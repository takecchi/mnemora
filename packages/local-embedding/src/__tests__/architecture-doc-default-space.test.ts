import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { LocalEmbeddingProvider } from "../local-embedding-provider.js";
import type { CreateLocalEmbeddingPipeline } from "../pipeline.js";

/**
 * `docs/architecture.md` §5.5 が書く `LocalEmbeddingProvider` の既定の空間
 * （「既定 `{ provider: "local", model: "…", dimensions: N }`」）が、options を省いた provider の
 * `space` と一致することを縛る。**doc の値は `docs/architecture.md` を実行時に読んで**、**実装の値は
 * options を省いて作った provider の振る舞いから**取って突き合わせる。モデルは読み込まない
 * （偽の pipeline を注入する）。
 *
 * 同じ既定値の TSDoc・README 側は `local-embedding-defaults-doc.test.ts` が縛っている。
 * この歯は `docs/architecture.md` の行を縛る（`@mnemora/postgres` 側の architecture.md の歯からは
 * このパッケージに届かないため、ここに置く）。
 */

const ARCHITECTURE_DOC = readFileSync(
  fileURLToPath(new URL("../../../../docs/architecture.md", import.meta.url)),
  "utf8",
);

const ctx: Ctx = { tenantId: "architecture-doc-default-space" };

describe("docs/architecture.md §5.5 の LocalEmbeddingProvider の既定の空間は、実装と一致する", () => {
  it("provider・model・dimensions", async () => {
    const m = ARCHITECTURE_DOC.match(
      /外部サービスに繋がず、\s*ONNX のモデルをプロセス内・CPU で推論する\*\*（既定 `\{ provider: "([^"]+)",\s*model: "([^"]+)", dimensions: (\d+) \}`）/,
    );
    if (!m) throw new Error("docs/architecture.md §5.5 に既定の空間の記述が見つからない");
    const documented = { provider: m[1], model: m[2], dimensions: Number(m[3]) };

    // 偽の pipeline は、provider が宣言した次元のベクトルを返す（次元の検査を通すため）
    let provider: LocalEmbeddingProvider | undefined = undefined;
    const createPipeline: CreateLocalEmbeddingPipeline = async () => ({
      maxInputTokens: Number.MAX_SAFE_INTEGER,
      countTokens: (texts) => texts.map(() => 0),
      embed: async (texts) =>
        texts.map(() =>
          Array.from({ length: provider!.space.dimensions }, (_, i) => (i === 0 ? 1 : 0)),
        ),
    });
    provider = new LocalEmbeddingProvider({ createPipeline });

    expect({ ...provider.space }).toEqual(documented);
    const vectors = await provider.embed(ctx, ["本文"]);
    expect(vectors[0]).toHaveLength(documented.dimensions);
  });
});
