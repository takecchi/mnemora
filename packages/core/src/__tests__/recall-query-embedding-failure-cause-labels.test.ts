import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { StageSkippedOmission } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
const SECRET = "SECRET-user-data-12345";
const LABEL_MAX = 64;

async function causeWhenProviderThrows(thrown: unknown): Promise<StageSkippedOmission["cause"]> {
  const stores = createFakeRuntimeStores();
  const embeddingProvider: EmbeddingProvider = {
    space: stores.embeddingProvider.space,
    embed: async () => {
      throw thrown;
    },
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
    embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  const result = await runtime.recall(ctx, { text: "何かのクエリ" });
  const found = result.omitted.filter(
    (o): o is StageSkippedOmission =>
      o.kind === "stage_skipped" && o.reason === "embedding_provider_unavailable",
  );
  expect(found).toHaveLength(1);
  return found[0]!.cause;
}

describe("cause のラベルは先頭64文字まで（#1504 C4）", () => {
  it("100文字の name を持つ Error: errorName は64文字で切れる", async () => {
    const e = new Error(SECRET);
    e.name = "N".repeat(100);
    expect(await causeWhenProviderThrows(e)).toEqual({
      kind: "provider_threw",
      errorName: "N".repeat(LABEL_MAX),
    });
  });

  it("100文字の kind を持つ Error: providerErrorKind は64文字で切れる", async () => {
    const e = Object.assign(new Error(SECRET), { kind: "k".repeat(100) });
    expect(await causeWhenProviderThrows(e)).toEqual({
      kind: "provider_threw",
      errorName: "Error",
      providerErrorKind: "k".repeat(LABEL_MAX),
    });
  });

  it("64文字ちょうどは切らない（65文字は切る）", async () => {
    const exact = Object.assign(new Error(SECRET), { name: "a".repeat(64), kind: "b".repeat(64) });
    expect(await causeWhenProviderThrows(exact)).toEqual({
      kind: "provider_threw",
      errorName: "a".repeat(64),
      providerErrorKind: "b".repeat(64),
    });
    const over = Object.assign(new Error(SECRET), { name: "a".repeat(65), kind: "b".repeat(65) });
    expect(await causeWhenProviderThrows(over)).toEqual({
      kind: "provider_threw",
      errorName: "a".repeat(64),
      providerErrorKind: "b".repeat(64),
    });
  });
});

describe("Error でない値を投げたときの cause（#1504 C7・C8）", () => {
  it("C8: kind が文字列の素のオブジェクトでも providerErrorKind は載る", async () => {
    expect(await causeWhenProviderThrows({ kind: "input_too_long", detail: SECRET })).toEqual({
      kind: "provider_threw",
      providerErrorKind: "input_too_long",
    });
  });

  it("C7: name が文字列の素のオブジェクトの name は errorName に載らない（kind だけ載る）", async () => {
    expect(await causeWhenProviderThrows({ name: "Fake", kind: "x", detail: SECRET })).toEqual({
      kind: "provider_threw",
      providerErrorKind: "x",
    });
  });

  it("C7: name だけを持つ素のオブジェクトなら provider_threw のみ", async () => {
    expect(await causeWhenProviderThrows({ name: "Fake" })).toEqual({ kind: "provider_threw" });
  });
});
