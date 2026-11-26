import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { analyze } from './analysis.ts';
import { loadConfig } from './config.ts';
import { query } from './dns.ts';
import { INDEX_HTML } from './embedded.ts';
import { errorMessage } from './errors.ts';
import { domainApplied, FritzBox, setListEnabled, upsertDomain, type DnsFilter, type DomainChange, type FilterList, type PlannedRequest } from './fritz.ts';
import { RuleSet } from './rules.ts';
import { StatsStore, toIntervals } from './store.ts';

const config = loadConfig();
const box = new FritzBox(config.fritzHost, config.fritzUser, config.fritzPassword);
const rules = new RuleSet(config.dataDir);
const stats = new StatsStore(config.dataDir);
const CSRF_HEADER = 'x-whyblocked';

// ---------- box state (cached briefly) ----------

let cached: { at: number; filter: DnsFilter } | null = null;
let lastBoxError: string | null = null;

async function getFilter(maxAgeMs = 15_000): Promise<DnsFilter> {
  if (cached && Date.now() - cached.at < maxAgeMs) {
    return cached.filter;
  }
  try {
    const filter = await box.getDnsFilter();
    cached = { at: Date.now(), filter };
    lastBoxError = null;
    rules.updateMeta(filter.filterlists ?? []);
    return filter;
  } catch (err) {
    lastBoxError = errorMessage(err);
    throw err;
  }
}

async function refreshLists(): Promise<void> {
  try {
    const filter = await getFilter(0);
    await rules.refresh(filter.filterlists ?? []);
    console.log(
      `Filter lists loaded: ${rules
        .status()
        .map((l) => `${l.name} (${l.indexedRules})`)
        .join(', ')}`,
    );
  } catch (err) {
    console.error(`Could not load filter lists: ${errorMessage(err)}`);
  }
}

async function recordStats(): Promise<void> {
  try {
    const count = (await getFilter(0)).statistics?.dnsQueryCount;
    if (typeof count?.total === 'number' && typeof count.blocked === 'number') {
      stats.add({ ts: Date.now(), total: count.total, blocked: count.blocked });
    }
    stats.prune(Date.now() - 30 * 24 * 3600 * 1000);
  } catch (err) {
    console.error(`Could not fetch statistics: ${errorMessage(err)}`);
  }
}

async function boxDnsServers(): Promise<{ label: string; address: string }[]> {
  const servers: { label: string; address: string }[] = [];
  let v4 = config.boxDnsV4;
  if (!v4) {
    try {
      v4 = (await lookup(config.fritzHost.replace(/^https?:\/\//, '').replace(/[:/].*$/, ''), { family: 4 })).address;
    } catch {
      v4 = '192.168.178.1';
    }
  }
  servers.push({ label: `IPv4 ${v4}`, address: v4 });
  if (config.boxDnsV6) {
    servers.push({ label: `IPv6 ${config.boxDnsV6}`, address: config.boxDnsV6 });
  }
  return servers;
}
const boxServersPromise = boxDnsServers();

// ---------- writing with dry run and verification ----------

/** The box returns status fields that should not be sent back when writing. */
function writableLists(lists: FilterList[]): FilterList[] {
  return lists.map(({ status: _status, ...rest }) => rest as FilterList);
}

interface WriteResult {
  dryRun: boolean;
  planned: PlannedRequest;
  applied?: boolean;
  warning?: string;
}

async function writeOrPlan(body: Partial<DnsFilter>, dryRun: boolean, verify: (after: DnsFilter) => boolean): Promise<WriteResult> {
  const planned = box.plan(body);
  if (dryRun) {
    return { dryRun: true, planned };
  }
  await box.put(body);
  const after = await getFilter(0);
  const applied = verify(after);
  return { dryRun: false, planned, applied, ...(applied ? {} : { warning: 'The box did not apply the change as expected.' }) };
}

// ---------- HTTP ----------

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function checkAuth(req: Request): boolean {
  if (!config.uiPassword) {
    return true;
  }
  const header = req.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) {
    return false;
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  const a = Buffer.from(password);
  const b = Buffer.from(config.uiPassword);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Body = Record<string, unknown>;

function isBody(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBody(req: Request): Promise<Body> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
  if (!isBody(body)) {
    throw new HttpError(400, 'The body must be a JSON object.');
  }
  return body;
}

function bool(body: Body, key: string, fallback?: boolean): boolean {
  const value = body[key] ?? fallback;
  if (typeof value !== 'boolean') {
    throw new HttpError(400, `${key} must be true or false.`);
  }
  return value;
}

function str(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${key} is required.`);
  }
  return value.trim();
}

function optionalStr(body: Body, key: string): string | undefined {
  const value = body[key];
  if (value !== undefined && typeof value !== 'string') {
    throw new HttpError(400, `${key} must be a string.`);
  }
  return value;
}

/** Writes are dry runs unless the body says otherwise. */
function dryRun(body: Body): boolean {
  return bool(body, 'dryRun', true);
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    return new Response(INDEX_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (!path.startsWith('/api/')) {
    return new Response('Not found', { status: 404 });
  }
  if (req.method !== 'GET' && req.headers.get(CSRF_HEADER) !== '1') {
    throw new HttpError(403, `Header ${CSRF_HEADER}: 1 is missing.`);
  }

  if (req.method === 'GET' && path === '/api/status') {
    let filter: DnsFilter | null = null;
    try {
      filter = await getFilter();
    } catch {
      /* the error is in lastBoxError */
    }
    return json({
      boxError: lastBoxError,
      filterEnabled: typeof filter?.enabled === 'boolean' ? filter.enabled : null,
      statistics: filter?.statistics?.dnsQueryCount ?? null,
      domains: filter?.domains ?? [],
      lists: rules.ready
        ? rules.status()
        : (filter?.filterlists ?? []).map((l) => ({
            name: l.name,
            url: l.url,
            enabled: l.enabled,
            action: l.action ?? 'block',
            boxEntryCount: l.status?.entryCount,
            indexedRules: 0,
            skippedLines: 0,
            indexBytes: 0,
          })),
      listsReady: rules.ready,
    });
  }

  if (req.method === 'GET' && path === '/api/check') {
    const input = url.searchParams.get('domain') ?? '';
    const filter = await getFilter();
    try {
      const result = await analyze(input, {
        query,
        lookupRules: (name) => rules.lookup(name),
        domains: filter.domains ?? [],
        referenceDns: config.referenceDns,
        boxServers: await boxServersPromise,
      });
      if (!rules.ready) {
        result.notes.unshift('The filter lists are still loading; hits may be missing.');
      }
      return json(result);
    } catch (err) {
      throw new HttpError(400, errorMessage(err));
    }
  }

  if (req.method === 'GET' && path === '/api/stats') {
    const hours = Math.min(Number(url.searchParams.get('hours') ?? 24) || 24, 24 * 30);
    return json({ intervals: toIntervals(stats.since(Date.now() - hours * 3600 * 1000)), intervalSeconds: config.statsIntervalMs / 1000 });
  }

  if (req.method === 'POST' && path === '/api/domains') {
    const body = await readBody(req);
    const action = body.action;
    if (action !== 'allow' && action !== 'deny') {
      throw new HttpError(400, 'action must be allow or deny.');
    }
    const change: DomainChange = {
      domain: str(body, 'domain').toLowerCase(),
      action,
      enabled: bool(body, 'enabled', true),
      comment: optionalStr(body, 'comment'),
    };
    const filter = await getFilter(0);
    return json(await writeOrPlan({ domains: upsertDomain(filter.domains ?? [], change) }, dryRun(body), (after) => domainApplied(after.domains, change)));
  }

  if (req.method === 'POST' && path === '/api/lists/toggle') {
    const body = await readBody(req);
    const listUrl = str(body, 'url');
    const enabled = bool(body, 'enabled');
    const filter = await getFilter(0);
    let lists: FilterList[];
    try {
      lists = writableLists(setListEnabled(filter.filterlists ?? [], listUrl, enabled));
    } catch (err) {
      throw new HttpError(404, errorMessage(err));
    }
    return json(await writeOrPlan({ filterlists: lists }, dryRun(body), (after) => after.filterlists?.find((l) => l.url === listUrl)?.enabled === enabled));
  }

  if (req.method === 'POST' && path === '/api/filter/toggle') {
    const body = await readBody(req);
    const enabled = bool(body, 'enabled');
    const filter = await getFilter(0);
    if (typeof filter.enabled !== 'boolean') {
      throw new HttpError(409, 'The box does not provide a switch for the whole DNS filter.');
    }
    return json(await writeOrPlan({ enabled }, dryRun(body), (after) => after.enabled === enabled));
  }

  if (req.method === 'POST' && path === '/api/lists/refresh') {
    await refreshLists();
    return json({ lists: rules.status() });
  }

  return json({ error: 'Not found' }, 404);
}

const hostname = config.uiPassword ? '0.0.0.0' : '127.0.0.1';
const server = Bun.serve({
  hostname,
  port: config.port,
  async fetch(req) {
    // Unauthenticated so a deploy can check a release; it reveals nothing but that the process is up.
    if (req.method === 'GET' && new URL(req.url).pathname === '/api/health') {
      return json({ ok: true });
    }
    if (!checkAuth(req)) {
      return new Response('Authentication required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="fritz-whyblocked", charset="UTF-8"' } });
    }
    try {
      return await handle(req);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      return json({ error: errorMessage(err) }, status);
    }
  },
});

console.log(`fritz-whyblocked running at http://${hostname}:${server.port}${config.uiPassword ? '' : ' (local only; set UI_PASSWORD for LAN access)'}`);

void refreshLists();
void recordStats();
setInterval(() => void refreshLists(), config.listsRefreshMs);
setInterval(() => void recordStats(), config.statsIntervalMs);
