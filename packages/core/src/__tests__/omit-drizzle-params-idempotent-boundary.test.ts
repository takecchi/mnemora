import { describe, expect, it } from "vitest";
import { omitDrizzleParams } from "../failure-description.js";

const HEAD = "Failed query: INSERT INTO memories (content) VALUES ($1)\nparams: ";

describe("omitDrizzleParams: 既に落とした印だけを、そのまま通す", () => {
  it("params の後ろがちょうど印の形なら、文字数の数字を書き換えずそのまま返す", () => {
    const once = `${HEAD}(omitted by mnemora, 34 chars)`;

    expect(omitDrizzleParams(once)).toBe(once);
  });

  it("params の後ろが印の形で始まっても、続きがあれば全体を落とす", () => {
    const rest = "(omitted by mnemora, 5 chars) 利用者の本文";

    expect(omitDrizzleParams(`${HEAD}${rest}`)).toBe(
      `${HEAD}(omitted by mnemora, ${rest.length} chars)`,
    );
  });

  it("params の後ろが印の前半だけで始まる本文でも、全体を落とす", () => {
    const rest = "(omitted 利用者の本文";

    expect(omitDrizzleParams(`${HEAD}${rest}`)).toBe(
      `${HEAD}(omitted by mnemora, ${rest.length} chars)`,
    );
  });
});

describe("omitDrizzleParams: 印の形に似ているだけの本文は、全体を落とす", () => {
  it("params の後ろが本文で始まり、印の形で終わっても、全体を落とす", () => {
    const rest = "利用者の本文 (omitted by mnemora, 5 chars)";

    expect(omitDrizzleParams(`${HEAD}${rest}`)).toBe(
      `${HEAD}(omitted by mnemora, ${rest.length} chars)`,
    );
  });

  it("文字数の数字が欠けた印の形は、印として通さず全体を落とす", () => {
    const rest = "(omitted by mnemora,  chars)";

    expect(omitDrizzleParams(`${HEAD}${rest}`)).toBe(
      `${HEAD}(omitted by mnemora, ${rest.length} chars)`,
    );
  });
});
