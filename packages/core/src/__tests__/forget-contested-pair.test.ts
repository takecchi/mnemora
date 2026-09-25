import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { MemoryId } from "../ids.js";
import type { Memory, MemoryStatus, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 再点火した負債の再現テスト。出典: ADR 0087「引き受けた負債」1、
 * ADR 0303「引き受けた負債」4/「これが覆るとしたら」。
 *
 * ADR 0087 決定時点は「`contested` を作る主体が本番コードに無い」ため負債は理論上のもの
 * だったが、ADR 0134（`runtime.markContested`）で実際に主体が入った。本ファイルは
 * `runtime.markContested`（公開 API）で本物の相互ペアを作り、片側を `runtime.forget`
 * したときに何が起きるかを、公開 API だけを使って観測する。
 *
 * ⚠ **この歯はバグを固定する歯ではない**——`forget` が contested の対向をどう扱うべきかは
 * まだ決まっていない（ADR 0087/0303 が明示的に「今は決めない」としている）。ここでは
 * 「現状こうなる」を記録するだけであり、期待値は「今の実装の出力」であって「あるべき姿」
 * ではない。将来この歯が赤くなったら、それは意味論が決まって実装が変わったということ。
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

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => NOW },
  });
  return { runtime, stores };
}

/**
 * `contested-pair-invariant.test.ts` の検査器そのもの（コピー。本番コードには無い
 * ——ADR 0046 の doc コメントのとおり「測るための道具は測る場所に置く」）。
 */
type ContestedInvariantViolation =
  | { kind: "contested_without_opposite"; memoryId: MemoryId }
  | { kind: "opposite_without_contested_status"; memoryId: MemoryId; status: MemoryStatus }
  | { kind: "opposite_missing"; memoryId: MemoryId; oppositeId: MemoryId }
  | { kind: "opposite_is_self"; memoryId: MemoryId }
  | {
      kind: "opposite_not_mutual";
      memoryId: MemoryId;
      oppositeId: MemoryId;
      oppositePointsTo: MemoryId | null;
    }
  | { kind: "opposite_shared"; memoryId: MemoryId; oppositeId: MemoryId; claimedBy: MemoryId[] };

function findContestedPairViolations(memories: readonly Memory[]): ContestedInvariantViolation[] {
  const byId = new Map(memories.map((m) => [m.id, m]));
  const claimants = new Map<MemoryId, MemoryId[]>();
  for (const m of memories) {
    if (m.contestedWithId) {
      claimants.set(m.contestedWithId, [...(claimants.get(m.contestedWithId) ?? []), m.id]);
    }
  }
  const violations: ContestedInvariantViolation[] = [];
  for (const m of memories) {
    const oppositeId = m.contestedWithId ?? null;
    if (m.status === "contested" && oppositeId === null) {
      violations.push({ kind: "contested_without_opposite", memoryId: m.id });
    }
    if (oppositeId === null) continue;
    if (m.status !== "contested") {
      violations.push({
        kind: "opposite_without_contested_status",
        memoryId: m.id,
        status: m.status,
      });
    }
    if (oppositeId === m.id) {
      violations.push({ kind: "opposite_is_self", memoryId: m.id });
      continue;
    }
    const opposite = byId.get(oppositeId);
    if (opposite === undefined) {
      violations.push({ kind: "opposite_missing", memoryId: m.id, oppositeId });
    }
    const oppositePointsTo = opposite === undefined ? null : (opposite.contestedWithId ?? null);
    if (opposite !== undefined && oppositePointsTo !== m.id) {
      violations.push({
        kind: "opposite_not_mutual",
        memoryId: m.id,
        oppositeId,
        oppositePointsTo,
      });
    }
    const others = claimants.get(oppositeId) ?? [];
    if (others.length > 1) {
      violations.push({ kind: "opposite_shared", memoryId: m.id, oppositeId, claimedBy: others });
    }
  }
  return violations;
}

/** `runtime.markContested`（公開 API）で本物の相互ペアを作る。 */
async function setupMarkContestedPair(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  runtime: ReturnType<typeof createRuntime>,
) {
  const a = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ status: "active", digest: "A" }),
  );
  const b = await stores.memoryStore.createMemory(
    ctx,
    newMemory({ status: "active", digest: "B" }),
  );
  const markResult = await runtime.markContested(ctx, a.id, b.id);
  expect(markResult).toEqual({
    supported: true,
    outcome: { kind: "contested", first: expect.anything(), second: expect.anything() },
  });
  return { a, b };
}

describe("再現: contested な対を forget すると対不変条件が壊れる（ADR 0087 負債1 / ADR 0303）", () => {
  it("① forget した側は forgotten になるが、対向は contested のまま・contestedWithId も残る", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupMarkContestedPair(stores, runtime);

    const forgetResult = await runtime.forget(ctx, { memoryId: b.id });
    expect(forgetResult.outcomes).toEqual([
      { memoryId: b.id, kind: "forgotten", previousStatus: "contested" },
    ]);

    const survivor = await stores.memoryStore.get(ctx, a.id);
    const forgotten = await stores.memoryStore.get(ctx, b.id);

    // 【観測】対向（a）は触られていない。
    expect(survivor?.status).toBe("contested");
    expect(survivor?.contestedWithId).toBe(b.id);
    // 【観測】forget した側自身の contestedWithId も消えない（forget は contestedWithId に触れない）。
    expect(forgotten?.status).toBe("forgotten");
    expect(forgotten?.contestedWithId).toBe(a.id);
  });

  it("② 対不変条件の検査器（ADR 0046）は違反として拾う", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupMarkContestedPair(stores, runtime);
    await runtime.forget(ctx, { memoryId: b.id });

    const memories = await stores.memoryStore.getMany(ctx, [a.id, b.id]);
    const violations = findContestedPairViolations(memories);

    // 【観測】b は「対向を指しているのに status が contested でない」で捕まる。
    expect(violations).toContainEqual({
      kind: "opposite_without_contested_status",
      memoryId: b.id,
      status: "forgotten",
    });
  });

  it("③ recall(): forget した対向（forgotten）が、生存側の必須同伴取得で結果に混入する", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupMarkContestedPair(stores, runtime);
    // a だけをベクタ検索で拾えるようにする。b は埋め込みを持たない
    // （= 段1の候補生成には出てこない。段3の必須同伴取得だけが b への経路になる)。
    await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, a.id, [1, 0]);

    await runtime.forget(ctx, { memoryId: b.id });

    const result = await runtime.recall(ctx, { vector: [1, 0] });
    const ids = result.memories.map((m) => m.memoryId);

    // 【観測】forgotten になったはずの b が、必須同伴取得（段3）を経由して
    // recall() の結果に出てくる——`forget()` は候補生成ゲート（段1、['active','contested']）
    // だけを塞いでおり、`contestedWithId` を辿る同伴取得（`getMany` 直呼び、status 無視）は
    // 塞いでいない。ADR 0087 決定6「forget が status を動かした時点で、recall 側は
    // 既に正しく振る舞う」は、この経路（同伴取得）には当てはまっていない。
    expect(ids).toContain(b.id);
    const companion = result.memories.find((m) => m.memoryId === b.id);
    expect(companion?.retrievedVia).toBe("mandatory_companion");

    const returnedB = await stores.memoryStore.get(ctx, b.id);
    expect(returnedB?.status).toBe("forgotten");
  });

  it("④ resolveContested: 生存側に対して呼んでも、対向が status_not_contested で ineligible のまま固まる", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupMarkContestedPair(stores, runtime);
    await runtime.forget(ctx, { memoryId: b.id });

    const result = await runtime.resolveContested(ctx, a.id, b.id, { kind: "both_active" });

    // 【観測】書き込みは起きない。a は永久に contested のまま取り残される
    // （対向を forget した後には、対向の id を知っていても解消する手段が無い）。
    expect(result).toEqual({
      supported: true,
      outcome: {
        kind: "ineligible",
        sides: [
          { memoryId: a.id, kind: "eligible" },
          { memoryId: b.id, kind: "status_not_contested", status: "forgotten" },
        ],
      },
    });

    const survivor = await stores.memoryStore.get(ctx, a.id);
    expect(survivor?.status).toBe("contested");
  });

  it("⑤ purge: forget 済みの対向をさらに purge しても、生存側の contested/contestedWithId は変わらない", async () => {
    const { runtime, stores } = buildRuntime();
    const { a, b } = await setupMarkContestedPair(stores, runtime);
    await runtime.forget(ctx, { memoryId: b.id });

    const purgeResult = await runtime.purge(ctx, { memoryId: b.id });
    // `purgeMemory` が fake store に実装されているかどうかで supported は決まる。
    // どちらであっても、a 側の状態には影響しないことだけを確かめる。
    void purgeResult;

    const survivor = await stores.memoryStore.get(ctx, a.id);
    expect(survivor?.status).toBe("contested");
    expect(survivor?.contestedWithId).toBe(b.id);
  });
});
