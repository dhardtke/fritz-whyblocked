/**
 * FRITZ!Box access: login via login_sid.lua (version 2, PBKDF2)
 * and the beta API /api/v0/beta/dnsfilter.
 */

export interface FilterList {
  name: string;
  url: string;
  enabled: boolean;
  /** e.g. "block" or "allow", as reported by the box */
  action?: string;
  status?: { entryCount?: number; [key: string]: unknown };
  UID?: string;
  [key: string]: unknown;
}

export interface DomainEntry {
  enabled: boolean;
  comment?: string;
  action: 'allow' | 'deny';
  domain: string;
  UID?: string;
  [key: string]: unknown;
}

export interface DnsFilter {
  enabled?: boolean;
  filterlists?: FilterList[];
  domains?: DomainEntry[];
  statistics?: { dnsQueryCount?: { blocked?: number; total?: number; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * One write to the box. `path` is relative to the DNS filter endpoint. The box ignores `domains` and `filterlists` in
 * a PUT of the whole filter (it answers 200 and changes nothing), so entries and lists are written one by one through
 * their own resources.
 */
export interface BoxRequest {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

/** Every field of DnsFilter is optional, so any JSON object is one; the UI copes with missing fields. */
function isDnsFilter(value: unknown): value is DnsFilter {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const INVALID_SID = '0000000000000000';

function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
}

function hex(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('hex');
}

async function pbkdf2(password: Uint8Array<ArrayBuffer> | ArrayBuffer, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

/** Answers a challenge of the form 2$<iter1>$<salt1>$<iter2>$<salt2>. */
export async function solveChallenge(challenge: string, password: string): Promise<string> {
  const parts = challenge.split('$');
  if (parts[0] !== '2' || parts.length !== 5) {
    throw new Error(`The box does not offer PBKDF2 login (challenge "${challenge}"). FRITZ!OS 7.24 or later is required.`);
  }
  const [, iter1 = '', salt1 = '', iter2 = '', salt2 = ''] = parts;
  const hash1 = await pbkdf2(new TextEncoder().encode(password), new Uint8Array(Buffer.from(salt1, 'hex')), Number(iter1));
  const hash2 = await pbkdf2(hash1, new Uint8Array(Buffer.from(salt2, 'hex')), Number(iter2));
  return `${salt2}$${hex(hash2)}`;
}

export class FritzBox {
  #sid: string | null = null;
  #loginPromise: Promise<string> | null = null;
  readonly #base: string;
  readonly #user: string;
  readonly #password: string;

  constructor(host: string, user: string, password: string) {
    this.#user = user;
    this.#password = password;
    this.#base = host.startsWith('http') ? host.replace(/\/$/, '') : `http://${host}`;
  }

  get dnsFilterUrl(): string {
    return `${this.#base}/api/v0/beta/dnsfilter`;
  }

  async #login(): Promise<string> {
    if (!this.#password) {
      throw new Error('No FRITZ!Box password set (FRITZ_PASSWORD or credential fritz-password).');
    }
    const url = `${this.#base}/login_sid.lua?version=2`;
    const xml = await (await fetch(url)).text();
    const blockTime = Number(tag(xml, 'BlockTime') ?? 0);
    if (blockTime > 0) {
      await Bun.sleep(blockTime * 1000);
    }
    const challenge = tag(xml, 'Challenge');
    if (!challenge) {
      throw new Error('Response from login_sid.lua contains no challenge.');
    }
    const user = this.#user === '' ? (/<User last="1">([^<]*)<\/User>/.exec(xml)?.[1] ?? '') : this.#user;
    const response = await solveChallenge(challenge, this.#password);
    const result = await (
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: user, response }),
      })
    ).text();
    const sid = tag(result, 'SID');
    if (!sid || sid === INVALID_SID) {
      throw new Error(`FRITZ!Box login failed (user "${user || '?'}"). Check the password.`);
    }
    return sid;
  }

  async #getSid(force = false): Promise<string> {
    if (this.#sid && !force) {
      return this.#sid;
    }
    this.#loginPromise ??= this.#login().finally(() => {
      this.#loginPromise = null;
    });
    this.#sid = await this.#loginPromise;
    return this.#sid;
  }

  /** Calls the box API; logs in again once if the SID has expired. */
  async #api(method: 'GET' | BoxRequest['method'], url: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sid = await this.#getSid(attempt > 0);
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `AVM-SID ${sid}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status === 401 || res.status === 403) {
        this.#sid = null;
        continue;
      }
      if (!res.ok) {
        throw new Error(`${method} ${url}: HTTP ${res.status} ${await res.text()}`);
      }
      return res;
    }
    throw new Error(`${method} ${url}: access denied, even after logging in again.`);
  }

  async getDnsFilter(): Promise<DnsFilter> {
    const body: unknown = await (await this.#api('GET', this.dnsFilterUrl)).json();
    if (!isDnsFilter(body)) {
      throw new Error(`GET ${this.dnsFilterUrl}: the response is not a JSON object.`);
    }
    return body;
  }

  urlFor(path: string): string {
    return `${this.dnsFilterUrl}${path}`;
  }

  async send(request: BoxRequest): Promise<void> {
    await this.#api(request.method, this.urlFor(request.path), request.body);
  }
}

// ---------- pure helpers for changes ----------

export interface DomainChange {
  domain: string;
  action: 'allow' | 'deny';
  enabled: boolean;
  comment?: string;
}

export interface DomainKey {
  domain: string;
  action: 'allow' | 'deny';
}

function sameKey(entry: DomainKey, key: DomainKey): boolean {
  return entry.domain.toLowerCase() === key.domain.toLowerCase() && entry.action === key.action;
}

function keyLabel(key: DomainKey): string {
  return `${key.domain} (${key.action})`;
}

/** Without `target` the entry is added; without `change` the target is deleted. */
export interface DomainEdit {
  target?: DomainKey;
  change?: DomainChange;
}

export interface FilterEdits {
  enabled?: boolean;
  lists?: { url: string; enabled: boolean }[];
  domains?: DomainEdit[];
}

/** The state the box should report once every request of a plan has arrived. */
export interface ExpectedState {
  enabled?: boolean;
  lists?: FilterList[];
  domains?: DomainEntry[];
}

export interface EditPlan {
  requests: BoxRequest[];
  expected: ExpectedState;
}

const DEFAULT_COMMENT = 'fritz-whyblocked';

function uidPath(collection: string, item: { UID?: string }, label: string): string {
  if (typeof item.UID !== 'string' || item.UID === '') {
    throw new Error(`${label} has no UID, so the box cannot change it.`);
  }
  return `/${collection}/${encodeURIComponent(item.UID)}`;
}

/** The fields of an entry the box accepts; `UID` is in the path instead. */
function entryBody({ UID: _uid, ...fields }: DomainEntry): Omit<DomainEntry, 'UID'> {
  return fields;
}

/** The fields of a list the box accepts; `status` and `latestUpdate` are reported, not set. */
function listBody({ UID: _uid, status: _status, latestUpdate: _latestUpdate, ...fields }: FilterList): Omit<FilterList, 'UID' | 'status'> {
  return fields;
}

/** Adds an entry, or switches and comments the existing one with the same domain and action. */
export function upsertEdits(domains: DomainEntry[], change: DomainChange): FilterEdits {
  const existing = domains.find((d) => sameKey(d, change));
  return { domains: [existing ? { target: existing, change } : { change }] };
}

/**
 * Turns a batch of edits into the requests that apply it to the current state. Edited entries keep their UID, so the
 * box changes them in place. Targets are matched against the current state, so the batch fails if an entry it touches
 * is gone; uniqueness is checked on the result, so two entries can swap their domains. Deletes go first, so an entry
 * can be replaced by a new one with the same domain and action.
 */
export function planEdits(filter: DnsFilter, edits: FilterEdits): EditPlan {
  const requests: BoxRequest[] = [];
  const expected: ExpectedState = {};
  if (edits.enabled !== undefined && edits.enabled !== filter.enabled) {
    if (typeof filter.enabled !== 'boolean') {
      throw new Error('The box does not provide a switch for the whole DNS filter.');
    }
    requests.push({ method: 'PUT', path: '', body: { enabled: edits.enabled } });
    expected.enabled = edits.enabled;
  }
  for (const c of edits.lists ?? []) {
    const list = filter.filterlists?.find((l) => l.url === c.url);
    if (!list) {
      throw new Error(`Filter list ${c.url} not found.`);
    }
    if (list.enabled !== c.enabled) {
      const changed = { ...list, enabled: c.enabled };
      requests.push({ method: 'PUT', path: uidPath('filterlists', list, `List ${list.name}`), body: listBody(changed) });
      (expected.lists ??= []).push(changed);
    }
  }
  if (edits.domains !== undefined && edits.domains.length > 0) {
    const domains = planDomainEdits(filter.domains ?? [], edits.domains);
    if (domains.requests.length) {
      requests.push(...domains.requests);
      expected.domains = domains.result;
    }
  }
  if (!requests.length) {
    throw new Error('Nothing to change.');
  }
  return { requests, expected };
}

function planDomainEdits(domains: DomainEntry[], edits: DomainEdit[]): { requests: BoxRequest[]; result: DomainEntry[] } {
  const byIndex = new Map<number, DomainChange | null>();
  const added: DomainEntry[] = [];
  for (const { target, change } of edits) {
    if (!target) {
      if (change) {
        const comment = change.comment === undefined || change.comment === '' ? DEFAULT_COMMENT : change.comment;
        added.push({ enabled: change.enabled, comment, action: change.action, domain: change.domain.toLowerCase() });
      }
      continue;
    }
    const idx = domains.findIndex((d) => sameKey(d, target));
    if (idx < 0) {
      throw new Error(`Entry ${keyLabel(target)} not found; it may have been changed elsewhere.`);
    }
    if (byIndex.has(idx)) {
      throw new Error(`Entry ${keyLabel(target)} is edited twice.`);
    }
    byIndex.set(idx, change ?? null);
  }

  const deletes: BoxRequest[] = [];
  const updates: BoxRequest[] = [];
  const result: DomainEntry[] = [];
  domains.forEach((d, i) => {
    const change = byIndex.get(i);
    if (change === undefined) {
      result.push(d);
      return;
    }
    const path = uidPath('domains', d, `Entry ${keyLabel(d)}`);
    if (change === null) {
      deletes.push({ method: 'DELETE', path });
      return;
    }
    const updated: DomainEntry = {
      ...d,
      domain: change.domain.toLowerCase(),
      action: change.action,
      enabled: change.enabled,
      ...(change.comment !== undefined ? { comment: change.comment } : {}),
    };
    result.push(updated);
    if (updated.domain !== d.domain || updated.action !== d.action || updated.enabled !== d.enabled || updated.comment !== d.comment) {
      updates.push({ method: 'PUT', path, body: entryBody(updated) });
    }
  });
  result.push(...added);
  result.forEach((d, i) => {
    if (result.findIndex((o) => sameKey(o, d)) !== i) {
      throw new Error(`There are two entries for ${keyLabel(d)}.`);
    }
  });
  const adds = added.map((d): BoxRequest => ({ method: 'POST', path: '/domains', body: d }));
  return { requests: [...deletes, ...updates, ...adds], result };
}

/** Compares the state read back after a write with the expected state and lists what does not match. */
export function editsMismatches(before: DnsFilter, expected: ExpectedState, after: DnsFilter): string[] {
  const problems: string[] = [];
  if (expected.enabled !== undefined && after.enabled !== expected.enabled) {
    problems.push(`the DNS filter is still ${after.enabled === true ? 'on' : 'off'}`);
  }
  for (const want of expected.lists ?? []) {
    if (after.filterlists?.find((l) => l.url === want.url)?.enabled !== want.enabled) {
      problems.push(`list ${want.name} is not ${want.enabled ? 'on' : 'off'}`);
    }
  }
  if (expected.domains) {
    const now = after.domains ?? [];
    for (const want of expected.domains) {
      const entry = now.find((d) => sameKey(d, want));
      if (!entry) {
        problems.push(`${keyLabel(want)} is missing`);
      } else if (entry.enabled !== want.enabled) {
        problems.push(`${keyLabel(want)} is not ${want.enabled ? 'on' : 'off'}`);
      } else if ((entry.comment ?? '') !== (want.comment ?? '')) {
        problems.push(`${keyLabel(want)} does not have the comment "${want.comment ?? ''}"`);
      }
    }
    for (const b of before.domains ?? []) {
      if (!expected.domains.some((w) => sameKey(w, b)) && now.some((d) => sameKey(d, b))) {
        problems.push(`${keyLabel(b)} is still there`);
      }
    }
  }
  return problems;
}
