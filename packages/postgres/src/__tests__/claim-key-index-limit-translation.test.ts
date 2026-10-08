import { describe, expect, it } from "vitest";
import { isClaimKeyIndexLimitError } from "@mnemora/core";
import type { Ctx, NewMemory } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { translateClaimKeyIndexLimit } from "../claim-key-index-limit.js";

const TENANT = "claim-key-index-limit-translation";
const ctx: Ctx = { tenantId: TENANT };

function named54000(indexName: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(
    new Error(`index row size 3000 exceeds btree version 4 maximum 2704 for index "${indexName}"`),
    { code: "54000", ...extra },
  );
}

function unnamed54000(): Error {
  return Object.assign(new Error("index row requires 9000 bytes, maximum size is 8191"), {
    code: "54000",
  });
}

async function translate(
  failure: Error,
  over: Partial<NewMemory> = {},
  withoutClaimKey = false,
): Promise<unknown> {
  const input = buildNewMemoryFixture({
    tenantId: TENANT,
    ...(withoutClaimKey ? {} : { claimKey: { subject: "s", predicate: "p" } }),
    ...over,
  });
  return translateClaimKeyIndexLimit("createMemory", ctx, input, () =>
    Promise.reject(failure),
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("名前が入る 54000: claim key を含む索引だけを包む", () => {
  it("idx_memories_claim_predicates の 54000 は ClaimKeyIndexLimitError になる", async () => {
    const error = await translate(named54000("idx_memories_claim_predicates"));

    expect(isClaimKeyIndexLimitError(error)).toBe(true);
  });

  it("idx_memories_tags の 54000 は包まず、同じ例外がそのまま出る", async () => {
    const failure = named54000("idx_memories_tags");

    const error = await translate(failure);

    expect(error).toBe(failure);
  });

  it("文面の前後に別の文字が付いた 54000 は包まず、同じ例外がそのまま出る", async () => {
    const prefixed = Object.assign(
      new Error(`Failed: ${named54000("idx_memories_claim_key").message}`),
      { code: "54000" },
    );
    const suffixed = Object.assign(new Error(`${named54000("idx_memories_claim_key").message}!`), {
      code: "54000",
    });

    expect(await translate(prefixed)).toBe(prefixed);
    expect(await translate(suffixed)).toBe(suffixed);
  });
});

describe("名前が入らない 54000: claim key が原因と言える入力だけを包む", () => {
  it("claimKey が無い入力では包まず、同じ例外がそのまま出る", async () => {
    const failure = unnamed54000();

    expect(await translate(failure, {}, true)).toBe(failure);
    expect(await translate(failure, { claimKey: null })).toBe(failure);
  });

  it("tags の要素の大きさはバイトで数える（文字数が上限以下でもバイト数が超えれば包まない）", async () => {
    const overInBytes = await translate(unnamed54000(), { tags: ["あ".repeat(1000)] });
    const withinInBytes = await translate(unnamed54000(), { tags: ["あ".repeat(900)] });

    expect(isClaimKeyIndexLimitError(overInBytes)).toBe(false);
    expect(isClaimKeyIndexLimitError(withinInBytes)).toBe(true);
  });

  it("境界: tags の要素がちょうど 2704 バイトなら包み、2705 バイトなら包まない", async () => {
    const atLimit = await translate(unnamed54000(), { tags: ["g".repeat(2704)] });
    const overLimit = await translate(unnamed54000(), { tags: ["g".repeat(2705)] });

    expect(isClaimKeyIndexLimitError(atLimit)).toBe(true);
    expect(isClaimKeyIndexLimitError(overLimit)).toBe(false);
  });

  it("境界: tenantId と subjectId の合計がちょうど 2704 バイトなら包み、2705 バイトなら包まない", async () => {
    const tenantBytes = Buffer.byteLength(TENANT);
    const atLimit = await translate(unnamed54000(), { subjectId: "u".repeat(2704 - tenantBytes) });
    const overLimit = await translate(unnamed54000(), {
      subjectId: "u".repeat(2705 - tenantBytes),
    });

    expect(isClaimKeyIndexLimitError(atLimit)).toBe(true);
    expect(isClaimKeyIndexLimitError(overLimit)).toBe(false);
  });

  it("文面の前後に別の文字が付いた名前の無い形の 54000 は包まず、同じ例外がそのまま出る", async () => {
    const prefixed = Object.assign(new Error(`Failed: ${unnamed54000().message}`), {
      code: "54000",
    });
    const suffixed = Object.assign(new Error(`${unnamed54000().message}!`), { code: "54000" });

    expect(await translate(prefixed)).toBe(prefixed);
    expect(await translate(suffixed)).toBe(suffixed);
  });
});

describe("包んだ例外の cause は、pg のエラーから決まった欄だけを写す", () => {
  const raw = named54000("idx_memories_claim_key", {
    schema: "public",
    table: "memories",
    constraint: "idx_memories_claim_key",
    detail: "利用者の値-detail",
    hint: "利用者の値-hint",
    where: "利用者の値-where",
  });

  it("code・schema・table・constraint を写す", async () => {
    const error = (await translate(raw)) as { cause?: Record<string, unknown> };

    expect(error.cause).toMatchObject({
      code: "54000",
      schema: "public",
      table: "memories",
      constraint: "idx_memories_claim_key",
    });
  });

  it("元の pg のエラーそのものを cause にせず、detail・hint・where を写さない", async () => {
    const error = (await translate(raw)) as { cause?: object };

    expect(error.cause).not.toBe(raw);
    const ownText = Object.getOwnPropertyNames(error.cause)
      .map((key) => String((error.cause as Record<string, unknown>)[key]))
      .join("\n");
    expect(ownText).not.toContain("利用者の値");
    expect(Object.getOwnPropertyNames(error.cause)).not.toEqual(expect.arrayContaining(["detail"]));
  });
});
