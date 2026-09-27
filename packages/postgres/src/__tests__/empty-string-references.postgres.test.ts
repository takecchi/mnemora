import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, NewMemory } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 空文字の参照・冪等の鍵を、testkit の fixture も Postgres と同じく「値が在る」として扱う。
 * - `createMemory` の `sourceObservationId`・`supersededById`・`contestedWithId` が `""`: Postgres は uuid として
 *   読めずに拒む。fixture も「参照先が無い」として拒む（`null`/`undefined` だけが「参照しない」）。
 * - `createObservation` の `externalId` が `""`: Postgres の一意制約は `external_id IS NOT NULL` の行に効くので、
 *   2回目は既存の行を返す。fixture も同じく既存の行を返す。
 *
 * 【実測 2026-09-28】以前は testkit の fixture が、`""` を偽として扱っていた——参照は検査せずに `""` のまま保存し、
 * `externalId: ""` は毎回新しい行を作っていた（store の公開の口に境界の入力を2実装へ流す差分で見つけた）。
 */

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

const ctx: Ctx = { tenantId: "empty-string-references" };

afterAll(async () => {
  await closeTestClient();
});

const REFERENCES: Array<[string, Partial<NewMemory>]> = [
  ["sourceObservationId", { sourceObservationId: "" }],
  ["supersededById", { status: "superseded", supersededById: "" }],
  ["contestedWithId", { status: "contested", contestedWithId: "" }],
];

describe.each(KITS)("空文字の参照・冪等の鍵（%s）", (_name, build) => {
  it.each(REFERENCES)(
    "createMemory は空文字の %s を、参照先の無い参照として拒む",
    async (field, override) => {
      const store = await build();
      await expect(
        store.createMemory(
          ctx,
          buildNewMemoryFixture({
            tenantId: ctx.tenantId,
            contentHash: `empty-${field}`,
            ...override,
          }),
        ),
      ).rejects.toThrow();
    },
  );

  it("createObservation の externalId が空文字なら、2回目は既存の行を返す（冪等の鍵として扱う）", async () => {
    const store = await build();
    const input = buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: "" });
    const first = await store.createObservation(ctx, input);
    const second = await store.createObservationWithOutbox(ctx, input, ["extract"]);
    expect(second.created).toBe(false);
    expect(second.observation.id).toBe(first.id);
    expect(second.jobs).toEqual([]);
  });
});
