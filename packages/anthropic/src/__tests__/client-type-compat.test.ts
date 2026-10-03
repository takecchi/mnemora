import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
// `anthropic-sdk-latest` は devDependency のエイリアス（`package.json` の
// `"anthropic-sdk-latest": "npm:@anthropic-ai/sdk@0.129.0"`。下の docstring 参照）。
import AnthropicLatest from "anthropic-sdk-latest";
import type { Ctx } from "@mnemora/core";
import type {
  AnthropicMessageCreateParams,
  AnthropicMessageResult,
  AnthropicMessagesClient,
} from "../client-types.js";
import { AnthropicLLMProvider } from "../llm-provider.js";

/**
 * [Issue #1221](https://github.com/takecchi/mnemora/issues/1221) の歯。`@mnemora/openai` の
 * `client-type-compat.test.ts` と同じ形・同じ理由——詳細はそちらの冒頭コメントを見ること。
 *
 * `AnthropicLLMProviderOptions.client` の型は、`@anthropic-ai/sdk` のクラスを名指ししない
 * 自前の構造型（`client-types.ts`）である。この歯は3つを縛る（3つ目は下の
 * `describe("公開する .d.ts に …")`。`stop_details` の型の歯と `system` の送り方の歯も下にある）:
 *
 * 1. **型**: 固定した版（`@anthropic-ai/sdk@0.124.0`）と、利用者が入れうる別の版
 *    （devDependency に `"anthropic-sdk-latest": "npm:@anthropic-ai/sdk@0.129.0"` として
 *    エイリアスした、2026-09-29 時点の最新）の**両方**の `Anthropic` インスタンスが
 *    `AnthropicMessagesClient` に代入できること——この行が `tsc -p tsconfig.json` を
 *    通ること自体が検査である。
 * 2. **実際の呼び出し**: 本物の SDK client（`fetch` を差し替えたもの）を provider に渡し、
 *    実際に送られる URL・method・JSON body が変わっていないことを、固定した版・別の版の
 *    両方で確かめる。
 * 3. **公開 `.d.ts`**: 公開する `.d.ts` に `@anthropic-ai/sdk` の import が出ないこと
 *    （`import ... from "@anthropic-ai/sdk"`・`import("@anthropic-ai/sdk")`・
 *    `/// <reference types="@anthropic-ai/sdk" />`）。⚠ CI は `test` を `build` より前に走らせる
 *    （`.github/workflows/ci.yml`）ので `dist` はまだ無い。そのためこの歯は `dist` を読まず、
 *    `tsconfig.build.json` と同じ設定で TypeScript の API が `.d.ts` をメモリへ出したものを読む
 *    （`dist` が無くても黙って通らない）。
 *
 * ⚠ **ネットワークは叩かない**（`live.anthropic.test.ts` の役目ではない）。
 */
const ctx: Ctx = { tenantId: "tenant-1" };

/** 代入できることそのものが検査であるマーカー関数。実行時は何もしない。 */
function assertAssignable<T>(_value: T): void {
  // 意図的に空。呼べる（＝ typecheck が通る）ことが検査である。
}

describe("client の型は別の版の @anthropic-ai/sdk インスタンスも受け付ける（Issue #1221、型検査）", () => {
  it("固定した版（@anthropic-ai/sdk@0.124.0）の Anthropic は AnthropicMessagesClient に代入できる", () => {
    const client: AnthropicMessagesClient = new Anthropic({ apiKey: "sk-ant-test" });
    assertAssignable<AnthropicMessagesClient>(client);
    expect(client).toBeInstanceOf(Anthropic);
  });

  it("別の版（anthropic-sdk-latest = @anthropic-ai/sdk@0.129.0）の Anthropic も代入できる", () => {
    const client: AnthropicMessagesClient = new AnthropicLatest({ apiKey: "sk-ant-test" });
    assertAssignable<AnthropicMessagesClient>(client);
    expect(client).toBeInstanceOf(AnthropicLatest);
  });

  it('Pick<Anthropic, "messages"> 型の値も、引き続き代入できる（既存の偽 client の形を壊さない）', () => {
    const messagesPick: Pick<Anthropic, "messages"> = new Anthropic({ apiKey: "sk-ant-test" });
    assertAssignable<AnthropicMessagesClient>(messagesPick);
  });
});

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

/** `fetch` を差し替えた本物の SDK client を作る。捕まえたリクエストは `calls` に積む。 */
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
  it("AnthropicLLMProvider.complete は固定した版の client で messages へ想定どおりの body を POST する", async () => {
    const { client, calls } = withCapturingFetch(
      (fetchStub) => new Anthropic({ apiKey: "sk-ant-test", fetch: fetchStub, maxRetries: 0 }),
      () =>
        jsonResponse({ content: [{ type: "text", text: "こんにちは" }], stop_reason: "end_turn" }),
    );
    const provider = new AnthropicLLMProvider({ model: "claude-opus-5", client });

    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(result).toEqual({ content: "こんにちは" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.body).toEqual({
      model: "claude-opus-5",
      max_tokens: 16000,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("AnthropicLLMProvider.complete は別の版（anthropic-sdk-latest）の client でも同じ body を POST する", async () => {
    const { client, calls } = withCapturingFetch(
      (fetchStub) =>
        new AnthropicLatest({ apiKey: "sk-ant-test", fetch: fetchStub, maxRetries: 0 }),
      () =>
        jsonResponse({ content: [{ type: "text", text: "こんにちは" }], stop_reason: "end_turn" }),
    );
    const provider = new AnthropicLLMProvider({ model: "claude-opus-5", client, maxTokens: 512 });

    const result = await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(result).toEqual({ content: "こんにちは" });
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.body).toEqual({
      model: "claude-opus-5",
      max_tokens: 512,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("AnthropicLLMProvider.completeStructured は output_config.format を載せて POST する（固定した版）", async () => {
    const { z } = await import("zod");
    const schema = z.object({ content: z.string() });
    const { client, calls } = withCapturingFetch(
      (fetchStub) => new Anthropic({ apiKey: "sk-ant-test", fetch: fetchStub, maxRetries: 0 }),
      () =>
        jsonResponse({
          content: [{ type: "text", text: JSON.stringify({ content: "本文" }) }],
          stop_reason: "end_turn",
        }),
    );
    const provider = new AnthropicLLMProvider({ model: "claude-opus-5", client });

    const result = await provider.completeStructured(ctx, {
      prompt: { messages: [{ role: "user", content: "hi" }] },
      schema,
    });

    expect(result).toEqual({ content: "本文" });
    const body = calls[0]?.body as { output_config?: { format?: { type?: string } } };
    expect(body.output_config?.format?.type).toBe("json_schema");
  });
});

/** `create` に渡された引数をそのまま積む偽 client（SDK の直列化を挟まずに `system` を見る）。 */
function fakeMessagesClient(): {
  client: AnthropicMessagesClient;
  bodies: AnthropicMessageCreateParams[];
} {
  const bodies: AnthropicMessageCreateParams[] = [];
  const client: AnthropicMessagesClient = {
    messages: {
      async create(params) {
        bodies.push(params);
        return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
      },
    },
  };
  return { client, bodies };
}

describe("PromptSpec.system は top-level の system として送られる（call-shape）", () => {
  it("prompt.system 付きで complete を呼ぶと、client が受け取る body の system にその値が入る", async () => {
    const { client, bodies } = fakeMessagesClient();
    const provider = new AnthropicLLMProvider({ model: "claude-opus-5", client });

    await provider.complete(ctx, {
      system: "あなたは記憶の整理役です。",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.system).toBe("あなたは記憶の整理役です。");
    // system は messages 配列へは入らない（Anthropic の messages に role: "system" は無い）。
    expect(bodies[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("prompt.system を渡さなければ、body に system の鍵そのものが無い（undefined も空文字も入れない）", async () => {
    const { client, bodies } = fakeMessagesClient();
    const provider = new AnthropicLLMProvider({ model: "claude-opus-5", client });

    await provider.complete(ctx, { messages: [{ role: "user", content: "hi" }] });

    expect(bodies).toHaveLength(1);
    expect("system" in (bodies[0] ?? {})).toBe(false);
  });
});

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

/**
 * `AnthropicMessageResult.stop_details`（`assertNotRefusedOrTruncated` が拒否の category を
 * 読む欄）が構造型に在ること。実 SDK の `Message` は `stop_details` を持つので、この欄を
 * 構造型から消しても、上の代入の歯（実 SDK の `Anthropic` の代入）は緑のままである。
 * 型だけの表明で、外れると `tsc`（`pnpm run typecheck`）が赤くなる——実行時の it は
 * 「歯が在る」ことを vitest に見せるためのもの。
 *
 * - `stop_details` を消すと、`AnthropicMessageResult["stop_details"]` が `TS2339`。
 * - `category` の型が変わると `Equals` が `false` になり `TS2344`。
 * - `stop_details` を必須にしても、`NonNullable` を通すので緑のまま（約束の外）。
 */
type _StopDetailsCategory = Expect<
  Equals<NonNullable<AnthropicMessageResult["stop_details"]>["category"], string | null | undefined>
>;

describe("AnthropicMessageResult は stop_details.category を持つ（型の歯）", () => {
  it("stop_details.category を持つ値が AnthropicMessageResult に代入できる", () => {
    const result: AnthropicMessageResult = {
      content: [],
      stop_reason: "refusal",
      stop_details: { category: "cyber" },
    };
    const category: _StopDetailsCategory = true;
    expect(category).toBe(true);
    expect(result.stop_details?.category).toBe("cyber");
  });
});

/**
 * 公開する `.d.ts` に SDK の import が出ないこと。`@mnemora/openai` の
 * `client-type-compat.test.ts` の同名の describe と同じ形・同じ理由——`dist` は読まず
 * （CI は `test` を `build` より前に走らせる）、build の設定で `.d.ts` をメモリへ出して読む。
 * `@mnemora/core` だけは `dist` が無いので `core/src` を指させる。
 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SDK_SPECIFIER = String.raw`(?:@anthropic-ai/sdk|anthropic-sdk-latest)(?:/[^"']*)?`;
/** 直前が引用符なので、`"@mnemora/anthropic"` や `"./anthropic.js"` には当たらない。 */
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

describe("公開する .d.ts に @anthropic-ai/sdk の import が出ない（grep）", () => {
  it("探り棒: SDK の import の綴りには当たり、自パッケージ名・相対パスには当たらない", () => {
    const shouldMatch = [
      'import type Anthropic from "@anthropic-ai/sdk";',
      "export type { Message } from '@anthropic-ai/sdk/resources/messages';",
      'import "@anthropic-ai/sdk";',
      'type Leaked = import("@anthropic-ai/sdk").Anthropic;',
      'type Leaked = typeof import("@anthropic-ai/sdk/resources");',
      '/// <reference types="@anthropic-ai/sdk" />',
      'import Anthropic = require("@anthropic-ai/sdk");',
    ];
    const shouldNotMatch = [
      'import type { Ctx } from "@mnemora/core";',
      'import type { X } from "@mnemora/anthropic";',
      'type X = import("@mnemora/anthropic").AnthropicLLMProvider;',
      '/// <reference types="@mnemora/anthropic" />',
      'import type { X } from "@mnemora/openai";',
      'export * from "./client-types.js";',
      'export { AnthropicLLMProvider } from "./llm-provider.js";',
      'import type { X } from "./anthropic.js";',
      'import type { X } from "@anthropic-ai/sdk-extras";',
    ];
    for (const line of shouldMatch) {
      expect(findSdkReferences(line), line).toEqual([line]);
    }
    for (const line of shouldNotMatch) {
      expect(findSdkReferences(line), line).toEqual([]);
    }
  });

  it("build の設定で出した .d.ts 全部に、@anthropic-ai/sdk の import・import()型・reference が無い", () => {
    const emitted = emitPublicDeclarations();

    // 1本も出ていない・主要なファイルが無いときは、「無かった」を根拠にしない。
    expect([...emitted.keys()]).toEqual(
      expect.arrayContaining(["index.d.ts", "client-types.d.ts", "llm-provider.d.ts"]),
    );
    expect(emitted.get("client-types.d.ts")).toContain("AnthropicMessagesClient");

    const found: string[] = [];
    for (const [file, text] of emitted) {
      for (const line of findSdkReferences(text)) {
        found.push(`${file}: ${line.trim()}`);
      }
    }
    expect(found).toEqual([]);
  }, 120_000);
});
