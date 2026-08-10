import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runReviewPipeline,
  routeReview,
  estimateReviewTokens,
} from '../../src/pipeline/run-review.js';
import { UsageTracker, type TelemetryEvent } from '../../src/pipeline/usage.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ReviewConfig } from '../../src/config/schema.js';
import { ReviewError } from '../../src/utils/errors.js';
import { estimateTokens } from '../../src/utils/tokens.js';
import type { ChatCompletionParams, LLMProvider } from '../../src/providers/interface.js';
import type { PullRequestContext } from '../../src/types/review.js';

const PATCH = '@@ -1,2 +1,3 @@\n line one\n+line two\n+line three';

function context(overrides: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    owner: 'o',
    repo: 'r',
    pullNumber: 1,
    baseSha: 'base',
    headSha: 'head',
    title: 'Add feature',
    body: 'Does things',
    diff: 'the-diff',
    changedFiles: [{ filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 0, patch: PATCH }],
    fileContents: new Map([['src/a.ts', 'a\nb\n']]),
    ...overrides,
  };
}

function cfg(pipelineOverrides: Partial<ReviewConfig['pipeline']> = {}): ReviewConfig {
  return {
    ...DEFAULT_CONFIG,
    pipeline: { ...DEFAULT_CONFIG.pipeline, maxRetries: 0, ...pipelineOverrides },
  };
}

interface ScriptedCall {
  match: (params: ChatCompletionParams) => boolean;
  content: unknown;
}

function scriptedLLM(script: ScriptedCall[]) {
  const calls: ChatCompletionParams[] = [];
  return {
    calls,
    chatCompletion: vi.fn(async (params: ChatCompletionParams) => {
      calls.push(params);
      const step = script.find((s) => s.match(params));
      if (!step) throw new Error(`No scripted response for call ${calls.length}`);
      return {
        content: JSON.stringify(step.content),
        usage: { input: 100, output: 50, cached: 10 },
      };
    }),
  };
}

const isIntentCall = (p: ChatCompletionParams) =>
  p.messages[0].content.includes('skimming a pull request');
const isGroupCall = (p: ChatCompletionParams) =>
  p.messages[0].content.includes('"groupSummary"');
const isSynthesisCall = (p: ChatCompletionParams) =>
  p.messages[0].content.includes('review lead');
const isFastPathCall = (p: ChatCompletionParams) =>
  p.messages[0].content.includes('"intent"') && p.messages[0].content.includes('"findings"');

const groupResponse = (title: string) => ({
  groupSummary: 'Group reviewed',
  findings: [
    {
      path: 'src/a.ts',
      startLine: 2,
      endLine: 2,
      severity: 'warning',
      category: 'bug',
      title,
      body: 'Something is off',
      confidence: 0.9,
    },
  ],
});

describe('routeReview', () => {
  it('routes a small PR to the fast path and reports estimated tokens', () => {
    const decision = routeReview(context(), cfg());
    expect(decision.route).toBe('fast-path');
    expect(decision.estimatedTokens).toBeGreaterThan(0);
  });

  it('routes a large PR to the multi-pass pipeline', () => {
    const big = context({
      fileContents: new Map([['src/a.ts', 'x'.repeat(200_000)]]),
    });
    const decision = routeReview(big, cfg());
    expect(decision.route).toBe('multi-pass');
    expect(decision.estimatedTokens).toBeGreaterThanOrEqual(
      cfg().pipeline.fastPathThreshold,
    );
  });

  it('forces the fast path when the pipeline is disabled, even for large PRs', () => {
    const big = context({ fileContents: new Map([['src/a.ts', 'x'.repeat(200_000)]]) });
    const decision = routeReview(big, cfg({ enabled: false }));
    expect(decision.route).toBe('fast-path');
  });

  it('estimates tokens from patches plus full file contents', () => {
    const ctx = context({
      changedFiles: [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n x' },
        { filename: 'b.ts', status: 'added', additions: 1, deletions: 0 },
      ],
      fileContents: new Map([
        ['a.ts', 'hello world'],
        ['b.ts', 'some content here'],
      ]),
    });
    const expected =
      estimateTokens('@@ -1 +1 @@\n x') +
      estimateTokens('hello world') +
      estimateTokens('some content here');
    expect(estimateReviewTokens(ctx)).toBe(expected);
  });
});

describe('runReviewPipeline', () => {
  it('takes the fast path: exactly 1 LLM call and forwards deltaHint', async () => {
    const llm = scriptedLLM([
      {
        match: isFastPathCall,
        content: {
          intent: 'Small change',
          summary: 'Looks fine',
          score: 95,
          walkthrough: [{ path: 'src/a.ts', summary: 'tweak' }],
          findings: [],
        },
      },
    ]);
    const usage = new UsageTracker();
    const deltaHint = '### Incremental Review\nOnly files changed since commit abc1234.';

    const result = await runReviewPipeline(llm, context(), cfg(), usage, { deltaHint });

    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
    expect(result.callCount).toBe(1);
    expect(result.intent).toBe('Small change');
    expect(result.walkthrough).toEqual([{ path: 'src/a.ts', summary: 'tweak' }]);
    expect(result.tokensUsed).toEqual({ input: 100, output: 50, cached: 10 });
    // deltaHint forwarded into the fast-path user prompt.
    expect(llm.calls[0].messages[1].content).toContain(deltaHint);
  });

  it('runs intent + groups + synthesis and aggregates usage from the caller tracker', async () => {
    const ctx = context({
      changedFiles: [
        { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 0, patch: PATCH },
        { filename: 'lib/b.ts', status: 'modified', additions: 2, deletions: 0, patch: PATCH },
      ],
      fileContents: new Map([
        ['src/a.ts', 'x'.repeat(90_000)],
        ['lib/b.ts', 'y'.repeat(90_000)],
      ]),
    });
    const llm = scriptedLLM([
      {
        match: isIntentCall,
        content: {
          intent: 'Big refactor',
          walkthrough: [],
          groups: [
            { label: 'g1', files: ['src/a.ts'] },
            { label: 'g2', files: ['lib/b.ts'] },
          ],
          riskHotspots: [],
        },
      },
      { match: isGroupCall, content: groupResponse('Group finding') },
      {
        match: isSynthesisCall,
        content: {
          summary: 'Final synthesis',
          score: 80,
          walkthrough: [],
          nearDuplicates: [],
          likelyFalsePositives: [],
        },
      },
    ]);
    const usage = new UsageTracker();

    const result = await runReviewPipeline(
      llm,
      ctx,
      cfg({ fastPathThreshold: 1_000, groupTokenBudget: 30_000 }),
      usage,
    );

    // 1 intent + 2 groups + 1 synthesis
    expect(llm.chatCompletion).toHaveBeenCalledTimes(4);
    expect(result.callCount).toBe(4);
    expect(result.summary).toBe('Final synthesis');
    expect(result.intent).toBe('Big refactor');
    expect(result.tokensUsed.input).toBe(400);
    expect(usage.total().input).toBe(400);
    expect(usage.calls()).toBe(4);
  });

  it('forwards deltaHint into the group review prompt on the multi-pass path', async () => {
    const ctx = context({ fileContents: new Map([['src/a.ts', 'x'.repeat(90_000)]]) });
    const llm = scriptedLLM([
      {
        match: isIntentCall,
        content: { intent: 'x', walkthrough: [], groups: [], riskHotspots: [] },
      },
      { match: isGroupCall, content: groupResponse('Finding') },
      {
        match: isSynthesisCall,
        content: { summary: 'Done', score: 70, walkthrough: [], nearDuplicates: [], likelyFalsePositives: [] },
      },
    ]);
    const deltaHint = '### Incremental Review\nOnly files changed since commit abc1234.';

    await runReviewPipeline(
      llm,
      ctx,
      cfg({ fastPathThreshold: 1_000 }),
      new UsageTracker(),
      { deltaHint },
    );

    const groupCall = llm.calls.find(isGroupCall)!;
    expect(groupCall.messages[1].content).toContain(deltaHint);
  });

  it('collects related context from the workspace root into the group prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fiscalcr-run-review-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'helper.ts'), 'export const helper = 1;\n');
      const ctx = context({
        changedFiles: [
          { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 0, patch: PATCH },
        ],
        fileContents: new Map([
          ['src/a.ts', "import { helper } from './helper';\nconst x = helper;\n" + 'x'.repeat(90_000)],
        ]),
      });
      const llm = scriptedLLM([
        {
          match: isIntentCall,
          content: { intent: 'x', walkthrough: [], groups: [], riskHotspots: [] },
        },
        { match: isGroupCall, content: groupResponse('Finding') },
        {
          match: isSynthesisCall,
          content: { summary: 's', score: 70, walkthrough: [], nearDuplicates: [], likelyFalsePositives: [] },
        },
      ]);

      await runReviewPipeline(
        llm,
        ctx,
        cfg({ fastPathThreshold: 1_000, relatedContextBudget: 15_000 }),
        new UsageTracker(),
        { workspaceRoot: dir },
      );

      const groupCall = llm.calls.find(isGroupCall)!;
      expect(groupCall.messages[1].content).toContain('### Related Files');
      expect(groupCall.messages[1].content).toContain('src/helper.ts');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws ReviewError when every review group fails', async () => {
    const ctx = make({ fileContents: new Map([['src/a.ts', 'x'.repeat(90_000)]]) });
    const llm = {
      chatCompletion: vi.fn(async (params: ChatCompletionParams) => {
        if (isIntentCall(params)) {
          return {
            content: JSON.stringify({ intent: 'x', walkthrough: [], groups: [], riskHotspots: [] }),
            usage: { input: 1, output: 1, cached: 0 },
          };
        }
        throw new Error('provider exploded');
      }),
    };

    await expect(
      runReviewPipeline(llm, ctx, cfg({ fastPathThreshold: 1_000 }), new UsageTracker()),
    ).rejects.toBeInstanceOf(ReviewError);
  });

  it('tolerates a failed group and notes it in the summary', async () => {
    const ctx = make({
      fileContents: new Map([
        ['src/a.ts', 'x'.repeat(90_000)],
        ['lib/b.ts', 'y'.repeat(90_000)],
      ]),
    });
    let groupCalls = 0;
    const llm = {
      chatCompletion: vi.fn(async (params: ChatCompletionParams) => {
        if (isIntentCall(params)) {
          return {
            content: JSON.stringify({ intent: 'x', walkthrough: [], groups: [], riskHotspots: [] }),
            usage: { input: 1, output: 1, cached: 0 },
          };
        }
        if (isGroupCall(params)) {
          groupCalls++;
          if (groupCalls === 1) throw new Error('provider exploded');
          return {
            content: JSON.stringify(groupResponse('Surviving finding')),
            usage: { input: 1, output: 1, cached: 0 },
          };
        }
        return {
          content: JSON.stringify({ summary: 'Done', score: 70, walkthrough: [], nearDuplicates: [], likelyFalsePositives: [] }),
          usage: { input: 1, output: 1, cached: 0 },
        };
      }),
    };

    const result = await runReviewPipeline(
      llm,
      ctx,
      cfg({ fastPathThreshold: 1_000, groupTokenBudget: 30_000 }),
      new UsageTracker(),
    );

    expect(result.summary).toContain('could not be fully reviewed');
    expect(result.annotations.map((a) => a.title)).toContain('Surviving finding');
  });
});

// Helper: build a multi-pass-sized context with the given fileContents.
function make(overrides: Partial<PullRequestContext> = {}): PullRequestContext {
  return context({
    changedFiles: [
      { filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 0, patch: PATCH },
      { filename: 'lib/b.ts', status: 'modified', additions: 2, deletions: 0, patch: PATCH },
    ],
    ...overrides,
  });
}