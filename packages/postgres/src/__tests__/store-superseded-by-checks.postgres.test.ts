import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, Memory, MemoryId, MemoryStore, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0503（ADR 0447 の材料3〜5・ADR 0450 の材料1・2）: `supersededById`（置き換えた側）の約束を壊す入力。
 *
 * - `resolveContestedPair`・`resolveContestedGroup` で `status: "superseded"` に `supersededById` を付けない
 *   → 戻せない敗者（`restoreSuperseded` の群に入らない）ができていた。
 * - `supersededById` に自分自身（自己置換）、2者版で互いを指す・群版で輪になる（循環）、群版で群の外の
 *   `forgotten` な記憶を指す、`active` のメンバーに `supersededById` を付ける。
 * - `updateStatus(T, "superseded", { supersededById: T })`・`updateStatus(T, "superseded")`
 *   （`updateStatusWithEvent` も同じ）。
 *
 * 2実装に同じ入力を流し、どちらも `RangeError` で何も書かないことを確かめる。陽性対照（正当な `supersededById`）は通る
 * ——断りすぎる実装で赤になる。
 */

const A: Ctx = { tenantId: "superseded-by-a" };

afterAll(async () => {
  await closeTestClient();
});

interface Kit {
  store: MemoryStore;
  eventCount(): Promise<number>;
}

async function postgresKit(): Promise<Kit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  return {
    store: new PostgresMemoryStore(db),
    eventCount: async () =>
      Number(
        (await db.execute(sql`SELECT count(*)::int AS c FROM memory_events`)).rows[0]!.c as number,
      ),
  };
}

async function inMemoryKit(): Promise<Kit> {
  const store = new InMemoryMemoryStore();
  return { store, eventCount: async () => store.events.length };
}

/** ADR 0557: core の Fake（`FakeMemoryStore`）。イベント数は Fake の裏の events を読む（`fake-cas-purged-row.test.ts` と同じ）。 */
async function fakeKit(): Promise<Kit> {
  const store = createFakeRuntimeStores().memoryStore;
  const backing = (store as unknown as { backing: { events: unknown[] } }).backing;
  return { store, eventCount: async () => backing.events.length };
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  ["testkit の InMemory", inMemoryKit],
  ["core の Fake", fakeKit],
  ["Postgres", postgresKit],
];

let seq = 0;
const mem = (kit: Kit): Promise<Memory> => {
  seq += 1;
  return kit.store.createMemory(
    A,
    buildNewMemoryFixture({
      tenantId: A.tenantId,
      content: `body-${seq}`,
      digest: `digest-${seq}`,
      contentHash: `hash-${seq}`,
    }),
  );
};
const ev = (memoryId: string, kind: NewMemoryEvent["kind"] = "updated"): NewMemoryEvent => ({
  tenantId: A.tenantId,
  memoryId: memoryId as MemoryId,
  kind,
  actor: { type: "system" },
  meta: { probe: true },
});

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  let thrown: unknown;
  await run().catch((e: unknown) => {
    thrown = e;
  });
  return thrown;
}

/** 行の (status, supersededById) を写し取る。断った呼び出しの前後で変わらないことを見る。 */
async function snap(kit: Kit, ids: string[]): Promise<Array<[string, string | null | undefined]>> {
  return Promise.all(
    ids.map(async (id) => {
      const m = (await kit.store.get(A, id as MemoryId))!;
      return [m.status, m.supersededById ?? null] as [string, string | null | undefined];
    }),
  );
}

async function expectRefused(
  kit: Kit,
  ids: string[],
  message: RegExp,
  run: () => Promise<unknown>,
): Promise<void> {
  const before = await snap(kit, ids);
  const events = await kit.eventCount();
  const error = await caught(run);
  expect(error).toBeInstanceOf(RangeError);
  expect((error as Error).message).toMatch(message);
  expect(await snap(kit, ids)).toEqual(before);
  expect(await kit.eventCount()).toBe(events);
}

for (const [kitName, makeKit] of KITS) {
  describe(`${kitName}: resolveContestedPair の supersededById（ADR 0503）`, () => {
    const pair = async (kit: Kit) => {
      const [a, b] = [await mem(kit), await mem(kit)];
      await kit.store.markContestedPair!(
        A,
        { id: a.id, event: ev(a.id) },
        { id: b.id, event: ev(b.id) },
      );
      return [a, b] as const;
    };
    type Side = { status: "active" | "superseded"; by?: string };
    const resolve = (kit: Kit, a: Memory, b: Memory, sa: Side, sb: Side) =>
      kit.store.resolveContestedPair!(
        A,
        {
          id: a.id,
          status: sa.status,
          ...(sa.by === undefined ? {} : { supersededById: sa.by }),
          event: ev(a.id),
        },
        {
          id: b.id,
          status: sb.status,
          ...(sb.by === undefined ? {} : { supersededById: sb.by }),
          event: ev(b.id),
        },
      );

    it("status: superseded に supersededById が無い（first・second どちらも）は RangeError で、何も書かない", async () => {
      const kit = await makeKit();
      const [a, b] = await pair(kit);
      await expectRefused(kit, [a.id, b.id], /^resolveContestedPair: first\.supersededById/, () =>
        resolve(kit, a, b, { status: "superseded" }, { status: "active" }),
      );
      await expectRefused(kit, [a.id, b.id], /^resolveContestedPair: second\.supersededById/, () =>
        resolve(kit, a, b, { status: "active" }, { status: "superseded" }),
      );
      await expectRefused(kit, [a.id, b.id], /^resolveContestedPair: /, () =>
        resolve(kit, a, b, { status: "superseded" }, { status: "superseded" }),
      );
    });

    it("自己置換（自分自身を supersededById に）は RangeError で、何も書かない", async () => {
      const kit = await makeKit();
      const [a, b] = await pair(kit);
      await expectRefused(kit, [a.id, b.id], /supersededById must not be the memory itself/, () =>
        resolve(kit, a, b, { status: "active" }, { status: "superseded", by: b.id }),
      );
      await expectRefused(kit, [a.id, b.id], /supersededById must not be the memory itself/, () =>
        resolve(kit, a, b, { status: "superseded", by: a.id }, { status: "active" }),
      );
    });

    it("互いを指す循環は RangeError で、何も書かない", async () => {
      const kit = await makeKit();
      const [a, b] = await pair(kit);
      await expectRefused(kit, [a.id, b.id], /must not form a cycle/, () =>
        resolve(kit, a, b, { status: "superseded", by: b.id }, { status: "superseded", by: a.id }),
      );
    });

    it("status: active に supersededById を付けるのは RangeError で、何も書かない", async () => {
      const kit = await makeKit();
      const [a, b] = await pair(kit);
      await expectRefused(kit, [a.id, b.id], /supersededById must not be set unless/, () =>
        resolve(kit, a, b, { status: "active", by: b.id }, { status: "active" }),
      );
    });

    it("対の外の forgotten な記憶を supersededById に指すのは RangeError で、何も書かない（ADR 0515）", async () => {
      const kit = await makeKit();
      const [a, b] = await pair(kit);
      const gone = await mem(kit);
      await kit.store.updateStatus(A, gone.id, "forgotten");
      await expectRefused(
        kit,
        [a.id, b.id, gone.id],
        /^resolveContestedPair: first\.supersededById must not be a forgotten memory outside the pair$/,
        () => resolve(kit, a, b, { status: "superseded", by: gone.id }, { status: "active" }),
      );
      await expectRefused(
        kit,
        [a.id, b.id, gone.id],
        /^resolveContestedPair: second\.supersededById must not be a forgotten memory outside the pair$/,
        () => resolve(kit, a, b, { status: "active" }, { status: "superseded", by: gone.id }),
      );
    });

    it("陽性対照: 対の外の archived な記憶を指す superseded は通る（forgotten だけを断る。ADR 0515）", async () => {
      const kit = await makeKit();
      const [a, b] = await pair(kit);
      const archived = await mem(kit);
      await kit.store.updateStatus(A, archived.id, "archived");
      const r = await resolve(
        kit,
        a,
        b,
        { status: "active" },
        { status: "superseded", by: archived.id },
      );
      expect(r.second.supersededById).toBe(archived.id);
    });

    it("陽性対照: 勝者を指す superseded・both_active・群の外の active を指す superseded は通る", async () => {
      const kit = await makeKit();
      let [a, b] = await pair(kit);
      let r = await resolve(kit, a, b, { status: "active" }, { status: "superseded", by: a.id });
      expect([r.first.status, r.second.status, r.second.supersededById]).toEqual([
        "active",
        "superseded",
        a.id,
      ]);
      [a, b] = await pair(kit);
      r = await resolve(kit, a, b, { status: "superseded", by: b.id }, { status: "active" });
      expect([r.first.status, r.first.supersededById]).toEqual(["superseded", b.id]);
      [a, b] = await pair(kit);
      r = await resolve(kit, a, b, { status: "active" }, { status: "active" });
      expect([r.first.status, r.second.status]).toEqual(["active", "active"]);
      [a, b] = await pair(kit);
      const outside = await mem(kit);
      r = await resolve(kit, a, b, { status: "active" }, { status: "superseded", by: outside.id });
      expect(r.second.supersededById).toBe(outside.id);
    });
  });

  describe(`${kitName}: resolveContestedGroup の supersededById（ADR 0503）`, () => {
    const group = async (kit: Kit) => {
      const ms = [await mem(kit), await mem(kit), await mem(kit)];
      await kit.store.markContestedGroup!(
        A,
        ms.map((m) => ({ id: m.id, event: ev(m.id) })),
      );
      return ms;
    };
    type M = { status: "active" | "superseded"; by?: string };
    const resolve = (kit: Kit, ms: Memory[], specs: M[]) =>
      kit.store.resolveContestedGroup!(
        A,
        ms.map((m, i) => ({
          id: m.id,
          status: specs[i]!.status,
          ...(specs[i]!.by === undefined ? {} : { supersededById: specs[i]!.by }),
          event: ev(m.id),
        })),
      );

    it("status: superseded に supersededById が無いメンバーは RangeError で、何も書かない", async () => {
      const kit = await makeKit();
      const ms = await group(kit);
      const ids = ms.map((m) => m.id);
      await expectRefused(kit, ids, /^resolveContestedGroup: members\[1\]\.supersededById/, () =>
        resolve(kit, ms, [
          { status: "active" },
          { status: "superseded" },
          { status: "superseded", by: ms[0]!.id },
        ]),
      );
    });

    it("自己置換は RangeError で、何も書かない", async () => {
      const kit = await makeKit();
      const ms = await group(kit);
      await expectRefused(
        kit,
        ms.map((m) => m.id),
        /supersededById must not be the memory itself/,
        () =>
          resolve(kit, ms, [
            { status: "active" },
            { status: "superseded", by: ms[0]!.id },
            { status: "superseded", by: ms[2]!.id },
          ]),
      );
    });

    it("メンバー同士で輪になる supersededById（2者・3者）は RangeError で、何も書かない", async () => {
      const kit = await makeKit();
      const ms = await group(kit);
      const ids = ms.map((m) => m.id);
      await expectRefused(kit, ids, /must not form a cycle/, () =>
        resolve(kit, ms, [
          { status: "active" },
          { status: "superseded", by: ms[2]!.id },
          { status: "superseded", by: ms[1]!.id },
        ]),
      );
      await expectRefused(kit, ids, /must not form a cycle/, () =>
        resolve(kit, ms, [
          { status: "superseded", by: ms[1]!.id },
          { status: "superseded", by: ms[2]!.id },
          { status: "superseded", by: ms[0]!.id },
        ]),
      );
    });

    it("群の外の forgotten な記憶を supersededById に指すのは RangeError で、何も書かない", async () => {
      const kit = await makeKit();
      const ms = await group(kit);
      const gone = await mem(kit);
      await kit.store.updateStatus(A, gone.id, "forgotten");
      await expectRefused(
        kit,
        [...ms.map((m) => m.id), gone.id],
        /forgotten memory outside the group/,
        () =>
          resolve(kit, ms, [
            { status: "active" },
            { status: "superseded", by: gone.id },
            { status: "superseded", by: ms[0]!.id },
          ]),
      );
    });

    it("status: active のメンバーに supersededById を付けるのは RangeError で、何も書かない", async () => {
      const kit = await makeKit();
      const ms = await group(kit);
      await expectRefused(
        kit,
        ms.map((m) => m.id),
        /supersededById must not be set unless/,
        () =>
          resolve(kit, ms, [
            { status: "active", by: ms[1]!.id },
            { status: "active" },
            { status: "active" },
          ]),
      );
    });

    it("陽性対照: 勝者を指す superseded・群の外の active を指す superseded・both_active は通る", async () => {
      const kit = await makeKit();
      let ms = await group(kit);
      let r = await resolve(kit, ms, [
        { status: "active" },
        { status: "superseded", by: ms[0]!.id },
        { status: "superseded", by: ms[0]!.id },
      ]);
      expect(r.members.map((m) => [m.status, m.supersededById ?? null])).toEqual([
        ["active", null],
        ["superseded", ms[0]!.id],
        ["superseded", ms[0]!.id],
      ]);
      ms = await group(kit);
      const outside = await mem(kit);
      r = await resolve(kit, ms, [
        { status: "active" },
        { status: "superseded", by: outside.id },
        { status: "superseded", by: ms[0]!.id },
      ]);
      expect(r.members[1]!.supersededById).toBe(outside.id);
      ms = await group(kit);
      r = await resolve(kit, ms, [
        { status: "active" },
        { status: "active" },
        { status: "active" },
      ]);
      expect(r.members.map((m) => m.status)).toEqual(["active", "active", "active"]);
    });

    it("陽性対照: 輪にならない鎖（members[2] → members[1] → members[0]）は通る（断るのは輪だけ）", async () => {
      const kit = await makeKit();
      const ms = await group(kit);
      const r = await resolve(kit, ms, [
        { status: "active" },
        { status: "superseded", by: ms[0]!.id },
        { status: "superseded", by: ms[1]!.id },
      ]);
      expect(r.members.map((m) => [m.status, m.supersededById ?? null])).toEqual([
        ["active", null],
        ["superseded", ms[0]!.id],
        ["superseded", ms[1]!.id],
      ]);
    });
  });

  describe(`${kitName}: updateStatus / updateStatusWithEvent の supersededById（ADR 0503）`, () => {
    const viaStatus = (kit: Kit, id: string, opts?: { supersededById?: string }) =>
      kit.store.updateStatus(A, id as MemoryId, "superseded", opts as never);
    const viaEvent = (kit: Kit, id: string, opts: { supersededById?: string }) =>
      kit.store.updateStatusWithEvent(
        A,
        id as MemoryId,
        "superseded",
        opts as never,
        ev(id, "superseded"),
      );
    type Call = (kit: Kit, id: string, opts?: { supersededById?: string }) => Promise<unknown>;
    const callers: Array<[string, Call]> = [
      ["updateStatus", viaStatus],
      ["updateStatusWithEvent", (kit, id, opts) => viaEvent(kit, id, opts ?? {})],
    ];

    for (const [name, call] of callers) {
      it(`${name}: superseded に supersededById が無い（省略・opts 無し・expectedStatus だけ）は RangeError で、何も書かない`, async () => {
        const kit = await makeKit();
        const t = await mem(kit);
        const re = new RegExp(`^${name}: opts\\.supersededById is required`);
        await expectRefused(kit, [t.id], re, () => call(kit, t.id, {}));
        await expectRefused(kit, [t.id], re, () =>
          call(kit, t.id, { expectedStatus: "active" } as never),
        );
        if (name === "updateStatus") {
          await expectRefused(kit, [t.id], re, () => call(kit, t.id));
        }
      });

      it(`${name}: 自己置換は RangeError で、何も書かない`, async () => {
        const kit = await makeKit();
        const t = await mem(kit);
        await expectRefused(kit, [t.id], /supersededById must not be the memory itself/, () =>
          call(kit, t.id, { supersededById: t.id }),
        );
      });

      it(`${name}: superseded 以外の status に supersededById を付けるのは RangeError で、何も書かない（ADR 0515）`, async () => {
        const kit = await makeKit();
        const t = await mem(kit);
        const w = await mem(kit);
        const run = (status: "active" | "archived" | "forgotten") =>
          name === "updateStatus"
            ? kit.store.updateStatus(A, t.id, status, { supersededById: w.id })
            : kit.store.updateStatusWithEvent(A, t.id, status, { supersededById: w.id }, ev(t.id));
        for (const status of ["active", "archived", "forgotten"] as const) {
          await expectRefused(
            kit,
            [t.id, w.id],
            new RegExp(
              `^${name}: opts\\.supersededById must not be set unless status is "superseded"$`,
            ),
            () => run(status),
          );
        }
      });

      it(`${name}: 陽性対照 — 別の記憶を指す superseded、superseded 以外の status（supersededById 無し）は通る`, async () => {
        const kit = await makeKit();
        const t = await mem(kit);
        const w = await mem(kit);
        await call(kit, t.id, { supersededById: w.id });
        expect(await snap(kit, [t.id])).toEqual([["superseded", w.id]]);
        const u = await mem(kit);
        if (name === "updateStatus") {
          await kit.store.updateStatus(A, u.id, "archived");
        } else {
          await kit.store.updateStatusWithEvent(A, u.id, "archived", {}, ev(u.id));
        }
        expect(await snap(kit, [u.id])).toEqual([["archived", null]]);
      });

      it(`${name}: 陽性対照 — forgotten な記憶を指す superseded は通る（forgotten を断るのは resolveContested* だけ）`, async () => {
        const kit = await makeKit();
        const t = await mem(kit);
        const gone = await mem(kit);
        await kit.store.updateStatus(A, gone.id, "forgotten");
        await call(kit, t.id, { supersededById: gone.id });
        expect(await snap(kit, [t.id])).toEqual([["superseded", gone.id]]);
      });
    }
  });
}

describe("Postgres: id の大文字小文字が違っても自己置換・循環・欠落を断る（ADR 0503）", () => {
  it("updateStatus: id が大文字、supersededById が同じ id の小文字でも自己置換", async () => {
    const kit = await postgresKit();
    const t = await mem(kit);
    await expectRefused(kit, [t.id], /supersededById must not be the memory itself/, () =>
      kit.store.updateStatus(A, t.id.toUpperCase() as MemoryId, "superseded", {
        supersededById: t.id,
      }),
    );
  });

  it("resolveContestedPair: 大文字の id で互いを指しても循環", async () => {
    const kit = await postgresKit();
    const [a, b] = [await mem(kit), await mem(kit)];
    await kit.store.markContestedPair!(
      A,
      { id: a.id, event: ev(a.id) },
      { id: b.id, event: ev(b.id) },
    );
    await expectRefused(kit, [a.id, b.id], /must not form a cycle/, () =>
      kit.store.resolveContestedPair!(
        A,
        {
          id: a.id,
          status: "superseded",
          supersededById: b.id.toUpperCase() as MemoryId,
          event: ev(a.id),
        },
        { id: b.id, status: "superseded", supersededById: a.id, event: ev(b.id) },
      ),
    );
  });
});
