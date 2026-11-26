import { expect, test } from 'bun:test';
import { domainApplied, solveChallenge, upsertDomain } from './fritz.ts';
import { toIntervals } from './store.ts';

test('solveChallenge (example from the AVM documentation)', async () => {
  const challenge = '2$10000$5A1711$2000$5A1722';
  expect(await solveChallenge(challenge, '1example!')).toBe('5A1722$1798a1672bca7c6463d6b245f82b53703b0f50813401b03e4045a5861e689adb');
});

test('upsertDomain adds or toggles', () => {
  const added = upsertDomain([], { domain: 'A.example.com', action: 'allow', enabled: true });
  expect(added).toEqual([{ enabled: true, comment: 'fritz-whyblocked', action: 'allow', domain: 'a.example.com' }]);
  const toggled = upsertDomain([{ enabled: true, comment: 'fritz-whyblocked', action: 'allow', domain: 'a.example.com', UID: 'x1' }], {
    domain: 'a.example.com',
    action: 'allow',
    enabled: false,
  });
  expect(toggled).toEqual([{ enabled: false, comment: 'fritz-whyblocked', action: 'allow', domain: 'a.example.com', UID: 'x1' }]);
  expect(domainApplied(toggled, { domain: 'a.example.com', action: 'allow', enabled: false })).toBe(true);
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
