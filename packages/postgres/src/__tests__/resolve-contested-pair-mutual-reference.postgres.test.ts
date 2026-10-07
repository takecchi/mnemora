import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  isMemoryStatusConflictError,
  type Ctx,
  type Memory,
  type MemoryId,
  type MemoryStore,
  type NewMemoryEvent,
} from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `resolveContestedPair` は、両側が contested であるだけでは足りず、互いを指し合っている（相互参照）ときだけ
 * 解決する。片側だけが相手を指している・別々の対に属する2件は、`MemoryStatusConflictError` で断り、何も書かない。
 *
 * 一方向の contested（対向を明示した作成）を使うと、「first が second を指す」と
 * 「second が first を指す」のどちらか片方だけが成り立つ組を作れる。2つの検査をそれぞれ単独で当てられる。
 */

const A: Ctx = { tenantId: "resolve-contested-mutual-ref" };

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
function create(kit: Kit, overrides: Parameters<typeof buildNewMemoryFixture>[0] = {}) {
  seq += 1;
  return kit.store.createMemory(
    A,
    buildNewMemoryFixture({
      tenantId: A.tenantId,
      content: `body-${seq}`,
      digest: `digest-${seq}`,
      contentHash: `hash-${seq}`,
      ...overrides,
    }),
  );
}

const ev = (memoryId: string): NewMemoryEvent => ({
  tenantId: A.tenantId,
  memoryId: memoryId as MemoryId,
  kind: "updated",
  actor: { type: "system" },
  meta: { probe: true },
});

async function markPair(kit: Kit): Promise<readonly [Memory, Memory]> {
  const a = await create(kit);
  const b = await create(kit);
  await kit.store.markContestedPair!(
    A,
    { id: a.id, event: ev(a.id) },
    { id: b.id, event: ev(b.id) },
  );
  return [a, b];
}

async function state(kit: Kit, ids: MemoryId[]) {
  return Promise.all(
    ids.map(async (id) => {
      const m = (await kit.store.get(A, id))!;
      return { status: m.status, contestedWithId: m.contestedWithId ?? null };
    }),
  );
}

const resolveBoth = (kit: Kit, first: Memory, second: Memory) =>
  kit.store.resolveContestedPair!(
    A,
    { id: first.id, status: "active", event: ev(first.id) },
    { id: second.id, status: "active", event: ev(second.id) },
  );

for (const [kitName, makeKit] of KITS) {
  describe(`${kitName}: resolveContestedPair は互いを指し合う2件だけを解決する`, () => {
    it.each([
      ["first だけが second を指している", "first-points-only"],
      ["second だけが first を指している", "second-points-only"],
      ["別々の対に属する2件", "different-pairs"],
      ["3件以上の群のメンバー2件（contestedWithId を持たない）", "group-members"],
    ] as const)("%s ときは MemoryStatusConflictError で、何も書かない", async (_name, shape) => {
      const kit = await makeKit();
      const [a] = await markPair(kit);
      const oneSided = await create(kit, { status: "contested", contestedWithId: a.id });
      const [c] = await markPair(kit);
      const groupMembers = await Promise.all([create(kit), create(kit), create(kit)]);
      if (shape === "group-members") {
        await kit.store.markContestedGroup!(
          A,
          groupMembers.map((m) => ({ id: m.id, event: ev(m.id) })),
        );
      }
      const [first, second] =
        shape === "first-points-only"
          ? [oneSided, a]
          : shape === "second-points-only"
            ? [a, oneSided]
            : shape === "group-members"
              ? [groupMembers[0]!, groupMembers[1]!]
              : [a, c];
      const ids = [first.id, second.id];
      const before = await state(kit, ids);
      const events = await kit.eventCount();

      const error = await resolveBoth(kit, first, second).catch((e: unknown) => e);

      expect(isMemoryStatusConflictError(error)).toBe(true);
      expect(await state(kit, ids)).toEqual(before);
      expect(await kit.eventCount()).toBe(events);
    });

    it("互いを指し合う対は解決でき、両側の contestedWithId が消える", async () => {
      const kit = await makeKit();
      const [a, b] = await markPair(kit);

      await resolveBoth(kit, a, b);

      expect(await state(kit, [a.id, b.id])).toEqual([
        { status: "active", contestedWithId: null },
        { status: "active", contestedWithId: null },
      ]);
    });
  });
}
