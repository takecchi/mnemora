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
import { assertNotInfinite, assertPositiveSafeInteger } from "./option-check.js";
import { lastTransformersCacheDir, revisionCacheRoot } from "./transformers-cache-place.js";

/** `space.provider`。**プロセス内推論であること**を表す。 */
export const LOCAL_EMBEDDING_PROVIDER_ID = "local";

/** 既定の Hugging Face repo（ONNX 変換済みの ruri v3 30m）。 */
export const DEFAULT_LOCAL_EMBEDDING_REPO = "sirasagi62/ruri-v3-30m-ONNX";

/** 既定の dtype。 */
export const DEFAULT_LOCAL_EMBEDDING_DTYPE: LocalEmbeddingDtype = "q8";

/** 既定の次元数。 */
export const DEFAULT_LOCAL_EMBEDDING_DIMENSIONS = 256;

/**
 * 既定の `space.model`。
 *
 * `/sym` を消さないこと。対称 prefix で作ったベクトルであることを表し、非対称 prefix へ切り替えた
 * 実装が別の `space.model` を名乗ることで、別 space になって再インデックスが強制される。
 * 同じ名前のままだと、互換のないベクトルが同じ space に混ざる。
 */
export const DEFAULT_LOCAL_EMBEDDING_MODEL_ID = "ruri-v3-30m/sym";

/** 既定の prefix。ruri v3 の対称 prefix は空文字。 */
export const DEFAULT_LOCAL_EMBEDDING_PREFIX = "";

/** 既定の onnxruntime intra-op スレッド数。コア数まかせより少ないほうが速かった。 */
export const DEFAULT_LOCAL_EMBEDDING_NUM_THREADS = 4;

/**
 * 既定の最大バッチサイズ。`texts.length` がこの値以下なら 1 回で推論する（ビット一致）。
 *
 * ⚠ q8 ではバッチの長さ構成が変わると出力ベクトルがわずかに動く。分割の対象は、この値より多い件数を
 * 直接 `embed()` に渡す呼び出しだけである。
 */
export const DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE = 128;

/** 既定の合計試行回数（初回を含む）。`1` にすると実質リトライ無し。 */
export const DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS = 3;

/**
 * 既定のリトライ間隔（指数バックオフ + full jitter）。
 * jitter を掛けるのは、同じ repo を同時に取りに行った複数のジョブが揃って再試行するのを避けるため。
 *
 * @param attempt 今回失敗した試行の番号（1始まり）。
 */
export function defaultLocalEmbeddingRetryDelayMs(attempt: number): number {
  const baseMs = 200;
  const capMs = 4_000;
  const upper = Math.min(baseMs * 2 ** (attempt - 1), capMs);
  return Math.random() * upper;
}

/** モデルの読み込み（`createPipeline`）が失敗したときのリトライ設定。`kind` の付いたエラーはリトライしない。 */
export interface LocalEmbeddingRetryOptions {
  /**
   * 合計の試行回数（初回を含む）。既定 {@link DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS}。
   * `±Infinity` は構築時に `RangeError`。`NaN`・0以下は 1 に丸め、小数は切り捨てる。
   */
  attempts?: number | undefined;
  /**
   * `attempt` 回目（1始まり、今回失敗した試行の番号）の後、次の試行まで待つ時間(ms)を返す。
   * 既定 {@link defaultLocalEmbeddingRetryDelayMs}。
   */
  delayMs?: ((attempt: number) => number) | undefined;
}

/** {@link LocalEmbeddingProvider} のコンストラクタに渡す設定。どれも省略でき、省くと既定のモデルを使う。 */
export interface LocalEmbeddingProviderOptions {
  /** Hugging Face の repo id。既定 `sirasagi62/ruri-v3-30m-ONNX`。 */
  repo?: string | undefined;
  /** 量子化の別。既定 `"q8"`。 */
  dtype?: LocalEmbeddingDtype | undefined;
  /**
   * 宣言する次元数。既定 `256`。実物と食い違えば初回 `embed()` で例外になる。
   * 渡すなら正の安全な整数でなければ、構築時に `TypeError` / `RangeError`。
   */
  dimensions?: number | undefined;
  /**
   * `space.model` に載せる文字列。既定 `"ruri-v3-30m/sym"`。prefix 方式を変えるなら、ここも変えること。
   */
  modelId?: string | undefined;
  /**
   * 全テキストの先頭に付ける文字列。既定は `""`。
   *
   * クエリ用と文書用を分けられる形（`{ query, document }`）にしないこと。`EmbeddingProvider.embed` は
   * テキストがクエリか文書かを知らないので、設定できても使われ方が呼ばれ方次第になる。
   */
  prefix?: string | undefined;
  /**
   * モデルファイルの置き場所。未指定なら transformers.js の既定で、`@huggingface/transformers`
   * パッケージ自身の中の `.cache/`（`node_modules/@huggingface/transformers/.cache/` など）。
   */
  cacheDir?: string | undefined;
  /**
   * onnxruntime の intra-op スレッド数。既定 `4`。
   * 渡すなら正の安全な整数でなければ、構築時に `TypeError` / `RangeError`。
   */
  numThreads?: number | undefined;
  /**
   * `embed(ctx, texts)` を1回の推論に渡す最大件数。既定 {@link DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE}（128）。
   * 超えたときだけ、先頭からこの件数ずつ順に推論して連結する。
   *
   * 不正な値は丸める（`NaN`・0以下は 1、非整数は切り捨て）。そのまま通すと、分割ループが止まらない・
   * テキストが消える。`Infinity` は「分割しない」。
   */
  maxBatchSize?: number | undefined;
  /**
   * Hugging Face の revision（枝名・tag・commit sha）。未指定なら transformers.js の既定（`"main"`）。
   * `createPipeline` を差し替えたときは `spec.revision` がそのまま渡り、扱いはその実装による。
   */
  revision?: string | undefined;
  /**
   * モデルを読み込む関数。テストで本物のモデルを落とさないための注入点。未指定なら transformers.js を使う。
   */
  createPipeline?: CreateLocalEmbeddingPipeline | undefined;
  /**
   * モデルの読み込みが失敗したときのリトライ設定。既定は {@link DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS} 回・
   * {@link defaultLocalEmbeddingRetryDelayMs} のバックオフ。
   */
  retry?: LocalEmbeddingRetryOptions | undefined;
  /**
   * リトライの待ち時間を待つ関数。テスト用の注入点。未指定なら `setTimeout`。
   */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * `EmbeddingProvider` のプロセス内実装。既定は `ruri-v3-30m/sym`・256次元・q8。
 *
 * `new` はモデルを読まない。読むのは最初の `embed()`（または `warmup()`）で、初回だけネットワークが要る。
 * 構築時に投げるもの: `repo` だけを差し替えて `modelId` を省くと `Error`。`dimensions`・`numThreads` が
 * 正の安全な整数でなければ `TypeError` / `RangeError`。`retry.attempts` が `±Infinity` なら `RangeError`。
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  /** コンストラクタで同期に確定して凍結する。`EmbeddingSpaceId` はテーブル名の導出元なので、途中で変わってはならない。 */
  readonly space: EmbeddingSpaceId;

  readonly #spec: LocalEmbeddingModelSpec;
  readonly #prefix: string;
  readonly #createPipeline: CreateLocalEmbeddingPipeline;
  readonly #retryAttempts: number;
  readonly #retryDelayMs: (attempt: number) => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxBatchSize: number;

  /**
   * 読み込み中／読み込み済みの Promise を握る（pipeline ではなく）。pipeline だけを持つと、同時に来た
   * `embed()` が全員別々にモデルを読み込む。失敗したら `null` へ戻す。握り続けると一度の失敗で使えなくなる。
   */
  #ready: Promise<LocalEmbeddingPipeline> | null = null;

  #disposed = false;
  #disposing: Promise<void> | null = null;
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(options: LocalEmbeddingProviderOptions = {}) {
    if (options.dimensions !== undefined) {
      assertPositiveSafeInteger("LocalEmbeddingProvider", "dimensions", options.dimensions);
    }
    if (options.numThreads !== undefined) {
      assertPositiveSafeInteger("LocalEmbeddingProvider", "numThreads", options.numThreads);
    }
    // `space.model` は `modelId` からしか作られず `repo` は反映されない。`repo` だけ差し替えると、別モデルの
    // ベクトルが同じ space に静かに混ざり、後から分けられない。次元の検査は次元が同じなら素通しするので、ここで落とす。
    // `dtype` は対象にしない。
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
    // `Math.max(1, ...)`: 0回以下は 1 に丸める（一度も試さないと #startLoad のループの前提が壊れる）。
    // `NaN` も同じ。`±Infinity` は丸めようがなく、通すと失敗が続くかぎり返らないので断る。
    const rawRetryAttempts = options.retry?.attempts ?? DEFAULT_LOCAL_EMBEDDING_RETRY_ATTEMPTS;
    assertNotInfinite("LocalEmbeddingProvider", "retry.attempts", rawRetryAttempts);
    this.#retryAttempts = Number.isNaN(rawRetryAttempts) ? 1 : Math.max(1, rawRetryAttempts);
    this.#retryDelayMs = options.retry?.delayMs ?? defaultLocalEmbeddingRetryDelayMs;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // 0以下・NaN は 1 に丸める（素通しすると `slice` が無限ループや空バッチになる）。非整数は切り捨てる
    // （刻み幅に使うので、整数でないと半端な位置で区切る）。`Infinity` は「分割しない」として通す。
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
   * モデルを先に読み込んでおく。`EmbeddingProvider` には無い追加のメソッド。
   *
   * `embed(ctx, [])` は即 `[]` を返すので、空配列ではウォームアップできない。読み込みだけを済ませ、推論は走らせない。
   *
   * 読み込みに失敗すると reject する。`retry` を使い切ると、元の例外を `cause` に持つ `Error` になる。
   * 種類の付いた失敗（`LocalEmbeddingProviderError`）は、リトライも包みもせずそのまま投げる。
   * {@link LocalEmbeddingProvider.dispose} の後に呼ぶと、素の `Error` で reject する。
   */
  async warmup(): Promise<void> {
    this.#assertNotDisposed("warmup");
    await this.#load();
  }

  /**
   * 保持しているモデル（pipeline）を手放す。`EmbeddingProvider` には無い任意の口。
   *
   * - 一度も読み込んでいなければ何もしない。読み込み中・推論中なら、終わるのを待ってから解放する。
   * - 2回目以降は最初と同じ Promise を返し、上流の `dispose()` は1回しか呼ばない。
   * - 呼んだ時点から、`embed()` / `warmup()` は reject する。
   * - 上流の `dispose()` が reject したら、この Promise も同じ理由で reject する。
   */
  dispose(): Promise<void> {
    if (this.#disposing === null) {
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
      return;
    }
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
   * `texts` を埋め込み、入力と同じ件数・順で返す。空配列ならモデルを読まずに `[]` を返す
   * （`opts.signal` が abort 済みなら reject する）。
   *
   * 投げるもの（どれも reject）:
   * - {@link LocalEmbeddingProvider.dispose} の後は、空配列でも素の `Error`。
   * - モデルの読み込みの失敗は {@link LocalEmbeddingProvider.warmup} と同じ。
   * - 既定の pipeline は、入力がモデルの上限トークン数を超えると `kind: "input_too_long"` の
   *   `LocalEmbeddingProviderError` を投げる（推論の前に検査し、切り詰めない）。このクラス自身は上限を検査しない。
   *   差し替えた pipeline が上限を守るのは、その `embed` の責任。
   * - ベクトルの件数が `texts` と違う・次元が `space.dimensions` と違う・有限でない成分を含むときは、素の `Error`。
   *
   * `opts.signal` は transformers.js の推論を中断できないので、推論の途中では止まらない。
   * 読み込みの待ち（再試行の `sleep` を含む）と、分割時のチャンクの合間では abort を見る。
   * 推論が終わった時点で abort 済みなら、ベクトルを返さず `signal.reason` で reject する。
   * 読み込みそのものは abort で止まらず、ある呼び出しの abort が同じ読み込みを待つ別の呼び出しを巻き込まない。
   * `warmup()` は `signal` を取らない。
   *
   * `texts.length` が `maxBatchSize` 以下なら 1 回で推論する（ビット一致）。超えたときだけ分割して直列に推論し、
   * 順に連結する。prefix は分割の前に `texts` 全体へ付ける。
   */
  async embed(_ctx: Ctx, texts: string[], opts?: AbortOptions): Promise<number[][]> {
    // dispose 済みの断りは、空配列の早期 return より前に置く。空のときだけ誤りが隠れるのを避ける。
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
    opts?.signal?.throwIfAborted();
    if (texts.length === 0) {
      return [];
    }
    opts?.signal?.throwIfAborted();

    // 待ちだけを signal ごとに切る。`#load()` 自体（共有の読み込み・再試行）は止めない。
    const pipeline = await runAbortable(opts?.signal, () => this.#load());
    opts?.signal?.throwIfAborted();

    // prefix が空でも必ず新しい配列を作る（`texts` を素通しにしない）。素通しだと、注入された pipeline が
    // 配列を書き換えたとき、既定（prefix が空）でだけ呼び出し側の配列が壊れる。
    const prefixed = texts.map((text) => this.#prefix + text);
    const vectors =
      prefixed.length <= this.#maxBatchSize
        ? await pipeline.embed(prefixed)
        : await this.#embedInChunks(pipeline, prefixed, opts?.signal);
    // 推論は走り終えた。abort 済みなら、出来上がったベクトルを返さずに投げ直す。
    opts?.signal?.throwIfAborted();

    // 件数がずれたベクトルを黙って返すと、呼び出し側で memory とベクトルが1つずれて対応する。
    if (vectors.length !== texts.length) {
      throw new Error(
        `LocalEmbeddingProvider: ${texts.length} 件のテキストに対して ` +
          `${vectors.length} 件のベクトルが返った（${this.#spec.repo}）`,
      );
    }

    // 宣言した次元と実物の食い違いを黙って通すと、宣言と中身が食い違ったまま DB へ入り、後から分けられない。
    for (const [index, vector] of vectors.entries()) {
      if (vector.length !== this.space.dimensions) {
        throw new Error(
          `LocalEmbeddingProvider: 宣言した次元数 ${this.space.dimensions} に対して、` +
            `モデル（${this.#spec.repo} / dtype=${this.#spec.dtype}）が返したベクトルは ` +
            `${vector.length} 次元だった（${index} 番目）。` +
            `options.dimensions を実物に合わせるか、repo を見直すこと`,
        );
      }
      // `toVectors` は `typeof === "number"` しか見ないので NaN / Infinity は素通りする。黙って返すと
      // pgvector への書き込みで初めて、原因から離れた SQL の失敗として現れる。
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
   * `prefixed` を `#maxBatchSize` 件ずつ**直列で**推論して連結する。`Promise.all` にしないのは、複数の推論を
   * 同時に走らせると、スレッドを奪い合い、かつ RSS を抑えるという目的に反するため。
   *
   * `input_too_long` の `detail.index` は、チャンクの開始位置を足し戻して投げ直す
   * （`pipeline.embed()` が知るのはチャンク内の位置だけで、`embed` の契約は配列全体での位置）。
   */
  async #embedInChunks(
    pipeline: LocalEmbeddingPipeline,
    prefixed: string[],
    signal: AbortSignal | undefined,
  ): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < prefixed.length; offset += this.#maxBatchSize) {
      // 1回の `pipeline.embed` は止められないので、abort 済みなら次のチャンクだけ始めない。
      signal?.throwIfAborted();
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

  /** 読み込みを 1 回に畳む。同期の関数にする（`async` にしない）。`#ready` の確認と代入の間に await が入ると競合する。 */
  #load(): Promise<LocalEmbeddingPipeline> {
    const existing = this.#ready;
    if (existing !== null) {
      return existing;
    }
    const pending = this.#startLoad();
    this.#ready = pending;
    // 失敗した Promise を握り続けない。自分が入れたものだけを消し、後から始まった別の読み込みを巻き添えにしない。
    pending.catch(() => {
      if (this.#ready === pending) {
        this.#ready = null;
      }
    });
    return pending;
  }

  /**
   * `createPipeline` を呼び、種類の分かっていない失敗をバックオフを挟んで再試行する。使い切ったら包んで投げる。
   *
   * ここでのリトライは 1 回の `#load()` の中で完結する。`#ready` を `null` へ戻して次の `embed()` に再試行を
   * 委ねる仕組みとは別の層で、こちらは一時的な失敗を呼び出し側に見せずに吸収するためにある。
   */
  async #startLoad(): Promise<LocalEmbeddingPipeline> {
    let lastError: unknown;
    // `retry.attempts` が整数でないと、設定値と実際に試した回数が食い違うので、メッセージには実際の回数を載せる。
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= this.#retryAttempts; attempt += 1) {
      attemptsMade = attempt;
      try {
        return await this.#createPipeline(this.#spec);
      } catch (error) {
        // 種類の付いた失敗はリトライしない・包まない。入力・設定の問題で、`describeLoadFailure` の「再変換できる」は助言として嘘になる。
        if (isLocalEmbeddingProviderError(error)) {
          throw error;
        }
        lastError = error;
        // `attempt < this.#retryAttempts` と書くと、整数でない `retry.attempts`（2.5 など）で最後の試行の後にも待つ。
        if (attempt + 1 <= this.#retryAttempts) {
          await this.#sleep(this.#retryDelayMs(attempt));
        }
      }
    }
    // 注入された `createPipeline` の置き場所はこのクラスには分からない。
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
 * `input_too_long` の `index` にチャンクの開始位置を足し戻す。それ以外の失敗はそのまま返す。
 * メッセージは番号だけ差し替え、文面は複製しない（片方だけ直し忘れる腐り方を避ける）。
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
 * `cacheDir` を省いたとき、実際の置き場所が分からない場合の表記。npm の配置で決め打ちすると、pnpm の
 * 利用者には無い場所を指す。
 */
const UNKNOWN_TRANSFORMERS_CACHE_PLACE =
  "transformers.js の env.cacheDir（`@huggingface/transformers` パッケージの中の `.cache/`。実際の場所はパッケージマネージャの配置による）";

function describeLoadFailure(
  spec: LocalEmbeddingModelSpec,
  attemptsMade: number,
  defaultCacheDir: string | undefined,
): string {
  const where =
    spec.cacheDir !== undefined
      ? `cacheDir=${spec.cacheDir}`
      : `cacheDir=未指定（transformers.js の既定: ${defaultCacheDir ?? UNKNOWN_TRANSFORMERS_CACHE_PLACE}）`;
  // 壊れたキャッシュは再試行を使い切っても同じように落ち続けるので、消す場所を名指す。`revision` を渡したときは根が分かれる。
  const baseCacheRoot = spec.cacheDir ?? defaultCacheDir;
  const cacheRoot =
    baseCacheRoot !== undefined && spec.revision !== undefined
      ? revisionCacheRoot(baseCacheRoot, spec.revision)
      : baseCacheRoot;
  const repoCache =
    cacheRoot !== undefined
      ? `${cacheRoot.replace(/[\\/]+$/, "")}/${spec.repo}`
      : `${UNKNOWN_TRANSFORMERS_CACHE_PLACE} の下の ${spec.repo}`;
  // 1回だけなら「1回試した」は情報にならないので黙る。
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
