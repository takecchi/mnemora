import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isContestedGroupMembershipMismatchError,
  isMemoryStatusConflictError,
  isSourceMemoryForgottenError,
  isSourceMemoryStatusChangedError,
} from "@mnemora/core";
import type {
  Ctx,
  EmbeddingStatus,
  MemoryEvent,
  MemoryId,
  MemoryStatus,
  MemoryStore,
  NewMemory,
  NewMemoryEvent,
  OutboxJobRecord,
} from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "../test-data.js";

/**
 * 31巡目（ADR 0458）: `MemoryStore` の port の約束のうち、conformance suite にも既存の `__tests__` にも
 * 歯が見当たらなかったものを、**同じ本文で2実装（`InMemoryMemoryStore`・`PostgresMemoryStore`）に流す**。
 * 本体は `packages/testkit/src/__tests__/memory-store-round31.test.ts`（IM）と
 * `packages/postgres/src/__tests__/memory-store-round31.postgres.test.ts`（PG）が呼ぶ。
 *
 * `packages/testkit/src/*-conformance.ts` には足していない（ADR 0434 決定5: conformance suite に約束を
 * 足すのはオーナーの領分）。約束の出所と一覧は ADR 0458 を見ること。
 */

export interface Round31Kit {
  store: MemoryStore;
  /** メモリ id を渡せばその Memory のイベント、渡さなければそのテナントの全イベント。 */
  listEvents(ctx: Ctx, memoryId?: MemoryId): Promise<MemoryEvent[]>;
  /** `memory_relations` で `memoryId` と結ばれた相手の id（行ごと。重複していれば重複したまま返す）。 */
  relatedIds(ctx: Ctx, memoryId: MemoryId): Promise<string[]>;
  setRetention(ctx: Ctx, days: number | "unlimited"): Promise<void>;
  activitySeq(ctx: Ctx): Promise<number>;
  claimEmbedJobs(ctx: Ctx, now: Date): Promise<OutboxJobRecord[]>;
  /** v1.0.x の purge が残した状態（purgedAt だけ立つ）を作る。 */
  seedLegacyPurged(ctx: Ctx, memoryId: MemoryId): Promise<void>;
}

export interface Round31Flags {
  /** この実装が `opts.abortIfForgotten` を実装している（IM は実装せず、渡されても無視する）。 */
  implementsAbortIfForgotten: boolean;
  /**
   * jsonb 列の欄（attributes/provenance）に孤立サロゲートを渡したときに例外を投げる（PG）。IM は投げずにそのまま保持する。
   * ⚠ ADR 0543 で、`text` 列の欄（content/digest/tags）は全実装が U+FFFD に置き換える形に揃えた——以前ここにあった
   * フラグ `loneSurrogateText`（`"replace"` か `"keep"`）は無くなった。jsonb の欄の差は ADR 0543 の対象外で、今も残る。
   */
  jsonbRejectsLoneSurrogate: boolean;
  /** 索引の1行の上限を超える claimKey を断る（PG: `ClaimKeyIndexLimitError`）。IM はどの長さも受け入れて投げない。 */
  claimKeyIndexLimit: boolean;
}

const LATER = new Date("2026-06-01T00:00:00.000Z");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ev(ctx: Ctx, memoryId: MemoryId, kind: NewMemoryEvent["kind"]): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId,
    kind,
    actor: { type: "system" },
    digestSnapshot: "digest",
    meta: {},
  };
}

export function describeRound31Teeth(
  name: string,
  makeKit: () => Promise<Round31Kit>,
  flags: Round31Flags,
): void {
  describe(`MemoryStore の port の約束の歯（31巡目・ADR 0458）: ${name}`, () => {
    const A: Ctx = { tenantId: "r31-a" };
    const B: Ctx = { tenantId: "r31-b" };
    let n = 0;
    const mem = (ctx: Ctx, over: Partial<NewMemory> = {}): NewMemory => {
      n += 1;
      return buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: `r31-${n}`,
        ...over,
      });
    };
    const mk = async (store: MemoryStore, ctx: Ctx, over: Partial<NewMemory> = {}) =>
      store.createMemory(ctx, mem(ctx, over));
    /** contested は対向が要る（ADR 0140）ので、markContestedPair で作る。 */
    const contestedPair = async (store: MemoryStore, ctx: Ctx) => {
      const a = await mk(store, ctx);
      const b = await mk(store, ctx);
      await store.markContestedPair!(
        ctx,
        { id: a.id, event: ev(ctx, a.id, "updated") },
        { id: b.id, event: ev(ctx, b.id, "updated") },
      );
      return [a, b] as const;
    };
    const group = async (store: MemoryStore, ctx: Ctx, size: number) => {
      const ms = [];
      for (let i = 0; i < size; i += 1) ms.push(await mk(store, ctx));
      await store.markContestedGroup!(
        ctx,
        ms.map((m) => ({ id: m.id, event: ev(ctx, m.id, "updated") })),
      );
      return ms;
    };
    const caught = async (p: Promise<unknown>): Promise<unknown> => {
      try {
        await p;
      } catch (e) {
        return e;
      }
      return undefined;
    };
    const newsOf = (ctx: Ctx, over: Partial<NewMemory> = {}) => ({
      input: mem(ctx, over),
      jobKinds: ["embed"],
    });
    const buildCreated =
      (ctx: Ctx) =>
      (memory: { id: MemoryId }): NewMemoryEvent =>
        ev(ctx, memory.id, "created");

    // ---------------------------------------------------------------- A1
    it("A1: 冪等の衝突で既存の行を返す createMemory・createMemoryWithOutbox にも、別テナントを指す参照の検査は当たる（ADR 0439）", async () => {
      const { store } = await makeKit();
      const obs = await store.createObservation(
        A,
        buildNewObservationFixture({ tenantId: A.tenantId }),
      );
      const foreign = await mk(store, B);
      for (const via of ["createMemory", "createMemoryWithOutbox"] as const) {
        const base = {
          sourceObservationId: obs.id,
          extractorVersion: `v-${via}`,
          contentHash: `a1-${via}`,
        };
        const first = await store.createMemory(A, mem(A, base));
        const resend = mem(A, { ...base, status: "superseded", supersededById: foreign.id });
        const err =
          via === "createMemory"
            ? await caught(store.createMemory(A, resend))
            : await caught(store.createMemoryWithOutbox(A, resend, ["embed"]));
        expect(String(err)).toMatch(/memory not found for tenant/);
        expect((await store.get(A, first.id))?.supersededById).toBeNull();
      }
    });

    // ---------------------------------------------------------------- A2 / A3
    const supersededSource = async (store: MemoryStore, ctx: Ctx) => {
      const anchor = await mk(store, ctx);
      const src = await mk(store, ctx, { status: "superseded", supersededById: anchor.id });
      return src;
    };
    const expectStatusChanged = (
      e: unknown,
      method: string,
      ids: Array<[string, MemoryStatus]>,
    ) => {
      expect(isSourceMemoryStatusChangedError(e)).toBe(true);
      const err = e as { method: string; changed: Array<{ id: string; observedStatus: string }> };
      expect(err.method).toBe(method);
      expect(err.changed.map((c) => [c.id, c.observedStatus]).sort()).toEqual([...ids].sort());
    };

    it("A2: createMemoryWithOutbox の abortIfSuperseded は、superseded を含めば SourceMemoryStatusChangedError で何も書かず、空配列・省略・active だけなら書く", async () => {
      const { store } = await makeKit();
      const src = await supersededSource(store, A);
      const active = await mk(store, A);
      const obs = await store.createObservation(
        A,
        buildNewObservationFixture({ tenantId: A.tenantId }),
      );
      const input = mem(A, {
        contentHash: "a2-cmwo",
        sourceObservationId: obs.id,
        extractorVersion: "v1",
      });
      const e = await caught(
        store.createMemoryWithOutbox(A, input, ["embed"], {
          abortIfSuperseded: [active.id, src.id],
        }),
      );
      expectStatusChanged(e, "createMemoryWithOutbox", [[src.id, "superseded"]]);
      // 何も書かれていない: 同じ抽出キーで作り直すと created: true（書かれていれば created: false）。
      const jobsBefore = await store.createMemoryWithOutbox(A, input, ["embed"], {
        abortIfSuperseded: [active.id],
      });
      expect(jobsBefore.created).toBe(true);
      const withEmpty = await store.createMemoryWithOutbox(A, mem(A), ["embed"], {
        abortIfSuperseded: [],
      });
      expect(withEmpty.created).toBe(true);
      const omitted = await store.createMemoryWithOutbox(A, mem(A), ["embed"]);
      expect(omitted.created).toBe(true);
    });

    it("A2: abortIfSuperseded は書き込みの前に見直し、throw したら news も supersede も1件も書かない（supersedeWithNewMemories）", async () => {
      const { store } = await makeKit();
      const src = await supersededSource(store, A);
      const target = await mk(store, A);
      const obs = await store.createObservation(
        A,
        buildNewObservationFixture({ tenantId: A.tenantId }),
      );
      const news = newsOf(A, { sourceObservationId: obs.id, extractorVersion: "v1" });
      const e = await caught(
        store.supersedeWithNewMemories!(
          A,
          [news],
          [{ id: target.id, supersededByIndex: 0, event: ev(A, target.id, "superseded") }],
          { abortIfSuperseded: [src.id] },
        ),
      );
      expectStatusChanged(e, "supersedeWithNewMemories", [[src.id, "superseded"]]);
      expect((await store.get(A, target.id))?.status).toBe("active");
      const ok = await store.supersedeWithNewMemories!(
        A,
        [news],
        [{ id: target.id, supersededByIndex: 0, event: ev(A, target.id, "superseded") }],
        { abortIfSuperseded: [] },
      );
      expect(ok.created[0]?.created).toBe(true);
    });

    it("A2: abortIfSuperseded は createMemoriesWithOutboxAndEvents でも、どの候補の書き込みより前に見直して何も書かない", async () => {
      const { store, listEvents } = await makeKit();
      const src = await supersededSource(store, A);
      const obs = await store.createObservation(
        A,
        buildNewObservationFixture({ tenantId: A.tenantId }),
      );
      const keyed = newsOf(A, { sourceObservationId: obs.id, extractorVersion: "v1" });
      const e = await caught(
        store.createMemoriesWithOutboxAndEvents!(A, [keyed], buildCreated(A), {
          abortIfSuperseded: [src.id],
        }),
      );
      expectStatusChanged(e, "createMemoriesWithOutboxAndEvents", [[src.id, "superseded"]]);
      expect((await listEvents(A)).filter((x) => x.kind === "created")).toEqual([]);
      const ok = await store.createMemoriesWithOutboxAndEvents!(A, [keyed], buildCreated(A), {
        abortIfSuperseded: [],
      });
      expect(ok.written).toHaveLength(1);
      expect(ok.written[0]?.created).toBe(true);
      expect(ok.dropped).toEqual([]);
    });

    it.runIf(flags.implementsAbortIfForgotten)(
      "A2: abortIfForgotten の見直しが先——forgotten と superseded を両方含めば SourceMemoryForgottenError",
      async () => {
        const { store } = await makeKit();
        const sup = await supersededSource(store, A);
        const forgotten = await mk(store, A, { status: "forgotten" });
        const e = await caught(
          store.createMemoryWithOutbox(A, mem(A), ["embed"], {
            abortIfForgotten: [forgotten.id],
            abortIfSuperseded: [sup.id],
          }),
        );
        expect(isSourceMemoryForgottenError(e)).toBe(true);
      },
    );

    it("A3: abortIfAllConflicted は、supersede の対象が全部 CAS に弾かれたら news ごと巻き戻して SourceMemoryStatusChangedError、1件でも通れば部分成功", async () => {
      const { store } = await makeKit();
      const a = await mk(store, A, { status: "archived" });
      const b = await mk(store, A, { status: "archived" });
      const live = await mk(store, A);
      const news = newsOf(A, { contentHash: "a3-news" });
      const sup = (id: MemoryId) => ({
        id,
        supersededByIndex: 0,
        expectedStatus: "active" as const,
        event: ev(A, id, "superseded"),
      });
      const e = await caught(
        store.supersedeWithNewMemories!(A, [news], [sup(a.id), sup(b.id)], {
          abortIfAllConflicted: true,
        }),
      );
      expectStatusChanged(e, "supersedeWithNewMemories", [
        [a.id, "archived"],
        [b.id, "archived"],
      ]);
      // news は残っていない: 同じ入力でもう一度（今度は通る supersede を混ぜて）呼ぶと created: true。
      const partial = await store.supersedeWithNewMemories!(A, [news], [sup(a.id), sup(live.id)], {
        abortIfAllConflicted: true,
      });
      expect(partial.created[0]?.created).toBe(true);
      expect(partial.conflicted.map((c) => c.id)).toEqual([a.id]);
      expect((await store.get(A, live.id))?.status).toBe("superseded");
      // 省略・false は今日どおり（全部弾かれても例外にせず conflicted に積む）。
      const dflt = await store.supersedeWithNewMemories!(A, [newsOf(A)], [sup(b.id)]);
      expect(dflt.conflicted.map((c) => c.id)).toEqual([b.id]);
      const off = await store.supersedeWithNewMemories!(A, [newsOf(A)], [sup(b.id)], {
        abortIfAllConflicted: false,
      });
      expect(off.conflicted.map((c) => c.id)).toEqual([b.id]);
    });

    // ---------------------------------------------------------------- A4
    it("A4: getMany は ids に同じ id が複数あっても、結果に1回だけ載せる", async () => {
      const { store } = await makeKit();
      const m = await mk(store, A);
      const r = await store.getMany(A, [m.id, m.id, m.id]);
      expect(r.map((x) => x.id)).toEqual([m.id]);
    });

    // ---------------------------------------------------------------- A5
    it("A5: updateStatus・updateStatusWithEvent の判定順は「対象の id が無い → supersededById が無い → expectedStatus が違う」", async () => {
      const { store } = await makeKit();
      const target = await mk(store, A);
      const missing = randomUUID();
      const e1 = await caught(
        store.updateStatus(A, target.id, "superseded", {
          supersededById: missing,
          expectedStatus: "archived",
        }),
      );
      expect(isMemoryStatusConflictError(e1)).toBe(false);
      expect(String(e1)).toContain(missing);
      const e2 = await caught(
        store.updateStatusWithEvent(
          A,
          target.id,
          "superseded",
          { supersededById: missing, expectedStatus: "archived" },
          ev(A, target.id, "superseded"),
        ),
      );
      expect(isMemoryStatusConflictError(e2)).toBe(false);
      expect(String(e2)).toContain(missing);
      // 対象が無いときは supersededById の検査より先に「対象が無い」。
      const gone = randomUUID();
      const e3 = await caught(
        store.updateStatus(A, gone, "superseded", {
          supersededById: missing,
          expectedStatus: "archived",
        }),
      );
      expect(String(e3)).toContain(gone);
      expect(String(e3)).not.toContain(missing);
      expect((await store.get(A, target.id))?.status).toBe("active");
    });

    it("A5: resolveContestedPair・resolveContestedGroup の supersededById のテナント検査は CAS の判定（MemoryStatusConflictError）のあとに当たる", async () => {
      const { store } = await makeKit();
      const foreign = await mk(store, B);
      const x = await mk(store, A);
      const y = await mk(store, A);
      const e = await caught(
        store.resolveContestedPair!(
          A,
          {
            id: x.id,
            status: "superseded",
            supersededById: foreign.id,
            event: ev(A, x.id, "superseded"),
          },
          { id: y.id, status: "active", event: ev(A, y.id, "updated") },
        ),
      );
      expect(isMemoryStatusConflictError(e)).toBe(true);
      const ms = [x, y, await mk(store, A)];
      const e2 = await caught(
        store.resolveContestedGroup!(
          A,
          ms.map((m, i) => ({
            id: m.id,
            status: i === 0 ? ("superseded" as const) : ("active" as const),
            ...(i === 0 ? { supersededById: foreign.id } : {}),
            event: ev(A, m.id, "updated"),
          })),
        ),
      );
      expect(isMemoryStatusConflictError(e2)).toBe(true);
    });

    // ---------------------------------------------------------------- A6 / A7
    it("A6: reinforce は status を見ない——active/contested/archived/superseded/forgotten のどれでも lastReinforcedAt を書く（Issue #840）", async () => {
      const { store } = await makeKit();
      const anchor = await mk(store, A);
      const [c1] = await contestedPair(store, A);
      const rows = [
        await mk(store, A),
        c1,
        await mk(store, A, { status: "archived" }),
        await mk(store, A, { status: "superseded", supersededById: anchor.id }),
        await mk(store, A, { status: "forgotten" }),
      ];
      for (const r of rows) {
        const out = await store.reinforce(A, r.id, LATER);
        expect(out.lastReinforcedAt?.getTime()).toBe(LATER.getTime());
        expect((await store.get(A, r.id))?.lastReinforcedAt?.getTime()).toBe(LATER.getTime());
      }
    });

    it("A7: reinforceMany は reinforce を ids[i] 順に呼んだのと同じ——同順・同長・重複 id は同じ行・古い at は no-op", async () => {
      const { store } = await makeKit();
      if (typeof store.reinforceMany !== "function") return;
      const a = await mk(store, A);
      const b = await mk(store, A);
      const out = await store.reinforceMany(A, [b.id, a.id, b.id], LATER);
      expect(out.map((m) => m.id)).toEqual([b.id, a.id, b.id]);
      expect(out.every((m) => m.lastReinforcedAt?.getTime() === LATER.getTime())).toBe(true);
      const updatedAt = (await store.get(A, a.id))!.updatedAt.getTime();
      await wait(5);
      const older = await store.reinforceMany(A, [a.id], new Date(LATER.getTime() - 86_400_000));
      expect(older[0]?.lastReinforcedAt?.getTime()).toBe(LATER.getTime());
      expect((await store.get(A, a.id))!.updatedAt.getTime()).toBe(updatedAt);
    });

    // ---------------------------------------------------------------- A9 / A10 / A11
    it("A9: purgeExpiredEvents は対象0件なら削除も events_purged の追記もせず、oldest/newestPurgedAt は null", async () => {
      const { store, listEvents } = await makeKit();
      const m = await mk(store, A);
      await store.updateStatusWithEvent(A, m.id, "forgotten", {}, ev(A, m.id, "forgotten"));
      const before = (await listEvents(A)).length;
      const r = await store.purgeExpiredEvents!(A, {
        olderThan: new Date("2000-01-01T00:00:00.000Z"),
        limit: 10,
      });
      expect(r).toEqual({
        purged: 0,
        reachedLimit: false,
        oldestPurgedAt: null,
        newestPurgedAt: null,
        dryRun: false,
      });
      expect((await listEvents(A)).length).toBe(before);
      expect((await listEvents(A)).filter((x) => x.kind === "events_purged")).toEqual([]);
    });

    it("A10: purgeExpiredEventsByRetention は unset・unlimited では1行も消さず、days なら cutoff を now から遡って消す", async () => {
      const { store, listEvents, setRetention } = await makeKit();
      const m = await mk(store, A);
      await store.updateStatusWithEvent(A, m.id, "forgotten", {}, ev(A, m.id, "forgotten"));
      const now = new Date(Date.now() + 40 * 86_400_000);
      expect(await store.purgeExpiredEventsByRetention!(A, { now, limit: 10 })).toEqual({
        kind: "unset",
      });
      await setRetention(A, "unlimited");
      expect(await store.purgeExpiredEventsByRetention!(A, { now, limit: 10 })).toEqual({
        kind: "unlimited",
      });
      expect((await listEvents(A, m.id)).length).toBe(1);
      await setRetention(A, 30);
      const dry = await store.purgeExpiredEventsByRetention!(A, { now, limit: 10, dryRun: true });
      expect(dry).toMatchObject({ kind: "executed", result: { purged: 1, dryRun: true } });
      expect((await listEvents(A, m.id)).length).toBe(1);
      const real = await store.purgeExpiredEventsByRetention!(A, { now, limit: 10 });
      expect(real).toMatchObject({ kind: "executed", result: { purged: 1, dryRun: false } });
      expect((await listEvents(A, m.id)).length).toBe(0);
      // 他テナントの設定は読まない。
      expect(await store.purgeExpiredEventsByRetention!(B, { now, limit: 10 })).toEqual({
        kind: "unset",
      });
    });

    it("A11: purgeExpiredRecalls は events_purged など、memory_events に監査行を一切積まない", async () => {
      const { store, listEvents } = await makeKit();
      const m = await mk(store, A);
      await store.updateStatusWithEvent(A, m.id, "forgotten", {}, ev(A, m.id, "forgotten"));
      const recallId = await store.createRecall(A, {
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
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
      });
      await store.recordUsage(A, recallId, [m.id]);
      const before = (await listEvents(A)).map((x) => x.kind);
      const r = await store.purgeExpiredRecalls!(A, {
        olderThan: new Date("2021-01-01T00:00:00.000Z"),
        limit: 10,
      });
      expect(r.purged).toBe(1);
      expect((await listEvents(A)).map((x) => x.kind)).toEqual(before);
    });

    // ---------------------------------------------------------------- A12
    it("A12: archiveDecayed(clock: 'activity') の usesSubjectActivityCounters: true は nowSeq に行の subject の S_x を足して比べる（既定 false は足さない）", async () => {
      const { store } = await makeKit();
      const recall = (subjectId: string) =>
        store.createRecall(A, {
          tenantId: A.tenantId,
          subjectId,
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
          advanceActivityClock: { scope: "subject", subjectId },
        });
      for (let i = 0; i < 7; i += 1) await recall("alice");
      const m = await mk(store, A, {
        subjectId: "alice",
        halfLifeRecalls: 360,
        decayBaseSeq: 0,
        decayFloorSeq: 10,
      });
      // T=5 だけなら 10 に届かない。S_alice=7 を足せば 12 >= 10 で沈んでいる。
      const without = await store.archiveDecayed!(A, {
        now: LATER,
        limit: 10,
        clock: "activity",
        nowSeq: 5,
        usesSubjectActivityCounters: false,
      });
      expect(without.archived).toEqual([]);
      const dflt = await store.archiveDecayed!(A, {
        now: LATER,
        limit: 10,
        clock: "activity",
        nowSeq: 5,
      });
      expect(dflt.archived).toEqual([]);
      const withS = await store.archiveDecayed!(A, {
        now: LATER,
        limit: 10,
        clock: "activity",
        nowSeq: 5,
        usesSubjectActivityCounters: true,
      });
      expect(withS.archived.map((x) => x.memoryId)).toEqual([m.id]);
    });

    // ---------------------------------------------------------------- A13 / A14
    it("A13: purgeMemory は registered の label を触らず、proposed の proposedCount だけ減らす", async () => {
      const { store } = await makeKit();
      const m = await mk(store, A, { status: "forgotten", tags: ["r31-reg", "r31-prop"] });
      await mk(store, A, { tags: ["r31-prop"] });
      // proposed で proposedCount=1 になった後に registered へ昇格する（昇格後は proposedCount を保つ）。
      await store.registerLabel!(A, "r31-reg");
      const before = await store.listLabels!(A);
      expect(before.find((l) => l.name === "r31-reg")).toMatchObject({
        status: "registered",
        proposedCount: 1,
      });
      await store.purgeMemory!(
        A,
        m.id,
        { content: "[purged]", digest: "[purged]" },
        ev(A, m.id, "purged"),
      );
      const after = await store.listLabels!(A);
      expect(after.find((l) => l.name === "r31-reg")).toEqual(
        before.find((l) => l.name === "r31-reg"),
      );
      expect(after.find((l) => l.name === "r31-prop")?.proposedCount).toBe(1);
    });

    it("A13/A14: scrubPurged は registered の label を触らず、memory_events を積まない", async () => {
      const { store, listEvents, seedLegacyPurged } = await makeKit();
      const m = await mk(store, A, { status: "forgotten", tags: ["r31-reg2"] });
      await store.registerLabel!(A, "r31-reg2");
      await seedLegacyPurged(A, m.id);
      const labelsBefore = await store.listLabels!(A);
      const eventsBefore = (await listEvents(A)).length;
      await store.scrubPurged!(A, [m.id]);
      expect(labelsBefore).toMatchObject([
        { name: "r31-reg2", status: "registered", proposedCount: 1 },
      ]);
      expect(await store.listLabels!(A)).toEqual(labelsBefore);
      expect((await listEvents(A)).length).toBe(eventsBefore);
      expect((await store.get(A, m.id))?.tags).toEqual([]);
    });

    // ---------------------------------------------------------------- A15 / A16
    it("A15: programmer error の RangeError は TSDoc どおりのメッセージ（markContestedPair・resolveContestedPair）", async () => {
      const { store } = await makeKit();
      const x = await mk(store, A);
      const side = { id: x.id, event: ev(A, x.id, "updated") };
      // TSDoc はメッセージを「`<実装のクラス名>: first.id and second.id must differ`」と書く（接頭辞は
      // `InMemoryMemoryStore: …`・`PostgresMemoryStore: …` のように実装ごとに違う。ADR 0458 で TSDoc を実装に合わせた）。
      // ここで縛るのは「RangeError で、`first.id and second.id must differ` で終わる」こと。
      for (const call of [
        () => store.markContestedPair!(A, side, side),
        () =>
          store.resolveContestedPair!(
            A,
            { ...side, status: "active" },
            { ...side, status: "active" },
          ),
      ]) {
        const e = await caught(call());
        expect(e).toBeInstanceOf(RangeError);
        expect((e as Error).message).toMatch(/: first\.id and second\.id must differ$/);
      }
      expect((await store.get(A, x.id))?.status).toBe("active");
    });

    it("A15/A16: markContestedGroup・resolveContestedGroup の RangeError（3件未満・重複 id）は型もメッセージも TSDoc どおりで、何も書かない", async () => {
      const { store } = await makeKit();
      const [a, b, c] = [await mk(store, A), await mk(store, A), await mk(store, A)];
      const mem2 = (x: { id: MemoryId }) => ({ id: x.id, event: ev(A, x.id, "updated") });
      const res = (x: { id: MemoryId }) => ({ ...mem2(x), status: "active" as const });
      const cases: Array<[string, () => Promise<unknown>, string]> = [
        [
          "mark<3",
          () => store.markContestedGroup!(A, [mem2(a), mem2(b)]),
          "markContestedGroup: members must have at least 3 entries",
        ],
        [
          "mark dup",
          () => store.markContestedGroup!(A, [mem2(a), mem2(b), mem2(a)]),
          "markContestedGroup: member ids must be unique",
        ],
        [
          "resolve<3",
          () => store.resolveContestedGroup!(A, [res(a), res(b)]),
          "resolveContestedGroup: members must have at least 3 entries",
        ],
        [
          "resolve dup",
          () => store.resolveContestedGroup!(A, [res(a), res(b), res(a)]),
          "resolveContestedGroup: member ids must be unique",
        ],
      ];
      for (const [label, call, message] of cases) {
        const e = await caught(call());
        expect(e, label).toBeInstanceOf(RangeError);
        expect((e as Error).message, label).toBe(message);
      }
      // 何も書かれていない（3件目の c を含めても全員 active のまま）。
      for (const m of [a, b, c]) expect((await store.get(A, m.id))?.status).toBe("active");
    });

    // ---------------------------------------------------------------- A17
    it("A17: 群の一部だけを渡すと ContestedGroupMembershipMismatchError。forget で抜けた分は欠けとして数えない", async () => {
      const { store } = await makeKit();
      const [a, b, c, d, e5] = await group(store, A, 5);
      await store.updateStatus(A, e5!.id, "forgotten");
      const err = await caught(
        store.resolveContestedGroup!(
          A,
          [a!, b!, c!].map((m) => ({
            id: m.id,
            status: "active" as const,
            event: ev(A, m.id, "updated"),
          })),
        ),
      );
      expect(isContestedGroupMembershipMismatchError(err)).toBe(true);
      expect((err as { missingMemberId: string }).missingMemberId).toBe(d!.id);
      const ok = await store.resolveContestedGroup!(
        A,
        [a!, b!, c!, d!].map((m) => ({
          id: m.id,
          status: "active" as const,
          event: ev(A, m.id, "updated"),
        })),
      );
      expect(ok.members).toHaveLength(4);
    });

    // ---------------------------------------------------------------- A18 / A19 / A20
    it("A18: markContestedGroup は既に張られている関係の行を重複させない（既存の群を吸収する）", async () => {
      const { store, relatedIds } = await makeKit();
      const [a, b, c] = await group(store, A, 3);
      const d = await mk(store, A);
      await store.markContestedGroup!(
        A,
        [a!, b!, c!, d].map((m) => ({ id: m.id, event: ev(A, m.id, "updated") })),
      );
      const ids = await relatedIds(A, a!.id);
      expect([...ids].sort()).toEqual([b!.id, c!.id, d.id].sort());
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("A19: markContestedGroup・resolveContestedGroup は、存在しない id が混ざれば「memory not found」で何も書かない", async () => {
      const { store } = await makeKit();
      const [a, b] = [await mk(store, A), await mk(store, A)];
      const ghost = randomUUID();
      const e = await caught(
        store.markContestedGroup!(
          A,
          [a, b, { id: ghost }].map((m) => ({ id: m.id, event: ev(A, m.id as string, "updated") })),
        ),
      );
      expect(String(e)).toMatch(/memory not found/);
      expect((await store.get(A, a.id))?.status).toBe("active");
      const ms = await group(store, A, 3);
      const e2 = await caught(
        store.resolveContestedGroup!(
          A,
          [...ms, { id: ghost }].map((m) => ({
            id: m.id,
            status: "active" as const,
            event: ev(A, m.id, "updated"),
          })),
        ),
      );
      expect(String(e2)).toMatch(/memory not found/);
      for (const m of ms) expect((await store.get(A, m.id))?.status).toBe("contested");
    });

    it("A20: markContestedGroup・resolveContestedGroup は別テナントの記憶に触れない", async () => {
      const { store } = await makeKit();
      const mine = [await mk(store, A), await mk(store, A)];
      const theirs = await mk(store, B);
      const e = await caught(
        store.markContestedGroup!(
          A,
          [...mine, theirs].map((m) => ({ id: m.id, event: ev(A, m.id, "updated") })),
        ),
      );
      expect(e).toBeDefined();
      expect((await store.get(B, theirs.id))?.status).toBe("active");
      expect((await store.get(A, mine[0]!.id))?.status).toBe("active");
      const bGroup = await group(store, B, 3);
      const e2 = await caught(
        store.resolveContestedGroup!(
          A,
          bGroup.map((m) => ({
            id: m.id,
            status: "active" as const,
            event: ev(A, m.id, "updated"),
          })),
        ),
      );
      expect(e2).toBeDefined();
      for (const m of bGroup) expect((await store.get(B, m.id))?.status).toBe("contested");
    });

    // ---------------------------------------------------------------- A21 / A22
    it("A21: restoreSupersededBy は updatedAt を進め、content/digest は書き換えない", async () => {
      const { store } = await makeKit();
      const anchor = await mk(store, A);
      const s = await mk(store, A, { status: "superseded", supersededById: anchor.id });
      const before = (await store.get(A, s.id))!;
      await wait(5);
      await store.restoreSupersededBy!(A, anchor.id, { at: LATER });
      const after = (await store.get(A, s.id))!;
      expect(after.status).toBe("active");
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      expect(after.content).toBe(before.content);
      expect(after.digest).toBe(before.digest);
    });

    it("A22: proposedCount は「新規作成された回数」——冪等な再送では増えない", async () => {
      const { store } = await makeKit();
      const obs = await store.createObservation(
        A,
        buildNewObservationFixture({ tenantId: A.tenantId }),
      );
      const base = {
        sourceObservationId: obs.id,
        extractorVersion: "v1",
        contentHash: "a22",
        tags: ["r31-idem"],
      };
      await store.createMemory(A, mem(A, base));
      await store.createMemory(A, mem(A, base));
      await store.createMemoryWithOutbox(A, mem(A, base), ["embed"]);
      const count = (await store.listLabels!(A)).find((l) => l.name === "r31-idem")?.proposedCount;
      expect(count).toBe(1);
    });

    // ---------------------------------------------------------------- A23
    it("A23: eraseTenant は memory_events・memory_labels/labels・memory_relations・recall_usages・tenant_activity も消す", async () => {
      const { store, listEvents, relatedIds, activitySeq } = await makeKit();
      const ms = await group(store, A, 3); // memory_relations・updated イベント
      await store
        .updateStatusWithEvent(A, ms[0]!.id, "forgotten", {}, ev(A, ms[0]!.id, "forgotten"))
        .catch(() => undefined);
      await mk(store, A, { tags: ["r31-erase"] }); // labels
      await store.registerLabel!(A, "r31-erase-reg");
      const recallId = await store.createRecall(A, {
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
        advanceActivityClock: true,
      });
      await store.recordUsage(A, recallId, [ms[1]!.id]);
      expect((await listEvents(A)).length).toBeGreaterThan(0);
      expect((await relatedIds(A, ms[1]!.id)).length).toBeGreaterThan(0);
      expect(await activitySeq(A)).toBe(1);
      const keep = await mk(store, B, { tags: ["r31-erase"] });
      let r = await store.eraseTenant!(A, { limit: 1000 });
      while (r.kind === "executed" && r.reachedLimit)
        r = await store.eraseTenant!(A, { limit: 1000 });
      expect(r.kind).toBe("executed");
      expect(await listEvents(A)).toEqual([]);
      expect(await store.listLabels!(A)).toEqual([]);
      expect(await relatedIds(A, ms[1]!.id)).toEqual([]);
      expect(await activitySeq(A)).toBe(0);
      expect((await store.get(B, keep.id))?.id).toBe(keep.id);
      expect((await store.listLabels!(B)).map((l) => l.name)).toEqual(["r31-erase"]);
    });

    // ---------------------------------------------------------------- B 代表
    it("B1: createObservation の input.tenantId が ctx と違っても、ctx のテナントとして書く", async () => {
      const { store } = await makeKit();
      const o = await store.createObservation(
        A,
        buildNewObservationFixture({ tenantId: B.tenantId }),
      );
      expect(o.tenantId).toBe(A.tenantId);
      expect((await store.getObservation(A, o.id))?.id).toBe(o.id);
      expect(await store.getObservation(B, o.id)).toBeNull();
    });

    it("B2: jobKinds の各要素につき1件のジョブを作る（createObservationWithOutbox・createMemoryWithOutbox）", async () => {
      const { store } = await makeKit();
      const o = await store.createObservationWithOutbox(
        A,
        buildNewObservationFixture({ tenantId: A.tenantId }),
        ["extract", "embed"],
      );
      expect(o.jobs.map((j) => j.kind).sort()).toEqual(["embed", "extract"]);
      const m = await store.createMemoryWithOutbox(A, mem(A), ["embed", "reflect"]);
      expect(m.jobs.map((j) => j.kind).sort()).toEqual(["embed", "reflect"]);
    });

    it("B5: setEmbeddingStatus は ready→failed だけを禁じる——ready→pending・ready→skipped は書く", async () => {
      const { store } = await makeKit();
      for (const to of ["pending", "skipped"] as EmbeddingStatus[]) {
        const m = await mk(store, A, { embeddingStatus: "ready" });
        const out = await store.setEmbeddingStatus(A, m.id, to);
        expect(out.embeddingStatus).toBe(to);
        expect((await store.get(A, m.id))?.embeddingStatus).toBe(to);
      }
    });

    it("B7: recordUsage は memoryIds が空配列なら何も検査せず、無効な recallId でも空の結果を返す", async () => {
      const { store } = await makeKit();
      for (const recallId of [randomUUID(), "not-a-uuid"]) {
        expect(await store.recordUsage(A, recallId, [])).toEqual({ insertedMemoryIds: [] });
      }
    });

    it("B11: createMemoriesWithOutboxAndEvents は opts.now を outbox の availableAt/createdAt に使う（過去の now で claim できる）", async () => {
      const { store, claimEmbedJobs } = await makeKit();
      const past = new Date("2020-01-01T00:00:00.000Z");
      const out = await store.createMemoriesWithOutboxAndEvents!(A, [newsOf(A)], buildCreated(A), {
        now: past,
      });
      const id = out.written[0]!.memory.id;
      expect(out.written[0]!.jobs[0]?.availableAt.getTime()).toBe(past.getTime());
      expect((await claimEmbedJobs(A, past)).map((j) => j.payload.memoryId)).toEqual([id]);
    });

    it("B13: resolveOrphanedContested は別テナント・形式不正な id を「memory not found」にする", async () => {
      const { store } = await makeKit();
      const [x] = await contestedPair(store, B);
      const survivor = (id: string) => ({
        id,
        contestedWithId: randomUUID(),
        event: ev(A, id, "updated"),
      });
      for (const id of [x!.id, "not-a-uuid"]) {
        const e = await caught(store.resolveOrphanedContested!(A, survivor(id)));
        expect(String(e)).toMatch(/memory not found/);
      }
      expect((await store.get(B, x!.id))?.status).toBe("contested");
    });

    it("B9: supersedeWithNewMemories は news が冪等で既存行に衝突（created:false）しても、supersededByIndex はその既存行を指し、ジョブを積まない", async () => {
      const { store } = await makeKit();
      const obs = await store.createObservation(
        A,
        buildNewObservationFixture({ tenantId: A.tenantId }),
      );
      const existing = await store.createMemory(
        A,
        mem(A, { sourceObservationId: obs.id, extractorVersion: "v1", contentHash: "b9" }),
      );
      const target = await mk(store, A);
      const r = await store.supersedeWithNewMemories!(
        A,
        [
          {
            input: mem(A, {
              sourceObservationId: obs.id,
              extractorVersion: "v1",
              contentHash: "b9",
            }),
            jobKinds: ["embed"],
          },
        ],
        [{ id: target.id, supersededByIndex: 0, event: ev(A, target.id, "superseded") }],
      );
      expect(r.created[0]?.created).toBe(false);
      expect(r.created[0]?.memory.id).toBe(existing.id);
      expect(r.created[0]?.jobs).toEqual([]);
      expect((await store.get(A, target.id))?.supersededById).toBe(existing.id);
    });

    it.runIf(!flags.implementsAbortIfForgotten)(
      "B10: abortIfForgotten を実装しない adapter は、supersedeWithNewMemories でも渡されて無視し、今日どおり書く",
      async () => {
        const { store } = await makeKit();
        const forgotten = await mk(store, A, { status: "forgotten" });
        const target = await mk(store, A);
        const r = await store.supersedeWithNewMemories!(
          A,
          [newsOf(A)],
          [{ id: target.id, supersededByIndex: 0, event: ev(A, target.id, "superseded") }],
          { abortIfForgotten: [forgotten.id] },
        );
        expect(r.created[0]?.created).toBe(true);
      },
    );

    // ---------------------------------------------------------------- B3 / B4
    // ⚠ B4 は、インメモリと Postgres の**今の振る舞いの記録であって、約束ではない**（ADR 0458 の材料4）。
    // 差（`flags.claimKeyIndexLimit`）をそのまま縛っている。B3 のうち `text` 列の欄は、ADR 0543 で
    // 「全実装が U+FFFD に置き換える」に揃えた（B3 の歯を書き換えた。全欄・3実装の突き合わせは
    // `lone-surrogate-fffd-teeth.ts`）。jsonb の欄の差（PG だけが例外）は `flags.jsonbRejectsLoneSurrogate` が今も縛る。
    it("B3: 孤立サロゲートを本文の欄へ渡したときは、PG・IM とも U+FFFD に置換（ADR 0543。ADR 0458 の旧 B3 は『IM は保持』を縛っていた）／jsonb の欄は PG だけが例外", async () => {
      const { store } = await makeKit();
      const lone = "a\uD800b";
      const m = await mk(store, A, { content: lone, digest: lone, tags: [lone] });
      const expected = "a\uFFFDb";
      expect(m.content).toBe(expected);
      expect(m.digest).toBe(expected);
      expect(m.tags).toEqual([expected]);
      const viaAttributes = await caught(mk(store, A, { attributes: { k: lone } }));
      const viaProvenance = await caught(
        mk(store, A, { provenance: { kind: "imported", batchId: lone } }),
      );
      if (flags.jsonbRejectsLoneSurrogate) {
        expect(viaAttributes).toBeDefined();
        expect(viaProvenance).toBeDefined();
      } else {
        expect(viaAttributes).toBeUndefined();
        expect(viaProvenance).toBeUndefined();
      }
    });

    it.runIf(!flags.claimKeyIndexLimit)(
      "B4: claimKey の索引の上限を持たない adapter（IM）は、PG なら ClaimKeyIndexLimitError になる長い主語・述語（圧縮されない2600字×2）も受け入れて投げない",
      async () => {
        const { store } = await makeKit();
        const subject = randomBytes(3000).toString("hex");
        const predicate = randomBytes(3000).toString("hex");
        const m = await mk(store, A, { claimKey: { subject, predicate } });
        expect(m.claimKey?.subject).toBe(subject);
      },
    );
  });
}
