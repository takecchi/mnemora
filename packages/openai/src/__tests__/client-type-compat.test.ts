import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import OpenAI from "openai";
// `openai-latest` は devDependency のエイリアス（`package.json` の `npm:openai@7.23.0`）。
import OpenAILatest from "openai-latest";
import type { Ctx } from "@mnemora/core";
import type {
  OpenAIChatClient,
  OpenAIChatCompletionCreateParams,
  OpenAIEmbeddingsClient,
} from "../client-types.js";
import { OpenAIEmbeddingProvider } from "../embedding-provider.js";
import { OpenAILLMProvider } from "../llm-provider.js";

/**
 * 3. **公開 `.d.ts`**: 公開する `.d.ts` に `openai` パッケージの import が出ないこと
 *    （`import ... from "openai"`・`import("openai")`・`/// <reference types="openai" />`）。
 * ⚠ CI は `test` を `build` より前に走らせるので `dist` がまだ無い。そのため `dist` を読まず、`tsconfig.build.json` と同じ設定で TypeScript の API が `.d.ts` をメモリへ出したものを読む（`dist` が無くても黙って通らない）。
 * 型の検査は実行時の assert ではなく、`tsc -p tsconfig.json` を通ること自体が検査である。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

function assertAssignable<T>(_value: T): void {
  // 意図的に空。呼べる（＝ typecheck が通る）ことが検査である。
}

describe("client の型は別の版の openai インスタンスも受け付ける（Issue #1221、型検査）", () => {
  it("固定した版（openai@7.10.0）の OpenAI は OpenAIChatClient に代入できる", () => {
    const client: OpenAIChatClient = new OpenAI({ apiKey: "sk-test" });
    assertAssignable<OpenAIChatClient>(client);
    expect(client).toBeInstanceOf(OpenAI);
  });

  it("別の版（openai-latest = openai@7.23.0）の OpenAI も OpenAIChatClient に代入できる", () => {
    const client: OpenAIChatClient = new OpenAILatest({ apiKey: "sk-test" });
    assertAssignable<OpenAIChatClient>(client);
    expect(client).toBeInstanceOf(OpenAILatest);
  });

  it("固定した版の OpenAI は OpenAIEmbeddingsClient にも代入できる", () => {
    const client: OpenAIEmbeddingsClient = new OpenAI({ apiKey: "sk-test" });
    assertAssignable<OpenAIEmbeddingsClient>(client);
    expect(client).toBeInstanceOf(OpenAI);
  });

  it("別の版の OpenAI も OpenAIEmbeddingsClient に代入できる", () => {
    const client: OpenAIEmbeddingsClient = new OpenAILatest({ apiKey: "sk-test" });
    assertAssignable<OpenAIEmbeddingsClient>(client);
    expect(client).toBeInstanceOf(OpenAILatest);
  });

  it('Pick<OpenAI, "chat">/Pick<OpenAI, "embeddings"> 型の値も、引き続き代入できる（既存の偽 client の形を壊さない）', () => {
    const chatPick: Pick<OpenAI, "chat"> = new OpenAI({ apiKey: "sk-test" });
    const embedPick: Pick<OpenAI, "embeddings"> = new OpenAI({ apiKey: "sk-test" });
    assertAssignable<OpenAIChatClient>(chatPick);
    assertAssignable<OpenAIEmbeddingsClient>(embedPick);
  });
});

/** SDK は既定で `encoding_format: "base64"` を強制し、応答をデコードして返す（`lib/embeddings.js`）。 */
function toBase64Float32(values: number[]): string {
  const buf = new Float32Array(values);
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("base64");
}

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

function withCapturingFetch<T>(
  buildClient: (fetchStub: typeof fetch) => T,
  respond: () => Response,
): { client: T; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return respond();
  };
  return { client: buildClient(fetchStub), calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("実際に送られる HTTP は、client の型を切り離す前と変わっていない（Issue #1221、call-shape）", () => {
  it("OpenAILLMProvider.complete は固定した版の client で chat/completions へ想定どおりの body を POST する", async () => {
    const { client, calls } = withCapturingFetch(
      (fetchStub) => new OpenAI({ apiKey: "sk-test", fetch: fetchStub, maxRetries: 0 }),
      () => jsonResponse({ choices: [{ message: { content: "こんにちは" } }] }),
    );
    const provider = new OpenAILLMProvider({ model: "gpt-4o-mini", client });

    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(result).toEqual({ content: "こんにちは" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.body).toEqual({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("OpenAILLMProvider.complete は別の版（openai-latest）の client でも同じ body を POST する", async () => {
    const { client, calls } = withCapturingFetch(
      (fetchStub) => new OpenAILatest({ apiKey: "sk-test", fetch: fetchStub, maxRetries: 0 }),
      () => jsonResponse({ choices: [{ message: { content: "こんにちは" } }] }),
    );
    const provider = new OpenAILLMProvider({ model: "gpt-4o-mini", client });

    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(result).toEqual({ content: "こんにちは" });
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.body).toEqual({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("OpenAIEmbeddingProvider.embed は固定した版の client で embeddings へ想定どおりの body を POST し、応答を正しく復元する", async () => {
    const { client, calls } = withCapturingFetch(
      (fetchStub) => new OpenAI({ apiKey: "sk-test", fetch: fetchStub, maxRetries: 0 }),
      () =>
        jsonResponse({
          data: [{ embedding: toBase64Float32([0.1, 0.2, 0.3]), index: 0 }],
          model: "text-embedding-3-small",
          object: "list",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
    );
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 3,
      client,
    });

    const [vector] = await provider.embed(ctx, ["hello"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0]?.body).toEqual({
      model: "text-embedding-3-small",
      input: ["hello"],
      dimensions: 3,
      encoding_format: "base64",
    });
    expect(vector).toHaveLength(3);
    expect(vector?.[0]).toBeCloseTo(0.1, 5);
    expect(vector?.[1]).toBeCloseTo(0.2, 5);
    expect(vector?.[2]).toBeCloseTo(0.3, 5);
  });

  it("OpenAIEmbeddingProvider.embed は別の版（openai-latest）の client でも同じ body を POST する", async () => {
    const { client, calls } = withCapturingFetch(
      (fetchStub) => new OpenAILatest({ apiKey: "sk-test", fetch: fetchStub, maxRetries: 0 }),
      () =>
        jsonResponse({
          data: [{ embedding: toBase64Float32([0.4, 0.5]), index: 0 }],
          model: "text-embedding-3-small",
          object: "list",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
    );
    const provider = new OpenAIEmbeddingProvider({
      model: "text-embedding-3-small",
      dimensions: 2,
      client,
    });

    const [vector] = await provider.embed(ctx, ["hello"]);

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0]?.body).toEqual({
      model: "text-embedding-3-small",
      input: ["hello"],
      dimensions: 2,
      encoding_format: "base64",
    });
    expect(vector?.[0]).toBeCloseTo(0.4, 5);
    expect(vector?.[1]).toBeCloseTo(0.5, 5);
  });
});

function fakeChatClient(): {
  client: OpenAIChatClient;
  bodies: OpenAIChatCompletionCreateParams[];
} {
  const bodies: OpenAIChatCompletionCreateParams[] = [];
  const client: OpenAIChatClient = {
    chat: {
      completions: {
        async create(params) {
          bodies.push(params);
          return { choices: [{ message: { content: "ok" } }] };
        },
      },
    },
  };
  return { client, bodies };
}

describe("temperature は指定したときだけ、その値で送られる（call-shape）", () => {
  it("temperature: 0.2 で作って complete を呼ぶと、client が受け取る body に temperature: 0.2 がある", async () => {
    const { client, bodies } = fakeChatClient();
    const provider = new OpenAILLMProvider({ model: "gpt-4o-mini", client, temperature: 0.2 });

    await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.temperature).toBe(0.2);
  });

  it("temperature を指定しなければ、body に temperature の鍵そのものが無い（undefined も既定値も入れない）", async () => {
    const { client, bodies } = fakeChatClient();
    const provider = new OpenAILLMProvider({ model: "gpt-4o-mini", client });

    await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body).toBeDefined();
    expect("temperature" in (body ?? {})).toBe(false);
  });
});

/** `dist` を読む形にすると、build 前は「読めるファイルが0本」で黙って通る穴になる。`@mnemora/core` だけは `dist` が無いので `core/src` を指させる（`import "@mnemora/core"` の綴りは変わらない）。 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SDK_SPECIFIER = String.raw`openai(?:-latest)?(?:/[^"']*)?`;
/** 直前が引用符なので、`"@mnemora/openai"` や `"./openai.js"` には当たらない。 */
const SDK_REFERENCE_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\bfrom\s*["']${SDK_SPECIFIER}["']`),
  new RegExp(String.raw`\bimport\s*["']${SDK_SPECIFIER}["']`),
  new RegExp(String.raw`\bimport\s*\(\s*["']${SDK_SPECIFIER}["']\s*\)`),
  new RegExp(String.raw`\brequire\s*\(\s*["']${SDK_SPECIFIER}["']\s*\)`),
  new RegExp(String.raw`///\s*<reference\s+(?:types|path)\s*=\s*["']${SDK_SPECIFIER}["']`),
];

function findSdkReferences(declarationText: string): string[] {
  return declarationText
    .split("\n")
    .filter((line) => SDK_REFERENCE_PATTERNS.some((pattern) => pattern.test(line)));
}

function emitPublicDeclarations(): Map<string, string> {
  const configPath = join(PACKAGE_ROOT, "tsconfig.build.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    PACKAGE_ROOT,
    undefined,
    configPath,
  );
  const srcRoot = join(PACKAGE_ROOT, "src") + sep;
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: {
      ...parsed.options,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: undefined,
      outDir: join(PACKAGE_ROOT, "dist-in-memory"),
      baseUrl: PACKAGE_ROOT,
      paths: { "@mnemora/core": [join(PACKAGE_ROOT, "..", "core", "src", "index.ts")] },
    },
  });
  const emitted = new Map<string, string>();
  program.emit(undefined, (fileName, text, _bom, _onError, sourceFiles) => {
    const source = sourceFiles?.[0]?.fileName;
    if (source !== undefined && resolve(source).startsWith(srcRoot) && fileName.endsWith(".d.ts")) {
      emitted.set(resolve(source).slice(srcRoot.length).replace(/\.ts$/, ".d.ts"), text);
    }
  });
  return emitted;
}

describe("公開する .d.ts に openai パッケージの import が出ない（grep）", () => {
  it("探り棒: SDK の import の綴りには当たり、自パッケージ名・相対パスには当たらない", () => {
    const shouldMatch = [
      'import type OpenAI from "openai";',
      "export type { ChatCompletion } from 'openai/resources/chat/completions';",
      'import "openai";',
      'type Leaked = import("openai").OpenAI;',
      'type Leaked = typeof import("openai/resources");',
      '/// <reference types="openai" />',
      'import OpenAI = require("openai");',
    ];
    const shouldNotMatch = [
      'import type { Ctx } from "@mnemora/core";',
      'import type { X } from "@mnemora/openai";',
      'type X = import("@mnemora/openai").OpenAILLMProvider;',
      '/// <reference types="@mnemora/openai" />',
      'export * from "./client-types.js";',
      'export { OpenAILLMProvider } from "./llm-provider.js";',
      'import type { X } from "./openai.js";',
      'import type { X } from "openai-provider";',
    ];
    for (const line of shouldMatch) {
      expect(findSdkReferences(line), line).toEqual([line]);
    }
    for (const line of shouldNotMatch) {
      expect(findSdkReferences(line), line).toEqual([]);
    }
  });

  it("build の設定で出した .d.ts 全部に、openai の import・import()型・reference が無い", () => {
    const emitted = emitPublicDeclarations();

    // 1本も出ていない・主要なファイルが無いときは、「無かった」を根拠にしない。
    expect([...emitted.keys()]).toEqual(
      expect.arrayContaining(["index.d.ts", "client-types.d.ts", "llm-provider.d.ts"]),
    );
    expect(emitted.get("client-types.d.ts")).toContain("OpenAIChatClient");

    const found: string[] = [];
    for (const [file, text] of emitted) {
      for (const line of findSdkReferences(text)) {
        found.push(`${file}: ${line.trim()}`);
      }
    }
    expect(found).toEqual([]);
  }, 120_000);
});
