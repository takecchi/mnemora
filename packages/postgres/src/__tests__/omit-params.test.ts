import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { omitParamsFromError } from "../omit-params.js";

/**
 * `omitParamsFromError`（`../omit-params.ts`、ADR 0504）の doc が約束する2つを、**DB 無しで**偽の例外で縛る歯（ADR 0586）。
 *
 * - `cause` の連鎖にも掛ける——連鎖の深いところの例外の `message`・`stack` からも、`params:` より後ろが消える。
 * - `stack` も書き換える——書き換えより前に `stack` を読んでおいた例外でも、`stack` の中の params が置き換わる。
 *
 * 本物の drizzle の例外（`*.postgres.test.ts` の歯）では、`cause` は pg のエラーで `params:` を持たず、
 * `stack` も書き換えより前には読まれていない。そのため、この2つは本物の例外の歯では縛れない
 * （どちらを外す変異も、`error-message-omits-params.postgres.test.ts` などは緑のままだった。ADR 0586）。
 */

const SECRET = "mnemora-omit-params-secret-7f3a";
const SQL = 'Failed query: select * from "memories" where "id" = $1';

function drizzleLikeError(label: string, cause?: unknown): Error {
  const error = new Error(`${SQL} -- ${label}\nparams: ${SECRET}-${label}`);
  if (cause !== undefined) {
    (error as { cause?: unknown }).cause = cause;
  }
  return error;
}

function chainOf(error: unknown): Array<{ message: string; stack: string }> {
  const out: Array<{ message: string; stack: string }> = [];
  let current: unknown = error;
  while (current instanceof Error) {
    out.push({ message: current.message, stack: current.stack ?? "" });
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

describe("omitParamsFromError: cause の連鎖にも掛ける（ADR 0504 の doc。ADR 0586）", () => {
  it("3段の cause の連鎖の、どの段の message・stack からも params が消え、SQL の文は残る", () => {
    const deepest = drizzleLikeError("depth2");
    const middle = drizzleLikeError("depth1", deepest);
    const top = drizzleLikeError("depth0", middle);

    expect(omitParamsFromError(top)).toBe(top);

    const chain = chainOf(top);
    expect(chain).toHaveLength(3);
    chain.forEach(({ message, stack }, depth) => {
      expect(message, `depth ${depth} の message`).not.toContain(SECRET);
      expect(stack, `depth ${depth} の stack`).not.toContain(SECRET);
      expect(message, `depth ${depth} の message`).toContain(`${SQL} -- depth${depth}`);
      expect(message, `depth ${depth} の message`).toMatch(
        /\nparams: \(omitted by mnemora, \d+ chars\)$/,
      );
    });
    // 連鎖の形（同じ例外のオブジェクト）は変えない。
    expect((top as { cause?: unknown }).cause).toBe(middle);
    expect((middle as { cause?: unknown }).cause).toBe(deepest);
  });

  it("params を持たない段（pg のエラーの形）を挟んでも、その先の段まで掛ける", () => {
    const deepest = drizzleLikeError("depth2");
    const pgLike = new Error("invalid input syntax for type json");
    (pgLike as { cause?: unknown }).cause = deepest;
    const top = drizzleLikeError("depth0", pgLike);

    omitParamsFromError(top);

    expect(pgLike.message).toBe("invalid input syntax for type json");
    expect(deepest.message).not.toContain(SECRET);
    expect(deepest.stack ?? "").not.toContain(SECRET);
  });
});

describe("omitParamsFromError: 先に読まれていた stack も書き換える（ADR 0504 の doc。ADR 0586）", () => {
  it("書き換えより前に stack を読んでおいた例外でも、stack の中の params が置き換わる", () => {
    const error = drizzleLikeError("stack");
    // 先に読む——V8 は `stack` を最初に読んだときの `message` で文字列にするので、ここで params 入りの stack が固まる。
    const before = error.stack ?? "";
    expect(before).toContain(SECRET);

    omitParamsFromError(error);

    expect(error.stack ?? "").not.toContain(SECRET);
    expect(error.stack ?? "").toMatch(/\nparams: \(omitted by mnemora, \d+ chars\)/);
    // SQL の文と、呼び出し位置の行は残る。
    expect(error.stack ?? "").toContain(`${SQL} -- stack`);
    expect(error.stack ?? "").toContain("omit-params.test.ts");
  });

  it("cause の段の、先に読まれていた stack も書き換える", () => {
    const inner = drizzleLikeError("inner");
    const top = drizzleLikeError("outer", inner);
    expect(inner.stack ?? "").toContain(SECRET);
    expect(top.stack ?? "").toContain(SECRET);

    omitParamsFromError(top);

    expect(top.stack ?? "").not.toContain(SECRET);
    expect(inner.stack ?? "").not.toContain(SECRET);
  });
});

/**
 * ADR 0592（ADR 0586 の歯の穴、確かめ直し）: 上の歯がどれも捕まえなかった3つ。
 *
 * - 循環する `cause` でも止まる（`seen` の歯止め。外すと無限ループ）。無限ループは同期なので vitest の
 *   時間切れでは止まらない。`node:vm` の `timeout` で打ち切り、赤として観測できる形にする。
 * - 書き換えられない（凍結された）例外は、投げずにそのまま返す（`catch` で握る）。
 * - 冪等——2回掛けても1回と同じ（印済みの検査。外すと、印の中の文字数が毎回書き変わる）。
 */
describe("omitParamsFromError: 取りこぼしていた3つ（ADR 0592）", () => {
  it("cause が循環していても止まり、輪の全員の params が消える", () => {
    const a = drizzleLikeError("cycleA");
    const b = drizzleLikeError("cycleB", a);
    (a as { cause?: unknown }).cause = b; // a -> b -> a
    const sandbox = { omitParamsFromError, a };
    let returned: unknown;
    expect(() => {
      returned = vm.runInNewContext("omitParamsFromError(a)", sandbox, { timeout: 2000 });
    }).not.toThrow();
    expect(returned).toBe(a);
    expect(a.message).not.toContain(SECRET);
    expect(b.message).not.toContain(SECRET);
    expect(a.message).toContain(SQL);
  });

  it("凍結された例外は、投げずにそのまま返す（message は変わらない）", () => {
    const frozen = Object.freeze(drizzleLikeError("frozen"));
    const before = frozen.message;
    let returned: unknown;
    expect(() => {
      returned = omitParamsFromError(frozen);
    }).not.toThrow();
    expect(returned).toBe(frozen);
    expect(frozen.message).toBe(before);
  });

  it("凍結された例外の cause の段は、書き換えられるなら書き換える（途中で止まらない）", () => {
    const inner = drizzleLikeError("inner");
    const frozen = Object.freeze(drizzleLikeError("frozenOuter", inner));
    expect(() => omitParamsFromError(frozen)).not.toThrow();
    expect(inner.message).not.toContain(SECRET);
  });

  it("冪等: 2回掛けても1回と同じ（message も stack の中の message も）", () => {
    const once = drizzleLikeError("idem");
    omitParamsFromError(once);
    const twice = drizzleLikeError("idem");
    omitParamsFromError(twice);
    omitParamsFromError(twice);
    expect(once.message).toMatch(/\nparams: \(omitted by mnemora, \d+ chars\)$/);
    expect(twice.message).toBe(once.message);
    // stack には呼び出し位置が入るので全体は比べない。先頭（message を含む行）が1回のときと同じであること。
    expect(once.stack ?? "").toContain(once.message);
    expect(twice.stack ?? "").toContain(once.message);
  });
});
