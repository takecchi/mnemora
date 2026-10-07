import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** モデルの読み込みに失敗したときのメッセージは `cacheDir=未指定（既定の場所）` としか出さないので、doc を頼りにホームの下を探すと実物に届かない。実物は `@huggingface/transformers` パッケージ自身のディレクトリの中の `.cache/`（`src/env.js` の `DEFAULT_CACHE_DIR`）。`env` を読むだけで、モデルも推論も起こさない。 */

const README = fileURLToPath(new URL("../../README.md", import.meta.url));
const PIPELINE = fileURLToPath(new URL("../pipeline.ts", import.meta.url));
const PROVIDER = fileURLToPath(new URL("../local-embedding-provider.ts", import.meta.url));

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
