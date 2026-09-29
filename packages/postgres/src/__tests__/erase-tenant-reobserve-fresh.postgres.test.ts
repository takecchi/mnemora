import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { eraseTenant } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";
import {
  buildEraseTenantTestRuntime,
  seedAllTablesForTenant,
} from "./erase-tenant-test-helpers.js";

/**
 * Issue #1207 / [ADR 0383](../../../../docs/decisions/0383-erase-tenant.md):
 *
 * 消した後に同じ `tenantId` で observe → tick すると、新しいテナントとして一から
 * 始まる——旧い記憶・設定・activity が見えない、`getEventRetention` は `unset`、
 * activity seq は初期値（0）に戻る。
 *
 * ⚠ **同テナント再 observe が特に確かめたいのは冪等キーの衝突である**——
 * `memories` の一意索引 `uq_memories_extraction (tenant_id, source_observation_id,
 * extractor_version, content_hash) NULLS NOT DISTINCT` は、古い行が消えていなければ
 * 同じ `content_hash` の再抽出を「既に作成済み」として弾く（冪等）。`eraseTenant` が
 * `memories` 行そのものを物理削除しているため、消去後は同じ `content_hash` でも
 * 新しい行が作られる——これは「テナントを消した後は台帳が空になる」ことの、
 * 冪等キーというアプリケーション可視の形での確認である。
 */

afterAll(async () => {
  await closeTestClient();
});

describe("eraseTenant の後、同じ tenantId で再び observe すると新しいテナントとして始まる（Issue #1207 / ADR 0383）", () => {
  it("旧い記憶・設定・activity が見えず、同じ内容の再 observe が新しい id で作られる", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const S = "SECRET-REOBSERVE-FRESH";
    const T = "erase-tenant-reobserve";
    const ctx: Ctx = { tenantId: T };

    const runtime1 = buildEraseTenantTestRuntime(db, S);
    const tenantSettingsStore = new PostgresTenantSettingsStore(db);
    await seedAllTablesForTenant(runtime1, tenantSettingsStore, T, S);

    // 消去前: 設定・activity が実際に存在することを確認する。
    const retentionBefore = await tenantSettingsStore.getEventRetention(ctx);
    expect(retentionBefore.kind).not.toBe("unset");
    const activitySeqBefore = await tenantSettingsStore.getActivitySeq(ctx);
    expect(activitySeqBefore).toBeGreaterThan(0);

    const memoryStore = new PostgresMemoryStore(db);

    const deps = {
      memoryStore,
      vectorStore: new PostgresVectorStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore,
    };
    let outcome = await eraseTenant(ctx, deps, { confirmTenantId: T, limit: 100_000 });
    let guard = 0;
    while (outcome.kind === "executed" && outcome.reachedLimit) {
      guard += 1;
      expect(guard).toBeLessThan(20);
      outcome = await eraseTenant(ctx, deps, { confirmTenantId: T, limit: 100_000 });
    }
    expect(outcome.kind).toBe("executed");

    // 消去後: 設定は unset、activity は初期値（0）。
    const retentionAfter = await tenantSettingsStore.getEventRetention(ctx);
    expect(retentionAfter).toEqual({ kind: "unset" });
    const activitySeqAfter = await tenantSettingsStore.getActivitySeq(ctx);
    expect(activitySeqAfter).toBe(0);
    const hasSubjectActivity = await tenantSettingsStore.hasSubjectActivityCounters?.(ctx);
    expect(hasSubjectActivity).toBe(false);

    // 冪等キーの衝突確認: 消去前と全く同じ content_hash で observe → tick すると、
    // 「既に作成済み」として弾かれず、新しい Memory が作られる。
    const runtime2 = buildEraseTenantTestRuntime(db, S);
    const observed = await runtime2.observe(ctx, {
      kind: "utterance",
      text: `${S} 発話 0`,
      speaker: `${S}-speaker`,
      externalId: `${S}-ext-${T}-reobserve-0`,
    } as never);
    expect(observed.memoryIds.length).toBeGreaterThan(0);
    for (let round = 0; round < 30; round++) {
      const r = await runtime2.tick({ tenantId: T }, {
        kinds: ["extract", "embed"],
        leaseMs: 60_000,
        limit: 10,
      } as never);
      if (r.processed === 0) break;
    }

    // このテナントの memories が実際に1件以上存在する（新規に作られた）。
    const { pool } = await getTestClient();
    const memoriesAfterReobserve = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM memories WHERE tenant_id = $1",
      [T],
    );
    expect(memoriesAfterReobserve.rows[0]!.n).toBeGreaterThan(0);

    // 新しく作られた記憶の内容には、消去前の目印がそのまま使われている
    // （内容そのものの再利用は禁じていない——禁じられるのは「作成済みとして弾かれる」
    // ことだけ）。
    const contentRows = await pool.query<{ content: string }>(
      "SELECT content FROM memories WHERE tenant_id = $1",
      [T],
    );
    expect(contentRows.rows.some((r) => r.content.includes(S))).toBe(true);
  }, 120_000);
});
