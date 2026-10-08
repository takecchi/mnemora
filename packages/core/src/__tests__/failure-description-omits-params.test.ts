import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { omitParamsFromError } from "../failure-description.js";

/** 循環する `cause` の無限ループは同期なので vitest の時間切れでは止まらない。`node:vm` の `timeout` で打ち切り、赤として観測できる形にする。冪等は `standalone-functions-omit-params.test.ts` に歯があるので足さない。 */

const SECRET = "mnemora-core-omit-params-secret-5c1d";
const SQL = 'Failed query: select * from "memories" where "id" = $1';

function drizzleLikeError(label: string, cause?: unknown): Error {
  const error = new Error(`${SQL} -- ${label}\nparams: ${SECRET}-${label}`);
  if (cause !== undefined) {
    (error as { cause?: unknown }).cause = cause;
  }
  return error;
}

describe("core の omitParamsFromError: 取りこぼしていた2つ（ADR 0592）", () => {
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

  it("自分自身を cause にする例外でも止まる", () => {
    const self = drizzleLikeError("self");
    (self as { cause?: unknown }).cause = self;
    let returned: unknown;
    expect(() => {
      returned = vm.runInNewContext(
        "omitParamsFromError(e)",
        { omitParamsFromError, e: self },
        {
          timeout: 2000,
        },
      );
    }).not.toThrow();
    expect(returned).toBe(self);
    expect(self.message).not.toContain(SECRET);
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
});

describe("core の omitParamsFromError: SQL に置換の記号（$$・$&）があっても stack は message と同じ文面になる", () => {
  // Postgres のドル引用（`$$`）や `$&` を含む SQL を、置き換え後の文字列として `String.prototype.replace` に
  // そのまま渡すと記号として解釈され、`$&` は元の message（params の本文を含む）に化ける。
  it.each([
    ["$&", "Failed query: select '$&' as x"],
    ["$$", "Failed query: do $$ begin perform 1; end $$"],
    ["$`", "Failed query: select '$`' as x"],
  ])(
    "%s を含む SQL でも、stack から本文が消え、stack の先頭は書き換えた message と一致する",
    (_label, sql) => {
      const error = new Error(`${sql}\nparams: ${SECRET}`);
      expect(error.stack).toContain(SECRET);

      omitParamsFromError(error);

      expect(error.message).toContain(sql);
      expect(error.message).not.toContain(SECRET);
      expect(error.stack).not.toContain(SECRET);
      expect(error.stack!.startsWith(`Error: ${error.message}\n`)).toBe(true);
    },
  );
});
