import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { SourceMemoryForgottenError } from "../interfaces/memory-store.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）の #1493 のすり抜け B2・B7・B8（ADR 0406・0544）。
 * `reextract` は LLM を待つ間に、その Observation から出た記憶を読み直し（`getMany` ＋ LLM の前の門と同じ判定）、
 * 1件でも退けた状態なら書かずに打ち切る。core の Fake は `abortIfForgotten` を実装しないので、
 * この読み直しだけが保護になる（Postgres の歯は書き込みと同一トランザクションの見直しが先に効く）。
 *
 * - B2: 読み直す id が、先頭の1件だけになっていても既存の歯は赤にならなかった（歯が forget するのは先頭の記憶だった）。
 *   → 3件のうち先頭でも末尾でもない1件・末尾の1件だけを forget する。
 * - B8: 読み直しが `forgotten` だけになっても赤にならなかった（ADR 0544 が範囲を contested・訂正の解決で負けた
 *   superseded に広げた）。→ 待つ間に contested にした場合・訂正の解決で負けた場合を、それぞれ打ち切りにする。
 * - B7: 口の無い adapter（`supersedeWithNewMemories` が無い）のループで2件目の書き込みが打ち切られたとき、
 *   書いた分（1件目）を隠さず `atomicity: "store_unsupported"` で返す。
 */
const ctx: Ctx = { tenantId: "tenant-reextract-recheck" };

let contents: string[] = [];
let holding = false;
let release: () => void = () => {};
let reached: () => void = () => {};
let gate: Promise<void> = Promise.resolve();

function holdNextCall(): { stopped: Promise<void>; resume: () => void } {
  holding = true;
  gate = new Promise((resolve) => (release = resolve));
  const stopped = new Promise<void>((resolve) => (reached = resolve));
  return { stopped, resume: () => release() };
}

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    if (holding) {
      holding = false;
      reached();
      await gate;
    }
    return req.schema.parse({
      memories: contents.map((content) => ({ content, provenanceKind: "stated" as const })),
    });
  },
};

function buildKit() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    relationStore: stores.relationStore,
  });
  return { runtime, stores };
}

async function observeThree() {
  const kit = buildKit();
  contents = ["猫は3匹", "犬は1匹", "鳥は2羽"];
  const first = await kit.runtime.observe(ctx, {
    kind: "utterance",
    text: "猫は3匹、犬は1匹、鳥は2羽",
  });
  const ids = first.memoryIds;
  expect(ids).toHaveLength(3);
  return { ...kit, first, ids };
}

describe("reextract が LLM を待つ間の読み直しは、その Observation の全ての記憶を見る（#1493 B2）", () => {
  it.each([
    ["先頭", 0],
    ["中間", 1],
    ["末尾", 2],
  ])("3件のうち%sの1件だけを forget しても、何も書かれず打ち切られる", async (_label, index) => {
    const { runtime, stores, first, ids } = await observeThree();
    contents = ["全部で猫3匹・犬1匹・鳥2羽"];
    const hold = holdNextCall();
    const pending = runtime.reextract(ctx, first.observationId);
    await hold.stopped;
    expect((await runtime.forget(ctx, { memoryId: ids[index]! })).outcomes[0]?.kind).toBe(
      "forgotten",
    );
    hold.resume();
    const result = await pending;

    expect(result).toMatchObject({
      memoryIds: [],
      supersededMemoryIds: [],
      atomicity: "not_attempted",
      extraction: "skipped",
    });
    expect(result.skipped).toEqual([
      { kind: "status_not_active", memoryId: ids[index]!, status: "forgotten" },
    ]);
    // 残りの2件は置き換えられず、新しい記憶も書かれていない。
    const all = await stores.memoryStore.listBySourceObservationAllVersions(
      ctx,
      first.observationId,
    );
    expect(all).toHaveLength(3);
    for (const memory of all) {
      expect(memory.status).toBe(memory.id === ids[index] ? "forgotten" : "active");
    }
  });
});

describe("待つ間に contested になった・訂正の解決で負けた記憶も、打ち切りにする（#1493 B8、ADR 0544）", () => {
  it("待つ間に2件が contested になったら、書かずに打ち切る（skipped は contested の2件）", async () => {
    const { runtime, stores, first, ids } = await observeThree();
    contents = ["全部で猫3匹・犬1匹・鳥2羽"];
    const hold = holdNextCall();
    const pending = runtime.reextract(ctx, first.observationId);
    await hold.stopped;
    expect((await runtime.markContested(ctx, ids[0]!, ids[1]!)).outcome.kind).toBe("contested");
    hold.resume();
    const result = await pending;

    expect(result).toMatchObject({
      memoryIds: [],
      supersededMemoryIds: [],
      atomicity: "not_attempted",
      extraction: "skipped",
    });
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { kind: "status_not_active", memoryId: ids[0]!, status: "contested" },
        { kind: "status_not_active", memoryId: ids[1]!, status: "contested" },
      ]),
    );
    const all = await stores.memoryStore.listBySourceObservationAllVersions(
      ctx,
      first.observationId,
    );
    expect(all).toHaveLength(3);
  });

  it("待つ間に訂正の解決で負けて superseded になった記憶があれば、書かずに打ち切る", async () => {
    const { runtime, stores, first, ids } = await observeThree();
    contents = ["全部で猫3匹・犬1匹・鳥2羽"];
    const hold = holdNextCall();
    const pending = runtime.reextract(ctx, first.observationId);
    await hold.stopped;
    expect((await runtime.markContested(ctx, ids[0]!, ids[1]!)).outcome.kind).toBe("contested");
    const resolved = await runtime.resolveContested(ctx, ids[0]!, ids[1]!, {
      kind: "supersede",
      winnerId: ids[0]!,
    });
    expect(resolved.outcome.kind).toBe("resolved");
    hold.resume();
    const result = await pending;

    expect(result).toMatchObject({
      memoryIds: [],
      supersededMemoryIds: [],
      atomicity: "not_attempted",
      extraction: "skipped",
    });
    expect(result.skipped).toEqual([
      { kind: "status_not_active", memoryId: ids[1]!, status: "superseded" },
    ]);
    const all = await stores.memoryStore.listBySourceObservationAllVersions(
      ctx,
      first.observationId,
    );
    expect(all).toHaveLength(3);
  });

  it("対照: 待つ間に何も起きなければ、書かれて既存が置き換えられる（歯が空振りしない）", async () => {
    const { runtime, first, ids } = await observeThree();
    contents = ["全部で猫3匹・犬1匹・鳥2羽"];
    const hold = holdNextCall();
    const pending = runtime.reextract(ctx, first.observationId);
    await hold.stopped;
    hold.resume();
    const result = await pending;
    expect(result.extraction).toBe("ok");
    expect(result.memoryIds).toHaveLength(1);
    expect([...result.supersededMemoryIds].sort()).toEqual([...ids].sort());
  });
});

describe("口の無い adapter のループで2件目の書き込みが打ち切られたとき、書いた分を隠さない（#1493 B7）", () => {
  it("1件目の memoryIds を返し、atomicity は store_unsupported、既存は置き換えない", async () => {
    const { runtime, stores } = buildKit();
    contents = ["猫は3匹"];
    const first = await runtime.observe(ctx, { kind: "utterance", text: "猫は3匹いる" });
    const existing = first.memoryIds[0]!;

    // 口（supersedeWithNewMemories）を隠し、2件目の createMemoryWithOutbox だけ forget 済みとして打ち切らせる。
    Object.defineProperty(stores.memoryStore, "supersedeWithNewMemories", {
      value: undefined,
      configurable: true,
    });
    const real = stores.memoryStore.createMemoryWithOutbox.bind(stores.memoryStore);
    let calls = 0;
    stores.memoryStore.createMemoryWithOutbox = (async (...args: Parameters<typeof real>) => {
      calls += 1;
      if (calls === 2) throw new SourceMemoryForgottenError("createMemoryWithOutbox", [existing]);
      return real(...args);
    }) as typeof real;

    contents = ["猫を3匹飼っている", "犬を1匹飼っている"];
    const result = await runtime.reextract(ctx, first.observationId);

    expect(calls).toBe(2);
    expect(result.memoryIds).toHaveLength(1);
    expect(result.atomicity).toBe("store_unsupported");
    expect(result.extraction).toBe("ok");
    expect(result.supersededMemoryIds).toEqual([]);
    expect(result.skipped).toEqual([
      { kind: "status_not_active", memoryId: existing, status: "forgotten" },
    ]);
    // 1件目は実際に書かれている（戻り値がそれを名乗っている）。
    const written = await stores.memoryStore.get(ctx, result.memoryIds[0]!);
    expect(written?.status).toBe("active");
    expect((await stores.memoryStore.get(ctx, existing))?.status).toBe("active");
  });
});
