import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE as SPACE,
} from "./test-db.js";

/**
 * testkit の fixture（InMemory）を、Postgres の振る舞いに揃えた項目を、**同じ入力を2実装へ流して**縛る。
 * ここは「Postgres がそう振る舞う」ことの実測を常設にする（fixture の側を揃えたあとで Postgres が変わったら、ここが落ちる）。
 *
 * 見るのは、投げたか・何で投げたか（`NUL`・`range`（`timestamptz` の範囲外）・`bigint`（範囲外）・その他）だけ。
 * 例外の文面・クラスは2実装で違う。
 */

const ctx: Ctx = { tenantId: "fixture-alignment" };
const NUL = "x\u0000y";
const FLOOR_MS = Date.UTC(-4713, 10, 24);
const EARLY = new Date(FLOOR_MS - 1);
const EDGE = new Date(FLOOR_MS);
const FAR = new Date(Date.UTC(-9000, 0, 1));
const BIG = 2 ** 63 - 1024;
const AT = new Date("2030-01-01T00:00:00Z");

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

type Outcome = "ok" | "NUL" | "range" | "bigint" | `other: ${string}`;

async function classify(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run();
    return "ok";
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const message = `${err.message} ${err.cause?.message ?? ""}`;
    const code = err.cause?.code;
    if (/must not contain NUL characters/.test(message)) return "NUL";
    if (code === "22008" || /must not be earlier than 4714-11-24 BC/.test(message)) return "range";
    if (code === "22003" || /must fit in a Postgres bigint/.test(message)) return "bigint";
    return `other: ${message.split("\n")[0]!.slice(0, 80)}`;
  }
}

async function build(impl: "postgres" | "fixture") {
  if (impl === "postgres") {
    const { db } = await getTestClient();
    return {
      mem: new PostgresMemoryStore(db),
      ev: new PostgresEventStore(db),
      vec: new PostgresVectorStore(db),
      lex: new PostgresLexicalStore(db),
      ob: new PostgresOutboxStore(db),
      setSubjectSeq: async (value: number) => {
        await db.execute(
          sql`INSERT INTO tenant_subject_activity(tenant_id, subject_id, activity_seq)
              VALUES (${ctx.tenantId}, 's', ${value}::bigint)
              ON CONFLICT (tenant_id, subject_id) DO UPDATE SET activity_seq = EXCLUDED.activity_seq`,
        );
      },
    };
  }
  const mem = new InMemoryMemoryStore();
  return {
    mem,
    ev: new InMemoryEventStore(mem, mem.events),
    vec: new InMemoryVectorStore(mem),
    lex: new InMemoryLexicalStore(mem),
    ob: new InMemoryOutboxStore(mem.outboxJobs),
    setSubjectSeq: async (value: number) => {
      mem.subjectActivitySeq.set(ctx.tenantId, new Map([["s", value]]));
    },
  };
}
type Stores = Awaited<ReturnType<typeof build>>;

/** 同じ入力を2実装へ流し、結果の種類が同じで、期待どおりであることを縛る。 */
async function both(expected: Outcome, run: (s: Stores) => Promise<unknown>) {
  const [pg, fx] = [
    await classify(() => build("postgres").then(run)),
    await classify(() => build("fixture").then(run)),
  ];
  expect({ postgres: pg, fixture: fx }).toEqual({ postgres: expected, fixture: expected });
}

const f = (extra: object) => ({ tenantId: ctx.tenantId, ...extra });
const claim = (
  subject: string,
  predicate: string,
  validFrom: Date | null = null,
  validUntil: Date | null = null,
) => ({
  subjectId: null,
  claimKey: { subject, predicate },
  excludeMemoryId: "00000000-0000-4000-8000-000000000000",
  contentHash: "h",
  validFrom,
  validUntil,
});

describe("NUL を含む読みの条件は、2実装とも名指しで断る", () => {
  it("findActiveByClaimKey・findContestedByClaimKey の claimKey", async () => {
    for (const m of ["findActiveByClaimKey", "findContestedByClaimKey"] as const) {
      await both("ok", (s) => s.mem[m]!(ctx, claim("s", "p")));
      await both("NUL", (s) => s.mem[m]!(ctx, claim(NUL, "p")));
      await both("NUL", (s) => s.mem[m]!(ctx, claim("s", NUL)));
    }
  });

  it("LexicalStore.search の labels", async () => {
    const run = (labels: string[]) => (s: Stores) =>
      s.lex.search(ctx, "hello", { limit: 3, filter: f({ labels }) });
    await both("ok", run(["x", "\\u0000", "好き"]));
    await both("NUL", run([NUL]));
    await both("NUL", run(["ok", NUL]));
  });

  it("VectorStore.search・searchMany の labels・attributes（searchMany は queries が空でも）", async () => {
    const search = (extra: object) => (s: Stores) =>
      s.vec.search(ctx, SPACE, [1, 0, 0], { limit: 3, filter: f(extra) });
    const many =
      (extra: object, queries = [{ key: "k", vector: [1, 0, 0] }]) =>
      (s: Stores) =>
        s.vec.searchMany(ctx, SPACE, queries, { limit: 3, filter: f(extra) });
    await both("ok", search({ labels: ["x"], attributes: { k: "v" } }));
    await both("NUL", search({ labels: [NUL] }));
    await both("NUL", search({ attributes: { k: NUL } }));
    await both("NUL", search({ attributes: { [NUL]: "v" } }));
    await both("NUL", many({ labels: [NUL] }));
    await both("NUL", many({ labels: [NUL] }, []));
    await both("NUL", many({ attributes: { k: NUL } }, []));
  });
});

describe("下限（4714-11-24 BC 00:00:00 UTC）より前の日時は、書く口では2実装とも断り、読みの口では断らない", () => {
  const cases: Array<[string, (d: Date) => (s: Stores) => Promise<unknown>]> = [
    ["EventStore.list since", (d) => (s) => s.ev.list(ctx, { since: d } as never)],
    ["EventStore.list until", (d) => (s) => s.ev.list(ctx, { until: d } as never)],
    ...["occurredAfter", "occurredBefore", "validAt", "decayFloorAtAfter"].flatMap(
      (k): Array<[string, (d: Date) => (s: Stores) => Promise<unknown>]> => [
        [
          `VectorStore.search ${k}`,
          (d) => (s) => s.vec.search(ctx, SPACE, [1, 0, 0], { limit: 3, filter: f({ [k]: d }) }),
        ],
        [
          `VectorStore.searchMany ${k}`,
          (d) => (s) =>
            s.vec.searchMany(ctx, SPACE, [{ key: "k", vector: [1, 0, 0] }], {
              limit: 3,
              filter: f({ [k]: d }),
            }),
        ],
        [`MemoryStore.aggregateScope ${k}`, (d) => (s) => s.mem.aggregateScope(ctx, { [k]: d })],
      ],
    ),
    ...["occurredAfter", "occurredBefore", "validAt"].map(
      (k): [string, (d: Date) => (s: Stores) => Promise<unknown>] => [
        `LexicalStore.search ${k}`,
        (d) => (s) => s.lex.search(ctx, "hello", { limit: 3, filter: f({ [k]: d }) }),
      ],
    ),
    [
      "OutboxStore.complete at",
      (d) => (s) => s.ob.complete(ctx, "00000000-0000-4000-8000-000000000000", 1, { at: d }),
    ],
    [
      "OutboxStore.fail at",
      (d) => (s) => s.ob.fail(ctx, "00000000-0000-4000-8000-000000000000", "e", 1, { at: d }),
    ],
    [
      "MemoryStore.requeueEmbedJobs now",
      (d) => (s) => s.mem.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 1 }, { now: d }),
    ],
    [
      "MemoryStore.archiveDecayed now",
      (d) => (s) => s.mem.archiveDecayed(ctx, { now: d, limit: 5, clock: "wall" }),
    ],
    [
      "findActiveByClaimKey validFrom",
      (d) => (s) => s.mem.findActiveByClaimKey!(ctx, claim("s", "p", d, null)),
    ],
    [
      "findActiveByClaimKey validUntil",
      (d) => (s) => s.mem.findActiveByClaimKey!(ctx, claim("s", "p", null, d)),
    ],
    [
      "findContestedByClaimKey validFrom",
      (d) => (s) => s.mem.findContestedByClaimKey!(ctx, claim("s", "p", d, null)),
    ],
    [
      "findContestedByClaimKey validUntil",
      (d) => (s) => s.mem.findContestedByClaimKey!(ctx, claim("s", "p", null, d)),
    ],
    [
      "createObservationWithOutbox now",
      (d) => (s) =>
        s.mem.createObservationWithOutbox(
          ctx,
          buildNewObservationFixture({ tenantId: ctx.tenantId }),
          ["embed"],
          { now: d },
        ),
    ],
    [
      "createMemoryWithOutbox now",
      (d) => (s) =>
        s.mem.createMemoryWithOutbox(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId }),
          ["embed"],
          { now: d },
        ),
    ],
    [
      "createMemoriesWithOutboxAndEvents now",
      (d) => (s) =>
        s.mem.createMemoriesWithOutboxAndEvents!(
          ctx,
          [{ input: buildNewMemoryFixture({ tenantId: ctx.tenantId }), jobKinds: ["embed"] }],
          (m) => ({
            tenantId: ctx.tenantId,
            memoryId: m.id,
            kind: "created",
            actor: { type: "system" },
            meta: {},
          }),
          { now: d },
        ),
    ],
    [
      "supersedeWithNewMemories now",
      (d) => (s) =>
        s.mem.supersedeWithNewMemories!(
          ctx,
          [{ input: buildNewMemoryFixture({ tenantId: ctx.tenantId }), jobKinds: ["embed"] }],
          [],
          { now: d },
        ),
    ],
  ];

  // 読みの口の条件は、Postgres が下限へ寄せてから比べる（落ちない）。fixture も断らない。書く口だけが、下限より前で断る。
  const READ_PORT =
    /^(EventStore\.list|VectorStore\.|MemoryStore\.aggregateScope|LexicalStore\.|find(Active|Contested)ByClaimKey)/;
  const readCases = cases.filter(([name]) => READ_PORT.test(name));
  const writeCases = cases.filter(([name]) => !READ_PORT.test(name));

  it.each(readCases)(
    "%s（読みの口）: 下限より前（1ms 前・紀元前9001年）でも、2実装とも断らない（ADR 0547）",
    async (_name, make) => {
      await both("ok", make(EARLY));
      await both("ok", make(FAR));
      await both("ok", make(EDGE));
    },
  );

  it.each(writeCases)(
    "%s（書く口）: 下限より前（1ms 前・紀元前9001年）は断り、下限ちょうどは日時の検査では落ちない",
    async (_name, make) => {
      await both("range", make(EARLY));
      await both("range", make(FAR));
      const edge = await Promise.all([
        classify(() => build("postgres").then(make(EDGE))),
        classify(() => build("fixture").then(make(EDGE))),
      ]);
      expect(edge).not.toContain("range");
    },
  );

  it("断らない口（purge 系の olderThan）は、下限より前でも2実装とも0件で返す", async () => {
    await both("ok", (s) => s.mem.purgeExpiredEvents!(ctx, { olderThan: EARLY, limit: 5 }));
    await both("ok", (s) => s.mem.purgeExpiredRecalls!(ctx, { olderThan: FAR, limit: 5 }));
    await both("ok", (s) => s.ob.purgeCompletedJobs!(ctx, { olderThan: EARLY, limit: 5 }));
  });

  it("jobKinds が空なら now を見ない（outbox へ INSERT しない）", async () => {
    await both("ok", (s) =>
      s.mem.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
        [],
        { now: EARLY },
      ),
    );
  });
});

describe("reinforce の addOwnSubjectSeq: nowSeq + S_x（と床）が bigint を溢れるなら、2実装とも断る", () => {
  const make = (s: Stores) =>
    s.mem.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        subjectId: "s",
        halfLifeRecalls: 100,
        decayBaseSeq: 0,
        decayFloorSeq: 5,
      }),
    );

  // この境界は、ドライバが nowSeq を文字にした値（"9223372036854775000"）と、床の offset（433）で決まる。
  it.each([
    [0, "ok"],
    [374, "ok"],
    [375, "bigint"],
    [807, "bigint"],
    [808, "bigint"],
    [5000, "bigint"],
  ] as const)("S_x = %i: %s", async (counter, expected) => {
    await both(expected, async (s) => {
      await s.setSubjectSeq(counter);
      const m = await make(s);
      return s.mem.reinforce(ctx, m.id, AT, { nowSeq: BIG, addOwnSubjectSeq: true });
    });
    await both(expected, async (s) => {
      await s.setSubjectSeq(counter);
      const m = await make(s);
      return s.mem.reinforceMany!(ctx, [m.id], AT, { nowSeq: BIG, addOwnSubjectSeq: true });
    });
  });

  it("addOwnSubjectSeq でなければ S_x を足さないので通る。何も書かない呼び出し（古い at）も通る", async () => {
    await both("ok", async (s) => {
      await s.setSubjectSeq(5000);
      const m = await make(s);
      return s.mem.reinforce(ctx, m.id, AT, { nowSeq: BIG, addOwnSubjectSeq: false });
    });
    await both("ok", async (s) => {
      const m = await make(s);
      await s.mem.reinforce(ctx, m.id, AT, { nowSeq: 0, addOwnSubjectSeq: false });
      await s.setSubjectSeq(5000);
      return s.mem.reinforce(ctx, m.id, new Date("2029-01-01T00:00:00Z"), {
        nowSeq: BIG,
        addOwnSubjectSeq: true,
      });
    });
  });
});

describe("TenantSettingsStore.setDefaultHalfLifeRecalls: float4 の読み戻しの形（core の Fake・testkit の InMemory と同じ表）", () => {
  it.each([
    [16777217, 16777216],
    [33554431, 33554432],
    [123456.789, 123456.79],
    [720.1, 720.1],
    [0.1, 0.1],
    [3e38, 3e38],
  ])("%s は %s として読める", async (written, readBack) => {
    const { db } = await getTestClient();
    const store = new PostgresTenantSettingsStore(db);
    await store.setDefaultHalfLifeRecalls(ctx, written);
    expect(await store.getDefaultHalfLifeRecalls(ctx)).toBe(readBack);
  });
});
