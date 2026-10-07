import { DrizzleQueryError, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * 値を落とす作りが、落とす以外のことをしていない、という歯。`error-message-omits-params.postgres.test.ts` は「message に値が無い」ことを見る。
 * ここは、その裏の約束を本物の DB の例外で縛る。
 *
 * - 例外の同一性: 投げられるのは DB 由来の例外そのもの（`DrizzleQueryError`。`name` も元のまま）。同じ message・cause の別の型（`TypeError` など）に作り直さない。
 * - `DrizzleQueryError.params`（値の配列）は変えない。落とすのは message と stack の文字だけ。
 * - `cause` の pg エラーの `message`・`detail`（pg が理由を説明する文）は残す。
 *
 * 例外の起こし方は `error-message-omits-params.postgres.test.ts` と同じ。
 */

afterAll(async () => {
  await closeTestClient();
});

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const ctx: Ctx = { tenantId: "omit-params-keeps-identity" };
const MARKER = "keeps-identity-marker-3f9a";

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("reject しなかった");
}

type PgLike = { message?: string; detail?: string; code?: string; name?: string };

interface Mouth {
  name: string;
  code: string;
  /** cause の pg エラーの message が含む文（pg が理由を説明する文）。 */
  causeMessage: RegExp;
  /** pg エラーに `detail` が付く口だけ。 */
  causeDetail?: RegExp;
  /** `DrizzleQueryError.params` が、そのまま実際に渡した値を持っていること。 */
  expectParams: (params: unknown[]) => void;
  run: () => Promise<unknown>;
}

function expectDriverErrorKept(error: unknown, mouth: Mouth): void {
  expect(error).toBeInstanceOf(DrizzleQueryError);
  expect((error as Error).constructor.name).toBe("DrizzleQueryError");
  expect((error as Error).name).toBe("Error");
  expect(error).not.toBeInstanceOf(TypeError);
  const cause = (error as Error).cause as PgLike | undefined;
  expect(cause?.name).toBe("error");
  expect(cause?.code).toBe(mouth.code);
  const params = (error as DrizzleQueryError).params;
  expect(Array.isArray(params)).toBe(true);
  expect(params.length).toBeGreaterThan(0);
  mouth.expectParams(params);
  expect(cause?.message).toMatch(mouth.causeMessage);
  if (mouth.causeDetail) {
    expect(cause?.detail).toMatch(mouth.causeDetail);
  }
  // 落とすものは落ちている（やりすぎ・やらなさすぎの両方を見る）
  expect((error as Error).message).toContain("(omitted by mnemora,");
  expect((error as Error).message).not.toContain(MARKER);
}

describe("params を落とした例外が、DB 由来の例外そのもの・params・pg の理由を保つ（ADR 0516）", () => {
  it("Outbox complete（22003）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const mouth: Mouth = {
      name: "complete",
      code: "22003",
      causeMessage: /out of range for type integer/,
      expectParams: (params) => {
        // [completed_at, tenant_id, id, attempts]。先頭は時刻なので、後ろを値で見る。
        expect(params).toHaveLength(4);
        expect(params.slice(1)).toEqual([ctx.tenantId, JOB_ID, 2 ** 40]);
      },
      run: () => new PostgresOutboxStore(db).complete(ctx, JOB_ID, 2 ** 40),
    };
    expectDriverErrorKept(await thrown(mouth.run()), mouth);
  });

  it("Trigram search（22P02。pg の detail も残る）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) return; // SQL_ASCII・C ロケールの脚では create() が拒む（別の歯が見る）
    const store = await PostgresTrigramLexicalStore.create(db);
    const mouth: Mouth = {
      name: "search",
      code: "22P02",
      causeMessage: /invalid input syntax for type json/,
      causeDetail: /Unicode low surrogate must follow a high surrogate/,
      expectParams: (params) => {
        // tenant_id（2回）・属性の JSON・limit が、実際に渡した値のまま残っている
        expect(params).toContain(ctx.tenantId);
        expect(params).toContain(`{"k":"${MARKER}\\ud83d"}`);
        expect(params.at(-1)).toBe(5);
      },
      run: () =>
        store.search(ctx, "東京", {
          limit: 5,
          filter: { tenantId: ctx.tenantId, attributes: { k: `${MARKER}\uD83D` } },
        }),
    };
    expectDriverErrorKept(await thrown(mouth.run()), mouth);
  });

  it("TenantSettings setDecayClock（42P01）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    let error: unknown;
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL search_path = pg_catalog`);
        error = await thrown(
          new PostgresTenantSettingsStore(tx as never).setDecayClock(ctx, "wall"),
        );
        throw new Error("rollback");
      })
      .catch(() => undefined);
    expectDriverErrorKept(error, {
      name: "setDecayClock",
      code: "42P01",
      causeMessage: /relation "tenant_settings" does not exist/,
      expectParams: (params) => {
        expect(params).toEqual([ctx.tenantId, "wall"]);
      },
      run: async () => undefined,
    });
  });
});
