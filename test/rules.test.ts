import { describe, expect, test } from "bun:test";
import { candidates, classify, KIND, parseLine, RuleIndex } from "../src/rules.ts";

describe("parseLine", () => {
  test("Adblock formats", () => {
    expect(parseLine("||ads.example.com^")).toEqual([{ domain: "ads.example.com", kind: KIND.WITH_SUBDOMAINS }]);
    expect(parseLine("||ads.example.com^$important")).toEqual([{ domain: "ads.example.com", kind: KIND.WITH_SUBDOMAINS }]);
    expect(parseLine("|exact.example.com^")).toEqual([{ domain: "exact.example.com", kind: KIND.EXACT }]);
    expect(parseLine("@@||good.example.com^")).toEqual([{ domain: "good.example.com", kind: KIND.EXCEPTION }]);
    expect(parseLine("! comment")).toEqual([]);
    expect(parseLine("[Adblock Plus 2.0]")).toEqual([]);
    expect(parseLine("/ads[0-9]+/")).toEqual([]);
    expect(parseLine("||ex*ample.com^")).toEqual([]);
  });
  test("hosts format", () => {
    expect(parseLine("0.0.0.0 tracker.example.net # comment")).toEqual([{ domain: "tracker.example.net", kind: KIND.EXACT }]);
    expect(parseLine("127.0.0.1 a.example.org b.example.org")).toHaveLength(2);
    expect(parseLine("127.0.0.1 localhost")).toEqual([]);
  });
  test("wildcard and bare domain", () => {
    expect(parseLine("*.cdn.example.com")).toEqual([{ domain: "cdn.example.com", kind: KIND.SUBDOMAINS_ONLY }]);
    expect(parseLine("Plain.Example.COM")).toEqual([{ domain: "plain.example.com", kind: KIND.EXACT }]);
  });
});

describe("RuleIndex", () => {
  const index = RuleIndex.build(["||ads.example.com^", "0.0.0.0 t.example.net", "*.w.example.org", "||ads.example.com^", "broken/line"].join("\n"));
  test("counts rules without duplicates", () => {
    expect(index.ruleCount).toBe(3);
    expect(index.skippedLines).toBe(1);
    expect(index.bytes).toBe(24);
  });
  test("finds rule kinds", () => {
    expect(index.kindsFor("ads.example.com")).toEqual([KIND.WITH_SUBDOMAINS]);
    expect(index.kindsFor("t.example.net")).toEqual([KIND.EXACT]);
    expect(index.kindsFor("w.example.org")).toEqual([KIND.SUBDOMAINS_ONLY]);
    expect(index.kindsFor("example.com")).toEqual([]);
  });
});

test("candidates and classify", () => {
  expect(candidates("a.b.example.com")).toEqual(["a.b.example.com", "b.example.com", "example.com"]);
  expect(classify("x.example.com", "example.com", KIND.WITH_SUBDOMAINS)).toEqual({ applies: true, certain: true });
  expect(classify("x.example.com", "example.com", KIND.EXACT)).toEqual({ applies: true, certain: false });
  expect(classify("example.com", "example.com", KIND.SUBDOMAINS_ONLY).applies).toBe(false);
});
