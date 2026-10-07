import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * PR #1762（ADR 0640）は、core の Fake も「同じ口・同じ位置で」下限（4714-11-24 BC 00:00 UTC）より前を RangeError で断ると書いた。
 * PR の歯（`fake-written-timestamptz-floor.test.ts`）は代表の口だけで、`purgeMemory`・contested の6形・`reinforceMany`・
 * `recordUsageAndReinforce` はどれも縛られていなかった（イベントの検査は `assertBuildableFakeEvent` に集約されているので、
 * 口ごとの呼び出しが落ちても、代表の口が赤にする）。ここで、残りの口が断り、何も書かないことを縛る。
 */
const ctx: Ctx = { tenantId: "tenant-1" };
const FLOOR_MS = Date.UTC(-4713, 10, 24);
const EARLY = new Date(FLOOR_MS - 1);
const GOOD = new Date("2030-01-01T00:00:00.000Z");

const newMemory = (over: Partial<NewMemory> = {}): NewMemory => ({
  tenantId: ctx.tenantId,
  subjectId: null,
  sourceObservationId: null,
  extractorVersion: null,
  content: "本文",
  contentHash: "hash",
  digest: "digest",
  digestSource: "llm",
  provenance: { kind: "imported", batchId: "fixture" },
  tags: [],
  occurredAt: null,
  recordedAt: new Date("2020-01-01T00:00:00.000Z"),
  lastReinforcedAt: null,
  strength: 1,
  halfLifeHours: 720,
  decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
  embeddingStatus: "pending",
  ...over,
});
const evt = (
  memoryId: string | null,
  at: Date,
  kind: NewMemoryEvent["kind"] = "updated",
): NewMemoryEvent => ({
  tenantId: ctx.tenantId,
  memoryId: memoryId as never,
  kind,
  at,
  actor: { type: "system" },
  digestSnapshot: null,
  sizeBeforeBytes: null,
  meta: {},
});
const recall = () =>
  ({
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "q" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
  }) as never;

type Stores = ReturnType<typeof createFakeRuntimeStores>;

function stateOf(stores: Stores): string {
  const backing = Reflect.get(stores.memoryStore, "backing") as Record<string, unknown>;
  return JSON.stringify(backing, (_k, v: unknown) =>
    v instanceof Map ? [...v] : v instanceof Set ? [...v] : v,
  );
}

async function mk(stores: Stores, contentHash: string) {
  return stores.memoryStore.createMemory(ctx, newMemory({ contentHash }));
}

interface Port {
  name: string;
  prepare: (stores: Stores) => Promise<() => Promise<unknown>>;
}

const PORTS: Port[] = [
  {
    name: "purgeMemory の event.at",
    prepare: async (s) => {
      const m = await mk(s, "a");
      await s.memoryStore.updateStatus(ctx, m.id, "forgotten", {});
      return () =>
        s.memoryStore.purgeMemory(
          ctx,
          m.id,
          { content: "x", digest: "y" },
          evt(m.id, EARLY, "purged"),
        );
    },
  },
  {
    name: "markContestedPair の1つ目の event.at",
    prepare: async (s) => {
      const a = await mk(s, "a");
      const b = await mk(s, "b");
      return () =>
        s.memoryStore.markContestedPair(
          ctx,
          { id: a.id, event: evt(a.id, EARLY) },
          { id: b.id, event: evt(b.id, GOOD) },
        );
    },
  },
  {
    name: "markContestedPair の2つ目の event.at",
    prepare: async (s) => {
      const a = await mk(s, "a");
      const b = await mk(s, "b");
      return () =>
        s.memoryStore.markContestedPair(
          ctx,
          { id: a.id, event: evt(a.id, GOOD) },
          { id: b.id, event: evt(b.id, EARLY) },
        );
    },
  },
  ...[0, 1].map((index): Port => ({
    name: `resolveContestedPair の${index + 1}つ目の event.at`,
    prepare: async (s) => {
      const a = await mk(s, "a");
      const b = await mk(s, "b");
      await s.memoryStore.markContestedPair(
        ctx,
        { id: a.id, event: evt(a.id, GOOD) },
        { id: b.id, event: evt(b.id, GOOD) },
      );
      return () =>
        s.memoryStore.resolveContestedPair(
          ctx,
          { id: a.id, status: "active", event: evt(a.id, index === 0 ? EARLY : GOOD) },
          { id: b.id, status: "active", event: evt(b.id, index === 1 ? EARLY : GOOD) },
        );
    },
  })),
  ...[0, 2].map((index): Port => ({
    name: `markContestedGroup の${index + 1}件目の event.at`,
    prepare: async (s) => {
      const ms = [await mk(s, "a"), await mk(s, "b"), await mk(s, "c")];
      return () =>
        s.memoryStore.markContestedGroup!(
          ctx,
          ms.map((m, i) => ({ id: m.id, event: evt(m.id, i === index ? EARLY : GOOD) })),
        );
    },
  })),
  ...[0, 2].map((index): Port => ({
    name: `resolveContestedGroup の${index + 1}件目の event.at`,
    prepare: async (s) => {
      const ms = [await mk(s, "a"), await mk(s, "b"), await mk(s, "c")];
      await s.memoryStore.markContestedGroup!(
        ctx,
        ms.map((m) => ({ id: m.id, event: evt(m.id, GOOD) })),
      );
      return () =>
        s.memoryStore.resolveContestedGroup!(
          ctx,
          ms.map((m, i) => ({
            id: m.id,
            status: "active" as const,
            event: evt(m.id, i === index ? EARLY : GOOD),
          })),
        );
    },
  })),
  {
    name: "resolveOrphanedContested の event.at",
    prepare: async (s) => {
      const a = await mk(s, "a");
      const b = await mk(s, "b");
      await s.memoryStore.markContestedPair(
        ctx,
        { id: a.id, event: evt(a.id, GOOD) },
        { id: b.id, event: evt(b.id, GOOD) },
      );
      return () =>
        s.memoryStore.resolveOrphanedContested!(ctx, {
          id: a.id,
          contestedWithId: b.id,
          event: evt(a.id, EARLY),
        });
    },
  },
  {
    name: "reinforceMany の at",
    prepare: async (s) => {
      const m = await mk(s, "a");
      return () => s.memoryStore.reinforceMany!(ctx, [m.id], EARLY);
    },
  },
  {
    name: "recordUsageAndReinforce の at",
    prepare: async (s) => {
      const m = await mk(s, "a");
      const recallId = await s.memoryStore.createRecall(ctx, recall());
      return () => s.memoryStore.recordUsageAndReinforce!(ctx, recallId, [m.id], EARLY);
    },
  },
];

describe("FakeMemoryStore: 代表の歯に無い口も、下限より前の日時を RangeError で断り、何も書かない（ADR 0640）", () => {
  it.each(PORTS.map((p) => [p.name, p] as const))("%s", async (_name, port) => {
    const stores = createFakeRuntimeStores();
    const act = await port.prepare(stores);
    const before = stateOf(stores);
    const error = await act().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as RangeError).message).toMatch(/must not be earlier than 4714-11-24 BC/);
    expect(stateOf(stores)).toBe(before);
  });
});
