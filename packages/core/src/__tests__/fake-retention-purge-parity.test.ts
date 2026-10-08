import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import { isMalformedIdentifierError } from "../identifier.js";
import type { EventStore } from "../interfaces/event-store.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { OutboxStore } from "../interfaces/outbox-store.js";
import type { TenantSettingsStore } from "../interfaces/tenant-settings-store.js";
import type { Memory, NewMemory } from "../memory.js";
import type { NewRecallRecord } from "../recall.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

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
  /** 記憶を、`NewMemory` の欄を上書きして1件作る（`createMemory`）。 */
  mkWith: (ctx: Ctx, tag: string, over: Partial<NewMemory>) => Promise<Memory>;
  /** その行の `purgedAt` を立てる。公開の口では作れない v1.0.x の残骸を、実装ごとの内部の口で作る。 */
  markPurgedAt: (ctx: Ctx, id: string) => Promise<void>;
  /** その label の `proposedCount` を直に書き換える（数え間違いの状態を作る）。 */
  setProposedCount: (ctx: Ctx, name: string, count: number) => Promise<void>;
}

type Result = Record<string, unknown>;

/** 保持と掃除の口（と `scrubPurged`）を、同じ入力で流して平らなデータにする。同じ `EXPECTED` を実 Postgres と InMemory の側も縛る。 */
async function scenario(env: Env): Promise<Result> {
  const { mem, ts, ev, ob, rows, mk, fresh, mkWith, markPurgedAt, setProposedCount } = env;
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

  {
    const ctx = fresh();
    for (const [i, n] of [-1000, -1, 0, 1, 999, 1000].entries()) await appendAt(ctx, eventAt(n), i);
    await ev.append(ctx, {
      tenantId: ctx.tenantId,
      memoryId: null,
      kind: "events_purged",
      actor: { type: "system" },
      digestSnapshot: null,
      sizeBeforeBytes: null,
      meta: { purgedCount: 0, oldestPurgedAt: null, newestPurgedAt: null, olderThan: "old record" },
      at: eventAt(-2000),
    });
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
    const ctx = fresh();
    await appendAt(ctx, eventAt(-1), 1);
    await ts.setEventRetention(ctx, { kind: "days", days: 2_000_000_000 });
    const r = await mem.purgeExpiredEventsByRetention!(ctx, { now: NOW, limit: 100 });
    out["retention: huge days clamp to the earliest representable time"] = [
      r.kind,
      r.kind === "executed" ? result(r.result) : null,
    ];
  }

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

  {
    // v1.0.x の purge が残した状態は公開の口では作れない。`markPurgedAt` / `setProposedCount` は、実装ごとの内部の口（Fake・InMemory は内部の Map、Postgres は SQL）で作る。
    const ctx = fresh();
    const other = fresh();
    const GHOST = "00000000-0000-4000-8000-000000000000";
    const residue = {
      attributes: { owner: "alice" },
      claimKey: { subject: "user", predicate: "home_city" },
    };
    const legacy = async (c: Ctx, tag: string, over: Partial<NewMemory>) => {
      const m = await mkWith(c, tag, { status: "forgotten", digest: "[purged]", ...over });
      await markPurgedAt(c, m.id);
      return m;
    };
    const purged = await legacy(ctx, "scrub-purged", { ...residue, tags: ["shared", "own"] });
    const purgedB = await legacy(ctx, "scrub-purged-b", { tags: ["shared"] });
    const clean = await legacy(ctx, "scrub-clean", {});
    const notPassed = await legacy(ctx, "scrub-not-passed", { ...residue, tags: ["shared"] });
    const regLegacy = await legacy(ctx, "scrub-reg-legacy", { tags: ["reg"] });
    const floor = await legacy(ctx, "scrub-floor", { tags: ["floor"] });
    const unpurged = await mkWith(ctx, "scrub-unpurged", {
      status: "forgotten",
      ...residue,
      tags: ["shared", "unpurged-only"],
    });
    const activePurgedAt = await mkWith(ctx, "scrub-active", { ...residue, tags: ["shared"] });
    await markPurgedAt(ctx, activePurgedAt.id);
    await mkWith(ctx, "scrub-reg-keep", { tags: ["reg"] });
    await mem.registerLabel!(ctx, "reg");
    const foreign = await legacy(other, "scrub-foreign", { ...residue, tags: ["shared"] });
    await setProposedCount(ctx, "floor", 0);

    const rowsOf: Array<[string, Ctx, Memory]> = [
      ["purged", ctx, purged],
      ["purgedB", ctx, purgedB],
      ["clean", ctx, clean],
      ["notPassed", ctx, notPassed],
      ["regLegacy", ctx, regLegacy],
      ["floor", ctx, floor],
      ["unpurged", ctx, unpurged],
      ["activePurgedAt", ctx, activePurgedAt],
      ["foreign", other, foreign],
    ];
    const read = async (c: Ctx, m: Memory) => (await mem.get(c, m.id))!;
    const shape = async () =>
      Object.fromEntries(
        await Promise.all(
          rowsOf.map(async ([name, c, m]) => {
            const g = await read(c, m);
            return [
              name,
              [
                g.status,
                g.content,
                g.digest,
                g.tags,
                g.attributes,
                g.claimKey ?? null,
                iso(g.purgedAt ?? null),
              ],
            ] as const;
          }),
        ),
      );
    const stamps = async () =>
      Object.fromEntries(
        await Promise.all(
          rowsOf.map(async ([name, c, m]) => [name, iso((await read(c, m)).updatedAt)] as const),
        ),
      );
    const labelsOf = async (c: Ctx) =>
      (await mem.listLabels!(c))
        .map((l) => [l.name, l.status, l.proposedCount])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const moved = (before: Record<string, string | null>, after: Record<string, string | null>) =>
      Object.fromEntries(Object.keys(before).map((k) => [k, before[k] !== after[k]]));

    const labelsBefore = [await labelsOf(ctx), await labelsOf(other)];
    const stampsBefore = await stamps();
    const eventsBefore = [(await ev.list(ctx, {})).length, (await ev.list(other, {})).length];
    await new Promise((r) => setTimeout(r, 5)); // updatedAt が動いたかを、時計の分解能に埋もれさせない
    const returned = await mem.scrubPurged!(ctx, [
      purged.id,
      purgedB.id,
      clean.id,
      regLegacy.id,
      floor.id,
      unpurged.id,
      activePurgedAt.id,
      foreign.id,
      GHOST,
      "not-a-uuid",
    ]);
    const stampsAfter = await stamps();
    out[
      "scrubPurged: only forgotten rows with purgedAt lose tags, attributes, claimKey and label links"
    ] = [
      returned === undefined,
      await shape(),
      moved(stampsBefore, stampsAfter),
      [(await ev.list(ctx, {})).length, (await ev.list(other, {})).length].join() ===
        eventsBefore.join(),
    ];
    out["scrubPurged: proposedCount drops by the links removed, registered and the floor stay"] = [
      labelsBefore,
      [await labelsOf(ctx), await labelsOf(other)],
    ];
    const labelsAfter = [await labelsOf(ctx), await labelsOf(other)];
    const shapeAfter = await shape();
    await mem.scrubPurged!(ctx, [purged.id, purgedB.id, regLegacy.id, floor.id]);
    await mem.scrubPurged!(ctx, []);
    out[
      "scrubPurged: idempotent, an empty list does nothing, rows with no residue keep updatedAt"
    ] = [
      JSON.stringify([await labelsOf(ctx), await labelsOf(other)]) === JSON.stringify(labelsAfter),
      JSON.stringify(await shape()) === JSON.stringify(shapeAfter),
      JSON.stringify(await stamps()) === JSON.stringify(stampsAfter),
    ];
    const badCtx = await mem.scrubPurged!({ tenantId: "bad\u0000tenant" }, [purged.id]).then(
      () => "resolved",
      (error: unknown) =>
        isMalformedIdentifierError(error) ? "MalformedIdentifierError" : "other",
    );
    out["scrubPurged: a malformed ctx is refused with MalformedIdentifierError"] = badCtx;
  }
  {
    const ctx = fresh();
    const other = fresh();
    const purged = await mkWith(ctx, "band-purged", {
      status: "forgotten",
      digest: "[purged]",
    });
    await markPurgedAt(ctx, purged.id);
    const notPassed = await mkWith(ctx, "band-not-passed", {
      status: "forgotten",
      digest: "[purged]",
    });
    await markPurgedAt(ctx, notPassed.id);
    const unpurged = await mkWith(ctx, "band-unpurged", { status: "forgotten", digest: "未purge" });
    const live = await mkWith(ctx, "band-live", { digest: "生きている" });
    const names = new Map([
      [purged.id, "purged"],
      [notPassed.id, "notPassed"],
      [unpurged.id, "unpurged"],
      [live.id, "live"],
    ]);
    const recallOf = (
      c: Ctx,
      digestBand: NonNullable<NewRecallRecord["indexBand"]["digestBand"]>,
    ): NewRecallRecord => ({
      tenantId: c.tenantId,
      subjectId: "s",
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
      indexBand: { groups: [], totalInScope: 0, countKind: "exact", digestBand },
      explain: { stages: [] },
      returnedMemories: [],
    });
    const band = [
      { memoryId: purged.id, digest: "秘密", truncated: true },
      { memoryId: notPassed.id, digest: "秘密2" },
      { memoryId: unpurged.id, digest: "未purge" },
      { memoryId: live.id, digest: "生きている" },
    ];
    const mine = await mem.createRecall(ctx, recallOf(ctx, band));
    const plain = await mem.createRecall(
      ctx,
      recallOf(ctx, [{ memoryId: purged.id, digest: "別の秘密" }]),
    );
    const theirs = await mem.createRecall(other, recallOf(other, band));
    const bandOf = async (c: Ctx, id: string) =>
      ((await mem.getRecall(c, id))?.indexBand.digestBand ?? []).map((e) => [
        names.get(e.memoryId),
        e.digest,
        "truncated" in e ? e.truncated : "absent",
      ]);
    const rest = async () => {
      const r = (await mem.getRecall(ctx, mine))!;
      return JSON.stringify([r.query, r.explain, r.indexBand.groups, r.indexBand.totalInScope]);
    };
    const restBefore = await rest();
    const memoryBefore = await mem.get(ctx, purged.id);
    await mem.scrubPurged!(ctx, [purged.id, unpurged.id, live.id]);
    const memoryAfter = await mem.get(ctx, purged.id);
    out[
      "scrubPurged: the digest band hides only the passed purged rows, drops truncated, leaves other entries, rows and tenants"
    ] = [
      await bandOf(ctx, mine),
      await bandOf(ctx, plain),
      await bandOf(other, theirs),
      (await rest()) === restBefore,
      [
        memoryAfter?.content,
        memoryAfter?.digest,
        iso(memoryAfter?.purgedAt ?? null),
        memoryAfter?.status,
      ].join() ===
        [
          memoryBefore?.content,
          memoryBefore?.digest,
          iso(memoryBefore?.purgedAt ?? null),
          memoryBefore?.status,
        ].join(),
    ];
    await mem.scrubPurged!(ctx, [purged.id]);
    out["scrubPurged: running it again leaves the band as it was"] = await bandOf(ctx, mine);
  }
  {
    // 残骸が一部の欄だけの行、大文字で渡した id、`[purged]` 以外のトゥームストーン、渡されたが未 purge の行の目次帯
    const ctx = fresh();
    const tomb = async (tag: string, digest: string, over: Partial<NewMemory>) => {
      const m = await mkWith(ctx, tag, { status: "forgotten", digest, ...over });
      await markPurgedAt(ctx, m.id);
      return m;
    };
    const attrOnly = await tomb("partial-attr", "墓標A", { attributes: { owner: "alice" } });
    const claimOnly = await tomb("partial-claim", "墓標C", {
      claimKey: { subject: "user", predicate: "home_city" },
    });
    const upper = await tomb("partial-upper", "墓標U", { tags: ["upper"] });
    const unpurged = await mkWith(ctx, "partial-unpurged", {
      status: "forgotten",
      digest: "未purgeの行",
    });
    const names = new Map([
      [attrOnly.id, "attrOnly"],
      [upper.id, "upper"],
      [unpurged.id, "unpurged"],
    ]);
    const recall = await mem.createRecall(ctx, {
      tenantId: ctx.tenantId,
      subjectId: "s",
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
      indexBand: {
        groups: [],
        totalInScope: 0,
        countKind: "exact",
        digestBand: [
          { memoryId: attrOnly.id, digest: "古い要旨A", truncated: true },
          { memoryId: upper.id, digest: "古い要旨U" },
          { memoryId: unpurged.id, digest: "古い要旨N" },
        ],
      },
      explain: { stages: [] },
      returnedMemories: [],
    });
    await mem.scrubPurged!(ctx, [attrOnly.id, claimOnly.id, upper.id.toUpperCase(), unpurged.id]);
    const residue = async (m: Memory) => {
      const g = (await mem.get(ctx, m.id))!;
      return [g.tags, g.attributes, g.claimKey ?? null];
    };
    out[
      "scrubPurged: a row whose only residue is attributes, claimKey or tags (passed in upper case) is scrubbed"
    ] = [
      await residue(attrOnly),
      await residue(claimOnly),
      await residue(upper),
      (await mem.listLabels!(ctx)).map((l) => [l.name, l.status, l.proposedCount]),
    ];
    out[
      "scrubPurged: the band takes each purged row's own digest, and a passed row that is not purged keeps its entry"
    ] = ((await mem.getRecall(ctx, recall))?.indexBand.digestBand ?? []).map((e) => [
      names.get(e.memoryId),
      e.digest,
      "truncated" in e ? e.truncated : "absent",
    ]);
  }
  return out;
}
const EXPECTED: Result = {
  "retention: no setting": [
    {
      kind: "unset",
    },
    7,
  ],
  "retention: unlimited": [
    {
      kind: "unlimited",
    },
    7,
  ],
  "retention: 30 days, dryRun": [
    "executed",
    [2, false, "2026-05-01T23:59:59.000Z", "2026-05-01T23:59:59.999Z", true],
    7,
  ],
  "retention: 30 days, limit 1 (the oldest goes first)": [
    "executed",
    [1, true, "2026-05-01T23:59:59.000Z", "2026-05-01T23:59:59.000Z", false],
    [
      [
        "events_purged",
        null,
        {
          newestPurgedAt: null,
          olderThan: "old record",
          oldestPurgedAt: null,
          purgedCount: 0,
        },
      ],
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
      [
        "events_purged",
        null,
        {
          newestPurgedAt: null,
          olderThan: "old record",
          oldestPurgedAt: null,
          purgedCount: 0,
        },
      ],
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
          newestPurgedAt: null,
          olderThan: "old record",
          oldestPurgedAt: null,
          purgedCount: 0,
        },
      ],
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
  "scrubPurged: only forgotten rows with purgedAt lose tags, attributes, claimKey and label links":
    [
      true,
      {
        purged: ["forgotten", "scrub-purged", "[purged]", [], {}, null, "2026-02-01T00:00:00.000Z"],
        purgedB: [
          "forgotten",
          "scrub-purged-b",
          "[purged]",
          [],
          {},
          null,
          "2026-02-01T00:00:00.000Z",
        ],
        clean: ["forgotten", "scrub-clean", "[purged]", [], {}, null, "2026-02-01T00:00:00.000Z"],
        notPassed: [
          "forgotten",
          "scrub-not-passed",
          "[purged]",
          ["shared"],
          { owner: "alice" },
          { subject: "user", predicate: "home_city" },
          "2026-02-01T00:00:00.000Z",
        ],
        regLegacy: [
          "forgotten",
          "scrub-reg-legacy",
          "[purged]",
          [],
          {},
          null,
          "2026-02-01T00:00:00.000Z",
        ],
        floor: ["forgotten", "scrub-floor", "[purged]", [], {}, null, "2026-02-01T00:00:00.000Z"],
        unpurged: [
          "forgotten",
          "scrub-unpurged",
          "scrub-unpurged",
          ["shared", "unpurged-only"],
          { owner: "alice" },
          { subject: "user", predicate: "home_city" },
          null,
        ],
        activePurgedAt: [
          "active",
          "scrub-active",
          "scrub-active",
          ["shared"],
          { owner: "alice" },
          { subject: "user", predicate: "home_city" },
          "2026-02-01T00:00:00.000Z",
        ],
        foreign: [
          "forgotten",
          "scrub-foreign",
          "[purged]",
          ["shared"],
          { owner: "alice" },
          { subject: "user", predicate: "home_city" },
          "2026-02-01T00:00:00.000Z",
        ],
      },
      {
        purged: true,
        purgedB: true,
        clean: false,
        notPassed: false,
        regLegacy: true,
        floor: true,
        unpurged: false,
        activePurgedAt: false,
        foreign: false,
      },
      true,
    ],
  "scrubPurged: proposedCount drops by the links removed, registered and the floor stay": [
    [
      [
        ["floor", "proposed", 0],
        ["own", "proposed", 1],
        ["reg", "registered", 2],
        ["shared", "proposed", 5],
        ["unpurged-only", "proposed", 1],
      ],
      [["shared", "proposed", 1]],
    ],
    [
      [
        ["floor", "proposed", 0],
        ["own", "proposed", 0],
        ["reg", "registered", 2],
        ["shared", "proposed", 3],
        ["unpurged-only", "proposed", 1],
      ],
      [["shared", "proposed", 1]],
    ],
  ],
  "scrubPurged: idempotent, an empty list does nothing, rows with no residue keep updatedAt": [
    true,
    true,
    true,
  ],
  "scrubPurged: a malformed ctx is refused with MalformedIdentifierError":
    "MalformedIdentifierError",
  "scrubPurged: the digest band hides only the passed purged rows, drops truncated, leaves other entries, rows and tenants":
    [
      [
        ["purged", "[purged]", "absent"],
        ["notPassed", "秘密2", "absent"],
        ["unpurged", "未purge", "absent"],
        ["live", "生きている", "absent"],
      ],
      [["purged", "[purged]", "absent"]],
      [
        ["purged", "秘密", true],
        ["notPassed", "秘密2", "absent"],
        ["unpurged", "未purge", "absent"],
        ["live", "生きている", "absent"],
      ],
      true,
      true,
    ],
  "scrubPurged: running it again leaves the band as it was": [
    ["purged", "[purged]", "absent"],
    ["notPassed", "秘密2", "absent"],
    ["unpurged", "未purge", "absent"],
    ["live", "生きている", "absent"],
  ],
  "scrubPurged: a row whose only residue is attributes, claimKey or tags (passed in upper case) is scrubbed":
    [[[], {}, null], [[], {}, null], [[], {}, null], [["upper", "proposed", 0]]],
  "scrubPurged: the band takes each purged row's own digest, and a passed row that is not purged keeps its entry":
    [
      ["attrOnly", "墓標A", "absent"],
      ["upper", "墓標U", "absent"],
      ["unpurged", "古い要旨N", "absent"],
    ],
};

let hashCounter = 0;
function newMemory(ctx: Ctx, tag: string): NewMemory {
  hashCounter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: tag,
    contentHash: `retention-${hashCounter}-${tag}`,
    digest: tag,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2035-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  };
}

describe("保持と掃除の口（Fake）", () => {
  it("保持日数による event の purge と、purgeExpiredRecalls・purgeCompletedJobs・scrubPurged の結果が、Postgres で実測した値（EXPECTED）と一致する", async () => {
    const stores = createFakeRuntimeStores();
    let n = 0;
    const out = await scenario({
      mem: stores.memoryStore as MemoryStore,
      ts: stores.tenantSettingsStore as TenantSettingsStore,
      ev: stores.eventStore as EventStore,
      ob: stores.outboxStore as OutboxStore,
      fresh: () => ({ tenantId: `retention-fake-${(n += 1)}` }),
      mk: async (ctx, tag): Promise<Memory> =>
        (await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(ctx, tag), ["embed"]))
          .memory,
      mkWith: async (ctx, tag, over): Promise<Memory> =>
        stores.memoryStore.createMemory(ctx, { ...newMemory(ctx, tag), ...over }),
      // v1.0.x の purge が残した状態は公開の口では作れない。Fake は内部の行と label を直に書き換える。
      markPurgedAt: async (ctx, id) => {
        stores.memoryStore.liveRowForTest(ctx, id)!.purgedAt = new Date("2026-02-01T00:00:00.000Z");
      },
      setProposedCount: async (ctx, name, count) => {
        const labels = (
          stores.memoryStore as unknown as {
            backing: { labels: Map<string, { proposedCount: number }> };
          }
        ).backing.labels;
        labels.get(JSON.stringify([ctx.tenantId, name]))!.proposedCount = count;
      },
      rows: async (ctx) =>
        stores.outboxStore.listJobs(ctx).map((j) => ({
          done: j.completedAt != null,
          completedAt: j.completedAt ? j.completedAt.toISOString() : null,
        })),
    });
    expect(out).toEqual(EXPECTED);
  });
});
