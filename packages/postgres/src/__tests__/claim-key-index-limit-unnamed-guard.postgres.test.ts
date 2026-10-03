import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { isClaimKeyIndexLimitError } from "@mnemora/core";
import type { Ctx, NewMemory } from "@mnemora/core";
import { buildNewMemoryFixture, buildNewObservationFixture } from "@mnemora/testkit";
import { translateClaimKeyIndexLimit } from "../claim-key-index-limit.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0435 の「名前の無い 54000」（`index row requires N bytes, maximum size is 8191`）を `ClaimKeyIndexLimitError` に
 * 包む条件のうち、冪等の索引（`uq_memories_extraction`: tenantId・sourceObservationId・extractorVersion・contentHash）の項を縛る。
 * 項は tenantId・extractorVersion・contentHash の3つで、3つの合計が btree の上限（2704 バイト）を超えたら包まない
 * （冪等の索引の行が原因かもしれないので、claim key のせいとは言えない）。
 *
 * - 本物の Postgres: claimKey が小さく、extractorVersion か contentHash だけが1万字のとき、名前の無い 54000 が出て、
 *   包まれずに生の例外のまま出る（`uq_memories_extraction` は sourceObservationId があるときだけ効く partial 索引）。
 * - 合成した 54000: 3つの項のそれぞれが、合計に入っている（1つだけ外すと包んでしまう入力）。tenantId は本物の索引の行が
 *   8191 バイトに届く大きさにすると `tenantId + subjectId` の項が先に弾くので、本物では縛れず、ここで縛る。
 * - 境界: 合計がちょうど 2704 バイトなら包み、2705 バイトなら包まない。
 *
 * 縛らないもの: 例外の型（`RangeError` かどうか）、`cause` に pg の欄を全部写すかどうか。
 */

afterAll(async () => {
  await closeTestClient();
});

const LIMIT = 2704;

/** 圧縮が効かない長い hex。 */
function incompressibleHex(seed: string, length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i++) {
    out += createHash("sha256").update(`${seed}:${i}`).digest("hex");
  }
  return out.slice(0, length);
}

const SMALL_CLAIM_KEY = { subject: "s", predicate: "p" };

function unnamed54000(): Error {
  return Object.assign(new Error("index row requires 9000 bytes, maximum size is 8191"), {
    code: "54000",
  });
}

async function translate(tenantId: string, over: Partial<NewMemory>): Promise<unknown> {
  const ctx: Ctx = { tenantId };
  const input = buildNewMemoryFixture({ tenantId, claimKey: SMALL_CLAIM_KEY, ...over });
  return translateClaimKeyIndexLimit("createMemory", ctx, input, () =>
    Promise.reject(unnamed54000()),
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("名前の無い 54000: 冪等の索引の項（本物の Postgres）", () => {
  const FIELDS: Array<[string, (value: string) => Partial<NewMemory>]> = [
    ["contentHash", (value) => ({ contentHash: value })],
    ["extractorVersion", (value) => ({ extractorVersion: value })],
  ];

  it.each(FIELDS)(
    "claimKey は小さく、%s だけが1万字: 名前の無い 54000 が出て、包まれずに生の例外のまま出る",
    async (name, over) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const store = new PostgresMemoryStore(db);
      const ctx: Ctx = { tenantId: "claim-key-index-limit-guard" };
      const observation = await store.createObservation(
        ctx,
        buildNewObservationFixture({ tenantId: ctx.tenantId }),
      );
      const input = buildNewMemoryFixture({
        tenantId: ctx.tenantId,
        sourceObservationId: observation.id,
        claimKey: SMALL_CLAIM_KEY,
        ...over(incompressibleHex(name, 10000)),
      });
      const error = await store.createMemory(ctx, input).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, name).toBeInstanceOf(Error);
      expect(isClaimKeyIndexLimitError(error), name).toBe(false);
      // 名前の無い形の 54000 そのもの（drizzle の例外の cause の連鎖のどこかに在る）。
      let found = false;
      let current: unknown = error;
      while (typeof current === "object" && current !== null) {
        const { code, message } = current as { code?: unknown; message?: unknown };
        if (
          code === "54000" &&
          typeof message === "string" &&
          /^index row requires \d+ bytes, maximum size is 8191$/.test(message)
        ) {
          found = true;
        }
        current = (current as { cause?: unknown }).cause;
      }
      expect(found, name).toBe(true);
    },
  );
});

describe("createMemoriesWithOutboxAndEvents: 全候補が落ちたときは最初の例外を投げる", () => {
  const limitFailure = () =>
    buildNewMemoryFixture({
      tenantId: "claim-key-first-error",
      contentHash: "limit-failure",
      claimKey: { subject: "s", predicate: incompressibleHex("p", 10000) },
    });
  // 値域の外（23514）。ClaimKeyIndexLimitError とは別の形で落ちる。
  const checkFailure = () =>
    buildNewMemoryFixture({
      tenantId: "claim-key-first-error",
      contentHash: "check-failure",
      strength: 5,
      claimKey: SMALL_CLAIM_KEY,
    });

  it.each([
    ["索引の上限 → 値域", [limitFailure, checkFailure], true],
    ["値域 → 索引の上限", [checkFailure, limitFailure], false],
  ] as const)(
    "%s の順に落ちる: 投げられるのは先頭の候補の例外",
    async (_label, builders, firstIsLimit) => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const store = new PostgresMemoryStore(db);
      const ctx: Ctx = { tenantId: "claim-key-first-error" };
      const error = await store
        .createMemoriesWithOutboxAndEvents(
          ctx,
          builders.map((build) => ({ input: build(), jobKinds: ["embed"] })),
          () => {
            throw new Error("event builder must not run");
          },
        )
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(Error);
      expect(isClaimKeyIndexLimitError(error)).toBe(firstIsLimit);
    },
  );
});

describe("名前の無い 54000: 冪等の索引の項（合成した 54000）", () => {
  // 3つの項の合計が 2704 を少し超える。どれか1つの項を合計から外すと 2704 以下になり、包んでしまう。
  const SPREADS: Array<[string, number, number, number]> = [
    ["tenantId が大きい", 2000, 400, 400],
    ["extractorVersion が大きい", 400, 2000, 400],
    ["contentHash が大きい", 400, 400, 2000],
    ["3つとも同じ", 1000, 1000, 1000],
  ];

  it.each(SPREADS)(
    "%s（合計が上限を超える）: 包まず、生の例外のまま出る",
    async (_label, tenantBytes, versionBytes, hashBytes) => {
      const error = await translate("t".repeat(tenantBytes), {
        extractorVersion: "e".repeat(versionBytes),
        contentHash: "h".repeat(hashBytes),
      });
      expect(isClaimKeyIndexLimitError(error)).toBe(false);
      expect((error as { code?: string }).code).toBe("54000");
    },
  );

  it.each(SPREADS)(
    "%s でも、合計が上限以下まで小さくすれば包む（断りすぎていない）",
    async (_label, tenantBytes, versionBytes, hashBytes) => {
      const scale = (n: number) =>
        Math.floor((n * LIMIT) / (tenantBytes + versionBytes + hashBytes));
      const error = await translate("t".repeat(scale(tenantBytes)), {
        extractorVersion: "e".repeat(scale(versionBytes)),
        contentHash: "h".repeat(scale(hashBytes)),
      });
      expect(isClaimKeyIndexLimitError(error)).toBe(true);
    },
  );

  it("境界: 3つの合計がちょうど 2704 バイトなら包み、2705 バイトなら包まない", async () => {
    const atLimit = await translate("t".repeat(900), {
      extractorVersion: "e".repeat(900),
      contentHash: "h".repeat(904),
    });
    expect(isClaimKeyIndexLimitError(atLimit)).toBe(true);
    const overLimit = await translate("t".repeat(900), {
      extractorVersion: "e".repeat(900),
      contentHash: "h".repeat(905),
    });
    expect(isClaimKeyIndexLimitError(overLimit)).toBe(false);
  });
});
