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
 * 渡したときの振る舞いを縛る（Issue #1211。`MemoryEvent.meta` の doc の 2026-09-27 追記・2026-09-29 追記）。
 *
 * 1. `EventStore.append` の `meta` の `Date`・`NaN`・`Infinity`・`-0`・`undefined`・BigInt は、
 *    `@mnemora/postgres` では JSON として保存した値で返り（BigInt は例外）、testkit の fixture ではそのまま返る
 *    （振る舞いは変えていない——2026-09-29 の変更の対象外。#1211 の「採らない案」のうち、この差は残した）。
 * 2. `Runtime` の口の `reason`・`actor.id` に NUL（U+0000）か孤立サロゲート（上位・下位のどちらか単体）が入ると、
 *    **2026-09-29 から、Postgres と testkit の fixture の両方が拒む**（オーナーの回答 ask_human `3f3411c5` を受けて、
 *    以前は fixture だけが書き換えを通していたのを揃えた）。`forget` は `{ kind: "failed" }` を返し、Memory は
 *    `active` のまま、イベントは0件。`markContested` は例外を投げ、両方の Memory が `active` のまま、イベントは
 *    どちらも0件。サロゲートペア（絵文字）・結合文字・U+FFFD・空文字など、Postgres が受け入れる文字列は
 *    引き続きどちらの実装でも通る（過剰実装で無いことの確認）。
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
  ["孤立サロゲート（上位、\\uD800 単体）", "a\uD800b"],
  ["孤立サロゲート（下位、\\uDC00 単体）", "a\uDC00b"],
];

// Postgres が受け入れる（拒まない）文字列——fixture が新しく拒むようになった判定の
// 過剰実装（サロゲートペアまで拒む・空文字を拒む等）で無いことを確かめる陽性対照。
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
        // JSON.stringify が関数・Symbol の欄を落とし、配列の要素なら null にする。残りを書いて通す。
        const appended = await appending;
        const back = (await kit.eventStore.get(ctx, appended.id))!;
        for (const event of [appended, back]) {
          expect(event.meta).toStrictEqual({ arr: [null], keep: 1 });
          expect(event.actor).toStrictEqual({ type: "system" });
        }
        expect(await eventsOf()).toBe(1);
      } else {
        // structuredClone が写せずに投げる。イベントは積まれない。
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
        // 書く前に投げる（PR #1231）——状態は呼ぶ前のまま。
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
          // 2026-09-29: Postgres も fixture も同じ形——Memory は active のまま、イベントは0件。
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
        // 2026-09-29: Postgres も fixture も同じ形——例外を投げ、両方の Memory が active のまま、
        // どちらの側にもイベントは残らない。
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
