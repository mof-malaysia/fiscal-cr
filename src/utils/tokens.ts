import pricingCatalogJson from '../config/llm_pricing_code_review.json';

interface PricingEntry {
  input: number;
  output: number;
  cached_input?: number;
  batch_discount?: number;
}

type PricingCatalog = Record<string, Record<string, PricingEntry>>;

const PRICING_CATALOG = pricingCatalogJson as unknown as PricingCatalog;
const DEFAULT_PROVIDER = 'kimi';
const DEFAULT_MODEL = 'kimi-k2.5';

/**
 * Rough token estimation. ~4 chars per token for English,
 * ~2 chars per token for CJK. Good enough for context budget planning.
 */
export function estimateTokens(text: string): number {
  // Count CJK characters
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length;
  const nonCjkLength = text.length - cjkCount;
  return Math.ceil(nonCjkLength / 4 + cjkCount / 2);
}

function getModelCandidates(model?: string): string[] {
  if (!model) return [];

  const trimmed = model.trim().toLowerCase();
  const withoutVariant = trimmed.includes(':') ? trimmed.split(':')[0] : trimmed;
  const withoutVendor = trimmed.includes('/') ? trimmed.split('/').slice(1).join('/') : trimmed;
  const withoutVendorOrVariant = withoutVariant.includes('/')
    ? withoutVariant.split('/').slice(1).join('/')
    : withoutVariant;

  return Array.from(
    new Set([trimmed, withoutVariant, withoutVendor, withoutVendorOrVariant].filter(Boolean)),
  );
}

function findEntryInProvider(provider: string, model?: string): PricingEntry | undefined {
  const entries = PRICING_CATALOG[provider];
  if (!entries) return undefined;

  for (const candidate of getModelCandidates(model)) {
    if (candidate in entries) {
      return entries[candidate];
    }
  }

  return undefined;
}

function findEntryAcrossProviders(model?: string): PricingEntry | undefined {
  if (!model) return undefined;

  for (const provider of Object.keys(PRICING_CATALOG)) {
    if (provider === '_meta') continue;

    const entry = findEntryInProvider(provider, model);
    if (entry) return entry;
  }

  return undefined;
}

function resolvePricingEntry(options?: {
  provider?: string;
  model?: string;
  baseUrl?: string;
}): PricingEntry {
  const defaultEntry = PRICING_CATALOG[DEFAULT_PROVIDER]?.[DEFAULT_MODEL];
  if (!defaultEntry) {
    throw new Error(`Missing default pricing entry for ${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`);
  }

  const provider = options?.provider?.toLowerCase();
  const model = options?.model;
  const baseUrl = options?.baseUrl?.toLowerCase();

  if (baseUrl?.includes('openrouter.ai')) {
    return (
      findEntryInProvider('openrouter', model) ??
      findEntryAcrossProviders(model) ??
      defaultEntry
    );
  }

  if (provider && provider !== 'openai-compatible') {
    return (
      findEntryInProvider(provider, model) ??
      findEntryAcrossProviders(model) ??
      defaultEntry
    );
  }

  return findEntryAcrossProviders(model) ?? defaultEntry;
}

/**
 * Calculate API cost in USD based on token usage.
 */
export function calculateCost(
  usage: {
    input: number;
    output: number;
    cached: number;
  },
  options?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
  },
): number {
  const pricing = resolvePricingEntry(options);
  const inputCost = (usage.input / 1_000_000) * pricing.input;
  const outputCost = (usage.output / 1_000_000) * pricing.output;
  const cachedCost = (usage.cached / 1_000_000) * (pricing.cached_input ?? pricing.input);

  return Math.round((inputCost + outputCost + cachedCost) * 10000) / 10000;
}
