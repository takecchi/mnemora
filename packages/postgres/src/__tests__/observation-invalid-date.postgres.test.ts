import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, NewObservation } from "@mnemora/core";
import { buildNewObservationFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `createObservation`・`createObservationWithOutbox` の日時の欄（`occurredAt`・`recordedAt`・`validFrom`・
 * `validUntil`）に Invalid Date を渡すと、Postgres は `timestamptz` への変換で拒む（`22007`）。`externalId` が同じ
 * 既存の行が在っても拒む（`INSERT ... ON CONFLICT DO NOTHING` は、衝突を見る前に値を変換する）。testkit の
 * fixture も同じく拒み、何も書かない。
 *
 * 【実測 2026-09-27】以前は testkit の fixture が、新しい行なら Invalid Date のまま保存し、既存の行が在れば
 * それを返していた（4つの欄すべて）。
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

const ctx: Ctx = { tenantId: "observation-invalid-date" };

afterAll(async () => {
  await closeTestClient();
});

const FIELDS = ["occurredAt", "recordedAt", "validFrom", "validUntil"] as const;

describe.each(KITS)("createObservation 系は Invalid Date の日時を拒む（%s）", (_name, build) => {
  it.each(FIELDS)(
    "%s: 新しい行でも、externalId が同じ既存の行が在っても拒み、何も書かない",
    async (field) => {
      const store = await build();
      const bad: Partial<NewObservation> = { [field]: new Date(Number.NaN) };

      const fresh = buildNewObservationFixture({
        tenantId: ctx.tenantId,
        externalId: `fresh-${field}`,
        ...bad,
      });
      await expect(store.createObservation(ctx, fresh)).rejects.toThrow();
      // 同じ externalId の正しい入力が、新しく作られる（＝上で何も書いていない）。
      const retried = await store.createObservationWithOutbox(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId, externalId: `fresh-${field}` }),
        ["extract"],
      );
      expect(retried.created).toBe(true);

      const valid = buildNewObservationFixture({
        tenantId: ctx.tenantId,
        externalId: `existing-${field}`,
      });
      const existing = await store.createObservation(ctx, valid);
      await expect(store.createObservation(ctx, { ...valid, ...bad })).rejects.toThrow();
      await expect(
        store.createObservationWithOutbox(ctx, { ...valid, ...bad }, ["extract"]),
      ).rejects.toThrow();
      expect(await store.getObservation(ctx, existing.id)).toEqual(existing);
    },
  );
});
