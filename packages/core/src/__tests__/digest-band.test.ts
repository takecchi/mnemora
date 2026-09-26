import { describe, expect, it } from "vitest";
import { packDigestBand } from "../digest-band.js";
import type { DigestEntry } from "../recall.js";

function entry(memoryId: string, digest: string): DigestEntry {
  return { memoryId, digest };
}

describe("packDigestBand — 順序（並べ替えない）", () => {
  it("candidates の順序をそのまま保つ", () => {
    const candidates = [entry("m3", "c"), entry("m1", "a"), entry("m2", "b")];
    const { band } = packDigestBand(candidates, 3, {
      limit: 10,
      maxChars: 10_000,
      maxEntryChars: 100,
    });
    expect(band.map((e) => e.memoryId)).toEqual(["m3", "m1", "m2"]);
  });
});

describe("packDigestBand — 1件の切り詰め（truncated）", () => {
  it("digest が maxEntryChars を超えたら切り詰めて truncated: true を立てる", () => {
    const candidates = [entry("m1", "0123456789")]; // 10文字
    const { band } = packDigestBand(candidates, 1, {
      limit: 10,
      maxChars: 10_000,
      maxEntryChars: 5,
    });
    expect(band).toEqual([{ memoryId: "m1", digest: "01234", truncated: true }]);
  });

  it("digest が maxEntryChars 以下なら truncated を立てない（省略される）", () => {
    const candidates = [entry("m1", "01234")]; // ちょうど5文字
    const { band } = packDigestBand(candidates, 1, {
      limit: 10,
      maxChars: 10_000,
      maxEntryChars: 5,
    });
    expect(band).toEqual([{ memoryId: "m1", digest: "01234" }]);
    expect(band[0]).not.toHaveProperty("truncated");
  });
});

describe("packDigestBand — limitedBy の決め方", () => {
  it("どの上限にも当たらなければ limitedBy は undefined（全件載る）", () => {
    const candidates = [entry("m1", "a"), entry("m2", "b"), entry("m3", "c")];
    const result = packDigestBand(candidates, 3, {
      limit: 10,
      maxChars: 10_000,
      maxEntryChars: 100,
    });
    expect(result.band).toHaveLength(3);
    expect(result.limitedBy).toBeUndefined();
  });

  it("件数の上限で切れたら limitedBy === 'entry_limit'", () => {
    const candidates = [
      entry("m1", "aaaaa"),
      entry("m2", "bbbbb"),
      entry("m3", "ccccc"),
      entry("m4", "ddddd"),
    ];
    const result = packDigestBand(candidates, 4, {
      limit: 2,
      maxChars: 10_000,
      maxEntryChars: 100,
    });
    expect(result.band).toHaveLength(2);
    expect(result.band.map((e) => e.memoryId)).toEqual(["m1", "m2"]);
    expect(result.limitedBy).toBe("entry_limit");
  });

  it("文字数の予算で切れたら limitedBy === 'char_budget'", () => {
    // 1件のコスト = 63(固定) + digest長(5) + 1(区切り) = 69。
    // maxChars=150 なら 2件(138)まで載り、3件目(207)で超える。limit は大きく取って
    // 件数側では絶対に切れないようにする。
    const candidates = [
      entry("m1", "aaaaa"),
      entry("m2", "bbbbb"),
      entry("m3", "ccccc"),
      entry("m4", "ddddd"),
    ];
    const result = packDigestBand(candidates, 4, { limit: 10, maxChars: 150, maxEntryChars: 100 });
    expect(result.band).toHaveLength(2);
    expect(result.limitedBy).toBe("char_budget");
  });

  it("同じ件で件数上限と文字数予算の両方に同時に当たったら limitedBy === 'both'", () => {
    // limit=2 なので3件目は entry_limit に当たる。同時に、1〜2件目の合計コストを
    // ちょうど maxChars に一致させておくと、3件目を足すと文字数も超える
    // ——「次の件を足すと件数も文字数も超える状態」を作る。
    const candidates = [entry("m1", "aaaaa"), entry("m2", "bbbbb"), entry("m3", "ccccc")];
    // 1件のコスト = 63 + 5 + 1 = 69。2件で 138。maxChars を 138 ちょうどに設定する。
    const result = packDigestBand(candidates, 3, { limit: 2, maxChars: 138, maxEntryChars: 100 });
    expect(result.band).toHaveLength(2);
    expect(result.limitedBy).toBe("both");
  });
});

describe("packDigestBand — band.length <= eligible の不変条件", () => {
  it("limit に 10,000 を渡しても band.length は eligible を超えない", () => {
    const candidates = [entry("m1", "a"), entry("m2", "b"), entry("m3", "c")];
    const result = packDigestBand(candidates, 3, {
      limit: 10_000,
      maxChars: 10_000,
      maxEntryChars: 100,
    });
    expect(result.band.length).toBeLessThanOrEqual(3);
    expect(result.band).toHaveLength(3);
    expect(result.limitedBy).toBeUndefined();
  });

  it("candidates が既に limit 相当で切られて渡ってきた（eligible > candidates.length）場合も entry_limit になる", () => {
    // 呼び出し側（store）が既に候補を5件だけ渡してきたが、資格があった総数は100件、
    // という状況——ここでは打ち切りは一度も内部で起きないが、それでも entry_limit を
    // 名乗らなければ「全部載った」と誤読される。
    const candidates = [
      entry("m1", "a"),
      entry("m2", "b"),
      entry("m3", "c"),
      entry("m4", "d"),
      entry("m5", "e"),
    ];
    const result = packDigestBand(candidates, 100, {
      limit: 5,
      maxChars: 10_000,
      maxEntryChars: 100,
    });
    expect(result.band).toHaveLength(5);
    expect(result.limitedBy).toBe("entry_limit");
  });
});

describe("packDigestBand — maxEntryChars が負数（境界値）", () => {
  it("負数の maxEntryChars を渡しても、切り詰め後の digest 長は 0 を下回らない", () => {
    // `String.prototype.slice(0, n)` は n が負数だと「末尾から n 文字を除く」という
    // 別の意味になる（先頭からの切り詰めにはならない）。maxEntryChars は「1件の digest の
    // 文字数上限」であり、負数は「上限0（何も残さない）」の下限として扱うのが筋——
    // 末尾から数文字だけ削った長い文字列を返すのは、この欄の契約と食い違う。
    const candidates = [entry("m1", "0123456789")]; // 10文字
    const { band } = packDigestBand(candidates, 1, {
      limit: 10,
      maxChars: 10_000,
      maxEntryChars: -5,
    });
    expect(band).toEqual([{ memoryId: "m1", digest: "", truncated: true }]);
  });
});

describe("packDigestBand — limit/maxChars が NaN（境界値、Issue #803）", () => {
  // `band.length >= opts.limit` / `runningChars + cost > opts.maxChars` は、比較の片方が
  // NaN だと常に false になる——打ち切り条件が一度も成立せず、上限が実質「無制限」に
  // 化けていた（負数を渡すと逆に安全側へ倒れるのと対照的）。NaN だけを負数と同じ
  // 安全側（既に上限に達している扱い）に倒す。
  const candidates = [entry("m1", "aaaaa"), entry("m2", "bbbbb"), entry("m3", "ccccc")];

  it("limit が NaN なら band は空で limitedBy === 'entry_limit'", () => {
    const result = packDigestBand(candidates, 3, {
      limit: NaN,
      maxChars: 10_000,
      maxEntryChars: 100,
    });
    expect(result.band).toEqual([]);
    expect(result.limitedBy).toBe("entry_limit");
  });

  it("maxChars が NaN なら band は空で limitedBy === 'char_budget'", () => {
    const result = packDigestBand(candidates, 3, {
      limit: 10,
      maxChars: NaN,
      maxEntryChars: 100,
    });
    expect(result.band).toEqual([]);
    expect(result.limitedBy).toBe("char_budget");
  });

  it("limit と maxChars が両方 NaN なら band は空で limitedBy === 'both'", () => {
    const result = packDigestBand(candidates, 3, {
      limit: NaN,
      maxChars: NaN,
      maxEntryChars: 100,
    });
    expect(result.band).toEqual([]);
    expect(result.limitedBy).toBe("both");
  });
});

describe("packDigestBand — limit/maxChars が Infinity（境界値、Issue #803では変えない）", () => {
  // +Infinity は「上限なし」として意味が通るので、NaN とは違って今の挙動のまま
  // （呼び出し側が明示的に上限を外す手段として使っている可能性があるため、狭めない）。
  // -Infinity は負数と同じ扱い（安全側、即座に打ち切り）のまま。
  const candidates = [entry("m1", "aaaaa"), entry("m2", "bbbbb"), entry("m3", "ccccc")];

  it("limit が +Infinity なら件数側では打ち切らず全件載る", () => {
    const result = packDigestBand(candidates, 3, {
      limit: Infinity,
      maxChars: 10_000,
      maxEntryChars: 100,
    });
    expect(result.band).toHaveLength(3);
    expect(result.limitedBy).toBeUndefined();
  });

  it("maxChars が +Infinity なら文字数側では打ち切らず全件載る", () => {
    const result = packDigestBand(candidates, 3, {
      limit: 10,
      maxChars: Infinity,
      maxEntryChars: 100,
    });
    expect(result.band).toHaveLength(3);
    expect(result.limitedBy).toBeUndefined();
  });

  it("limit が -Infinity なら band は空で limitedBy === 'entry_limit'", () => {
    const result = packDigestBand(candidates, 3, {
      limit: -Infinity,
      maxChars: 10_000,
      maxEntryChars: 100,
    });
    expect(result.band).toEqual([]);
    expect(result.limitedBy).toBe("entry_limit");
  });

  it("maxChars が -Infinity なら band は空で limitedBy === 'char_budget'", () => {
    const result = packDigestBand(candidates, 3, {
      limit: 10,
      maxChars: -Infinity,
      maxEntryChars: 100,
    });
    expect(result.band).toEqual([]);
    expect(result.limitedBy).toBe("char_budget");
  });
});

describe("packDigestBand — eligible が 0", () => {
  it("候補が無ければ空の帯を返し、limitedBy は付かない", () => {
    const result = packDigestBand([], 0, { limit: 10, maxChars: 10_000, maxEntryChars: 100 });
    expect(result.band).toEqual([]);
    expect(result.limitedBy).toBeUndefined();
  });
});
