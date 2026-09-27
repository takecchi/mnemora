import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  EventStore,
  LexicalStore,
  MemoryEvent,
  MemoryStore,
  NewMemoryEvent,
  OutboxStore,
  RecallId,
  VectorStore,
} from "@mnemora/core";
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
 *   他テナントの記憶とイベント）。
 *   ⚠ 例外の種類と文面は比べない（DB の例外と fixture の `Error` は顔が違う。`packages/testkit/src/fixtures.ts` の冒頭）。
 *
 * 🔴 **許可リスト（`DOCUMENTED_DIFFERENCES`）は、doc に「違う」と書いてある差だけを持つ。**
 * - 許可リストの外で差が出たら落ちる。直すか（fixture は Postgres を写す）、doc に書いてから足すこと。
 * - 許可リストの場面で差が出なくなったら（揃ったら）、それも落ちる（リストが古い）。消すこと。
 */

/** 場面の名前 → どこに「違う」と書いてあるか。 */
const DOCUMENTED_DIFFERENCES: Readonly<Record<string, string>> = {
  "vector.upsert(other)":
    "他テナントの memoryId: Postgres は受け付け、fixture は拒む（docs/memory-model.md §5 の Issue #1051 の追記の表・VectorStore.upsert の TSDoc）",
  "event.append(memoryId:other)":
    "他テナントの memoryId: Postgres は受け付け、fixture は拒む（docs/memory-model.md §5 の Issue #1051 の追記の表・EventStore.append の TSDoc）",
  "vector.upsert(self,[])":
    "壊れたベクトル: Postgres は拒み、fixture は保存する（Issue #1070・VectorStore.upsert の TSDoc の adapter ごとの表）",
  "vector.upsert(self,[1,0])（次元違い）":
    "壊れたベクトル: Postgres は拒み、fixture は保存する（Issue #1070・VectorStore.upsert の TSDoc の adapter ごとの表）",
  "vector.upsert(self,[NaN,0,0])":
    "壊れたベクトル: Postgres は拒み、fixture は保存する（Issue #1070・VectorStore.upsert の TSDoc の adapter ごとの表）",
};

const SPACE = TEST_EMBEDDING_SPACE;

interface Stores {
  ms: Required<MemoryStore>;
  vs: Required<Pick<VectorStore, "upsert" | "search" | "delete" | "getVectors">>;
  es: EventStore;
  os: OutboxStore;
  ls: LexicalStore;
}

type Backend = "pg" | "testkit";

let scenarioSeq = 0;
const runTag = Math.random().toString(36).slice(2, 7);

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
    };
  } else {
    const ms = new InMemoryMemoryStore();
    s = {
      ms: ms as Required<MemoryStore>,
      vs: new InMemoryVectorStore(ms) as Stores["vs"],
      es: new InMemoryEventStore(ms, ms.events),
      os: new InMemoryOutboxStore(ms.outboxJobs),
      ls: new InMemoryLexicalStore(ms),
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
  const recallId: RecallId = await s.ms.createRecall(ctx, {
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
  });
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
  "registeredAt",
]);
const GENERATED_ID = /^(mem|obs|evt|rec|job|recall|ev)-\d+$|^[0-9a-f]{8}-[0-9a-f]{4}-/;

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

interface Outcome {
  result: string;
  state: string;
}

async function runOn(backend: Backend, f: (h: Kit) => Promise<unknown>): Promise<Outcome> {
  const h = await makeKit(backend);
  let result: string;
  try {
    result = `返した ${JSON.stringify(normalize(await f(h), h))}`;
  } catch {
    result = "投げた";
  }
  return { result, state: await snapshotState(h) };
}

const differing = new Map<string, { pg: Outcome; testkit: Outcome }>();

describe("store の公開の口の境界の入力: Postgres と testkit の fixture の差（PR #1252）", () => {
  beforeAll(async () => {
    await getTestClient();
    for (const [name, f] of scenarios) {
      const pg = await runOn("pg", f);
      const testkit = await runOn("testkit", f);
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
        `doc に「違う」と書いてから DOCUMENTED_DIFFERENCES に足すこと:\n${unexpected.join("\n")}`,
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
});
