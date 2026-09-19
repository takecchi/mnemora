import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ⭐ **段3.5（連想枠）の"席の取り合い"が、使用報告の有無で順位として分かれることの歯。**
 *
 * 正典 `docs/north-star.md`「目指す姿」項目4「使われない記憶が、静かに遠ざかる」の
 * **順位軸**を測る（Issue #402）。
 *
 * ## この歯が測るもの・測らないもの
 *
 * `recall-usage-selection.test.ts` が測るのは**ゲート軸**（`decayFloorAt` を割ったら
 * `recall()` から丸ごと落ちる）だけであり、その歯の doc コメント自身が「段3.5（連想枠）は
 * 閾値分割より後に走り、閾値を迂回する」「この歯はその穴に触れない」と明記している——
 * ⟹ 連想枠の**席（`maxCount`）の中の順位**が使用報告で動くかどうかは、
 * どちらの既存の歯（`recall-usage-selection.test.ts` / `recall-association.test.ts` /
 * `recall-association-gates.test.ts`）も測っていなかった。
 *
 * **この歯が測るのは、連想枠の席が「アンカー類似度だけ」ではなく
 * 「アンカー類似度 × decay（使用報告で押し上がる）」で埋まることだけである。**
 *
 * ⛔ **測らないもの**:
 * - 忘却ゲート（`decayFloorAt` を割って `recall()` 全体から落ちること）——
 *   それは `recall-usage-selection.test.ts` の射程であり、この歯では
 *   **両方とも生き残ったうえで順位だけが動く**ことを明示的に検算する（下）。
 * - スコア閾値（段2の `below_threshold`）——A・B はどちらもクエリには当たらない
 *   （below_threshold 相当）が、連想枠はそこを迂回する経路であり、この歯もその迂回の
 *   上に乗っている（`recall-association.test.ts` が既に固めている挙動）。
 * - `strength` / `tagMatch` / `freshness` が順位に効くこと——この歯は decay
 *   （＝使用報告で `lastReinforcedAt` が進む効果）だけを動かす。他の3項は
 *   A・B で完全に同条件にする。
 *
 * ## 形
 *
 * `recall-usage-selection.test.ts` と同型: `packages/core` 自身のテストなので
 * `@mnemora/testkit` には依存せず（`runtime-fakes.ts` 冒頭のコメントと同じ理由）、
 * DB を要さない。`Clock` を可変にし、「報告した時刻」と「読み直す時刻」を分ける。
 *
 * 3次元ベクトルを使う（連想枠の錨とその近傍を、クエリ方向とは別の軸に置くため）。
 * クエリ Q_vec = `[1, 0, 0]`。
 * - **アンカー**: `[0.8, 0.6, 0]`。クエリとの類似度 0.8 ⟹ 段2の閾値を超えて
 *   `withinLimit` に入り、連想の起点になる。
 * - **A・B**: どちらも `[0, 1, 0]`。クエリとの類似度は 0 ⟹ 段2の閾値で落ちる
 *   （`withinLimit` には入らない）。アンカーとの類似度は 0.6 ⟹ 既定 `minSimilarity`
 *   （0.5）を超えるので連想候補になる。**A と B は同一の vector**——アンカー類似度が
 *   完全に同値になることを、tie-break の土台として使う（decay 以外の差を残さない）。
 */

const T0 = new Date("2026-06-01T00:00:00.000Z");
/** 使用報告を撃つ時刻（＝最初の recall() で recallId を取る時刻でもある）。 */
const T1 = new Date("2026-06-05T00:00:00.000Z");
/** 読み直す時刻。順位を検算するのはここ。 */
const T2 = new Date("2026-06-20T00:00:00.000Z");

const ctx: Ctx = { tenantId: "tenant-1" };

/**
 * `recall-usage-selection.test.ts` の `buildRuntime` と同じ配線。違いは `clock` が
 * 可変であることだけ（`setNow` で進める）。
 */
function buildRuntime() {
  const stores = createFakeRuntimeStores();
  let now = T0;
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
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => now },
  });
  return {
    runtime,
    stores,
    setNow: (next: Date) => {
      now = next;
    },
  };
}

/**
 * アンカー用の半減期（10年）。連想の起点はクエリに直接当たる候補なので、`total`
 * （= similarity × decay × tagMatch × freshness × strength）が段2の閾値を割らないよう、
 * `recall-usage-selection.test.ts` と同じ理由で長くする。
 */
const ANCHOR_HALF_LIFE_HOURS = 24 * 365 * 10;

/**
 * A・B 用の半減期。**意図して短くする**——ここは `recall-usage-selection.test.ts` とは
 * 逆で、見たいのは「T2 で decay がはっきり差を持つこと」であって忘却ゲートではない
 * （A・B の忘却の床は下で T2 より十分先に置かれていることを歯の中で検算する）。
 * 150時間（6.25日）: T1→T2 の経過（15日=360時間）とT0→T2の経過（19日=456時間）の
 * 差が、decay = 0.5^(elapsed/halfLife) の比としてはっきり出る長さとして選んだ。
 */
const USAGE_HALF_LIFE_HOURS = 150;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? T0;
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? ANCHOR_HALF_LIFE_HOURS;
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
    // 既定は「一度も強化されていない」ときの床（recordedAt 起点）。使用報告される側は
    // `runtime.observe` 経由の `reinforce` が後で上書きする。
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "ready",
    ...overrides,
  };
}

async function createEmbeddedMemory(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  vector: number[],
  overrides: Partial<NewMemory> = {},
): Promise<Memory> {
  const memory = await stores.memoryStore.createMemory(ctx, newMemory(overrides));
  await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, memory.id, vector);
  return memory;
}

/** クエリ・アンカー・A/B の3次元ベクトル。冒頭 doc コメントと対応する。 */
const QUERY_VECTOR = [1, 0, 0];
const ANCHOR_VECTOR = [0.8, 0.6, 0];
const CANDIDATE_VECTOR = [0, 1, 0];

describe("recall() — 連想枠の席は、使用報告で decay が動くと順位が入れ替わる（Issue #402 順位軸）", () => {
  it("A だけ使用報告すると、maxCount:1 の席は A が取り、B は返らない", async () => {
    const { runtime, stores, setNow } = buildRuntime();

    const anchor = await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
    // A を先に作る——「報告が無ければ作成順で席が決まる」対照条件（it 3）の前提を、
    // ここでも同じ順序で保つ。
    const a = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "A",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });
    const b = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "B",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });

    setNow(T1);
    const baseline = await runtime.recall(ctx, { vector: QUERY_VECTOR, limit: 10 });
    const report = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: baseline.recallId,
      usedMemoryIds: [a.id],
    });
    expect(report.memoryIds).toEqual([a.id]);

    setNow(T2);

    // 🔴 検算: この歯で分かれてほしいのは順位であって忘却ゲートではない。
    // A（報告済み）・B（未報告）とも、T2 の時点で忘却の床（decayFloorAt）を
    // まだ割っていないことを、ゲート判定に頼らず直接確かめる。
    const aAfter = await stores.memoryStore.get(ctx, a.id);
    const bAfter = await stores.memoryStore.get(ctx, b.id);
    expect(aAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());
    expect(bAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());

    const result = await runtime.recall(ctx, {
      vector: QUERY_VECTOR,
      association: { maxCount: 1, anchorCount: 1 },
    });

    const memoryIds = result.memories.map((m) => m.memoryId);
    expect(memoryIds).toContain(a.id);
    expect(memoryIds).not.toContain(b.id);

    const aEntry = result.memories.find((m) => m.memoryId === a.id);
    expect(aEntry?.retrievedVia).toBe("association");
    expect(aEntry?.associationOf).toBe(anchor.id);

    expect(result.omitted).toContainEqual({
      kind: "over_limit",
      stage: "association",
      count: 1,
      countKind: "exact",
    });
  });

  it("⭐ B だけ使用報告すると（器も作成順も同一）、席は B が取る——勝者が入れ替わる", async () => {
    const { runtime, stores, setNow } = buildRuntime();

    await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
    const a = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "A",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });
    const b = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "B",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });

    setNow(T1);
    const baseline = await runtime.recall(ctx, { vector: QUERY_VECTOR, limit: 10 });
    // ⛔ ここが it 1 との唯一の違い——報告する側を B に入れ替える。
    const report = await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: baseline.recallId,
      usedMemoryIds: [b.id],
    });
    expect(report.memoryIds).toEqual([b.id]);

    setNow(T2);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    const bAfter = await stores.memoryStore.get(ctx, b.id);
    expect(aAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());
    expect(bAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());

    const result = await runtime.recall(ctx, {
      vector: QUERY_VECTOR,
      association: { maxCount: 1, anchorCount: 1 },
    });

    const memoryIds = result.memories.map((m) => m.memoryId);
    expect(memoryIds).toContain(b.id);
    expect(memoryIds).not.toContain(a.id);

    const bEntry = result.memories.find((m) => m.memoryId === b.id);
    expect(bEntry?.retrievedVia).toBe("association");
  });

  it("対照条件: どちらも使用報告しなければ、席は作成順（前置きの順）のまま——先に作った A が取る", async () => {
    const { runtime, stores, setNow } = buildRuntime();

    await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
    const a = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "A",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });
    const b = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "B",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });

    setNow(T1);
    // ⛔ ここで `observe({ kind: 'memory_usage' })` を一切呼ばない——それがこの対照条件である。
    await runtime.recall(ctx, { vector: QUERY_VECTOR, limit: 10 });

    setNow(T2);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    const bAfter = await stores.memoryStore.get(ctx, b.id);
    expect(aAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());
    expect(bAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());

    const result = await runtime.recall(ctx, {
      vector: QUERY_VECTOR,
      association: { maxCount: 1, anchorCount: 1 },
    });

    const memoryIds = result.memories.map((m) => m.memoryId);
    // 報告が無ければ decay は同値のまま——tie-break は前置き（アンカー類似度が同点の
    // ときの adapter 順序、ここでは insert 順）に委ねられ、先に作った A が席を取る。
    expect(memoryIds).toContain(a.id);
    expect(memoryIds).not.toContain(b.id);
  });

  it("maxCount:2 で両方返るとき、報告した側（＝後から作った B）が前に並ぶ——並びが作成順ではないことまで測る", async () => {
    const { runtime, stores, setNow } = buildRuntime();

    await createEmbeddedMemory(stores, ANCHOR_VECTOR, { digest: "アンカー" });
    const a = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "A",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });
    const b = await createEmbeddedMemory(stores, CANDIDATE_VECTOR, {
      digest: "B",
      halfLifeHours: USAGE_HALF_LIFE_HOURS,
    });

    setNow(T1);
    const baseline = await runtime.recall(ctx, { vector: QUERY_VECTOR, limit: 10 });
    // ⭐ **報告するのは後から作った B のほうである。**A を報告すると、順位キーが
    // 「アンカー類似度だけ」に退化していても A が先に並んでしまい（挿入順と一致する）、
    // この it は変異を素通しする——実際に一度そうなっていた【実測】。⟹ 報告先を B に
    // 倒すことで、「並びが作成順ではなく順位キーで決まっている」ことまで測る。
    await runtime.observe(ctx, {
      kind: "memory_usage",
      recallId: baseline.recallId,
      usedMemoryIds: [b.id],
    });

    setNow(T2);

    const aAfter = await stores.memoryStore.get(ctx, a.id);
    const bAfter = await stores.memoryStore.get(ctx, b.id);
    expect(aAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());
    expect(bAfter!.decayFloorAt.getTime()).toBeGreaterThan(T2.getTime());

    const result = await runtime.recall(ctx, {
      vector: QUERY_VECTOR,
      association: { maxCount: 2, anchorCount: 1 },
    });

    const memoryIds = result.memories.map((m) => m.memoryId);
    expect(memoryIds).toContain(a.id);
    expect(memoryIds).toContain(b.id);
    // ⚠ 段4/段5 を通った後の並びが連想枠内の順位をそのまま保つかは自明ではないため、
    // ここで現物として検算する。
    expect(memoryIds.indexOf(b.id)).toBeLessThan(memoryIds.indexOf(a.id));
  });
});
