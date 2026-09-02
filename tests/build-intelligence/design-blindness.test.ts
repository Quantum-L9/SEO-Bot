// L9_META: layer=test, role=seo_bot_design_blindness, status=active, version=1.0.0
//
// WBV2-002 / WBV2-006 / WBV2-011: SEO-Bot stays design-blind.
//
// Before ADR-0018 this boundary was a comment. These tests make it an
// assertion: SEO-Bot must not produce, consume, or even be able to name the
// blueprint and the design authorities, and the artifacts it does own must
// keep their independent authority.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as interop from "../../packages/bot-interop/src/website-intelligence.js";

const SRC = resolve(__dirname, "../../src");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("SEO-Bot design blindness", () => {
  it("WBV2-002: the design authorities are not reachable from bot-interop", () => {
    // They are Website-Bot-local on purpose: an import SEO-Bot cannot write is
    // a stronger boundary than one it is merely asked not to write.
    for (const name of [
      "ClientVision",
      "DesignReferenceSet",
      "DesignReferenceIntelligence",
      "resolveClientVision",
      "resolveDesignDirection",
      "compileWebsiteBuildBlueprint",
    ]) {
      expect(interop as Record<string, unknown>).not.toHaveProperty(name);
    }
  });

  it("WBV2-002/006: no SEO-Bot source consumes the blueprint or a design authority", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const forbidden of [
        "WebsiteBuildBlueprint",
        "ClientVision",
        "DesignReferenceIntelligence",
        "DesignReferenceSet",
        "design_direction",
        "palette_authority",
      ]) {
        if (code.includes(forbidden)) {
          offenders.push(`${relative(SRC, file)} → ${forbidden}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("WBV2-011: SEO-Bot still owns its three artifacts", () => {
    expect(interop.WEBSITE_INTELLIGENCE_SCHEMAS.competitiveLandscape).toMatch(
      /competitive-landscape\/v1$/,
    );
    expect(interop.WEBSITE_INTELLIGENCE_SCHEMAS.seoContentBlueprint).toMatch(
      /seo-content-blueprint\/v1$/,
    );
    expect(interop.WEBSITE_INTELLIGENCE_SCHEMAS.structuredContentPackage).toMatch(
      /structured-content-package\/v1$/,
    );
  });

  it("WBV2-001: the shared contract names v2 as the only blueprint schema", () => {
    expect(interop.WEBSITE_INTELLIGENCE_SCHEMAS.websiteBuildBlueprint).toBe(
      "l9://website-intelligence/website-build-blueprint/v2",
    );
  });

  it("WBV2-014: the vendored interop source matches the shared parity manifest", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, "../../contracts/BOT_INTEROP_PARITY.json"), "utf8"),
    ) as { files: Record<string, string> };
    const dir = resolve(__dirname, "../../packages/bot-interop/src");
    for (const [name, expected] of Object.entries(manifest.files)) {
      const digest = createHash("sha256")
        .update(readFileSync(join(dir, name)))
        .digest("hex");
      expect(digest, `${name} has drifted from the shared contract`).toBe(expected);
    }
  });
});
