import type { AbortOptions, Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";
import { runAbortable } from "@mnemora/core";
import type {
  CreateLocalEmbeddingPipeline,
  LocalEmbeddingDtype,
  LocalEmbeddingModelSpec,
  LocalEmbeddingPipeline,
} from "./pipeline.js";
import { createLocalEmbeddingPipeline } from "./pipeline.js";
import { LocalEmbeddingProviderError, isLocalEmbeddingProviderError } from "./errors.js";
import { lastTransformersCacheDir, revisionCacheRoot } from "./transformers-cache-place.js";

/**
 * `EmbeddingProvider` の**プロセス内**実装（外部サービスへ繋がない）。
 *
 * 契約は `packages/core/src/interfaces/embedding-provider.ts` のまま——
 * 1インスタンス = 1 `EmbeddingSpaceId` に固定し、次元をモデルに応じて動的に変えない。
 * このクラスはその契約に**実行時の歯**を2本足す:
 * コンストラクタでの repo/modelId 宣言食い違い検査（下記。Issue #142 / ADR 0247）と、
 * `embed()` の次元検査（下記）。前者は宣言そのものの食い違いを、後者は宣言と実物の
 * 食い違いを落とす——両者は落とすタイミングも対象も別である。
 */

/** `space.provider`。**プロセス内推論であること**を表す。 */
export const LOCAL_EMBEDDING_PROVIDER_ID = "local";

/** 既定の Hugging Face repo（ONNX 変換済みの ruri v3 30m）。 */
export const DEFAULT_LOCAL_EMBEDDING_REPO = "sirasagi62/ruri-v3-30m-ONNX";

/** 既定の dtype。重み 36MB / peak RSS 362MB はこの値での実測である。 */
export const DEFAULT_LOCAL_EMBEDDING_DTYPE: LocalEmbeddingDtype = "q8";

/** 既定の次元数。 */
export const DEFAULT_LOCAL_EMBEDDING_DIMENSIONS = 256;

/**
 * 既定の `space.model`。
 *
 * 🔴 **`/sym` を消さないこと。これは飾りではなく、再インデックスの引き金である。**
 *
 * `/sym` は「**対称 prefix**（クエリと文書に同じ prefix を付ける。ruri v3 では空文字）で
 * 作られたベクトルである」ことを表す。ruri v3 は本来
 * `検索クエリ: ` / `検索文書: ` という**非対称**の prefix を持つモデルであり、
 * reranking を入れる段でそちらへ切り替える判断はありうる。
 *
 * **そのとき、非対称 prefix で作ったベクトルと、いまの対称 prefix で作ったベクトルは
 * 同じ空間の点ではない。**`space.model` が同じままだと、`EmbeddingSpaceId` は
 * `(provider, model, dimensions)` で等しくなり、**両者が同じ space のテーブルに混ざる。**
 * 混ざったことは検索結果が少し悪くなる形でしか現れず、原因を追えない。
 *
 * `/sym` を持たせておけば、prefix 方式を変えた実装は `ruri-v3-30m/asym` のような
 * 別の `space.model` を名乗ることになり、**別 space になる ⟹ 再インデックスが強制される。**
 * 静かに壊れる代わりに、うるさく作り直させる。
 */
export const DEFAULT_LOCAL_EMBEDDING_MODEL_ID = "ruri-v3-30m/sym";

/**
 * 既定の prefix。**ruri v3 の対称 prefix は空文字である。**
 *
 * 実測: 対称 prefix（空文字）に落としても品質は有意に落ちない
 * （ΔMRR −0.031、95%CI [−0.094, +0.031] ——0 を含む）。
 */
export const DEFAULT_LOCAL_EMBEDDING_PREFIX = "";

/**
 * 既定の onnxruntime intra-op スレッド数。
 *
 * 32コア機での実測で、**既定（コア数まかせ）より速かった**: 985 文/秒 対 819 文/秒。
 * 埋め込みは他の仕事と同居するので、コア数だけスレッドを立てても
 * オーバーサブスクリプションで損をする。
 */
export const DEFAULT_LOCAL_EMBEDDING_NUM_THREADS = 4;

/**
 * 既定の最大バッチサイズ。**Issue #1141 / ADR 0358。**
 *
 * `embed(ctx, texts)` は、`texts.length` がこの値以下なら**今までどおり1回**で
 * 推論する（ビット一致）。超えたときだけ、先頭からこの件数ずつに分けて順に推論し、
 * 結果を順番どおりに連結する。
 *
 * **128 を選んだ理由**: 実測（Issue #1141、2026-09-27・2026-09-29）による——
 * 1回の `embed()` に渡す件数が増えるほど peak RSS が伸び、同じ件数でも
 * 128件ずつに分けたほうが小さくなる（例: 512件を1回で渡すと peak RSS
 * 485〜712MB・533〜897ms、128件ずつ4回に分けると 386〜490MB・484〜754ms——
 * 短文・長さの混ざった文の双方で確認した。README「良くなること」節・ADR 0358 参照）。
 * `examples/chat` の既存のベンチ（`src/bench/embedding-cache.ts` の
 * `batchSize` 既定 64、`src/bench/association-scale-bench.ts` の
 * `MNEMORA_ASSOC_SCALE_EMBED_BATCH` 既定 64）よりは大きいが、Issue 本文が
 * 例示した「2048件を128件ずつ」と同じ桁に揃えた。
 *
 * ⚠ **q8 では、バッチの長さ構成が変わると出力ベクトルがわずかに動く**
 * （ADR 0095 決定5・ADR 0099 追記・ADR 0110 §4 で実測済み）。この既定値**以下**の
 * 件数を渡す既存の呼び出し（`packages/core` の本番経路は常に1件）は、
 * この変更の前後でビット単位で変わらない——1回で推論する経路そのものを
 * 変えていないため。既定値**より多い**件数を直接 `embed()` に渡す呼び出しだけが、
 * 分割の対象になる。
 */
export const DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE = 128;

/**
 * 既定の合計試行回数（初回を含む）。**Issue #261 / ADR 0141。**
 *
 * `createPipeline`（既定は Hugging Face からの取得を含む）が「種類の付いていない」
 * 失敗（多くはネットワーク）を返したとき、この回数まで試す。
 * `1` にすると実質リトライ無し（Issue #261 が直す前の挙動）になる。
 */
export const DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS = 3;

/**
 * 既定のリトライ間隔（指数バックオフ + full jitter）。
 *
 * **なぜ jitter を掛けるか**: CI の5ジョブは同じ Hugging Face repo を同じ瞬間に
 * 取りに行きうる（`ci.yml` が5ジョブとも同じ cache key を共有している——本 ADR の
 * 「測ったこと」参照）。jitter が無いと、揃って失敗した複数ジョブが**揃って
 * 同じ瞬間に再試行し**、再び渋滞を起こしうる。`Math.random() * upper` の
 * full jitter（AWS の backoff の記事で知られる形）でそれをずらす。
 *
 * @param attempt 今回失敗した試行の番号（1始まり）。
 */
export function defaultLocalEmbeddingRetryDelayMs(attempt: number): number {
  const baseMs = 200;
  const capMs = 4_000;
  const upper = Math.min(baseMs * 2 ** (attempt - 1), capMs);
  return Math.random() * upper;
}

/**
 * モデルの読み込み（`createPipeline`）が失敗したときのリトライ設定。
 *
 * ⚠ **`kind` の付いたエラー（`errors.ts`。`input_too_long` / `unknown_input_limit`）は
 * リトライしない。**それらは入力・設定の問題であり、同じ入力で再試行しても
 * 結果は変わらない（`#startLoad` の実装を見ること）。リトライするのは
 * 「種類が分かっていない失敗」——このパッケージの経路では、その大半が
 * Hugging Face からの取得に伴うネットワークの失敗である。
 */
export interface LocalEmbeddingRetryOptions {
  /** 合計の試行回数（初回を含む）。既定 {@link DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS}。 */
  attempts?: number;
  /**
   * `attempt` 回目（1始まり、今回失敗した試行の番号）の後、次の試行まで待つ時間(ms)を返す。
   * 既定 {@link defaultLocalEmbeddingRetryDelayMs}。
   */
  delayMs?: (attempt: number) => number;
}

/** {@link LocalEmbeddingProvider} のコンストラクタに渡す設定。どれも省略でき、省くと既定のモデルを使う。 */
export interface LocalEmbeddingProviderOptions {
  /** Hugging Face の repo id。既定 `sirasagi62/ruri-v3-30m-ONNX`。 */
  repo?: string;
  /** 量子化の別。既定 `"q8"`。 */
  dtype?: LocalEmbeddingDtype;
  /** 宣言する次元数。既定 `256`。**実物と食い違えば初回 `embed()` で例外になる。** */
  dimensions?: number;
  /**
   * `space.model` に載せる文字列。既定 `"ruri-v3-30m/sym"`。
   * **prefix 方式を変えるなら、ここも変えること**（`DEFAULT_LOCAL_EMBEDDING_MODEL_ID` の説明）。
   */
  modelId?: string;
  /**
   * 全テキストの先頭に付ける文字列。既定は `""`。
   *
   * 🔴 **ここが「1本の文字列」なのは意図的である。クエリ用と文書用を分けられる形
   * （`{ query, document }`）にしてはならない。**
   *
   * 理由: `EmbeddingProvider.embed(ctx, texts)` は、渡されたテキストが**クエリなのか
   * 文書なのかを知らない。**そして、それを知っている呼び出し口
   * （`packages/core/src/recall-runtime.ts` / `runtime.ts`）は
   * この interface 越しにしか provider を触れない。
   * ⟹ 非対称 prefix を**表現できる型**にすると、「設定できるのに、どちらの prefix が
   * 使われるかは呼ばれ方次第」という、**設定した人が裏切られる形**になる。
   * 型のほうで対称性を強制して、その裏切りを起こせなくしてある。
   *
   * 非対称 prefix が本当に要るようになったら、それは `EmbeddingProvider` の契約を
   * 変える話であって、このオプションの形を変える話ではない。
   */
  prefix?: string;
  /**
   * モデルファイルの置き場所。未指定なら transformers.js の既定——`@huggingface/transformers`
   * パッケージ自身の中の `.cache/`（`node_modules/@huggingface/transformers/.cache/` など）。
   * `node_modules` を消す・入れ直すと一緒に消える。
   */
  cacheDir?: string;
  /** onnxruntime の intra-op スレッド数。既定 `4`。 */
  numThreads?: number;
  /**
   * `embed(ctx, texts)` を1回の推論に渡す最大件数。既定
   * {@link DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE}（128）。
   *
   * `texts.length` がこの値以下なら、今までどおり1回の推論で済ませる
   * （ビット一致）。超えたときだけ、先頭からこの件数ずつに分けて順に推論し、
   * 結果を順番どおりに連結する——分割すると、q8 ではベクトルがわずかに動きうる
   * （{@link DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE} の doc・ADR 0358 参照）。
   *
   * ⚠ **不正な値（`NaN`・0以下・非整数）は、`retry.attempts` と同じ流儀で
   * 素通しせずに丸める**——分割ループの刻み幅・`Array.prototype.slice` の
   * 引数に直接使うため、そのまま通すと無限ループや、テキストが静かに消える
   * 空バッチを起こしうる。`NaN`・0以下は 1（1件ずつ）に、非整数は
   * 切り捨てて使う。`Infinity` は「分割しない」として有効な値である。
   */
  maxBatchSize?: number;
  /**
   * Hugging Face の revision（枝名・tag・commit sha）。**未指定なら transformers.js の既定
   * （`"main"`）のままで、この option を足す前と同じ呼び出しになる**（Issue #597）。
   *
   * ⚠ **渡したときの実挙動は、本物のモデルを落として確かめていない。**
   * ⚠ **キャッシュ鍵（ADR 0263）と、読み込んだ重みの指紋の照合（ADR 0253）が、固定した
   * revision をどう扱うかは決めていない**（Issue #597 の「先に決めるべきこと」のうち、
   * 決めたのは「既定値は変えない」だけである）。
   */
  revision?: string;
  /**
   * モデルを読み込む関数。**テストで本物のモデルを落とさないための注入点である**
   * （`packages/openai` の `client` と同じ役目）。未指定なら transformers.js を使う。
   */
  createPipeline?: CreateLocalEmbeddingPipeline;
  /**
   * モデルの読み込みが失敗したときのリトライ設定。**Issue #261 / ADR 0141。**
   * 既定は {@link DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS} 回・
   * {@link defaultLocalEmbeddingRetryDelayMs} のバックオフ。
   */
  retry?: LocalEmbeddingRetryOptions;
  /**
   * リトライの待ち時間を実際に待つ関数。**テスト用の注入点**（`createPipeline` と同じ役目
   * ——待たずに何度も失敗させるテストが、実時間を消費しないようにする）。
   * 未指定なら `setTimeout` を使う本物の待ちになる。
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `EmbeddingProvider` のプロセス内実装（外部サービスへ繋がない）。既定は `ruri-v3-30m/sym`・256次元・q8。
 * 契約と実行時の歯（宣言の食い違いの検査・次元の検査）は、このファイルの冒頭の doc を見ること。
 *
 * `new` はモデルを読まない。読むのは最初の `embed()`（または `warmup()`）で、初回だけネットワークが要る。
 * 構築時: `repo` だけを差し替えて `modelId` を省くと例外を投げる（宣言の食い違い。Issue #142 / ADR 0247）。
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  /**
   * ⭐ **コンストラクタで同期に確定し、凍結する。**
   *
   * モデルの読み込み（`pipeline()`）は非同期だが、**`space` の確定はそれを待たない。**
   * `space` は `(provider, model, dimensions)` という**宣言**であり、モデルから
   * 読み取った値ではない。⟹ `new` した直後に `provider.space` を読んで
   * ベクトル空間のテーブルを用意する呼び出し側が、そのまま動く。
   *
   * 凍結するのは、`EmbeddingSpaceId` がテーブル名スラグの導出元
   * （`docs/memory-model.md`）だからである。**走っている途中で書き換えられると、
   * 同じインスタンスが2つの space へ書く。**
   */
  readonly space: EmbeddingSpaceId;

  readonly #spec: LocalEmbeddingModelSpec;
  readonly #prefix: string;
  readonly #createPipeline: CreateLocalEmbeddingPipeline;
  readonly #retryAttempts: number;
  readonly #retryDelayMs: (attempt: number) => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxBatchSize: number;

  /**
   * ⭐ **読み込み中／読み込み済みの Promise そのものを握る**（`LocalEmbeddingPipeline` ではなく）。
   *
   * **なぜ Promise を握るか（実測で踏んだ穴）**: 「読み込み済みの pipeline」だけを持って
   * `if (this.#pipeline) ... else await load()` と書くと、**同時に来た `embed()` が
   * 全員 `else` に入り、全員が別々にモデルを読み込む。**8本並行で 8回読み込み、
   * 557ms / 406MB が **3,138ms / 1,009MB** になることを実測している。
   * Promise を握れば、2本目以降は同じ Promise を await するだけになる。
   *
   * 失敗したら `null` へ戻す——**失敗した Promise を握り続けると、
   * 一度の一時的な失敗が、そのインスタンスを永久に使えなくする。**
   */
  #ready: Promise<LocalEmbeddingPipeline> | null = null;

  /** `dispose()` が呼ばれたら以後 `true`（戻らない）。ADR 0419。 */
  #disposed = false;
  /** 最初の `dispose()` の Promise。2回目以降は同じものを返す（上流の dispose を1回に畳む）。 */
  #disposing: Promise<void> | null = null;
  /** 走っている `embed()`。`dispose()` はこれが終わるのを待ってから上流を解放する。 */
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(options: LocalEmbeddingProviderOptions = {}) {
    // ⭐ **宣言（repo と modelId）が食い違ったまま space が確定するのを、ここで落とす。**
    //
    // `embed()` の次元検査（このファイル下部、`vector.length !== this.space.dimensions`）は
    // **宣言した次元と実物が食い違ったとき**にしか鳴らない歯である。**あちらは次元が
    // 変わったときしか鳴らない。**⟹ 次元が同じまま重みだけ入れ替わる場合
    // （`repo` だけ差し替えて `modelId` は既定のまま、という組み合わせ）は、あちらを
    // 素通りする。**ここはその手前——宣言そのものの食い違いを、`embed()` を待たずに
    // コンストラクタで落とす。**
    //
    // 下の `this.space = Object.freeze(...)` が示す通り、`space.model` は
    // `options.modelId` からしか作られず、**`options.repo` は一度も効かない。**
    // ⟹ 採用者が `repo` だけ差し替えると、別のモデルのベクトルが同じ space
    // （`EmbeddingSpaceId`、テーブル名スラグの導出元）へ静かに混ざる。
    // 混ざったものは後から分けられない。
    //
    // 逃げ道は残す: `modelId` を明示すれば通る（同じ重みの私設ミラーを使う場合など、
    // 「何を名乗るか」を宣言させる契約である）。
    // ⛔ `dtype` はここでは対象にしない（この PR の範囲外。ADR 0247 に負債として記録）。
    if (
      options.repo !== undefined &&
      options.repo !== DEFAULT_LOCAL_EMBEDDING_REPO &&
      options.modelId === undefined
    ) {
      throw new Error(
        `LocalEmbeddingProvider: repo に既定（${DEFAULT_LOCAL_EMBEDDING_REPO}）と異なる値` +
          `（${options.repo}）が渡されたが、modelId は指定されていない` +
          `（既定の ${DEFAULT_LOCAL_EMBEDDING_MODEL_ID} のまま）。` +
          `space.model は modelId からしか作られず repo は反映されないため、このままでは` +
          `別モデルのベクトルが同じ space（EmbeddingSpaceId。テーブル名スラグの導出元）へ` +
          `混ざる——混ざったものは後から分けられない。` +
          `options.modelId に、そのモデルを名乗る別の id を渡すこと` +
          `（同じ重みの私設ミラーであれば、既定と同じ modelId` +
          `（${DEFAULT_LOCAL_EMBEDDING_MODEL_ID}）を明示的に渡せば通る）。`,
      );
    }

    this.#spec = Object.freeze({
      repo: options.repo ?? DEFAULT_LOCAL_EMBEDDING_REPO,
      dtype: options.dtype ?? DEFAULT_LOCAL_EMBEDDING_DTYPE,
      cacheDir: options.cacheDir,
      numThreads: options.numThreads ?? DEFAULT_LOCAL_EMBEDDING_NUM_THREADS,
      revision: options.revision,
    });
    this.#prefix = options.prefix ?? DEFAULT_LOCAL_EMBEDDING_PREFIX;
    this.#createPipeline = options.createPipeline ?? createLocalEmbeddingPipeline;
    // `Math.max(1, ...)`: 0回以下の指定を「1回（実質リトライ無し）」に丸める。
    // 「一度も試さない」は #startLoad の for ループの前提を壊すので許さない。
    // ⚠ `NaN` は `Math.max(1, NaN) === NaN` になり同じ前提を壊す（`for (attempt = 1;
    // attempt <= NaN; …)` が一度も回らない）ので、0回以下と同じく1回に丸める。
    const rawRetryAttempts = options.retry?.attempts ?? DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS;
    this.#retryAttempts = Number.isNaN(rawRetryAttempts) ? 1 : Math.max(1, rawRetryAttempts);
    this.#retryDelayMs = options.retry?.delayMs ?? defaultLocalEmbeddingRetryDelayMs;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // ⭐ `retry.attempts` と同じ流儀で、0以下・NaN は「分割ループが前進できる」
    // 最小値 1（1件ずつ）に丸める——素通しすると `slice(i, i + maxBatchSize)` が
    // 無限ループ（0以下）や静かな空バッチ（NaN）を起こす。`retry.attempts` と
    // 違い、非整数（例: 128.7）は `Math.floor` で切り捨てる——こちらはループの
    // 刻み幅・`slice` の引数に直接使うため、整数に揃えておかないと `i +=
    // maxBatchSize` の蓄積が範囲を跨いで半端な位置で区切ってしまう
    // （`retry.attempts` は上限との `<=` 比較にしか使わないので、その心配が無い）。
    // `Infinity` は「分割しない」を表す有効な値としてそのまま通す
    // （`Math.floor(Infinity) === Infinity`、`Math.max(1, Infinity) === Infinity`）。
    const rawMaxBatchSize = options.maxBatchSize ?? DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE;
    this.#maxBatchSize = Number.isNaN(rawMaxBatchSize)
      ? 1
      : Math.max(1, Math.floor(rawMaxBatchSize));
    this.space = Object.freeze({
      provider: LOCAL_EMBEDDING_PROVIDER_ID,
      model: options.modelId ?? DEFAULT_LOCAL_EMBEDDING_MODEL_ID,
      dimensions: options.dimensions ?? DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
    });
  }

  /**
   * モデルを先に読み込んでおく。**契約（`EmbeddingProvider`）には無い追加のメソッドである。**
   *
   * **なぜ要るか**: `embed(ctx, [])` は `[]` を即返すので（`packages/openai` と同じ）、
   * **空配列ではウォームアップできない。**かといってウォームアップのために
   * 意味の無い文字列を1件埋め込ませるのは、呼び出し側に「どんな文字列なら安全か」を
   * 考えさせる。ここに名前を付けておけば、最初の実リクエストが
   * 557ms のロードを被る形を避けられる。
   *
   * ⚠ **これはモデルの読み込みだけを済ませる。**推論そのものは一度も走らせない
   * （初回推論のグラフ確保ぶんは残る）。ここで適当な文字列を1件通すことも考えたが、
   * **「ウォームアップしただけのつもりが、モデルへ勝手な入力が流れる」**ほうが
   * 説明しづらいと判断した。
   *
   * **読み込みに失敗すると reject する**（`embed()` が初回にモデルを読むときと同じ）。
   * `retry` の回数を使い切ると、元の例外を `cause` に持つ `Error`（repo・dtype・cacheDir と
   * 再変換の手がかりをメッセージに載せる）になる。種類の付いた失敗
   * （`LocalEmbeddingProviderError`。例: `kind: "unknown_input_limit"`）は、リトライも包みも
   * せずにそのまま投げる。
   */
  async warmup(): Promise<void> {
    this.#assertNotDisposed("warmup");
    await this.#load();
  }

  /**
   * 保持しているモデル（pipeline）を手放す。**任意の口**であり、`EmbeddingProvider` interface には無い
   * （[ADR 0419](../../../docs/decisions/0419-local-embedding-provider-dispose.md)）。
   *
   * - 上流（`@huggingface/transformers`）の `dispose()` に委ねる。pipeline が `dispose` を持たなければ何もしない。
   * - 一度も読み込んでいなければ何もしない（読み込みも起こさない）。
   * - **読み込み中・推論中なら、それらが終わるのを待ってから**解放する（漏らさない）。読み込みが失敗していたら、
   *   解放するものが無いので reject しない。
   * - 2回以上呼んでもよい。2回目以降は最初と同じ Promise を返し、上流の `dispose()` は1回しか呼ばない。
   * - 呼んだ時点から、`embed()` / `warmup()` は reject する（{@link LocalEmbeddingProvider.embed} を見ること）。
   * - 上流の `dispose()` が reject したら、この Promise も同じ理由で reject する。
   */
  dispose(): Promise<void> {
    if (this.#disposing === null) {
      // 同期に立てる: 以後の embed / warmup は、解放の完了を待たずに断られる。
      this.#disposed = true;
      this.#disposing = this.#release();
    }
    return this.#disposing;
  }

  async #release(): Promise<void> {
    const ready = this.#ready;
    if (ready === null) {
      return;
    }
    let pipeline: LocalEmbeddingPipeline;
    try {
      pipeline = await ready;
    } catch {
      return; // 読み込みに失敗した——解放するものが無い。
    }
    // 走っている推論の足元から解放しない。終わり方（成功か失敗か）は問わない。
    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight]);
    }
    this.#ready = null;
    await pipeline.dispose?.();
  }

  #assertNotDisposed(method: string): void {
    if (this.#disposed) {
      throw new Error(
        `LocalEmbeddingProvider: dispose() 済みのため ${method}() できない。` +
          `dispose() はモデルを手放す一方向の操作で、同じインスタンスでは読み込み直さない` +
          `（続けるなら新しい LocalEmbeddingProvider を作ること）`,
      );
    }
  }

  /**
   * `texts` を埋め込み、入力と同じ件数・順で返す。空配列ならモデルを読まずに `[]` を返す。
   *
   * 投げるもの（どれも reject として届く）:
   * - {@link LocalEmbeddingProvider.dispose} の後は、入力に関わらず（空配列でも）素の `Error`（ADR 0419）。
   * - モデルの読み込みの失敗は {@link LocalEmbeddingProvider.warmup} と同じ。
   * - 既定の pipeline（`createPipeline` を省いたとき。`buildLocalEmbeddingPipeline` で組み立てた pipeline も同じ）では、
   *   入力がモデルの上限トークン数を超えれば、`kind: "input_too_long"` の `LocalEmbeddingProviderError`
   *   （推論の前に検査する。切り詰めない）。⚠ **このクラス自身は上限を検査しない**——`createPipeline` で差し替えた
   *   pipeline の `maxInputTokens`・`countTokens` は読まない。差し替えた pipeline では、上限を守るのはその `embed` の責任である。
   * - 返ったベクトルの件数が `texts` と違う・次元が `space.dimensions` と違う・有限でない成分を含むときは、素の `Error`。
   *
   * ⚠ **2026-09-29 追記（[Issue #1200](https://github.com/takecchi/mnemora/issues/1200)、
   * [ADR 0359](../../../docs/decisions/0359-abort-signal-for-provider-calls.md)）: `opts?.signal`
   * を受け取るが、`@huggingface/transformers` のパイプライン呼び出し自体を中断する口を
   * 持たないため、**推論の途中では止まらない**。** このクラスがすることは、モデルの
   * 読み込みの前後・推論（`pipeline.embed`、下の分割の有無に関わらず）の前後で
   * `signal.throwIfAborted()` 相当を確かめるだけであり、推論そのものは最後まで走る
   * ——`signal` が途中で abort されても、推論が終わるまでは待ち、終わった時点で abort
   * 済みなら、ベクトルを**返さずに**投げ直す（reject の値は `signal.reason`）。
   * `packages/core` 側は runtime 自身が provider の Promise と abort を競わせる
   * （`runAbortable`）ため、runtime 経由の呼び出しはこの提供元の対応と無関係に中断が
   * 効く——この対応が意味を持つのは、この provider を `packages/core` を介さず直接呼ぶ
   * 呼び出し側にとってである。
   *
   * ⚠ **2026-09-30 追記（ADR 0428）: モデルの読み込み中・読み込みの再試行の待ち（`retry` の `sleep` を含む）も、
   * `signal` ごとに切れる。** abort された呼び出しは、読み込みの完了を待たずに `signal.reason`（`abortReason(signal)`）で
   * 即座に reject する。**ただし読み込みそのものは abort で止まらない**——複数の `embed()`・`warmup()` が待つ共有の読み込み
   * （と、その中の再試行）は続き、切れるのは abort された呼び出しの「待ち」だけである。ある呼び出しの abort が、
   * 同じ読み込みを待つ別の呼び出しを巻き添えにしない。全員が abort しても、読み込みは終わりまで走り、
   * 成功すればモデルは保持されて次の `embed()` が使う。`warmup()` は `signal` を取らない（待ちは切れない）。
   *
   * ⭐ **`texts.length` が `maxBatchSize`（既定 {@link DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE}）
   * 以下なら、今までどおり1回の `pipeline.embed()` で済ませる（ビット一致）。**超えたときだけ、
   * 先頭から `maxBatchSize` 件ずつに分けて順に（直列で）推論し、結果を順番どおりに連結する
   * （Issue #1141 / ADR 0358）。prefix の付与・上限トークン数の検査の順序は変わらない
   * ——分割するかどうかを決める前に、まず `texts` 全体に prefix を付ける。
   */
  async embed(_ctx: Ctx, texts: string[], opts?: AbortOptions): Promise<number[][]> {
    // ⭐ dispose 済みの断りは、入力の検査（空配列の早期 return・abort 済み signal）より**前**に置く
    // （ADR 0419）。使い終わったものを使っている、というプログラムの誤りは、入力が空でも
    // 検査より先に見せる——空配列だけ通ると、誤りが特定の入力のときだけ隠れる。
    this.#assertNotDisposed("embed");
    const running = this.#embed(texts, opts);
    this.#inflight.add(running);
    try {
      return await running;
    } finally {
      this.#inflight.delete(running);
    }
  }

  async #embed(texts: string[], opts?: AbortOptions): Promise<number[][]> {
    // `packages/openai` と同じ早期 return。**空でモデルを起こさない。**
    // ⟹ ウォームアップは `warmup()` を使うこと。
    if (texts.length === 0) {
      return [];
    }
    opts?.signal?.throwIfAborted();

    // ⭐ 待ちだけを signal ごとに切る（ADR 0428）。`#load()` 自体（共有の読み込み・再試行）は止めない。
    const pipeline = await runAbortable(opts?.signal, () => this.#load());
    opts?.signal?.throwIfAborted();

    // ⭐ **prefix が空でも、必ず新しい配列を作る**（`this.#prefix === "" ? texts : ...` と
    // 分岐して素通しにしない）。
    //
    // **なぜ**: 素通しにすると、**呼び出し側が渡した配列そのものが `createPipeline` の
    // 先へ渡る。**注入された pipeline がそれを書き換えると、呼び出し側の配列が変わる。
    // 実際に、書き換える pipeline を注入して確かめた——**既定（prefix が空）でだけ
    // 呼び出し側の配列が壊れ、prefix を設定したときは壊れなかった。**
    // ⟹ **振る舞いが設定に依存して変わり、しかも壊れるほうが既定だった。**
    //
    // 分岐を消して、経路を1本にしてある。`"" + text` は元の文字列そのものなので、
    // 増えるのは配列1本の確保だけで、その費用は推論の前では見えない。
    const prefixed = texts.map((text) => this.#prefix + text);
    // ⭐ 件数が maxBatchSize 以下なら、今までどおり1回で丸ごと渡す（ビット一致）。
    // 超えたときだけ #embedInChunks に回す——分岐の片方は今日の呼び出しと1バイトも
    // 変わらない（同じ関数を、同じ引数で、同じ経路で呼ぶ）。
    const vectors =
      prefixed.length <= this.#maxBatchSize
        ? await pipeline.embed(prefixed)
        : await this.#embedInChunks(pipeline, prefixed);
    // 推論は最後まで走らせた（分割していても、上の doc コメントの追記のとおり）。
    // ここで abort 済みなら、出来上がったベクトルを返さずに投げ直す。
    opts?.signal?.throwIfAborted();

    // ⭐ 件数の一致だけは確かめる。
    //
    // `packages/openai` は応答の `index` で並べ直して「順序は保たれる」という前提を
    // 作らないようにしている。ここには `index` に当たるものが無いので、順序までは
    // 確かめようがない——**確かめられるもの（件数）だけを確かめ、確かめていないことは
    // 確かめていないと書く。**件数が合っていないベクトルを黙って返すと、
    // 呼び出し側で memory とベクトルが1つずれて対応する。
    if (vectors.length !== texts.length) {
      throw new Error(
        `LocalEmbeddingProvider: ${texts.length} 件のテキストに対して ` +
          `${vectors.length} 件のベクトルが返った（${this.#spec.repo}）`,
      );
    }

    // ⭐ 宣言した次元と実物の食い違いを、ここで落とす。
    //
    // `interfaces/embedding-provider.ts` の「次元をモデルに応じて動的に変える実装は
    // 許容しない」を**実行時に守らせる歯**である。repo を差し替えた・dtype を変えたら
    // 次元が違った、を**黙って通すと、宣言と中身が食い違ったまま DB へ入る**
    // （`EmbeddingSpaceId` はテーブル名スラグの導出元なので、後から気づいても
    // 混ざったものは分けられない）。
    for (const [index, vector] of vectors.entries()) {
      if (vector.length !== this.space.dimensions) {
        throw new Error(
          `LocalEmbeddingProvider: 宣言した次元数 ${this.space.dimensions} に対して、` +
            `モデル（${this.#spec.repo} / dtype=${this.#spec.dtype}）が返したベクトルは ` +
            `${vector.length} 次元だった（${index} 番目）。` +
            `options.dimensions を実物に合わせるか、repo を見直すこと`,
        );
      }
      // ⭐ Issue #992: 成分が有限の数であることも、同じ位置で確かめる。
      //
      // 適合テスト（`describeEmbeddingProviderConformance`）は「ベクトルの各成分は有限の数
      // である」を provider の要件にしている。`toVectors`（`pipeline.ts`）は
      // `typeof value === "number"` しか見ないので、NaN / Infinity はそこを素通りする。
      // 黙って返すと、pgvector への書き込み（`NaN not allowed in vector` /
      // `infinite value not allowed in vector`）で初めて失敗し、原因（埋め込み）から離れた
      // SQL の失敗として現れる。注入された pipeline の出力を信じない、という点で
      // 上の次元の検査と同じ歯である（ADR 0205 の 2026-09-27 追記）。
      const nonFinite = vector.findIndex((component) => !Number.isFinite(component));
      if (nonFinite !== -1) {
        throw new Error(
          `LocalEmbeddingProvider: モデル（${this.#spec.repo} / dtype=${this.#spec.dtype}）が` +
            `返したベクトルに有限でない成分がある（${index} 番目のベクトルの ${nonFinite} 番目の` +
            `成分が ${String(vector[nonFinite])}）。この値は埋め込みとして保存できない` +
            `（pgvector は NaN / Infinity を拒否する）`,
        );
      }
    }

    return vectors;
  }

  /**
   * `prefixed`（既に prefix を付けた配列）を、先頭から `#maxBatchSize` 件ずつに分けて
   * **直列で**（`Promise.all` にしない）順に推論し、結果を順番どおりに連結する。
   *
   * ⛔ **直列にする理由**: 並列にすると、onnxruntime のセッションに複数の推論が
   * 同時に走る——スレッド（`numThreads`）の奪い合いで速くなる保証が無く、
   * かつ「RSS を抑える」という本来の目的（Issue #1141）と衝突する
   * （複数バッチ分のメモリを同時に確保することになる）。
   *
   * ⚠ **`kind: "input_too_long"` の例外は、`detail.index` をこのチャンクの
   * 開始位置ぶんだけ足し戻してから投げ直す。**`pipeline.embed()` は「渡された
   * 配列の何番目か」しか知らない（`errors.ts` の doc）——分割すると、そのままでは
   * 2個目以降のチャンクで「バッチ内の位置」が返り、`embed(ctx, texts)` の契約
   * （「渡した配列全体での位置」）と食い違う。
   */
  async #embedInChunks(pipeline: LocalEmbeddingPipeline, prefixed: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < prefixed.length; offset += this.#maxBatchSize) {
      const chunk = prefixed.slice(offset, offset + this.#maxBatchSize);
      let chunkVectors: number[][];
      try {
        chunkVectors = await pipeline.embed(chunk);
      } catch (error) {
        throw rebaseInputTooLongIndex(error, offset);
      }
      vectors.push(...chunkVectors);
    }
    return vectors;
  }

  /**
   * 読み込みを1回に畳む。**同期の関数である**（`async` にしない）——
   * `#ready` の確認と代入の間に await が入ると、そこが競合の窓になる。
   */
  #load(): Promise<LocalEmbeddingPipeline> {
    const existing = this.#ready;
    if (existing !== null) {
      return existing;
    }
    const pending = this.#startLoad();
    this.#ready = pending;
    // 失敗した Promise を握り続けない。**自分が入れたものだけを消す**——
    // 失敗が返ってくる頃に別の読み込みが始まっていたら、そちらを巻き添えにしない。
    pending.catch(() => {
      if (this.#ready === pending) {
        this.#ready = null;
      }
    });
    return pending;
  }

  /**
   * `createPipeline` を呼ぶ薄い層。3つのことをする。
   *
   * 1. **同期の throw を reject に均す**（`async` 関数なのでこれは自動で起きる）。
   * 2. **種類の分かっていない失敗を、バックオフを挟んで数回まで再試行する**
   *    （**Issue #261 / ADR 0141**。下記）。
   * 3. **リトライを使い切っても失敗したら、包んで、次に何ができるかを一緒に投げる**（下記）。
   *
   * ⚠ **ここでのリトライは「1回の `#load()` の中で完結する」。**`#ready` を
   * 握ったまま数回試す——`#ready` を早々に `null` へ戻して次の `embed()` 呼び出しに
   * 再試行を委ねる既存の仕組み（クラス doc の `#ready` を参照）とは別の層である。
   * 両方が要る理由: こちらは「一時的な失敗を、呼び出し側に一度も見せずに吸収する」ため
   * （Issue #261 が直した対象）。既存の仕組みは「リトライを使い切って本当に失敗したとき、
   * インスタンスを壊れたままにしない」ためであり、今回変えていない。
   */
  async #startLoad(): Promise<LocalEmbeddingPipeline> {
    let lastError: unknown;
    // メッセージには、実際に試した回数（整数）を載せる。`retry.attempts` に整数でない値
    // （例: 2.5）が渡ると、下のループは切り捨てた回数だけ回るので、設定値をそのまま書くと食い違う。
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= this.#retryAttempts; attempt += 1) {
      attemptsMade = attempt;
      try {
        return await this.#createPipeline(this.#spec);
      } catch (error) {
        // 🔴 **種類の付いた失敗はリトライしない・包まない**（ADR 0090 / ADR 0141）。
        //
        // `input_too_long` / `unknown_input_limit` は入力・設定の問題であり、
        // **同じ入力でもう一度試しても結果は変わらない**——リトライは無駄な待ち時間を
        // 足すだけである。`describeLoadFailure` が足す文面（「repo が消えたなら
        // 再変換できる」）も `unknown_input_limit` に対しては嘘の助言になるため、
        // 包まずにそのまま投げる（ここは Issue #261 より前からの決定を変えていない）。
        if (isLocalEmbeddingProviderError(error)) {
          throw error;
        }
        lastError = error;
        // 次の試行があるときだけ待つ。`attempt < this.#retryAttempts` と書くと、整数でない
        // `retry.attempts`（例: 2.5）では最後の試行（2回目）の後にも待ってしまう。
        if (attempt + 1 <= this.#retryAttempts) {
          await this.#sleep(this.#retryDelayMs(attempt));
        }
      }
    }
    // 実際の置き場所を名指せるのは、既定の `createPipeline` が transformers.js を読み込んだときだけである
    // （注入された `createPipeline` がどこに置くかは、このクラスには分からない）。
    const defaultCacheDir =
      this.#createPipeline === createLocalEmbeddingPipeline
        ? lastTransformersCacheDir()
        : undefined;
    throw new Error(describeLoadFailure(this.#spec, attemptsMade, defaultCacheDir), {
      cause: lastError,
    });
  }
}

/**
 * `#embedInChunks` が捕まえた例外を、投げ直す前に**チャンクの開始位置ぶんだけ**
 * `index` を足し戻す（Issue #1141 / ADR 0358）。
 *
 * ⚠ **`kind: "input_too_long"` 以外はそのまま投げ直す。**種類の分かっていない失敗
 * （ネットワーク断など、チャンク単位の推論そのものが失敗した場合）に `index` の
 * 概念は無く、触るべきではない。
 *
 * **メッセージの数字だけを機械的に差し替え、それ以外の文面は複製しない**
 * （`pipeline.ts` の `embed` が組み立てるメッセージ全体を書き写すと、
 * 片方だけ直して他方を直し忘れる腐り方をする）。
 */
function rebaseInputTooLongIndex(error: unknown, chunkOffset: number): unknown {
  if (
    !isLocalEmbeddingProviderError(error) ||
    error.kind !== "input_too_long" ||
    error.detail === null
  ) {
    return error;
  }
  const globalIndex = error.detail.index + chunkOffset;
  return new LocalEmbeddingProviderError(
    "input_too_long",
    error.message.replace(
      /^LocalEmbeddingProvider: \d+ 番目/,
      `LocalEmbeddingProvider: ${globalIndex} 番目`,
    ),
    { ...error.detail, index: globalIndex },
    { cause: error },
  );
}

/**
 * モデルの読み込みに失敗したときのメッセージを組み立てる。
 *
 * 🔴 **なぜ素の例外をそのまま投げないか。**
 *
 * 既定の repo（`sirasagi62/ruri-v3-30m-ONNX`）は**個人の変換 repo** であり、
 * **消えうる**。それを承知でこのモデルを選べているのは、
 * **元モデルが公式（`cl-nagoya/ruri-v3-30m`, apache-2.0）で、ONNX 変換を
 * 自分でやり直せる**からである。
 *
 * ⟹ **その「やり直せる」が、必要になった人に届かなければ、選択の前提が成立しない。**
 * そして届く先は doc ではない——repo が消えた人が最初に見るのは、
 * transformers.js が投げる素の 404 である。**だからここに書く。**
 *
 * ⚠ **元の例外は `cause` に必ず残す。**ネットワーク断・repo 消滅・dtype 名の間違いは
 * 別の問題であり、包んだ文面だけになると区別が付かなくなる。
 * ここで足しているのは「次に何ができるか」だけで、**何が起きたかは cause の側にある。**
 */
/**
 * `cacheDir` を省いたとき、実際の置き場所が分からない場合の表記。**特定の場所を断言しない。**
 * 置き場所はパッケージマネージャの配置で変わる（npm と pnpm で違う。`transformers-cache-place.ts`）。
 * 【実測 2026-09-27】以前はここを npm の配置 `node_modules/@huggingface/transformers/.cache/` で
 * 決め打ちしており、pnpm の利用者には無い場所を指していた。
 */
const UNKNOWN_TRANSFORMERS_CACHE_PLACE =
  "transformers.js の env.cacheDir（`@huggingface/transformers` パッケージの中の `.cache/`。実際の場所はパッケージマネージャの配置による）";

/**
 * @param defaultCacheDir `cacheDir` を省いたときに transformers.js が解決した置き場所
 *   （既定の `createPipeline` が記録した `env.cacheDir`）。分からなければ `undefined`。
 */
function describeLoadFailure(
  spec: LocalEmbeddingModelSpec,
  attemptsMade: number,
  defaultCacheDir: string | undefined,
): string {
  const where =
    spec.cacheDir !== undefined
      ? `cacheDir=${spec.cacheDir}`
      : `cacheDir=未指定（transformers.js の既定: ${defaultCacheDir ?? UNKNOWN_TRANSFORMERS_CACHE_PLACE}）`;
  // 【実測 2026-09-27】キャッシュのファイルが壊れていると（取得の中断など）、再試行を使い切っても、
  // 次のプロセスでも同じように落ち続ける。消せば次の読み込みで取り直すので、消す場所を名指す。
  // Issue #1403: `revision` を渡したときは、既定の `createPipeline` が根を `<根>/<revision>` に分ける。
  const baseCacheRoot = spec.cacheDir ?? defaultCacheDir;
  const cacheRoot =
    baseCacheRoot !== undefined && spec.revision !== undefined
      ? revisionCacheRoot(baseCacheRoot, spec.revision)
      : baseCacheRoot;
  const repoCache =
    cacheRoot !== undefined
      ? `${cacheRoot.replace(/[\\/]+$/, "")}/${spec.repo}`
      : `${UNKNOWN_TRANSFORMERS_CACHE_PLACE} の下の ${spec.repo}`;
  // attemptsMade <= 1 のときは「1回試した」と言っても情報が増えないので黙る
  // （リトライを無効化した呼び出し側・既存のテストの文面と揃える）。
  const attemptsNote = attemptsMade > 1 ? `${attemptsMade} 回試したが取得できなかった。` : "";
  return (
    `LocalEmbeddingProvider: モデルを読み込めなかった` +
    `（repo=${spec.repo} / dtype=${spec.dtype} / ${where}）。${attemptsNote}` +
    `原因は cause を見ること——ネットワーク断・repo の消滅・dtype 名の誤り・キャッシュのファイルの破損は別の問題である。` +
    ` キャッシュのファイルが壊れている場合（取得の中断など。cause が Protobuf や JSON の解析の失敗になる）:` +
    `同じ場所から何度読んでも失敗する。 ${repoCache} を消すと、次の読み込みで取り直す。` +
    ` repo が取得できなくなっている場合: 元モデルは公式の cl-nagoya/ruri-v3-30m（apache-2.0）` +
    `であり、ONNX への変換は自分でやり直せる。変換したものは options.repo に指し、options.modelId に` +
    `そのモデルを名乗る id を渡すことで使える（別の変換先でも、自分で変換したものでもよい。repo だけを差し替えると` +
    `構築時に例外になる）。` +
    ` 手順は @mnemora/local-embedding の README「モデルが取得できなくなったら（再変換の手順）」にある`
  );
}
