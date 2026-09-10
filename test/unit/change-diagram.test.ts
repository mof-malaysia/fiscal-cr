import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  generateChangeDiagram,
  shouldGenerateChangeDiagram,
  DIAGRAM_MAX_INPUT_TOKENS,
} from '../../src/pipeline/change-diagram.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type {
  LLMProvider,
  LLMCompletionResponse,
  ChatCompletionParams,
} from '../../src/providers/interface.js';
import type { PullRequestContext } from '../../src/types/review.js';
import type { ReviewConfig } from '../../src/config/schema.js';
import { UsageTracker } from '../../src/pipeline/usage.js';
import { estimateTokens } from '../../src/utils/tokens.js';

/** Fake provider returning a fixed completion; the only mocked collaborator. */
function makeLlm(content: string, finishReason?: string): LLMProvider {
  return {
    chatCompletion: vi.fn().mockResolvedValue({
      content,
      usage: { input: 100, output: 50, cached: 0 },
      finishReason,
    } as LLMCompletionResponse),
  };
}

/** Real usage aggregator — totals and call counts are observed directly. */
function makeUsage(): UsageTracker {
  return new UsageTracker();
}

function makeCtx(overrides: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    owner: 'o',
    repo: 'r',
    pullNumber: 1,
    baseSha: 'base',
    headSha: 'headsha',
    title: 't',
    body: '',
    diff: '',
    changedFiles: [],
    fileContents: new Map(),
    ...overrides,
  };
}

function makeConfig(enabled: boolean, language: ReviewConfig['language'] = 'en'): ReviewConfig {
  return {
    ...DEFAULT_CONFIG,
    language,
    review: { ...DEFAULT_CONFIG.review, diagram: { enabled } },
  } as ReviewConfig;
}

/** A minimal strict-schema-valid diagram response referencing evidence id e0. */
const VALID_RESPONSE = JSON.stringify({
  outcome: 'diagram',
  nodes: [{ id: 'n1', label: 'Auth', change: 'modified', evidence: ['e0'] }],
  edges: [],
});

interface SentEvidence {
  id: string;
  path: string;
  patch: string;
}
interface SentData {
  language: string;
  scope: 'full' | 'delta';
  partial: boolean;
  evidence: SentEvidence[];
}

function userMessageOf(llm: LLMProvider): string {
  const mock = llm.chatCompletion as unknown as Mock;
  const messages = mock.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
  return messages.find((m) => m.role === 'user')!.content;
}

function dataBlockOf(userMsg: string): SentData {
  return JSON.parse(userMsg.split('Data: ')[1]!) as SentData;
}

describe('generateChangeDiagram', () => {
  it('gates diagrams to complex multi-file changes', () => {
    expect(
      shouldGenerateChangeDiagram(
        makeCtx({
          changedFiles: [
            { filename: 'a.ts', status: 'modified', additions: 10, deletions: 0, patch: 'patch' },
            { filename: 'b.ts', status: 'modified', additions: 10, deletions: 0, patch: 'patch' },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      shouldGenerateChangeDiagram(
        makeCtx({
          changedFiles: [
            { filename: 'a.ts', status: 'modified', additions: 19, deletions: 0, patch: 'patch' },
            { filename: 'b.ts', status: 'modified', additions: 0, deletions: 0, patch: 'patch' },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      shouldGenerateChangeDiagram(
        makeCtx({
          changedFiles: [
            { filename: 'a.ts', status: 'modified', additions: 20, deletions: 0, patch: 'patch' },
          ],
        }),
      ),
    ).toBe(false);
  });
  it('uses configured complexity thresholds', () => {
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'a.ts', status: 'modified', additions: 5, deletions: 0, patch: 'patch' },
        { filename: 'b.ts', status: 'modified', additions: 5, deletions: 0, patch: 'patch' },
      ],
    });

    expect(shouldGenerateChangeDiagram(ctx)).toBe(false);
    expect(shouldGenerateChangeDiagram(ctx, { minChangedLines: 10 })).toBe(true);
    expect(shouldGenerateChangeDiagram(ctx, { minChangedFiles: 3 })).toBe(false);
  });


  it('returns undefined and makes no call when disabled', async () => {
    const llm = makeLlm('{}');
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(false), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['a.ts'],
    });
    expect(result).toBeUndefined();
    expect(llm.chatCompletion).not.toHaveBeenCalled();
  });

  it('makes no call when no changed file has a usable patch', async () => {
    const llm = makeLlm('{}');
    const ctx = makeCtx({
      changedFiles: [{ filename: 'a.ts', status: 'modified', additions: 0, deletions: 0 }],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: [],
    });
    expect(result).toBeUndefined();
    expect(llm.chatCompletion).not.toHaveBeenCalled();
  });

  it('produces an artifact from a valid response via the real parser', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['src/a.ts'],
    });

    expect(result).toBeDefined();
    expect(result!.scope).toBe('full');
    expect(result!.headSha).toBe('headsha');
    // The real parser remaps model ids to code-owned n0… and validates refs.
    expect(result!.nodes).toHaveLength(1);
    expect(result!.nodes[0].id).toBe('n0');
    expect(result!.edges).toEqual([]);
    // Evidence mapping carries ids/paths only, never the raw patches.
    expect(result!.evidence).toEqual([{ id: 'e0', path: 'src/a.ts' }]);
    expect((result!.evidence[0] as Record<string, unknown>).patch).toBeUndefined();
  });

  it('never sends ctx.diff and does not overclaim full PR coverage', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const secret = 'SECRET_SHOULD_NOT_LEAK';
    const ctx = makeCtx({
      diff: `whole pr diff ${secret}`,
      changedFiles: [
        { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['src/a.ts'],
    });
    expect(result).toBeDefined();

    const userMsg = userMessageOf(llm);
    expect(userMsg).toContain('src/a.ts');
    expect(userMsg).not.toContain(secret);
    // Scope/partial are serialized as code-owned data; no "full PR coverage" claim.
    const data = dataBlockOf(userMsg);
    expect(data.scope).toBe('full');
    expect(userMsg).not.toMatch(/full pull request scope|covers the full/i);
    // The actual patch evidence is present, keyed by its real path.
    expect(data.evidence[0].path).toBe('src/a.ts');
    expect(data.evidence[0].patch).toContain('-a');
  });

  it('delta scope reports only the selected evidence and still excludes ctx.diff', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const secret = 'DO_NOT_LEAK_DELTA';
    const ctx = makeCtx({
      diff: `whole diff ${secret}`,
      changedFiles: [
        { filename: 'selected.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'delta',
      reviewedPaths: ['selected.ts'],
    });
    expect(result!.scope).toBe('delta');
    const userMsg = userMessageOf(llm);
    const data = dataBlockOf(userMsg);
    expect(data.scope).toBe('delta');
    expect(userMsg).toContain('selected.ts');
    expect(userMsg).not.toContain(secret);
  });

  it('makes exactly one bounded json call to the provider', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['a.ts'],
    });
    expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
    const req = (llm.chatCompletion as unknown as Mock).mock.calls[0][0] as ChatCompletionParams;
    expect(req.responseFormat).toEqual({ type: 'json_object' });
    expect(req.maxTokens).toBe(2000);
    expect(req.timeoutMs).toBe(60000);
  });

  it('drops an oversized whole hunk and keeps the fitting ones (exact whole-hunk selection)', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const bigPatch = `@@ -1,1 +1,2 @@\n context\n+${'a'.repeat(60_000)}`;
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'small.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
        { filename: 'huge.ts', status: 'modified', additions: 1, deletions: 0, patch: bigPatch },
        { filename: 'small2.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-x\n+y\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['small.ts', 'huge.ts', 'small2.ts'],
    });
    expect(result).toBeDefined();

    const data = dataBlockOf(userMessageOf(llm));
    // The oversized hunk was dropped whole; the two small hunks were kept.
    expect(data.evidence.map((e) => e.id)).toEqual(['e0', 'e1']);
    expect(data.evidence.some((e) => e.patch.includes('a'.repeat(100)))).toBe(false);
    expect(data.partial).toBe(true);
    expect(result!.partial).toBe(true);
  });

  it('caps evidence at 40 units and marks partial when more exist', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const files = Array.from({ length: 45 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
      patch: '@@ -1,1 +1,1 @@\n-a\n+b\n',
    }));
    const ctx = makeCtx({ changedFiles: files });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: files.map((f) => f.filename),
    });
    const data = dataBlockOf(userMessageOf(llm));
    expect(data.evidence).toHaveLength(40);
    expect(result!.partial).toBe(true);
  });

  it('marks partial when an included file is missing from reviewedPaths', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'covered.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
        { filename: 'uncovered.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-x\n+y\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['covered.ts'],
    });
    expect(result!.partial).toBe(true);
  });

  it('marks partial when a changed file has no usable patch', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'haspatch.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
        { filename: 'nopatch.ts', status: 'modified', additions: 5, deletions: 0 },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['haspatch.ts', 'nopatch.ts'],
    });
    expect(result!.partial).toBe(true);
  });

  it('is not partial when every included file is covered and fits', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'p.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['p.ts'],
    });
    expect(result!.partial).toBe(false);
  });

  it('discards an invalid response but records real usage totals and the call', async () => {
    const llm = makeLlm('not json {{');
    const usage = makeUsage();
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), usage, {
      scope: 'full',
      reviewedPaths: ['a.ts'],
    });
    expect(result).toBeUndefined();
    expect(usage.calls()).toBe(1);
    expect(usage.total()).toEqual({ input: 100, output: 50, cached: 0 });
  });

  it('discards a length-truncated response and counts the spend', async () => {
    const llm = makeLlm('{"outcome":"diagram"', 'length');
    const usage = makeUsage();
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), usage, {
      scope: 'full',
      reviewedPaths: ['a.ts'],
    });
    expect(result).toBeUndefined();
    expect(usage.calls()).toBe(1);
    expect(usage.total()).toEqual({ input: 100, output: 50, cached: 0 });
  });

  it('discards a content_filter response and still records the call totals', async () => {
    const llm = makeLlm(VALID_RESPONSE, 'content_filter');
    const usage = makeUsage();
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), usage, {
      scope: 'full',
      reviewedPaths: ['a.ts'],
    });
    expect(result).toBeUndefined();
    expect(usage.calls()).toBe(1);
    expect(usage.total()).toEqual({ input: 100, output: 50, cached: 0 });
  });

  it('returns undefined and records the attempt if the provider throws', async () => {
    const llm = {
      chatCompletion: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as LLMProvider;
    const usage = makeUsage();
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), usage, {
      scope: 'full',
      reviewedPaths: ['a.ts'],
    });
    expect(result).toBeUndefined();
    expect(usage.calls()).toBe(1);
    expect(usage.total()).toEqual({ input: 0, output: 0, cached: 0 });
  });

  it('keeps the actual serialized payload within the input budget', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const patch = '@@ -1,6 +1,6 @@\n' + Array.from({ length: 5 }, (_, i) => ` ${i}\n`).join('') + '-old\n+new\n';
    const files = Array.from({ length: 10 }, (_, i) => ({
      filename: `m${i}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      patch,
    }));
    const ctx = makeCtx({ changedFiles: files });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: files.map((f) => f.filename),
    });
    expect(result).toBeDefined();
    const messages = ((llm.chatCompletion as unknown as Mock).mock.calls[0][0] as ChatCompletionParams).messages;
    const estimated = estimateTokens(messages[0].content) + estimateTokens(messages[1].content);
    expect(estimated).toBeLessThanOrEqual(DIAGRAM_MAX_INPUT_TOKENS);
  });
  it('accepts an Anthropic end_turn finish reason and records the spend', async () => {
    const llm = makeLlm(VALID_RESPONSE, 'end_turn');
    const usage = makeUsage();
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), usage, {
      scope: 'full',
      reviewedPaths: ['a.ts'],
    });
    expect(result).toBeDefined();
    expect(usage.calls()).toBe(1);
    expect(usage.total()).toEqual({ input: 100, output: 50, cached: 0 });
  });

  it('accepts an Anthropic stop_sequence finish reason', async () => {
    const llm = makeLlm(VALID_RESPONSE, 'stop_sequence');
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['a.ts'],
    });
    expect(result).toBeDefined();
  });

  it('rejects a tool_use finish reason but still records the spend', async () => {
    const llm = makeLlm('{"outcome":"diagram"}', 'tool_use');
    const usage = makeUsage();
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), usage, {
      scope: 'full',
      reviewedPaths: ['a.ts'],
    });
    expect(result).toBeUndefined();
    expect(usage.calls()).toBe(1);
    expect(usage.total()).toEqual({ input: 100, output: 50, cached: 0 });
  });

  it('rejects an incomplete truncated hunk as a unit and marks the result partial', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'good.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
        // Header claims 3/3 but only 2/2 body lines exist: a truncated unit.
        { filename: 'truncated.ts', status: 'modified', additions: 0, deletions: 0, patch: '@@ -1,3 +1,3 @@\n context\n-old\n+new' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['good.ts', 'truncated.ts'],
    });
    expect(result).toBeDefined();
    expect(result!.partial).toBe(true);
    const data = dataBlockOf(userMessageOf(llm));
    // Only the complete hunk reached the model; the truncated one was dropped.
    expect(data.evidence.map((e) => e.id)).toEqual(['e0']);
    expect(data.evidence.some((e) => e.patch.includes('context'))).toBe(false);
  });
  it('marks partial for a file whose nonempty patch yields no usable hunk', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'good.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
        // Malformed patch with no '@@' header: splitHunks yields nothing.
        { filename: 'broken.ts', status: 'modified', additions: 1, deletions: 1, patch: 'not a diff at all' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['good.ts', 'broken.ts'],
    });
    expect(result).toBeDefined();
    expect(result!.partial).toBe(true);
    const data = dataBlockOf(userMessageOf(llm));
    // Only the real hunk reached the model; the malformed file is excluded.
    expect(data.evidence.map((e) => e.id)).toEqual(['e0']);
  });

  it('marks partial when complete hunks account for fewer changes than the file reports', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    const ctx = makeCtx({
      changedFiles: [
        // File reports 5/5 but the supplied patch holds only one 1/1 hunk:
        // upstream omitted the remaining whole hunks from the patch.
        { filename: 'omitted.ts', status: 'modified', additions: 5, deletions: 5, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['omitted.ts'],
    });
    expect(result).toBeDefined();
    expect(result!.partial).toBe(true);
  });

  it('rejects a hunk with an invalid body prefix but accepts a no-newline marker', async () => {
    const llm = makeLlm(VALID_RESPONSE);
    // `random` has no diff prefix, so this hunk is malformed.
    const invalid = '@@ -1,2 +1,2 @@\n-a\nrandom\n+b\n';
    // A trailing "\ No newline at end of file" marker is legitimate.
    const withNoNewline = '@@ -1,1 +1,1 @@\n-a\n+b\n\\ No newline at end of file';
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'invalid.ts', status: 'modified', additions: 1, deletions: 1, patch: invalid },
        { filename: 'nonew.ts', status: 'modified', additions: 1, deletions: 1, patch: withNoNewline },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), makeUsage(), {
      scope: 'full',
      reviewedPaths: ['invalid.ts', 'nonew.ts'],
    });
    expect(result).toBeDefined();
    expect(result!.partial).toBe(true);
    const data = dataBlockOf(userMessageOf(llm));
    // Only the no-newline hunk reached the model; the invalid one was dropped.
    expect(data.evidence.map((e) => e.id)).toEqual(['e0']);
    expect(data.evidence.some((e) => e.patch.includes('random'))).toBe(false);
    expect(data.evidence.some((e) => e.patch.includes('No newline'))).toBe(true);
  });

  it('rejects a forged finishReason such as "constructor" and still records spend', async () => {
    const llm = makeLlm(VALID_RESPONSE, 'constructor');
    const usage = makeUsage();
    const ctx = makeCtx({
      changedFiles: [
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
      ],
    });
    const result = await generateChangeDiagram(llm, ctx, makeConfig(true), usage, {
      scope: 'full',
      reviewedPaths: ['a.ts'],
    });
    expect(result).toBeUndefined();
    expect(usage.calls()).toBe(1);
    expect(usage.total()).toEqual({ input: 100, output: 50, cached: 0 });
  });
});
