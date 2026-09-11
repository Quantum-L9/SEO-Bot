import assert from "node:assert/strict";
import test from "node:test";
import {
  POSTHOG_EVENTS,
  POSTHOG_LEGACY_EVENT_ALIASES,
  POSTHOG_SITE_EMITTED_EVENTS,
} from "../src/index.js";

test("canonical event names are unique snake_case identifiers (or PostHog $-events)", () => {
  const names = Object.values(POSTHOG_EVENTS);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^\$?[a-z][a-z0-9_]*$/);
});

test("site-emitted events are exactly the canonical custom events", () => {
  const custom = Object.values(POSTHOG_EVENTS).filter((name) => !name.startsWith("$"));
  assert.deepEqual([...POSTHOG_SITE_EMITTED_EVENTS].sort(), custom.sort());
});

test("legacy aliases map canonical names to distinct non-canonical names", () => {
  const canonical = new Set<string>(Object.values(POSTHOG_EVENTS));
  const aliases = Object.values(POSTHOG_LEGACY_EVENT_ALIASES);
  assert.equal(new Set(aliases).size, aliases.length);
  for (const [event, alias] of Object.entries(POSTHOG_LEGACY_EVENT_ALIASES)) {
    assert.ok(canonical.has(event), `${event} is not a canonical event`);
    assert.ok(!canonical.has(alias), `${alias} collides with a canonical event`);
    assert.notEqual(event, alias);
  }
});
