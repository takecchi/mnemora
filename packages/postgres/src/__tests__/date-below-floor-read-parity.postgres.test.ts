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
import { PostgresTrigramLexicalStore } from "../trigram-lexical-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  TEST_EMBEDDING_SPACE,
  closeTestClient,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

/**
 * ADR 0547: 読みの経路の日時が `timestamptz` の下限（4714-11-24 BC 00:00:00 UTC）より前でも、Postgres は
 * 生の `22008 timestamp out of range` で落ちず、下限に寄せてからいつもどおり比べる。InMemory（testkit）と Fake（core）は
 * 同じ入力に同じ答えを返す。3実装に**同じデータ・同じ入力**を流し、(1) 3者が一致すること、(2) 答えが「全件」か「0件」か
 * （`since` 系は全件、`until` 系は0件）という意味どおりであることを縛る。Fake は検査をせず意味どおりに答える（参照実装）。
 *
 * 書き込みの口（約35口）と Invalid Date（`22007`）は ADR 0547 の対象外で、ここでは見ない。
 * 下限ちょうどに行がある場合の食い違い（下限へ寄せることの限界）は ADR 0547 の「引き受けた負債」。この歯のデータは下限に行を置かない。
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
  /** Postgres の trigram 版（InMemory と Fake の答えに突き合わせる）。 */
  trigram?: LexicalStore;
  name: string;
}

let tenantSeq = 0;
const nextCtx = (): Ctx => ({ tenantId: `date-floor-${++tenantSeq}` });

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
      trigram: await PostgresTrigramLexicalStore.create(db),
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

/** 本文 → id（結果の id を本文に直して並べ替える）。 */
type Seeded = { ctx: Ctx; idToName: Map<string, string> };

/**
 * 同じ5件の記憶を入れる。いずれも `recordedAt` は 2026 年で、下限の近くには行を置かない。
 * - alpha: occurredAt 2026-03-01、有効期間なし
 * - bravo: occurredAt なし、validFrom 2026-01-01
 * - charlie: occurredAt 2026-02-01、validUntil 2030-01-01
 * - delta: claimKey (s, p)、active、validFrom 2026-01-01
 * - echo・foxtrot: claimKey (s, p)、contested のペア、validFrom 2026-01-01
 */
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
const ALL = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
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
  /** 下限より前の日時 `d` を渡したときの答え。 */
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
const VALID_AT_BELOW = ["alpha", "charlie"];

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
        // ステータス active の件数（echo は contested）。
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
      run: (k, s, d) => lexSearch(k.trigram ?? k.lex, s, { [field]: d }),
    },
  ]),
  // 空の区間は何とも重ならない。validFrom だけが下限より前なら、delta（validFrom 2026・validUntil なし）と重なる。
  {
    name: "findActiveByClaimKey validFrom のみ",
    expected: ["delta"],
    run: async (k, s, d) =>
      names(
        s,
        (await k.mem.findActiveByClaimKey!(s.ctx, CLAIM(d, null))).map((m) => m.id),
      ),
  },
  // validUntil だけが下限より前: delta の validFrom（2026）は validUntil より後なので重ならない。
  {
    name: "findActiveByClaimKey validUntil のみ",
    expected: [],
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
      // claimed_at は 2100 年、境界は下限へ寄る。claimed_at <= 境界 にはならないので、取り直せない。
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
