import { afterAll, describe, expect, it } from "vitest";
import { createRuntime, type MemoryId } from "@mnemora/core";
import {
  expectLinearGrowth,
  growthLlm,
  measureContestedGroupGrowth,
  type GrowthMeasurement,
} from "../../../core/src/__tests__/contested-group-event-growth.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";
import { insertRawMemory, newEvent } from "./contested-group-fixtures.js";

/**
 * ADR 0431: 群の監査イベントが N に対して線形にしか増えないこと（Postgres 版）。
 * 走らせ方と閾値は core の Fake 版・testkit の InMemory 版と同じ部品を使う。
 * 加えて、`markContestedGroup` の口そのものが、状態の変わらないメンバーにイベントを積まないことを見る。
 */

async function measure(n: number): Promise<GrowthMeasurement> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const eventStore = new PostgresEventStore(db);
  const runtime = createRuntime({
    memoryStore: new PostgresMemoryStore(db),
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore,
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: growthLlm(),
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => `sha256(${content})`,
    relationStore: new PostgresRelationStore(db),
  });
  return measureContestedGroupGrowth(
    runtime,
    async () => eventStore.list({ tenantId: "contested-group-event-growth" }, {}),
    n,
  );
}

afterAll(async () => {
  await closeTestClient();
});

describe("群の監査イベントは N に対して線形にしか増えない（Postgres）", () => {
  it("N=10/20/40: イベントの件数・note の長さ・meta の合計バイト数", async () => {
    const m = { 10: await measure(10), 20: await measure(20), 40: await measure(40) };
    expectLinearGrowth(m);
  }, 120_000);

  it("note は件数と先頭の一部だけを持ち、切ったことを印で示す", async () => {
    const note = (await measure(40)).lastNote!;
    expect(note.memberCount).toBe(40);
    expect(note.memberIdsTruncated).toBe(true);
    expect((note.memberIds as string[]).length).toBeLessThan(40);
    const ids = note.memberIds as string[];
    expect(ids).toEqual([...ids].sort());
  }, 120_000);
});

describe("markContestedGroup の口: 状態の変わらないメンバーには updated を積まない（Postgres）", () => {
  it("既に群の一員（contested・contestedWithId なし）は積まない。active と、対の片割れ（contestedWithId あり）は積む", async () => {
    await resetTestDatabase();
    const tenantId = "mark-group-unchanged-events";
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const v = { validFrom: null, validUntil: null };
    const grouped = await insertRawMemory(pool, tenantId, "g0", v, "contested");
    const paired1 = await insertRawMemory(pool, tenantId, "p1", v, "contested");
    const paired2 = await insertRawMemory(pool, tenantId, "p2", v, "contested");
    await pool.query(`UPDATE memories SET contested_with_id = $2 WHERE id = $1`, [
      paired1,
      paired2,
    ]);
    await pool.query(`UPDATE memories SET contested_with_id = $2 WHERE id = $1`, [
      paired2,
      paired1,
    ]);
    const fresh = await insertRawMemory(pool, tenantId, "a0", v, "active");
    const ids: MemoryId[] = [grouped, paired1, paired2, fresh];

    const { events } = await store.markContestedGroup(
      { tenantId },
      ids.map((id) => ({ id, event: newEvent(tenantId, id, "m") })),
    );

    expect(events.map((e) => e.memoryId).sort()).toEqual([paired1, paired2, fresh].sort());
    const stored = await pool.query(`SELECT memory_id FROM memory_events WHERE tenant_id = $1`, [
      tenantId,
    ]);
    expect(stored.rows.map((r) => r.memory_id).sort()).toEqual([paired1, paired2, fresh].sort());
  });

  it("全員が既に群の一員でも、例外にならず 0 件を積む", async () => {
    await resetTestDatabase();
    const tenantId = "mark-group-all-unchanged";
    const { db, pool } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const v = { validFrom: null, validUntil: null };
    const ids: MemoryId[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(await insertRawMemory(pool, tenantId, `c${i}`, v, "contested"));

    const { members, events } = await store.markContestedGroup(
      { tenantId },
      ids.map((id) => ({ id, event: newEvent(tenantId, id, "m") })),
    );

    expect(members).toHaveLength(3);
    expect(events).toHaveLength(0);
  });
});
