import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `createRecall` の活動時計の加算（`tenant_activity`・`tenant_subject_activity` の UPSERT）は、
 * `tenant_id` を行の値として書く（`WHERE` で絞る文ではない）ので、テナントの境界は
 * 「どのテナントの行に足すか」にある。A の recall が B のカウンタを進めず、同じ subject 名でも
 * テナントごとに別のカウンタになることを縛る。
 */

const A: Ctx = { tenantId: "tenant-boundary-2-a" };
const B: Ctx = { tenantId: "tenant-boundary-2-b" };
const usage = {
  chars: 0,
  estimatedTokens: 0,
  counter: "heuristic",
  byTier: { full: 0, digest: 0, index: 0 },
  indexChars: 0,
};
const record = (ctx: Ctx, advanceActivityClock: unknown) =>
  ({
    tenantId: ctx.tenantId,
    subjectId: null,
    query: { text: "q" },
    budget: null,
    omitted: [],
    usage,
    indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
    explain: { stages: [] },
    returnedMemories: [],
    advanceActivityClock,
  }) as never;

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

describe("createRecall の活動時計: テナントごとに別のカウンタ", () => {
  it("テナント単位: A を2回・B を1回進めると、A は2・B は1で、recall の行もそれぞれのテナントのもの", async () => {
    const { db } = await getTestClient();
    const mem = new PostgresMemoryStore(db);
    const settings = new PostgresTenantSettingsStore(db);
    const a1 = await mem.createRecall(A, record(A, true));
    await mem.createRecall(A, record(A, true));
    const b1 = await mem.createRecall(B, record(B, true));

    expect(await settings.getActivitySeq(A)).toBe(2);
    expect(await settings.getActivitySeq(B)).toBe(1);
    expect(await mem.getRecall(A, a1)).not.toBeNull();
    expect(await mem.getRecall(B, a1)).toBeNull();
    expect(await mem.getRecall(B, b1)).not.toBeNull();
    expect(await mem.getRecall(A, b1)).toBeNull();
  });

  it("subject 単位: 同じ subject 名でも A と B は別のカウンタで、テナント単位のカウンタは動かない", async () => {
    const { db } = await getTestClient();
    const mem = new PostgresMemoryStore(db);
    const settings = new PostgresTenantSettingsStore(db);
    const subject = { scope: "subject", subjectId: "s" };
    await mem.createRecall(A, record(A, subject));
    await mem.createRecall(A, record(A, subject));
    await mem.createRecall(B, record(B, subject));

    expect(await settings.getSubjectActivitySeqs(A, ["s"])).toEqual({ s: 2 });
    expect(await settings.getSubjectActivitySeqs(B, ["s"])).toEqual({ s: 1 });
    expect(await settings.getActivitySeq(A)).toBe(0);
    expect(await settings.getActivitySeq(B)).toBe(0);
  });
});
