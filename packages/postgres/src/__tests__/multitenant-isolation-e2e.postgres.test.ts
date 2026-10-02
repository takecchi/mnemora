import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import {
  ConsolidationLLMResultSchema,
  ExtractionResultSchema,
  ReflectionLLMResultSchema,
  createRuntime,
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
 * 多数のテナントで、observe → tick → recall → forget を**1つの Runtime を共有して並行に**回したとき、
 * テナントが混ざらないこと（端から端まで）。store の口ごとの分離は各 store の適合テストが見ているので、
 * ここでは Runtime を通した並行の流れだけを見る。
 *
 * - 15テナントを `Promise.all` で同時に回す。1テナント（`BAD`）だけ、LLM と埋め込みの偽物が毎回失敗する。
 * - どの recall も自分のテナントの記憶しか返さない（返った記憶を1件ずつ DB で引いて確かめる）。
 * - イベント・outbox・recall の記録・出どころ・置き換え・埋め込みの行が、別テナントの記憶を指さない
 *   （下の `CROSS_TENANT_CHECKS` を SQL で数え、どれも0件）。
 * - `BAD` の失敗が、ほかのテナントの処理を止めない（ほかのテナントの outbox は全部完了する）。
 */

const BAD = "t-bad";
const TENANTS = [...Array.from({ length: 14 }, (_, i) => `t${String(i).padStart(2, "0")}`), BAD];
const OBSERVATIONS_PER_TENANT = 12;
const RECALLS_PER_TENANT = 6;

const vec = (text: string): number[] => {
  const h = createHash("sha256").update(text).digest();
  return [h[0]! / 255 + 0.01, h[1]! / 255, h[2]! / 255];
};

/** 別テナントの記憶を指しているものを数える SQL。どれも0件であること。 */
const CROSS_TENANT_CHECKS: Array<[string, string]> = [
  [
    "イベントの memory",
    "SELECT count(*)::int AS n FROM memory_events e JOIN memories m ON m.id = e.memory_id WHERE e.tenant_id <> m.tenant_id",
  ],
  [
    "outbox の payload.memoryId",
    "SELECT count(*)::int AS n FROM outbox o JOIN memories m ON m.id = (o.payload->>'memoryId')::uuid WHERE o.tenant_id <> m.tenant_id",
  ],
  [
    "outbox の payload.observationId",
    "SELECT count(*)::int AS n FROM outbox o JOIN observations b ON b.id = (o.payload->>'observationId')::uuid WHERE o.tenant_id <> b.tenant_id",
  ],
  [
    "recall の記録の returned_memories",
    "SELECT count(*)::int AS n FROM recalls r, jsonb_array_elements(r.returned_memories->'memories') x JOIN memories m ON m.id = (x->>'memoryId')::uuid WHERE r.tenant_id <> m.tenant_id",
  ],
  [
    "記憶の元の Observation",
    "SELECT count(*)::int AS n FROM memories m JOIN observations b ON b.id = m.source_observation_id WHERE m.tenant_id <> b.tenant_id",
  ],
  [
    "provenance.sources",
    "SELECT count(*)::int AS n FROM memories m, jsonb_array_elements_text(m.provenance->'sources') s JOIN memories src ON src.id = s::uuid WHERE m.tenant_id <> src.tenant_id",
  ],
  [
    "superseded_by_id",
    "SELECT count(*)::int AS n FROM memories m JOIN memories w ON w.id = m.superseded_by_id WHERE m.tenant_id <> w.tenant_id",
  ],
  [
    "埋め込みの行",
    `SELECT count(*)::int AS n FROM ${embeddingSpaceTableName(TEST_EMBEDDING_SPACE)} e JOIN memories m ON m.id = e.memory_id WHERE e.tenant_id <> m.tenant_id`,
  ],
  [
    "本文の目印",
    "SELECT count(*)::int AS n FROM memories WHERE content LIKE '[%]%' AND content NOT LIKE '[' || tenant_id || ']%'",
  ],
];

afterAll(async () => {
  await closeTestClient();
});

describe("多数のテナントを1つの Runtime で並行に回しても、テナントが混ざらない", () => {
  it("15テナント・1テナントだけ LLM と埋め込みが失敗", async () => {
    await resetTestDatabase();
    const { db, pool } = await getTestClient();
    let n = 0;
    const runtime = createRuntime({
      memoryStore: new PostgresMemoryStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      outboxStore: new PostgresOutboxStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: {
        complete: async () => ({ content: "unused" }),
        completeStructured: async (ctx: Ctx, req: { schema: unknown }) => {
          // 並行の順序を揺らす（テナントどうしの呼び出しを交互に混ぜる）。
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
          if (ctx.tenantId === BAD) throw new Error(`LLM down for ${BAD}`);
          n += 1;
          const mark = `[${ctx.tenantId}]`;
          if (req.schema === ExtractionResultSchema) {
            return ExtractionResultSchema.parse({
              memories: [
                { content: `${mark} 事実 ${n}`, provenanceKind: "stated", tags: ["共通"] },
              ],
            }) as never;
          }
          if (req.schema === ConsolidationLLMResultSchema) {
            return ConsolidationLLMResultSchema.parse({ content: `${mark} 統合 ${n}` }) as never;
          }
          if (req.schema === ReflectionLLMResultSchema) {
            return ReflectionLLMResultSchema.parse({
              outcome: "reflected",
              content: `${mark} 内省 ${n}`,
            }) as never;
          }
          throw new Error("unexpected schema");
        },
      } as never,
      embeddingProvider: {
        space: TEST_EMBEDDING_SPACE,
        embed: async (ctx: Ctx, texts: string[]) => {
          if (ctx.tenantId === BAD) throw new Error(`embed down for ${BAD}`);
          return texts.map(vec);
        },
      } as never,
      hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
      // runtime の時計を先に進める。歴史的な理由で残している（今は available_at も注入した時計に従う。ADR 0559。operation-roundtrip-shape も見ること）。
      clock: { now: () => new Date(Date.now() + 60_000) },
      config: { autoQueueConsolidateReflectOnExtract: true },
    } as never);

    const leaks: string[] = [];
    const errors: string[] = [];
    await Promise.all(
      TENANTS.map(async (tenantId) => {
        const ctx: Ctx = { tenantId };
        try {
          for (let i = 0; i < OBSERVATIONS_PER_TENANT; i++) {
            await runtime.observe(ctx, {
              kind: "utterance",
              text: `[${tenantId}] 発話 ${i}`,
              ...(i % 2 === 1 ? { extract: "deferred" } : {}),
            } as never);
          }
          for (let round = 0; round < 40; round++) {
            const r = await runtime.tick(ctx, {
              kinds: ["extract", "embed", "consolidate", "reflect"],
              leaseMs: 60_000,
              limit: 5,
            } as never);
            if (r.processed === 0) break;
          }
          for (let i = 0; i < RECALLS_PER_TENANT; i++) {
            const r = await runtime.recall(ctx, {
              text: `[${tenantId}] 事実 ${i}`,
              limit: 5,
            } as never);
            for (const memory of r.memories) {
              // 行の tenant_id と、本文の目印（書いたテナント）の両方を見る——行の tenant_id が
              // 書き換わって混ざった場合も、目印で分かる。
              const row = await pool.query<{ tenant_id: string; content: string }>(
                "SELECT tenant_id, content FROM memories WHERE id = $1",
                [memory.memoryId],
              );
              const found = row.rows[0];
              const markedFor = /^\[([^\]]+)\]/.exec(found?.content ?? "")?.[1];
              if (
                found?.tenant_id !== tenantId ||
                (markedFor !== undefined && markedFor !== tenantId)
              ) {
                leaks.push(`${tenantId} <- ${memory.memoryId} (${found?.content})`);
              }
            }
          }
          const own = await pool.query<{ id: string }>(
            "SELECT id FROM memories WHERE tenant_id = $1 AND status = 'active' ORDER BY id LIMIT 3",
            [tenantId],
          );
          const forgotten = await runtime.forget(ctx, {
            memoryIds: own.rows.map((r) => r.id) as never,
          });
          expect(forgotten.outcomes.map((o) => o.kind)).toEqual([
            "forgotten",
            "forgotten",
            "forgotten",
          ]);
        } catch (error) {
          errors.push(`${tenantId}: ${(error as Error).message}`);
        }
      }),
    );

    expect(errors).toEqual([]);
    expect(leaks).toEqual([]);

    for (const [label, sql] of CROSS_TENANT_CHECKS) {
      const result = await pool.query<{ n: number }>(sql);
      expect({ label, n: result.rows[0]?.n }).toEqual({ label, n: 0 });
    }

    // BAD の失敗が、ほかのテナントの outbox を止めない。
    const others = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE tenant_id <> $1 AND completed_at IS NULL",
      [BAD],
    );
    expect(others.rows[0]?.n).toBe(0);
    const othersDone = await pool.query<{ n: number }>(
      "SELECT count(DISTINCT tenant_id)::int AS n FROM outbox WHERE tenant_id <> $1 AND completed_at IS NOT NULL",
      [BAD],
    );
    expect(othersDone.rows[0]?.n).toBe(TENANTS.length - 1);
    // BAD 自身も止まらずに進んだ（未処理のまま残ったジョブが無い）。
    const badPending = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND completed_at IS NULL AND failed_at IS NULL",
      [BAD],
    );
    expect(badPending.rows[0]?.n).toBe(0);
  }, 120_000);
});
