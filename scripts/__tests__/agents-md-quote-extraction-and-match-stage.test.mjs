/**
 * 狭い窓の取り出しの境界と、`quoteExistsInAgentsMd` の `stage`（何段目で当たったか）を合成の入力で固定する。
 * 門の本体（本物の ADR と `AGENTS.md` を読む歯）は `agents-md-quote-attribution.test.mjs` にある。
 * そちらは現物の文面に頼るので、現物にたまたま無い形はここで押さえる。
 */

import { describe, expect, it } from "vitest";
import {
  findNarrowAgentsMdQuotes,
  quoteExistsInAgentsMd,
} from "../agents-md-quote-attribution-lib.mjs";

describe("狭い窓の取り出し —— 帰属の直後の鉤括弧だけを、入れ子ごと取る", () => {
  it("帰属と鉤括弧の間の半角空白は、狭い窓の隙間として許す", () => {
    expect(findNarrowAgentsMdQuotes("`AGENTS.md` 「⚠ 数を焼き込まない」に従う。")).toEqual([
      { quote: "⚠ 数を焼き込まない" },
    ]);
  });

  it("入れ子の「」は内側の 」 で切らず、対応する外側の 」 まで取る", () => {
    expect(findNarrowAgentsMdQuotes("`AGENTS.md`「外の「内の語」と続き」に従う。")).toEqual([
      { quote: "外の「内の語」と続き" },
    ]);
  });

  it("⛔ 帰属と鉤括弧の間に地の文が挟まる形は、狭い窓では拾わない（広い窓の側である）", () => {
    expect(findNarrowAgentsMdQuotes("`AGENTS.md` に照らすと「無関係な引用」になる。")).toEqual([]);
  });
});

describe("`stage` は、どの段の正規化で初めて当たったかを返す", () => {
  it("段2: 原典の行送りだけが違う", () => {
    const target = "⚠ 数を、道具と\n  生成物に焼き込まない";
    expect(quoteExistsInAgentsMd("⚠ 数を、道具と生成物に焼き込まない", target)).toEqual({
      exists: true,
      stage: 2,
    });
  });

  it("段3: 入れ子の作法で 『』 と 「」 が入れ替わっただけ", () => {
    const target = "### ⚠ 機械には「検出」まで — 確定と書き込みは人に残す";
    expect(quoteExistsInAgentsMd("⚠ 機械には『検出』まで", target)).toEqual({
      exists: true,
      stage: 3,
    });
  });

  it("段4: ダッシュの種類と空白だけが違う", () => {
    const target = "線は引けない — ADR が反例";
    expect(quoteExistsInAgentsMd("線は引けない - ADR が反例", target)).toEqual({
      exists: true,
      stage: 4,
    });
  });

  it("段5: 読点・句点だけが違う", () => {
    const target = "数を、道具と生成物に焼き込まない。";
    expect(quoteExistsInAgentsMd("数を道具と生成物に焼き込まない", target)).toEqual({
      exists: true,
      stage: 5,
    });
  });
});
