import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
  DEFAULT_LOCAL_EMBEDDING_REPO,
  LocalEmbeddingProvider,
} from "../local-embedding-provider.js";

/**
 * この歯が測っているもの: `repo` だけを既定から差し替え、`modelId` を渡さないと、
 * コンストラクタが throw すること（Issue #142 / ADR 0247）。
 *
 * ⛔ **この歯が捕まえないもの**（必ず読むこと）:
 *
 * - **実際に読み込まれた重みが `modelId` の名乗りと合っているかは見ていない。**
 *   縛っているのは**宣言どうしの整合**（`repo` を変えたら `modelId` も変えたか）だけである。
 *   ⟹ **本物の指紋照合**（既知の入力に対するベクトルの一致を確かめる。42MB のモデル取得が要る）
 *   **は別の話であり、Issue #142 に残る。**
 * - **`dtype` は対象にしていない。**量子化（`q8` / `fp32` 等）が変われば出てくるベクトルは
 *   変わりうるが、この guard は `dtype` を一切見ない。鳴らない。
 * - **既定の `repo` と `modelId` の組が「正しい」ことは、この歯は何も言っていない。**
 *   既定値そのものが間違っている可能性は、この歯の射程の外にある。
 *
 * ⭐ **DB も実 API も 42MB のダウンロードも要らない**——guard はコンストラクタで
 * 同期に鳴るので、`createPipeline`（pipeline 経路）を一切読まない。
 * ⟹ required な `typecheck / lint / test / build` に素直に乗る。
 *
 * ⛔ **既定の repo/modelId の文字列を literal で書かない**——差し替え側には、
 * 既定から確実に異なることだけが分かる値（`${DEFAULT_LOCAL_EMBEDDING_REPO}-OTHER`）を使う。
 * 焼き込んだ錨に頼ると、既定値が変わったときにこの歯が意味を失っていることに気づけない。
 */

const OTHER_REPO = `${DEFAULT_LOCAL_EMBEDDING_REPO}-OTHER`;
const OTHER_MODEL_ID = `${DEFAULT_LOCAL_EMBEDDING_MODEL_ID}-OTHER`;

describe("repo/modelId 宣言食い違い検査（コンストラクタ、Issue #142 / ADR 0247）", () => {
  it("既定のまま作れる（陽性対照——ここが落ちたら以下は何も測っていない）", () => {
    const provider = new LocalEmbeddingProvider();
    expect(provider.space.model).toBe(DEFAULT_LOCAL_EMBEDDING_MODEL_ID);
  });

  it("repo だけ差し替えると落ちる", () => {
    expect(() => new LocalEmbeddingProvider({ repo: OTHER_REPO })).toThrow();

    let message = "";
    try {
      new LocalEmbeddingProvider({ repo: OTHER_REPO });
    } catch (error) {
      message = (error as Error).message;
    }
    // ⚠ メッセージ全文の一致では縛らない（文面を直すたびに歯が壊れる）。
    // 個別に assert するのは (a) 渡した repo の値 (b) modelId という語
    // (c) space または EmbeddingSpaceId の語、の3点だけ。
    expect(message).toContain(OTHER_REPO);
    expect(message).toContain("modelId");
    expect(message).toMatch(/space|EmbeddingSpaceId/);
  });

  it("repo を差し替えても modelId を明示すれば通る（逃げ道が効く）", () => {
    const provider = new LocalEmbeddingProvider({ repo: OTHER_REPO, modelId: OTHER_MODEL_ID });
    expect(provider.space.model).toBe(OTHER_MODEL_ID);
  });

  it("既定と同じ repo を明示しても落ちない（誤検出しない）", () => {
    expect(() => new LocalEmbeddingProvider({ repo: DEFAULT_LOCAL_EMBEDDING_REPO })).not.toThrow();
  });

  it("modelId だけを差し替えるのは落ちない（この guard の範囲外である）", () => {
    const provider = new LocalEmbeddingProvider({ modelId: OTHER_MODEL_ID });
    expect(provider.space.model).toBe(OTHER_MODEL_ID);
  });
});
