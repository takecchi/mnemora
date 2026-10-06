// ADR 0434（穴探し14巡目）: testkit のインメモリ実装を、Postgres 実装（正）に揃えた3組の入力の歯。
// クローンの委譲先（マネージャー mgr-0629e6a2）が書いた。オーナーではない。
//
// - 候補2: NUL（U+0000）を、Postgres が拒む口（書き込み・読み取りとも）で同じく拒む。
// - 候補3: `MemoryEvent.sizeBeforeBytes`（int4）・`reinforce` の `nowSeq`・outbox の行を書くときの `opts.now`
//   （Invalid Date）を、同じ入力で拒む。
// - 候補4: `createMemory` に渡された `purgedAt` を保存しない。
//
// 各ケースは「拒む」と「通る」の両方を持つ。通るほうは、拒みすぎる実装（境界を1つずらす・Postgres が通す
// 入力まで拒む）を赤にする歯である。**同じ表を Postgres にも当てたもの**が
// `packages/postgres/src/__tests__/testkit-fixtures-nul-numeric-purged-at-alignment.postgres.test.ts`
// （2つの表は同じ内容。こちらは DB が要らない）。
//
// このテストは fixture を直接呼ぶだけで、`*-conformance.ts` には触れていない（適合テストを足すのはオーナーの判断）。

import { describe, expect, it } from "vitest";
import type {
  Ctx,
  EventStore,
  LexicalFilter,
  LexicalStore,
  Memory,
  MemoryStore,
  NewMemory,
  NewMemoryEvent,
  NewRecallRecord,
  OutboxJobKind,
  ReinforceOptions,
  TenantSettingsStore,
} from "@mnemora/core";
import {
  buildNewMemoryEventFixture,
  buildNewMemoryFixture,
  buildNewObservationFixture,
} from "../test-data.js";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryTenantSettingsStore } from "../__fixtures__/in-memory-tenant-settings-store.js";

/** 1つのケースが使う、空の store 一式。 */
interface Kit {
  memory: MemoryStore;
  events: EventStore;
  lexical: LexicalStore;
  tenantSettings: TenantSettingsStore;
}

async function inMemoryKit(): Promise<Kit> {
  const memory = new InMemoryMemoryStore();
  return {
    memory,
    events: new InMemoryEventStore(memory, memory.events),
    lexical: new InMemoryLexicalStore(memory),
    tenantSettings: new InMemoryTenantSettingsStore(memory.activitySeq, memory.subjectActivitySeq),
  };
}

const ctx: Ctx = { tenantId: "align-nul-numeric" };
const NUL = "a\u0000b";
const INVALID = new Date(Number.NaN);
/** uuid の形の、どの行にも当たらない id（Postgres は uuid 列へ渡すので、形の正しい値が要る）。 */
const NO_SUCH = "00000000-0000-0000-0000-000000000000";
const I32 = 2 ** 31;
const AT = new Date("2026-06-01T00:00:00.000Z");

let seq = 0;
const newMemory = (o: Partial<NewMemory> = {}): NewMemory =>
  buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `h-${++seq}`, ...o });
const newEvent = (o: Partial<NewMemoryEvent> = {}): NewMemoryEvent =>
  buildNewMemoryEventFixture({ tenantId: ctx.tenantId, ...o });

/** 冪等の鍵（観測・抽出器の版・contentHash）が決まった `NewMemory`。同じ値で2回書くと2回目は既存の行に当たる。 */
async function keyedMemory(kit: Kit): Promise<NewMemory> {
  const observation = await kit.memory.createObservation(
    ctx,
    buildNewObservationFixture({ tenantId: ctx.tenantId }),
  );
  return newMemory({
    sourceObservationId: observation.id,
    provenance: {
      kind: "stated",
      sourceObservationId: observation.id,
      at: AT.toISOString(),
    },
    extractorVersion: "v1",
    contentHash: "keyed",
  });
}
async function forgottenMemory(kit: Kit): Promise<Memory> {
  const memory = await kit.memory.createMemory(ctx, newMemory());
  await kit.memory.updateStatus(ctx, memory.id, "forgotten");
  return memory;
}
/** 入れ替え先になる旧い Memory を作って `supersedeWithNewMemories` を呼ぶ。 */
async function supersede(
  kit: Kit,
  news: Array<{ input: NewMemory; jobKinds: OutboxJobKind[] }>,
  opts?: { now?: Date },
  eventOverrides: Partial<NewMemoryEvent> = {},
): Promise<unknown> {
  const old = await kit.memory.createMemory(ctx, newMemory());
  return kit.memory.supersedeWithNewMemories!(
    ctx,
    news,
    [
      {
        id: old.id,
        supersededByIndex: 0,
        event: newEvent({ memoryId: old.id, kind: "superseded", ...eventOverrides }),
      },
    ],
    opts,
  );
}
const createdEvent =
  (overrides: Partial<NewMemoryEvent> = {}) =>
  (memory: Memory): NewMemoryEvent =>
    newEvent({ memoryId: memory.id, kind: "created", ...overrides });
const embedJobs: OutboxJobKind[] = ["embed"];
const nulJob = ["em\u0000bed"] as unknown as OutboxJobKind[];
// NUL 以外の制御文字（SOH）。`text` 列は受け付けるので、Postgres も fixture も通す。
const controlJob = [`em${String.fromCharCode(1)}bed`] as unknown as OutboxJobKind[];
const claimKeyOf = (subject: string, predicate: string) => ({ subject, predicate });
const find = (kit: Kit, claimKey: { subject: string; predicate: string }) =>
  kit.memory.findActiveByClaimKey!(ctx, {
    subjectId: null,
    claimKey,
    excludeMemoryId: NO_SUCH,
    contentHash: "x",
    validFrom: null,
    validUntil: null,
  });
const search = (kit: Kit, filter: Partial<LexicalFilter>) =>
  kit.lexical.search(ctx, "abc", { limit: 5, filter: { tenantId: ctx.tenantId, ...filter } });
const digestBand = { limit: 5, excludeMemoryIds: [] } as const;
const reinforceWith =
  (
    halfLifeRecalls: number | null,
    nowSeq: number | undefined,
    at: Date,
    extra: ReinforceOptions = {},
  ) =>
  async (kit: Kit) => {
    const memory = await kit.memory.createMemory(ctx, newMemory({ halfLifeRecalls }));
    return kit.memory.reinforce(ctx, memory.id, at, { nowSeq, ...extra });
  };
const emptyRecall = {
  query: {},
  budget: null,
  omitted: [],
  usage: {},
  indexBand: {},
  explain: {},
  returnedMemories: [],
} as unknown as NewRecallRecord;

/** 3件の active な Memory を作って、その id を返す（群の検出・解決の口に渡す）。 */
async function threeMemoryIds(kit: Kit): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push((await kit.memory.createMemory(ctx, newMemory())).id);
  }
  return ids;
}

interface Case {
  name: string;
  /** `reject`: 書き込みも読み取りも例外になる（Postgres は生の DB の例外、fixture は `message` の `Error`）。`accept`: 成功する。 */
  expect: "reject" | "accept";
  /** fixture の例外の文面（`reject` のときだけ）。 */
  message?: RegExp;
  run: (kit: Kit) => Promise<unknown>;
}

const NUL_MESSAGE = /must not contain NUL characters \(U\+0000\)/;
const INT4_MESSAGE =
  /sizeBeforeBytes (must be an integer|does not fit in a Postgres "integer" \(int4\) column)/;
const NOW_MESSAGE = /now must be a valid Date \(got Invalid Date\)/;

const CASES: Case[] = [
  // ---- 候補2: 書き込み（NUL） ----
  {
    name: "createMemory: claimKey.subject に NUL",
    expect: "reject",
    message: /claimKey\.subject must not contain NUL/,
    run: (k) => k.memory.createMemory(ctx, newMemory({ claimKey: claimKeyOf(NUL, "p") })),
  },
  {
    name: "createMemory: claimKey.predicate に NUL",
    expect: "reject",
    message: /claimKey\.predicate must not contain NUL/,
    run: (k) => k.memory.createMemory(ctx, newMemory({ claimKey: claimKeyOf("s", NUL) })),
  },
  {
    name: "createMemory: extractorVersion に NUL（観測なし）",
    expect: "reject",
    message: /extractorVersion must not contain NUL/,
    run: (k) => k.memory.createMemory(ctx, newMemory({ extractorVersion: NUL })),
  },
  {
    name: "createMemory: extractorVersion に NUL（観測あり）",
    expect: "reject",
    message: /extractorVersion must not contain NUL/,
    run: async (k) => {
      const base = await keyedMemory(k);
      return k.memory.createMemory(ctx, { ...base, extractorVersion: NUL });
    },
  },
  {
    name: "createMemory: 冪等の既存の行が在っても claimKey の NUL は拒む",
    expect: "reject",
    message: NUL_MESSAGE,
    run: async (k) => {
      const base = await keyedMemory(k);
      await k.memory.createMemory(ctx, base);
      return k.memory.createMemory(ctx, { ...base, claimKey: claimKeyOf(NUL, "p") });
    },
  },
  {
    name: "createMemory: NUL の無い claimKey・extractorVersion は通る",
    expect: "accept",
    run: async (k) => {
      const base = await keyedMemory(k);
      return k.memory.createMemory(ctx, { ...base, claimKey: claimKeyOf("s", "p") });
    },
  },
  {
    // ADR 0630: 以前は通った（書けて、読み戻すと MemorySchema を通らなかった）。今は入口で拒む。
    name: "createMemory: 空文字の extractorVersion は拒む（ADR 0630。以前は通った）",
    expect: "reject",
    message: /extractorVersion is malformed/,
    run: (k) => k.memory.createMemory(ctx, newMemory({ extractorVersion: "" })),
  },
  {
    name: "createMemory: NUL ではない制御文字・文字どおりの \\u0000 は通る",
    expect: "accept",
    run: (k) =>
      k.memory.createMemory(
        ctx,
        newMemory({ claimKey: claimKeyOf("a\u0001b", "a\\u0000b"), extractorVersion: "v\u0002" }),
      ),
  },
  {
    name: "createMemoryWithOutbox: claimKey.subject に NUL",
    expect: "reject",
    message: /claimKey\.subject must not contain NUL/,
    run: (k) =>
      k.memory.createMemoryWithOutbox(
        ctx,
        newMemory({ claimKey: claimKeyOf(NUL, "p") }),
        embedJobs,
      ),
  },
  {
    name: "createMemoryWithOutbox: extractorVersion に NUL",
    expect: "reject",
    message: /extractorVersion must not contain NUL/,
    run: (k) =>
      k.memory.createMemoryWithOutbox(ctx, newMemory({ extractorVersion: NUL }), embedJobs),
  },
  {
    name: "createMemoryWithOutbox: jobKinds の要素に NUL",
    expect: "reject",
    message: /jobKinds must not contain NUL/,
    run: (k) => k.memory.createMemoryWithOutbox(ctx, newMemory(), nulJob),
  },
  {
    name: "createMemoryWithOutbox: 冪等の既存の行に当たるときは、jobKinds の NUL を見ない",
    expect: "accept",
    run: async (k) => {
      const base = await keyedMemory(k);
      await k.memory.createMemoryWithOutbox(ctx, base, embedJobs);
      return k.memory.createMemoryWithOutbox(ctx, base, nulJob);
    },
  },
  {
    name: "createMemoryWithOutbox: NUL の無い jobKinds は通る",
    expect: "accept",
    run: (k) => k.memory.createMemoryWithOutbox(ctx, newMemory(), embedJobs),
  },
  {
    name: "createMemoryWithOutbox: NUL 以外の制御文字（SOH）を含む jobKinds の要素は通る",
    expect: "accept",
    run: (k) => k.memory.createMemoryWithOutbox(ctx, newMemory(), controlJob),
  },
  {
    name: "createObservationWithOutbox: NUL 以外の制御文字（SOH）を含む jobKinds の要素は通る",
    expect: "accept",
    run: (k) =>
      k.memory.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
        controlJob,
      ),
  },
  {
    name: "createObservationWithOutbox: jobKinds の要素に NUL",
    expect: "reject",
    message: /jobKinds must not contain NUL/,
    run: (k) =>
      k.memory.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
        nulJob,
      ),
  },
  {
    name: "createObservationWithOutbox: 冪等の既存の行に当たるときは、jobKinds の NUL を見ない",
    expect: "accept",
    run: async (k) => {
      const input = buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: "ext-1" });
      await k.memory.createObservationWithOutbox(ctx, input, ["extract"]);
      return k.memory.createObservationWithOutbox(ctx, input, nulJob);
    },
  },
  {
    name: "supersedeWithNewMemories: 新しい行の claimKey に NUL",
    expect: "reject",
    message: /claimKey\.subject must not contain NUL/,
    run: (k) =>
      supersede(k, [{ input: newMemory({ claimKey: claimKeyOf(NUL, "p") }), jobKinds: [] }]),
  },
  {
    name: "supersedeWithNewMemories: 新しい行の extractorVersion に NUL",
    expect: "reject",
    message: /extractorVersion must not contain NUL/,
    run: (k) => supersede(k, [{ input: newMemory({ extractorVersion: NUL }), jobKinds: [] }]),
  },
  {
    name: "supersedeWithNewMemories: jobKinds の要素に NUL",
    expect: "reject",
    message: /jobKinds must not contain NUL/,
    run: (k) => supersede(k, [{ input: newMemory(), jobKinds: nulJob }]),
  },
  {
    name: "supersedeWithNewMemories: 冪等の既存の行に当たるときは、jobKinds の NUL を見ない",
    expect: "accept",
    run: async (k) => {
      const base = await keyedMemory(k);
      await k.memory.createMemory(ctx, base);
      return supersede(k, [{ input: base, jobKinds: nulJob }]);
    },
  },
  {
    name: "supersedeWithNewMemories: NUL の無い新しい行は通る",
    expect: "accept",
    run: (k) =>
      supersede(k, [{ input: newMemory({ claimKey: claimKeyOf("s", "p") }), jobKinds: embedJobs }]),
  },
  {
    name: "createMemoriesWithOutboxAndEvents: claimKey に NUL（全候補が落ちて例外）",
    expect: "reject",
    message: /claimKey\.subject must not contain NUL/,
    run: (k) =>
      k.memory.createMemoriesWithOutboxAndEvents!(
        ctx,
        [{ input: newMemory({ claimKey: claimKeyOf(NUL, "p") }), jobKinds: [] }],
        createdEvent(),
      ),
  },
  {
    name: "createMemoriesWithOutboxAndEvents: jobKinds に NUL（全候補が落ちて例外）",
    expect: "reject",
    message: /jobKinds must not contain NUL/,
    run: (k) =>
      k.memory.createMemoriesWithOutboxAndEvents!(
        ctx,
        [{ input: newMemory(), jobKinds: nulJob }],
        createdEvent(),
      ),
  },
  {
    name: "createMemoriesWithOutboxAndEvents: 一部の候補だけ NUL なら、その候補だけ dropped で通る",
    expect: "accept",
    run: async (k) => {
      const r = await k.memory.createMemoriesWithOutboxAndEvents!(
        ctx,
        [
          { input: newMemory(), jobKinds: [] },
          { input: newMemory(), jobKinds: nulJob },
        ],
        createdEvent(),
      );
      if (r.written.length !== 1 || r.dropped.length !== 1)
        throw new Error(`written=${r.written.length} dropped=${r.dropped.length}`);
      return r;
    },
  },
  {
    name: "EventStore.append: digestSnapshot に NUL",
    expect: "reject",
    message: /digestSnapshot must not contain NUL/,
    run: (k) => k.events.append(ctx, newEvent({ digestSnapshot: NUL })),
  },
  {
    name: "EventStore.append: NUL の無い・null の digestSnapshot は通る",
    expect: "accept",
    run: async (k) => {
      await k.events.append(ctx, newEvent({ digestSnapshot: "ok\u0001" }));
      return k.events.append(ctx, newEvent({ digestSnapshot: null }));
    },
  },
  {
    name: "updateStatusWithEvent: digestSnapshot に NUL",
    expect: "reject",
    message: /digestSnapshot must not contain NUL/,
    run: async (k) => {
      const m = await k.memory.createMemory(ctx, newMemory());
      return k.memory.updateStatusWithEvent(
        ctx,
        m.id,
        "forgotten",
        {},
        newEvent({ memoryId: m.id, kind: "forgotten", digestSnapshot: NUL }),
      );
    },
  },
  {
    name: "purgeMemory: 墓石の content に NUL",
    expect: "reject",
    message: /tombstone\.content must not contain NUL/,
    run: async (k) => {
      const m = await forgottenMemory(k);
      return k.memory.purgeMemory!(
        ctx,
        m.id,
        { content: NUL, digest: "d" },
        newEvent({ memoryId: m.id, kind: "purged" }),
      );
    },
  },
  {
    name: "purgeMemory: 墓石の digest に NUL",
    expect: "reject",
    message: /tombstone\.digest must not contain NUL/,
    run: async (k) => {
      const m = await forgottenMemory(k);
      return k.memory.purgeMemory!(
        ctx,
        m.id,
        { content: "c", digest: NUL },
        newEvent({ memoryId: m.id, kind: "purged" }),
      );
    },
  },
  {
    name: "purgeMemory: 対象が無くても、墓石の NUL は拒む（行を引く前に見る）",
    expect: "reject",
    message: /tombstone\.content must not contain NUL/,
    run: (k) =>
      k.memory.purgeMemory!(
        ctx,
        NO_SUCH,
        { content: NUL, digest: "d" },
        newEvent({ memoryId: NO_SUCH, kind: "purged" }),
      ),
  },
  {
    name: "purgeMemory: NUL の無い墓石は通る",
    expect: "accept",
    run: async (k) => {
      const m = await forgottenMemory(k);
      return k.memory.purgeMemory!(
        ctx,
        m.id,
        { content: "c\u0001", digest: "d" },
        newEvent({ memoryId: m.id, kind: "purged" }),
      );
    },
  },

  // ---- 候補2: 読み取り（NUL） ----
  {
    name: "findActiveByClaimKey: claimKey.subject に NUL",
    expect: "reject",
    message: /claimKey\.subject must not contain NUL/,
    run: (k) => find(k, claimKeyOf(NUL, "p")),
  },
  {
    name: "findActiveByClaimKey: claimKey.predicate に NUL",
    expect: "reject",
    message: /claimKey\.predicate must not contain NUL/,
    run: (k) => find(k, claimKeyOf("s", NUL)),
  },
  {
    name: "findActiveByClaimKey: NUL の無い claimKey は通る",
    expect: "accept",
    run: (k) => find(k, claimKeyOf("s", "p\u0001")),
  },
  {
    name: "listBySourceObservation: extractorVersion に NUL",
    expect: "reject",
    message: /extractorVersion must not contain NUL/,
    run: (k) => k.memory.listBySourceObservation(ctx, NO_SUCH, NUL),
  },
  {
    name: "listBySourceObservation: NUL の無い・null の extractorVersion は通る",
    expect: "accept",
    run: async (k) => {
      await k.memory.listBySourceObservation(ctx, NO_SUCH, "v1");
      return k.memory.listBySourceObservation(ctx, NO_SUCH, null);
    },
  },
  {
    name: "aggregateScope: attributes のキーに NUL",
    expect: "reject",
    message: /attributes must not contain NUL/,
    run: (k) => k.memory.aggregateScope(ctx, { attributes: { [NUL]: "x" } }),
  },
  {
    name: "aggregateScope: attributes の値に NUL",
    expect: "reject",
    message: /attributes must not contain NUL/,
    run: (k) => k.memory.aggregateScope(ctx, { attributes: { a: NUL } }),
  },
  {
    name: "aggregateScope: labels に NUL",
    expect: "reject",
    message: /labels must not contain NUL/,
    run: (k) => k.memory.aggregateScope(ctx, { labels: ["ok", NUL] }),
  },
  {
    name: "aggregateScope: skip でも digestBand があれば attributes の NUL を拒む",
    expect: "reject",
    message: /attributes must not contain NUL/,
    run: (k) =>
      k.memory.aggregateScope(
        ctx,
        { attributes: { a: NUL } },
        { scopeAggregate: "skip", digestBand },
      ),
  },
  {
    name: "aggregateScope: skip で digestBand が無いときは、Postgres がクエリを発行しないので NUL を見ない",
    expect: "accept",
    run: (k) =>
      k.memory.aggregateScope(
        ctx,
        { attributes: { a: NUL }, labels: [NUL] },
        { scopeAggregate: "skip" },
      ),
  },
  {
    name: "aggregateScope: NUL の無い attributes・labels、空の labels・attributes は通る",
    expect: "accept",
    run: async (k) => {
      await k.memory.aggregateScope(ctx, { attributes: { a: "x\u0001" }, labels: ["l"] });
      await k.memory.aggregateScope(ctx, { attributes: {}, labels: [] });
      return k.memory.aggregateScope(ctx, {});
    },
  },
  {
    name: "LexicalStore.search: filter.attributes の値に NUL",
    expect: "reject",
    message: /filter\.attributes must not contain NUL/,
    run: (k) => search(k, { attributes: { a: NUL } }),
  },
  {
    name: "LexicalStore.search: filter.attributes のキーに NUL",
    expect: "reject",
    message: /filter\.attributes must not contain NUL/,
    run: (k) => search(k, { attributes: { [NUL]: "x" } }),
  },
  {
    name: "LexicalStore.search: NUL の無い・空の filter.attributes は通る",
    expect: "accept",
    run: async (k) => {
      await search(k, { attributes: { a: "x\u0001" } });
      return search(k, { attributes: {} });
    },
  },
  {
    name: "getSubjectActivitySeqs: subjectId に NUL",
    expect: "reject",
    message: /subjectIds\[1\] contains a NUL character/, // ADR 0437: MalformedIdentifierError が先に断る
    run: (k) => k.tenantSettings.getSubjectActivitySeqs!(ctx, ["ok", NUL]),
  },
  {
    name: "getSubjectActivitySeqs: NUL の無い・空の subjectIds は通る",
    expect: "accept",
    run: async (k) => {
      await k.tenantSettings.getSubjectActivitySeqs!(ctx, ["x\u0001"]);
      return k.tenantSettings.getSubjectActivitySeqs!(ctx, []);
    },
  },

  // ---- 候補3: sizeBeforeBytes（int4） ----
  ...(
    [
      ["2^31（int4 の最大値 + 1）", I32, "reject"],
      ["-2^31 - 1（int4 の最小値 - 1）", -I32 - 1, "reject"],
      ["小数 1.5", 1.5, "reject"],
      ["NaN", Number.NaN, "reject"],
      ["Infinity", Number.POSITIVE_INFINITY, "reject"],
      ["-Infinity", Number.NEGATIVE_INFINITY, "reject"],
      ["2^31 - 1（int4 の最大値）", I32 - 1, "accept"],
      ["-2^31（int4 の最小値）", -I32, "accept"],
      ["0", 0, "accept"],
      ["-1（列に CHECK は無いので負も通る）", -1, "accept"],
      ["null", null, "accept"],
    ] as Array<[string, number | null, "reject" | "accept"]>
  ).map(([label, value, expectation]): Case => ({
    name: `EventStore.append: sizeBeforeBytes が ${label}`,
    expect: expectation,
    message: INT4_MESSAGE,
    run: (k) => k.events.append(ctx, newEvent({ sizeBeforeBytes: value })),
  })),
  ...(
    [
      ["2^31", I32, "reject"],
      ["2^31 - 1", I32 - 1, "accept"],
      ["1.5", 1.5, "reject"],
      ["NaN", Number.NaN, "reject"],
    ] as Array<[string, number, "reject" | "accept"]>
  ).flatMap(([label, value, expectation]): Case[] => [
    {
      name: `updateStatusWithEvent: sizeBeforeBytes が ${label}`,
      expect: expectation,
      message: INT4_MESSAGE,
      run: async (k) => {
        const m = await k.memory.createMemory(ctx, newMemory());
        return k.memory.updateStatusWithEvent(
          ctx,
          m.id,
          "forgotten",
          {},
          newEvent({ memoryId: m.id, kind: "forgotten", sizeBeforeBytes: value }),
        );
      },
    },
    {
      name: `purgeMemory: event.sizeBeforeBytes が ${label}`,
      expect: expectation,
      message: INT4_MESSAGE,
      run: async (k) => {
        const m = await forgottenMemory(k);
        return k.memory.purgeMemory!(
          ctx,
          m.id,
          { content: "c", digest: "d" },
          newEvent({ memoryId: m.id, kind: "purged", sizeBeforeBytes: value }),
        );
      },
    },
    {
      name: `supersedeWithNewMemories: 旧い行の event.sizeBeforeBytes が ${label}`,
      expect: expectation,
      message: INT4_MESSAGE,
      run: (k) =>
        supersede(k, [{ input: newMemory(), jobKinds: [] }], undefined, { sizeBeforeBytes: value }),
    },
    {
      name: `createMemoriesWithOutboxAndEvents: created イベントの sizeBeforeBytes が ${label}`,
      expect: expectation,
      message: INT4_MESSAGE,
      run: (k) =>
        k.memory.createMemoriesWithOutboxAndEvents!(
          ctx,
          [{ input: newMemory(), jobKinds: [] }],
          createdEvent({ sizeBeforeBytes: value }),
        ),
    },
  ]),
  {
    name: "updateStatusWithEvent: CAS に弾かれるときは、sizeBeforeBytes を見ずに競合の例外になる",
    expect: "reject",
    message: /expected status|status/i,
    run: async (k) => {
      const m = await k.memory.createMemory(ctx, newMemory());
      return k.memory.updateStatusWithEvent(
        ctx,
        m.id,
        "archived",
        { expectedStatus: "forgotten" },
        newEvent({ memoryId: m.id, kind: "archived", sizeBeforeBytes: I32 }),
      );
    },
  },

  // `markContestedGroup`・`resolveContestedGroup` は、Postgres が複数のイベントを1つの `jsonb` の配列で渡す。
  // `NaN`・`±Infinity` は `JSON.stringify` で `null` になって通る（他の口と、ここだけ違う）。
  ...(
    [
      ["NaN", Number.NaN, "accept"],
      ["Infinity", Number.POSITIVE_INFINITY, "accept"],
      ["2^31 - 1", I32 - 1, "accept"],
      ["1.5", 1.5, "reject"],
      ["2^31", I32, "reject"],
    ] as Array<[string, number, "reject" | "accept"]>
  ).flatMap(([label, value, expectation]): Case[] => [
    {
      name: `markContestedGroup: sizeBeforeBytes が ${label}`,
      expect: expectation,
      message: INT4_MESSAGE,
      run: async (k) => {
        const ids = await threeMemoryIds(k);
        return k.memory.markContestedGroup!(
          ctx,
          ids.map((id) => ({
            id,
            event: newEvent({ memoryId: id, kind: "updated", sizeBeforeBytes: value }),
          })),
        );
      },
    },
    {
      name: `resolveContestedGroup: sizeBeforeBytes が ${label}`,
      expect: expectation,
      message: INT4_MESSAGE,
      run: async (k) => {
        const ids = await threeMemoryIds(k);
        await k.memory.markContestedGroup!(
          ctx,
          ids.map((id) => ({ id, event: newEvent({ memoryId: id, kind: "updated" }) })),
        );
        return k.memory.resolveContestedGroup!(
          ctx,
          ids.map((id) => ({
            id,
            status: "active" as const,
            event: newEvent({ memoryId: id, kind: "updated", sizeBeforeBytes: value }),
          })),
        );
      },
    },
  ]),

  // ---- 候補3: reinforce の nowSeq ----
  ...(
    [
      ["負（-1）", -1],
      ["小数 1.5", 1.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
      ["2^63（bigint の最大値を超える）", 2 ** 63],
    ] as Array<[string, number]>
  ).map(([label, value]): Case => ({
    name: `reinforce: halfLifeRecalls を持つ Memory に nowSeq が ${label}`,
    expect: "reject",
    message: /nowSeq must|decayBaseSeq must not be negative/,
    run: reinforceWith(10, value, AT),
  })),
  ...(
    [
      ["0", 0],
      ["1", 1],
      ["2^53", 2 ** 53],
      ["2^62", 2 ** 62],
      ["Number.MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
      ["2^63 未満で最大の double", 2 ** 63 - 1024],
      ["-0", -0],
    ] as Array<[string, number]>
  ).map(([label, value]): Case => ({
    name: `reinforce: nowSeq が ${label} なら通る`,
    expect: "accept",
    run: reinforceWith(10, value, AT),
  })),
  {
    name: "reinforce: nowSeq を省略すれば通る",
    expect: "accept",
    run: reinforceWith(10, undefined, AT),
  },
  {
    name: "reinforce: halfLifeRecalls を持たない Memory なら、nowSeq が NaN・負・小数でも見ない（使われない）",
    expect: "accept",
    run: async (k) => {
      await reinforceWith(null, Number.NaN, AT)(k);
      await reinforceWith(null, -1, AT)(k);
      return reinforceWith(null, 1.5, AT)(k);
    },
  },
  {
    name: "reinforce: 何も書かない（起点より古い at の）呼び出しでも、nowSeq が NaN なら拒む",
    expect: "reject",
    message: /nowSeq must be an integer/,
    run: reinforceWith(10, Number.NaN, new Date("2020-01-01T00:00:00.000Z")),
  },
  {
    name: "reinforce: 何も書かない呼び出しでは、負の nowSeq は CHECK 制約に当たらず通る",
    expect: "accept",
    run: reinforceWith(10, -1, new Date("2020-01-01T00:00:00.000Z")),
  },
  {
    name: "reinforce: addOwnSubjectSeq でも、書く値（nowSeq + S_x）が負なら拒む",
    expect: "reject",
    message: /decayBaseSeq must not be negative/,
    run: reinforceWith(10, -1, AT, { addOwnSubjectSeq: true }),
  },
  {
    name: "reinforceMany: nowSeq が NaN",
    expect: "reject",
    message: /nowSeq must be an integer/,
    run: async (k) => {
      const m = await k.memory.createMemory(ctx, newMemory({ halfLifeRecalls: 10 }));
      return k.memory.reinforceMany!(ctx, [m.id], AT, { nowSeq: Number.NaN });
    },
  },
  {
    name: "reinforceMany: 対象が空なら、nowSeq が NaN でも通る",
    expect: "accept",
    run: (k) => k.memory.reinforceMany!(ctx, [], AT, { nowSeq: Number.NaN }),
  },
  {
    name: "recordUsageAndReinforce: nowSeq が NaN",
    expect: "reject",
    message: /nowSeq must be an integer/,
    run: async (k) => {
      const m = await k.memory.createMemory(ctx, newMemory({ halfLifeRecalls: 10 }));
      const recallId = await k.memory.createRecall(ctx, emptyRecall);
      return k.memory.recordUsageAndReinforce!(ctx, recallId, [m.id], AT, { nowSeq: Number.NaN });
    },
  },

  // ---- 候補3: opts.now の Invalid Date（outbox の行を実際に書くときだけ） ----
  {
    name: "createMemoryWithOutbox: now が Invalid Date（jobKinds あり）",
    expect: "reject",
    message: NOW_MESSAGE,
    run: (k) => k.memory.createMemoryWithOutbox(ctx, newMemory(), embedJobs, { now: INVALID }),
  },
  {
    name: "createMemoryWithOutbox: jobKinds が空なら now を見ない",
    expect: "accept",
    run: (k) => k.memory.createMemoryWithOutbox(ctx, newMemory(), [], { now: INVALID }),
  },
  {
    name: "createMemoryWithOutbox: 冪等の既存の行に当たるときは now を見ない",
    expect: "accept",
    run: async (k) => {
      const base = await keyedMemory(k);
      await k.memory.createMemoryWithOutbox(ctx, base, embedJobs);
      return k.memory.createMemoryWithOutbox(ctx, base, embedJobs, { now: INVALID });
    },
  },
  {
    name: "createMemoryWithOutbox: 有効な now（遠い未来の境界）は通る",
    expect: "accept",
    run: (k) =>
      k.memory.createMemoryWithOutbox(ctx, newMemory(), embedJobs, { now: new Date(8.64e15) }),
  },
  {
    name: "createObservationWithOutbox: now が Invalid Date（jobKinds あり）",
    expect: "reject",
    message: NOW_MESSAGE,
    run: (k) =>
      k.memory.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
        ["extract"],
        { now: INVALID },
      ),
  },
  {
    name: "createObservationWithOutbox: jobKinds が空なら now を見ない",
    expect: "accept",
    run: (k) =>
      k.memory.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
        [],
        { now: INVALID },
      ),
  },
  {
    name: "createObservationWithOutbox: 冪等の既存の行に当たるときは now を見ない",
    expect: "accept",
    run: async (k) => {
      const input = buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: "ext-2" });
      await k.memory.createObservationWithOutbox(ctx, input, ["extract"]);
      return k.memory.createObservationWithOutbox(ctx, input, ["extract"], { now: INVALID });
    },
  },
  {
    name: "createObservationWithOutbox: 有効な now は通る",
    expect: "accept",
    run: (k) =>
      k.memory.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
        ["extract"],
        { now: AT },
      ),
  },
  {
    name: "requeueEmbedJobs: writeOpts.now が Invalid Date（対象が1件）",
    expect: "reject",
    message: NOW_MESSAGE,
    run: async (k) => {
      await k.memory.createMemory(ctx, newMemory());
      return k.memory.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 10 }, { now: INVALID });
    },
  },
  {
    name: "requeueEmbedJobs: writeOpts.now が Invalid Date（対象が0件でも拒む）",
    expect: "reject",
    message: NOW_MESSAGE,
    run: (k) =>
      k.memory.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 10 }, { now: INVALID }),
  },
  {
    name: "requeueEmbedJobs: writeOpts.now が Invalid Date（limit 0 でも拒む）",
    expect: "reject",
    message: NOW_MESSAGE,
    run: (k) =>
      k.memory.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 0 }, { now: INVALID }),
  },
  {
    name: "requeueEmbedJobs: memoryIds が空配列なら、Postgres はクエリを発行しないので now を見ない",
    expect: "accept",
    run: (k) =>
      k.memory.requeueEmbedJobs(
        ctx,
        { statuses: ["pending"], limit: 10, memoryIds: [] },
        { now: INVALID },
      ),
  },
  {
    name: "requeueEmbedJobs: 有効な now・省略は通る",
    expect: "accept",
    run: async (k) => {
      await k.memory.requeueEmbedJobs(ctx, { statuses: ["pending"], limit: 10 }, { now: AT });
      return k.memory.requeueEmbedJobs(
        ctx,
        { statuses: ["pending"], limit: 10 },
        { now: undefined },
      );
    },
  },
  {
    name: "supersedeWithNewMemories: now が Invalid Date（jobKinds あり）",
    expect: "reject",
    message: NOW_MESSAGE,
    run: (k) => supersede(k, [{ input: newMemory(), jobKinds: embedJobs }], { now: INVALID }),
  },
  {
    name: "supersedeWithNewMemories: jobKinds が空なら now を見ない",
    expect: "accept",
    run: (k) => supersede(k, [{ input: newMemory(), jobKinds: [] }], { now: INVALID }),
  },
  {
    name: "supersedeWithNewMemories: 冪等の既存の行に当たるときは now を見ない",
    expect: "accept",
    run: async (k) => {
      const base = await keyedMemory(k);
      await k.memory.createMemory(ctx, base);
      return supersede(k, [{ input: base, jobKinds: embedJobs }], { now: INVALID });
    },
  },
  {
    name: "createMemoriesWithOutboxAndEvents: now が Invalid Date（jobKinds あり、全候補が落ちて例外）",
    expect: "reject",
    message: NOW_MESSAGE,
    run: (k) =>
      k.memory.createMemoriesWithOutboxAndEvents!(
        ctx,
        [{ input: newMemory(), jobKinds: embedJobs }],
        createdEvent(),
        { now: INVALID },
      ),
  },
  {
    name: "createMemoriesWithOutboxAndEvents: jobKinds が空なら now を見ない",
    expect: "accept",
    run: (k) =>
      k.memory.createMemoriesWithOutboxAndEvents!(
        ctx,
        [{ input: newMemory(), jobKinds: [] }],
        createdEvent(),
        { now: INVALID },
      ),
  },
  {
    name: "createMemoriesWithOutboxAndEvents: 一部の候補だけ jobKinds があれば、その候補だけ dropped で通る",
    expect: "accept",
    run: async (k) => {
      const r = await k.memory.createMemoriesWithOutboxAndEvents!(
        ctx,
        [
          { input: newMemory(), jobKinds: [] },
          { input: newMemory(), jobKinds: embedJobs },
        ],
        createdEvent(),
        { now: INVALID },
      );
      if (r.written.length !== 1 || r.dropped.length !== 1)
        throw new Error(`written=${r.written.length} dropped=${r.dropped.length}`);
      return r;
    },
  },
  {
    name: "createMemoriesWithOutboxAndEvents: 有効な now は通る",
    expect: "accept",
    run: (k) =>
      k.memory.createMemoriesWithOutboxAndEvents!(
        ctx,
        [{ input: newMemory(), jobKinds: embedJobs }],
        createdEvent(),
        { now: AT },
      ),
  },
];

function registerCases(kits: Array<[string, () => Promise<Kit>]>): void {
  for (const [kitName, makeKit] of kits) {
    describe(`${kitName}: NUL・数値・日時・purgedAt の入力（Postgres と同じ入力で断る／通す）`, () => {
      for (const c of CASES) {
        it(`${c.expect === "reject" ? "拒む" : "通る"}: ${c.name}`, async () => {
          const kit = await makeKit();
          if (c.expect === "reject") {
            const assertion = expect(c.run(kit)).rejects;
            if (kitName === "InMemory" && c.message !== undefined) {
              await assertion.toThrow(c.message);
            } else {
              await assertion.toThrow();
            }
          } else {
            await expect(c.run(kit)).resolves.not.toThrow();
          }
        });
      }

      // ---- 候補4: purgedAt ----
      it("createMemory に purgedAt を渡しても保存せず、null で読み戻る（断らない）", async () => {
        const kit = await makeKit();
        const created = await kit.memory.createMemory(ctx, newMemory({ purgedAt: AT }));
        expect(created.purgedAt ?? null).toBeNull();
        expect((await kit.memory.get(ctx, created.id))?.purgedAt ?? null).toBeNull();
      });
      it("createMemoryWithOutbox に purgedAt を渡しても保存しない", async () => {
        const kit = await makeKit();
        const { memory } = await kit.memory.createMemoryWithOutbox(
          ctx,
          newMemory({ purgedAt: AT }),
          embedJobs,
        );
        expect(memory.purgedAt ?? null).toBeNull();
      });
      it("purgedAt を渡して作った forgotten の Memory は、purgeMemory の対象になる（purged 済みの扱いにならない）", async () => {
        const kit = await makeKit();
        const created = await kit.memory.createMemory(ctx, newMemory({ purgedAt: AT }));
        await kit.memory.updateStatus(ctx, created.id, "forgotten");
        const result = await kit.memory.purgeMemory!(
          ctx,
          created.id,
          { content: "c", digest: "d" },
          newEvent({ memoryId: created.id, kind: "purged" }),
        );
        expect(result.memory.purgedAt).toBeInstanceOf(Date);
        expect(result.memory.purgedAt).not.toEqual(AT);
      });
    });
  }
}

registerCases([["InMemory", inMemoryKit]]);
