import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, type QueryFn } from '../analysis.ts';
import { TYPE } from '../dns.ts';
import { INDEX_HTML } from '../embedded.ts';
import { errorMessage } from '../errors.ts';
import type { DomainEntry } from '../fritz.ts';
import { KIND, KIND_LABEL, type ListStatus, type RuleHit } from '../rules.ts';
import type { StatsInterval } from '../store.ts';

const OUT_DIR = 'docs/screenshots';
const THEMES = ['light', 'dark'] as const;

const BROWSERS = [
  process.env.WHYBLOCKED_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  Bun.which('google-chrome'),
  Bun.which('chromium'),
  Bun.which('microsoft-edge'),
];

// Edge formats with the OS region whatever --lang says, so the page's default-locale formatters are pinned.
const EN_US_SHIM = `(() => {
  for (const name of ['NumberFormat', 'DateTimeFormat']) {
    const Original = Intl[name];
    const Pinned = function (locales, options) { return new Original(locales ?? 'en-US', options); };
    Pinned.prototype = Original.prototype;
    Pinned.supportedLocalesOf = Original.supportedLocalesOf;
    Intl[name] = Pinned;
  }
  for (const [proto, method] of [[Number.prototype, 'toLocaleString'], [Date.prototype, 'toLocaleString'], [Date.prototype, 'toLocaleDateString'], [Date.prototype, 'toLocaleTimeString']]) {
    const original = proto[method];
    proto[method] = function (locales, options) { return original.call(this, locales ?? 'en-US', options); };
  }
})();`;

// Everything the page shows is made up here; the script never reads the configuration, the data directory or a box.
const NOW = Date.UTC(2026, 10, 26, 15, 0);
const REFERENCE_DNS = '1.1.1.1';
const BOX_SERVERS = [
  { label: 'IPv4 192.168.178.1', address: '192.168.178.1' },
  { label: 'IPv6 fd00::1', address: 'fd00::1' },
];
const CHECKED_DOMAIN = 'metrics.example.com';

const CNAMES: Record<string, string> = {
  'metrics.example.com': 'example.com.tracking.example.net',
  'example.com.tracking.example.net': 'collect.tracking.example.net',
};
const BLOCKED = new Set(['metrics.example.com', 'example.com.tracking.example.net', 'collect.tracking.example.net']);

const LISTS: ListStatus[] = [
  list('Ads & trackers', 'https://lists.example.org/ads-trackers.txt', true, 'block', 148_213, 147_906),
  list('Malware & phishing', 'https://lists.example.org/malware.txt', true, 'block', 61_840, 61_840),
  list('Social media', 'https://lists.example.org/social.txt', false, 'block', 3_412, 3_398),
  list('Allowlist', 'https://lists.example.org/allowlist.txt', true, 'allow', 1_127, 1_127),
];

const DOMAINS: DomainEntry[] = [
  { domain: 'cdn.example.net', action: 'allow', enabled: true, comment: 'Breaks the video player' },
  { domain: 'login.example.org', action: 'allow', enabled: true, comment: 'Single sign-on' },
  { domain: 'ads.example.com', action: 'deny', enabled: true, comment: '' },
  { domain: 'analytics.example.com', action: 'allow', enabled: false, comment: 'Only while debugging' },
  { domain: 'telemetry.example.io', action: 'deny', enabled: true, comment: 'Smart TV' },
];

const RULE_HITS: Record<string, RuleHit[]> = {
  'example.com.tracking.example.net': [hit(LISTS[0], 'tracking.example.net', KIND.WITH_SUBDOMAINS, '||tracking.example.net^')],
  'collect.tracking.example.net': [
    hit(LISTS[0], 'tracking.example.net', KIND.WITH_SUBDOMAINS, '||tracking.example.net^'),
    hit(LISTS[1], 'collect.tracking.example.net', KIND.EXACT, '0.0.0.0 collect.tracking.example.net'),
  ],
};

interface Shot {
  name: string;
  mobile: boolean;
  /** Run in the page once it has loaded. */
  prepare: string;
}

const CHECK = `document.getElementById('domain').value = '${CHECKED_DOMAIN}'; document.getElementById('checkForm').requestSubmit();`;
const scrollTo = (section: number): string => `window.scrollTo(0, document.querySelectorAll('section')[${section}].offsetTop - 16);`;
const DRAFT = `
  document.querySelectorAll('#domains input[data-field="enabled"]')[3].click();
  document.getElementById('newDomain').value = 'video.example.net';
  document.getElementById('addForm').requestSubmit();
  document.querySelectorAll('#lists input[data-list-url]')[2].click();
  document.activeElement?.blur();
`;

const SHOTS: Shot[] = [
  { name: 'check', mobile: false, prepare: CHECK },
  { name: 'statistics', mobile: false, prepare: scrollTo(1) },
  { name: 'filter', mobile: false, prepare: DRAFT + scrollTo(2) },
  { name: 'mobile-check', mobile: true, prepare: CHECK },
  { name: 'mobile-statistics', mobile: true, prepare: scrollTo(1) },
  { name: 'mobile-filter', mobile: true, prepare: DRAFT + scrollTo(2) },
];

function list(name: string, url: string, enabled: boolean, action: string, boxEntryCount: number, indexedRules: number): ListStatus {
  return {
    name,
    url,
    enabled,
    action,
    boxEntryCount,
    indexedRules,
    skippedLines: boxEntryCount - indexedRules,
    indexBytes: indexedRules * 8,
    loadedAt: NOW - 3 * 3600_000,
  };
}

function hit(of: ListStatus | undefined, ruleDomain: string, kind: (typeof KIND)['EXACT' | 'WITH_SUBDOMAINS'], line: string): RuleHit {
  if (of === undefined) {
    throw new Error('no such list');
  }
  return {
    listName: of.name,
    listUrl: of.url,
    listEnabled: of.enabled,
    listAction: of.action,
    ruleDomain,
    kind,
    kindLabel: KIND_LABEL[kind],
    certain: true,
    line,
  };
}

const query: QueryFn = (server, name, type) => {
  if (server === REFERENCE_DNS) {
    const answers = [];
    let current = name;
    for (let next = CNAMES[current]; next !== undefined; current = next, next = CNAMES[current]) {
      answers.push({ name: current, type: TYPE.CNAME, ttl: 300, data: next });
    }
    answers.push({ name: current, type: TYPE.A, ttl: 300, data: '203.0.113.42' });
    return Promise.resolve({ rcode: 0, truncated: false, answers });
  }
  const blocked = BLOCKED.has(name);
  const data = type === 'A' ? (blocked ? '0.0.0.0' : '203.0.113.42') : blocked ? '::' : '2001:db8::42';
  return Promise.resolve({ rcode: 0, truncated: false, answers: [{ name, type: TYPE[type], ttl: 300, data }] });
};

/** A day-and-night rhythm of DNS queries, with a little deterministic noise. */
function intervals(hours: number): StatsInterval[] {
  const step = hours <= 24 ? 5 * 60_000 : hours <= 168 ? 30 * 60_000 : 2 * 3600_000;
  let seed = 7;
  const noise = (): number => {
    seed = (seed * 16_807) % 2_147_483_647;
    return seed / 2_147_483_647 - 0.5;
  };
  const out: StatsInterval[] = [];
  for (let ts = NOW - hours * 3600_000 + step; ts <= NOW; ts += step) {
    const hour = new Date(ts).getUTCHours() + new Date(ts).getUTCMinutes() / 60;
    const daytime = 0.5 - 0.5 * Math.cos(((hour - 3) / 24) * 2 * Math.PI);
    const perMinute = 60 + 160 * daytime * (1 + 0.25 * noise());
    const total = Math.round((perMinute * step) / 60_000);
    const share = 0.11 + 0.06 * (1 - daytime) + 0.008 * noise();
    out.push({ ts, total, blocked: Math.round(total * share) });
  }
  return out;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  switch (url.pathname) {
    case '/':
      return new Response(INDEX_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    case '/api/status':
      return Response.json({
        boxError: null,
        filterEnabled: true,
        statistics: { total: 1_284_532, blocked: 187_310 },
        domains: DOMAINS,
        lists: LISTS,
        listsReady: true,
      });
    case '/api/stats':
      return Response.json({ intervals: intervals(Number(url.searchParams.get('hours') ?? 24)), intervalSeconds: 300 });
    case '/api/check':
      try {
        return Response.json(
          await analyze(url.searchParams.get('domain') ?? '', {
            query,
            lookupRules: (name) => Promise.resolve(RULE_HITS[name] ?? []),
            domains: DOMAINS,
            referenceDns: REFERENCE_DNS,
            boxServers: BOX_SERVERS,
          }),
        );
      } catch (err) {
        return Response.json({ error: errorMessage(err) }, { status: 400 });
      }
    default:
      return Response.json({ error: 'Not available in the screenshot fixture.' }, { status: 404 });
  }
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const entry: unknown = Reflect.get(value, key);
  return entry;
}

class Cdp {
  readonly #ws: WebSocket;

  readonly #pending = new Map<number, (result: unknown) => void>();

  #nextId = 0;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const message: unknown = JSON.parse(String(event.data));
      const id = field(message, 'id');
      const resolve = typeof id === 'number' ? this.#pending.get(id) : undefined;
      if (resolve === undefined || typeof id !== 'number') {
        return;
      }
      this.#pending.delete(id);
      const error = field(message, 'error');
      if (error !== undefined) {
        console.error(error);
      }
      resolve(field(message, 'result'));
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve) => {
      ws.addEventListener('open', resolve, { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: object = {}): Promise<unknown> {
    const id = ++this.#nextId;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.#ws.close();
  }
}

function findBrowser(): string {
  const found = BROWSERS.find((path): path is string => path != null && path !== '' && existsSync(path));
  if (found === undefined) {
    console.error('no Chrome or Edge found; point WHYBLOCKED_BROWSER at one');
    process.exit(1);
  }
  return found;
}

function freePort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

async function debuggerUrl(port: number): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch (err) {
      if (attempt >= 100) {
        throw err;
      }
      await Bun.sleep(100);
    }
  }
  const target: unknown = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const url = field(target, 'webSocketDebuggerUrl');
  if (typeof url !== 'string') {
    throw new Error('the browser opened no debuggable tab');
  }
  return url;
}

async function shoot(cdp: Cdp, origin: string): Promise<void> {
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: EN_US_SHIM });
  await cdp.send('Emulation.setScrollbarsHidden', { hidden: true });
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  await mkdir(OUT_DIR, { recursive: true });

  for (const theme of THEMES) {
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    for (const shot of SHOTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: shot.mobile ? 390 : 1200,
        height: shot.mobile ? 844 : 820,
        deviceScaleFactor: shot.mobile ? 3 : 2,
        mobile: shot.mobile,
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: shot.mobile });
      await cdp.send('Page.navigate', { url: `${origin}/` });
      await Bun.sleep(1500);
      await cdp.send('Runtime.evaluate', { expression: shot.prepare });
      await Bun.sleep(1000);
      const data = field(await cdp.send('Page.captureScreenshot', { format: 'png' }), 'data');
      if (typeof data !== 'string') {
        throw new Error(`no screenshot of ${shot.name}`);
      }
      const file = join(OUT_DIR, `${shot.name}-${theme}.png`);
      await Bun.write(file, Buffer.from(data, 'base64'));
      console.log(`  ${file}`);
    }
  }
}

async function main(): Promise<void> {
  const browserPath = findBrowser();
  const profile = await mkdtemp(join(tmpdir(), 'whyblocked-screenshots-'));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handle });
  const port = freePort();
  const browser = Bun.spawn([browserPath, '--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  try {
    const cdp = await Cdp.connect(await debuggerUrl(port));
    await shoot(cdp, server.url.origin);
    cdp.close();
  } finally {
    browser.kill();
    await browser.exited;
    await server.stop(true);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (import.meta.main) {
  await main();
}
