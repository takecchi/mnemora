import { defaultActivityDecayStrategy, defaultDecayStrategy } from "./decay.js";
import type { ScoreBreakdown } from "../recall.js";
import { DEFAULT_DECAY_CLOCK } from "../interfaces/tenant-settings-store.js";
import type { DecayClock } from "../interfaces/tenant-settings-store.js";

/**
 * ScoringStrategy — Phase 1・純関数（docs/architecture.md §5.7、docs/recall.md §7）。
 *
 * docs が規定するのは「減衰 × 類似度 × タグ一致 × 鮮度 × 強度を掛け合わせる」ことと、「鮮度は
 * occurred_at ?? recorded_at、減衰は last_reinforced_at を使う」ことだけで、各要素の具体的な式は
 * 既定の実装が選んだもの。`ScoringStrategy` を差し替えれば別の式を使える。
 *
 * - `decay`（時間減衰）は `strength = 1` で呼んだ係数のみで、生の強度は `total` で別要素として掛ける
 *   （二重に強度を織り込まない）。
 * - `freshness` は同じ減衰関数を `occurredAt ?? recordedAt` 起点・`strength = 1` で呼び、**1 で頭打ちにする**
 *   （`MAX_FRESHNESS`、[ADR 0036](../../../../docs/decisions/0036-clamp-freshness-at-one.md)）。
 * - `tagMatch` はクエリタグが無ければ中立の 1、あれば `1 + 0.1 * 一致数`。タグは加点要素で除外条件ではない
 *   ので、一致しなくても total を 0 に落とさない。一致は `Set` の完全一致（大文字小文字・正規化を区別する）で、
 *   数えるのは `queryTags` の要素ごと（同じタグが重複していれば重複して数える）。
 * - `similarity` は ANN 経由でない候補では存在しないため、中立の 1 として扱う。
 * - `lexicalMatch` は語彙チャンネルが引き当てた候補にのみ在る（[ADR 0084](../../../../docs/decisions/0084-lexical-recall-channel.md)）。
 *   **第6の項として掛けず、`similarity` と同じ枠（`affinity`）を争わせる**: 掛けると、語彙一致が無い ANN 候補の
 *   `total` が 0 に落ちるか、中立の 1 を掛けるだけの死んだ項になる。`affinity = max(similarity, lexicalMatch)` で、
 *   「この候補がクエリにどれだけ近いか」を、見つけたチャンネルのうち最も強いものが名乗る。
 *
 * **`lexicalMatch` が `undefined` のとき、`affinity` は `similarity ?? 1` にそのまま退化する。**`Math.max` を通さない
 * のは意図的で、`similarity` は負になりうる（`interfaces/vector-store.ts` の `VectorHit.distance`）ため、
 * `Math.max(similarity, 0)` のような形にすると負の類似度の候補の `total` が静かに変わる。
 */
export interface ScoringInput {
  /** スコアを計算する時点（`decay`・`freshness` の計算に使う）。 */
  now: Date;
  /** ANN 経由の場合のみ渡す。類似度（`1 - distance`、距離から変換済み）。上は 1、**負にもなりうる**（コサイン距離は最大 2 まで出るので −1 まで下がる。`interfaces/vector-store.ts` の `VectorHit.distance`）。 */
  similarity?: number | undefined;
  /**
   * 語彙チャンネルが引き当てた場合のみ渡す（ADR 0084）。
   * **`(0, 1]` の被覆率を取る**（ADR 0092。一致したクエリ語彙数 ÷ クエリ語彙の総数。`ScoreBreakdown.lexicalMatch` の doc 参照）。
   */
  lexicalMatch?: number | undefined;
  /** 候補の Memory の `tags`。 */
  tags: string[];
  /** `RecallQuery.tags`（`tagMatch` に使う）。 */
  queryTags: string[];
  /**
   * 候補の Memory の `occurredAt`。`freshness` の起点になる（無ければ `recordedAt`。どちらの `timeWeighting` でも）。
   * `timeWeighting` が `"eventAwareFreshness"` で、この値が無いときは、`freshness` を最大にする。
   */
  occurredAt?: Date | null | undefined;
  /** 候補の Memory の `recordedAt`。 */
  recordedAt: Date;
  /** 候補の Memory の `lastReinforcedAt`（`decay` の起点。無ければ `recordedAt`）。 */
  lastReinforcedAt?: Date | null | undefined;
  /** 候補の Memory の `strength`。 */
  strength: number;
  /** 候補の Memory の `halfLifeHours`。 */
  halfLifeHours: number;
  /**
   * そのテナントの `decay_clock`（[ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md)）。省略時は壁時計のみ。
   * `'activity'`/`'either'` でも、下の `nowSeq`/`decayBaseSeq`/`halfLifeRecalls` が揃っていなければ壁時計へ
   * フォールバックする（「揃っていない」は「この軸に床が無い＝活動時計では沈まない」と同じ向きの判断）。
   */
  decayClock?: DecayClock | undefined;
  /** 活動時計の「いま」（`TenantSettingsStore.getActivitySeq` の値）。 */
  nowSeq?: number | undefined;
  /** `Memory.decayBaseSeq`。活動時計の起点。 */
  decayBaseSeq?: number | null | undefined;
  /** `Memory.halfLifeRecalls`。活動時計での Memory 単位の半減期。 */
  halfLifeRecalls?: number | null | undefined;
  /**
   * **段2の時間項の方針**（[ADR 0300](../../../../docs/decisions/0300-time-weighting-policy-opt-in.md)）。
   *
   * **省略時は {@link DEFAULT_TIME_WEIGHTING_POLICY}（`"legacy"`）。**
   * `"legacy"` と `"eventAwareFreshness"` の違いは `freshness` の計算にのみ現れる（{@link TimeWeightingPolicy}）。
   * **この方針が動かすのは `freshness` だけ**で、忘却ゲート（`decay_floor_at`/`decay_floor_seq`）・`validAt`
   * ゲートはこの欄を一切参照しない。
   */
  timeWeighting?: TimeWeightingPolicy | undefined;
}

/** 候補1件のスコアの内訳を計算する純関数（上の doc）。上界を宣言する戦略は {@link BoundedScoringStrategy}。 */
export type ScoringStrategy = (input: ScoringInput) => ScoreBreakdown;

/**
 * **段2の時間項の方針**（[ADR 0300](../../../../docs/decisions/0300-time-weighting-policy-opt-in.md)）。
 *
 * - `"legacy"`: `freshness` は常に `occurredAt ?? recordedAt` を起点にした減衰係数（`MAX_FRESHNESS` で頭打ち）。
 *   `occurredAt` が無い記憶（恒常的な事実・好み）は `recordedAt` の古さで沈み続け、`decay`（`lastReinforcedAt`
 *   起点。`reinforce` で若返る）と同じ半減期を使うため、使われ続けている記憶でも `freshness` だけが二重に減衰する。
 * - `"eventAwareFreshness"`: `occurredAt == null` のとき `freshness` を `MAX_FRESHNESS`（1）に固定する。
 *   `occurredAt` が在るときは `"legacy"` と完全に同じ式で、出来事の順位付けは変わらない。
 *
 * **どちらの値でも `decay` は変えない。**`decay`（使用の新しさ）と `freshness`（内容の新しさ）は独立な軸のままで、
 * 分離するはずの2軸を別の形でまた結合しない（ADR 0300 が「起点を共有させる」案を却下した理由）。
 *
 * **値の一覧をここに散文で二重に書かない。**唯一の出所は {@link TIME_WEIGHTING_POLICIES}（`RecallQuerySchema` の
 * `z.enum(TIME_WEIGHTING_POLICIES)` が読む）。
 */
export const TIME_WEIGHTING_POLICIES = ["legacy", "eventAwareFreshness"] as const;

/** {@link TIME_WEIGHTING_POLICIES} の要素型。 */
export type TimeWeightingPolicy = (typeof TIME_WEIGHTING_POLICIES)[number];

/**
 * `ScoringInput.timeWeighting` の既定値。**`"legacy"`**。**この定数を書き換える PR は既定の挙動を変える**
 * （ADR 0300 がオーナー判断として開いたまま残している点）。
 */
export const DEFAULT_TIME_WEIGHTING_POLICY: TimeWeightingPolicy = "legacy";

/**
 * `freshness` の上限（[ADR 0036](../../../../docs/decisions/0036-clamp-freshness-at-one.md)）。
 *
 * **「まだ起きていない出来事は、最も古びていない」と決めたものである。**`occurredAt` は「その出来事・事実が
 * いつのものか」なので、ふつうに未来になる（「来月、京都へ出張する」）。減衰式 `0.5 ** (elapsedHours / halfLifeHours)` は
 * 経過時間が負のとき 1 を超えて上限を持たず（+30日 → 2.0、+365日 → 4,597、+10年 → 4.2×10³⁶）、上限が無いと
 * 未来の日付を1つ持つ記憶がそのテナントの想起を永久に支配する。
 *
 * これは「未来の出来事を優遇する」決定ではない。`freshness` は古びを測る項で、まだ起きていない出来事は
 * 「たったいま起きたこと」と同じ扱いになるだけ。
 *
 * **上限を掛けるのは `freshness` だけで、`decay` には掛けない。**`defaultDecayStrategy` に手を入れると、
 * [ADR 0010](../../../../docs/decisions/0010-decay-parameters.md) が価値を置く「`floorAt` が `strengthAt(now) = threshold` の
 * 解析解として導かれ、両者が同じ式から機械的に一貫する」性質が壊れる。戦略の側で頭打ちにし、減衰関数そのものは変えない。
 */
export const MAX_FRESHNESS = 1;

/**
 * `freshness` の計算そのもの（ADR 0036 の頭打ちと、ADR 0300 の `timeWeighting` 分岐を1箇所に持つ）。
 *
 * - `"legacy"`（既定）: `occurredAt ?? recordedAt` を起点にした減衰係数を `MAX_FRESHNESS` で頭打ちにする。
 * - `"eventAwareFreshness"`: `occurredAt == null` のときだけ `MAX_FRESHNESS` を返す（起点が無いので古びを測る
 *   対象そのものが無い）。`occurredAt` が在るときは `"legacy"` と同じ式を通る。
 *
 * **下限側には clamp が無い（意図的な契約）**: `elapsed / halfLifeHours` が十分大きいと（既定の半減期720時間で
 * 約88年前の `occurredAt` 相当）、`0.5 ** x` は IEEE 754 倍精度の下限を割り込んで厳密に0になり、`total` も0になって
 * `similarity` の差が順位から消える。「そこまで古い記憶は区別しない」という契約で、直さない。境界の実測値・
 * 同点時のタイブレークは `docs/recall.md` §7.2 を見ること。
 */
function computeFreshness(input: ScoringInput): number {
  const timeWeighting = input.timeWeighting ?? DEFAULT_TIME_WEIGHTING_POLICY;
  if (timeWeighting === "eventAwareFreshness" && input.occurredAt == null) {
    return MAX_FRESHNESS;
  }
  return Math.min(
    MAX_FRESHNESS,
    defaultDecayStrategy.strengthAt(input.now, {
      recordedAt: input.occurredAt ?? input.recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: input.halfLifeHours,
    }),
  );
}

function computeTagMatch(tags: string[], queryTags: string[]): number {
  const tagSet = new Set(tags);
  const matchedCount = queryTags.filter((tag) => tagSet.has(tag)).length;
  return 1 + matchedCount * 0.1;
}

// ---------------------------------------------------------------------------
// 非 similarity 項の積の上界の宣言（ADR 0069）
// ---------------------------------------------------------------------------

/**
 * `nonSimilarityUpperBound` の入力。`tagMatch` の上界（`1 + 0.1 × queryTags.length`）はクエリのタグ数だけで決まり、
 * 候補側の情報を要らない。これが「上界をクエリだけから宣言できる」ことの根拠。
 */
export interface NonSimilarityBoundInput {
  /** `RecallQuery.tags`。`tagMatch` の上界はこれだけで決まる。 */
  queryTags: readonly string[];
}

/**
 * 段2のスコアのうち `similarity` 以外の項（`decay` × `tagMatch` × `freshness` × `strength`）の積の上界（ADR 0069）。
 *
 * **`number` ではなく判別可能な union にする**——宣言できたか／できなかったかを潰さない（ADR 0008）。
 * `kind: "declared"` でも、その上界が**保証**か**前提**かは `assumptions` の中身で読み分ける。
 */
export type NonSimilarityUpperBound =
  | {
      kind: "declared";
      value: number;
      /**
       * この上界が成り立つために立てた前提。**歯にできていないものを含む**（ADR 0069）。
       * 空配列は「前提なしの保証」を意味する。
       */
      assumptions: readonly string[];
    }
  | {
      kind: "undeclared";
      /** なぜ宣言できないか（この戦略が上界の機構そのものを持たない、等）。 */
      reason: string;
    };

/**
 * 上界を宣言できる戦略。`ScoringStrategy` を拡張するのではなく**足す**。
 *
 * `ScoringStrategy` 型（`(input) => ScoreBreakdown`）は、npm に `0.1.1` が既に出ているので破壊できない。
 * 宣言を持たない素の関数もそのまま `ScoringStrategy` として通したいので、宣言は本体の型に埋め込まず、
 * `Object.assign` で後から生やせるプロパティとして表現する。これで「宣言しない戦略」が型の上でも表現でき、
 * 判定不能に落ちるだけで、黙って誤った上界を使うことにはならない（ADR 0069）。
 */
export interface BoundedScoringStrategy extends ScoringStrategy {
  /** 類似度以外の成分がとりうる上界を、クエリ側の情報だけから返す（`decideAnnTruncation` が使う）。 */
  nonSimilarityUpperBound(input: NonSimilarityBoundInput): NonSimilarityUpperBound;
}

/** 引数が `nonSimilarityUpperBound` を持つか（＝宣言できる戦略か）を実行時に見分ける。 */
export function isBoundedScoringStrategy(s: ScoringStrategy): s is BoundedScoringStrategy {
  return typeof (s as Partial<BoundedScoringStrategy>).nonSimilarityUpperBound === "function";
}

/**
 * 既定戦略が宣言する、非 similarity 項の積の上界が立っている**前提**（ADR 0069）。
 *
 * `freshness` と `tagMatch` は式の形そのものから上界が出る（`Math.min` が在る／`1 + 0.1 × n`）が、次の2つは
 * 保証ではなく前提である。
 *
 * - **`decay ≤ 1`** — `decay` に clamp は無く、`0.5 ** (elapsed / halfLife)` は `elapsed < 0`（起点が未来）なら 1 を超える。
 * - **`strength ≤ 1`** — 型は `number` で 1 以下を保証しない。値域 `(0, MAX_STRENGTH]` は
 *   [ADR 0078](../../../../docs/decisions/0078-strength-value-range.md) が決め、同梱の実装は書き込み時に守る
 *   （`@mnemora/postgres` は DB の CHECK 制約、testkit の fixture と core の Fake は `createMemory` の検査）。
 *   **適合テストを通していない adapter では、前提のままである。**
 *
 * コメントに書くだけでは検査されないので、戻り値に載せる。この配列は歯で中身を検査され、`recall()` の
 * `omitted` にもそのまま出る。「この判定はこの前提の上に立っている」を結果自身に名乗らせる。
 */
export const DEFAULT_STRATEGY_BOUND_ASSUMPTIONS: readonly string[] = [
  "decay <= 1: 減衰の起点（lastReinforcedAt ?? recordedAt）が now より未来でないこと。" +
    "freshness と違い decay に clamp は無い（ADR 0036 は freshness だけを頭打ちにした）。",
  "strength <= 1: Memory.strength が値域 (0, 1] に収まっていること（ADR 0078）。" +
    "同梱の実装は書き込み時に拒むが（Postgres は DB の CHECK 制約、testkit は createMemory の検査）、" +
    "型（number）は保証しないので、適合テストを通していない adapter では前提のままである。",
];

/**
 * 段2の再スコア係数 `decay`（ADR 0165）。
 *
 * - `decayClock` 省略 or `'wall'`: 壁時計のみ。
 * - `'activity'`: `nowSeq`・`decayBaseSeq`・`halfLifeRecalls` の3つが揃っていれば活動時計の係数を使う。
 *   **揃っていなければ壁時計へフォールバックする**（「この軸に床が無い＝活動時計では沈まない」と同じ向き。
 *   `decay = 0`/`NaN` へ倒さない）。
 * - `'either'`: **2つの係数の `Math.max`**（最も緩い）を使う。段1のゲートが `'either'` を OR にしたのと同じ向きで、
 *   ゲートを通った候補の順位付けがゲートの判定と矛盾しないようにする。活動時計側の入力が揃っていなければ
 *   壁時計の係数だけが使われる。
 */
function computeDecay(input: ScoringInput): number {
  const wallDecay = defaultDecayStrategy.strengthAt(input.now, {
    recordedAt: input.recordedAt,
    lastReinforcedAt: input.lastReinforcedAt,
    strength: 1,
    halfLifeHours: input.halfLifeHours,
  });

  const clock = input.decayClock ?? DEFAULT_DECAY_CLOCK;
  if (clock === "wall") {
    return wallDecay;
  }

  const hasActivityInputs =
    input.nowSeq !== undefined &&
    input.decayBaseSeq !== undefined &&
    input.decayBaseSeq !== null &&
    input.halfLifeRecalls !== undefined &&
    input.halfLifeRecalls !== null;

  if (!hasActivityInputs) {
    // 揃っていない＝この軸に床が無いので、壁時計へフォールバックする。
    return wallDecay;
  }

  const activityDecay = defaultActivityDecayStrategy.strengthAt(input.nowSeq!, {
    baseSeq: input.decayBaseSeq!,
    strength: 1,
    halfLifeRecalls: input.halfLifeRecalls!,
  });

  return clock === "either" ? Math.max(wallDecay, activityDecay) : activityDecay;
}

const scoreWithDefaultStrategy: ScoringStrategy = (input) => {
  const decay = computeDecay(input);
  const freshness = computeFreshness(input);

  const tagMatch = computeTagMatch(input.tags, input.queryTags);
  const similarity = input.similarity;
  const lexicalMatch = input.lexicalMatch;

  // affinity: 「この候補はクエリにどれだけ近いか」。lexicalMatch が無いときは similarity ?? 1 に退化する（冒頭の doc）。
  const affinity =
    lexicalMatch === undefined
      ? (similarity ?? 1)
      : similarity === undefined
        ? lexicalMatch
        : Math.max(similarity, lexicalMatch);

  const total = affinity * decay * tagMatch * freshness * input.strength;

  // affinity が中立の1に退化したか（関連度を測っていないか）を名乗る欄（ADR 0282）。値がある場合だけ足す形にはしない
  // （欄が無いことを「defaultScoringStrategy を経由していない」の専用の合図として残すため。`ScoreBreakdown.affinityMeasured`）。
  const affinityMeasured = similarity !== undefined || lexicalMatch !== undefined;

  const score: ScoreBreakdown = {
    decay,
    tagMatch,
    freshness,
    strength: input.strength,
    total,
    affinityMeasured,
  };
  if (similarity !== undefined) {
    score.similarity = similarity;
  }
  if (lexicalMatch !== undefined) {
    score.lexicalMatch = lexicalMatch;
  }
  return score;
};

/**
 * 既定のスコアリング戦略。**上界の宣言を持つ**（ADR 0069）。
 *
 * `Object.assign` で関数へメソッドを生やすのは、`ScoringStrategy` の呼び出し可能な形を保つため
 * （`{ score, bound }` のようなオブジェクトへ変えると npm の `0.1.1` の利用者を壊す）。
 *
 * **上界の内訳**（`total` から `similarity` を除いた4項の積）:
 *
 * | 項 | 上界 | 保証か、前提か |
 * |---|---|---|
 * | `freshness` | `MAX_FRESHNESS`（= 1） | **保証** — `Math.min` が式の中に在る（ADR 0036） |
 * | `tagMatch` | `1 + 0.1 × queryTags.length` | **保証** — `computeTagMatch` の形そのもの。候補側を見ずにクエリだけで決まる |
 * | `decay` | 1 | **前提** — clamp が無い（`DEFAULT_STRATEGY_BOUND_ASSUMPTIONS`） |
 * | `strength` | 1 | **前提** — 型は保証しない（同上） |
 *
 * **`tagMatch` の上界に候補側の `tags` を使わない。**使えば上界は縮むが、窓の外の候補の tags を知る必要があり、
 * 窓の外は見えないというのが前提そのものである。
 *
 * **`lexicalMatch` はこの上界に入らない。入れてはならない**（ADR 0084）。この上界は `total` から similarity の枠を
 * 除いた積の上界で、`lexicalMatch` は `affinity` としてその枠の**中**に居る。
 * ただし、この上界を使う判定（`decideAnnTruncation`）は変わる。語彙チャンネルが走っているとき、ANN の窓の外の候補が
 * `affinity = 1` を名乗りうるので、`recall-runtime.ts` は語彙チャンネルが走った run では `ann_truncated` を
 * `certainty: 'undecidable'` に落とす（ADR 0084）。
 */
export const defaultScoringStrategy: BoundedScoringStrategy = Object.assign(
  scoreWithDefaultStrategy,
  {
    nonSimilarityUpperBound(input: NonSimilarityBoundInput): NonSimilarityUpperBound {
      const freshnessMax = MAX_FRESHNESS;
      const tagMatchMax = 1 + input.queryTags.length * 0.1;
      const decayMax = 1;
      const strengthMax = 1;
      return {
        kind: "declared",
        value: freshnessMax * tagMatchMax * decayMax * strengthMax,
        assumptions: DEFAULT_STRATEGY_BOUND_ASSUMPTIONS,
      };
    },
  },
);
