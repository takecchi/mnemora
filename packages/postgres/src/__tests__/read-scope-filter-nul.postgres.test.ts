import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/** 各 it の最初に、NUL を含まない同じ形の入力が通ることを見る（陽性対照）。`RecallQuery.labels`・`attributes` の値は zod が NUL を弾かない（key は文字種の正規表現が弾く）ので、`runtime.recall` から実際にここへ届く。 */

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
    await rejectsNamed(() => store.aggregateScope(A, { labels: ["ok", NUL] }), "scope.labels");
    await rejectsNamed(
      () => store.aggregateScope(A, { attributes: { k: NUL } }),
      "scope.attributes",
    );
    await rejectsNamed(
      () => store.aggregateScope(A, { attributes: { [NUL]: "v" } }),
      "scope.attributes",
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

  it("listBySourceObservation: observationId が uuid の形でなければ、extractorVersion に NUL があっても今までどおり DB に行かず [] を返す（断る入力は増やさない）", async () => {
    const { db } = await getTestClient();
    const store = new PostgresMemoryStore(db);
    await expect(store.listBySourceObservation(A, "not-a-uuid", "v1")).resolves.toEqual([]);
    await expect(store.listBySourceObservation(A, "not-a-uuid", NUL)).resolves.toEqual([]);
  });
});

describe("検索の絞り（filter）", () => {
  const filter = (extra: object) => ({ tenantId: A.tenantId, ...extra });

  it("PostgresLexicalStore.search: filter.labels・filter.attributes の NUL を名指しで断る", async () => {
    const { db } = await getTestClient();
    const store = new PostgresLexicalStore(db);
    const run = (extra: object) => store.search(A, "hello", { limit: 3, filter: filter(extra) });
    await expect(run({ labels: ["x"], attributes: { k: "v" } })).resolves.toEqual([]);
    await rejectsNamed(() => run({ labels: [NUL] }), "opts.filter.labels");
    await rejectsNamed(() => run({ attributes: { k: NUL } }), "opts.filter.attributes");
    await rejectsNamed(() => run({ attributes: { [NUL]: "v" } }), "opts.filter.attributes");
  });

  it("PostgresTrigramLexicalStore.search: 同じ（server_encoding が UTF8 でない DB では、store が作れないので飛ばす）", async (ctx) => {
    const { db } = await getTestClient();
    if (!(await probeTrigramLexicalSupport(db)).ok) {
      ctx.skip();
    }
    const store = await PostgresTrigramLexicalStore.create(db);
    const run = (extra: object) => store.search(A, "hello", { limit: 3, filter: filter(extra) });
    await expect(run({ labels: ["x"], attributes: { k: "v" } })).resolves.toEqual([]);
    await rejectsNamed(() => run({ labels: [NUL] }), "opts.filter.labels");
    await rejectsNamed(() => run({ attributes: { k: NUL } }), "opts.filter.attributes");
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
    await rejectsNamed(() => search({ labels: [NUL] }), "opts.filter.labels");
    await rejectsNamed(() => search({ attributes: { k: NUL } }), "opts.filter.attributes");
    await rejectsNamed(() => searchMany({ labels: [NUL] }), "opts.filter.labels");
    await rejectsNamed(() => searchMany({ attributes: { [NUL]: "v" } }), "opts.filter.attributes");
  });
});
