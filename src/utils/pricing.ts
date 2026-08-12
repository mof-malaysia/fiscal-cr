import { z } from 'zod';

/**
 * Published token prices in USD per million tokens.
 *
 * Pricing is intentionally a local snapshot: reviews must not depend on a
 * pricing endpoint being available. Update this map when vendors change rates.
 */
export interface TokenPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
}

export type PricingSource = 'exact' | 'family' | 'remote' | 'fallback';

export interface PricingContext {
  provider?: string;
  model?: string;
  baseUrl?: string;
}

export interface PricingResolution {
  pricing: TokenPricing;
  source: PricingSource;
  provider?: string;
  model?: string;
  matchedModel?: string;
}

/** Previous FiscalCR estimate, retained for unknown/custom endpoints. */
export const FALLBACK_TOKEN_PRICING: TokenPricing = {
  inputPerMillion: 0.39,
  outputPerMillion: 1.9,
  cachedInputPerMillion: 0.1,
};

const OPENAI_PRICING: Record<string, TokenPricing> = {
  'gpt-4.1': { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
  'gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6, cachedInputPerMillion: 0.1 },
  'gpt-4.1-nano': { inputPerMillion: 0.1, outputPerMillion: 0.4, cachedInputPerMillion: 0.025 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10, cachedInputPerMillion: 1.25 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.075 },
  'gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10, cachedInputPerMillion: 0.125 },
  'gpt-5.6': { inputPerMillion: 5, outputPerMillion: 30, cachedInputPerMillion: 0.5 },
  'gpt-5.6-sol': { inputPerMillion: 5, outputPerMillion: 30, cachedInputPerMillion: 0.5 },
  'gpt-5.6-terra': { inputPerMillion: 1, outputPerMillion: 6, cachedInputPerMillion: 0.1 },
  'gpt-5.6-luna': { inputPerMillion: 0.1, outputPerMillion: 0.6, cachedInputPerMillion: 0.01 },
  'gpt-5-mini': { inputPerMillion: 0.25, outputPerMillion: 2, cachedInputPerMillion: 0.025 },
  o1: { inputPerMillion: 15, outputPerMillion: 60, cachedInputPerMillion: 7.5 },
  o3: { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
  'o3-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4, cachedInputPerMillion: 0.55 },
  'o4-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4, cachedInputPerMillion: 0.275 },
};

const ANTHROPIC_PRICING: Record<string, TokenPricing> = {
  'claude-opus-4.6': { inputPerMillion: 5, outputPerMillion: 25, cachedInputPerMillion: 0.5 },
  'claude-opus-4.5': { inputPerMillion: 5, outputPerMillion: 25, cachedInputPerMillion: 0.5 },
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25, cachedInputPerMillion: 0.5 },
  'claude-sonnet-4.6': { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
  'claude-sonnet-4.5': { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
  'claude-sonnet-5': { inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 0.2 },
  'claude-haiku-4.5': { inputPerMillion: 1, outputPerMillion: 5, cachedInputPerMillion: 0.1 },
  'claude-3.5-sonnet': { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
  'claude-3-5-sonnet': { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
  'claude-fable-5': { inputPerMillion: 10, outputPerMillion: 50, cachedInputPerMillion: 1 },
};

const KIMI_PRICING: Record<string, TokenPricing> = {
  // Kimi Open Platform K2.7. Kimi Code subscription models intentionally do
  // not appear here because they do not publish a fixed token rate.
  'kimi-k2.7': { inputPerMillion: 0.95, outputPerMillion: 4, cachedInputPerMillion: 0.19 },
  'kimi-k2-7': { inputPerMillion: 0.95, outputPerMillion: 4, cachedInputPerMillion: 0.19 },
};

/**
 * OpenRouter prices are maintained separately because routing/markup can make
 * them differ from the upstream vendor's direct API price.
 */
const OPENROUTER_PRICING: Record<string, TokenPricing> = {
  'openai/gpt-4.1': OPENAI_PRICING['gpt-4.1'],
  'openai/gpt-4.1-mini': OPENAI_PRICING['gpt-4.1-mini'],
  'openai/gpt-4.1-nano': OPENAI_PRICING['gpt-4.1-nano'],
  'openai/gpt-4o': OPENAI_PRICING['gpt-4o'],
  'openai/gpt-4o-mini': OPENAI_PRICING['gpt-4o-mini'],
  'openai/gpt-5': OPENAI_PRICING['gpt-5'],
  'openai/gpt-5-mini': OPENAI_PRICING['gpt-5-mini'],
  'openai/gpt-5.6': OPENAI_PRICING['gpt-5.6'],
  'openai/gpt-5.6-sol': OPENAI_PRICING['gpt-5.6-sol'],
  'openai/gpt-5.6-terra': OPENAI_PRICING['gpt-5.6-terra'],
  'openai/gpt-5.6-luna': OPENAI_PRICING['gpt-5.6-luna'],
  'openai/o3': OPENAI_PRICING.o3,
  'openai/o4-mini': OPENAI_PRICING['o4-mini'],
  'anthropic/claude-opus-4.5': ANTHROPIC_PRICING['claude-opus-4.5'],
  'anthropic/claude-opus-5': ANTHROPIC_PRICING['claude-opus-5'],
  'anthropic/claude-sonnet-4.5': ANTHROPIC_PRICING['claude-sonnet-4.5'],
  'anthropic/claude-sonnet-5': ANTHROPIC_PRICING['claude-sonnet-5'],
  'anthropic/claude-haiku-4.5': ANTHROPIC_PRICING['claude-haiku-4.5'],
  'anthropic/claude-fable-5': ANTHROPIC_PRICING['claude-fable-5'],
};

function normalizedModel(model: string): string {
  return model.trim().toLowerCase().replace(/:free$|:thinking$|:online$/, '');
}

function lookup(
  table: Record<string, TokenPricing>,
  model: string,
): { pricing: TokenPricing; source: PricingSource; matchedModel: string } | undefined {
  const normalized = normalizedModel(model);
  const exact = table[normalized];
  if (exact) return { pricing: exact, source: 'exact', matchedModel: normalized };

  const family = Object.keys(table)
    .filter((key) => normalized.startsWith(`${key}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (!family) return undefined;
  return { pricing: table[family], source: 'family', matchedModel: family };
}

function isOpenRouter(baseUrl: string | undefined): boolean {
  return Boolean(baseUrl && /(^|[/.])openrouter\.ai(?:\/|$)/i.test(baseUrl));
}

const OPENROUTER_CACHE_TTL_MS = 60 * 60 * 1000;
const openRouterPricingCache = new Map<
  string,
  { expiresAt: number; resolution: PricingResolution }
>();

function openRouterModelUrl(baseUrl: string | undefined, model: string): string | undefined {
  if (!baseUrl || !isOpenRouter(baseUrl)) return undefined;
  const modelParts = normalizedModel(model).split('/');
  if (modelParts.length !== 2 || modelParts.some((part) => part.length === 0)) {
    return undefined;
  }

  try {
    const origin = new URL(baseUrl).origin;
    return `${origin}/api/v1/model/${modelParts.map(encodeURIComponent).join('/')}`;
  } catch {
    return undefined;
  }
}

const OPENROUTER_RESPONSE_SCHEMA = z.object({
  data: z.object({
    id: z.string().optional(),
    pricing: z.object({
      prompt: z.coerce.number().finite().nonnegative(),
      completion: z.coerce.number().finite().nonnegative(),
      input_cache_read: z.coerce.number().finite().nonnegative().optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

function parseOpenRouterPricing(payload: unknown): {
  pricing: TokenPricing;
  matchedModel?: string;
} | undefined {
  const parsed = OPENROUTER_RESPONSE_SCHEMA.safeParse(payload);
  if (!parsed.success) return undefined;

  const matchedModel = parsed.data.data.id
    ? normalizedModel(parsed.data.data.id)
    : undefined;
  return {
    pricing: {
      inputPerMillion: parsed.data.data.pricing.prompt * 1_000_000,
      outputPerMillion: parsed.data.data.pricing.completion * 1_000_000,
      cachedInputPerMillion: (parsed.data.data.pricing.input_cache_read ?? 0) * 1_000_000,
    },
    matchedModel,
  };
}

/** Resolve a local pricing snapshot for a provider/model pair. */
export function resolvePricing(context: PricingContext = {}): PricingResolution {
  const provider = context.provider?.trim().toLowerCase();
  const model = context.model?.trim();
  const tableAndModel =
    model && (provider === 'openrouter' || isOpenRouter(context.baseUrl))
      ? lookup(OPENROUTER_PRICING, model)
      : model && provider === 'openai'
        ? lookup(OPENAI_PRICING, model)
        : model && provider === 'anthropic'
          ? lookup(ANTHROPIC_PRICING, model)
          : model && provider === 'kimi'
            ? lookup(KIMI_PRICING, model)
            : undefined;

  if (tableAndModel) {
    return { ...tableAndModel, provider, model };
  }

  return {
    pricing: FALLBACK_TOKEN_PRICING,
    source: 'fallback',
    provider,
    model,
  };
}

/**
 * Resolve pricing asynchronously, consulting OpenRouter only for an unknown
 * model. The remote result is cached briefly so a review does not repeatedly
 * pay the metadata lookup latency.
 */
export async function resolvePricingAsync(
  context: PricingContext = {},
): Promise<PricingResolution> {
  const local = resolvePricing(context);
  if (local.source !== 'fallback' || !context.model) return local;

  const endpoint = openRouterModelUrl(context.baseUrl, context.model);
  if (!endpoint) return local;

  const cacheKey = normalizedModel(context.model);
  const cached = openRouterPricingCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.resolution;

  try {
    const response = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return local;

    const remote = parseOpenRouterPricing(await response.json());
    if (!remote) return local;

    const resolution: PricingResolution = {
      pricing: remote.pricing,
      source: 'remote',
      provider: context.provider?.trim().toLowerCase(),
      model: context.model.trim(),
      matchedModel: remote.matchedModel ?? cacheKey,
    };
    openRouterPricingCache.set(cacheKey, {
      expiresAt: Date.now() + OPENROUTER_CACHE_TTL_MS,
      resolution,
    });
    return resolution;
  } catch {
    return local;
  }
}

export function calculateCostWithPricing(
  usage: { input: number; output: number; cached: number },
  pricing: TokenPricing,
): number {
  const uncachedInput = Math.max(0, usage.input - usage.cached);
  return (
    (uncachedInput / 1_000_000) * pricing.inputPerMillion +
    (usage.cached / 1_000_000) * pricing.cachedInputPerMillion +
    (usage.output / 1_000_000) * pricing.outputPerMillion
  );
}
