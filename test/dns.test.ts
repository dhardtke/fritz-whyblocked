import { expect, test } from "bun:test";
import { decodeResponse, encodeQuery, isBlockAddress, TYPE } from "../src/dns.ts";

/** Baut eine Antwort mit Namenskomprimierung: www.example.com CNAME cdn.example.net, A 0.0.0.0 */
function sampleResponse(): Uint8Array {
  const q = encodeQuery(0x1234, "www.example.com", TYPE.A);
  const bytes = [...q];
  bytes[2] = 0x81; bytes[3] = 0x80; // QR, RD, RA
  bytes[7] = 2; // ANCOUNT
  const cnameTarget = [3, ..."cdn".split("").map((c) => c.charCodeAt(0)), 7, ..."example".split("").map((c) => c.charCodeAt(0)), 3, ..."net".split("").map((c) => c.charCodeAt(0)), 0];
  const cnameOffset = bytes.length + 12;
  bytes.push(0xc0, 12, 0, 5, 0, 1, 0, 0, 0, 60, 0, cnameTarget.length, ...cnameTarget);
  bytes.push(0xc0, cnameOffset, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 0, 0, 0, 0);
  return new Uint8Array(bytes);
}

test("decodeResponse liest CNAME-Kette und Sperradresse", () => {
  const res = decodeResponse(sampleResponse());
  expect(res.id).toBe(0x1234);
  expect(res.rcode).toBe(0);
  expect(res.answers).toEqual([
    { name: "www.example.com", type: TYPE.CNAME, ttl: 60, data: "cdn.example.net" },
    { name: "cdn.example.net", type: TYPE.A, ttl: 60, data: "0.0.0.0" },
  ]);
});

test("isBlockAddress", () => {
  expect(isBlockAddress("0.0.0.0")).toBe(true);
  expect(isBlockAddress("::")).toBe(true);
  expect(isBlockAddress("1.2.3.4")).toBe(false);
});
