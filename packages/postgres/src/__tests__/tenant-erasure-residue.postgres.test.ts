import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryId } from "@mnemora/core";
import {
  ConsolidationLLMResultSchema,
  ExtractionResultSchema,
  ReflectionLLMResultSchema,
  createRuntime,
  purgeExpiredEventsForTenant,
} from "@mnemora/core";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 1つのテナントを消去した後（全記憶を forget → purge し、イベントの保持期間を1日にして掃除した後）に、
 * 表ごとに何が残るかを縛る（`docs/memory-model.md` §9 の 2026-09-29 追記、Issue #1207、
 * [ADR 0375](../../../../docs/decisions/0375-purge-scope-widened.md)）。
 *
 * ADR 0375 より前は、この歯は「今の振る舞い」を書き写すだけで約束を足すものではなかった
 * （`tags`・`memory_labels`・`recalls.index_band` の digest 帯がどれも残ることを、消すべきかの
 * 決定が無いまま記録していた）。ADR 0375 決定1〜3 がこれらを purge の契約に含めたため、
 * この歯は**いまは契約——(a) で消えると書いた列が実際に消えることを縛る**。(b) として
 * 残ると決めたもの（`recalls.query`・`content_hash`・`provenance.speaker`・
 * `observations.payload`・完了した outbox の行・`recall_usages`）は、これまでどおり
 * 「決まっていない」ではなく ADR 0375「(b) 残る」表の約束として残る。
 */

const T = "erase-me";
const OTHER = "keep-me";
const S = "SECRET-ERASE";
const vec = (text: string): number[] => {
  const h = createHash("sha256").update(text).digest();
  return [h[0]! / 255 + 0.01, h[1]! / 255, h[2]! / 255];
};

afterAll(async () => {
  await closeTestClient();
});

describe("1つのテナントを消去した後に残るもの（今の振る舞い）", () => {
  it("全記憶の purge と保持期間の掃除の後、表ごとの残り", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    const memoryStore = new PostgresMemoryStore(db);
    const tenantSettingsStore = new PostgresTenantSettingsStore(db);
    let n = 0;
    const runtime = createRuntime({
      memoryStore,
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore,
      llmProvider: {
        complete: async () => ({ content: "unused" }),
        completeStructured: async (_ctx: Ctx, req: { schema: unknown }) => {
          n += 1;
          if (req.schema === ExtractionResultSchema) {
            return ExtractionResultSchema.parse({
              memories: [
                {
                  content: `${S} 本文 ${n}`,
                  digest: `${S} 要旨 ${n}`,
                  provenanceKind: "stated",
                  tags: [`${S}-tag`],
                },
              ],
            }) as never;
          }
          if (req.schema === ConsolidationLLMResultSchema) {
            return ConsolidationLLMResultSchema.parse({ content: `${S} 統合 ${n}` }) as never;
          }
          if (req.schema === ReflectionLLMResultSchema) {
            return ReflectionLLMResultSchema.parse({
              outcome: "reflected",
              content: `${S} 内省 ${n}`,
            }) as never;
          }
          throw new Error("unexpected schema");
        },
      } as never,
      embeddingProvider: {
        space: TEST_EMBEDDING_SPACE,
        embed: async (_ctx: Ctx, texts: string[]) => texts.map(vec),
      } as never,
      hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
      clock: { now: () => new Date(Date.now() + 60_000) },
      config: { autoQueueConsolidateReflectOnExtract: true },
    } as never);

    for (const tenantId of [T, OTHER]) {
      const ctx: Ctx = { tenantId, subjectId: `${S}-subject` };
      for (let i = 0; i < 6; i++) {
        await runtime.observe(ctx, {
          kind: "utterance",
          text: `${S} 発話 ${i}`,
          speaker: `${S}-speaker`,
          externalId: `${S}-ext-${i}`,
          attributes: { owner: `${S}-owner` },
          ...(i % 2 === 1 ? { extract: "deferred" } : {}),
        } as never);
      }
      for (let round = 0; round < 30; round++) {
        const r = await runtime.tick({ tenantId }, {
          kinds: ["extract", "embed", "consolidate", "reflect"],
          leaseMs: 60_000,
          limit: 10,
        } as never);
        if (r.processed === 0) break;
      }
      const recalled = await runtime.recall(ctx, { text: `${S} の問い`, limit: 3 } as never);
      await runtime.observe(ctx, {
        kind: "memory_usage",
        recallId: recalled.recallId,
        usedMemoryIds: recalled.memories.slice(0, 1).map((m) => m.memoryId),
      } as never);
    }

    const countOf = async (table: string, tenantId: string, where = "true"): Promise<number> => {
      const r = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} x WHERE tenant_id = $1 AND (${where})`,
        [tenantId],
      );
      return r.rows[0]!.n;
    };
    const tables = [
      "memories",
      "observations",
      embeddingSpaceTableName(TEST_EMBEDDING_SPACE),
      "labels",
      "memory_labels",
      "recalls",
      "recall_usages",
      "outbox",
      "memory_events",
      "tenant_settings",
    ];
    const otherBefore = Object.fromEntries(
      await Promise.all(tables.map(async (t) => [t, await countOf(t, OTHER)] as const)),
    );

    // 消去
    const ctxT: Ctx = { tenantId: T };
    const ids = (
      await pool.query<{ id: string }>("SELECT id FROM memories WHERE tenant_id = $1", [T])
    ).rows.map((r) => r.id as MemoryId);
    await runtime.forget(ctxT, { memoryIds: ids });
    const purged = await runtime.purge(ctxT, { memoryIds: ids });
    expect(purged.outcomes.every((o) => o.kind === "purged")).toBe(true);
    await tenantSettingsStore.setEventRetention(ctxT, { kind: "days", days: 1 } as never);
    const retention = await purgeExpiredEventsForTenant(
      ctxT,
      { memoryStore, tenantSettingsStore },
      {
        limit: 100_000,
        now: new Date("2100-01-01T00:00:00.000Z"),
      },
    );
    expect(retention.kind).toBe("executed");

    const secret = `to_jsonb(x)::text LIKE '%${S}%'`;
    // memories: 行は残る。(a) content・digest・tags・attributes・claim key は消える。
    // (b) provenance.speaker・subject_id は ADR 0375 でも残ると決めた（決まっていない、ではなく約束）。
    expect(await countOf("memories", T)).toBe(ids.length);
    expect(await countOf("memories", T, `content LIKE '%${S}%' OR digest LIKE '%${S}%'`)).toBe(0);
    expect(await countOf("memories", T, `provenance->>'speaker' = '${S}-speaker'`)).toBeGreaterThan(
      0,
    );
    // ADR 0375 決定1: tags はこのテナントの全記憶から消える（extract・consolidate・reflect の
    // どの由来の Memory も、purge の前は `${S}-tag` を持っていた——`ids.length` は下の変更前の
    // 期待値だったが、purge 後は0件でなければならない）。
    expect(await countOf("memories", T, `tags::text LIKE '%${S}%'`)).toBe(0);
    // observations: payload・attributes・subject_id・external_id が元のまま（(b)、Observation に
    // purge の経路は無い）。
    expect(await countOf("observations", T, `payload::text LIKE '%${S} 発話%'`)).toBe(6);
    expect(await countOf("observations", T, `external_id LIKE '${S}-ext-%'`)).toBe(6);
    // 今の空間の埋め込みは消える。
    expect(await countOf(embeddingSpaceTableName(TEST_EMBEDDING_SPACE), T)).toBe(0);
    // labels: 行そのものは残る（名前を消す口が無い、ADR 0318）が、proposed_count はこの
    // テナントの purge で0まで減る（ADR 0375 決定2、近似のまま床は0）。
    // memory_labels: 紐付けはすべて外れる（ADR 0375 決定2）。
    expect(await countOf("labels", T, secret)).toBe(1);
    {
      const proposedCount = await pool.query<{ proposed_count: number }>(
        `SELECT proposed_count FROM labels WHERE tenant_id = $1 AND name = $2`,
        [T, `${S}-tag`],
      );
      expect(proposedCount.rows[0]?.proposed_count).toBe(0);
    }
    expect(await countOf("memory_labels", T)).toBe(0);
    // recalls: 行そのものは全部残る（(b)、保持方針は #1207 で決まっていない）。
    // query（問いの本文・consolidate/reflect の種の digest）は (b) として残る
    // ——`memoryId` で特定できないため purge では触らない（ADR 0375 決定4）。
    expect(await countOf("recalls", T, `query->>'text' = '${S} の問い'`)).toBe(1);
    expect(await countOf("recalls", T, `query->>'text' LIKE '${S} 要旨 %'`)).toBeGreaterThan(0);
    // index_band の digest 帯は (a) として伏せられる（ADR 0375 決定3）——この元の要旨は
    // どの recall 行の index_band にも、もう文字列としては現れない。
    expect(await countOf("recalls", T, `index_band::text LIKE '%${S} 要旨%'`)).toBe(0);
    expect(await countOf("recall_usages", T)).toBe(1);
    // outbox: 完了した行が残る（payload は id だけ）。
    expect(await countOf("outbox", T)).toBeGreaterThan(0);
    expect(await countOf("outbox", T, secret)).toBe(0);
    // memory_events: 保持期間の掃除で消え、events_purged の行だけが残る（ADR 0115 決定4）。
    const kinds = await pool.query<{ kind: string }>(
      "SELECT DISTINCT kind FROM memory_events WHERE tenant_id = $1",
      [T],
    );
    expect(kinds.rows.map((r) => r.kind)).toEqual(["events_purged"]);
    // tenant_settings の行は残る。
    expect(await countOf("tenant_settings", T)).toBe(1);

    // 別テナントの行は変わらない。
    for (const t of tables) {
      expect({ t, n: await countOf(t, OTHER) }).toEqual({ t, n: otherBefore[t] });
    }
  }, 120_000);
});
