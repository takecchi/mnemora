import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, LLMProvider, MemoryStore, Runtime } from "@mnemora/core";
import { ExtractionResultSchema, createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
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

const llm: LLMProvider = {
  complete: async () => ({ content: "unused" }),
  completeStructured: async (_ctx, req) => {
    if ((req.schema as unknown) === ExtractionResultSchema) {
      return req.schema.parse({ memories: [] });
    }
    throw new Error("unexpected schema");
  },
};

const shared = {
  llmProvider: llm,
  embeddingProvider: {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  },
  hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
};

interface Kit {
  runtime: Runtime;
  memoryStore: MemoryStore;
  eventStore: EventStore;
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
      return {
        memoryStore,
        eventStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
          vectorStore: new InMemoryVectorStore(memoryStore),
          eventStore,
          tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
        }),
      };
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const memoryStore = new PostgresMemoryStore(db);
      const eventStore = new PostgresEventStore(db);
      return {
        memoryStore,
        eventStore,
        runtime: createRuntime({
          ...shared,
          memoryStore,
          outboxStore: new PostgresOutboxStore(db),
          vectorStore: new PostgresVectorStore(db),
          eventStore,
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "memory-events-meta-parity" };
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterAll(async () => {
  await closeTestClient();
});

describe.each(KITS)("memory_events の meta（%s）", (_name, build) => {
  it("resolveContested（supersede）の敗者の superseded は、meta.supersededById に勝者の id を持つ", async () => {
    const { runtime, memoryStore, eventStore } = await build();
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "meta-parity-a",
        content: "住所は東京",
      }),
    );
    const b = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "meta-parity-b",
        content: "住所は大阪",
      }),
    );
    await runtime.markContested(ctx, a.id, b.id);

    const out = await runtime.resolveContested(ctx, a.id, b.id, {
      kind: "supersede",
      winnerId: b.id,
    });
    expect(out.supported && out.outcome.kind).toBe("resolved");

    const loser = await eventStore.list(ctx, { memoryId: a.id, kind: "superseded" });
    expect(loser).toHaveLength(1);
    expect(loser[0]!.meta).toEqual({
      reason: "contested_resolved",
      resolution: "supersede",
      contestedWithId: b.id,
      supersededById: b.id,
    });
    const winner = (await eventStore.list(ctx, { memoryId: b.id, kind: "updated" })).filter(
      (e) => e.meta.reason === "contested_resolved",
    );
    expect(winner).toHaveLength(1);
    expect(winner[0]!.meta).toEqual({
      reason: "contested_resolved",
      resolution: "supersede",
      contestedWithId: a.id,
    });
  });

  it("群（markContestedGroup → resolveContestedGroup supersede）が書くイベントの meta は、2実装で同じ", async () => {
    const { runtime, memoryStore, eventStore } = await build();
    const [a, b, c] = await Promise.all(
      ["a", "b", "c"].map((n) =>
        memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `meta-parity-group-${n}` }),
        ),
      ),
    );
    const members = [a!.id, b!.id, c!.id];
    const marked = await runtime.markContestedGroup!(ctx, members, { reason: "mark-note" });
    expect(marked.supported && marked.outcome.kind).toBe("contested_group");
    const out = await runtime.resolveContestedGroup!(
      ctx,
      members,
      { kind: "supersede", winnerId: c!.id },
      { reason: "resolve-note" },
    );
    expect(out.supported && out.outcome.kind).toBe("resolved");

    // 群のイベントは contestedWithId を持たない（2者版との違い）。マークは全員に `updated`、解決は勝者が `updated`・敗者が `superseded`。
    const metasOf = async (id: string, kind: "updated" | "superseded") =>
      (await eventStore.list(ctx, { memoryId: id as never, kind })).map((e) => e.meta);
    for (const id of members) {
      expect((await metasOf(id, "updated")).filter((m) => m.reason === "contested")).toEqual([
        { reason: "contested", note: "mark-note" },
      ]);
    }
    expect(
      (await metasOf(c!.id, "updated")).filter((m) => m.reason === "contested_resolved"),
    ).toEqual([{ reason: "contested_resolved", resolution: "supersede", note: "resolve-note" }]);
    for (const loser of [a!.id, b!.id]) {
      expect(await metasOf(loser, "superseded")).toEqual([
        {
          reason: "contested_resolved",
          resolution: "supersede",
          note: "resolve-note",
          supersededById: c!.id,
        },
      ]);
    }
  });

  it("群の both_active が書くイベントの meta は、2実装で同じ", async () => {
    const { runtime, memoryStore, eventStore } = await build();
    const [a, b, c] = await Promise.all(
      ["a", "b", "c"].map((n) =>
        memoryStore.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: `meta-parity-group-ba-${n}`,
          }),
        ),
      ),
    );
    const members = [a!.id, b!.id, c!.id];
    await runtime.markContestedGroup!(ctx, members);
    const out = await runtime.resolveContestedGroup!(ctx, members, { kind: "both_active" });
    expect(out.supported && out.outcome.kind).toBe("resolved");
    for (const id of members) {
      const metas = (await eventStore.list(ctx, { memoryId: id, kind: "updated" })).map(
        (e) => e.meta,
      );
      expect(metas).toHaveLength(2);
      expect(metas).toContainEqual({ reason: "contested" });
      expect(metas).toContainEqual({ reason: "contested_resolved", resolution: "both_active" });
    }
  });

  it("purgeExpiredEvents の events_purged は、meta の日時を ISO 8601 の文字列で持つ", async () => {
    const { runtime, memoryStore, eventStore } = await build();
    const a = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "meta-parity-purge" }),
    );
    await runtime.forget(ctx, { memoryId: a.id });
    const olderThan = new Date(Date.now() + 3_600_000);

    const result = await memoryStore.purgeExpiredEvents!(ctx, { olderThan, limit: 100 });
    expect(result.purged).toBeGreaterThan(0);

    const events = await eventStore.list(ctx, { kind: "events_purged" });
    expect(events).toHaveLength(1);
    const meta = events[0]!.meta;
    expect(meta.purgedCount).toBe(result.purged);
    for (const key of ["oldestPurgedAt", "newestPurgedAt", "olderThan"] as const) {
      expect(typeof meta[key], key).toBe("string");
      expect(meta[key], key).toMatch(ISO_8601);
    }
    expect(meta.olderThan).toBe(olderThan.toISOString());
    expect(result.oldestPurgedAt).toBeInstanceOf(Date);
  });

  it("purgeExpiredEvents は、別テナントのより古い期限切れイベントに limit を食われず、消した件数・reachedLimit・purgedCount が正確", async () => {
    const { eventStore, memoryStore } = await build();
    const other: Ctx = { tenantId: "memory-events-meta-parity-other" };
    const at = (day: number) => new Date(Date.UTC(2025, 0, day));
    const put = (c: Ctx, day: number) =>
      eventStore.append(c, {
        tenantId: c.tenantId,
        memoryId: null,
        kind: "updated",
        at: at(day),
        actor: { type: "system" },
        meta: {},
      });
    // 別テナントの3件は、こちらの3件より古い（消す行を選ぶ SELECT からテナントの絞りが抜けると、limit の枠を別テナントの行が先に食う）。
    for (const day of [1, 2, 3]) await put(other, day);
    for (const day of [11, 12, 13]) await put(ctx, day);

    const result = await memoryStore.purgeExpiredEvents!(ctx, {
      olderThan: at(28),
      limit: 2,
    });
    expect(result).toMatchObject({ purged: 2, reachedLimit: true, dryRun: false });
    expect(result.oldestPurgedAt).toEqual(at(11));
    expect(result.newestPurgedAt).toEqual(at(12));

    const purged = await eventStore.list(ctx, { kind: "events_purged" });
    expect(purged).toHaveLength(1);
    expect(purged[0]!.meta.purgedCount).toBe(2);
    expect(await eventStore.list(ctx, { kind: "updated" })).toHaveLength(1);
    // 別テナントは何も消えず、events_purged も積まれない。
    expect(await eventStore.list(other, { kind: "updated" })).toHaveLength(3);
    expect(await eventStore.list(other, { kind: "events_purged" })).toEqual([]);
  });
});
