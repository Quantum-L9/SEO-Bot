# Agent runbook — finish Biome instantiation (SEO-Bot)

This PR lands the portable Biome contract. It does **not** mass-rewrite source
and it does **not** flip CI to blocking. Follow the steps below in order. Do not
skip the Cursor-Governance reclassify or the plugin install — without both, the
editor will keep fighting ESLint and pushes will still wait on a slow lint job.

Reference implementation already live in Website-Bot (`biome_default`, plugin
`biomejs.biome`, `npm run lint` = `biome check .`).

## Goal

Biome is the **only** JS/TS/JSON formatter and linter:

1. Real-time diagnostics + format/fix on save in Cursor (faster local pushes).
2. CI scan via the l9-ci-sdk reusable workflow (advisory, then blocking).
3. ESLint is removed so there is not a second owner.

## Already in this branch

| File | Role |
|---|---|
| `biome.json` | Cursor-Governance Biome 2.5.8 contract (SEO-Bot excludes) |
| `.biomeignore` | Generated-tree exclusions (keep in sync with `files.includes`) |
| `.editorconfig` | Editor-agnostic indent/newline contract Biome honors |
| `.vscode/extensions.json` | Recommends `biomejs.biome` |
| `.vscode/settings.json` | Biome default formatter + `source.fixAll.biome` / organize imports on save |
| `package.json` | `@biomejs/biome@2.5.8`; `lint` / `lint:fix` |
| `.github/workflows/l9-lint-test.yml` | SDK-owned `biome` job, `enforce-biome: false` |
| `.github/workflows/ci.yml` | No longer runs ESLint as a second lint owner |

`eslint.config.js` and the ESLint npm deps are **intentionally left**. Remove
them only after step 6.

## Step 1 — install

```bash
source scripts/ensure-npm-auth.sh
npm ci --no-audit --no-fund --ignore-scripts
npx biome --version
# expect 2.5.8
```

Do not invent a second GitHub PAT. Resolve `openclaw-igorbot/github#token` via
`l9-aws-secrets` when `NODE_AUTH_TOKEN` is empty.

## Step 2 — baseline scan (read-only)

```bash
npx biome check .
```

Record the finding count in the follow-up PR body. **Do not** run
`npx biome check --write .` across the tree unless the operator asked for a
format PR. A whole-repo rewrite is a separate scoped PR, not this one.

Safe local loop while editing:

```bash
npm run lint        # biome check .
npm run lint:fix    # biome check --write .  (only files you are already changing)
```

## Step 3 — activate the plugin (real-time lint)

Workspace settings are already committed. The extension must still be installed
in the local Cursor profile.

1. Install: `cursor --install-extension biomejs.biome` (or accept the workspace
   recommendation for `biomejs.biome`).
2. Reload the window (`Developer: Reload Window`).
3. Confirm `.vscode/settings.json` has:
   - `editor.defaultFormatter` = `biomejs.biome` for `javascript`,
     `javascriptreact`, `typescript`, `typescriptreact`, `json`
   - `editor.formatOnSave` = `true`
   - `editor.codeActionsOnSave.source.fixAll.biome` = `explicit`
   - `editor.codeActionsOnSave.source.organizeImports.biome` = `explicit`
   - JSONC stays on `vscode.json-language-features` (Biome cannot format jsonc)
4. Proof: open any `src/**/*.ts`, add an unused `const __biome_probe = 1;`,
   wait for the unused-variable diagnostic, then revert. Save a dirty file and
   confirm format/import organize runs without opening a terminal.

If the IDE still formats with ESLint or Prettier, stop. Either the workspace is
still classified `eslint_owned` (step 4) or another formatter extension is
winning. Do not add a second formatter config.

## Step 4 — reclassify the workspace (Cursor-Governance, separate PR)

Detection order in `environment/ide/exceptions.yaml` **basename-matches first**.
`SEO-Bot` is listed under `eslint_owned_repos`. While that entry exists, the
governed IDE profile will **not** treat this repo as `biome_default` even with
`biome.json` present, and it may overwrite `.vscode/settings.json` back to
ESLint.

In the Cursor-Governance clone:

1. Remove `SEO-Bot` from `eslint_owned_repos`.
2. Update any installer fixture that still names `SEO-Bot` as `eslint_owned`.
3. Open a scoped governance PR. Do not mix it with this SEO-Bot PR.
4. After that merge, run the IDE profile installer against this workspace so
   the generated `AGENTS.md` formatter-ownership block becomes `biome_default`.

Until step 4 merges, rely on the committed `.vscode/settings.json` in this repo
and do not let the installer rewrite it back to ESLint.

## Step 5 — flip CI to blocking

Only after `npx biome check .` exits 0 on `main` (or on a dedicated format PR
that lands first):

```yaml
# .github/workflows/l9-lint-test.yml — biome job with:
enforce-biome: true
```

Optional: add `npm run lint` to `.github/workflows/ci.yml` as a local-equivalent
gate. Do not reintroduce an `eslint` step.

## Step 6 — remove ESLint (second owner)

After step 5, or in the same follow-up if the tree is already clean:

1. Delete `eslint.config.js`.
2. Remove `eslint`, `@eslint/js`, `globals`, and `typescript-eslint` from
   `devDependencies`.
3. Refresh the lockfile: `npm run lockfile:generate`.
4. Do not add Prettier. Biome owns JS/TS/JSON.

## Step 7 — done when all of these are true

- `npx biome --version` prints `2.5.8`.
- `biomejs.biome` is installed and unused-variable diagnostics appear without a
  terminal command.
- Save formats and organizes imports via Biome.
- `l9-lint-test` job `Biome (format + lint) — SDK-owned` is present.
- `enforce-biome` is `true` only after a clean `biome check .`.
- `SEO-Bot` is absent from Cursor-Governance `eslint_owned_repos`.
- `eslint.config.js` is gone and no `npm run lint` path invokes ESLint.

## Do not

- Flip `enforce-biome: true` while the baseline scan is dirty.
- Mass-apply `biome check --write .` inside an unrelated feature PR.
- Hardcode secrets, PATs, or formatter settings that point at a local
  Website-Bot path.
- Ask the operator for a GitHub PAT when `openclaw-igorbot/github#token` resolves.
- Re-add ESLint or Prettier “just for CI”.
