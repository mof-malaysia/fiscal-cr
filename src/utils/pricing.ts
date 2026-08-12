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

export type PricingSource = 'exact' | 'family' | 'fallback';

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
  'gpt-5-mini': { inputPerMillion: 0.25, outputPerMillion: 2, cachedInputPerMillion: 0.025 },
  'gpt-5-nano': { inputPerMillion: 0.05, outputPerMillion: 0.4, cachedInputPerMillion: 0.005 },
  o1: { inputPerMillion: 15, outputPerMillion: 60, cachedInputPerMillion: 7.5 },
  o3: { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
  'o3-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4, cachedInputPerMillion: 0.55 },
  'o4-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4, cachedInputPerMillion: 0.275 },
};

const ANTHROPIC_PRICING: Record<string, TokenPricing> = {
  'claude-opus-4.6': { inputPerMillion: 5, outputPerMillion: 25, cachedInputPerMillion: 0.5 },
  'claude-opus-4.5': { inputPerMillion: 5, outputPerMillion: 25, cachedInputPerMillion: 0.5 },
  'claude-sonnet-4.6': { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
  'claude-sonnet-4.5': { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
  'claude-haiku-4.5': { inputPerMillion: 1, outputPerMillion: 5, cachedInputPerMillion: 0.1 },
  'claude-3.5-sonnet': { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
  'claude-3-5-sonnet': { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
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
  'openai/o3': OPENAI_PRICING.o3,
  'openai/o4-mini': OPENAI_PRICING['o4-mini'],
  'anthropic/claude-opus-4.5': ANTHROPIC_PRICING['claude-opus-4.5'],
  'anthropic/claude-sonnet-4.5': ANTHROPIC_PRICING['claude-sonnet-4.5'],
  'anthropic/claude-haiku-4.5': ANTHROPIC_PRICING['claude-haiku-4.5'],
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
