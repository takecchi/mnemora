import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #949（ADR 0203 追記3「範囲外と分かったこと」1番目が実測だけして直していなかった経路）。
 *
 * 直前の一連の修正（Issue #823/#925/#940）は、`over_limit(stage:"rescore")` の候補が
 * 段3（`companions`）または段3.5（連想、`associationUnits`）へ**実際に席を得て**
 * 昇格した場合だけを扱っていた。本ファイルが固定するのは、段3.5 の候補プールに
 * 入ったが**席に着けなかった**候補——(a) `rankedCandidates` には居たが `maxCount` の
 * 席を他候補に取られた、(b) 過取得の窓（`rankFetchHits`）の外に居た——が、
 * `over_limit(stage:"rescore")` からは差し引かれないまま
 * `over_limit(stage:"association")` にも数えられる（同じ1件が両方に載る）経路である。
 *
 * (c) は、連想の近傍に一度も現れていない `over_limit(stage:"rescore")` のバイスタンダーが
 * 巻き込まれずに残ることを確かめる、過剰実装を捕まえる歯。
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

function buildRuntime() {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
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

// owner を [1, 0] に置き、クエリベクトルも [1, 0] にする——owner はクエリと完全一致する
// ので、cos(x, owner) と cos(x, query) が常に同じ値になる（owner の第1成分がそのまま
// クエリとの類似度、かつ連想アンカーとの類似度でもある）。これにより、各候補の
// 「クエリでの順位」と「アンカー owner への近さ」を同じ1つの数（第1成分 c）で同時に
// 制御できる——2つの類似度を別々に組み立てる必要がない。
// vector(c) = [c, sqrt(1 - c^2)]（単位ベクトル、cos(vector(c), [1,0]) = c）。
function vec(c: number): [number, number] {
  return [c, Math.sqrt(1 - c * c)];
}

/**
 * 共通フィクスチャ: owner（アンカー、c=1.0） + 4件のフィラー（c=0.95/0.90/0.85/0.80、
 * limit=5 の残り4席を占めて withinLimit を owner+フィラーで満杯にする） + C1（c=0.65）+
 * T（c=0.60、本命の検証対象）。
 *
 * limit=5 なので withinLimit = {owner, F1, F2, F3, F4}（上位5件）、C1・T は
 * over_limit(stage:"rescore") へ回る。C1・T はどちらも owner への類似度が既定の
 * minSimilarity（0.5）を超えるので、段3.5 の連想候補プール（アンカー owner の近傍）に
 * 入る——除外集合（withinLimit + companions + アンカー自身）に over_limit の候補は
 * 入っていないため（ADR 0203「引き受けた負債」2番）。
 *
 * `withD` を渡すと、owner への類似度が 0.30（minSimilarity 未満）のバイスタンダー D も
 * 追加する——D は連想の近傍に一度も現れない over_limit(stage:"rescore") 候補になる。
 */
async function createFixture(stores: ReturnType<typeof createFakeRuntimeStores>, withD: boolean) {
  const owner = await createEmbeddedMemory(stores, vec(1.0), { digest: "owner" });
  const f1 = await createEmbeddedMemory(stores, vec(0.95), { digest: "F1" });
  const f2 = await createEmbeddedMemory(stores, vec(0.9), { digest: "F2" });
  const f3 = await createEmbeddedMemory(stores, vec(0.85), { digest: "F3" });
  const f4 = await createEmbeddedMemory(stores, vec(0.8), { digest: "F4" });
  const c1 = await createEmbeddedMemory(stores, vec(0.65), { digest: "C1" });
  const t = await createEmbeddedMemory(stores, vec(0.6), { digest: "T" });
  const d = withD ? await createEmbeddedMemory(stores, vec(0.3), { digest: "D" }) : undefined;
  return { owner, f1, f2, f3, f4, c1, t, d };
}

describe("recall() — over_limit(stage:'rescore') の候補が段3.5（連想）の候補プールに入ったが席に着けなかったときの排他性（Issue #949）", () => {
  it("(a) 過取得の窓には入ったが maxCount の席を競り負けたときは、over_limit(stage:'rescore') からも差し引かれる", async () => {
    const { runtime, stores } = buildRuntime();
    const { owner, c1, t } = await createFixture(stores, false);

    // overFetchFactor=2.0: rankFetchCount = max(1, round(1*2)) = 2 —— C1・T の
    // associationHits（2件）が両方とも窓に入り、maxCount=1 の席を similarity で競う。
    // C1（0.65）が T（0.60）に勝つ——T は「土俵に上がって競り負けた」形になる。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 5,
      overFetchFactor: 2.0,
      association: { maxCount: 1, anchorCount: 1 },
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedC1 = result.memories.find((m) => m.memoryId === c1.id);
    expect(returnedC1).toBeDefined();
    expect(returnedC1?.retrievedVia).toBe("association");
    const returnedT = result.memories.find((m) => m.memoryId === t.id);
    expect(returnedT).toBeUndefined();

    // 修正前: over_limit(stage:"rescore") は C1 の分だけ既存処理で差し引かれ、T の分は
    // 残ったまま count: 1 になる。修正後: T の分も差し引かれ、Omission 自体が消える。
    const overLimitRescore = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "rescore",
    );
    expect(overLimitRescore).toBeUndefined();

    // T は over_limit(stage:"association") 側に1回だけ残る（席を競り負けた分）。
    const overLimitAssociation = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "association",
    );
    expect(overLimitAssociation).toBeDefined();
    if (overLimitAssociation?.kind === "over_limit") {
      expect(overLimitAssociation.count).toBe(1);
    }
  });

  it("(b) 過取得の窓の外に居たときも、over_limit(stage:'rescore') からも差し引かれる", async () => {
    const { runtime, stores } = buildRuntime();
    const { owner, c1, t } = await createFixture(stores, false);

    // overFetchFactor=1.4: rankFetchCount = max(1, round(1*1.4)) = 1 —— associationHits
    // は similarity 降順で [C1(0.65), T(0.60)] であり、窓（1件）に入るのは C1 だけ。
    // T は一度も rankedCandidates の土俵に上がらない（席の競り合いにすら参加しない）。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 5,
      overFetchFactor: 1.4,
      association: { maxCount: 1, anchorCount: 1 },
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedC1 = result.memories.find((m) => m.memoryId === c1.id);
    expect(returnedC1).toBeDefined();
    expect(returnedC1?.retrievedVia).toBe("association");
    const returnedT = result.memories.find((m) => m.memoryId === t.id);
    expect(returnedT).toBeUndefined();

    const overLimitRescore = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "rescore",
    );
    expect(overLimitRescore).toBeUndefined();

    const overLimitAssociation = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "association",
    );
    expect(overLimitAssociation).toBeDefined();
    if (overLimitAssociation?.kind === "over_limit") {
      expect(overLimitAssociation.count).toBe(1);
    }
  });

  it("(c) 連想の近傍に現れていない over_limit(stage:'rescore') のバイスタンダーは残る（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = buildRuntime();
    // D: owner への類似度が 0.30（minSimilarity の既定 0.5 未満）——段3.5 の連想候補
    // プールに一度も入らない。over_limit(stage:"rescore") には C1・T・D の3件が入るが、
    // D だけは連想と無関係であり続けなければならない。
    const { owner, c1, t, d } = await createFixture(stores, true);
    if (!d) throw new Error("fixture must include D");

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 5,
      overFetchFactor: 2.0,
      association: { maxCount: 1, anchorCount: 1 },
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedC1 = result.memories.find((m) => m.memoryId === c1.id);
    expect(returnedC1).toBeDefined();
    expect(returnedC1?.retrievedVia).toBe("association");
    const returnedT = result.memories.find((m) => m.memoryId === t.id);
    expect(returnedT).toBeUndefined();
    const returnedD = result.memories.find((m) => m.memoryId === d.id);
    expect(returnedD).toBeUndefined();

    // over_limit(stage:"rescore") は D の1件だけが残る——C1（既存処理）・T（本 Issue の
    // 修正）はどちらも差し引かれるが、連想の近傍に一度も現れていない D は無関係であり
    // 続ける。ここで D まで巻き込まれて count が 0（Omission 自体が消える）になったら、
    // 差し引く判定が「over_limit 全件」のように広すぎる過剰実装になっている証拠である。
    const overLimitRescore = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "rescore",
    );
    expect(overLimitRescore).toBeDefined();
    if (overLimitRescore?.kind === "over_limit") {
      expect(overLimitRescore.count).toBe(1);
    }

    const overLimitAssociation = result.omitted.find(
      (o) => o.kind === "over_limit" && o.stage === "association",
    );
    expect(overLimitAssociation).toBeDefined();
    if (overLimitAssociation?.kind === "over_limit") {
      expect(overLimitAssociation.count).toBe(1);
    }
  });
});
