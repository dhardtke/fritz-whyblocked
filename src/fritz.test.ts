import { expect, test } from 'bun:test';
import { editsMismatches, planEdits, solveChallenge, upsertEdits, type DnsFilter, type FilterEdits } from './fritz.ts';
import { toIntervals } from './store.ts';

test('solveChallenge (example from the AVM documentation)', async () => {
  const challenge = '2$10000$5A1711$2000$5A1722';
  expect(await solveChallenge(challenge, '1example!')).toBe('5A1722$1798a1672bca7c6463d6b245f82b53703b0f50813401b03e4045a5861e689adb');
});

const current: DnsFilter = {
  enabled: true,
  filterlists: [
    { name: 'One', url: 'https://one', enabled: true, action: 'deny', status: { entryCount: 1 }, latestUpdate: { status: 'success' }, UID: 'filterlist1' },
    { name: 'Two', url: 'https://two', enabled: false, action: 'deny', UID: 'filterlist2' },
  ],
  domains: [
    { enabled: true, comment: 'old', action: 'allow', domain: 'a.example.com', UID: 'domain1' },
    { enabled: true, comment: '', action: 'deny', domain: 'b.example.com', UID: 'domain2' },
    { enabled: false, comment: '', action: 'allow', domain: 'c.example.com', UID: 'domain3' },
  ],
};

test('planEdits switches the filter and lists through their own resources, only where something changes', () => {
  expect(planEdits(current, { enabled: false, lists: [{ url: 'https://one', enabled: true }] })).toEqual({
    requests: [{ method: 'PUT', path: '', body: { enabled: false } }],
    expected: { enabled: false },
  });
  const plan = planEdits(current, { lists: [{ url: 'https://one', enabled: false }] });
  expect(plan.requests).toEqual([
    { method: 'PUT', path: '/filterlists/filterlist1', body: { name: 'One', url: 'https://one', enabled: false, action: 'deny' } },
  ]);
  expect(editsMismatches(current, plan.expected, current)).toEqual(['list One is not off']);
  expect(() => planEdits(current, { enabled: true, lists: [{ url: 'https://one', enabled: true }] })).toThrow('Nothing to change');
  expect(() => planEdits(current, { lists: [{ url: 'https://three', enabled: true }] })).toThrow('not found');
});

test('planEdits deletes, then edits in place, then adds', () => {
  const edits: FilterEdits = {
    domains: [
      { change: { domain: 'E.example.com', action: 'allow', enabled: true, comment: '' } },
      { target: { domain: 'A.example.com', action: 'allow' }, change: { domain: 'D.example.com', action: 'deny', enabled: false, comment: 'new' } },
      { target: { domain: 'b.example.com', action: 'deny' } },
      { target: { domain: 'c.example.com', action: 'allow' }, change: { domain: 'c.example.com', action: 'allow', enabled: false, comment: '' } },
    ],
  };
  const plan = planEdits(current, edits);
  expect(plan.requests).toEqual([
    { method: 'DELETE', path: '/domains/domain2' },
    { method: 'PUT', path: '/domains/domain1', body: { enabled: false, comment: 'new', action: 'deny', domain: 'd.example.com' } },
    { method: 'POST', path: '/domains', body: { enabled: true, comment: 'fritz-whyblocked', action: 'allow', domain: 'e.example.com' } },
  ]);
  const after = { domains: plan.expected.domains };
  expect(editsMismatches(current, plan.expected, after)).toEqual([]);
  expect(editsMismatches(current, plan.expected, current)).toEqual([
    'd.example.com (deny) is missing',
    'e.example.com (allow) is missing',
    'a.example.com (allow) is still there',
    'b.example.com (deny) is still there',
  ]);
  expect(editsMismatches(current, plan.expected, { domains: plan.expected.domains?.map((d) => ({ ...d, comment: '' })) })).toEqual([
    'd.example.com (deny) does not have the comment "new"',
    'e.example.com (allow) does not have the comment "fritz-whyblocked"',
  ]);
});

test('planEdits lets entries swap but rejects duplicates and missing targets', () => {
  const swapped = planEdits(current, {
    domains: [
      { target: { domain: 'a.example.com', action: 'allow' }, change: { domain: 'c.example.com', action: 'allow', enabled: true } },
      { target: { domain: 'c.example.com', action: 'allow' }, change: { domain: 'a.example.com', action: 'allow', enabled: false } },
    ],
  });
  expect(swapped.expected.domains?.map((d) => [d.UID, d.domain])).toEqual([
    ['domain1', 'c.example.com'],
    ['domain2', 'b.example.com'],
    ['domain3', 'a.example.com'],
  ]);
  expect(() => planEdits(current, { domains: [{ change: { domain: 'a.example.com', action: 'allow', enabled: true } }] })).toThrow('two entries');
  expect(() => planEdits(current, { domains: [{ target: { domain: 'x.example.com', action: 'allow' } }] })).toThrow('not found');
  expect(() =>
    planEdits(
      { domains: [{ enabled: true, action: 'allow', domain: 'a.example.com' }] },
      { domains: [{ target: { domain: 'a.example.com', action: 'allow' } }] },
    ),
  ).toThrow('no UID');
});

test('upsertEdits adds a new entry or edits the existing one', () => {
  const change = { domain: 'a.example.com', action: 'allow' as const, enabled: false };
  expect(planEdits(current, upsertEdits(current.domains ?? [], change)).requests).toEqual([
    { method: 'PUT', path: '/domains/domain1', body: { enabled: false, comment: 'old', action: 'allow', domain: 'a.example.com' } },
  ]);
  expect(planEdits(current, upsertEdits(current.domains ?? [], { ...change, domain: 'n.example.com' })).requests).toEqual([
    { method: 'POST', path: '/domains', body: { enabled: false, comment: 'fritz-whyblocked', action: 'allow', domain: 'n.example.com' } },
  ]);
  expect(() => planEdits(current, upsertEdits(current.domains ?? [], { ...change, enabled: true }))).toThrow('Nothing to change');
});

test('toIntervals converts counter readings into intervals', () => {
  expect(
    toIntervals([
      { ts: 1, total: 100, blocked: 10 },
      { ts: 2, total: 150, blocked: 12 },
      { ts: 3, total: 20, blocked: 1 },
    ]),
  ).toEqual([
    { ts: 2, total: 50, blocked: 2 },
    { ts: 3, total: 20, blocked: 1 },
  ]);
});
