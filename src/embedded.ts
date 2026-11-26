/**
 * Files the server serves. Read from disk here; `bun run build` replaces this module with one that
 * holds their text, so the build is a single file.
 */
export const INDEX_HTML: string = await Bun.file(new URL('../public/index.html', import.meta.url)).text();
