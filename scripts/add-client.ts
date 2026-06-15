/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Add Client Script
 * 
 * Usage: pnpm add-client
 * Onboards a new domain into the multi-tenant SEO system.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { getDb, schema, closeDb } from '../src/core/database/index.js';
import { loadConfig } from '../src/core/config.js';
import readline from 'readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

async function main() {
  loadConfig();
  const db = getDb();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  L9 SEO Bot - Add New Client');
  console.log('═══════════════════════════════════════════════════════════\n');

  const name = await ask('Business name: ');
  const domain = await ask('Domain (e.g., safehavenrr.com): ');
  const industry = await ask('Industry (e.g., roofing, insurance, recycling): ');
  const city = await ask('City: ');
  const state = await ask('State (2-letter): ');
  const posthogProjectId = await ask('PostHog Project ID (or press Enter to skip): ');
  const posthogApiKey = await ask('PostHog Project API Key (or press Enter to skip): ');

  console.log('\nTarget Keywords (enter one per line, empty line to finish):');
  const keywords: Array<{ keyword: string; priority: string }> = [];
  while (true) {
    const kw = await ask('  Keyword: ');
    if (!kw) break;
    const priority = await ask('  Priority (critical/high/medium/low): ') || 'medium';
    keywords.push({ keyword: kw, priority });
  }

  console.log('\nServices offered (enter one per line, empty line to finish):');
  const services: string[] = [];
  while (true) {
    const svc = await ask('  Service: ');
    if (!svc) break;
    services.push(svc);
  }

  // Insert client
  const [client] = await db.insert(schema.clients).values({
    name,
    domain: domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, ''),
    industry,
    city: city || null,
    state: state || null,
    posthogProjectId: posthogProjectId || null,
    posthogApiKey: posthogApiKey || null,
    config: {
      targetKeywords: keywords,
      services,
      industry,
      city,
      state,
    },
  }).returning();

  console.log(`\n✅ Client added successfully!`);
  console.log(`   ID: ${client.id}`);
  console.log(`   Domain: ${client.domain}`);
  console.log(`   Keywords: ${keywords.length}`);
  console.log(`   Services: ${services.length}`);
  console.log(`\nThe Bot will begin monitoring on the next scheduled cycle.`);

  rl.close();
  await closeDb();
}

main().catch(console.error);
