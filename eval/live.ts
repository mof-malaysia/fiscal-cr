import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertCallBudget,
  buildEvalPlan,
  checkCallBudget,
  resolveEvalSelection,
  type BudgetCheck,
  type EvalPlan,
  type EvalSelection,
} from './plan.js';
import { SUITE_ID, SUITE_VERSION } from './cases.js';
import {
  assertArtifactSafe,
  buildBenchmarkArtifact,
  buildBenchmarkResult,
  type AggregateQualitySummary,
  type BenchmarkArtifactV3,
  type ExecutionAggregate,
  type PairsSummary,
  type RegressionReport,
  type VariantLabel,
  type VariantPerformanceAggregate,
  type VariantReliabilityAggregate,
} from './benchmark.js';
import {
  buildSuitePromptMetadata,
  executePlan,
  formatDuration,
  gitRepoMetadata,
  requireApiKey,
  resolveEvalEnv,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_RETRIES,
  type EvalEnvConfig,
  type SuitePromptMetadata,
} from './runtime.js';
import type { Attempt, CompletedAttempt } from './benchmark.js';
import {
  buildBlindKey,
  buildBlindPairsFromAttempts,
  buildBlindReport,
} from './blind-report.js';

const RESULT_DIR = '.eval-results';

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

function fmtNum(n: number, digits = 1): string {
  const fixed = n.toFixed(digits);
  const [intPart, decPart] = fixed.split('.');
  const formattedInt = Number(intPart).toLocaleString('en-US');
  return decPart ? `${formattedInt}.${decPart}` : formattedInt;
}

function signedNumber(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function fmtPctNullable(v: number | null): string {
  return v === null ? 'unavailable' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Env provenance (which source supplied provider/model — for transparency)

function sourceOf(env: NodeJS.ProcessEnv, key: string): string {
  return env[key] ? `env ${key}` : 'default';
}

function modelSource(env: NodeJS.ProcessEnv): string {
  if (env.MODEL) return 'env MODEL';
  if (env.KIMI_MODEL) return 'env KIMI_MODEL';
  return 'default';
}

// ---------------------------------------------------------------------------
// Header + dry-run output

function header(env: NodeJS.ProcessEnv, cfg: EvalEnvConfig, selection: EvalSelection, plan: EvalPlan): string {
  const suiteLabel = selection.explicit
    ? `override (EVAL_CASES: ${selection.caseIds.join(', ')})`
    : `${selection.suite} (${selection.caseIds.length} cases)`;
  let fastPath = 0;
  let multiPass = 0;
  for (const entry of plan.entries) {
    if (entry.route === 'fast-path') fastPath += 1;
    else multiPass += 1;
  }
  return [
    'FiscalCR LLM eval harness (local) — fiscalcr-eval-v3',
    `  provider: ${cfg.provider} (${sourceOf(env, 'MODEL_PROVIDER')})`,
    `  model:    ${cfg.model} (${modelSource(env)})`,
    `  suite:    ${suiteLabel}`,
    `  cases:    ${selection.caseIds.join(', ')}`,
    `  seed:     ${selection.seed}`,
    `  rounds:   ${selection.runs} round(s) per case`,
    `  plan:     ${plan.plannedAttempts} attempts (${selection.caseIds.length} cases × ${selection.runs} × 2 variants)`,
    `  routes:   ${fastPath} fast-path · ${multiPass} multi-pass attempts`,
    `  provider calls: up to ${plan.plannedProviderCallsUpperBound} (EVAL_MAX_CALLS guard)`,
  ].join('\n');
}

function printDryBudget(budget: BudgetCheck): void {
  const status = budget.exceeded
    ? red(`EXCEEDS EVAL_MAX_CALLS=${budget.max} — live would fail; raise the guard, e.g. EVAL_MAX_CALLS=${budget.plannedProviderCalls}`)
    : green(`ok (≤ EVAL_MAX_CALLS=${budget.max})`);
  console.log(`\nBudget: ${budget.plannedProviderCalls} planned provider calls (upper bound) ${status}`);
}

function printSuitePrompts(experimental: boolean, info: SuitePromptMetadata): void {
  const label = experimental ? 'experimental' : 'baseline';
  const s = info.stats;
  const multi = info.dynamicMultiPassCount;
  console.log(`Prompts (${label}) — suite-level across ${s.cases} selected case(s)`);
  console.log(`  total:  ${fmt(s.totalChars)} chars  (~${fmt(s.totalEstimatedTokens)} est. tokens)`);
  console.log(`  range:  ${fmt(s.minChars)} – ${fmt(s.maxChars)} chars per case`);
  console.log(`  sha256: ${info.metadata.sha256.slice(0, 16)}… (${info.metadata.sha256.length} hex)`);
  if (multi > 0) {
    console.log(
      `  dynamic multi-pass: ${multi} case(s) excluded from the static prompt preview ` +
        `(${info.dynamicMultiPassCaseIds.join(', ')})`,
    );
    console.log(
      s.cases === 0
        ? '  pipeline-only selection — no static fast-path prompt preview; all stage prompts are generated during live execution'
        : '  stage prompts for the excluded case(s) are generated during live execution',
    );
  } else {
    console.log('  dynamic multi-pass: 0 case(s) excluded');
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Per-attempt console output

function printAttempt(attempt: Attempt, attemptNumber: number, totalAttempts: number): void {
  const tag = `[${attemptNumber}/${totalAttempts}][${attempt.case.caseId} r${attempt.identity.roundIndex}] ${rpad(attempt.identity.variant, 12)}`;
  if (attempt.status === 'failed') {
    console.log(
      `${tag} ${red('FAIL')}  (${attempt.error.code}) ${attempt.error.message}  ` +
        `[${formatDuration(attempt.durationMs)}, ${attempt.providerCalls} provider call(s)]`,
    );
    return;
  }
  const m = attempt.metrics;
  const q = attempt.quality.postGate;
  const routeStr = m.route === 'multi-pass' ? yellow('multi-pass') : 'fast-path';
  const degradedStr = m.degraded ? yellow('degraded') : green('ok');
  const parseStr = m.parseSuccess === true ? green('ok') : m.parseSuccess === false ? red('FAIL') : '—';
  const contractStr = m.contractComplete === true ? green('ok') : m.contractComplete === false ? yellow('INCOMPLETE') : '—';
  const fmtStr = m.conciseCompliant === true ? green('yes') : m.conciseCompliant === false ? red('NO') : '—';
  console.log(
    `${tag} ${lpad(formatDuration(m.durationMs), 6)}  ` +
      `${routeStr} ${degradedStr}  ` +
      `parse:${parseStr} contract:${contractStr} fmt:${fmtStr}  ` +
      `${m.providerCalls} call(s)  ` +
      `retained ${m.retainedFindings}/${q.goldIssues} gold  ` +
      `TP ${q.tp} FP ${q.fp} FN ${q.fn}  F1 ${q.f1.toFixed(2)}  ` +
      `out=${fmt(m.outputTokens)} ch=${fmt(m.rawChars)}`,
  );
}

function routeLabel(route: string): string {
  return route === 'multi-pass' ? yellow('multi-pass') : 'fast-path';
}

function printPairProgress(info: {
  pairNumber: number;
  totalPairs: number;
  pairId: string;
  caseId: string;
  roundIndex: number;
  order: readonly string[];
  completed: number;
  failed: number;
  complete: boolean;
}): void {
  const order = info.order.join(' → ');
  const state = info.complete
    ? green(`complete`)
    : yellow(`partial (${info.completed} completed, ${info.failed} failed)`);
  console.log(
    `Pair ${info.pairNumber}/${info.totalPairs} [${info.pairId}] ${order}  ${state}`,
  );
  console.log();
}

// ---------------------------------------------------------------------------
// Final report blocks

function printExecution(e: ExecutionAggregate): void {
  console.log(bold('\n=== Execution ==='));
  console.log(
    `  planned ${e.planned} attempts · completed ${e.completed} · failed ${e.failed} · ` +
      `degraded ${e.degraded} · completion ${pct(e.completionRate)}`,
  );
  console.log(`  actual provider calls: ${e.actualProviderCalls}`);
  console.log(
    `  baseline ${e.byVariant.baseline.completed}/${e.byVariant.baseline.planned} · ` +
      `experimental ${e.byVariant.experimental.completed}/${e.byVariant.experimental.planned}`,
  );
}

function printQuality(quality: Record<VariantLabel, AggregateQualitySummary | null>): void {
  console.log(bold('\n=== Post-gate quality: baseline vs experimental ==='));
  for (const variant of ['baseline', 'experimental'] as const) {
    const q = quality[variant];
    if (q === null) {
      console.log(`  ${rpad(variant, 12)} unavailable (no completed runs)`);
      continue;
    }
    console.log(
      `  ${rpad(variant, 12)} n=${q.runs}  ` +
        `micro P/R/F1 ${fmtNum(q.micro.precision)}/${fmtNum(q.micro.recall)}/${fmtNum(q.micro.f1)}  ` +
        `macro F1 ${fmtNum(q.macro.f1)}  ` +
        `clean FP rate ${pct(q.cleanRate)}  severe FP ${q.severeFalsePositives}  dup ${q.duplicates}  ` +
        `TP/1k out ${q.tpPer1000Tokens === null ? 'unavailable' : fmtNum(q.tpPer1000Tokens, 2)}`,
    );
  }
}

function printReliability(
  reliability: Record<VariantLabel, VariantReliabilityAggregate | null>,
  performance: Record<VariantLabel, VariantPerformanceAggregate | null>,
): void {
  console.log(bold('\n=== Reliability / efficiency (completed attempts) ==='));
  for (const variant of ['baseline', 'experimental'] as const) {
    const rel = reliability[variant];
    const perf = performance[variant];
    if (rel === null || perf === null) {
      console.log(`  ${rpad(variant, 12)} unavailable (no completed attempts)`);
      continue;
    }
    const parseStr = rel.fastPath > 0 ? `fast-path parse ${pct(rel.parseRate)}` : 'parse —';
    console.log(
      `  ${rpad(variant, 12)} n=${rel.completed}  ` +
        `fast-path ${rel.fastPath} · multi-pass ${rel.multiPass} · degraded ${pct(rel.degradedRate)}  ` +
        `${parseStr}  contract ${pct(rel.contractRate)}  ` +
        `format-length ${pct(rel.formatLengthComplianceRate)}  ` +
        `median out ${fmt(perf.medianOutputTokens)} tok  raw ${fmt(perf.medianRawChars)} ch  ` +
        `${formatDuration(perf.medianDurationMs)}`,
    );
  }
}

function printPairs(pairs: PairsSummary): void {
  console.log(bold('\n=== Paired deltas (complete pairs only) ==='));
  if (pairs.completePairs === 0) {
    console.log(
      yellow(
        `  No complete pairs (${pairs.incompletePairs} incomplete) — insufficient data for paired deltas.`,
      ),
    );
    return;
  }
  const a = pairs.aggregate!;
  console.log(`  complete pairs ${pairs.completePairs} · incomplete ${pairs.incompletePairs}`);
  console.log(`  output savings     ${fmtPctNullable(a.outputSavingsPct.mean)}  (median ${fmtPctNullable(a.outputSavingsPct.median)})`);
  console.log(`  raw-char savings   ${fmtPctNullable(a.rawCharsSavingsPct.mean)}  (median ${fmtPctNullable(a.rawCharsSavingsPct.median)})`);
  console.log(
    `  post-gate Δ (exp − base): F1 ${signedNumber(a.postGateF1Delta.mean)}  ` +
      `TP ${signedNumber(a.postGateTpDelta.mean)}  FP ${signedNumber(a.postGateFpDelta.mean)}`,
  );
}

function printRegressions(regressions: RegressionReport[]): void {
  console.log(bold('\n=== Regression report ==='));
  const r = regressions[0];
  if (!r) {
    console.log('  unavailable');
    return;
  }
  if (r.status === 'insufficient-data') {
    console.log(
      `  runs=${r.runs} < 4 — ${yellow('insufficient data')}. Directional only; ` +
        `rerun with EVAL_RUNS>=4 (11×4 decision run = 88 attempts, up to 160 calls; ` +
          `needs EVAL_MAX_CALLS=160).`,
    );
    return;
  }
  const verdict =
    r.status === 'detected'
      ? red('LARGE REGRESSION DETECTED')
      : green('no large regression');
  console.log(
    `  ${verdict} (${r.metric}: baseline ${fmtNum(r.baseline ?? 0)} → experimental ${fmtNum(r.experimental ?? 0)}; ` +
      `thresholds ${r.baselineThreshold} / ${r.experimentalThreshold})`,
  );
}

function printHeadline(regressions: RegressionReport[], completePairs: number): void {
  console.log(bold('\n=== Verdict ==='));
  if (completePairs === 0) {
    console.log(yellow('  No complete pairs — no verdict possible.'));
    return;
  }
  const r = regressions[0];
  if (!r || r.status === 'insufficient-data') {
    const runs = r?.runs ?? 0;
    console.log(
      yellow(`  runs=${runs} < 4 — evidence is directional only. `) +
        'Do not claim a winner from this run.',
    );
    return;
  }
  if (r.status === 'detected') {
    console.log(red(`  ${r.metric}: baseline ${fmtNum(r.baseline ?? 0)} → experimental ${fmtNum(r.experimental ?? 0)}`));
    console.log(red('  Large regression detected against thresholds.'));
  } else {
    console.log(
      `  ${r.metric}: baseline ${fmtNum(r.baseline ?? 0)} → experimental ${fmtNum(r.experimental ?? 0)} — ` +
        green('no large regression against thresholds.'),
    );
  }
}

// ---------------------------------------------------------------------------
// Artifact (v3, secret-safe)

function artifactFileName(ts: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `eval-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}` +
    `-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.json`
  );
}

async function writeArtifact(artifact: BenchmarkArtifactV3): Promise<string> {
  await mkdir(RESULT_DIR, { recursive: true });
  const file = path.join(RESULT_DIR, artifactFileName(new Date(artifact.timestamp)));
  await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// Main

export async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const cfg = resolveEvalEnv(process.env);
  const selection = resolveEvalSelection(process.env);
  const plan = buildEvalPlan(selection);
  const cases = selection.cases;
  const budget = checkCallBudget(plan);

  console.log(header(process.env, cfg, selection, plan));

  if (dryRun) {
    printDryBudget(budget);
    for (const experimental of [false, true]) {
      printSuitePrompts(experimental, buildSuitePromptMetadata(cases, cfg, experimental));
    }
    console.log(
      'Dry run: API key not used, no network calls, no artifact written. ' +
        `Planned live run: ${plan.plannedAttempts} attempts (${selection.runs} round(s) per case, ` +
        `seed "${selection.seed}"), up to ${plan.plannedProviderCallsUpperBound} provider LLM calls.\n`,
    );
    return;
  }

  const apiKey = requireApiKey(cfg);

  // Call budget is enforced here — immediately before any live provider
  // creation/call — and throws (nonzero exit) when the plan's provider-call
  // upper bound exceeds the guard.
  assertCallBudget(plan);

  console.log(
    `\nLive run: ${plan.plannedAttempts} review attempts ` +
      `(${selection.runs} round(s) per case, ${selection.caseIds.length} case(s)); ` +
      `up to ${plan.plannedProviderCallsUpperBound} provider LLM calls; ` +
      `call timeout ${formatDuration(DEFAULT_CALL_TIMEOUT_MS)} (fast-path + group-review; ` +
      `intent/synthesis use fixed 60s/90s), retries ${DEFAULT_RETRIES}.\n`,
  );

  const { attempts } = await executePlan(plan, cases, cfg, {
    apiKey,
    onProgress: (line) => console.log(line),
    onAttempt: (attempt, callNumber, totalCalls) => printAttempt(attempt, callNumber, totalCalls),
    onPairProgress: (info) => printPairProgress(info),
  });

  // Aggregate exclusively through the benchmark result model — never ad-hoc
  // unmatched deltas.
  const result = buildBenchmarkResult({ plan, cases, attempts });
  printExecution(result.execution);
  printQuality(result.quality.postGate);
  printReliability(result.reliability, result.performance);
  printPairs(result.pairs);
  printRegressions(result.regressions);
  printHeadline(result.regressions, result.pairs.completePairs);

  // Blind human pack (complete pairs only)
  const completedAttempts = attempts.filter((a): a is CompletedAttempt => a.status === 'completed');
  const casesById = new Map(cases.map((c) => [c.id, c]));
  const { pairs: blindPairs, excludedPairIds } = buildBlindPairsFromAttempts({
    seed: selection.seed,
    attempts: completedAttempts,
    casesById,
  });

  const timestamp = new Date().toISOString();
  let blindPackPath: string | null = null;
  let blindKeyPath: string | null = null;

  if (blindPairs.length > 0) {
    const pack = buildBlindReport({ seed: selection.seed, pairs: blindPairs, excludedPairIds });
    const key = buildBlindKey(blindPairs, selection.seed, timestamp);
    const stem = artifactFileName(new Date(timestamp)).replace(/\.json$/, '');
    blindPackPath = path.join(RESULT_DIR, `${stem}-blind.md`);
    blindKeyPath = path.join(RESULT_DIR, `${stem}-blind-key.json`);
    await writeFile(blindPackPath, pack, 'utf8');
    await writeFile(blindKeyPath, `${JSON.stringify(key, null, 2)}\n`, 'utf8');
  }
  const baselinePrompt = buildSuitePromptMetadata(cases, cfg, false);
  const experimentalPrompt = buildSuitePromptMetadata(cases, cfg, true);

  const artifact = buildBenchmarkArtifact({
    timestamp,
    benchmark: { suiteId: SUITE_ID, suiteVersion: SUITE_VERSION },
    repository: gitRepoMetadata(),
    provider: cfg.provider,
    model: cfg.model,
    prompt: {
      baseline: baselinePrompt.metadata,
      experimental: experimentalPrompt.metadata,
      dynamicMultiPassCaseIds: baselinePrompt.dynamicMultiPassCaseIds,
      dynamicMultiPassCount: baselinePrompt.dynamicMultiPassCount,
    },
    retries: DEFAULT_RETRIES,
    callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
    plan,
    cases,
    attempts,
  });

  // Prove the artifact is free of the live key + forbidden keys/substrings
  // before anything touches disk.
  assertArtifactSafe(artifact, { secret: apiKey });

  const artifactPath = await writeArtifact(artifact);
  console.log(`\n=== Output files ===`);
  console.log(`  Artifact: ${artifactPath}`);
  if (blindPackPath && blindKeyPath) {
    console.log(`  Blind pack: ${blindPackPath}`);
    console.log(`  Blind key:  ${blindKeyPath}`);
    console.log(yellow('  Open the answer key ONLY after scoring the blind pack.'));
  } else if (excludedPairIds.length > 0) {
    console.log(
      yellow(`  No blind pack generated: all ${excludedPairIds.length} pair(s) were incomplete.`),
    );
  }
  console.log(
    `\nDone. ${attempts.filter((a) => a.status === 'failed').length} failed attempt(s) recorded in the artifact. ` +
      `Unset the key when finished: unset API_KEY`,
  );
}
