# Local LLM eval harness — runs the real provider/fast-path/usage code against
# the deterministic eval case suite using the locally installed tsx (no npx, no
# network fetch).
#
# A root .env (or $ENV_FILE) is loaded via Node --env-file when present, so
# `make eval-llm` needs no manual exports. Node never overwrites variables
# already exported in the shell, so exported env keeps precedence over .env.
# The harness itself never reads, prints, or logs .env values.
#
# Node may print a benign DEP0205 warning about --env-file; it is left as-is
# rather than suppressing all warnings or touching the user's NODE_OPTIONS.
.PHONY: eval-llm eval-llm-dry eval-llm-full eval-llm-full-dry

ENV_FILE ?= .env

ifneq ($(wildcard $(ENV_FILE)),)
ENV_FILE_FLAG := --env-file=$(ENV_FILE)
else
ENV_FILE_FLAG :=
endif

# Live, default smoke suite: 3 cases x EVAL_RUNS x 2 variants = 6 calls at the
# default EVAL_RUNS=1 (fits the default EVAL_MAX_CALLS=20). EVAL_CASES overrides
# the suite; EVAL_RUNS scales rounds per case; EVAL_MAX_CALLS guards the plan.
# Requires API_KEY (or FISCALCR_API_KEY / KIMI_API_KEY) in .env or the shell.
# Results land in .eval-results/ (gitignored).
eval-llm:
	./node_modules/.bin/tsx $(ENV_FILE_FLAG) eval/index.ts

# Keyless dry run: prints the plan (selected case ids, rounds, seed, call
# count), the budget check (exceeding the guard is shown without failing), and
# suite-level prompt char/token stats per variant. No API key sent, no network,
# zero billable calls, no artifact.
eval-llm-dry:
	./node_modules/.bin/tsx $(ENV_FILE_FLAG) eval/index.ts --dry-run

# Live, full suite: 10 cases x EVAL_RUNS x 2 variants = 20 calls at the default
# EVAL_RUNS=1 (exactly the default EVAL_MAX_CALLS=20). The 10x4 decision run is
# 80 calls and requires EVAL_MAX_CALLS=80.
eval-llm-full:
	EVAL_SUITE=full ./node_modules/.bin/tsx $(ENV_FILE_FLAG) eval/index.ts

# Keyless full-suite dry run (same guard behavior as eval-llm-dry).
eval-llm-full-dry:
	EVAL_SUITE=full ./node_modules/.bin/tsx $(ENV_FILE_FLAG) eval/index.ts --dry-run
