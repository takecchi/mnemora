import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, EventStore, Memory, MemoryId, MemoryStore, NewMemoryEvent } from "@mnemora/core";
import { MemoryStatusConflictError } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryEventStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0499（ADR 0450・ADR 0447 の材料）: status を書く口の、型の外の入力と purge 済みの行。
 *
 * - `resolveContestedGroup`・`resolveContestedPair` の `status` は型が `"active" | "superseded"`。型の外の値
 *   （`"forgotten"`・`"contested"`・`"archived"` など）は、以前は通って行をその status にしていた。
 *   2実装とも、書く前に `RangeError` で断る（何も書かない）。
 * - purge 済みの行（`status = 'forgotten'` のまま `purged_at` が入る）は、`expectedStatus` に一致しない行として扱う
 *   （`MemoryStatusConflictError`）。以前は `updateStatusWithEvent(T, "active", { expectedStatus: "forgotten" })` が
 *   墓石を active に戻していた（`Runtime.purge` の「不可逆」の約束の外）。
 *
 * 2実装に同じ入力を流し、結果を比べる。陽性対照（型の中の値・purge 前の forgotten の復元）は今までどおり通る。
 */

const A: Ctx = { tenantId: "status-write-a" };

afterAll(async () => {
  await closeTestClient();
});

interface Kit {
  store: MemoryStore;
  eventStore: EventStore;
  eventCount(): Promise<number>;
}

async function postgresKit(): Promise<Kit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  return {
    store: new PostgresMemoryStore(db),
    eventStore: new PostgresEventStore(db),
    eventCount: async () =>
      Number(
        (await db.execute(sql`SELECT count(*)::int AS c FROM memory_events`)).rows[0]!.c as number,
      ),
  };
}

async function inMemoryKit(): Promise<Kit> {
  const store = new InMemoryMemoryStore();
  return {
    store,
    eventStore: new InMemoryEventStore(store, store.events),
    eventCount: async () => store.events.length,
  };
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  ["testkit の InMemory", inMemoryKit],
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

const OUT_OF_TYPE = ["forgotten", "contested", "archived", "bogus", "", undefined, null];
const STATUS_RANGE = /status must be "active" or "superseded"/;

for (const [kitName, makeKit] of KITS) {
  describe(`${kitName}: resolveContestedGroup / resolveContestedPair の型の外の status（ADR 0499）`, () => {
    const contestedGroup = async (kit: Kit) => {
      const ms = [await mem(kit), await mem(kit), await mem(kit)];
      await kit.store.markContestedGroup!(
        A,
        ms.map((m) => ({ id: m.id, event: ev(m.id) })),
      );
      return ms;
    };
    const contestedPair = async (kit: Kit) => {
      const [a, b] = [await mem(kit), await mem(kit)];
      await kit.store.markContestedPair!(
        A,
        { id: a.id, event: ev(a.id) },
        { id: b.id, event: ev(b.id) },
      );
      return [a, b] as const;
    };

    it.each(OUT_OF_TYPE.map((s) => [String(s), s]))(
      "resolveContestedGroup: members[i].status = %s は RangeError で、何も書かない",
      async (_label, bad) => {
        const kit = await makeKit();
        const ms = await contestedGroup(kit);
        const before = await kit.eventCount();
        for (const position of [0, 2]) {
          const error = await caught(() =>
            kit.store.resolveContestedGroup!(
              A,
              ms.map((m, i) => ({
                id: m.id,
                status: (i === position ? bad : "active") as "active",
                event: ev(m.id),
              })),
            ),
          );
          expect(error).toBeInstanceOf(RangeError);
          expect((error as Error).message).toMatch(/^resolveContestedGroup: /);
          expect((error as Error).message).toMatch(STATUS_RANGE);
        }
        expect(await kit.eventCount()).toBe(before);
        for (const m of ms) {
          expect((await kit.store.get(A, m.id))!.status).toBe("contested");
        }
      },
    );

    it("resolveContestedGroup: 型の中の status（active・superseded）は今までどおり通る", async () => {
      const kit = await makeKit();
      const ms = await contestedGroup(kit);
      const result = await kit.store.resolveContestedGroup!(A, [
        { id: ms[0]!.id, status: "active", event: ev(ms[0]!.id) },
        { id: ms[1]!.id, status: "superseded", supersededById: ms[0]!.id, event: ev(ms[1]!.id) },
        { id: ms[2]!.id, status: "superseded", supersededById: ms[0]!.id, event: ev(ms[2]!.id) },
      ]);
      expect(result.members.map((m) => m.status)).toEqual(["active", "superseded", "superseded"]);
    });

    it.each(OUT_OF_TYPE.map((s) => [String(s), s]))(
      "resolveContestedPair: first / second の status = %s は RangeError で、何も書かない",
      async (_label, bad) => {
        const kit = await makeKit();
        const [a, b] = await contestedPair(kit);
        const before = await kit.eventCount();
        for (const side of ["first", "second"] as const) {
          const error = await caught(() =>
            kit.store.resolveContestedPair!(
              A,
              {
                id: a.id,
                status: (side === "first" ? bad : "active") as "active",
                event: ev(a.id),
              },
              {
                id: b.id,
                status: (side === "second" ? bad : "active") as "active",
                event: ev(b.id),
              },
            ),
          );
          expect(error).toBeInstanceOf(RangeError);
          expect((error as Error).message).toMatch(new RegExp(`^resolveContestedPair: ${side}\\.`));
          expect((error as Error).message).toMatch(STATUS_RANGE);
        }
        expect(await kit.eventCount()).toBe(before);
        expect((await kit.store.get(A, a.id))!.status).toBe("contested");
        expect((await kit.store.get(A, b.id))!.status).toBe("contested");
      },
    );

    it("resolveContestedPair: 型の中の status は今までどおり通る", async () => {
      const kit = await makeKit();
      const [a, b] = await contestedPair(kit);
      const result = await kit.store.resolveContestedPair!(
        A,
        { id: a.id, status: "active", event: ev(a.id) },
        { id: b.id, status: "superseded", supersededById: a.id, event: ev(b.id) },
      );
      expect([result.first.status, result.second.status]).toEqual(["active", "superseded"]);
    });
  });

  describe(`${kitName}: purge 済みの行は expectedStatus に一致しない（ADR 0499）`, () => {
    const purged = async (kit: Kit) => {
      const m = await mem(kit);
      await kit.store.updateStatus(A, m.id, "forgotten");
      const { memory } = await kit.store.purgeMemory!(
        A,
        m.id,
        { content: "[purged]", digest: "[purged]" },
        ev(m.id, "purged"),
      );
      return memory;
    };

    it("updateStatusWithEvent(T, active, { expectedStatus: forgotten }) は MemoryStatusConflictError で、墓石も events も動かない", async () => {
      const kit = await makeKit();
      const t = await purged(kit);
      const before = await kit.eventCount();
      const error = await caught(() =>
        kit.store.updateStatusWithEvent(
          A,
          t.id,
          "active",
          { expectedStatus: "forgotten" },
          ev(t.id),
        ),
      );
      expect(error).toBeInstanceOf(MemoryStatusConflictError);
      expect((error as MemoryStatusConflictError).expectedStatus).toBe("forgotten");
      const after = (await kit.store.get(A, t.id))!;
      expect(after.status).toBe("forgotten");
      expect(after.purgedAt).not.toBeNull();
      expect(after.content).toBe("[purged]");
      expect(await kit.eventCount()).toBe(before);
    });

    it("updateStatus(T, active, { expectedStatus: forgotten }) も同じ", async () => {
      const kit = await makeKit();
      const t = await purged(kit);
      const error = await caught(() =>
        kit.store.updateStatus(A, t.id, "active", { expectedStatus: "forgotten" }),
      );
      expect(error).toBeInstanceOf(MemoryStatusConflictError);
      expect((await kit.store.get(A, t.id))!.status).toBe("forgotten");
    });

    it("supersedeWithNewMemories の supersede（expectedStatus: forgotten）も、purge 済みの行は conflicted に積み、書かない", async () => {
      const kit = await makeKit();
      const t = await purged(kit);
      const before = await kit.eventCount();
      const result = await kit.store.supersedeWithNewMemories(
        A,
        [
          {
            input: buildNewMemoryFixture({
              tenantId: A.tenantId,
              content: "n",
              digest: "n",
              contentHash: "n-hash",
            }),
            jobKinds: [],
          },
        ],
        [
          {
            id: t.id,
            supersededByIndex: 0,
            expectedStatus: "forgotten",
            event: ev(t.id, "superseded"),
          },
        ],
      );
      expect(result.conflicted.map((c) => c.id)).toEqual([t.id]);
      expect(result.superseded).toEqual([]);
      expect((await kit.store.get(A, t.id))!.status).toBe("forgotten");
      expect(await kit.eventCount()).toBe(before);
    });

    // ---- やりすぎを捕まえる歯 ----

    it("purge 前の forgotten は、今までどおり active へ戻せる（updateStatusWithEvent・updateStatus）", async () => {
      const kit = await makeKit();
      const [x, y] = [await mem(kit), await mem(kit)];
      await kit.store.updateStatus(A, x.id, "forgotten");
      await kit.store.updateStatus(A, y.id, "forgotten");
      const viaEvent = await kit.store.updateStatusWithEvent(
        A,
        x.id,
        "active",
        { expectedStatus: "forgotten" },
        ev(x.id),
      );
      expect(viaEvent.memory.status).toBe("active");
      const plain = await kit.store.updateStatus(A, y.id, "active", {
        expectedStatus: "forgotten",
      });
      expect(plain.status).toBe("active");
    });

    it("purge 済みの行でも、expectedStatus を渡さない更新は、今までどおり通る（この ADR は CAS の約束だけを直す）", async () => {
      const kit = await makeKit();
      const t = await purged(kit);
      const after = await kit.store.updateStatus(A, t.id, "archived");
      expect(after.status).toBe("archived");
    });

    it("purge 済みでない別の行は、purge 済みの行があっても影響を受けない", async () => {
      const kit = await makeKit();
      await purged(kit);
      const other = await mem(kit);
      await kit.store.updateStatus(A, other.id, "forgotten");
      const restored = await kit.store.updateStatus(A, other.id, "active", {
        expectedStatus: "forgotten",
      });
      expect(restored.status).toBe("active");
    });
  });
}
