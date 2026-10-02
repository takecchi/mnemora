import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type {
  Ctx,
  EventStore,
  Memory,
  MemoryStore,
  NewRecallRecord,
  OutboxStore,
  TenantSettingsStore,
} from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
} from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0538（ADR 0536 の「次の候補」の2つ目）: 保持と掃除の口（`purgeExpiredEventsByRetention`・`purgeExpiredRecalls`・`purgeCompletedJobs`）を、
 * **実 Postgres と InMemory の両方**で `EXPECTED` に突き合わせる。core の Fake の側は `packages/core/src/__tests__/fake-retention-purge-parity.test.ts` が
 * 同じ `EXPECTED` を縛る。DB はファイル冒頭で作り直し、tenant はこのファイル専用の名前を使う。
 */
interface Env {
  mem: MemoryStore;
  ts: TenantSettingsStore;
  ev: EventStore;
  ob: OutboxStore;
  /** その tenant の outbox の行（kind・完了の時刻）。 */
  rows: (ctx: Ctx) => Promise<Array<{ done: boolean; completedAt: string | null }>>;
  /** 記憶を1件作り、`embed` のジョブを1本積む。 */
  mk: (ctx: Ctx, tag: string) => Promise<Memory>;
  fresh: () => Ctx;
}

type Result = Record<string, unknown>;

/**
 * ADR 0538（ADR 0536 の「次の候補」の2つ目）: 保持と掃除の口を3者（core の Fake・testkit の InMemory・Postgres）に同じ入力で流す。
 * `MemoryStore.purgeExpiredEventsByRetention`（テナントごとの保持の設定を読んで掃除）・`purgeExpiredRecalls`・`OutboxStore.purgeCompletedJobs`。
 * 見るのは、日時の境界（ちょうど・1ms 前後・ミリ秒の端数）、`limit` と `reachedLimit`、`dryRun`、`events_purged` の記録、保持の設定、
 * 別テナントに触れないこと、時刻の注入（`now`）。`scrubPurged`（Fake は実装しない任意メソッド）は、この歯の外（ADR 0538 の「scrubPurged の扱い」）。
 */
async function scenario(env: Env): Promise<Result> {
  const { mem, ts, ev, ob, rows, mk, fresh } = env;
  const out: Result = {};
  const D = (s: string) => new Date(s);
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const NOW = D("2026-06-01T00:00:00.000Z");
  const CUTOFF = D("2026-05-02T00:00:00.000Z"); // NOW - 30 日
  const eventAt = (n: number) => new Date(CUTOFF.getTime() + n);
  const result = (r: {
    purged: number;
    reachedLimit: boolean;
    oldestPurgedAt: Date | null;
    newestPurgedAt: Date | null;
    dryRun: boolean;
  }) => [r.purged, r.reachedLimit, iso(r.oldestPurgedAt), iso(r.newestPurgedAt), r.dryRun];
  const appendAt = async (ctx: Ctx, at: Date, tag: number) =>
    ev.append(ctx, {
      tenantId: ctx.tenantId,
      memoryId: null,
      kind: "updated",
      actor: { type: "system" },
      digestSnapshot: null,
      sizeBeforeBytes: null,
      meta: { tag },
      at,
    });
  const eventsOf = async (ctx: Ctx) =>
    (await ev.list(ctx, {})).map((e) =>
      e.kind === "events_purged"
        ? [
            e.kind,
            null,
            Object.fromEntries(Object.entries(e.meta).sort(([a], [b]) => a.localeCompare(b))),
          ] // 掃除の記録の `at` は実時刻（比べない）
        : [e.kind, iso(e.at), e.meta["tag"]],
    );

  // ---- purgeExpiredEventsByRetention ----
  {
    const ctx = fresh();
    // cutoff の前後（1ms・ミリ秒の端数）と、ちょうど。at は cutoff + n ms
    for (const [i, n] of [-1000, -1, 0, 1, 999, 1000].entries()) await appendAt(ctx, eventAt(n), i);
    out["retention: no setting"] = [
      await mem.purgeExpiredEventsByRetention!(ctx, { now: NOW, limit: 100 }),
      (await eventsOf(ctx)).length,
    ];
    await ts.setEventRetention(ctx, { kind: "unlimited" });
    out["retention: unlimited"] = [
      await mem.purgeExpiredEventsByRetention!(ctx, { now: NOW, limit: 100 }),
      (await eventsOf(ctx)).length,
    ];
    await ts.setEventRetention(ctx, { kind: "days", days: 30 });
    const dry = await mem.purgeExpiredEventsByRetention!(ctx, {
      now: NOW,
      limit: 100,
      dryRun: true,
    });
    out["retention: 30 days, dryRun"] = [
      dry.kind,
      dry.kind === "executed" ? result(dry.result) : null,
      (await eventsOf(ctx)).length,
    ];
    const first = await mem.purgeExpiredEventsByRetention!(ctx, { now: NOW, limit: 1 });
    out["retention: 30 days, limit 1 (the oldest goes first)"] = [
      first.kind,
      first.kind === "executed" ? result(first.result) : null,
      await eventsOf(ctx),
    ];
    const rest = await mem.purgeExpiredEventsByRetention!(ctx, { now: NOW, limit: 100 });
    out["retention: 30 days, the rest (strictly older than the cutoff)"] = [
      rest.kind,
      rest.kind === "executed" ? result(rest.result) : null,
      await eventsOf(ctx),
    ];
    const again = await mem.purgeExpiredEventsByRetention!(ctx, { now: NOW, limit: 100 });
    out["retention: nothing left"] = [
      again.kind,
      again.kind === "executed" ? result(again.result) : null,
    ];
    // now を進めると cutoff も進む（注入した時刻で決まる）
    const later = await mem.purgeExpiredEventsByRetention!(ctx, {
      now: new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 31),
      limit: 100,
    });
    out["retention: injected later now moves the cutoff"] = [
      later.kind,
      later.kind === "executed" ? result(later.result) : null,
      await eventsOf(ctx),
    ];
  }
  {
    // テナントごとの保持: 別のテナントには触れない。保持を変えると次の掃除が変わる
    const a = fresh();
    const b = fresh();
    for (const c of [a, b])
      for (const n of [-86_400_000, 0, 86_400_000]) await appendAt(c, eventAt(n), 1);
    await ts.setEventRetention(a, { kind: "days", days: 30 });
    await ts.setEventRetention(b, { kind: "days", days: 31 });
    const ra = await mem.purgeExpiredEventsByRetention!(a, { now: NOW, limit: 100 });
    out["retention: tenants differ"] = [
      ra.kind === "executed" ? result(ra.result) : null,
      (await eventsOf(a)).length,
      (await eventsOf(b)).length,
    ];
    await ts.setEventRetention(b, { kind: "days", days: 29 });
    const rb = await mem.purgeExpiredEventsByRetention!(b, { now: NOW, limit: 100 });
    out["retention: shortening the setting purges more next time"] = [
      rb.kind === "executed" ? result(rb.result) : null,
      (await eventsOf(b)).map((e) => e[0]),
    ];
  }
  {
    // 日数が大きいときは、表せる最も古い時刻へ寄せる（何も消さず、例外にもしない）
    const ctx = fresh();
    await appendAt(ctx, eventAt(-1), 1);
    await ts.setEventRetention(ctx, { kind: "days", days: 2_000_000_000 });
    const r = await mem.purgeExpiredEventsByRetention!(ctx, { now: NOW, limit: 100 });
    out["retention: huge days clamp to the earliest representable time"] = [
      r.kind,
      r.kind === "executed" ? result(r.result) : null,
    ];
  }

  // ---- purgeExpiredRecalls ----
  {
    const ctx = fresh();
    const other = fresh();
    const memory = await mk(ctx, "recall-usage");
    const rec = (c: Ctx, at: Date): NewRecallRecord => ({
      tenantId: c.tenantId,
      query: { text: "q" },
      omitted: [],
      usage: {} as NewRecallRecord["usage"],
      indexBand: {} as NewRecallRecord["indexBand"],
      explain: { stages: [] },
      returnedMemories: [],
      createdAt: at,
    });
    const T = D("2026-03-01T00:00:00.000Z");
    const ids: string[] = [];
    for (const n of [-1000, -1, 0, 1, 1000]) {
      const id = await mem.createRecall(ctx, rec(ctx, new Date(T.getTime() + n)));
      ids.push(id);
      await mem.recordUsage(ctx, id, [memory.id]); // 使用の行（purgedUsages に数える）
    }
    await mem.createRecall(other, rec(other, new Date(T.getTime() - 5000)));
    const exists = async () =>
      Promise.all(ids.map(async (id) => (await mem.getRecall(ctx, id)) !== null));
    const dry = await mem.purgeExpiredRecalls!(ctx, { olderThan: T, limit: 100, dryRun: true });
    out["recalls: dryRun counts strictly older than olderThan, deletes nothing"] = [
      [
        dry.purged,
        dry.purgedUsages,
        dry.reachedLimit,
        iso(dry.oldestPurgedAt),
        iso(dry.newestPurgedAt),
        dry.dryRun,
      ],
      await exists(),
    ];
    const lim = await mem.purgeExpiredRecalls!(ctx, { olderThan: T, limit: 1 });
    out["recalls: limit 1 reaches the limit (oldest first)"] = [
      [
        lim.purged,
        lim.purgedUsages,
        lim.reachedLimit,
        iso(lim.oldestPurgedAt),
        iso(lim.newestPurgedAt),
      ],
      await exists(),
    ];
    const all = await mem.purgeExpiredRecalls!(ctx, { olderThan: T, limit: 100 });
    out["recalls: the rest; the one exactly at olderThan and the later ones stay"] = [
      [
        all.purged,
        all.purgedUsages,
        all.reachedLimit,
        iso(all.oldestPurgedAt),
        iso(all.newestPurgedAt),
      ],
      await exists(),
    ];
    const none = await mem.purgeExpiredRecalls!(ctx, { olderThan: T, limit: 100 });
    out["recalls: nothing older is left"] = [
      none.purged,
      none.purgedUsages,
      none.reachedLimit,
      iso(none.oldestPurgedAt),
      iso(none.newestPurgedAt),
    ];
    const edge = await mem.purgeExpiredRecalls!(ctx, {
      olderThan: new Date(T.getTime() + 1),
      limit: 100,
    });
    out["recalls: olderThan 1ms later takes the one exactly at T"] = [
      edge.purged,
      edge.purgedUsages,
      await exists(),
    ];
    const o = await mem.purgeExpiredRecalls!(other, { olderThan: T, limit: 100 });
    out["recalls: another tenant is purged only by its own call"] = [o.purged, o.purgedUsages];
  }

  // ---- OutboxStore.purgeCompletedJobs ----
  {
    const ctx = fresh();
    const other = fresh();
    const T = D("2026-03-01T00:00:00.000Z");
    const make = async (c: Ctx, tag: string) => (await mk(c, tag)).id;
    for (const c of [ctx, other]) for (let i = 0; i < 6; i += 1) await make(c, `job-${i}`);
    const claimAll = async (c: Ctx) =>
      ob.claimBatch(c, {
        limit: 100,
        now: new Date(Date.now() + 1000),
        claimedBy: "w",
        leaseMs: 60_000,
      });
    const claimed = await claimAll(ctx);
    // 5本を、T の前後（1ms・ちょうど）で完了させる。1本は claim したまま（完了しない）
    const offsets = [-1000, -1, 0, 1, 1000];
    for (const [i, j] of claimed.slice(0, 5).entries())
      await ob.complete(ctx, j.id, j.attempts, { at: new Date(T.getTime() + offsets[i]!) });
    const otherClaimed = await claimAll(other);
    for (const j of otherClaimed)
      await ob.complete(other, j.id, j.attempts, { at: new Date(T.getTime() - 5000) });
    const state = async () =>
      (await rows(ctx))
        .map((r) => [r.done, r.completedAt])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const r = (x: {
      purged: number;
      reachedLimit: boolean;
      oldestPurgedAt: Date | null;
      newestPurgedAt: Date | null;
      dryRun: boolean;
    }) => result(x);
    out["jobs: dryRun counts the completed ones strictly older than olderThan"] = [
      r(await ob.purgeCompletedJobs!(ctx, { olderThan: T, limit: 100, dryRun: true })),
      await state(),
    ];
    out["jobs: limit 1 (the oldest completed first)"] = [
      r(await ob.purgeCompletedJobs!(ctx, { olderThan: T, limit: 1 })),
      await state(),
    ];
    out["jobs: the rest; exactly at olderThan, later and unfinished ones stay"] = [
      r(await ob.purgeCompletedJobs!(ctx, { olderThan: T, limit: 100 })),
      await state(),
    ];
    out["jobs: olderThan 1ms later takes the one exactly at T"] = [
      r(await ob.purgeCompletedJobs!(ctx, { olderThan: new Date(T.getTime() + 1), limit: 100 })),
      await state(),
    ];
    out["jobs: another tenant keeps its completed jobs until its own call"] = [
      (await rows(other)).length,
      r(await ob.purgeCompletedJobs!(other, { olderThan: T, limit: 100 })),
      (await rows(other)).length,
    ];
  }
  return out;
}

const EXPECTED: Result = {
  "retention: no setting": [
    {
      kind: "unset",
    },
    6,
  ],
  "retention: unlimited": [
    {
      kind: "unlimited",
    },
    6,
  ],
  "retention: 30 days, dryRun": [
    "executed",
    [2, false, "2026-05-01T23:59:59.000Z", "2026-05-01T23:59:59.999Z", true],
    6,
  ],
  "retention: 30 days, limit 1 (the oldest goes first)": [
    "executed",
    [1, true, "2026-05-01T23:59:59.000Z", "2026-05-01T23:59:59.000Z", false],
    [
      ["updated", "2026-05-01T23:59:59.999Z", 1],
      ["updated", "2026-05-02T00:00:00.000Z", 2],
      ["updated", "2026-05-02T00:00:00.001Z", 3],
      ["updated", "2026-05-02T00:00:00.999Z", 4],
      ["updated", "2026-05-02T00:00:01.000Z", 5],
      [
        "events_purged",
        null,
        {
          newestPurgedAt: "2026-05-01T23:59:59.000Z",
          olderThan: "2026-05-02T00:00:00.000Z",
          oldestPurgedAt: "2026-05-01T23:59:59.000Z",
          purgedCount: 1,
        },
      ],
    ],
  ],
  "retention: 30 days, the rest (strictly older than the cutoff)": [
    "executed",
    [1, false, "2026-05-01T23:59:59.999Z", "2026-05-01T23:59:59.999Z", false],
    [
      ["updated", "2026-05-02T00:00:00.000Z", 2],
      ["updated", "2026-05-02T00:00:00.001Z", 3],
      ["updated", "2026-05-02T00:00:00.999Z", 4],
      ["updated", "2026-05-02T00:00:01.000Z", 5],
      [
        "events_purged",
        null,
        {
          newestPurgedAt: "2026-05-01T23:59:59.000Z",
          olderThan: "2026-05-02T00:00:00.000Z",
          oldestPurgedAt: "2026-05-01T23:59:59.000Z",
          purgedCount: 1,
        },
      ],
      [
        "events_purged",
        null,
        {
          newestPurgedAt: "2026-05-01T23:59:59.999Z",
          olderThan: "2026-05-02T00:00:00.000Z",
          oldestPurgedAt: "2026-05-01T23:59:59.999Z",
          purgedCount: 1,
        },
      ],
    ],
  ],
  "retention: nothing left": ["executed", [0, false, null, null, false]],
  "retention: injected later now moves the cutoff": [
    "executed",
    [4, false, "2026-05-02T00:00:00.000Z", "2026-05-02T00:00:01.000Z", false],
    [
      [
        "events_purged",
        null,
        {
          newestPurgedAt: "2026-05-01T23:59:59.000Z",
          olderThan: "2026-05-02T00:00:00.000Z",
          oldestPurgedAt: "2026-05-01T23:59:59.000Z",
          purgedCount: 1,
        },
      ],
      [
        "events_purged",
        null,
        {
          newestPurgedAt: "2026-05-01T23:59:59.999Z",
          olderThan: "2026-05-02T00:00:00.000Z",
          oldestPurgedAt: "2026-05-01T23:59:59.999Z",
          purgedCount: 1,
        },
      ],
      [
        "events_purged",
        null,
        {
          newestPurgedAt: "2026-05-02T00:00:01.000Z",
          olderThan: "2026-06-02T00:00:00.000Z",
          oldestPurgedAt: "2026-05-02T00:00:00.000Z",
          purgedCount: 4,
        },
      ],
    ],
  ],
  "retention: tenants differ": [
    [1, false, "2026-05-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z", false],
    3,
    3,
  ],
  "retention: shortening the setting purges more next time": [
    [2, false, "2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z", false],
    ["updated", "events_purged"],
  ],
  "retention: huge days clamp to the earliest representable time": [
    "executed",
    [0, false, null, null, false],
  ],
  "recalls: dryRun counts strictly older than olderThan, deletes nothing": [
    [2, 2, false, "2026-02-28T23:59:59.000Z", "2026-02-28T23:59:59.999Z", true],
    [true, true, true, true, true],
  ],
  "recalls: limit 1 reaches the limit (oldest first)": [
    [1, 1, true, "2026-02-28T23:59:59.000Z", "2026-02-28T23:59:59.000Z"],
    [false, true, true, true, true],
  ],
  "recalls: the rest; the one exactly at olderThan and the later ones stay": [
    [1, 1, false, "2026-02-28T23:59:59.999Z", "2026-02-28T23:59:59.999Z"],
    [false, false, true, true, true],
  ],
  "recalls: nothing older is left": [0, 0, false, null, null],
  "recalls: olderThan 1ms later takes the one exactly at T": [
    1,
    1,
    [false, false, false, true, true],
  ],
  "recalls: another tenant is purged only by its own call": [1, 0],
  "jobs: dryRun counts the completed ones strictly older than olderThan": [
    [2, false, "2026-02-28T23:59:59.000Z", "2026-02-28T23:59:59.999Z", true],
    [
      [false, null],
      [true, "2026-02-28T23:59:59.000Z"],
      [true, "2026-02-28T23:59:59.999Z"],
      [true, "2026-03-01T00:00:00.000Z"],
      [true, "2026-03-01T00:00:00.001Z"],
      [true, "2026-03-01T00:00:01.000Z"],
    ],
  ],
  "jobs: limit 1 (the oldest completed first)": [
    [1, true, "2026-02-28T23:59:59.000Z", "2026-02-28T23:59:59.000Z", false],
    [
      [false, null],
      [true, "2026-02-28T23:59:59.999Z"],
      [true, "2026-03-01T00:00:00.000Z"],
      [true, "2026-03-01T00:00:00.001Z"],
      [true, "2026-03-01T00:00:01.000Z"],
    ],
  ],
  "jobs: the rest; exactly at olderThan, later and unfinished ones stay": [
    [1, false, "2026-02-28T23:59:59.999Z", "2026-02-28T23:59:59.999Z", false],
    [
      [false, null],
      [true, "2026-03-01T00:00:00.000Z"],
      [true, "2026-03-01T00:00:00.001Z"],
      [true, "2026-03-01T00:00:01.000Z"],
    ],
  ],
  "jobs: olderThan 1ms later takes the one exactly at T": [
    [1, false, "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", false],
    [
      [false, null],
      [true, "2026-03-01T00:00:00.001Z"],
      [true, "2026-03-01T00:00:01.000Z"],
    ],
  ],
  "jobs: another tenant keeps its completed jobs until its own call": [
    6,
    [6, false, "2026-02-28T23:59:55.000Z", "2026-02-28T23:59:55.000Z", false],
    0,
  ],
};

afterAll(async () => {
  await closeTestClient();
});

let hashCounter = 0;
function memoryFixture(ctx: Ctx, tag: string) {
  hashCounter += 1;
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `retention-${hashCounter}-${tag}`,
    content: tag,
    digest: tag,
    embeddingStatus: "pending",
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    decayFloorAt: new Date("2035-01-01T00:00:00.000Z"),
  });
}

describe("保持と掃除の口（InMemory・Postgres）", () => {
  it("InMemory は Postgres で実測した結果（EXPECTED）と一致する", async () => {
    const m = new InMemoryMemoryStore();
    let n = 0;
    const out = await scenario({
      mem: m,
      ts: new InMemoryTenantSettingsStore(
        m.activitySeq,
        m.subjectActivitySeq,
        m.eventRetentionDays,
      ),
      ev: new InMemoryEventStore(m, m.events),
      ob: new InMemoryOutboxStore(m.outboxJobs),
      fresh: () => ({ tenantId: `retention-inmem-${(n += 1)}` }),
      mk: async (ctx, tag): Promise<Memory> =>
        (await m.createMemoryWithOutbox(ctx, memoryFixture(ctx, tag), ["embed"])).memory,
      rows: async (ctx) =>
        m.outboxJobs
          .filter((j) => j.tenantId === ctx.tenantId)
          .map((j) => ({
            done: j.completedAt != null,
            completedAt: j.completedAt ? j.completedAt.toISOString() : null,
          })),
    });
    expect(out).toEqual(EXPECTED);
  });

  it("Postgres は EXPECTED と一致する", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const mem = new PostgresMemoryStore(db);
    let n = 0;
    const out = await scenario({
      mem: mem as MemoryStore,
      ts: new PostgresTenantSettingsStore(db) as TenantSettingsStore,
      ev: new PostgresEventStore(db) as EventStore,
      ob: new PostgresOutboxStore(db) as OutboxStore,
      fresh: () => ({ tenantId: `retention-pg-${(n += 1)}` }),
      mk: async (ctx, tag): Promise<Memory> =>
        (await mem.createMemoryWithOutbox(ctx, memoryFixture(ctx, tag), ["embed"])).memory,
      rows: async (ctx) => {
        const r = await db.execute(sql`
          SELECT completed_at IS NOT NULL AS done,
                 to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "completedAt"
          FROM outbox WHERE tenant_id = ${ctx.tenantId}
        `);
        return r.rows as Array<{ done: boolean; completedAt: string | null }>;
      },
    });
    expect(out).toEqual(EXPECTED);
  });
});
