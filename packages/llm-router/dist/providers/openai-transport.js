import OpenAI from 'openai';
/** Isolates the OpenAI SDK from provider and router contracts. */
export class OpenAIChatTransport {
    client;
    constructor(config) {
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            timeout: config.timeoutMs,
            maxRetries: config.maxRetries,
            defaultHeaders: config.defaultHeaders,
        });
    }
    async create(request, options) {
        const response = await this.client.chat.completions.create(request, options?.signal ? { signal: options.signal } : undefined);
        return response;
    }
}
//# sourceMappingURL=openai-transport.js.map