# L9 SEO Bot — Makefile (publish surface)
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
