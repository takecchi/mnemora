import { LocalEmbeddingProviderError } from "./errors.js";
import { recordTransformersCacheDir, revisionCacheRoot } from "./transformers-cache-place.js";

/** dtype（量子化の別）。 */
export type LocalEmbeddingDtype = "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "q4f16";

/** `createPipeline` に渡る、確定済みのモデル指定。 */
export interface LocalEmbeddingModelSpec {
  /** Hugging Face の repo id。 */
  readonly repo: string;
  /** 量子化の別（{@link LocalEmbeddingDtype}）。 */
  readonly dtype: LocalEmbeddingDtype;
  /**
   * モデルファイルの置き場所。未指定なら transformers.js の既定で、`@huggingface/transformers`
   * パッケージ自身の中の `.cache/`（`node_modules/@huggingface/transformers/.cache/` など）。
   */
  readonly cacheDir: string | undefined;
  /** onnxruntime の intra-op スレッド数。 */
  readonly numThreads: number;
  /**
   * Hugging Face の revision（枝名・tag・commit sha）。未指定なら `pipeline()` へ渡さず、transformers.js の
   * 既定（`"main"`）のまま。指定したときの扱いは {@link createLocalEmbeddingPipeline} を見ること。
   */
  readonly revision?: string | undefined;
}

/**
 * テキストの配列をベクトルの配列にする。prefix の付与は呼ぶ側の仕事で、`embed()` は付与済みの文字列を受け取る。
 *
 * 関数1本ではなく `maxInputTokens` / `countTokens` を必須のプロパティにしてある。関数型だと、上限を宣言しない
 * pipeline を注入できてしまい、切り捨てられたベクトルと切られていないベクトルが同じ顔で返る。
 * ⚠ 型が強制するのは宣言までで、`embed()` が宣言した上限を守るかは検査できない。
 *
 * ⛔ ここに具体的な上限の値を書かないこと。値はモデルごとに違う。
 */
export interface LocalEmbeddingPipeline {
  /**
   * このモデルが受け付ける最大トークン数。`Infinity` / `NaN` / 0以下 / 非整数は「宣言されていない」として、
   * {@link buildLocalEmbeddingPipeline} が組み立てを失敗させる。
   */
  readonly maxInputTokens: number;
  /**
   * 各テキストのトークン数を、切り詰めずに数えて返す（`texts` と同じ順・同じ長さ）。
   * ⚠ `LocalEmbeddingProvider` はこれも `maxInputTokens` も読まない。上限超過を推論の前に検出するのは
   * `embed` の実装の仕事である。
   */
  countTokens(texts: string[]): number[];
  embed(texts: string[]): Promise<number[][]>;
  /**
   * 保持しているモデル（ONNX のセッション）を手放す。任意（`LocalEmbeddingProvider.dispose()` は在れば呼ぶ）。
   */
  dispose?(): Promise<void>;
}

/** モデルを読み込んで `LocalEmbeddingPipeline` を返す関数。ここが注入点。 */
export type CreateLocalEmbeddingPipeline = (
  spec: LocalEmbeddingModelSpec,
) => Promise<LocalEmbeddingPipeline>;

/**
 * トークナイザのうち、上限を知り、切り詰めずに数えるために必要なぶんだけを写した形。
 * transformers.js の型を公開の型に出さないため、構造だけを写す。
 */
export interface LocalEmbeddingTokenizer {
  /**
   * `tokenizer_config.json` の `model_max_length`。宣言が無いと transformers.js は `Infinity` を返す。
   * `Infinity` は「上限が無い」ではなく「宣言されていない」ので、{@link buildLocalEmbeddingPipeline} は
   * 有限でない値で組み立てを失敗させる。
   */
  readonly model_max_length: number;
  /** 切り詰めずに、特殊トークンを含めて符号化する。 */
  encode(text: string): number[];
}

/** transformers.js の feature-extraction pipeline のうち、ここで使うぶんだけを写した形。 */
export interface LocalEmbeddingExtractor {
  (texts: string[], options: { pooling: "mean"; normalize: boolean }): Promise<unknown>;
  readonly tokenizer: LocalEmbeddingTokenizer;
  /** 上流の pipeline が持つ `dispose()`。古い版・擬似の extractor は持たないことがあるので任意。 */
  dispose?(): Promise<void>;
}

/**
 * extractor から `LocalEmbeddingPipeline` を組み立てる。
 *
 * `createLocalEmbeddingPipeline` の中に検査を書くと、本物のモデルを落とさないと測れなくなるので、純関数に切り出して
 * 擬似の extractor で測れるようにしてある。上限の検査は推論の前に行う。
 *
 * 投げるもの: `tokenizer.model_max_length` が正の整数でなければ、組み立ての時点で `kind: "unknown_input_limit"` の
 * {@link LocalEmbeddingProviderError}。組み立てた pipeline は、上限を超える入力に `kind: "input_too_long"` の
 * {@link LocalEmbeddingProviderError} を投げる。
 */
export function buildLocalEmbeddingPipeline(
  extractor: LocalEmbeddingExtractor,
): LocalEmbeddingPipeline {
  const maxInputTokens = extractor.tokenizer.model_max_length;

  // `Infinity` を「上限が無い」として通すと、切り捨てが再び黙る。
  if (!Number.isInteger(maxInputTokens) || maxInputTokens <= 0) {
    throw new LocalEmbeddingProviderError(
      "unknown_input_limit",
      `LocalEmbeddingProvider: モデルが入力トークン数の上限を宣言していない` +
        `（tokenizer の model_max_length = ${String(maxInputTokens)}）。` +
        `上限が分からないと、入力が黙って切り捨てられたことを検出できない。` +
        `tokenizer_config.json に model_max_length を持つモデルを options.repo に指す（options.modelId にそのモデルを名乗る id も渡す。` +
        `repo だけを差し替えると構築時に例外になる）か、` +
        `options.createPipeline で pipeline を注入すること`,
    );
  }

  const countTokens = (texts: string[]): number[] =>
    texts.map((text) => extractor.tokenizer.encode(text).length);

  return {
    maxInputTokens,
    countTokens,
    // `this` を失わないよう extractor 越しに呼ぶ。持たない extractor には生やさない。
    ...(typeof extractor.dispose === "function" ? { dispose: () => extractor.dispose!() } : {}),
    async embed(texts) {
      for (const [index, text] of texts.entries()) {
        const tokens = extractor.tokenizer.encode(text).length;
        if (tokens > maxInputTokens) {
          throw new LocalEmbeddingProviderError(
            "input_too_long",
            `LocalEmbeddingProvider: ${index} 番目の入力が上限を超えている` +
              `（${tokens} トークン > 上限 ${maxInputTokens} トークン、${text.length} 文字）。` +
              `このまま埋め込むと、上限より後ろは黙って捨てられ、` +
              `切り捨てられたことが分からないベクトルが返る` +
              `（transformers.js は truncation: true で呼ぶため、例外もログも出ない）。` +
              `入力を分割するか短くすること——同じ入力で再試行しても永久に失敗する`,
            { index, tokens, maxInputTokens, characters: text.length },
          );
        }
      }
      return toVectors(await extractor(texts, { pooling: "mean", normalize: true }));
    },
  };
}

/**
 * feature-extraction が返すもの（`Tensor`）から `number[][]` を取り出す。
 * `as` で黙らせないのは、pooling の指定漏れで `[batch][tokens][dim]` になったとき、トークン列がベクトルとして
 * DB に入る壊れ方を実行時まで気づけないため。形を見て、違えば落とす。
 */
export function toVectors(output: unknown): number[][] {
  const raw = hasToList(output) ? output.tolist() : output;
  if (!Array.isArray(raw)) {
    throw new Error(
      `LocalEmbeddingProvider: 埋め込みの出力が配列ではない（${describe(raw)}）。` +
        `feature-extraction pipeline が Tensor 以外を返した可能性がある`,
    );
  }
  const vectors: number[][] = [];
  for (const [index, row] of raw.entries()) {
    if (!Array.isArray(row) || !row.every((value) => typeof value === "number")) {
      throw new Error(
        `LocalEmbeddingProvider: 埋め込みの出力の ${index} 番目が number[] ではない` +
          `（${describe(row)}）。mean pooling が効いていない（[batch][tokens][dim] のまま）` +
          `可能性がある`,
      );
    }
    vectors.push(row as number[]);
  }
  return vectors;
}

function hasToList(value: unknown): value is { tolist: () => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { tolist?: unknown }).tolist === "function"
  );
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return `長さ ${value.length} の配列（要素は ${typeof value[0]}）`;
  return typeof value;
}

/**
 * `env.cacheDir`（プロセス全体で共有される大域）を触る処理を 1 本に直列化する待ち行列。内部専用。
 *
 * 差し替えが、同じプロセスで同時に走る別の読み込みから見えてしまうため。待ち行列なしで並行させると、
 * 本来成功する側が `this.tokenizer is not a function` で落ちた。`cacheDir` を差し替えない呼び出しも含め、
 * 全経路がここを通る。
 *
 * ⚠ 前の読み込みが失敗しても待ち行列は解放される。積むのは「決着したら次へ進む」番兵で、成否は
 * {@link withCacheDirLock} が返す `run` に残す。
 */
let cacheDirQueue: Promise<void> = Promise.resolve();

/**
 * `task` を待ち行列の最後尾へ並べる。同期の関数にする（`async` にしない）。`cacheDirQueue` の読み出しと
 * 書き戻しの間に `await` を挟むと競合の窓になる。
 */
function withCacheDirLock<T>(task: () => Promise<T>): Promise<T> {
  const run = cacheDirQueue.then(task);
  // `cacheDirQueue` 自身は reject させない。reject すると、次に並んだ呼び出しの `.then(task)` が巻き添えで失敗する。
  cacheDirQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 既定の `createPipeline`。transformers.js をプロセス内で走らせる。
 *
 * `import()` で遅延させるのは、`createPipeline` を注入した呼び出し側（テスト）が onnxruntime を読み込まずに済むように。
 *
 * pooling / 正規化は mean pooling + L2 normalize で固定し、呼び出し側から変えられるようにしない。変えるとベクトルが
 * 別物になるが `EmbeddingSpaceId` は変わらず、同じ space に非互換なベクトルが混ざる。
 *
 * `spec.cacheDir` は、`pipeline()` を呼んでいる間だけ `env.cacheDir` にも反映する。transformers.js の読み込みの
 * 前段の確認は `cache_dir` を運ばず `env.cacheDir` だけを見るため、反映しないと、モデルが `spec.cacheDir` に
 * 揃っていてもオフラインで失敗する。終わったら成否にかかわらず元の値へ戻す（`env` は共有の大域）。
 * `spec.cacheDir` が未指定なら `env.cacheDir` に触らない。`env` を読めない（`vi.mock` が `pipeline` だけを返す形）
 * ときは差し替えず、読み込みそのものは止めない。
 *
 * `spec.revision` があるときは、`pipeline()` に渡さず `env.remotePathTemplate` の `{revision}` に埋め込み、
 * キャッシュの根を `<基の根>/<encodeURIComponent(revision)>` にする（基の根は `spec.cacheDir`、無ければ `env.cacheDir`）。
 * 前段の確認が `revision` を運ばず `main` の鍵を探すため、渡すと固定した利用者はオフラインで読めなかった。
 * `env` を読めない・基の根が無い・`env.remotePathTemplate` が文字列でない、のどれかなら、差し替えず `revision` を
 * `pipeline()` へそのまま渡す。
 *
 * ⛔ この関数を呼ぶ経路は {@link withCacheDirLock} を必ず通る。通さないと、並行した呼び出しが差し替え中の値を見る。
 */
export const createLocalEmbeddingPipeline: CreateLocalEmbeddingPipeline = (spec) =>
  withCacheDirLock(() => loadWithCacheDirSwap(spec));

async function loadWithCacheDirSwap(
  spec: LocalEmbeddingModelSpec,
): Promise<LocalEmbeddingPipeline> {
  const transformers = await import("@huggingface/transformers");
  const { pipeline } = transformers;
  // 失敗時のメッセージが置き場所を名指せるよう、`pipeline()` の前に記録する。`vi.mock` は返していない export を読むだけで投げるので、読めなければ「分からない」にする。
  let env: SwappableTransformersEnv | undefined;
  try {
    env = (transformers as { env?: SwappableTransformersEnv }).env;
  } catch {
    env = undefined;
  }
  recordTransformersCacheDir(env?.cacheDir);

  const revisionPin = planRevisionPin(spec, env);
  const cacheDir = revisionPin?.cacheRoot ?? spec.cacheDir;

  const restores: (() => void)[] = [];
  if (env !== undefined) {
    const swappableEnv = env;
    if (cacheDir !== undefined) {
      const previousCacheDir = swappableEnv.cacheDir;
      swappableEnv.cacheDir = cacheDir;
      restores.push(() => {
        swappableEnv.cacheDir = previousCacheDir;
      });
    }
    if (revisionPin !== undefined) {
      const previousTemplate = swappableEnv.remotePathTemplate;
      swappableEnv.remotePathTemplate = revisionPin.remotePathTemplate;
      restores.push(() => {
        swappableEnv.remotePathTemplate = previousTemplate;
      });
    }
  }
  try {
    const extractor = await pipeline("feature-extraction", spec.repo, {
      dtype: spec.dtype,
      ...(cacheDir !== undefined ? { cache_dir: cacheDir } : {}),
      // 埋め込んだときは渡さない。渡すと鍵が `<repo>/<revision>/<file>` に戻る。
      ...(spec.revision !== undefined && revisionPin === undefined
        ? { revision: spec.revision }
        : {}),
      // スレッドを増やすほど速くなるわけではない。オーバーサブスクリプションのほうが高くつく。
      session_options: { intraOpNumThreads: spec.numThreads, interOpNumThreads: 1 },
    });
    // `pipeline()` の戻りは全 pipeline 種の union で、`LocalEmbeddingExtractor` の形であることを型では確かめられない。cast はここ1箇所に閉じ、形が違えば live テストが落ちる。
    return buildLocalEmbeddingPipeline(extractor as unknown as LocalEmbeddingExtractor);
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

interface SwappableTransformersEnv {
  cacheDir?: unknown;
  remotePathTemplate?: unknown;
}

/** `revision` を `env.remotePathTemplate` に埋め込むときの値。埋め込めないなら `undefined`（`revision` をそのまま渡す）。 */
function planRevisionPin(
  spec: LocalEmbeddingModelSpec,
  env: SwappableTransformersEnv | undefined,
): { readonly cacheRoot: string; readonly remotePathTemplate: string } | undefined {
  if (spec.revision === undefined || env === undefined) return undefined;
  const template = env.remotePathTemplate;
  if (typeof template !== "string") return undefined;
  const defaultCacheDir =
    typeof env.cacheDir === "string" && env.cacheDir !== "" ? env.cacheDir : undefined;
  const baseCacheDir = spec.cacheDir ?? defaultCacheDir;
  if (baseCacheDir === undefined) return undefined;
  return {
    cacheRoot: revisionCacheRoot(baseCacheDir, spec.revision),
    remotePathTemplate: template.replaceAll("{revision}", encodeURIComponent(spec.revision)),
  };
}
