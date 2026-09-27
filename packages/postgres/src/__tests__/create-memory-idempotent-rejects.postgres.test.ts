import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, MemoryStore, NewMemory } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * `createMemory`・`createMemoryWithOutbox` に、冪等の鍵（観測・抽出器の版・contentHash）が同じ既存の行が
 * 在っても、Postgres は書けない値（型の列挙に無い値・NUL・Invalid Date・値域の外）を拒む——`INSERT ... ON
 * CONFLICT DO NOTHING` は、衝突を見る前に行の値を型に変換し CHECK 制約を当てるためである。testkit の fixture も
 * 同じく拒み、既存の行を返さない。
 *
 * 【実測 2026-09-27】以前は testkit の fixture が、既存の行が在るときは値を確かめずにそれを返していた
 * （下の13の形すべて。Postgres は `23514`・`22021`・`22P05`・`22007`・`22003` で拒んだ）。
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

const ctx: Ctx = { tenantId: "create-memory-idempotent-rejects" };

afterAll(async () => {
  await closeTestClient();
});

/** 型を外した呼び出しを模す（列挙に無い値）。 */
const BOGUS = "bogus" as never;

const CASES: Array<[string, Partial<NewMemory>]> = [
  ["status が列挙に無い", { status: BOGUS }],
  ["digestSource が列挙に無い", { digestSource: BOGUS }],
  ["embeddingStatus が列挙に無い", { embeddingStatus: BOGUS }],
  ["provenance.kind が列挙に無い", { provenance: { kind: BOGUS } }],
  ["content に NUL", { content: "a\u0000b" }],
  ["digest に NUL", { digest: "a\u0000b" }],
  ["tags に NUL", { tags: ["a\u0000"] }],
  ["subjectId に NUL", { subjectId: "a\u0000" }],
  ["attributes に NUL", { attributes: { k: "a\u0000" } }],
  ["recordedAt が Invalid Date", { recordedAt: new Date(NaN) }],
  ["occurredAt が Invalid Date", { occurredAt: new Date(NaN) }],
  ["strength が値域の外", { strength: 5 }],
  ["halfLifeHours が float4 に収まらない", { halfLifeHours: 1e300 }],
];

describe.each(KITS)("冪等の既存の行が在っても、書けない値は拒む（%s）", (_name, build) => {
  it.each(CASES)(
    "%s: createMemory・createMemoryWithOutbox は拒み、既存の行を変えない",
    async (_label, override) => {
      const store = await build();
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
      );
      const valid = buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        contentHash: "idempotent-rejects",
        sourceObservationId: observation.id,
        extractorVersion: "v1",
      });
      const existing = await store.createMemory(ctx, valid);

      await expect(store.createMemory(ctx, { ...valid, ...override })).rejects.toThrow();
      await expect(
        store.createMemoryWithOutbox(ctx, { ...valid, ...override }, ["embed"]),
      ).rejects.toThrow();

      expect(await store.get(ctx, existing.id)).toEqual(existing);
    },
  );

  it("同じ鍵の正しい値なら、既存の行を返す（陽性対照）", async () => {
    const store = await build();
    const observation = await store.createObservation(
      ctx,
      buildNewObservationFixture({ tenantId: ctx.tenantId }),
    );
    const valid = buildNewMemoryFixture({
      tenantId: ctx.tenantId,
      contentHash: "idempotent-ok",
      sourceObservationId: observation.id,
      extractorVersion: "v1",
    });
    const existing = await store.createMemory(ctx, valid);
    const again = await store.createMemoryWithOutbox(ctx, valid, ["embed"]);
    expect(again.created).toBe(false);
    expect(again.memory.id).toBe(existing.id);
  });
});
