# fritz-whyblocked

*Find out why your FRITZ!Box DNS filter blocks a domain – and allow it with one click.*

Gib eine Domain oder URL ein. fritz-whyblocked zeigt, ob der DNS-Filter der FRITZ!Box sie sperrt, welches Glied der CNAME-Kette der Auslöser ist und welche Filterliste dafür verantwortlich ist. Eine Ausnahme legst du mit einem Klick an. Dazu kommen Schalter für Ausnahmen, eigene Sperren und Filterlisten sowie die Statistik der Box.

> Kein offizielles Produkt der FRITZ! GmbH; nicht mit ihr verbunden.

## So funktioniert die Analyse

1. Die CNAME-Kette wird über einen Referenz-DNS (Standard `1.1.1.1`) aufgelöst.
2. Jedes Glied wird direkt bei der Box abgefragt (A und AAAA, per IPv4 und optional IPv6). Eine Sperre erkennt das Tool an der Antwort `0.0.0.0` bzw. `::`.
3. Das letzte gesperrte Glied ist der **Auslöser**. Oft ist das ein CNAME-Ziel: Eine Ausnahme für den angefragten Namen hilft dann nicht, sie muss für das Ziel gelten.
4. Für jedes Glied und seine Eltern-Domains werden Regeln im Regel-Index gesucht. Treffer werden im zwischengespeicherten Listentext bestätigt und mit der Originalzeile angezeigt.

Der Regel-Index legt pro Regel einen 44-Bit-Hash plus Regelart in einem sortierten `Float64Array` ab, also 8 Byte pro Regel. Es gibt keinen Mitschnitt und keinen DNS-Proxy, das Tool bremst das Netz also nicht.

Änderungen an der Box laufen immer gleich ab. Zuerst kommt ein Probelauf, der das JSON für den `PUT` anzeigt. Danach wird es abgeschickt, und das Tool liest den Stand neu, um zu prüfen, ob er angekommen ist.

## Voraussetzungen

- FRITZ!Box mit DNS-Filter und der Beta-API `/api/v0/beta/dnsfilter` (getestet mit 7590, FRITZ!OS 8.50)
- [Bun](https://bun.sh) ≥ 1.1, keine weiteren Laufzeit-Abhängigkeiten

> Die API ist `beta` und kann sich mit FRITZ!OS-Updates ändern.

## Lokal starten

```sh
cp .env.example .env   # FRITZ_PASSWORD eintragen
bun install            # nur Typen und TypeScript für die Entwicklung
bun start              # http://127.0.0.1:8053
bun test
```

Ohne `UI_PASSWORD` lauscht die Oberfläche nur auf `127.0.0.1`. Ist es gesetzt, ist sie aus dem LAN per Basic-Auth erreichbar. Schreibende Aufrufe brauchen den Header `X-WhyBlocked: 1` (CSRF-Schutz).

## Konfiguration

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `FRITZ_HOST` | `fritz.box` | Adresse der Box |
| `FRITZ_USER` | leer | Benutzer; leer = zuletzt genutzter aus `login_sid.lua` |
| `FRITZ_PASSWORD` | – | Passwort (oder systemd-Credential `fritz-password`) |
| `BOX_DNS_V4` | aufgelöster `FRITZ_HOST` | DNS-Adresse der Box für die Gegenprobe |
| `BOX_DNS_V6` | leer | IPv6-Adresse der Box (z. B. ULA); leer = keine IPv6-Gegenprobe |
| `REFERENCE_DNS` | `1.1.1.1` | Resolver für die CNAME-Kette |
| `PORT` | `8053` | Port der Oberfläche |
| `UI_PASSWORD` | leer | Passwort der Oberfläche (oder Credential `ui-password`) |
| `DATA_DIR` | `./data` | Listen-Cache und Statistik (unter systemd: `StateDirectory`) |
| `STATS_INTERVAL` | `300` | Abfrage der Statistik in Sekunden |
| `LISTS_REFRESH_HOURS` | `24` | Neu-Laden der Filterlisten in Stunden |

## Deployment (Fedora, systemd)

```sh
# Bun mit install statt mv, damit der SELinux-Kontext stimmt
sudo install -m 0755 ~/.bun/bin/bun /usr/local/bin/bun
sudo useradd --system --no-create-home --shell /usr/sbin/nologin whyblocked
sudo mkdir -p /opt/fritz-whyblocked /etc/fritz-whyblocked
sudo cp -r src public package.json /opt/fritz-whyblocked/
sudo cp .env.example /etc/fritz-whyblocked/config.env   # anpassen, Passwörter leer lassen
sudo sh -c 'umask 077; printf %s "…" > /etc/fritz-whyblocked/fritz-password; printf %s "…" > /etc/fritz-whyblocked/ui-password'
sudo cp deploy/fritz-whyblocked.service /etc/systemd/system/
sudo firewall-cmd --permanent --add-port=8053/tcp && sudo firewall-cmd --reload
sudo systemctl daemon-reload && sudo systemctl enable --now fritz-whyblocked
journalctl -u fritz-whyblocked -f
```

## Offene Punkte

- Gegen die echte Box testen: Nimmt `PUT` einen neuen `domains`-Eintrag ohne `UID` an? Akzeptiert sie `filterlists` ohne `status`?
- Gibt eine Ausnahme für eine Eltern-Domain auch Subdomains frei? Legt die Box Adblock-, Hosts- und Domain-Einträge für Subdomains gleich aus? Bis das geklärt ist, markiert die Oberfläche solche Treffer als „Auslegung unklar“.
- Ob `statistics.dnsQueryCount` fortlaufend oder pro Tag zählt; der Verlauf behandelt sinkende Zähler als Reset.
- Mitschnitt auf Knopfdruck (später, bremst die Box während der Aufnahme auf 60–100 Mbit/s).
- Lizenz wählen.
