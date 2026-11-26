import { relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const NAME = 'fritz-whyblocked';

export interface BuildResult {
  outfile: string;
  bytes: number;
}

function commit(): string {
  const git = (...args: string[]): string | null => {
    const result = Bun.spawnSync(['git', ...args], { cwd: ROOT, stderr: 'ignore' });
    return result.success ? result.stdout.toString().trim() : null;
  };
  const head = git('rev-parse', 'HEAD');
  if (head === null) {
    return 'unknown';
  }
  return git('status', '--porcelain') === '' ? head : `${head}-dirty`;
}

/** Puts the commit and build time into the page, after its doctype, so a deployed page names its build. */
function stamp(html: string, builtAt: Date): string {
  const runId = Bun.env.GITHUB_RUN_ID;
  const run = runId === undefined ? '' : `, run ${runId}`;
  const doctype = /^<!doctype html>\r?\n/i.exec(html)?.[0];
  if (doctype === undefined) {
    throw new Error('public/index.html must start with <!doctype html>');
  }
  return `${doctype}<!-- ${NAME} ${commit()}, built ${builtAt.toISOString()}${run} -->\n${html.slice(doctype.length)}`;
}

/** Bundles the server and public/index.html into one file, next to the Bun version that built it. */
export async function build(outdir: string): Promise<BuildResult> {
  const html = stamp(await Bun.file(resolve(ROOT, 'public', 'index.html')).text(), new Date());
  const result = await Bun.build({
    entrypoints: [resolve(ROOT, 'src', 'server.ts')],
    target: 'bun',
    outdir,
    naming: `${NAME}.js`,
    minify: true,
    sourcemap: 'linked',
    files: { [resolve(ROOT, 'src', 'embedded.ts')]: `export const INDEX_HTML = ${JSON.stringify(html)};` },
  });
  if (!result.success) {
    throw new AggregateError(result.logs, 'build failed');
  }
  await Bun.write(resolve(outdir, 'bun-version'), `${Bun.version}\n`);
  const outfile = resolve(outdir, `${NAME}.js`);
  return { outfile, bytes: Bun.file(outfile).size };
}

async function main(): Promise<void> {
  const { outfile, bytes } = await build('dist');
  const shown = relative(process.cwd(), outfile).replaceAll('\\', '/');
  console.log(`built ${shown} (${Math.round(bytes / 1024)} KB), ${shown}.map and bun-version (${Bun.version})`);
}

if (import.meta.main) {
  await main();
}
