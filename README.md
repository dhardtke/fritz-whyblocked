# fritz-whyblocked

*Find out why your FRITZ!Box DNS filter blocks a domain – and allow it with one click.*

Enter a domain or URL. fritz-whyblocked shows whether the FRITZ!Box DNS filter blocks it, which link of the CNAME chain triggers the block, and which filter list is responsible. You can add an exception with one click. It also has switches for exceptions, custom blocks and filter lists, and shows the box's statistics.

> Not an official product of FRITZ! GmbH; not affiliated with it.

## How the analysis works

1. The CNAME chain is resolved via a reference DNS (default `1.1.1.1`).
2. Each link is queried directly at the box (A and AAAA, via IPv4 and optionally IPv6). The tool recognizes a block by the answer `0.0.0.0` or `::`.
3. The last blocked link is the **trigger**. Often that is a CNAME target: an exception for the requested name does not help then; it has to be for the target.
4. Rules are looked up in the rule index for each link and its parent domains. Hits are confirmed against the cached list text and shown with the original line.

The rule index stores a 44-bit hash plus the rule kind per rule in a sorted `Float64Array`, i.e. 8 bytes per rule. There is no packet capture and no DNS proxy, so the tool does not slow down the network.

Changes to the box always follow the same steps. First a dry run shows the JSON for the `PUT`. Then it is sent, and the tool reads the state again to check that the change arrived.

## Requirements

- FRITZ!Box with DNS filter and the beta API `/api/v0/beta/dnsfilter` (tested with 7590, FRITZ!OS 8.50)
- [Bun](https://bun.sh) ≥ 1.1, no other runtime dependencies

> The API is `beta` and may change with FRITZ!OS updates.

## Running locally

```sh
cp .env.example .env   # set FRITZ_PASSWORD
bun install            # types and TypeScript for development only
bun start              # http://127.0.0.1:8053
bun test
```

Without `UI_PASSWORD` the UI only listens on `127.0.0.1`. With it set, the UI is reachable from the LAN via basic auth. Write requests need the header `X-WhyBlocked: 1` (CSRF protection).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FRITZ_HOST` | `fritz.box` | Address of the box |
| `FRITZ_USER` | empty | User; empty = most recently used user from `login_sid.lua` |
| `FRITZ_PASSWORD` | – | Password (or systemd credential `fritz-password`) |
| `BOX_DNS_V4` | resolved `FRITZ_HOST` | DNS address of the box for probing |
| `BOX_DNS_V6` | empty | IPv6 address of the box (e.g. ULA); empty = no IPv6 probe |
| `REFERENCE_DNS` | `1.1.1.1` | Resolver for the CNAME chain |
| `PORT` | `8053` | Port of the UI |
| `UI_PASSWORD` | empty | UI password (or credential `ui-password`) |
| `DATA_DIR` | `./data` | List cache and statistics (under systemd: `StateDirectory`) |
| `STATS_INTERVAL` | `300` | Statistics polling in seconds |
| `LISTS_REFRESH_HOURS` | `24` | Filter list refresh in hours |

## Deployment (Fedora, systemd)

```sh
# install Bun with install rather than mv so the SELinux context is right
sudo install -m 0755 ~/.bun/bin/bun /usr/local/bin/bun
sudo useradd --system --no-create-home --shell /usr/sbin/nologin whyblocked
sudo mkdir -p /opt/fritz-whyblocked /etc/fritz-whyblocked
sudo cp -r src public package.json /opt/fritz-whyblocked/
sudo cp .env.example /etc/fritz-whyblocked/config.env   # adjust, leave passwords empty
sudo sh -c 'umask 077; printf %s "…" > /etc/fritz-whyblocked/fritz-password; printf %s "…" > /etc/fritz-whyblocked/ui-password'
sudo cp deploy/fritz-whyblocked.service /etc/systemd/system/
sudo firewall-cmd --permanent --add-port=8053/tcp && sudo firewall-cmd --reload
sudo systemctl daemon-reload && sudo systemctl enable --now fritz-whyblocked
journalctl -u fritz-whyblocked -f
```

## Open points

- Test against the real box: does `PUT` accept a new `domains` entry without `UID`? Does it accept `filterlists` without `status`?
- Does an exception for a parent domain also allow its subdomains? Does the box interpret Adblock, hosts and domain entries the same way for subdomains? Until that is clear, the UI marks such hits as "interpretation unclear".
- Whether `statistics.dnsQueryCount` counts continuously or per day; the history treats a falling counter as a reset.
- Capture on demand (later; slows the box down to 60–100 Mbit/s while recording).
- Choose a license.
