import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { EventStore } from "../interfaces/event-store.js";
import type { LexicalStore } from "../interfaces/lexical-store.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { Memory, NewMemory } from "../memory.js";
import { createRuntime, type Runtime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

// 大文字の uuid の id は含めない: fixture の id は `mem-N` で、Postgres と割れることが分かっている。

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

const ctx: Ctx = { tenantId: "tenant-after-delete" };

let hashCounter = 0;
function newMemory(content: string): NewMemory {
  hashCounter += 1;
  return {
    tenantId: ctx.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content,
    contentHash: `after-delete-${hashCounter}`,
    digest: content,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24 * 365 * 10,
    decayFloorAt: new Date("2030-01-01T00:00:00.000Z"),
    embeddingStatus: "ready",
  };
}

describe("Runtime 層の「消した後の参照」と purgeExpiredEvents の後の参照（Fake）", () => {
  it("Postgres で実測した結果（EXPECTED）と一致する", async () => {
    const stores = createFakeRuntimeStores();
    const space = { provider: "fake", model: "fake-model", dimensions: 3 };
    const runtime: Runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      lexicalStore: stores.lexicalStore,
      eventStore: stores.eventStore,
      relationStore: stores.relationStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: {
        name: "unused",
        completeStructured: async () => {
          throw new Error("unused");
        },
      } as never,
      embeddingProvider: {
        space,
        embed: async (_ctx, texts) => texts.map(() => [1, 0, 0]),
      },
      hashContent: (content) => `h(${content})`,
      clock: { now: () => new Date("2026-01-02T00:00:00.000Z") },
    });
    const out = await scenario({
      runtime,
      mem: stores.memoryStore as MemoryStore,
      lex: stores.lexicalStore as LexicalStore,
      ev: stores.eventStore as EventStore,
      ctx,
      mk: async (content): Promise<Memory> => {
        const m = await stores.memoryStore.createMemory(ctx, newMemory(content));
        await stores.vectorStore.upsert(ctx, space, m.id, [1, 0, 0]);
        return m;
      },
    });
    expect(out).toEqual(EXPECTED);
  });
});
