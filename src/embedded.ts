/**
 * Files the server serves. Imported rather than read so `bun --watch` restarts on a change to them;
 * `bun run build` replaces this module with one that holds their text, so the build is a single file.
 */
import indexHtml from '../public/index.html' with { type: 'text' };

// @types/bun types every `.html` import as an HTMLBundle, even one with `type: 'text'`.
const text: unknown = indexHtml;
if (typeof text !== 'string') {
  throw new Error('public/index.html did not import as text');
}

export const INDEX_HTML: string = text;
