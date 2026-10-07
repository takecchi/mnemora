import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { OutboxStore } from "../interfaces/outbox-store.js";
import type { ObservationId } from "../ids.js";
import { createRuntime } from "../runtime.js";
import type { Runtime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/** 語の多い 1MB 超の本文は当てない: 保存できない候補の例にならない（Fake も testkit の fixture も、migration 0025 以降の Postgres も受け入れる）。 */

const ctx: Ctx = { tenantId: "extract-redelivery-unsaveable-fake" };
const LEASE_MS = 60_000;
const NUL = "二件目\u0000";
// 本文をそのまま写さない（NUL を hash に持ち込むと「NUL を写さない」の歯が hash で落ちる）。
const hashContent = (content: string) =>
  `h(${Array.from(content, (c) => c.codePointAt(0)).join(",")})`;

let nowMs = 0;
let llmCall = 0;
/** extract の LLM が順に返す本文（配列なら候補を複数）。`null` は LLM の失敗（全文フォールバックへ倒れる）。 */
let extractOutputs: Array<string | readonly string[] | null> = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "" }),
  completeStructured: async (_ctx, req) => {
    llmCall += 1;
    const next = extractOutputs.shift();
    if (next === null) throw new Error("LLM が落ちた");
    if (next === undefined) throw new Error(`unexpected LLM call ${llmCall}`);
    const contents = typeof next === "string" ? [next] : next;
    return req.schema.parse({
      memories: contents.map((content) => ({ content, provenanceKind: "stated" })),
    });
  },
};

function crashable(inner: OutboxStore): { store: OutboxStore; state: { crash: boolean } } {
  const state = { crash: false };
  return {
    state,
    store: {
      claimBatch: (c, opts) => inner.claimBatch(c, opts),
      complete: async (c, id, attempts) => {
        if (state.crash) throw new Error("ワーカーが止まった（complete の前）");
        return inner.complete(c, id, attempts);
      },
      fail: async (c, id, error, attempts) => {
        if (state.crash) throw new Error("ワーカーが止まった（fail の前）");
        return inner.fail(c, id, error, attempts);
      },
    },
  };
}

/** `hangOnCreate` が n なら、n 回目の `createMemoryWithOutbox` が決して返らない（プロセスが死んだのと同じ）。 */
function hangableMemory(inner: MemoryStore): {
  store: MemoryStore;
  state: { hangOnCreate: number; reached: Promise<void> };
} {
  let signal = () => {};
  const state = {
    hangOnCreate: 0,
    reached: new Promise<void>((resolve) => {
      signal = resolve;
    }),
  };
  let seen = 0;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (prop !== "createMemoryWithOutbox") return value.bind(target);
      return (...args: Parameters<MemoryStore["createMemoryWithOutbox"]>) => {
        if (state.hangOnCreate > 0) {
          seen += 1;
          if (seen === state.hangOnCreate) {
            state.hangOnCreate = 0;
            signal();
            return new Promise(() => {});
          }
        }
        return (value as MemoryStore["createMemoryWithOutbox"]).apply(target, args);
      };
    },
  });
  return { store, state };
}

function makeKit() {
  nowMs = Date.now() + 60_000;
  const stores = createFakeRuntimeStores();
  const hang = hangableMemory(stores.memoryStore);
  const crash = crashable(stores.outboxStore);
  const runtime: Runtime = createRuntime({
    memoryStore: hang.store,
    outboxStore: crash.store,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: llm,
    embeddingProvider: stores.embeddingProvider,
    hashContent,
    clock: { now: () => new Date(nowMs) },
  });
  return {
    runtime,
    stores,
    crash: crash.state,
    memoryHang: hang.state,
    contents: async (observationId: ObservationId, extractorVersion = "v1") =>
      (await stores.memoryStore.listBySourceObservation(ctx, observationId, extractorVersion))
        .map((m) => ({ status: m.status, content: m.content }))
        .sort((a, b) => a.content.localeCompare(b.content)),
    createdMetas: async () =>
      (await stores.eventStore.list(ctx, { kind: "created" })).map((e) => e.meta ?? {}),
  };
}
type Kit = ReturnType<typeof makeKit>;

/** 1回目の tick を「書いた後・complete の前」に落とし、リースを切らして2回目の tick で再配達する。 */
async function crashThenRedeliver(kit: Kit) {
  kit.crash.crash = true;
  await expect(kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS })).rejects.toThrow(
    /ワーカーが止まった/,
  );
  kit.crash.crash = false;
  nowMs += LEASE_MS * 2;
  const redelivered = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
  expect(redelivered.processed).toBe(1);
}

describe("core の Fake: 保存できない候補を含む抽出結果（#1063、ADR 0347）", () => {
  it("本文に NUL: その候補だけを落として残りを書き、observe は投げない。落とした候補は created の meta に残る", async () => {
    const kit = makeKit();
    extractOutputs = [["一件目の事実", NUL, "三件目の事実"]];
    const result = await kit.runtime.observe(ctx, { kind: "utterance", text: "発話" });
    expect(result.extraction).toBe("ok");
    expect(result.extractionFailure).toBeNull();
    expect(result.memoryIds).toHaveLength(2);
    expect((await kit.contents(result.observationId)).map((m) => m.content)).toEqual([
      "一件目の事実",
      "三件目の事実",
    ]);
    const tick = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
    expect({ processed: tick.processed, failed: tick.failed }).toEqual({ processed: 0, failed: 0 });
    const metas = await kit.createdMetas();
    expect(metas).toHaveLength(2);
    for (const meta of metas) {
      expect(meta.reason).toBe("extracted");
      const dropped = meta.droppedCandidates as Array<Record<string, unknown>>;
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatchObject({ index: 1, contentHash: hashContent(NUL), code: null });
      expect(typeof dropped[0]!.message).toBe("string");
      expect(JSON.stringify(dropped[0])).not.toContain("\\u0000");
    }
  });

  it("deferred の extract ジョブでも、保存できない候補だけを落として残りを書き、ジョブは完了する", async () => {
    const kit = makeKit();
    extractOutputs = [["一件目の事実", NUL, "三件目の事実"]];
    const { observationId } = await kit.runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      extract: "deferred",
    });
    nowMs += 1000;
    const tick = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
    expect({ processed: tick.processed, failed: tick.failed }).toEqual({ processed: 1, failed: 0 });
    expect((await kit.contents(observationId)).map((m) => m.content)).toEqual([
      "一件目の事実",
      "三件目の事実",
    ]);
  });

  it("全件が保存できなければ、今どおり observe は例外で、何も書かない", async () => {
    const kit = makeKit();
    extractOutputs = [
      [NUL, "三件目\u0000"],
      [NUL, "三件目\u0000"],
    ];
    const input = { kind: "utterance" as const, text: "発話", externalId: "all-bad" };
    await expect(kit.runtime.observe(ctx, input)).rejects.toThrow(/NUL/);
    const resent = await kit.runtime.observe(ctx, input);
    expect(resent.extraction).toBe("skipped");
    expect(await kit.contents(resent.observationId)).toEqual([]);
    expect(await kit.createdMetas()).toEqual([]);
    const early = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
    expect({ processed: early.processed, failed: early.failed }).toEqual({
      processed: 0,
      failed: 0,
    });
    nowMs += LEASE_MS * 2;
    const tick = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
    expect({ processed: tick.processed, failed: tick.failed }).toEqual({ processed: 0, failed: 1 });
  });

  it("正常な候補だけなら、今どおり全件を書き、created の meta も変わらない", async () => {
    const kit = makeKit();
    extractOutputs = [["一件目の事実", "二件目の事実", "三件目の事実"]];
    const result = await kit.runtime.observe(ctx, { kind: "utterance", text: "発話" });
    expect(result.memoryIds).toHaveLength(3);
    const metas = await kit.createdMetas();
    expect(metas).toHaveLength(3);
    for (const meta of metas) {
      expect(Object.keys(meta).sort()).toEqual(
        ["extractorVersion", "reason", "sourceObservationId"].sort(),
      );
    }
  });
});

describe("core の Fake: extract のジョブの逐次の再配達（#1092、ADR 0347）", () => {
  for (const [label, outputs, expectedContents] of [
    ["同じ本文（A → A）: 1件のまま", ["候補A", "候補A"], ["候補A"]],
    ["違う本文（A → B）: 2回目は書かず、1回目の A だけが残る", ["候補A", "候補B"], ["候補A"]],
    ["LLM の失敗 → A: 2回目は書かず、全文フォールバックだけが残る", [null, "候補A"], ["発話"]],
  ] as const) {
    it(label, async () => {
      const kit = makeKit();
      extractOutputs = [...outputs];
      const { observationId } = await kit.runtime.observe(ctx, {
        kind: "utterance",
        text: "発話",
        extract: "deferred",
      });
      nowMs += 1000;
      await crashThenRedeliver(kit);
      expect(extractOutputs).toEqual([outputs[1]]);
      expect(await kit.contents(observationId)).toEqual(
        expectedContents.map((content) => ({ status: "active", content })),
      );
      expect(await kit.createdMetas()).toHaveLength(expectedContents.length);
    });
  }

  for (const how of ["forget", "purge"] as const) {
    it(`1回目が書いた記憶を ${how} した後の再配達でも、LLM を呼ばず、active は増えず、忘れさせた内容は蘇らない`, async () => {
      const kit = makeKit();
      // 2回目の LLM が別の本文を返す形にする（呼ばれて書かれたら、B が active で現れて赤くなる）。
      extractOutputs = ["候補A", "候補B"];
      const { observationId } = await kit.runtime.observe(ctx, {
        kind: "utterance",
        text: "発話",
        extract: "deferred",
      });
      nowMs += 1000;
      kit.crash.crash = true;
      await expect(
        kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS }),
      ).rejects.toThrow(/ワーカーが止まった/);
      kit.crash.crash = false;
      const written = await kit.stores.memoryStore.listBySourceObservation(
        ctx,
        observationId,
        "v1",
      );
      expect(written.map((m) => m.status)).toEqual(["active"]);
      const target = { memoryId: written[0]!.id };
      await kit.runtime.forget(ctx, target);
      if (how === "purge") await kit.runtime.purge(ctx, target);
      nowMs += LEASE_MS * 2;
      const redelivered = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
      expect({ processed: redelivered.processed, failed: redelivered.failed }).toEqual({
        processed: 1,
        failed: 0,
      });
      expect(extractOutputs).toEqual(["候補B"]);
      const after = await kit.stores.memoryStore.listBySourceObservation(ctx, observationId, "v1");
      expect(after.map((m) => m.status)).toEqual(["forgotten"]);
      expect(after.some((m) => m.content === "候補B")).toBe(false);
      expect(await kit.createdMetas()).toHaveLength(1);
    });
  }

  it("1回目の配達は、今どおり抽出して書く", async () => {
    const kit = makeKit();
    extractOutputs = [["候補A", "候補B"]];
    const { observationId } = await kit.runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      extract: "deferred",
    });
    nowMs += 1000;
    const result = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
    expect(result.processed).toBe(1);
    expect(extractOutputs).toEqual([]);
    expect((await kit.contents(observationId)).map((m) => m.content)).toEqual(["候補A", "候補B"]);
  });

  it("同じ Observation に旧い抽出器の版の Memory しか無ければ、今どおり抽出する（#873）", async () => {
    const kit = makeKit();
    extractOutputs = ["候補A"];
    const { observationId } = await kit.runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      extract: "deferred",
    });
    const recordedAt = new Date(nowMs);
    await kit.stores.memoryStore.createMemory(ctx, {
      tenantId: ctx.tenantId,
      subjectId: null,
      sourceObservationId: observationId,
      extractorVersion: "v0",
      content: "旧い版の記憶",
      contentHash: "old-version",
      digest: "旧い版の記憶",
      digestSource: "llm",
      provenance: {
        kind: "stated",
        sourceObservationId: observationId,
        at: recordedAt.toISOString(),
      },
      tags: [],
      occurredAt: null,
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
      decayFloorAt: new Date(nowMs + 86_400_000),
      embeddingStatus: "pending",
    });
    nowMs += 1000;
    const result = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
    expect(result.processed).toBe(1);
    expect(extractOutputs).toEqual([]);
    expect((await kit.contents(observationId)).map((m) => m.content)).toEqual(["候補A"]);
    expect((await kit.contents(observationId, "v0")).map((m) => m.content)).toEqual([
      "旧い版の記憶",
    ]);
  });

  it("再配達で書かれなかった候補は、reextract で回復する（全文フォールバック → A）", async () => {
    const kit = makeKit();
    extractOutputs = [null, "候補A"];
    const { observationId } = await kit.runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      extract: "deferred",
    });
    nowMs += 1000;
    await crashThenRedeliver(kit);
    const reextracted = await kit.runtime.reextract(ctx, observationId);
    expect(reextracted.extraction).toBe("ok");
    expect(extractOutputs).toEqual([]);
    expect(await kit.contents(observationId)).toEqual([
      { status: "active", content: "候補A" },
      { status: "superseded", content: "発話" },
    ]);
  });

  it("1回目が候補の一部だけを書いて止まると、再配達は残りを書かず、reextract で回復する", async () => {
    const kit = makeKit();
    extractOutputs = [
      ["候補1", "候補2"],
      ["候補1", "候補2"],
    ];
    const { observationId } = await kit.runtime.observe(ctx, {
      kind: "utterance",
      text: "発話",
      extract: "deferred",
    });
    nowMs += 1000;
    kit.memoryHang.hangOnCreate = 2;
    void kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
    await kit.memoryHang.reached;
    nowMs += LEASE_MS * 2;
    const redelivered = await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
    expect(redelivered.processed).toBe(1);
    expect((await kit.contents(observationId)).map((m) => m.content)).toEqual(["候補1"]);
    expect(extractOutputs).toEqual([["候補1", "候補2"]]);
    await kit.runtime.reextract(ctx, observationId);
    expect(extractOutputs).toEqual([]);
    expect(await kit.contents(observationId)).toEqual([
      { status: "active", content: "候補1" },
      { status: "active", content: "候補2" },
    ]);
  });
});
