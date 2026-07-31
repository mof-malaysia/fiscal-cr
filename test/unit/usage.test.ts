import { describe, expect, it, vi } from 'vitest';
import { UsageTracker, type TelemetryEvent } from '../../src/pipeline/usage.js';

describe('UsageTracker telemetry', () => {
  it('aggregates usage without telemetry', () => {
    const tracker = new UsageTracker();

    tracker.startCall();
    tracker.add({ input: 100, output: 20, cached: 10 });
    tracker.startCall();
    tracker.add({ input: 50, output: 5, cached: 0 });

    expect(tracker.total()).toEqual({ input: 150, output: 25, cached: 10 });
    expect(tracker.calls()).toBe(2);
  });

  it('emits safe call metrics without message content', () => {
    const events: TelemetryEvent[] = [];
    const sink = vi.fn((event: TelemetryEvent) => events.push(event));
    const tracker = new UsageTracker(sink);

    tracker.startCall();
    tracker.add(
      { input: 100, output: 20, cached: 10 },
      {
        stage: 'group-review',
        messages: [
          { role: 'system', content: 'secret system prompt' },
          { role: 'user', content: 'private source code' },
        ],
        maxOutputTokens: 4_096,
        durationMs: 12,
        groupIndex: 1,
        fileCount: 3,
        finishReason: 'stop',
      },
    );

    expect(sink).toHaveBeenCalledOnce();
    expect(events[0]).toMatchObject({
      type: 'llm_call',
      stage: 'group-review',
      groupIndex: 1,
      fileCount: 3,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 10,
      maxOutputTokens: 4_096,
      durationMs: 12,
      finishReason: 'stop',
    });
    expect(events[0]).toHaveProperty('estimatedInputTokens');
    expect(JSON.stringify(events[0])).not.toContain('secret system prompt');
    expect(JSON.stringify(events[0])).not.toContain('private source code');
  });

  it('ignores telemetry sink failures', () => {
    const tracker = new UsageTracker(() => {
      throw new Error('telemetry unavailable');
    });

    expect(() =>
      tracker.add(
        { input: 1, output: 2, cached: 0 },
        {
          stage: 'intent',
          messages: [{ role: 'user', content: 'content' }],
          maxOutputTokens: 100,
          durationMs: 1,
        },
      ),
    ).not.toThrow();
    expect(tracker.total()).toEqual({ input: 1, output: 2, cached: 0 });
  });

  it('maps untrusted finish reasons to a safe value', () => {
    const events: TelemetryEvent[] = [];
    const tracker = new UsageTracker((event) => {
      events.push(event);
    });

    tracker.startCall();
    tracker.add(
      { input: 1, output: 2, cached: 0 },
      {
        stage: 'intent',
        messages: [{ role: 'user', content: 'content' }],
        maxOutputTokens: 100,
        durationMs: 1,
        finishReason: 'provider-private-detail',
      },
    );

    expect(events[0]).toMatchObject({ finishReason: 'other' });
    expect(JSON.stringify(events[0])).not.toContain('provider-private-detail');
  });

  it('counts attempts before a response is available', () => {
    const tracker = new UsageTracker();

    tracker.startCall();

    expect(tracker.calls()).toBe(1);
    expect(tracker.total()).toEqual({ input: 0, output: 0, cached: 0 });
  });

  it('ignores asynchronous telemetry sink failures', async () => {
    const tracker = new UsageTracker(async () => {
      throw new Error('telemetry unavailable');
    });

    expect(() =>
      tracker.emit({ type: 'stage_result', stage: 'intent', status: 'failed' }),
    ).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});
