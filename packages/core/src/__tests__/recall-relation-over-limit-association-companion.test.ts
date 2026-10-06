import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import type { RecallResult } from "../recall.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * 段3で多者間の群を `relationMaxCount` で切った候補（`relationOverLimitIds`）が、段3.5 の連想の
 * 必須の同伴取得（`getMany` による id 引き。連想の候補生成の除外集合が効かない）で結果集合へ
 * 戻ると、同じ1件が `memories`（または段4の `budget_dropped`）と `over_limit(stage:"relation")` の
 * 両方に数えられていた（Issue #1794）。
 *
 * 「最後にその候補を落とした段で1回だけ数える」（ADR 0203 追記3・7）を `over_limit(relation)` にも当てる。
 * 戻った先で返れば `memories` にだけ、予算で落ちれば `budget_dropped` にだけ数える。
 *
 * 形の作り方: ペア P–Q の Q に、`RelationStore.link` で群の owner からの `contradicts` の辺を直接張る
 * （Runtime の口 `markContested`/`markContestedGroup` では作れない形。`link` は公開メソッドである）。
 * Q は群の探索で拾われ、validFrom が最も古いので `relationMaxCount` で切られる。連想がアンカー近傍の
 * P を選ぶと、P の対向として Q が取り戻される。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  const strength = 1;
  const halfLifeHours = 24 * 365 * 10;
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
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
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
    relationStore: stores.relationStore,
  });
  return { runtime, stores };
}

async function create(
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

/** owner O と群 [g1, g2]、ANCHOR、ペア P–Q、O→Q の辺。`extraCut` が true なら群に切られて戻らない R も足す。 */
async function build(opts: { extraCut: boolean }) {
  const { runtime, stores } = buildRuntime();
  const o = await create(stores, [1, 0, 0], { digest: "OOOO" });
  const g1 = await create(stores, [0.1, 0.1, 0.9], {
    digest: "G1G1",
    validFrom: new Date("2026-01-03"),
  });
  const g2 = await create(stores, [0.1, 0.1, 0.9], {
    digest: "G2G2",
    validFrom: new Date("2026-01-02"),
  });
  const anchor = await create(stores, [0.9, 0.1, 0.1], { digest: "ANCH" });
  const p = await create(stores, [0.85, 0.15, 0.1], { digest: "PPPP" });
  const q = await create(stores, [0.1, 0.1, 0.9], {
    digest: "QQQQ",
    validFrom: new Date("2026-01-01"),
  });
  const members = [o.id, g1.id, g2.id];
  let r: Memory | undefined;
  if (opts.extraCut) {
    // R は群に入り、Q より古い validFrom で切られる。連想の対象にはならない（Q と違い、誰の対向でもない）。
    r = await create(stores, [0.1, 0.1, 0.9], { digest: "RRRR", validFrom: new Date("2025-12-01") });
    members.push(r.id);
  }
  expect((await runtime.markContestedGroup!(ctx, members)).outcome.kind).toBe("contested_group");
  expect((await runtime.markContested(ctx, p.id, q.id)).outcome.kind).toBe("contested");
  await stores.relationStore.link(ctx, "contradicts", o.id, q.id);
  return { runtime, o, g1, g2, anchor, p, q, r };
}

function relationOmissions(result: RecallResult) {
  return result.omitted.filter((x) => x.kind === "over_limit" && x.stage === "relation");
}
function budgetDropped(result: RecallResult): number | undefined {
  const o = result.omitted.find((x) => x.kind === "budget_dropped");
  return o?.kind === "budget_dropped" ? o.count : undefined;
}

describe("recall() — 群の上限で切られた候補が段3.5 の必須同伴取得で戻ったときの排他性（Issue #1794）", () => {
  it("(a) 連想の同伴として返った記憶は、memories にだけ数え、over_limit(relation) には数えない", async () => {
    const { runtime, q } = await build({ extraCut: false });

    const result = await runtime.recall(ctx, { vector: [1, 0, 0], limit: 2, relationMaxCount: 2 });

    const byId = new Map(result.memories.map((m) => [m.memoryId, m]));
    expect(byId.get(q.id)?.retrievedVia).toBe("mandatory_companion");
    expect(relationOmissions(result)).toEqual([]);
  });

  it("(b) 同じ群で切られて戻らなかった別の記憶の分は、over_limit(relation) に残る（件数だけ減り、札は残る）", async () => {
    const { runtime, q, r } = await build({ extraCut: true });

    const result = await runtime.recall(ctx, { vector: [1, 0, 0], limit: 2, relationMaxCount: 2 });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).toContain(q.id);
    expect(ids).not.toContain(r!.id);
    expect(relationOmissions(result)).toEqual([
      { kind: "over_limit", stage: "relation", count: 1, countKind: "exact" },
    ]);
  });

  it("(c) 連想を切ると Q は戻らないので、over_limit(relation) に残る（過剰実装を捕まえる歯）", async () => {
    const { runtime, q } = await build({ extraCut: false });

    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 2,
      relationMaxCount: 2,
      association: null,
    });

    expect(result.memories.map((m) => m.memoryId)).not.toContain(q.id);
    expect(relationOmissions(result)).toEqual([
      { kind: "over_limit", stage: "relation", count: 1, countKind: "exact" },
    ]);
  });

  it("(d) 戻った先で予算に落ちたら、budget_dropped にだけ数える", async () => {
    const { runtime, q, p } = await build({ extraCut: false });

    // 本体（O・G1・G2・ANCH、各4字）だけが収まる予算。連想の P と同伴の Q は段4で最初に落ちる。
    const result = await runtime.recall(ctx, {
      vector: [1, 0, 0],
      limit: 2,
      relationMaxCount: 2,
      budget: { maxMemoryChars: 16 },
    });

    const ids = result.memories.map((m) => m.memoryId);
    expect(ids).not.toContain(q.id);
    expect(ids).not.toContain(p.id);
    expect(budgetDropped(result)).toBe(2);
    expect(relationOmissions(result)).toEqual([]);
  });
});
