import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { defaultActivityDecayStrategy } from "../strategies/decay.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeMemoryStore.reinforce` の `opts.nowSeq`（`ReinforceOptions.nowSeq`、
 * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16）が、
 * `InMemoryMemoryStore.reinforce`/`PostgresMemoryStore.reinforce` と同じ意味論——
 * `halfLifeRecalls` を持つ Memory の活動時計側（`decayBaseSeq`/`decayFloorSeq`）を、
 * 壁時計側の強化と同じ強化イベントとして進める——を実際に守っていることを検査する歯。
 *
 * **`packages/testkit` の `memory-store-conformance.ts` の対象ではない。**
 * `FakeMemoryStore` は `packages/core` 自身の runtime テスト専用の別系統
 * （`fake-reinforce-monotonicity.test.ts` と同じ理由・同じ形）。
 *
 * Issue #768: 調査時、この Fake を `describeMemoryStoreConformance` へ一時的に通して
 * 見つけた食い違い（`reinforce` が `opts` 自体を受け取らず、活動時計のテナントでも
 * `reinforce` が忘却ゲートに対して完全な no-op になっていた）を、`runtime-fakes.ts` の
 * `reinforce` に足した `opts?.nowSeq` の分岐で塞いだ。その塞ぎが実際に効いていることを
 * ここで固定する。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
let contentHashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

const HOUR = 1000 * 60 * 60;

describe("FakeMemoryStore.reinforce の opts.nowSeq（ADR 0165 決めたこと16、Issue #768）", () => {
  it("opts.nowSeq を渡すと、halfLifeRecalls を持つ Memory の decayBaseSeq/decayFloorSeq を進める", async () => {
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(
      ctx,
      newMemory({ decayBaseSeq: 0, decayFloorSeq: 10, halfLifeRecalls: 360 }),
    );
    const nowSeq = 1000;
    const at = new Date(memory.recordedAt.getTime() + HOUR);

    const reinforced = await memoryStore.reinforce(ctx, memory.id, at, { nowSeq });

    const expectedDecayFloorSeq = defaultActivityDecayStrategy.floorAt({
      baseSeq: nowSeq,
      strength: memory.strength,
      halfLifeRecalls: memory.halfLifeRecalls!,
    });
    expect(reinforced.decayBaseSeq).toBe(nowSeq);
    expect(reinforced.decayFloorSeq).toBe(expectedDecayFloorSeq);

    // 読み直しても同じ（返り値だけを繕う実装を弾く）。
    const reread = await memoryStore.get(ctx, memory.id);
    expect(reread?.decayBaseSeq).toBe(nowSeq);
    expect(reread?.decayFloorSeq).toBe(expectedDecayFloorSeq);
  });

  it("⚠ 同じ at をもう一度渡すと、opts.nowSeq が進んでいても活動時計側を動かさない（2軸を同じ WHERE で守る、ADR 0048/0165。Issue #730）", async () => {
    // これは修正ではなく、今の契約を固定する歯である。活動時計側の3列は壁時計の `at` と
    // 同じ条件（狭義の `<`）で守られる——「seq が進んだから活動時計側だけ書く」実装は
    // 2軸の起点をずらすので、この契約の下では誤り。
    const { memoryStore } = createFakeRuntimeStores();
    const memory = await memoryStore.createMemory(
      ctx,
      newMemory({ decayBaseSeq: 0, decayFloorSeq: 10, halfLifeRecalls: 360 }),
    );
    const at = new Date(memory.recordedAt.getTime() + HOUR);
    const firstSeq = 1000;
    const secondSeq = 2000;

    const first = await memoryStore.reinforce(ctx, memory.id, at, { nowSeq: firstSeq });
    // 前提: 1回目は活動時計側も実際に進めている。
    expect(first.decayBaseSeq).toBe(firstSeq);
    // ⚠ プリミティブへ即座に写し取る（`fake-reinforce-monotonicity.test.ts` と同じ理由
    // ——in-memory 実装は行オブジェクトへの参照を返すので、保持すると同じオブジェクトを
    // 2回見るだけになる）。
    const firstDecayFloorSeq = first.decayFloorSeq;
    const firstUpdatedAt = first.updatedAt.getTime();
    // 書けば必ず updatedAt が変わる状況を作る。
    await new Promise((resolve) => setTimeout(resolve, 5));

    const again = await memoryStore.reinforce(ctx, memory.id, at, { nowSeq: secondSeq });
    expect(again.decayBaseSeq).toBe(firstSeq);
    expect(again.decayFloorSeq).toBe(firstDecayFloorSeq);
    expect(again.halfLifeRecalls).toBe(360);
    expect(again.updatedAt.getTime()).toBe(firstUpdatedAt);

    // 読み直しても同じ（返り値だけを繕う実装を弾く）。
    const reread = await memoryStore.get(ctx, memory.id);
    expect(reread?.decayBaseSeq).toBe(firstSeq);
    expect(reread?.decayFloorSeq).toBe(firstDecayFloorSeq);
    expect(reread?.updatedAt.getTime()).toBe(firstUpdatedAt);
  });
});
