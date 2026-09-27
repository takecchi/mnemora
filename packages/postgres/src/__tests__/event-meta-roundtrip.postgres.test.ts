import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, MemoryStore, Runtime } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
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

/**
 * 監査ログ（`memory_events`）の `meta`・`actor` に JSON で往復しない値や、`jsonb` が受け付けない文字を
 * 渡したときの今の振る舞いを縛る（Issue #1211。`MemoryEvent.meta` の doc の 2026-09-27 追記）。
 * 振る舞いは変えていない。
 *
 * 1. `EventStore.append` の `meta` の `Date`・`NaN`・`Infinity`・`-0`・`undefined`・BigInt は、
 *    `@mnemora/postgres` では JSON として保存した値で返り（BigInt は例外）、testkit の fixture ではそのまま返る。
 * 2. `Runtime` の口の `reason`・`actor.id` に NUL（U+0000）か孤立サロゲートが入ると、Postgres だけが
 *    監査ログの INSERT で失敗する。状態の書き換えも一緒に取り消され、途中まで書かれたものは残らない。
 *    fixture は書き換えて、文字列をそのまま監査ログに残す。
 */

const shared = {
  llmProvider: {
    complete: async () => ({ content: "unused" }),
    completeStructured: async () => {
      throw new Error("not used");
    },
  },
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
          eventStore,
          vectorStore: new InMemoryVectorStore(memoryStore),
          outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
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
          eventStore,
          vectorStore: new PostgresVectorStore(db),
          outboxStore: new PostgresOutboxStore(db),
          tenantSettingsStore: new PostgresTenantSettingsStore(db),
        }),
      };
    },
  ],
];

const ctx: Ctx = { tenantId: "event-meta-roundtrip" };
let seq = 0;

async function createActive(kit: Kit) {
  seq += 1;
  return kit.memoryStore.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: `event-meta-${seq}`,
      content: `本文 ${seq}`,
    }),
  );
}

const D = new Date("2026-01-01T00:00:00.000Z");
const BAD_STRINGS: Array<[string, string]> = [
  ["NUL（U+0000）", "a\u0000b"],
  ["孤立サロゲート", "a\uD800b"],
];

afterAll(async () => {
  await closeTestClient();
});

describe("EventStore.append: meta と actor の JSON で往復しない値（今の振る舞い）", () => {
  for (const [name, makeKit] of KITS) {
    it(`${name}`, async () => {
      const kit = await makeKit();
      const memory = await createActive(kit);
      const appended = await kit.eventStore.append(ctx, {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "updated",
        actor: { type: "system", id: undefined },
        meta: { d: D, nan: NaN, inf: Infinity, z: -0, u: undefined, nested: { d: D } },
      });
      const back = (await kit.eventStore.get(ctx, appended.id))!;
      const bigint = kit.eventStore.append(ctx, {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "updated",
        actor: { type: "system" },
        meta: { b: 10n },
      });
      if (name === "Postgres") {
        for (const event of [appended, back]) {
          expect(event.meta).toStrictEqual({
            d: D.toISOString(),
            nan: null,
            inf: null,
            z: 0,
            nested: { d: D.toISOString() },
          });
          expect(Object.is(event.meta.z, 0)).toBe(true);
          expect(event.actor).toStrictEqual({ type: "system" });
        }
        await expect(bigint).rejects.toThrow(/BigInt/);
      } else {
        for (const event of [appended, back]) {
          expect(event.meta.d).toBeInstanceOf(Date);
          expect(event.meta.d).toEqual(D);
          expect(event.meta.nan).toBeNaN();
          expect(event.meta.inf).toBe(Infinity);
          expect(Object.is(event.meta.z, -0)).toBe(true);
          expect("u" in event.meta).toBe(true);
          expect("id" in event.actor).toBe(true);
        }
        await expect(bigint).resolves.toMatchObject({ meta: { b: 10n } });
      }
    });
  }
});

describe("Runtime の reason・actor.id に NUL・孤立サロゲートを渡したとき（今の振る舞い）", () => {
  for (const [name, makeKit] of KITS) {
    for (const [label, bad] of BAD_STRINGS) {
      it(`${name}: forget の reason・actor.id に ${label}`, async () => {
        const kit = await makeKit();
        for (const opts of [{ reason: bad }, { actor: { type: "human" as const, id: bad } }]) {
          const memory = await createActive(kit);
          const { outcomes } = await kit.runtime.forget(ctx, { memoryId: memory.id }, opts);
          const after = await kit.memoryStore.get(ctx, memory.id);
          const events = await kit.eventStore.list(ctx, { memoryId: memory.id });
          if (name === "Postgres") {
            expect(outcomes.map((o) => o.kind)).toEqual(["failed"]);
            expect(after?.status).toBe("active");
            expect(events).toEqual([]);
          } else {
            expect(outcomes.map((o) => o.kind)).toEqual(["forgotten"]);
            expect(after?.status).toBe("forgotten");
            expect(events).toHaveLength(1);
            if ("reason" in opts) expect(events[0]!.meta.reason).toBe(bad);
            else expect(events[0]!.actor.id).toBe(bad);
          }
        }
      });

      it(`${name}: markContested の reason に ${label}`, async () => {
        const kit = await makeKit();
        const first = await createActive(kit);
        const second = await createActive(kit);
        const call = kit.runtime.markContested(ctx, first.id, second.id, { reason: bad });
        if (name === "Postgres") {
          await expect(call).rejects.toThrow(/memory_events/);
        } else {
          await expect(call).resolves.toMatchObject({ outcome: { kind: "contested" } });
        }
        const expected = name === "Postgres" ? "active" : "contested";
        expect((await kit.memoryStore.get(ctx, first.id))?.status).toBe(expected);
        expect((await kit.memoryStore.get(ctx, second.id))?.status).toBe(expected);
        expect(await kit.eventStore.list(ctx, { memoryId: first.id })).toHaveLength(
          name === "Postgres" ? 0 : 1,
        );
      });
    }
  }
});
