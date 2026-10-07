import { ClaimKeyIndexLimitError } from "@mnemora/core";
import type { Ctx, NewMemory } from "@mnemora/core";

/**
 * ADR 0435: `memories` への INSERT が claim key の btree 索引の1行の上限（SQLSTATE 54000）で落ちたときだけ、
 * {@link ClaimKeyIndexLimitError} に包む。**断る入力は変えない**（今通る入力は通り、今 54000 で落ちる入力だけが
 * 型付きの例外になる。長さの上限を入口に置かない）。
 *
 * 包む条件（どれも、Postgres のエラーが `code === "54000"` で、message が下の2つの決まった形のとき）:
 *
 * 1. **索引の名前が message に入る形**（`index row size N exceeds btree version V maximum M for index "NAME"`）で、
 *    `NAME` が claim key を含む索引（`idx_memories_claim_key`・`idx_memories_claim_predicates`）のとき。
 *    ほかの索引（`idx_memories_by_subject`・GIN の `idx_memories_tags` など）の 54000 は包まない。
 * 2. **索引の名前が入らない形**（`index row requires N bytes, maximum size is 8191`。1行が 8191 バイトを超えると、
 *    btree の検査より前に出る）。この形は**どの索引の行かを message から言えない**（実測: 1万字の tag・
 *    `subjectId` でも同じ文面）。そこで入力から、**claim key 以外には原因になりえないときだけ**包む
 *    （{@link onlyClaimKeyCanOverflow}）。決められないときは包まず、今までの生の例外のまま出す（安全側）。
 *
 * 🔴 **`cause` に drizzle の例外（`Failed query: … params: …` と `params`・`query` の欄）を残さない。**Postgres の
 * エラーから `code`・`schema`・`table`・`constraint` と、上の2形に一致した message（数値と索引名だけ）を写した
 * 新しい `Error` を `cause` にする。`detail`・`hint`・`where` などは写さない。
 */
const CLAIM_KEY_INDEXES: ReadonlySet<string> = new Set([
  "idx_memories_claim_key",
]);
const NAMED_INDEX_ROW =
  /^index row size \d+ exceeds btree version \d+ maximum \d+ for index "(\w+)"$/;
const UNNAMED_INDEX_ROW = /^index row requires \d+ bytes, maximum size is \d+$/;

/** btree の1行の上限（2704 バイト）。これ以下の値は、ほかの欄だけでは 8191 バイトの壁に届かない。 */
const BTREE_ROW_LIMIT_BYTES = 2704;

type PgIndexRowError = { message: string; code: "54000"; indexName: string | null; raw: object };

export async function translateClaimKeyIndexLimit<T>(
  method: ClaimKeyIndexLimitError["method"],
  ctx: Ctx,
  input: NewMemory,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const pg = findIndexRowError(error);
    if (pg !== null && isClaimKeyIndexRow(pg, ctx, input)) {
      throw new ClaimKeyIndexLimitError(method, { cause: valueFreeCause(pg.raw, pg.message) });
    }
    throw error;
  }
}

function findIndexRowError(error: unknown): PgIndexRowError | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { code, message, cause } = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (code === "54000" && typeof message === "string") {
      const named = NAMED_INDEX_ROW.exec(message);
      if (named !== null) {
        return { message, code, indexName: named[1]!, raw: current };
      }
      if (UNNAMED_INDEX_ROW.test(message)) {
        return { message, code, indexName: null, raw: current };
      }
    }
    current = cause;
  }
  return null;
}

function isClaimKeyIndexRow(pg: PgIndexRowError, ctx: Ctx, input: NewMemory): boolean {
  if (pg.indexName !== null) {
    return CLAIM_KEY_INDEXES.has(pg.indexName);
  }
  return onlyClaimKeyCanOverflow(ctx, input);
}

function bytes(value: string | null | undefined): number {
  return value === null || value === undefined ? 0 : Buffer.byteLength(value);
}

/**
 * 索引の名前が入らない形の 54000 を、claim key のものと言ってよいか。`claimKey` があり、かつ
 * claim key の索引に入るほかの値（`tenantId`・`subjectId`）、GIN の `tags` の各要素、
 * 冪等の索引（`tenantId`・`extractorVersion`・`contentHash`）が、**それぞれ単独では 8191 バイトの壁に
 * 届かない大きさ（btree の上限 2704 バイト以下）**のとき。圧縮は値を小さくするだけなので、この条件のもとで
 * 8191 バイトを超えうる行は claim key を含む索引の行だけである。
 */
function onlyClaimKeyCanOverflow(ctx: Ctx, input: NewMemory): boolean {
  if (input.claimKey === undefined || input.claimKey === null) {
    return false;
  }
  const limit = BTREE_ROW_LIMIT_BYTES;
  return (
    bytes(ctx.tenantId) + bytes(input.subjectId) <= limit &&
    bytes(ctx.tenantId) + bytes(input.extractorVersion) + bytes(input.contentHash) <= limit &&
    input.tags.every((tag) => bytes(tag) <= limit)
  );
}

function valueFreeCause(raw: object, message: string): Error {
  const cause = new Error(message);
  const source = raw as Record<string, unknown>;
  const copied: Record<string, string> = { code: "54000" };
  for (const key of ["schema", "table", "constraint"] as const) {
    const value = source[key];
    if (typeof value === "string") {
      copied[key] = value;
    }
  }
  return Object.assign(cause, copied);
}
