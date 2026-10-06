import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type {
  Ctx,
  EventStore,
  MemoryId,
  MemoryStore,
  NewMemory,
  NewMemoryEvent,
  NewObservation,
  NewRecallRecord,
} from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { InMemoryEventStore, InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0499（ADR 0456 M4・ADR 0446 の材料）: 書き込みの口に NUL（U+0000）が入ったとき、DB の生の例外
 * （`DrizzleQueryError`。message は `Failed query: … params: …` で、params に利用者の値が載る）ではなく、
 * 何が悪いかを名指しした `Error`（`<欄> must not contain NUL characters (U+0000)`）で断る。
 * 読み取りの口（`read-scope-filter-nul.postgres.test.ts`）と同じ形である。
 *
 * 断る入力は増えない（直す前も同じ入力は例外で落ちていた）。例外の形が変わるだけで、何も書かれないことも変わらない。
 * 各口を testkit の InMemory にも同じ入力で流し、2実装が同じ欄名で断ることを縛る。
 * 各 it は、陽性対照（NUL を含まない・対になったサロゲートを含む同じ形の入力が通る）も持つ。
 *
 * `content` の NUL も対象（`digest` は、LLM が返さないとき本文から作られるので、本文の NUL は digest にも入る。`digest` だけ
 * 名指しにすると、本文の NUL を「digest が悪い」と説明してしまう）。保存できない候補を落とすときの説明
 * （`droppedCandidates`）が変わることは、`observe-unsaveable-candidate.postgres.test.ts` が縛っている。
 */

const A: Ctx = { tenantId: "write-nul-a" };
const NUL = "x\u0000y";
const LONE = "x\ud800y";
const PAIR = "x\u{1f600}y";

afterAll(async () => {
  await closeTestClient();
});

interface Kit {
  store: MemoryStore;
  eventStore: EventStore;
  eventCount(): Promise<number>;
  memoryCount(): Promise<number>;
}

async function postgresKit(): Promise<Kit> {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const count = async (table: "memory_events" | "memories") =>
    Number(
      (await db.execute(sql.raw(`SELECT count(*)::int AS c FROM ${table}`))).rows[0]!.c as number,
    );
  return {
    store: new PostgresMemoryStore(db),
    eventStore: new PostgresEventStore(db),
    eventCount: () => count("memory_events"),
    memoryCount: () => count("memories"),
  };
}

async function inMemoryKit(): Promise<Kit> {
  const store = new InMemoryMemoryStore();
  return {
    store,
    eventStore: new InMemoryEventStore(store, store.events),
    eventCount: async () => store.events.length,
    memoryCount: async () => store.listByTenant(A).length,
  };
}

const KITS: Array<[string, () => Promise<Kit>]> = [
  ["testkit の InMemory", inMemoryKit],
  ["Postgres", postgresKit],
];

let seq = 0;
function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  seq += 1;
  return buildNewMemoryFixture({
    tenantId: A.tenantId,
    content: `body-${seq}`,
    digest: `digest-${seq}`,
    contentHash: `hash-${seq}`,
    ...overrides,
  });
}
const mem = (kit: Kit, overrides: Partial<NewMemory> = {}) =>
  kit.store.createMemory(A, newMemory(overrides));

const ev = (
  memoryId: string | null,
  extra: Partial<NewMemoryEvent> = {},
  kind: NewMemoryEvent["kind"] = "updated",
): NewMemoryEvent => ({
  tenantId: A.tenantId,
  memoryId: memoryId as MemoryId | null,
  kind,
  actor: { type: "system" },
  meta: { probe: true },
  ...extra,
});

/** 例外が生の DB の例外でなく、名指しの Error であること。値（NUL）そのものを写していないこと。 */
function expectNamed(error: unknown, field: RegExp): void {
  expect(error, "NUL を含む入力は例外で終わる").toBeInstanceOf(Error);
  const err = error as Error;
  expect(err.constructor.name).not.toBe("DrizzleQueryError");
  expect(err.message).not.toContain("Failed query");
  expect(err.message).not.toContain("\u0000");
  expect(err.message).toMatch(field);
  expect(err.message).toMatch(/must not contain NUL/);
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  let thrown: unknown;
  await run().catch((e: unknown) => {
    thrown = e;
  });
  return thrown;
}

// ---- memory_events に書く口（イベントの digestSnapshot・meta・actor）----

interface EventCase {
  /** 準備（記憶・状態づくり。ここで積まれるイベントは数えない）をして、イベントを差して書く関数を返す。 */
  prepare(kit: Kit): Promise<(patch: Partial<NewMemoryEvent>) => Promise<void>>;
}

const EVENT_CASES: Record<string, EventCase> = {};
const eventCase = (name: string, c: EventCase) => {
  EVENT_CASES[name] = c;
};

const pair = async (kit: Kit) => [await mem(kit), await mem(kit)] as const;
const triple = async (kit: Kit) => [await mem(kit), await mem(kit), await mem(kit)] as const;

eventCase("EventStore.append（memoryId なし）", {
  prepare: async (kit) => async (patch) => {
    await kit.eventStore.append(A, ev(null, patch, "events_purged"));
  },
});
eventCase("EventStore.append（memoryId あり）", {
  prepare: async (kit) => {
    const m = await mem(kit);
    return async (patch) => {
      await kit.eventStore.append(A, ev(m.id, patch));
    };
  },
});
eventCase("updateStatusWithEvent", {
  prepare: async (kit) => {
    const m = await mem(kit);
    return async (patch) => {
      await kit.store.updateStatusWithEvent(A, m.id, "archived", {}, ev(m.id, patch));
    };
  },
});
eventCase("purgeMemory", {
  prepare: async (kit) => {
    const m = await mem(kit);
    await kit.store.updateStatus(A, m.id, "forgotten");
    return async (patch) => {
      await kit.store.purgeMemory!(A, m.id, { content: "[p]", digest: "[p]" }, ev(m.id, patch));
    };
  },
});
eventCase("markContestedPair（first 側）", {
  prepare: async (kit) => {
    const [a, b] = await pair(kit);
    return async (patch) => {
      await kit.store.markContestedPair!(
        A,
        { id: a.id, event: ev(a.id, patch) },
        { id: b.id, event: ev(b.id) },
      );
    };
  },
});
eventCase("markContestedPair（second 側）", {
  prepare: async (kit) => {
    const [a, b] = await pair(kit);
    return async (patch) => {
      await kit.store.markContestedPair!(
        A,
        { id: a.id, event: ev(a.id) },
        { id: b.id, event: ev(b.id, patch) },
      );
    };
  },
});
eventCase("resolveContestedPair", {
  prepare: async (kit) => {
    const [a, b] = await pair(kit);
    await kit.store.markContestedPair!(
      A,
      { id: a.id, event: ev(a.id) },
      { id: b.id, event: ev(b.id) },
    );
    return async (patch) => {
      await kit.store.resolveContestedPair!(
        A,
        { id: a.id, status: "active", event: ev(a.id, patch) },
        { id: b.id, status: "active", event: ev(b.id) },
      );
    };
  },
});
eventCase("resolveOrphanedContested", {
  prepare: async (kit) => {
    const [a, b] = await pair(kit);
    await kit.store.markContestedPair!(
      A,
      { id: a.id, event: ev(a.id) },
      { id: b.id, event: ev(b.id) },
    );
    await kit.store.updateStatus(A, b.id, "forgotten");
    return async (patch) => {
      await kit.store.resolveOrphanedContested!(A, {
        id: a.id,
        contestedWithId: b.id,
        event: ev(a.id, patch),
      });
    };
  },
});
eventCase("markContestedGroup", {
  prepare: async (kit) => {
    const ms = await triple(kit);
    return async (patch) => {
      await kit.store.markContestedGroup!(
        A,
        ms.map((m, i) => ({ id: m.id, event: ev(m.id, i === 2 ? patch : {}) })),
      );
    };
  },
});
eventCase("resolveContestedGroup", {
  prepare: async (kit) => {
    const ms = await triple(kit);
    await kit.store.markContestedGroup!(
      A,
      ms.map((m) => ({ id: m.id, event: ev(m.id) })),
    );
    return async (patch) => {
      await kit.store.resolveContestedGroup!(
        A,
        ms.map((m, i) => ({
          id: m.id,
          status: "active" as const,
          event: ev(m.id, i === 1 ? patch : {}),
        })),
      );
    };
  },
});
eventCase("supersedeWithNewMemories（supersede の event）", {
  prepare: async (kit) => {
    const old = await mem(kit);
    return async (patch) => {
      await kit.store.supersedeWithNewMemories!(
        A,
        [{ input: newMemory(), jobKinds: [] }],
        [{ id: old.id, supersededByIndex: 0, event: ev(old.id, patch, "superseded") }],
      );
    };
  },
});
eventCase("supersedeWithNewMemories（buildCreatedEvent）", {
  prepare: async (kit) => async (patch) => {
    await kit.store.supersedeWithNewMemories!(A, [{ input: newMemory(), jobKinds: [] }], [], {
      buildCreatedEvent: (memory) => ev(memory.id, patch, "created"),
    });
  },
});
eventCase("createMemoriesWithOutboxAndEvents（buildCreatedEvent）", {
  prepare: async (kit) => async (patch) => {
    await kit.store.createMemoriesWithOutboxAndEvents!(
      A,
      [{ input: newMemory(), jobKinds: [] }],
      (memory) => ev(memory.id, patch, "created"),
    );
  },
});

const POISON: Array<[string, Partial<NewMemoryEvent>, RegExp]> = [
  ["digestSnapshot の NUL", { digestSnapshot: NUL }, /memory_events\.digestSnapshot/],
  ["meta.reason の NUL", { meta: { reason: NUL } }, /memory_events\.meta/],
  ["meta の key の NUL", { meta: { [NUL]: "v" } }, /memory_events\.meta/],
  ["meta の入れ子の NUL", { meta: { a: [{ b: NUL }] } }, /memory_events\.meta/],
  ["meta の孤立サロゲート", { meta: { reason: LONE } }, /memory_events\.meta/],
  ["actor.id の NUL", { actor: { type: "human", id: NUL } }, /memory_events\.actor/],
];

for (const [kitName, makeKit] of KITS) {
  describe(`${kitName}: memory_events に書く口の NUL を名指しで断る（ADR 0499）`, () => {
    for (const [caseName, c] of Object.entries(EVENT_CASES)) {
      it(`${caseName}: 陽性対照（NUL なし・対になったサロゲート）は通る`, async () => {
        const kit = await makeKit();
        const go = await c.prepare(kit);
        const before = await kit.eventCount();
        await go({ meta: { reason: PAIR }, digestSnapshot: PAIR });
        expect(await kit.eventCount()).toBeGreaterThan(before);
      });

      it.each(POISON)(`${caseName}: %s は名指しで断り、何も書かない`, async (_l, patch, field) => {
        const kit = await makeKit();
        const go = await c.prepare(kit);
        const before = await snapshotOf(kit);
        const error = await caught(() => go(patch));
        expectNamed(error, field);
        // 何も書かれない: イベントは増えず、記憶の数も status も動かない。
        expect(await snapshotOf(kit)).toEqual(before);
      });
    }
  });
}

async function snapshotOf(kit: Kit) {
  const ids = await listAll(kit);
  const statuses = await Promise.all(
    ids.map(async (id) => [id, (await kit.store.get(A, id))!.status] as const),
  );
  return {
    events: await kit.eventCount(),
    memories: await kit.memoryCount(),
    statuses: statuses.sort((x, y) => (x[0] < y[0] ? -1 : 1)),
  };
}

async function listAll(kit: Kit): Promise<MemoryId[]> {
  const probe = kit.store as unknown as { listByTenant?: (ctx: Ctx) => Array<{ id: MemoryId }> };
  if (probe.listByTenant !== undefined) {
    return probe.listByTenant(A).map((m) => m.id);
  }
  const { db } = await getTestClient();
  const rows = await db.execute(sql`SELECT id FROM memories WHERE tenant_id = ${A.tenantId}`);
  return rows.rows.map((r) => (r as { id: MemoryId }).id);
}

// ---- memories に書く口（digest・tags・attributes・claim key・extractorVersion・provenance）----

const MEMORY_POISON: Array<[string, Partial<NewMemory>, RegExp, Partial<NewMemory>]> = [
  ["content", { content: NUL }, /content/, { content: PAIR }],
  ["digest", { digest: NUL }, /digest/, { digest: PAIR }],
  ["tags", { tags: ["ok", NUL] }, /tags/, { tags: ["ok", PAIR] }],
  ["attributes の値", { attributes: { k: NUL } }, /attributes/, { attributes: { k: PAIR } }],
  [
    "attributes の key",
    { attributes: { [NUL]: "v" } },
    /attributes/,
    { attributes: { [PAIR]: "v" } },
  ],
  [
    "claimKey.subject",
    { claimKey: { subject: NUL, predicate: "p" } },
    /claimKey\.subject/,
    { claimKey: { subject: PAIR, predicate: "p" } },
  ],
  [
    "claimKey.predicate",
    { claimKey: { subject: "s", predicate: NUL } },
    /claimKey\.predicate/,
    { claimKey: { subject: "s", predicate: PAIR } },
  ],
  ["extractorVersion", { extractorVersion: NUL }, /extractorVersion/, { extractorVersion: PAIR }],
  [
    "provenance",
    { provenance: { kind: "imported", batchId: NUL } },
    /provenance/,
    { provenance: { kind: "imported", batchId: PAIR } },
  ],
];

const MEMORY_ENTRIES: Record<string, (kit: Kit, input: NewMemory) => Promise<unknown>> = {
  createMemory: (kit, input) => kit.store.createMemory(A, input),
  createMemoryWithOutbox: (kit, input) => kit.store.createMemoryWithOutbox(A, input, ["embed"]),
  supersedeWithNewMemories: (kit, input) =>
    kit.store.supersedeWithNewMemories!(A, [{ input, jobKinds: ["embed"] }], []),
  // 全候補が保存できないとき、最初の例外がそのまま投げられる。
  createMemoriesWithOutboxAndEvents: (kit, input) =>
    kit.store.createMemoriesWithOutboxAndEvents!(A, [{ input, jobKinds: ["embed"] }], (memory) =>
      ev(memory.id, {}, "created"),
    ),
};

for (const [kitName, makeKit] of KITS) {
  describe(`${kitName}: memories に書く口の NUL を名指しで断る（ADR 0499）`, () => {
    for (const [entryName, enter] of Object.entries(MEMORY_ENTRIES)) {
      for (const [field, bad, pattern, good] of MEMORY_POISON) {
        it(`${entryName}: ${field}`, async () => {
          const kit = await makeKit();
          await expect(enter(kit, newMemory(good))).resolves.toBeDefined();
          const before = await kit.memoryCount();
          const error = await caught(() => enter(kit, newMemory(bad)));
          expectNamed(error, pattern);
          expect(await kit.memoryCount()).toBe(before);
        });
      }
    }

    it("型を外れた欄（claimKey の片方）は、NUL の検査ではなく ADR 0630 の検査が断る（NUL の message ではない。tags が空は通る）", async () => {
      const kit = await makeKit();
      const err = await kit.store
        .createMemory(A, newMemory({ claimKey: { subject: "u" } as never, tags: [] }))
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(String(err)).toMatch(/claimKey\.predicate is malformed/);
      expect(String(err)).not.toMatch(/NUL/);
      await expect(kit.store.createMemory(A, newMemory({ tags: [] }))).resolves.toBeDefined();
    });

    it("createMemoriesWithOutboxAndEvents: NUL の候補だけを落とし、ほかの候補は書く（落とした候補の例外は名指し）", async () => {
      const kit = await makeKit();
      const result = await kit.store.createMemoriesWithOutboxAndEvents!(
        A,
        [
          { input: newMemory(), jobKinds: ["embed"] },
          { input: newMemory({ digest: NUL }), jobKinds: ["embed"] },
          { input: newMemory(), jobKinds: ["embed"] },
        ],
        (memory) => ev(memory.id, {}, "created"),
      );
      expect(result.written.map((w) => w.index)).toEqual([0, 2]);
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0]!.index).toBe(1);
      expectNamed(result.dropped[0]!.error, /digest/);
      expect(await kit.memoryCount()).toBe(2);
    });
  });
}

for (const [kitName, makeKit] of KITS) {
  describe(`${kitName}: 墓石・restoreSupersededBy の NUL を名指しで断る（ADR 0499）`, () => {
    it.each([
      ["tombstone.content", { content: NUL, digest: "[p]" }],
      ["tombstone.digest", { content: "[p]", digest: NUL }],
    ])("purgeMemory: %s の NUL は名指しで断り、purge されない", async (field, tombstone) => {
      const kit = await makeKit();
      const m = await mem(kit);
      await kit.store.updateStatus(A, m.id, "forgotten");
      const error = await caught(() => kit.store.purgeMemory!(A, m.id, tombstone, ev(m.id)));
      expectNamed(error, new RegExp(field.replace(".", "\\.")));
      expect((await kit.store.get(A, m.id))!.purgedAt ?? null).toBeNull();
      expect(await kit.eventCount()).toBe(0);
      // 陽性対照
      await expect(
        kit.store.purgeMemory!(A, m.id, { content: "[p]", digest: "[p]" }, ev(m.id)),
      ).resolves.toBeDefined();
    });

    const restoreSetup = async (kit: Kit) => {
      const anchor = await mem(kit);
      const old = await mem(kit);
      await kit.store.updateStatus(A, old.id, "superseded", { supersededById: anchor.id });
      return { anchor, old };
    };

    it.each([
      ["reason", { reason: NUL }, /memory_events\.meta/],
      ["actor.id", { actor: { type: "human" as const, id: NUL } }, /memory_events\.actor/],
    ])("restoreSupersededBy: %s の NUL は名指しで断り、戻さない", async (_l, patch, field) => {
      const kit = await makeKit();
      const { anchor, old } = await restoreSetup(kit);
      const error = await caught(() =>
        kit.store.restoreSupersededBy!(A, anchor.id, { ...patch, at: new Date() }),
      );
      expectNamed(error, field);
      expect((await kit.store.get(A, old.id))!.status).toBe("superseded");
      expect(await kit.eventCount()).toBe(0);
    });

    it("restoreSupersededBy: 陽性対照（NUL なし・対になったサロゲート）は戻る", async () => {
      const kit = await makeKit();
      const { anchor, old } = await restoreSetup(kit);
      const { restored } = await kit.store.restoreSupersededBy!(A, anchor.id, {
        reason: PAIR,
        at: new Date(),
      });
      expect(restored.map((m) => m.id)).toEqual([old.id]);
    });
  });
}

// ---- observations・recalls に書く口（ADR 0505。ADR 0456 M4 の残り）----

const OBSERVATION_NUL_CASES: Array<[string, Partial<NewObservation>, RegExp]> = [
  ["payload の値", { payload: { text: NUL } }, /payload/],
  ["payload の key", { payload: { [NUL]: "v" } }, /payload/],
  ["payload の入れ子", { payload: { a: [{ b: NUL }] } }, /payload/],
  ["attributes の値", { attributes: { k: NUL } }, /attributes/],
  ["attributes の key", { attributes: { [NUL]: "v" } }, /attributes/],
  ["kind", { kind: NUL }, /kind/],
];

const RECALL_RECORD: NewRecallRecord = {
  tenantId: A.tenantId,
  subjectId: null,
  query: { text: "q" },
  budget: null,
  omitted: [],
  usage: {
    chars: 0,
    estimatedTokens: 0,
    counter: "heuristic",
    byTier: { full: 0, digest: 0, index: 0 },
    indexChars: 0,
  },
  indexBand: { groups: [], totalInScope: 0, countKind: "exact" },
  explain: { stages: [] },
  returnedMemories: [],
};

const RECALL_NUL_CASES: Array<[string, Partial<NewRecallRecord>, RegExp]> = [
  ["query", { query: { text: NUL } }, /query/],
  ["query の key", { query: { [NUL]: "x" } }, /query/],
  ["budget", { budget: { chars: 1, x: NUL } as never }, /budget/],
  ["omitted", { omitted: [{ reason: NUL }] as never }, /omitted/],
  ["usage", { usage: { ...RECALL_RECORD.usage, counter: NUL } as never }, /usage/],
  ["indexBand", { indexBand: { groups: [NUL], totalInScope: 0 } as never }, /indexBand/],
  ["explain", { explain: { stages: [{ stage: NUL }] } as never }, /explain/],
  ["returnedMemories", { returnedMemories: [{ memoryId: NUL }] as never }, /returnedMemories/],
];

for (const [kitName, makeKit] of KITS) {
  describe(`${kitName}: Observation・Recall の記録の NUL を名指しで断る（ADR 0505）`, () => {
    const observationMouths: Array<
      [string, (kit: Kit, input: NewObservation) => Promise<unknown>]
    > = [
      ["createObservation", (kit, input) => kit.store.createObservation(A, input)],
      [
        "createObservationWithOutbox",
        (kit, input) => kit.store.createObservationWithOutbox!(A, input, []),
      ],
    ];
    for (const [mouth, write] of observationMouths) {
      it.each(OBSERVATION_NUL_CASES)(
        `${mouth}: %s の NUL は名指しで断る`,
        async (_label, patch, field) => {
          const kit = await makeKit();
          const input = buildNewObservationFixture({
            tenantId: A.tenantId,
            externalId: `ext-${mouth}`,
            ...patch,
          });
          const error = await caught(() => write(kit, input));
          expectNamed(error, field);
          expect((error as Error).message).toMatch(/^(Postgres|InMemory)MemoryStore: /);
          // 何も書かれていない: 同じ externalId で NUL を除いた入力が、新しい行として書ける
          const clean = buildNewObservationFixture({
            tenantId: A.tenantId,
            externalId: `ext-${mouth}`,
          });
          const written = (await write(kit, clean)) as { created?: boolean };
          if (mouth === "createObservationWithOutbox") {
            expect(written.created).toBe(true);
          }
        },
      );

      it(`${mouth}: 陽性対照（NUL を含まない・NUL に似た文字・対になったサロゲート）は通る`, async () => {
        const kit = await makeKit();
        await expect(
          write(
            kit,
            buildNewObservationFixture({
              tenantId: A.tenantId,
              kind: "utterance\u0001",
              payload: { text: PAIR, literal: "a\\u0000b", [PAIR]: [LONE.length] },
              attributes: { k: PAIR },
            }),
          ),
        ).resolves.toBeDefined();
      });
    }

    it.each(RECALL_NUL_CASES)(
      "createRecall: %s の NUL は名指しで断る",
      async (_label, patch, field) => {
        const kit = await makeKit();
        const error = await caught(() => kit.store.createRecall(A, { ...RECALL_RECORD, ...patch }));
        expectNamed(error, field);
        expect((error as Error).message).toMatch(/^createRecall: /);
      },
    );

    it("createRecall: 陽性対照（NUL を含まない・対になったサロゲート）は通る", async () => {
      const kit = await makeKit();
      await expect(
        kit.store.createRecall(A, { ...RECALL_RECORD, query: { text: PAIR, [PAIR]: "a\\u0000b" } }),
      ).resolves.toBeDefined();
    });
  });
}
