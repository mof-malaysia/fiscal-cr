import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLLMProvider } from '../src/providers/factory.js';
import { runFastPath } from '../src/pipeline/fast-path.js';
import { UsageTracker } from '../src/pipeline/usage.js';
import type { PullRequestContext, ReviewResult } from '../src/types/review.js';
import {
  buildPromptReport,
  evalReviewConfig,
  formatDuration,
  requireApiKey,
  resolveEvalEnv,
  type EvalEnvConfig,
  type PromptReport,
} from './eval-helpers.js';
import { wrapCapturingProvider } from './eval-capture.js';
import {
  aggregateRuns,
  buildArtifact,
  buildRunMetrics,
  captureFromResponse,
  computeDelta,
  mean,
  pairRunOrder,
  resolveEvalRuns,
  type BenchmarkDelta,
  type CapturedCall,
  type RunMetrics,
  type VariantAggregate,
  type VariantLabel,
} from './eval-metrics.js';
import { buildSyntheticContext } from './eval-fixture.js';

const RESULT_DIR = '.eval-results';
const FIXTURE_NAME = 'synthetic-review-pr';
const FIXTURE_VERSION = 1;

interface RunOutcome {
  metrics: RunMetrics;
  result: ReviewResult;
}

function sourceOf(env: NodeJS.ProcessEnv, key: string): string {
  return env[key] ? `env ${key}` : 'default';
}

function modelSource(env: NodeJS.ProcessEnv): string {
  if (env.MODEL) return 'env MODEL';
  if (env.KIMI_MODEL) return 'env KIMI_MODEL';
  return 'default';
}

function header(
  env: NodeJS.ProcessEnv,
  cfg: EvalEnvConfig,
  runs: number,
  totalCalls: number,
  changedFileCount: number,
): string {
  const lines = [
    'FiscalCR LLM eval harness (local)',
    `  provider: ${cfg.provider} (${sourceOf(env, 'MODEL_PROVIDER')})`,
    `  model:    ${cfg.model} (${modelSource(env)})`,
    `  fixture:  ${FIXTURE_NAME} (${changedFileCount} changed files)`,
    `  runs:     ${runs} A/B pair(s) = ${totalCalls} planned calls`,
    `  order:    alternates per pair (baseline→experimental, experimental→baseline)`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Terminal styling — disabled when NO_COLOR is set or stdout is not a TTY.

const useColor = !process.env.NO_COLOR && process.stdout.isTTY === true;

function color(code: number, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const bold = (s: string) => color(1, s);
const red = (s: string) => color(31, s);
const green = (s: string) => color(32, s);
const yellow = (s: string) => color(33, s);
const cyan = (s: string) => color(36, s);

function lpad(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}
function rpad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function signedNumber(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function signedDurationMs(ms: number): string {
  const sign = ms > 0 ? '+' : ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  return `${sign}${formatDuration(abs)}`;
}

function fmtNum(n: number, digits = 1): string {
  const fixed = n.toFixed(digits);
  const [intPart, decPart] = fixed.split('.');
  const formattedInt = Number(intPart).toLocaleString('en-US');
  return decPart ? `${formattedInt}.${decPart}` : formattedInt;
}

// ---------------------------------------------------------------------------
// Per-run execution

async function runOnce(
  cfg: EvalEnvConfig,
  apiKey: string,
  ctx: PullRequestContext,
  experimental: boolean,
  pairIndex: number,
  runIndex: number,
): Promise<RunOutcome> {
  const config = evalReviewConfig(cfg, experimental);
  const captures: CapturedCall[] = [];
  const provider = wrapCapturingProvider(
    createLLMProvider({
      apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      provider: config.provider,
      userAgent: config.userAgent,
      retry: { maxRetries: 0 },
    }),
    (info) => {
      const capture = captureFromResponse(info.response, info.order, info.durationMs);
      captures.push(capture);
    },
  );
  const usage = new UsageTracker();
  const startedAt = Date.now();
  const label = experimental ? 'experimental' : 'baseline';

  console.log(
    `[pair ${pairIndex + 1}] ${label}  start  (timeout ${formatDuration(config.pipeline.callTimeoutMs)}, retries 0)`,
  );
  const heartbeat = setInterval(() => {
    console.log(
      `[pair ${pairIndex + 1}] ${label}  wait   ${formatDuration(Date.now() - startedAt)}`,
    );
  }, 15_000);

  try {
    const result = await runFastPath(provider, ctx, config, usage);
    const durationMs = Date.now() - startedAt;
    console.log(`[pair ${pairIndex + 1}] ${label}  done   ${formatDuration(durationMs)}`);
    const metrics = buildRunMetrics({
      experimental,
      pairIndex,
      runIndex,
      durationMs,
      tokens: usage.total(),
      calls: usage.calls(),
      captures,
      result,
      changedFilePaths: ctx.changedFiles.map((f) => f.filename),
    });
    return { metrics, result };
  } finally {
    clearInterval(heartbeat);
  }
}

// ---------------------------------------------------------------------------
// Per-run output

function printOutcome(metrics: RunMetrics, runNumber: number, totalCalls: number): void {
  const label = metrics.experimental ? 'experimental' : 'baseline';
  const parseStr = metrics.parseSuccess ? green('ok') : red('FAIL');
  const contractStr = metrics.contractComplete ? green('ok') : yellow('INCOMPLETE');
  const conciseStr = metrics.conciseCompliant ? green('yes') : red('NO');

  const parts: string[] = [
    `[${runNumber}/${totalCalls}] ${rpad(label, 12)} ${lpad(formatDuration(metrics.durationMs), 6)}`,
    `parse:${parseStr}`,
    `contract:${contractStr}`,
    `findings:${metrics.retainedFindings}/${metrics.generatedFindings}`,
    `score:${metrics.score}`,
    `concise:${conciseStr}`,
    `out=${fmt(metrics.outputTokens)}`,
    `tot=${fmt(metrics.totalTokens)}`,
  ];

  if (metrics.finishReason && metrics.finishReason !== 'stop') {
    parts.push(`(finish:${metrics.finishReason})`);
  }
  if (metrics.zeroFindingsKind) {
    parts.push(`zero:${metrics.zeroFindingsKind}`);
  }

  console.log(parts.join(' '));
}

// ---------------------------------------------------------------------------
// Aggregate output

function printVariantAggregate(a: VariantAggregate): void {
  const title = a.variant === 'baseline' ? 'Baseline' : 'Experimental';
  console.log(`=== ${title} (n=${a.runs}) ===`);
  console.log(`  success      ${pct(a.successRate)}`);
  console.log(`  parse        ${pct(a.parseRate)}`);
  console.log(`  contract     ${pct(a.contractRate)}`);
  console.log(`  concise      ${pct(a.conciseComplianceRate)}`);
  console.log(
    `  duration  mean ${lpad(formatDuration(a.meanDurationMs), 8)}   median ${lpad(formatDuration(a.medianDurationMs), 8)}`,
  );
  console.log(
    `  input     mean ${lpad(fmt(a.meanInputTokens), 8)}   median ${lpad(fmt(a.medianInputTokens), 8)}`,
  );
  console.log(
    `  output    mean ${lpad(fmt(a.meanOutputTokens), 8)}   median ${lpad(fmt(a.medianOutputTokens), 8)}`,
  );
  console.log(
    `  total     mean ${lpad(fmt(a.meanTotalTokens), 8)}   median ${lpad(fmt(a.medianTotalTokens), 8)}`,
  );
  console.log(
    `  findings  mean ${lpad(fmtNum(a.meanFindings), 8)}   median ${lpad(fmtNum(a.medianFindings), 8)}`,
  );
  console.log(
    `  score     mean ${lpad(fmtNum(a.meanScore), 8)}   median ${lpad(fmtNum(a.medianScore), 8)}`,
  );
  console.log();
}

function printAggregates(aggregates: Record<VariantLabel, VariantAggregate>): void {
  printVariantAggregate(aggregates.baseline);
  printVariantAggregate(aggregates.experimental);
}

function printDelta(delta: BenchmarkDelta): void {
  console.log('=== Delta (experimental - baseline) ===');
  const savings = delta.outputSavingsPct;
  let savingsLine: string;
  if (savings === null) {
    savingsLine = 'n/a';
  } else {
    const sign = savings >= 0 ? '+' : '';
    const note =
      savings > 0 ? '(experimental lower)' : savings < 0 ? '(experimental higher)' : '(same)';
    savingsLine = `${sign}${savings.toFixed(1)}% ${note}`;
  }
  console.log(`  output savings  ${savingsLine}`);
  console.log(`  duration        ${signedDurationMs(delta.durationDeltaMs)}`);
  console.log(`  input           ${signedNumber(delta.inputDeltaTokens)} tokens`);
  console.log(`  output          ${signedNumber(delta.outputDeltaTokens)} tokens`);
  console.log(`  total           ${signedNumber(delta.totalDeltaTokens)} tokens`);
  console.log(`  findings        ${signedNumber(delta.findingsDelta)}`);
  console.log(`  score           ${signedNumber(delta.scoreDelta)}`);
  console.log(`  concise         ${signedNumber(delta.conciseComplianceDeltaPp)} pp`);
  console.log();
}

// ---------------------------------------------------------------------------
// Artifact + summary

function artifactFileName(ts: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `eval-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}` +
    `-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.json`
  );
}

async function writeArtifact(artifact: Parameters<typeof buildArtifact>[0]): Promise<string> {
  await mkdir(RESULT_DIR, { recursive: true });
  const file = path.join(RESULT_DIR, artifactFileName(new Date(artifact.timestamp)));
  await writeFile(file, `${JSON.stringify(buildArtifact(artifact), null, 2)}\n`, 'utf8');
  return file;
}

function printDryReport(report: PromptReport): void {
  const label = report.experimental ? 'experimental' : 'baseline';
  console.log(`Prompts (${label})`);
  console.log(`  system: ${fmt(report.systemChars)} chars`);
  console.log(`  user:   ${fmt(report.userChars)} chars`);
  console.log(`  total:  ${fmt(report.totalChars)} chars  (~${fmt(report.estimatedTokens)} est. tokens)`);
  console.log(`  Concision Rules: ${report.hasConcisionRules ? 'yes' : 'no'}`);
  console.log();
}

function printSummary(
  runs: number,
  totalCalls: number,
  allMetrics: RunMetrics[],
  aggregates: Record<VariantLabel, VariantAggregate>,
  delta: BenchmarkDelta,
  artifactPath: string,
): void {
  console.log(`\nArtifact: ${artifactPath}`);

  const baselineRuns = allMetrics.filter((m) => !m.experimental);
  const experimentalRuns = allMetrics.filter((m) => m.experimental);
  const baselineSuccess = baselineRuns.filter((m) => m.parseSuccess && m.contractComplete).length;
  const experimentalSuccess = experimentalRuns.filter((m) => m.parseSuccess && m.contractComplete).length;

  console.log(bold('Summary'));
  console.log(`- ${runs} A/B pair(s), ${totalCalls} calls.`);
  console.log(
    `- Usable reviews: baseline ${pct(baselineRuns.length ? baselineSuccess / baselineRuns.length : 0)} ` +
      `(${baselineSuccess}/${baselineRuns.length}), experimental ${pct(experimentalRuns.length ? experimentalSuccess / experimentalRuns.length : 0)} ` +
      `(${experimentalSuccess}/${experimentalRuns.length}).`,
  );

  const outBase = mean(baselineRuns.map((m) => m.outputTokens));
  const outExp = mean(experimentalRuns.map((m) => m.outputTokens));
  const savingsStr = delta.outputSavingsPct === null ? 'n/a' : `${delta.outputSavingsPct >= 0 ? '+' : ''}${delta.outputSavingsPct.toFixed(1)}%`;
  const savingsNote =
    delta.outputSavingsPct === null
      ? ''
      : delta.outputSavingsPct > 0
        ? ' (experimental lower)'
        : delta.outputSavingsPct < 0
          ? ' (experimental higher)'
          : '';
  console.log(
    `- Output tokens: baseline mean ${fmt(outBase)} vs experimental mean ${fmt(outExp)} (savings ${savingsStr}${savingsNote}).`,
  );

  console.log(
    `- Strict concision: baseline ${pct(aggregates.baseline.conciseComplianceRate)}, experimental ${pct(aggregates.experimental.conciseComplianceRate)}.`,
  );

  const scoreDelta = aggregates.experimental.meanScore - aggregates.baseline.meanScore;
  console.log(
    `- Experimental mean score ${fmtNum(aggregates.experimental.meanScore)} vs baseline ${fmtNum(aggregates.baseline.meanScore)} ` +
      `(${scoreDelta >= 0 ? '+' : ''}${fmtNum(scoreDelta)}).`,
  );

  if (runs <= 1) {
    console.log(
      yellow('Note: Only 1 pair was run; differences may be noise. Increase EVAL_RUNS for confidence.'),
    );
  }
  console.log('Done. Unset the key when finished: unset API_KEY');
}

// ---------------------------------------------------------------------------
// Main

export async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const cfg = resolveEvalEnv(process.env);
  const ctx = buildSyntheticContext();
  const runs = resolveEvalRuns(process.env);
  const totalCalls = runs * 2;

  console.log(header(process.env, cfg, runs, totalCalls, ctx.changedFiles.length));

  if (dryRun) {
    console.log(
      `\nDry run: API key not used, no network calls, no artifact. ` +
        `Planned live run: ${runs} A/B pair(s), ${totalCalls} calls.\n`,
    );
    for (const experimental of [false, true]) {
      printDryReport(buildPromptReport(evalReviewConfig(cfg, experimental), ctx));
    }
    console.log('Dry run complete. Nothing was sent over the network.');
    return;
  }

  const apiKey = requireApiKey(cfg);
  console.log(
    `\nLive run: ${totalCalls} billable LLM calls ` +
      `(${runs} A/B pair(s); order alternates per pair).\n`,
  );

  const allMetrics: RunMetrics[] = [];
  const pairOrders: boolean[][] = [];
  let runNumber = 0;

  for (let pair = 0; pair < runs; pair++) {
    const order = pairRunOrder(pair);
    pairOrders.push(order);
    for (let i = 0; i < order.length; i++) {
      runNumber += 1;
      const outcome = await runOnce(cfg, apiKey, ctx, order[i], pair, i);
      allMetrics.push(outcome.metrics);
      printOutcome(outcome.metrics, runNumber, totalCalls);
    }
    console.log(
      `Pair ${pair + 1}/${runs} complete  ${order.map((o) => (o ? 'experimental' : 'baseline')).join(' → ')}`,
    );
    console.log();
  }

  const aggregates = aggregateRuns(allMetrics);
  const delta = computeDelta(aggregates.baseline, aggregates.experimental);
  printAggregates(aggregates);
  printDelta(delta);

  const timestamp = new Date().toISOString();
  const artifactPath = await writeArtifact({
    timestamp,
    provider: cfg.provider,
    model: cfg.model,
    fixtureName: FIXTURE_NAME,
    fixtureVersion: FIXTURE_VERSION,
    changedFileCount: ctx.changedFiles.length,
    runs,
    retries: 0,
    pairOrders,
    runMetrics: allMetrics,
  });

  printSummary(runs, totalCalls, allMetrics, aggregates, delta, artifactPath);
}
