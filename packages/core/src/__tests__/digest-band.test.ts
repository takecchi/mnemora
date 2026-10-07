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

describe("packDigestBand — maxEntryChars が NaN（境界値）", () => {
  it("NaN の maxEntryChars は負数と同じ安全側（digest を空に切る）へ倒れ、無制限へ化けない", () => {
    // `length > NaN` は常に false なので、NaN は上限0として扱う（負数の `maxEntryChars` と同じ）。
    const candidates = [entry("m1", "0123456789")];
    const opts = { limit: 10, maxChars: 10_000 };
    const nan = packDigestBand(candidates, 1, { ...opts, maxEntryChars: NaN });
    const negative = packDigestBand(candidates, 1, { ...opts, maxEntryChars: -5 });
    expect(nan.band).toEqual([{ memoryId: "m1", digest: "", truncated: true }]);
    expect(nan).toEqual(negative);
  });
});

describe("packDigestBand — 切り詰め位置が UTF-16 サロゲートペアの内側（境界値）", () => {
  it("サロゲートペアの内側で切ると孤立サロゲートを作ってしまうため、1文字手前で止める", () => {
    // "😀" は UTF-16 では2コードユニット（サロゲートペア）。`digest.slice(0, 5)` を素朴にやると孤立サロゲートができ、
    // UTF-8 へエンコードする経路（Postgres の digest 列への書き込み）で静かに U+FFFD へ壊れる。
    const candidates = [entry("m1", "AAAA😀BBBB")];
    const { band } = packDigestBand(candidates, 1, {
      limit: 10,
      maxChars: 10_000,
      maxEntryChars: 5,
    });
    expect(band).toEqual([{ memoryId: "m1", digest: "AAAA", truncated: true }]);
  });

  it("ペアがちょうど境界に収まる場合は割らない——1文字も余計に削らない", () => {
    const candidates = [entry("m1", "AAAA😀BBBB")];
    const { band } = packDigestBand(candidates, 1, {
      limit: 10,
      maxChars: 10_000,
      maxEntryChars: 6,
    });
    expect(band).toEqual([{ memoryId: "m1", digest: "AAAA😀", truncated: true }]);
  });

  it("文字数の予算は UTF-16 のコードユニットで数える（サロゲートペアは2字、コードポイントの1字ではない）", () => {
    // 1件のコスト = 63(固定) + digest長(😀×3 = 6コードユニット) + 1(区切り) = 70。
    // コードポイントで数えると 67 になり、maxChars=68 に収まってしまう。
    const candidates = [entry("m1", "😀😀😀")];
    const tooSmall = packDigestBand(candidates, 1, { limit: 10, maxChars: 68, maxEntryChars: 100 });
    expect(tooSmall.band).toEqual([]);
    expect(tooSmall.limitedBy).toBe("char_budget");
    const exact = packDigestBand(candidates, 1, { limit: 10, maxChars: 70, maxEntryChars: 100 });
    expect(exact.band).toHaveLength(1);
  });
});

describe("packDigestBand — limit/maxChars が NaN（境界値、Issue #803）", () => {
  // `band.length >= opts.limit` / `runningChars + cost > opts.maxChars` は比較の片方が NaN だと常に false になり、上限が実質無制限に化ける。
  // NaN だけを負数と同じ安全側（既に上限に達している扱い）に倒す。
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

  it("limit が NaN で、maxChars も実際に超えているなら 'both'（負数と同じ）", () => {
    const options = { maxChars: 0, maxEntryChars: 100 };
    const withNaN = packDigestBand(candidates, 3, { limit: NaN, ...options });
    const withNegative = packDigestBand(candidates, 3, { limit: -1, ...options });
    expect(withNaN).toEqual(withNegative);
    expect(withNaN.band).toEqual([]);
    expect(withNaN.limitedBy).toBe("both");
  });

  it("maxChars が NaN で、limit も実際に超えているなら 'both'（負数と同じ）", () => {
    const options = { limit: 0, maxEntryChars: 100 };
    const withNaN = packDigestBand(candidates, 3, { maxChars: NaN, ...options });
    const withNegative = packDigestBand(candidates, 3, { maxChars: -1, ...options });
    expect(withNaN).toEqual(withNegative);
    expect(withNaN.band).toEqual([]);
    expect(withNaN.limitedBy).toBe("both");
  });

  it("候補が無く eligible も 0 なら、limit・maxChars が NaN でも limitedBy は付かない（負数と同じ）", () => {
    for (const opts of [
      { limit: NaN, maxChars: 10_000, maxEntryChars: 100 },
      { limit: 10, maxChars: NaN, maxEntryChars: 100 },
      { limit: NaN, maxChars: NaN, maxEntryChars: 100 },
    ]) {
      expect(packDigestBand([], 0, opts)).toEqual({ band: [] });
    }
    expect(packDigestBand([], 0, { limit: -1, maxChars: -1, maxEntryChars: 100 })).toEqual({
      band: [],
    });
  });
});

describe("packDigestBand — limit/maxChars が Infinity（境界値、Issue #803では変えない）", () => {
  // +Infinity は「上限なし」として意味が通るので、NaN とは違って今の挙動のまま
  // （呼び出し側が明示的に上限を外す手段として使っている可能性があるため、狭めない）。
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

describe("packDigestBand — 切り詰め位置が書記素の途中（穴 O-5、ADR 0424）", () => {
  const pack = (digest: string, maxEntryChars: number) =>
    packDigestBand([entry("m1", digest)], 1, { limit: 10, maxChars: 10_000, maxEntryChars })
      .band[0]!.digest;

  it("NFD の「が」（か + 結合濁点）を、濁点だけ落として「か」にしない", () => {
    const nfdGa = "が".normalize("NFD"); // "か" + U+3099（2コードユニット）
    expect(nfdGa).toHaveLength(2);
    expect(pack(`ab${nfdGa}cd`, 3)).toBe("ab");
    expect(pack(`ab${nfdGa}cd`, 4)).toBe(`ab${nfdGa}`);
  });

  it("ZWJ で繋がった絵文字を、ZWJ だけ残して切らない", () => {
    const family = "👨‍👩‍👧"; // 👨 ZWJ 👩 ZWJ 👧（8コードユニット）
    expect(family).toHaveLength(8);
    expect(pack(`a${family}b`, 4)).toBe("a");
    expect(pack(`a${family}b`, 8)).toBe("a");
    expect(pack(`a${family}b`, 9)).toBe(`a${family}`);
  });

  it("最初の書記素だけで上限を超えるなら、空文字列になる（上限は超えない）", () => {
    expect(pack("👨‍👩‍👧", 3)).toBe("");
  });

  it("陽性対照: 書記素が1コードユニットの ASCII は今までどおり maxEntryChars 文字で切れる", () => {
    expect(pack("0123456789", 5)).toBe("01234");
  });
});

describe("packDigestBand — maxEntryChars の +Infinity は上限なし、NaN は band の全件を空に切る（ADR 0585）", () => {
  const opts = { limit: 10, maxChars: 10_000 };

  it("maxEntryChars: +Infinity は上限なし——digest を切らず、truncated も立てない", () => {
    // NaN を空に切る判定へ `+Infinity` が巻き込まれると、全件が空文字になる。
    const long = "x".repeat(5000);
    const { band, limitedBy } = packDigestBand([entry("m1", long), entry("m2", "short")], 2, {
      ...opts,
      maxEntryChars: Number.POSITIVE_INFINITY,
    });
    expect(band).toEqual([
      { memoryId: "m1", digest: long },
      { memoryId: "m2", digest: "short" },
    ]);
    expect(band[0]).not.toHaveProperty("truncated");
    expect(band[1]).not.toHaveProperty("truncated");
    expect(limitedBy).toBeUndefined();
  });

  it("maxEntryChars: NaN は band の2件目以降でも効く——全件の digest が空になり truncated: true", () => {
    // NaN の処理が「band の1件目だけ」に限られても、1件候補の既存の歯は緑のままになる。
    const candidates = [entry("m1", "0123456789"), entry("m2", "abcdefghij"), entry("m3", "XYZ")];
    const { band } = packDigestBand(candidates, 3, { ...opts, maxEntryChars: NaN });
    expect(band).toEqual([
      { memoryId: "m1", digest: "", truncated: true },
      { memoryId: "m2", digest: "", truncated: true },
      { memoryId: "m3", digest: "", truncated: true },
    ]);
  });

  it("もとの digest が空文字の候補も、NaN は負数（-5）と同じ結果になる（truncated: true）", () => {
    // 負数では `0 > -5` が真なので、空文字でも truncated が立つ。NaN も同じ結果にそろえる。
    const candidates = [entry("m1", "")];
    const nan = packDigestBand(candidates, 1, { ...opts, maxEntryChars: NaN });
    const negative = packDigestBand(candidates, 1, { ...opts, maxEntryChars: -5 });
    expect(negative.band).toEqual([{ memoryId: "m1", digest: "", truncated: true }]);
    expect(nan).toEqual(negative);
  });
});
