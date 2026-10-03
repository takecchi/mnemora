import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { omitParamsFromError } from "../failure-description.js";

/**
 * ADR 0592（ADR 0423・0586 の系の歯の穴、確かめ直し）: `omitParamsFromError`（`../failure-description.ts`）の
 * 既存の歯がどれも捕まえなかった2つ。冪等は `standalone-functions-omit-params.test.ts` に歯があるので足さない。
 *
 * - 循環する `cause` でも止まる（`seen` の歯止め。外すと無限ループ）。無限ループは同期なので vitest の
 *   時間切れでは止まらない。`node:vm` の `timeout` で打ち切り、赤として観測できる形にする。
 * - 書き換えられない（凍結された）例外は、投げずにそのまま返す。
 */

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
