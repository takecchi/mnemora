import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx, MemoryId, MemoryStore, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0466: `NewMemoryEvent.memoryId` の検査（ADR 0456 の H4）を、`PostgresMemoryStore` と `InMemoryMemoryStore` に
 * **同じ入力**で流し、断る・通すが一致することを縛る。口 × 指し先の全組み合わせで、(1) 結果（通った／断られた。断られたときは
 * message をクラス名と id を伏せて比べる）、(2) 呼び出しのあとの status、(3) 別テナントの記憶に積まれたイベントの数、を2実装で比べる。
 *
 * 口: updateStatusWithEvent・purgeMemory・markContestedPair・resolveContestedPair・resolveOrphanedContested・
 * markContestedGroup・resolveContestedGroup・supersedeWithNewMemories（supersede の event・buildCreatedEvent）・
 * createMemoriesWithOutboxAndEvents。指し先: 別テナントの記憶・uuid でない/実在しない id・今更新した行・同じテナントの別の記憶・null。
 */

const A: Ctx = { tenantId: "event-parity-a" };
const B: Ctx = { tenantId: "event-parity-b" };

afterAll(async () => {
  await closeTestClient();
});

type Target =
  | "foreign"
  | "malformed"
  | "own"
  | "sameTenantOther"
  | "null"
  | "ownUpper"
  | "otherUpper"
  | "foreignUpper";
const TARGETS: Target[] = [
  "foreign",
  "malformed",
  "own",
  "sameTenantOther",
  "null",
  "ownUpper",
  "otherUpper",
  "foreignUpper",
];

interface Kit {
  store: MemoryStore;
  eventsAt(id: MemoryId): Promise<number>;
}

async function postgresKit(): Promise<Kit> {
  const { db } = await getTestClient();
  await resetTestDatabase();
  return {
    store: new PostgresMemoryStore(db),
    eventsAt: async (id) =>
      Number(
        (
          await db.execute(
            sql`SELECT count(*)::int AS c FROM memory_events WHERE memory_id = ${id}`,
          )
        ).rows[0]!.c,
      ),
  };
}

function inMemoryKit(): Kit {
  const store = new InMemoryMemoryStore();
  return { store, eventsAt: async (id) => store.events.filter((e) => e.memoryId === id).length };
}

let seq = 0;
function memory(store: MemoryStore, ctx: Ctx) {
  seq += 1;
  return store.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      content: `p${seq}`,
      digest: `d${seq}`,
      contentHash: `h-${ctx.tenantId}-${seq}`,
    }),
  );
}

const event = (
  memoryId: string | null,
  kind: "updated" | "created" = "updated",
): NewMemoryEvent => ({
  tenantId: "ignored",
  memoryId,
  kind,
  actor: { type: "system" },
  meta: { probe: true },
});

/** 結果の比較用: クラス名の接頭辞と末尾の id を伏せる。 */
function outcomeOf(error: unknown): string {
  if (!(error instanceof Error)) return "ok";
  return `${error.constructor.name}: ${error.message.replace(/^\w+: /, "<Store>: ").replace(/: [^\s:]+$/, ": <id>")}`;
}

interface Run {
  outcome: string;
  statuses: string[];
  eventsAtForeign: number;
}

type Op = (
  kit: Kit,
  pick: (own: MemoryId, other: MemoryId) => string | null,
) => Promise<{
  statuses: () => Promise<string[]>;
}>;

const OPS: Record<string, Op> = {
  async updateStatusWithEvent(kit, pick) {
    const a = await memory(kit.store, A);
    const other = await memory(kit.store, A);
    await kit.store.updateStatusWithEvent(A, a.id, "archived", {}, event(pick(a.id, other.id)));
    return { statuses: async () => [(await kit.store.get(A, a.id))!.status] };
  },
  async purgeMemory(kit, pick) {
    const a = await memory(kit.store, A);
    const other = await memory(kit.store, A);
    await kit.store.updateStatus(A, a.id, "forgotten");
    await kit.store.purgeMemory!(
      A,
      a.id,
      { content: "[p]", digest: "[p]" },
      event(pick(a.id, other.id)),
    );
    return { statuses: async () => [(await kit.store.get(A, a.id))!.status] };
  },
  async markContestedPair(kit, pick) {
    const [p1, p2, other] = [
      await memory(kit.store, A),
      await memory(kit.store, A),
      await memory(kit.store, A),
    ];
    await kit.store.markContestedPair!(
      A,
      { id: p1.id, event: event(pick(p2.id, other.id)) },
      { id: p2.id, event: event(p2.id) },
    );
    return {
      statuses: async () => [
        (await kit.store.get(A, p1.id))!.status,
        (await kit.store.get(A, p2.id))!.status,
      ],
    };
  },
  async resolveContestedPair(kit, pick) {
    const [p1, p2, other] = [
      await memory(kit.store, A),
      await memory(kit.store, A),
      await memory(kit.store, A),
    ];
    await kit.store.markContestedPair!(
      A,
      { id: p1.id, event: event(p1.id) },
      { id: p2.id, event: event(p2.id) },
    );
    await kit.store.resolveContestedPair!(
      A,
      { id: p1.id, status: "active", event: event(pick(p1.id, other.id)) },
      { id: p2.id, status: "superseded", supersededById: p1.id, event: event(p2.id) },
    );
    return {
      statuses: async () => [
        (await kit.store.get(A, p1.id))!.status,
        (await kit.store.get(A, p2.id))!.status,
      ],
    };
  },
  async resolveOrphanedContested(kit, pick) {
    const [z1, z2, other] = [
      await memory(kit.store, A),
      await memory(kit.store, A),
      await memory(kit.store, A),
    ];
    await kit.store.markContestedPair!(
      A,
      { id: z1.id, event: event(z1.id) },
      { id: z2.id, event: event(z2.id) },
    );
    await kit.store.updateStatus(A, z2.id, "forgotten");
    await kit.store.resolveOrphanedContested!(A, {
      id: z1.id,
      contestedWithId: z2.id,
      event: event(pick(z1.id, other.id)),
    });
    return { statuses: async () => [(await kit.store.get(A, z1.id))!.status] };
  },
  async markContestedGroup(kit, pick) {
    const [g1, g2, g3, other] = [
      await memory(kit.store, A),
      await memory(kit.store, A),
      await memory(kit.store, A),
      await memory(kit.store, A),
    ];
    await kit.store.markContestedGroup!(A, [
      { id: g1.id, event: event(pick(g2.id, other.id)) },
      { id: g2.id, event: event(g2.id) },
      { id: g3.id, event: event(g3.id) },
    ]);
    return { statuses: async () => [(await kit.store.get(A, g1.id))!.status] };
  },
  async resolveContestedGroup(kit, pick) {
    const [g1, g2, g3, other] = [
      await memory(kit.store, A),
      await memory(kit.store, A),
      await memory(kit.store, A),
      await memory(kit.store, A),
    ];
    await kit.store.markContestedGroup!(
      A,
      [g1, g2, g3].map((m) => ({ id: m.id, event: event(m.id) })),
    );
    await kit.store.resolveContestedGroup!(A, [
      { id: g1.id, status: "active", event: event(pick(g2.id, other.id)) },
      { id: g2.id, status: "superseded", supersededById: g1.id, event: event(g2.id) },
      { id: g3.id, status: "superseded", supersededById: g1.id, event: event(g3.id) },
    ]);
    return { statuses: async () => [(await kit.store.get(A, g1.id))!.status] };
  },
  async "supersedeWithNewMemories(supersede.event)"(kit, pick) {
    const old = await memory(kit.store, A);
    const other = await memory(kit.store, A);
    await kit.store.supersedeWithNewMemories!(
      A,
      [
        {
          input: buildNewMemoryFixture({
            tenantId: A.tenantId,
            content: "n",
            digest: "n",
            contentHash: `h-n-${++seq}`,
          }),
          jobKinds: [],
        },
      ],
      [{ id: old.id, supersededByIndex: 0, event: event(pick(old.id, other.id)) }],
    );
    return { statuses: async () => [(await kit.store.get(A, old.id))!.status] };
  },
  async "supersedeWithNewMemories(buildCreatedEvent)"(kit, pick) {
    const old = await memory(kit.store, A);
    const other = await memory(kit.store, A);
    await kit.store.supersedeWithNewMemories!(
      A,
      [
        {
          input: buildNewMemoryFixture({
            tenantId: A.tenantId,
            content: "n",
            digest: "n",
            contentHash: `h-n-${++seq}`,
          }),
          jobKinds: [],
        },
      ],
      [{ id: old.id, supersededByIndex: 0, event: event(old.id) }],
      { buildCreatedEvent: (m) => event(pick(m.id, other.id), "created") },
    );
    return { statuses: async () => [(await kit.store.get(A, old.id))!.status] };
  },
  async createMemoriesWithOutboxAndEvents(kit, pick) {
    const old = await memory(kit.store, A);
    const other = await memory(kit.store, A);
    await kit.store.createMemoriesWithOutboxAndEvents!(
      A,
      [
        {
          input: buildNewMemoryFixture({
            tenantId: A.tenantId,
            content: "n",
            digest: "n",
            contentHash: `h-n-${++seq}`,
          }),
          jobKinds: [],
        },
      ],
      (m) => event(pick(m.id, other.id), "created"),
    );
    return { statuses: async () => [(await kit.store.get(A, old.id))!.status] };
  },
};

async function run(kit: Kit, opName: string, target: Target): Promise<Run> {
  const b = await memory(kit.store, B);
  const pick = (own: MemoryId, other: MemoryId): string | null =>
    ({
      foreign: b.id,
      malformed: "not-a-uuid",
      own,
      sameTenantOther: other,
      null: null,
      ownUpper: own.toUpperCase(),
      otherUpper: other.toUpperCase(),
      foreignUpper: b.id.toUpperCase(),
    })[target];
  let statuses: () => Promise<string[]> = async () => [];
  let outcome = "ok";
  try {
    const result = await OPS[opName]!(kit, pick);
    statuses = result.statuses;
  } catch (error) {
    outcome = outcomeOf(error);
  }
  return {
    outcome,
    statuses: await statuses().catch(() => ["(未取得)"]),
    eventsAtForeign: await kit.eventsAt(b.id),
  };
}

describe("PostgresMemoryStore と InMemoryMemoryStore は、NewMemoryEvent.memoryId の検査で同じ入力を同じように断る・通す", () => {
  for (const opName of Object.keys(OPS)) {
    it(`${opName}: 指し先ごとに、結果・status・別テナントのイベント数が2実装で一致する`, async () => {
      const results: Array<{ target: Target; pg: Run; mem: Run }> = [];
      for (const target of TARGETS) {
        const pg = await run(await postgresKit(), opName, target);
        const mem = await run(inMemoryKit(), opName, target);
        results.push({ target, pg, mem });
      }
      for (const { target, pg, mem } of results) {
        expect(mem, `${opName} / ${target}`).toEqual(pg);
        if (target === "foreign" || target === "malformed" || target === "foreignUpper") {
          expect(pg.outcome, `${opName} / ${target}`).toMatch(/memory not found for tenant: <id>/);
          expect(pg.eventsAtForeign).toBe(0);
        } else {
          expect(pg.outcome, `${opName} / ${target}`).toBe("ok");
        }
      }
    });
  }
});
