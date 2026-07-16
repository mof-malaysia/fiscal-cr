import { describe, expect, it, vi } from 'vitest';
import { ReviewOrchestrator } from '../../src/review/orchestrator.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ReviewConfig } from '../../src/config/schema.js';
import type { ChatCompletionParams } from '../../src/providers/interface.js';

const PATCH = '@@ -1,2 +1,3 @@\n line one\n+line two\n+line three';

function fakeOctokit(files: Array<{ filename: string; patch?: string }>) {
  return {
    checks: {
      create: vi.fn(async () => ({ data: { id: 42 } })),
      update: vi.fn(async () => ({})),
    },
    pulls: {
      get: vi.fn(async ({ mediaType }: { mediaType?: { format: string } }) => {
        if (mediaType?.format === 'diff') return { data: 'the-diff' };
        return {
          data: {
            base: { sha: 'base-sha' },
            head: { sha: 'head-sha' },
            title: 'Add feature',
            body: 'Does things',
          },
        };
      }),
      listFiles: vi.fn(async ({ page }: { page: number }) =>
        page === 1
          ? {
              data: files.map((f) => ({
                filename: f.filename,
                status: 'modified',
                additions: 2,
                deletions: 0,
                patch: f.patch ?? PATCH,
              })),
            }
          : { data: [] },
      ),
      createReview: vi.fn(async () => ({ data: { id: 7 } })),
    },
    repos: {
      getContent: vi.fn(async ({ path }: { path: string }) => ({
        data: {
          content: Buffer.from(`// content of ${path}\n`).toString('base64'),
          encoding: 'base64',
        },
      })),
    },
    issues: {
      listComments: vi.fn(async () => ({ data: [] })),
      createComment: vi.fn(async () => ({ data: { id: 9 } })),
      updateComment: vi.fn(async () => ({})),
    },
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

function cfg(pipelineOverrides: Partial<ReviewConfig['pipeline']> = {}): ReviewConfig {
  return {
    ...DEFAULT_CONFIG,
    pipeline: { ...DEFAULT_CONFIG.pipeline, maxRetries: 0, ...pipelineOverrides },
  };
}

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

describe('ReviewOrchestrator pipeline routing', () => {
  it('small PR takes the fast path: exactly 1 LLM call', async () => {
    const octokit = fakeOctokit([{ filename: 'src/a.ts' }]);
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

    const orchestrator = new ReviewOrchestrator(octokit as never, llm, cfg());
    const result = await orchestrator.reviewPullRequest({
      owner: 'o', repo: 'r', pullNumber: 1, headSha: 'head-sha',
    });

    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
    expect(result.callCount).toBe(1);
    expect(result.intent).toBe('Small change');
    expect(result.walkthrough).toEqual([{ path: 'src/a.ts', summary: 'tweak' }]);
    expect(result.tokensUsed).toEqual({ input: 100, output: 50, cached: 10 });
  });

  it('large PR runs intent + N groups + synthesis and aggregates usage', async () => {
    // Two files with big contents so the pipeline splits them into 2 groups.
    const octokit = fakeOctokit([
      { filename: 'src/a.ts' },
      { filename: 'lib/b.ts' },
    ]);
    octokit.repos.getContent = vi.fn(async ({ path }: { path: string }) => ({
      data: {
        content: Buffer.from(`// ${path}\n${'x'.repeat(90_000)}`).toString('base64'),
        encoding: 'base64',
      },
    }));

    const llm = scriptedLLM([
      {
        match: isIntentCall,
        content: {
          intent: 'Big refactor',
          walkthrough: [{ path: 'src/a.ts', summary: 'refactor' }],
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

    const orchestrator = new ReviewOrchestrator(
      octokit as never,
      llm,
      cfg({ fastPathThreshold: 1_000, groupTokenBudget: 30_000 }),
    );
    const result = await orchestrator.reviewPullRequest({
      owner: 'o', repo: 'r', pullNumber: 1, headSha: 'head-sha',
    });

    // 1 intent + 2 groups + 1 synthesis
    expect(llm.chatCompletion).toHaveBeenCalledTimes(4);
    expect(result.callCount).toBe(4);
    expect(result.summary).toBe('Final synthesis');
    expect(result.intent).toBe('Big refactor');
    expect(result.tokensUsed.input).toBe(400);
    // One finding per group, deduped to distinct files? Same path+category+lines → deduped to 1
    expect(result.annotations.length).toBeGreaterThanOrEqual(1);
  });

  it('tolerates a failed group and notes it in the summary', async () => {
    const octokit = fakeOctokit([
      { filename: 'src/a.ts' },
      { filename: 'lib/b.ts' },
    ]);
    octokit.repos.getContent = vi.fn(async ({ path }: { path: string }) => ({
      data: {
        content: Buffer.from(`// ${path}\n${'x'.repeat(90_000)}`).toString('base64'),
        encoding: 'base64',
      },
    }));

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

    const orchestrator = new ReviewOrchestrator(
      octokit as never,
      llm,
      cfg({ fastPathThreshold: 1_000, groupTokenBudget: 30_000 }),
    );
    const result = await orchestrator.reviewPullRequest({
      owner: 'o', repo: 'r', pullNumber: 1, headSha: 'head-sha',
    });

    expect(result.summary).toContain('could not be fully reviewed');
    expect(result.annotations.map((a) => a.title)).toContain('Surviving finding');
  });

  it('pipeline.enabled=false forces the fast path even for big PRs', async () => {
    const octokit = fakeOctokit([{ filename: 'src/a.ts' }, { filename: 'lib/b.ts' }]);
    octokit.repos.getContent = vi.fn(async () => ({
      data: {
        content: Buffer.from('x'.repeat(200_000)).toString('base64'),
        encoding: 'base64',
      },
    }));
    const llm = scriptedLLM([
      {
        match: isFastPathCall,
        content: { intent: '', summary: 'Legacy single call', score: 88, walkthrough: [], findings: [] },
      },
    ]);

    const orchestrator = new ReviewOrchestrator(
      octokit as never,
      llm,
      cfg({ enabled: false }),
    );
    const result = await orchestrator.reviewPullRequest({
      owner: 'o', repo: 'r', pullNumber: 1, headSha: 'head-sha',
    });

    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe('Legacy single call');
  });

  it('completes the check run as failure and rethrows when everything fails', async () => {
    const octokit = fakeOctokit([{ filename: 'src/a.ts' }]);
    const llm = {
      chatCompletion: vi.fn(async () => {
        throw new Error('total outage');
      }),
    };
    const orchestrator = new ReviewOrchestrator(octokit as never, llm, cfg());

    await expect(
      orchestrator.reviewPullRequest({ owner: 'o', repo: 'r', pullNumber: 1, headSha: 'h' }),
    ).rejects.toThrow('total outage');

    const updateCall = octokit.checks.update.mock.calls.at(-1)?.[0] as { conclusion: string };
    expect(updateCall.conclusion).toBe('failure');
  });
});
