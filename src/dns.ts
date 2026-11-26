/**
 * Minimal DNS client over UDP. Enough for A, AAAA and CNAME; deliberately dependency-free,
 * because each query must go to one specific server (the box via IPv4/IPv6, the reference DNS).
 */
import { isIPv6 } from "node:net";

export const TYPE = { A: 1, CNAME: 5, AAAA: 28 } as const;
export type RecordType = keyof typeof TYPE;

export interface DnsRecord {
  name: string;
  type: number;
  ttl: number;
  /** IP address (A/AAAA), target name (CNAME), or empty for unknown types */
  data: string;
}

export interface DnsResponse {
  rcode: number;
  answers: DnsRecord[];
  truncated: boolean;
}

export const RCODE_NAMES: Record<number, string> = { 0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 5: "REFUSED" };

export function encodeQuery(id: number, name: string, type: number): Uint8Array {
  const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
  const qname = labels.flatMap((l) => {
    const bytes = new TextEncoder().encode(l);
    if (bytes.length > 63) throw new Error(`DNS label too long: ${l}`);
    return [bytes.length, ...bytes];
  });
  const buf = new Uint8Array(12 + qname.length + 1 + 4);
  const view = new DataView(buf.buffer);
  view.setUint16(0, id);
  view.setUint16(2, 0x0100); // RD
  view.setUint16(4, 1); // QDCOUNT
  buf.set(qname, 12);
  const off = 12 + qname.length + 1;
  view.setUint16(off, type);
  view.setUint16(off + 2, 1); // IN
  return buf;
}

function readName(buf: Uint8Array, offset: number): [string, number] {
  const labels: string[] = [];
  let pos = offset;
  let end = -1;
  for (let jumps = 0; jumps < 64; jumps++) {
    const len = buf[pos];
    if (len === undefined) throw new Error("DNS response truncated");
    if (len === 0) {
      return [labels.join("."), end >= 0 ? end : pos + 1];
    }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = pos + 2;
      pos = ((len & 0x3f) << 8) | (buf[pos + 1] ?? 0);
      continue;
    }
    labels.push(new TextDecoder().decode(buf.subarray(pos + 1, pos + 1 + len)));
    pos += 1 + len;
  }
  throw new Error("DNS response with too many compression jumps");
}

function formatIPv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  // replace the longest run of zeros with ::
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > bestLen && j - i > 1) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return groups.join(":");
  return `${groups.slice(0, best).join(":")}::${groups.slice(best + bestLen).join(":")}`;
}

export function decodeResponse(buf: Uint8Array): DnsResponse & { id: number } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const id = view.getUint16(0);
  const flags = view.getUint16(2);
  const qd = view.getUint16(4);
  const an = view.getUint16(6);
  let pos = 12;
  for (let i = 0; i < qd; i++) pos = readName(buf, pos)[1] + 4;
  const answers: DnsRecord[] = [];
  for (let i = 0; i < an; i++) {
    const [name, next] = readName(buf, pos);
    const type = view.getUint16(next);
    const ttl = view.getUint32(next + 4);
    const rdlen = view.getUint16(next + 8);
    const rdata = next + 10;
    let data = "";
    if (type === TYPE.A && rdlen === 4) data = Array.from(buf.subarray(rdata, rdata + 4)).join(".");
    else if (type === TYPE.AAAA && rdlen === 16) data = formatIPv6(buf.subarray(rdata, rdata + 16));
    else if (type === TYPE.CNAME) data = readName(buf, rdata)[0];
    answers.push({ name: name.toLowerCase(), type, ttl, data: data.toLowerCase() });
    pos = rdata + rdlen;
  }
  return { id, rcode: flags & 0x000f, truncated: (flags & 0x0200) !== 0, answers };
}

/** One query to a specific server; two attempts with timeout. */
export async function query(server: string, name: string, type: RecordType, timeoutMs = 2500): Promise<DnsResponse> {
  const v6 = isIPv6(server);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = Math.floor(Math.random() * 0xffff);
    try {
      return await new Promise<DnsResponse>((resolve, reject) => {
        let socket: { close(): void } | undefined;
        const timer = setTimeout(() => {
          socket?.close();
          reject(new Error(`No response from ${server} for ${name} (${type})`));
        }, timeoutMs);
        Bun.udpSocket({
          hostname: v6 ? "::" : "0.0.0.0",
          socket: {
            data(sock, data) {
              try {
                const res = decodeResponse(new Uint8Array(data));
                if (res.id !== id) return;
                clearTimeout(timer);
                sock.close();
                resolve(res);
              } catch (err) {
                clearTimeout(timer);
                sock.close();
                reject(err);
              }
            },
          },
        }).then((sock) => {
          socket = sock;
          sock.send(encodeQuery(id, name, TYPE[type]), 53, server);
        }, reject);
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Address the FRITZ!Box DNS filter answers with when it blocks. */
export function isBlockAddress(ip: string): boolean {
  return ip === "0.0.0.0" || ip === "::";
}
