import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { MemoryStatusConflictError } from "../interfaces/memory-store.js";
import type { Memory, NewMemory } from "../memory.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 本物の Postgres とテスト用の fixture に当てる歯は `packages/postgres/src/__tests__/uppercase-uuid-contested-runtime.postgres.test.ts`。
 * core の Fake は大文字小文字を区別しないので、この歯は Fake の `memoryStore` の口を1つだけ差し替えて、
 * 「store が別の記憶を返す」「相手が見つからない」「store の id が大文字を含む」を作る（群版の歯 `resolve-contested-group.test.ts` と同じ流儀）。
 */

const ctx: Ctx = { tenantId: "tenant-rc-spelling" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

type Stores = ReturnType<typeof createFakeRuntimeStores>;
type MemoryStoreOverrides = Partial<Pick<Stores["memoryStore"], "get" | "getMany">> & {
  resolveContestedPair?: unknown;
};

/** Fake の `memoryStore` の口をいくつか差し替えた store で Runtime を組む（差し替えない口は Fake のまま）。 */
function buildRuntime(overrides: (stores: Stores) => MemoryStoreOverrides = () => ({})) {
  const stores = createFakeRuntimeStores();
  const memoryStore = Object.create(stores.memoryStore) as Stores["memoryStore"];
  Object.assign(memoryStore, overrides(stores));
  const runtime = createRuntime({
    memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
    relationStore: stores.relationStore,
  });
  return { runtime, stores };
}

async function createContestedPair(stores: Stores) {
  const a = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "A" }));
  const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "B" }));
  // 対にするのは、差し替えていない Fake の Runtime で行う（歯の対象は解決の側）。
  const plain = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
    relationStore: stores.relationStore,
  });
  const marked = await plain.markContested(ctx, a.id, b.id);
  expect(marked.outcome.kind).toBe("contested");
  return { a, b };
}

const upper = (id: string) => id.toUpperCase();

describe("resolveContested（2者版）の winnerId が片側と大文字小文字だけ違うとき", () => {
  it("store の get が winnerId について別の記憶を返すなら、RangeError を投げ、何も書かない", async () => {
    let bId = "";
    const { runtime, stores } = buildRuntime((s) => ({
      // winnerId（大文字の綴り）として引いたときだけ、別の記憶 b を返す。
      get: (async (c: Ctx, id: string) =>
        id === id.toUpperCase() && id !== id.toLowerCase()
          ? s.memoryStore.get(c, bId)
          : s.memoryStore.get(c, id)) as Stores["memoryStore"]["get"],
    }));
    const { a, b } = await createContestedPair(stores);
    bId = b.id;

    await expect(
      runtime.resolveContested(ctx, a.id, b.id, { kind: "supersede", winnerId: upper(a.id) }),
    ).rejects.toThrow(RangeError);

    for (const id of [a.id, b.id]) {
      expect((await stores.memoryStore.get(ctx, id))?.status).toBe("contested");
    }
  });

  it("やりすぎの歯: store が同じ記憶と言えば勝者として扱い、敗者は勝者の id を持つ", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await createContestedPair(stores);

    const result = await runtime.resolveContested(ctx, a.id, b.id, {
      kind: "supersede",
      winnerId: upper(a.id),
    });

    expect(result.outcome.kind).toBe("resolved");
    const loser = await stores.memoryStore.get(ctx, b.id);
    expect([loser?.status, loser?.supersededById]).toEqual(["superseded", a.id]);
  });

  it("firstId と secondId が同じ記憶の2つの綴りで、winnerId が第3の綴りなら、救済せず RangeError（store は読まない）", async () => {
    const calls: string[] = [];
    const { runtime, stores } = buildRuntime((s) => ({
      get: (async (c: Ctx, id: string) => {
        calls.push(id);
        return s.memoryStore.get(c, id);
      }) as Stores["memoryStore"]["get"],
    }));
    const { a, b } = await createContestedPair(stores);
    // どちらの側とも文字列として一致しない綴り（先頭の英字だけ大文字）。
    const third = a.id.replace(/[a-z]/, (ch) => ch.toUpperCase());
    expect([third === a.id, third === upper(a.id)]).toEqual([false, false]);

    await expect(
      runtime.resolveContested(ctx, a.id, upper(a.id), { kind: "supersede", winnerId: third }),
    ).rejects.toThrow(RangeError);

    expect(calls).toEqual([]);
    for (const id of [a.id, b.id]) {
      expect((await stores.memoryStore.get(ctx, id))?.status).toBe("contested");
    }
  });
});

describe("resolveContested（2者版）の競合の読み直しは、store が返した id を渡された id と突き合わせる", () => {
  it("store の id が大文字を含んでいても、conflict の observedStatus は読み直した記憶の status になる", async () => {
    // 大文字を含む id を返す store（大文字小文字を区別せずに引け、保存した綴りで返す store）を模す。
    const asStored = (m: Memory): Memory => ({
      ...m,
      id: upper(m.id),
      contestedWithId:
        typeof m.contestedWithId === "string" ? upper(m.contestedWithId) : m.contestedWithId,
    });
    const { runtime, stores } = buildRuntime((s) => ({
      getMany: (async (c: Ctx, ids: string[]) =>
        (
          await s.memoryStore.getMany(
            c,
            ids.map((id) => id.toLowerCase()),
          )
        ).map(asStored)) as Stores["memoryStore"]["getMany"],
      // 両側が eligible と読めたあとで、書き込みが競合した（別の書き込みが割り込んだ）ことにする。
      resolveContestedPair: async () => {
        throw new MemoryStatusConflictError("any", "contested", "active");
      },
    }));
    const { a, b } = await createContestedPair(stores);

    const result = await runtime.resolveContested(ctx, upper(a.id), upper(b.id), {
      kind: "both_active",
    });

    expect(result.outcome).toEqual({
      kind: "conflict",
      conflicts: [
        { id: upper(a.id), observedStatus: "contested" },
        { id: upper(b.id), observedStatus: "contested" },
      ],
    });
  });
});

describe("resolveContested（2者版）で相手が見つからないときの相互参照の突き合わせ", () => {
  /** `hidden` の id（大文字小文字は無視）を `getMany` の戻りから外す。 */
  const hiding = (hidden: () => string) => (s: Stores) => ({
    getMany: (async (c: Ctx, ids: string[]) =>
      (await s.memoryStore.getMany(c, ids)).filter(
        (m) => m.id.toLowerCase() !== hidden().toLowerCase(),
      )) as Stores["memoryStore"]["getMany"],
  });

  it("相手が見つからなければ、contestedWithId を渡された相手の id と比べる（一致すれば eligible のまま）", async () => {
    let bId = "";
    const { runtime, stores } = buildRuntime(hiding(() => bId));
    const { a, b } = await createContestedPair(stores);
    bId = b.id;

    const result = await runtime.resolveContested(ctx, a.id, b.id, { kind: "both_active" });

    expect(result.outcome).toEqual({
      kind: "ineligible",
      sides: [
        { memoryId: a.id, kind: "eligible" },
        { memoryId: b.id, kind: "not_found" },
      ],
    });
  });

  it("相手が見つからず、渡された相手の id が contestedWithId と綴りまで同じでなければ、pair_broken", async () => {
    let bId = "";
    const { runtime, stores } = buildRuntime(hiding(() => bId));
    const { a, b } = await createContestedPair(stores);
    bId = b.id;

    const result = await runtime.resolveContested(ctx, a.id, upper(b.id), { kind: "both_active" });

    expect(result.outcome).toEqual({
      kind: "ineligible",
      sides: [
        { memoryId: a.id, kind: "pair_broken", contestedWithId: b.id },
        { memoryId: upper(b.id), kind: "not_found" },
      ],
    });
  });
});
