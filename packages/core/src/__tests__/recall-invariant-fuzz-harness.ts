import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";
import type { NewMemory } from "../memory.js";
import type { RecallQuery, RecallRecord, RecallResult } from "../recall.js";
import type { createRuntime as CreateRuntime, RuntimeDeps } from "../runtime.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import {
  isContestedGroupMembershipMismatchError,
  isContestedWithoutCompanionError,
  isMemoryStatusConflictError,
} from "../interfaces/memory-store.js";

/**
 * recall の不変条件を、シードつきのランダムな操作列で検査する検査器の本体（Issue #1019・#1020・
 * #1021 を見つけた検査器）。store 一式は呼び出し側が渡す——Fake（`recall-invariant-fuzz.test.ts`）と
 * Postgres（`packages/postgres/src/__tests__/recall-invariant-fuzz.postgres.test.ts`）が同じ操作列・
 * 同じ検査を共有する。
 *
 * 操作: 記憶の作成（ゼロベクトル・`pending` を含む）、recall（`limit`・連想枠・予算・閾値・
 * 語彙チャンネルを振る）、使用報告による強化、forget、purge、restoreArchived、markContested、
 * resolveContested、consolidate（LLM は固定の応答）、sweepArchive、時計を進める。
 *
 * recall のたびに検査する不変条件と、その約束の在り処:
 * - I1 contested は対向なしで返らない（`docs/architecture.md` §0 原則1、`MemoryStore` の契約、
 *   `docs/recall.md` §8、ADR 0136、Issue #959）
 * - I2 `memories` に同じ id が2回出ない（ADR 0203）
 * - I3 status が active/contested 以外の記憶・purge 済みの記憶は返らない
 *   （`docs/recall.md` §2 段0 の status ゲート、ADR 0124）
 * - I4 `below_threshold.nearMisses` の id は返っておらず、score は閾値未満（ADR 0203、
 *   `BelowThresholdOmission` の doc）
 * - I5 `score.total` は `affinity × decay × tagMatch × freshness × strength`
 *   （`strategies/scoring.ts`、`docs/recall.md` §7）
 * - I6 `axis: 'subject'` の群カウントの総和は `totalInScope`（`docs/recall.md` §5）
 * - I7 digest 帯の id は返っていない（`docs/recall.md` §5）
 * - I8 `contestedWith` の相手は同じ結果に居る（ADR 0335）
 * - I9 同じ操作列は同じ結果を返す（Fake の決定性。`checkDeterminism` を立てた backend だけ）
 * - I10 件数の勘定。スコープ内の記憶を、返したもの（status が active/contested）と、**候補ごとの層**の
 *   札（`below_threshold`・`over_limit`・`budget_dropped`・`score_not_comparable`・
 *   `unit_assembly_dropped`）の件数で数える。**集約の層**の札（`not_indexed`、`filtered` のすべての
 *   `condition`）は、スコープ全体の集約から出す件数で、排他性の対象の外に置く（ADR 0203 追記9、
 *   Issue #1021・#1025）ので、この和には入れない。
 *   - 上限: 和 ≦ `totalInScope`。ADR 0203 の「1件の Memory は `omitted` の中で1回だけ数える」
 *     （決めたこと1、追記3〜8）から導ける。
 *   - 下限: 候補ごとの層の件数がすべて `'exact'` で、件数を持たない札（`ann_truncated`・
 *     `ann_unreached`・`lexical_truncated`・段1の `stage_skipped`）が無いとき、
 *     和 ≧ `totalInScope` − `not_indexed` − スコープ内の `filtered`（`within_scope`）。
 *     候補にならなかったスコープ内の記憶は、埋め込みが無いか減衰しきっているかのどちらかであり、
 *     それは集約の層の札が数えている。`docs/recall.md` 冒頭の原則3（結果は、そこから漏れたものと
 *     必ず同時に提示する）から導ける。
 *   下限は `channels` に `"ann"` を含む recall にだけ当てる（ADR 0509）。
 * - I11 集約の件数を、検査器が作った記憶の現在の状態から独立に数えた値と突き合わせる。この検査器の
 *   recall は scope を絞らない（subject・期間・`validAt` の外に出る記憶・taxonomy を持たない）ので、
 *   `totalInScope` は status が active/contested の記憶の件数（`docs/recall.md` §5「`totalInScope` が
 *   何を数えているか」）、`not_indexed` の合計はそのうち埋め込みが `ready` でないものの件数に等しい。
 *   I10 の下限は、`totalInScope` が膨らむと `ann_unreached` が立って効かなくなる（eligible も一緒に
 *   膨らむ）ので、膨らみはここで捕まえる。
 * - I12 `filtered`（`outside_scope`）の `archived`・`superseded`・`forgotten` の件数は、その status の
 *   記憶の件数に等しい（`docs/recall.md` §5 の表の甲群）。
 * - I13 `findCorrectionCandidates` の `excludeMemoryIds` は、大文字小文字を無視して除外する（ADR 0485、`fcc` 操作。ADR 0494）。
 * - I15 `consolidate` が積む `created` の `meta.sources` は小文字（ADR 0527、`argupper` の `consolidate` で届く）。
 * - I16 `getRecall(recallId)` が読み戻す `RecallRecord` は、その recall の戻り値と同じ内容を持つ（`returnedMemories` の
 *   `memoryId`・`retrievedVia`・`score`・`companionOf`・`associationOf`、`omitted`、`usage`。ADR 0155・0480・0509）。
 * - I14 群の同伴の数は、返った owner の数 × `relationMaxCount` 以下（ADR 0381・0396、`relations` profile。ADR 0494）。
 *
 * 落ちたときは、操作を1つずつ抜いて違反が残るかを見る形で操作列を最小化し、シードと最小の
 * 操作列を出力に出す。
 */

/** キーの順に依らない JSON（`undefined` の欄は落ちる）。`getRecall` の読み戻し（jsonb）と、その場の値を比べるのに使う。 */
function canon(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * 差分の突き合わせ用に、`RecallRecord` から backend の違いで値が変わる欄を落とす。
 * - `query.vector`: backend の空間の次元で書かれる（Fake は 2 次元、Postgres は 3 次元に 0 を足したもの。`FuzzBackend.vector`）。
 * - `usage.chars`・`estimatedTokens`・`indexChars`・`byTier.index`: 目次帯の JSON（`JSON.stringify(indexBand)`、memoryId を含む）の
 *   長さから出る。id の長さが backend で違う（Fake は `mem-N`、Postgres は uuid の 36 字）ので揃わない。
 * ほかの欄は比べる。
 */
function withoutBackendDependentFields<T extends RecallRecord | null>(rec: T): T {
  if (rec === null) return rec;
  const { vector: _vector, ...query } = (rec.query ?? {}) as Record<string, unknown>;
  const { chars: _c, estimatedTokens: _e, indexChars: _i, byTier, ...usage } = rec.usage;
  const { index: _idx, ...tier } = byTier;
  return { ...rec, query, usage: { ...usage, byTier: tier } };
}

export const FUZZ_CTX: Ctx = { tenantId: "tenant-1" };
const ctx = FUZZ_CTX;
const T0 = new Date("2026-06-01T00:00:00.000Z").getTime();

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 操作に渡す id の変形（ADR 0494、`argdead`／`argupper` profile だけ）。
 * - `upper`: 大文字にする。操作の対象の `id` の大文字小文字は Postgres が受け、fixture（InMemory・Fake）は受けない
 *   （ADR 0446 の既存の違い）ので、3 実装の差分の検査には載せない。
 * - `dead`: 消した（forget・purge 済みの）記憶の id を狙って渡す。
 */
export type ArgMutation = "upper" | "dead";

export type Op =
  | {
      k: "create";
      v: number;
      tags: string[];
      ready: boolean;
      zero: boolean;
      subj: boolean;
      hl: number;
      /** `fields` profile だけ: `occurredAt` を「いまから何時間前か」（負なら未来）で振る。無ければ null。 */
      occ?: number | null;
      /** `channels` profile だけ: content に足す語（ADR 0509。日本語・識別子を含む）。 */
      w?: string;
    }
  | {
      k: "recall";
      v: number;
      limit: number;
      off: number;
      assoc: number;
      budget: number;
      thr: number;
      lex: boolean;
      /** `fields` profile だけ: これまで一度も振っていなかった `RecallQuery` の欄（ADR 0492）。 */
      x?: { tw: boolean; dbl: number; qt: string[]; rmc?: number };
      /** `channels` profile だけ: 渡す `channels` と `text`（ADR 0509）。あれば `lex` より優先する。 */
      ch?: { c: ("ann" | "lexical")[]; text: string };
    }
  | { k: "bulk"; n: number; seed: number }
  | { k: "usage"; pick: number; mu?: ArgMutation }
  | { k: "forget"; i: number; mu?: ArgMutation }
  | { k: "purge"; i: number; mu?: ArgMutation }
  | { k: "restore"; i: number; mu?: ArgMutation }
  | { k: "mark"; i: number; j: number; mu?: ArgMutation }
  | { k: "resolve"; i: number; sup: boolean; mu?: ArgMutation }
  | { k: "consolidate"; i: number; j: number; mu?: ArgMutation }
  /** `relations` profile だけ（ADR 0494）: 3 件の多者間の群を作る（`markContestedGroup`）。 */
  | { k: "group"; i: number; j: number; l: number }
  /** `relations` profile だけ: 作った群を解決する（`resolveContestedGroup`）。 */
  | { k: "resolveGroup"; g: number; sup: boolean }
  /** `relations` profile だけ: `RelationStore.link` を直接呼ぶ（`contradicts` の1行、片方向。ADR 0494）。 */
  | { k: "link"; i: number; j: number }
  /** `relations` profile だけ: `RelationStore.unlink` を直接呼ぶ。 */
  | { k: "unlink"; i: number; j: number }
  /** `argdead`／`argupper` profile だけ: `findCorrectionCandidates` に `excludeMemoryIds` を渡す（ADR 0485・0494）。 */
  | { k: "fcc"; i: number; mu?: ArgMutation }
  | { k: "sweep" }
  | { k: "advance"; hours: number };

/** 操作列が使うベクトル（2次元）。backend の空間の次元へは `FuzzBackend.vector` が写す。 */
const VECS = [
  [1, 0],
  [0.95, 0.31],
  [0.7, 0.71],
  [0.31, 0.95],
  [0, 1],
  [0.05, 0.9987],
];

/**
 * 操作列の形。
 * - `default`: 元の検査器（PR #1030）の操作列そのもの。同じシードは同じ列になる。
 * - `wide`: 記憶を一度に数十〜数百件作る `bulk` を混ぜ、recall の窓（`limit`・`overFetchFactor`）を
 *   広げる。`default` は1シードの記憶が高々二十数件で、窓 k' が scope の候補より小さいため
 *   `ann_unreached`（info）がほぼ常に立ち、I10 の下限がほとんど効かない。`wide` は
 *   索引（HNSW）を通る規模と、k' ≧ 候補数の recall（I10 の下限が効く）の両方を作る。
 * - `fields`: これまで振っていなかった `RecallQuery` の欄（ADR 0492）。
 * - `relations`: `relationStore` を配線し、`relationMaxCount`・多者間の群（`markContestedGroup`／
 *   `resolveContestedGroup`）・`RelationStore.link`／`unlink`（`contradicts` の1行、実在の2件）を振る
 *   （ADR 0494）。範囲外の `kind` や `kind` が偽の値の読み（ADR 0488 が縛った面）は渡さない。
 * - `argdead`／`argupper`: 操作に渡す id を、消した（forget・purge 済みの）記憶の id に差し替える／大文字にする
 *   （ADR 0494）。大文字の id は、ADR 0494 の時点では fixture が受けず（ADR 0446 の既存の違い）、3 実装の差分に載せられなかった。
 *   ADR 0521 で fixture を Postgres に揃えたので、`argdead`・`argupper` とも 3 実装の差分に載せる。
 * - `channels`: `channels`（`["ann","lexical"]`・`["lexical"]` だけ・`["ann"]` だけ）と `text` を乱択し、記憶の content に
 *   語（ASCII の識別子・日本語）を足す。語彙チャンネルの store（tsvector／trigram）との合流を振る（ADR 0509）。
 * - `fieldswide`: `wide` と `fields` を合わせる（近似索引 HNSW を通る規模に `fields` の欄を載せる。ADR 0509）。
 * - どの profile も、追加の乱数は別の流れ（`r2`）から引き、`default`／`wide`／`fields` の同じシードの操作列を変えない。
 */
export type FuzzProfile =
  "default" | "wide" | "fields" | "relations" | "argdead" | "argupper" | "channels" | "fieldswide";

/**
 * `channels` profile が content と query の text に使う語（ADR 0509）。ASCII の語・識別子と、日本語（trigram 側）を含む。
 * ADR 0509 は Fake・testkit が Postgres と食い違う 2 つの語（ハイフンを含む識別子 `PROJ-12`、ほかの語の部分文字列になる語）を
 * 外していた。ADR 0513 で fixture を Postgres に揃えたので戻した（`PROJ-12`・`alp`。`alp` は `alpha` の部分文字列）。
 * ⚠ ADR 0513 が揃えていない parser の細部（`-12` の符号付き token、`a.b`・メールアドレスの 1 token、ハイフン結合語）を踏む語は
 * 入れないこと（`12` 単独、`a.b`、`abc-def` など）。入れると Fake・testkit と Postgres が割れる。
 */
const CHANNEL_WORDS = [
  "alpha",
  "beta",
  "gamma",
  "PROJ12",
  "PROJ-12",
  "alp",
  "東京",
  "大阪",
  "東京タワー",
  "alpha beta",
];
const CHANNEL_SETS: ("ann" | "lexical")[][] = [
  ["ann", "lexical"],
  ["lexical"],
  ["lexical", "ann"],
  ["ann"],
];

export function genOps(seed: number, n: number, profile: FuzzProfile = "default"): Op[] {
  const r = rng(seed);
  // `fields` の追加の欄は別の乱数の流れから引く——`r` の引き方は `default` と同じに保ち、
  // 同じシードの操作列の骨格（どの操作が何番目か）を変えない（ADR 0492）。
  const r2 = rng((seed ^ 0x5bd1e995) >>> 0);
  const fields = profile === "fields" || profile === "fieldswide";
  const wide = profile === "wide" || profile === "fieldswide";
  const chan = profile === "channels";
  const rel = profile === "relations";
  const argMu: ArgMutation | null =
    profile === "argdead" ? "dead" : profile === "argupper" ? "upper" : null;
  const mu = (): { mu?: ArgMutation } => (argMu !== null && r2() < 0.5 ? { mu: argMu } : {});
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const idx = () => Math.floor(r() * 1000);
  const ops: Op[] = [];
  for (let i = 0; i < n; i++) {
    const x = r();
    if (wide && (i === 0 || r() < 0.04)) {
      ops.push({ k: "bulk", n: pick([20, 60, 150]), seed: Math.floor(r() * 2 ** 31) });
      continue;
    }
    if (i < 3 || x < 0.3) {
      ops.push({
        k: "create",
        v: Math.floor(r() * VECS.length),
        tags: ["a", "b", "c"].filter(() => r() < 0.4),
        ready: r() < 0.9,
        zero: r() < 0.05,
        subj: r() < 0.3,
        hl: pick([1, 24, 24 * 365]),
        ...(fields ? { occ: r2() < 0.5 ? null : Math.floor(r2() * 24 * 400) - 24 * 10 } : {}),
        ...(chan && r2() < 0.8
          ? { w: CHANNEL_WORDS[Math.floor(r2() * CHANNEL_WORDS.length)]! }
          : {}),
      });
    } else if (x < 0.6) {
      ops.push({
        k: "recall",
        v: Math.floor(r() * VECS.length),
        limit: 1 + Math.floor(r() * (wide ? 20 : 4)),
        off: 1 + Math.floor(r() * (wide ? 5 : 3)),
        assoc: Math.floor(r() * 3),
        budget: pick([0, 0, 5, 12, 25]),
        thr: pick([-1, 0, 0.3, 0.6]),
        lex: r() < 0.2,
        ...(fields
          ? {
              x: {
                tw: r2() < 0.5,
                dbl: [0, 0, 1, 2, 3, 5][Math.floor(r2() * 6)]!,
                qt: ["a", "b", "c", "a"].filter(() => r2() < 0.4),
              },
            }
          : rel
            ? { x: { tw: false, dbl: 0, qt: [], rmc: [0, 0, 1, 2, 3][Math.floor(r2() * 5)]! } }
            : chan
              ? {
                  ch: {
                    c: CHANNEL_SETS[Math.floor(r2() * CHANNEL_SETS.length)]!,
                    text: CHANNEL_WORDS.filter(() => r2() < 0.25).join(" ") || "alpha",
                  },
                }
              : {}),
      });
    } else if (x < 0.68) ops.push({ k: "usage", pick: idx(), ...mu() });
    else if (x < 0.74) ops.push({ k: "forget", i: idx(), ...mu() });
    else if (x < 0.78) ops.push({ k: "purge", i: idx(), ...mu() });
    else if (x < 0.8) ops.push({ k: "restore", i: idx(), ...mu() });
    else if (x < 0.87) {
      const i = idx();
      const j = idx();
      const u = rel ? r2() : 1;
      if (u < 0.45) ops.push({ k: "group", i, j, l: Math.floor(r2() * 1000) });
      else if (u < 0.65) ops.push({ k: "link", i, j });
      else if (u < 0.75) ops.push({ k: "unlink", i, j });
      else ops.push({ k: "mark", i, j, ...mu() });
    } else if (x < 0.91) {
      const i = idx();
      const sup = r() < 0.5;
      if (rel && r2() < 0.5) ops.push({ k: "resolveGroup", g: Math.floor(r2() * 1000), sup });
      else ops.push({ k: "resolve", i, sup, ...mu() });
    } else if (x < 0.94) ops.push({ k: "consolidate", i: idx(), j: idx(), ...mu() });
    else if (x < 0.96) {
      if (argMu !== null && r2() < 0.5) ops.push({ k: "fcc", i: idx(), ...mu() });
      else ops.push({ k: "sweep" });
    } else ops.push({ k: "advance", hours: pick([1, 24, 24 * 30, 24 * 400]) });
  }
  return ops;
}

/** 検査器が使う store 一式（`createFakeRuntimeStores()` の戻り値と同じ形）。 */
export type FuzzStores = Pick<
  RuntimeDeps,
  "memoryStore" | "outboxStore" | "vectorStore" | "eventStore" | "tenantSettingsStore"
> & {
  lexicalStore: NonNullable<RuntimeDeps["lexicalStore"]>;
  embeddingProvider: RuntimeDeps["embeddingProvider"];
  /** `relations` profile だけが配線する（ADR 0494）。 */
  relationStore?: RuntimeDeps["relationStore"];
};

export interface FuzzBackend {
  /**
   * 1回の実行ぶんの store 一式を、前の実行の状態を持ち越さない形で用意する。`createRuntime` も
   * 一緒に返す——Fake は id の採番をモジュール単位の続き番号で持つので、実行ごとにモジュールを
   * 読み直す（I9）。
   */
  setup(): Promise<{ stores: FuzzStores; createRuntime: typeof CreateRuntime }>;
  /** `VECS` の2次元ベクトルを、`stores.embeddingProvider.space` の次元へ写す。 */
  vector(v: readonly number[]): number[];
}

export interface Violation {
  inv: string;
  detail: string;
  op: number;
}

export interface RunOutcome {
  violations: Violation[];
  /** ADR 0494: 変形した引数の形の数え上げ（`操作:変形:狙った記憶の状態` → 回数）。実際に何を渡したかを報告に載せる。 */
  shapes: Record<string, number>;
  /** 終わった時点の、作った記憶の状態（作成順。`status` と、purge 済みなら `+purged`）。 */
  finalStates: string[];
  trace: string[];
  /**
   * recall ごとの、backend に依らない形の結果（`RunOptions.snapshot` を立てたときだけ）。
   * Memory の id は作成順の別名（`c0`, `c1`, …。検査器が作ったもの以外は初出順の `x0`, …）へ、
   * 数値は有効数字6桁へ丸める——Fake・testkit と Postgres の差分検査（`diffRuns`）が突き合わせる。
   */
  snapshots: string[];
}

/**
 * 差分検査で `VECS` の代わりに使うベクトル。角度（度）をゴロム定規 {0, 1, 4, 10, 12, 17} の
 * 5倍に置く——どの2本の組の角度差も互いに異なるので、**違うベクトルどうしが、あるクエリに
 * 対して数学的に同じ cosine を持つことが無い**。`VECS` は鏡像（[0.95, 0.31] と [0.31, 0.95]、
 * [1, 0] と [0, 1]）を含み、数学的な同点を作る。同点の決着は浮動小数の端数に落ち、pgvector は
 * ベクトルを float4 で持つので、Fake（float8）と逆に転ぶことがある（実測: seed 183 の連想枠の
 * 過取得の窓、#1033）。
 */
const DIFF_VECS = [0, 5, 20, 50, 60, 85].map((deg) => [
  Math.cos((deg * Math.PI) / 180),
  Math.sin((deg * Math.PI) / 180),
]);

export interface RunOptions {
  /**
   * 操作ごと（`bulk` は1件ごと）に時計を進める（既定は進めない）。同じ時刻に作った記憶の並びは
   * id で決着し、id の振り方は backend ごとに違う（Fake は続き番号、Postgres は
   * `gen_random_uuid()`）。差分検査では時刻をずらして、並びを id に頼らせない。
   * 進め幅は、このシードの擬似乱数で 1〜1,000,000 ms に散らす——一定の幅だと
   * 「減衰の起点 + 鮮度の起点 = 2 × 別の記憶の起点」のような算術的な一致が起き、
   * 数学的に同点の total を作る（実測: seed 85、#1033）。
   */
  jitterSeed?: number;
  /** `VECS` の代わりに `DIFF_VECS` を使う。 */
  diffVectors?: boolean;
  snapshot?: boolean;
  /** `relationStore` を runtime に配線する（`relations` profile、ADR 0494）。配線すると recall の段3が変わる。 */
  relations?: boolean;
}

export async function runOps(
  backend: FuzzBackend,
  ops: readonly Op[],
  runOpts: RunOptions = {},
): Promise<RunOutcome> {
  const jitter = runOpts.jitterSeed === undefined ? undefined : rng(runOpts.jitterSeed);
  const step = () => (jitter ? 1 + Math.floor(jitter() * 1_000_000) : 0);
  const vecs = runOpts.diffVectors ? DIFF_VECS : VECS;
  let now = T0;
  const { stores, createRuntime } = await backend.setup();
  const vec = (i: number) => backend.vector(vecs[i]!);
  const llm = {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async (
      _c: Ctx,
      req: { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } },
    ) => {
      for (const cand of [
        { content: "merged", digest: "merged" },
        { outcome: "reflected", content: "reflection", digest: "reflection" },
      ]) {
        const parsed = req.schema.safeParse(cand);
        if (parsed.success) return parsed.data;
      }
      throw new Error("stub: no candidate matched");
    },
  };
  const makeRuntime = (lexical: boolean) =>
    createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      lexicalStore: lexical ? stores.lexicalStore : undefined,
      relationStore: runOpts.relations ? stores.relationStore : undefined,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: llm as never,
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
      clock: { now: () => new Date(now) },
    });
  const rt = makeRuntime(false);
  const rtLex = makeRuntime(true);
  /** 群の操作（`group`／`resolveGroup`）と、`relations` profile の recall。配線は `runOpts.relations` で決まる。 */
  const rtRel = rt;
  const ids: MemoryId[] = [];
  /** I11・I12 の数え上げ用。`ids` と違い、consolidate が作った記憶も入れる（`nth` の意味は変えない）。 */
  const allIds: MemoryId[] = [];
  let lastRecall: RecallResult | null = null;
  const violations: Violation[] = [];
  const trace: string[] = [];
  const snapshots: string[] = [];
  const alias = new Map<string, string>();
  let extra = 0;
  const normalize = async (value: unknown): Promise<unknown> => {
    if (typeof value === "number") return Number(value.toPrecision(6));
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") {
      const known = alias.get(value);
      if (known !== undefined) return known;
      if (/^mem-\d+$|^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) {
        const m = await stores.memoryStore.get(ctx, value as MemoryId);
        if (m) {
          const name = `x${extra++}`;
          alias.set(value, name);
          return name;
        }
      }
      return value;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const x of value) out.push(await normalize(x));
      return out;
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        if (k === "recallId") continue;
        out[k] = await normalize((value as Record<string, unknown>)[k]);
        // `groups` の出現順序は契約にしない（ADR 0307 決定6）。
        if (k === "groups" && Array.isArray(out[k]))
          out[k] = (out[k] as unknown[])
            .map((g) => JSON.stringify(g))
            .sort()
            .map((g) => JSON.parse(g) as unknown);
      }
      return out;
    }
    return value;
  };
  const nth = (i: number) => (ids.length > 0 ? ids[i % ids.length] : undefined);
  /**
   * ADR 0494: 消した記憶の id。forget 済み（`purgedAt` なし）と purge 済み（`purgedAt` あり。行は墓標として残る）を
   * 別々に集め、`i` の偶奇で交互に狙う（片方が無ければ、もう片方）。どちらも無ければ undefined。
   */
  const deadNth = async (i: number): Promise<MemoryId | undefined> => {
    const forgotten: MemoryId[] = [];
    const purged: MemoryId[] = [];
    for (const id of ids) {
      const m = await stores.memoryStore.get(ctx, id);
      if (m?.status !== "forgotten") continue;
      (m.purgedAt ? purged : forgotten).push(id);
    }
    const pool =
      (i & 1) === 1 && purged.length > 0 ? purged : forgotten.length > 0 ? forgotten : purged;
    return pool.length > 0 ? pool[Math.floor(i / 2) % pool.length] : undefined;
  };
  /** ADR 0494: 操作に渡す id を変形する（`upper`: 大文字、`dead`: 消した記憶を狙う。無ければ元の id）。 */
  const shapes: Record<string, number> = {};
  const countShape = async (op: string, id: MemoryId | undefined, mu?: ArgMutation) => {
    if (mu === undefined || id === undefined) return;
    const m = await stores.memoryStore.get(ctx, id.toLowerCase() as MemoryId);
    const state = m === null || m === undefined ? "missing" : m.purgedAt ? "purged" : m.status;
    const key = `${op}:${mu}:${state}`;
    shapes[key] = (shapes[key] ?? 0) + 1;
  };
  const target = async (op: string, i: number, mu?: ArgMutation): Promise<MemoryId | undefined> => {
    const id = mu === "dead" ? ((await deadNth(i)) ?? nth(i)) : nth(i);
    await countShape(op, id, mu);
    return id !== undefined && mu === "upper" ? (id.toUpperCase() as MemoryId) : id;
  };
  /** `relations` profile で作った群のメンバー（`resolveGroup` が使う）。 */
  const groups: MemoryId[][] = [];
  /** 群の操作で起きうる、設計どおりの競合（メンバーの状態が変わった等）。違反にしない。 */
  const isExpectedGroupConflict = (e: unknown) =>
    isMemoryStatusConflictError(e) ||
    isContestedGroupMembershipMismatchError(e) ||
    isContestedWithoutCompanionError(e);

  const check = async (r: RecallResult, q: RecallQuery, oi: number) => {
    const v = (inv: string, detail: string) => violations.push({ inv, detail, op: oi });
    const returned = new Set(r.memories.map((m) => m.memoryId));
    if (returned.size !== r.memories.length) v("I2-unique", JSON.stringify([...returned]));
    // I16（ADR 0509）: 書いた `recalls` の行を `getRecall` で読み戻すと、返した内容と一致する。
    {
      const rec = await rt.getRecall(ctx, r.recallId);
      if (rec === null) v("I16-record-missing", String(r.recallId));
      else {
        if (rec.tenantId !== ctx.tenantId) v("I16-record-tenant", rec.tenantId);
        if (!rec.returnedMemories.breakdownCaptured)
          v("I16-record-breakdown", "breakdownCaptured: false");
        const proj = (m: {
          memoryId: unknown;
          retrievedVia: unknown;
          score: unknown;
          companionOf?: unknown;
          associationOf?: unknown;
        }) => ({
          memoryId: m.memoryId,
          retrievedVia: m.retrievedVia,
          score: m.score,
          companionOf: m.companionOf,
          associationOf: m.associationOf,
        });
        const want = canon(r.memories.map(proj));
        const got = canon(rec.returnedMemories.memories.map((m) => proj(m as never)));
        if (want !== got) v("I16-record-returned", `${want} vs ${got}`);
        if (canon(rec.omitted) !== canon(r.omitted)) v("I16-record-omitted", "omitted が食い違う");
        if (canon(rec.usage) !== canon(r.usage)) v("I16-record-usage", "usage が食い違う");
      }
    }
    // I14（ADR 0494）: 群の同伴（`contestedWithId` を持たない `contested` から辿った `mandatory_companion`）は、
    // 群ごとに `relationMaxCount` 件まで（`RecallQuery.relationMaxCount`）。単位は丸ごと返る（owner を含む）ので、
    // 返った owner（同伴でなく、`contested` で `contestedWithId` なし）の数 × 上限が、同伴の総数の上限になる。
    if (q.relationMaxCount !== undefined && q.relationMaxCount > 0) {
      const rows = new Map(
        (await stores.memoryStore.getMany(ctx, [...returned])).map((m) => [m.id, m]),
      );
      const isGroupMember = (id: MemoryId | undefined) => {
        const m = id === undefined ? undefined : rows.get(id);
        return m?.status === "contested" && (m.contestedWithId ?? null) === null;
      };
      const owners = r.memories.filter(
        (m) => m.retrievedVia !== "mandatory_companion" && isGroupMember(m.memoryId),
      ).length;
      const companions = r.memories.filter(
        (m) => m.retrievedVia === "mandatory_companion" && isGroupMember(m.companionOf),
      ).length;
      if (companions > owners * q.relationMaxCount)
        v(
          "I14-relationMaxCount",
          `companions ${companions} > owners ${owners} × ${q.relationMaxCount}`,
        );
    }
    let returnedInScope = 0;
    for (const rm of r.memories) {
      const m = await stores.memoryStore.get(ctx, rm.memoryId);
      if (!m) {
        v("I3-missing", rm.memoryId);
        continue;
      }
      if (m.status === "active" || m.status === "contested") returnedInScope++;
      else v("I3-status", `${rm.memoryId} ${m.status} via ${rm.retrievedVia}`);
      if (m.purgedAt) v("I3-purged", rm.memoryId);
      if (m.status === "contested" && m.contestedWithId && !returned.has(m.contestedWithId)) {
        v("I1-lone-contested", `${rm.memoryId} via ${rm.retrievedVia}`);
      }
      if (rm.contestedWith !== undefined && !returned.has(rm.contestedWith))
        v("I8-contestedWith", rm.memoryId);
      const s = rm.score;
      // Issue #548 方向2 / ADR 0352: affinityMeasured: false の score（AffinityUnmeasuredScore）
      // は total/similarity/lexicalMatch を欄として持たない——I5 が比べる「公開された total」
      // そのものが無いので、この形の記憶は I5 の検査対象から外す（内部では今日も同じ積で
      // total を計算しているが、その値は返り値に出ない。`toRecalledScore` の doc 参照）。
      if (s.affinityMeasured === false) {
        continue;
      }
      const affinity =
        s.lexicalMatch === undefined
          ? (s.similarity ?? 1)
          : s.similarity === undefined
            ? s.lexicalMatch
            : Math.max(s.similarity, s.lexicalMatch);
      const product = affinity * s.decay * s.tagMatch * s.freshness * s.strength;
      if (!(Number.isNaN(product) && Number.isNaN(s.total)) && product !== s.total) {
        v("I5-product", `${rm.memoryId} ${product} vs ${s.total}`);
      }
    }
    const threshold = q.scoreThreshold ?? 0.1;
    for (const o of r.omitted) {
      if (o.kind !== "below_threshold") continue;
      for (const nm of o.nearMisses ?? []) {
        if (returned.has(nm.memoryId)) v("I4-nearMiss-returned", nm.memoryId);
        if (!(nm.score < threshold))
          v("I4-nearMiss-score", `${nm.memoryId} ${nm.score} < ${threshold}`);
      }
    }
    const subjectSum = r.index.groups
      .filter((g) => g.axis === "subject")
      .reduce((acc, g) => acc + g.count, 0);
    if (subjectSum !== r.index.totalInScope)
      v("I6-groups", `${subjectSum} vs ${r.index.totalInScope}`);
    for (const d of r.index.digestBand ?? [])
      if (returned.has(d.memoryId)) v("I7-band-returned", d.memoryId);

    let counted = returnedInScope;
    // 集約の層の札（ADR 0203 追記9）。和には入れず、下限の余白にだけ使う。
    let aggregateSlack = 0;
    let allExact = true;
    for (const o of r.omitted) {
      switch (o.kind) {
        case "not_indexed":
          aggregateSlack += o.count;
          break;
        case "filtered":
          if (o.scopeRelation === "within_scope") aggregateSlack += o.count;
          break;
        case "below_threshold":
        case "over_limit":
        case "budget_dropped":
        case "score_not_comparable":
        case "unit_assembly_dropped":
          counted += o.count;
          if (o.countKind !== "exact") allExact = false;
          break;
        case "ann_truncated":
        case "ann_unreached":
        case "lexical_truncated":
          allExact = false;
          break;
        case "stage_skipped":
          if (o.stage !== "association") allExact = false;
          break;
      }
    }
    // ADR 0509: `channels` に `"ann"` が無い recall（`["lexical"]` だけ）の候補は語彙に当たった記憶だけで、当たらなかった
    // スコープ内の記憶は、どの札にも数えられない（埋め込みが有っても候補にならない）。下限は「ann が eligible を全部候補にする」
    // ことに依っているので、ann を含まない recall には当てない（上限は当てる）。
    if (q.channels !== undefined && !q.channels.includes("ann")) allExact = false;
    const summary = () =>
      `returned ${returnedInScope}, counted ${counted}, aggregate-layer ${aggregateSlack}, total ${r.index.totalInScope} :: ${JSON.stringify(r.omitted)}`;
    if (counted > r.index.totalInScope) v("I10-upper", summary());
    if (allExact && counted < r.index.totalInScope - aggregateSlack) v("I10-lower", summary());

    const all = await stores.memoryStore.getMany(ctx, allIds);
    const live = all.filter((m) => m.status === "active" || m.status === "contested");
    if (r.index.totalInScope !== live.length)
      v("I11-totalInScope", `${r.index.totalInScope} vs ${live.length}`);
    const notIndexed = r.omitted.reduce(
      (acc, o) => acc + (o.kind === "not_indexed" ? o.count : 0),
      0,
    );
    const unready = live.filter((m) => m.embeddingStatus !== "ready").length;
    if (notIndexed !== unready) v("I11-notIndexed", `${notIndexed} vs ${unready}`);
    for (const status of ["archived", "superseded", "forgotten"] as const) {
      const reported = r.omitted.reduce(
        (acc, o) =>
          acc +
          (o.kind === "filtered" && o.condition === status && o.scopeRelation === "outside_scope"
            ? o.count
            : 0),
        0,
      );
      const actual = all.filter((m) => m.status === status).length;
      if (reported !== actual) v(`I12-filtered-${status}`, `${reported} vs ${actual}`);
    }
  };

  const createOne = async (
    op: {
      tags: string[];
      ready: boolean;
      subj: boolean;
      hl: number;
      occ?: number | null;
      w?: string;
    },
    vector: number[],
  ) => {
    const at = new Date(now);
    const n: NewMemory = {
      tenantId: ctx.tenantId,
      subjectId: op.subj ? "s1" : null,
      sourceObservationId: null,
      extractorVersion: null,
      content: `content ${ids.length} ${op.tags.join(" ")}${op.w ? ` ${op.w}` : ""}`,
      contentHash: `h${ids.length}`,
      digest: `d${ids.length}`,
      digestSource: "llm",
      provenance: { kind: "imported", batchId: "fuzz" },
      tags: op.tags,
      occurredAt: op.occ == null ? null : new Date(now - op.occ * 3_600_000),
      recordedAt: at,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: op.hl,
      decayFloorAt: defaultDecayStrategy.floorAt({
        recordedAt: at,
        lastReinforcedAt: null,
        strength: 1,
        halfLifeHours: op.hl,
      }),
      embeddingStatus: op.ready ? "ready" : "pending",
      // ADR 0494: 群の同伴の並び・切り捨ては `validFrom` の新しい順→id の順。`validFrom` が全員 null だと id で決まり、
      // id が作成順の `mem-N`（Fake・InMemory）か乱数の uuid（Postgres）かで並びが割れる（約束の外）ので、
      // `relations` の実行では作成ごとに別の `validFrom` を付けて、id の比較に落ちないようにする。
      ...(runOpts.relations ? { validFrom: at } : {}),
    };
    const m = await stores.memoryStore.createMemory(ctx, n);
    alias.set(m.id, `c${ids.length}`);
    if (op.ready) {
      await stores.vectorStore.upsert(ctx, stores.embeddingProvider.space, m.id, vector);
    }
    ids.push(m.id);
    allIds.push(m.id);
    now += step();
  };

  for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi]!;
    try {
      switch (op.k) {
        case "create":
          await createOne(op, op.zero ? backend.vector([0, 0]) : vec(op.v));
          break;
        case "bulk": {
          const br = rng(op.seed);
          for (let b = 0; b < op.n; b++) {
            // 第1象限の単位ベクトル（`VECS` と同じ範囲）。1/4 は `VECS` と同じ向きにして同点を作る。
            const theta = (br() * Math.PI) / 2;
            const exact = br() < 0.25 ? Math.floor(br() * vecs.length) : -1;
            await createOne(
              {
                tags: ["a", "b", "c"].filter(() => br() < 0.4),
                ready: true,
                subj: br() < 0.3,
                hl: [24, 24 * 30, 24 * 365][Math.floor(br() * 3)]!,
              },
              exact >= 0 ? vec(exact) : backend.vector([Math.cos(theta), Math.sin(theta)]),
            );
          }
          break;
        }
        case "recall": {
          const q = {
            vector: vec(op.v),
            limit: op.limit,
            overFetchFactor: op.off,
            association:
              op.assoc === 0
                ? null
                : op.assoc === 1
                  ? undefined
                  : { maxCount: 1, anchorCount: 2, minSimilarity: 0.3 },
            ...(op.budget ? { budget: { maxMemoryChars: op.budget } } : {}),
            ...(op.thr >= 0 ? { scoreThreshold: op.thr } : {}),
            ...(op.ch
              ? { channels: op.ch.c, text: op.ch.text }
              : op.lex
                ? { channels: ["ann", "lexical"], text: "a b" }
                : {}),
            ...(op.x
              ? {
                  ...(op.x.tw ? { timeWeighting: "eventAwareFreshness" } : {}),
                  ...(op.x.dbl > 0 ? { digestBandLimit: op.x.dbl } : {}),
                  ...(op.x.qt.length > 0 ? { tags: op.x.qt } : {}),
                  ...(op.x.rmc ? { relationMaxCount: op.x.rmc } : {}),
                }
              : {}),
          } as RecallQuery;
          const r = await (op.ch || op.lex ? rtLex : rt).recall(ctx, q);
          lastRecall = r;
          trace.push(
            JSON.stringify({
              // Issue #548 方向2 / ADR 0352: affinityMeasured: false の score には total が
              // 無い——I9（決定性）の指紋としては null で揃える（無いことも決定的なので、
              // トレースの一貫性には影響しない）。
              m: r.memories.map((x) => [
                x.memoryId,
                x.retrievedVia,
                x.score.affinityMeasured === false ? null : x.score.total,
              ]),
              o: r.omitted,
              i: r.index,
            }),
          );
          await check(r, q, oi);
          if (runOpts.snapshot) {
            snapshots.push(
              JSON.stringify(
                await normalize({
                  memories: r.memories,
                  omitted: r.omitted,
                  index: r.index,
                  // ADR 0509: `getRecall` で読み戻した `RecallRecord`（`recallId` は normalize が落とす）。
                  record: withoutBackendDependentFields(await rt.getRecall(ctx, r.recallId)),
                }),
              ),
            );
          }
          break;
        }
        case "usage": {
          if (lastRecall && lastRecall.memories.length > 0) {
            const used: MemoryId[] = lastRecall.memories
              .filter((_, i) => (op.pick >> i) & 1)
              .map((m) => m.memoryId);
            if (op.mu === "upper") {
              await countShape("usage", used[0], "upper");
              for (let u = 0; u < used.length; u++) used[u] = used[u]!.toUpperCase() as MemoryId;
            } else if (op.mu === "dead") {
              const dead = await deadNth(op.pick);
              if (dead !== undefined) used.push(dead);
              await countShape("usage", dead, "dead");
            }
            if (used.length > 0) {
              await rt.observe(ctx, {
                kind: "memory_usage",
                recallId: lastRecall.recallId,
                usedMemoryIds: used,
              });
            }
          }
          break;
        }
        case "forget": {
          const id = await target(op.k, op.i, op.mu);
          if (id) await rt.forget(ctx, { memoryId: id });
          break;
        }
        case "purge": {
          const id = await target(op.k, op.i, op.mu);
          if (id) await rt.purge(ctx, { memoryId: id });
          break;
        }
        case "restore": {
          const id = await target(op.k, op.i, op.mu);
          if (id) await rt.restoreArchived(ctx, { memoryId: id });
          break;
        }
        case "mark": {
          const a = await target(op.k, op.i, op.mu);
          const b = await target(op.k, op.j, op.mu);
          if (a && b && a !== b) await rt.markContested(ctx, a, b);
          break;
        }
        case "group": {
          const members = [...new Set([nth(op.i), nth(op.j), nth(op.l)])].filter(
            (m): m is MemoryId => m !== undefined,
          );
          if (members.length >= 3) {
            try {
              const res = await rtRel.markContestedGroup!(ctx, members);
              if (res.outcome.kind === "contested_group") groups.push(members);
            } catch (e) {
              if (!isExpectedGroupConflict(e)) throw e;
            }
          }
          break;
        }
        case "link":
        case "unlink": {
          const a = nth(op.i);
          const b = nth(op.j);
          if (a && b && a !== b) {
            const rs = stores.relationStore!;
            if (op.k === "link") await rs.link(ctx, "contradicts", a, b);
            else await rs.unlink(ctx, "contradicts", a, b);
          }
          break;
        }
        case "resolveGroup": {
          const members = groups.length > 0 ? groups[op.g % groups.length] : undefined;
          if (members) {
            try {
              await rtRel.resolveContestedGroup!(
                ctx,
                members,
                op.sup ? { kind: "supersede", winnerId: members[0]! } : { kind: "both_active" },
              );
            } catch (e) {
              if (!isExpectedGroupConflict(e)) throw e;
            }
          }
          break;
        }
        case "resolve": {
          const a = await target(op.k, op.i, op.mu);
          if (a && op.mu === "dead") {
            // 消した記憶を、対として解決しようとする（`contested` でないので、何も起きないはず）。
            const other = nth(op.i + 1);
            if (other && other !== a)
              await rt.resolveContested(
                ctx,
                a,
                other,
                op.sup ? { kind: "supersede", winnerId: a } : { kind: "both_active" },
              );
          } else if (a) {
            const m = await stores.memoryStore.get(ctx, a);
            if (m?.status === "contested" && m.contestedWithId) {
              await rt.resolveContested(
                ctx,
                a,
                m.contestedWithId,
                op.sup ? { kind: "supersede", winnerId: a } : { kind: "both_active" },
              );
            }
          }
          break;
        }
        case "consolidate": {
          const a = await target(op.k, op.i, op.mu);
          const b = await target(op.k, op.j, op.mu);
          if (a && b && a !== b) {
            const res = await rt.consolidate(ctx, { target: { memoryIds: [a, b] } });
            if (res.consolidatedMemoryId) allIds.push(res.consolidatedMemoryId);
            if (res.consolidatedMemoryId) {
              // I15（ADR 0527）: `created` の `meta.sources` は、渡された綴り（大文字でも）ではなく store の行の id（小文字）。
              const created = (
                await stores.eventStore.list(ctx, { memoryId: res.consolidatedMemoryId })
              ).find((e) => e.kind === "created");
              const srcs = (created?.meta as { sources?: unknown } | undefined)?.sources;
              if (Array.isArray(srcs))
                for (const sid of srcs)
                  if (typeof sid === "string" && sid !== sid.toLowerCase())
                    violations.push({ inv: "I15-sources-lowercase", detail: sid, op: oi });
            }
          }
          break;
        }
        case "fcc": {
          const id = await target(op.k, op.i, op.mu);
          if (id) {
            const res = await rt.findCorrectionCandidates(ctx, {
              text: "a b",
              limit: 20,
              excludeMemoryIds: [id],
            });
            // ADR 0485: 除外の突き合わせは大文字小文字を無視する。
            for (const c of res.candidates)
              if (c.memoryId.toLowerCase() === id.toLowerCase())
                violations.push({ inv: "I13-exclude", detail: `${id} が除外されていない`, op: oi });
          }
          break;
        }
        case "sweep":
          await rt.sweepArchive(ctx, { now: new Date(now), limit: 50 } as never);
          break;
        case "advance":
          now += op.hours * 3_600_000;
          break;
      }
    } catch (e) {
      violations.push({ inv: "EXCEPTION", detail: `${op.k}: ${(e as Error).message}`, op: oi });
    }
    now += step();
  }
  const finalStates: string[] = [];
  for (const id of allIds) {
    const m = await stores.memoryStore.get(ctx, id);
    finalStates.push(m ? `${m.status}${m.purgedAt ? "+purged" : ""}` : "missing");
  }
  return { violations, shapes, finalStates, trace, snapshots };
}

/** 違反の種類 `inv` が残る限り、操作を1つずつ抜いて短くする。 */
export async function minimize(
  backend: FuzzBackend,
  ops: readonly Op[],
  inv: string,
  runOpts: RunOptions = {},
): Promise<Op[]> {
  let current = [...ops];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = current.length - 1; i >= 0; i--) {
      const candidate = current.filter((_, j) => j !== i);
      const { violations } = await runOps(backend, candidate, runOpts);
      if (violations.some((x) => x.inv === inv)) {
        current = candidate;
        changed = true;
      }
    }
  }
  return current;
}

export interface FuzzSeedsOptions {
  seeds: number;
  len: number;
  /** 同じ操作列を2回流して trace を比べる（I9）。 */
  checkDeterminism: boolean;
  /** 1から数えたシードの始点（既定 1）。 */
  firstSeed?: number;
  /** 操作列の形（既定 `default`）。 */
  profile?: FuzzProfile;
}

/**
 * シードごとに操作列を流し、違反があれば最小化した操作列つきの報告を返す（空なら違反なし）。
 */
export async function fuzzSeeds(backend: FuzzBackend, opts: FuzzSeedsOptions): Promise<string> {
  const reports: string[] = [];
  const first = opts.firstSeed ?? 1;
  for (let seed = first; seed < first + opts.seeds; seed++) {
    const ops = genOps(seed, opts.len, opts.profile);
    const runOpts: RunOptions = { relations: opts.profile === "relations" };
    const firstRun = await runOps(backend, ops, runOpts);
    const violations = [...firstRun.violations];
    if (opts.checkDeterminism) {
      const second = await runOps(backend, ops, runOpts);
      const k = firstRun.trace.findIndex((t, i) => t !== second.trace[i]);
      if (k !== -1 || firstRun.trace.length !== second.trace.length) {
        violations.push({
          inv: "I9-determinism",
          detail: `recall #${k} が2回の実行で食い違った`,
          op: -1,
        });
      }
    }
    if (violations.length === 0) continue;
    const v0 = violations[0]!;
    const minimal =
      v0.inv === "I9-determinism" ? ops : await minimize(backend, ops, v0.inv, runOpts);
    reports.push(
      [
        `seed=${seed}${opts.profile === undefined || opts.profile === "default" ? "" : `（${opts.profile}）`} ${v0.inv}（op ${v0.op}）: ${v0.detail}`,
        `  ほかの違反: ${
          violations
            .slice(1)
            .map((x) => x.inv)
            .join(", ") || "なし"
        }`,
        `  最小化した操作列（${minimal.length} 操作）: ${JSON.stringify(minimal)}`,
      ].join("\n"),
    );
  }
  return reports.join("\n\n");
}

/** 1つの操作列の差分検査の結果。食い違いが無ければ `null`。 */
export interface BackendDiff {
  /** 何番目の recall で食い違ったか（0 始まり）。 */
  recall: number;
  /** 最初に食い違った場所（JSON のパス）。 */
  path: string;
  a: string;
  b: string;
}

/**
 * 数値は相対誤差 `1e-5` までを同じとみなす。pgvector はベクトルを float4 で持つので、
 * 類似度は Fake（float8）と下の桁で揺れる。
 */
function firstMismatch(a: unknown, b: unknown, path: string): string | null {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : path;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length`;
    for (let i = 0; i < a.length; i++) {
      const m = firstMismatch(a[i], b[i], `${path}[${i}]`);
      if (m !== null) return m;
    }
    return null;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const m = firstMismatch(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        `${path}.${k}`,
      );
      if (m !== null) return m;
    }
    return null;
  }
  return a === b ? null : path;
}

export interface DiffOutcome {
  diff: BackendDiff | null;
  /** 突き合わせた recall の数（打ち切った recall より前のもの）。 */
  compared: number;
}

/**
 * 差分検査のために、1つの backend へ操作列を流す（`diffRuns` に渡す `RunOutcome` を作る）。
 * 同じ `backend`・`ops`・`jitterSeed` なら同じ結果になるので、呼び出し側は結果を使い回してよい
 * （Postgres の側を seed ごとに1回だけ流し、Fake・testkit・陽性対照の相手と突き合わせる）。
 */
export function runForDiff(
  backend: FuzzBackend,
  ops: readonly Op[],
  jitterSeed: number,
  relations = false,
): Promise<RunOutcome> {
  return runOps(backend, ops, { jitterSeed, diffVectors: true, snapshot: true, relations });
}

/**
 * 2つの `runForDiff` の結果を、recall ごとの正規化した結果（`RunOutcome.snapshots`）で
 * 突き合わせる。最初に食い違った recall を返す。
 *
 * **どちらかに `lexical_truncated` が立った recall で、突き合わせを打ち切る。**語彙の窓は
 * `coverage` 降順・同値なら `rank` 降順で切るが、`rank` の尺度は adapter ごとに違う
 * （`LexicalHit.rank` の doc。Postgres は `ts_rank_cd`、Fake は出現回数）。窓が切れたとき、
 * 同じ `coverage` のどれが窓に入るかは約束の外であり、そこから先は使用報告の対象・強化・
 * 減衰を通じて状態そのものが分かれうる。
 *
 * **近似索引（HNSW）を通す backend には当てない。**窓が満杯でも近似索引は真の上位を
 * 取りこぼしうる（ADR 0193、`ann_unreached`）ので、同じ理由で食い違いが約束の内に入る。
 */
export function diffRuns(ra: RunOutcome, rb: RunOutcome): DiffOutcome {
  const n = Math.max(ra.snapshots.length, rb.snapshots.length);
  const lexicalTruncated = (x: unknown) =>
    (x as { omitted?: { kind: string }[] } | null)?.omitted?.some(
      (o) => o.kind === "lexical_truncated",
    ) ?? false;
  for (let i = 0; i < n; i++) {
    const sa = ra.snapshots[i] ?? "null";
    const sb = rb.snapshots[i] ?? "null";
    const ja = JSON.parse(sa) as unknown;
    const jb = JSON.parse(sb) as unknown;
    if (lexicalTruncated(ja) || lexicalTruncated(jb)) return { diff: null, compared: i };
    const path = firstMismatch(ja, jb, "$");
    if (path !== null) return { diff: { recall: i, path, a: sa, b: sb }, compared: i };
  }
  return { diff: null, compared: n };
}

/**
 * 陽性対照用: `aggregateScope` の `totalInScope` を1だけ多く返すように壊した `MemoryStore`。
 * 差分検査が黙って何も比べなくなる回帰を捕まえるために、相手の側へ被せる。
 */
export function breakTotalInScope(store: FuzzStores["memoryStore"]): FuzzStores["memoryStore"] {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "aggregateScope") {
        return async (...args: Parameters<FuzzStores["memoryStore"]["aggregateScope"]>) => {
          const aggregate = await target.aggregateScope(...args);
          return { ...aggregate, totalInScope: aggregate.totalInScope + 1 };
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
