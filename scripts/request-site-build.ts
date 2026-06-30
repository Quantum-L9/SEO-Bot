/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Request Site Build (operator CLI)
 *
 * Fires a `build-site` repository_dispatch at the Website-Bot repo so its
 * factory pipeline builds + deploys + registers a client's site on demand.
 *
 * Usage:  npm run request-site-build -- <clientId> [specPath]
 *    or:  tsx scripts/request-site-build.ts <clientId> [specPath]
 *   <clientId>  becomes CLIENT_ID in the Website-Bot pipeline
 *   [specPath]  path to the client's normalized domain spec ALREADY committed in
 *               the Website-Bot repo (default: domain_spec/domain_spec.normalized.yaml)
 *
 * Requires GITHUB_TOKEN (repo:write on WEBSITE_BOT_REPO) + WEBSITE_BOT_REPO in the
 * environment (or Infisical). Without them, this is a no-op dry-run.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { loadSecrets } from '../src/core/secrets.js';
import { requestSiteBuild } from '../src/services/site-deployment.js';

async function main() {
  // Validate args before any secret loading — a bad invocation should print
  // usage immediately and do no Infisical/.env work.
  const clientId = process.argv[2];
  const specPath = process.argv[3];

  if (!clientId) {
    console.error('Usage: npm run request-site-build -- <clientId> [specPath]');
    console.error('   or: tsx scripts/request-site-build.ts <clientId> [specPath]');
    process.exit(1);
  }

  await loadSecrets();

  const result = await requestSiteBuild({ clientId, specPath });

  if (result.dryRun) {
    console.log(
      `[dry-run] Not dispatched — set GITHUB_TOKEN + WEBSITE_BOT_REPO to fire. ` +
        `clientId=${result.clientId} specPath=${result.specPath}`,
    );
  } else {
    console.log(`✅ Dispatched build-site (clientId=${result.clientId}, specPath=${result.specPath})`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
