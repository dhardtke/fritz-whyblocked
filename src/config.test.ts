import { afterEach, expect, test } from 'bun:test';
import { loadConfig } from './config.ts';

const NAMES = ['FRITZ_HOST', 'REFERENCE_DNS', 'STATE_DIRECTORY', 'DATA_DIR', 'PORT', 'CREDENTIALS_DIRECTORY'];
const saved = new Map(NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
});

test('empty variables fall back to the defaults, as .env.example leaves them empty', () => {
  for (const name of NAMES) {
    process.env[name] = '';
  }
  const config = loadConfig();
  expect(config.fritzHost).toBe('fritz.box');
  expect(config.referenceDns).toBe('1.1.1.1');
  expect(config.dataDir).toBe('./data');
  expect(config.port).toBe(8053);
});

test('the systemd state directory wins over DATA_DIR', () => {
  process.env.STATE_DIRECTORY = '/var/lib/fritz-whyblocked';
  process.env.DATA_DIR = './elsewhere';
  expect(loadConfig().dataDir).toBe('/var/lib/fritz-whyblocked');
});

test('a port that is not a positive number is rejected', () => {
  process.env.PORT = 'abc';
  expect(() => loadConfig()).toThrow('PORT must be a positive number');
});
