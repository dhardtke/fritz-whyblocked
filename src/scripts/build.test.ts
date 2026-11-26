import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from './build.ts';

const outdir = mkdtempSync(join(tmpdir(), 'fritz-whyblocked-build-'));

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
});

test('the build is one file with the stamped page embedded, next to its Bun version', async () => {
  const { outfile, bytes } = await build(outdir);
  expect(bytes).toBeGreaterThan(0);
  const js = await Bun.file(outfile).text();
  expect(js).toContain('<!-- fritz-whyblocked ');
  expect(js).not.toContain('public/index.html');
  expect(await Bun.file(`${outfile}.map`).exists()).toBe(true);
  expect(await Bun.file(join(outdir, 'bun-version')).text()).toBe(`${Bun.version}\n`);
});
