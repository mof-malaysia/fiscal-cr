/**
 * Generates `llms.txt`: a plain-text guide for coding agents setting FiscalCR
 * up in a repository. Inputs, outputs, config defaults and release models are
 * read from their sources (`action.yml`, `DEFAULT_CONFIG`, the schema enums,
 * `PROVIDER_DEFAULT_MODELS`), so only the prose here is hand-written. The
 * version is the latest stable release tag (vX.Y.Z; betas and the floating
 * major tag are skipped).
 *
 *   pnpm llms:sync                          # writes ./llms.txt
 *   pnpm llms:sync --out site/public/llms.txt
 *
 * `test/unit/llms.test.ts` fails when the committed `llms.txt` is out of date.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { PROVIDER_DEFAULT_MODELS, RELEASE_MODEL_PARAMS } from '../src/config/provider-models.js';
import { MODEL_ROLES, PROVIDERS, PROVIDERS_REQUIRING_MODEL } from '../src/config/schema.js';
import { latestRelease, workflowYaml } from './release.js';

export const LLMS_PATH = fileURLToPath(new URL('../llms.txt', import.meta.url));
const ACTION_PATH = fileURLToPath(new URL('../action.yml', import.meta.url));
const REPO = 'mof-malaysia/fiscal-cr';
const SITE = 'https://mof-malaysia.github.io/fiscal-cr';

/** The version a rendered guide was written for, from its title line. */
export function versionOf(guide: string): string | undefined {
  return /^# FiscalCR (v\d+\.\d+\.\d+)/.exec(guide)?.[1];
}

interface ActionField {
  description?: string;
  required?: boolean;
  default?: string;
}
interface ActionMetadata {
  inputs: Record<string, ActionField>;
  outputs: Record<string, ActionField>;
}

export function readAction(): ActionMetadata {
  return parse(readFileSync(ACTION_PATH, 'utf8')) as ActionMetadata;
}

const code = (value: string) => `\`${value}\``;

/** `a`, `a` and `b`, `a`, `b` and `c`. */
const listOf = (values: readonly string[]) => {
  const items = values.map(code);
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
};

function inputLines(action: ActionMetadata): string {
  return Object.entries(action.inputs)
    .map(([name, field]) => {
      const extra = [field.required ? 'required' : undefined, field.default ? `default ${code(field.default)}` : undefined]
        .filter(Boolean)
        .join(', ');
      return `- ${code(name)}${extra ? ` (${extra})` : ''}: ${field.description ?? ''}`;
    })
    .join('\n');
}

function outputLines(action: ActionMetadata): string {
  return Object.entries(action.outputs)
    .map(([name, field]) => `- ${code(name)}: ${field.description ?? ''}`)
    .join('\n');
}

function modelLines(): string {
  const rows = Object.entries(PROVIDER_DEFAULT_MODELS).map(
    ([provider, stages]) => `- ${code(provider)}: ${MODEL_ROLES.map((role) => `${role} ${code(stages[role])}`).join(', ')}`,
  );
  const params = Object.entries(RELEASE_MODEL_PARAMS).map(
    ([model, fields]) => `${code(model)} is sent ${Object.entries(fields).map(([k, v]) => code(`${k}: ${v}`)).join(', ')}`,
  );
  return [...rows, ...(params.length ? ['', `Release-tuned request params: ${params.join('; ')}.`] : [])].join('\n');
}

export function renderLlmsTxt(version: string, action: ActionMetadata = readAction()): string {
  const uses = `${REPO}@${version}`;
  const needModel = listOf(PROVIDERS_REQUIRING_MODEL);
  const withModels = listOf(Object.keys(PROVIDER_DEFAULT_MODELS));
  return `# FiscalCR ${version}

> FiscalCR is open-source AI code review for GitHub pull requests. It runs as a GitHub Action in the repository's own CI (or as a self-hosted GitHub App), sends the pull request to the LLM provider the team configures, and posts a check run, one summary comment and inline findings on the changed lines. Fixed findings are replied to and their threads resolved. FiscalCR has no backend of its own. This guide is for coding agents adding or configuring FiscalCR in a repository; it is generated from FiscalCR's own sources for ${version}.

Source: https://github.com/${REPO}
README (full reference): https://github.com/${REPO}#readme
Website: ${SITE}
Changing FiscalCR itself: read AGENTS.md in the repository, not this file.

## Add FiscalCR to a repository

1. Add an Actions secret named \`LLM_API_KEY\` holding the provider's API key (repository Settings → Secrets and variables → Actions). Never write the key into a workflow or config file. On Anthropic, you can skip the secret and use keyless OIDC instead (below).
2. Commit this workflow as \`.github/workflows/fiscalcr-review.yml\`:

\`\`\`yaml
${workflowYaml(version)}\`\`\`

3. Optionally add \`.fiscalcr-review.yml\` at the repository root (see Configuration). Without it, built-in defaults apply.
4. Open a pull request. FiscalCR reviews it on open, on every push, when it is marked ready for review and when review is requested. Drafts are skipped by default.

Keep the \`permissions\` and \`concurrency\` blocks as shown. Pin the action to a release tag (\`${uses}\`); \`@main\` is unreleased code.

## Choosing a provider

Providers: ${PROVIDERS.map(code).join(', ')}.

- ${withModels} use the models pinned to this release (below) when \`model\` is not set. Prefer that: the prompts were tuned against them.
- ${needModel} have no release models and require \`model\`.
- ${code('openai-compatible')} also requires \`base_url\` (the provider's \`/v1\` URL). ${code('openrouter')} defaults to \`https://openrouter.ai/api/v1\` and takes OpenRouter model IDs such as \`anthropic/claude-sonnet-5.5\`.
- ${code('anthropic')} uses the native Messages API and defaults to \`https://api.anthropic.com/v1\`.

Models pinned to ${version}, per pipeline stage:

${modelLines()}

To override, set \`model\` (every stage) or \`models.<stage>\` (one stage) in the Action inputs or the config file. Resolution order: \`models.<stage>\`, then \`model\`, then the release model.

### Keyless Anthropic (GitHub OIDC)

With \`provider: anthropic\`, set the four federation inputs instead of \`api_key\` and add \`id-token: write\` to \`permissions\`:

\`\`\`yaml
      - uses: ${uses}
        with:
          provider: anthropic
          anthropic_federation_rule_id: \${{ vars.ANTHROPIC_FEDERATION_RULE_ID }}
          anthropic_organization_id: \${{ vars.ANTHROPIC_ORGANIZATION_ID }}
          anthropic_service_account_id: \${{ vars.ANTHROPIC_SERVICE_ACCOUNT_ID }}
          anthropic_workspace_id: \${{ vars.ANTHROPIC_WORKSPACE_ID }}
\`\`\`

The IDs are Actions variables, not secrets. The federation rule is created in the Claude Console (Settings → Workload identity); see the README. Set either \`api_key\` or the federation inputs, never both. Pull requests from forks get no OIDC token.

## Action inputs

${inputLines(action)}

Inputs override the config file. \`visualize\` maps to \`review.visualize.enabled\` and \`comments\` to \`review.comments.mode\`.

## Action outputs

${outputLines(action)}

## Configuration (.fiscalcr-review.yml)

Every key is optional. An invalid file fails the run instead of being ignored. These are the built-in defaults:

\`\`\`yaml
${stringify(DEFAULT_CONFIG, { lineWidth: 0 }).trimEnd()}
\`\`\`

Keys with no default:

- \`model\`, \`models.<stage>\` (stages: ${MODEL_ROLES.map(code).join(', ')}): model overrides, as above.
- \`baseUrl\`: provider base URL.
- \`userAgent\`: custom User-Agent for endpoints that whitelist clients. Some providers treat changing it as a terms violation.
- \`temperature\`: 0 to 2. Unset uses 0.3, except models that only accept their server default (FiscalCR omits it for those).
- \`modelParams\`: provider-native fields merged into each call, e.g. \`reasoning_effort: medium\`.
- \`promptCache\`: \`1h\`, \`5m\` or \`off\`; unset uses the provider's default.
- \`rules[]\`: \`{ name, description, severity (critical | warning | suggestion, default warning), filePattern? }\`.
- \`prompt.systemAppend\` (up to 2000 characters) and \`prompt.reviewFocus\` (up to 500).
- \`pipeline.callTimeoutMs\` and \`pipeline.maxOutputTokens\`: unset resolves per model.

Values: \`language\` is en, zh-TW, zh-CN, ja or ko. \`review.minSeverity\` is critical, warning, suggestion or nitpick. \`review.failOn\` is critical, warning or never. \`review.comments.mode\` is sticky (one updated summary, incremental reviews) or legacy (a full review per run).

## Rules an agent must respect

- \`provider\` and \`base_url\` are read from the pull request's base branch, not its head. A pull request cannot redirect the API key by editing the config. Changes to routing take effect after they merge.
- Other config comes from the PR head and applies to that PR's own review.
- Never put an API key in \`.fiscalcr-review.yml\` or a workflow file; use a secret or OIDC.
- Pull requests from forks get read-only tokens: FiscalCR cannot post reviews on them.
- Thread cleanup needs \`pull-requests: write\`.

## Recipes

Security and bugs only, fail the check on warnings:

\`\`\`yaml
review:
  aspects: { bugs: true, security: true, performance: false, style: false, bestPractices: false }
  minSeverity: warning
  failOn: warning
\`\`\`

A team rule:

\`\`\`yaml
rules:
  - name: no-console-log
    description: "No console.log in production code"
    severity: warning
    filePattern: "src/**/*.ts"
\`\`\`

OpenRouter:

\`\`\`yaml
      - uses: ${uses}
        with:
          api_key: \${{ secrets.LLM_API_KEY }}
          provider: openrouter
          model: anthropic/claude-sonnet-5.5
\`\`\`

A self-hosted or other OpenAI-compatible endpoint:

\`\`\`yaml
      - uses: ${uses}
        with:
          api_key: \${{ secrets.LLM_API_KEY }}
          provider: openai-compatible
          base_url: https://llm.example.internal/v1
          model: your-model-name
\`\`\`

## Self-hosted GitHub App

For comment commands, run FiscalCR as a GitHub App on your own server (clone the repository, \`pnpm install\`, \`pnpm dev\`). Environment: \`API_KEY\` (or \`FISCALCR_API_KEY\`), \`GITHUB_APP_ID\`, \`GITHUB_PRIVATE_KEY\`, \`GITHUB_WEBHOOK_SECRET\`, and optionally \`MODEL_PROVIDER\`, \`MODEL\`, \`BASE_URL\`, \`LLM_USER_AGENT\`, \`PORT\` (3000), \`LOG_LEVEL\`. Comment \`@fiscalcr review\` on a pull request for a full review, or \`@fiscalcr help\`.

## Severity levels

- \`critical\`: must fix before merge (bugs, security issues, data loss risk)
- \`warning\`: should fix (performance issues, risky practices)
- \`suggestion\`: nice to have (readability, maintainability)
- \`nitpick\`: optional; posted as check-run annotations, not inline comments
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex > -1 ? process.argv[outIndex + 1] : LLMS_PATH;
  if (!out) throw new Error('--out needs a path');
  const version = latestRelease();
  writeFileSync(out, renderLlmsTxt(version));
  console.log(`Wrote ${out} for ${version}`);
}
