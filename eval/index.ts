// Entry point for the local LLM eval harness.
//
// Suppress provider logs before any src module loads pino. Some upstream error
// bodies echo credential fragments; harness errors are reported safely below.
process.env.LOG_LEVEL = 'fatal';
// The app selects a pino-pretty transport when NODE_ENV=development; that
// transport is not installed here and would crash harness startup (e.g. when a
// loaded .env sets NODE_ENV=development). The harness does not need it.
process.env.NODE_ENV = 'production';

const { main } = await import('./live.js');

main(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const safeMessage = message
    .replace(/\bsk-[A-Za-z0-9*_.-]+/gi, '[REDACTED_API_KEY]')
    .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1[REDACTED]@');
  console.error(`\neval-llm failed: ${safeMessage}`);
  process.exitCode = 1;
});

// Mark as a module so top-level await is legal.
export {};
