/**
 * Zugriff auf die FRITZ!Box: Login über login_sid.lua (Version 2, PBKDF2)
 * und die Beta-API /api/v0/beta/dnsfilter.
 */

export interface FilterList {
  name: string;
  url: string;
  enabled: boolean;
  /** z. B. "block" oder "allow" – von der Box vorgegeben */
  action?: string;
  status?: { entryCount?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface DomainEntry {
  enabled: boolean;
  comment?: string;
  action: "allow" | "deny";
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
  method: "PUT";
  url: string;
  body: Partial<DnsFilter>;
}

const INVALID_SID = "0000000000000000";

function tag(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
}

function hex(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("hex");
}

async function pbkdf2(password: Uint8Array<ArrayBuffer> | ArrayBuffer, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

/** Beantwortet eine Challenge der Form 2$<iter1>$<salt1>$<iter2>$<salt2>. */
export async function solveChallenge(challenge: string, password: string): Promise<string> {
  const parts = challenge.split("$");
  if (parts[0] !== "2" || parts.length !== 5) {
    throw new Error(`Box bietet kein PBKDF2-Login an (Challenge "${challenge}"). FRITZ!OS ab 7.24 nötig.`);
  }
  const [, iter1, salt1, iter2, salt2] = parts as [string, string, string, string, string];
  const hash1 = await pbkdf2(new TextEncoder().encode(password), new Uint8Array(Buffer.from(salt1, "hex")), Number(iter1));
  const hash2 = await pbkdf2(hash1, new Uint8Array(Buffer.from(salt2, "hex")), Number(iter2));
  return `${salt2}$${hex(hash2)}`;
}

export class FritzBox {
  private sid: string | null = null;
  private loginPromise: Promise<string> | null = null;
  private readonly base: string;

  constructor(
    host: string,
    private readonly user: string,
    private readonly password: string,
  ) {
    this.base = host.startsWith("http") ? host.replace(/\/$/, "") : `http://${host}`;
  }

  get dnsFilterUrl(): string {
    return `${this.base}/api/v0/beta/dnsfilter`;
  }

  private async login(): Promise<string> {
    if (!this.password) throw new Error("Kein FRITZ!Box-Passwort gesetzt (FRITZ_PASSWORD bzw. Credential fritz-password).");
    const url = `${this.base}/login_sid.lua?version=2`;
    const xml = await (await fetch(url)).text();
    const blockTime = Number(tag(xml, "BlockTime") ?? 0);
    if (blockTime > 0) await Bun.sleep(blockTime * 1000);
    const challenge = tag(xml, "Challenge");
    if (!challenge) throw new Error("Antwort von login_sid.lua enthält keine Challenge.");
    const user = this.user || xml.match(/<User last="1">([^<]*)<\/User>/)?.[1] || "";
    const response = await solveChallenge(challenge, this.password);
    const result = await (
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: user, response }),
      })
    ).text();
    const sid = tag(result, "SID");
    if (!sid || sid === INVALID_SID) {
      throw new Error(`Login bei der FRITZ!Box fehlgeschlagen (Benutzer "${user || "?"}"). Passwort prüfen.`);
    }
    return sid;
  }

  private async getSid(force = false): Promise<string> {
    if (this.sid && !force) return this.sid;
    this.loginPromise ??= this.login().finally(() => (this.loginPromise = null));
    this.sid = await this.loginPromise;
    return this.sid;
  }

  /** Aufruf der Box-API; bei abgelaufener SID einmal neu anmelden. */
  private async api(method: "GET" | "PUT", url: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sid = await this.getSid(attempt > 0);
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `AVM-SID ${sid}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 || res.status === 403) {
        this.sid = null;
        continue;
      }
      if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${await res.text()}`);
      return res;
    }
    throw new Error(`${method} ${url}: Zugriff verweigert, auch nach erneutem Login.`);
  }

  async getDnsFilter(): Promise<DnsFilter> {
    return (await (await this.api("GET", this.dnsFilterUrl)).json()) as DnsFilter;
  }

  /** Baut den PUT-Aufruf, ohne ihn abzuschicken (Probelauf). */
  plan(body: Partial<DnsFilter>): PlannedRequest {
    return { method: "PUT", url: this.dnsFilterUrl, body };
  }

  async put(body: Partial<DnsFilter>): Promise<void> {
    await this.api("PUT", this.dnsFilterUrl, body);
  }
}

// ---------- reine Hilfsfunktionen für Änderungen ----------

export interface DomainChange {
  domain: string;
  action: "allow" | "deny";
  enabled: boolean;
  comment?: string;
}

/**
 * Legt einen Eintrag an oder aktualisiert einen vorhandenen mit gleicher Domain und Aktion.
 * Neue Einträge bekommen keine UID; die vergibt die Box.
 */
export function upsertDomain(domains: DomainEntry[], change: DomainChange): DomainEntry[] {
  const domain = change.domain.toLowerCase();
  const idx = domains.findIndex((d) => d.domain.toLowerCase() === domain && d.action === change.action);
  if (idx >= 0) {
    return domains.map((d, i) =>
      i === idx ? { ...d, enabled: change.enabled, ...(change.comment !== undefined ? { comment: change.comment } : {}) } : d,
    );
  }
  return [...domains, { enabled: change.enabled, comment: change.comment ?? "fritz-whyblocked", action: change.action, domain }];
}

/** Prüft nach dem Schreiben, ob die Box den gewünschten Zustand übernommen hat. */
export function domainApplied(domains: DomainEntry[] | undefined, change: DomainChange): boolean {
  return (domains ?? []).some(
    (d) => d.domain.toLowerCase() === change.domain.toLowerCase() && d.action === change.action && d.enabled === change.enabled,
  );
}

export function setListEnabled(lists: FilterList[], url: string, enabled: boolean): FilterList[] {
  if (!lists.some((l) => l.url === url)) throw new Error(`Filterliste ${url} nicht gefunden.`);
  return lists.map((l) => (l.url === url ? { ...l, enabled } : l));
}
