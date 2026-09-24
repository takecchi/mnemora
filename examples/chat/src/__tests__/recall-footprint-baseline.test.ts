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
 * `BUILTIN_RECALL_FOOTPRINT_PROFILE` は「12点のうち目次帯が空の7点（`totalInScope <=
 * DEFAULT_RECALL_LIMIT`）だけを使った最小二乗」だと自称している（`recall-footprint.ts` の
 * 該当コメント）。この歯は、**その主張を実際に自分で計算し直して検算する**
 * ——同梱の既定プロファイルを信用せず、`calibrateRecallFootprint` を実際に呼ぶ。
 */

interface BaselineRow {
  turnCount: number;
  totalInScope: number;
  naiveChars: number;
  mnemoraChars: number;
  mnemoraShareOfNaiveChars: number;
  returnedCount: number;
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
 * ### ⚠ 2026-09-24 訂正（ADR 0299・Issue #340）: `compare-baseline.json` を録り直した
 *
 * 上の2026-09-17時点の表（322行が最大誤差2.068%・余裕17%・字数余白20.14字、42行が
 * hold-out中最小の字数余白11.15字）は、**`scenario.ts` の filler が12文の固定配列を
 * `i % 12` で巡回していた時点の `compare-baseline.json` に対する値である。**
 *
 * filler の重複（320往復の会話で同じ文が最大約27回重複）が、連想枠の `maxCount` による
 * tie-break に紛れ込み、322ターン行の `mnemoraChars` を非決定にしていた
 * （[ADR 0170](../../../docs/decisions/0170-association-search-tiebreak-nondeterminism.md) §3）。
 * この重複を無くすため filler を話題×述語の直積による一意な生成へ直し（`scenario.ts`）、
 * `compare.json`（カセット）を実 API で録り直した上で、`compare-baseline.json` を
 * この PR 自身の CI artifact で実測更新した（ADR 0299）。
 *
 * **filler の内容が変われば、12行すべての `naiveChars`/`mnemoraChars`/`totalInScope` が
 * 連鎖して動く**——「322行だけを直した」とは言えない。特に、各 turnCount で
 * 実際に何件の filler が「記憶に値する」と real LLM に判定されるかが変わったため、
 * **hold-in（`totalInScope <= 10`）/hold-out の内訳自体が「7行/5行」から「8行/4行」へ
 * 変わった**（turnCount=42 行が `totalInScope=9` になり hold-out から hold-in 側へ移った）。
 *
 * | | 旧（12文巡回、2026-09-17時点） | 新（話題×述語の直積、2026-09-24） |
 * |---|---|---|
 * | hold-in/hold-out の内訳 | 7行/5行 | **8行/4行** |
 * | 較正係数 | charsPerDigest≒15.458 / fixedIndexChars≒170.881 | **charsPerDigest=14.45 / fixedIndexChars=180.7** |
 * | 12行全体の最大誤差 | 2.068%（322ターン行） | **2.061%（22ターン行）** |
 * | hold-out側の最大誤差 | 2.068%（322ターン行） | **1.982%（322ターン行）** |
 * | 2.5%に対する余裕（百分率、全体最大） | (2.5−2.068)/2.5 ≒ 17% | **(2.5−2.061)/2.5 ≒ 17.6%** |
 *
 * ⟹ **推定器の形・重み（自由係数2つという構造）は変えていない**——係数の値そのものは
 * 「入力（`compare-baseline.json`）が変わったので再較正した結果」であり、それ自体は
 * この ADR が意図して動かしたものではない。`ACCURACY_TOLERANCE`（0.025）も
 * `DEFAULT_FOOTPRINT_TOLERANCE`（`packages/core`、0.05）も動かしていない。
 *
 * 🔴 **字数の余白は次の「字数で見た誤差の余白」の訂正節を見ること**——42行が
 * hold-in側へ移ったため、いちばん狭い行が変わっている。
 */
const ACCURACY_TOLERANCE = 0.025;

const holdInRows = rows.filter((r) => r.totalInScope <= DEFAULT_RECALL_LIMIT);
const holdOutRows = rows.filter((r) => r.totalInScope > DEFAULT_RECALL_LIMIT);

function relativeError(estimatedChars: number, actualChars: number): number {
  return Math.abs(estimatedChars - actualChars) / actualChars;
}

describe("compare-baseline.json — 前提（行数が変わっていないこと）", () => {
  // ⚠ 2026-09-24訂正（ADR 0299・Issue #340）: hold-in/hold-out の内訳は「7行/5行」だったが、
  // filler を録り直した結果、turnCount=42 行が hold-out から hold-in 側へ移り「8行/4行」に
  // なった（このファイル冒頭の docstring 参照）。
  it("12行のうち、目次帯が空の(totalInScope <= DEFAULT_RECALL_LIMIT)行が8行、そうでない行が4行", () => {
    expect(rows).toHaveLength(12);
    expect(holdInRows).toHaveLength(8);
    expect(holdOutRows).toHaveLength(4);
  });
});

describe("calibrateRecallFootprint — hold-in 8行での較正", () => {
  // ⚠ 2026-09-24訂正（ADR 0299・Issue #340）: 以前は「目次帯が空の7行だけ」だったが、
  // filler を録り直した結果 turnCount=42 行が hold-in 側へ移り、いまは8行（このファイル
  // 冒頭の docstring 参照）。目次帯が空の8行だけを標本にする。これらは
  // totalInScope <= DEFAULT_RECALL_LIMIT なので全件が返り、目次帯に載る候補が無い
  // (bandEntryCount=0)。
  const samples: RecallFootprintSample[] = holdInRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: 0,
  }));
  const calibrated = calibrateRecallFootprint(samples);

  it("borrowedFromDefault が空(8行に memoryCount の広がりがあるため両係数とも決まる)", () => {
    if (calibrated.origin.kind !== "calibrated") throw new Error("unreachable");
    expect(calibrated.origin.borrowedFromDefault).toEqual([]);
    expect(calibrated.origin.sampleCount).toBe(8);
  });

  // ⚠ 2026-09-24訂正（ADR 0299・Issue #340）: 以前は charsPerDigest≒15.458 /
  // fixedIndexChars≒170.881 だった。filler を録り直した結果の再較正値に更新した
  // （`packages/core` の BUILTIN_RECALL_FOOTPRINT_PROFILE も同じ値に更新済み）。
  it("較正した係数がオーナーの実測(charsPerDigest=14.45 / fixedIndexChars=180.7)に一致する", () => {
    expect(calibrated.charsPerDigest).toBeCloseTo(14.45, 2);
    expect(calibrated.fixedIndexChars).toBeCloseTo(180.7, 2);
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

    it("12行全体(較正に使った8行 + hold-outの4行)の最大誤差が許容誤差以内", () => {
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
   * ⚠ **`too_close_to_call` が出る行がありうる。**
   *
   * ### ⚠ 2026-09-24訂正（ADR 0299・Issue #340）
   *
   * 以前（filler 12文巡回時点）は `totalInScope=4`（10ターン行）の
   * `mnemoraShareOfNaiveChars` ≒ 0.9547（95.5%）が既定許容誤差(5%)の内側に落ち、
   * `too_close_to_call` になっていた。filler を録り直した結果、10ターン行は
   * `totalInScope=3`・`mnemoraShareOfNaiveChars` ≒ 0.9004（90.0%）——既定許容誤差(5%)の
   * **外**（約10%乖離）になり、`too_close_to_call` ではなく `mnemora_smaller` になった。
   * 【実測】12行を通して `too_close_to_call` になる行は無い——`TOO_CLOSE_TO_CALL_TURN_COUNTS`
   * を空集合にした（値を削除するのではなく、経緯をこの節に残す）。
   *
   * `too_close_to_call` は「見積もりが誤差の幅の中に居るのでどちらとも言えない」という
   * 積極的な申告であり、これを「判定を外した」と数えるのは誤り
   * （`recall-footprint.ts` の `FullLogVerdict` の doc）。
   */
  const TOO_CLOSE_TO_CALL_TURN_COUNTS = new Set<number>([]);

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

    // ⚠ 2026-09-24訂正（ADR 0299・Issue #340）: 以前は naiveChars=197・実測109.6%だった。
    // filler を録り直した結果 naiveChars=199・実測113.6%に動いたが、既定許容誤差(5%)の
    // 外という結論(full_log_smallerのまま)は変わっていない。
    it("8ターン行(totalInScope=3, naiveChars=199, 実測113.6%)は1に近いが許容誤差の外なので full_log_smaller のまま", () => {
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
  it("既定プロファイルの最大誤差が許容誤差以内であり、hold-in較正済みプロファイルとほぼ同程度に当たる", () => {
    const samples: RecallFootprintSample[] = holdInRows.map((row) => ({
      totalChars: row.mnemoraChars,
      memoryCount: row.returnedCount,
      bandEntryCount: 0,
    }));
    const calibrated = calibrateRecallFootprint(samples);

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
    // 既定プロファイル自身がこの8行から測ったものである(recall-footprint.ts の
    // BUILTIN_RECALL_FOOTPRINT_PROFILE.origin.measuredFrom を見よ)以上、この歯が
    // hold-in較正し直した値とほぼ一致するはず。ずれるなら既定プロファイルの係数が
    // 古い(誰かが構造定数を変えたのに測り直していない)ということなので、その場合は
    // このテストの失敗をそのまま報告すること。
    expect(Math.abs(maxErrDefault - maxErrCalibrated)).toBeLessThan(0.005);
  });
});

/**
 * Issue #410 対処候補3: 「歯の余白は字数で見るとどれだけ狭いか」を、百分率ではなく
 * 字数で見える形にする。
 *
 * ⚠ **対象は hold-out 行だけであり、hold-in 行は含めない。**理由は自己参照——
 * hold-in 行（`totalInScope <= DEFAULT_RECALL_LIMIT`）は `calibrateRecallFootprint` の
 * 較正標本そのものである（上の `samples` が `row.mnemoraChars` を直接使う）。ある
 * hold-in 行の実測が変われば、その行の「実測」だけでなく較正係数
 * （`charsPerDigest` / `fixedIndexChars`）自体も同時に動く——較正を固定したまま
 * 「この行がどこまでずれたら赤くなるか」を計算しても、実際にその行が動いたときの
 * 挙動を正しく予測しない。
 *
 * hold-out 行（322ターン行を含む）は較正標本に入らない——`calibrateRecallFootprint`
 * は hold-in 行だけから決まるので、hold-out 行の実測がいくら動いても較正係数は
 * 変わらない。⟹ hold-out 行だけは「この行の実測が[下限,上限]の外に出たら赤くなる」
 * という境界を、較正を固定したまま正しく計算できる。ADR 0201「検討して採らなかった案」に
 * hold-in 行を含めなかった理由の詳細がある。
 *
 * 境界は §上の docstring と同じ式: `est / (1 - ACCURACY_TOLERANCE)` が上限、
 * `est / (1 + ACCURACY_TOLERANCE)` が下限。上側の余白 = 上限 − 実測、
 * 下側の余白 = 実測 − 下限。
 *
 * FLOOR_CHARS は「半 digest 分（`charsPerDigest / 2`）」——⛔ **いまの余白の実測値
 * （例: 42ターン行の11.15字）をそのまま固定しない**（脆くなる。ADR 0201参照。
 * digest 1件の内容が変わるだけで正当に動きうる量を、赤の基準に固定すると、
 * その正当な変更のたびに意味なく赤くなる）。半digest分は「digestの内容がわずかに
 * 変わっただけで境界に触れる」水準を表す、較正そのものから導いた閾値であり、
 * 較正係数が動けば閾値も追随する。
 *
 * ### 🔴 2026-09-24訂正（ADR 0299・Issue #340）: hold-out は5行→4行になり、
 * 最も狭い行が42行→82行に変わった。**この歯はいま実際に赤い。**
 *
 * `scenario.ts` の filler を録り直した結果（このファイル冒頭の docstring 参照）、
 * turnCount=42 行は `totalInScope=9` になり hold-in 側へ移った——hold-out は
 * 82/162/322/642 の4行になった。42行が抜けたことで「いちばん狭い行」の候補も
 * 入れ替わり、【実測】いちばん狭いのは **82ターン行の下側で 6.51字**
 * （旧: 42ターン行の上側で11.15字）。**これは FLOOR（半digest分 = 7.225字）を
 * 下回っている**——⟹ 下の `it` は緑ではなく赤で終わる。
 *
 * | | 旧（2026-09-17時点、42行が最狭） | 新（2026-09-24、82行が最狭） |
 * |---|---|---|
 * | hold-out 行数 | 5行 | 4行 |
 * | 最も狭い行 | 42ターン行・上側 | **82ターン行・下側** |
 * | 最小余白 | 11.15字 | **6.51字** |
 * | FLOOR（半digest分） | 7.73字 | 7.225字 |
 * | 判定 | 余白 > FLOOR（緑） | **余白 < FLOOR（赤）** |
 *
 * ⛔ **`ACCURACY_TOLERANCE`・`FLOOR_CHARS` の式（`charsPerDigest/2`）・推定器の形は
 * 1つも動かしていない**——ADR 0201 が却下した「固定した実測値を閾値にする」も
 * 「通すために閾値を動かす」も採っていない。ADR 0201 自身の「これが覆るとしたら」1項
 * （較正標本の取り方・入力が変わって hold-out 行の誤差が動いたとき）がまさに起きた
 * 状態であり、**この歯が意図通り「境界に近づいたら知らせる」役割を果たして赤くなって
 * いる**。⟹ **この赤を、この PR の中で消していない**——`ACCURACY_TOLERANCE` を
 * 緩める・FLOOR の式を変えるといった手段は AGENTS.md／ADR 0201 の規律に反するため
 * 採らず、オーナーの判断を仰ぐ（PR 本文「未評価の残り」参照）。
 */
describe("字数で見た誤差の余白 — hold-out 4行のうちいちばん狭い行を明示する(Issue #410)", () => {
  const samples: RecallFootprintSample[] = holdInRows.map((row) => ({
    totalChars: row.mnemoraChars,
    memoryCount: row.returnedCount,
    bandEntryCount: 0,
  }));
  const calibrated = calibrateRecallFootprint(samples);

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
