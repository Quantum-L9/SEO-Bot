import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildManifest, renderManifestMarkdown } from './inventory.js';
async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, filePath);
}
export async function generateManifest(root = process.cwd()): Promise<void> {
  const manifest = await buildManifest(root);
  await atomicWrite(path.join(root, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
  await atomicWrite(path.join(root, 'MANIFEST.md'), renderManifestMarkdown(manifest));
  console.log(`Generated ${manifest.entries.length} manifest entries (${manifest.inventory_digest})`);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  generateManifest().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
