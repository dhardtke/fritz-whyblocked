import { expect, test } from 'bun:test';
import { analyze, normalizeDomain, type QueryFn } from './analysis.ts';
import { TYPE } from './dns.ts';
import { KIND } from './rules.ts';

test('normalizeDomain', () => {
  expect(normalizeDomain('https://WWW.Example.com/pfad?x=1')).toBe('www.example.com');
  expect(normalizeDomain('example.com.')).toBe('example.com');
  expect(normalizeDomain('bücher.de')).toBe('xn--bcher-kva.de');
  expect(() => normalizeDomain('localhost')).toThrow();
});

test('blocked CNAME target is detected as the trigger', async () => {
  const query: QueryFn = (server, name, type) => {
    if (server === '1.1.1.1') {
      return Promise.resolve({
        rcode: 0,
        truncated: false,
        answers: [
          { name: 'www.example.com', type: TYPE.CNAME, ttl: 60, data: 'x.cdn.example.net' },
          { name: 'x.cdn.example.net', type: TYPE.A, ttl: 60, data: '1.2.3.4' },
        ],
      });
    }
    const ip = type === 'A' ? '0.0.0.0' : '::';
    return Promise.resolve({ rcode: 0, truncated: false, answers: [{ name, type: TYPE[type], ttl: 60, data: ip }] });
  };
  const result = await analyze('www.example.com', {
    query,
    referenceDns: '1.1.1.1',
    boxServers: [{ label: 'IPv4', address: '192.168.178.1' }],
    domains: [],
    lookupRules: (name) =>
      Promise.resolve(
        name === 'x.cdn.example.net'
          ? [
              {
                listName: 'Test list',
                listUrl: 'https://l',
                listEnabled: true,
                listAction: 'block',
                ruleDomain: 'cdn.example.net',
                kind: KIND.WITH_SUBDOMAINS,
                kindLabel: '',
                certain: true,
              },
            ]
          : [],
      ),
  });
  expect(result.blocked).toBe(true);
  expect(result.chain.map((l) => l.name)).toEqual(['www.example.com', 'x.cdn.example.net']);
  expect(result.trigger).toBe('x.cdn.example.net');
  expect(result.suggestedAllow).toBe('x.cdn.example.net');
  expect(result.responsible.lists.map((h) => h.listName)).toEqual(['Test list']);
  expect(result.notes.some((n) => n.includes('CNAME target'))).toBe(true);
});
