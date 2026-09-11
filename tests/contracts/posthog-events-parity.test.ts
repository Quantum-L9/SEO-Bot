/* L9_META
 * layer: test
 * role: contract_parity_test
 * status: active
 */

/**
 * The PostHog event vocabulary has one source: `@quantum-l9/bot-interop`
 * posthog-events, vendored byte-identically in Website-Bot and SEO-Bot. This
 * test pins SEO-Bot's two local mirrors of it — the stable import path in
 * src/contracts/posthog_events.ts and the `posthog_event_alignment` block in
 * contracts/website_factory_integration.yaml — to that source, so a rename on
 * one side cannot silently orphan the other.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POSTHOG_EVENTS as SHARED_EVENTS,
  POSTHOG_SITE_EMITTED_EVENTS as SHARED_SITE_EMITTED_EVENTS,
} from "@quantum-l9/bot-interop";
import { describe, expect, it } from "vitest";
import { POSTHOG_EVENTS, POSTHOG_SITE_EMITTED_EVENTS } from "../../src/contracts/posthog_events.js";

const here = dirname(fileURLToPath(import.meta.url));
const CONVENIENCE_COPY = resolve(here, "../../contracts/website_factory_integration.yaml");

/**
 * The convenience copy is a flat YAML block of `key: "value"` lines under
 * `posthog_event_alignment:`; the repo carries no YAML parser, and adding one
 * for four lines is not worth a dependency.
 */
function readPosthogEventAlignment(): Record<string, string> {
  const lines = readFileSync(CONVENIENCE_COPY, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === "posthog_event_alignment:");
  expect(start, "posthog_event_alignment block present").toBeGreaterThanOrEqual(0);
  const alignment: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (!/^\s+/.test(line)) break;
    const match = /^\s+([a-z_]+):\s*"([^"]+)"\s*$/.exec(line);
    expect(match, `parseable alignment line: ${line}`).not.toBeNull();
    if (match) alignment[match[1] as string] = match[2] as string;
  }
  return alignment;
}

describe("PostHog event vocabulary parity", () => {
  it("re-exports the shared bot-interop constants unchanged", () => {
    expect(POSTHOG_EVENTS).toBe(SHARED_EVENTS);
    expect(POSTHOG_SITE_EMITTED_EVENTS).toBe(SHARED_SITE_EMITTED_EVENTS);
  });

  it("names the events Behavior Intelligence joins on", () => {
    expect(POSTHOG_EVENTS).toEqual({
      PAGEVIEW: "$pageview",
      SCROLL_DEPTH: "scroll_depth",
      LEAD_FORM_SUBMITTED: "lead_form_submitted",
      CTA_CLICKED: "cta_clicked",
    });
  });

  it("keeps the website_factory_integration.yaml convenience copy in parity", () => {
    expect(readPosthogEventAlignment()).toEqual({
      pageview: POSTHOG_EVENTS.PAGEVIEW,
      scroll_depth: POSTHOG_EVENTS.SCROLL_DEPTH,
      form_submission: POSTHOG_EVENTS.LEAD_FORM_SUBMITTED,
      click_cta: POSTHOG_EVENTS.CTA_CLICKED,
    });
  });

  it("uses the shared constants, not literals, in Behavior Intelligence queries", () => {
    const source = readFileSync(
      resolve(here, "../../src/modules/behavior-intelligence/index.ts"),
      "utf8",
    );
    expect(source).toContain("POSTHOG_EVENTS.SCROLL_DEPTH");
    expect(source).toContain("POSTHOG_EVENTS.PAGEVIEW");
    expect(source).not.toMatch(/event\s*=\s*'\$pageview'/);
    expect(source).not.toMatch(/event\s*=\s*'scroll_depth'/);
  });
});
