import type { FiscalcrOctokit } from '../github/client.js';
import { modelForRole, type ReviewConfig } from '../config/schema.js';
import type {
  PullRequestContext,
  ReviewAnnotation,
  ReviewResult,
  ReviewedRange,
  Severity,
} from '../types/review.js';
import type { LLMProvider } from '../providers/interface.js';
import { extractPullRequestContext } from '../github/pulls.js';
import { createCheckRun, completeCheckRun } from '../github/checks.js';
import {
  createIncrementalReview,
  createPRReview,
  dismissBlockingReview,
} from '../github/comments.js';
import { fingerprintAnnotation } from '../github/fingerprint.js';
import {
  appendRun,
  EMPTY_COUNTS,
  loadReviewState,
  migrateLegacyState,
  mergeConcurrentReviewState,
  applyManualThreadResolution,
  reconcileFindingInventory,
  renderStickyComment,
  replaceStateMarkerWithinBudget,
  saveStickyComment,
  withReviewStateLock,
  type FindingRecord,
  type StickyComment,
  type ReviewState,
} from '../github/review-state.js';
import { hasGraphql, listFiscalcrThreads, resolveOutdatedThreads, type FiscalcrThread } from '../github/threads.js';
import { decideScope, type ScopeDecision } from './delta.js';
import { filterFiles } from './file-filter.js';
import { buildSummary } from './summary-builder.js';
import { ApiFileSource, LocalFileSource } from './file-source.js';
import { countBySeverity, deterministicScore } from '../pipeline/pass3-synthesis.js';
import { runReviewPipeline } from '../pipeline/run-review.js';
import { generateChangeDiagram, shouldGenerateChangeDiagram } from '../pipeline/change-diagram.js';
import { UsageTracker } from '../pipeline/usage.js';
import type { TelemetrySink } from '../pipeline/usage.js';
import { resolvePricingAsync, type PricingContext } from '../utils/pricing.js';
import { roundCost } from '../utils/tokens.js';
import { ReviewError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

interface ReviewParams {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  /** Review the whole PR even when a delta would suffice (@fiscalcr review). */
  forceFull?: boolean;
}
export interface OrchestratorOptions {
  /** Local checkout root (Action mode). Enables disk reads instead of API fetches. */
  workspaceRoot?: string;
  /** Optional metrics-only event sink. Prompt and repository content are never included. */
  telemetry?: TelemetrySink;
  /** Effective provider/model used by the provider factory, including App overrides. */
  pricingContext?: PricingContext;
  /** Disable the app-managed check run when the host already supplies one (Action mode). */
  createCheckRun?: boolean;
}

/** Map configured failure thresholds to the check conclusion. */
function conclusionFor(
  counts: Record<Severity, number>,
  failOn: ReviewConfig['review']['failOn'],
): 'success' | 'failure' {
  if (failOn === 'critical') return counts.critical > 0 ? 'failure' : 'success';
  if (failOn === 'warning')
    return counts.critical > 0 || counts.warning > 0 ? 'failure' : 'success';
  return 'success';
}
interface StickyPublicationPlan {
  fingerprints: Map<ReviewAnnotation, string>;
  newAnnotations: ReviewAnnotation[];
  inlineNew: ReviewAnnotation[];
  capOverflow: ReviewAnnotation[];
  openCounts: Record<Severity, number>;
  findings: FindingRecord[];
  autoResolvedThreadIds: string[];
  blocking: boolean;
}

/** Build the side-effect and lifecycle plan for one sticky publication. */
function planStickyPublication(input: {
  result: ReviewResult;
  config: ReviewConfig;
  /** Delta reviews may prove fixes only for these covered lines. */
  reviewedRanges: ReviewedRange[];
  state: ReviewState | null;
  threads: Array<{ fingerprint: string; id: string; isResolved: boolean }>;
  /** False means the API failed; preserve prior thread identities conservatively. */
  threadsAvailable: boolean;
  /** Only successful, complete scope may prove an absent finding fixed. */
  reviewedPaths: string[];
  headSha: string;
}): StickyPublicationPlan {
  const { result, config, state, threads, threadsAvailable, reviewedPaths, reviewedRanges, headSha } = input;
  const commentsCfg = config.review.comments;
  const inventory = result.findings ?? result.annotations;
  const threadByFingerprint = new Map(threads.map((thread) => [thread.fingerprint, thread.id]));
  const threadIdFor = (finding: FindingRecord): string | null =>
    threadsAvailable ? threadByFingerprint.get(finding.fingerprint) ?? null : finding.threadId;
  const stateWithThreads = state
    ? {
        ...state,
        findings: state.findings.map((finding) => ({
          ...finding,
          threadId: threadIdFor(finding),
        })),
      }
    : null;
  const reconciliation = reconcileFindingInventory(
    stateWithThreads,
    inventory,
    reviewedPaths,
    headSha,
    new Date().toISOString(),
    reviewedRanges,
  );
  const findings = reconciliation.findings.map((finding) => ({
    ...finding,
    threadId: threadIdFor(finding),
  }));
  const newlyOpen = new Set(reconciliation.newlyOpen);
  const previousFingerprints = new Set(
    (state?.findings ?? []).map((finding) => finding.fingerprint),
  );
  const fingerprints = new Map(result.annotations.map((annotation) => [annotation, fingerprintAnnotation(annotation)]));
  const newAnnotations =
    commentsCfg.dedupe && state
      ? result.annotations.filter((annotation) => {
          const fingerprint = fingerprints.get(annotation)!;
          return newlyOpen.has(fingerprint) || !previousFingerprints.has(fingerprint);
        })
      : result.annotations;
  const active = findings.filter((finding) => finding.status === 'open');
  const openCounts: Record<Severity, number> = { ...EMPTY_COUNTS };
  for (const finding of active) openCounts[finding.severity]++;
  const inlineCount = active.filter((finding) => finding.threadId !== null).length;
  const inlineBudget = Math.max(0, commentsCfg.maxOpenComments - inlineCount);
  const inlineNew = newAnnotations.slice(0, inlineBudget);
  const capOverflow = newAnnotations.slice(inlineBudget);
  return {
    fingerprints,
    newAnnotations,
    inlineNew,
    capOverflow,
    openCounts,
    findings,
    autoResolvedThreadIds: [],
    blocking: conclusionFor(openCounts, config.review.failOn) === 'failure',
  };
}

export class ReviewOrchestrator {
  constructor(
    private octokit: FiscalcrOctokit,
    private llm: LLMProvider,
    private config: ReviewConfig,
    private options: OrchestratorOptions = {},
  ) {}

  /** Run extraction, review, publication, and lifecycle persistence for one PR. */
  async reviewPullRequest(params: ReviewParams): Promise<ReviewResult> {
    const { owner, repo, pullNumber, headSha } = params;
    const sticky = this.config.review.comments.mode === 'sticky';

    // GitHub Actions already provides the workflow job check; avoid publishing a duplicate.
    let checkRunId: number | null = null;
    try {
      // Step 2: Load state and decide review scope
      let stickyRef: StickyComment | null = null;
      let state: ReviewState | null = null;
      let migration = false;
      let scope: ScopeDecision = {
        mode: 'full',
        reason: sticky ? 'no previous review state' : 'legacy comment mode',
      };
      if (sticky) {
        stickyRef = await loadReviewState(this.octokit, { owner, repo, pullNumber });
        migration = Boolean(stickyRef?.legacyState);
        state = stickyRef?.state ?? (stickyRef?.legacyState ? migrateLegacyState(stickyRef.legacyState) : null);
        if (state) {
          const { data: pr } = await this.octokit.pulls.get({
            owner,
            repo,
            pull_number: pullNumber,
          });
          scope = await decideScope(this.octokit, {
            owner,
            repo,
            headSha,
            baseSha: pr.base.sha,
            state,
            forceFull: params.forceFull || migration,
            config: this.config,
          });
        }
      }
      if (this.options.createCheckRun !== false) {
        checkRunId = await this.ensureCheckRun({ owner, repo, headSha, state });
      }
      logger.info({ pullNumber, scope: scope.mode, reason: scope.reason, migration }, 'Review scope decided');

      if (scope.mode === 'skip' && state && stickyRef) {
        return await this.completeSkippedRun(
          { owner, repo, checkRunId },
          state,
          scope.reason,
          { commentId: stickyRef.commentId, pullNumber, body: stickyRef.body, headSha },
        );
      }

      // Step 3: Extract PR context (path-filtered for delta reviews)
      logger.info({ pullNumber }, 'Extracting PR context');
      const apiSource = new ApiFileSource(this.octokit, owner, repo, headSha);
      const fileSource = this.options.workspaceRoot
        ? new LocalFileSource(this.options.workspaceRoot, apiSource)
        : apiSource;
      const prContext = await extractPullRequestContext(
        this.octokit,
        owner,
        repo,
        pullNumber,
        this.config,
        {
          fileSource,
          pathFilter: scope.mode === 'delta' ? scope.paths : undefined,
        },
      );

      // Step 4: Filter files
      const filteredFiles = filterFiles(prContext.changedFiles, this.config);
      prContext.changedFiles = filteredFiles;
      // Keep contents only for reviewable files (never prompt with lockfiles etc.)
      const reviewable = new Set(filteredFiles.map((f) => f.filename));
      for (const path of [...prContext.fileContents.keys()]) {
        if (!reviewable.has(path)) prContext.fileContents.delete(path);
      }

      if (filteredFiles.length === 0) {
        if (state && stickyRef) {
          return await this.completeSkippedRun(
            { owner, repo, checkRunId },
            state,
            'no reviewable files in scope',
            { commentId: stickyRef.commentId, pullNumber, body: stickyRef.body, headSha },
          );
        }
        const result: ReviewResult = {
          summary: 'No reviewable files in this PR (all files matched exclude patterns).',
          score: 100,
          findings: [],
          annotations: [],
          reviewedPaths: [],
          stats: { ...EMPTY_COUNTS },
          tokensUsed: { input: 0, output: 0, cached: 0 },
        };
        if (checkRunId !== null) {
          await completeCheckRun(this.octokit, {
            owner,
            repo,
            checkRunId,
            conclusion: 'success',
            summary: result.summary,
            annotations: [],
          });
        }
        return result;
      }

      // Step 5: Run the review (fast path or multi-pass pipeline)
      const deltaHint =
        scope.mode === 'delta' && scope.sinceSha
          ? `### Incremental Review\nOnly files changed since commit \`${scope.sinceSha.slice(0, 7)}\` are included. Focus on lines changed since that commit; findings on other files are tracked separately.`
          : undefined;
      const pricingContext = this.options.pricingContext ?? {
        provider: this.config.provider,
        baseUrl: this.config.baseUrl,
      };
      const stageModels = [
        modelForRole(this.config, 'intent'),
        modelForRole(this.config, 'fastPath'),
        modelForRole(this.config, 'groupReview'),
        modelForRole(this.config, 'synthesis'),
        modelForRole(this.config, 'diagram'),
      ];
      const pricingEntries = await Promise.all(
        [...new Set(stageModels)].map(async (model) => [
          model,
          await resolvePricingAsync({ ...pricingContext, model }),
        ] as const),
      );
      const pricingResolutions = new Map(pricingEntries);
      const pricingResolution = pricingResolutions.get(stageModels[2])!;
      const usage = new UsageTracker(
        this.options.telemetry,
        pricingContext,
        pricingResolutions,
      );
      const result = await runReviewPipeline(this.llm, prContext, this.config, usage, {
        workspaceRoot: this.options.workspaceRoot,
        deltaHint,
      });

      // Step 5b: Full reviews may generate a bounded replacement diagram before
      // final cost accounting. Delta reviews deliberately do not call the
      // auxiliary model; sticky publication preserves the last full-review map.
      // Any auxiliary failure is contained locally so the ordinary review
      // result and conclusion are never affected.
      if (
        scope.mode === 'full' &&
        this.config.review.diagram.enabled &&
        shouldGenerateChangeDiagram(prContext, this.config.review.diagram)
      ) {
        try {
          const diagram = await generateChangeDiagram(this.llm, prContext, this.config, usage, {
            scope: 'full',
            reviewedPaths: result.reviewedPaths,
          });
          if (diagram) {
            result.diagram = diagram;
          }
        } catch {
          // Minimal protection: the generator guards its own steps, but an
          // unexpected rejection must not leak into the review outcome.
          logger.warn('Change diagram generation failed; continuing without diagram');
        }
        // Refresh token/call totals so diagram spend — including any invalid or
        // failed call — is reflected in the returned accounting.
        result.tokensUsed = usage.total();
        result.callCount = usage.calls();
      }
      const costBreakdown = usage.costBreakdown();
      result.costEstimate = {
        usd: roundCost(usage.cost()),
        inputUsd: roundCost(costBreakdown.inputUsd),
        outputUsd: roundCost(costBreakdown.outputUsd),
        cachedUsd: roundCost(costBreakdown.cachedUsd),
        models: usage.modelCosts().map((summary) => ({
          ...summary,
          inputUsd: roundCost(summary.inputUsd),
          outputUsd: roundCost(summary.outputUsd),
          cachedUsd: roundCost(summary.cachedUsd),
          usd: roundCost(summary.usd),
        })),
        ...(this.options.telemetry
          ? {
              stages: usage.stageCosts().map((summary) => ({
                ...summary,
                inputUsd: roundCost(summary.inputUsd),
                outputUsd: roundCost(summary.outputUsd),
                cachedUsd: roundCost(summary.cachedUsd),
                usd: roundCost(summary.usd),
              })),
            }
          : {}),
        ...pricingResolution,
      };

      // Step 6: Publish (sticky lifecycle or legacy stacked review)
      if (!sticky) {
        return await this.publishLegacy({ checkRunId, prContext, result });
      }
      return await withReviewStateLock(`${owner}/${repo}#${pullNumber}`, () =>
        this.publishSticky({
          checkRunId,
          prContext,
          result,
          scope,
          state,
          commentId: stickyRef?.commentId ?? null,
          commentBody: stickyRef?.body,
        }),
      );
    } catch (err) {
      logger.error({ err, pullNumber }, 'Review failed');

      if (checkRunId !== null) {
        await completeCheckRun(this.octokit, {
          owner,
          repo,
          checkRunId,
          conclusion: 'failure',
          summary: `Review failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          annotations: [],
        });
      }

      throw new ReviewError(
        err instanceof Error ? err.message : 'Unknown error',
        'orchestration',
      );
    }
  }
  /** Reuse a valid check run for this head or create a replacement. */
  private async ensureCheckRun(input: {
    owner: string;
    repo: string;
    headSha: string;
    state: ReviewState | null;
  }): Promise<number> {
    const existingId = input.state?.checkRunId;
    if (existingId !== null && existingId !== undefined && input.state?.checkRunHeadSha === input.headSha) {
      try {
        const response = await (this.octokit.checks as typeof this.octokit.checks & {
          get?: (params: { owner: string; repo: string; check_run_id: number }) => Promise<{
            data: { head_sha?: string; status?: string };
          }>;
        }).get?.({ owner: input.owner, repo: input.repo, check_run_id: existingId });
        if (response?.data.head_sha === input.headSha && response.data.status === 'in_progress') return existingId;
      } catch (err) {
        logger.warn({ err, checkRunId: existingId }, 'Stored check run unavailable — creating replacement');
      }
    }
    return createCheckRun(this.octokit, {
      owner: input.owner,
      repo: input.repo,
      headSha: input.headSha,
    });
  }

  /** Nothing to review — carry the previous conclusion so the check stays honest. */
  private async completeSkippedRun(
    target: { owner: string; repo: string; checkRunId: number | null },
    state: ReviewState,
    reason: string,
    sticky?: { commentId: number; pullNumber: number; body: string; headSha: string },
  ): Promise<ReviewResult> {
    const openCounts: Record<Severity, number> = { ...EMPTY_COUNTS };
    for (const finding of state.findings) {
      if (finding.status === 'open') openCounts[finding.severity]++;
    }
    const conclusion = conclusionFor(openCounts, this.config.review.failOn);
    const openTotal = Object.values(openCounts).reduce((a, b) => a + b, 0);
    const summary = `Review skipped: ${reason}. ${openTotal} open finding(s) carried from the last review of \`${state.lastReviewedSha.slice(0, 7)}\`.`;

    if (target.checkRunId !== null) {
      await completeCheckRun(this.octokit, {
        owner: target.owner,
        repo: target.repo,
        checkRunId: target.checkRunId,
        conclusion,
        summary,
        annotations: [],
        externalId: JSON.stringify({ scope: 'skip' }),
      });
    }
    if (
      sticky?.body !== undefined &&
      (state.migratedFromV1 === true ||
        (target.checkRunId !== null &&
          (state.checkRunId !== target.checkRunId || state.checkRunHeadSha !== sticky.headSha)))
    ) {
      const stateToSave = {
        ...state,
        checkRunId: target.checkRunId,
        checkRunHeadSha: sticky.headSha,
      };
      const renderSkippedBody = (body: string, nextState: ReviewState) =>
        replaceStateMarkerWithinBudget(body, nextState);
      await saveStickyComment(this.octokit, {
        owner: target.owner,
        repo: target.repo,
        pullNumber: sticky.pullNumber,
        commentId: sticky.commentId,
        body: renderSkippedBody(sticky.body, stateToSave),
        expectedBody: sticky.body,
        onConflict: async (latest) => {
          const mergedState = latest.state
            ? mergeConcurrentReviewState(state, stateToSave, latest.state)
            : stateToSave;
          return {
            commentId: latest.commentId,
            expectedBody: latest.body,
            body: renderSkippedBody(latest.body, mergedState),
          };
        },
      });
    }

    logger.info({ reason, conclusion }, 'Review skipped');
    return {
      summary,
      score: deterministicScore(openCounts),
      findings: state.findings.filter((finding) => finding.status === 'open').map((finding) => ({
        path: finding.path,
        startLine: finding.startLine,
        endLine: finding.endLine,
        severity: finding.severity,
        category: 'other',
        title: finding.title,
        body: '',
      })),
      annotations: [],
      reviewedPaths: [],
      stats: openCounts,
      tokensUsed: { input: 0, output: 0, cached: 0 },
      callCount: 0,
    };
  }

  /** Pre-sticky behavior: full review stacked on the PR every run. */
  private async publishLegacy(input: {
    checkRunId: number | null;
    prContext: PullRequestContext;
    result: ReviewResult;
  }): Promise<ReviewResult> {
    const { checkRunId, prContext, result } = input;
    const { owner, repo, pullNumber, headSha } = prContext;

    const conclusion = conclusionFor(result.stats, this.config.review.failOn);
    if (checkRunId !== null) {
      await completeCheckRun(this.octokit, {
        owner,
        repo,
        checkRunId,
        conclusion,
        summary: buildSummary(result),
        annotations: result.annotations,
      });
    }

    await createPRReview(this.octokit, {
      owner,
      repo,
      pullNumber,
      commitSha: headSha,
      result,
      failOn: this.config.review.failOn,
    });

    logger.info(
      {
        pullNumber,
        score: result.score,
        annotations: result.annotations.length,
        llmCalls: result.callCount,
        conclusion,
      },
      'Review completed',
    );
    return result;
  }

  /**
   * Reconcile the complete finding inventory, publish only newly-open
   * annotations, then save the v2 marker last.
   */
  private async publishSticky(input: {
    checkRunId: number | null;
    prContext: PullRequestContext;
    result: ReviewResult;
    scope: ScopeDecision;
    state: ReviewState | null;
    commentId: number | null;
    commentBody?: string;
  }): Promise<ReviewResult> {
    const { checkRunId, prContext, result, scope, state } = input;
    const { owner, repo, pullNumber, headSha } = prContext;
    const commentsCfg = this.config.review.comments;
    let threads: Array<{ fingerprint: string; id: string; isResolved: boolean }> = [];
    let threadsAvailable = hasGraphql(this.octokit);
    if (threadsAvailable) {
      try {
        threads = await listFiscalcrThreads(
          this.octokit,
          { owner, repo, pullNumber },
          { includeOutdated: true },
        );
      } catch (err) {
        threadsAvailable = false;
        logger.warn({ err }, 'Could not list review threads — lifecycle remains threadless');
      }
    } else {
      logger.warn('GraphQL unavailable — lifecycle remains threadless');
    }

    const reviewedPaths = result.reviewedPaths;
    const reviewedRanges = scope.mode === 'delta' ? result.reviewedRanges ?? [] : [];
    let stateForPublication = state;
    try {
      const latestSticky = await loadReviewState(this.octokit, { owner, repo, pullNumber });
      const latestState =
        latestSticky?.state ?? (latestSticky?.legacyState ? migrateLegacyState(latestSticky.legacyState) : null);
      if (latestState) {
        stateForPublication = state
          ? mergeConcurrentReviewState(state, state, latestState)
          : latestState;
      }
    } catch (err) {
      logger.warn({ err }, 'Could not reread lifecycle state before publication — preserving planned state');
    }
    const plan = planStickyPublication({
      result,
      config: this.config,
      state: stateForPublication,
      threads,
      threadsAvailable,
      reviewedPaths,
      reviewedRanges,
      headSha,
    });
    if (commentsCfg.resolveOutdated && stateForPublication) {
      if (!threadsAvailable) {
        result.threadCleanup = { attempted: 0, resolved: 0, failed: 0, unavailable: true };
      } else {
        const cleanup = await resolveOutdatedThreads(this.octokit, {
          owner,
          repo,
          pullNumber,
          changedPaths: new Set(reviewedPaths),
          reviewedRanges: scope.mode === 'delta' ? reviewedRanges : undefined,
          currentFingerprints: new Set(
            (result.findings ?? result.annotations).map((annotation) => fingerprintAnnotation(annotation)),
          ),
          headSha,
        });
        result.threadCleanup = {
          attempted: cleanup.attempted,
          resolved: cleanup.resolved.length,
          failed: cleanup.failed,
          unavailable: cleanup.unavailable,
        };
        plan.autoResolvedThreadIds = cleanup.resolved.map((thread) => thread.id);
      }
    }
    if (plan.capOverflow.length > 0) {
      logger.info(
        { overflow: plan.capOverflow.length, cap: commentsCfg.maxOpenComments },
        'maxOpenComments reached — overflow findings demoted to check-run annotations',
      );
    }
    const conclusion = plan.blocking ? 'failure' : 'success';

    if (checkRunId !== null) {
      await completeCheckRun(this.octokit, {
        owner,
        repo,
        checkRunId,
        conclusion,
        summary: buildSummary({ ...result, stats: plan.openCounts }),
        annotations: result.annotations,
        externalId: JSON.stringify({
          scope: scope.mode,
          calls: result.callCount ?? 0,
          newFindings: plan.newAnnotations.length,
        }),
      });
    }

    let blockingReviewId = stateForPublication?.blockingReviewId ?? null;
    if (blockingReviewId !== null) {
      const message = plan.blocking
        ? `Superseded by an updated review as of ${headSha.slice(0, 7)}.`
        : `✅ Issues addressed as of ${headSha.slice(0, 7)}.`;
      await dismissBlockingReview(this.octokit, {
        owner,
        repo,
        pullNumber,
        reviewId: blockingReviewId,
        message,
      });
      blockingReviewId = null;
    }

    const outcome = await createIncrementalReview(this.octokit, {
      owner,
      repo,
      pullNumber,
      commitSha: headSha,
      annotations: plan.inlineNew,
      changedFiles: prContext.changedFiles,
      event: plan.blocking ? 'REQUEST_CHANGES' : 'COMMENT',
      body: this.buildIncrementalBody(
        result,
        scope,
        plan.newAnnotations.length,
        plan.openCounts,
        plan.blocking,
      ),
    });
    let findings = plan.findings;
    let refreshedThreads: FiscalcrThread[] = [];
    if (outcome.posted.length > 0) {
      try {
        refreshedThreads = await listFiscalcrThreads(this.octokit, { owner, repo, pullNumber });
        const postedFingerprints = new Set(outcome.posted.map((annotation) => fingerprintAnnotation(annotation)));
        const threadByFingerprint = new Map(
          refreshedThreads.map((thread) => [thread.fingerprint, thread.id]),
        );
        findings = findings.map((finding) =>
          postedFingerprints.has(finding.fingerprint)
            ? { ...finding, threadId: threadByFingerprint.get(finding.fingerprint) ?? finding.threadId }
            : finding,
        );
      } catch (err) {
        logger.warn({ err }, 'Could not refresh newly posted review threads — preserving current state');
      }
    }

    if (plan.blocking) blockingReviewId = outcome.reviewId;

    // State is saved last, only after all publication side effects succeeded.
    const demoted = [...outcome.demoted, ...plan.capOverflow];
    let newState: ReviewState = {
      v: 2,
      lastReviewedSha: headSha,
      baseSha: prContext.baseSha,
      blockingReviewId,
      findings,
      recentEvents: stateForPublication?.recentEvents ?? [],
      autoResolvedThreads: [
        ...(stateForPublication?.autoResolvedThreads ?? []),
        ...plan.autoResolvedThreadIds,
      ],
      checkRunId: checkRunId ?? stateForPublication?.checkRunId ?? null,
      checkRunHeadSha: checkRunId === null ? stateForPublication?.checkRunHeadSha ?? null : headSha,
      runs: appendRun(stateForPublication?.runs ?? [], {
        sha: headSha.slice(0, 7),
        at: new Date().toISOString().slice(0, 10),
        scope: scope.mode === 'delta' ? 'delta' : 'full',
        newFindings: plan.newAnnotations.length,
        cost: result.costEstimate?.usd.toFixed(4) ?? '0',
      }),
    };
    for (const thread of refreshedThreads) {
      if (!thread.isResolved) continue;
      const finding = newState.findings.find(
        (candidate) => candidate.fingerprint === thread.fingerprint && candidate.threadId === thread.id,
      );
      if (!finding) continue;
      newState = applyManualThreadResolution(newState, {
        fingerprint: thread.fingerprint,
        threadId: thread.id,
        eventKey: `pre-persist-resolved:${thread.id}:${headSha}`,
        at: new Date().toISOString(),
      });
    }
    let stateToSave = newState;
    let stickyCommentId = input.commentId;
    let expectedBody = input.commentBody;
    try {
      const latestSticky = await loadReviewState(this.octokit, { owner, repo, pullNumber });
      if (latestSticky) {
        expectedBody = latestSticky.body;
      }
      if (latestSticky?.state) {
        stateToSave = mergeConcurrentReviewState(stateForPublication, newState, latestSticky.state);
        stickyCommentId = latestSticky.commentId;
      }
    } catch (err) {
      logger.warn({ err }, 'Could not reread lifecycle state before save — preserving planned state');
    }
    const renderSavedBody = () =>
      renderStickyComment({
        result,
        state: stateToSave,
        preserveExistingDiagram: scope.mode === 'delta',
        existingBody: expectedBody,
        demoted: demoted.map((annotation) => ({
          path: annotation.path,
          startLine: annotation.startLine,
          severity: annotation.severity,
          title: annotation.title,
        })),
      });
    await saveStickyComment(this.octokit, {
      owner,
      repo,
      pullNumber,
      commentId: stickyCommentId,
      expectedBody,
      body: renderSavedBody(),
      onConflict: async (latest) => {
        if (latest.state) {
          stateToSave = mergeConcurrentReviewState(stateForPublication, newState, latest.state);
        }
        stickyCommentId = latest.commentId;
        expectedBody = latest.body;
        return {
          commentId: latest.commentId,
          expectedBody: latest.body,
          body: renderSavedBody(),
        };
      },
    });

    logger.info(
      {
        pullNumber,
        scope: scope.mode,
        score: result.score,
        newFindings: plan.newAnnotations.length,
        postedInline: outcome.posted.length,
        openCounts: plan.openCounts,
        llmCalls: result.callCount,
        conclusion,
      },
      'Review completed',
    );
    return { ...result, stats: plan.openCounts };
  }

  /** Render the short body used for incremental review comments. */
  private buildIncrementalBody(
    result: ReviewResult,
    scope: ScopeDecision,
    newFindings: number,
    openCounts: Record<Severity, number>,
    blocking: boolean,
  ): string {
    const openTotal = Object.values(openCounts).reduce((a, b) => a + b, 0);
    const lines: string[] = [];
    lines.push(blocking ? '## 🤖 FiscalCR — changes requested' : '## 🤖 FiscalCR review update');
    if (scope.mode === 'delta' && scope.sinceSha) {
      lines.push(`\nIncremental review of changes since \`${scope.sinceSha.slice(0, 7)}\`.`);
    }
    lines.push(
      `\n**${newFindings} new finding(s)** this run · **${openTotal} open** across the PR · score ${result.score}/100`,
    );
    lines.push('\nSee the pinned FiscalCR summary comment for the full walkthrough and open findings.');
    return lines.join('\n');
  }
}
