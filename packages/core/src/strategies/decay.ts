/**
 * DecayStrategy — Phase 1・純関数（docs/architecture.md §5.7、ADR 0010）。
 *
 * 両方とも純関数であり、状態を保存しない。`strengthAt` の結果はどこにも永続化されない。
 * 永続化されるのは書き込み時に一度だけ計算する `decay_floor_at`（`floorAt` の戻り値）。
 */
export interface DecayParams {
  /** Memory.recordedAt。lastReinforcedAt が無い場合の起点として使う。 */
  recordedAt: Date;
  /** Memory.lastReinforcedAt。無ければ recordedAt を起点にする（ADR 0010）。 */
  lastReinforcedAt?: Date | null | undefined;
  /** 減衰させる前の強さ（`Memory.strength`）。 */
  strength: number;
  /** 半減期（時間）。起点からこの時間が経つと強さが半分になる。 */
  halfLifeHours: number;
}

/** 壁時計（時間）で読む減衰の戦略（上の doc）。既定は {@link defaultDecayStrategy}。 */
export interface DecayStrategy {
  /**
   * `now` の時点の強さ（`strength × 0.5^(経過時間 / halfLifeHours)`、起点は `lastReinforcedAt ?? recordedAt`）。⚠ `now` が起点より前なら `strength` を超える値を返す（丸めない）。
   */
  strengthAt(now: Date, params: DecayParams): number;
  /** threshold を省略すると `DEFAULT_DECAY_THRESHOLD`（0.05、ADR 0010）が使われる。 */
  floorAt(params: DecayParams, threshold?: number): Date;
}

/** ADR 0010 が固定する既定の減衰閾値。 */
export const DEFAULT_DECAY_THRESHOLD = 0.05;

const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * `Date` が有限の時刻として表現できる最大値（ECMA-262 `Date` 仕様。西暦 +275760 年ごろ）。
 *
 * **`floorAt` がここで丸める理由**: `halfLifeHours` は有限の正の実数を認める（ADR 0125 決定4）ので、
 * 「ほぼ永久に減衰しない」を意図した有限だが巨大な値が値域に入る。そのとき `base + halfLifeHours *
 * log2(strength/threshold)` は `±8.64e15ms` を超えて Invalid Date になり、`decayFloorAt > now` が
 * 常に `false` になって、「ほぼ永久に生きる」が「作成直後から忘却済み」に壊れる。
 * `decayFloorOffset` は非負なので下側では起こらず、上側だけ丸めれば足りる。
 */
const MAX_DATE_MS = 8_640_000_000_000_000;

function decayBase(params: DecayParams): Date {
  return params.lastReinforcedAt ?? params.recordedAt;
}

/**
 * 単位を持たない数値核（[ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md)）。
 * `elapsed` と `halfLife` が「時間」の単位でも「recall 回数」の単位でも式は変わらず、
 * `defaultDecayStrategy.floorAt`（時刻）と `defaultActivityDecayStrategy.floorAt`（通し番号）はこの核を包むだけ。
 *
 * **下限に clamp は無い。** `elapsed / halfLife` が十分大きいと `Math.pow(0.5, x)` が IEEE 754 倍精度の下限を
 * 割り込み、厳密に `0` になる。`scoring.ts` の `computeFreshness` がこの境界を契約として
 * `docs/recall.md` §7.2 に書いている。
 */
export function decayFactor(elapsed: number, halfLife: number): number {
  return Math.pow(0.5, elapsed / halfLife);
}

/**
 * 「`strength` が `threshold` をちょうど下回るまでの `elapsed`」を返す、単位を持たない数値核（ADR 0165）。
 * `strength <= threshold`（既に閾値以下）のときは `0` を返す。
 *
 * **入力の検査（ADR 0496）**: `threshold` が有限かつ `0` 超でない、`strength`・`halfLife` が有限かつ `0` 以上でない、
 * のどれかなら `RangeError`。`floorAt`（壁時計・活動時計の両方）はこの関数を通るので、同じ検査が掛かる。
 * message に入力値は入れない。
 * ⚠ **`strength`・`halfLife` の `0` は断らない**——`halfLife: 0` は「壊れた」記憶を作るテストの fixture が使っており
 * （`FakeMemoryStore` などは `halfLifeHours: 0` を受ける）、戻り値は `0`（有限）で壊れた値を作らない。
 * `(0, ∞)` の値域（ADR 0125）まで締めるかは決めていない。上限（`MAX_STRENGTH`）も検査しない。
 */
export function decayFloorOffset(strength: number, halfLife: number, threshold: number): number {
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new RangeError("decayFloorOffset: threshold must be a finite number greater than 0");
  }
  if (!Number.isFinite(strength) || strength < 0) {
    throw new RangeError("decayFloorOffset: strength must be a finite number, 0 or greater");
  }
  if (!Number.isFinite(halfLife) || halfLife < 0) {
    throw new RangeError("decayFloorOffset: halfLife must be a finite number, 0 or greater");
  }
  if (strength <= threshold) {
    return 0;
  }
  return halfLife * Math.log2(strength / threshold);
}

/** `strengthAt(now, params) = strength * 0.5 ** (elapsedHours / halfLifeHours)`（ADR 0010）。 */
function strengthAt(now: Date, params: DecayParams): number {
  const base = decayBase(params);
  const elapsedHours = (now.getTime() - base.getTime()) / MS_PER_HOUR;
  return params.strength * decayFactor(elapsedHours, params.halfLifeHours);
}

/**
 * `strengthAt` が `threshold` をちょうど下回る時刻。`strength <= threshold` の場合は base をそのまま返す
 * （ADR 0010。作成時点で既に閾値以下で、過去の時刻が返る）。
 */
function floorAt(params: DecayParams, threshold: number = DEFAULT_DECAY_THRESHOLD): Date {
  const base = decayBase(params);
  const hours = decayFloorOffset(params.strength, params.halfLifeHours, threshold);
  // `MAX_DATE_MS` の doc のとおり、巨大な `halfLifeHours` で Invalid Date にしないために丸める。
  const ms = Math.min(base.getTime() + hours * MS_PER_HOUR, MAX_DATE_MS);
  return new Date(ms);
}

/** 既定の {@link DecayStrategy}。`floorAt` は、`Date` で表せる最大の時刻を超えるときは、その最大値に丸める（Invalid Date にしない）。 */
export const defaultDecayStrategy: DecayStrategy = {
  strengthAt,
  floorAt,
};

/**
 * ActivityDecayStrategy — 壁時計（`DecayStrategy`）と同じ式を、「recall() が起きた回数」を単位にして読む実例
 * （[ADR 0165](../../../../docs/decisions/0165-decay-activity-clock.md)）。
 *
 * | | 起点（base） | 進み方（1単位） | 保存する床 |
 * |---|---|---|---|
 * | 壁時計（`DecayStrategy`） | `lastReinforcedAt ?? recordedAt` | 1時間 | `decayFloorAt`（`Date`） |
 * | 活動時計（本 interface） | 書き込み時点の `activity_seq`（`baseSeq`） | そのテナントで `recall()` が1回起きること | `decayFloorSeq`（`bigint`/`number`） |
 *
 * ADR 0010 の式（`floor = base + halfLife * log2(strength / threshold)`）は動かさず、読む単位だけが違う。
 */
export interface ActivityDecayParams {
  /** 書き込み時（作成・強化）の tenant_activity.activity_seq。 */
  baseSeq: number;
  /** 減衰させる前の強さ（`Memory.strength`）。 */
  strength: number;
  /** 単位は「そのテナントで recall() が起きた回数」。 */
  halfLifeRecalls: number;
}

/** 活動時計（そのテナントで `recall()` が起きた回数）で読む減衰の戦略（上の doc）。既定は {@link defaultActivityDecayStrategy}。 */
export interface ActivityDecayStrategy {
  /**
   * `nowSeq` の時点の強さ（`strength × 0.5^((nowSeq − baseSeq) / halfLifeRecalls)`）。⚠ `nowSeq` が `baseSeq` より小さければ `strength` を超える値を返す（丸めない）。
   */
  strengthAt(nowSeq: number, params: ActivityDecayParams): number;
  /** threshold を省略すると `DEFAULT_DECAY_THRESHOLD`（0.05、ADR 0010）が使われる。 */
  floorAt(params: ActivityDecayParams, threshold?: number): number;
}

function activityStrengthAt(nowSeq: number, params: ActivityDecayParams): number {
  const elapsed = nowSeq - params.baseSeq;
  return params.strength * decayFactor(elapsed, params.halfLifeRecalls);
}

/**
 * `baseSeq + Math.ceil(decayFloorOffset(...))` を返す（整数）。
 *
 * **`ceil` は意図的である**（ADR 0165）。段1のゲートは `decay_floor_seq > nowSeq`（狭義）なので、小数を切り捨てると
 * 「まだ閾値を割っていない seq」が `decay_floor_seq <= nowSeq` の側に落ちて沈んだ扱いになる
 * （offset = 2.3 のとき床を `base + 2` にすると、`nowSeq = base + 2` でまだ `strengthAt > threshold` なのに沈む）。
 * `strength <= threshold` のときは `baseSeq` をそのまま返す（壁時計の `floorAt` が `base` を返すのと同じ）。
 *
 * **`Number.MAX_SAFE_INTEGER` で丸める理由**（`floorAt` が `MAX_DATE_MS` で丸める理由と同根）:
 * `halfLifeRecalls` も有限で巨大な値を許す。戻り値は `decay_floor_seq`（Postgres `bigint`、`mode: "number"`）に
 * 書かれ、JS の number は `2**53` を超えると整数を正確に表現できない（ADR 0290 も同じ境界を前提にする）。
 * 丸めなければ、精度を落とした値を静かに書くか、bigint の範囲を超えて INSERT が例外になる一方 Fake は
 * 無検査で受け入れる、のどちらかになる。
 */
function activityFloorAt(
  params: ActivityDecayParams,
  threshold: number = DEFAULT_DECAY_THRESHOLD,
): number {
  const offset = decayFloorOffset(params.strength, params.halfLifeRecalls, threshold);
  return Math.min(params.baseSeq + Math.ceil(offset), Number.MAX_SAFE_INTEGER);
}

/** 既定の {@link ActivityDecayStrategy}。`floorAt` は切り上げた整数を返し、`Number.MAX_SAFE_INTEGER` を超えるときはその値に丸める。 */
export const defaultActivityDecayStrategy: ActivityDecayStrategy = {
  strengthAt: activityStrengthAt,
  floorAt: activityFloorAt,
};
