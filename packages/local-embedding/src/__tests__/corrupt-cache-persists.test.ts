import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "@huggingface/transformers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import {
  DEFAULT_LOCAL_EMBEDDING_REPO,
  LocalEmbeddingProvider,
} from "../local-embedding-provider.js";
import { createLocalEmbeddingPipeline, type CreateLocalEmbeddingPipeline } from "../pipeline.js";

/**
 * Issue #1140 の今の振る舞いを縛る歯。README「🔴 キャッシュのファイルが壊れていると、再試行でも次のプロセスでも
 * 直らない」。振る舞いは変えていない。
 *
 * - `cacheDir` の `tokenizer.json` と onnx が途中で切れていると（取得の中断を模す。Issue #1140 が本物の
 *   transformers.js で当てた4形のうち2つ）、読み込みは再試行を使い切って失敗する。新しいインスタンス（次の
 *   プロセスと同じく、読み込みをやり直す）でも同じく失敗する。
 *   ⚠ transformers.js は2つを並べて読むので、`cause` にどちらの失敗が出るかは回ごとに変わる（どちらでもよい）。
 * - 壊れたファイルは、失敗の後も1バイトも変わらずに残る（自動で消して取り直さない）。
 * - ネットワークには出ない: 既定のキャッシュ（`env.cacheDir`）に前段の確認の2ファイルを置き（#1239）、`env.fetch`
 *   は呼ばれたら記録して必ず失敗する。⟹ 失敗の原因は、壊れたファイルそのものである。
 */

const ctx: Ctx = { tenantId: "corrupt-cache" };
const REPO = DEFAULT_LOCAL_EMBEDDING_REPO;
/** 途中で切れたファイル（取得の中断を模す）。 */
const CORRUPT: Readonly<Record<string, string>> = {
  "tokenizer.json": `{"version": "1.0", "model": {"type": "Unigram", "vocab": [["<pad>", 0.0], ["<unk>"`,
  "onnx/model_quantized.onnx": "\u0008\u0007\u0012\u0004trunc",
};

let root: string;
let cacheDir: string;
const fetched: string[] = [];
const original = { cacheDir: env.cacheDir, fetch: env.fetch };

async function put(dir: string, file: string, content: string): Promise<void> {
  const target = path.join(dir, REPO, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mnemora-local-embedding-corrupt-"));
  const defaultCacheDir = path.join(root, "default-cache");
  cacheDir = path.join(root, "cache-dir");
  await put(defaultCacheDir, "config.json", JSON.stringify({ model_type: "modernbert" }));
  await put(defaultCacheDir, "tokenizer_config.json", "{}");
  await put(cacheDir, "config.json", JSON.stringify({ model_type: "modernbert" }));
  await put(cacheDir, "tokenizer_config.json", "{}");
  for (const [file, content] of Object.entries(CORRUPT)) {
    await put(cacheDir, file, content);
  }
  env.cacheDir = defaultCacheDir;
  env.fetch = (async (input: unknown) => {
    fetched.push(String(input));
    throw new TypeError("fetch failed (corrupt-cache-persists: network is disabled)");
  }) as typeof env.fetch;
});

afterAll(async () => {
  env.cacheDir = original.cacheDir;
  env.fetch = original.fetch;
  await rm(root, { recursive: true, force: true });
});

/** 本物の読み込み（`createLocalEmbeddingPipeline`）を呼んだ回数を数えるインスタンスで embed し、失敗を返す。 */
async function embedOnce(): Promise<{ error: Error; loads: number }> {
  let loads = 0;
  const counting: CreateLocalEmbeddingPipeline = async (spec) => {
    loads += 1;
    return createLocalEmbeddingPipeline(spec);
  };
  const provider = new LocalEmbeddingProvider({
    cacheDir,
    createPipeline: counting,
    retry: { attempts: 3, delayMs: () => 0 },
    sleep: async () => {},
  });
  const error = await provider.embed(ctx, ["テキスト"]).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "壊れたキャッシュなのに読み込めた").toBeInstanceOf(Error);
  return { error: error as Error, loads };
}

describe("キャッシュのファイルが壊れていると、再試行でも新しいインスタンスでも直らない（Issue #1140、今の振る舞い）", () => {
  it("再試行を使い切って失敗し、新しいインスタンスでも同じく失敗する。壊れたファイルは消されずに残る", async () => {
    const first = await embedOnce();
    expect(first.loads).toBe(3);
    expect(first.error.message).toContain("壊れ");
    // 原因は壊れたファイルの解釈（途中で切れた JSON か onnx）である。
    const cause = /JSON|Protobuf parsing failed/;
    expect(String((first.error as { cause?: unknown }).cause)).toMatch(cause);

    const second = await embedOnce();
    expect(second.loads).toBe(3);
    expect(String((second.error as { cause?: unknown }).cause)).toMatch(cause);

    for (const [file, content] of Object.entries(CORRUPT)) {
      expect(await readFile(path.join(cacheDir, REPO, file), "utf8")).toBe(content);
    }
    expect(fetched).toEqual([]);
  }, 90_000);
});
