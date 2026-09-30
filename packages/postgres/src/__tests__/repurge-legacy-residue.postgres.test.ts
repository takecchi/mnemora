import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import {
  DeterministicEmbeddingProvider,
  DeterministicLLMProvider,
  buildNewMemoryFixture,
} from "@mnemora/testkit";
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
 * ADR 0437 決定3: v1.0.0〜v1.0.2 の `purgeMemory` は `content`・`digest`・`purged_at` しか書き換えず、
 * `tags`・`attributes`・claim key・`memory_labels` が残った（v1.1.0 の ADR 0375 が消すようになったが、
 * migration は遡らない）。`Runtime.purge` をかけ直すと（`already_purged`）、それらが消え、
 * `labels.proposed_count` が実数に揃う。
 *
 * v1.0.x の purge が残した状態は SQL で作る（今の `purgeMemory` では作れない）。
 */

async function labelCounts(
  db: Db,
  tenantId: string,
): Promise<Record<string, { proposedCount: number; links: number }>> {
  const r = await db.execute(sql`
    SELECT l.name, l.proposed_count::int AS proposed_count,
           (SELECT count(*)::int FROM memory_labels ml WHERE ml.label_id = l.id) AS links
    FROM labels l WHERE l.tenant_id = ${tenantId} ORDER BY l.name
  `);
  const out: Record<string, { proposedCount: number; links: number }> = {};
  for (const row of r.rows as unknown as {
    name: string;
    proposed_count: number;
    links: number;
  }[]) {
    out[row.name] = { proposedCount: row.proposed_count, links: row.links };
  }
  return out;
}

async function residueOf(db: Db, id: string) {
  const r = await db.execute(sql`
    SELECT tags, attributes, claim_key_subject, claim_key_predicate, content, digest,
           purged_at IS NOT NULL AS purged, status,
           (SELECT count(*)::int FROM memory_labels WHERE memory_id = memories.id) AS links,
           (SELECT count(*)::int FROM memory_events WHERE memory_id = memories.id) AS events
    FROM memories WHERE id = ${id}
  `);
  return r.rows[0] as unknown as {
    tags: string[];
    attributes: Record<string, unknown>;
    claim_key_subject: string | null;
    claim_key_predicate: string | null;
    content: string;
    digest: string;
    purged: boolean;
    status: string;
    links: number;
    events: number;
  };
}

describe("v1.1.0 より前に purge した行は、purge をかけ直すと消える（ADR 0437 決定3、本物の Postgres）", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestClient();
  });

  it("tags・attributes・claim key・memory_labels が消え、labels.proposed_count が実数に揃う。dryRun は何もせず、2回目以降は変わらない", async () => {
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
    const tenantId = `tenant-repurge-${randomUUID()}`;
    const ctx: Ctx = { tenantId };
    const claimKey = { subject: "user", predicate: "home_city" };

    // v1.0.x で purge した行（SQL で再現する）。
    const legacy = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId,
        contentHash: "repurge-legacy",
        status: "forgotten",
        tags: ["tag-x", "tag-y"],
        attributes: { owner: "alice" },
        claimKey,
      }),
    );
    // まだ生きている行（同じ label を使い続ける）。
    const live = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId, contentHash: "repurge-live", tags: ["tag-x"] }),
    );
    // 今のコードで purge した行（残骸は purge 自身が消し、件数も purge が減らした）。
    const current = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId,
        contentHash: "repurge-current",
        status: "forgotten",
        tags: ["tag-y"],
        attributes: { owner: "bob" },
        claimKey,
      }),
    );
    // 未 purge の forgotten（触ってはいけない）。
    const unpurged = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId,
        contentHash: "repurge-unpurged",
        status: "forgotten",
        tags: ["tag-x"],
        attributes: { owner: "carol" },
        claimKey,
      }),
    );
    await db.execute(sql`
      UPDATE memories SET content = '[purged]', digest = '[purged]', purged_at = now()
      WHERE id = ${legacy.id}
    `);
    const purgedNow = await runtime.purge(ctx, { memoryId: current.id });
    expect(purgedNow.outcomes[0]?.kind).toBe("purged");

    // 前提: v1.0.x の状態が作れている。件数は「生きている紐付け + 残骸の紐付け」で、実数より多い。
    const legacyBefore = await residueOf(db, legacy.id);
    expect(legacyBefore).toMatchObject({
      purged: true,
      tags: ["tag-x", "tag-y"],
      claim_key_subject: "user",
      links: 2,
    });
    expect(await labelCounts(db, tenantId)).toEqual({
      "tag-x": { proposedCount: 3, links: 3 }, // legacy + live + unpurged
      "tag-y": { proposedCount: 1, links: 1 }, // legacy（current は purge 済み）
    });
    const unpurgedBefore = await residueOf(db, unpurged.id);
    const eventsBefore = legacyBefore.events;

    // dryRun は何も書かない。
    const dry = await runtime.purge(
      ctx,
      { memoryIds: [legacy.id, current.id, unpurged.id] },
      { dryRun: true },
    );
    expect(dry.outcomes.map((o) => o.kind)).toEqual([
      "already_purged",
      "already_purged",
      "would_purge",
    ]);
    expect(await residueOf(db, legacy.id)).toEqual(legacyBefore);
    expect(await labelCounts(db, tenantId)).toEqual({
      "tag-x": { proposedCount: 3, links: 3 },
      "tag-y": { proposedCount: 1, links: 1 },
    });

    // purge のかけ直し。
    const redo = await runtime.purge(ctx, { memoryIds: [legacy.id, current.id] });
    expect(redo.outcomes).toEqual([
      { memoryId: legacy.id, kind: "already_purged" },
      { memoryId: current.id, kind: "already_purged" },
    ]);
    const legacyAfter = await residueOf(db, legacy.id);
    expect(legacyAfter).toMatchObject({
      purged: true,
      status: "forgotten",
      tags: [],
      attributes: {},
      claim_key_subject: null,
      claim_key_predicate: null,
      links: 0,
      content: "[purged]",
      events: eventsBefore, // 監査イベントは積まない
    });
    // labels の件数は実数（残っている紐付けの本数）に揃う。0 を割らず、二重に減らさない。
    expect(await labelCounts(db, tenantId)).toEqual({
      "tag-x": { proposedCount: 2, links: 2 }, // live + unpurged
      "tag-y": { proposedCount: 0, links: 0 },
    });
    // 触ってはいけない行は、そのまま。
    expect(await residueOf(db, unpurged.id)).toEqual(unpurgedBefore);
    expect((await residueOf(db, live.id)).tags).toEqual(["tag-x"]);

    // べき等。
    const again = await runtime.purge(ctx, { memoryIds: [legacy.id, current.id] });
    expect(again.outcomes.map((o) => o.kind)).toEqual(["already_purged", "already_purged"]);
    expect(await residueOf(db, legacy.id)).toEqual(legacyAfter);
    expect(await labelCounts(db, tenantId)).toEqual({
      "tag-x": { proposedCount: 2, links: 2 },
      "tag-y": { proposedCount: 0, links: 0 },
    });
  });
});
