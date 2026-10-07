import {
  DEFAULT_DIGEST_BAND_LIMIT,
  DEFAULT_RECALL_LIMIT,
  DIGEST_BAND_MAX_CHARS,
  DIGEST_BAND_MAX_ENTRY_CHARS,
} from "./recall.js";
import {
  DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS,
  DIGEST_BAND_ENTRY_SEPARATOR_CHARS,
} from "./digest-band.js";
import type { RecallResult } from "./recall.js";

/**
 * `recall-footprint` — mnemora を使うべき場面か、会話ログを全部積むほうが小さいかを、
 * LLM を呼ばずに判定する純関数（Issue #276）。
 *
 * 入力に取るのは**ターン数ではなく**、「会話ログ全部だと何文字か」と「スコープ内に Memory が何件あるか」。
 * 実測の比は単調に下がらず（一度悪化してからまた下がる区間がある）、「N ターン以上なら得」という形の判定は
 * その区間で嘘をつくため。
 *
 * 呼び出し側の義務:
 * - 会話ログの文字数は呼び出し側にしか無いので、必ず引数で受け取る（ここで推定しない）。
 * - 連想枠（ADR 0151）が実際に本体へ昇格させる件数も `packages/core` は知りようがないので、
 *   `RecallFootprintShape.associationCount` で受け取る（ADR 0166）。
 *   `recall()` の連想枠の既定が on でも（ADR 0337）、`associationCount` の既定は `0` のまま据え置く。
 *   `maxCount` は試みる上限であって昇格件数ではなく、流用すると推測を持ち込むことになるため。
 *   省略した見積もりは実際の `recall()` の出力を過小評価する。正確に見積もるなら
 *   `footprintSampleFromRecall` による較正か、過去の実測から見積もった値を明示的に渡すこと。
 */

/**
 * 見積もりが依存している、`recall` 側の構造定数の一覧。
 *
 * `BUILTIN_RECALL_FOOTPRINT_PROFILE` の係数は、これらの定数が現在の値であったときに測ったもの。
 * 既定プロファイルに「どの定数の下で測ったか」を記録し、現在値との一致をテストで検査する。
 * 守るのは既定プロファイルだけで、`calibrateRecallFootprint` で較正した値は検査できない。
 */
export interface FootprintStructuralConstants {
  /** `DEFAULT_RECALL_LIMIT` の値。 */
  defaultRecallLimit: number;
  /** `DEFAULT_DIGEST_BAND_LIMIT` の値。 */
  defaultDigestBandLimit: number;
  /** `DIGEST_BAND_MAX_CHARS` の値。 */
  digestBandMaxChars: number;
  /** `DIGEST_BAND_MAX_ENTRY_CHARS` の値。 */
  digestBandMaxEntryChars: number;
  /** `DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS` の値。 */
  digestBandEntryFixedOverheadChars: number;
  /** `DIGEST_BAND_ENTRY_SEPARATOR_CHARS` の値。 */
  digestBandEntrySeparatorChars: number;
}

/** 現在の構造定数。`recall.ts` / `digest-band.ts` の値をそのまま読む（複製した数値を置かない）。 */
export const FOOTPRINT_STRUCTURAL_CONSTANTS: FootprintStructuralConstants = {
  defaultRecallLimit: DEFAULT_RECALL_LIMIT,
  defaultDigestBandLimit: DEFAULT_DIGEST_BAND_LIMIT,
  digestBandMaxChars: DIGEST_BAND_MAX_CHARS,
  digestBandMaxEntryChars: DIGEST_BAND_MAX_ENTRY_CHARS,
  digestBandEntryFixedOverheadChars: DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS,
  digestBandEntrySeparatorChars: DIGEST_BAND_ENTRY_SEPARATOR_CHARS,
};

/** 較正で決まりうる係数の名前。`borrowedFromDefault` が指すのはこの集合である。 */
export type FootprintCoefficientName = "charsPerDigest" | "fixedIndexChars";

/**
 * 見積もりの出所。
 *
 * 較正していない見積もりは「探していない」であり、較正済みと同じ顔で返さない。
 * 注記の文字列ではなく、`origin.kind` で分岐できる形にしてある。
 * - `kind` が `'builtin_default'` ＝ 一度も較正していない。
 * - `kind` が `'calibrated'` かつ `borrowedFromDefault` が空 ＝ 全係数が実データから決まった。
 * - `kind` が `'calibrated'` かつ `borrowedFromDefault` が非空 ＝ 標本では決められなかった係数があり、
 *   そこだけ既定値のまま。
 *
 * この3つを1つの真偽値へ潰さないこと。
 */
export type FootprintProfileOrigin =
  | {
      kind: "builtin_default";
      /** 何を測った値か。 */
      measuredFrom: string;
      /** どの構造定数の下で測ったか。現在値と違っていれば、この係数は古い。 */
      measuredUnder: FootprintStructuralConstants;
    }
  | {
      kind: "calibrated";
      /** 較正に実際に使えた標本数（渡された標本数とは限らない）。 */
      sampleCount: number;
      /** 較正に使った標本の `memoryCount` の範囲。外挿の判定に使う。 */
      observedMemoryCount: { min: number; max: number };
      /** 標本から決められず、既定値のまま残った係数。空なら全部データから決まった。 */
      borrowedFromDefault: readonly FootprintCoefficientName[];
    };

/**
 * 見積もりの係数。自由な係数は2つだけ。
 *
 * 他の項（目次帯1件あたりの器・帯全体の上限・件数上限）は `recall` 側の構造定数から決まるので、
 * 係数として持たない（同じ意味の値が2箇所に在って食い違いうるため。ADR 0011）。
 */
export interface RecallFootprintProfile {
  /** この係数の出所（既定か、較正したか。{@link FootprintProfileOrigin}）。 */
  origin: FootprintProfileOrigin;
  /**
   * Memory 1件の digest の平均文字数。`memories` tier と `index` tier（目次帯）の両方に効く。
   */
  charsPerDigest: number;
  /**
   * 件数に依らない固定分（`JSON.stringify(indexBand)` のうち `groups` / `totalInScope` / `countKind` /
   * `digestBandCoverage` などの器）。`groups` は群の数に比例して伸びるが、較正の標本に群の数の広がりが無く
   * 分離できないため定数として扱う。
   */
  fixedIndexChars: number;
}

/**
 * 同梱の既定プロファイル。較正していない呼び出し側のための初手の値。
 *
 * **このリポジトリのベンチ（日本語・`recorded`・`examples/chat`）で測った値であって、呼び出し側の環境の値ではない。**
 * 言語・モデル・埋め込み・コーパスが変われば動く。誤解は `origin` で防ぐ（`FootprintProfileOrigin`）。
 *
 * 較正を必須にして既定値を同梱しない形にしない: `recall()` を一度も呼んでいない時点
 * （「mnemora を入れるべきか」を判断したい時点）でこの関数が使えなくなるため。
 */
export const BUILTIN_RECALL_FOOTPRINT_PROFILE: RecallFootprintProfile = {
  origin: {
    kind: "builtin_default",
    measuredFrom:
      "examples/chat/compare-baseline.json（CI の example-chat ジョブが実測し repo に commit した値。" +
      "12点のうち目次帯が空の hold-in 7点、totalInScope <= DEFAULT_RECALL_LIMIT）と、" +
      "examples/chat/recall-footprint-calibration-samples-baseline.json（同じく CI 実測、" +
      "RecallQuery.limit=20 を明示して帯を空に保った8点、totalInScope は10〜19の範囲）を" +
      "合わせた15点の最小二乗（Issue #340 フォローアップ、ADR 0306/0310）。両ファイルとも" +
      "llmMode=recorded / embeddingMode=recorded。標本には totalInScope を渡し、" +
      "calibrateRecallFootprint が構造項（indexBandStructuralTerms、桁上がり分）を" +
      "差し引いてから較正している（ADR 0306）——15点のうち7点は totalInScope が2桁であり、" +
      "この差し引きを行わないと係数がずれる。compare-baseline.json の帯のある5点は較正に" +
      "使っていない（hold-out）。旧い値（7点だけの較正、charsPerDigest≒15.458 / " +
      "fixedIndexChars≒170.881）は examples/chat/src/__tests__/recall-footprint-baseline." +
      "test.ts の回帰の歯にいまも残っている。",
    measuredUnder: {
      defaultRecallLimit: 10,
      defaultDigestBandLimit: 50,
      digestBandMaxChars: 4000,
      digestBandMaxEntryChars: 120,
      digestBandEntryFixedOverheadChars: 63,
      digestBandEntrySeparatorChars: 1,
    },
  },
  charsPerDigest: 16.175,
  fixedIndexChars: 168.503,
};

/**
 * 見積もりの許容誤差の既定値（`compareWithFullLog` が `'too_close_to_call'` を返す幅）。
 *
 * この値は「この関数の精度が常に5%以内」を意味しない。このリポジトリのベンチの12点での最大残差
 * （2.023%、ADR 0306/0310）に余裕を見た値でしかない。較正していない環境・外挿の領域ではもっと外れうる。
 * そのことは `origin` と `RecallFootprintEstimate.extrapolated` が名乗る。
 */
export const DEFAULT_FOOTPRINT_TOLERANCE = 0.05;

/**
 * 較正の標本1件。`RecallResult` から `footprintSampleFromRecall` で作れる。
 *
 * `totalInScope` は任意。省略した標本は構造項0として扱われる（何も差し引かない）。
 * 与えると `calibrateRecallFootprint` が推定器と同じ `indexBandStructuralTerms` で構造項を差し引く。
 * 2桁以上の標本を差し引かずに混ぜると、桁上がり分が較正係数へ吸い込まれたうえで
 * `estimateRecallFootprint` がもう一度足し、二重計上になる（ADR 0302、ADR 0306）。
 */
export interface RecallFootprintSample {
  /** `usage.chars`（digest tier + index tier の合計）。 */
  totalChars: number;
  /** `memories.length`。 */
  memoryCount: number;
  /** `index.digestBand?.length ?? 0`。 */
  bandEntryCount: number;
  /** `index.totalInScope`。任意。省略すれば構造項を0として扱う。 */
  totalInScope?: number;
}

/** `RecallResult` から較正の標本を取り出す。 */
export function footprintSampleFromRecall(result: RecallResult): RecallFootprintSample {
  return {
    totalChars: result.usage.chars,
    memoryCount: result.memories.length,
    bandEntryCount: result.index.digestBand?.length ?? 0,
    totalInScope: result.index.totalInScope,
  };
}

/**
 * 較正の標本1件が含んでいたはずの構造項の合計（ADR 0306）。`sample.totalInScope` が無ければ `0`。
 * `calibrateRecallFootprint` が呼ぶのは `bandEntryCount === 0` の標本だけなので、`bandEntries` は `0` 固定、
 * `charsPerDigest` は結果に効かないダミー値でよい。
 */
function structuralCarryForSample(sample: RecallFootprintSample): number {
  if (sample.totalInScope === undefined) return 0;
  const terms = indexBandStructuralTerms(sample.totalInScope, sample.memoryCount, 0, 0);
  return (
    terms.bandChars +
    terms.totalInScopeDigitCarry +
    terms.bandCoverageDigitCarry +
    terms.limitedByChars
  );
}

/**
 * 標本から係数を較正する。LLM も DB もネットワークも使わない純関数。
 *
 * **使うのは `bandEntryCount === 0` の標本だけ。** 帯の項の大きさは求めたい係数 `charsPerDigest` に依存し、
 * 混ぜると係数が両辺に現れる。帯が空なら `totalChars = fixedIndexChars + memoryCount * charsPerDigest` の
 * 線形式になる。帯のある標本は較正に使われないが、予測の検証（hold-out）に使える。
 *
 * 構造項（`indexBandStructuralTerms`、ADR 0302）は標本の `totalInScope` から差し引いてから最小二乗する
 * （ADR 0306）。省略した標本は構造項0。
 *
 * 標本が足りないときに黙って既定値へ倒れない。借りた係数は `origin.borrowedFromDefault` に名前で出る。
 * 標本から求めた傾き（`charsPerDigest`）が0以下なら採らず、既定値から借りる（digest の平均長が0以下は
 * ありえない）。最小二乗の枝では、切片は借りた傾きのもとで標本の平均を通るように決める。
 *
 * @param samples 較正の標本。`bandEntryCount === 0` のものだけが使われる。
 * @param fallback 決められなかった係数の借り元。既定は同梱プロファイル。
 */
export function calibrateRecallFootprint(
  samples: readonly RecallFootprintSample[],
  fallback: RecallFootprintProfile = BUILTIN_RECALL_FOOTPRINT_PROFILE,
): RecallFootprintProfile {
  const usable = samples
    // ADR 0467: 件数・総量が有限でない標本は使える標本に数えない（係数が NaN でも『較正済み』の顔で返るため）。
    .filter(
      (s) =>
        s.bandEntryCount === 0 &&
        s.memoryCount > 0 &&
        Number.isFinite(s.memoryCount) &&
        Number.isFinite(s.totalChars),
    )
    .map((s) => ({ ...s, totalChars: s.totalChars - structuralCarryForSample(s) }));
  const counts = usable.map((s) => s.memoryCount);
  // ADR 0467: `Math.min(...counts)` は標本が約12万件を超えるとスプレッド引数の上限で RangeError になる。
  let observedMin = 0;
  let observedMax = 0;
  for (const [i, c] of counts.entries()) {
    if (i === 0 || c < observedMin) observedMin = c;
    if (i === 0 || c > observedMax) observedMax = c;
  }
  const observedMemoryCount = { min: observedMin, max: observedMax };

  const borrowed: FootprintCoefficientName[] = [];
  let charsPerDigest = fallback.charsPerDigest;
  let fixedIndexChars = fallback.fixedIndexChars;

  const distinct = new Set(counts).size;
  if (distinct >= 2) {
    // 2点以上で `memoryCount` が異なる ⟹ 傾きと切片の両方が決まる（最小二乗）。
    const n = usable.length;
    const sx = usable.reduce((a, s) => a + s.memoryCount, 0);
    const sy = usable.reduce((a, s) => a + s.totalChars, 0);
    const sxx = usable.reduce((a, s) => a + s.memoryCount * s.memoryCount, 0);
    const sxy = usable.reduce((a, s) => a + s.memoryCount * s.totalChars, 0);
    const denominator = n * sxx - sx * sx;
    const slope = (n * sxy - sx * sy) / denominator;
    // ADR 0467: 有限でない傾き（合計のオーバーフローなど）も、0以下と同じく採らない。
    if (Number.isFinite(slope) && slope > 0) {
      charsPerDigest = slope;
    } else {
      // 最小二乗の傾きが0以下になるのは標本の側の事情で、そのまま採ると以後の見積もりが静かに壊れる
      // （`chars` が負になる）。傾きは既定値から借りて名前で出し、切片は借りた傾きのもとで標本の平均を通す。
      borrowed.push("charsPerDigest");
    }
    const intercept = (sy - charsPerDigest * sx) / n;
    if (Number.isFinite(intercept)) {
      fixedIndexChars = intercept;
    } else {
      // ADR 0467: 切片が数にならない（合計のオーバーフロー）。傾きと同じ形で既定値から借りて名前で出す。
      borrowed.push("fixedIndexChars");
    }
  } else if (distinct === 1) {
    // `memoryCount` が1種類しかないと切片は決まらない。切片を借りて傾きだけを決める。
    borrowed.push("fixedIndexChars");
    const n = usable.length;
    const meanY = usable.reduce((a, s) => a + s.totalChars, 0) / n;
    const derived = (meanY - fixedIndexChars) / usable[0]!.memoryCount;
    if (Number.isFinite(derived) && derived > 0) {
      charsPerDigest = derived;
    } else {
      // 借りた切片が標本の総量より大きいと傾きが0以下になる。そのまま採ると見積もりが静かに壊れる
      // （`chars` が負になり、判定は常に `mnemora_smaller` へ倒れる）ので、傾きも借りたことにして名前で出す。
      borrowed.push("charsPerDigest");
    }
  } else {
    // 使える標本がない ⟹ 両方とも借りる。
    borrowed.push("charsPerDigest", "fixedIndexChars");
  }

  return {
    origin: {
      kind: "calibrated",
      sampleCount: usable.length,
      observedMemoryCount,
      borrowedFromDefault: borrowed,
    },
    charsPerDigest,
    fixedIndexChars,
  };
}

/** 見積もりたい状況。ターン数を取らない。 */
export interface RecallFootprintShape {
  /**
   * `recall()` のスコープ内に在る Memory の件数（`RecallResult.index.totalInScope` に相当）。
   * 一度も `recall()` を呼んでいない時点でも見積もれるよう、件数そのものを受け取る。
   */
  memoryCountInScope: number;
  /** `RecallQuery.limit`。省略時は `DEFAULT_RECALL_LIMIT`。 */
  limit?: number | undefined;
  /** `RecallQuery.digestBandLimit`。省略時は `DEFAULT_DIGEST_BAND_LIMIT`。 */
  digestBandLimit?: number | undefined;
  /**
   * 連想枠（`RecallQuery.association`、ADR 0151）が本体へ昇格させると見込む件数。省略時は `0`。
   *
   * **`association.maxCount` ではない。** 実際の昇格件数は候補の類似度（`minSimilarity`・アンカーごとの
   * ANN 近傍分布）に依存し、`packages/core` は知りようがない。実測（`footprintSampleFromRecall` による較正）か
   * 過去の実測から見積もった値を持っているときだけ渡すこと。
   *
   * 省略時の `0` は、`recall()` の連想枠の既定が on でも意図して据え置く（ADR 0337）。
   * `RecallQuery.association: null` で止めた場合を除き、**見積もりは実際より小さく出る**（過小評価にのみ倒れる）。
   *
   * 構造上の上限は `memoryCountInScope - min(limit, memoryCountInScope)`。超えた分は切り詰められる。
   */
  associationCount?: number | undefined;
}

/** 見積もりの内訳。 */
export interface RecallFootprintEstimate {
  /** 見積もった総文字数（`RecallUsage.chars` に対応）。 */
  chars: number;
  /**
   * tier 別の内訳。モデルによる帰属であって、実測の `RecallUsage.byTier` ではない
   * （固定分 `fixedIndexChars` は丸ごと `index` 側）。
   */
  byTier: { digest: number; index: number };
  /**
   * 返ると見積もった Memory の件数（`min(limit, memoryCountInScope) + associationCount`。
   * 後者は構造上の上限で切り詰め済み）。
   */
  returnedMemories: number;
  /** 連想枠によって本体へ昇格したと見積もった件数（切り詰め後）。 */
  associationCount: number;
  /** 目次帯に載ると見積もった件数。 */
  bandEntries: number;
  /** 件数上限（`limit`）で切られているか。切られていれば、会話が伸びても digest tier は増えない。 */
  memoriesCappedByLimit: boolean;
  /** 目次帯が文字数上限（`DIGEST_BAND_MAX_CHARS`）に当たっているか。当たっていれば **以後 mnemora は伸びない。** */
  bandSaturated: boolean;
  /**
   * 較正した標本の範囲の外へ外挿しているか。
   * `origin.kind` が `'builtin_default'` のときは常に `true`（一度も較正していないため）。
   */
  extrapolated: boolean;
  /** 使ったプロファイルの出所。 */
  profileOrigin: FootprintProfileOrigin;
}

/** 目次帯1件あたりの JSON 上の費用（器 + 切り詰め後の digest）。 */
function bandEntryChars(charsPerDigest: number): number {
  return (
    DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS +
    DIGEST_BAND_ENTRY_SEPARATOR_CHARS +
    Math.min(charsPerDigest, DIGEST_BAND_MAX_ENTRY_CHARS)
  );
}

/**
 * 非負整数 `n` を10進表記したときの桁数が、1桁（0〜9）からいくつ増えたか。
 * `Infinity` は "Infinity"（8字）、`NaN` は "NaN"（3字）として数える。
 */
function extraDigitsBeyondOne(n: number): number {
  const normalized = Math.max(0, Math.trunc(n));
  // ADR 0470: `String(1e21)` は `"1e+21"` と指数表記になり桁数を誤る。1e21 以上の有限の値は `BigInt` で
  // 10進に直す（非有限の値は `BigInt` が投げるので `String` で数える）。
  const text =
    Number.isFinite(normalized) && normalized >= 1e21
      ? BigInt(normalized).toString()
      : String(normalized);
  return Math.max(0, text.length - 1);
}

/** `,"limitedBy":"entry_limit"` を `digestBandCoverage` に足したときの追加バイト数（実測。`"char_budget"` も同じ11字）。 */
const LIMITED_BY_LABEL_ADDED_CHARS = 26;

/**
 * 構造項(a)〜(d)の内訳。`estimateRecallFootprint`（足す側）と `calibrateRecallFootprint`（差し引く側）の
 * 両方から呼ばれる唯一の実装。2箇所に同じ計算を書くとどちらかが古いまま残り、静かにずれる
 * （ADR 0306 の二重計上はそれで起きた）。
 *
 * @param inScope `memoryCountInScope`（推定側）/ `totalInScope`（較正側）。
 * @param returnedMemories 本体へ返った（見積もり上を含む）件数。
 * @param bandEntries 目次帯に載る（見積もり上を含む）件数。`bandLimit` ではなくこの値自体を渡す。
 * @param charsPerDigest 帯1件あたりの費用の計算に使う。`bandEntries === 0` のときは結果に影響しない。
 */
function indexBandStructuralTerms(
  inScope: number,
  returnedMemories: number,
  bandEntries: number,
  charsPerDigest: number,
): {
  bandChars: number;
  totalInScopeDigitCarry: number;
  bandCoverageDigitCarry: number;
  limitedByChars: number;
  bandSaturated: boolean;
} {
  const bandEligible = Math.max(0, inScope - returnedMemories);

  const perEntry = bandEntryChars(charsPerDigest);
  const uncappedBandChars = bandEntries * perEntry;
  const bandSaturated = uncappedBandChars >= DIGEST_BAND_MAX_CHARS;
  // 構造項(a): 配列の要素区切りは n 件で n-1 個だが、`bandEntryChars` は n 個分計上するので、
  // 帯が非空なら1字数えすぎる。飽和している領域では既存の近似が先に効くので手を出さない。
  const commaOvercount = !bandSaturated && bandEntries >= 1 ? DIGEST_BAND_ENTRY_SEPARATOR_CHARS : 0;
  const bandChars = Math.min(uncappedBandChars, DIGEST_BAND_MAX_CHARS) - commaOvercount;

  // 構造項(b)/(c): totalInScope・(単一groupを仮定した)groups[0].count・digestBandCoverage.shown/eligible の桁上がり。
  const totalInScopeDigitCarry = 2 * extraDigitsBeyondOne(inScope);
  const bandCoverageDigitCarry =
    extraDigitsBeyondOne(bandEntries) + extraDigitsBeyondOne(bandEligible);

  // 構造項(d): 打ち切りが起きたとき（かつ飽和していないとき）だけ digestBandCoverage.limitedBy が足される。
  const limitedByChars =
    !bandSaturated && bandEligible > bandEntries ? LIMITED_BY_LABEL_ADDED_CHARS : 0;

  return {
    bandChars,
    totalInScopeDigitCarry,
    bandCoverageDigitCarry,
    limitedByChars,
    bandSaturated,
  };
}

/**
 * `recall()` が積むであろう文字数を見積もる。LLM を呼ばない。DB も引かない。
 *
 * ```
 * 素の返る件数 = min(limit, memoryCountInScope)
 * 連想の件数   = min(associationCount, memoryCountInScope - 素の返る件数)
 * 返る件数     = 素の返る件数 + 連想の件数
 * 帯の資格件数 = memoryCountInScope - 返る件数
 * 帯の件数     = min(digestBandLimit, 帯の資格件数)
 * 帯の費用(素) = min(帯の件数 × (DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS + DIGEST_BAND_ENTRY_SEPARATOR_CHARS
 *                              + min(charsPerDigest, DIGEST_BAND_MAX_ENTRY_CHARS)), DIGEST_BAND_MAX_CHARS)
 * 帯の費用     = 帯の費用(素) + (帯の件数 >= 1 ? -1 : 0)                 … 構造項(a)
 * 桁上がり     = 2×extraDigits(memoryCountInScope)                     … 構造項(b)
 *             + extraDigits(帯の件数) + extraDigits(帯の資格件数)        … 構造項(c)
 * limitedBy分 = (帯の資格件数 > 帯の件数 かつ 帯が文字数で飽和していない) ? LIMITED_BY_LABEL_ADDED_CHARS : 0  … 構造項(d)
 * 合計         = fixedIndexChars + 返る件数 × charsPerDigest + 帯の費用 + 桁上がり + limitedBy分
 * ```
 *
 * 構造項は、`fixedIndexChars` が較正された形（帯が空・`totalInScope`/`shown`/`eligible` が1桁）から外れたときの
 * `JSON.stringify` のずれを、係数の再較正ではなく JSON の構文から決まる項として加算する（ADR 0302）。
 * - (a) カンマ: 要素区切りは n 件で n-1 個。
 * - (b)/(c) 桁上がり: `totalInScope` は単一 group の想定で `groups[0].count` にも現れる。group が複数ある
 *   場合はこの想定が崩れる（`RecallFootprintShape` は group の内訳を持たない）。
 * - (d) limitedBy: 帯が打ち切られたときだけ `digestBandCoverage.limitedBy` が足される。
 *   `bandSaturated` のときは足さない（`帯の件数` が実際の `packDigestBand` の結果と乖離する既存の近似が
 *   先に効き、`limitedBy` の値も件数だけからは決まらないため）。
 *
 * 連想の項に新しい自由係数は足さない（ADR 0166）。連想で昇格した候補は目次帯の対象から外れるので、
 * `returnedMemories` が増え `bandEligible` が減る既存の2項だけで表せる。
 *
 * **入力が NaN のとき**（`shape` の `memoryCountInScope`・`limit`・`digestBandLimit`・`associationCount`）、
 * `chars` と、NaN から計算した欄（`returnedMemories`・`bandEntries`・`byTier`）は NaN のまま返る（ADR 0470）。
 * 「見積もれなかった」を表す欄は無く、`chars` が NaN であることで見分ける。
 * `compareWithFullLog` はこれを受けて結論を出さない（`too_close_to_call`・`estimatedShare: NaN`、ADR 0467）。
 */
export function estimateRecallFootprint(
  shape: RecallFootprintShape,
  profile: RecallFootprintProfile = BUILTIN_RECALL_FOOTPRINT_PROFILE,
): RecallFootprintEstimate {
  const inScope = Math.max(0, shape.memoryCountInScope);
  const limit = shape.limit ?? DEFAULT_RECALL_LIMIT;
  const bandLimit = shape.digestBandLimit ?? DEFAULT_DIGEST_BAND_LIMIT;

  const baseReturnedMemories = Math.min(limit, inScope);
  const requestedAssociationCount = Math.max(0, shape.associationCount ?? 0);
  // 構造上の上限: limit の外に居る候補の総数を超えては昇格できない。
  const associationCount = Math.min(
    requestedAssociationCount,
    Math.max(0, inScope - baseReturnedMemories),
  );
  const returnedMemories = baseReturnedMemories + associationCount;
  const bandEligible = Math.max(0, inScope - returnedMemories);
  const bandEntries = Math.min(bandLimit, bandEligible);

  // 構造項(a)〜(d)。`calibrateRecallFootprint` と共有する唯一の実装（ADR 0306）。
  const {
    bandChars,
    totalInScopeDigitCarry,
    bandCoverageDigitCarry,
    limitedByChars,
    bandSaturated,
  } = indexBandStructuralTerms(inScope, returnedMemories, bandEntries, profile.charsPerDigest);

  const digestChars = returnedMemories * profile.charsPerDigest;
  const indexChars =
    profile.fixedIndexChars +
    bandChars +
    totalInScopeDigitCarry +
    bandCoverageDigitCarry +
    limitedByChars;

  const extrapolated =
    profile.origin.kind === "builtin_default" ||
    inScope < profile.origin.observedMemoryCount.min ||
    inScope > profile.origin.observedMemoryCount.max;

  return {
    chars: digestChars + indexChars,
    byTier: { digest: digestChars, index: indexChars },
    returnedMemories,
    associationCount,
    bandEntries,
    memoriesCappedByLimit: inScope > limit,
    bandSaturated,
    extrapolated,
    profileOrigin: profile.origin,
  };
}

/**
 * 判定の結論。真偽値にしていない。`'too_close_to_call'` は誤差の幅の中に居てどちらとも言えない状態で、
 * `'full_log_smaller'` へ丸めると、判断できていないことと判断した結果が同じ顔になる。
 */
export type FullLogVerdict = "mnemora_smaller" | "full_log_smaller" | "too_close_to_call";

/** 判定の理由。コードで分岐できる形にする（文字列の注記にしない）。 */
export type FootprintReason =
  /**
   * 見積もった量のうち、どの項がいちばん大きいか。**この札は必ず立つ**（`reasons` を空にしない）。
   * 他の札と違って警告ではなく、「何が効いているか」を名指しするだけ。
   */
  | {
      code: "dominant_term";
      term: "memories" | "digest_band" | "fixed_index";
      chars: number;
      /** その項が見積もり総量に占める割合。 */
      shareOfEstimate: number;
    }
  /** mnemora の固定費（目次帯の器など）だけで会話ログ全部を超えている ＝ 会話が短すぎる。 */
  | { code: "full_log_below_fixed_cost"; fixedIndexChars: number; fullLogChars: number }
  /** 目次帯が上限に当たっている ＝ **会話がこれ以上伸びても mnemora は増えない。** */
  | { code: "band_saturated"; bandChars: number }
  /** 件数上限で切られている ＝ 会話が伸びても digest tier は増えない。 */
  | { code: "memories_capped_by_limit"; limit: number; memoryCountInScope: number }
  /** 差が許容誤差の内側にある ＝ **どちらとも言えない。** */
  | { code: "within_tolerance"; tolerance: number; estimatedShare: number }
  /** ⚠ 一度も較正していない既定プロファイルで見積もった。 */
  | { code: "profile_not_calibrated" }
  /** ⚠ 較正した標本の範囲の外へ外挿している。 */
  | { code: "outside_calibrated_range"; observed: { min: number; max: number }; asked: number }
  /** ⚠ 較正はしたが、決められなかった係数があり既定値のままである。 */
  | { code: "coefficients_borrowed"; borrowed: readonly FootprintCoefficientName[] };

/** {@link compareWithFullLog} の入力。 */
export interface FullLogComparisonInput {
  /** 会話ログを全部積んだときの文字数。呼び出し側が実測して渡す（`packages/core` は会話ログを持たない）。 */
  fullLogChars: number;
  /** 見積もる recall の形（スコープ内の件数など。{@link RecallFootprintShape}）。 */
  shape: RecallFootprintShape;
  /** 見積もりの係数。省略すると同梱の既定プロファイル。 */
  profile?: RecallFootprintProfile | undefined;
  /** `'too_close_to_call'` を返す幅。既定は `DEFAULT_FOOTPRINT_TOLERANCE`。 */
  tolerance?: number | undefined;
}

/** {@link compareWithFullLog} の結果。 */
export interface FullLogComparison {
  /** どちらが小さいか（`mnemora_smaller`・`full_log_smaller`・`too_close_to_call`）。 */
  verdict: FullLogVerdict;
  /**
   * 見積もった `mnemora / 会話ログ全部`。
   *
   * `fullLogChars` が 0 以下（負は 0 に丸められる）のときは `Infinity`（`verdict` は `"full_log_smaller"`）、
   * 入力が NaN で見積もりが数にならないときは `NaN`（`verdict` は `"too_close_to_call"`）。
   */
  estimatedShare: number;
  /**
   * 会話ログ全部が何文字を超えたら mnemora のほうが小さくなるか。mnemora 側の量は会話ログの長さに
   * 依らないので、交点は見積もった mnemora の文字数そのもの。ただし `memoryCountInScope` が
   * 増えれば動くので、「いまの件数のままなら」という条件付き。
   */
  breakEvenFullLogChars: number;
  /** 根拠。**空にならない**（`dominant_term` が必ず1枚立つ。`FootprintReason` の doc）。 */
  reasons: readonly FootprintReason[];
  /** 見積もりそのもの。 */
  estimate: RecallFootprintEstimate;
}

/**
 * mnemora を使うべきか、会話ログを全部積むべきかを判定する。
 *
 * **量だけを見ている。** 「削っても目的の記憶が落ちていないか」は答えない。量で負けていても
 * 想起のために mnemora を使う判断はありうるので、その材料として量を出す。
 *
 * **入力が NaN で見積もりが数にならないとき**（`shape` の `memoryCountInScope`・`limit`・`digestBandLimit`・
 * `associationCount`、または `fullLogChars` が NaN）は、`verdict` は `"too_close_to_call"`、`estimatedShare` は
 * `NaN`、`reasons` に `within_tolerance` は無い（ADR 0467）。この状態を名乗る `reasons` の code は無いので、
 * `estimatedShare` が NaN であることで見分けること。
 * `shape` の負・小数の値は検査しない（そのまま計算に入る）。`tolerance` が NaN のときは `too_close_to_call` に
 * ならない。
 */
export function compareWithFullLog(input: FullLogComparisonInput): FullLogComparison {
  const profile = input.profile ?? BUILTIN_RECALL_FOOTPRINT_PROFILE;
  const tolerance = input.tolerance ?? DEFAULT_FOOTPRINT_TOLERANCE;
  const estimate = estimateRecallFootprint(input.shape, profile);
  const fullLogChars = Math.max(0, input.fullLogChars);

  const reasons: FootprintReason[] = [];

  const bandChars = estimate.byTier.index - profile.fixedIndexChars;
  const terms = [
    { term: "memories" as const, chars: estimate.byTier.digest },
    { term: "digest_band" as const, chars: bandChars },
    { term: "fixed_index" as const, chars: profile.fixedIndexChars },
  ];
  // 同点のときは上の並び順で先に来たものを採る（決定的にするため）。
  const dominant = terms.reduce((best, t) => (t.chars > best.chars ? t : best));
  reasons.push({
    code: "dominant_term",
    term: dominant.term,
    chars: dominant.chars,
    shareOfEstimate: estimate.chars > 0 ? dominant.chars / estimate.chars : 0,
  });

  if (profile.origin.kind === "builtin_default") {
    reasons.push({ code: "profile_not_calibrated" });
  } else {
    if (profile.origin.borrowedFromDefault.length > 0) {
      reasons.push({
        code: "coefficients_borrowed",
        borrowed: profile.origin.borrowedFromDefault,
      });
    }
    if (estimate.extrapolated) {
      reasons.push({
        code: "outside_calibrated_range",
        observed: profile.origin.observedMemoryCount,
        asked: input.shape.memoryCountInScope,
      });
    }
  }

  if (estimate.bandSaturated) {
    reasons.push({ code: "band_saturated", bandChars: DIGEST_BAND_MAX_CHARS });
  }
  if (estimate.memoriesCappedByLimit) {
    reasons.push({
      code: "memories_capped_by_limit",
      limit: input.shape.limit ?? DEFAULT_RECALL_LIMIT,
      memoryCountInScope: input.shape.memoryCountInScope,
    });
  }
  if (fullLogChars < profile.fixedIndexChars) {
    reasons.push({
      code: "full_log_below_fixed_cost",
      fixedIndexChars: profile.fixedIndexChars,
      fullLogChars,
    });
  }

  // `fullLogChars === 0` は比が定義できない。0除算の結果（Infinity / NaN）を結論の顔で返さない。
  // ADR 0467: 入力が NaN で見積もりか会話ログの量が数にならないときも、比較がすべて偽になって
  // `full_log_smaller` へ落ちる代わりに `estimatedShare` を NaN にして `too_close_to_call` で返す。
  // `within_tolerance` の札は立てない。この状態を名乗る札の code は足さない（公開の型が変わる）。
  const undecidable = Number.isNaN(fullLogChars) || !Number.isFinite(estimate.chars);
  const estimatedShare = undecidable
    ? Number.NaN
    : fullLogChars > 0
      ? estimate.chars / fullLogChars
      : Number.POSITIVE_INFINITY;

  let verdict: FullLogVerdict;
  if (undecidable) {
    verdict = "too_close_to_call";
  } else if (Math.abs(estimatedShare - 1) <= tolerance) {
    verdict = "too_close_to_call";
    reasons.push({ code: "within_tolerance", tolerance, estimatedShare });
  } else if (estimatedShare < 1) {
    verdict = "mnemora_smaller";
  } else {
    verdict = "full_log_smaller";
  }

  return {
    verdict,
    estimatedShare,
    breakEvenFullLogChars: estimate.chars,
    reasons,
    estimate,
  };
}
