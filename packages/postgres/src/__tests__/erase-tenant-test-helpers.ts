import { createHash } from "node:crypto";
import type { Ctx } from "@mnemora/core";
import {
  ConsolidationLLMResultSchema,
  ExtractionResultSchema,
  ReflectionLLMResultSchema,
  createRuntime,
} from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { getTestClient, TEST_EMBEDDING_SPACE } from "./test-db.js";

/**
 * `eraseTenant`（Issue #1207 / [ADR 0383](../../../../docs/decisions/0383-erase-tenant.md)）
 * のテストファイル群が共有する、テナントに「全表に最低1行」を作るための道具。
 * `erase-tenant.postgres.test.ts`・`erase-tenant-all-tenant-tables.postgres.test.ts`・
 * `erase-tenant-reobserve-fresh.postgres.test.ts` が使う。
 *
 * `S`（秘密の目印）は呼び出し側が渡す——`erase-tenant-all-tenant-tables.postgres.test.ts`
 * は独自の目印を使い、`erase-tenant.postgres.test.ts` は別の目印を使う（並行実行時に
 * 同じ文字列一致で互いのデータを拾わないため）。
 */
export function vecFor(seed: string): (text: string) => number[] {
  return (text: string): number[] => {
    const h = createHash("sha256").update(seed).update(text).digest();
    return [h[0]! / 255 + 0.01, h[1]! / 255, h[2]! / 255];
  };
}

export function buildEraseTenantTestRuntime(
  db: Awaited<ReturnType<typeof getTestClient>>["db"],
  S: string,
) {
  let n = 0;
  const vec = vecFor(S);
  return createRuntime({
    memoryStore: new PostgresMemoryStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
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
    hashContent: (content: string) => createHash("sha256").update(S).update(content).digest("hex"),
    clock: { now: () => new Date(Date.now() + 60_000) },
    config: { autoQueueConsolidateReflectOnExtract: true },
  } as never);
}

/**
 * このテナントについて、`eraseTenant` が消す全表（`memories`・`observations`・
 * `memory_events`・`recalls`・`recall_usages`・`outbox`・`labels`・`memory_labels`・
 * `tenant_activity`・`tenant_subject_activity`・`tenant_settings`・埋め込み空間の表）に
 * 最低1行を作る。
 */
export async function seedAllTablesForTenant(
  runtime: ReturnType<typeof buildEraseTenantTestRuntime>,
  tenantSettingsStore: PostgresTenantSettingsStore,
  tenantId: string,
  S: string,
): Promise<void> {
  const subjectId = `${S}-subject`;
  const ctx: Ctx = { tenantId, subjectId };
  // decayClock を進めておかないと `advanceActivityClock` が常に false のまま
  // （`tenant_activity`/`tenant_subject_activity` に行が作られない。`recall-runtime.ts`
  // 参照）。
  await tenantSettingsStore.setDecayClock(ctx, "either" as never);

  for (let i = 0; i < 6; i++) {
    await runtime.observe(ctx, {
      kind: "utterance",
      text: `${S} 発話 ${i}`,
      speaker: `${S}-speaker`,
      externalId: `${S}-ext-${tenantId}-${i}`,
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
  // tenant_activity（テナント単位カウンタ）。
  await runtime.recall(ctx, {
    text: `${S} の問い`,
    limit: 3,
    activityCounting: "tenant",
  } as never);
  // tenant_subject_activity（subject 単位カウンタ）。
  const recalled = await runtime.recall(ctx, {
    text: `${S} の問い2`,
    limit: 3,
    activityCounting: "subject",
  } as never);
  await runtime.observe(ctx, {
    kind: "memory_usage",
    recallId: recalled.recallId,
    usedMemoryIds: recalled.memories.slice(0, 1).map((m: { memoryId: unknown }) => m.memoryId),
  } as never);
  // tenant_settings。observe/tick/recall だけでは行が作られない。
  await tenantSettingsStore.setEventRetention(ctx, { kind: "unlimited" } as never);
}
