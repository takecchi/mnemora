// ADR 0466（ADR 0456 の H4 の InMemory 版）: `InMemoryMemoryStore` の書き込み口のうち、呼び出し側が
// `NewMemoryEvent`（`memoryId` を持つ）を渡すものは、そのイベントが指す記憶が `ctx` のテナントの記憶であることを、
// 書く前に確かめる。断るときは何も書かない（status の更新も、news も、先に積んだイベントも残らない）。
//
// `packages/postgres` の `PostgresMemoryStore` と同じ入力を同じように断る（例外は素の `Error`、message は
// `<クラス名>: memory not found for tenant: <id>`。`kind`・`code` は無い）。
// 2実装の一致は `packages/postgres/src/__tests__/event-target-parity.postgres.test.ts` が同じ入力を流して縛る。
//
// このテストは fixture を直接呼ぶだけで、`*-conformance.ts` には触れていない（ADR 0434 決定5。約束を足すのはオーナーの判断）。
//
// 各 `it`: (1) 別テナントの記憶を指す `event.memoryId` は `memory not found for tenant` で断られる。
// (2) 何も書かれない。(3) やりすぎの対照: 自分の id・同じテナントの別の記憶・`null`・今作った行を指すイベントは通る。

import { describe, expect, it } from "vitest";
import type { Ctx, MemoryId, NewMemoryEvent } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

const A: Ctx = { tenantId: "event-target-a" };
const B: Ctx = { tenantId: "event-target-b" };
const NOT_FOUND = /^InMemoryMemoryStore: memory not found for tenant: /;

function setup() {
  const store = new InMemoryMemoryStore();
  let n = 0;
  const make = (ctx: Ctx) => {
    n += 1;
    return store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        content: `m${n}`,
        digest: `d${n}`,
        contentHash: `h-${ctx.tenantId}-${n}`,
      }),
    );
  };
  const ev = (
    memoryId: string | null,
    kind: "updated" | "created" = "updated",
  ): NewMemoryEvent => ({
    tenantId: "ignored",
    memoryId,
    kind,
    actor: { type: "system" },
    meta: { probe: true },
  });
  const eventCount = (id: MemoryId) => store.events.filter((e) => e.memoryId === id).length;
  const statusOf = async (ctx: Ctx, id: MemoryId) => (await store.get(ctx, id))?.status;
  return { store, make, ev, eventCount, statusOf };
}

describe("event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore）", () => {
  it("updateStatusWithEvent: status の更新ごと書かない。自分の id・同じテナントの別の記憶・null は通る", async () => {
    const { store, make, ev, eventCount, statusOf } = setup();
    const b = await make(B);
    const a = await make(A);
    const total = store.events.length;
    await expect(store.updateStatusWithEvent(A, a.id, "archived", {}, ev(b.id))).rejects.toThrow(
      NOT_FOUND,
    );
    expect(eventCount(b.id)).toBe(0);
    expect(store.events.length).toBe(total);
    expect(await statusOf(A, a.id)).toBe("active");
    // やりすぎの対照
    const other = await make(A);
    await store.updateStatusWithEvent(A, a.id, "archived", {}, ev(a.id));
    await store.updateStatusWithEvent(A, other.id, "archived", {}, ev(a.id)); // 同じテナントの別の記憶
    const third = await make(A);
    await store.updateStatusWithEvent(A, third.id, "archived", {}, ev(null)); // 記憶を指さない
    expect(store.events.length).toBe(total + 3);
  });

  it("実在しない id・形式のおかしい id も、別テナントと同じ例外で断る（Postgres の uuid でない id と同じ）", async () => {
    const { store, make, ev, statusOf } = setup();
    const a = await make(A);
    for (const bad of ["not-a-uuid", "mem-does-not-exist", ""]) {
      const error = await store
        .updateStatusWithEvent(A, a.id, "archived", {}, ev(bad))
        .catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(NOT_FOUND);
      expect((error as Error).message).toContain(bad);
      expect((error as { code?: unknown }).code).toBeUndefined();
      expect((error as { kind?: unknown }).kind).toBeUndefined();
    }
    expect(await statusOf(A, a.id)).toBe("active");
  });

  it("大文字小文字は区別しない（Postgres は uuid を小文字にそろえる）。小文字の正規形で積む。別テナントは大文字でも断る。操作の対象の id は変えない", async () => {
    const { store, make, ev, eventCount } = setup();
    const a = await make(A);
    const other = await make(A);
    const b = await make(B);
    await store.updateStatusWithEvent(A, a.id, "archived", {}, ev(a.id.toUpperCase())); // 今更新した行
    await store.updateStatusWithEvent(A, other.id, "archived", {}, ev(a.id.toUpperCase())); // 同じテナントの別の記憶
    expect(eventCount(a.id)).toBe(2);
    expect(store.events.some((e) => e.memoryId === a.id.toUpperCase())).toBe(false);
    const c = await make(A);
    await expect(
      store.updateStatusWithEvent(A, c.id, "archived", {}, ev(b.id.toUpperCase())),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    // 操作の対象の id は完全一致のまま（ADR 0438・0446。fixture は id の大文字小文字を区別する）。
    const d = await make(A);
    await expect(
      store.updateStatusWithEvent(A, d.id.toUpperCase(), "archived", {}, ev(d.id)),
    ).rejects.toThrow(NOT_FOUND);
    // 断るときの message は、渡された id のまま。
    const error = await store
      .updateStatusWithEvent(A, c.id, "archived", {}, ev(b.id.toUpperCase()))
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).toContain(b.id.toUpperCase());
  });

  it("purgeMemory: 墓石も書かない", async () => {
    const { store, make, ev, eventCount } = setup();
    const b = await make(B);
    const own = await make(A);
    await store.updateStatus(A, own.id, "forgotten");
    await store.purgeMemory!(A, own.id, { content: "[p]", digest: "[p]" }, ev(own.id));
    const a = await make(A);
    await store.updateStatus(A, a.id, "forgotten");
    const total = store.events.length;
    await expect(
      store.purgeMemory!(A, a.id, { content: "[p]", digest: "[p]" }, ev(b.id)),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(store.events.length).toBe(total);
    const after = await store.get(A, a.id);
    expect(after?.purgedAt ?? null).toBeNull();
    expect(after?.content).not.toBe("[p]");
  });

  it("markContestedPair・resolveContestedPair", async () => {
    const { store, make, ev, eventCount, statusOf } = setup();
    const b = await make(B);
    const [p1, p2] = [await make(A), await make(A)] as const;
    const total = store.events.length;
    await expect(
      store.markContestedPair!(A, { id: p1.id, event: ev(b.id) }, { id: p2.id, event: ev(p2.id) }),
    ).rejects.toThrow(NOT_FOUND);
    await expect(
      store.markContestedPair!(A, { id: p1.id, event: ev(p1.id) }, { id: p2.id, event: ev(b.id) }),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(store.events.length).toBe(total);
    expect(await statusOf(A, p1.id)).toBe("active");
    expect(await statusOf(A, p2.id)).toBe("active");
    // 対照: 相手側の id を指すイベントも通る（同じ呼び出しで更新する行）。
    await store.markContestedPair!(
      A,
      { id: p1.id, event: ev(p2.id) },
      { id: p2.id, event: ev(p1.id) },
    );
    expect(await statusOf(A, p1.id)).toBe("contested");
    await expect(
      store.resolveContestedPair!(
        A,
        { id: p1.id, status: "active", event: ev(b.id) },
        { id: p2.id, status: "superseded", supersededById: p1.id, event: ev(p2.id) },
      ),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(await statusOf(A, p1.id)).toBe("contested");
    expect(await statusOf(A, p2.id)).toBe("contested");
    await store.resolveContestedPair!(
      A,
      { id: p1.id, status: "active", event: ev(p1.id) },
      { id: p2.id, status: "superseded", supersededById: p1.id, event: ev(null) },
    );
    expect(await statusOf(A, p2.id)).toBe("superseded");
  });

  it("resolveOrphanedContested", async () => {
    const { store, make, ev, eventCount, statusOf } = setup();
    const b = await make(B);
    const [z1, z2] = [await make(A), await make(A)] as const;
    await store.markContestedPair!(
      A,
      { id: z1.id, event: ev(z1.id) },
      { id: z2.id, event: ev(z2.id) },
    );
    await store.updateStatus(A, z2.id, "forgotten");
    const total = store.events.length;
    await expect(
      store.resolveOrphanedContested!(A, { id: z1.id, contestedWithId: z2.id, event: ev(b.id) }),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(store.events.length).toBe(total);
    expect(await statusOf(A, z1.id)).toBe("contested");
    await store.resolveOrphanedContested!(A, {
      id: z1.id,
      contestedWithId: z2.id,
      event: ev(z1.id),
    });
    expect(await statusOf(A, z1.id)).toBe("active");
  });

  it("markContestedGroup・resolveContestedGroup（群）", async () => {
    const { store, make, ev, eventCount, statusOf } = setup();
    const b = await make(B);
    const [g1, g2, g3] = [await make(A), await make(A), await make(A)] as const;
    const own = (id: MemoryId) => ({ id, event: ev(id) });
    const total = store.events.length;
    await expect(
      store.markContestedGroup!(A, [{ id: g1.id, event: ev(b.id) }, own(g2.id), own(g3.id)]),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(store.events.length).toBe(total);
    expect(await statusOf(A, g1.id)).toBe("active");
    // 対照: 群の別のメンバーの id を指すイベントは通る。
    await store.markContestedGroup!(A, [{ id: g1.id, event: ev(g2.id) }, own(g2.id), own(g3.id)]);
    expect(await statusOf(A, g1.id)).toBe("contested");
    await expect(
      store.resolveContestedGroup!(A, [
        { id: g1.id, status: "active", event: ev(b.id) },
        { id: g2.id, status: "superseded", supersededById: g1.id, event: ev(g2.id) },
        { id: g3.id, status: "superseded", supersededById: g1.id, event: ev(g3.id) },
      ]),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(await statusOf(A, g1.id)).toBe("contested");
    expect(await statusOf(A, g2.id)).toBe("contested");
  });

  it("markContestedGroup: 状態が変わらないメンバー（既に contested で相手なし）のイベントは書かないので、検査もしない（Postgres と同じ）", async () => {
    const { store, make, ev, eventCount } = setup();
    const b = await make(B);
    const [g1, g2, g3, g4] = [await make(A), await make(A), await make(A), await make(A)] as const;
    const own = (id: MemoryId) => ({ id, event: ev(id) });
    await store.markContestedGroup!(A, [own(g1.id), own(g2.id), own(g3.id)]);
    // g1 は既に contested かつ相手なし（群の吸収）。g1 のイベントは積まれないので、別テナントを指していても通る。
    const result = await store.markContestedGroup!(A, [
      { id: g1.id, event: ev(b.id) },
      own(g2.id),
      own(g4.id),
    ]);
    expect(result.events).toHaveLength(1); // g4 だけが active -> contested（g1・g2 は既に contested で相手なし）
    expect(eventCount(b.id)).toBe(0);
  });

  it("supersedeWithNewMemories: supersede の event と buildCreatedEvent。news も書かない", async () => {
    const { store, make, ev, eventCount, statusOf } = setup();
    const b = await make(B);
    const old = await make(A);
    const fresh = (name: string) =>
      buildNewMemoryFixture({
        tenantId: A.tenantId,
        content: name,
        digest: name,
        contentHash: `h-fresh-${name}`,
      });
    const total = store.events.length;
    const memoriesBefore = (await store.listByTenant(A)).length;
    await expect(
      store.supersedeWithNewMemories!(
        A,
        [{ input: fresh("s1"), jobKinds: [] }],
        [{ id: old.id, supersededByIndex: 0, event: ev(b.id) }],
      ),
    ).rejects.toThrow(NOT_FOUND);
    expect(await statusOf(A, old.id)).toBe("active");
    expect((await store.listByTenant(A)).length).toBe(memoriesBefore);
    await expect(
      store.supersedeWithNewMemories!(
        A,
        [{ input: fresh("s2"), jobKinds: [] }],
        [{ id: old.id, supersededByIndex: 0, event: ev(old.id) }],
        { buildCreatedEvent: () => ev(b.id, "created") },
      ),
    ).rejects.toThrow(NOT_FOUND);
    expect(await statusOf(A, old.id)).toBe("active");
    expect((await store.listByTenant(A)).length).toBe(memoriesBefore);
    expect(eventCount(b.id)).toBe(0);
    expect(store.events.length).toBe(total);
    // 対照: 作った記憶自身を指す created、supersede の対象自身を指す event は通る。
    const ok = await store.supersedeWithNewMemories!(
      A,
      [{ input: fresh("s3"), jobKinds: [] }],
      [{ id: old.id, supersededByIndex: 0, event: ev(old.id) }],
      { buildCreatedEvent: (memory) => ev(memory.id, "created") },
    );
    expect(ok.created).toHaveLength(1);
    expect(eventCount(ok.created[0]!.memory.id)).toBe(1);
    expect(await statusOf(A, old.id)).toBe("superseded");
  });

  it("supersedeWithNewMemories: CAS に弾かれる対象のイベントは書かないので、検査もしない（Postgres と同じ）", async () => {
    const { store, make, ev, eventCount } = setup();
    const b = await make(B);
    const old = await make(A);
    const result = await store.supersedeWithNewMemories!(
      A,
      [
        {
          input: buildNewMemoryFixture({
            tenantId: A.tenantId,
            content: "x",
            digest: "x",
            contentHash: "h-fresh-x",
          }),
          jobKinds: [],
        },
      ],
      [{ id: old.id, supersededByIndex: 0, expectedStatus: "archived", event: ev(b.id) }],
    );
    expect(result.conflicted).toHaveLength(1);
    expect(eventCount(b.id)).toBe(0);
  });

  it("createMemoriesWithOutboxAndEvents: 全体を戻す。作った記憶自身を指す created は通る", async () => {
    const { store, make, ev, eventCount } = setup();
    const b = await make(B);
    const fresh = (name: string) =>
      buildNewMemoryFixture({
        tenantId: A.tenantId,
        content: name,
        digest: name,
        contentHash: `h-fresh-${name}`,
      });
    const total = store.events.length;
    const memoriesBefore = (await store.listByTenant(A)).length;
    await expect(
      store.createMemoriesWithOutboxAndEvents!(
        A,
        [
          { input: fresh("c1"), jobKinds: [] },
          { input: fresh("c2"), jobKinds: [] },
        ],
        (memory) => (memory.content === "c2" ? ev(b.id, "created") : ev(memory.id, "created")),
      ),
    ).rejects.toThrow(NOT_FOUND);
    expect(eventCount(b.id)).toBe(0);
    expect(store.events.length).toBe(total);
    expect((await store.listByTenant(A)).length).toBe(memoriesBefore);
    const ok = await store.createMemoriesWithOutboxAndEvents!(
      A,
      [{ input: fresh("c3"), jobKinds: [] }],
      (memory) => ev(memory.id, "created"),
    );
    expect(ok.written).toHaveLength(1);
    expect(eventCount(ok.written[0]!.memory.id)).toBe(1);
  });
});
