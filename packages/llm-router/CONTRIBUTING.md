# Contributing to Quantum-L9

## Governance Setup Checklist {#governance-setup}

Before opening any pull request, verify each item:

- [ ] Cloned `Cursor-Governance` into your local workspace root
- [ ] Ran `setup_workspace_symlinks.sh` (see [§2 symlink contract](https://github.com/Quantum-L9/Cursor-Governance/blob/main/CANONICAL_LAW.md#2-symlink-contract))
- [ ] Validated symlinks resolve correctly: `ls -la .cursor/rules .cursor/skills .cursor/commands`
- [ ] Read [CANONICAL_LAW.md §8](https://github.com/Quantum-L9/Cursor-Governance/blob/main/CANONICAL_LAW.md#8) for workspace wiring requirements
- [ ] Reviewed [CANONICAL_LAW.md §7 Anti-Patterns](https://github.com/Quantum-L9/Cursor-Governance/blob/main/CANONICAL_LAW.md#7-anti-patterns) — never violate these
- [ ] All CI gates green (no bypassing required status checks)
- [ ] CODEOWNERS notified for blast-radius files

---

## Quick Setup (3 Steps)

```bash
# Step 1: Clone Cursor-Governance alongside your target repo
git clone https://github.com/Quantum-L9/Cursor-Governance.git

# Step 2: Run workspace symlink wiring
cd Cursor-Governance
bash scripts/setup_workspace_symlinks.sh

# Step 3: Validate symlinks
ls -la .cursor/rules .cursor/skills .cursor/commands
# Expected: all three resolve without error
```

Per [CANONICAL_LAW.md §2](https://github.com/Quantum-L9/Cursor-Governance/blob/main/CANONICAL_LAW.md#2-symlink-contract):
the workspace root must have `.cursor/` symlinks resolving to `Cursor-Governance/rules/`, `skills/`, and `commands/`.

---

## CI Gate Requirements

All pull requests must pass:

| Gate | Tool | Kernel |
|---|---|---|
| Lint + type-check | ruff, mypy (Python) / tsc (TypeScript) | `pr-pipeline.yml@v1` |
| Unit tests | pytest (Python) / Jest (TypeScript) | `pr-pipeline.yml@v1` |
| Secret scan | gitleaks | `security.yml@v1` |
| SAST | Bandit + Semgrep (Python) | `security.yml@v1` |
| Dependency audit | pip-audit / npm audit | `security.yml@v1` |
| Pre-commit hooks | pre-commit framework | `pre-commit-ci.yml@v1` |
| Governance trio | Three-tier separation | `trio-governance.yml@v1` |

> **Anti-patterns** ([§7](https://github.com/Quantum-L9/Cursor-Governance/blob/main/CANONICAL_LAW.md#7-anti-patterns)):
> Never duplicate logic across kernels. Never add business logic to thin callers.
> Never reference `@main` from thin callers — always use `@v1`.

---

## Branch Naming & Commit Conventions

- Branches: `feat/<scope>`, `fix/<scope>`, `chore/<scope>`, `docs/<scope>`
- Commits: Conventional Commits format — `feat(scope): message`
- PRs targeting `main` require 2 CODEOWNERS approvals for blast-radius paths

---

## Kernel Authoring (l9-ci-core contributors only)

- Kernels must use `on: workflow_call` only
- `l9-self-ci.yml` must remain `on: pull_request/push` — **never convert to workflow_call** (circular dependency)
- `@v1` moving tag discipline: force-update `v1` for backward-compatible changes; cut `v2` for breaking changes
- See [workflow-interface-registry.yml](https://github.com/Quantum-L9/.github/blob/main/workflow-interface-registry.yml) for the full kernel API contract
