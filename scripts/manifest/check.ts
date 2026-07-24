import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildManifest, renderManifestMarkdown } from './inventory.js';
export async function checkManifest(root = process.cwd()): Promise<void> {
  const generated = await buildManifest(root);
  const [actualJson, actualMarkdown] = await Promise.all([
    readFile(path.join(root, 'MANIFEST.json'), 'utf8'),
    readFile(path.join(root, 'MANIFEST.md'), 'utf8'),
  ]);
  const drift: string[] = [];
  if (actualJson !== JSON.stringify(generated, null, 2) + '\n') drift.push('MANIFEST.json');
  if (actualMarkdown !== renderManifestMarkdown(generated)) drift.push('MANIFEST.md');
  if (drift.length > 0) throw new Error(`Manifest drift detected in ${drift.join(', ')}. Run npm run manifest:generate.`);
  console.log(`Manifest is current (${generated.entries.length} entries, ${generated.inventory_digest})`);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  checkManifest().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
