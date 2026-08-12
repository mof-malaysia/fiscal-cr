import { z } from 'zod';

/**
 * Published token prices in USD per million tokens.
 *
 * Local snapshots keep cost reporting available without network access.
 * OpenRouter can supply a fresher snapshot through `resolvePricingAsync`.
 */
export interface PricingTier {
  minPromptTokens: number;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
}

export interface TokenPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
  tiers?: PricingTier[];
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
  'gpt-5.6-terra': { inputPerMillion: 2, outputPerMillion: 12, cachedInputPerMillion: 0.2 },
  'gpt-5.6-luna': { inputPerMillion: 0.2, outputPerMillion: 1.2, cachedInputPerMillion: 0.02 },
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

const KIMI_K27_CODE_PRICING: TokenPricing = {
  inputPerMillion: 0.95,
  outputPerMillion: 4,
  cachedInputPerMillion: 0.19,
};

const KIMI_PRICING: Record<string, TokenPricing> = {
  // Kimi Open Platform pricing; subscription-only IDs such as
  // `kimi-for-coding` are intentionally omitted.
  'kimi-k3': { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
  'kimi-k2.7-code': KIMI_K27_CODE_PRICING,
  'kimi-k2.7-code-highspeed': {
    inputPerMillion: 1.9,
    outputPerMillion: 8,
    cachedInputPerMillion: 0.38,
  },
  'kimi-k2.6': { inputPerMillion: 0.95, outputPerMillion: 4, cachedInputPerMillion: 0.16 },
  // Legacy aliases retained for existing direct-provider configurations.
  'kimi-k2.7': KIMI_K27_CODE_PRICING,
  'kimi-k2-7': KIMI_K27_CODE_PRICING,
};

const PROVIDER_PRICING: Record<string, Record<string, TokenPricing>> = {
  openai: OPENAI_PRICING,
  anthropic: ANTHROPIC_PRICING,
  kimi: KIMI_PRICING,
};

function lookupOpenRouter(model: string): {
  pricing: TokenPricing;
  source: PricingSource;
  matchedModel: string;
} | undefined {
  const [provider, ...modelParts] = normalizedModel(model).split('/');
  const table = PROVIDER_PRICING[provider];
  if (!table || modelParts.length === 0) return undefined;

  const result = lookup(table, modelParts.join('/'));
  return result
    ? { ...result, matchedModel: `${provider}/${result.matchedModel}` }
    : undefined;
}

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
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
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

const pricePerTokenSchema = z.union([
  z.number().finite().nonnegative(),
  z.string()
    .trim()
    .min(1)
    .refine((value) => Number.isFinite(Number(value)) && Number(value) >= 0)
    .transform(Number),
]);

const OPENROUTER_RESPONSE_SCHEMA = z.object({
  data: z.object({
    id: z.string().optional(),
    pricing: z.object({
      prompt: pricePerTokenSchema,
      completion: pricePerTokenSchema,
      input_cache_read: pricePerTokenSchema.optional(),
      overrides: z.array(z.object({
        min_prompt_tokens: z.number().int().positive(),
        prompt: pricePerTokenSchema,
        completion: pricePerTokenSchema,
        input_cache_read: pricePerTokenSchema.optional(),
      }).passthrough()).optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

function parseOpenRouterPricing(payload: unknown): {
  pricing: TokenPricing;
  matchedModel?: string;
} | undefined {
  const parsed = OPENROUTER_RESPONSE_SCHEMA.safeParse(payload);
  if (!parsed.success) return undefined;

  const { pricing } = parsed.data.data;
  const cacheReadPerToken = pricing.input_cache_read ?? pricing.prompt;
  const tiers = pricing.overrides?.map((override) => ({
    minPromptTokens: override.min_prompt_tokens,
    inputPerMillion: override.prompt * 1_000_000,
    outputPerMillion: override.completion * 1_000_000,
    cachedInputPerMillion:
      (override.input_cache_read ?? override.prompt) * 1_000_000,
  }));
  const matchedModel = parsed.data.data.id
    ? normalizedModel(parsed.data.data.id)
    : undefined;
  return {
    pricing: {
      inputPerMillion: pricing.prompt * 1_000_000,
      outputPerMillion: pricing.completion * 1_000_000,
      cachedInputPerMillion: cacheReadPerToken * 1_000_000,
      ...(tiers && tiers.length > 0 ? { tiers } : {}),
    },
    matchedModel,
  };
}

/** Resolve a local pricing snapshot for a provider/model pair. */
export function resolvePricing(context: PricingContext = {}): PricingResolution {
  const provider = context.provider?.trim().toLowerCase();
  const model = context.model?.trim();
  const routerPricing =
    model && (provider === 'openrouter' || isOpenRouter(context.baseUrl))
      ? lookupOpenRouter(model)
      : undefined;
  const providerTable = provider ? PROVIDER_PRICING[provider] : undefined;
  const localPricing =
    routerPricing ?? (model && providerTable ? lookup(providerTable, model) : undefined);

  if (localPricing) return { ...localPricing, provider, model };
  return { pricing: FALLBACK_TOKEN_PRICING, source: 'fallback', provider, model };
}

/**
 * Resolve pricing asynchronously, looking up unknown OpenRouter models and
 * falling back to the local snapshot on failure.
 */
export async function resolvePricingAsync(
  context: PricingContext = {},
): Promise<PricingResolution> {
  const local = resolvePricing(context);
  if (
    local.source !== 'fallback'
    || !context.model
    || !isOpenRouter(context.baseUrl)
  ) return local;

  const endpoint = openRouterModelUrl(context.baseUrl, context.model);
  if (!endpoint) return local;

  const cached = openRouterPricingCache.get(endpoint);
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
      matchedModel: remote.matchedModel ?? normalizedModel(context.model),
    };
    openRouterPricingCache.set(endpoint, {
      expiresAt: Date.now() + OPENROUTER_CACHE_TTL_MS,
      resolution,
    });
    return resolution;
  } catch {
    return local;
  }
}
function pricingForUsage(usage: { input: number }, pricing: TokenPricing): PricingTier | TokenPricing {
  return pricing.tiers?.reduce<PricingTier | undefined>((selected, tier) => {
    if (usage.input < tier.minPromptTokens) return selected;
    return !selected || tier.minPromptTokens > selected.minPromptTokens ? tier : selected;
  }, undefined) ?? pricing;
}

export function calculateCostWithPricing(
  usage: { input: number; output: number; cached: number },
  pricing: TokenPricing,
): number {
  const rates = pricingForUsage(usage, pricing);
  const uncachedInput = Math.max(0, usage.input - usage.cached);
  return (
    (uncachedInput / 1_000_000) * rates.inputPerMillion +
    (usage.cached / 1_000_000) * rates.cachedInputPerMillion +
    (usage.output / 1_000_000) * rates.outputPerMillion
  );
}
