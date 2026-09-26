import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #925（ADR 0203「引き受けた負債」2番が名指ししていた経路、PR #922 は意図的に
 * 対象外にした）。
 *
 * PR #922 は `over_limit(stage:"rescore")` と `memories` の排他性を、段3（必須の同伴
 * 取得、`companions`）経由の昇格についてだけ塞いだ——判定を `companions` に居るかどうかに
 * 絞ったのは、`finalMemories` 全体との突き合わせに広げると
 * `omission-kind-generation.test.ts` の既存の `over_limit` probe を壊す回帰が実測された
 * ためである（そのフィクスチャ自体が、段3.5（連想、既定 on、ADR 0337）経由でこの矛盾を
 * 踏んでいた）。
 *
 * 本ファイルは、段3.5（連想）経由で同じ矛盾が起きることを固定し（(a)(b)）、かつ
 * 「`over_limit(stage:"rescore")` に居なかった連想候補」まで数えてしまう過剰実装を
 * 捕まえる歯（(c)）を置く。
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

describe("recall() — over_limit(stage:'rescore') に数えられた候補が段3.5（連想）経由で finalMemories に昇格したときの排他性（Issue #925）", () => {
  it("(a) over_limit の唯一の候補が連想で拾い直されたときは over_limit(stage:'rescore') の Omission 自体が消える（Issue #925 の再現構成そのまま）", async () => {
    const { runtime, stores } = buildRuntime();

    // A: クエリと完全一致。limit=1 なので withinLimit の1件を占め、連想のアンカーになる。
    const a = await createEmbeddedMemory(stores, [1, 0], { digest: "A" });
    // B: A にわずかに劣るだけ（cos(B, query) = cos(B, A) ≈ 0.99999...）。
    // limit=1 なので段2で over_limit(stage:"rescore") へ回る一方、A への類似度が
    // 連想の minSimilarity（既定 0.5）を軽々超えるため、段3.5 のアンカー A から
    // 拾い直され、`retrievedVia: "association"` として finalMemories に足される。
    const b = await createEmbeddedMemory(stores, [1, 0.001], { digest: "B" });

    // `association` を渡さない——既定 on（ADR 0337）のまま呼ぶ。
    const result = await runtime.recall(ctx, {
      vector: [1, 0],
      limit: 1,
      overFetchFactor: 10,
    });

    // 返した記憶の集合は変わらない——A（ann）と B（association、A からの連想）の2件。
    expect(result.memories.length).toBe(2);
    const returnedA = result.memories.find((m) => m.memoryId === a.id);
    expect(returnedA).toBeDefined();
    expect(returnedA?.retrievedVia).toBe("ann");
    const returnedB = result.memories.find((m) => m.memoryId === b.id);
    expect(returnedB).toBeDefined();
    expect(returnedB?.retrievedVia).toBe("association");
    expect(returnedB?.associationOf).toBe(a.id);

    // 修正前: B は memories に「返した」のに、over_limit(stage:"rescore") にも
    // count: 1 のまま数えられている（Issue #925 の実測どおり）。
    // 修正後: below_threshold と同じ作法で、0件になった Omission は配列から消える。
    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeUndefined();
  });

  it("(b) over_limit に2件居て1件だけが連想で拾い直されたときは、count が1だけ減り Omission は残る", async () => {
    const { runtime, stores } = buildRuntime();

    // owner: クエリと完全一致。limit=1 なので withinLimit の1件を占め、連想のアンカーになる。
    const owner = await createEmbeddedMemory(stores, [1, 0, 0], { digest: "owner" });
    // mid: owner（=クエリ）への類似度が高い（0.99）ので、段2では limit を超えて
    // over_limit(stage:"rescore") へ回る一方、連想の minSimilarity（既定 0.5）を
    // 超えるため owner から拾い直される。
    const mid = await createEmbeddedMemory(stores, [0.99, 0.1411, 0], { digest: "mid" });
    // far: クエリへの類似度は閾値（既定 0.1）を超えるので over_limit(stage:"rescore") には
    // 数えられるが、owner（=クエリ）への類似度自体も 0.3 と低く、連想の
    // minSimilarity（既定 0.5）に届かないため誰にも拾い直されない。
    const far = await createEmbeddedMemory(stores, [0.3, 0.9539, 0], { digest: "far" });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 1,
      overFetchFactor: 10,
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedMid = result.memories.find((m) => m.memoryId === mid.id);
    expect(returnedMid).toBeDefined();
    expect(returnedMid?.retrievedVia).toBe("association");
    expect(returnedMid?.associationOf).toBe(owner.id);
    const returnedFar = result.memories.find((m) => m.memoryId === far.id);
    expect(returnedFar).toBeUndefined();

    // over_limit(stage:"rescore") は2件（mid, far）で始まり、mid だけが連想で
    // 昇格したので count は1件分だけ減る。far は omitted のまま残る。
    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeDefined();
    if (overLimit?.kind === "over_limit") {
      expect(overLimit.count).toBe(1);
    }
  });

  it("(c) over_limit に居なかった連想候補が返っても、無関係な over_limit(stage:'rescore') の count は減らない（過剰実装を捕まえる歯）", async () => {
    const { runtime, stores } = buildRuntime();

    // owner: クエリへの類似度 0.5（閾値は超えるが1位）。limit=1 で withinLimit の1件を
    // 占め、連想のアンカーになる。
    const owner = await createEmbeddedMemory(stores, [0.5, 0.8660254, 0, 0], { digest: "owner" });
    // bystander: クエリへの類似度 0.3（閾値は超えるが owner より劣後するので
    // over_limit(stage:"rescore") にちょうど1件計上される）。owner への類似度は
    // 0.5*0.3 = 0.15 と低く（e2/e3 が直交）、連想の minSimilarity（既定 0.5）に
    // 届かないため誰にも拾い直されない——この count はこのテストを通じて 1 の
    // ままでなければならない。
    const bystander = await createEmbeddedMemory(stores, [0.3, 0, 0.9539, 0], {
      digest: "bystander",
    });
    // associated: クエリへの類似度は 0.05（既定閾値 0.1 未満）なので段2の `passed` に
    // 一度も入らず、over_limit(stage:"rescore") の勘定（内部の `overLimit` 配列）にも
    // 現れない——below_threshold 側の候補である。だが owner（アンカー）への類似度は
    // 0.5*0.05 + 0.8660254*0.9987 ≈ 0.890 と高く、段3.5 のアンカー owner から
    // 拾い直され、`retrievedVia: "association"` として finalMemories に足される。
    const associated = await createEmbeddedMemory(stores, [0.05, 0.9987, 0, 0], {
      digest: "associated",
    });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0, 0],
      limit: 1,
      overFetchFactor: 10,
    });

    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();
    const returnedAssociated = result.memories.find((m) => m.memoryId === associated.id);
    expect(returnedAssociated).toBeDefined();
    expect(returnedAssociated?.retrievedVia).toBe("association");
    expect(returnedAssociated?.associationOf).toBe(owner.id);
    const returnedBystander = result.memories.find((m) => m.memoryId === bystander.id);
    expect(returnedBystander).toBeUndefined();

    // below_threshold(associated) は既存の取り下げ処理で消える——本テストの主張はそこではない。
    expect(result.omitted.some((o) => o.kind === "below_threshold")).toBe(false);

    // over_limit(stage:"rescore") は bystander の1件だけであり、`associated`
    // （over_limit に一度も居なかった連想候補）が返ったことに影響されず count: 1 のまま。
    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeDefined();
    if (overLimit?.kind === "over_limit") {
      expect(overLimit.count).toBe(1);
    }
  });
});
