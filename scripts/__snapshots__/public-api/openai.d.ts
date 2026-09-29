// ===== dist/client-types.d.ts =====
export interface OpenAIChatMessageParam {
    role: "system" | "user" | "assistant";
    content: string;
}
export interface OpenAIChatResponseFormatJsonSchema {
    type: "json_schema";
    json_schema: {
        name: string;
        schema: Record<string, unknown>;
        strict: true;
    };
}
export interface OpenAIChatCompletionCreateParams {
    model: string;
    messages: OpenAIChatMessageParam[];
    temperature?: number;
    response_format?: OpenAIChatResponseFormatJsonSchema;
}
export interface OpenAIChatCompletionChoice {
    finish_reason?: string | null;
    message?: {
        content?: string | null;
        refusal?: string | null;
    } | null;
}
export interface OpenAIChatCompletionResult {
    choices: OpenAIChatCompletionChoice[];
}
export interface OpenAIChatClient {
    chat: {
        completions: {
            create(params: OpenAIChatCompletionCreateParams, options?: unknown): PromiseLike<OpenAIChatCompletionResult>;
        };
    };
}
export interface OpenAIEmbeddingCreateParams {
    model: string;
    input: string[];
    dimensions?: number;
}
export interface OpenAIEmbeddingItem {
    embedding: number[];
    index: number;
}
export interface OpenAIEmbeddingsResult {
    data: OpenAIEmbeddingItem[];
}
export interface OpenAIEmbeddingsClient {
    embeddings: {
        create(params: OpenAIEmbeddingCreateParams, options?: unknown): PromiseLike<OpenAIEmbeddingsResult>;
    };
}

// ===== dist/embedding-provider.d.ts =====
import type { AbortOptions, Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import type { OpenAIEmbeddingsClient } from "./client-types.js";
export interface OpenAIEmbeddingProviderOptions {
    apiKey?: string;
    model: string;
    dimensions: number;
    client?: OpenAIEmbeddingsClient;
}
export declare class OpenAIEmbeddingProvider implements EmbeddingProvider {
    readonly space: EmbeddingSpaceId;
    private readonly client;
    private readonly model;
    constructor(options: OpenAIEmbeddingProviderOptions);
    embed(_ctx: Ctx, texts: string[], opts?: AbortOptions): Promise<number[][]>;
}

// ===== dist/errors.d.ts =====
export type OpenAILLMFailureKind = "refusal" | "truncated" | "no_content";
export interface OpenAILLMProviderErrorOptions {
    kind: OpenAILLMFailureKind;
    finishReason?: string | null;
    refusalMessage?: string | null;
    message?: string;
}
export declare class OpenAILLMProviderError extends Error {
    readonly kind: OpenAILLMFailureKind;
    readonly finishReason: string | null;
    readonly refusalMessage: string | null;
    constructor(options: OpenAILLMProviderErrorOptions);
}

// ===== dist/index.d.ts =====
export * from "./client-types.js";
export * from "./embedding-provider.js";
export * from "./errors.js";
export * from "./llm-provider.js";
export * from "./json-schema.js";

// ===== dist/json-schema.d.ts =====
import type { z } from "zod";
export interface OpenAIJsonSchemaFormat {
    name: string;
    schema: Record<string, unknown>;
    strict: true;
}
export declare function translateForOpenAIStructuredOutput<T>(name: string, schema: z.ZodType<T>): OpenAIJsonSchemaFormat;

// ===== dist/llm-provider.d.ts =====
import type { AbortOptions, Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
import type { OpenAIChatClient } from "./client-types.js";
export interface OpenAILLMProviderOptions {
    apiKey?: string;
    model: string;
    client?: OpenAIChatClient;
    temperature?: number;
}
export declare class OpenAILLMProvider implements LLMProvider {
    private readonly client;
    private readonly model;
    private readonly temperature?;
    constructor(options: OpenAILLMProviderOptions);
    complete(_ctx: Ctx, req: PromptSpec, opts?: AbortOptions): Promise<LLMResponse>;
    completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>, opts?: AbortOptions): Promise<T>;
}
