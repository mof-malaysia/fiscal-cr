import * as core from "@actions/core";
import * as github from "@actions/github";
import { ReviewOrchestrator } from "../src/review/orchestrator.js";
import { createActionOctokit } from "./github-client.js";
import { mergeActionConfig } from "./config.js";
import { createLLMProvider } from "../src/providers/factory.js";
import { loadConfig } from "../src/config/loader.js";
import { modelForRole } from "../src/config/schema.js";
import { applyModelOverride, applyProviderOverride } from "../src/config/overrides.js";
import { calculateCostForModel } from "../src/utils/tokens.js";
import { telemetryFromActionInput } from "./telemetry.js";
import { experimentalFromActionInput } from "./experimental.js";
import { modelParamsFromActionInput } from "./model-params.js";
import { renderDiagramSection } from "../src/review/diagram-renderer.js";
/**
 * Conservative UTF-8 budget for the complete Action job summary body. The
 * optional change-diagram section is omitted if it would push the body past
 * this limit, preserving the baseline conclusion and findings.
 */
const JOB_SUMMARY_BUDGET_BYTES = 1024 * 1024;

async function run(): Promise<void> {
  try {
    // Get inputs
    const apiKey = core.getInput("api_key");
    if (!apiKey) {
      throw new Error("Missing required input: api_key");
    }

    const githubToken = core.getInput("github_token");
    const providerInput = core.getInput("provider") || undefined;
    const modelInput = core.getInput("model") || undefined;
    const baseUrlInput = core.getInput("base_url") || undefined;
    const userAgentInput = core.getInput("user_agent") || undefined;
    const languageInput = core.getInput("language") || undefined;
    const experimentalInput = experimentalFromActionInput(core);
    const modelParamsInput = modelParamsFromActionInput(core);
    const configPath = core.getInput("config_path") || ".fiscalcr-review.yml";
    const failOnInput = (core.getInput("fail_on") || undefined) as
      | "critical"
      | "warning"
      | "never";

    const octokit = github.getOctokit(githubToken);
    const context = github.context;

    // Only run on pull requests
    if (!context.payload.pull_request) {
      core.info("Not a pull request event, skipping.");
      return;
    }

    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const pullNumber = context.payload.pull_request.number;
    const headSha = context.payload.pull_request.head.sha;
    const eventAction = context.payload.action ?? "";
    const isDraft = Boolean(context.payload.pull_request.draft);

    core.info(`Reviewing PR #${pullNumber} (${headSha.slice(0, 7)}, event: ${eventAction})`);

    // Keep the Action client's REST namespace and GraphQL method together.
    const fiscalcrOctokit = createActionOctokit(octokit);

    // Load review policy from the PR head, but keep network routing pinned to
    // the trusted base revision so PR config cannot exfiltrate the API key.
    const headConfig = await loadConfig(fiscalcrOctokit, owner, repo, configPath, headSha);
    const trustedConfig = await loadConfig(
      fiscalcrOctokit,
      owner,
      repo,
      configPath,
      context.payload.pull_request.base.sha,
    );
    const config = mergeActionConfig(headConfig, trustedConfig);
    if (languageInput) {
      config.language = languageInput as typeof config.language;
    }
    if (failOnInput) {
      config.review.failOn = failOnInput;
    }
    applyProviderOverride(config, providerInput);
    applyModelOverride(config, modelInput);
    if (baseUrlInput) {
      config.baseUrl = baseUrlInput;
    }
    if (userAgentInput) {
      config.userAgent = userAgentInput;
    }
    if (experimentalInput !== undefined) {
      config.experimental = experimentalInput;
    }
    if (modelParamsInput !== undefined) {
      config.modelParams = modelParamsInput;
    }

    // Honor auto-review settings (previously App-mode only)
    if (isDraft && !config.review.auto.drafts) {
      core.info("Skipping draft PR (review.auto.drafts is false).");
      return;
    }
    if (eventAction === "synchronize" && !config.review.auto.onPush) {
      core.info("Skipping push event (review.auto.onPush is false).");
      return;
    }
    if (
      ["opened", "reopened", "ready_for_review"].includes(eventAction) &&
      !config.review.auto.onOpen
    ) {
      core.info(`Skipping ${eventAction} event (review.auto.onOpen is false).`);
      return;
    }

    // Create model provider
    const llm = createLLMProvider({
      apiKey,
      provider: providerInput || config.provider,
      model: modelForRole(config, "groupReview"),
      baseUrl: config.baseUrl,
      userAgent: config.userAgent,
      modelParams: config.modelParams,
    });

    // Run review
    const telemetry = telemetryFromActionInput(core);
    const orchestrator = new ReviewOrchestrator(
      fiscalcrOctokit,
      llm,
      config,
      {
        // The workflow job is the user-facing check in Action mode; the
        // orchestrator's check run is reserved for App mode.
        createCheckRun: false,
        workspaceRoot: process.env.GITHUB_WORKSPACE || process.cwd(),
        telemetry,
        pricingContext: {
          provider: providerInput || config.provider,
          model: modelForRole(config, "groupReview"),
          baseUrl: config.baseUrl,
        },
      },
    );
    const result = await orchestrator.reviewPullRequest({
      owner,
      repo,
      pullNumber,
      headSha,
    });
    telemetry?.({
      type: "review_completed",
      calls: result.callCount ?? 0,
      inputTokens: result.tokensUsed.input,
      outputTokens: result.tokensUsed.output,
      cachedTokens: result.tokensUsed.cached,
      estimatedCostUsd: result.costEstimate?.usd ?? 0,
      pricingSource: result.costEstimate?.source ?? "fallback",
      annotations: result.annotations.length,
    });

    // Set outputs
    core.setOutput("review_summary", result.summary);
    core.setOutput("annotations_count", result.annotations.length.toString());
    core.setOutput(
      "critical_count",
      result.stats.critical.toString(),
    );
    core.setOutput(
      "tokens_used",
      (result.tokensUsed.input + result.tokensUsed.output).toString(),
    );
    core.setOutput(
      "cost_estimate",
      (result.costEstimate?.usd ?? calculateCostForModel(result.tokensUsed, {
        provider: config.provider,
        model: modelForRole(config, "groupReview"),
        baseUrl: config.baseUrl,
      })).toFixed(4),
    );

    // Summary in job output
    core.summary
      .addHeading("FiscalCR Code Review", 2)
      .addRaw(`**Score:** ${result.score}/100\n\n`)
      .addRaw(result.summary)
      .addTable([
        [
          { data: "Severity", header: true },
          { data: "Count", header: true },
        ],
        ["Critical", result.stats.critical.toString()],
        ["Warning", result.stats.warning.toString()],
        ["Suggestion", result.stats.suggestion.toString()],
      ]);

    // Optional change-diagram section. Text-only (no Mermaid fences): GitHub
    // renders Mermaid only in PR/issues/Markdown, not in check/Action job
    // summaries. Rendering failure is isolated so it never breaks the baseline
    // job summary. The bounded diagram is still guarded against the 1 MiB
    // job-summary budget using the current raw buffer length.
    if (result.diagram) {
      try {
        const diagramSection = renderDiagramSection(result.diagram, 'text');
        const fits =
          Buffer.byteLength(
            `${core.summary.stringify()}\n\n${diagramSection}${process.platform === "win32" ? "\r\n" : "\n"}`,
            "utf8",
          ) <= JOB_SUMMARY_BUDGET_BYTES;
        if (fits) {
          core.summary.addRaw(`\n\n${diagramSection}`);
        }
      } catch {
        // Keep the baseline job summary intact on any diagram rendering error.
      }
    }

    await core.summary.write();

    // Fail the action if needed
    if (config.review.failOn === "critical" && result.stats.critical > 0) {
      core.setFailed(`Found ${result.stats.critical} critical issue(s)`);
    } else if (
      config.review.failOn === "warning" &&
      (result.stats.critical > 0 || result.stats.warning > 0)
    ) {
      core.setFailed(
        `Found ${result.stats.critical} critical and ${result.stats.warning} warning issue(s)`,
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`FiscalCR Review failed: ${error.message}`);
    } else {
      core.setFailed("FiscalCR Review failed with unknown error");
    }
  }
}

run();
