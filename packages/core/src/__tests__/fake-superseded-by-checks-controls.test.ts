import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import {
  isContestedGroupMembershipMismatchError,
  isMemoryStatusConflictError,
} from "../interfaces/memory-store.js";
import type { Memory, NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0574（ADR 0557 の歯の穴）: `fake-superseded-by-checks.test.ts` の変異試験で生き残った5つを塞ぐ。
 *
 * - 陽性対照: 対・群の外の `superseded`・`contested` を指す `superseded` は通る（外の `active`・`archived` だけでは、
 *   「外の `superseded`・`contested` まで断る」やりすぎが緑のままだった）。
 * - 循環の走査は、先頭のキーだけでなく全メンバーから辿る（先頭が輪の外・尾が輪に入る形）。
 * - 形の検査・pair の循環の検査は、存在確認・`beforeUpdateStatus` hook・CAS より前（ADR 0557「位置」。
 *   testkit の InMemory・`PostgresMemoryStore` と同じ順。Postgres は `store-superseded-by-checks-controls.postgres.test.ts`）。
 */

const A: Ctx = { tenantId: "fake-superseded-by-controls-a" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
let counter = 0;

function newMemory(): NewMemory {
  counter += 1;
  return {
    tenantId: A.tenantId,
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: `本文 ${counter}`,
    contentHash: `fake-superseded-by-controls-${counter}`,
    digest: `要旨 ${counter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fake-superseded-by-controls" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 168,
    decayFloorAt: new Date("2100-01-01T00:00:00.000Z"),
    embeddingStatus: "pending",
  };
}

const ABSENT = "00000000-0000-4000-8000-0000000000aa";

function setup() {
  const store = createFakeRuntimeStores().memoryStore;
  const backing = (store as unknown as { backing: { events: unknown[] } }).backing;
  const hookCalls: string[] = [];
  (store as unknown as { beforeUpdateStatus: (id: string) => void }).beforeUpdateStatus = (id) => {
    hookCalls.push(id);
  };
  const mem = (): Promise<Memory> => store.createMemory(A, newMemory());
  const ev = (memoryId: string, kind: NewMemoryEvent["kind"] = "updated"): NewMemoryEvent => ({
    tenantId: A.tenantId,
    memoryId,
    kind,
    actor: { type: "system" },
    meta: { probe: true },
  });
  const snap = async (ids: string[]) =>
    Promise.all(
      ids.map(async (id) => {
        const m = (await store.get(A, id))!;
        return [m.status, m.supersededById ?? null, m.updatedAt.getTime()];
      }),
    );
  const expectRefused = async (
    ids: string[],
    message: RegExp,
    run: () => Promise<unknown>,
  ): Promise<void> => {
    const before = await snap(ids);
    const events = backing.events.length;
    let thrown: unknown;
    await run().catch((e: unknown) => {
      thrown = e;
    });
    expect(thrown).toBeInstanceOf(RangeError);
    expect((thrown as Error).message).toMatch(message);
    expect(await snap(ids)).toEqual(before);
    expect(backing.events.length).toBe(events);
  };
  const pair = async () => {
    const [a, b] = [await mem(), await mem()];
    await store.markContestedPair!(A, { id: a.id, event: ev(a.id) }, { id: b.id, event: ev(b.id) });
    return [a, b] as const;
  };
  const group = async () => {
    const ms = [await mem(), await mem(), await mem()];
    await store.markContestedGroup!(
      A,
      ms.map((m) => ({ id: m.id, event: ev(m.id) })),
    );
    return ms;
  };
  type Side = { status: "active" | "superseded"; by?: string };
  const resolvePair = (a: { id: string }, b: { id: string }, sa: Side, sb: Side) =>
    store.resolveContestedPair!(
      A,
      {
        id: a.id,
        status: sa.status,
        ...(sa.by === undefined ? {} : { supersededById: sa.by }),
        event: ev(a.id),
      },
      {
        id: b.id,
        status: sb.status,
        ...(sb.by === undefined ? {} : { supersededById: sb.by }),
        event: ev(b.id),
      },
    );
  const resolveGroup = (ms: Array<{ id: string }>, specs: Side[]) =>
    store.resolveContestedGroup!(
      A,
      ms.map((m, i) => ({
        id: m.id,
        status: specs[i]!.status,
        ...(specs[i]!.by === undefined ? {} : { supersededById: specs[i]!.by }),
        event: ev(m.id),
      })),
    );
  /** 外の記憶（対・群のメンバーではない）。status ごとに作る。 */
  const outside = async (status: "superseded" | "contested"): Promise<Memory> => {
    if (status === "superseded") {
      const m = await mem();
      const winner = await mem();
      await store.updateStatus(A, m.id, "superseded", { supersededById: winner.id });
      return (await store.get(A, m.id))!;
    }
    const [c] = await pair();
    return (await store.get(A, c.id))!;
  };
  return {
    store,
    mem,
    ev,
    hookCalls,
    expectRefused,
    pair,
    group,
    resolvePair,
    resolveGroup,
    outside,
  };
}

describe("Fake: 陽性対照 — 対・群の外の superseded・contested を指す superseded は通る（ADR 0557 の決定3）", () => {
  for (const kind of ["superseded", "contested"] as const) {
    it(`pair: 対の外の ${kind} を指す superseded は通る`, async () => {
      const s = setup();
      const [a, b] = await s.pair();
      const out = await s.outside(kind);
      expect(out.status).toBe(kind);
      const r = await s.resolvePair(
        a,
        b,
        { status: "active" },
        { status: "superseded", by: out.id },
      );
      expect([r.first.status, r.second.status, r.second.supersededById]).toEqual([
        "active",
        "superseded",
        out.id,
      ]);
    });

    it(`group: 群の外の ${kind} を指す superseded は通る`, async () => {
      const s = setup();
      const ms = await s.group();
      const out = await s.outside(kind);
      expect(out.status).toBe(kind);
      const r = await s.resolveGroup(ms, [
        { status: "active" },
        { status: "superseded", by: out.id },
        { status: "superseded", by: ms[0]!.id },
      ]);
      expect(r.members.map((m) => [m.status, m.supersededById ?? null])).toEqual([
        ["active", null],
        ["superseded", out.id],
        ["superseded", ms[0]!.id],
      ]);
    });
  }
});

describe("Fake: 循環の走査は先頭のキーだけでなく全メンバーから辿る（ADR 0503）", () => {
  const CYCLE = /^resolveContestedGroup: supersededById must not form a cycle among the members$/;

  it("輪が先頭に絡まない（先頭は群の外の active を指す）: RangeError で、何も書かない", async () => {
    const s = setup();
    const ms = await s.group();
    const out = await s.mem();
    await s.expectRefused([...ms.map((m) => m.id), out.id], CYCLE, () =>
      s.resolveGroup(ms, [
        { status: "superseded", by: out.id },
        { status: "superseded", by: ms[2]!.id },
        { status: "superseded", by: ms[1]!.id },
      ]),
    );
  });

  it("先頭が active で、後ろ2者が輪になる: RangeError で、何も書かない", async () => {
    const s = setup();
    const ms = await s.group();
    await s.expectRefused(
      ms.map((m) => m.id),
      CYCLE,
      () =>
        s.resolveGroup(ms, [
          { status: "active" },
          { status: "superseded", by: ms[2]!.id },
          { status: "superseded", by: ms[1]!.id },
        ]),
    );
  });

  it("尾が輪に入る形（m0 → m1 → m2 → m1）: RangeError で、何も書かない", async () => {
    const s = setup();
    const ms = await s.group();
    await s.expectRefused(
      ms.map((m) => m.id),
      CYCLE,
      () =>
        s.resolveGroup(ms, [
          { status: "superseded", by: ms[1]!.id },
          { status: "superseded", by: ms[2]!.id },
          { status: "superseded", by: ms[1]!.id },
        ]),
    );
  });
});

describe("Fake: 形・循環の検査は存在確認・hook・CAS より前（ADR 0557「位置」）", () => {
  it("updateStatus: 存在しない id でも、supersededById 無しの superseded は RangeError（not found ではない）で、hook を呼ばない", async () => {
    const s = setup();
    await s.expectRefused(
      [],
      /^updateStatus: opts\.supersededById is required when status is "superseded"$/,
      () => s.store.updateStatus(A, ABSENT, "superseded"),
    );
    expect(s.hookCalls).toEqual([]);
  });

  it("updateStatusWithEvent: 同じ（not found ではなく RangeError で、hook を呼ばない）", async () => {
    const s = setup();
    await s.expectRefused(
      [],
      /^updateStatusWithEvent: opts\.supersededById is required when status is "superseded"$/,
      () => s.store.updateStatusWithEvent(A, ABSENT, "superseded", {}, s.ev(ABSENT, "superseded")),
    );
    expect(s.hookCalls).toEqual([]);
  });

  it("updateStatus: 存在しない id の自己置換・active への付与も RangeError で、hook を呼ばない", async () => {
    const s = setup();
    await s.expectRefused([], /must not be the memory itself$/, () =>
      s.store.updateStatus(A, ABSENT, "superseded", { supersededById: ABSENT }),
    );
    await s.expectRefused([], /must not be set unless status is "superseded"$/, () =>
      s.store.updateStatus(A, ABSENT, "active", { supersededById: ABSENT }),
    );
    expect(s.hookCalls).toEqual([]);
  });

  it("updateStatus: 存在する id でも、形の検査が hook より前（hook を呼ばない）", async () => {
    const s = setup();
    const t = await s.mem();
    await s.expectRefused([t.id], /is required when status is "superseded"$/, () =>
      s.store.updateStatus(A, t.id, "superseded"),
    );
    expect(s.hookCalls).toEqual([]);
  });

  it("pair: contested でない2件が互いを指す循環は、MemoryStatusConflictError ではなく循環の RangeError で、hook を呼ばない", async () => {
    const s = setup();
    const a = await s.mem();
    const b = await s.mem();
    await s.expectRefused(
      [a.id, b.id],
      /^resolveContestedPair: supersededById must not form a cycle among the members$/,
      () =>
        s.resolvePair(a, b, { status: "superseded", by: b.id }, { status: "superseded", by: a.id }),
    );
    expect(s.hookCalls).toEqual([]);
  });

  it("pair: 存在しない2件が互いを指す循環も、not found ではなく循環の RangeError で、hook を呼ばない", async () => {
    const s = setup();
    const x = "00000000-0000-4000-8000-0000000000b1";
    const y = "00000000-0000-4000-8000-0000000000b2";
    await s.expectRefused([], /must not form a cycle among the members$/, () =>
      s.resolvePair(
        { id: x },
        { id: y },
        { status: "superseded", by: y },
        { status: "superseded", by: x },
      ),
    );
    expect(s.hookCalls).toEqual([]);
  });

  it("group: contested でない3件が輪になる循環も、MemoryStatusConflictError ではなく循環の RangeError で、hook を呼ばない", async () => {
    const s = setup();
    const ms = [await s.mem(), await s.mem(), await s.mem()];
    await s.expectRefused(
      ms.map((m) => m.id),
      /^resolveContestedGroup: supersededById must not form a cycle among the members$/,
      () =>
        s.resolveGroup(ms, [
          { status: "active" },
          { status: "superseded", by: ms[2]!.id },
          { status: "superseded", by: ms[1]!.id },
        ]),
    );
    expect(s.hookCalls).toEqual([]);
  });
});

/**
 * ADR 0584（ADR 0574 の歯の穴）: 前回の確かめ直しで、どの歯にも捕まらなかった変異を塞ぐ。
 *
 * - F14: 対の外の `forgotten` を指す検査を CAS より前へ動かしても通っていた。
 * - F10・F12: 対・群の形の検査を、存在確認や CAS の後ろへ動かしても 0574 の歯は緑のままだった（0557 の歯1本だけが捕まえた）。
 */
describe("Fake: 外の forgotten の検査は CAS より後（ADR 0515・0584）", () => {
  const forgotten = async (s: ReturnType<typeof setup>): Promise<Memory> => {
    const m = await s.mem();
    await s.store.updateStatus(A, m.id, "forgotten");
    return (await s.store.get(A, m.id))!;
  };

  it("pair: contested でない2件 + 外の forgotten を指す superseded は、RangeError ではなく MemoryStatusConflictError", async () => {
    const s = setup();
    const a = await s.mem();
    const b = await s.mem();
    const out = await forgotten(s);
    expect(out.status).toBe("forgotten");
    const events = (s.store as unknown as { backing: { events: unknown[] } }).backing.events.length;
    let thrown: unknown;
    await s
      .resolvePair(a, b, { status: "active" }, { status: "superseded", by: out.id })
      .catch((e: unknown) => {
        thrown = e;
      });
    expect(isMemoryStatusConflictError(thrown)).toBe(true);
    expect(thrown).not.toBeInstanceOf(RangeError);
    expect((await s.store.get(A, b.id))!.status).toBe("active");
    expect((s.store as unknown as { backing: { events: unknown[] } }).backing.events.length).toBe(
      events,
    );
  });

  it("group: contested でない3件 + 外の forgotten を指す superseded は、RangeError ではなく MemoryStatusConflictError", async () => {
    const s = setup();
    const ms = [await s.mem(), await s.mem(), await s.mem()];
    const out = await forgotten(s);
    let thrown: unknown;
    await s
      .resolveGroup(ms, [
        { status: "active" },
        { status: "superseded", by: out.id },
        { status: "active" },
      ])
      .catch((e: unknown) => {
        thrown = e;
      });
    expect(isMemoryStatusConflictError(thrown)).toBe(true);
    expect(thrown).not.toBeInstanceOf(RangeError);
  });

  it("group: 群の一部だけを渡し + 外の forgotten を指す superseded は、RangeError ではなく ContestedGroupMembershipMismatchError", async () => {
    const s = setup();
    const four = [await s.mem(), await s.mem(), await s.mem(), await s.mem()];
    await s.store.markContestedGroup!(
      A,
      four.map((m) => ({ id: m.id, event: s.ev(m.id) })),
    );
    const out = await forgotten(s);
    const three = four.slice(0, 3);
    let thrown: unknown;
    await s
      .resolveGroup(three, [
        { status: "active" },
        { status: "superseded", by: out.id },
        { status: "active" },
      ])
      .catch((e: unknown) => {
        thrown = e;
      });
    expect(isContestedGroupMembershipMismatchError(thrown)).toBe(true);
    expect(thrown).not.toBeInstanceOf(RangeError);
  });
});

describe("Fake: pair・group の形の検査は存在確認・CAS より前（ADR 0503・0584）", () => {
  const PAIR_SHAPE =
    /^resolveContestedPair: second\.supersededById is required when status is "superseded"$/;
  const GROUP_SHAPE =
    /^resolveContestedGroup: members\[1\]\.supersededById is required when status is "superseded"$/;
  const X = "00000000-0000-4000-8000-0000000000c1";
  const Y = "00000000-0000-4000-8000-0000000000c2";
  const Z = "00000000-0000-4000-8000-0000000000c3";

  it("pair: 存在しない2件 + supersededById 無しの superseded は、not found ではなく形の RangeError で、hook を呼ばない", async () => {
    const s = setup();
    await s.expectRefused([], PAIR_SHAPE, () =>
      s.resolvePair({ id: X }, { id: Y }, { status: "active" }, { status: "superseded" }),
    );
    expect(s.hookCalls).toEqual([]);
  });

  it("pair: contested でない2件（CAS が外れる）+ supersededById 無しの superseded は、MemoryStatusConflictError ではなく形の RangeError で、hook を呼ばない", async () => {
    const s = setup();
    const a = await s.mem();
    const b = await s.mem();
    await s.expectRefused([a.id, b.id], PAIR_SHAPE, () =>
      s.resolvePair(a, b, { status: "active" }, { status: "superseded" }),
    );
    expect(s.hookCalls).toEqual([]);
  });

  it("pair: contested でない2件 + 自己置換は、形の RangeError", async () => {
    const s = setup();
    const a = await s.mem();
    const b = await s.mem();
    await s.expectRefused([a.id, b.id], /must not be the memory itself$/, () =>
      s.resolvePair(a, b, { status: "active" }, { status: "superseded", by: b.id }),
    );
    expect(s.hookCalls).toEqual([]);
  });

  it("group: 存在しない3件 + supersededById 無しの superseded は、not found ではなく形の RangeError で、hook を呼ばない", async () => {
    const s = setup();
    await s.expectRefused([], GROUP_SHAPE, () =>
      s.resolveGroup(
        [{ id: X }, { id: Y }, { id: Z }],
        [{ status: "active" }, { status: "superseded" }, { status: "active" }],
      ),
    );
    expect(s.hookCalls).toEqual([]);
  });

  it("group: contested でない3件（CAS が外れる）+ supersededById 無しの superseded は、MemoryStatusConflictError ではなく形の RangeError で、hook を呼ばない", async () => {
    const s = setup();
    const ms = [await s.mem(), await s.mem(), await s.mem()];
    await s.expectRefused(
      ms.map((m) => m.id),
      GROUP_SHAPE,
      () =>
        s.resolveGroup(ms, [{ status: "active" }, { status: "superseded" }, { status: "active" }]),
    );
    expect(s.hookCalls).toEqual([]);
  });

  it("group: contested でない3件 + 自己置換は、形の RangeError", async () => {
    const s = setup();
    const ms = [await s.mem(), await s.mem(), await s.mem()];
    await s.expectRefused(
      ms.map((m) => m.id),
      /must not be the memory itself$/,
      () =>
        s.resolveGroup(ms, [
          { status: "active" },
          { status: "superseded", by: ms[1]!.id },
          { status: "active" },
        ]),
    );
    expect(s.hookCalls).toEqual([]);
  });
});

describe("Fake: 存在しない id の not found は RangeError ではない（ADR 0584 の約束 D の陽性対照、確かめ直し）", () => {
  // Postgres 側の陽性対照（store-superseded-by-checks-controls.postgres.test.ts）は DB が要る。
  // core の Fake の `updateStatus` の not found を RangeError で投げても、他の歯は捕まえなかった。
  it("updateStatus: 形が正しい存在しない id は、RangeError ではなく memory not found の Error", async () => {
    const s = setup();
    const other = await s.mem();
    for (const run of [
      () => s.store.updateStatus(A, ABSENT, "archived"),
      () => s.store.updateStatus(A, ABSENT, "superseded", { supersededById: other.id }),
    ]) {
      let thrown: unknown;
      await run().catch((e: unknown) => {
        thrown = e;
      });
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(RangeError);
      expect((thrown as Error).message).toMatch(/memory not found for tenant/);
    }
  });
});
