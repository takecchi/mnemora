import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, EventStore, MemoryStore, NewMemoryEvent, Runtime } from "@mnemora/core";
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
  ["孤立サロゲート（上位、\\uD800 単体）", "a\uD800b"],
  ["孤立サロゲート（下位、\\uDC00 単体）", "a\uDC00b"],
];

// Postgres が受け入れる（拒まない）文字列。拒む判定の過剰実装（サロゲートペアまで拒む・空文字を拒む等）で無いことを確かめる陽性対照。
const GOOD_STRINGS: Array<[string, string]> = [
  ["空文字", ""],
  ["対になったサロゲートペア（絵文字 😀）", "a😀b"],
  ["結合文字（é = e + U+0301）", "é"],
  ["U+FFFD（置換文字）", "a�b"],
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
      }
    });
  }
});

/**
 * ⚠ BigInt の検査は他のどの検査よりも先に働く。`@mnemora/postgres` の `EventStore.append` は `INSERT` の引数（`actor`・`meta` を含む）を
 * 全部 JS 側で評価してから初めて DB へ問い合わせを送るので、`actor`/`meta` に BigInt があると `JSON.stringify` が例外を投げ、問い合わせ自体が一切送られない。
 * 下の「他の不正な入力と同時に BigInt」の各ケースがそれを縛る。
 */
describe("meta・actor の BigInt（今の振る舞い、Issue #1384）", () => {
  for (const [name, makeKit] of KITS) {
    it(`${name}: 最上位・入れ子・配列の要素、actor の中`, async () => {
      const kit = await makeKit();
      const memory = await createActive(kit);
      const cases: Array<[string, Partial<NewMemoryEvent>]> = [
        ["meta 最上位", { meta: { b: 10n } }],
        ["meta 入れ子", { meta: { nested: { b: 10n } } }],
        ["meta 配列の要素", { meta: { xs: [1, 10n] } }],
        ["actor の中", { actor: { type: "system", extra: 10n } as never }],
      ];
      for (const [label, override] of cases) {
        const memoryBefore = (await kit.memoryStore.get(ctx, memory.id))!;
        const eventsBefore = await kit.eventStore.list(ctx, { memoryId: memory.id });
        const appending = kit.eventStore.append(ctx, {
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          kind: "updated",
          actor: { type: "system" },
          meta: {},
          ...override,
        });
        await expect(appending, label).rejects.toThrow(TypeError);
        await expect(appending, label).rejects.toThrow(/Do not know how to serialize a BigInt/);
        expect(await kit.memoryStore.get(ctx, memory.id), label).toStrictEqual(memoryBefore);
        expect(await kit.eventStore.list(ctx, { memoryId: memory.id }), label).toEqual(
          eventsBefore,
        );
      }
    });

    it(`${name}: 他の不正な入力と同時に BigInt（assertStorableMemoryEvent の中の検査は BigInt が先に出る）`, async () => {
      const kit = await makeKit();
      const memory = await createActive(kit);
      const cases: Array<[string, Partial<NewMemoryEvent>]> = [
        ["NUL を含む meta の文字列 + BigInt", { meta: { bad: "a\u0000b", big: 10n } }],
        ["列挙に無い kind + BigInt", { kind: "not-a-real-kind" as never, meta: { big: 10n } }],
        ["Invalid Date の at + BigInt", { at: new Date(NaN), meta: { big: 10n } }],
      ];
      for (const [label, override] of cases) {
        const appending = kit.eventStore.append(ctx, {
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          kind: "updated",
          actor: { type: "system" },
          meta: {},
          ...override,
        });
        await expect(appending, label).rejects.toThrow(TypeError);
        await expect(appending, label).rejects.toThrow(/Do not know how to serialize a BigInt/);
      }
    });

    /**
     * ⚠ 揃っていない1点: `memoryId` が実在しない状態で BigInt も同時に渡すと、`@mnemora/postgres` は引数評価で BigInt が先に例外になり `TypeError` になるが、
     * `InMemoryEventStore.append` は実在確認を `assertStorableMemoryEvent` より前に行うので、「memory not found」の `Error` が先に出る。
     */
    it(`${name}: 実在しない memoryId + BigInt（揃っていない——adapter で例外が違う）`, async () => {
      const kit = await makeKit();
      const memory = await createActive(kit);
      const appending = kit.eventStore.append(ctx, {
        tenantId: ctx.tenantId,
        memoryId: "00000000-0000-0000-0000-000000000000",
        kind: "updated",
        actor: { type: "system" },
        meta: { big: 10n },
      });
      if (name === "Postgres") {
        await expect(appending).rejects.toThrow(TypeError);
        await expect(appending).rejects.toThrow(/Do not know how to serialize a BigInt/);
      } else {
        await expect(appending).rejects.toThrow(/memory not found/);
      }
      expect(await kit.eventStore.list(ctx, { memoryId: memory.id })).toEqual([]);
    });

    it(`${name}: number・数字に見える文字列は引き続き通る（陽性対照）`, async () => {
      const kit = await makeKit();
      const memory = await createActive(kit);
      const appended = await kit.eventStore.append(ctx, {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "updated",
        actor: { type: "system" },
        meta: { n: 123, s: "123n" },
      });
      expect(appended.meta.n).toBe(123);
      expect(appended.meta.s).toBe("123n");
    });

    it(`${name}: updateStatusWithEvent（状態の書き換えとイベントを1回で書く口）`, async () => {
      const kit = await makeKit();
      const memory = await createActive(kit);
      const updating = kit.memoryStore.updateStatusWithEvent(
        ctx,
        memory.id,
        "forgotten",
        { expectedStatus: "active" },
        {
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          kind: "forgotten",
          actor: { type: "system" },
          meta: { big: 10n },
        },
      );
      await expect(updating).rejects.toThrow(TypeError);
      await expect(updating).rejects.toThrow(/Do not know how to serialize a BigInt/);
      expect((await kit.memoryStore.get(ctx, memory.id))!.status).toBe("active");
      expect(await kit.eventStore.list(ctx, { memoryId: memory.id })).toEqual([]);
    });
  }
});

describe("meta・actor の欄に関数・Symbol（今の振る舞い、Issue #1211 の追補）", () => {
  const fn = () => 1;
  for (const [name, makeKit] of KITS) {
    it(`${name}: EventStore.append`, async () => {
      const kit = await makeKit();
      const memory = await createActive(kit);
      const appending = kit.eventStore.append(ctx, {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "updated",
        actor: { type: "system", f: fn } as never,
        meta: { f: fn, s: Symbol("x"), arr: [fn], keep: 1 },
      });
      const eventsOf = async () => (await kit.eventStore.list(ctx, { memoryId: memory.id })).length;
      if (name === "Postgres") {
        const appended = await appending;
        const back = (await kit.eventStore.get(ctx, appended.id))!;
        for (const event of [appended, back]) {
          expect(event.meta).toStrictEqual({ arr: [null], keep: 1 });
          expect(event.actor).toStrictEqual({ type: "system" });
        }
        expect(await eventsOf()).toBe(1);
      } else {
        await expect(appending).rejects.toThrow(/could not be cloned/);
        expect(await eventsOf()).toBe(0);
      }
    });

    it(`${name}: updateStatusWithEvent（状態の書き換えとイベントを1回で書く口）`, async () => {
      const kit = await makeKit();
      const memory = await createActive(kit);
      const updating = kit.memoryStore.updateStatusWithEvent(
        ctx,
        memory.id,
        "forgotten",
        { expectedStatus: "active" },
        {
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          kind: "forgotten",
          actor: { type: "system" },
          meta: { f: fn, keep: 1 },
        },
      );
      if (name === "Postgres") {
        const { memory: updated, event } = await updating;
        expect(updated.status).toBe("forgotten");
        expect(event.meta).toStrictEqual({ keep: 1 });
      } else {
        await expect(updating).rejects.toThrow(/could not be cloned/);
        expect((await kit.memoryStore.get(ctx, memory.id))!.status).toBe("active");
      }
    });
  }
});

describe("Runtime の reason・actor.id に NUL・孤立サロゲートを渡したとき（2026-09-29 から、両実装とも拒む）", () => {
  for (const [name, makeKit] of KITS) {
    for (const [label, bad] of BAD_STRINGS) {
      it(`${name}: forget の reason・actor.id に ${label}`, async () => {
        const kit = await makeKit();
        for (const opts of [{ reason: bad }, { actor: { type: "human" as const, id: bad } }]) {
          const memory = await createActive(kit);
          const { outcomes } = await kit.runtime.forget(ctx, { memoryId: memory.id }, opts);
          const after = await kit.memoryStore.get(ctx, memory.id);
          const events = await kit.eventStore.list(ctx, { memoryId: memory.id });
          expect(outcomes.map((o) => o.kind)).toEqual(["failed"]);
          expect(after?.status).toBe("active");
          expect(events).toEqual([]);
        }
      });

      it(`${name}: markContested の reason に ${label}`, async () => {
        const kit = await makeKit();
        const first = await createActive(kit);
        const second = await createActive(kit);
        const call = kit.runtime.markContested(ctx, first.id, second.id, { reason: bad });
        await expect(call).rejects.toThrow();
        expect((await kit.memoryStore.get(ctx, first.id))?.status).toBe("active");
        expect((await kit.memoryStore.get(ctx, second.id))?.status).toBe("active");
        expect(await kit.eventStore.list(ctx, { memoryId: first.id })).toEqual([]);
        expect(await kit.eventStore.list(ctx, { memoryId: second.id })).toEqual([]);
      });
    }

    for (const [label, good] of GOOD_STRINGS) {
      it(`${name}: forget の reason・actor.id に ${label}（引き続き受け入れる、陽性対照）`, async () => {
        const kit = await makeKit();
        for (const opts of [{ reason: good }, { actor: { type: "human" as const, id: good } }]) {
          const memory = await createActive(kit);
          const { outcomes } = await kit.runtime.forget(ctx, { memoryId: memory.id }, opts);
          expect(outcomes.map((o) => o.kind)).toEqual(["forgotten"]);
          expect((await kit.memoryStore.get(ctx, memory.id))?.status).toBe("forgotten");
          expect(await kit.eventStore.list(ctx, { memoryId: memory.id })).toHaveLength(1);
        }
      });

      it(`${name}: markContested の reason に ${label}（引き続き受け入れる、陽性対照）`, async () => {
        const kit = await makeKit();
        const first = await createActive(kit);
        const second = await createActive(kit);
        await expect(
          kit.runtime.markContested(ctx, first.id, second.id, { reason: good }),
        ).resolves.toMatchObject({ outcome: { kind: "contested" } });
        expect((await kit.memoryStore.get(ctx, first.id))?.status).toBe("contested");
        expect((await kit.memoryStore.get(ctx, second.id))?.status).toBe("contested");
        expect(await kit.eventStore.list(ctx, { memoryId: first.id })).toHaveLength(1);
        expect(await kit.eventStore.list(ctx, { memoryId: second.id })).toHaveLength(1);
      });
    }
  }
});
