import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { omitParamsFromError } from "../failure-description.js";
import { isMalformedIdentifierError, MalformedIdentifierError } from "../identifier.js";

/**
 * Issue #1734（2026-09-30 マージ分の確かめ直し）の歯。PR #1520（ADR 0423）の変異試験で、次の2つがすり抜けた。
 * 担当はクローン（miku）の判断で進めている作業であり、オーナーの判断ではない。
 *
 * - I7: `isMalformedIdentifierError` が `instanceof` だけになる。ADR 0423 決定2・3（ADR 0418 の作法）は「`kind`、
 *   無ければ `name`」で見る。core が2つの版に分かれ、別 realm の `MalformedIdentifierError` が来ても通る。
 *   同じ realm では差が出ないので、`node:vm` の別 context で作った例外を渡す。
 * - E2: `omitParamsFromError` が `stack` を書き換えない。ADR 0423 決定6は「`message`（と、それを含む `stack`）を
 *   書き換える」。`stack` に `params:` 以降の本文が残ると、`stack` を表示・ログに出す利用者に本文が漏れる。
 *   既存の歯は `message` しか見ていなかった。
 */

describe("isMalformedIdentifierError は instanceof ではなく kind（無ければ name）で見る（ADR 0423・0418、Issue #1734）", () => {
  it("陽性対照: 同じ realm のクラスのインスタンスは通る", () => {
    expect(isMalformedIdentifierError(new MalformedIdentifierError("ctx.tenantId", "nul", 0))).toBe(
      true,
    );
  });

  it("別 realm で作った、kind を持つ例外は通る", () => {
    const foreign = vm.runInNewContext(
      `(() => { const e = new Error("x"); e.name = "MalformedIdentifierError"; e.kind = "malformed_identifier"; return e; })()`,
    );
    expect(foreign instanceof MalformedIdentifierError).toBe(false); // 前提: instanceof では判別できない
    expect(isMalformedIdentifierError(foreign)).toBe(true);
  });

  it("別 realm で作った、kind が無く name だけの例外（kind がまだ無い古い版の core）も通る", () => {
    const foreign = vm.runInNewContext(
      `(() => { const e = new Error("x"); e.name = "MalformedIdentifierError"; return e; })()`,
    );
    expect(foreign instanceof MalformedIdentifierError).toBe(false);
    expect(isMalformedIdentifierError(foreign)).toBe(true);
  });

  it.each([
    ["別の kind を持つ例外", { kind: "outbox_lease_conflict", name: "MalformedIdentifierError" }],
    ["別の name で kind の無い例外", { name: "Error" }],
    ["文字列", "malformed_identifier"],
    ["null", null],
  ])("通らない: %s", (_label, value) => {
    expect(isMalformedIdentifierError(value)).toBe(false);
  });
});

describe("omitParamsFromError は stack からも params 以降の本文を落とす（ADR 0423 決定6、Issue #1734）", () => {
  const SECRET = "mnemora-core-stack-secret-7e2a";
  const SQL = 'Failed query: select * from "memories" where "id" = $1';

  it("message と同じく stack からも、params: 以降の本文が消える（SQL の文は残る）", () => {
    const error = new Error(`${SQL}\nparams: ${SECRET}`);
    // 前提（陽性対照）: 書き換える前の stack には本文が載っている。
    expect(error.stack).toContain(SECRET);

    omitParamsFromError(error);

    expect(error.message).not.toContain(SECRET);
    expect(error.stack).not.toContain(SECRET);
    expect(error.stack).toContain(SQL);
  });

  it("cause の連鎖の stack からも消える", () => {
    const inner = new Error(`${SQL}\nparams: ${SECRET}-inner`);
    const outer = new Error("外側", { cause: inner });
    expect(inner.stack).toContain(`${SECRET}-inner`);

    omitParamsFromError(outer);

    expect(inner.stack).not.toContain(`${SECRET}-inner`);
  });
});
