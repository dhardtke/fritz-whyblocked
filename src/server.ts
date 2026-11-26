import { lookup } from "node:dns/promises";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { analyze } from "./analysis.ts";
import { loadConfig } from "./config.ts";
import { query } from "./dns.ts";
import { domainApplied, FritzBox, setListEnabled, upsertDomain, type DnsFilter, type DomainChange, type FilterList } from "./fritz.ts";
import { RuleSet } from "./rules.ts";
import { StatsStore, toIntervals } from "./store.ts";

const config = loadConfig();
const box = new FritzBox(config.fritzHost, config.fritzUser, config.fritzPassword);
const rules = new RuleSet(config.dataDir);
const stats = new StatsStore(config.dataDir);
const CSRF_HEADER = "x-whyblocked";

// ---------- box state (cached briefly) ----------

let cached: { at: number; filter: DnsFilter } | null = null;
let lastBoxError: string | null = null;

async function getFilter(maxAgeMs = 15_000): Promise<DnsFilter> {
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.filter;
  try {
    const filter = await box.getDnsFilter();
    cached = { at: Date.now(), filter };
    lastBoxError = null;
    rules.updateMeta(filter.filterlists ?? []);
    return filter;
  } catch (err) {
    lastBoxError = (err as Error).message;
    throw err;
  }
}

async function refreshLists(): Promise<void> {
  try {
    const filter = await getFilter(0);
    await rules.refresh(filter.filterlists ?? []);
    console.log(`Filter lists loaded: ${rules.status().map((l) => `${l.name} (${l.indexedRules})`).join(", ")}`);
  } catch (err) {
    console.error(`Could not load filter lists: ${(err as Error).message}`);
  }
}

async function recordStats(): Promise<void> {
  try {
    const count = (await getFilter(0)).statistics?.dnsQueryCount;
    if (typeof count?.total === "number" && typeof count.blocked === "number") {
      stats.add({ ts: Date.now(), total: count.total, blocked: count.blocked });
    }
    stats.prune(Date.now() - 30 * 24 * 3600 * 1000);
  } catch (err) {
    console.error(`Could not fetch statistics: ${(err as Error).message}`);
  }
}

async function boxDnsServers(): Promise<{ label: string; address: string }[]> {
  const servers: { label: string; address: string }[] = [];
  let v4 = config.boxDnsV4;
  if (!v4) {
    try {
      v4 = (await lookup(config.fritzHost.replace(/^https?:\/\//, "").replace(/[:/].*$/, ""), { family: 4 })).address;
    } catch {
      v4 = "192.168.178.1";
    }
  }
  servers.push({ label: `IPv4 ${v4}`, address: v4 });
  if (config.boxDnsV6) servers.push({ label: `IPv6 ${config.boxDnsV6}`, address: config.boxDnsV6 });
  return servers;
}
const boxServersPromise = boxDnsServers();

// ---------- writing with dry run and verification ----------

/** The box returns status fields that should not be sent back when writing. */
function writableLists(lists: FilterList[]): FilterList[] {
  return lists.map(({ status: _status, ...rest }) => rest as FilterList);
}

async function writeOrPlan(body: Partial<DnsFilter>, dryRun: boolean, verify: (after: DnsFilter) => boolean) {
  const planned = box.plan(body);
  if (dryRun) return { dryRun: true, planned };
  await box.put(body);
  const after = await getFilter(0);
  const applied = verify(after);
  return { dryRun: false, planned, applied, ...(applied ? {} : { warning: "The box did not apply the change as expected." }) };
}

// ---------- HTTP ----------

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function checkAuth(req: Request): boolean {
  if (!config.uiPassword) return true;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  const a = Buffer.from(password);
  const b = Buffer.from(config.uiPassword);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return new Response(Bun.file(join(import.meta.dir, "..", "public", "index.html")));
  }
  if (!path.startsWith("/api/")) return new Response("Not found", { status: 404 });
  if (req.method !== "GET" && req.headers.get(CSRF_HEADER) !== "1") {
    throw new HttpError(403, `Header ${CSRF_HEADER}: 1 is missing.`);
  }

  if (req.method === "GET" && path === "/api/status") {
    let filter: DnsFilter | null = null;
    try {
      filter = await getFilter();
    } catch {
      /* the error is in lastBoxError */
    }
    return json({
      boxError: lastBoxError,
      filterEnabled: typeof filter?.enabled === "boolean" ? filter.enabled : null,
      statistics: filter?.statistics?.dnsQueryCount ?? null,
      domains: filter?.domains ?? [],
      lists: rules.ready ? rules.status() : (filter?.filterlists ?? []).map((l) => ({ name: l.name, url: l.url, enabled: l.enabled, action: l.action ?? "block", boxEntryCount: l.status?.entryCount, indexedRules: 0, skippedLines: 0, indexBytes: 0 })),
      listsReady: rules.ready,
    });
  }

  if (req.method === "GET" && path === "/api/check") {
    const input = url.searchParams.get("domain") ?? "";
    const filter = await getFilter();
    try {
      const result = await analyze(input, {
        query,
        lookupRules: (name) => rules.lookup(name),
        domains: filter.domains ?? [],
        referenceDns: config.referenceDns,
        boxServers: await boxServersPromise,
      });
      if (!rules.ready) result.notes.unshift("The filter lists are still loading; hits may be missing.");
      return json(result);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  if (req.method === "GET" && path === "/api/stats") {
    const hours = Math.min(Number(url.searchParams.get("hours") ?? 24) || 24, 24 * 30);
    return json({ intervals: toIntervals(stats.since(Date.now() - hours * 3600 * 1000)), intervalSeconds: config.statsIntervalMs / 1000 });
  }

  if (req.method === "POST" && path === "/api/domains") {
    const body = await readBody<DomainChange & { dryRun?: boolean }>(req);
    if (!body.domain || (body.action !== "allow" && body.action !== "deny")) throw new HttpError(400, "domain and action (allow|deny) are required.");
    const change: DomainChange = { domain: body.domain.trim().toLowerCase(), action: body.action, enabled: body.enabled !== false, comment: body.comment };
    const filter = await getFilter(0);
    return json(await writeOrPlan({ domains: upsertDomain(filter.domains ?? [], change) }, body.dryRun !== false, (after) => domainApplied(after.domains, change)));
  }

  if (req.method === "POST" && path === "/api/lists/toggle") {
    const body = await readBody<{ url: string; enabled: boolean; dryRun?: boolean }>(req);
    const filter = await getFilter(0);
    let lists: FilterList[];
    try {
      lists = writableLists(setListEnabled(filter.filterlists ?? [], body.url, Boolean(body.enabled)));
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
    return json(await writeOrPlan({ filterlists: lists }, body.dryRun !== false, (after) => after.filterlists?.find((l) => l.url === body.url)?.enabled === Boolean(body.enabled)));
  }

  if (req.method === "POST" && path === "/api/filter/toggle") {
    const body = await readBody<{ enabled: boolean; dryRun?: boolean }>(req);
    const filter = await getFilter(0);
    if (typeof filter.enabled !== "boolean") throw new HttpError(409, "The box does not provide a switch for the whole DNS filter.");
    return json(await writeOrPlan({ enabled: Boolean(body.enabled) }, body.dryRun !== false, (after) => after.enabled === Boolean(body.enabled)));
  }

  if (req.method === "POST" && path === "/api/lists/refresh") {
    await refreshLists();
    return json({ lists: rules.status() });
  }

  return json({ error: "Not found" }, 404);
}

const hostname = config.uiPassword ? "0.0.0.0" : "127.0.0.1";
const server = Bun.serve({
  hostname,
  port: config.port,
  async fetch(req) {
    if (!checkAuth(req)) {
      return new Response("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="fritz-whyblocked", charset="UTF-8"' } });
    }
    try {
      return await handle(req);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 502;
      return json({ error: (err as Error).message }, status);
    }
  },
});

console.log(`fritz-whyblocked running at http://${hostname}:${server.port}${config.uiPassword ? "" : " (local only; set UI_PASSWORD for LAN access)"}`);

void refreshLists();
void recordStats();
setInterval(() => void refreshLists(), config.listsRefreshMs);
setInterval(() => void recordStats(), config.statsIntervalMs);
