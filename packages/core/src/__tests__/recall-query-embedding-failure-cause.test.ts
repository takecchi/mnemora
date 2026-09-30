import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { StageSkippedOmission } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `recall()` のクエリ埋め込みが失敗したとき、`embedding_provider_unavailable` の Omission に
 * 任意の `cause` が付き、原因の種類（4種）が返り値から読めること。
 *
 * - 既存の3欄（`kind` / `stage` / `reason`）と語彙検索への劣化は変わらない。
 * - `cause` には error の message・ベクトルの値を載せない。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const SECRET = "SECRET-user-data-12345";

function buildRuntime(
  embed: EmbeddingProvider["embed"] | undefined,
  options: { omitProvider?: boolean } = {},
) {
  const stores = createFakeRuntimeStores();
  const embeddingProvider: EmbeddingProvider = {
    space: stores.embeddingProvider.space,
    embed: embed ?? (async () => []),
  };
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: stores.lexicalStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    ...(options.omitProvider ? {} : { embeddingProvider }),
    hashContent: (content: string) => `sha256(${content})`,
  } as Parameters<typeof createRuntime>[0]);
  return { runtime, stores, dimensions: stores.embeddingProvider.space.dimensions };
}

async function unavailable(runtime: ReturnType<typeof buildRuntime>["runtime"]) {
  const result = await runtime.recall(ctx, { text: "何かのクエリ" });
  const found = result.omitted.filter(
    (o): o is StageSkippedOmission =>
      o.kind === "stage_skipped" && o.reason === "embedding_provider_unavailable",
  );
  expect(found).toHaveLength(1);
  return found[0] as StageSkippedOmission;
}

function expectBase(o: StageSkippedOmission) {
  expect(o).toMatchObject({
    kind: "stage_skipped",
    stage: "candidate_generation",
    reason: "embedding_provider_unavailable",
  });
  expect(JSON.stringify(o)).not.toContain(SECRET);
}

describe("recall() — 埋め込み失敗の原因が cause で読める", () => {
  it("provider が Error を投げた: provider_threw + errorName（message は載らない）", async () => {
    class BoomError extends Error {
      override name = "BoomError";
    }
    const { runtime } = buildRuntime(async () => {
      throw new BoomError(SECRET);
    });
    const o = await unavailable(runtime);
    expectBase(o);
    expect(o.cause).toEqual({ kind: "provider_threw", errorName: "BoomError" });
  });

  it("provider が kind を持つ値を投げた: providerErrorKind が載る", async () => {
    const { runtime } = buildRuntime(async () => {
      const e = new Error(SECRET) as Error & { kind: string };
      e.name = "LocalEmbeddingProviderError";
      e.kind = "input_too_long";
      throw e;
    });
    const o = await unavailable(runtime);
    expectBase(o);
    expect(o.cause).toEqual({
      kind: "provider_threw",
      providerErrorKind: "input_too_long",
      errorName: "LocalEmbeddingProviderError",
    });
  });

  it("provider が Error でない値を投げた: provider_threw のみ（kind が文字列でなければ載らない）", async () => {
    const { runtime } = buildRuntime(async () => {
      throw { kind: 42, detail: SECRET };
    });
    const o = await unavailable(runtime);
    expectBase(o);
    expect(o.cause).toEqual({ kind: "provider_threw" });
  });

  it("ベクトルを返さなかった: no_vector", async () => {
    const { runtime } = buildRuntime(async () => []);
    const o = await unavailable(runtime);
    expectBase(o);
    expect(o.cause).toEqual({ kind: "no_vector" });
  });

  it("次元違い: dimension_mismatch（ベクトルの値は載らない）", async () => {
    const { runtime } = buildRuntime(async () => [[0.123456, 0.654321, 0.5]]);
    const o = await unavailable(runtime);
    expectBase(o);
    expect(o.cause).toEqual({ kind: "dimension_mismatch" });
    expect(JSON.stringify(o)).not.toContain("0.123456");
  });

  it("非有限値: non_finite", async () => {
    const dims = buildRuntime(undefined).dimensions;
    const { runtime } = buildRuntime(async () => [Array.from({ length: dims }, () => Number.NaN)]);
    const o = await unavailable(runtime);
    expectBase(o);
    expect(o.cause).toEqual({ kind: "non_finite" });
  });

  it("embeddingProvider が無い: 既存の3欄は変わらず、cause は provider_threw（TypeError）", async () => {
    const { runtime } = buildRuntime(undefined, { omitProvider: true });
    const o = await unavailable(runtime);
    expectBase(o);
    expect(o.cause).toEqual({ kind: "provider_threw", errorName: "TypeError" });
  });

  it("既存の3欄は変わらない（cause 以外の欄が増えていない）", async () => {
    const { runtime } = buildRuntime(async () => []);
    const o = await unavailable(runtime);
    const { cause: _cause, ...rest } = o;
    expect(rest).toEqual({
      kind: "stage_skipped",
      stage: "candidate_generation",
      reason: "embedding_provider_unavailable",
    });
  });

  it("empty_query_content には cause が付かない", async () => {
    const { runtime } = buildRuntime(async () => []);
    const result = await runtime.recall(ctx, {});
    const o = result.omitted.find(
      (x) => x.kind === "stage_skipped" && x.reason === "empty_query_content",
    );
    expect(o).toBeDefined();
    expect(o).not.toHaveProperty("cause");
  });
});
