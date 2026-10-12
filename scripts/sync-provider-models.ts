/**
 * Regenerates the README release-model table from `PROVIDER_DEFAULT_MODELS`
 * so the map in `src/config/provider-models.ts` stays the only hand-edited
 * source. Run via `pnpm models:sync` after changing release defaults.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL_ROLES } from '../src/config/schema.js';
import { PROVIDER_DEFAULT_MODELS, RELEASE_MODEL_PARAMS } from '../src/config/provider-models.js';

export const README_PATH = fileURLToPath(new URL('../README.md', import.meta.url));
const START = '<!-- provider-models:start -->';
const END = '<!-- provider-models:end -->';

export function renderProviderModelsTable(): string {
  const header = `| Provider | ${MODEL_ROLES.join(' | ')} |`;
  const divider = `| --- | ${MODEL_ROLES.map(() => '---').join(' | ')} |`;
  const rows = Object.entries(PROVIDER_DEFAULT_MODELS).map(
    ([provider, stages]) =>
      `| \`${provider}\` | ${MODEL_ROLES.map((role) => `\`${stages[role]}\``).join(' | ')} |`,
  );
  const params = Object.entries(RELEASE_MODEL_PARAMS).map(
    ([model, fields]) =>
      `\`${model}\`: ${Object.entries(fields).map(([k, v]) => `\`${k}: ${v}\``).join(', ')}`,
  );
  const paramsLine = params.length > 0 ? ['', `Release-tuned request params: ${params.join('; ')}.`] : [];
  return [header, divider, ...rows, ...paramsLine].join('\n');
}

/** Replace the marked README section with the rendered table. */
export function syncReadme(readme: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end < start) {
    throw new Error(`README is missing the ${START} / ${END} markers`);
  }
  return `${readme.slice(0, start + START.length)}\n${renderProviderModelsTable()}\n${readme.slice(end)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const current = readFileSync(README_PATH, 'utf8');
  const next = syncReadme(current);
  if (next !== current) writeFileSync(README_PATH, next);
  console.log(next === current ? 'README model table already up to date' : 'README model table updated');
}
