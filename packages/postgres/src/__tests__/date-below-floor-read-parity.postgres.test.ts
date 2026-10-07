import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  EventStore,
  LexicalStore,
  MemoryStore,
  OutboxStore,
  TenantSettingsStore,
  VectorStore,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { createFakeRuntimeStores } from "../../../core/src/__tests__/runtime-fakes.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  PostgresTrigramLexicalStore,
  TrigramLexicalStoreUnavailableError,
} from "../trigram-lexical-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  TEST_EMBEDDING_SPACE,
  closeTestClient,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

/**
 * 読みの経路の日時が `timestamptz` の下限（4714-11-24 BC 00:00:00 UTC）より前でも、Postgres は生の `22008 timestamp out of range` で落ちず、
 * 下限に寄せてからいつもどおり比べる。3実装に同じデータ・同じ入力を流し、(1) 3者が一致すること、(2) 答えが「全件」か「0件」か
 * （`since` 系は全件、`until` 系は0件）という意味どおりであることを縛る。Fake は検査をせず意味どおりに答える（参照実装）。
 * この歯のデータは下限に行を置かない（下限ちょうどに行がある場合の食い違いは既知の限界）。
 */

const FLOOR_MS = Date.UTC(-4713, 10, 24);
const FAR = new Date(Date.UTC(-5000, 0, 1)); // 紀元前5001年
const EARLY = new Date(FLOOR_MS - 1);
const EDGE = new Date(FLOOR_MS);
const BELOW: Array<[string, Date]> = [
  ["紀元前5001年", FAR],
  ["下限の1ms 前", EARLY],
];

interface Kit {
  mem: MemoryStore;
  vec: VectorStore;
  lex: LexicalStore;
  ev: EventStore;
  ob: OutboxStore;
  settings: TenantSettingsStore;
  trigram?: LexicalStore;
  name: string;
}

let tenantSeq = 0;
const nextCtx = (): Ctx => ({ tenantId: `date-floor-${++tenantSeq}` });

/**
 * server_encoding が UTF8 でない DB（CI の SQL_ASCII の脚）では trigram 版の `create` が `TrigramLexicalStoreUnavailableError` を投げるので、
 * そのときは trigram 版の比較を外す（`undefined`。tsvector 版は SQL_ASCII でも走る）。それ以外の例外は握りつぶさない。
 */
async function createTrigramIfAvailable(
  db: Awaited<ReturnType<typeof getTestClient>>["db"],
): Promise<LexicalStore | undefined> {
  try {
    return await PostgresTrigramLexicalStore.create(db);
  } catch (e) {
    if (e instanceof TrigramLexicalStoreUnavailableError) return undefined;
    throw e;
  }
}

async function kits(): Promise<Kit[]> {
  const { db } = await getTestClient();
  const inMem = new InMemoryMemoryStore();
  const fake = createFakeRuntimeStores();
  return [
    {
      name: "postgres",
      mem: new PostgresMemoryStore(db),
      vec: new PostgresVectorStore(db),
      lex: new PostgresLexicalStore(db),
      trigram: await createTrigramIfAvailable(db),
      ev: new PostgresEventStore(db),
      ob: new PostgresOutboxStore(db),
      settings: new PostgresTenantSettingsStore(db),
    },
    {
      name: "in-memory",
      mem: inMem,
      vec: new InMemoryVectorStore(inMem),
      lex: new InMemoryLexicalStore(inMem),
      ev: new InMemoryEventStore(inMem, inMem.events),
      ob: new InMemoryOutboxStore(inMem.outboxJobs),
      settings: new InMemoryTenantSettingsStore(inMem.activitySeq),
    },
    {
      name: "fake",
      mem: fake.memoryStore,
      vec: fake.vectorStore,
      lex: fake.lexicalStore,
      ev: fake.eventStore,
      ob: fake.outboxStore,
      settings: fake.tenantSettingsStore,
    },
  ];
}

beforeAll(async () => {
  await resetTestDatabase();
});
afterAll(async () => {
  await closeTestClient();
});

type Seeded = { ctx: Ctx; idToName: Map<string, string> };

/** 同じ5件の記憶を入れる。いずれも `recordedAt` は 2026 年で、下限の近くには行を置かない。 */
async function seed(kit: Kit): Promise<Seeded> {
  const ctx = nextCtx();
  const idToName = new Map<string, string>();
  const make = async (
    name: string,
    over: Parameters<typeof buildNewMemoryFixture>[0],
  ): Promise<string> => {
    const m = await kit.mem.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: `${name} hello`,
        contentHash: `h-${name}`,
        digest: name,
        embeddingStatus: "ready",
        halfLifeHours: 1e6,
        decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
        ...over,
      }),
    );
    idToName.set(m.id, name);
    await kit.vec.upsert(ctx, TEST_EMBEDDING_SPACE, m.id, [1, 0, 0]);
    return m.id;
  };
  await make("alpha", { occurredAt: new Date("2026-03-01T00:00:00.000Z") });
  await make("bravo", { validFrom: new Date("2026-01-01T00:00:00.000Z") });
  await make("charlie", {
    occurredAt: new Date("2026-02-01T00:00:00.000Z"),
    validUntil: new Date("2030-01-01T00:00:00.000Z"),
  });
  await make("delta", {
    claimKey: { subject: "s", predicate: "p" },
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
  });
  await make("golf", { claimKey: { subject: "s", predicate: "p" } });
  const echo = await make("echo", {
    claimKey: { subject: "s", predicate: "p" },
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
  });
  const foxtrot = await make("foxtrot", {
    claimKey: { subject: "s", predicate: "p" },
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
  });
  const contestedEvent = (memoryId: string) => ({
    tenantId: ctx.tenantId,
    memoryId,
    kind: "updated" as const,
    at: new Date("2026-04-01T00:00:00.000Z"),
    actor: { type: "system" as const },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
  });
  await kit.mem.markContestedPair!(
    ctx,
    { id: echo, event: contestedEvent(echo) },
    { id: foxtrot, event: contestedEvent(foxtrot) },
  );
  for (const [i, at] of [
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-02-01T00:00:00.000Z"),
    new Date("2026-03-01T00:00:00.000Z"),
  ].entries()) {
    await kit.ev.append(ctx, {
      tenantId: ctx.tenantId,
      memoryId: null,
      kind: "created",
      at,
      actor: { type: "system" },
      digestSnapshot: null,
      sizeBeforeBytes: null,
      meta: { i },
    });
  }
  return { ctx, idToName };
}

const names = (seeded: Seeded, ids: string[]): string[] =>
  ids.map((id) => seeded.idToName.get(id) ?? `?${id}`).sort();
const ALL = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
const CLAIM = (validFrom: Date | null, validUntil: Date | null) => ({
  subjectId: null,
  claimKey: { subject: "s", predicate: "p" },
  excludeMemoryId: "00000000-0000-4000-8000-000000000000",
  contentHash: "other",
  validFrom,
  validUntil,
});

/** 例外の SQLSTATE（あれば）と、先頭の一行。 */
function describeThrown(e: unknown): string {
  const code =
    (e as { cause?: { code?: string }; code?: string }).cause?.code ??
    (e as { code?: string }).code ??
    "";
  return `${code} ${(e as Error).message.trim().split("\n")[0] ?? ""}`.slice(0, 120);
}

interface Case {
  name: string;
  expected: unknown;
  run: (kit: Kit, s: Seeded, d: Date) => Promise<unknown>;
}

const vecFilter = (s: Seeded, extra: object) => ({ tenantId: s.ctx.tenantId, ...extra });
const vecSearch = async (kit: Kit, s: Seeded, extra: object) =>
  names(
    s,
    (
      await kit.vec.search(s.ctx, TEST_EMBEDDING_SPACE, [1, 0, 0], {
        limit: 10,
        filter: vecFilter(s, extra),
      })
    ).map((h) => h.memoryId),
  );
const vecSearchMany = async (kit: Kit, s: Seeded, extra: object) => {
  // core の Fake は任意の `searchMany` を実装しない。呼び出し側の定石どおり、無ければ `search` で答える。
  if (kit.vec.searchMany === undefined) return vecSearch(kit, s, extra);
  const out = await kit.vec.searchMany(
    s.ctx,
    TEST_EMBEDDING_SPACE,
    [{ key: "k", vector: [1, 0, 0] }],
    { limit: 10, filter: vecFilter(s, extra) },
  );
  return names(
    s,
    (out.get("k") ?? []).map((h) => h.memoryId),
  );
};
const lexSearch = async (lex: LexicalStore, s: Seeded, extra: object) =>
  names(
    s,
    (await lex.search(s.ctx, "hello", { limit: 10, filter: vecFilter(s, extra) })).map(
      (h) => h.memoryId,
    ),
  );

// validAt が下限より前: 開始が無く（valid_from なし）終了が将来か無い行だけが有効（alpha・charlie・delta/echo は validFrom 2026 なので外れる）。
const VALID_AT_BELOW = ["alpha", "charlie", "golf"];

const cases: Case[] = [
  {
    name: "EventStore.list since（全件）",
    expected: 5,
    run: async (k, s, d) => (await k.ev.list(s.ctx, { since: d })).length,
  },
  {
    name: "EventStore.list until（0件）",
    expected: 0,
    run: async (k, s, d) => (await k.ev.list(s.ctx, { until: d })).length,
  },
  ...(
    [
      ["occurredAfter", ALL],
      ["occurredBefore", []],
      ["validAt", VALID_AT_BELOW],
      ["decayFloorAtAfter", ALL],
    ] as const
  ).flatMap(([field, expected]): Case[] => [
    {
      name: `VectorStore.search ${field}`,
      expected,
      run: (k, s, d) => vecSearch(k, s, { [field]: d }),
    },
    {
      name: `VectorStore.searchMany ${field}`,
      expected,
      run: (k, s, d) => vecSearchMany(k, s, { [field]: d }),
    },
    {
      name: `MemoryStore.aggregateScope ${field}`,
      expected: expected.length,
      run: async (k, s, d) => {
        const agg = await k.mem.aggregateScope(s.ctx, { [field]: d } as never);
        return agg.totalInScope;
      },
    },
  ]),
  ...(
    [
      ["occurredAfter", ALL],
      ["occurredBefore", []],
      ["validAt", VALID_AT_BELOW],
    ] as const
  ).flatMap(([field, expected]): Case[] => [
    {
      name: `LexicalStore.search ${field}`,
      expected,
      run: (k, s, d) => lexSearch(k.lex, s, { [field]: d }),
    },
    {
      name: `LexicalStore.search（trigram 版）${field}`,
      expected,
      // trigram 版が使えない DB（SQL_ASCII）では tsvector 版で代用する（比較の意味は変わらず、trigram 固有の確認だけが外れる）。
      run: (k, s, d) => lexSearch(k.trigram ?? k.lex, s, { [field]: d }),
    },
  ]),
  {
    name: "findActiveByClaimKey validFrom のみ",
    expected: ["delta", "golf"],
    run: async (k, s, d) =>
      names(
        s,
        (await k.mem.findActiveByClaimKey!(s.ctx, CLAIM(d, null))).map((m) => m.id),
      ),
  },
  {
    name: "findActiveByClaimKey validUntil のみ",
    expected: ["golf"],
    run: async (k, s, d) =>
      names(
        s,
        (await k.mem.findActiveByClaimKey!(s.ctx, CLAIM(null, d))).map((m) => m.id),
      ),
  },
  {
    name: "findContestedByClaimKey validFrom のみ",
    expected: ["echo", "foxtrot"],
    run: async (k, s, d) =>
      names(
        s,
        (await k.mem.findContestedByClaimKey!(s.ctx, CLAIM(d, null))).map((m) => m.id),
      ),
  },
  {
    name: "findContestedByClaimKey validUntil のみ",
    expected: [],
    run: async (k, s, d) =>
      names(
        s,
        (await k.mem.findContestedByClaimKey!(s.ctx, CLAIM(null, d))).map((m) => m.id),
      ),
  },
  // 両端が下限より前で、from < until（空でない区間）。寄せた値は等しくなるが、空の区間にしない（開始も終了も無い golf と重なる）。
  {
    name: "findActiveByClaimKey 両端とも下限より前（空でない区間）",
    expected: ["golf"],
    run: async (k, s, d) =>
      names(
        s,
        (await k.mem.findActiveByClaimKey!(s.ctx, CLAIM(new Date(d.getTime() - 1000), d))).map(
          (m) => m.id,
        ),
      ),
  },
  {
    name: "findActiveByClaimKey 両端とも下限より前（逆転した区間）",
    expected: [],
    run: async (k, s, d) =>
      names(
        s,
        (await k.mem.findActiveByClaimKey!(s.ctx, CLAIM(d, new Date(d.getTime() - 1000)))).map(
          (m) => m.id,
        ),
      ),
  },
];

describe("下限より前の日時でも、読みの口は3実装で同じ答えを返す", () => {
  for (const c of cases) {
    for (const [label, date] of BELOW) {
      it(`${c.name}（${label}）`, async () => {
        const answers: Record<string, unknown> = {};
        for (const kit of await kits()) {
          const s = await seed(kit);
          answers[kit.name] = await c
            .run(kit, s, date)
            .catch((e: unknown) => ({ threw: describeThrown(e) }));
        }
        expect(answers).toEqual({
          postgres: c.expected,
          "in-memory": c.expected,
          fake: c.expected,
        });
      });
    }
  }

  it("下限ちょうどの日時は、下限より前と同じ答えになる口がある（since は全件）", async () => {
    for (const kit of await kits()) {
      const s = await seed(kit);
      expect((await kit.ev.list(s.ctx, { since: EDGE })).length).toBe(5);
      expect((await kit.ev.list(s.ctx, { since: EARLY })).length).toBe(5);
      expect(await vecSearch(kit, s, { occurredAfter: EDGE })).toEqual(ALL);
    }
  });
});

describe("下限ちょうどに行がある場合", () => {
  /** occurredAt と事象の時刻が下限ちょうどの行を1件だけ入れる（書く口は下限ちょうどを通す）。 */
  async function seedEdge(kit: Kit): Promise<Seeded> {
    const ctx = nextCtx();
    const m = await kit.mem.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: "zulu hello",
        contentHash: "h-zulu",
        occurredAt: EDGE,
        embeddingStatus: "ready",
        halfLifeHours: 1e6,
        decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
      }),
    );
    await kit.vec.upsert(ctx, TEST_EMBEDDING_SPACE, m.id, [1, 0, 0]);
    await kit.ev.append(ctx, {
      tenantId: ctx.tenantId,
      memoryId: null,
      kind: "created",
      at: EDGE,
      actor: { type: "system" },
      digestSnapshot: null,
      sizeBeforeBytes: null,
      meta: {},
    });
    return { ctx, idToName: new Map([[m.id, "zulu"]]) };
  }

  it("下限ちょうどの日時で比べると、3実装とも下限ちょうどの行を since 系・until 系の両方に含める（境界を含む）", async () => {
    const answers: Record<string, unknown> = {};
    for (const kit of await kits()) {
      const s = await seedEdge(kit);
      answers[kit.name] = {
        eventsSinceEdge: (await kit.ev.list(s.ctx, { since: EDGE })).length,
        eventsUntilEdge: (await kit.ev.list(s.ctx, { until: EDGE })).length,
        afterEdge: await vecSearch(kit, s, { occurredAfter: EDGE }),
        beforeEdge: await vecSearch(kit, s, { occurredBefore: EDGE }),
      };
    }
    const expected = {
      eventsSinceEdge: 1,
      eventsUntilEdge: 1,
      afterEdge: ["zulu"],
      beforeEdge: ["zulu"],
    };
    expect(answers).toEqual({ postgres: expected, "in-memory": expected, fake: expected });
  });

  it("下限より前の since 系は、下限ちょうどの行も返す（全件）", async () => {
    for (const [, date] of BELOW) {
      for (const kit of await kits()) {
        const s = await seedEdge(kit);
        expect((await kit.ev.list(s.ctx, { since: date })).length).toBe(1);
        expect(await vecSearch(kit, s, { occurredAfter: date })).toEqual(["zulu"]);
      }
    }
  });

  // 既知の限界: 下限へ寄せると、下限ちょうどの行が until 系（<=）に当たってしまう。意味どおりなら0件（InMemory・Fake はそう答える）。
  it("既知の限界: 下限より前の until 系は、下限ちょうどの行があるとき Postgres だけがその行を返す", async () => {
    const answers: Record<string, unknown> = {};
    for (const kit of await kits()) {
      const s = await seedEdge(kit);
      answers[kit.name] = {
        eventsUntilEarly: (await kit.ev.list(s.ctx, { until: EARLY })).length,
        beforeEarly: await vecSearch(kit, s, { occurredBefore: EARLY }),
      };
    }
    expect(answers).toEqual({
      postgres: { eventsUntilEarly: 1, beforeEarly: ["zulu"] },
      "in-memory": { eventsUntilEarly: 0, beforeEarly: [] },
      fake: { eventsUntilEarly: 0, beforeEarly: [] },
    });
  });
});

// 約9500年のリース。now が 2100 年でも、now - leaseMs は紀元前7000年台になる（下限より前）。
const HUGE_LEASE_MS = 3e14;
const LATER = new Date("2100-01-01T00:00:00.000Z");

describe("OutboxStore.claimBatch の opts.now", () => {
  /**
   * 「いま」available になる job を1件入れる（`opts.now` は渡さない。core の Fake は `opts.now` を `availableAt` に使わない）。
   * 下限の近くに行は置かない。
   */
  async function seedJob(kit: Kit): Promise<Ctx> {
    const ctx = nextCtx();
    await kit.mem.createObservationWithOutbox(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
      ["extract"],
    );
    return ctx;
  }
  const shape = (jobs: Array<{ kind: string; attempts: number; claimedBy?: string | null }>) =>
    jobs.map((j) => [j.kind, j.attempts, j.claimedBy]);

  for (const [label, date] of BELOW) {
    it(`now が下限より前（${label}）は、まだ available でないので0件`, async () => {
      const answers: Record<string, unknown> = {};
      for (const kit of await kits()) {
        const ctx = await seedJob(kit);
        answers[kit.name] = await kit.ob
          .claimBatch(ctx, { limit: 5, now: date, claimedBy: "w", leaseMs: 60_000 })
          .then(shape, (e: unknown) => ({ threw: describeThrown(e) }));
      }
      expect(answers).toEqual({ postgres: [], "in-memory": [], fake: [] });
    });
  }

  it("now は下限より後でも、now - leaseMs が下限より前なら、claim できる（リースの境界を下限に寄せる）。リース中の再 claim はできない", async () => {
    const answers: Record<string, unknown> = {};
    for (const kit of await kits()) {
      const ctx = await seedJob(kit);
      const first = await kit.ob
        .claimBatch(ctx, {
          limit: 5,
          now: LATER,
          claimedBy: "w1",
          leaseMs: HUGE_LEASE_MS,
        })
        .then(shape, (e: unknown) => ({ threw: describeThrown(e) }));
      const second = await kit.ob
        .claimBatch(ctx, {
          limit: 5,
          now: new Date(LATER.getTime() + 1000),
          claimedBy: "w2",
          leaseMs: HUGE_LEASE_MS,
        })
        .then(shape, (e: unknown) => ({ threw: describeThrown(e) }));
      answers[kit.name] = { first, second };
    }
    const expected = { first: [["extract", 1, "w1"]], second: [] };
    expect(answers).toEqual({ postgres: expected, "in-memory": expected, fake: expected });
  });
});

describe("Runtime.recall の日時の絞り込み", () => {
  const embeddingProvider = {
    space: TEST_EMBEDDING_SPACE,
    embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
  };
  const llmProvider = {
    complete: async () => ({ content: "" }),
    completeStructured: async () => {
      throw new Error("unused");
    },
  };

  async function recallKits() {
    const shared = {
      llmProvider,
      embeddingProvider,
      hashContent: (c: string) => createHash("sha256").update(c).digest("hex"),
      clock: { now: () => new Date("2026-06-01T00:00:00.000Z") },
    };
    return (await kits()).map((kit) => ({
      kit,
      runtime: createRuntime({
        ...shared,
        memoryStore: kit.mem,
        vectorStore: kit.vec,
        lexicalStore: kit.lex,
        outboxStore: kit.ob,
        eventStore: kit.ev,
        tenantSettingsStore: kit.settings,
      }),
    }));
  }

  for (const [label, date] of BELOW) {
    for (const [field, expectAll] of [
      ["occurredAfter", true],
      ["occurredBefore", false],
    ] as const) {
      it(`${field} が下限より前（${label}）: ${expectAll ? "絞り込み無しと同じ" : "0件"}`, async () => {
        const answers: Record<string, unknown> = {};
        for (const { kit, runtime } of await recallKits()) {
          const s = await seed(kit);
          const run = async (extra: object) =>
            names(
              s,
              (
                await runtime.recall(s.ctx, {
                  text: "hello",
                  limit: 10,
                  association: null,
                  ...extra,
                })
              ).memories.map((m) => m.memoryId),
            );
          const baseline = await run({});
          const filtered = await run({ [field]: date }).catch((e: unknown) => ({
            threw: describeThrown(e),
          }));
          answers[kit.name] = expectAll
            ? {
                sameAsBaseline: JSON.stringify(filtered) === JSON.stringify(baseline),
                nonEmpty: baseline.length > 0,
              }
            : filtered;
        }
        const expected = expectAll ? { sameAsBaseline: true, nonEmpty: true } : [];
        expect(answers).toEqual({ postgres: expected, "in-memory": expected, fake: expected });
      });
    }
  }
});

describe("OutboxStore.claimBatch: 下限ちょうどに available な job（Postgres だけ）", () => {
  // now を下限へ寄せると、available_at が下限ちょうどの行が claim できる。そのとき行に書く claimed_at・available_at も寄せた値でなければならない（寄せずに書くと UPDATE が 22008 になる）。
  it("now が下限より前でも、下限ちょうどに available な job の claim は 22008 にならず、claimed_at は下限になる", async () => {
    const { db } = await getTestClient();
    const memory = new PostgresMemoryStore(db);
    const outbox = new PostgresOutboxStore(db);
    const ctx = nextCtx();
    await memory.createObservationWithOutbox(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
      ["extract"],
      { now: EDGE },
    );
    const claimed = await outbox.claimBatch(ctx, {
      limit: 5,
      now: FAR,
      claimedBy: "w",
      leaseMs: 60_000,
    });
    expect(claimed.map((j) => [j.kind, j.attempts, j.claimedAt?.getTime()])).toEqual([
      ["extract", 1, FLOOR_MS],
    ]);
  });
});

describe("purge の olderThan が下限より前（0件。以前から同じ）", () => {
  for (const [label, date] of BELOW) {
    it(`purgeExpiredEvents・purgeExpiredRecalls・purgeCompletedJobs は、3実装とも例外にならず0件（${label}）`, async () => {
      const answers: Record<string, unknown> = {};
      for (const kit of await kits()) {
        const ctx = nextCtx();
        const run = (f: () => Promise<{ purged: number }> | undefined) =>
          (f() ?? Promise.resolve({ purged: -1 })).then(
            (r) => r.purged,
            (e: unknown) => ({ threw: describeThrown(e) }),
          );
        answers[kit.name] = [
          await run(() => kit.mem.purgeExpiredEvents?.(ctx, { olderThan: date, limit: 5 })),
          await run(() => kit.mem.purgeExpiredRecalls?.(ctx, { olderThan: date, limit: 5 })),
          await run(() => kit.ob.purgeCompletedJobs?.(ctx, { olderThan: date, limit: 5 })),
        ];
      }
      const expected = [0, 0, 0];
      expect(answers).toEqual({ postgres: expected, "in-memory": expected, fake: expected });
    });
  }
});

describe("findContestedByClaimKey: 両端とも下限より前でも、空の区間の判定は寄せる前の値で行う（決めたこと3）", () => {
  /** 有効期間の無い contested のペアを1組入れる（開始も終了も無い行は、どの区間とも重なる）。 */
  async function seedContestedOpen(kit: Kit): Promise<Seeded> {
    const ctx = nextCtx();
    const idToName = new Map<string, string>();
    const make = async (name: string): Promise<string> => {
      const m = await kit.mem.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          content: `${name} hello`,
          contentHash: `h-${name}`,
          claimKey: { subject: "s", predicate: "p" },
        }),
      );
      idToName.set(m.id, name);
      return m.id;
    };
    const hotel = await make("hotel");
    const india = await make("india");
    const event = (memoryId: string) => ({
      tenantId: ctx.tenantId,
      memoryId,
      kind: "updated" as const,
      at: new Date("2026-04-01T00:00:00.000Z"),
      actor: { type: "system" as const },
      digestSnapshot: null,
      sizeBeforeBytes: null,
      meta: {},
    });
    await kit.mem.markContestedPair!(
      ctx,
      { id: hotel, event: event(hotel) },
      { id: india, event: event(india) },
    );
    return { ctx, idToName };
  }

  for (const [label, date] of BELOW) {
    it(`両端とも下限より前で from < until（空でない区間）は、開始も終了も無い contested の行と重なる（${label}）`, async () => {
      const answers: Record<string, unknown> = {};
      for (const kit of await kits()) {
        const s = await seedContestedOpen(kit);
        answers[kit.name] = await kit.mem.findContestedByClaimKey!(
          s.ctx,
          CLAIM(new Date(date.getTime() - 1000), date),
        ).then(
          (ms) =>
            names(
              s,
              ms.map((m) => m.id),
            ),
          (e: unknown) => ({ threw: describeThrown(e) }),
        );
      }
      const expected = ["hotel", "india"];
      expect(answers).toEqual({ postgres: expected, "in-memory": expected, fake: expected });
    });

    it(`両端とも下限より前で from > until（逆転した区間）は、何とも重ならない（${label}）`, async () => {
      const answers: Record<string, unknown> = {};
      for (const kit of await kits()) {
        const s = await seedContestedOpen(kit);
        answers[kit.name] = await kit.mem.findContestedByClaimKey!(
          s.ctx,
          CLAIM(date, new Date(date.getTime() - 1000)),
        ).then(
          (ms) =>
            names(
              s,
              ms.map((m) => m.id),
            ),
          (e: unknown) => ({ threw: describeThrown(e) }),
        );
      }
      expect(answers).toEqual({ postgres: [], "in-memory": [], fake: [] });
    });
  }
});

describe("下限より後の日時は寄せない（下限の直後の行を、その日時を境に比べる）", () => {
  const DAY_MS = 86_400_000;
  const AT = [
    ["m0", new Date(FLOOR_MS)],
    ["m1", new Date(FLOOR_MS + 1)],
    ["m2", new Date(FLOOR_MS + DAY_MS)],
  ] as const;

  async function seedNear(kit: Kit): Promise<Seeded> {
    const ctx = nextCtx();
    const idToName = new Map<string, string>();
    for (const [name, at] of AT) {
      const m = await kit.mem.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          content: `${name} hello`,
          contentHash: `h-${name}`,
          occurredAt: at,
          embeddingStatus: "ready",
          halfLifeHours: 1e6,
          decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
        }),
      );
      idToName.set(m.id, name);
      await kit.vec.upsert(ctx, TEST_EMBEDDING_SPACE, m.id, [1, 0, 0]);
      await kit.ev.append(ctx, {
        tenantId: ctx.tenantId,
        memoryId: null,
        kind: "created",
        at,
        actor: { type: "system" },
        digestSnapshot: null,
        sizeBeforeBytes: null,
        meta: {},
      });
    }
    return { ctx, idToName };
  }

  // 境界の日時（下限+1ms、下限+1日-1ms）と、その答え。since 系は境界以後、until 系は境界以前。
  const PROBES: Array<[string, Date, { after: string[]; before: string[] }]> = [
    ["下限+1ms", new Date(FLOOR_MS + 1), { after: ["m1", "m2"], before: ["m0", "m1"] }],
    ["下限+1日-1ms", new Date(FLOOR_MS + DAY_MS - 1), { after: ["m2"], before: ["m0", "m1"] }],
  ];

  for (const [label, date, want] of PROBES) {
    it(`${label}を境にした EventStore.list と VectorStore.search は、3実装とも寄せずに比べる`, async () => {
      const answers: Record<string, unknown> = {};
      for (const kit of await kits()) {
        const s = await seedNear(kit);
        answers[kit.name] = {
          eventsSince: (await kit.ev.list(s.ctx, { since: date })).length,
          eventsUntil: (await kit.ev.list(s.ctx, { until: date })).length,
          after: await vecSearch(kit, s, { occurredAfter: date }),
          before: await vecSearch(kit, s, { occurredBefore: date }),
        };
      }
      const expected = {
        eventsSince: want.after.length,
        eventsUntil: want.before.length,
        after: want.after,
        before: want.before,
      };
      expect(answers).toEqual({ postgres: expected, "in-memory": expected, fake: expected });
    });
  }
});

describe("purgeCompletedJobs: 下限以後の olderThan は、早い return をせず問い合わせる（Postgres）", () => {
  it("紀元1000年に完了した job は、olderThan が紀元1500年（下限より後）なら消える", async () => {
    const { db } = await getTestClient();
    const memory = new PostgresMemoryStore(db);
    const outbox = new PostgresOutboxStore(db);
    const ctx = nextCtx();
    await memory.createObservationWithOutbox(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
      ["extract"],
    );
    const [job] = await outbox.claimBatch(ctx, {
      limit: 5,
      now: new Date(Date.now() + 1000),
      claimedBy: "w",
      leaseMs: 60_000,
    });
    await outbox.complete(ctx, job!.id, job!.attempts, { at: new Date(Date.UTC(1000, 0, 1)) });
    const dry = await outbox.purgeCompletedJobs(ctx, {
      olderThan: new Date(Date.UTC(1500, 0, 1)),
      limit: 5,
      dryRun: true,
    });
    expect(dry.purged).toBe(1);
    const real = await outbox.purgeCompletedJobs(ctx, {
      olderThan: new Date(Date.UTC(1500, 0, 1)),
      limit: 5,
    });
    expect(real.purged).toBe(1);
  });
});
