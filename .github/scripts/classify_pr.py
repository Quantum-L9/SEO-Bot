#!/usr/bin/env python3
"""L9 PR classifier — changed-files-primary routing for the SEO-Bot TypeScript node.

Contract: emits routing signals to $GITHUB_OUTPUT for the PR Pipeline Gate to
consume. Changed files are the primary signal; labels are hints only; an
unknown diff fails closed (all gates run).

Standard library only — no third-party dependencies. Runs on the GitHub-hosted
runner's system python3.

Required outputs (stable contract):
  pr_class                 one of the pr_class_values below
  run_lint                 bool
  run_test                 bool
  run_security             bool
  run_infrastructure       bool
  is_docs_only             bool
  requires_human_review    bool
  diff_unknown             bool
  changed_count            int
  detected_labels          comma-separated string
  all_changed_files        newline-collapsed comma-separated string
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

# --- classification tables --------------------------------------------------

CODE_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
DOCS_EXT = {".md", ".mdx", ".rst", ".txt"}
DEP_FILES = {"package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc"}
INFRA_EXT = {".yml", ".yaml", ".tf", ".toml", ".dockerfile"}

# Paths whose change forces the security gate + human review. Note: `.github/`
# is handled separately as `ci_workflow` (still human-review-flagged) so that a
# pure workflow change is not miscategorised as an app security change.
SECURITY_SENSITIVE_PREFIXES = (
    "src/core/config",
    "src/core/database",
    "src/core/auth",
    "docker",
    "contracts/",
)

# pr_class values (fail-closed default is `unknown_diff`)
PR_CLASS_VALUES = {
    "docs_only",
    "ci_workflow",
    "docker",
    "tests_only",
    "compliance",
    "security",
    "dependency",
    "app_code",
    "unknown_diff",
}


def _run(cmd: list[str]) -> str:
    try:
        return subprocess.check_output(cmd, text=True, stderr=subprocess.DEVNULL)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def changed_files() -> list[str]:
    """Best-effort changed-file list.

    Prefer the PR base..head range; fall back to the last commit. If we cannot
    determine the diff, return an empty list and let the caller fail closed.
    """
    base_ref = os.environ.get("GITHUB_BASE_REF", "")
    if base_ref:
        _run(["git", "fetch", "--depth=1", "origin", base_ref])
        out = _run(["git", "diff", "--name-only", f"origin/{base_ref}...HEAD"])
        if out.strip():
            return [line for line in out.splitlines() if line.strip()]
    # Fallbacks for push events / shallow checkouts.
    out = _run(["git", "diff", "--name-only", "HEAD~1...HEAD"])
    if out.strip():
        return [line for line in out.splitlines() if line.strip()]
    out = _run(["git", "show", "--name-only", "--pretty=format:", "HEAD"])
    return [line for line in out.splitlines() if line.strip()]


def ext_of(path: str) -> str:
    base = path.rsplit("/", 1)[-1]
    if base.lower() == "dockerfile" or base.lower().endswith(".dockerfile"):
        return ".dockerfile"
    dot = base.rfind(".")
    return base[dot:].lower() if dot != -1 else ""


def detected_labels() -> list[str]:
    """Read PR labels from the event payload (hints only)."""
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if not event_path or not os.path.exists(event_path):
        return []
    try:
        with open(event_path, encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return []
    labels = payload.get("pull_request", {}).get("labels", [])
    return [lbl.get("name", "") for lbl in labels if lbl.get("name")]


def classify(files: list[str], labels: list[str]) -> dict:
    if not files:
        # Fail closed: we could not determine the diff -> run everything.
        return {
            "pr_class": "unknown_diff",
            "run_lint": True,
            "run_test": True,
            "run_security": True,
            "run_infrastructure": True,
            "is_docs_only": False,
            "requires_human_review": True,
            "diff_unknown": True,
        }

    exts = {ext_of(f) for f in files}
    names = {f.rsplit("/", 1)[-1] for f in files}

    code_changed = bool(exts & CODE_EXT)
    docs_changed = bool(exts & DOCS_EXT)
    infra_changed = bool(exts & INFRA_EXT) or any(f.startswith(".github/") for f in files)
    dep_changed = bool(names & DEP_FILES)
    tests_changed = any(f.startswith("tests/") or ".test." in f or ".spec." in f for f in files)
    docker_changed = any("docker" in f.lower() or ext_of(f) == ".dockerfile" for f in files)
    security_sensitive = any(
        f.startswith(SECURITY_SENSITIVE_PREFIXES) for f in files
    )
    workflow_sensitive = any(f.startswith(".github/") for f in files)
    unknown_ext = any(
        e not in (CODE_EXT | DOCS_EXT | INFRA_EXT) and f.rsplit("/", 1)[-1] not in DEP_FILES
        for f, e in ((f, ext_of(f)) for f in files)
    )

    # docs_only is true only when NO code/infra/dep files changed (evidence beats labels)
    is_docs_only = docs_changed and not (code_changed or dep_changed or docker_changed)
    # honor a docs label only if the evidence agrees
    if "type:docs" in labels and not (code_changed or dep_changed or docker_changed or infra_changed):
        is_docs_only = True

    # Determine dominant pr_class (most-specific → least)
    if is_docs_only:
        pr_class = "docs_only"
    elif dep_changed and not code_changed:
        pr_class = "dependency"
    elif docker_changed and not code_changed:
        pr_class = "docker"
    elif code_changed and all(
        f.startswith("tests/") or ".test." in f or ".spec." in f or ext_of(f) in DOCS_EXT
        for f in files
    ):
        pr_class = "tests_only"
    elif security_sensitive:
        pr_class = "security"
    elif code_changed:
        pr_class = "app_code"
    elif infra_changed or workflow_sensitive:
        pr_class = "ci_workflow"
    elif unknown_ext:
        pr_class = "unknown_diff"
    else:
        pr_class = "compliance"

    diff_unknown = pr_class == "unknown_diff"

    return {
        "pr_class": pr_class,
        # Lint/typecheck run for any code, infra, or unknown change.
        "run_lint": code_changed or infra_changed or diff_unknown,
        # Tests run for code or unknown change (docs/deps-only skip).
        "run_test": code_changed or tests_changed or diff_unknown,
        # Security runs for code, dep, docker, security-sensitive, or unknown change.
        "run_security": code_changed or dep_changed or docker_changed or security_sensitive or diff_unknown,
        "run_infrastructure": infra_changed or docker_changed or diff_unknown,
        "is_docs_only": is_docs_only,
        # Security-sensitive, workflow, or unknown diffs want a human in the loop.
        "requires_human_review": security_sensitive or workflow_sensitive or diff_unknown,
        "diff_unknown": diff_unknown,
    }


def emit(outputs: dict, files: list[str], labels: list[str]) -> None:
    outputs = dict(outputs)
    outputs["changed_count"] = len(files)
    outputs["detected_labels"] = ",".join(labels)
    outputs["all_changed_files"] = ",".join(files)

    lines = []
    for key, value in outputs.items():
        if isinstance(value, bool):
            value = "true" if value else "false"
        lines.append(f"{key}={value}")

    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

    # Human-readable log + step summary.
    print("=== L9 PR classification ===")
    for line in lines:
        print(line)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(f"### PR classification: `{outputs['pr_class']}`\n\n")
            fh.write(f"- changed files: {outputs['changed_count']}\n")
            fh.write(f"- run_lint: {outputs['run_lint']}\n")
            fh.write(f"- run_test: {outputs['run_test']}\n")
            fh.write(f"- run_security: {outputs['run_security']}\n")
            fh.write(f"- run_infrastructure: {outputs['run_infrastructure']}\n")
            fh.write(f"- requires_human_review: {outputs['requires_human_review']}\n")


def main() -> int:
    files = changed_files()
    labels = detected_labels()
    result = classify(files, labels)
    assert result["pr_class"] in PR_CLASS_VALUES, result["pr_class"]
    emit(result, files, labels)
    return 0


if __name__ == "__main__":
    sys.exit(main())
