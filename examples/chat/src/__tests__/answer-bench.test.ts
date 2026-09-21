import { describe, expect, it } from "vitest";
import type { EmbeddingSpaceId } from "@mnemora/core";
import { embeddingSpaceSlug } from "../answer-bench.js";

/**
 * `embeddingSpaceSlug`（Issue #583）の unit 歯。DB を要求しない——
 * `EmbeddingSpaceId` から文字列を作るだけの純関数を見る。
 */
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

  // ⭐ これが (C) の芯——2つの異なる空間が、異なるスラグになること。
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
    // 英数字とハイフンだけであることを直接見る（tenantId・SQL 識別子どちらの
    // 文脈でも安全に埋め込める形）。
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
