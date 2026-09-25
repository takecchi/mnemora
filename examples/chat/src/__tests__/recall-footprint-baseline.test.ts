import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_RECALL_FOOTPRINT_PROFILE,
  DEFAULT_RECALL_LIMIT,
  calibrateRecallFootprint,
  compareWithFullLog,
  estimateRecallFootprint,
  type RecallFootprintSample,
} from "@mnemora/core";

/**
 * Issue #276 の `recall-footprint.ts` を、`examples/chat/compare-baseline.json`
 * （CI の `example-chat` ジョブが実測し repo に commit した12点。ADR 0133 により⭐門）に
 * 対して検算する歯。**DB も API キーも要らない**——読むのは commit 済みの JSON だけである。
 *
 * ⚠ `compare-baseline.json` はこの歯の対象そのものであり、**書き換えない**（CIの門）。
 *
 * ## この歯がやっていること
 *
 * `BUILTIN_RECALL_FOOTPRINT_PROFILE` は「`compare-baseline.json` の hold-in 7行
 * （帯が空、`bandEntryCount === 0`）と、`recall-footprint-calibration-samples-baseline.json`
 * の8行（同じく帯が空、`limit=20` で明示的に拡張した標本）を合わせた15点だけを使った
 * 最小二乗」だと自称している（`recall-footprint.ts` の該当コメント、Issue #340
 * フォローアップ・ADR 0306/0310）。この歯は、**その主張を実際に自分で計算し直して検算する**
 * ——同梱の既定プロファイルを信用せず、`calibrateRecallFootprint` を実際に呼ぶ。
 *
 * ## ⭐ hold-in/hold-out の分け方: `bandEntryCount === 0`（Issue #340 フォローアップ、ADR 0314）
 *
 * 旧い分け方 `totalInScope <= DEFAULT_RECALL_LIMIT` は、「目次帯が空である」ことの
 * **代理指標**だった——`queryRecall`（`mnemora-path.ts`）が `limit` を明示的に渡さず、
 * 既定 `DEFAULT_RECALL_LIMIT` のまま呼ぶ限り両者は常に一致する。ADR 0314 §2 が指摘した
 * とおり、`limit` を明示的に上げる呼び出し（`recall-footprint-calibration-samples.ts`）が
 * 増えると、この一致は構造的に崩れる（`totalInScope=14` でも `limit=20` なら帯は空）。
 * ⟹ 代理指標ではなく、帯が実際に空かどうか（`RecallResult.index.digestBand?.length ?? 0
 * === 0`、`compare.ts` の `ComparisonRow.bandEntryCount`）そのもので分ける。
 *
 * `examples/chat/compare-baseline.json` は CI artifact から実測更新され、`bandEntryCount`
 * を持つ（Issue #340 フォローアップ）。⟹ `bandEntryCountOrThrow`（下）が例外を投げることは
 * もう無い——欄が無いときに黙って旧条件へフォールバックしない、という設計はそのまま残す
 * （将来また欄が失われたときに、黙って緑に倒れないようにするため）。
 *
 * ## ⭐ 較正標本を15点に拡張する（Issue #340 フォローアップ、ADR 0306/0310）
 *
 * hold-in 7行（`compare-baseline.json`）だけでは、目次帯が空のまま返る最大件数が
 * `totalInScope=8`（22ターン行）に留まり、hold-out の82ターン行（`totalInScope=25`）まで
 * 内挿で届かない。`recall-footprint-calibration-samples-baseline.json`
 * （`RecallQuery.limit=20` を明示して帯を空に保った8点、CI artifact から実測、ADR 0314）を
 * 較正標本へ足し、7+8=15点で較正する。標本には `totalInScope` を渡す
 * （`calibrateRecallFootprint` が `indexBandStructuralTerms` で構造項を差し引いてから
 * 最小二乗にかける、ADR 0306）——8点のうち7点は `totalInScope` が2桁（10〜19）であり、
 * これを渡さないと桁上がり分が係数へ誤って吸い込まれる。
 */

interface BaselineRow {
  turnCount: number;
  totalInScope: number;
  naiveChars: number;
  mnemoraChars: number;
  mnemoraShareOfNaiveChars: number;
  returnedCount: number;
  /** `ComparisonRow.bandEntryCount` — Issue #340 フォローアップ、ADR 0314。 */
  bandEntryCount: number;
}

interface BaselineFile {
  rowCount: number;
  rows: BaselineRow[];
}

// examples/chat/src/__tests__/ から見て examples/chat/compare-baseline.json は2つ上。
const baselinePath = fileURLToPath(new URL("../../compare-baseline.json", import.meta.url));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineFile;
const rows = baseline.rows;

/**
 * `recall-footprint-calibration-samples-baseline.json` の8点（Issue #340 フォローアップ、
 * ADR 0314）。CI artifact から実測更新した、目次帯が空のまま件数が10〜19件の較正標本。
 * hold-in 7行（`compare-baseline.json`）とあわせて15点の較正標本になる（上のファイル
 * 冒頭 docstring 参照）。
 */
interface CalibrationSampleBaselineRow {
  fillerPairs: number;
  recallLimit: number;
  turnCount: number;
  totalInScope: number;
  returnedCount: number;
  mnemoraChars: number;
  bandEntryCount: number;
}

interface CalibrationSampleBaselineFile {
  rowCount: number;
  rows: CalibrationSampleBaselineRow[];
}

const calibrationSamplesPath = fileURLToPath(
  new URL("../../recall-footprint-calibration-samples-baseline.json", import.meta.url),
);
const calibrationSamplesFile = JSON.parse(
  readFileSync(calibrationSamplesPath, "utf8"),
) as CalibrationSampleBaselineFile;
const calibrationSampleRows = calibrationSamplesFile.rows;

/**
 * ADR 0166: `queryRecall`（`mnemora-path.ts`）は連想枠を既定で使う（ADR 0168、`maxCount=10`）。
 * ⟹ `row.returnedCount` は「素の返る件数（`min(DEFAULT_RECALL_LIMIT, totalInScope)`）」
 * だけでなく、**連想枠が本体へ昇格させた件数**も含む。
 *
 * `estimateRecallFootprint` はこの昇格件数を `associationCount` として受け取る
 * （`packages/core` は `maxCount` から実際の昇格件数を知りようがないため、呼び出し側=この歯が
 * 実測から渡す。`recall-footprint.ts` の `RecallFootprintShape.associationCount` の doc）。
 * **`row.returnedCount` は既に実測値**なので、ここから逆算するのは
 * 「推定」ではなく「実測を較正の入力に変換しているだけ」である。
 */
function associationCountForRow(row: BaselineRow): number {
  const baseReturned = Math.min(DEFAULT_RECALL_LIMIT, row.totalInScope);
  return Math.max(0, row.returnedCount - baseReturned);
}

/**
 * ⚠ **なぜ 2.5% か**（実測ぎりぎりに置かない理由）。
 *
 * このファイルが実際に検算した値では、12行全体の最大誤差は **2ターン行
 * （`totalInScope=2`）の 1.56%**、較正に使っていない5行（hold-out）側の最大は
 * **82ターン行（`totalInScope=25`）の 1.28%** だった。
 *
 * 閾値をこの実測値（1.56%）ぎりぎりに置くと、浮動小数点の丸め方の違いや
 * 将来の軽微な変更だけで揺れて赤くなりうる——この歯が守りたいのは
 * 「mnemora は頭打ちになる」という主張が実測に対して成立することであって、
 * 「いま測った小数第3位までを固定する」ことではない。2.5% は実測(1.56%)に
 * 約6割の余裕を載せた値である。
 *
 * ### ⚠ 2026-09-17 訂正（Issue #410 / main=4b92134c45b2377b9f5bb501ef921ab3e8b9cee3）:
 * 上の3つの数字（1.56% / 1.28% / 「約6割」）は、**いまの `compare-baseline.json` に対しては
 * 成立しない。**古い記述を消すのではなく、当時の値といまの値を書き分ける
 * （ADR 0166「2026-09-17 訂正」節と同じ作法）。
 *
 * **上の1.56%/1.28%は、`queryRecall` が連想枠（ADR 0151/0168）をまだ使っていなかった
 * 時点——全 hold-out 行の `associationCount = 0` だった時点——の実測である**
 * （Issue #340 が当時の `compare-baseline.json` を `git show` で取り出し、現行の較正
 * ロジックで検算して確認済み）。ADR 0166 が連想枠の項を推定器に足したあとも、
 * **このdocstringの数字だけは更新されないまま残っていた。**
 *
 * **【実測】2026-09-17、`main = 4b92134` の時点**（このファイル・`compare-baseline.json`
 * とも1行も変えず、この歯が呼ぶのと同じ `calibrateRecallFootprint` /
 * `estimateRecallFootprint` を `node` で直接呼んで検算した。歯自体も3回実行し
 * 3回とも緑・23 tests）:
 *
 * | | 当時（連想枠なし、hold-out全行 associationCount=0） | いま（2026-09-17、main=4b92134） |
 * |---|---|---|
 * | 12行全体の最大誤差 | 1.56%（2ターン行） | **2.068%（322ターン行、hold-out）** |
 * | hold-out 5行の最大誤差 | 1.28%（82ターン行） | **2.068%（322ターン行）**（同じ行が両方を兼ねる） |
 * | 2.5%に対する余裕（百分率） | 実測(1.56%)に対し約6割 | **(2.5−2.068)/2.5 ≒ 17%** |
 *
 * 🔴 **百分率だけで見ると「まだ17%の余裕がある」ように読めるが、字数で見ると別の
 * 姿になる。**322行の推定は4452.96字であり、これを許容誤差2.5%で割り戻した上限
 * `4452.96 / (1 − 0.025) = 4567.14` 字を実測（`4547`字）が超えた時点で赤くなる。
 * ⟹ **余白は 20.14字（0.44%）しかない。**
 *
 * さらに——**「誤差の百分率が最大の行」と「字数の余白が最も狭い行」は一致しない。**
 * hold-out 5行を字数の余白で計算し直すと、いちばん狭いのは322行(20.14字)ではなく
 * **42ターン行（`totalInScope=14`）の上側で、余白は 11.15字**しかない（42行は誤差の
 * 百分率では0.635%しかなく一見余裕があるが、`mnemoraChars` の絶対値が583字と小さい
 * ため、同じ2.5%という相対許容が字数に直すと狭くなる）。この字数の余白を実際に
 * 見える形にしたのが下の「字数で見た誤差の余白」の `it`（Issue #410 対処候補3、
 * ADR 0201）である。
 *
 * ⚠ **許容誤差 `0.025` はこの訂正でも動かしていない**——#340・#410・ADR 0166 が
 * いずれも「通すために緩める」形を名指しで却下している。
 *
 * ### ⚠ 2026-09-25 追記（Issue #340 フォローアップ / main=5a3d343605751ae262e5f1ba4ebb4aac763f6196）:
 *
 * 上の「2026-09-17 訂正」節の数字（2.068% / 2.068% / 17%）も、いまの `compare-baseline.json`
 * と較正ロジックに対しては成立しない。**`compare-baseline.json` の12行の実測値
 * （`mnemoraChars`等）自体はこの間1バイトも動いていない**（PR #728 の diff で確認——
 * 動いたのは `bandEntryCount`/`rawIndexJsonLength` 欄の新設だけ）。動いたのは推定器と
 * 較正標本のほうである: PR #710（ADR 0302、`estimateRecallFootprint` に indexBand の実
 * JSON構造から決まる構造項を足した）→ PR #722（ADR 0306、`calibrateRecallFootprint` が
 * 較正前にその構造項を差し引くようにした）→ PR #728（ADR 0314、較正標本を hold-in 7点
 * から15点へ拡張し、hold-in/hold-out の分け方を `bandEntryCount === 0` へ移した）。
 * 古い文・09-17 訂正の文はどちらも消さず、当時・09-17・いまの3列で書き分ける。
 *
 * **【実測】2026-09-25、`main = 5a3d343605751ae262e5f1ba4ebb4aac763f6196` の時点**
 * （このファイル・`compare-baseline.json` とも1行も変えず、この歯が呼ぶのと同じ
 * `calibrateRecallFootprint` / `estimateRecallFootprint` を `tsx` で直接呼んで検算した。
 * 歯自体も実行し緑・40 tests）:
 *
 * | | 当時（連想枠なし） | 09-17（main=4b92134） | いま（2026-09-25、main=5a3d343） |
 * |---|---|---|---|
 * | 12行全体の最大誤差 | 1.56%（2ターン行） | 2.068%（322ターン行、hold-out） | **2.023%（2ターン行、hold-in）** |
 * | hold-out 5行の最大誤差 | 1.28%（82ターン行） | 2.068%（322ターン行、同じ行が両方を兼ねる） | **1.122%（322ターン行）** |
 * | 2.5%に対する余裕（12行全体基準） | 実測(1.56%)に対し約6割 | (2.5−2.068)/2.5 ≒ 17% | **(2.5−2.023)/2.5 ≒ 19%** |
 * | 2.5%に対する余裕（hold-out基準） | — （測っていない） | 17%（上と同じ行） | **(2.5−1.122)/2.5 ≒ 55%** |
 * | 字数の余白の最小（hold-out、ADR 0201の歯） | — （まだ無い） | 42行(totalInScope=14)・**上側**・11.15字 | **42行(totalInScope=14)・下側・9.387字** |
 * | FLOOR（`charsPerDigest/2`） | — | 7.729字 | **8.088字** |
 * | 係数（`charsPerDigest` / `fixedIndexChars`） | — | 15.458 / 170.881 | **16.175 / 168.503** |
 *
 * 🔴 **設計意図の「約6割」に戻ったかどうかは、12行全体と hold-out で答えが分かれる。**
 * 12行全体の余裕は19%——09-17（17%）よりわずかに戻ったが、「約6割」にはまだ遠い。
 * ただし12行全体の最大をいま持っているのは hold-in（較正に使った側）の2ターン行であり、
 * hold-out（較正に使っていない側）だけで見ると余裕は55%まで戻っている——「約6割」に近い。
 * ⟹ **どちら側で言うかで答えが変わる。**このIssueが元々問題にしていた「322ターン行の
 * 余裕の乏しさ」自体は解消した（1.28%→1.122%、322行はhold-outの最大でありつつ12行全体
 * の最大ではなくなった）が、いまの12行全体の最大は別の行（2ターン行、hold-in）が持って
 * おり、これは09-17時点までは無かった構図である。
 *
 * ⟹ **字数の余白（ADR 0201の歯、hold-out限定）も縮む方向で動いた。**FLOORとの差は
 * `9.387 − 8.088 = 1.299` 字（09-17時点の `11.15 − 7.729 = 3.421` 字より狭い）。歯は
 * 緑のままだが、余裕が縮んだことは字数で見ても変わらない——最小余白の行も42行のままだが、
 * 向き（上側→下側）が変わっている。詳細・過去の消費率との比較は ADR 0201「2026-09-25
 * 測った: 3件目の実測」節、負債の一覧は ADR 0314「引き受けた負債」を見ること。
 *
 * ⚠ **許容誤差 `0.025`・FLOOR（`charsPerDigest/2`という式そのもの）・
 * `compare-baseline.json`・較正標本の設計・hold-in/hold-out の分け方は、この追記の
 * どれも動かしていない。**動いたのは推定器（PR #710/#722）と較正標本・BUILTINプロファイル
 * （PR #728）であり、この追記はその結果をこの docstring の主張に対して検算し、
 * 書き留めただけである。
 */
const ACCURACY_TOLERANCE = 0.025;

/**
 * `row.bandEntryCount === 0`（目次帯が空、という一次指標そのもの）を返す。
 *
 * ⛔ **欄が無い（型として不正な）行が混じっていたら、黙って `0` や旧条件へフォールバック
 * しない**——名指しのエラーで失敗する。`compare-baseline.json` は CI artifact 経由で
 * `bandEntryCount` を持つように更新済みだが、この検査は残す（将来また欄が失われたときに
 * 黙って緑に倒れないようにするため）。
 */
function bandEntryCountOrThrow(row: BaselineRow): number {
  if (typeof row.bandEntryCount !== "number") {
    throw new Error(
      `compare-baseline.json の turnCount=${row.turnCount} 行に bandEntryCount が無い。` +
        "hold-in/hold-out の分け方は bandEntryCount === 0 である(Issue #340 フォローアップ・" +
        "ADR 0314)。基準値が壊れている可能性があるので、CI artifact から作り直すこと" +
        "(examples/chat/README.md『基準値を更新する手順』)。",
    );
  }
  return row.bandEntryCount;
}

const holdInRows = rows.filter((r) => bandEntryCountOrThrow(r) === 0);
const holdOutRows = rows.filter((r) => bandEntryCountOrThrow(r) !== 0);

/**
 * ⭐ 較正に実際に使う標本(15点 = hold-in 7行 + 較正標本8点、Issue #340 フォローアップ、
 * ADR 0306/0310)。**`totalInScope` を渡す**——`calibrateRecallFootprint` は
 * `bandEntryCount === 0` の標本について `indexBandStructuralTerms` で構造項を計算し、
 * 最小二乗にかける前に差し引く(ADR 0306)。渡さなければ構造項0として扱われ、較正標本8点の
 * うち7点(`totalInScope` が2桁)で桁上がり分を誤って係数へ吸い込む。
 */
const calibrationSamples: RecallFootprintSample[] = [
  ...holdInRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: 0,
    totalInScope: row.totalInScope,
  })),
  ...calibrationSampleRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: row.bandEntryCount,
    totalInScope: row.totalInScope,
  })),
];

function relativeError(estimatedChars: number, actualChars: number): number {
  return Math.abs(estimatedChars - actualChars) / actualChars;
}

describe("compare-baseline.json — 前提（行数が変わっていないこと）", () => {
  it("12行のうち、目次帯が空の(bandEntryCount === 0)行が7行、そうでない行が5行", () => {
    expect(rows).toHaveLength(12);
    expect(holdInRows).toHaveLength(7);
    expect(holdOutRows).toHaveLength(5);
  });
});

/**
 * ⭐ Issue #340 フォローアップ(ADR 0314)が明示的に要求した歯:
 * 「既存の12行について、旧い条件（`totalInScope <= DEFAULT_RECALL_LIMIT`）と
 * 新しい条件（`bandEntryCount === 0`）の分け方が1行も違わない」ことを検算する。
 *
 * ⚠ `holdInRows`/`holdOutRows`（上）は既に新条件で計算されている——`bandEntryCount`
 * が無ければこのファイル自体が module 読み込み時点で例外を投げるため、この
 * describe に実際に到達するのは、基準値が更新された後だけである。
 */
describe("hold-in/hold-out の分け方の移行 — bandEntryCount === 0 と旧条件(totalInScope <= DEFAULT_RECALL_LIMIT)が1行も違わない（Issue #340 フォローアップ、ADR 0314）", () => {
  it.each(rows)(
    "turnCount=$turnCount: bandEntryCount===0 と totalInScope<=DEFAULT_RECALL_LIMIT の判定が一致する",
    (row) => {
      expect(bandEntryCountOrThrow(row) === 0).toBe(row.totalInScope <= DEFAULT_RECALL_LIMIT);
    },
  );
});

/**
 * ⚠ **回帰の確認**: 7点だけ(`compare-baseline.json` の hold-in のみ、較正標本8点を
 * 足さない)で較正すると、拡張前の値(`charsPerDigest≒15.458` / `fixedIndexChars≒170.881`)
 * に一致し続けること。拡張後の較正(下のメインの `describe`)がこの値を上書きした
 * わけではないことを確認する回帰の歯——ADR 0306 の「hold-in 7行では構造項が常に0」
 * という主張の検算でもある(`totalInScope` を渡しても渡さなくても同じ、という歯は
 * 下に別途ある)。
 */
describe("calibrateRecallFootprint — 7点だけ(拡張前)の較正は変更前の値に一致し続ける", () => {
  const samples: RecallFootprintSample[] = holdInRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: 0,
  }));
  const calibrated = calibrateRecallFootprint(samples);

  it("borrowedFromDefault が空(7行に memoryCount の広がりがあるため両係数とも決まる)、sampleCount=7", () => {
    if (calibrated.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(calibrated.origin.borrowedFromDefault).toEqual([]);
    expect(calibrated.origin.sampleCount).toBe(7);
  });

  it("較正した係数が変更前の値(charsPerDigest≒15.458 / fixedIndexChars≒170.881)に一致する", () => {
    expect(calibrated.charsPerDigest).toBeCloseTo(15.458, 2);
    expect(calibrated.fixedIndexChars).toBeCloseTo(170.881, 2);
  });
});

describe("calibrateRecallFootprint — hold-in 15行(7+8)での較正", () => {
  const calibrated = calibrateRecallFootprint(calibrationSamples);

  it("borrowedFromDefault が空(15行に memoryCount の広がりがあるため両係数とも決まる)、sampleCount=15", () => {
    if (calibrated.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(calibrated.origin.borrowedFromDefault).toEqual([]);
    expect(calibrated.origin.sampleCount).toBe(15);
  });

  it("較正した係数が BUILTIN_RECALL_FOOTPRINT_PROFILE の新しい値(charsPerDigest≒16.175 / fixedIndexChars≒168.503)に一致する", () => {
    expect(calibrated.charsPerDigest).toBeCloseTo(
      BUILTIN_RECALL_FOOTPRINT_PROFILE.charsPerDigest,
      2,
    );
    expect(calibrated.fixedIndexChars).toBeCloseTo(
      BUILTIN_RECALL_FOOTPRINT_PROFILE.fixedIndexChars,
      2,
    );
  });

  describe("較正済みプロファイルで12行すべての mnemoraChars を予測する", () => {
    it.each(holdOutRows)(
      "hold-out: turnCount=$turnCount (totalInScope=$totalInScope) の誤差が許容誤差以内",
      (row) => {
        const est = estimateRecallFootprint(
          { memoryCountInScope: row.totalInScope, associationCount: associationCountForRow(row) },
          calibrated,
        );
        const err = relativeError(est.chars, row.mnemoraChars);
        expect(err).toBeLessThanOrEqual(ACCURACY_TOLERANCE);
      },
    );

    it("12行全体(較正に使った7行 + hold-outの5行。較正標本自体は7+8=15点)の最大誤差が許容誤差以内", () => {
      const errors = rows.map((row) => {
        const est = estimateRecallFootprint(
          { memoryCountInScope: row.totalInScope, associationCount: associationCountForRow(row) },
          calibrated,
        );
        return relativeError(est.chars, row.mnemoraChars);
      });
      const maxErr = Math.max(...errors);
      expect(maxErr).toBeLessThanOrEqual(ACCURACY_TOLERANCE);
    });
  });

  /**
   * ⚠ **`too_close_to_call` が出る行がありうる。** 実測では:
   * - `totalInScope=4`（10ターン行）: `mnemoraShareOfNaiveChars` ≒ 0.9547（95.5%）。
   *   これは既定許容誤差(5%)の内側に落ち、実際に `too_close_to_call` になる。
   * - `totalInScope=3` のうち `naiveChars=197` の行（8ターン行）: 実測 ≒ 1.0964（109.6%）。
   *   1 には近いが、誤差は約10.3%あり、既定許容誤差(5%)の**外**——`too_close_to_call` には
   *   ならない。
   *
   * `too_close_to_call` は「見積もりが誤差の幅の中に居るのでどちらとも言えない」という
   * 積極的な申告であり、これを「判定を外した」と数えるのは誤り
   * （`recall-footprint.ts` の `FullLogVerdict` の doc）。
   */
  const TOO_CLOSE_TO_CALL_TURN_COUNTS = new Set<number>([10]);

  describe("compareWithFullLog — 12行すべてで判定の向きが実測と一致する(too_close_to_callは除く)", () => {
    it.each(rows)(
      "turnCount=$turnCount (totalInScope=$totalInScope, 実測share=$mnemoraShareOfNaiveChars)",
      (row) => {
        const result = compareWithFullLog({
          fullLogChars: row.naiveChars,
          shape: {
            memoryCountInScope: row.totalInScope,
            associationCount: associationCountForRow(row),
          },
          profile: calibrated,
        });

        if (TOO_CLOSE_TO_CALL_TURN_COUNTS.has(row.turnCount)) {
          expect(result.verdict).toBe("too_close_to_call");
          return;
        }

        const expectedDirection =
          row.mnemoraShareOfNaiveChars < 1 ? "mnemora_smaller" : "full_log_smaller";
        expect(result.verdict).toBe(expectedDirection);
      },
    );

    it("8ターン行(totalInScope=3, naiveChars=197, 実測109.6%)は1に近いが許容誤差の外なので full_log_smaller のまま", () => {
      const row = rows.find((r) => r.turnCount === 8);
      if (!row) throw new Error("baseline row not found: turnCount=8");
      const result = compareWithFullLog({
        fullLogChars: row.naiveChars,
        shape: {
          memoryCountInScope: row.totalInScope,
          associationCount: associationCountForRow(row),
        },
        profile: calibrated,
      });
      expect(result.verdict).toBe("full_log_smaller");
    });
  });
});

describe("BUILTIN_RECALL_FOOTPRINT_PROFILE（既定プロファイル）でも同じ12行を予測する", () => {
  it("既定プロファイルの最大誤差が許容誤差以内であり、hold-in較正(15点)とほぼ同程度に当たる", () => {
    const calibrated = calibrateRecallFootprint(calibrationSamples);

    const maxErrDefault = Math.max(
      ...rows.map((row) => {
        const est = estimateRecallFootprint(
          { memoryCountInScope: row.totalInScope, associationCount: associationCountForRow(row) },
          BUILTIN_RECALL_FOOTPRINT_PROFILE,
        );
        return relativeError(est.chars, row.mnemoraChars);
      }),
    );
    const maxErrCalibrated = Math.max(
      ...rows.map((row) => {
        const est = estimateRecallFootprint(
          { memoryCountInScope: row.totalInScope, associationCount: associationCountForRow(row) },
          calibrated,
        );
        return relativeError(est.chars, row.mnemoraChars);
      }),
    );

    expect(maxErrDefault).toBeLessThanOrEqual(ACCURACY_TOLERANCE);
    // 既定プロファイル自身がこの15点(hold-in 7行 + 較正標本8点)から測ったものである
    // (recall-footprint.ts の BUILTIN_RECALL_FOOTPRINT_PROFILE.origin.measuredFrom を
    // 見よ)以上、この歯がhold-in較正し直した値とほぼ一致するはず。ずれるなら既定
    // プロファイルの係数が古い(誰かが構造定数を変えたのに測り直していない、または
    // 較正標本を増やしたのにBUILTINを更新し忘れた)ということなので、その場合は
    // このテストの失敗をそのまま報告すること。
    expect(Math.abs(maxErrDefault - maxErrCalibrated)).toBeLessThan(0.005);
  });
});

/**
 * Issue #410 対処候補3: 「歯の余白は字数で見るとどれだけ狭いか」を、百分率ではなく
 * 字数で見える形にする。
 *
 * ⚠ **対象は hold-out 5行だけであり、較正標本(hold-in 7行 + 較正標本8点=15点)は
 * 含めない。**理由は自己参照——較正標本の各行は `calibrateRecallFootprint` の
 * 入力そのものである（上の `calibrationSamples` が `row.mnemoraChars` を直接使う）。
 * ある較正標本の実測が変われば、その行の「実測」だけでなく較正係数
 * （`charsPerDigest` / `fixedIndexChars`）自体も同時に動く——較正を固定したまま
 * 「この行がどこまでずれたら赤くなるか」を計算しても、実際にその行が動いたときの
 * 挙動を正しく予測しない。
 *
 * hold-out 5行（322ターン行を含む）は較正標本に入らない——`calibrateRecallFootprint`
 * は較正標本15点だけから決まるので、hold-out 行の実測がいくら動いても較正係数は
 * 変わらない。⟹ hold-out 行だけは「この行の実測が[下限,上限]の外に出たら赤くなる」
 * という境界を、較正を固定したまま正しく計算できる。ADR 0201「検討して採らなかった案」に
 * hold-in 行を含めなかった理由の詳細がある。
 *
 * 境界は §上の docstring と同じ式: `est / (1 - ACCURACY_TOLERANCE)` が上限、
 * `est / (1 + ACCURACY_TOLERANCE)` が下限。上側の余白 = 上限 − 実測、
 * 下側の余白 = 実測 − 下限。
 *
 * FLOOR_CHARS は「半 digest 分（`charsPerDigest / 2`）」——⛔ **いまの余白の実測値を
 * そのまま固定しない**（脆くなる。ADR 0201参照。digest 1件の内容が変わるだけで
 * 正当に動きうる量を、赤の基準に固定すると、その正当な変更のたびに意味なく赤くなる）。
 * 半digest分は「digestの内容がわずかに変わっただけで境界に触れる」水準を表す、
 * 較正そのものから導いた閾値であり、較正係数が動けば閾値も追随する。
 *
 * ⚠ **2026-09-25（Issue #340 フォローアップ、ADR 0306/0310）: 較正標本を15点へ拡張した
 * ことで、この歯が実際に判定する対象（`calibrated`）が変わった。**7点だけの較正では
 * turnCount=42 の上側で12.18字（緑）だったが、15点(構造項を正しく差し引いた較正、
 * ADR 0306)では同じ行の下側で約9.39字になる——それでも FLOOR(半digest≒8.09字)を
 * 上回り、緑のままである（詳細は ADR 0201 追記3・ADR 0314 訂正節）。
 */
describe("字数で見た誤差の余白 — hold-out 5行のうちいちばん狭い行を明示する(Issue #410、較正標本15点、ADR 0306/0310)", () => {
  const calibrated = calibrateRecallFootprint(calibrationSamples);

  interface MarginInfo {
    turnCount: number;
    direction: "upper" | "lower";
    marginChars: number;
  }

  const margins: MarginInfo[] = holdOutRows.flatMap((row): MarginInfo[] => {
    const est = estimateRecallFootprint(
      { memoryCountInScope: row.totalInScope, associationCount: associationCountForRow(row) },
      calibrated,
    ).chars;
    const upperBoundChars = est / (1 - ACCURACY_TOLERANCE);
    const lowerBoundChars = est / (1 + ACCURACY_TOLERANCE);
    return [
      {
        turnCount: row.turnCount,
        direction: "upper",
        marginChars: upperBoundChars - row.mnemoraChars,
      },
      {
        turnCount: row.turnCount,
        direction: "lower",
        marginChars: row.mnemoraChars - lowerBoundChars,
      },
    ];
  });

  const narrowest = margins.reduce((min, cur) => (cur.marginChars < min.marginChars ? cur : min));

  // 半digest分。較正係数から導く——特定の実測値(例:11.15字)を固定しない。
  const FLOOR_CHARS = calibrated.charsPerDigest / 2;

  it(
    `いちばん余白が狭いのは turnCount=${narrowest.turnCount}(${narrowest.direction}側)で ` +
      `${narrowest.marginChars.toFixed(2)}字 — 半digest分(${FLOOR_CHARS.toFixed(2)}字)を上回ること`,
    () => {
      expect(narrowest.marginChars).toBeGreaterThanOrEqual(FLOOR_CHARS);
    },
  );
});

/**
 * `calibrateRecallFootprint` に `totalInScope`（Issue #340 フォローアップ / ADR 0306）を
 * 渡しても、この repo の hold-in 7行（`totalInScope` はいずれも1桁——上の「前提」節参照）
 * では較正係数が**バイト単位で**変わらないことを示す。
 *
 * hold-in 7行はすべて `totalInScope <= DEFAULT_RECALL_LIMIT`(10) であり、実際の値は
 * 2/3/3/3/4/5/8（`compare-baseline.json` 実測、上の `describe` 群が既に検算済み）と
 * すべて1桁——構造項（`indexBandStructuralTerms`、`totalInScope` の桁上がり）は
 * このデータでは常に0になる。⟹ `totalInScope` を渡しても渡さなくても
 * `calibrateRecallFootprint` の出力は**完全に同じ値**のはずである
 * （`Object.is` で比較——`toBeCloseTo` ではなく、丸めの余地を一切与えない）。
 *
 * ⚠ **この歯は ACCURACY_TOLERANCE・FLOOR_CHARS・compare-baseline.json・hold-in/hold-out
 * の分け方のいずれも変更しない。**既存の `holdInRows`/`ACCURACY_TOLERANCE` をそのまま
 * 読むだけである。
 */
describe("calibrateRecallFootprint — totalInScope を渡しても、hold-in 7行(すべて1桁)では係数がバイト単位で変わらない（Issue #340 フォローアップ / ADR 0306）", () => {
  const samplesWithout: RecallFootprintSample[] = holdInRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: 0,
  }));
  const samplesWith: RecallFootprintSample[] = holdInRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: 0,
    totalInScope: row.totalInScope,
  }));

  it("hold-in 7行がすべて1桁であること（この歯の前提。桁上がりが起きない形であることを検算する）", () => {
    for (const row of holdInRows) {
      expect(row.totalInScope, `turnCount=${row.turnCount}`).toBeLessThanOrEqual(9);
    }
  });

  it("charsPerDigest / fixedIndexChars とも Object.is で完全一致する（totalInScope の有無で1バイトも変わらない）", () => {
    const withoutProfile = calibrateRecallFootprint(samplesWithout);
    const withProfile = calibrateRecallFootprint(samplesWith);
    expect(Object.is(withProfile.charsPerDigest, withoutProfile.charsPerDigest)).toBe(true);
    expect(Object.is(withProfile.fixedIndexChars, withoutProfile.fixedIndexChars)).toBe(true);
    // 変更前の値(7点だけの較正、charsPerDigest≒15.458 / fixedIndexChars≒170.881)とも
    // 一致すること(3桁目まで)——BUILTIN_RECALL_FOOTPRINT_PROFILE は較正標本15点の値へ
    // 更新済みなので、ここでは BUILTIN ではなく固定した旧い値と比較する
    // (ADR 0302 の「較正係数は1つも動かしていない」という主張の、本 PR 版の確認)。
    expect(withProfile.charsPerDigest).toBeCloseTo(15.458, 2);
    expect(withProfile.fixedIndexChars).toBeCloseTo(170.881, 2);
  });
});
