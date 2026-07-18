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
 *   5. (The caller — plan-executor — records the outcome via
 *      execution-policy.logAction → actionOutcomes; this module does not.)
 *
 * Env vars required (add to .env and GitHub Actions secrets):
 *   GITHUB_TOKEN          — PAT with repo:write on the Website-Bot source repo
 *   VERCEL_DEPLOY_HOOK    — Vercel deploy hook URL for the live site
 *   WEBSITE_BOT_REPO      — e.g., Quantum-L9/Website-Bot
 *   SITE_SOURCE_BRANCH    — e.g., main
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import axios from 'axios';
import { createModuleLogger } from '../core/logger.js';

const logger = createModuleLogger('site-deployment');

// Every outbound call gets a bounded timeout so a hung GitHub/Vercel endpoint
// can't stall a BullMQ worker slot indefinitely.
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Render a value as a safe double-quoted YAML scalar (including the quotes).
 * LLM-generated titles/descriptions are written into Astro frontmatter; an
 * unescaped `"` breaks the YAML (fails the site build) and a newline can inject
 * an arbitrary extra frontmatter key. Collapse newlines and escape `\` and `"`.
 */
export function yamlDoubleQuoted(value: string): string {
  const oneLine = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  const escaped = oneLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

export interface SiteDeploymentConfig {
  githubToken: string;
  vercelDeployHook: string;
  websiteBotRepo: string;   // e.g. 'Quantum-L9/Website-Bot'
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
    const response = await axios.get(url, { headers: this.headers, timeout: REQUEST_TIMEOUT_MS });
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
    }, { headers: this.headers, timeout: REQUEST_TIMEOUT_MS });

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
    if (!this.config.vercelDeployHook) {
      logger.warn('VERCEL_DEPLOY_HOOK not set — skipping Vercel deploy trigger');
      return;
    }
    await axios.post(this.config.vercelDeployHook, {}, { timeout: REQUEST_TIMEOUT_MS });
    logger.info('Vercel deploy hook triggered');
  }
}

// ─── Public Actions ──────────────────────────────────────────────────────────
// Each function maps 1:1 to an action in execution-policy.ts ACTION_TAXONOMY.

/** Build the single-tenant transport config from environment variables. */
export function siteConfigFromEnv(): SiteDeploymentConfig {
  const githubToken = process.env.GITHUB_TOKEN ?? '';
  const websiteBotRepo = process.env.WEBSITE_BOT_REPO ?? '';
  if (!githubToken || !websiteBotRepo) {
    logger.warn('GITHUB_TOKEN or WEBSITE_BOT_REPO not set — site-deployment forced to dry-run');
  }
  return {
    githubToken,
    vercelDeployHook: process.env.VERCEL_DEPLOY_HOOK ?? '',
    websiteBotRepo,
    sourceBranch: process.env.SITE_SOURCE_BRANCH ?? 'main',
    dryRun:
      process.env.NODE_ENV === 'test' ||
      process.env.SITE_DEPLOY_DRY_RUN === 'true' ||
      !githubToken ||
      !websiteBotRepo,
  };
}

/**
 * Get a GitHub content client.
 *
 * Pass an explicit `SiteDeploymentConfig` for multi-tenant use so each client
 * writes to its OWN source repo / deploy hook. With no argument it falls back
 * to the single-tenant env config — correct only while one client is onboarded.
 * There is intentionally NO module-level singleton, so an injected per-client
 * config always takes effect.
 *
 * TODO(multi-tenant): resolve config from the client's stored config
 * (clients.config.site_deployment) before enabling serp:execute-surpass-plans
 * for more than one client — otherwise every client would write to the same
 * WEBSITE_BOT_REPO. This is why that job ships `enabled: false`.
 */
export function getSiteDeploymentService(config?: SiteDeploymentConfig): GitHubContentClient {
  return new GitHubContentClient(config ?? siteConfigFromEnv());
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

  const safeTitle = yamlDoubleQuoted(newTitle);
  const updated = content
    .replace(/^title:.*$/m, `title: ${safeTitle}`)
    .replace(/^og_title:.*$/m, `og_title: ${safeTitle}`);

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
    .replace(/^description:.*$/m, `description: ${yamlDoubleQuoted(newDescription)}`);

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

  // Match the whole JSON-LD <script> block for this @type. Use [\s\S]*? (not
  // \{[^}]*) so nested objects/arrays in real-world schema don't cut the match
  // short and cause a duplicate block to be injected instead of replaced.
  const existingPattern = new RegExp(
    `<script type="application/ld\\+json">[\\s\\S]*?"@type":\\s*"${schemaType}"[\\s\\S]*?</script>`,
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

  // Collapse newlines so a multi-line value can't inject extra markdown lines.
  const safeHeading = String(newHeading ?? '').replace(/[\r\n]+/g, ' ').trim();
  const updated = content.replace(/^# .+$/m, `# ${safeHeading}`);

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

// ─── Initial Site Build Dispatch (Pillar 5) ──────────────────────────────────
// Programmatic "build a site for this client" trigger: fires a `build-site`
// repository_dispatch at the Website-Bot repo, whose build-site.yml workflow
// runs the factory pipeline (build → Vercel deploy → register back here).

const DEFAULT_SPEC_PATH = 'domain_spec/domain_spec.normalized.yaml';

export interface SiteBuildRequest {
  /** Client to build for; becomes CLIENT_ID in the Website-Bot pipeline. */
  clientId: string;
  /** Path to the normalized domain spec already committed in the Website-Bot repo. */
  specPath?: string;
}

export interface SiteBuildDispatchResult {
  dispatched: boolean;
  dryRun: boolean;
  clientId: string;
  specPath: string;
}

/**
 * Request an on-demand initial site build by firing a `build-site`
 * repository_dispatch at WEBSITE_BOT_REPO. The normalized domain spec must
 * already exist in that repo at `specPath` (authored during onboarding — this
 * only triggers a build for it; it does not carry or synthesize the spec).
 * Honors the same dry-run guard as the rest of site-deployment (no token/repo
 * configured → no-op).
 */
export async function requestSiteBuild(
  req: SiteBuildRequest,
  config: SiteDeploymentConfig = siteConfigFromEnv(),
): Promise<SiteBuildDispatchResult> {
  const specPath = req.specPath ?? DEFAULT_SPEC_PATH;

  if (config.dryRun) {
    logger.info({ clientId: req.clientId, specPath }, '[DRY-RUN] Would dispatch build-site');
    return { dispatched: false, dryRun: true, clientId: req.clientId, specPath };
  }

  const url = `https://api.github.com/repos/${config.websiteBotRepo}/dispatches`;
  await axios.post(
    url,
    { event_type: 'build-site', client_payload: { client_id: req.clientId, spec_path: specPath } },
    {
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: 'application/vnd.github.v3+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
  );

  logger.info(
    { clientId: req.clientId, specPath, repo: config.websiteBotRepo },
    'Dispatched build-site to Website-Bot',
  );
  return { dispatched: true, dryRun: false, clientId: req.clientId, specPath };
}
