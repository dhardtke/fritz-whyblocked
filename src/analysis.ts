/**
 * On-demand analysis: resolve the CNAME chain via the reference DNS, probe each link at the box
 * (IPv4 and IPv6) and find the rules responsible.
 */
import { errorMessage } from './errors.ts';
import { isBlockAddress, RCODE_NAMES, TYPE, type DnsResponse, type RecordType } from './dns.ts';
import type { DomainEntry } from './fritz.ts';
import type { RuleHit } from './rules.ts';

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
  /** Entry applies to exactly this name (otherwise via a parent domain) */
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
  /** last link the box blocks */
  trigger?: string;
  /** Lists and custom blocks that block the triggering link */
  responsible: { lists: RuleHit[]; custom: CustomHit[] };
  /** Domain for which an exception should lift the block */
  suggestedAllow?: string;
  notes: string[];
}

/** Turns a domain or URL into a lowercase hostname (IDN as punycode). */
export function normalizeDomain(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Please enter a domain or URL.');
  }
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`).hostname;
  } catch {
    throw new Error(`"${trimmed}" is not a valid domain or URL.`);
  }
  host = host.replace(/\.$/, '').toLowerCase();
  if (!host.includes('.') || host.startsWith('[')) {
    throw new Error(`"${trimmed}" is not a valid domain.`);
  }
  return host;
}

/** Follows the CNAME records of a response starting at `name`. */
export function cnameChain(name: string, res: DnsResponse): string[] {
  const chain = [name];
  const seen = new Set(chain);
  for (let i = 0; i < 16; i++) {
    const current = chain.at(-1) ?? name;
    const next = res.answers.find((a) => a.type === TYPE.CNAME && a.name === current)?.data;
    if (!next || seen.has(next)) {
      break;
    }
    chain.push(next);
    seen.add(next);
  }
  return chain;
}

export function customHitsFor(name: string, domains: DomainEntry[]): CustomHit[] {
  return domains
    .filter((e) => {
      const d = e.domain.toLowerCase().replace(/^\*\./, '');
      return name === d || name.endsWith(`.${d}`);
    })
    .map((entry) => ({ entry, exact: entry.domain.toLowerCase() === name }));
}

async function probe(deps: AnalysisDeps, name: string): Promise<BoxProbe[]> {
  const jobs = deps.boxServers.flatMap((s) =>
    (['A', 'AAAA'] as const).map(async (type): Promise<BoxProbe> => {
      try {
        const res = await deps.query(s.address, name, type);
        const addresses = res.answers.filter((a) => a.type === TYPE[type]).map((a) => a.data);
        return { server: s.label, type, blocked: addresses.some(isBlockAddress), addresses, rcode: RCODE_NAMES[res.rcode] ?? String(res.rcode) };
      } catch (err) {
        return { server: s.label, type, blocked: false, addresses: [], error: errorMessage(err) };
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
    const res = await deps.query(deps.referenceDns, domain, 'A');
    referenceRcode = RCODE_NAMES[res.rcode] ?? String(res.rcode);
    names = cnameChain(domain, res);
    if (res.rcode === 3) {
      notes.push(`According to ${deps.referenceDns} the domain does not exist (NXDOMAIN), so the box is not what blocks it.`);
    }
  } catch (err) {
    referenceError = errorMessage(err);
    notes.push(`Reference DNS ${deps.referenceDns} unreachable; CNAME chain unknown, only the domain itself is checked.`);
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
      notes.push(`${link.name}: the box answers differently depending on the address (blocked via ${[...blockedOn].join(', ')}).`);
    }
    if (link.probes.every((p) => p.error)) {
      notes.push(`${link.name}: the box did not answer any query.`);
    }
  }

  const blockedLinks = chain.filter((l) => l.blockedByBox);
  const triggerLink = blockedLinks[blockedLinks.length - 1];
  const responsible = {
    lists: triggerLink?.ruleHits.filter((h) => h.listEnabled && h.listAction !== 'allow' && h.kind !== 3) ?? [],
    custom: triggerLink?.customHits.filter((h) => h.entry.enabled && h.entry.action === 'deny') ?? [],
  };

  if (triggerLink) {
    if (triggerLink !== chain[0]) {
      notes.push(
        `The blocked name is the CNAME target ${triggerLink.name}, not ${domain} itself. An exception for ${domain} does not help; it has to be for ${triggerLink.name}.`,
      );
    }
    if (responsible.lists.length === 0 && responsible.custom.length === 0) {
      const disabledOnly = triggerLink.ruleHits.some((h) => !h.listEnabled);
      notes.push(
        disabledOnly
          ? 'Only disabled lists contain a matching rule. The box has probably not updated its state yet.'
          : 'No matching rule found in the loaded lists. Possible reasons: lists not loaded yet, the box has a different list version, or it interprets a rule differently.',
      );
    }
    const allowed = triggerLink.customHits.filter((h) => h.entry.enabled && h.entry.action === 'allow');
    if (allowed.length > 0) {
      notes.push(
        `There is already an active exception for ${triggerLink.name} (${allowed.map((h) => h.entry.domain).join(', ')}), but the box still blocks it.`,
      );
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
