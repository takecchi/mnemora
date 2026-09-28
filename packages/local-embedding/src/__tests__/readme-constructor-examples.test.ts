import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import {
  LocalEmbeddingProvider,
  type LocalEmbeddingProviderOptions,
} from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline } from "../pipeline.js";

/**
 * README の `ts check` の片にある `new LocalEmbeddingProvider({ ... })` が、構築時に例外を投げないこと。
 *
 * `ts check` の印は型しか見ない（ADR 0345）。README の「変換したものをどこに置けば拾われるか」の2つの例は、
 * 型は通るのに、`repo` だけを差し替えて `modelId` を省いていたので、構築時の検査（Issue #142 / ADR 0247）で
 * 投げていた。ここでは README から呼び出しを読み出して、同じ引数で実際に構築する。
 *
 * ネットワークには出ない——`new` はモデルを読まない（読むのは最初の `embed()`・`warmup()`）。
 * `createPipeline` の識別子は、呼ばれたら落ちる偽物に差し替える。
 *
 * ⚠ 読むのは、1行に収まった呼び出しで、引数が文字列のリテラルか `createPipeline` の識別子だけのもの
 * （README の `repo`・`cacheDir` の例がこの形）。複数行の呼び出し（`retry` の例）と `new LocalEmbeddingProvider()`
 * は読まない。読めない形の1行の呼び出しは、黙って飛ばさずに赤にする。
 */

const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

const ctx: Ctx = { tenantId: "t" };

const notCalled: CreateLocalEmbeddingPipeline = async () => {
  throw new Error("この歯では createPipeline を呼ばない");
};

/** `ts check` の片の中の、1行の `new LocalEmbeddingProvider({ ... })` の引数の中身を返す。 */
function singleLineCalls(): string[] {
  const calls: string[] = [];
  for (const block of README.matchAll(/```ts check\n([\s\S]*?)```/g)) {
    for (const call of block[1]!.matchAll(/new LocalEmbeddingProvider\(\{([^\n]*?)\}\)/g)) {
      calls.push(call[1]!);
    }
  }
  return calls;
}

function parseOptions(inner: string): LocalEmbeddingProviderOptions {
  const options: Record<string, unknown> = {};
  for (const part of inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")) {
    const literal = part.match(/^(\w+):\s*"([^"]*)"$/);
    if (literal) {
      options[literal[1]!] = literal[2]!;
      continue;
    }
    if (part === "createPipeline") {
      options.createPipeline = notCalled;
      continue;
    }
    throw new Error(`README の呼び出しの引数を読めない: ${part}`);
  }
  return options as LocalEmbeddingProviderOptions;
}

describe("README の new LocalEmbeddingProvider({ ... }) の例は、構築時に例外を投げない", () => {
  const calls = singleLineCalls();

  it("前提: repo を差し替える例を読み出せている（読めなければ下の歯は空振りする）", () => {
    expect(calls.filter((inner) => /\brepo:/.test(inner)).length).toBeGreaterThan(0);
  });

  it.each(calls.map((inner) => [inner]))("{%s}", (inner) => {
    expect(() => new LocalEmbeddingProvider(parseOptions(inner))).not.toThrow();
  });
});

describe("読み込み失敗のメッセージの、repo を差し替える案内", () => {
  it("modelId も渡すことを案内する（repo だけを差し替えると構築時に例外になるため）", async () => {
    const error = await new LocalEmbeddingProvider({
      createPipeline: async () => {
        throw new Error("取得できない");
      },
      retry: { attempts: 1 },
    })
      .embed(ctx, ["テキスト"])
      .then(
        () => expect.fail("例外が投げられなかった"),
        (reason: unknown) => reason as Error,
      );
    expect(error.message).toMatch(/^LocalEmbeddingProvider: モデルを読み込めなかった/);
    expect(error.message).toContain("options.repo");
    expect(error.message).toContain("options.modelId");
  });
});
