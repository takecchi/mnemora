import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddingSpaceId } from "@mnemora/core";
import { embeddingSpaceTableName } from "../embedding-space-table.js";
import { registerEmbeddingSpace } from "../vector-space.js";
import { closeTestClient, getTestClient } from "./test-db.js";

const PAIRS: Array<[string, EmbeddingSpaceId, EmbeddingSpaceId]> = [
  [
    "区切りの位置が違う",
    { provider: "a_b", model: "c", dimensions: 3 },
    { provider: "a", model: "b_c", dimensions: 3 },
  ],
  [
    "大文字小文字と記号が違う",
    { provider: "openai", model: "text-embedding-3-small", dimensions: 3 },
    { provider: "OpenAI", model: "text_embedding_3_small", dimensions: 3 },
  ],
  [
    "`:` と `-` が違う",
    { provider: "ollama", model: "nomic-embed-text:latest", dimensions: 3 },
    { provider: "ollama", model: "nomic-embed-text-latest", dimensions: 3 },
  ],
  [
    "ASCII 以外の文字だけが違う",
    { provider: "x", model: "日本語モデル", dimensions: 3 },
    { provider: "x", model: "中文模型", dimensions: 3 },
  ],
  // 上の4組は、どれも model の綴りか、大文字小文字以外の違いも持っているので、組の比較が大文字小文字を畳んでも provider を見なくても model の違いで拒めてしまう。
  // 次の2組は、違う欄を provider の1つだけにしてあり、比較が provider を・大文字小文字を区別して見ていることを縛る。
  [
    "provider の大文字小文字だけが違う（model・dimensions は同じ）",
    { provider: "ZzProbe", model: "probe-model", dimensions: 3 },
    { provider: "zzprobe", model: "probe-model", dimensions: 3 },
  ],
  [
    "provider の区切りだけが違う（model・dimensions は同じ）",
    { provider: "zz_probe_p", model: "probe-model", dimensions: 3 },
    { provider: "zz-probe-p", model: "probe-model", dimensions: 3 },
  ],
];

async function dropTableOf(space: EmbeddingSpaceId): Promise<string> {
  const { pool } = await getTestClient();
  const table = embeddingSpaceTableName(space);
  await pool.query(`DROP TABLE IF EXISTS ${table}`);
  return table;
}

async function commentOf(table: string): Promise<string | null> {
  const { pool } = await getTestClient();
  const result = await pool.query<{ c: string | null }>(
    `SELECT obj_description(to_regclass($1), 'pg_class') AS c`,
    [table],
  );
  return result.rows[0]?.c ?? null;
}

/**
 * `COMMENT ON TABLE` を打つ直前に `delayMs` 待つ Pool の見せかけ（`pool.query` と、`pool.connect()` で借りた
 * client の `query` の両方）。コメントを「読んでから書くまで」の窓を、測れる幅まで広げるために使う。
 * 待ち始めた時点で `onCommentStart` を呼ぶ。
 */
function withDelayedComment(pool: Pool, delayMs: number, onCommentStart: () => void): Pool {
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop) {
        const value: unknown = Reflect.get(t, prop);
        if (prop === "query") {
          return async (sql: unknown, ...rest: unknown[]) => {
            if (typeof sql === "string" && sql.trimStart().startsWith("COMMENT ON TABLE")) {
              onCommentStart();
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            return (value as (...args: unknown[]) => unknown).call(t, sql, ...rest);
          };
        }
        if (prop === "connect") {
          return async (...args: unknown[]) =>
            wrap(await (value as (...a: unknown[]) => Promise<object>).call(t, ...args));
        }
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(t)
          : value;
      },
    });
  return wrap(pool);
}

async function rejectsAsConflict(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("EmbeddingSpaceTableConflictError");
  return error as Error;
}

afterAll(async () => {
  await closeTestClient();
});

describe("registerEmbeddingSpace は、同じテーブルに潰れる別の空間の登録を拒む（Issue #1151）", () => {
  beforeEach(async () => {
    for (const [, first, second] of PAIRS) {
      await dropTableOf(first);
      await dropTableOf(second);
    }
  });

  it.each(PAIRS)(
    "%s: 2つ目の組の登録は拒まれ、1つ目の組の再登録は通る",
    async (_, first, second) => {
      const { pool } = await getTestClient();
      expect(embeddingSpaceTableName(first)).toBe(embeddingSpaceTableName(second));

      await registerEmbeddingSpace(pool, first);
      const error = await rejectsAsConflict(registerEmbeddingSpace(pool, second));
      expect(error.message).toContain(JSON.stringify(first.model));
      expect(error.message).toContain(JSON.stringify(second.model));

      await expect(registerEmbeddingSpace(pool, first)).resolves.toBeDefined();
    },
  );

  it.each(PAIRS)(
    "%s: 衝突する別々の2つの組を同時に登録すると、片方だけが通り、もう片方は拒まれる",
    async (_, first, second) => {
      const { pool } = await getTestClient();
      const table = embeddingSpaceTableName(first);

      const settled = await Promise.allSettled([
        registerEmbeddingSpace(pool, first),
        registerEmbeddingSpace(pool, second),
      ]);

      const fulfilled = settled.flatMap((s, i) => (s.status === "fulfilled" ? [i] : []));
      const rejected = settled.flatMap((s, i) => (s.status === "rejected" ? [i] : []));
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason = (settled[rejected[0]!] as PromiseRejectedResult).reason as Error;
      expect(reason.name).toBe("EmbeddingSpaceTableConflictError");
      const winner = fulfilled[0] === 0 ? first : second;
      expect(await commentOf(table)).toBe(
        `mnemora:embedding-space:${JSON.stringify({
          provider: winner.provider,
          model: winner.model,
          dimensions: winner.dimensions,
        })}`,
      );
    },
  );

  it("1つ目が「コメントを読んでから書くまで」の間に止まっていても、2つ目はその間に割り込めず、拒まれる", async () => {
    // 突き合わせ（読み）と記録（書き）が advisory lock の内側に一続きで在れば、2つ目の読みは1つ目の記録を見る。
    // lock の外に出ていると、2つ目は1つ目の書きの前に「コメントが無い」と読んで自分の組を書き、後から来た1つ目がそれを上書きする（どちらも成功する）。
    // 窓を測れる幅（400ms）にして、順序を固定する。
    const { pool } = await getTestClient();
    const [, first, second] = PAIRS[0]!;
    const table = embeddingSpaceTableName(first);

    let commentStarted!: () => void;
    const firstIsWriting = new Promise<void>((resolve) => {
      commentStarted = resolve;
    });
    const slowPool = withDelayedComment(pool, 400, commentStarted);

    const firstRun = registerEmbeddingSpace(slowPool, first);
    await firstIsWriting;
    const secondRun = registerEmbeddingSpace(pool, second);
    const settled = await Promise.allSettled([firstRun, secondRun]);

    expect(settled[0]?.status).toBe("fulfilled");
    expect(settled[1]?.status).toBe("rejected");
    expect(((settled[1] as PromiseRejectedResult).reason as Error).name).toBe(
      "EmbeddingSpaceTableConflictError",
    );
    expect(await commentOf(table)).toContain(JSON.stringify(first.model));
  });

  it("コメントの無い既存のテーブル（修正前に作られたもの）は、最初の登録の組を記録して通す", async () => {
    const { pool } = await getTestClient();
    const [, first, second] = PAIRS[0]!;
    const table = embeddingSpaceTableName(first);
    await registerEmbeddingSpace(pool, first);
    await pool.query(`COMMENT ON TABLE ${table} IS NULL`);

    await expect(registerEmbeddingSpace(pool, second)).resolves.toBeDefined();
    expect(await commentOf(table)).toContain(JSON.stringify(second.model));
    await rejectsAsConflict(registerEmbeddingSpace(pool, first));
  });

  it("mnemora の形ではないコメント（利用者が付けたもの）は上書きせず、登録を通す", async () => {
    const { pool } = await getTestClient();
    const [, first, second] = PAIRS[1]!;
    const table = embeddingSpaceTableName(first);
    await registerEmbeddingSpace(pool, first);
    await pool.query(`COMMENT ON TABLE ${table} IS 'owned by the search team'`);

    await expect(registerEmbeddingSpace(pool, second)).resolves.toBeDefined();
    expect(await commentOf(table)).toBe("owned by the search team");
  });
});
