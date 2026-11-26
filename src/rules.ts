/**
 * Regel-Index für die Filterlisten der Box.
 *
 * Jede Regel wird als 44-Bit-Hash der Domain plus 2 Bit Regelart in einem sortierten
 * Float64Array abgelegt (8 Byte pro Regel; Fehltreffer etwa 1 zu 8 Mio. bei 2 Mio. Regeln).
 * Ein Treffer wird zur Anzeige im zwischengespeicherten Listentext bestätigt.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FilterList } from "./fritz.ts";

export const KIND = {
  /** gilt nur für genau diese Domain (Hosts-Zeile, |domain^, nackte Domain) */
  EXACT: 0,
  /** Domain und alle Subdomains (||domain^) */
  WITH_SUBDOMAINS: 1,
  /** nur Subdomains (*.domain) */
  SUBDOMAINS_ONLY: 2,
  /** Ausnahme in der Liste selbst (@@||domain^) */
  EXCEPTION: 3,
} as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

export const KIND_LABEL: Record<Kind, string> = {
  0: "exakt",
  1: "Domain und Subdomains",
  2: "nur Subdomains",
  3: "Ausnahme in der Liste",
};

export interface ParsedRule {
  domain: string;
  kind: Kind;
}

const DOMAIN_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const HOSTS_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|0:0:0:0:0:0:0:0)\s+(.+)$/;
const HOSTS_IGNORE = new Set(["localhost", "localhost.localdomain", "local", "broadcasthost", "ip6-localhost", "ip6-loopback", "0.0.0.0"]);

function valid(domain: string): boolean {
  return domain.length <= 253 && DOMAIN_RE.test(domain);
}

/** Zerlegt eine Zeile im Adblock-, Hosts- oder Wildcard-Format. Unbekanntes ergibt []. */
export function parseLine(raw: string): ParsedRule[] {
  const line = raw.trim().toLowerCase();
  if (!line || line[0] === "!" || line[0] === "#" || line[0] === "[") return [];

  const hosts = line.match(HOSTS_RE);
  if (hosts) {
    return (hosts[1] ?? "")
      .split("#")[0]!
      .split(/\s+/)
      .filter((d) => d && !HOSTS_IGNORE.has(d) && valid(d))
      .map((domain) => ({ domain, kind: KIND.EXACT }));
  }

  let rest = line;
  let exception = false;
  if (rest.startsWith("@@")) {
    exception = true;
    rest = rest.slice(2);
  }
  // Modifikatoren ($important, $client=…) ignorieren
  const dollar = rest.indexOf("$");
  if (dollar >= 0) rest = rest.slice(0, dollar);

  let kind: Kind;
  if (rest.startsWith("||")) {
    kind = KIND.WITH_SUBDOMAINS;
    rest = rest.slice(2);
  } else if (rest.startsWith("|")) {
    kind = KIND.EXACT;
    rest = rest.slice(1);
  } else if (rest.startsWith("*.")) {
    kind = KIND.SUBDOMAINS_ONLY;
    rest = rest.slice(2);
  } else {
    kind = KIND.EXACT;
  }
  if (rest.endsWith("^")) rest = rest.slice(0, -1);
  if (rest.endsWith(".")) rest = rest.slice(0, -1);
  if (!valid(rest)) return [];
  return [{ domain: rest, kind: exception ? KIND.EXCEPTION : kind }];
}

const HASH_BITS = 44n;

export function hashDomain(domain: string): number {
  return Number(BigInt.asUintN(Number(HASH_BITS), BigInt(Bun.hash.wyhash(domain))));
}

export class RuleIndex {
  private constructor(
    private readonly values: Float64Array,
    readonly ruleCount: number,
    readonly skippedLines: number,
  ) {}

  static build(text: string): RuleIndex {
    let values = new Float64Array(1 << 16);
    let n = 0;
    let skipped = 0;
    for (const line of text.split("\n")) {
      const rules = parseLine(line);
      if (rules.length === 0) {
        const t = line.trim();
        if (t && t[0] !== "!" && t[0] !== "#" && t[0] !== "[") skipped++;
        continue;
      }
      for (const r of rules) {
        if (n === values.length) {
          const bigger = new Float64Array(values.length * 2);
          bigger.set(values);
          values = bigger;
        }
        values[n++] = hashDomain(r.domain) * 4 + r.kind;
      }
    }
    const sorted = values.slice(0, n).sort();
    // Duplikate entfernen
    let w = 0;
    for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[w - 1]) sorted[w++] = sorted[i]!;
    return new RuleIndex(sorted.slice(0, w), w, skipped);
  }

  get bytes(): number {
    return this.values.byteLength;
  }

  /** Alle Regelarten, die für genau diese Domain eingetragen sind. */
  kindsFor(domain: string): Kind[] {
    const base = hashDomain(domain) * 4;
    let lo = 0, hi = this.values.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.values[mid]! < base) lo = mid + 1;
      else hi = mid;
    }
    const kinds: Kind[] = [];
    for (let i = lo; i < this.values.length && this.values[i]! < base + 4; i++) kinds.push((this.values[i]! - base) as Kind);
    return kinds;
  }
}

export interface RuleHit {
  listName: string;
  listUrl: string;
  listEnabled: boolean;
  /** "allow" bei Freigabe-Listen, sonst "block" */
  listAction: string;
  /** Domain, unter der die Regel eingetragen ist (der Name selbst oder eine Eltern-Domain) */
  ruleDomain: string;
  kind: Kind;
  kindLabel: string;
  /** false, wenn nicht dokumentiert ist, ob die Box die Regel so auslegt */
  certain: boolean;
  /** Zeile aus der Liste, sofern im Cache gefunden */
  line?: string;
}

/** Alle Domains, unter denen eine Regel für `name` stehen könnte: name, Eltern bis zur TLD+1. */
export function candidates(name: string): string[] {
  const parts = name.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}

/** Ordnet Regelarten für einen Namen ein: greift die Regel und ist die Auslegung sicher? */
export function classify(name: string, ruleDomain: string, kind: Kind): { applies: boolean; certain: boolean } {
  const self = name === ruleDomain;
  switch (kind) {
    case KIND.EXACT:
      // Ob Hosts-/Domain-Einträge auch Subdomains sperren, ist bei der Box nicht dokumentiert.
      return self ? { applies: true, certain: true } : { applies: true, certain: false };
    case KIND.WITH_SUBDOMAINS:
    case KIND.EXCEPTION:
      return { applies: true, certain: true };
    case KIND.SUBDOMAINS_ONLY:
      return { applies: !self, certain: true };
  }
}

interface LoadedList {
  meta: FilterList;
  index: RuleIndex | null;
  file: string;
  error?: string;
  loadedAt?: number;
}

export interface ListStatus {
  name: string;
  url: string;
  enabled: boolean;
  action: string;
  boxEntryCount?: number;
  indexedRules: number;
  skippedLines: number;
  indexBytes: number;
  loadedAt?: number;
  error?: string;
}

export class RuleSet {
  private lists: LoadedList[] = [];
  private refreshing: Promise<void> | null = null;

  constructor(private readonly dataDir: string) {}

  private cacheFile(url: string): string {
    return join(this.dataDir, "lists", `${new Bun.CryptoHasher("sha1").update(url).digest("hex")}.txt`);
  }

  /** Lädt alle Listen der Box herunter (bei Fehler aus dem Cache) und baut die Indizes neu. */
  refresh(filterlists: FilterList[]): Promise<void> {
    this.refreshing ??= this.doRefresh(filterlists).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(filterlists: FilterList[]): Promise<void> {
    await mkdir(join(this.dataDir, "lists"), { recursive: true });
    const next: LoadedList[] = [];
    for (const meta of filterlists) {
      const file = this.cacheFile(meta.url);
      let error: string | undefined;
      try {
        const res = await fetch(meta.url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await Bun.write(file, await res.text());
      } catch (err) {
        error = `Download fehlgeschlagen (${(err as Error).message})`;
      }
      const cached = Bun.file(file);
      if (await cached.exists()) {
        const index = RuleIndex.build(await cached.text());
        next.push({ meta, index, file, loadedAt: error ? cached.lastModified : Date.now(), ...(error ? { error: `${error}, nutze Cache` } : {}) });
      } else {
        next.push({ meta, index: null, file, error: error ?? "nicht geladen" });
      }
    }
    this.lists = next;
  }

  /** Übernimmt Metadaten (enabled, Name) aus der Box, ohne neu herunterzuladen. */
  updateMeta(filterlists: FilterList[]): void {
    for (const l of this.lists) {
      const fresh = filterlists.find((f) => f.url === l.meta.url);
      if (fresh) l.meta = fresh;
    }
  }

  get ready(): boolean {
    return this.lists.length > 0;
  }

  status(): ListStatus[] {
    return this.lists.map((l) => ({
      name: l.meta.name,
      url: l.meta.url,
      enabled: l.meta.enabled,
      action: l.meta.action ?? "block",
      boxEntryCount: l.meta.status?.entryCount,
      indexedRules: l.index?.ruleCount ?? 0,
      skippedLines: l.index?.skippedLines ?? 0,
      indexBytes: l.index?.bytes ?? 0,
      loadedAt: l.loadedAt,
      error: l.error,
    }));
  }

  /** Sucht alle Regeln, die für `name` greifen könnten, und bestätigt sie im Listentext. */
  async lookup(name: string): Promise<RuleHit[]> {
    const hits: RuleHit[] = [];
    for (const l of this.lists) {
      if (!l.index) continue;
      for (const ruleDomain of candidates(name)) {
        for (const kind of l.index.kindsFor(ruleDomain)) {
          const { applies, certain } = classify(name, ruleDomain, kind);
          if (!applies) continue;
          const line = await findLine(l.file, ruleDomain, kind);
          if (line === null) continue; // Hash-Kollision
          hits.push({
            listName: l.meta.name,
            listUrl: l.meta.url,
            listEnabled: l.meta.enabled,
            listAction: l.meta.action ?? "block",
            ruleDomain,
            kind,
            kindLabel: KIND_LABEL[kind],
            certain,
            line,
          });
        }
      }
    }
    return hits;
  }
}

/** Sucht die Originalzeile einer Regel im Cache; null, wenn es sie nicht gibt (Hash-Kollision). */
export async function findLine(file: string, domain: string, kind: Kind): Promise<string | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  const text = await f.text();
  let from = 0;
  for (;;) {
    const at = text.indexOf(domain, from);
    if (at < 0) return null;
    const start = text.lastIndexOf("\n", at) + 1;
    const endIdx = text.indexOf("\n", at);
    const line = text.slice(start, endIdx < 0 ? undefined : endIdx);
    if (parseLine(line).some((r) => r.domain === domain && r.kind === kind)) return line.trim();
    from = at + domain.length;
  }
}
