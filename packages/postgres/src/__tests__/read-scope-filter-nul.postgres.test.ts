import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresTrigramLexicalStore } from "../trigram-lexical-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * ADR 0456（ADR 0424 O-6-1 の続き）: 読み取りの絞り（`labels`・`attributes` の key と value）・claim key・
 * `extractorVersion` に NUL（U+0000）が入ったとき、DB の生の例外（`Failed query: … params: …`、原因は
 * `invalid byte sequence for encoding "UTF8": 0x00` か `unsupported Unicode escape sequence`）ではなく、
 * DB に触れる前の名指しの例外（`<口>: <欄> must not contain NUL characters (U+0000)`）で断る。
 *
 * 断る入力は増やさない——直す前も、同じ入力は例外で落ちていた（陽性対照: 各 it の最初に、NUL を含まない
 * 同じ形の入力が通ることを見る）。`RecallQuery.labels`・`RecallQuery.attributes` の値は zod が NUL を
 * 弾かない（key は文字種の正規表現が弾く）ので、`runtime.recall` から実際にここへ届く。
 */

const A: Ctx = { tenantId: "read-nul" };
const NUL = "x\u0000y";
const OBS = "00000000-0000-4000-8000-000000000000";
const NO_RAW = (e: unknown) => {
  const err = e as Error;
  expect(err.constructor.name).not.toBe("DrizzleQueryError");
  expect(err.message).not.toContain("Failed query");
  expect(err.message).toMatch(/must not contain NUL characters \(U\+0000\)/);
};

afterAll(async () => {
  await closeTestClient();
});
beforeEach(async () => {
  await resetTestDatabase();
});

async function rejectsNamed(run: () => Promise<unknown>, field: string) {
  let caught: unknown;
  await run().catch((e: unknown) => {
    caught = e;
  });
  expect(caught, "NUL を含む入力は例外で終わる").toBeDefined();
  NO_RAW(caught);
  expect((caught as Error).message).toContain(field);
}

describe("PostgresMemoryStore", () => {
  it("aggregateScope: labels の要素・attributes の key と value の NUL を名指しで断る", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    await expect(
      store.aggregateScope(A, { labels: ["x"], attributes: { k: "v" } }),
    ).resolves.toBeDefined();
    await rejectsNamed(() => store.aggregateScope(A, { labels: ["ok", NUL] }), "scope.labels[1]");
    await rejectsNamed(
      () => store.aggregateScope(A, { attributes: { k: NUL } }),
      "scope.attributes (value)",
    );
    await rejectsNamed(
      () => store.aggregateScope(A, { attributes: { [NUL]: "v" } }),
      "scope.attributes (key)",
    );
  });

  it("findActiveByClaimKey・findContestedByClaimKey: claimKey の NUL を名指しで断る", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    const query = (subject: string, predicate: string) => ({
      subjectId: null,
      claimKey: { subject, predicate },
      excludeMemoryId: OBS,
      contentHash: "h",
      validFrom: null,
      validUntil: null,
    });
    await expect(store.findActiveByClaimKey!(A, query("s", "p"))).resolves.toEqual([]);
    await expect(store.findContestedByClaimKey!(A, query("s", "p"))).resolves.toEqual([]);
    await rejectsNamed(() => store.findActiveByClaimKey!(A, query(NUL, "p")), "claimKey.subject");
    await rejectsNamed(() => store.findActiveByClaimKey!(A, query("s", NUL)), "claimKey.predicate");
    await rejectsNamed(
      () => store.findContestedByClaimKey!(A, query(NUL, "p")),
      "claimKey.subject",
    );
    await rejectsNamed(
      () => store.findContestedByClaimKey!(A, query("s", NUL)),
      "claimKey.predicate",
    );
  });

  it("listBySourceObservation: extractorVersion の NUL を名指しで断る（null は通る）", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    await expect(store.listBySourceObservation(A, OBS, "v1")).resolves.toEqual([]);
    await expect(store.listBySourceObservation(A, OBS, null)).resolves.toEqual([]);
    await rejectsNamed(() => store.listBySourceObservation(A, OBS, NUL), "extractorVersion");
  });
});

describe("検索の絞り（filter）", () => {
  const filter = (extra: object) => ({ tenantId: A.tenantId, ...extra });

  it("PostgresLexicalStore.search: filter.labels・filter.attributes の NUL を名指しで断る", async () => {
    const { db } = await getTestClient();
    const store = new PostgresLexicalStore(db);
    const run = (extra: object) => store.search(A, "hello", { limit: 3, filter: filter(extra) });
    await expect(run({ labels: ["x"], attributes: { k: "v" } })).resolves.toEqual([]);
    await rejectsNamed(() => run({ labels: [NUL] }), "opts.filter.labels[0]");
    await rejectsNamed(() => run({ attributes: { k: NUL } }), "opts.filter.attributes (value)");
    await rejectsNamed(() => run({ attributes: { [NUL]: "v" } }), "opts.filter.attributes (key)");
  });

  it("PostgresTrigramLexicalStore.search: 同じ", async () => {
    const { db } = await getTestClient();
    const store = await PostgresTrigramLexicalStore.create(db);
    const run = (extra: object) => store.search(A, "hello", { limit: 3, filter: filter(extra) });
    await expect(run({ labels: ["x"], attributes: { k: "v" } })).resolves.toEqual([]);
    await rejectsNamed(() => run({ labels: [NUL] }), "opts.filter.labels[0]");
    await rejectsNamed(() => run({ attributes: { k: NUL } }), "opts.filter.attributes (value)");
  });

  it("PostgresVectorStore.search・searchMany: 同じ", async () => {
    const { db } = await getTestClient();
    const store = new PostgresVectorStore(db);
    const search = (extra: object) =>
      store.search(A, TEST_EMBEDDING_SPACE, [1, 0, 0], { limit: 3, filter: filter(extra) });
    const searchMany = (extra: object) =>
      store.searchMany(A, TEST_EMBEDDING_SPACE, [{ key: "k", vector: [1, 0, 0] }], {
        limit: 3,
        filter: filter(extra),
      });
    await expect(search({ labels: ["x"], attributes: { k: "v" } })).resolves.toEqual([]);
    await expect(searchMany({ labels: ["x"], attributes: { k: "v" } })).resolves.toBeDefined();
    await rejectsNamed(() => search({ labels: [NUL] }), "opts.filter.labels[0]");
    await rejectsNamed(() => search({ attributes: { k: NUL } }), "opts.filter.attributes (value)");
    await rejectsNamed(() => searchMany({ labels: [NUL] }), "opts.filter.labels[0]");
    await rejectsNamed(
      () => searchMany({ attributes: { [NUL]: "v" } }),
      "opts.filter.attributes (key)",
    );
  });
});
