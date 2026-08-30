export interface ChatTextPart {
    type: 'text';
    text: string;
}
export interface ChatImagePart {
    type: 'image_url';
    image_url: {
        url: string;
        detail?: 'low' | 'high' | 'auto';
    };
}
export type ChatContentPart = ChatTextPart | ChatImagePart;
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | ChatContentPart[];
}
export interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    response_format?: {
        type: 'json_object';
    };
    [key: string]: unknown;
}
export interface ChatCompletionResult {
    id?: string;
    _request_id?: string;
    choices: Array<{
        message?: {
            content?: string | null;
        };
        finish_reason?: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    citations?: string[];
}
export interface ChatRequestOptions {
    signal?: AbortSignal;
}
export interface ChatTransport {
    create(request: ChatCompletionRequest, options?: ChatRequestOptions): Promise<ChatCompletionResult>;
}
export interface OpenAIChatTransportConfig {
    apiKey: string;
    baseURL: string;
    timeoutMs: number;
    maxRetries: 0;
    defaultHeaders?: Record<string, string>;
}
/** Isolates the OpenAI SDK from provider and router contracts. */
export declare class OpenAIChatTransport implements ChatTransport {
    private readonly client;
    constructor(config: OpenAIChatTransportConfig);
    create(request: ChatCompletionRequest, options?: ChatRequestOptions): Promise<ChatCompletionResult>;
}
//# sourceMappingURL=openai-transport.d.ts.map