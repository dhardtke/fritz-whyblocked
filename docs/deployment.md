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
connections, and pipes the build into `sudo fritz-whyblocked-deploy <sha>`. The `deploy` job is skipped unless the
push changed something the build reads: `src/` other than `*.test.ts`, `public/`, `package.json`, `bun.lock`,
`bunfig.toml`, `tsconfig.json` or `.bun-version`. A push whose previous head is unknown, such as a force push, always
deploys. Pull requests get the `check` job only. Actions are pinned to commit SHAs, and CI's Bun comes from
`.bun-version`.

fritz-whyblocked runs as the hardened system service `fritz-whyblocked` (`deploy/fritz-whyblocked.service`) under the
`whyblocked` user, so restarting it takes root. The runner's user, `fritz-whyblocked-gh-runner`, may therefore run
`/usr/local/bin/fritz-whyblocked-deploy` as root, and nothing else (`deploy/fritz-whyblocked-gh-runner.sudoers`). The
script accepts nothing but a commit SHA and a tar of the three build files.

`deploy/fritz-whyblocked-deploy`:

1. unpacks the build into `/opt/fritz-whyblocked/releases/<sha>`
2. installs the Bun named in `bun-version` into `/opt/fritz-whyblocked/bun/<version>`, verified against the release's
   `SHASUMS256.txt`, and links it as the release's `bun`
3. points `/opt/fritz-whyblocked/current` at the release and restarts the service
4. rolls back to the previous release and its Bun if `/api/health` does not answer within 30 seconds
5. keeps five releases, and the Bun versions they use

The list cache and the statistics in `/var/lib/fritz-whyblocked` (the unit's `StateDirectory`) are not part of a
release and need no migration, so a deploy does not back them up. Each release runs on the Bun that built it, so
upgrading Bun is just the pull request that bumps `.bun-version`. The paths and port 8053 are constants at the top of
the script; change `PORT` there too if `config.env` sets another.

## Server setup

Once, on the Fedora server, with the repository's `deploy/` directory and `.env.example` copied over:

```sh
sudo dnf install -y curl unzip tar util-linux policycoreutils-python-utils
sudo useradd --system --no-create-home --shell /usr/sbin/nologin whyblocked
sudo mkdir -p /opt/fritz-whyblocked /etc/fritz-whyblocked
sudo cp .env.example /etc/fritz-whyblocked/config.env   # adjust, leave passwords empty
sudo sh -c 'umask 077; printf %s "…" > /etc/fritz-whyblocked/fritz-password; printf %s "…" > /etc/fritz-whyblocked/ui-password'
# systemd must be allowed to execute the Bun binaries the deploy installs
sudo semanage fcontext -a -t bin_t '/opt/fritz-whyblocked/bun/[^/]+/bun'
sudo install -m 0644 deploy/fritz-whyblocked.service /etc/systemd/system/fritz-whyblocked.service
sudo systemctl daemon-reload && sudo systemctl enable fritz-whyblocked
sudo install -m 0755 deploy/fritz-whyblocked-deploy /usr/local/bin/fritz-whyblocked-deploy
sudo install -m 0440 deploy/fritz-whyblocked-gh-runner.sudoers /etc/sudoers.d/fritz-whyblocked-gh-runner
sudo firewall-cmd --permanent --add-port=8053/tcp && sudo firewall-cmd --reload
```

The first deploy creates the release and Bun, and starts the service. CI never updates
`deploy/fritz-whyblocked.service` or `deploy/fritz-whyblocked-deploy`: after changing one, rerun its `install` line,
and for the unit also `daemon-reload` and `restart fritz-whyblocked`.

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

## Operating

```sh
sudo systemctl status fritz-whyblocked
journalctl -u fritz-whyblocked -f
curl -s http://127.0.0.1:8053/api/health
```
