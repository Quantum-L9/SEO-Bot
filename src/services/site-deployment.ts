/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

import { createModuleLogger } from '../core/logger.js';

type PageMetaUpdates = {
  title?: string;
  description?: string;
};

type GitHubContentFile = {
  sha: string;
  content: string;
};

const logger = createModuleLogger('site-deployment');

class GitHubContentClient {
  constructor(private token: string, private owner: string, private repo: string) {}

  async updatePageMeta(path: string, updates: PageMetaUpdates, branch: string): Promise<void> {
    const file = await this.getFile(path, branch);
    let nextContent = file.content;

    if (updates.title) {
      const titleTag = `<title>${escapeHtml(updates.title)}</title>`;
      if (/<title>[\s\S]*?<\/title>/i.test(nextContent)) {
        nextContent = nextContent.replace(/<title>[\s\S]*?<\/title>/i, titleTag);
      } else {
        nextContent = nextContent.replace(/<\/head>/i, `  ${titleTag}\n</head>`);
      }
    }

    if (updates.description) {
      const metaDescription = `<meta name="description" content="${escapeHtmlAttribute(updates.description)}">`;
      if (/<meta[^>]*name=["']description["'][^>]*>/i.test(nextContent)) {
        nextContent = nextContent.replace(/<meta[^>]*name=["']description["'][^>]*>/i, metaDescription);
      } else {
        nextContent = nextContent.replace(/<\/head>/i, `  ${metaDescription}\n</head>`);
      }
    }

    if (nextContent !== file.content) {
      await this.updateFile(path, nextContent, file.sha, branch, `Update SEO meta tags for ${path}`);
    }
  }

  async injectSchema(path: string, schemaJson: Record<string, unknown>, branch: string): Promise<void> {
    const file = await this.getFile(path, branch);
    const schemaScript = `<script type="application/ld+json">${JSON.stringify(schemaJson)}</script>`;
    const nextContent = file.content.replace(/<\/head>/i, `  ${schemaScript}\n</head>`);

    if (nextContent !== file.content) {
      await this.updateFile(path, nextContent, file.sha, branch, `Inject JSON-LD schema for ${path}`);
    }
  }

  async triggerVercelDeploy(deployHookUrl: string): Promise<void> {
    const response = await fetch(deployHookUrl, { method: 'POST' });

    if (response.status !== 200) {
      const body = await response.text();
      throw new Error(`Vercel deploy hook failed with status ${response.status}: ${body}`);
    }

    logger.info({ repo: `${this.owner}/${this.repo}` }, 'Triggered Vercel deploy hook');
  }

  private async getFile(path: string, branch: string): Promise<GitHubContentFile> {
    const apiPath = this.getContentsApiPath(path, branch);
    const response = await fetch(apiPath, { headers: this.getHeaders() });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to fetch file "${path}" from GitHub: ${response.status} ${body}`);
    }

    const data = await response.json() as { sha: string; content: string };
    return {
      sha: data.sha,
      content: Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8'),
    };
  }

  private async updateFile(path: string, content: string, sha: string, branch: string, message: string): Promise<void> {
    const apiPath = this.getContentsApiPath(path, branch);
    const response = await fetch(apiPath, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify({
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        sha,
        branch,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to update file "${path}" in GitHub: ${response.status} ${body}`);
    }
  }

  private getContentsApiPath(path: string, branch: string): string {
    const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: ['Bearer', this.token].join(' '),
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

export function createSiteDeploymentClient(token: string, owner: string, repo: string): GitHubContentClient {
  return new GitHubContentClient(token, owner, repo);
}

export { GitHubContentClient };
