import { createLLMProvider } from '../src/providers/factory.js';
import { runFastPath } from '../src/pipeline/fast-path.js';
import { UsageTracker } from '../src/pipeline/usage.js';
import type { PullRequestContext, ReviewResult } from '../src/types/review.js';
import {
  buildPromptReport,
  evalReviewConfig,
  formatDelta,
  formatDuration,
  requireApiKey,
  resolveEvalEnv,
  type EvalEnvConfig,
  type PromptReport,
  type RunStats,
} from './eval-helpers.js';
import { buildSyntheticContext } from './eval-fixture.js';

interface RunOutcome {
  result: ReviewResult;
  stats: RunStats;
}

function sourceOf(env: NodeJS.ProcessEnv, key: string): string {
  return env[key] ? `env ${key}` : 'default';
}

function modelSource(env: NodeJS.ProcessEnv): string {
  if (env.MODEL) return 'env MODEL';
  if (env.KIMI_MODEL) return 'env KIMI_MODEL';
  return 'default';
}

// The actual base URL is never printed — just whether one is configured. Dry
// mode omits the line entirely: the value may come from .env and is an
// endpoint detail. The API key is never printed in any mode.
function header(env: NodeJS.ProcessEnv, cfg: EvalEnvConfig, showBaseUrl: boolean): string {
  const lines = [
    'eval-llm harness (local, no GitHub API/repo/PR)',
    `  provider: ${cfg.provider} (${sourceOf(env, 'MODEL_PROVIDER')})`,
    `  model:    ${cfg.model} (${modelSource(env)})`,
  ];
  if (showBaseUrl) {
    lines.push(`  base URL: ${cfg.baseUrl ? '(configured)' : '(provider default)'}`);
  }
  return lines.join('\n');
}

async function runOnce(
  cfg: EvalEnvConfig,
  apiKey: string,
  ctx: PullRequestContext,
  experimental: boolean,
): Promise<RunOutcome> {
  const config = evalReviewConfig(cfg, experimental);
  const provider = createLLMProvider({
    apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    provider: config.provider,
    userAgent: config.userAgent,
  });
  const usage = new UsageTracker();
  const startedAt = Date.now();
  const result = await runFastPath(provider, ctx, config, usage);
  const durationMs = Date.now() - startedAt;
  const tokens = usage.total();
  return {
    result,
    stats: {
      experimental,
      durationMs,
      input: tokens.input,
      output: tokens.output,
      cached: tokens.cached,
      calls: usage.calls(),
      score: result.score,
      findings: result.annotations.length,
    },
  };
}

function printOutcome(outcome: RunOutcome): void {
  const { result, stats } = outcome;
  console.log(`--- run: experimental=${stats.experimental} ---`);
  console.log(`duration: ${formatDuration(stats.durationMs)}`);
  console.log(
    `tokens: input=${stats.input.toLocaleString('en-US')} ` +
      `output=${stats.output.toLocaleString('en-US')} ` +
      `cached=${stats.cached.toLocaleString('en-US')}`,
  );
  console.log(`calls: ${stats.calls}`);
  console.log(`score: ${stats.score}`);
  console.log(`findings (retained): ${stats.findings}`);
  console.log(`intent: ${result.intent ?? '(none)'}`);
  console.log('summary:');
  console.log(result.summary);
  console.log('walkthrough:');
  if (result.walkthrough && result.walkthrough.length > 0) {
    for (const w of result.walkthrough) console.log(`  - ${w.path}: ${w.summary}`);
  } else {
    console.log('  (none)');
  }
  console.log('findings:');
  if (result.annotations.length === 0) {
    console.log('  (none)');
  } else {
    for (const a of result.annotations) {
      console.log(`  - ${a.path}:${a.startLine}-${a.endLine} [${a.severity}] ${a.title}`);
    }
  }
  console.log();
}

function printDryReport(report: PromptReport): void {
  console.log(`--- prompts: experimental=${report.experimental} ---`);
  console.log(`system prompt: ${report.systemChars.toLocaleString('en-US')} chars`);
  console.log(`user prompt:   ${report.userChars.toLocaleString('en-US')} chars`);
  console.log(
    `total:         ${report.totalChars.toLocaleString('en-US')} chars ` +
      `/ ~${report.estimatedTokens.toLocaleString('en-US')} est. tokens`,
  );
  console.log(`Concision Rules: ${report.hasConcisionRules ? 'yes' : 'no'}`);
  console.log();
}

export async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const cfg = resolveEvalEnv(process.env);
  const ctx = buildSyntheticContext();

  console.log(header(process.env, cfg, !dryRun));

  if (dryRun) {
    console.log('\nDry run: API key not used, no network calls.\n');
    for (const experimental of [false, true]) {
      printDryReport(buildPromptReport(evalReviewConfig(cfg, experimental), ctx));
    }
    console.log('Dry run complete. Nothing was sent over the network.');
    return;
  }

  const apiKey = requireApiKey(cfg);
  console.log(
    '\nLive run: 2 billable LLM calls (experimental=false, then experimental=true).\n',
  );

  const baseline = await runOnce(cfg, apiKey, ctx, false);
  printOutcome(baseline);

  const experimental = await runOnce(cfg, apiKey, ctx, true);
  printOutcome(experimental);

  console.log(formatDelta(baseline.stats, experimental.stats));
  console.log('\nDone. Unset the key when finished: unset API_KEY');
}
