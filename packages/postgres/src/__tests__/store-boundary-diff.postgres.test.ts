import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isContestedWithoutCompanionError,
  isMemoryPurgeConflictError,
  isMemoryStatusConflictError,
  isOutboxLeaseConflictError,
} from "@mnemora/core";
import type {
  ClaimOutboxJobsOptions,
  Ctx,
  TenantSettingsStore,
  EventStore,
  LexicalStore,
  MemoryEvent,
  MemoryStore,
  NewMemoryEvent,
  NewRecallRecord,
  OutboxJobRecord,
  OutboxStore,
  RecallId,
  VectorEntry,
  VectorStore,
} from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { closeTestClient, getTestClient, TEST_EMBEDDING_SPACE } from "./test-db.js";

/**
 * store の公開の口に、同じ境界の入力を2実装（`@mnemora/postgres` と `@mnemora/testkit/fixtures`）へ流し、
 * 戻り値と状態の差が**許可リストの差だけ**であることを縛る（PR #1252 の差分の探りを常設にしたもの）。
 *
 * - 当てるのは、store を直接呼ぶ境界の入力である。Runtime の正しい入力の操作列は
 *   `write-diff-fuzz.postgres.test.ts` が見るので、ここでは重ねない。
 * - id を取る口には5つの値（同じテナントの在る id・形の正しい無い id・形の崩れた id・空文字・他テナントの id）を
 *   当てる。あわせて、空配列・重複・壊れたベクトル・空の文字列などの境界を当てる（下の `scenarios`）。
 * - 比べるもの: 戻り値（投げたか・返した値。id・テナント・時刻は別名に伏せ、鍵を並べ替える）と、その後の状態
 *   （自分のテナントの記憶2件の status・参照・本文・強化・埋め込みの状態、イベントの kind と memoryId、
 *   呼んだテナントで記憶2件と他テナントの記憶の id が持つベクトル、他テナントの記憶・イベント・ベクトル）。
 *   ⚠ 例外の文面は比べない。種類も、interface の TSDoc が約束する4クラス（`ContestedWithoutCompanionError`・
 *   `MemoryStatusConflictError`・`MemoryPurgeConflictError`・`OutboxLeaseConflictError`）のときだけ比べる——クラス名と
 *   約束の欄（id は別名に、時刻は `<t>` に伏せる）。それ以外の例外は「投げた」とだけ比べる（DB の例外と fixture の
 *   `Error` は顔が違う。`packages/testkit/src/fixtures.ts` の冒頭）。
 * - 約束の4クラスを出す場面は、(口, クラス) の13組すべてを `TYPED_THROWS` に持ち、2実装とも約束のクラスと欄で
 *   投げることを縛る（差が出ないだけでは、2実装が同じく約束を破っていても緑になるため）。
 *
 * 🔴 **許可リスト（`DOCUMENTED_DIFFERENCES`）は、doc に「違う」と書いてある差と、揃える先が未決で Issue に在る差だけを持つ。**
 * - 許可リストの外で差が出たら落ちる。直すか（fixture は Postgres を写す）、doc か Issue に書いてから足すこと。
 * - 許可リストの場面で差が出なくなったら（揃ったら）、それも落ちる（リストが古い）。消すこと。
 * - 各項目は、doc に書いた**向き**（どちらが投げ、どちらが返すか）と、ベクトルを書く場面では書いた後に
 *   保存されているベクトルを持つ。差が残っていても、向きや保存の中身が doc と違えば落ちる。
 */

/** 戻り値の形（`Outcome.result` から読む）。 */
type ResultKind = "throws" | "returns-null" | "returns-value";

/** `snapshotState` の `vectors` の1件（成分は有限でなければ文字列にして持つ。JSON で `NaN` が `null` に潰れるため）。 */
type StoredVector = Array<number | string> | null;

interface DocumentedDifference {
  /** どこに「違う」と書いてあるか（doc の節、または揃える先が未決の Issue）。 */
  where: string;
  postgres: ResultKind;
  fixture: ResultKind;
  /** 書いた後に、呼んだテナントで `memory` の別名が持つベクトル（無ければ `null`）。 */
  vector?: { memory: "SELF" | "OTHER"; postgres: StoredVector; fixture: StoredVector };
}

const BROKEN_VECTOR_DOC =
  "VectorStore.upsert の TSDoc の adapter ごとの表（docs/architecture.md §5.5 の 2026-09-27 追記も同じ）";

/** 場面の名前 → doc に書いた差（向きと、書いた後のベクトル）。 */
const DOCUMENTED_DIFFERENCES: Readonly<Record<string, DocumentedDifference>> = {
  "vector.upsert(self,[])": {
    where: `空のベクトル: Postgres は拒んで前の埋め込みを残し、fixture は保存する（${BROKEN_VECTOR_DOC}。Issue #1070 はこれを doc に書いて閉じた）`,
    postgres: "throws",
    fixture: "returns-null",
    vector: { memory: "SELF", postgres: [1, 0, 0], fixture: [] },
  },
  "vector.upsert(self,[1,0])（次元違い）": {
    where: `長さが space.dimensions と違うベクトル: Postgres は拒んで前の埋め込みを残し、fixture は保存する（${BROKEN_VECTOR_DOC}。Issue #1070 はこれを doc に書いて閉じた）`,
    postgres: "throws",
    fixture: "returns-null",
    vector: { memory: "SELF", postgres: [1, 0, 0], fixture: [1, 0] },
  },
};

const SPACE = TEST_EMBEDDING_SPACE;

interface Stores {
  ms: Required<MemoryStore>;
  vs: Required<Pick<VectorStore, "upsert" | "search" | "delete" | "getVectors">>;
  es: EventStore;
  os: OutboxStore;
  ls: LexicalStore;
  ts: Required<TenantSettingsStore>;
}

type Backend = "pg" | "testkit";

let scenarioSeq = 0;
const runTag = Math.random().toString(36).slice(2, 7);

/** recall の記録の既定の形（中身は使わない。境界の場面は一部の欄だけを差し替える）。 */
function newRecallRecord(ctx: Ctx): NewRecallRecord {
  return {
    tenantId: ctx.tenantId,
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
}

async function makeKit(backend: Backend) {
  scenarioSeq += 1;
  const ctx: Ctx = { tenantId: `bd${scenarioSeq}-${backend}-${runTag}` };
  const other: Ctx = { tenantId: `bo${scenarioSeq}-${backend}-${runTag}` };
  let s: Stores;
  if (backend === "pg") {
    const { db } = await getTestClient();
    s = {
      ms: new PostgresMemoryStore(db) as Required<MemoryStore>,
      vs: new PostgresVectorStore(db) as Stores["vs"],
      es: new PostgresEventStore(db),
      os: new PostgresOutboxStore(db),
      ls: new PostgresLexicalStore(db),
      ts: new PostgresTenantSettingsStore(db) as Required<TenantSettingsStore>,
    };
  } else {
    const ms = new InMemoryMemoryStore();
    s = {
      ms: ms as Required<MemoryStore>,
      vs: new InMemoryVectorStore(ms) as Stores["vs"],
      es: new InMemoryEventStore(ms, ms.events),
      os: new InMemoryOutboxStore(ms.outboxJobs),
      ls: new InMemoryLexicalStore(ms),
      ts: new InMemoryTenantSettingsStore(ms.activitySeq) as Required<TenantSettingsStore>,
    };
  }
  const obs = await s.ms.createObservation(
    ctx,
    buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: "e1" }),
  );
  const m = await s.ms.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: "self",
      sourceObservationId: obs.id,
      extractorVersion: "v1",
      content: "東京 に 住んで いる",
      digest: "東京",
      // 2件の記憶の記録時刻をずらす——同じ時刻だと、並びの同点が id（2実装で形が違う）に落ちる。
      recordedAt: new Date(Date.now() - 120_000),
    }),
  );
  const m2 = await s.ms.createMemory(
    ctx,
    buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: "self2",
      content: "大阪",
      digest: "大阪",
    }),
  );
  await s.vs.upsert(ctx, SPACE, m.id, [1, 0, 0]);
  const oobs = await s.ms.createObservation(
    other,
    buildNewObservationFixture({ tenantId: other.tenantId }),
  );
  const om = await s.ms.createMemory(
    other,
    buildNewMemoryFixture({ tenantId: other.tenantId, contentHash: "other" }),
  );
  const ev = await s.es.append(ctx, event(ctx, m.id));
  const oev = await s.es.append(other, event(other, om.id));
  const recallId: RecallId = await s.ms.createRecall(ctx, newRecallRecord(ctx));
  const alias = new Map<string, string>([
    [m.id, "SELF"],
    [m2.id, "SELF2"],
    [obs.id, "OBS"],
    [om.id, "OTHER"],
    [oobs.id, "OOBS"],
    [ev.id, "EV"],
    [oev.id, "OEV"],
    [recallId, "RECALL"],
    [ctx.tenantId, "CTX"],
    [other.tenantId, "OTHER_T"],
  ]);
  return { s, ctx, other, m, m2, obs, om, oobs, ev, oev, recallId, alias };
}

type Kit = Awaited<ReturnType<typeof makeKit>>;
type Target = "m" | "obs" | "ev";

function event(
  ctx: Ctx,
  memoryId: string | null,
  kind: NewMemoryEvent["kind"] = "updated",
): NewMemoryEvent {
  return { tenantId: ctx.tenantId, memoryId, kind, actor: { type: "system" }, meta: {} };
}

const ID_VALUES: Record<string, (h: Kit, target: Target) => string> = {
  self: (h, target) => ({ m: h.m.id, obs: h.obs.id, ev: h.ev.id })[target],
  missing: () => "00000000-0000-4000-8000-000000000000",
  malformed: () => "not-a-uuid",
  empty: () => "",
  other: (h, target) => ({ m: h.om.id, obs: h.oobs.id, ev: h.oev.id })[target],
};

const TIME_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "at",
  "recordedAt",
  "decayFloorAt",
  "lastReinforcedAt",
  "occurredAt",
  "claimedAt",
  "availableAt",
  "completedAt",
  "failedAt",
  "purgedAt",
  "observedPurgedAt",
  "registeredAt",
  "oldestPurgedAt",
  "newestPurgedAt",
]);
const GENERATED_ID = /^(mem|obs|evt|rec|rcl|job|recall|ev)-\d+$|^[0-9a-f]{8}-[0-9a-f]{4}-/;

/** id・テナント・時刻を別名に伏せ、鍵を並べ替えた形にする（2実装で同じになるべき形）。 */
function normalize(value: unknown, h: Kit): unknown {
  const masked: unknown = JSON.parse(
    JSON.stringify(value ?? null, (key, x: unknown) => {
      if (TIME_KEYS.has(key)) return x == null ? x : "<t>";
      if (typeof x === "string" && h.alias.has(x)) return h.alias.get(x);
      if (typeof x === "string" && GENERATED_ID.test(x)) return "<new>";
      return x;
    }),
  );
  const sortKeys = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sortKeys)
      : x !== null && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, sortKeys((x as Record<string, unknown>)[k])]),
          )
        : x;
  return sortKeys(masked);
}

async function snapshotState(h: Kit): Promise<string> {
  const mems = await h.s.ms.getMany(h.ctx, [h.m.id, h.m2.id]);
  const others = await h.s.ms.getMany(h.other, [h.om.id]);
  const events = await h.s.es.list(h.ctx, { limit: 100 });
  const otherEvents = await h.s.es.list(h.other, { limit: 100 });
  // ベクトルは別名 → 成分で持つ（「保存されたか」を doc の向きと照らすため）。他テナントの記憶の id も、
  // 呼んだテナントで引く（Postgres は他テナントの memoryId を呼んだテナントの行として書く）。
  const storedVectors = (entries: VectorEntry[]): Record<string, StoredVector> =>
    Object.fromEntries(
      entries.map((e) => [
        h.alias.get(e.memoryId) ?? "<unknown>",
        e.vector.map((x) => (Number.isFinite(x) ? x : String(x))),
      ]),
    );
  const vectors = storedVectors(await h.s.vs.getVectors(h.ctx, SPACE, [h.m.id, h.m2.id, h.om.id]));
  const otherVectors = storedVectors(await h.s.vs.getVectors(h.other, SPACE, [h.om.id]));
  const n = normalize(
    {
      mems: mems.map((x) => [
        x.status,
        x.embeddingStatus,
        x.supersededById,
        x.contestedWithId,
        x.content,
        x.lastReinforcedAt ? 1 : 0,
      ]),
      others: others.map((x) => [x.status, x.content]),
      events: events.map((e: MemoryEvent) => [e.kind, e.memoryId]),
      otherEvents: otherEvents.length,
      vectors,
      otherVectors,
    },
    h,
  ) as { mems: unknown[]; events: unknown[] };
  n.mems.sort();
  n.events.sort();
  return JSON.stringify(n);
}

const later = () => new Date(Date.now() + 60_000);
const scenarios: Array<[string, (h: Kit) => Promise<unknown>]> = [];
const add = (name: string, f: (h: Kit) => Promise<unknown>) => scenarios.push([name, f]);

for (const [idKind, pick] of Object.entries(ID_VALUES)) {
  const id = (h: Kit, target: Target = "m") => pick(h, target);
  add(`getObservation(${idKind})`, (h) => h.s.ms.getObservation(h.ctx, id(h, "obs")));
  add(`get(${idKind})`, (h) => h.s.ms.get(h.ctx, id(h)));
  add(`getMany([${idKind}])`, (h) => h.s.ms.getMany(h.ctx, [id(h)]));
  add(`getMany([self,${idKind}])`, (h) => h.s.ms.getMany(h.ctx, [h.m.id, id(h)]));
  add(`listBySourceObservation(${idKind},v1)`, (h) =>
    h.s.ms.listBySourceObservation(h.ctx, id(h, "obs"), "v1"),
  );
  add(`updateStatus(${idKind},archived)`, (h) => h.s.ms.updateStatus(h.ctx, id(h), "archived"));
  add(`updateStatus(self,superseded,{supersededById:${idKind}})`, (h) =>
    h.s.ms.updateStatus(h.ctx, h.m.id, "superseded", { supersededById: id(h) }),
  );
  add(`updateStatusWithEvent(${idKind})`, (h) =>
    h.s.ms.updateStatusWithEvent(h.ctx, id(h), "archived", {}, event(h.ctx, id(h), "archived")),
  );
  add(`setEmbeddingStatus(${idKind},ready)`, (h) =>
    h.s.ms.setEmbeddingStatus(h.ctx, id(h), "ready"),
  );
  add(`reinforce(${idKind})`, (h) => h.s.ms.reinforce(h.ctx, id(h), later()));
  add(`reinforceMany([${idKind}])`, (h) => h.s.ms.reinforceMany(h.ctx, [id(h)], later()));
  add(`recordUsage(recall,[${idKind}])`, (h) => h.s.ms.recordUsage(h.ctx, h.recallId, [id(h)]));
  add(`recordUsage(${idKind} as recall,[self])`, (h) =>
    h.s.ms.recordUsage(h.ctx, idKind === "self" ? h.recallId : id(h), [h.m.id]),
  );
  add(`recordUsageAndReinforce(recall,[${idKind}])`, (h) =>
    h.s.ms.recordUsageAndReinforce(h.ctx, h.recallId, [id(h)], later()),
  );
  add(`getRecall(${idKind})`, (h) =>
    h.s.ms.getRecall(h.ctx, idKind === "self" ? h.recallId : id(h)),
  );
  add(`purgeMemory(${idKind})`, (h) =>
    h.s.ms.purgeMemory(
      h.ctx,
      id(h),
      { content: "[purged]", digest: "[purged]" },
      event(h.ctx, id(h), "purged"),
    ),
  );
  add(`markContestedPair(self,${idKind})`, (h) =>
    h.s.ms.markContestedPair(
      h.ctx,
      { id: h.m.id, event: event(h.ctx, h.m.id) },
      { id: id(h), event: event(h.ctx, id(h)) },
    ),
  );
  add(`resolveOrphanedContested(${idKind})`, (h) =>
    h.s.ms.resolveOrphanedContested(h.ctx, {
      id: id(h),
      contestedWithId: h.m2.id,
      event: event(h.ctx, id(h)),
    }),
  );
  add(`restoreSupersededBy(${idKind})`, (h) =>
    h.s.ms.restoreSupersededBy(h.ctx, id(h), { at: new Date() }),
  );
  add(`previewRestoreSupersededBy(${idKind})`, (h) =>
    h.s.ms.previewRestoreSupersededBy(h.ctx, id(h)),
  );
  add(`restoreSupersededBy(self,{only:[${idKind}]})`, (h) =>
    h.s.ms.restoreSupersededBy(h.ctx, h.m.id, { at: new Date() }, { onlyMemoryIds: [id(h)] }),
  );
  add(`createMemory(sourceObservationId:${idKind})`, (h) =>
    h.s.ms.createMemory(
      h.ctx,
      buildNewMemoryFixture({
        tenantId: h.ctx.tenantId,
        contentHash: `src-${idKind}`,
        sourceObservationId: id(h, "obs"),
      }),
    ),
  );
  add(`createMemory(supersededById:${idKind})`, (h) =>
    h.s.ms.createMemory(
      h.ctx,
      buildNewMemoryFixture({
        tenantId: h.ctx.tenantId,
        contentHash: `sup-${idKind}`,
        status: "superseded",
        supersededById: id(h),
      }),
    ),
  );
  add(`createMemory(contestedWithId:${idKind})`, (h) =>
    h.s.ms.createMemory(
      h.ctx,
      buildNewMemoryFixture({
        tenantId: h.ctx.tenantId,
        contentHash: `con-${idKind}`,
        status: "contested",
        contestedWithId: id(h),
      }),
    ),
  );
  add(`vector.upsert(${idKind})`, (h) => h.s.vs.upsert(h.ctx, SPACE, id(h), [0, 1, 0]));
  add(`vector.delete(${idKind})`, (h) => h.s.vs.delete(h.ctx, SPACE, id(h)));
  add(`vector.getVectors([${idKind}])`, (h) => h.s.vs.getVectors(h.ctx, SPACE, [id(h)]));
  add(`event.get(${idKind})`, (h) => h.s.es.get(h.ctx, id(h, "ev")));
  add(`event.append(memoryId:${idKind})`, (h) => h.s.es.append(h.ctx, event(h.ctx, id(h))));
  add(`event.list({memoryId:${idKind}})`, (h) =>
    h.s.es.list(h.ctx, { memoryId: id(h), limit: 10 }),
  );
  add(`outbox.complete(${idKind},1)`, (h) => h.s.os.complete(h.ctx, id(h), 1));
  add(`outbox.fail(${idKind},1)`, (h) => h.s.os.fail(h.ctx, id(h), "e", 1));
}
add("getMany([])", (h) => h.s.ms.getMany(h.ctx, []));
add("reinforceMany([])", (h) => h.s.ms.reinforceMany(h.ctx, [], later()));
add("reinforceMany([self,self])", (h) => h.s.ms.reinforceMany(h.ctx, [h.m.id, h.m.id], later()));
add("recordUsage(recall,[])", (h) => h.s.ms.recordUsage(h.ctx, h.recallId, []));
add("recordUsage(recall,[self,self])", (h) =>
  h.s.ms.recordUsage(h.ctx, h.recallId, [h.m.id, h.m.id]),
);
add("recordUsageAndReinforce(recall,[self,self])", (h) =>
  h.s.ms.recordUsageAndReinforce(h.ctx, h.recallId, [h.m.id, h.m.id], later()),
);
add("vector.getVectors([])", (h) => h.s.vs.getVectors(h.ctx, SPACE, []));
add("vector.getVectors([self,self])", (h) => h.s.vs.getVectors(h.ctx, SPACE, [h.m.id, h.m.id]));
add("vector.upsert(self,[])", (h) => h.s.vs.upsert(h.ctx, SPACE, h.m.id, []));
add("vector.upsert(self,[1,0])（次元違い）", (h) => h.s.vs.upsert(h.ctx, SPACE, h.m.id, [1, 0]));
add("vector.upsert(self,[NaN,0,0])", (h) =>
  h.s.vs.upsert(h.ctx, SPACE, h.m.id, [Number.NaN, 0, 0]),
);
add("vector.search(query 次元違い)", (h) =>
  h.s.vs.search(h.ctx, SPACE, [1, 0], { limit: 5, filter: { tenantId: h.ctx.tenantId } }),
);
add("vector.search(query [])", (h) =>
  h.s.vs.search(h.ctx, SPACE, [], { limit: 5, filter: { tenantId: h.ctx.tenantId } }),
);
add("vector.search(query NaN)", (h) =>
  h.s.vs.search(h.ctx, SPACE, [Number.NaN, 0, 0], {
    limit: 5,
    filter: { tenantId: h.ctx.tenantId },
  }),
);
add("lexical.search('')", (h) =>
  h.s.ls.search(h.ctx, "", { limit: 5, filter: { tenantId: h.ctx.tenantId } }),
);
add("lexical.search('   ')", (h) =>
  h.s.ls.search(h.ctx, "   ", { limit: 5, filter: { tenantId: h.ctx.tenantId } }),
);
add("registerLabel('')", (h) => h.s.ms.registerLabel(h.ctx, ""));
add("registerLabel('  ')", (h) => h.s.ms.registerLabel(h.ctx, "  "));
add("registerLabel('x'*3000)", (h) => h.s.ms.registerLabel(h.ctx, "x".repeat(3000)));
add("createObservation(externalId:'')", (h) =>
  h.s.ms.createObservation(
    h.ctx,
    buildNewObservationFixture({ tenantId: h.ctx.tenantId, externalId: "" }),
  ),
);
add("createObservation(externalId:'') 2回", async (h) => {
  await h.s.ms.createObservation(
    h.ctx,
    buildNewObservationFixture({ tenantId: h.ctx.tenantId, externalId: "" }),
  );
  return h.s.ms.createObservationWithOutbox(
    h.ctx,
    buildNewObservationFixture({ tenantId: h.ctx.tenantId, externalId: "" }),
    ["extract"],
  );
});
add("createMemoryWithOutbox(jobKinds:[])", (h) =>
  h.s.ms.createMemoryWithOutbox(
    h.ctx,
    buildNewMemoryFixture({ tenantId: h.ctx.tenantId, contentHash: "nojob" }),
    [],
  ),
);
add("createMemoryWithOutbox(jobKinds:[embed,embed])", (h) =>
  h.s.ms.createMemoryWithOutbox(
    h.ctx,
    buildNewMemoryFixture({ tenantId: h.ctx.tenantId, contentHash: "dupjob" }),
    ["embed", "embed"],
  ),
);
add("createMemoryWithOutbox(jobKinds:['x'])（未知の kind）", (h) =>
  h.s.ms.createMemoryWithOutbox(
    h.ctx,
    buildNewMemoryFixture({ tenantId: h.ctx.tenantId, contentHash: "unkjob" }),
    ["x"],
  ),
);
add("createObservationWithOutbox(jobKinds:[extract,extract])", (h) =>
  h.s.ms.createObservationWithOutbox(
    h.ctx,
    buildNewObservationFixture({ tenantId: h.ctx.tenantId }),
    ["extract", "extract"],
  ),
);
add("event.append(tenantId 食い違い)", (h) =>
  h.s.es.append(h.ctx, { ...event(h.ctx, h.m.id), tenantId: "someone-else" }),
);
add("createMemory(input.tenantId 食い違い)", (h) =>
  h.s.ms.createMemory(
    h.ctx,
    buildNewMemoryFixture({ tenantId: "someone-else", contentHash: "tmismatch" }),
  ),
);
add("createObservation(input.tenantId 食い違い)", (h) =>
  h.s.ms.createObservation(h.ctx, buildNewObservationFixture({ tenantId: "someone-else" })),
);
add("markContestedPair(self,self2) 2回目（既に contested）", async (h) => {
  const pair = () =>
    h.s.ms.markContestedPair(
      h.ctx,
      { id: h.m.id, event: event(h.ctx, h.m.id) },
      { id: h.m2.id, event: event(h.ctx, h.m2.id) },
    );
  await pair();
  return pair();
});
add("purgeMemory(self)（forgotten でない）", (h) =>
  h.s.ms.purgeMemory(
    h.ctx,
    h.m.id,
    { content: "[purged]", digest: "[purged]" },
    event(h.ctx, h.m.id, "purged"),
  ),
);

// ---- 単一の id を取らない口（#1255 の後に足した）----
const scope = (h: Kit, extra: Record<string, unknown> = {}) =>
  ({ ...extra }) as Parameters<Stores["ms"]["aggregateScope"]>[1];
add("requeueEmbedJobs(statuses:[])", (h) =>
  h.s.ms.requeueEmbedJobs(h.ctx, { statuses: [], limit: 10 }),
);
add("requeueEmbedJobs(statuses:[pending,pending])", (h) =>
  h.s.ms.requeueEmbedJobs(h.ctx, { statuses: ["pending", "pending"], limit: 10 }),
);
add("requeueEmbedJobs(memoryIds:[])", (h) =>
  h.s.ms.requeueEmbedJobs(h.ctx, { statuses: ["pending"], memoryIds: [], limit: 10 }),
);
for (const [idKind, pick] of Object.entries(ID_VALUES)) {
  add(`requeueEmbedJobs(memoryIds:[${idKind}])`, (h) =>
    h.s.ms.requeueEmbedJobs(h.ctx, { statuses: ["pending"], memoryIds: [pick(h, "m")], limit: 10 }),
  );
  add(`aggregateScope(digestBand.excludeMemoryIds:[${idKind}])`, (h) =>
    h.s.ms.aggregateScope(h.ctx, scope(h), {
      digestBand: { limit: 10, excludeMemoryIds: [pick(h, "m")] },
    }),
  );
  // Issue #1262: uuid の形でない id が混ざっても、ほかの id の除外は今までどおり効く（形の崩れた id だけが
  // 「無いもの」になる）。`self` の場面では、自分の記憶は目次帯から外れ、件数からも引かれる。
  add(`aggregateScope(digestBand.excludeMemoryIds:[${idKind},malformed])`, (h) =>
    h.s.ms.aggregateScope(h.ctx, scope(h), {
      digestBand: { limit: 10, excludeMemoryIds: [pick(h, "m"), "not-a-uuid"] },
    }),
  );
  add(`findActiveByClaimKey(excludeMemoryId:${idKind})`, (h) =>
    h.s.ms.findActiveByClaimKey(h.ctx, {
      subjectId: null,
      claimKey: { subject: "user", predicate: "home_city" },
      excludeMemoryId: pick(h, "m"),
      contentHash: "x",
      validFrom: null,
      validUntil: null,
    }),
  );
  add(`resolveContestedPair(${idKind},self2)（contested でない）`, (h) =>
    h.s.ms.resolveContestedPair(
      h.ctx,
      { id: pick(h, "m"), status: "active", event: event(h.ctx, pick(h, "m")) },
      { id: h.m2.id, status: "active", event: event(h.ctx, h.m2.id) },
    ),
  );
  add(`supersedeWithNewMemories(supersede id:${idKind})`, (h) =>
    h.s.ms.supersedeWithNewMemories(
      h.ctx,
      [
        {
          input: buildNewMemoryFixture({ tenantId: h.ctx.tenantId, contentHash: `new-${idKind}` }),
          jobKinds: ["embed"],
        },
      ],
      [
        {
          id: pick(h, "m"),
          supersededByIndex: 0,
          expectedStatus: "active",
          event: event(h.ctx, pick(h, "m"), "superseded"),
        },
      ],
    ),
  );
}
add("purgeExpiredEvents(olderThan: Invalid Date)", (h) =>
  h.s.ms.purgeExpiredEvents(h.ctx, { olderThan: new Date(Number.NaN), limit: 10 }),
);
add("purgeExpiredEvents(limit:0)", (h) =>
  h.s.ms.purgeExpiredEvents(h.ctx, { olderThan: later(), limit: 0 }),
);
add("purgeExpiredEvents(dryRun)", (h) =>
  h.s.ms.purgeExpiredEvents(h.ctx, { olderThan: later(), limit: 10, dryRun: true }),
);
add("purgeExpiredRecalls(olderThan: Invalid Date)", (h) =>
  h.s.ms.purgeExpiredRecalls(h.ctx, { olderThan: new Date(Number.NaN), limit: 10 }),
);
add("purgeExpiredRecalls(limit:0)", (h) =>
  h.s.ms.purgeExpiredRecalls(h.ctx, { olderThan: later(), limit: 0 }),
);
add("purgeExpiredRecalls(limit:1.5)", (h) =>
  h.s.ms.purgeExpiredRecalls(h.ctx, { olderThan: later(), limit: 1.5 }),
);
add("purgeExpiredRecalls(dryRun)", (h) =>
  h.s.ms.purgeExpiredRecalls(h.ctx, { olderThan: later(), limit: 10, dryRun: true }),
);
add("outbox.purgeCompletedJobs(olderThan: Invalid Date)", (h) =>
  h.s.os.purgeCompletedJobs!(h.ctx, { olderThan: new Date(Number.NaN), limit: 10 }),
);
add("outbox.purgeCompletedJobs(limit:0)", (h) =>
  h.s.os.purgeCompletedJobs!(h.ctx, { olderThan: later(), limit: 0 }),
);
add("outbox.purgeCompletedJobs(limit:1.5)", (h) =>
  h.s.os.purgeCompletedJobs!(h.ctx, { olderThan: later(), limit: 1.5 }),
);
add("outbox.purgeCompletedJobs(dryRun)", (h) =>
  h.s.os.purgeCompletedJobs!(h.ctx, { olderThan: later(), limit: 10, dryRun: true }),
);
add("archiveDecayed(now: Invalid Date)", (h) =>
  h.s.ms.archiveDecayed(h.ctx, { now: new Date(Number.NaN), limit: 10 }),
);
add("archiveDecayed(limit:0)", (h) =>
  h.s.ms.archiveDecayed(h.ctx, { now: new Date(Date.now() + 1e13), limit: 0 }),
);
add("archiveDecayed(nowSeq:-1, clock:activity)", (h) =>
  h.s.ms.archiveDecayed(h.ctx, { now: new Date(), limit: 10, nowSeq: -1, clock: "activity" }),
);
add("archiveDecayed(nowSeq:1.5, clock:activity)", (h) =>
  h.s.ms.archiveDecayed(h.ctx, { now: new Date(), limit: 10, nowSeq: 1.5, clock: "activity" }),
);
add("archiveDecayed(clock:activity, nowSeq 無し)", (h) =>
  h.s.ms.archiveDecayed(h.ctx, { now: new Date(), limit: 10, clock: "activity" }),
);
add("aggregateScope({})", (h) => h.s.ms.aggregateScope(h.ctx, scope(h)));
add("aggregateScope(subjectId:'')", (h) =>
  h.s.ms.aggregateScope(h.ctx, scope(h, { subjectId: "" })),
);
add("aggregateScope(labels:[])", (h) => h.s.ms.aggregateScope(h.ctx, scope(h, { labels: [] })));
add("aggregateScope(labels:[''])", (h) => h.s.ms.aggregateScope(h.ctx, scope(h, { labels: [""] })));
add("aggregateScope(attributes:{})", (h) =>
  h.s.ms.aggregateScope(h.ctx, scope(h, { attributes: {} })),
);
add("aggregateScope(occurredAfter: Invalid Date)", (h) =>
  h.s.ms.aggregateScope(h.ctx, scope(h, { occurredAfter: new Date(Number.NaN) })),
);
add("aggregateScope(validAt: Invalid Date)", (h) =>
  h.s.ms.aggregateScope(h.ctx, scope(h, { validAt: new Date(Number.NaN) })),
);
add("aggregateScope(decayFloorAtAfter: Invalid Date)", (h) =>
  h.s.ms.aggregateScope(h.ctx, scope(h, { decayFloorAtAfter: new Date(Number.NaN) })),
);
add("aggregateScope(decayFloorSeqAfter:-1)", (h) =>
  h.s.ms.aggregateScope(h.ctx, scope(h, { decayFloorSeqAfter: -1 })),
);
add("aggregateScope(decayFloorSeqAfter:1.5)", (h) =>
  h.s.ms.aggregateScope(h.ctx, scope(h, { decayFloorSeqAfter: 1.5 })),
);
add("aggregateScope(taxonomyGroupCandidates:[])", (h) =>
  h.s.ms.aggregateScope(h.ctx, scope(h, { taxonomyGroupCandidates: [] })),
);
add("aggregateScope(digestBand.limit:0)", (h) =>
  h.s.ms.aggregateScope(h.ctx, scope(h), { digestBand: { limit: 0, excludeMemoryIds: [] } }),
);
add("findActiveByClaimKey(claimKey 空文字)", (h) =>
  h.s.ms.findActiveByClaimKey(h.ctx, {
    subjectId: null,
    claimKey: { subject: "", predicate: "" },
    excludeMemoryId: h.m.id,
    contentHash: "x",
    validFrom: null,
    validUntil: null,
  }),
);
add("findActiveByClaimKey(subjectId:'')", (h) =>
  h.s.ms.findActiveByClaimKey(h.ctx, {
    subjectId: "",
    claimKey: { subject: "user", predicate: "home_city" },
    excludeMemoryId: h.m.id,
    contentHash: "x",
    validFrom: null,
    validUntil: null,
  }),
);
add("findActiveByClaimKey(validFrom: Invalid Date)", (h) =>
  h.s.ms.findActiveByClaimKey(h.ctx, {
    subjectId: null,
    claimKey: { subject: "user", predicate: "home_city" },
    excludeMemoryId: h.m.id,
    contentHash: "x",
    validFrom: new Date(Number.NaN),
    validUntil: null,
  }),
);
add("listActiveClaimPredicates(subjectId:'')", (h) =>
  h.s.ms.listActiveClaimPredicates(h.ctx, { subjectId: "", limit: 10 }),
);
add("listActiveClaimPredicates(limit:0)", (h) =>
  h.s.ms.listActiveClaimPredicates(h.ctx, { subjectId: null, limit: 0 }),
);
add("supersedeWithNewMemories([],[])", (h) => h.s.ms.supersedeWithNewMemories(h.ctx, [], []));
for (const index of [1, -1, 1.5]) {
  add(`supersedeWithNewMemories(supersededByIndex:${index})`, (h) =>
    h.s.ms.supersedeWithNewMemories(
      h.ctx,
      [
        {
          input: buildNewMemoryFixture({ tenantId: h.ctx.tenantId, contentHash: `idx-${index}` }),
          jobKinds: ["embed"],
        },
      ],
      [
        {
          id: h.m.id,
          supersededByIndex: index,
          expectedStatus: "active",
          event: event(h.ctx, h.m.id, "superseded"),
        },
      ],
    ),
  );
}
add("supersedeWithNewMemories(同じ id を2回 supersede)", (h) =>
  h.s.ms.supersedeWithNewMemories(
    h.ctx,
    [
      {
        input: buildNewMemoryFixture({ tenantId: h.ctx.tenantId, contentHash: "dup-sup" }),
        jobKinds: ["embed"],
      },
    ],
    [
      {
        id: h.m.id,
        supersededByIndex: 0,
        expectedStatus: "active",
        event: event(h.ctx, h.m.id, "superseded"),
      },
      {
        id: h.m.id,
        supersededByIndex: 0,
        expectedStatus: "active",
        event: event(h.ctx, h.m.id, "superseded"),
      },
    ],
  ),
);
add("supersedeWithNewMemories(news に同じ冪等の鍵が2つ)", (h) =>
  h.s.ms.supersedeWithNewMemories(
    h.ctx,
    [
      {
        input: buildNewMemoryFixture({
          tenantId: h.ctx.tenantId,
          contentHash: "dupkey",
          sourceObservationId: h.obs.id,
          extractorVersion: "v1",
        }),
        jobKinds: ["embed"],
      },
      {
        input: buildNewMemoryFixture({
          tenantId: h.ctx.tenantId,
          contentHash: "dupkey",
          sourceObservationId: h.obs.id,
          extractorVersion: "v1",
        }),
        jobKinds: ["embed"],
      },
    ],
    [
      {
        id: h.m2.id,
        supersededByIndex: 1,
        expectedStatus: "active",
        event: event(h.ctx, h.m2.id, "superseded"),
      },
    ],
  ),
);
add("resolveContestedPair(self,self)", (h) =>
  h.s.ms.resolveContestedPair(
    h.ctx,
    { id: h.m.id, status: "active", event: event(h.ctx, h.m.id) },
    { id: h.m.id, status: "active", event: event(h.ctx, h.m.id) },
  ),
);
add("resolveContestedPair(対の両側、supersededById 無しで superseded)", async (h) => {
  await h.s.ms.markContestedPair(
    h.ctx,
    { id: h.m.id, event: event(h.ctx, h.m.id) },
    { id: h.m2.id, event: event(h.ctx, h.m2.id) },
  );
  return h.s.ms.resolveContestedPair(
    h.ctx,
    { id: h.m.id, status: "active", event: event(h.ctx, h.m.id) },
    { id: h.m2.id, status: "superseded", event: event(h.ctx, h.m2.id, "superseded") },
  );
});
add("registerLabel 同じ名前を2回", async (h) => {
  await h.s.ms.registerLabel(h.ctx, "work");
  return h.s.ms.registerLabel(h.ctx, "work");
});
add("listLabels(何も無いテナント)", (h) => h.s.ms.listLabels(h.other));
add("event.list({})", (h) => h.s.es.list(h.ctx, {}));
add("event.list({limit:0})", (h) => h.s.es.list(h.ctx, { limit: 0 }));
add("event.list({since: Invalid Date})", (h) =>
  h.s.es.list(h.ctx, { since: new Date(Number.NaN) }),
);
add("event.list({until: Invalid Date})", (h) =>
  h.s.es.list(h.ctx, { until: new Date(Number.NaN) }),
);
add("event.list({since > until})", (h) =>
  h.s.es.list(h.ctx, { since: later(), until: new Date(0) }),
);
add("event.list({kind:'events_purged'})", (h) => h.s.es.list(h.ctx, { kind: "events_purged" }));

// ---- 検索の filter の日時・通し番号（#1255 の後に足した）----
for (const field of ["occurredAfter", "occurredBefore", "validAt", "decayFloorAtAfter"] as const) {
  add(`vector.search(filter.${field}: Invalid Date)`, (h) =>
    h.s.vs.search(h.ctx, SPACE, [1, 0, 0], {
      limit: 5,
      filter: { tenantId: h.ctx.tenantId, [field]: new Date(Number.NaN) },
    }),
  );
}
add("vector.search(filter.decayFloorSeqAfter:1.5)", (h) =>
  h.s.vs.search(h.ctx, SPACE, [1, 0, 0], {
    limit: 5,
    filter: { tenantId: h.ctx.tenantId, decayFloorSeqAfter: 1.5 },
  }),
);
for (const field of ["occurredAfter", "occurredBefore", "validAt"] as const) {
  add(`lexical.search(filter.${field}: Invalid Date)`, (h) =>
    h.s.ls.search(h.ctx, "東京", {
      limit: 5,
      filter: { tenantId: h.ctx.tenantId, [field]: new Date(Number.NaN) },
    }),
  );
}
add("aggregateScope(occurredBefore: Invalid Date)", (h) =>
  h.s.ms.aggregateScope(h.ctx, scope(h, { occurredBefore: new Date(Number.NaN) })),
);
add("findActiveByClaimKey(validUntil: Invalid Date)", (h) =>
  h.s.ms.findActiveByClaimKey(h.ctx, {
    subjectId: null,
    claimKey: { subject: "user", predicate: "home_city" },
    excludeMemoryId: h.m.id,
    contentHash: "x",
    validFrom: null,
    validUntil: new Date(Number.NaN),
  }),
);

// ---- TenantSettingsStore（#1165・#1171 の外側。書いた後に全部の読みの口を並べて比べる）----
const readAllSettings = async (h: Kit, ctx: Ctx = h.ctx) => ({
  halfLifeHours: await h.s.ts.getDefaultHalfLifeHours(ctx),
  retention: await h.s.ts.getEventRetention(ctx),
  decayClock: await h.s.ts.getDecayClock(ctx),
  halfLifeRecalls: await h.s.ts.getDefaultHalfLifeRecalls(ctx),
  activitySeq: await h.s.ts.getActivitySeq(ctx),
  taxonomy: await h.s.ts.getTaxonomyMode(ctx),
});
add("tenantSettings: 何も書いていないテナントの既定値", (h) => readAllSettings(h));
add("tenantSettings: 空文字の tenantId の既定値", (h) => readAllSettings(h, { tenantId: "" }));
for (const days of [1, 365, 2 ** 31 - 1, 2 ** 31, 2 ** 53, 0, -1, 1.5]) {
  add(`setEventRetention(days:${days})`, async (h) => {
    await h.s.ts.setEventRetention(h.ctx, { kind: "days", days });
    return readAllSettings(h);
  });
}
add("setEventRetention(unlimited) の後に days", async (h) => {
  await h.s.ts.setEventRetention(h.ctx, { kind: "unlimited" });
  await h.s.ts.setEventRetention(h.ctx, { kind: "days", days: 30 });
  return readAllSettings(h);
});
add("setEventRetention(days) の後に unlimited", async (h) => {
  await h.s.ts.setEventRetention(h.ctx, { kind: "days", days: 30 });
  await h.s.ts.setEventRetention(h.ctx, { kind: "unlimited" });
  return readAllSettings(h);
});
for (const clock of ["wall", "activity", "either"] as const) {
  add(`setDecayClock(${clock}) を2回`, async (h) => {
    await h.s.ts.setDecayClock(h.ctx, clock);
    await h.s.ts.setDecayClock(h.ctx, clock);
    return readAllSettings(h);
  });
}
for (const recalls of [1, 1e-45, 3.4e38, 0.5]) {
  add(`setDefaultHalfLifeRecalls(${recalls})`, async (h) => {
    await h.s.ts.setDefaultHalfLifeRecalls(h.ctx, recalls);
    return readAllSettings(h);
  });
}
for (const mode of ["open", "strict"] as const) {
  add(`setTaxonomyMode(${mode}) の後の読み`, async (h) => {
    await h.s.ts.setTaxonomyMode(h.ctx, mode);
    return readAllSettings(h);
  });
}
add("tenantSettings: 書いたのは別のテナント（読みは変わらない）", async (h) => {
  await h.s.ts.setEventRetention(h.other, { kind: "days", days: 7 });
  await h.s.ts.setDecayClock(h.other, "activity");
  await h.s.ts.setTaxonomyMode(h.other, "strict");
  await h.s.ts.setDefaultHalfLifeRecalls(h.other, 3);
  return readAllSettings(h);
});

// ---- createRecall（makeKit の用意でだけ呼んでいた口。書いた後に getRecall と活動時計で読み戻す）----
const recallWith = async (h: Kit, override: Partial<NewRecallRecord>) => {
  const recallId = await h.s.ms.createRecall(h.ctx, { ...newRecallRecord(h.ctx), ...override });
  return {
    recallId,
    readBack: await h.s.ms.getRecall(h.ctx, recallId),
    readByOther: await h.s.ms.getRecall(h.other, recallId),
    activitySeq: await h.s.ts.getActivitySeq(h.ctx),
  };
};
add("createRecall(既定)", (h) => recallWith(h, {}));
add("createRecall(advanceActivityClock:true)", (h) =>
  recallWith(h, { advanceActivityClock: true }),
);
add("createRecall(record.tenantId:other)", (h) => recallWith(h, { tenantId: h.other.tenantId }));
add("createRecall(subjectId:'')", (h) => recallWith(h, { subjectId: "" }));
add("createRecall(subjectId:NUL)", (h) => recallWith(h, { subjectId: "s\u0000" }));
add("createRecall(query:NUL)", (h) => recallWith(h, { query: { text: "q\u0000" } }));
add("createRecall(budget:NUL)", (h) =>
  recallWith(h, { budget: { chars: 1, x: "\u0000" } as never }),
);
add("createRecall(query:undefined)", (h) => recallWith(h, { query: undefined }));
add("createRecall(explain:NUL)", (h) =>
  recallWith(h, { explain: { stages: [{ stage: "s\u0000" } as never] } }),
);
add("createRecall(returnedMemories:[other])", (h) =>
  recallWith(h, {
    returnedMemories: [
      {
        memoryId: h.om.id,
        score: {} as never,
        retrievedVia: "ann",
      },
    ],
  }),
);

// ---- claimBatch（時刻の境界は #1196・#1237 が持つので外す。now は十分先・leaseMs は固定）----
const claimWith = async (h: Kit, opts: Partial<ClaimOutboxJobsOptions>) => {
  await h.s.ms.createMemoryWithOutbox(
    h.ctx,
    buildNewMemoryFixture({ tenantId: h.ctx.tenantId, contentHash: "claim-self" }),
    ["embed", "extract"],
  );
  await h.s.ms.createMemoryWithOutbox(
    h.other,
    buildNewMemoryFixture({ tenantId: h.other.tenantId, contentHash: "claim-other" }),
    ["embed"],
  );
  const claim = (o: Partial<ClaimOutboxJobsOptions>) =>
    h.s.os.claimBatch(h.ctx, { limit: 10, now: later(), claimedBy: "w", leaseMs: 60_000, ...o });
  // 同じ available_at の行どうしの並びは約束していない（outbox-store.ts の冒頭）ので、種別で並べる。
  const byKind = (jobs: OutboxJobRecord[]) =>
    jobs.map((j) => [j.kind, j.claimedBy, j.attempts]).sort();
  const claimed = byKind(await claim(opts));
  // 残りを取る（同じ呼び手の2回目。リースは切れていないので、1回目に取った行は出ない）。
  const rest = byKind(await claim({}));
  return { claimed, rest };
};
add("claimBatch(既定)", (h) => claimWith(h, {}));
add("claimBatch(kinds:[])", (h) => claimWith(h, { kinds: [] }));
add("claimBatch(kinds:[embed])", (h) => claimWith(h, { kinds: ["embed"] }));
add("claimBatch(kinds:[embed,embed])", (h) => claimWith(h, { kinds: ["embed", "embed"] }));
add("claimBatch(kinds:[bogus])", (h) => claimWith(h, { kinds: ["bogus"] }));
for (const limit of [0, 1, 2 ** 53, -1, 1.5, Number.NaN, 2 ** 63]) {
  add(`claimBatch(limit:${limit})`, (h) => claimWith(h, { limit }));
}
add("claimBatch(claimedBy:'')", (h) => claimWith(h, { claimedBy: "" }));
add("claimBatch(claimedBy:NUL)", (h) => claimWith(h, { claimedBy: "w\u0000" }));

// ---- 約束の4クラスを出す場面（下の `TYPED_THROWS`。上の場面で足りている組は、そちらを使う）----
const contestedNew = (h: Kit, contentHash: string) =>
  buildNewMemoryFixture({ tenantId: h.ctx.tenantId, contentHash, status: "contested" });
add("updateStatus(self,contested)", (h) => h.s.ms.updateStatus(h.ctx, h.m.id, "contested"));
add("updateStatusWithEvent(self,contested)", (h) =>
  h.s.ms.updateStatusWithEvent(h.ctx, h.m.id, "contested", {}, event(h.ctx, h.m.id)),
);
add("createMemory(contested、contestedWithId 無し)", (h) =>
  h.s.ms.createMemory(h.ctx, contestedNew(h, "con-none")),
);
add("createMemoryWithOutbox(contested、contestedWithId 無し)", (h) =>
  h.s.ms.createMemoryWithOutbox(h.ctx, contestedNew(h, "con-none"), ["embed"]),
);
add("supersedeWithNewMemories(news が contested、contestedWithId 無し)", (h) =>
  h.s.ms.supersedeWithNewMemories(
    h.ctx,
    [{ input: contestedNew(h, "con-news"), jobKinds: ["embed"] }],
    [
      {
        id: h.m.id,
        supersededByIndex: 0,
        expectedStatus: "active",
        event: event(h.ctx, h.m.id, "superseded"),
      },
    ],
  ),
);
add("updateStatus(self,archived,{expectedStatus:superseded})", (h) =>
  h.s.ms.updateStatus(h.ctx, h.m.id, "archived", { expectedStatus: "superseded" }),
);
add("updateStatusWithEvent(self,archived,{expectedStatus:superseded})", (h) =>
  h.s.ms.updateStatusWithEvent(
    h.ctx,
    h.m.id,
    "archived",
    { expectedStatus: "superseded" },
    event(h.ctx, h.m.id, "archived"),
  ),
);
add("resolveOrphanedContested(self,contestedWithId 食い違い)", async (h) => {
  await h.s.ms.markContestedPair(
    h.ctx,
    { id: h.m.id, event: event(h.ctx, h.m.id) },
    { id: h.m2.id, event: event(h.ctx, h.m2.id) },
  );
  await h.s.ms.updateStatusWithEvent(
    h.ctx,
    h.m2.id,
    "forgotten",
    {},
    event(h.ctx, h.m2.id, "forgotten"),
  );
  return h.s.ms.resolveOrphanedContested(h.ctx, {
    id: h.m.id,
    contestedWithId: ID_VALUES.missing!(h, "m"),
    event: event(h.ctx, h.m.id),
  });
});
add("purgeMemory(self)（purge 済み）", async (h) => {
  await h.s.ms.updateStatus(h.ctx, h.m.id, "forgotten");
  const purge = () =>
    h.s.ms.purgeMemory(
      h.ctx,
      h.m.id,
      { content: "[purged]", digest: "[purged]" },
      event(h.ctx, h.m.id, "purged"),
    );
  await purge();
  return purge();
});
/** 呼んだテナントに embed のジョブを1本作る（`attempts` は 0）。`claim` なら取って `attempts` を 1 にする。 */
const jobOf = async (h: Kit, claim: boolean) => {
  const { jobs } = await h.s.ms.createMemoryWithOutbox(
    h.ctx,
    buildNewMemoryFixture({ tenantId: h.ctx.tenantId, contentHash: "lease" }),
    ["embed"],
  );
  if (claim) {
    await h.s.os.claimBatch(h.ctx, { limit: 10, now: later(), claimedBy: "w", leaseMs: 60_000 });
  }
  return jobs[0]!.id;
};
add("outbox.complete(claim 済み,attempts 違い)", async (h) =>
  h.s.os.complete(h.ctx, await jobOf(h, true), 2),
);
add("outbox.fail(claim 済み,attempts 違い)", async (h) =>
  h.s.os.fail(h.ctx, await jobOf(h, true), "e", 2),
);
// Issue #1292（決まった件）: 終端済みの行に違う expectedAttempts を渡したときは、冒頭の契約と実装の側
// （attempts が違えば投げる）を正とした。2実装ともそう動くことを縛る。
add("outbox.complete(終端済み,attempts 違い)", async (h) => {
  const jobId = await jobOf(h, false);
  await h.s.os.fail(h.ctx, jobId, "e", 0);
  return h.s.os.complete(h.ctx, jobId, 1);
});
add("outbox.fail(終端済み,attempts 違い)", async (h) => {
  const jobId = await jobOf(h, false);
  await h.s.os.complete(h.ctx, jobId, 0);
  return h.s.os.fail(h.ctx, jobId, "e", 1);
});

/**
 * interface の TSDoc が例外の種類まで約束する (口, クラス) の13組と、それを出す場面・約束の欄の値
 * （`normalize` の後の形。id は別名、ジョブの id と新しく作った id は `<new>`、時刻は `<t>`）。
 */
const TYPED_THROWS: ReadonlyArray<{ pair: string; scenario: string; expected: object }> = [
  ...(
    [
      ["updateStatus", "updateStatus(self,contested)", "SELF"],
      ["updateStatusWithEvent", "updateStatusWithEvent(self,contested)", "SELF"],
      ["createMemory", "createMemory(contested、contestedWithId 無し)", null],
      ["createMemoryWithOutbox", "createMemoryWithOutbox(contested、contestedWithId 無し)", null],
      [
        "supersedeWithNewMemories",
        "supersedeWithNewMemories(news が contested、contestedWithId 無し)",
        null,
      ],
    ] as const
  ).map(([method, scenario, memoryId]) => ({
    pair: `${method} / ContestedWithoutCompanionError`,
    scenario,
    expected: { class: "ContestedWithoutCompanionError", method, memoryId },
  })),
  ...(
    [
      [
        "updateStatus",
        "updateStatus(self,archived,{expectedStatus:superseded})",
        "superseded",
        "active",
      ],
      [
        "updateStatusWithEvent",
        "updateStatusWithEvent(self,archived,{expectedStatus:superseded})",
        "superseded",
        "active",
      ],
      [
        "markContestedPair",
        "markContestedPair(self,self2) 2回目（既に contested）",
        "active",
        "contested",
      ],
      [
        "resolveContestedPair",
        "resolveContestedPair(self,self2)（contested でない）",
        "contested",
        "active",
      ],
      ["resolveOrphanedContested", "resolveOrphanedContested(self)", "contested", "active"],
      [
        "resolveOrphanedContested",
        "resolveOrphanedContested(self,contestedWithId 食い違い)",
        "contested",
        "contested",
      ],
    ] as const
  ).map(([method, scenario, expectedStatus, observedStatus]) => ({
    pair: `${method} / MemoryStatusConflictError`,
    scenario,
    expected: {
      class: "MemoryStatusConflictError",
      memoryId: "SELF",
      expectedStatus,
      observedStatus,
    },
  })),
  ...(
    [
      ["purgeMemory(self)（forgotten でない）", "active", null],
      ["purgeMemory(self)（purge 済み）", "forgotten", "<t>"],
    ] as const
  ).map(([scenario, observedStatus, observedPurgedAt]) => ({
    pair: "purgeMemory / MemoryPurgeConflictError",
    scenario,
    expected: {
      class: "MemoryPurgeConflictError",
      memoryId: "SELF",
      observedStatus,
      observedPurgedAt,
    },
  })),
  ...(
    [
      ["complete", "outbox.complete(claim 済み,attempts 違い)", 2, 1],
      ["fail", "outbox.fail(claim 済み,attempts 違い)", 2, 1],
      ["complete", "outbox.complete(終端済み,attempts 違い)", 1, 0],
      ["fail", "outbox.fail(終端済み,attempts 違い)", 1, 0],
    ] as const
  ).map(([method, scenario, expectedAttempts, observedAttempts]) => ({
    pair: `${method} / OutboxLeaseConflictError`,
    scenario,
    expected: {
      class: "OutboxLeaseConflictError",
      jobId: "<new>",
      expectedAttempts,
      observedAttempts,
    },
  })),
];

interface Outcome {
  result: string;
  state: string;
}

async function runOn(backend: Backend, f: (h: Kit) => Promise<unknown>): Promise<Outcome> {
  const h = await makeKit(backend);
  let result: string;
  try {
    result = `返した ${JSON.stringify(normalize(await f(h), h))}`;
  } catch (error) {
    const typed = typedError(error);
    result = typed ? `投げた ${JSON.stringify(normalize(typed, h))}` : "投げた";
  }
  return { result, state: await snapshotState(h) };
}

/** 約束の4クラスなら、クラス名と TSDoc が約束する欄（それ以外は `null`＝「投げた」とだけ比べる）。 */
function typedError(error: unknown): Record<string, unknown> | null {
  if (isContestedWithoutCompanionError(error)) {
    return { class: error.name, method: error.method, memoryId: error.memoryId };
  }
  if (isMemoryStatusConflictError(error)) {
    return {
      class: error.name,
      memoryId: error.memoryId,
      expectedStatus: error.expectedStatus,
      observedStatus: error.observedStatus,
    };
  }
  if (isMemoryPurgeConflictError(error)) {
    return {
      class: error.name,
      memoryId: error.memoryId,
      observedStatus: error.observedStatus,
      observedPurgedAt: error.observedPurgedAt,
    };
  }
  if (isOutboxLeaseConflictError(error)) {
    return {
      class: error.name,
      jobId: error.jobId,
      expectedAttempts: error.expectedAttempts,
      observedAttempts: error.observedAttempts,
    };
  }
  return null;
}

const differing = new Map<string, { pg: Outcome; testkit: Outcome }>();
const outcomes = new Map<string, { pg: Outcome; testkit: Outcome }>();

function resultKind(result: string): ResultKind {
  if (result.startsWith("投げた")) return "throws";
  return result === "返した null" ? "returns-null" : "returns-value";
}

/** 許可リストの場面で、実測の向きと書いた後のベクトル（`DocumentedDifference` と同じ形）。 */
function observedDirection(name: string, pg: Outcome, testkit: Outcome) {
  const expected = DOCUMENTED_DIFFERENCES[name]!;
  const vectorOf = (o: Outcome, memory: string): StoredVector =>
    (JSON.parse(o.state) as { vectors: Record<string, StoredVector> }).vectors[memory] ?? null;
  return {
    postgres: resultKind(pg.result),
    fixture: resultKind(testkit.result),
    ...(expected.vector
      ? {
          vector: {
            memory: expected.vector.memory,
            postgres: vectorOf(pg, expected.vector.memory),
            fixture: vectorOf(testkit, expected.vector.memory),
          },
        }
      : {}),
  };
}

describe("store の公開の口の境界の入力: Postgres と testkit の fixture の差（PR #1252）", () => {
  beforeAll(async () => {
    await getTestClient();
    for (const [name, f] of scenarios) {
      const pg = await runOn("pg", f);
      const testkit = await runOn("testkit", f);
      outcomes.set(name, { pg, testkit });
      if (pg.result !== testkit.result || pg.state !== testkit.state) {
        differing.set(name, { pg, testkit });
      }
    }
  }, 240_000);

  afterAll(async () => {
    await closeTestClient();
  });

  it("場面の名前は重複しない（許可リストが名前で引くため）", () => {
    expect(new Set(scenarios.map(([name]) => name)).size).toBe(scenarios.length);
  });

  it("🔴 約束の4クラスを出す場面では、2実装とも約束のクラスと欄で投げる（13組すべて）", () => {
    expect(new Set(TYPED_THROWS.map(({ pair }) => pair)).size).toBe(13);
    const observed = TYPED_THROWS.map(({ scenario }) => {
      const outcome = outcomes.get(scenario);
      const parse = (o: Outcome | undefined) =>
        o?.result.startsWith("投げた {")
          ? (JSON.parse(o.result.slice("投げた ".length)) as object)
          : o?.result;
      return { scenario, pg: parse(outcome?.pg), testkit: parse(outcome?.testkit) };
    });
    expect(observed).toEqual(
      TYPED_THROWS.map(({ scenario, expected }) => ({ scenario, pg: expected, testkit: expected })),
    );
  });

  it("🔴 許可リストの外で、戻り値も状態も差が出ない", () => {
    const unexpected = [...differing]
      .filter(([name]) => !(name in DOCUMENTED_DIFFERENCES))
      .map(([name, { pg, testkit }]) =>
        [
          `- ${name}`,
          `    Postgres の戻り値: ${pg.result.slice(0, 300)}`,
          `    fixture の戻り値:  ${testkit.result.slice(0, 300)}`,
          ...(pg.state !== testkit.state
            ? [
                `    Postgres の状態: ${pg.state.slice(0, 300)}`,
                `    fixture の状態:  ${testkit.state.slice(0, 300)}`,
              ]
            : []),
        ].join("\n"),
      );
    expect(
      unexpected,
      `許可リストの外で、${unexpected.length} 件の場面に差が出た。fixture を Postgres に揃えるか、` +
        `doc か Issue に書いてから DOCUMENTED_DIFFERENCES に足すこと:\n${unexpected.join("\n")}`,
    ).toEqual([]);
  });

  it("🔴 許可リストの場面は、今も差が出る（揃ったのにリストに残っていたら、リストが古い）", () => {
    const stale = Object.keys(DOCUMENTED_DIFFERENCES).filter((name) => !differing.has(name));
    const unknown = Object.keys(DOCUMENTED_DIFFERENCES).filter(
      (name) => !scenarios.some(([scenario]) => scenario === name),
    );
    expect(
      { stale, unknown },
      `許可リストが古い——差が出なくなった場面（揃ったなら、doc の「違う」と一緒に消すこと）: ${JSON.stringify(stale)}、` +
        `場面に無い名前: ${JSON.stringify(unknown)}`,
    ).toEqual({ stale: [], unknown: [] });
  });

  it("🔴 許可リストの場面は、doc に書いた向きで違う（どちらが投げるか・書いた後に保存されているベクトル）", () => {
    const mismatched = [...differing]
      .filter(([name]) => name in DOCUMENTED_DIFFERENCES)
      .map(([name, { pg, testkit }]) => {
        const { where: _where, ...expected } = DOCUMENTED_DIFFERENCES[name]!;
        return { name, expected, observed: observedDirection(name, pg, testkit) };
      })
      .filter(({ expected, observed }) => JSON.stringify(expected) !== JSON.stringify(observed));
    expect(
      mismatched,
      `許可リストの場面で、差の向きか保存の中身が doc と違う（doc と実装のどちらが古いかを確かめること）: ` +
        JSON.stringify(mismatched, null, 2),
    ).toEqual([]);
  });
});
