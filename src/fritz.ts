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

export interface PlannedRequest {
  method: 'PUT';
  url: string;
  body: Partial<DnsFilter>;
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
  async #api(method: 'GET' | 'PUT', url: string, body?: unknown): Promise<Response> {
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

  /** Builds the PUT request without sending it (dry run). */
  plan(body: Partial<DnsFilter>): PlannedRequest {
    return { method: 'PUT', url: this.dnsFilterUrl, body };
  }

  async put(body: Partial<DnsFilter>): Promise<void> {
    await this.#api('PUT', this.dnsFilterUrl, body);
  }
}

// ---------- pure helpers for changes ----------

export interface DomainChange {
  domain: string;
  action: 'allow' | 'deny';
  enabled: boolean;
  comment?: string;
}

/**
 * Adds an entry or updates an existing one with the same domain and action.
 * New entries get no UID; the box assigns it.
 */
export function upsertDomain(domains: DomainEntry[], change: DomainChange): DomainEntry[] {
  const domain = change.domain.toLowerCase();
  const idx = domains.findIndex((d) => d.domain.toLowerCase() === domain && d.action === change.action);
  if (idx >= 0) {
    return domains.map((d, i) => (i === idx ? { ...d, enabled: change.enabled, ...(change.comment !== undefined ? { comment: change.comment } : {}) } : d));
  }
  return [...domains, { enabled: change.enabled, comment: change.comment ?? 'fritz-whyblocked', action: change.action, domain }];
}

/** Checks after writing whether the box has applied the desired state. */
export function domainApplied(domains: DomainEntry[] | undefined, change: DomainChange): boolean {
  return (domains ?? []).some((d) => d.domain.toLowerCase() === change.domain.toLowerCase() && d.action === change.action && d.enabled === change.enabled);
}

export function setListEnabled(lists: FilterList[], url: string, enabled: boolean): FilterList[] {
  if (!lists.some((l) => l.url === url)) {
    throw new Error(`Filter list ${url} not found.`);
  }
  return lists.map((l) => (l.url === url ? { ...l, enabled } : l));
}
