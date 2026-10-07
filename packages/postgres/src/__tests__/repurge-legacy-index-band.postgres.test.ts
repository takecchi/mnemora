import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { DeterministicEmbeddingProvider, DeterministicLLMProvider } from "@mnemora/testkit";
import type { Db } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { sha256Hex } from "../content-hash.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 旧版（v1.0.x）の `purgeMemory` は `recalls.index_band` の `digestBand` を書き換えなかったので、purge より前に撃った recall の `index_band` に、purge 済みの記憶の digest が残りうる。
 * その状態は、今の purge で作ったあと、`index_band` だけを purge 前の値へ SQL で戻して再現する。
 */

type Band = { digestBand: { memoryId: string; digest: string; truncated?: boolean }[] } & Record<
  string,
  unknown
>;

async function bandsOf(db: Db, tenantId: string): Promise<Band[]> {
  const r = await db.execute(
    sql`SELECT index_band FROM recalls WHERE tenant_id = ${tenantId} ORDER BY id`,
  );
  return (r.rows as unknown as { index_band: Band }[]).map((x) => x.index_band);
}

function digestsFor(bands: Band[], memoryId: string): string[] {
  return bands.flatMap((b) =>
    (b.digestBand ?? []).filter((e) => e.memoryId === memoryId).map((e) => e.digest),
  );
}

describe("v1.0.x の purge が recalls.index_band に残した digest は、purge のかけ直しで伏せられる（ADR 0512、本物の Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestClient();
  });

  async function setup() {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const runtime = createRuntime({
      memoryStore: store,
      outboxStore: new PostgresOutboxStore(db),
      vectorStore: new PostgresVectorStore(db),
      eventStore: new PostgresEventStore(db),
      tenantSettingsStore: new PostgresTenantSettingsStore(db),
      llmProvider: new DeterministicLLMProvider(),
      embeddingProvider: new DeterministicEmbeddingProvider(TEST_EMBEDDING_SPACE),
      hashContent: sha256Hex,
    });
    const tenantId = `tenant-band-${randomUUID()}`;
    const ctx: Ctx = { tenantId };
    for (let i = 0; i < 4; i++) {
      await runtime.observe(ctx, {
        kind: "utterance",
        text: `東京 会議 秘密の本文${i}`,
        speaker: "user",
      });
    }
    await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000, limit: 100 });
    await runtime.recall(ctx, { text: "東京 会議", limit: 10, budget: { maxMemoryChars: 25 } });
    const original = await bandsOf(db, tenantId);
    const entries = original[0]!.digestBand;
    expect(entries.length).toBeGreaterThanOrEqual(2); // 前提: 目次帯に2件以上載っている
    const target = entries[0]!;
    const bystander = entries[1]!;
    return { db, store, runtime, tenantId, ctx, original, target, bystander };
  }

  it("陽性対照: 今の purge は、purge 時に目次帯の digest を伏せる（残るのは v1.0.x の purge の残骸だけ）", async () => {
    const { db, runtime, tenantId, ctx, target, bystander } = await setup();
    await runtime.forget(ctx, { memoryId: target.memoryId });
    const r = await runtime.purge(ctx, { memoryId: target.memoryId });
    expect(r.outcomes[0]?.kind).toBe("purged");
    const bands = await bandsOf(db, tenantId);
    expect(digestsFor(bands, target.memoryId)).toEqual(["[purged]"]);
    expect(digestsFor(bands, bystander.memoryId)).toEqual([bystander.digest]);
  });

  it("v1.0.x の purge が残した digest は、purge をかけ直すと伏せられる。他の記憶・未 purge の forgotten・他テナントの帯は触らない", async () => {
    const { db, store, runtime, tenantId, ctx, original, target, bystander } = await setup();

    // 他テナントにも同じ形の帯（別の記憶の digest）を置く。
    const otherTenant = `tenant-band-other-${randomUUID()}`;
    const otherCtx: Ctx = { tenantId: otherTenant };
    for (let i = 0; i < 4; i++) {
      await runtime.observe(otherCtx, {
        kind: "utterance",
        text: `東京 会議 他テナント${i}`,
        speaker: "user",
      });
    }
    await runtime.tick(otherCtx, { kinds: ["embed"], leaseMs: 60_000, limit: 100 });
    await runtime.recall(otherCtx, {
      text: "東京 会議",
      limit: 10,
      budget: { maxMemoryChars: 25 },
    });
    const otherBefore = await bandsOf(db, otherTenant);

    // 旧版の purge を再現する: 今の purge をかけ、index_band だけを purge 前の値へ戻す。
    await runtime.forget(ctx, { memoryId: target.memoryId });
    await runtime.forget(ctx, { memoryId: bystander.memoryId }); // forgotten だが未 purge
    await runtime.purge(ctx, { memoryId: target.memoryId });
    await db.execute(sql`
      UPDATE recalls SET index_band = ${JSON.stringify(original[0])}::jsonb
      WHERE tenant_id = ${tenantId}
    `);
    expect(digestsFor(await bandsOf(db, tenantId), target.memoryId)).toEqual([target.digest]);
    const purgedRow = await db.execute(
      sql`SELECT purged_at IS NOT NULL AS purged, digest FROM memories WHERE id = ${target.memoryId}`,
    );
    expect(purgedRow.rows[0]).toMatchObject({ purged: true, digest: "[purged]" });

    await runtime.purge(ctx, { memoryId: target.memoryId }, { dryRun: true });
    expect(digestsFor(await bandsOf(db, tenantId), target.memoryId)).toEqual([target.digest]);

    const redo = await runtime.purge(ctx, { memoryId: target.memoryId });
    expect(redo.outcomes[0]?.kind).toBe("already_purged");
    const after = await bandsOf(db, tenantId);
    expect(digestsFor(after, target.memoryId)).toEqual(["[purged]"]);
    expect(digestsFor(after, bystander.memoryId)).toEqual([bystander.digest]);
    expect(after[0]!.digestBand.map((e) => e.memoryId)).toEqual(
      original[0]!.digestBand.map((e) => e.memoryId),
    );
    expect({ ...after[0], digestBand: undefined }).toEqual({
      ...original[0],
      digestBand: undefined,
    });
    expect(await bandsOf(db, otherTenant)).toEqual(otherBefore);

    await runtime.purge(ctx, { memoryId: target.memoryId });
    expect(await bandsOf(db, tenantId)).toEqual(after);

    // store を直接呼んでも同じ（未 purge の行は、id を渡されても触らない）。
    await store.scrubPurged!(ctx, [bystander.memoryId]);
    expect(digestsFor(await bandsOf(db, tenantId), bystander.memoryId)).toEqual([bystander.digest]);
  });
});
