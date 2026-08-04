# Local LLM eval harness — runs the real provider/fast-path/usage code against a
# synthetic PR using the locally installed tsx (no npx, no network fetch).
#
# A root .env (or $ENV_FILE) is loaded via Node --env-file when present, so
# `make eval-llm` needs no manual exports. Node never overwrites variables
# already exported in the shell, so exported env keeps precedence over .env.
# The harness itself never reads, prints, or logs .env values.
.PHONY: eval-llm eval-llm-dry

ENV_FILE ?= .env

ifneq ($(wildcard $(ENV_FILE)),)
ENV_FILE_FLAG := --env-file=$(ENV_FILE)
else
ENV_FILE_FLAG :=
endif

# Live: 2 * EVAL_RUNS billable LLM calls (EVAL_RUNS default 1, 1..10) as
# alternating A/B pairs (baseline→experimental, then experimental→baseline).
# Requires API_KEY (or FISCALCR_API_KEY / KIMI_API_KEY) in .env or the shell.
# Results land in .eval-results/ (gitignored).
eval-llm:
	./node_modules/.bin/tsx $(ENV_FILE_FLAG) scripts/eval-llm.ts

# Keyless dry run: builds both system/user prompts, prints sizes and estimated
# tokens. No API key sent, no network, zero billable calls.
eval-llm-dry:
	./node_modules/.bin/tsx $(ENV_FILE_FLAG) scripts/eval-llm.ts --dry-run
