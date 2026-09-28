import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore } from "@mnemora/core";
import { EventActorSchema, EventFilterSchema } from "@mnemora/core";
import { InMemoryEventStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `EventFilterSchema.limit`・`EventActorSchema.id` は store より厳しい（今の振る舞い。6回目の TSDoc の棚卸し）。
 * schema は `limit: 0` と空文字の `id` を拒むが、`EventStore.list`・`append` はこの schema で検査しないので、
 * `limit: 0` は0件を返し、空文字の `id` はそのまま保存される。負数の `limit` は store も例外にする。
 * `@mnemora/postgres` と testkit の fixture の2実装で縛る（core の Fake の側は
 * `packages/core/src/__tests__/zod-schema-constraints-tsdoc-edges.test.ts`）。振る舞いは変えていない。
 */

const ctx: Ctx = { tenantId: "event-filter-actor-schema-vs-store" };

const KITS: Array<[string, () => Promise<EventStore>]> = [
  [
    "testkit の InMemory",
    async () => {
      const memoryStore = new InMemoryMemoryStore();
      return new InMemoryEventStore(memoryStore, memoryStore.events);
    },
  ],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return new PostgresEventStore(db);
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

describe("EventFilterSchema・EventActorSchema は store より厳しい（今の振る舞い）", () => {
  it("schema は limit: 0 と空文字の actor.id を拒む", () => {
    expect({
      filterLimit0: EventFilterSchema.safeParse({ limit: 0 }).success,
      actorEmptyId: EventActorSchema.safeParse({ type: "human", id: "" }).success,
    }).toEqual({ filterLimit0: false, actorEmptyId: false });
  });

  for (const [kitName, makeStore] of KITS) {
    it(`${kitName}: 空文字の actor.id をそのまま保存し、limit: 0 は0件、limit: -1 は例外`, async () => {
      const store = await makeStore();
      const appended = await store.append(ctx, {
        tenantId: ctx.tenantId,
        memoryId: null,
        kind: "events_purged",
        actor: { type: "human", id: "" },
        meta: {},
      });

      const listed = await store.list(ctx, { limit: 0 });
      const all = await store.list(ctx, {});

      expect({
        appendedActor: appended.actor,
        storedActor: all.map((e) => e.actor),
        listedWithLimit0: listed.length,
      }).toEqual({
        appendedActor: { type: "human", id: "" },
        storedActor: [{ type: "human", id: "" }],
        listedWithLimit0: 0,
      });
      await expect(store.list(ctx, { limit: -1 })).rejects.toThrow();
    });
  }
});
