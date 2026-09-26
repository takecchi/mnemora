import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecallResult } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #959: 段3.5（連想枠）が拾った `contested` の記憶が、対向なしの単独で
 * `memories` に返っていた（原則1・`MemoryStore` の契約と食い違う。ADR 0136 が
 * 段3で塞いだのと同じ形の穴が、段3.5には無かった）。
 *
 * 採った案 (B)（ADR 0151 の 2026-09-27 追記）: 段3.5が選んだ contested にも、
 * 段3と同じ必須の同伴取得規則（`fetchMandatoryCompanions`、recall-runtime.ts 冒頭）を
 * かける。対向が取れれば2件を1 Unit に、取れなければ Unit ごと落として
 * `unit_assembly_dropped`（ADR 0043）を名乗る——段3と同じ札・同じ countKind。
 *
 * ## この歯が測るもの
 *
 * 1. **不変条件**（`assertNoLoneContested`）: `result.memories` に
 *    `status: "contested"` の記憶が、その `contestedWithId` の記憶を伴わずに
 *    含まれていたら赤。Issue #959 の最小再現・3組以上・channels 併用・
 *    attributes 絞り込み併用のすべてにこの歯を当てる。
 * 2. Issue #959 本文の最小再現が、修理後どう返るか（C1/C2 が1 Unit、印の付き方）。
 * 3. 対向が取れない形（attributes 絞り込みで外れる）で Unit ごと落ちること。
 * 4. 連想枠自身が両側を選んだときに重複しないこと（#823/#925 の排他性を壊さない）。
 *
 * `@mnemora/testkit` には依存しない（`runtime-fakes.ts` 冒頭のコメントと同じ理由——
 * このファイルも他の `recall-*.test.ts` と同型の足場を独立に持つ）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? NOW;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
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

function buildRuntime(opts: { wireLexicalStore?: boolean } = {}) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    lexicalStore: opts.wireLexicalStore ? stores.lexicalStore : undefined,
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
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ embeddingStatus: "ready", ...overrides }),
  );
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

/**
 * 🔴 この PR の中心の歯: `result.memories` に `status: "contested"` の記憶が、
 * その `contestedWithId` の記憶を伴わずに含まれていたら赤にする。
 *
 * `RecalledMemory` 自身は `status` を持たない（`contestedWith` は「対向が同じ結果に
 * 含まれるか」を名乗るだけで、元の Memory が contested だったかどうかを覆い隠す）ため、
 * 判定は `memoryStore.get` で元の `Memory.status`/`contestedWithId` を引き直して行う。
 */
async function assertNoLoneContested(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  result: RecallResult,
): Promise<void> {
  const returnedIds = new Set(result.memories.map((m) => m.memoryId));
  for (const recalled of result.memories) {
    const memory = await stores.memoryStore.get(ctx, recalled.memoryId);
    if (memory && memory.status === "contested" && memory.contestedWithId) {
      expect(
        returnedIds.has(memory.contestedWithId),
        `contested な ${memory.id}（digest: ${memory.digest}）が、対向 ${memory.contestedWithId} を伴わずに返っている`,
      ).toBe(true);
    }
  }
}

describe("recall() — 段3.5(連想枠)の contested 候補にも必須の同伴取得をかける（Issue #959、ADR 0151 2026-09-27 追記）", () => {
  it("🔴 Issue #959 最小再現: limit の外に落ちた contested が連想枠の候補になっても、対向なしの単独では返らない", async () => {
    const { runtime, stores } = buildRuntime();
    // Q: クエリの直接ヒット。limit:1 なので withinLimit に入るのはこれだけ。
    const q = await createEmbeddedMemory(stores, [1, 0, 0, 0], { digest: "Q" });
    // C1: withinLimit には入らないが、連想枠のアンカー(Q)には十分近い。
    const c1 = await createEmbeddedMemory(stores, [0.95, 0.05, 0, 0], { digest: "C1" });
    // C2: embedding を持たない——ANN/連想の検索では一度も見つからず、
    //     必須の同伴取得（getMany）だけが引ける対向。
    const c2 = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C2" }));

    const marked = await runtime.markContested(ctx, c1.id, c2.id);
    expect(marked.outcome.kind).toBe("contested");

    const result = await runtime.recall(ctx, { vector: [1, 0, 0, 0], limit: 1 });

    await assertNoLoneContested(stores, result);

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(q.id);
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c2.id);

    const c1Result = result.memories.find((m) => m.memoryId === c1.id);
    const c2Result = result.memories.find((m) => m.memoryId === c2.id);
    // C1 は連想枠が本来見つけていたとおり "association" のまま。
    expect(c1Result?.retrievedVia).toBe("association");
    expect(c1Result?.associationOf).toBe(q.id);
    // C2 は段3と同じ必須の同伴取得の印——mandatory_companion + companionOf。
    expect(c2Result?.retrievedVia).toBe("mandatory_companion");
    expect(c2Result?.companionOf).toBe(c1.id);
    // 両側に対称に contestedWith が付く（ADR 0335 の既存機構がそのまま働く）。
    expect(c1Result?.contestedWith).toBe(c2.id);
    expect(c2Result?.contestedWith).toBe(c1.id);
    // 対向は取れているので unit_assembly_dropped は出ない。
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });

  it("対向が attributes 絞り込みで外れて取得できないときは、Unit ごと落ちて unit_assembly_dropped を名乗る", async () => {
    const { runtime, stores } = buildRuntime();
    const q = await createEmbeddedMemory(stores, [1, 0, 0, 0], {
      digest: "Q",
      attributes: { tier: "gold" },
    });
    const c1 = await createEmbeddedMemory(stores, [0.95, 0.05, 0, 0], {
      digest: "C1",
      attributes: { tier: "gold" },
    });
    // C2 は絞り込みの外（tier: silver）——同伴取得の survivesAttributesFilter で落ちる。
    const c2 = await stores.memoryStore.createMemory(
      ctx,
      newMemory({ digest: "C2", attributes: { tier: "silver" } }),
    );
    const marked = await runtime.markContested(ctx, c1.id, c2.id);
    expect(marked.outcome.kind).toBe("contested");

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0, 0],
      limit: 1,
      attributes: { tier: "gold" },
    });

    await assertNoLoneContested(stores, result);
    const ids = result.memories.map((m) => m.memoryId);
    // Q 自身は絞り込みに合致しており、影響を受けない。
    expect(ids).toContain(q.id);
    expect(ids).not.toContain(c1.id);
    expect(ids).not.toContain(c2.id);
    expect(result.omitted).toContainEqual({
      kind: "unit_assembly_dropped",
      count: 1,
      countKind: "lower_bound",
    });
  });

  it("forget 済みの対向は同伴取得の対象にならない——生存側も単独では出ず Unit ごと落ちる", async () => {
    const { runtime, stores } = buildRuntime();
    const q = await createEmbeddedMemory(stores, [1, 0, 0, 0], { digest: "Q" });
    const c1 = await createEmbeddedMemory(stores, [0.95, 0.05, 0, 0], { digest: "C1" });
    const c2 = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C2" }));
    const marked = await runtime.markContested(ctx, c1.id, c2.id);
    expect(marked.outcome.kind).toBe("contested");
    await runtime.forget(ctx, { memoryId: c2.id });

    const result = await runtime.recall(ctx, { vector: [1, 0, 0, 0], limit: 1 });

    await assertNoLoneContested(stores, result);
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(q.id);
    expect(ids).not.toContain(c1.id);
    expect(ids).not.toContain(c2.id);
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped" && o.count >= 1)).toBe(
      true,
    );
  });

  it("連想枠自身が contested の両側を別々のアンカーから選んでも、1つの Unit にまとまり重複しない（#823/#925 の排他性を壊さない）", async () => {
    const { runtime, stores } = buildRuntime();
    const q = await createEmbeddedMemory(stores, [1, 0, 0, 0], { digest: "Q" });
    // p1・p2 はどちらも埋め込みを持ち、Q に近い——連想枠自身の ANN 検索で
    // どちらも独立に見つかる（同伴取得の getMany を経由しない）。
    const p1 = await createEmbeddedMemory(stores, [0.9, 0.1, 0, 0], { digest: "P1" });
    const p2 = await createEmbeddedMemory(stores, [0.85, 0.15, 0, 0], { digest: "P2" });
    const marked = await runtime.markContested(ctx, p1.id, p2.id);
    expect(marked.outcome.kind).toBe("contested");

    const result = await runtime.recall(ctx, { vector: [1, 0, 0, 0], limit: 1 });

    await assertNoLoneContested(stores, result);
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(q.id);
    // 重複していない（同じ memoryId が2回現れない）。
    expect(ids.filter((id) => id === p1.id)).toHaveLength(1);
    expect(ids.filter((id) => id === p2.id)).toHaveLength(1);
    expect(ids).toContain(p1.id);
    expect(ids).toContain(p2.id);
    // どちらも本来の経路（association）のまま——同伴取得の印は付かない
    // (段3の「両側とも独立に withinLimit に含まれていた」分岐と同じ形)。
    const p1Result = result.memories.find((m) => m.memoryId === p1.id);
    const p2Result = result.memories.find((m) => m.memoryId === p2.id);
    expect(p1Result?.retrievedVia).toBe("association");
    expect(p2Result?.retrievedVia).toBe("association");
    expect(p1Result?.companionOf).toBeUndefined();
    expect(p2Result?.companionOf).toBeUndefined();
    expect(p1Result?.contestedWith).toBe(p2.id);
    expect(p2Result?.contestedWith).toBe(p1.id);
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });

  it("3組以上の contested ペアが同時に連想枠へ入っても、すべて対を伴って返るか、揃って落ちる", async () => {
    const { runtime, stores } = buildRuntime();
    const q = await createEmbeddedMemory(stores, [1, 0, 0, 0], { digest: "Q" });
    const pairs: { a: Memory; b: Memory }[] = [];
    for (let i = 0; i < 4; i += 1) {
      // 各組の a 側だけ埋め込みを持たせる（連想の候補になる側）。b 側は同伴取得でだけ引ける。
      const a = await createEmbeddedMemory(stores, [0.9 - i * 0.01, 0.1 + i * 0.01, 0, 0], {
        digest: `A${i}`,
      });
      const b = await stores.memoryStore.createMemory(ctx, newMemory({ digest: `B${i}` }));
      const marked = await runtime.markContested(ctx, a.id, b.id);
      expect(marked.outcome.kind).toBe("contested");
      pairs.push({ a, b });
    }

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0, 0],
      limit: 1,
      association: { maxCount: 10 },
    });

    await assertNoLoneContested(stores, result);
    const ids = new Set(result.memories.map((m) => m.memoryId));
    expect(ids.has(q.id)).toBe(true);
    for (const { a, b } of pairs) {
      // 両方とも返るか、両方とも返らないかのどちらかであり、
      // 「a だけ・b だけ」という状態は無い。
      expect(ids.has(a.id)).toBe(ids.has(b.id));
    }
  });

  it("channels: ['ann','lexical'] を併用しても不変条件は崩れない", async () => {
    const { runtime, stores } = buildRuntime({ wireLexicalStore: true });
    const q = await createEmbeddedMemory(stores, [1, 0, 0, 0], {
      digest: "Q",
      content: "PROJ-9999 の定例メモ",
    });
    const c1 = await createEmbeddedMemory(stores, [0.95, 0.05, 0, 0], { digest: "C1" });
    const c2 = await stores.memoryStore.createMemory(ctx, newMemory({ digest: "C2" }));
    const marked = await runtime.markContested(ctx, c1.id, c2.id);
    expect(marked.outcome.kind).toBe("contested");

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0, 0],
      text: "PROJ-9999",
      limit: 1,
      channels: ["ann", "lexical"],
    });

    await assertNoLoneContested(stores, result);
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(q.id);
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c2.id);
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });

  it("⚠ 鳴ってはいけない側: 連想枠の候補が誰も contested でなければ、この修理は何も変えない", async () => {
    const { runtime, stores } = buildRuntime();
    const q = await createEmbeddedMemory(stores, [1, 0, 0, 0], { digest: "アンカー" });
    const associated = await createEmbeddedMemory(stores, [0.9, 0.1, 0, 0], { digest: "連想" });

    const result = await runtime.recall(ctx, { vector: [1, 0, 0, 0], limit: 1 });

    await assertNoLoneContested(stores, result);
    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(q.id);
    expect(ids).toContain(associated.id);
    const associatedResult = result.memories.find((m) => m.memoryId === associated.id);
    expect(associatedResult?.retrievedVia).toBe("association");
    expect(associatedResult?.companionOf).toBeUndefined();
    expect(associatedResult?.contestedWith).toBeUndefined();
    expect(result.omitted.some((o) => o.kind === "unit_assembly_dropped")).toBe(false);
  });
});
