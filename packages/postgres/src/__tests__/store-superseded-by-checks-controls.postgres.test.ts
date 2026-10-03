import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, Memory, MemoryId, MemoryStore, NewMemoryEvent } from "@mnemora/core";
import {
  isContestedGroupMembershipMismatchError,
  isMemoryStatusConflictError,
} from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0574（ADR 0557 の歯の穴）: `store-superseded-by-checks.postgres.test.ts` に足りなかった期待を、3実装
 * （testkit の InMemory・core の Fake・Postgres）に同じ入力で流して縛る。core 側の歯は
 * `fake-superseded-by-checks-controls.test.ts`（Fake だけの変異試験の対象）。
 *
 * - 対・群の外の `superseded`・`contested` を指す `superseded` は通る（ADR 0557 の決定3）。
 * - 輪が先頭に絡まない循環（先頭が群の外を指す・尾が輪に入る）も RangeError。
 * - 形・循環の検査は、存在確認・CAS より前（存在しない id・contested でない行でも RangeError）。
 *
 * ADR 0584（ADR 0574 の歯の穴）: 次を足した。
 * - F14・P16: 外の `forgotten` を指す検査は CAS（と群の部分解消の検査）より後（MemoryStatusConflictError が先）。
 * - P12: 壊れた id（`isUuidLike` で弾かれる形）+ 形の違反は、not found ではなく RangeError（決定3）。
 * - F10・F12: pair・group の形の違反は、存在確認・CAS より前（形の違反だけが違う入力で、存在しない・contested でないの両方）。
 */

const A: Ctx = { tenantId: "superseded-by-controls-a" };
const ABSENT = "00000000-0000-4000-8000-0000000000aa" as MemoryId;
const ABSENT2 = "00000000-0000-4000-8000-0000000000ab" as MemoryId;
const ABSENT3 = "00000000-0000-4000-8000-0000000000ac" as MemoryId;
/** `isUuidLike` で弾かれる形（uuid ではない）。ADR 0574「決定」3番: 形・循環の検査は、この not found より先。 */
const BROKEN = "not-a-uuid" as MemoryId;
const BROKEN2 = "also-not-a-uuid" as MemoryId;
const BROKEN3 = "still-not-a-uuid" as MemoryId;

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

type Side = { status: "active" | "superseded"; by?: string };

for (const [kitName, makeKit] of KITS) {
  describe(`${kitName}: supersededById の陽性対照・循環の走査・検査の位置（ADR 0557・0574）`, () => {
    const pair = async (kit: Kit) => {
      const [a, b] = [await mem(kit), await mem(kit)];
      await kit.store.markContestedPair!(
        A,
        { id: a.id, event: ev(a.id) },
        { id: b.id, event: ev(b.id) },
      );
      return [a, b] as const;
    };
    const group = async (kit: Kit) => {
      const ms = [await mem(kit), await mem(kit), await mem(kit)];
      await kit.store.markContestedGroup!(
        A,
        ms.map((m) => ({ id: m.id, event: ev(m.id) })),
      );
      return ms;
    };
    const resolvePair = (kit: Kit, a: { id: string }, b: { id: string }, sa: Side, sb: Side) =>
      kit.store.resolveContestedPair!(
        A,
        {
          id: a.id as MemoryId,
          status: sa.status,
          ...(sa.by === undefined ? {} : { supersededById: sa.by as MemoryId }),
          event: ev(a.id),
        },
        {
          id: b.id as MemoryId,
          status: sb.status,
          ...(sb.by === undefined ? {} : { supersededById: sb.by as MemoryId }),
          event: ev(b.id),
        },
      );
    const resolveGroup = (kit: Kit, ms: Array<{ id: string }>, specs: Side[]) =>
      kit.store.resolveContestedGroup!(
        A,
        ms.map((m, i) => ({
          id: m.id as MemoryId,
          status: specs[i]!.status,
          ...(specs[i]!.by === undefined ? {} : { supersededById: specs[i]!.by as MemoryId }),
          event: ev(m.id),
        })),
      );
    const outside = async (kit: Kit, status: "superseded" | "contested"): Promise<Memory> => {
      if (status === "superseded") {
        const m = await mem(kit);
        const winner = await mem(kit);
        await kit.store.updateStatus(A, m.id, "superseded", { supersededById: winner.id });
        return (await kit.store.get(A, m.id))!;
      }
      const [c] = await pair(kit);
      return (await kit.store.get(A, c.id))!;
    };
    const expectCycle = async (kit: Kit, run: () => Promise<unknown>) => {
      const events = await kit.eventCount();
      let thrown: unknown;
      await run().catch((e: unknown) => {
        thrown = e;
      });
      expect(thrown).toBeInstanceOf(RangeError);
      expect((thrown as Error).message).toMatch(/must not form a cycle among the members$/);
      expect(await kit.eventCount()).toBe(events);
    };

    for (const kind of ["superseded", "contested"] as const) {
      it(`陽性対照: 対の外の ${kind} を指す superseded は通る`, async () => {
        const kit = await makeKit();
        const [a, b] = await pair(kit);
        const out = await outside(kit, kind);
        expect(out.status).toBe(kind);
        const r = await resolvePair(
          kit,
          a,
          b,
          { status: "active" },
          { status: "superseded", by: out.id },
        );
        expect(r.second.supersededById).toBe(out.id);
      });

      it(`陽性対照: 群の外の ${kind} を指す superseded は通る`, async () => {
        const kit = await makeKit();
        const ms = await group(kit);
        const out = await outside(kit, kind);
        expect(out.status).toBe(kind);
        const r = await resolveGroup(kit, ms, [
          { status: "active" },
          { status: "superseded", by: out.id },
          { status: "superseded", by: ms[0]!.id },
        ]);
        expect(r.members[1]!.supersededById).toBe(out.id);
      });
    }

    it("循環: 先頭が群の外を指し、後ろ2者が輪になるのは RangeError", async () => {
      const kit = await makeKit();
      const ms = await group(kit);
      const out = await mem(kit);
      await expectCycle(kit, () =>
        resolveGroup(kit, ms, [
          { status: "superseded", by: out.id },
          { status: "superseded", by: ms[2]!.id },
          { status: "superseded", by: ms[1]!.id },
        ]),
      );
    });

    it("循環: 尾が輪に入る形（m0 → m1 → m2 → m1）は RangeError", async () => {
      const kit = await makeKit();
      const ms = await group(kit);
      await expectCycle(kit, () =>
        resolveGroup(kit, ms, [
          { status: "superseded", by: ms[1]!.id },
          { status: "superseded", by: ms[2]!.id },
          { status: "superseded", by: ms[1]!.id },
        ]),
      );
    });

    it("位置: 存在しない id の superseded（supersededById 無し）は、not found ではなく RangeError", async () => {
      const kit = await makeKit();
      for (const run of [
        () => kit.store.updateStatus(A, ABSENT, "superseded"),
        () =>
          kit.store.updateStatusWithEvent(A, ABSENT, "superseded", {}, ev(ABSENT, "superseded")),
      ]) {
        let thrown: unknown;
        await run().catch((e: unknown) => {
          thrown = e;
        });
        expect(thrown).toBeInstanceOf(RangeError);
        expect((thrown as Error).message).toMatch(
          /opts\.supersededById is required when status is "superseded"$/,
        );
      }
    });

    it("位置: contested でない2件・3件の循環は、MemoryStatusConflictError ではなく RangeError", async () => {
      const kit = await makeKit();
      const [a, b] = [await mem(kit), await mem(kit)];
      await expectCycle(kit, () =>
        resolvePair(
          kit,
          a,
          b,
          { status: "superseded", by: b.id },
          { status: "superseded", by: a.id },
        ),
      );
      const ms = [await mem(kit), await mem(kit), await mem(kit)];
      await expectCycle(kit, () =>
        resolveGroup(kit, ms, [
          { status: "active" },
          { status: "superseded", by: ms[2]!.id },
          { status: "superseded", by: ms[1]!.id },
        ]),
      );
    });

    it("位置（ADR 0574 決定3・ADR 0596）: 存在しない2件・3件が互いを指して輪になる循環は、not found ではなく循環の RangeError", async () => {
      const kit = await makeKit();
      await expectCycle(kit, () =>
        resolvePair(
          kit,
          { id: ABSENT },
          { id: ABSENT2 },
          { status: "superseded", by: ABSENT2 },
          { status: "superseded", by: ABSENT },
        ),
      );
      await expectCycle(kit, () =>
        resolveGroup(
          kit,
          [{ id: ABSENT }, { id: ABSENT2 }, { id: ABSENT3 }],
          [
            { status: "active" },
            { status: "superseded", by: ABSENT3 },
            { status: "superseded", by: ABSENT2 },
          ],
        ),
      );
    });

    // --- ADR 0584（ADR 0574 の歯の穴）---------------------------------------------------------
    const thrownOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      let thrown: unknown;
      await run().catch((e: unknown) => {
        thrown = e;
      });
      return thrown;
    };
    const REQUIRED_TAIL = 'supersededById is required when status is "superseded"$';
    const forgotten = async (kit: Kit): Promise<Memory> => {
      const m = await mem(kit);
      await kit.store.updateStatus(A, m.id, "forgotten");
      return (await kit.store.get(A, m.id))!;
    };
    const expectRangeError = async (kit: Kit, message: RegExp, run: () => Promise<unknown>) => {
      const events = await kit.eventCount();
      const thrown = await thrownOf(run);
      expect(thrown).toBeInstanceOf(RangeError);
      expect((thrown as Error).message).toMatch(message);
      expect(await kit.eventCount()).toBe(events);
    };

    it("位置（F14・P16）: contested でない2件 + 対の外の forgotten を指す superseded は、RangeError ではなく MemoryStatusConflictError", async () => {
      const kit = await makeKit();
      const [a, b] = [await mem(kit), await mem(kit)];
      const out = await forgotten(kit);
      expect(out.status).toBe("forgotten");
      const events = await kit.eventCount();
      const thrown = await thrownOf(() =>
        resolvePair(kit, a, b, { status: "active" }, { status: "superseded", by: out.id }),
      );
      expect(isMemoryStatusConflictError(thrown)).toBe(true);
      expect(thrown).not.toBeInstanceOf(RangeError);
      expect(await kit.eventCount()).toBe(events);
    });

    it("位置（F14・P16 の group 版）: contested でない3件 + 群の外の forgotten を指す superseded は、RangeError ではなく MemoryStatusConflictError", async () => {
      const kit = await makeKit();
      const ms = [await mem(kit), await mem(kit), await mem(kit)];
      const out = await forgotten(kit);
      const events = await kit.eventCount();
      const thrown = await thrownOf(() =>
        resolveGroup(kit, ms, [
          { status: "active" },
          { status: "superseded", by: out.id },
          { status: "active" },
        ]),
      );
      expect(isMemoryStatusConflictError(thrown)).toBe(true);
      expect(thrown).not.toBeInstanceOf(RangeError);
      expect(await kit.eventCount()).toBe(events);
    });

    it("位置（group）: 群の一部だけを渡し + 群の外の forgotten を指す superseded は、RangeError ではなく ContestedGroupMembershipMismatchError", async () => {
      const kit = await makeKit();
      const four = [await mem(kit), await mem(kit), await mem(kit), await mem(kit)];
      await kit.store.markContestedGroup!(
        A,
        four.map((m) => ({ id: m.id, event: ev(m.id) })),
      );
      const out = await forgotten(kit);
      const thrown = await thrownOf(() =>
        resolveGroup(kit, four.slice(0, 3), [
          { status: "active" },
          { status: "superseded", by: out.id },
          { status: "active" },
        ]),
      );
      expect(isContestedGroupMembershipMismatchError(thrown)).toBe(true);
      expect(thrown).not.toBeInstanceOf(RangeError);
    });

    it("位置（P12）: 壊れた id（uuid の形ではない）+ supersededById 無しの superseded は、not found ではなく形の RangeError（isUuidLike は形の検査より後）", async () => {
      const kit = await makeKit();
      await expectRangeError(kit, new RegExp(`^updateStatus: opts\\.${REQUIRED_TAIL}`), () =>
        kit.store.updateStatus(A, BROKEN, "superseded"),
      );
      await expectRangeError(
        kit,
        new RegExp(`^updateStatusWithEvent: opts\\.${REQUIRED_TAIL}`),
        () =>
          kit.store.updateStatusWithEvent(A, BROKEN, "superseded", {}, ev(BROKEN, "superseded")),
      );
    });

    it("位置（P12）: 壊れた id の自己置換・active への付与も形の RangeError", async () => {
      const kit = await makeKit();
      await expectRangeError(kit, /must not be the memory itself$/, () =>
        kit.store.updateStatus(A, BROKEN, "superseded", { supersededById: BROKEN }),
      );
      await expectRangeError(kit, /must not be the memory itself$/, () =>
        kit.store.updateStatusWithEvent(
          A,
          BROKEN,
          "superseded",
          { supersededById: BROKEN },
          ev(BROKEN, "superseded"),
        ),
      );
      await expectRangeError(kit, /must not be set unless status is "superseded"$/, () =>
        kit.store.updateStatus(A, BROKEN, "active", { supersededById: ABSENT }),
      );
    });

    it("位置（P12 の陽性対照）: 壊れた id でも形が正しければ、RangeError ではなく memory not found の Error", async () => {
      const kit = await makeKit();
      const other = await mem(kit);
      for (const run of [
        () => kit.store.updateStatus(A, BROKEN, "archived"),
        () => kit.store.updateStatus(A, BROKEN, "superseded", { supersededById: other.id }),
        () => kit.store.updateStatusWithEvent(A, BROKEN, "archived", {}, ev(BROKEN, "updated")),
      ]) {
        const thrown = await thrownOf(run);
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).not.toBeInstanceOf(RangeError);
        expect((thrown as Error).message).toMatch(/memory not found for tenant/);
      }
    });

    it("位置（P12 の pair・group 版）: 壊れた id + 形の違反は、not found ではなく形の RangeError", async () => {
      const kit = await makeKit();
      await expectRangeError(kit, /^resolveContestedPair: second\.supersededById is required/, () =>
        resolvePair(
          kit,
          { id: BROKEN },
          { id: BROKEN2 },
          { status: "active" },
          { status: "superseded" },
        ),
      );
      await expectRangeError(
        kit,
        /^resolveContestedGroup: members\[1\]\.supersededById is required/,
        () =>
          resolveGroup(
            kit,
            [{ id: BROKEN }, { id: BROKEN2 }, { id: BROKEN3 }],
            [{ status: "active" }, { status: "superseded" }, { status: "active" }],
          ),
      );
    });

    it("位置（F10）: pair の形の違反は、存在確認・CAS より前（存在しない2件・contested でない2件のどちらでも RangeError）", async () => {
      const kit = await makeKit();
      await expectRangeError(kit, /^resolveContestedPair: second\.supersededById is required/, () =>
        resolvePair(
          kit,
          { id: ABSENT },
          { id: ABSENT2 },
          { status: "active" },
          { status: "superseded" },
        ),
      );
      const [a, b] = [await mem(kit), await mem(kit)];
      await expectRangeError(kit, /^resolveContestedPair: second\.supersededById is required/, () =>
        resolvePair(kit, a, b, { status: "active" }, { status: "superseded" }),
      );
      await expectRangeError(
        kit,
        /^resolveContestedPair: second\.supersededById must not be the memory itself$/,
        () => resolvePair(kit, a, b, { status: "active" }, { status: "superseded", by: b.id }),
      );
    });

    it("位置（F12）: group の形の違反は、存在確認・CAS より前（存在しない3件・contested でない3件のどちらでも RangeError）", async () => {
      const kit = await makeKit();
      await expectRangeError(
        kit,
        /^resolveContestedGroup: members\[1\]\.supersededById is required/,
        () =>
          resolveGroup(
            kit,
            [{ id: ABSENT }, { id: ABSENT2 }, { id: ABSENT3 }],
            [{ status: "active" }, { status: "superseded" }, { status: "active" }],
          ),
      );
      const ms = [await mem(kit), await mem(kit), await mem(kit)];
      await expectRangeError(
        kit,
        /^resolveContestedGroup: members\[1\]\.supersededById is required/,
        () =>
          resolveGroup(kit, ms, [
            { status: "active" },
            { status: "superseded" },
            { status: "active" },
          ]),
      );
      await expectRangeError(
        kit,
        /^resolveContestedGroup: members\[1\]\.supersededById must not be the memory itself$/,
        () =>
          resolveGroup(kit, ms, [
            { status: "active" },
            { status: "superseded", by: ms[1]!.id },
            { status: "active" },
          ]),
      );
    });
  });
}
