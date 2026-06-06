/**
 * A tiny in-process mutex used to serialize the few critical sections that
 * mutate SHARED files (report-number allocation, the applications.md tracker
 * merge, the PDF-status update). Everything else in an eval — the LLM calls,
 * PDF rendering, JD scraping — runs fully in parallel; only these quick
 * file writes are serialized, so concurrent evals can never:
 *   - hand out the same report number,
 *   - clobber data/applications.md with a lost update.
 *
 * This works because the whole web server is a single Node process: one shared
 * promise chain is enough. (It does NOT protect against a second server
 * instance writing the same files — run only one `npm run dev`.)
 */
let chain: Promise<unknown> = Promise.resolve();

export function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // Keep the chain alive whether fn resolves or rejects, so one failure
  // doesn't wedge every later caller.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
