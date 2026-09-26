import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #823（ADR 0203「これが覆るとしたら」3番が観測条件として挙げていた経路の是正）。
 *
 * below_threshold については ADR 0203 が `finalMemories` との突き合わせで取り下げる
 * 後処理を入れた（`recall-runtime.ts` の排他性契約ブロック）。本テストは、同じ形の
 * 矛盾が `over_limit(stage:"rescore")` でも起きる（段2で `passed.slice(limit)` により
 * over_limit へ回された候補が、段3の必須の同伴取得で `finalMemories` に昇格する）ことを
 * 示し、修正後は below_threshold と同じ作法（count を差し引く／0件なら Omission を
 * 配列から外す）で解消されていることを固定する。
 *
 * ⚠ 差し引く数は「段3で返した同伴の数」ではなく「`overLimit` に居て、かつ返した id の
 * 数」である——companion が over_limit ではなく below_threshold に居た場合や、
 * companion が最初から withinLimit に居た場合まで数えてはいけない（3本目の歯が
 * これを検査する）。
 *
 * ⚠ **この PR が解消するのは、over_limit(stage:"rescore") の候補が段3（必須の同伴
 * 取得）経由で昇格する経路だけである。** 同じ候補が段3.5（連想、既定 on）経由で
 * 昇格する経路（ADR 0203「引き受けた負債」2番がまさに名指ししていた経路）は、
 * この PR では塞いでいない——`recall-runtime.ts` の取り下げは `companions`
 * （段3が構築した配列）に居るかどうかで判定しており、段3.5 経由の昇格はそこに現れない
 * （広げると `omission-kind-generation.test.ts` の既存の歯を壊す回帰になることを実測した）。
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

describe("recall() — over_limit(stage:'rescore') に数えられた候補が段3で finalMemories に昇格したときの排他性（Issue #823、ADR 0203「これが覆るとしたら」3番）", () => {
  it("companion が over_limit の唯一の候補で、丸ごと同伴取得に昇格したときは over_limit(stage:'rescore') の Omission 自体が消える", async () => {
    const { runtime, stores } = buildRuntime();

    // companion: クエリにほぼ一致する候補として ANN 経由で見つかる（段2で passed する）が、
    // owner よりわずかにスコアが低い。limit=1 なので owner だけが withinLimit に入り、
    // companion は passed.slice(limit) = overLimit に落ちる。
    const companion = await createEmbeddedMemory(stores, [1, 0.001], {
      status: "contested",
      digest: "companion",
    });
    // owner: companion と対向の contested ペア。クエリと完全一致し withinLimit の1件を占める。
    const owner = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "owner",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 10,
      // 段3.5（連想、既定 on、ADR 0337）を明示的に切る——本テストが検査したいのは
      // 段2の over_limit(stage:"rescore") と段3（必須の同伴取得）だけであり、
      // 連想が別経路で同じ候補を拾い直すと検証が段3.5の挙動と混ざる。
      association: null,
    });

    // companion が実際に memories へ返っている（retrievedVia: "mandatory_companion"
    // — 段3が拾った証拠）。
    const returnedCompanion = result.memories.find((m) => m.memoryId === companion.id);
    expect(returnedCompanion).toBeDefined();
    expect(returnedCompanion?.retrievedVia).toBe("mandatory_companion");
    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    expect(result.memories.length).toBe(2); // owner + companion

    // 修正後の期待: over_limit(stage:"rescore") の対象はこの1件（companion）だけ
    // だったので、below_threshold と同じ作法で Omission 自体が配列から消える
    // （count === 0 では push しない作法、ADR 0203「決めたこと」5番に揃える）。
    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeUndefined();
  });

  it("over_limit に2件居て1件だけが同伴取得で昇格したときは、count が1だけ減り Omission は残る", async () => {
    const { runtime, stores } = buildRuntime();

    // companion: owner の対向。閾値は通るが owner より劣後するので overLimit に落ちる。
    // 段3の必須同伴取得で拾われ、finalMemories に昇格する。
    const companion = await createEmbeddedMemory(stores, [0.99, 0.1411], {
      status: "contested",
      digest: "companion",
    });
    // owner: クエリと完全一致。limit=1 なので withinLimit の1件を占める。
    // `contestedWithId` は owner 側からだけ辿られる（段3のアルゴリズムは companion 側の
    // `contestedWithId` を読まない、ADR 0136）。
    const owner = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "owner",
    });
    // bystander: 閾値は通るが companion よりさらに劣後し、contested でもないので
    // 誰にも同伴として拾われない。overLimit に残ったままになる。
    const bystander = await createEmbeddedMemory(stores, [0.9, 0.436], {
      digest: "bystander",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 10,
      // 段3.5（連想、既定 on、ADR 0337）を明示的に切る——本テストが検査したいのは
      // 段2の over_limit(stage:"rescore") と段3（必須の同伴取得）だけであり、
      // 連想が別経路で同じ候補を拾い直すと検証が段3.5の挙動と混ざる。
      association: null,
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedCompanion = result.memories.find((m) => m.memoryId === companion.id);
    expect(returnedCompanion).toBeDefined();
    expect(returnedCompanion?.retrievedVia).toBe("mandatory_companion");
    const returnedBystander = result.memories.find((m) => m.memoryId === bystander.id);
    expect(returnedBystander).toBeUndefined();

    // count は「昇格した1件（companion）」の分だけ減っている
    // （2件 over_limit のうち1件が昇格。bystander はそのまま残る）。
    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeDefined();
    if (overLimit?.kind === "over_limit") {
      expect(overLimit.count).toBe(1);
    }
  });

  it("同伴が over_limit ではなく below_threshold から昇格したときは、無関係な over_limit(stage:'rescore') の count は減らない（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = buildRuntime();

    // companion: owner の対向だが、クエリとはほぼ無関係（similarity ≈ 0）——
    // below_threshold に落ちる。段3の必須同伴取得は閾値を見ずに getMany で
    // 直接取り直すので、below_threshold からでも finalMemories に昇格する
    // （below_threshold の既存の取り下げ処理——ADR 0203「決めたこと」の設計——が
    // この経路も同じ形で処理する。段3経由でも実際に効くことは Issue #823 で実測した）。
    const companion = await createEmbeddedMemory(stores, [0, 1], {
      status: "contested",
      digest: "companion",
    });
    // owner: クエリと完全一致。limit=1 なので withinLimit の1件を占める。
    const owner = await createEmbeddedMemory(stores, [1, 0], {
      status: "contested",
      contestedWithId: companion.id,
      digest: "owner",
    });
    // bystander: owner とは無関係。閾値は通るが limit=1 を超えるので、
    // over_limit(stage:"rescore") にちょうど1件だけ計上される。誰の同伴でもない
    // ので昇格しない——この count は本テストを通じて 1 のまま変わってはいけない。
    const bystander = await createEmbeddedMemory(stores, [0.99, 0.1411], {
      digest: "bystander",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 10,
      // 段3.5（連想、既定 on、ADR 0337）を明示的に切る——本テストが検査したいのは
      // 段2の over_limit(stage:"rescore") と段3（必須の同伴取得）だけであり、
      // 連想が別経路で同じ候補を拾い直すと検証が段3.5の挙動と混ざる。
      association: null,
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    // companion は below_threshold 経由で昇格している（ADR 0203 の既存の取り下げで
    // below_threshold 側の Omission 自体が消える）。
    const returnedCompanion = result.memories.find((m) => m.memoryId === companion.id);
    expect(returnedCompanion).toBeDefined();
    expect(returnedCompanion?.retrievedVia).toBe("mandatory_companion");
    expect(result.omitted.some((o) => o.kind === "below_threshold")).toBe(false);

    // bystander は over_limit(stage:"rescore") に残ったまま——companion の昇格は
    // over_limit の勘定に触れてはいけない（「段3で返した同伴の数」を無条件に
    // 差し引く過剰実装だと、ここが誤って 0 になり Omission が消える）。
    const returnedBystander = result.memories.find((m) => m.memoryId === bystander.id);
    expect(returnedBystander).toBeUndefined();
    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeDefined();
    if (overLimit?.kind === "over_limit") {
      expect(overLimit.count).toBe(1);
    }
  });
});
