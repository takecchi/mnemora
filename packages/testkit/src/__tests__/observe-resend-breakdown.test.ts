import { describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryOutboxStore } from "../__fixtures__/in-memory-outbox-store.js";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

/**
 * ADR 0639: 冪等な再送（同じ `externalId` の Observation が既に在った）の `ObserveResult` には `resend` が付く。
 * 既存の欄（`memoryIds: []`・`extraction: 'skipped'`・ADR 0454 決定4 の3欄）は変えない。
 * `resend.memories` は `listBySourceObservationAllVersions` の写し（版も status も問わない・memoryId の昇順）。
 *
 * ⚠ このファイルは testkit の InMemory で走らせる。同じ本体を core の Fake
 * （`packages/core/src/__tests__/observe-resend-breakdown.test.ts`）と実 Postgres
 * （`packages/postgres/src/__tests__/observe-resend-breakdown.postgres.test.ts`）でも走らせている。
 * 3つの本体は同じ形に保つこと。
 */

interface Kit {
  /** 同じ store に繋がった runtime を、`extractorVersion` ごとに作る。 */
  runtimeFor: (
    extractorVersion: string,
    wrapMemoryStore?: (store: MemoryStore) => MemoryStore,
  ) => Runtime;
  memoryStore: MemoryStore;
}

/**
 * `listBySourceObservationAllVersions` の返す順を逆にする包み。口は「返す順序は規定しない」ので、
 * runtime が自分で昇順にしていることを、store の並びに頼らず確かめるために使う。
 */
function reverseListed(store: MemoryStore): MemoryStore {
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "listBySourceObservationAllVersions") {
        return async (...args: unknown[]) =>
          ((await (value as (...a: unknown[]) => Promise<unknown[]>).apply(target, args)) ?? [])
            .slice()
            .reverse();
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

let contents: string[] = ["X"];
let llmCalls = 0;
let gate: (() => Promise<void>) | undefined;

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    llmCalls += 1;
    const extracted = req.schema.parse({
      memories: contents.map((content) => ({ content, provenanceKind: "stated" })),
    });
    if (gate) await gate();
    return extracted;
  },
};

function makeInMemoryKit(): Kit {
  const memoryStore = new InMemoryMemoryStore();
  return {
    memoryStore,
    runtimeFor: (extractorVersion, wrapMemoryStore) =>
      createRuntime({
        llmProvider: llm,
        embeddingProvider: {
          space: { provider: "test", model: "resend", dimensions: 3 },
          embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
        },
        hashContent: (content: string) => `sha256(${content})`,
        memoryStore: wrapMemoryStore ? wrapMemoryStore(memoryStore) : memoryStore,
        vectorStore: new InMemoryVectorStore(memoryStore),
        eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
        outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
        tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        config: { extractorVersion },
      }),
  };
}

const ctx: Ctx = { tenantId: "observe-resend-breakdown" };
const LEASE = { kinds: ["extract" as const], leaseMs: 60_000 };

function defineTests(label: string, makeKit: () => Promise<Kit> | Kit): void {
  const input = (externalId: string, extra: Record<string, unknown> = {}) =>
    ({ kind: "utterance" as const, text: "発話", externalId, ...extra }) as const;

  describe(`${label}: 冪等な再送の内訳 resend（ADR 0639）`, () => {
    it("新しく作った呼び出しには resend が無い（sync・deferred とも）", async () => {
      contents = ["X"];
      const runtime = (await makeKit()).runtimeFor("v1");
      const sync = await runtime.observe(ctx, input("new-sync"));
      const deferred = await runtime.observe(ctx, input("new-deferred", { extract: "deferred" }));
      expect(sync).not.toHaveProperty("resend");
      expect(deferred).not.toHaveProperty("resend");
    });

    it("正常な再送には active の記憶が載り、既存の欄は変わらない（ADR 0454 決定4 の3欄も）", async () => {
      contents = ["A", "B"];
      const runtime = (await makeKit()).runtimeFor("v1");
      const full = input("resend-ok", {
        subjectCandidates: ["alice"],
        claimKey: { enabled: true, detectContested: true },
      });
      const first = await runtime.observe(ctx, full);
      expect(first.memoryIds).toHaveLength(2);
      const resend = await runtime.observe(ctx, full);
      expect(resend).toEqual({
        observationId: first.observationId,
        memoryIds: [],
        extraction: "skipped",
        extractionFailure: null,
        rejectedSubjectIds: [],
        claimKeyFailure: null,
        contestedDetection: [],
        resend: {
          memories: [...first.memoryIds]
            .sort()
            .map((memoryId) => ({ memoryId, status: "active", purged: false })),
        },
      });
    });

    it("forget の後の再送は forgotten・purged: false", async () => {
      contents = ["X"];
      const runtime = (await makeKit()).runtimeFor("v1");
      const first = await runtime.observe(ctx, input("resend-forget"));
      const memoryId = first.memoryIds[0]!;
      await runtime.forget(ctx, { memoryId });
      const resend = await runtime.observe(ctx, input("resend-forget"));
      expect(resend.memoryIds).toEqual([]);
      expect(resend.resend).toEqual({
        memories: [{ memoryId, status: "forgotten", purged: false }],
      });
    });

    it("purge の後の再送は purged: true（status は forgotten のまま）", async () => {
      contents = ["X"];
      const runtime = (await makeKit()).runtimeFor("v1");
      const first = await runtime.observe(ctx, input("resend-purge"));
      const memoryId = first.memoryIds[0]!;
      await runtime.forget(ctx, { memoryId });
      await runtime.purge(ctx, { memoryId });
      const resend = await runtime.observe(ctx, input("resend-purge"));
      expect(resend.resend).toEqual({
        memories: [{ memoryId, status: "forgotten", purged: true }],
      });
    });

    it("deferred で tick の前に再送すると memories: []、tick の後は載る", async () => {
      contents = ["X"];
      const runtime = (await makeKit()).runtimeFor("v1");
      const deferred = input("resend-deferred", { extract: "deferred" });
      const first = await runtime.observe(ctx, deferred);
      const before = await runtime.observe(ctx, deferred);
      expect(before).toMatchObject({ memoryIds: [], extraction: "skipped" });
      expect(before.resend).toEqual({ memories: [] });
      const tick = await runtime.tick(ctx, LEASE);
      expect(tick.processed).toBe(1);
      const after = await runtime.observe(ctx, deferred);
      expect(after.resend?.memories).toHaveLength(1);
      expect(after.observationId).toBe(first.observationId);
    });

    it("sync の observe が abort された後の再送も memories: []", async () => {
      contents = ["X"];
      const runtime = (await makeKit()).runtimeFor("v1");
      const controller = new AbortController();
      let release: () => void = () => {};
      let reached: () => void = () => {};
      const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
      gate = () =>
        new Promise<void>((resolve) => {
          release = resolve;
          reached();
        });
      const pending = runtime
        .observe(ctx, input("resend-abort"), { signal: controller.signal })
        .then(
          () => "resolved",
          () => "rejected",
        );
      await reachedPromise;
      controller.abort();
      expect(await pending).toBe("rejected");
      release();
      gate = undefined;
      const resend = await runtime.observe(ctx, input("resend-abort"));
      expect(resend).toMatchObject({ memoryIds: [], extraction: "skipped" });
      expect(resend.resend).toEqual({ memories: [] });
    });

    it("extractorVersion を上げた記憶（版違い）も載る", async () => {
      contents = ["A"];
      const kit = await makeKit();
      const v1 = kit.runtimeFor("v1");
      const first = await v1.observe(ctx, input("resend-version"));
      contents = ["B"];
      const v2 = kit.runtimeFor("v2");
      await v2.reextract(ctx, first.observationId);
      const all = await kit.memoryStore.listBySourceObservationAllVersions(
        ctx,
        first.observationId,
      );
      // 前提: 版違いの記憶が実際に2件在る。
      expect(new Set(all.map((m) => m.extractorVersion))).toEqual(new Set(["v1", "v2"]));
      const resend = await v2.observe(ctx, input("resend-version"));
      expect(resend.resend?.memories.map((m) => m.memoryId)).toEqual(all.map((m) => m.id).sort());
    });

    it("別テナントの記憶は載らない", async () => {
      contents = ["A"];
      const runtime = (await makeKit()).runtimeFor("v1");
      const other: Ctx = { tenantId: "observe-resend-breakdown-other" };
      const mine = await runtime.observe(ctx, input("resend-tenant"));
      contents = ["B", "C"];
      const theirs = await runtime.observe(other, input("resend-tenant"));
      expect(theirs.observationId).not.toBe(mine.observationId);
      const resend = await runtime.observe(ctx, input("resend-tenant"));
      expect(resend.resend?.memories.map((m) => m.memoryId)).toEqual(mine.memoryIds);
      const resendOther = await runtime.observe(other, input("resend-tenant"));
      expect(resendOther.resend?.memories.map((m) => m.memoryId)).toEqual(
        [...theirs.memoryIds].sort(),
      );
    });

    it("順序は memoryId の昇順", async () => {
      contents = ["a", "b", "c", "d", "e", "f"];
      const kit = await makeKit();
      const runtime = kit.runtimeFor("v1");
      const first = await runtime.observe(ctx, input("resend-order"));
      expect(first.memoryIds).toHaveLength(6);
      const ascending = [...first.memoryIds].sort();
      const resend = await runtime.observe(ctx, input("resend-order"));
      expect(resend.resend!.memories.map((m) => m.memoryId)).toEqual(ascending);
      // store が逆順で返しても、runtime が昇順にする（口は順序を規定しない）。
      const reversedStore = kit.runtimeFor("v1", reverseListed);
      const viaReversed = await reversedStore.observe(ctx, input("resend-order"));
      expect(viaReversed.resend!.memories.map((m) => m.memoryId)).toEqual(ascending);
    });

    it("再送は LLM を呼ばず、記憶を書き換えない", async () => {
      contents = ["A", "B"];
      const kit = await makeKit();
      const runtime = kit.runtimeFor("v1");
      const first = await runtime.observe(ctx, input("resend-readonly"));
      const before = await kit.memoryStore.listBySourceObservationAllVersions(
        ctx,
        first.observationId,
      );
      const calls = llmCalls;
      await runtime.observe(ctx, input("resend-readonly"));
      await runtime.observe(ctx, input("resend-readonly", { extract: "deferred" }));
      expect(llmCalls).toBe(calls);
      const after = await kit.memoryStore.listBySourceObservationAllVersions(
        ctx,
        first.observationId,
      );
      const byId = (ms: typeof before) => [...ms].sort((a, b) => (a.id < b.id ? -1 : 1));
      expect(byId(after)).toEqual(byId(before));
    });
  });
}

defineTests("testkit の InMemory", makeInMemoryKit);
