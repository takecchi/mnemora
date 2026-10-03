import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import type { Memory, NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * ADR 0557（ADR 0503・0515 の「Fake は揃えていない」負債）: core の Fake（`FakeMemoryStore`）も、`supersededById`
 * （置き換えた側）の約束を壊す入力を、書く前に `RangeError` で断る。testkit の `InMemoryMemoryStore`・`PostgresMemoryStore` と同じ文面。
 *
 * - `status: "superseded"` に `supersededById` が無い（4口: `updateStatus`・`updateStatusWithEvent`・`resolveContestedPair`・`resolveContestedGroup`）
 * - 自己置換（4口。id の大文字小文字は畳んで比べる）
 * - `superseded` 以外（pair・group では `active`）への付与（4口）
 * - メンバー間の循環（pair・group）
 * - 対の外・群の外の `forgotten` を指す（pair は ADR 0515、group は ADR 0503）
 *
 * 断られたとき、行（status・supersededById）もイベントも変わらない。陽性対照（勝者・相手・外の `active`/`archived` を指す、
 * `supersededById` 無しの非 superseded）は通る。⚠ ADR 0499 の `assertResolvedStatus`（列挙の外の status）は、この Fake には入れていない（ADR 0557 の材料A）。
 */

const A: Ctx = { tenantId: "fake-superseded-by-a" };
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
    contentHash: `fake-superseded-by-${counter}`,
    digest: `要旨 ${counter}`,
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fake-superseded-by" },
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

function setup() {
  const store = createFakeRuntimeStores().memoryStore;
  const backing = (store as unknown as { backing: { events: unknown[] } }).backing;
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
  /** 断られ、行もイベントも変わらないことを確かめる。 */
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
  const resolvePair = (a: Memory, b: Memory, sa: Side, sb: Side) =>
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
  const resolveGroup = (ms: Memory[], specs: Side[]) =>
    store.resolveContestedGroup!(
      A,
      ms.map((m, i) => ({
        id: m.id,
        status: specs[i]!.status,
        ...(specs[i]!.by === undefined ? {} : { supersededById: specs[i]!.by }),
        event: ev(m.id),
      })),
    );
  return { store, mem, ev, expectRefused, pair, group, resolvePair, resolveGroup };
}

describe("Fake: resolveContestedPair の supersededById（ADR 0503・0515）", () => {
  it("superseded に supersededById が無い（first・second・両方）は RangeError で、何も書かない", async () => {
    const s = setup();
    const [a, b] = await s.pair();
    const ids = [a.id, b.id];
    await s.expectRefused(
      ids,
      /^resolveContestedPair: first\.supersededById is required when status is "superseded"$/,
      () => s.resolvePair(a, b, { status: "superseded" }, { status: "active" }),
    );
    await s.expectRefused(
      ids,
      /^resolveContestedPair: second\.supersededById is required when status is "superseded"$/,
      () => s.resolvePair(a, b, { status: "active" }, { status: "superseded" }),
    );
    await s.expectRefused(ids, /^resolveContestedPair: first\.supersededById is required/, () =>
      s.resolvePair(a, b, { status: "superseded" }, { status: "superseded" }),
    );
  });

  it("自己置換は RangeError で、何も書かない（大文字の id でも）", async () => {
    const s = setup();
    const [a, b] = await s.pair();
    const ids = [a.id, b.id];
    await s.expectRefused(
      ids,
      /^resolveContestedPair: second\.supersededById must not be the memory itself$/,
      () => s.resolvePair(a, b, { status: "active" }, { status: "superseded", by: b.id }),
    );
    await s.expectRefused(
      ids,
      /^resolveContestedPair: first\.supersededById must not be the memory itself$/,
      () => s.resolvePair(a, b, { status: "superseded", by: a.id }, { status: "active" }),
    );
    await s.expectRefused(
      ids,
      /^resolveContestedPair: first\.supersededById must not be the memory itself$/,
      () =>
        s.resolvePair(a, b, { status: "superseded", by: a.id.toUpperCase() }, { status: "active" }),
    );
  });

  it("互いを指す循環は RangeError で、何も書かない（大文字の id でも）", async () => {
    const s = setup();
    const [a, b] = await s.pair();
    const ids = [a.id, b.id];
    await s.expectRefused(
      ids,
      /^resolveContestedPair: supersededById must not form a cycle among the members$/,
      () =>
        s.resolvePair(a, b, { status: "superseded", by: b.id }, { status: "superseded", by: a.id }),
    );
    await s.expectRefused(ids, /must not form a cycle/, () =>
      s.resolvePair(
        a,
        b,
        { status: "superseded", by: b.id.toUpperCase() },
        { status: "superseded", by: a.id },
      ),
    );
  });

  it("active に supersededById を付けるのは RangeError で、何も書かない", async () => {
    const s = setup();
    const [a, b] = await s.pair();
    await s.expectRefused(
      [a.id, b.id],
      /^resolveContestedPair: first\.supersededById must not be set unless status is "superseded"$/,
      () => s.resolvePair(a, b, { status: "active", by: b.id }, { status: "active" }),
    );
    await s.expectRefused(
      [a.id, b.id],
      /^resolveContestedPair: second\.supersededById must not be set unless/,
      () => s.resolvePair(a, b, { status: "active" }, { status: "active", by: a.id }),
    );
  });

  it("対の外の forgotten を指すのは RangeError で、何も書かない（ADR 0515）", async () => {
    const s = setup();
    const [a, b] = await s.pair();
    const gone = await s.mem();
    await s.store.updateStatus(A, gone.id, "forgotten");
    const ids = [a.id, b.id, gone.id];
    await s.expectRefused(
      ids,
      /^resolveContestedPair: first\.supersededById must not be a forgotten memory outside the pair$/,
      () => s.resolvePair(a, b, { status: "superseded", by: gone.id }, { status: "active" }),
    );
    await s.expectRefused(
      ids,
      /^resolveContestedPair: second\.supersededById must not be a forgotten memory outside the pair$/,
      () => s.resolvePair(a, b, { status: "active" }, { status: "superseded", by: gone.id }),
    );
  });

  it("陽性対照: 勝者・相手・外の active・外の archived を指す superseded、both_active は通る", async () => {
    const s = setup();
    let [a, b] = await s.pair();
    let r = await s.resolvePair(a, b, { status: "active" }, { status: "superseded", by: a.id });
    expect([r.first.status, r.second.status, r.second.supersededById]).toEqual([
      "active",
      "superseded",
      a.id,
    ]);
    [a, b] = await s.pair();
    r = await s.resolvePair(a, b, { status: "superseded", by: b.id }, { status: "active" });
    expect([r.first.status, r.first.supersededById]).toEqual(["superseded", b.id]);
    [a, b] = await s.pair();
    r = await s.resolvePair(a, b, { status: "active" }, { status: "active" });
    expect([r.first.status, r.second.status]).toEqual(["active", "active"]);
    [a, b] = await s.pair();
    const outside = await s.mem();
    r = await s.resolvePair(a, b, { status: "active" }, { status: "superseded", by: outside.id });
    expect(r.second.supersededById).toBe(outside.id);
    [a, b] = await s.pair();
    const archived = await s.mem();
    await s.store.updateStatus(A, archived.id, "archived");
    r = await s.resolvePair(a, b, { status: "active" }, { status: "superseded", by: archived.id });
    expect(r.second.supersededById).toBe(archived.id);
  });
});

describe("Fake: resolveContestedGroup の supersededById（ADR 0503）", () => {
  it("superseded に supersededById が無いメンバーは RangeError で、何も書かない", async () => {
    const s = setup();
    const ms = await s.group();
    await s.expectRefused(
      ms.map((m) => m.id),
      /^resolveContestedGroup: members\[1\]\.supersededById is required when status is "superseded"$/,
      () =>
        s.resolveGroup(ms, [
          { status: "active" },
          { status: "superseded" },
          { status: "superseded", by: ms[0]!.id },
        ]),
    );
  });

  it("自己置換は RangeError で、何も書かない（大文字の id でも）", async () => {
    const s = setup();
    const ms = await s.group();
    const ids = ms.map((m) => m.id);
    await s.expectRefused(
      ids,
      /^resolveContestedGroup: members\[2\]\.supersededById must not be the memory itself$/,
      () =>
        s.resolveGroup(ms, [
          { status: "active" },
          { status: "superseded", by: ms[0]!.id },
          { status: "superseded", by: ms[2]!.id },
        ]),
    );
    await s.expectRefused(ids, /members\[2\]\.supersededById must not be the memory itself/, () =>
      s.resolveGroup(ms, [
        { status: "active" },
        { status: "superseded", by: ms[0]!.id },
        { status: "superseded", by: ms[2]!.id.toUpperCase() },
      ]),
    );
  });

  it("メンバー同士で輪になる（2者・3者）のは RangeError で、何も書かない", async () => {
    const s = setup();
    const ms = await s.group();
    const ids = ms.map((m) => m.id);
    await s.expectRefused(
      ids,
      /^resolveContestedGroup: supersededById must not form a cycle among the members$/,
      () =>
        s.resolveGroup(ms, [
          { status: "active" },
          { status: "superseded", by: ms[2]!.id },
          { status: "superseded", by: ms[1]!.id },
        ]),
    );
    await s.expectRefused(ids, /must not form a cycle/, () =>
      s.resolveGroup(ms, [
        { status: "superseded", by: ms[1]!.id },
        { status: "superseded", by: ms[2]!.id },
        { status: "superseded", by: ms[0]!.id },
      ]),
    );
    // 大文字の supersededById で輪になる形も、同じ RangeError（ADR 0557 の「循環は両側を畳んで比べる」。2者版の歯と揃える。ADR 0595）。
    await s.expectRefused(
      ids,
      /^resolveContestedGroup: supersededById must not form a cycle among the members$/,
      () =>
        s.resolveGroup(ms, [
          { status: "active" },
          { status: "superseded", by: ms[2]!.id.toUpperCase() },
          { status: "superseded", by: ms[1]!.id },
        ]),
    );
  });

  it("群の外の forgotten を指すのは RangeError で、何も書かない", async () => {
    const s = setup();
    const ms = await s.group();
    const gone = await s.mem();
    await s.store.updateStatus(A, gone.id, "forgotten");
    await s.expectRefused(
      [...ms.map((m) => m.id), gone.id],
      /^resolveContestedGroup: members\[1\]\.supersededById must not be a forgotten memory outside the group$/,
      () =>
        s.resolveGroup(ms, [
          { status: "active" },
          { status: "superseded", by: gone.id },
          { status: "superseded", by: ms[0]!.id },
        ]),
    );
  });

  it("active に supersededById を付けるのは RangeError で、何も書かない", async () => {
    const s = setup();
    const ms = await s.group();
    await s.expectRefused(
      ms.map((m) => m.id),
      /^resolveContestedGroup: members\[0\]\.supersededById must not be set unless status is "superseded"$/,
      () =>
        s.resolveGroup(ms, [
          { status: "active", by: ms[1]!.id },
          { status: "active" },
          { status: "active" },
        ]),
    );
  });

  it("陽性対照: 勝者・群の外の active・外の archived を指す superseded、both_active は通る", async () => {
    const s = setup();
    let ms = await s.group();
    let r = await s.resolveGroup(ms, [
      { status: "active" },
      { status: "superseded", by: ms[0]!.id },
      { status: "superseded", by: ms[0]!.id },
    ]);
    expect(r.members.map((m) => [m.status, m.supersededById ?? null])).toEqual([
      ["active", null],
      ["superseded", ms[0]!.id],
      ["superseded", ms[0]!.id],
    ]);
    ms = await s.group();
    const outside = await s.mem();
    r = await s.resolveGroup(ms, [
      { status: "active" },
      { status: "superseded", by: outside.id },
      { status: "superseded", by: ms[0]!.id },
    ]);
    expect(r.members[1]!.supersededById).toBe(outside.id);
    ms = await s.group();
    const archived = await s.mem();
    await s.store.updateStatus(A, archived.id, "archived");
    r = await s.resolveGroup(ms, [
      { status: "active" },
      { status: "superseded", by: archived.id },
      { status: "superseded", by: ms[0]!.id },
    ]);
    expect(r.members[1]!.supersededById).toBe(archived.id);
    // 輪にならない鎖（members[2] → members[1] → members[0]）は断らない（InMemory・Postgres と同じ）。
    ms = await s.group();
    r = await s.resolveGroup(ms, [
      { status: "active" },
      { status: "superseded", by: ms[0]!.id },
      { status: "superseded", by: ms[1]!.id },
    ]);
    expect(r.members.map((m) => [m.status, m.supersededById ?? null])).toEqual([
      ["active", null],
      ["superseded", ms[0]!.id],
      ["superseded", ms[1]!.id],
    ]);
    ms = await s.group();
    r = await s.resolveGroup(ms, [
      { status: "active" },
      { status: "active" },
      { status: "active" },
    ]);
    expect(r.members.map((m) => m.status)).toEqual(["active", "active", "active"]);
  });
});

describe("Fake: updateStatus / updateStatusWithEvent の supersededById（ADR 0503）", () => {
  type Opts = { supersededById?: string; expectedStatus?: "active" };
  const callers = [
    [
      "updateStatus",
      (
        s: ReturnType<typeof setup>,
        id: string,
        status: "superseded" | "active" | "archived" | "forgotten",
        opts?: Opts,
      ) => s.store.updateStatus(A, id, status, opts),
    ],
    [
      "updateStatusWithEvent",
      (
        s: ReturnType<typeof setup>,
        id: string,
        status: "superseded" | "active" | "archived" | "forgotten",
        opts?: Opts,
      ) => s.store.updateStatusWithEvent(A, id, status, opts ?? {}, s.ev(id, "superseded")),
    ],
  ] as const;

  for (const [name, call] of callers) {
    it(`${name}: superseded に supersededById が無い（空 opts・expectedStatus だけ）は RangeError で、何も書かない`, async () => {
      const s = setup();
      const t = await s.mem();
      const re = new RegExp(
        `^${name}: opts\\.supersededById is required when status is "superseded"$`,
      );
      await s.expectRefused([t.id], re, () => call(s, t.id, "superseded", {}));
      await s.expectRefused([t.id], re, () =>
        call(s, t.id, "superseded", { expectedStatus: "active" }),
      );
      if (name === "updateStatus")
        await s.expectRefused([t.id], re, () => call(s, t.id, "superseded"));
    });

    it(`${name}: 自己置換は RangeError で、何も書かない（大文字小文字違いでも）`, async () => {
      const s = setup();
      const t = await s.mem();
      const re = new RegExp(`^${name}: opts\\.supersededById must not be the memory itself$`);
      await s.expectRefused([t.id], re, () =>
        call(s, t.id, "superseded", { supersededById: t.id }),
      );
      await s.expectRefused([t.id], re, () =>
        call(s, t.id.toUpperCase(), "superseded", { supersededById: t.id }),
      );
      await s.expectRefused([t.id], re, () =>
        call(s, t.id, "superseded", { supersededById: t.id.toUpperCase() }),
      );
    });

    it(`${name}: superseded 以外に supersededById を付けるのは RangeError で、何も書かない`, async () => {
      const s = setup();
      const t = await s.mem();
      const w = await s.mem();
      const re = new RegExp(
        `^${name}: opts\\.supersededById must not be set unless status is "superseded"$`,
      );
      for (const status of ["active", "archived", "forgotten"] as const) {
        await s.expectRefused([t.id, w.id], re, () =>
          call(s, t.id, status, { supersededById: w.id }),
        );
      }
    });

    it(`${name}: 陽性対照 — 別の記憶を指す superseded、supersededById 無しの非 superseded は通る`, async () => {
      const s = setup();
      const t = await s.mem();
      const w = await s.mem();
      await call(s, t.id, "superseded", { supersededById: w.id });
      expect(await s.store.get(A, t.id)).toMatchObject({
        status: "superseded",
        supersededById: w.id,
      });
      const u = await s.mem();
      await call(s, u.id, "archived");
      expect(await s.store.get(A, u.id)).toMatchObject({ status: "archived" });
      // forgotten を指すのを断るのは resolveContested* だけ（ADR 0503・0515）。updateStatus* は断らない（InMemory・Postgres と同じ）。
      const v = await s.mem();
      const gone = await s.mem();
      await s.store.updateStatus(A, gone.id, "forgotten");
      await call(s, v.id, "superseded", { supersededById: gone.id });
      expect(await s.store.get(A, v.id)).toMatchObject({
        status: "superseded",
        supersededById: gone.id,
      });
    });
  }
});
