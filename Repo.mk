# SEO-Bot repository-owned Make implementation (Repository Execution V2).
#
# The root Makefile is the generated l9-ci-core `make-v1` facade (never edit
# it; regenerate with `python3 -m tools.l9_repo --workspace <repo> reconcile`
# from an l9-ci-core checkout). It includes this file and routes
#   setup -> repo-setup   validate -> repo-validate
#   check -> repo-check   test     -> repo-test
# Do not define help, setup, validate, check or test here: the facade owns
# them. SHELL and .DEFAULT_GOAL are the facade's too. Everything else below is
# this repository's own command surface.

# Organization CI (`Analyze (central Core)`) runs the four phases on the hosted
# runner without setting up Node, and SEO-Bot requires Node >= 22 (package.json
# engines). Prefer the runner's hosted-toolcache Node 22 when it exists;
# elsewhere the Node already on PATH is used and repo-setup checks it.
NODE22_BIN := $(lastword $(sort $(wildcard /opt/hostedtoolcache/node/22.*/x64/bin)))
ifneq ($(NODE22_BIN),)
export PATH := $(NODE22_BIN):$(PATH)
endif

BIN := node_modules/.bin

# ── make-v1 ABI leaves (Repository Execution V2) ────────────────────────────
# Each reuses a gate the repository's own CI (.github/workflows/ci.yml) or the
# pr-check target below already runs; none adds a second implementation.
.PHONY: repo-setup repo-validate repo-check repo-test

repo-setup: ## Install Node dependencies (lockfile-exact, no install scripts)
	@node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22) { console.error(`repo-setup: Node >= 22 required, found $${process.versions.node}`); process.exit(1); }'
	npm ci --no-audit --no-fund --ignore-scripts

repo-validate: ## Non-mutating structural validation (source entrypoints present)
	npm run verify:source

repo-check: ## Static checks: TypeScript (build and check projects) and Biome
	$(BIN)/tsc --noEmit
	$(BIN)/tsc -p tsconfig.check.json --noEmit
	$(BIN)/biome check .

repo-test: ## Unit test suite (vitest; live Gate 5 suite stays in ci.yml)
	$(BIN)/vitest run

# ── Publish (L9 sanctioned surface) ──────────────────────────────────────
# make pr is the ONLY push/PR route (48-make-pr-remediation). Checkers run
# before any remote mutation; OPEN_PR=0 runs the gate only.
GOV_ROOT ?= $(HOME)/.cursor-governance
OPEN_PR ?= 1
PR_REMEDIATE ?= 1
PR_BASE ?= origin/main

.PHONY: pr pr-check

pr-check:
	@echo "--- pr-check: SEO-Bot repository gates ---"
	npx tsc -p tsconfig.check.json --noEmit
	npx vitest run
	npx biome check .
	@echo "--- pr-check PASS ---"

pr: pr-check
	@if [ "$(OPEN_PR)" = "1" ]; then \
		PR_BASE="$(PR_BASE)" PR_REMEDIATE="$(PR_REMEDIATE)" \
			bash "$(GOV_ROOT)/ops/scripts/open_pr_after_gate.sh" "$(PWD)"; \
	else \
		echo "OPEN_PR=0 — skipped GitHub PR open (gate already PASS)"; \
	fi
