/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

import type { IntelligenceProducer } from '@quantum-l9/bot-interop';

/**
 * Producer identity stamped onto every sealed build-intelligence artifact.
 * `repo` is fixed by the seam (SEO-Bot owns these artifacts); `version` tracks
 * the producing bot. Producer identity is NOT part of the artifact's semantic
 * digest (see bot-interop `sealIntelligenceArtifact`), so it never affects
 * determinism — it is provenance only.
 */
export const PRODUCER: { repo: IntelligenceProducer; version: string } = {
  repo: 'SEO-Bot',
  version: '2.1.0',
};
