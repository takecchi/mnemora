import { describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { InMemoryLexicalStore } from "../__fixtures__/in-memory-lexical-store.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";
import { InMemoryVectorStore } from "../__fixtures__/in-memory-vector-store.js";

const ctx: Ctx = { tenantId: "read-filter-nul" };
const NUL = "x\u0000y";
const SPACE = { provider: "p", model: "m", dimensions: 3 };
const OBS = "00000000-0000-4000-8000-000000000000";
const NAMED = /must not contain NUL characters \(U\+0000\)$/;

describe("findContestedByClaimKey は claimKey の NUL を断る（findActiveByClaimKey と同じ）", () => {
  const query = (subject: string, predicate: string) => ({
    subjectId: null,
    claimKey: { subject, predicate },
    excludeMemoryId: OBS,
    contentHash: "h",
    validFrom: null,
    validUntil: null,
  });

  it("subject・predicate の NUL は、名指しの例外になる", async () => {
    const store = new InMemoryMemoryStore();
    await expect(store.findContestedByClaimKey(ctx, query(NUL, "p"))).rejects.toThrow(
      /^findContestedByClaimKey: claimKey\.subject must not contain NUL characters \(U\+0000\)$/,
    );
    await expect(store.findContestedByClaimKey(ctx, query("s", NUL))).rejects.toThrow(
      /^findContestedByClaimKey: claimKey\.predicate must not contain NUL characters \(U\+0000\)$/,
    );
  });

  it("やりすぎ: NUL を含まない値（文字どおりの \\u0000・日本語）は通る", async () => {
    const store = new InMemoryMemoryStore();
    await expect(store.findContestedByClaimKey(ctx, query("\\u0000", "好き"))).resolves.toEqual([]);
  });
});

describe("InMemoryLexicalStore.search は filter.labels の NUL を断る", () => {
  const run = (labels: string[]) =>
    new InMemoryLexicalStore(new InMemoryMemoryStore()).search(ctx, "hello", {
      limit: 3,
      filter: { tenantId: ctx.tenantId, labels },
    });

  it("labels の要素の NUL は、名指しの例外になる（他の要素が NUL でなくても）", async () => {
    await expect(run([NUL])).rejects.toThrow(NAMED);
    await expect(run(["ok", NUL])).rejects.toThrow(/^search: filter\.labels must not contain/);
  });

  it("やりすぎ: NUL を含まない labels（空配列・文字どおりの \\u0000・日本語）は通る", async () => {
    await expect(run([])).resolves.toEqual([]);
    await expect(run(["\\u0000", "好き"])).resolves.toEqual([]);
  });
});

describe("InMemoryVectorStore.search・searchMany は filter.labels・filter.attributes の NUL を断る", () => {
  const filter = (extra: object) => ({ tenantId: ctx.tenantId, ...extra });
  const search = (extra: object) =>
    new InMemoryVectorStore(new InMemoryMemoryStore()).search(ctx, SPACE, [1, 0, 0], {
      limit: 3,
      filter: filter(extra),
    });
  const searchMany = (extra: object, queries = [{ key: "k", vector: [1, 0, 0] }]) =>
    new InMemoryVectorStore(new InMemoryMemoryStore()).searchMany(ctx, SPACE, queries, {
      limit: 3,
      filter: filter(extra),
    });

  it("labels の要素の NUL", async () => {
    await expect(search({ labels: [NUL] })).rejects.toThrow(
      /^search: filter\.labels must not contain NUL characters \(U\+0000\)$/,
    );
    await expect(searchMany({ labels: [NUL] })).rejects.toThrow(NAMED);
  });

  it("attributes の key・value の NUL", async () => {
    await expect(search({ attributes: { k: NUL } })).rejects.toThrow(
      /^search: filter\.attributes must not contain NUL characters \(U\+0000\)$/,
    );
    await expect(search({ attributes: { [NUL]: "v" } })).rejects.toThrow(NAMED);
    await expect(searchMany({ attributes: { k: NUL } })).rejects.toThrow(NAMED);
  });

  it("searchMany は queries が空でも断る（Postgres は往復の前に絞りを検査する）", async () => {
    await expect(searchMany({ labels: [NUL] }, [])).rejects.toThrow(NAMED);
  });

  it("やりすぎ: NUL を含まない絞りは通る", async () => {
    await expect(
      search({ labels: ["x", "\\u0000", "好き"], attributes: { k: "v" } }),
    ).resolves.toEqual([]);
    await expect(searchMany({ labels: ["x"], attributes: { k: "v" } })).resolves.toBeDefined();
  });
});
