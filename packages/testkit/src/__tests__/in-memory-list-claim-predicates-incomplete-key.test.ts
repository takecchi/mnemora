import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

/**
 * `InMemoryMemoryStore.listActiveClaimPredicates` は、claim key の片方（主語か述語）が欠けた
 * Memory を数えない——`PostgresMemoryStore.listActiveClaimPredicates` の SQL
 * （`claim_key_subject IS NOT NULL AND claim_key_predicate IS NOT NULL`）と同じ。
 *
 * 【実測 2026-09-27】以前は、述語の欠けた claim key（`{ subject: "user" }`）を持つ Memory から
 * **`null` を一覧に混ぜて**返していた（`[null, "favorite_color"]`）——戻り値の型 `string[]` に
 * 反する。同じ入力で Postgres は `[]` を返した（片方だけの行は、書き込みの口の後の読み出し側で
 * 「鍵なし」として扱われる。`packages/postgres/src/mapping.ts` の `rowToClaimKey`）。
 *
 * 片方だけの claim key は型（`ClaimKey` は2欄とも必須）を破る入力であり、書き込みの口が
 * それを受け付けてよいかは別に決める（Issue に起票）。ここで縛るのは、読み出しの一覧が
 * Postgres と同じく「両方そろった鍵だけ」を数えることだけである。
 */

const ctx: Ctx = { tenantId: "tenant-1" };

describe("InMemoryMemoryStore.listActiveClaimPredicates — 片方が欠けた claim key を数えない", () => {
  it("主語だけ・述語だけの claim key を持つ Memory は数えず、両方そろったものだけを返す（null を混ぜない）", async () => {
    const store = new InMemoryMemoryStore();
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "subject-only",
        claimKey: { subject: "user" } as never,
      }),
    );
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "predicate-only",
        claimKey: { predicate: "home_city" } as never,
      }),
    );
    await store.createMemory(
      ctx,
      buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "complete",
        claimKey: { subject: "user", predicate: "favorite_color" },
      }),
    );

    const predicates = await store.listActiveClaimPredicates(ctx, { subjectId: null, limit: 10 });

    expect(predicates).toEqual(["favorite_color"]);
  });
});
