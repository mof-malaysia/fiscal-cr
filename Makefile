# Local LLM eval harness — runs the real provider/routing/review-pipeline code
# against the deterministic eval case suite using the locally installed tsx
# (no npx, no network fetch).
#
# A root .env (or $ENV_FILE) is loaded via Node --env-file when present, so
# `make eval-llm` needs no manual exports. Node never overwrites variables
# already exported in the shell, so exported env keeps precedence over .env.
# The harness itself never reads, prints, or logs .env values.
#
# Node may print a benign DEP0205 warning about --env-file; it is left as-is
# rather than suppressing all warnings or touching the user's NODE_OPTIONS.
.PHONY: eval-llm eval-llm-dry eval-llm-full eval-llm-full-dry eval-llm-pipeline-dry

ENV_FILE ?= .env

ifneq ($(wildcard $(ENV_FILE)),)
ENV_FILE_FLAG := --env-file=$(ENV_FILE)
else
ENV_FILE_FLAG :=
endif

# Live, default smoke suite: 3 fast-path cases x EVAL_RUNS x 2 variants = 6
# attempts at the default EVAL_RUNS=1 (each attempt is one provider call, so
# 6 calls — fits the default EVAL_MAX_CALLS=20). EVAL_CASES overrides the
# suite; EVAL_RUNS scales rounds per case; EVAL_MAX_CALLS guards the
# provider-call upper bound before any provider is created.
# Requires API_KEY (or FISCALCR_API_KEY / KIMI_API_KEY) in .env or the shell.
# Results land in .eval-results/ (gitignored).
eval-llm:
	./node_modules/.bin/tsx $(ENV_FILE_FLAG) eval/index.ts

# Keyless dry run: prints the plan (selected case ids, rounds, seed, route per
# attempt, attempt count, provider-call upper bound), the budget check
# (exceeding the guard is shown without failing), and suite-level prompt
# char/token stats per variant. No API key sent, no network, zero billable
# calls, no artifact.
eval-llm-dry:
	./node_modules/.bin/tsx $(ENV_FILE_FLAG) eval/index.ts --dry-run

# Live, full suite: 11 cases x EVAL_RUNS x 2 variants = 22 attempts at the
# default EVAL_RUNS=1. 10 fast-path cases cost 1 provider call each and
# pipeline-01 (multi-pass canary) up to 10 (intent + maxGroups 8 + synthesis),
# so the provider-call upper bound is 40. EVAL_MAX_CALLS defaults to 40 for
# the full suite (20 for smoke / focused runs) when the variable is absent —
# an explicit EVAL_MAX_CALLS from the shell or .env always wins and is never
# overridden here, so a lower operator cap is honored. The 11x4 decision run
# upper bound is 160 (EVAL_MAX_CALLS=160).
eval-llm-full:
	EVAL_SUITE=full ./node_modules/.bin/tsx $(ENV_FILE_FLAG) eval/index.ts

# Keyless full-suite dry run (same guard behavior as eval-llm-dry).
eval-llm-full-dry:
	EVAL_SUITE=full ./node_modules/.bin/tsx $(ENV_FILE_FLAG) eval/index.ts --dry-run

# Keyless focused dry run of the pipeline-01 multi-pass canary: prints its
# route (multi-pass), per-attempt provider-call upper bound (10), and prompt
# stats without any key, network, or artifact.
eval-llm-pipeline-dry:
	EVAL_CASES=pipeline-01 ./node_modules/.bin/tsx $(ENV_FILE_FLAG) eval/index.ts --dry-run
