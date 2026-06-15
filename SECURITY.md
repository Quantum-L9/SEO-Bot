# Security & Privacy Policy

The L9 SEO Bot manages sensitive data (API keys, client analytics, email credentials) and operates autonomously on the open web. Strict security boundaries are enforced.

## 1. API Key & Credential Management

- **No Hardcoded Secrets:** No API keys, passwords, or tokens shall ever be committed to the repository.
- **Environment Variables:** All secrets are injected via the `.env` file at runtime.
- **Zod Validation:** `src/core/config.ts` validates the presence of all required secrets on startup. If a secret is missing, the Bot will not start.

## 2. Multi-Tenant Data Isolation

- **Database Isolation:** Every row in operational tables (rankings, vitals, engagement, prospects) MUST include a `clientId`.
- **Query Scoping:** All database queries MUST filter by `clientId`. Cross-client queries are strictly forbidden unless explicitly authorized for anonymized portfolio benchmarking.
- **PostHog Projects:** Each client MUST have a distinct PostHog Project ID to ensure behavioral data is strictly siloed within the analytics engine.

## 3. Autonomous Safety Governors

- **Link Velocity Governor:** To prevent triggering spam penalties, the Bot enforces strict link acquisition velocity limits based on domain age (configured per client).
- **Circuit Breaker:** If a client's rankings drop by >30% in a 24-hour period, all autonomous SEO actions (content generation, outreach) are immediately paused, and an alert is sent to the operator.
- **LLM Budget Cap:** To prevent financial exhaustion via runaway LLM loops, a hard daily spend limit (e.g., $5.00) is enforced. If exceeded, strategic jobs are aborted.

## 4. Web Scraping & Crawler Policy

When the Bot interacts with external sites (e.g., competitor analysis, prospect discovery):
- It MUST respect `robots.txt` directives.
- It MUST use a clear, identifiable User-Agent (e.g., `L9-SEO-Bot/1.0 (+https://youragency.com)`).
- It MUST implement rate limiting (via BullMQ concurrency controls) to avoid overwhelming target servers.

## 5. Vulnerability Reporting

If you discover a security vulnerability in the L9 SEO Bot, do NOT open a public issue.
- **Status:** Unknown (Pending operator configuration)
- **Next Action:** Operator must define a security contact email or reporting channel.
