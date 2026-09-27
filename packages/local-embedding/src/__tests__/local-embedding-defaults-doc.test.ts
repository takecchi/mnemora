import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import * as providerModule from "../local-embedding-provider.js";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import type {
  CreateLocalEmbeddingPipeline,
  LocalEmbeddingModelSpec,
  LocalEmbeddingPipeline,
} from "../pipeline.js";

/**
 * `LocalEmbeddingProvider` の options を省いたときの既定値が、TSDoc と README に書かれた値と一致することを縛る。
 * **doc の値は `local-embedding-provider.ts` の TSDoc と `README.md` を読んで**（`{@link DEFAULT_…}` で定数を
 * 指している欄はその定数を解決して）、**実装の値は options を省いた provider の振る舞いから**、どちらも実行時に
 * 取って突き合わせる。モデルは読み込まない（偽の pipeline を注入する）。
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("../local-embedding-provider.ts", import.meta.url)),
  "utf8",
);
const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");

/** `interface <name> { … }` の中で、`field?:` の直前の TSDoc を返す。 */
function docOf(interfaceName: string, field: string): string {
  const start = SOURCE.indexOf(`export interface ${interfaceName} {`);
  const end = SOURCE.indexOf("\n}\n", start);
  const block = SOURCE.slice(start, end);
  const at = block.indexOf(`\n  ${field}?:`);
  if (start < 0 || at < 0) throw new Error(`${interfaceName}.${field} が見つからない`);
  return block.slice(block.lastIndexOf("/**", at), at);
}

/** TSDoc の既定値。「既定 `"q8"`」「既定は `""`」「既定 `256`」「既定 {@link DEFAULT_X}」の形を読む。 */
function documentedDefault(interfaceName: string, field: string): string | number {
  const doc = docOf(interfaceName, field);
  const link = doc.match(/既定は?\s*\{@link\s+([A-Z0-9_]+)\}/);
  if (link) {
    const value = (providerModule as Record<string, unknown>)[link[1]!];
    if (value === undefined) throw new Error(`${link[1]} は export されていない`);
    return value as string | number;
  }
  const literal = doc.match(/既定は?\s*`("?)([^`"]*)\1`/);
  if (!literal) throw new Error(`${interfaceName}.${field} の TSDoc に既定値の記述が見つからない`);
  return /^[0-9]+$/.test(literal[2]!) ? Number(literal[2]) : literal[2]!;
}

function fakePipeline(dimensions: number, embedded: string[][]): LocalEmbeddingPipeline {
  return {
    maxInputTokens: Number.MAX_SAFE_INTEGER,
    countTokens: (texts) => texts.map(() => 0),
    embed: async (texts) => {
      embedded.push([...texts]);
      return texts.map(() => Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0)));
    },
  };
}

const ctx: Ctx = { tenantId: "local-embedding-defaults-doc" };

describe("LocalEmbeddingProvider の既定値は TSDoc と README の値と一致する", () => {
  it("repo・dtype・numThreads・modelId・dimensions・prefix", async () => {
    const specs: LocalEmbeddingModelSpec[] = [];
    const embedded: string[][] = [];
    const dimensions = Number(documentedDefault("LocalEmbeddingProviderOptions", "dimensions"));
    const createPipeline: CreateLocalEmbeddingPipeline = async (spec) => {
      specs.push(spec);
      return fakePipeline(dimensions, embedded);
    };
    const provider = new LocalEmbeddingProvider({ createPipeline });
    await provider.embed(ctx, ["本文"]);

    const doc = (field: string) => documentedDefault("LocalEmbeddingProviderOptions", field);
    expect(specs[0]).toMatchObject({
      repo: doc("repo"),
      dtype: doc("dtype"),
      numThreads: doc("numThreads"),
    });
    expect(provider.space).toMatchObject({ model: doc("modelId"), dimensions: doc("dimensions") });
    expect(embedded[0]).toEqual([`${doc("prefix")}本文`]);

    // README の「既定設定（`ruri-v3-30m/sym`・q8・256次元」「既定の設定（q8・4スレッド）」。
    const settings = README.match(/既定設定（`([^`]+)`・(q\d+)・\s*(\d+)次元/);
    const threads = README.match(/既定の設定（(q\d+)・(\d+)スレッド）/);
    expect(settings, "README に既定設定の記述が見つからない").not.toBeNull();
    expect(threads, "README に既定の設定の記述が見つからない").not.toBeNull();
    expect([settings![1], settings![2], Number(settings![3])]).toEqual([
      provider.space.model,
      specs[0]!.dtype,
      provider.space.dimensions,
    ]);
    expect([threads![1], Number(threads![2])]).toEqual([specs[0]!.dtype, specs[0]!.numThreads]);
  });

  it("retry.attempts（読み込みが失敗し続けるときの合計の試行回数）", async () => {
    let calls = 0;
    const provider = new LocalEmbeddingProvider({
      createPipeline: async () => {
        calls += 1;
        throw new Error("network down");
      },
      retry: { delayMs: () => 0 },
    });
    await expect(provider.embed(ctx, ["本文"])).rejects.toThrow();
    expect(calls).toBe(documentedDefault("LocalEmbeddingRetryOptions", "attempts"));
  });
});
