/**
 * Analyse auf Abruf: CNAME-Kette über den Referenz-DNS auflösen, jedes Glied bei der Box
 * gegenprüfen (IPv4 und IPv6) und die Regeln suchen, die dafür verantwortlich sind.
 */
import { isBlockAddress, RCODE_NAMES, TYPE, type DnsResponse, type RecordType } from "./dns.ts";
import type { DomainEntry } from "./fritz.ts";
import type { RuleHit } from "./rules.ts";

export type QueryFn = (server: string, name: string, type: RecordType) => Promise<DnsResponse>;

export interface AnalysisDeps {
  query: QueryFn;
  lookupRules: (name: string) => Promise<RuleHit[]>;
  domains: DomainEntry[];
  referenceDns: string;
  boxServers: { label: string; address: string }[];
}

export interface BoxProbe {
  server: string;
  type: RecordType;
  blocked: boolean;
  addresses: string[];
  rcode?: string;
  error?: string;
}

export interface CustomHit {
  entry: DomainEntry;
  /** Eintrag gilt genau für diesen Namen (sonst über eine Eltern-Domain) */
  exact: boolean;
}

export interface ChainLink {
  name: string;
  blockedByBox: boolean;
  probes: BoxProbe[];
  ruleHits: RuleHit[];
  customHits: CustomHit[];
}

export interface Analysis {
  input: string;
  domain: string;
  chain: ChainLink[];
  referenceRcode?: string;
  referenceError?: string;
  blocked: boolean;
  /** letztes Glied, das die Box sperrt */
  trigger?: string;
  /** Listen und eigene Sperren, die das auslösende Glied sperren */
  responsible: { lists: RuleHit[]; custom: CustomHit[] };
  /** Domain, für die eine Ausnahme die Sperre aufheben sollte */
  suggestedAllow?: string;
  notes: string[];
}

/** Macht aus Domain oder URL einen kleingeschriebenen Hostnamen (IDN als Punycode). */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Bitte eine Domain oder URL eingeben.");
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`).hostname;
  } catch {
    throw new Error(`"${trimmed}" ist keine gültige Domain oder URL.`);
  }
  host = host.replace(/\.$/, "").toLowerCase();
  if (!host.includes(".") || host.startsWith("[")) throw new Error(`"${trimmed}" ist keine gültige Domain.`);
  return host;
}

/** Folgt den CNAME-Einträgen einer Antwort ab `name`. */
export function cnameChain(name: string, res: DnsResponse): string[] {
  const chain = [name];
  const seen = new Set(chain);
  for (let i = 0; i < 16; i++) {
    const current = chain[chain.length - 1]!;
    const next = res.answers.find((a) => a.type === TYPE.CNAME && a.name === current)?.data;
    if (!next || seen.has(next)) break;
    chain.push(next);
    seen.add(next);
  }
  return chain;
}

export function customHitsFor(name: string, domains: DomainEntry[]): CustomHit[] {
  return domains
    .filter((e) => {
      const d = e.domain.toLowerCase().replace(/^\*\./, "");
      return name === d || name.endsWith(`.${d}`);
    })
    .map((entry) => ({ entry, exact: entry.domain.toLowerCase() === name }));
}

async function probe(deps: AnalysisDeps, name: string): Promise<BoxProbe[]> {
  const jobs = deps.boxServers.flatMap((s) =>
    (["A", "AAAA"] as const).map(async (type): Promise<BoxProbe> => {
      try {
        const res = await deps.query(s.address, name, type);
        const addresses = res.answers.filter((a) => a.type === TYPE[type]).map((a) => a.data);
        return { server: s.label, type, blocked: addresses.some(isBlockAddress), addresses, rcode: RCODE_NAMES[res.rcode] ?? String(res.rcode) };
      } catch (err) {
        return { server: s.label, type, blocked: false, addresses: [], error: (err as Error).message };
      }
    }),
  );
  return Promise.all(jobs);
}

export async function analyze(input: string, deps: AnalysisDeps): Promise<Analysis> {
  const domain = normalizeDomain(input);
  const notes: string[] = [];

  let names = [domain];
  let referenceRcode: string | undefined;
  let referenceError: string | undefined;
  try {
    const res = await deps.query(deps.referenceDns, domain, "A");
    referenceRcode = RCODE_NAMES[res.rcode] ?? String(res.rcode);
    names = cnameChain(domain, res);
    if (res.rcode === 3) notes.push(`Die Domain existiert laut ${deps.referenceDns} nicht (NXDOMAIN). Dann sperrt nicht die Box.`);
  } catch (err) {
    referenceError = (err as Error).message;
    notes.push(`Referenz-DNS ${deps.referenceDns} nicht erreichbar; CNAME-Kette unbekannt, nur die Domain selbst wird geprüft.`);
  }

  const chain: ChainLink[] = await Promise.all(
    names.map(async (name) => {
      const probes = await probe(deps, name);
      return {
        name,
        blockedByBox: probes.some((p) => p.blocked),
        probes,
        ruleHits: await deps.lookupRules(name),
        customHits: customHitsFor(name, deps.domains),
      };
    }),
  );

  for (const link of chain) {
    const blockedOn = new Set(link.probes.filter((p) => p.blocked).map((p) => p.server));
    const answeredOn = new Set(link.probes.filter((p) => !p.error).map((p) => p.server));
    if (blockedOn.size > 0 && blockedOn.size < answeredOn.size) {
      notes.push(`${link.name}: Die Box antwortet je nach Adresse unterschiedlich (gesperrt über ${[...blockedOn].join(", ")}).`);
    }
    if (link.probes.every((p) => p.error)) notes.push(`${link.name}: Die Box hat auf keine Anfrage geantwortet.`);
  }

  const blockedLinks = chain.filter((l) => l.blockedByBox);
  const triggerLink = blockedLinks[blockedLinks.length - 1];
  const responsible = {
    lists: triggerLink?.ruleHits.filter((h) => h.listEnabled && h.listAction !== "allow" && h.kind !== 3) ?? [],
    custom: triggerLink?.customHits.filter((h) => h.entry.enabled && h.entry.action === "deny") ?? [],
  };

  if (triggerLink) {
    if (triggerLink !== chain[0]) {
      notes.push(
        `Gesperrt ist das CNAME-Ziel ${triggerLink.name}, nicht ${domain} selbst. Eine Ausnahme für ${domain} hilft nicht, sie muss für ${triggerLink.name} gelten.`,
      );
    }
    if (responsible.lists.length === 0 && responsible.custom.length === 0) {
      const disabledOnly = triggerLink.ruleHits.some((h) => !h.listEnabled);
      notes.push(
        disabledOnly
          ? "Nur deaktivierte Listen enthalten eine passende Regel. Vermutlich hat die Box ihren Stand noch nicht aktualisiert."
          : "Keine passende Regel in den geladenen Listen gefunden. Mögliche Gründe: Listen noch nicht geladen, die Box hat einen anderen Listenstand oder legt eine Regel anders aus.",
      );
    }
    const allowed = triggerLink.customHits.filter((h) => h.entry.enabled && h.entry.action === "allow");
    if (allowed.length > 0) {
      notes.push(`Für ${triggerLink.name} gibt es schon eine aktive Ausnahme (${allowed.map((h) => h.entry.domain).join(", ")}), die Box sperrt trotzdem.`);
    }
  }

  return {
    input,
    domain,
    chain,
    referenceRcode,
    referenceError,
    blocked: Boolean(triggerLink),
    trigger: triggerLink?.name,
    responsible,
    suggestedAllow: triggerLink?.name,
    notes,
  };
}
