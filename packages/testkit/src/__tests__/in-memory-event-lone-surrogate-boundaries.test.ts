import { describe, expect, it } from "vitest";
import type { Ctx, NewMemoryEvent } from "@mnemora/core";
import { assertStorableMemoryEvent } from "../__fixtures__/memory-event-check.js";
import { InMemoryEventStore } from "../__fixtures__/in-memory-event-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { buildNewMemoryFixture } from "../test-data.js";

/**
 * イベントの `reason`（`meta.reason`・`meta.note`）と `actor.id` の、NUL・孤立サロゲートの検査の境目
 * （`__fixtures__/memory-event-check.ts` の `hasNulOrLoneSurrogate`）。
 *
 * Postgres の `jsonb` は、対をなさないサロゲートのエスケープ（`\ud800` から `\udfff`）を拒み、NUL（U+0000）を拒む。
 * それ以外の制御文字（SOH = U+0001 など）と、サロゲートの範囲のすぐ外（U+D7FF・U+E000）は通す。
 * 2026-09-28 マージ分の確かめ直しで、次の3つの境目を縛る歯が無かった。
 * - 文字列の末尾の孤立した上位サロゲート（`"abc\uD800"`）を断る。
 * - 孤立した下位サロゲートの上端 U+DFFF を断る。
 * - SOH は通す（NUL だけを断る）。
 *
 * ソースにサロゲートは `\u` の表記で書く（生の文字を入れない）。2実装を並べた歯は
 * `packages/postgres/src/__tests__/event-meta-roundtrip.postgres.test.ts`。
 */

const ctx: Ctx = { tenantId: "event-lone-surrogate-boundaries" };

function eventWith(fields: { reason?: string; note?: string; actorId?: string }): NewMemoryEvent {
  return {
    tenantId: ctx.tenantId,
    memoryId: null,
    kind: "updated",
    actor:
      fields.actorId === undefined ? { type: "system" } : { type: "human", id: fields.actorId },
    meta: {
      ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
      ...(fields.note !== undefined ? { note: fields.note } : {}),
    },
  };
}

const places = {
  "meta.reason": (value: string) => eventWith({ reason: value }),
  "meta.note": (value: string) => eventWith({ note: value }),
  "actor.id": (value: string) => eventWith({ actorId: value }),
} as const;

const REJECTED: [label: string, value: string][] = [
  ["末尾の孤立した上位サロゲート", "abc\uD800"],
  ["末尾の孤立した上位サロゲート（上端 U+DBFF）", "abc\uDBFF"],
  ["上位サロゲートの直後が下位サロゲートでない", "a\uD800b"],
  ["孤立した下位サロゲートの下端 U+DC00", "abc\uDC00"],
  ["孤立した下位サロゲートの上端 U+DFFF", "\uDFFF"],
  ["文字列の途中の孤立した下位サロゲート U+DFFF", "a\uDFFFb"],
  ["対の順序が逆（下位のあとに上位）", "\uDC00\uD800"],
  ["NUL", "a\u0000b"],
];

const ACCEPTED: [label: string, value: string][] = [
  ["SOH（U+0001）", "a\u0001b"],
  ["SOH だけ", "\u0001"],
  ["サロゲートの範囲のすぐ下 U+D7FF", "퟿"],
  ["サロゲートの範囲のすぐ上 U+E000", ""],
  ["正しいサロゲートペア（絵文字）", "x😀y"],
  ["正しいサロゲートペアの下端", "𐀀"],
  ["正しいサロゲートペアの上端 U+DBFF U+DFFF", "􏿿"],
  ["末尾が正しいサロゲートペア", "abc😀"],
];

describe.each(Object.entries(places))("%s の検査の境目", (_place, build) => {
  it.each(REJECTED)("断る: %s", (_label, value) => {
    expect(() => assertStorableMemoryEvent(build(value))).toThrow(
      /must not contain NUL \(U\+0000\) or a lone surrogate code unit/,
    );
  });

  it.each(ACCEPTED)("通す: %s", (_label, value) => {
    expect(() => assertStorableMemoryEvent(build(value))).not.toThrow();
  });
});

describe("InMemoryEventStore.append も同じ境目で断る・通す", () => {
  it("末尾の孤立した上位サロゲート・U+DFFF は何も書かずに断り、SOH は書く", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
    const m = await memoryStore.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "lone-surrogate-boundary" }),
    );

    for (const value of ["abc\uD800", "\uDFFF"]) {
      await expect(
        eventStore.append(ctx, { ...eventWith({ reason: value }), memoryId: m.id }),
      ).rejects.toThrow(/lone surrogate/);
      await expect(
        eventStore.append(ctx, { ...eventWith({ actorId: value }), memoryId: m.id }),
      ).rejects.toThrow(/lone surrogate/);
    }
    expect(memoryStore.events).toHaveLength(0);

    await eventStore.append(ctx, { ...eventWith({ reason: "a\u0001b" }), memoryId: m.id });
    await eventStore.append(ctx, { ...eventWith({ actorId: "\u0001" }), memoryId: m.id });
    expect(memoryStore.events).toHaveLength(2);
  });
});
