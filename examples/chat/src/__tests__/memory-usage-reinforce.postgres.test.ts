import { afterAll, describe, expect, it } from "vitest";
import { defaultDecayStrategy } from "@mnemora/core";
import type { Ctx } from "@mnemora/core";
import { buildConversation } from "../scenario.js";
import { ingestConversation, queryRecall, reportMemoryUsage } from "../mnemora-path.js";
import { createExampleRuntime } from "../runtime-factory.js";
import { createMutableClock } from "../mutable-clock.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

describe("examples/chat: reportMemoryUsage → reinforce が本物の Postgres 上で発火する（Issue #301）", () => {
  it("使われた記憶と使われなかった記憶で last_reinforced_at / decay_floor_at / decay に差が出る", async () => {
    await resetTestDatabase();
    await getTestClient();

    // t0 を実時刻より60秒先にしておくのは、outbox の available_at が壁時計由来だった頃の名残（ADR 0355・0559）。
    const t0 = new Date(Date.now() + 60_000);
    const clock = createMutableClock(t0);
    const handle = await createExampleRuntime(requireDatabaseUrl(), {}, {}, clock);
    try {
      const ctx: Ctx = { tenantId: "example-chat-reinforce-fires" };
      const conversation = buildConversation(15);
      expect(conversation.userUtterances.length).toBe(16);

      await ingestConversation(handle.runtime, ctx, conversation);

      // association: null にする。連想枠（maxCount=10）が、limit の外に残るはずの対照群の6件を全部吸収してしまうため。
      const recallOpts = { association: null } as const;

      const recall1 = await queryRecall(handle.runtime, ctx, conversation, recallOpts);
      expect(recall1.index.totalInScope).toBe(16);
      expect(recall1.memories.length).toBeLessThan(16); // 前提: 実際に絞り込みが起きている
      const usedIds1 = new Set(recall1.memories.map((m) => m.memoryId));
      const report1 = await reportMemoryUsage(handle.runtime, ctx, recall1);
      expect(report1.reported).toBe(true);

      const t1 = new Date(t0.getTime() + 200 * 60 * 60 * 1000);
      clock.set(t1);
      const recall2 = await queryRecall(handle.runtime, ctx, conversation, recallOpts);
      const usedIds2 = new Set(recall2.memories.map((m) => m.memoryId));
      expect(usedIds2).toEqual(usedIds1);
      const report2 = await reportMemoryUsage(handle.runtime, ctx, recall2);
      expect(report2.reported).toBe(true);

      const usageCountResult = await handle.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM recall_usages WHERE recall_id = ANY($1::uuid[])",
        [[recall1.recallId, recall2.recallId]],
      );
      const usageRowCount = Number(usageCountResult.rows[0]?.count ?? "0");
      console.log(
        `[Issue #301 実測] recall_usages に入った行数: ${usageRowCount}` +
          `（recall1: ${usedIds1.size}件 + recall2: ${usedIds2.size}件 の報告に対応）`,
      );
      expect(usageRowCount).toBe(usedIds1.size + usedIds2.size);

      const usedMemoryIdFirst = [...usedIds1][0];
      if (usedMemoryIdFirst === undefined) {
        throw new Error("前提が崩れている: 使用報告した Memory が無い");
      }

      const t2 = new Date(t0.getTime() + 400 * 60 * 60 * 1000);
      clock.set(t2);

      const usedMemory = await handle.memoryStore.get(ctx, usedMemoryIdFirst);
      expect(usedMemory).not.toBeNull();
      expect(usedMemory!.lastReinforcedAt).not.toBeNull();
      expect(usedMemory!.lastReinforcedAt!.getTime()).toBe(t1.getTime());

      const controlRow = (
        await handle.pool.query<{ id: string }>(
          `SELECT id::text AS id FROM memories
           WHERE tenant_id = $1 AND status = 'active' AND id != ALL($2::uuid[])
           LIMIT 1`,
          [ctx.tenantId, [...usedIds1]],
        )
      ).rows[0];
      expect(controlRow).toBeDefined();

      const controlMemory = await handle.memoryStore.get(ctx, controlRow!.id);
      expect(controlMemory).not.toBeNull();
      expect(controlMemory!.lastReinforcedAt).toBeNull();

      console.log(
        `[Issue #301 実測] decayFloorAt 使用側=${usedMemory!.decayFloorAt.toISOString()} ` +
          `対照側=${controlMemory!.decayFloorAt.toISOString()}`,
      );
      expect(usedMemory!.decayFloorAt.getTime()).toBeGreaterThan(
        controlMemory!.decayFloorAt.getTime(),
      );

      const usedStrength = defaultDecayStrategy.strengthAt(t2, {
        recordedAt: usedMemory!.recordedAt,
        lastReinforcedAt: usedMemory!.lastReinforcedAt,
        strength: usedMemory!.strength,
        halfLifeHours: usedMemory!.halfLifeHours,
      });
      const controlStrength = defaultDecayStrategy.strengthAt(t2, {
        recordedAt: controlMemory!.recordedAt,
        lastReinforcedAt: controlMemory!.lastReinforcedAt,
        strength: controlMemory!.strength,
        halfLifeHours: controlMemory!.halfLifeHours,
      });
      console.log(
        `[Issue #301 実測] t2(+400h)時点の decay(strengthAt): ` +
          `使われた側=${usedStrength} 対照側=${controlStrength} ` +
          `(差=${usedStrength - controlStrength}, 比=${usedStrength / controlStrength})`,
      );
      expect(usedStrength).toBeGreaterThan(controlStrength);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
