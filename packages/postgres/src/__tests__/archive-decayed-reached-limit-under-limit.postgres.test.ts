import { afterAll, describe, expect, it } from "vitest";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import type { Ctx, MemoryStore } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0432 AL-4 の確かめ直し（Issue #1734、PR #1538）で足した歯。`archiveDecayed` の `reachedLimit` は
 * 「`limit` が正で、掃いた件数がちょうど `limit`」のときだけ true。`limit` に届かなかったとき（対象が
 * `limit` より少ない）は false——「もう残っていない」の意味。`archive-decayed-limit-zero` は
 * `limit: 0` と `limit: 1`（1件で届く）だけを見ていたので、「掃いた件数が1件でもあれば true」や
 * 「`limit - 1` 件で true」に変えても赤にならなかった。Postgres と testkit の InMemory の両方を見る。
 */

const ctx: Ctx = { tenantId: "archive-decayed-reached-limit-under-limit" };
const now = new Date("2026-06-01T00:00:00.000Z");

const KITS: Array<[string, () => Promise<MemoryStore>]> = [
  ["testkit の InMemory", async () => new InMemoryMemoryStore()],
  [
    "Postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return new PostgresMemoryStore(db);
    },
  ],
];

afterAll(async () => {
  await closeTestClient();
});

describe.each(KITS)(
  "archiveDecayed の reachedLimit：limit に届かなければ false（%s）",
  (_name, make) => {
      it.each([
      [5, false],
      [3, false],
      [2, true],
    ])("対象が2件で limit=%i なら、2件掃いて reachedLimit は %s", async (limit, expected) => {
      const store = await make();
      for (const tag of ["a", "b"]) {
        await store.createMemory(
          ctx,
          buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `h-${tag}` }),
        );
      }

      const result = await store.archiveDecayed(ctx, { now, limit });

      expect(result.archived).toHaveLength(2);
      expect(result.reachedLimit).toBe(expected);
    });
  },
);
