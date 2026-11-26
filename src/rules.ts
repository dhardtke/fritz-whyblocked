/**
 * Rule index for the box's filter lists.
 *
 * Each rule is stored as a 44-bit hash of the domain plus 2 bits of rule kind in a sorted
 * Float64Array (8 bytes per rule; false positives about 1 in 8 million with 2 million rules).
 * A hit is confirmed against the cached list text before it is shown.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from './errors.ts';
import type { FilterList } from './fritz.ts';

export const KIND = {
  /** applies to exactly this domain (hosts line, |domain^, bare domain) */
  EXACT: 0,
  /** domain and all subdomains (||domain^) */
  WITH_SUBDOMAINS: 1,
  /** subdomains only (*.domain) */
  SUBDOMAINS_ONLY: 2,
  /** exception within the list itself (@@||domain^) */
  EXCEPTION: 3,
} as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

/** The kinds indexed by their value. */
const KINDS: readonly Kind[] = [KIND.EXACT, KIND.WITH_SUBDOMAINS, KIND.SUBDOMAINS_ONLY, KIND.EXCEPTION];

export const KIND_LABEL: Record<Kind, string> = {
  0: 'exact',
  1: 'domain and subdomains',
  2: 'subdomains only',
  3: 'exception in list',
};

export interface ParsedRule {
  domain: string;
  kind: Kind;
}

const DOMAIN_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const HOSTS_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|0:0:0:0:0:0:0:0)\s+(.+)$/;
const HOSTS_IGNORE = new Set(['localhost', 'localhost.localdomain', 'local', 'broadcasthost', 'ip6-localhost', 'ip6-loopback', '0.0.0.0']);

function valid(domain: string): boolean {
  return domain.length <= 253 && DOMAIN_RE.test(domain);
}

/** Parses a line in Adblock, hosts or wildcard format. Anything unknown yields []. */
export function parseLine(raw: string): ParsedRule[] {
  const line = raw.trim().toLowerCase();
  if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[')) {
    return [];
  }

  const hosts = HOSTS_RE.exec(line);
  if (hosts !== null) {
    return (hosts[1] ?? '')
      .replace(/#.*/, '')
      .split(/\s+/)
      .filter((d) => d !== '' && !HOSTS_IGNORE.has(d) && valid(d))
      .map((domain) => ({ domain, kind: KIND.EXACT }));
  }

  let rest = line;
  let exception = false;
  if (rest.startsWith('@@')) {
    exception = true;
    rest = rest.slice(2);
  }
  // ignore modifiers ($important, $client=…)
  const dollar = rest.indexOf('$');
  if (dollar >= 0) {
    rest = rest.slice(0, dollar);
  }

  let kind: Kind;
  if (rest.startsWith('||')) {
    kind = KIND.WITH_SUBDOMAINS;
    rest = rest.slice(2);
  } else if (rest.startsWith('|')) {
    kind = KIND.EXACT;
    rest = rest.slice(1);
  } else if (rest.startsWith('*.')) {
    kind = KIND.SUBDOMAINS_ONLY;
    rest = rest.slice(2);
  } else {
    kind = KIND.EXACT;
  }
  if (rest.endsWith('^')) {
    rest = rest.slice(0, -1);
  }
  if (rest.endsWith('.')) {
    rest = rest.slice(0, -1);
  }
  if (!valid(rest)) {
    return [];
  }
  return [{ domain: rest, kind: exception ? KIND.EXCEPTION : kind }];
}

const HASH_BITS = 44n;

export function hashDomain(domain: string): number {
  return Number(BigInt.asUintN(Number(HASH_BITS), Bun.hash.wyhash(domain)));
}

export class RuleIndex {
  readonly #values: Float64Array;
  readonly ruleCount: number;
  readonly skippedLines: number;

  private constructor(values: Float64Array, ruleCount: number, skippedLines: number) {
    this.#values = values;
    this.ruleCount = ruleCount;
    this.skippedLines = skippedLines;
  }

  static build(text: string): RuleIndex {
    let values = new Float64Array(1 << 16);
    let n = 0;
    let skipped = 0;
    for (const line of text.split('\n')) {
      const rules = parseLine(line);
      if (rules.length === 0) {
        const t = line.trim();
        if (t && !t.startsWith('!') && !t.startsWith('#') && !t.startsWith('[')) {
          skipped++;
        }
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
    // remove duplicates
    let w = 0;
    let previous: number | undefined;
    for (const value of sorted) {
      if (value !== previous) {
        sorted[w++] = value;
        previous = value;
      }
    }
    return new RuleIndex(sorted.slice(0, w), w, skipped);
  }

  get bytes(): number {
    return this.#values.byteLength;
  }

  /** All rule kinds listed for exactly this domain. */
  kindsFor(domain: string): Kind[] {
    const base = hashDomain(domain) * 4;
    let lo = 0,
      hi = this.#values.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.#values[mid] ?? Infinity) < base) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const kinds: Kind[] = [];
    for (let i = lo; i < this.#values.length; i++) {
      const kind = KINDS[(this.#values[i] ?? Infinity) - base];
      if (kind === undefined) {
        break;
      }
      kinds.push(kind);
    }
    return kinds;
  }
}

export interface RuleHit {
  listName: string;
  listUrl: string;
  listEnabled: boolean;
  /** "allow" for allow lists, otherwise "block" */
  listAction: string;
  /** Domain the rule is listed under (the name itself or a parent domain) */
  ruleDomain: string;
  kind: Kind;
  kindLabel: string;
  /** false if it is undocumented whether the box interprets the rule this way */
  certain: boolean;
  /** Line from the list, if found in the cache */
  line?: string;
}

/** All domains a rule for `name` could be listed under: the name and its parents down to TLD+1. */
export function candidates(name: string): string[] {
  const parts = name.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts.slice(i).join('.'));
  }
  return out;
}

/** Classifies a rule kind for a name: does the rule apply, and is that interpretation certain? */
export function classify(name: string, ruleDomain: string, kind: Kind): { applies: boolean; certain: boolean } {
  const self = name === ruleDomain;
  if (kind === KIND.SUBDOMAINS_ONLY) {
    return { applies: !self, certain: true };
  }
  // Whether hosts/domain entries also block subdomains is undocumented for the box.
  return { applies: true, certain: kind !== KIND.EXACT || self };
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
  #lists: LoadedList[] = [];
  #refreshing: Promise<void> | null = null;

  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  #cacheFile(url: string): string {
    return join(this.#dataDir, 'lists', `${new Bun.CryptoHasher('sha1').update(url).digest('hex')}.txt`);
  }

  /** Downloads all of the box's lists (falling back to the cache on error) and rebuilds the indexes. */
  refresh(filterlists: FilterList[]): Promise<void> {
    this.#refreshing ??= this.#doRefresh(filterlists).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #doRefresh(filterlists: FilterList[]): Promise<void> {
    await mkdir(join(this.#dataDir, 'lists'), { recursive: true });
    const next: LoadedList[] = [];
    for (const meta of filterlists) {
      const file = this.#cacheFile(meta.url);
      let error: string | undefined;
      try {
        const res = await fetch(meta.url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        await Bun.write(file, await res.text());
      } catch (err) {
        error = `download failed (${errorMessage(err)})`;
      }
      const cached = Bun.file(file);
      if (await cached.exists()) {
        const index = RuleIndex.build(await cached.text());
        next.push({ meta, index, file, loadedAt: error ? cached.lastModified : Date.now(), ...(error ? { error: `${error}, using cache` } : {}) });
      } else {
        next.push({ meta, index: null, file, error: error ?? 'not loaded' });
      }
    }
    this.#lists = next;
  }

  /** Takes over metadata (enabled, name) from the box without downloading again. */
  updateMeta(filterlists: FilterList[]): void {
    for (const l of this.#lists) {
      const fresh = filterlists.find((f) => f.url === l.meta.url);
      if (fresh) {
        l.meta = fresh;
      }
    }
  }

  get ready(): boolean {
    return this.#lists.length > 0;
  }

  status(): ListStatus[] {
    return this.#lists.map((l) => ({
      name: l.meta.name,
      url: l.meta.url,
      enabled: l.meta.enabled,
      action: l.meta.action ?? 'block',
      boxEntryCount: l.meta.status?.entryCount,
      indexedRules: l.index?.ruleCount ?? 0,
      skippedLines: l.index?.skippedLines ?? 0,
      indexBytes: l.index?.bytes ?? 0,
      loadedAt: l.loadedAt,
      error: l.error,
    }));
  }

  /** Finds all rules that could apply to `name` and confirms them in the list text. */
  async lookup(name: string): Promise<RuleHit[]> {
    const hits: RuleHit[] = [];
    for (const l of this.#lists) {
      if (!l.index) {
        continue;
      }
      for (const ruleDomain of candidates(name)) {
        for (const kind of l.index.kindsFor(ruleDomain)) {
          const { applies, certain } = classify(name, ruleDomain, kind);
          if (!applies) {
            continue;
          }
          const line = await findLine(l.file, ruleDomain, kind);
          // No line means a hash collision.
          if (line === null) {
            continue;
          }
          hits.push({
            listName: l.meta.name,
            listUrl: l.meta.url,
            listEnabled: l.meta.enabled,
            listAction: l.meta.action ?? 'block',
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

/** Finds a rule's original line in the cache; null if there is none (hash collision). */
export async function findLine(file: string, domain: string, kind: Kind): Promise<string | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) {
    return null;
  }
  const text = await f.text();
  let from = 0;
  for (;;) {
    const at = text.indexOf(domain, from);
    if (at < 0) {
      return null;
    }
    const start = text.lastIndexOf('\n', at) + 1;
    const endIdx = text.indexOf('\n', at);
    const line = text.slice(start, endIdx < 0 ? undefined : endIdx);
    if (parseLine(line).some((r) => r.domain === domain && r.kind === kind)) {
      return line.trim();
    }
    from = at + domain.length;
  }
}
