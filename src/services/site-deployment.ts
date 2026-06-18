/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot — Site Deployment Service (GAP-08)
 *
 * The platform-level transport layer that was missing.
 * Enables every action in execution-policy.ts ACTION_TAXONOMY to actually
 * modify the live Astro/Vercel site via GitHub Contents API.
 *
 * Pattern:
 *   1. Read current file from source repo via GitHub API
 *   2. Apply targeted mutation (regex/AST-lite for frontmatter/JSON-LD)
 *   3. Write updated file back via PUT /repos/{owner}/{repo}/contents/{path}
 *   4. Trigger Vercel deploy hook
 *   5. Record outcome in actionOutcomes table
 *
 * Env vars required (add to .env and GitHub Actions secrets):
 *   GITHUB_TOKEN          — PAT with repo:write on the Website-Bot source repo
 *   VERCEL_DEPLOY_HOOK    — Vercel deploy hook URL for the live site
 *   WEBSITE_BOT_REPO      — e.g., cryptoxdog/Website-Bot
 *   SITE_SOURCE_BRANCH    — e.g., main
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import axios from 'axios';
import { createModuleLogger } from '../core/logger.js';

const logger = createModuleLogger('site-deployment');

export interface SiteDeploymentConfig {
  githubToken: string;
  vercelDeployHook: string;
  websiteBotRepo: string;   // e.g. 'cryptoxdog/Website-Bot'
  sourceBranch: string;     // e.g. 'main'
  dryRun?: boolean;         // true in CI/test — logs mutations, writes nothing
}

export interface FileUpdateResult {
  success: boolean;
  path: string;
  sha: string;
  commitUrl: string;
  dryRun: boolean;
}

class GitHubContentClient {
  private baseUrl = 'https://api.github.com';
  private config: SiteDeploymentConfig;

  constructor(config: SiteDeploymentConfig) {
    this.config = config;
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.config.githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async readFile(filePath: string): Promise<{ content: string; sha: string }> {
    const url = `${this.baseUrl}/repos/${this.config.websiteBotRepo}/contents/${filePath}?ref=${this.config.sourceBranch}`;
    const response = await axios.get(url, { headers: this.headers });
    const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
    return { content, sha: response.data.sha };
  }

  async writeFile(filePath: string, content: string, sha: string, commitMessage: string): Promise<FileUpdateResult> {
    if (this.config.dryRun) {
      logger.info({ filePath, commitMessage }, '[DRY-RUN] Would write file');
      return { success: true, path: filePath, sha, commitUrl: 'dry-run', dryRun: true };
    }

    const url = `${this.baseUrl}/repos/${this.config.websiteBotRepo}/contents/${filePath}`;
    const response = await axios.put(url, {
      message: commitMessage,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      sha,
      branch: this.config.sourceBranch,
    }, { headers: this.headers });

    return {
      success: true,
      path: filePath,
      sha: response.data.content.sha,
      commitUrl: response.data.commit.html_url,
      dryRun: false,
    };
  }

  async triggerVercelDeploy(): Promise<void> {
    if (this.config.dryRun) {
      logger.info('[DRY-RUN] Would trigger Vercel deploy hook');
      return;
    }
    await axios.post(this.config.vercelDeployHook, {});
    logger.info('Vercel deploy hook triggered');
  }
}

// ─── Public Actions ──────────────────────────────────────────────────────────
// Each function maps 1:1 to an action in execution-policy.ts ACTION_TAXONOMY.

let _client: GitHubContentClient | null = null;

export function getSiteDeploymentService(): GitHubContentClient {
  if (_client) return _client;
  const githubToken = process.env.GITHUB_TOKEN ?? '';
  const vercelDeployHook = process.env.VERCEL_DEPLOY_HOOK ?? '';
  const websiteBotRepo = process.env.WEBSITE_BOT_REPO ?? '';
  const sourceBranch = process.env.SITE_SOURCE_BRANCH ?? 'main';
  const dryRun = process.env.NODE_ENV === 'test' || process.env.SITE_DEPLOY_DRY_RUN === 'true';

  if (!githubToken || !websiteBotRepo) {
    logger.warn('GITHUB_TOKEN or WEBSITE_BOT_REPO not set — site-deployment running in dry-run mode');
  }

  _client = new GitHubContentClient({
    githubToken,
    vercelDeployHook,
    websiteBotRepo,
    sourceBranch,
    dryRun: dryRun || !githubToken || !websiteBotRepo,
  });
  return _client;
}

/**
 * Update the <title> and og:title of a page's frontmatter.
 * Targets Astro .astro or .md files with YAML frontmatter.
 */
export async function updateMetaTitle(
  filePath: string,
  newTitle: string,
  clientDomain: string,
): Promise<FileUpdateResult> {
  const client = getSiteDeploymentService();
  const { content, sha } = await client.readFile(filePath);

  const updated = content
    .replace(/^title:.*$/m, `title: "${newTitle}"`)
    .replace(/^og_title:.*$/m, `og_title: "${newTitle}"`);

  return client.writeFile(
    filePath,
    updated,
    sha,
    `seo(meta): update title on ${filePath} for ${clientDomain} [seo-bot]`,
  );
}

/**
 * Update the meta description in a page's frontmatter.
 */
export async function updateMetaDescription(
  filePath: string,
  newDescription: string,
  clientDomain: string,
): Promise<FileUpdateResult> {
  const client = getSiteDeploymentService();
  const { content, sha } = await client.readFile(filePath);

  const updated = content
    .replace(/^description:.*$/m, `description: "${newDescription}"`);

  return client.writeFile(
    filePath,
    updated,
    sha,
    `seo(meta): update description on ${filePath} for ${clientDomain} [seo-bot]`,
  );
}

/**
 * Inject or replace a JSON-LD <script> block in an Astro/HTML file.
 */
export async function injectSchema(
  filePath: string,
  schemaType: string,
  schemaJson: Record<string, unknown>,
  clientDomain: string,
): Promise<FileUpdateResult> {
  const client = getSiteDeploymentService();
  const { content, sha } = await client.readFile(filePath);

  const scriptBlock = `<script type="application/ld+json">
${JSON.stringify(schemaJson, null, 2)}
</script>`;

  const existingPattern = new RegExp(
    `<script type="application/ld\\+json">\\s*\\{[^}]*"@type":\\s*"${schemaType}"[\\s\\S]*?</script>`,
    'g',
  );

  const updated = existingPattern.test(content)
    ? content.replace(existingPattern, scriptBlock)
    : content.replace('</head>', `${scriptBlock}\n</head>`);

  return client.writeFile(
    filePath,
    updated,
    sha,
    `seo(schema): inject ${schemaType} on ${filePath} for ${clientDomain} [seo-bot]`,
  );
}

/**
 * Update the H1 heading in a page file.
 */
export async function updateHeading(
  filePath: string,
  newHeading: string,
  clientDomain: string,
): Promise<FileUpdateResult> {
  const client = getSiteDeploymentService();
  const { content, sha } = await client.readFile(filePath);

  const updated = content.replace(/^# .+$/m, `# ${newHeading}`);

  return client.writeFile(
    filePath,
    updated,
    sha,
    `seo(content): update H1 on ${filePath} for ${clientDomain} [seo-bot]`,
  );
}

/**
 * Full page content rewrite — replaces the markdown body below frontmatter.
 */
export async function rewritePageContent(
  filePath: string,
  newBodyMarkdown: string,
  clientDomain: string,
): Promise<FileUpdateResult> {
  const client = getSiteDeploymentService();
  const { content, sha } = await client.readFile(filePath);

  // Preserve frontmatter (everything between --- delimiters), replace body
  const frontmatterMatch = content.match(/^---[\s\S]*?---/);
  const frontmatter = frontmatterMatch ? frontmatterMatch[0] : '';
  const updated = frontmatter ? `${frontmatter}\n\n${newBodyMarkdown}` : newBodyMarkdown;

  return client.writeFile(
    filePath,
    updated,
    sha,
    `seo(content): rewrite page content on ${filePath} for ${clientDomain} [seo-bot]`,
  );
}

/**
 * Update FAQ schema and content block on a page.
 */
export async function updateFaq(
  filePath: string,
  faqs: Array<{ question: string; answer: string }>,
  clientDomain: string,
): Promise<FileUpdateResult> {
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };
  return injectSchema(filePath, 'FAQPage', faqSchema, clientDomain);
}

/**
 * Trigger Vercel deploy after one or more file mutations.
 */
export async function triggerVercelDeploy(): Promise<void> {
  const client = getSiteDeploymentService();
  await client.triggerVercelDeploy();
}
