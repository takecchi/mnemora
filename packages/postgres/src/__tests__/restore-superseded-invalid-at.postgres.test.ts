import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `MemoryStore.restoreSupersededBy` の `event.at` に Invalid Date を渡したときの今の振る舞いを縛る
 * （Issue #1229 の行3。`restoreSupersededBy?` の doc の 2026-09-28 追記）。振る舞いは変えていない。
 *
 * - 戻す対象が**無い**とき: `@mnemora/postgres` は例外（対象が無くても `at` を `timestamptz` に変える）、
 *   testkit の fixture は `{ restored: [] }` を返す。**2実装で違う**（どちらへ揃えるかは Issue #1229 で未決）。
 * - 戻す対象が**在る**とき: 両方とも例外で、何も戻さない。
 */

const ctx: Ctx = { tenantId: "restore-superseded-invalid-at" };
const INVALID = new Date(Number.NaN);

const STORES: Array<[string, () => Promise<MemoryStore>]> = [
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

async function anchorWithGroup(store: MemoryStore, groupSize: number) {
  const anchor = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "anchor" }),
  );
  const group = [];
  for (let i = 0; i < groupSize; i += 1) {
    const m = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `member-${i}` }),
    );
    await store.updateStatus(ctx, m.id, "superseded", { supersededById: anchor.id });
    group.push(m.id);
  }
  return { anchor, group };
}

afterAll(async () => {
  await closeTestClient();
});

describe("restoreSupersededBy の at が Invalid Date（今の振る舞い）", () => {
  it("戻す対象が無いとき: Postgres は例外、testkit の fixture は空で返る（2実装で違う）", async () => {
    const fixture = await STORES[0]![1]();
    const { anchor: fixtureAnchor } = await anchorWithGroup(fixture, 0);
    await expect(
      fixture.restoreSupersededBy!(ctx, fixtureAnchor.id, { at: INVALID }),
    ).resolves.toEqual({ restored: [] });

    const postgres = await STORES[1]![1]();
    const { anchor: postgresAnchor } = await anchorWithGroup(postgres, 0);
    const err = await postgres.restoreSupersededBy!(ctx, postgresAnchor.id, { at: INVALID }).then(
      () => undefined,
      (e: unknown) => e,
    );
    // drizzle の `Failed query` に包まれ、DB の例外は `cause` に入る。
    expect(String((err as { cause?: unknown } | undefined)?.cause)).toMatch(
      /invalid input syntax for type timestamp with time zone/,
    );
  });

  for (const [name, makeStore] of STORES) {
    it(`${name}: 戻す対象が在るときは例外で、1件も戻さない`, async () => {
      const store = await makeStore();
      const { anchor, group } = await anchorWithGroup(store, 2);
      await expect(store.restoreSupersededBy!(ctx, anchor.id, { at: INVALID })).rejects.toThrow();
      for (const id of group) {
        expect((await store.get(ctx, id))?.status).toBe("superseded");
      }
    });
  }
});
