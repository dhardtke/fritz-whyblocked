# Deployment

## Running a build

```sh
bun run build    # dist/fritz-whyblocked.js + dist/fritz-whyblocked.js.map + dist/bun-version
bun dist/fritz-whyblocked.js
```

The build is one file: the server with `public/index.html` embedded and stamped with the commit it was built from.
It needs only Bun, no `node_modules`. Configuration is the same as for `bun start` (see the README).

The rest of this document covers the repository's own server.

## How a deploy works

Every push to `main` runs `.github/workflows/ci.yml`. The `check` job runs format, lint, typecheck, tests and the build
on GitHub and uploads `dist/`. The `deploy` job runs on a self-hosted runner on the server, which accepts no inbound
connections, and pipes the build into `sudo -u whyblocked fritz-whyblocked-deploy <sha>`. The `deploy` job is skipped
unless the push changed something the build reads: `src/` other than `*.test.ts`, `public/`, `package.json`,
`bun.lock`, `bunfig.toml`, `tsconfig.json` or `.bun-version`. A push whose previous head is unknown, such as a force
push, always deploys. Pull requests get the `check` job only. Actions are pinned to commit SHAs, and CI's Bun comes from
`.bun-version`.

The runner's user, `fritz-whyblocked-gh-runner`, may run only `/usr/local/bin/fritz-whyblocked-deploy` as `whyblocked`
(`deploy/fritz-whyblocked-gh-runner.sudoers`), and nothing as root. fritz-whyblocked runs as a systemd user service of
`whyblocked` (`deploy/fritz-whyblocked.service`), kept running by lingering, so the deploy restarts it without root. The
script accepts nothing but a commit SHA and a tar of the three build files.

`deploy/fritz-whyblocked-deploy`:

1. unpacks the build into `/home/whyblocked/app/releases/<sha>`
2. installs the Bun named in `bun-version` into `/home/whyblocked/app/bun/<version>`, verified against the release's
   `SHASUMS256.txt`, and links it as the release's `bun`
3. points `/home/whyblocked/app/current` at the release and restarts the service
4. rolls back to the previous release and its Bun if `/api/health` does not answer within 30 seconds
5. keeps five releases, and the Bun versions they use

The list cache and the statistics in `/home/whyblocked/app/data` (`DATA_DIR` relative to the unit's working directory)
are not part of a release and need no migration, so a deploy does not back them up. Each release runs on the Bun that
built it, so upgrading Bun is just the pull request that bumps `.bun-version`. The paths and port 8053 are constants at
the top of the script; change `PORT` there too if `fritz-whyblocked.env` sets another.

## Server setup

Once, on the Fedora server, with the repository's `deploy/` directory and `.env.example` copied over:

```sh
sudo dnf install -y curl unzip tar util-linux
sudo useradd --system --create-home --home-dir /home/whyblocked --shell /sbin/nologin whyblocked
sudo loginctl enable-linger whyblocked
sudo -u whyblocked mkdir -p /home/whyblocked/app /home/whyblocked/.config/systemd/user
sudo install -o whyblocked -g whyblocked -m 0600 .env.example /home/whyblocked/app/fritz-whyblocked.env
sudoedit -u whyblocked /home/whyblocked/app/fritz-whyblocked.env   # set FRITZ_PASSWORD, UI_PASSWORD and the rest
sudo install -o whyblocked -g whyblocked -m 0644 deploy/fritz-whyblocked.service /home/whyblocked/.config/systemd/user/fritz-whyblocked.service
sudo systemctl --user -M whyblocked@ daemon-reload
sudo systemctl --user -M whyblocked@ enable fritz-whyblocked
sudo install -m 0755 deploy/fritz-whyblocked-deploy /usr/local/bin/fritz-whyblocked-deploy
sudo install -m 0440 deploy/fritz-whyblocked-gh-runner.sudoers /etc/sudoers.d/fritz-whyblocked-gh-runner
```

The first deploy creates the release and Bun, and starts the service. CI never updates
`deploy/fritz-whyblocked.service` or `deploy/fritz-whyblocked-deploy`: after changing one, rerun its `install` line,
and for the unit also `daemon-reload` and `restart fritz-whyblocked` (both with `--user -M whyblocked@`).

Then the runner, with a token from _Settings → Actions → Runners → New self-hosted runner_:

```sh
sudo useradd --system --create-home --home-dir /var/lib/fritz-whyblocked-gh-runner --shell /sbin/nologin fritz-whyblocked-gh-runner
sudo -u fritz-whyblocked-gh-runner mkdir /var/lib/fritz-whyblocked-gh-runner/actions-runner
cd /var/lib/fritz-whyblocked-gh-runner/actions-runner
sudo -u fritz-whyblocked-gh-runner sh -c 'curl -fsSL <runner tarball URL> | tar -xz'
sudo ./bin/installdependencies.sh
sudo -u fritz-whyblocked-gh-runner ./config.sh --unattended --url https://github.com/<owner>/fritz-whyblocked --token <token> \
  --labels fritz-whyblocked-prod --name "$(hostname)"
sudo ./svc.sh install fritz-whyblocked-gh-runner && sudo ./svc.sh start
```

If the runner service fails with `203/EXEC`, SELinux is blocking `runsvc.sh`:

```sh
sudo semanage fcontext -a -t bin_t '/var/lib/fritz-whyblocked-gh-runner/actions-runner/runsvc\.sh'
sudo restorecon -v /var/lib/fritz-whyblocked-gh-runner/actions-runner/runsvc.sh
```

Finally, create the `production` environment (_Settings → Environments_) and restrict it to `main`.

### Reverse proxy

The LAN reaches fritz-whyblocked through Caddy at `https://whyblocked.server`, and port 8053 stays closed in the
firewall. `.server` is no public top-level domain, so Caddy cannot get a certificate from Let's Encrypt and signs one
with its own local CA instead (`tls internal`). `/etc/caddy/Caddyfile.d/whyblocked.caddyfile`:

```caddyfile
whyblocked.server {
	tls internal
	reverse_proxy 127.0.0.1:8053
}
```

```sh
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
sudo firewall-cmd --permanent --add-service=https && sudo firewall-cmd --reload
sudo curl -fsS --cacert /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt https://whyblocked.server/api/health
```

Fedora's default `Caddyfile` serves a test page on `:80` and imports `Caddyfile.d/*.caddyfile`; a file without that
suffix is never loaded, and Caddy then aborts the TLS handshake for the name with `tlsv1 alert internal error`.
`caddy adapt --config /etc/caddy/Caddyfile --pretty` shows the routes Caddy actually loaded.

Keep `UI_PASSWORD` set: without it the UI has no login, and anyone who reaches Caddy can change the box's filter. With
it, the server listens on every interface, so the closed port is what keeps clients from bypassing the proxy and
sending the password in clear text. The deploy's health check talks to `127.0.0.1:8053` directly.

Each client needs two things:

- `whyblocked.server` resolving to the server's LAN address. The FRITZ!Box only answers names of its own devices, under
  `.fritz.box`, so this takes a local DNS server or a `hosts` entry per client.
- Trust in Caddy's root certificate, `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt` (never the
  `root.key` beside it). Firefox: _Settings → Privacy & Security → Certificates → View Certificates → Authorities →
  Import_, with _Trust this CA to identify websites_. Elsewhere, add it to the operating system's trusted roots. The CA
  can sign for any name, so install it only on your own devices.

## Operating

```sh
sudo systemctl --user -M whyblocked@ status fritz-whyblocked
sudo journalctl _SYSTEMD_USER_UNIT=fritz-whyblocked.service -f        # -p warning or -p err to filter
curl -s http://127.0.0.1:8053/api/health
```

The passwords live in `/home/whyblocked/app/fritz-whyblocked.env` (mode `0600`). Keep values with `$` signs in single
quotes, or systemd expands them. Without the file the service does not start. After changing it, restart the service.
