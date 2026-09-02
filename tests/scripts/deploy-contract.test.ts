/* L9_META
 * layer: test
 * role: deployment_contract_test
 * status: active
 */

/**
 * Both defects this file guards were SILENT in exactly the same way, which is
 * why they are worth a test rather than a code review:
 *
 *  - `docker compose build l9-seo-bot` names the container_name, not the Compose
 *    SERVICE KEY. Compose matches no service, does nothing, and exits 0 — so a
 *    broken deploy is indistinguishable from a working one at the shell.
 *  - `cmd_update` never ran migrations. Only `setup` did, so every release
 *    carrying a migration booted new code against an old schema and failed at
 *    runtime, on the server, rather than at deploy time.
 *
 * These are asserted against the script's TEXT because the script's failure mode
 * is that it runs successfully while doing the wrong thing; executing it here
 * would need a Docker daemon and would still exit 0 on the bug.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const deployScript = readFileSync(join(ROOT, "scripts", "deploy.sh"), "utf8");
const composeFile = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");

/**
 * Service keys Compose will accept as selectors.
 *
 * Read with a scanner rather than a YAML library on purpose: the repo has no
 * YAML parser in its own dependencies, and reaching for a transitively-hoisted
 * one would make this test fail whenever an unrelated dependency tree changed.
 * The shape being read is two-space-indented keys under `services:`, which is
 * this file's stable form.
 */
function composeServiceKeys(): string[] {
  const keys: string[] = [];
  let inServices = false;
  for (const line of composeFile.split("\n")) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    // Any other column-0 key ends the services block.
    if (inServices && /^\S/.test(line)) break;
    const match = inServices ? line.match(/^ {2}([A-Za-z0-9._-]+):\s*$/) : null;
    if (match) keys.push(match[1]);
  }
  return keys;
}

/**
 * Every literal service selector passed to a compose subcommand.
 *
 * Only the compose lines are scanned, and only the tokens AFTER the subcommand
 * and its flags — `$`-tokens are resolved at runtime and are checked separately
 * via the BOT_SERVICE assertion below.
 */
function selectorsUsed(): string[] {
  const selectors: string[] = [];
  for (const line of deployScript.split("\n")) {
    const compose = line.match(/docker compose -f "\$COMPOSE_FILE" (.+)$/);
    if (!compose) continue;

    let rest = compose[1].trim();
    // Strip the subcommand, which may be two words (`up -d`, `run --rm`).
    const sub = rest.match(/^(build|pull|run|up|down|restart|logs|ps|exec)\b\s*/);
    if (!sub) continue;
    rest = rest.slice(sub[0].length);

    for (const raw of rest.split(/\s+/)) {
      const token = raw.replace(/"/g, "");
      if (token === "") continue;
      // Flags, runtime-resolved values, and anything past a pipe/redirect.
      if (token.startsWith("-") || token.includes("$")) continue;
      if (["|", ">", "gzip", "pg_dumpall", "npm", "run", "migrate"].includes(token)) break;
      selectors.push(token);
    }
  }
  return selectors;
}

describe("deploy.sh — Compose service selectors", () => {
  it("addresses services by their Compose service key", () => {
    const keys = composeServiceKeys();
    expect(keys).toContain("seo-bot");
    for (const selector of selectorsUsed()) {
      expect(keys, `"${selector}" is not a Compose service key`).toContain(selector);
    }
  });

  it("never passes the container_name as a selector", () => {
    // `l9-seo-bot` is the container_name. Compose silently matches nothing.
    const containerNames = (composeFile.match(/container_name:\s*(\S+)/g) ?? []).map((line) =>
      line.split(":")[1].trim(),
    );
    expect(containerNames).toContain("l9-seo-bot");
    for (const name of containerNames) {
      expect(
        selectorsUsed(),
        `deploy.sh passes container_name "${name}" where a service key is required`,
      ).not.toContain(name);
    }
  });

  it("resolves the bot service through one overridable variable", () => {
    expect(deployScript).toMatch(/BOT_SERVICE="\$\{BOT_SERVICE:-seo-bot\}"/);
  });
});

describe("deploy.sh — the update path migrates", () => {
  const update = deployScript.slice(
    deployScript.indexOf("cmd_update()"),
    deployScript.indexOf("cmd_backup()") > deployScript.indexOf("cmd_update()")
      ? deployScript.indexOf("cmd_backup()")
      : deployScript.length,
  );

  it("runs migrations during update, not only during setup", () => {
    expect(update).toMatch(/npm run migrate/);
  });

  it("migrates BEFORE starting the new bot container", () => {
    // Order is the whole point: starting first would boot new code against an
    // unmigrated schema, which is the defect this guards.
    const migrateAt = update.indexOf("npm run migrate");
    const startAt = update.indexOf('up -d "$BOT_SERVICE"');
    expect(migrateAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(-1);
    expect(migrateAt).toBeLessThan(startAt);
  });

  it("brings up the database before migrating against it", () => {
    const dbUpAt = update.indexOf("up -d postgres redis");
    expect(dbUpAt).toBeGreaterThan(-1);
    expect(dbUpAt).toBeLessThan(update.indexOf("npm run migrate"));
  });

  it("backs up before it changes anything", () => {
    expect(update.indexOf("cmd_backup")).toBeLessThan(update.indexOf("git pull"));
  });

  it("uses npm, matching package.json's migrate script", () => {
    // The repo has no pnpm lockfile and no pnpm in the image; `pnpm migrate`
    // would fail inside the container after a successful-looking build.
    expect(deployScript).not.toMatch(/pnpm/);
  });
});

// ─── Network exposure (hardening contract C5) ────────────────────────────────

describe("docker-compose.yml — internal services are not published to the world", () => {
  /** Every published port mapping, as { service, mapping }. */
  function publishedPorts(): { service: string; mapping: string }[] {
    const out: { service: string; mapping: string }[] = [];
    let service: string | null = null;
    let inServices = false;
    let inPorts = false;

    for (const line of composeFile.split("\n")) {
      if (/^services:\s*$/.test(line)) {
        inServices = true;
        continue;
      }
      if (inServices && /^\S/.test(line)) break;
      if (!inServices) continue;

      const svc = line.match(/^ {2}([A-Za-z0-9._-]+):\s*$/);
      if (svc) {
        service = svc[1];
        inPorts = false;
        continue;
      }
      if (/^ {4}ports:\s*$/.test(line)) {
        inPorts = true;
        continue;
      }
      // Any other 4-space key ends the ports block.
      if (/^ {4}\S/.test(line)) {
        inPorts = false;
        continue;
      }
      const entry = inPorts ? line.match(/^ {6}- "([^"]+)"/) : null;
      if (entry && service) out.push({ service, mapping: entry[1] });
    }
    return out;
  }

  // Datastores. Nothing outside this host has business reaching these directly,
  // and two of them (redis, clickhouse) have no authentication configured here.
  const INTERNAL_SERVICES = ["postgres", "redis", "clickhouse"];

  it("binds every datastore port to loopback", () => {
    const internal = publishedPorts().filter((p) => INTERNAL_SERVICES.includes(p.service));
    // Guard the guard: if the services were renamed this must fail loudly rather
    // than vacuously pass over an empty list.
    expect(internal.length).toBeGreaterThan(0);

    for (const { service, mapping } of internal) {
      expect(mapping, `${service} publishes "${mapping}" to all interfaces`).toMatch(
        /^127\.0\.0\.1:/,
      );
    }
  });

  it("still reaches every datastore service the compose file defines", () => {
    // Catches a rename that would make the assertion above skip a service.
    const services = composeServiceKeys();
    for (const name of INTERNAL_SERVICES) {
      expect(services, `compose no longer defines "${name}" — update INTERNAL_SERVICES`).toContain(
        name,
      );
    }
  });

  it("leaves the operator-facing ports published", () => {
    // 3100 (bot API/dashboard) and 8000 (PostHog) sit behind the reverse proxy
    // and are authenticated; narrowing them here would take the product down
    // rather than harden it.
    const published = publishedPorts().map((p) => p.mapping);
    expect(published).toContain("3100:3100");
    expect(published).toContain("8000:8000");
  });
});
