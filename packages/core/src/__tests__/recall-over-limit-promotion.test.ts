import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0203「引き受けた負債」2・3 の陽性対照。
 *
 * below_threshold については ADR 0203 が `finalMemories` との突き合わせで取り下げる
 * 後処理を入れた（`recall-runtime.ts:1679` 以降）。だが ADR 0203 自身が「引き受けた
 * 負債」2・3 として明記している通り、対象は `below_threshold` だけに絞られており、
 * `over_limit(stage:"rescore")` 側には同じ取り下げが無い——`OverLimitOmission` は
 * memoryId を持たないため、ADR 0203 の設計（`finalMemories` との memoryId 突き合わせ）
 * をそのまま適用できない、というのが却下理由（「採らなかった案」4番）。
 *
 * このテストは「段2で `passed.slice(limit)` により over_limit へ回された候補が、
 * 段3（必須の同伴取得）を経由して `finalMemories` に昇格しうる」という、ADR 0203
 * 自身が「構造的にあり得るが実測していない」と書いた経路（「引き受けた負債」3番）を、
 * fake ストア上で実際に起こして確かめる。
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

describe("recall() — over_limit(stage:'rescore') に数えられた候補が、段3の必須同伴取得で finalMemories に昇格する（ADR 0203「引き受けた負債」3番の陽性対照）", () => {
  it("companion が limit を超えて over_limit に回っても、対向の contested owner が withinLimit に居れば companion は memories に返り、over_limit の count はそのまま残る", async () => {
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
    });

    // 陽性対照本体: companion が実際に memories へ返っている
    // （retrievedVia: "mandatory_companion" — 段3が拾った証拠）。
    const returnedCompanion = result.memories.find((m) => m.memoryId === companion.id);
    expect(returnedCompanion).toBeDefined();
    expect(returnedCompanion?.retrievedVia).toBe("mandatory_companion");
    const returnedOwner = result.memories.find((m) => m.memoryId === owner.id);
    expect(returnedOwner).toBeDefined();

    // 同時に、companion の memoryId は over_limit(stage:"rescore") の勘定にも
    // 数えられたままである——below_threshold と違い、取り下げの後処理が無い。
    const overLimit = result.omitted.find((o) => o.kind === "over_limit" && o.stage === "rescore");
    expect(overLimit).toBeDefined();
    if (overLimit?.kind === "over_limit") {
      // これが本 ADR の負債そのもの: 「返した」のに「1件 over_limit で落とした」とも
      // 名乗っている。below_threshold なら ADR 0203 の後処理でここが 0 になり
      // Omission 自体が消えるが、over_limit にはその処理が無い。
      expect(overLimit.count).toBe(1);
    }

    // memories と omitted の排他性（ADR 0203 が契約にしたもの）は memoryId を持たない
    // over_limit については検証しようがない——`OverLimitOmission` に memoryId が無いため、
    // 「同じ個体が両方に載っている」ことを型の上で直接は指せない。ここでは
    // 「返した記憶の個体数」と「over_limit の count」を突き合わせることで、
    // 実質的に同じ矛盾（返した1件が、落ちた1件としても数えられている）を示す。
    expect(result.memories.length).toBe(2); // owner + companion
  });
});
