import { afterAll, describe, expect, it } from "vitest";
import type {
  Ctx,
  EventStore,
  LexicalStore,
  Memory,
  MemoryStore,
  NewMemoryEvent,
  Runtime,
} from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import {
  InMemoryEventStore,
  InMemoryLexicalStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryRelationStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresRelationStore } from "../relation-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  TEST_EMBEDDING_SPACE,
  closeTestClient,
  getTestClient,
  resetTestDatabase,
} from "./test-db.js";

/**
 * Runtime 層の「消した後の参照」と `purgeExpiredEvents` の後の `EventStore` の参照、`LexicalFilter` に無い `decayFloor*After` を渡したときの結果を、
 * 実 Postgres と InMemory の両方で `EXPECTED` に突き合わせる。core の Fake の側は `packages/core/src/__tests__/fake-runtime-after-delete-parity.test.ts` が同じ `EXPECTED` を縛る。
 * 大文字の uuid の id は含めない。
 */

interface Env {
  runtime: Runtime;
  mem: MemoryStore;
  lex: LexicalStore;
  ev: EventStore;
  mk: (content: string) => Promise<Memory>;
  ctx: Ctx;
}

interface Outcomes {
  outcomes: Array<{ kind: string }>;
}

/**
 * 同じ操作列を、実装ごとの組み立て（`Env`）に流し、結果を平らなデータにする。core の Fake の歯（`fake-runtime-after-delete-parity.test.ts`）と、
 * InMemory・Postgres の歯（このファイル）が、同じ `EXPECTED` に突き合わせる。
 */
async function scenario(env: Env): Promise<Record<string, unknown>> {
  const { runtime, mem, lex, ev, mk, ctx } = env;
  const out: Record<string, unknown> = {};
  const D = (s: string) => new Date(s);
  const event0 = (id: string | null, kind: NewMemoryEvent["kind"], at?: Date): NewMemoryEvent => ({
    tenantId: ctx.tenantId,
    memoryId: id,
    kind,
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
    ...(at ? { at } : {}),
  });
  const toState = async (m: Memory, st: string) => {
    if (st === "forgotten" || st === "purged") await mem.updateStatus(ctx, m.id, "forgotten");
    if (st === "archived") await mem.updateStatus(ctx, m.id, "archived");
    if (st === "purged") {
      await mem.purgeMemory!(
        ctx,
        m.id,
        { content: "[purged]", digest: "[purged]" },
        event0(m.id, "purged"),
      );
    }
  };
  const kindsOf = (r: Outcomes) => r.outcomes.map((o) => o.kind);
  for (const st of ["active", "forgotten", "archived", "purged"]) {
    let m = await mk(`banana ${st} forget`);
    await toState(m, st);
    out[`forget(${st})`] = kindsOf(await runtime.forget(ctx, { memoryId: m.id }));
    m = await mk(`banana ${st} purge`);
    await toState(m, st);
    out[`purge(${st})`] = kindsOf((await runtime.purge(ctx, { memoryId: m.id })) as Outcomes);
    m = await mk(`banana ${st} restoreArchived`);
    await toState(m, st);
    out[`restoreArchived(${st})`] = kindsOf(await runtime.restoreArchived(ctx, { memoryId: m.id }));
    const old = await mk(`banana old ${st}`);
    const n = await mk(`banana new ${st}`);
    await mem.updateStatus(ctx, old.id, "superseded", { supersededById: n.id });
    await toState(n, st);
    const rs = await runtime.restoreSuperseded(ctx, { supersededById: n.id });
    out[`restoreSuperseded(superseder ${st})`] = [
      kindsOf(rs as Outcomes),
      (await mem.get(ctx, old.id))?.status,
    ];
    const a = await mk(`banana a ${st}`);
    const b2 = await mk(`banana b ${st}`);
    await toState(b2, st);
    const mc = (await runtime.markContested(ctx, a.id, b2.id)) as {
      outcome: { kind: string; sides?: Array<{ kind: string }> };
    };
    out[`markContested(${st})`] = [mc.outcome.kind, mc.outcome.sides?.map((s) => s.kind) ?? null];
    const q = await mk(`unique${st} query`);
    await toState(q, st);
    const rc = await runtime.recall(ctx, {
      text: `unique${st}`,
      vector: [1, 0, 0],
      limit: 50,
      channels: ["ann", "lexical"],
    });
    out[`recall hits m(${st})`] = rc.memories.some((x) => x.memoryId === q.id);
    const old2 = await mk(`zebra corrected ${st}`);
    const cr = await mk(`zebra correcting ${st}`);
    await toState(old2, st);
    const d = await runtime.findCorrectionCandidates(ctx, {
      text: `zebra corrected ${st}`,
      excludeMemoryIds: [cr.id],
      limit: 100,
    });
    const ac = await runtime.applyCorrection(ctx, {
      discovery: d,
      correctedId: old2.id,
      correctingId: cr.id,
    });
    out[`applyCorrection(corrected ${st})`] = ac.kind;
  }
  // purgeExpiredEvents の後の EventStore の参照
  const em = await mk("events memory");
  const eids: string[] = [];
  for (const at of [
    "2026-01-01T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
    "2026-01-03T00:00:00.000Z",
  ]) {
    eids.push((await ev.append(ctx, event0(em.id, "updated", D(at)))).id);
  }
  const dry = await mem.purgeExpiredEvents!(ctx, {
    olderThan: D("2026-01-03T00:00:00.000Z"),
    limit: 100,
    dryRun: true,
  });
  out["purgeExpiredEvents dryRun"] = [
    dry.purged,
    dry.dryRun,
    (await ev.list(ctx, { memoryId: em.id })).length,
  ];
  const pe = await mem.purgeExpiredEvents!(ctx, {
    olderThan: D("2026-01-03T00:00:00.000Z"),
    limit: 100,
  });
  out["purgeExpiredEvents"] = [pe.purged, pe.reachedLimit];
  out["after purge: get purged event"] = await ev.get(ctx, eids[0]!);
  out["after purge: get surviving event kind"] = (await ev.get(ctx, eids[2]!))?.kind ?? null;
  out["after purge: list by memoryId count"] = (await ev.list(ctx, { memoryId: em.id })).length;
  const rec = await ev.list(ctx, { kind: "events_purged" });
  out["after purge: events_purged record"] = [
    rec.length,
    rec[0]?.memoryId,
    rec[0]?.meta["purgedCount"],
  ];
  out["after purge: second purge"] = (
    await mem.purgeExpiredEvents!(ctx, { olderThan: D("2026-01-03T00:00:00.000Z"), limit: 100 })
  ).purged;
  out["after purge: memory still readable"] = (await mem.get(ctx, em.id))?.status;
  // LexicalFilter は decayFloorAtAfter・decayFloorSeqAfter を持たない。型の外から渡しても、どの実装も黙って無視する
  const lm = await mk("lexicalfilterprobe");
  const lh = await lex.search(ctx, "lexicalfilterprobe", {
    limit: 5,
    filter: {
      tenantId: ctx.tenantId,
      decayFloorAtAfter: new Date(Number.NaN),
      decayFloorSeqAfter: Number.NaN,
    } as never,
  });
  out["lexical filter ignores decayFloor*After"] = lh.map((h) => h.memoryId === lm.id);
  return out;
}

const EXPECTED: Record<string, unknown> = {
  "forget(active)": ["forgotten"],
  "purge(active)": ["status_not_forgotten"],
  "restoreArchived(active)": ["status_not_archived"],
  "restoreSuperseded(superseder active)": [["restored"], "active"],
  "markContested(active)": ["contested", null],
  "recall hits m(active)": true,
  "applyCorrection(corrected active)": "contested",
  "forget(forgotten)": ["already_forgotten"],
  "purge(forgotten)": ["purged"],
  "restoreArchived(forgotten)": ["status_not_archived"],
  "restoreSuperseded(superseder forgotten)": [["restored"], "active"],
  "markContested(forgotten)": ["ineligible", ["eligible", "status_not_active"]],
  "recall hits m(forgotten)": false,
  "applyCorrection(corrected forgotten)": "not_a_candidate",
  "forget(archived)": ["forgotten"],
  "purge(archived)": ["status_not_forgotten"],
  "restoreArchived(archived)": ["restored"],
  "restoreSuperseded(superseder archived)": [["restored"], "active"],
  "markContested(archived)": ["ineligible", ["eligible", "status_not_active"]],
  "recall hits m(archived)": false,
  "applyCorrection(corrected archived)": "not_a_candidate",
  "forget(purged)": ["already_forgotten"],
  "purge(purged)": ["already_purged"],
  "restoreArchived(purged)": ["status_not_archived"],
  "restoreSuperseded(superseder purged)": [["restored"], "active"],
  "markContested(purged)": ["ineligible", ["eligible", "status_not_active"]],
  "recall hits m(purged)": false,
  "applyCorrection(corrected purged)": "not_a_candidate",
  "purgeExpiredEvents dryRun": [14, true, 3],
  purgeExpiredEvents: [14, false],
  "after purge: get purged event": null,
  "after purge: get surviving event kind": "updated",
  "after purge: list by memoryId count": 1,
  "after purge: events_purged record": [1, null, 14],
  "after purge: second purge": 0,
  "after purge: memory still readable": "active",
  "lexical filter ignores decayFloor*After": [true],
};

const ctx: Ctx = { tenantId: "runtime-after-delete-parity" };
const space = TEST_EMBEDDING_SPACE;
const llm = {
  name: "unused",
  completeStructured: async () => {
    throw new Error("unused");
  },
};

afterAll(async () => {
  await closeTestClient();
});

let hashCounter = 0;
function memoryFixture(content: string) {
  hashCounter += 1;
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    contentHash: `after-delete-${hashCounter}`,
    content,
    digest: content,
    embeddingStatus: "ready",
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
  });
}

function build(stores: {
  mem: MemoryStore;
  vec: PostgresVectorStore | InMemoryVectorStore;
  lex: LexicalStore;
  ev: EventStore;
  ob: PostgresOutboxStore | InMemoryOutboxStore;
  ts: PostgresTenantSettingsStore | InMemoryTenantSettingsStore;
  rel: PostgresRelationStore | InMemoryRelationStore;
}) {
  const runtime: Runtime = createRuntime({
    memoryStore: stores.mem,
    vectorStore: stores.vec,
    lexicalStore: stores.lex,
    outboxStore: stores.ob,
    eventStore: stores.ev,
    relationStore: stores.rel,
    tenantSettingsStore: stores.ts,
    llmProvider: llm as never,
    embeddingProvider: { space, embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]) },
    hashContent: (content) => `h(${content})`,
    clock: { now: () => new Date("2026-01-02T00:00:00.000Z") },
  });
  return {
    runtime,
    mem: stores.mem,
    lex: stores.lex,
    ev: stores.ev,
    ctx,
    mk: async (content: string): Promise<Memory> => {
      const m = await stores.mem.createMemory(ctx, memoryFixture(content));
      await stores.vec.upsert(ctx, space, m.id, [1, 0, 0]);
      return m;
    },
  };
}

describe("Runtime 層の「消した後の参照」と purgeExpiredEvents の後の参照（InMemory・Postgres）", () => {
  it("InMemory の、active・forgotten・archived・purged の記憶への forget・purge・restoreArchived・markContested の結果と purgeExpiredEvents の件数が、Postgres で実測した値（EXPECTED）と一致する", async () => {
    const m = new InMemoryMemoryStore();
    const env = build({
      mem: m,
      vec: new InMemoryVectorStore(m),
      lex: new InMemoryLexicalStore(m),
      ev: new InMemoryEventStore(m, m.events),
      ob: new InMemoryOutboxStore(m.outboxJobs),
      ts: new InMemoryTenantSettingsStore(
        m.activitySeq,
        m.subjectActivitySeq,
        m.eventRetentionDays,
      ),
      rel: new InMemoryRelationStore(m),
    });
    expect(await scenario(env)).toEqual(EXPECTED);
  });

  it("Postgres の、active・forgotten・archived・purged の記憶への forget・purge・restoreArchived・markContested の結果と purgeExpiredEvents の件数が、EXPECTED と一致する", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const mem = new PostgresMemoryStore(db);
    const env = build({
      mem,
      vec: new PostgresVectorStore(db),
      lex: new PostgresLexicalStore(db),
      ev: new PostgresEventStore(db),
      ob: new PostgresOutboxStore(db),
      ts: new PostgresTenantSettingsStore(db),
      rel: new PostgresRelationStore(db),
    });
    expect(await scenario(env)).toEqual(EXPECTED);
  });
});
