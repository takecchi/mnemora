import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `MemoryStore.restoreSupersededBy` の `event.at` に Invalid Date を渡したときの振る舞いを縛る
 * （Issue #1229 の行3。`restoreSupersededBy?` の doc の 2026-09-28 追記）。
 *
 * - 戻す対象が**無い**とき: 2実装とも `{ restored: [] }` を返す（例外にしない）。以前は `@mnemora/postgres` だけが、
 *   対象が無くても `at` を `timestamptz` に変えて例外になっていた。例外の少ない側（testkit の fixture）に揃えた
 *   （クローン miku の判断であり、オーナーの判断ではない）。
 * - 戻す対象が**在る**とき: 今どおり2実装とも例外で、1件も戻さない。`@mnemora/postgres` の例外の種類も今どおり
 *   （drizzle の `Failed query` に包まれ、DB の例外が `cause` に入る）。
 * - やりすぎない: 正しい `at` なら今どおり戻す。
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

let hashCounter = 0;

async function anchorWithGroup(store: MemoryStore, groupSize: number) {
  hashCounter += 1;
  const anchor = await store.createMemory(
    ctx,
    buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `anchor-${hashCounter}` }),
  );
  const group = [];
  for (let i = 0; i < groupSize; i += 1) {
    const m = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: `member-${hashCounter}-${i}` }),
    );
    await store.updateStatus(ctx, m.id, "superseded", { supersededById: anchor.id });
    group.push(m.id);
  }
  return { anchor, group };
}

afterAll(async () => {
  await closeTestClient();
});

describe("restoreSupersededBy の at が Invalid Date", () => {
  for (const [name, makeStore] of STORES) {
    it(`${name}: 戻す対象が無いときは例外にせず、空で返る（群が空・群の外の id だけを onlyMemoryIds に渡した・群がもう superseded でない）`, async () => {
      const store = await makeStore();
      const { anchor: emptyAnchor } = await anchorWithGroup(store, 0);
      const noGroup = await store.restoreSupersededBy!(ctx, emptyAnchor.id, { at: INVALID });

      const other = await store.createMemory(
        ctx,
        buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "outside-the-group" }),
      );
      const { anchor, group } = await anchorWithGroup(store, 1);
      const filteredOut = await store.restoreSupersededBy!(
        ctx,
        anchor.id,
        { at: INVALID },
        { onlyMemoryIds: [other.id] },
      );
      await store.updateStatus(ctx, group[0]!, "forgotten");
      const noLongerSuperseded = await store.restoreSupersededBy!(ctx, anchor.id, {
        at: INVALID,
      });

      expect({ noGroup, filteredOut, noLongerSuperseded }).toEqual({
        noGroup: { restored: [] },
        filteredOut: { restored: [] },
        noLongerSuperseded: { restored: [] },
      });
    });

    it(`${name}: 別のテナントの群は、対象が無いのと同じ——別のテナントの ctx から Invalid Date の at で呼んでも、例外にせず空で返り、何も戻さない`, async () => {
      const store = await makeStore();
      const { anchor, group } = await anchorWithGroup(store, 2);
      const otherTenant: Ctx = { tenantId: "restore-superseded-invalid-at-other" };

      const result = await store.restoreSupersededBy!(otherTenant, anchor.id, { at: INVALID });

      expect(result).toEqual({ restored: [] });
      for (const id of group) {
        expect((await store.get(ctx, id))?.status).toBe("superseded");
      }
    });

    it(`${name}: 戻す対象が在るときは今どおり例外で、1件も戻さない`, async () => {
      const store = await makeStore();
      const { anchor, group } = await anchorWithGroup(store, 2);
      await expect(store.restoreSupersededBy!(ctx, anchor.id, { at: INVALID })).rejects.toThrow();
      for (const id of group) {
        expect((await store.get(ctx, id))?.status).toBe("superseded");
      }
    });

    it(`${name}: やりすぎない——正しい at なら今どおり戻す`, async () => {
      const store = await makeStore();
      const { anchor, group } = await anchorWithGroup(store, 2);

      const result = await store.restoreSupersededBy!(ctx, anchor.id, {
        at: new Date("2026-06-01T00:00:00.000Z"),
      });

      expect(result.restored.map((m) => m.id).sort()).toEqual([...group].sort());
    });
  }

  it("Postgres: 戻す対象が在るときの例外の種類は今どおり（drizzle の Failed query に包まれ、DB の例外が cause に入る）", async () => {
    const postgres = await STORES[1]![1]();
    const { anchor } = await anchorWithGroup(postgres, 1);

    const err = await postgres.restoreSupersededBy!(ctx, anchor.id, { at: INVALID }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(String((err as { message?: unknown } | undefined)?.message)).toMatch(/^Failed query/);
    expect(String((err as { cause?: unknown } | undefined)?.cause)).toMatch(
      /invalid input syntax for type timestamp with time zone/,
    );
  });
});
