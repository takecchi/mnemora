import { describe, expect, it } from "vitest";
import type { EmbeddingSpaceId } from "@mnemora/core";
import { describeZeroPresented, embeddingSpaceSlug } from "../answer-bench.js";

describe("embeddingSpaceSlug", () => {
  it("openai の空間から provider-model-dimensions 形のスラグを作る", () => {
    const space: EmbeddingSpaceId = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 256,
    };
    expect(embeddingSpaceSlug(space)).toBe("openai-text-embedding-3-small-256");
  });

  it("testkit の deterministic 空間から短いスラグを作る", () => {
    const space: EmbeddingSpaceId = {
      provider: "testkit",
      model: "deterministic",
      dimensions: 8,
    };
    expect(embeddingSpaceSlug(space)).toBe("testkit-deterministic-8");
  });

  it("異なる空間は異なるスラグになる", () => {
    const a: EmbeddingSpaceId = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 256,
    };
    const b: EmbeddingSpaceId = { provider: "testkit", model: "deterministic", dimensions: 8 };
    expect(embeddingSpaceSlug(a)).not.toBe(embeddingSpaceSlug(b));
  });

  it("次元だけが違う空間も異なるスラグになる", () => {
    const a: EmbeddingSpaceId = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 256,
    };
    const b: EmbeddingSpaceId = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
    };
    expect(embeddingSpaceSlug(a)).not.toBe(embeddingSpaceSlug(b));
  });

  it("'.' や '/' などの記号を含む入力を潰す——tenantId に入れたくない文字を残さない", () => {
    const space: EmbeddingSpaceId = {
      provider: "local",
      model: "Xenova/multilingual-e5-small@1.0",
      dimensions: 384,
    };
    const slug = embeddingSpaceSlug(space);
    expect(slug).toBe("local-xenova-multilingual-e5-small-1-0-384");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug).not.toMatch(/[./]/);
  });

  it("先頭・末尾・連続する記号はハイフンの重複や余りを残さない", () => {
    const space: EmbeddingSpaceId = { provider: "-openai-", model: "a..b//c", dimensions: 3 };
    const slug = embeddingSpaceSlug(space);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.startsWith("-")).toBe(false);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).not.toContain("--");
  });
});

describe("describeZeroPresented", () => {
  const belowThresholdRecall = {
    index: { groups: [], totalInScope: 2, countKind: "exact" as const },
    memories: [],
    omitted: [
      {
        kind: "below_threshold" as const,
        count: 2,
        countKind: "exact" as const,
        nearMisses: [
          { memoryId: "m1", score: 0.07 },
          { memoryId: "m2", score: 0.05 },
        ],
      },
      {
        kind: "stage_skipped" as const,
        stage: "association" as const,
        reason: "no_anchor" as const,
      },
    ],
  };

  it("提示が1件以上なら何も言わない（null）", () => {
    expect(
      describeZeroPresented("t", "space", {
        ...belowThresholdRecall,
        memories: [{}] as never,
      }),
    ).toBeNull();
  });

  it("候補に「関連度が閾値に届かなかった」を含む", () => {
    const text = describeZeroPresented("t", "space", belowThresholdRecall as never);
    expect(text).toContain("閾値");
    expect(text).not.toContain("どちらかは、この行だけでは決まらない");
  });

  it("この recall が実際に返した omitted の内訳を並べる", () => {
    const text = describeZeroPresented("t", "space", belowThresholdRecall as never);
    expect(text).toContain("below_threshold×2");
    expect(text).toContain("stage_skipped(association:no_anchor)");
  });
});
