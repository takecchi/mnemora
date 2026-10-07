import { describe, expect, it } from "vitest";
import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import { assertCassette, embeddingCassetteKey } from "../__fixtures__/cassette.js";
import { CassetteRecorder, RecordingEmbeddingProvider } from "../__fixtures__/cassette-recorder.js";
import { RecordedEmbeddingProvider } from "../__fixtures__/recorded-embedding-provider.js";
import { SeededEmbeddingProvider } from "../__fixtures__/seeded-provider.js";

const ctx: Ctx = { tenantId: "provider-fakes-align-edges" };
const SPACE: EmbeddingSpaceId = { provider: "p", model: "m", dimensions: 3 };

function seedSection() {
  const recorder = new CassetteRecorder();
  recorder.recordEmbedding(SPACE, "seeded", [7, 7, 7]);
  recorder.recordLLM("m", { messages: [{ role: "user", content: "p" }] }, { content: "seeded" });
  return recorder.toCassette();
}

describe("埋め込み空間は provider の名前だけが違っても断る", () => {
  it("SeededEmbeddingProvider: delegate の provider だけが種と違うと、構築で落ちる", () => {
    const seed = seedSection();
    const delegate: EmbeddingProvider = {
      space: { ...SPACE, provider: "other" },
      embed: async (_c, texts) => texts.map(() => [1, 1, 1]),
    };
    expect(
      () => new SeededEmbeddingProvider(delegate, { seed: seed.embedding, expectedSpace: SPACE }),
    ).toThrow(/委譲先/);
  });

  it("CassetteRecorder: 2回目以降の記録で provider だけが違うと、落ちる", () => {
    const recorder = new CassetteRecorder();
    recorder.recordEmbedding(SPACE, "a", [1, 2, 3]);
    expect(() => recorder.recordEmbedding({ ...SPACE, provider: "other" }, "b", [1, 2, 3])).toThrow(
      /違う埋め込み空間/,
    );
    expect(recorder.embeddingCount).toBe(1);
  });
});

describe("RecordingEmbeddingProvider: 返すベクトルは、呼び出しごと・記録・delegate の配列と別", () => {
  it("同じテキストを並列に呼んだ一方が返り値を書き換えても、他方・記録・delegate の配列に漏れない", async () => {
    const own = [1, 2, 3];
    const delegate: EmbeddingProvider = {
      space: SPACE,
      embed: async (_c, texts) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return texts.map(() => own);
      },
    };
    const recorder = new CassetteRecorder();
    const p = new RecordingEmbeddingProvider(delegate, recorder);
    const [a, b] = await Promise.all([p.embed(ctx, ["t"]), p.embed(ctx, ["t"])]);
    a[0]![0] = 999;
    expect(b[0]).toEqual([1, 2, 3]);
    expect(recorder.lookupEmbedding("t")?.vector).toEqual([1, 2, 3]);
    expect(own).toEqual([1, 2, 3]);
    own[1] = 555;
    expect(recorder.lookupEmbedding("t")?.vector).toEqual([1, 2, 3]);
  });
});

describe.each([[Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])(
  "成分が %s のベクトル",
  (bad) => {
    it("assertCassette は読んだ時点で落ちる", () => {
      const cassette = JSON.parse(JSON.stringify(seedSection())) as ReturnType<typeof seedSection>;
      const key = Object.keys(cassette.embedding.entries)[0]!;
      cassette.embedding.entries[key]!.vector[1] = bad;
      expect(() => assertCassette(cassette, "t")).toThrow(/有限の数でない/);
    });

    it("RecordedEmbeddingProvider.embed は返さずに落ちる", async () => {
      const section = {
        space: SPACE,
        entries: { [embeddingCassetteKey("a")]: { text: "a", vector: [1, bad, 3] } },
      };
      await expect(new RecordedEmbeddingProvider({ section }).embed(ctx, ["a"])).rejects.toThrow(
        /有限でない/,
      );
    });

    it("RecordingEmbeddingProvider は記録せずに落ちる", async () => {
      const recorder = new CassetteRecorder();
      const delegate: EmbeddingProvider = {
        space: SPACE,
        embed: async (_c, texts) => texts.map(() => [1, bad, 3]),
      };
      await expect(
        new RecordingEmbeddingProvider(delegate, recorder).embed(ctx, ["t"]),
      ).rejects.toThrow(/記録できない/);
      expect(recorder.embeddingCount).toBe(0);
    });
  },
);
