// 確かめ直し（Issue #1759、B 群 #1610・#1625 / ADR 0499・0505）の歯。やりすぎ側の対照。
//
// 書き込み口の NUL の検査が断るのは「U+0000 そのもの」だけで、文字どおりの `\u0000`（バックスラッシュ + `u0000`）や
// `U+0001` は通す（Postgres も通す）。既存の歯は、この対照を Observation の `payload` と `kind` にしか置いていないので、
// `attributes`（Observation・Memory）と `provenance` の検査を「文字どおりの `\u0000` も断る」へ広げる変異が赤にならなかった。
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { InMemoryMemoryStore } from "@mnemora/testkit/fixtures";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

const A: Ctx = { tenantId: "nul-lookalike-controls" };
const LIT = "a\\u0000b";
const SOH = "a\u0001b";

afterAll(async () => {
  await closeTestClient();
});

const KITS: Array<[string, () => Promise<PostgresMemoryStore | InMemoryMemoryStore>]> = [
  [
    "postgres",
    async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      return new PostgresMemoryStore(db);
    },
  ],
  ["testkit の fixture", async () => new InMemoryMemoryStore()],
];

describe.each(KITS)("NUL に似た文字は通す（やりすぎない）: %s", (_n, build) => {
  it("createObservation / createObservationWithOutbox の attributes", async () => {
    const store = await build();
    await expect(
      store.createObservation(
        A,
        buildNewObservationFixture({
          tenantId: A.tenantId,
          externalId: "lit-1",
          attributes: { k: LIT, [LIT]: SOH },
        }),
      ),
    ).resolves.toBeDefined();
    await expect(
      store.createObservationWithOutbox!(
        A,
        buildNewObservationFixture({
          tenantId: A.tenantId,
          externalId: "lit-2",
          attributes: { k: LIT, [SOH]: LIT },
        }),
        [],
      ),
    ).resolves.toBeDefined();
  });

  it("createMemory の attributes・provenance・tags・claimKey", async () => {
    const store = await build();
    const m = await store.createMemory(
      A,
      buildNewMemoryFixture({
        tenantId: A.tenantId,
        contentHash: "lit-m1",
        content: LIT,
        digest: SOH,
        tags: [LIT, SOH],
        attributes: { k: LIT, [LIT]: SOH },
        provenance: { kind: "imported", batchId: LIT },
        claimKey: { subject: LIT, predicate: SOH },
      }),
    );
    expect(m.attributes).toEqual({ k: LIT, [LIT]: SOH });
    expect(m.provenance).toEqual({ kind: "imported", batchId: LIT });
    expect(m.tags).toEqual([LIT, SOH]);
  });
});
