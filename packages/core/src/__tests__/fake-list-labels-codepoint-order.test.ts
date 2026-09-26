import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * クローン miku の委譲先が書いた回帰テスト。オーナーではない。
 *
 * Issue #881 / クローン miku の判断（2026-09-26、
 * `docs/decisions/0318-taxonomy-labels.md` 追記）: `MemoryStore.listLabels?` の
 * 「`name` 昇順」を**コードポイント順**（Postgres の `COLLATE "C"` と同じ、バイト順）
 * と決めた。
 *
 * `FakeMemoryStore.listLabels`（`packages/core` 自身の runtime テスト用フェイク、
 * `runtime-fakes.ts`）も `packages/testkit` の `InMemoryMemoryStore.listLabels` と
 * 同じく `results.sort((a, b) => a.name.localeCompare(b.name))` を使っており、
 * 同じ不一致を持つ——`in-memory-list-labels-codepoint-order.test.ts`
 * （`packages/testkit`）が直す不一致と**同じ形**を、`packages/core` 専用の `Fake*`
 * にも見つけた。`fake-reinforce-monotonicity.test.ts` 冒頭の doc が説明するとおり、
 * `packages/testkit` の適合テストの対象は `InMemory*` であり、`FakeMemoryStore` には
 * 届かない別系統——ここで個別に検査する。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
let contentHashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("FakeMemoryStore.listLabels は name のコードポイント順で返す（Issue #881）", () => {
  it("🔴 大文字小文字・空白・記号が混在する名前でも、コードポイント順で返る", async () => {
    const stores = createFakeRuntimeStores();

    // 大文字小文字・前後の空白・記号が混在する名前。期待するコードポイント順は
    // ASCII のコード値そのまま: ' '(32) < 'B'(66) < 'F'(70) < '_'(95) < 'f'(102)。
    await stores.memoryStore.createMemory(
      ctx,
      newMemory({ tags: [" Foo ", "Foo", "foo", "_a", "B"] }),
    );

    const labels = await stores.memoryStore.listLabels!(ctx);
    expect(labels.map((l) => l.name)).toEqual([" Foo ", "B", "Foo", "_a", "foo"]);
  });

  it("🔴 サロゲートペア（U+10000 以上）を含む名前でも、コードポイント順で返る", async () => {
    // クローン miku の判断（2026-09-26、追記2）: 契約に「コードポイント順」と書いた
    // 以上、BMP 外の文字（サロゲートペア）でもそれを満たす。
    //
    // "！"（U+FF01、BMP 内、コード単位1つ）と "😀"（U+1F600、BMP 外、サロゲートペア
    // "😀"）の2件。コードポイント値は "！"=0xFF01=65281 < "😀"=0x1F600=128512
    // なので、コードポイント順では "！" が先。
    //
    // ところが JS の `<`（UTF-16 コード単位の比較）で見ると、"😀" の先頭コード単位
    // （上位サロゲート 0xD83D=55357）は "！" の唯一のコード単位（0xFF01=65281）より
    // 小さいため、単純な `<` 比較では "😀" が先に来てしまう——コードポイント順とは逆。
    const stores = createFakeRuntimeStores();

    await stores.memoryStore.createMemory(ctx, newMemory({ tags: ["😀", "！"] }));

    const labels = await stores.memoryStore.listLabels!(ctx);
    expect(labels.map((l) => l.name)).toEqual(["！", "😀"]);
  });
});
