import * as core from "@actions/core";
import * as github from "@actions/github";
import { ReviewOrchestrator } from "../src/review/orchestrator.js";
import { createLLMProvider } from "../src/providers/factory.js";
import { loadConfig } from "../src/config/loader.js";
import { calculateCost } from "../src/utils/tokens.js";

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

    // @actions/github getOctokit puts REST methods under .rest,
    // but our code expects @octokit/rest shape (octokit.checks, octokit.pulls, etc.)
    const restOctokit = octokit.rest;

    // Load config from repo
    const config = await loadConfig(restOctokit as any, owner, repo, configPath);
    if (languageInput) {
      config.language = languageInput as typeof config.language;
    }
    if (failOnInput) {
      config.review.failOn = failOnInput;
    }
    if (modelInput) {
      config.model = modelInput;
    }
    if (baseUrlInput) {
      config.baseUrl = baseUrlInput;
    }
    if (userAgentInput) {
      config.userAgent = userAgentInput;
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
      model: config.model,
      baseUrl: config.baseUrl,
      userAgent: config.userAgent,
    });

    // Run review
    const orchestrator = new ReviewOrchestrator(
      restOctokit as any,
      llm,
      config,
      { workspaceRoot: process.env.GITHUB_WORKSPACE || process.cwd() },
    );
    const result = await orchestrator.reviewPullRequest({
      owner,
      repo,
      pullNumber,
      headSha,
    });

    // Set outputs
    core.setOutput("review_summary", result.summary);
    core.setOutput("annotations_count", result.annotations.length.toString());
    core.setOutput("critical_count", result.stats.critical.toString());
    core.setOutput(
      "tokens_used",
      (result.tokensUsed.input + result.tokensUsed.output).toString(),
    );
    core.setOutput(
      "cost_estimate",
      calculateCost(result.tokensUsed).toString(),
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
