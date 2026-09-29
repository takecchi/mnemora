// ===== dist/client-types.d.ts =====
export interface AnthropicMessageParam {
    role: "user" | "assistant";
    content: string;
}
export interface AnthropicJSONOutputFormat {
    type: "json_schema";
    schema: Record<string, unknown>;
}
export interface AnthropicOutputConfig {
    format?: AnthropicJSONOutputFormat | null;
}
export interface AnthropicMessageCreateParams {
    model: string;
    max_tokens: number;
    system?: string;
    messages: AnthropicMessageParam[];
    output_config?: AnthropicOutputConfig;
}
export interface AnthropicContentBlock {
    type: string;
    text?: string;
}
export interface AnthropicStopDetails {
    category?: string | null;
}
export interface AnthropicMessageResult {
    content: AnthropicContentBlock[];
    stop_reason?: string | null;
    stop_details?: AnthropicStopDetails | null;
}
export interface AnthropicMessagesClient {
    messages: {
        create(params: AnthropicMessageCreateParams, options?: unknown): PromiseLike<AnthropicMessageResult>;
    };
}

// ===== dist/errors.d.ts =====
export type AnthropicLLMFailureKind = "refusal" | "truncated" | "no_content";
export interface AnthropicLLMProviderErrorOptions {
    kind: AnthropicLLMFailureKind;
    stopReason?: string | null;
    refusalCategory?: string | null;
    message?: string;
}
export declare class AnthropicLLMProviderError extends Error {
    readonly kind: AnthropicLLMFailureKind;
    readonly stopReason: string | null;
    readonly refusalCategory: string | null;
    constructor(options: AnthropicLLMProviderErrorOptions);
}

// ===== dist/index.d.ts =====
export * from "./client-types.js";
export * from "./errors.js";
export * from "./llm-provider.js";
export * from "./json-schema.js";

// ===== dist/json-schema.d.ts =====
import type { z } from "zod";
export interface AnthropicJsonSchemaFormat {
    type: "json_schema";
    schema: Record<string, unknown>;
}
export declare function translateForAnthropicStructuredOutput<T>(schema: z.ZodType<T>): AnthropicJsonSchemaFormat;

// ===== dist/llm-provider.d.ts =====
import type { AbortOptions, Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
import type { AnthropicMessageParam, AnthropicMessagesClient } from "./client-types.js";
export declare const DEFAULT_MAX_TOKENS = 16000;
export interface AnthropicLLMProviderOptions {
    apiKey?: string;
    model: string;
    maxTokens?: number;
    client?: AnthropicMessagesClient;
}
export interface AnthropicRequest {
    system?: string;
    messages: AnthropicMessageParam[];
}
export declare function toAnthropicRequest(prompt: PromptSpec): AnthropicRequest;
export declare class AnthropicLLMProvider implements LLMProvider {
    private readonly client;
    private readonly model;
    private readonly maxTokens;
    constructor(options: AnthropicLLMProviderOptions);
    complete(_ctx: Ctx, req: PromptSpec, opts?: AbortOptions): Promise<LLMResponse>;
    completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>, opts?: AbortOptions): Promise<T>;
}
