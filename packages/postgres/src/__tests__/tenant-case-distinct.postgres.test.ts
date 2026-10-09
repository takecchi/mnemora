import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, NewRecallRecord } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 大文字と小文字だけが違う2つの tenant（`"Tenant-A"` と `"tenant-a"`）は別の tenant で、互いに見えない。
 *
 * `tenantId` は uuid ではない任意の文字列で、store の入口で小文字にそろえるのは uuid の形の id だけ
 * （`mapping.ts` の `normalizeUuidCase`）。`tenant_id` の比較を大文字小文字を区別しないものにする
 * （`lower(tenant_id) = lower($1)` など）と、別の tenant の行が見えたり消えたりする。
 *
 * 各 `it`: (1) 綴りの違う tenant からは get・getMany・getObservation・aggregateScope・listLabels で見えない。
 * (2) 自分の tenant からは見える（「常に隠す」実装で緑にならない対照）。
 * (3) 片方の tenant の `eraseTenant` は、もう片方の行を消さない。
 * (4) `createObservation` の `externalId` の冪等は tenant の綴りごとで、綴りの違う tenant の Observation を返さない。
 * (5) `getRecall` は綴りの違う tenant の recall を返さない。
 */

const UPPER: Ctx = { tenantId: "Tenant-A" };
const LOWER: Ctx = { tenantId: "tenant-a" };

function recallRecord(ctx: Ctx): NewRecallRecord {
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "tenant-case" },
    budget: null,
    omitted: [],
    usage: {
      chars: 0,
      estimatedTokens: 0,
      counter: "heuristic",
      byTier: { full: 0, digest: 0, index: 0 },
      indexChars: 0,
    },
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
  };
}

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function setup() {
  const { db } = await getTestClient();
  const store = new PostgresMemoryStore(db);
  const upperMemory = await store.createMemory(
    UPPER,
    buildNewMemoryFixture({ tenantId: UPPER.tenantId, content: "upper", contentHash: "h-upper" }),
  );
  const lowerMemory = await store.createMemory(
    LOWER,
    buildNewMemoryFixture({ tenantId: LOWER.tenantId, content: "lower", contentHash: "h-lower" }),
  );
  return { store, upperMemory, lowerMemory };
}

describe("綴りだけが違う tenant は別の tenant（PostgresMemoryStore）", () => {
  it("get・getMany: 相手の綴りの tenant からは null・空配列。自分の tenant からは見える", async () => {
    const { store, upperMemory, lowerMemory } = await setup();
    expect(upperMemory.tenantId).toBe("Tenant-A");
    expect(lowerMemory.tenantId).toBe("tenant-a");

    expect(await store.get(LOWER, upperMemory.id)).toBeNull();
    expect(await store.get(UPPER, lowerMemory.id)).toBeNull();
    expect((await store.get(UPPER, upperMemory.id))?.id).toBe(upperMemory.id);
    expect((await store.get(LOWER, lowerMemory.id))?.id).toBe(lowerMemory.id);

    expect(await store.getMany(LOWER, [upperMemory.id])).toEqual([]);
    expect(await store.getMany(UPPER, [lowerMemory.id])).toEqual([]);
    expect((await store.getMany(UPPER, [upperMemory.id, lowerMemory.id])).map((m) => m.id)).toEqual(
      [upperMemory.id],
    );
  });

  it("getObservation: 相手の綴りの tenant からは null。自分の tenant からは見える", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const upperObservation = await store.createObservation(
      UPPER,
      buildNewObservationFixture({ tenantId: UPPER.tenantId, externalId: "ext-upper" }),
    );
    expect(await store.getObservation(LOWER, upperObservation.id)).toBeNull();
    expect((await store.getObservation(UPPER, upperObservation.id))?.id).toBe(upperObservation.id);
  });

  it("aggregateScope: 綴りの違う tenant の件数を数えない（それぞれ1件）", async () => {
    const { store } = await setup();
    expect((await store.aggregateScope(UPPER, {})).totalInScope).toBe(1);
    expect((await store.aggregateScope(LOWER, {})).totalInScope).toBe(1);
  });

  it("listLabels: 登録したラベルは、登録した tenant の綴りでだけ見える", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    await store.registerLabel!(UPPER, "label-only-upper");
    expect((await store.listLabels!(UPPER)).map((l) => l.name)).toEqual(["label-only-upper"]);
    expect(await store.listLabels!(LOWER)).toEqual([]);
  });

  it("eraseTenant: 片方の綴りを消しても、もう片方の行は残る", async () => {
    const { store, upperMemory, lowerMemory } = await setup();
    const erased = await store.eraseTenant!(UPPER, { limit: 1000 });
    expect(erased).toMatchObject({ kind: "executed", deleted: expect.any(Number) });
    expect(erased.kind === "executed" ? erased.deleted : 0).toBeGreaterThan(0);
    expect(await store.get(UPPER, upperMemory.id)).toBeNull();
    expect((await store.get(LOWER, lowerMemory.id))?.id).toBe(lowerMemory.id);
  });

  it("createObservation の externalId の冪等は tenant の綴りごと: 綴りの違う tenant の Observation を返さず、自分の tenant に書く", async () => {
    const store = new PostgresMemoryStore((await getTestClient()).db);
    const upperObservation = await store.createObservation(
      UPPER,
      buildNewObservationFixture({ tenantId: UPPER.tenantId, externalId: "ext-same-spelling" }),
    );
    const lowerObservation = await store.createObservation(
      LOWER,
      buildNewObservationFixture({ tenantId: LOWER.tenantId, externalId: "ext-same-spelling" }),
    );
    expect(lowerObservation.id).not.toBe(upperObservation.id);
    expect(lowerObservation.tenantId).toBe("tenant-a");
    expect((await store.getObservation(LOWER, lowerObservation.id))?.id).toBe(lowerObservation.id);

    // 同じ綴りの tenant からの再送は、同じ Observation を返す（「常に新しく書く」実装で緑にならない対照）。
    const resent = await store.createObservation(
      UPPER,
      buildNewObservationFixture({ tenantId: UPPER.tenantId, externalId: "ext-same-spelling" }),
    );
    expect(resent.id).toBe(upperObservation.id);

    // 後から書いた側の再送も、自分の Observation を返す（先に書いた側の綴りの行へは寄らない）。
    const lowerResent = await store.createObservation(
      LOWER,
      buildNewObservationFixture({ tenantId: LOWER.tenantId, externalId: "ext-same-spelling" }),
    );
    expect(lowerResent.id).toBe(lowerObservation.id);
  });

  it("getRecall: 相手の綴りの tenant からは null。自分の tenant からは見える", async () => {
    const store = new PostgresMemoryStore((await getTestClient()).db);
    const upperRecallId = await store.createRecall(UPPER, recallRecord(UPPER));
    expect(await store.getRecall(LOWER, upperRecallId)).toBeNull();
    expect((await store.getRecall(UPPER, upperRecallId))?.recallId).toBe(upperRecallId);
  });
});
