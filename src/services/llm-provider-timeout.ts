/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 *
 * Shared provider deadline. Kept out of services/llm.ts so the build-intelligence
 * DeepSeek client can use it without loading the router.
 */

export const LLM_PROVIDER_TIMEOUT_MS = 240_000;
