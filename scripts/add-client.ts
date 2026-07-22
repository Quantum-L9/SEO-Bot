/* L9_META: layer=module, role=seo_bot_engine, status=active, version=3.0.0 */
import { getDb, schema, closeDb } from '../src/core/database/index.js';
import { loadConfig } from '../src/core/config.js';
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question: string): Promise<string> => new Promise(resolve => rl.question(question, resolve));
const ENV_REF = /^env:\/\/[A-Z][A-Z0-9_]*$/;

function normalizeDomain(value: string): string {
  return value.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
}

async function main(): Promise<void> {
  loadConfig();
  const db = getDb();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  L9 SEO Bot - Add New Client (monitoring-only)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const name = await ask('Business name: ');
  const domain = await ask('Domain (e.g., safehavenrr.com): ');
  const industry = await ask('Industry (e.g., roofing, insurance, recycling): ');
  const city = await ask('City: ');
  const state = await ask('State (2-letter): ');
  const posthogProjectId = await ask('PostHog Project ID (or press Enter to skip): ');
  const posthogApiKey = await ask('PostHog Personal API Key (or press Enter to skip): ');

  console.log('\nTarget Keywords (enter one per line, empty line to finish):');
  const keywords: Array<{ keyword: string; priority: string }> = [];
  while (true) {
    const keyword = await ask('  Keyword: ');
    if (!keyword) break;
    const priority = (await ask('  Priority (critical/high/medium/low): ')) || 'medium';
    keywords.push({ keyword, priority });
  }

  console.log('\nServices offered (enter one per line, empty line to finish):');
  const services: string[] = [];
  while (true) {
    const service = await ask('  Service: ');
    if (!service) break;
    services.push(service);
  }

  console.log('\nOptional unverified site target. Raw tokens are never stored.');
  const websiteBotRepo = await ask('  Website repo (owner/repo, or press Enter to skip): ');
  const sourceBranch = (await ask('  Source branch [main]: ')) || 'main';
  const githubCredentialRef = await ask('  GitHub credential ref [env://CLIENT_SITE_GITHUB_TOKEN]: ') || 'env://CLIENT_SITE_GITHUB_TOKEN';
  const vercelDeployHookRef = await ask('  Vercel deploy hook ref [env://CLIENT_SITE_VERCEL_DEPLOY_HOOK]: ') || 'env://CLIENT_SITE_VERCEL_DEPLOY_HOOK';

  if (!ENV_REF.test(githubCredentialRef) || !ENV_REF.test(vercelDeployHookRef)) {
    throw new Error('Credential references must use env://UPPERCASE_NAME');
  }

  const config = {
    targetKeywords: keywords,
    services,
    industry,
    city,
    state,
    ...(websiteBotRepo ? {
      site_deployment: {
        schemaVersion: '3.0',
        status: 'unverified',
        transport: 'github-contents-api',
        githubCredentialRef,
        vercelDeployHookRef,
        websiteBotRepo,
        sourceBranch,
      },
    } : {}),
  };

  const [client] = await db.insert(schema.clients).values({
    name,
    domain: normalizeDomain(domain),
    industry,
    city: city || null,
    state: state || null,
    posthogProjectId: posthogProjectId || null,
    posthogApiKey: posthogApiKey || null,
    config,
    active: false,
  }).returning();

  console.log('\n✅ Client added in monitoring-only mode.');
  console.log(`   ID: ${client.id}`);
  console.log(`   Domain: ${client.domain}`);
  console.log(`   Keywords: ${keywords.length}`);
  console.log('   Maintenance: INACTIVE until a canonical Website Factory v3 handoff proves the repo, commit, and editable Astro paths.');

  rl.close();
  await closeDb();
}

main().catch(error => {
  console.error(error);
  rl.close();
  process.exitCode = 1;
});
