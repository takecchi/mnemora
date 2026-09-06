import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemoryEvent } from "../event.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * `FakeEventStore.list`（`packages/core` 自身の runtime テスト用フェイク、`runtime-fakes.ts`）が
 * `EventStore.list` の契約（ADR 0042、`packages/core/src/interfaces/event-store.ts` の doc）を
 * 実際に守っていることを検査する歯。
 *
 * **`packages/testkit` の `event-store-conformance.ts` の対象ではない。** `FakeEventStore` は
 * adapter 適合テストの対象である `EventStore` 実装（`InMemoryEventStore`/`PostgresEventStore`）
 * ではなく、`packages/core` 自身の runtime テスト専用の別系統（`runtime-fakes.ts` 冒頭のコメント:
 * core は testkit に依存しない）。`fake-vector-store-filter.test.ts`（ADR 0034 の穴を
 * `packages/core` 側で埋めた前例）と同じ理由・同じ形。
 *
 * 置く歯はすべて非対称——挿入順と `at` 順をわざと不一致にする（`at = T3, T1, T2` の順で
 * append する）。挿入順でソートしても `at` 順でソートしても同じ結果になる並びを作ると、
 * どんな変異も生き残ってしまう（`event-store-conformance.ts` の「list は at 昇順で返す」
 * と同じ形）。
 *
 * 期待値の導出について: 実装側の関数や定数からではなく、このファイル内のリテラルな `Date`
 * から作る——検査対象（`FakeEventStore.list`）と期待値が同じ値を共有すると、両方が一緒に
 * 壊れて変異が素通りする。
 *
 * 🔴 `backing.events`（`store.events` getter 経由で読める、ADR 0031）は
 * `FakeMemoryStore.updateStatusWithEvent` と共有される配列であり、`runtime.test.ts` が
 * `stores.eventStore.events` として直接読んでいる。`list` がこの共有配列を in-place で
 * 並べ替えると `runtime.test.ts` を静かに壊しかねない——最後の歯でそれを検査する。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

/** `event-store-conformance.ts` の `buildNewMemoryEventFixture` と似た形だが、
 * 意図的に独立したコピー（ファイル冒頭のコメント: `FakeEventStore` はこの系統の
 * 別テストと結合させない。core は testkit に依存しない）。 */
function newEvent(overrides: Partial<NewMemoryEvent> = {}): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId: "mem-fixture-1",
    kind: "created",
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
    ...overrides,
  };
}

const T1 = new Date("2026-01-01T00:00:00.000Z");
const T2 = new Date("2026-01-02T00:00:00.000Z");
const T3 = new Date("2026-01-03T00:00:00.000Z");

describe("FakeEventStore.list — EventStore.list の契約（ADR 0042）", () => {
  it("at 昇順で返す（挿入順ではない）", async () => {
    const stores = createFakeRuntimeStores();
    // 挿入順は T3, T1, T2 —— at 順（T1, T2, T3）とわざと不一致にする。
    const e3 = await stores.eventStore.append(ctx, newEvent({ at: T3 }));
    const e1 = await stores.eventStore.append(ctx, newEvent({ at: T1 }));
    const e2 = await stores.eventStore.append(ctx, newEvent({ at: T2 }));

    const listed = await stores.eventStore.list(ctx, {});

    expect(listed.map((event) => event.id)).toEqual([e1.id, e2.id, e3.id]);
  });

  it("limit は at 昇順に並べ替えた後に適用する（挿入順の先頭 n 件ではない）", async () => {
    const stores = createFakeRuntimeStores();
    // 挿入順の先頭は T3 の行。limit: 1 が挿入順の先頭 n 件を返す実装だと T3 の行が
    // 返ってしまう —— at が最も古い e1 の1件が返ることを検査する（順序ではなく
    // 集合そのものが変わることの歯）。
    const e3 = await stores.eventStore.append(ctx, newEvent({ at: T3 }));
    const e1 = await stores.eventStore.append(ctx, newEvent({ at: T1 }));
    await stores.eventStore.append(ctx, newEvent({ at: T2 }));

    const limited = await stores.eventStore.list(ctx, { limit: 1 });

    expect(limited.map((event) => event.id)).toEqual([e1.id]);
    expect(limited.map((event) => event.id)).not.toEqual([e3.id]);
  });

  it("since は境界を含む（at >= since）", async () => {
    const stores = createFakeRuntimeStores();
    await stores.eventStore.append(ctx, newEvent({ at: T1 }));
    const e2 = await stores.eventStore.append(ctx, newEvent({ at: T2 }));
    const e3 = await stores.eventStore.append(ctx, newEvent({ at: T3 }));

    const listed = await stores.eventStore.list(ctx, { since: T2 });

    expect(listed.map((event) => event.id)).toEqual([e2.id, e3.id]);
  });

  it("until は境界を含む（at <= until）", async () => {
    const stores = createFakeRuntimeStores();
    const e1 = await stores.eventStore.append(ctx, newEvent({ at: T1 }));
    const e2 = await stores.eventStore.append(ctx, newEvent({ at: T2 }));
    await stores.eventStore.append(ctx, newEvent({ at: T3 }));

    const listed = await stores.eventStore.list(ctx, { until: T2 });

    expect(listed.map((event) => event.id)).toEqual([e1.id, e2.id]);
  });

  it("list を呼んだ後も backing.events（store.events）の並びは挿入順のまま変わらない（共有配列を in-place で壊さない）", async () => {
    const stores = createFakeRuntimeStores();
    // ADR 0031: store.events は backing.events を指す getter であり、
    // FakeMemoryStore.updateStatusWithEvent と共有される。list が this.backing.events を
    // 直接 sort() すると、runtime.test.ts が stores.eventStore.events を読む箇所を
    // 静かに壊す——ここではその共有配列そのものが呼び出し後も挿入順のままであることを見る。
    const e3 = await stores.eventStore.append(ctx, newEvent({ at: T3 }));
    const e1 = await stores.eventStore.append(ctx, newEvent({ at: T1 }));
    const e2 = await stores.eventStore.append(ctx, newEvent({ at: T2 }));

    await stores.eventStore.list(ctx, {});

    expect(stores.eventStore.events.map((event) => event.id)).toEqual([e3.id, e1.id, e2.id]);
  });
});
