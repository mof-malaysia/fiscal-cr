// Materialises the history suite into the gitignored cache.
//
//   tsx eval/history/fetch.ts [--force] [id ...]
//
// Read-only GitHub API calls (GITHUB_TOKEN, GH_TOKEN or `gh auth token`). No
// provider calls. Cached entries whose pinned SHAs still match are skipped
// unless --force is given.

// Silence the pino logger the src modules use before they load.
process.env.LOG_LEVEL = 'fatal';
const { DEFAULT_CONFIG } = await import('../../src/config/defaults.js');
const { readManifest } = await import('./manifest.js');
const { HISTORY_CACHE_DIR, findCauseProblem, findPostMergeLeak, readCached, toContext } = await import('./loader.js');
const { createOctokit, fetchHistoryCase, measure, writeCached } =
  await import('./materialize.js');

async function main(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const ids = argv.filter((a) => !a.startsWith('--'));
  const manifest = readManifest();
  const selected = ids.length > 0 ? manifest.cases.filter((c) => ids.includes(c.id)) : manifest.cases;
  const unknown = ids.filter((id) => !manifest.cases.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`Unknown history case id(s): ${unknown.join(', ')}`);

  const octokit = createOctokit();
  let fetched = 0;
  let warnings = 0;
  const errors: string[] = [];
  for (const c of selected) {
    const cached = (!force && readCached(c)) || null;
    const entry = cached ?? (await fetchHistoryCase(octokit, c));
    const ctx = toContext(entry);
    // The loader refuses these cases too; report them all here, then fail.
    const leak = findPostMergeLeak(c, ctx);
    if (leak) errors.push(`${c.id}: PR text ${leak}; drop the case or pick another`);
    const causeProblem = findCauseProblem(c, ctx);
    if (causeProblem) errors.push(`${c.id}: cause label does not fit the context: ${causeProblem}`);
    const size = measure(ctx);
    const notes: string[] = [];
    if (size.estimatedTokens >= DEFAULT_CONFIG.pipeline.fastPathThreshold) notes.push('OFF the fast path');
    if (size.estimatedTokens !== c.size.estimatedTokens) notes.push(`tokens ${size.estimatedTokens} (manifest ${c.size.estimatedTokens})`);
    if (ctx.title.length !== c.description.titleChars || ctx.body.length !== c.description.bodyChars) {
      notes.push('title or body changed since the manifest was written');
    }
    if (!cached) {
      writeCached(entry);
      fetched += 1;
    }
    warnings += notes.length > 0 ? 1 : 0;
    console.log(`${cached ? 'cached ' : 'fetched'} ${c.id.padEnd(28)} ${String(size.estimatedTokens).padStart(6)} tok${notes.length ? `  ! ${notes.join('; ')}` : ''}`);
  }
  console.log(`\n${selected.length} case(s) in ${HISTORY_CACHE_DIR} (${fetched} fetched, ${warnings} with warnings).`);
  if (errors.length > 0) throw new Error(`${errors.length} case(s) unusable:\n  ${errors.join('\n  ')}`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`eval-history-fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

export {};
