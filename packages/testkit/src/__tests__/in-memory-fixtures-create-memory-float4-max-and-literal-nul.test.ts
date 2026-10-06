import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

// `InMemoryMemoryStore.createMemory` が Postgres に揃えて断る入力の、断りすぎない側。
// - `halfLifeHours`: float4（Postgres の `real`）に収まる最大の値までは受け、`Infinity` へ丸まる境目から断る
//   （`1e300`・`Number.MAX_VALUE` を断り `3e38` を受けるだけでは、`3.4e38` 付近で断る実装を見分けられない）。
// - `content`: 断るのは NUL（U+0000）そのもの。`\u0000` という6文字の文字列（バックスラッシュ・u・0・0・0・0）は
//   ただの文字なので受ける。NUL が先頭・末尾にあるときも断る。

const ctx: Ctx = { tenantId: "tenant-1" };

const FLOAT4_MAX = 3.4028234663852886e38;
// float4 の最大値と、その次の（`Infinity` になる）値の真ん中。これ以上は `Infinity` へ丸まり、これ未満は最大値へ丸まる。
const OVERFLOW_AT = 3.4028235677973366e38;
const JUST_BELOW_OVERFLOW = 3.4028235677973362e38;

describe("InMemoryMemoryStore.createMemory: halfLifeHours は float4 の最大値まで受ける", () => {
  it("境目の前提（Math.fround の丸め方）", () => {
    expect(Math.fround(FLOAT4_MAX)).toBe(FLOAT4_MAX);
    expect(Math.fround(JUST_BELOW_OVERFLOW)).toBe(FLOAT4_MAX);
    expect(Math.fround(OVERFLOW_AT)).toBe(Number.POSITIVE_INFINITY);
  });

  it("float4 の最大値と、Infinity に丸まる直前の値は受ける", async () => {
    const store = new InMemoryMemoryStore();
    const a = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "max-a",
        halfLifeHours: FLOAT4_MAX,
      }),
    );
    const b = await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "max-b",
        halfLifeHours: JUST_BELOW_OVERFLOW,
      }),
    );
    expect(a.halfLifeHours).toBeGreaterThan(3.4e38);
    expect(b.halfLifeHours).toBeGreaterThan(3.4e38);
  });

  it("Infinity に丸まる値は断り、Memory を作らない", async () => {
    const store = new InMemoryMemoryStore();
    await expect(
      store.createMemory(
        ctx,
        buildNewMemoryFixture({
          tenantId: ctx.tenantId,
          contentHash: "overflow",
          halfLifeHours: OVERFLOW_AT,
        }),
      ),
    ).rejects.toThrow(/does not fit in a Postgres "real"/);
  });
});

describe("InMemoryMemoryStore.createMemory: content の NUL", () => {
  it("\\u0000 という文字列（NUL ではない）は受け、そのまま読み戻せる", async () => {
    const store = new InMemoryMemoryStore();
    const content = "手順は \\u0000 と書く";
    const created = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "literal", content }),
    );
    expect((await store.get(ctx, created.id))?.content).toBe(content);
  });

  it("先頭・末尾の NUL も断る", async () => {
    const store = new InMemoryMemoryStore();
    for (const [label, content] of [
      ["先頭", "\u0000abc"],
      ["末尾", "abc\u0000"],
      ["NUL だけ", "\u0000"],
    ] as const) {
      await expect(
        store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `nul-${label}`, content }),
        ),
      ).rejects.toThrow(/content must not contain NUL/);
    }
  });
});
