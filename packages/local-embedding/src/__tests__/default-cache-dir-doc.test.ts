import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `cacheDir` を省いたときのモデルの置き場所について、doc（README・TSDoc）が実物と同じことを
 * 言っているか。
 *
 * 実物は transformers.js の `env.cacheDir` の既定で、`@huggingface/transformers` パッケージ自身の
 * ディレクトリの中の `.cache/` である（`src/env.js` の `DEFAULT_CACHE_DIR`）。
 *
 * 【実測 2026-09-27、main f663a6c】以前の doc は、既定を `~/.cache/huggingface`（ホームの下）と
 * 書いていた。モデルの読み込みに失敗したとき、メッセージは `cacheDir=未指定（既定の場所）` と
 * 出すだけなので、doc を頼りにホームの下を探す（消す）と、実物に届かない。
 *
 * ⚠ `@huggingface/transformers` の `env` を読むだけで、モデルも onnxruntime の推論も起こさない
 * （読むのは設定の値だけ）。
 */

const README = fileURLToPath(new URL("../../README.md", import.meta.url));
const PIPELINE = fileURLToPath(new URL("../pipeline.ts", import.meta.url));
const PROVIDER = fileURLToPath(new URL("../local-embedding-provider.ts", import.meta.url));

/** doc が既定の置き場所を名指すときの言い方（実物の場所を指す）。 */
const ACTUAL_PLACE = "@huggingface/transformers/.cache/";

describe("cacheDir の既定の置き場所（doc と実物）", () => {
  it("実物: transformers.js の既定は @huggingface/transformers パッケージの中の .cache/", async () => {
    const { env } = await import("@huggingface/transformers");
    expect(env.cacheDir?.replaceAll("\\", "/")).toMatch(/\/@huggingface\/transformers\/\.cache\/$/);
  });

  it.each([
    ["README.md", README],
    ["pipeline.ts（LocalEmbeddingModelSpec.cacheDir）", PIPELINE],
    ["local-embedding-provider.ts（LocalEmbeddingProviderOptions.cacheDir）", PROVIDER],
  ])("%s は既定を ~/.cache/huggingface と書かず、実物の場所を名指す", (_label, path) => {
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("~/.cache/huggingface");
    expect(text).toContain(ACTUAL_PLACE);
  });
});
