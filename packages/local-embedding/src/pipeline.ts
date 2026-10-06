/**
 * `LocalEmbeddingProvider` が握る「モデルを1回だけ読み込んで、テキストの配列を
 * ベクトルの配列にする関数」の型と、その既定の作り方（transformers.js 経由）。
 *
 * **なぜ interface を1枚挟むか**: `packages/openai` の `OpenAIEmbeddingProvider` が
 * `client` を注入できるようにしてあるのと同じ理由である。ここを差せないと、
 * **provider の検査が毎回 4ファイル計42MB（うち重み36MB）を落とすことになり、CI では走らせられない。**
 * 差せるようにしてあるおかげで、遅延ロードの共有・次元の検査・prefix の適用といった
 * 「このパッケージが本当に持っているロジック」は、ネットワーク無しで測れる。
 *
 * ⚠ **`createLocalEmbeddingPipeline`（既定の実装）のうち、`@huggingface/transformers` を
 * 呼ぶ2行だけは、ユニットテストで測っていない。**ここだけは本物の onnxruntime を
 * 起動しないと意味が無いため、`src/__tests__/live.local-embedding.test.ts`（opt-in）だけが通る。
 * **それ以外（上限の読み取り・トークン数の検査・出力の形の検査）は
 * {@link buildLocalEmbeddingPipeline} に切り出してあり、擬似の extractor で CI から測っている**
 * （ADR 0090）。
 */

import { LocalEmbeddingProviderError } from "./errors.js";
import { recordTransformersCacheDir, revisionCacheRoot } from "./transformers-cache-place.js";

/** dtype（量子化の別）。transformers.js が受け付ける値のうち、ここで意味があるものを並べる。 */
export type LocalEmbeddingDtype = "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "q4f16";

/** `createPipeline` に渡る、確定済みのモデル指定。 */
export interface LocalEmbeddingModelSpec {
  /** Hugging Face の repo id。 */
  readonly repo: string;
  /** 量子化の別（{@link LocalEmbeddingDtype}）。 */
  readonly dtype: LocalEmbeddingDtype;
  /**
   * モデルファイルの置き場所。未指定なら transformers.js の既定——`@huggingface/transformers`
   * パッケージ自身の中の `.cache/`（`node_modules/@huggingface/transformers/.cache/` など。
   * ホームの `~/.cache` の下ではない）。
   */
  readonly cacheDir: string | undefined;
  /** onnxruntime の intra-op スレッド数。 */
  readonly numThreads: number;
  /**
   * Hugging Face の revision（枝名・tag・commit sha）。**未指定なら `pipeline()` へ渡さない**
   * ——transformers.js の既定（`"main"`）のまま、いまと同じ呼び出しになる（Issue #597）。
   * 指定したときは、既定の `createPipeline` がキャッシュの根を `<根>/<encodeURIComponent(revision)>` に分け、
   * `revision` を `env.remotePathTemplate` に埋め込む（Issue #1403。{@link createLocalEmbeddingPipeline}）。
   */
  readonly revision?: string | undefined;
}

/**
 * テキストの配列を、そのままベクトルの配列にする**必須 interface**
 * （ADR 0090 §3.1 の決定4「負債1」を実装したもの。Issue #137 案 (a)）。
 *
 * **prefix の付与は呼ぶ側（`LocalEmbeddingProvider`）の仕事であり、ここには無い。**
 * `embed()` が受け取るのは既に prefix の付いた文字列である。
 *
 * 🔴 **なぜ「テキスト→ベクトル」の関数1本ではなく、この形にしたか。**
 *
 * `(texts: string[]) => Promise<number[][]>` という**関数型**だと、
 * `LocalEmbeddingProvider` の `createPipeline` 注入点（`CreateLocalEmbeddingPipeline`）は
 * 外から差し替えられるため、**上限を宣言しない pipeline を注入できてしまう**
 * （ADR 0090 決定4・引き受けた負債1）。宣言が無いまま黙って切り捨てられると、
 * 切られたベクトルと切られていないベクトルが**同じ顔**で返る——
 * `docs/north-star.md` が挙げる「知らないことを、知らないと言える」の裏側、
 * 「見つからなかった」と「探していない」を同じ顔で返す壊れ方そのものである。
 *
 * ⟹ `maxInputTokens` / `countTokens` を**必須のプロパティ**にすることで、
 * `(texts) => Promise<number[][]>` という関数だけを渡す形は型検査で弾かれる。
 * **注入する側は、上限を宣言しないと `LocalEmbeddingPipeline` を作れない。**
 *
 * ⚠ **この interface が構造的に強制するのは「宣言すること」までである。**
 * 宣言した `maxInputTokens` を `embed()` の実装が実際に守っているか
 * （自前の実装が黙って切り詰めていないか）までは、型では検査できない。
 * それでも、「宣言を忘れる」という一番安易な壊れ方は塞がれる。
 *
 * ⛔ **ここに具体的な上限の値を書かないこと。**値はモデルごとに違い、
 * 宣言するのは pipeline を組み立てる側（{@link buildLocalEmbeddingPipeline} や、
 * 独自に実装する側）である。
 */
export interface LocalEmbeddingPipeline {
  /**
   * このモデルが受け付ける最大トークン数。**宣言できないなら pipeline を作れない**
   * （{@link buildLocalEmbeddingPipeline} は `Infinity` / `NaN` / 0以下 / 非整数を
   * 「宣言されていない」として組み立て自体を失敗させる）。
   */
  readonly maxInputTokens: number;
  /**
   * 各テキストのトークン数を、**切り詰めずに**数えて返す
   * （`texts` と同じ順・同じ長さの配列）。
   * ⚠ `LocalEmbeddingProvider` はこれも `maxInputTokens` も読まない。上限超過を推論の前に検出するのは
   * `embed` の実装の仕事である（{@link buildLocalEmbeddingPipeline} の `embed` はそうしている）。
   */
  countTokens(texts: string[]): number[];
  /** 実際にベクトルへ変換する。 */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * 保持しているモデル（ONNX のセッション）を手放す。**任意**——持たない pipeline も注入できる
   * （`LocalEmbeddingProvider.dispose()` は、在れば呼び、無ければ何もしない。ADR 0419）。
   */
  dispose?(): Promise<void>;
}

/** モデルを読み込んで `LocalEmbeddingPipeline` を返す関数。**ここが注入点である。** */
export type CreateLocalEmbeddingPipeline = (
  spec: LocalEmbeddingModelSpec,
) => Promise<LocalEmbeddingPipeline>;

/**
 * トークナイザのうち、**上限を知り、切り詰めずに数えるために必要なぶんだけ**を写した形。
 *
 * ⚠ **`@huggingface/transformers` の型をそのまま公開の型に出さない**
 * （`docs/architecture.md` §3.8——core にも呼び出し側にも transformers.js の型を漏らさない）。
 * 構造だけを写すことで、擬似の extractor を注入して CI から測れるようにしてある。
 */
export interface LocalEmbeddingTokenizer {
  /**
   * `tokenizer_config.json` の `model_max_length`。
   *
   * ⚠ **宣言が無いとき、transformers.js はここに `Infinity` を返す**
   * （`src/tokenization_utils.js` の `get model_max_length()` は
   * `this._tokenizerConfig.model_max_length ?? Infinity`）。
   * ⟹ **`Infinity` は「上限が無い」ではなく「宣言されていない」である。**
   * その2つを潰さないために、{@link buildLocalEmbeddingPipeline} は
   * 有限でない値を受け取ったら組み立て自体を失敗させる。
   */
  readonly model_max_length: number;
  /** **切り詰めずに**、特殊トークンを含めて符号化する。 */
  encode(text: string): number[];
}

/** transformers.js の feature-extraction pipeline のうち、ここで使うぶんだけを写した形。 */
export interface LocalEmbeddingExtractor {
  (texts: string[], options: { pooling: "mean"; normalize: boolean }): Promise<unknown>;
  /** 上限の検査に使うトークナイザ（{@link LocalEmbeddingTokenizer}）。 */
  readonly tokenizer: LocalEmbeddingTokenizer;
  /**
   * 上流の pipeline が持つ `async dispose()`（ONNX のセッションを解放する）。
   * 古い版・擬似の extractor は持たないことがあるので任意にしてある（ADR 0419）。
   */
  dispose?(): Promise<void>;
}

/**
 * extractor から `LocalEmbeddingPipeline` を組み立てる**純関数**（ADR 0090）。
 *
 * 🔴 **なぜここに切り出すか。**
 *
 * 上限の判定に必要な知識（`model_max_length` と、切り詰めない符号化）は
 * **トークナイザだけが持っている。**そしてトークナイザは
 * `createLocalEmbeddingPipeline` の中、つまり**本物のモデルを落とさないと触れない場所**に居る。
 * ⟹ そこへ検査を書くと、**検査が CI から測れなくなり、歯にならない。**
 *
 * だから「extractor を受け取って pipeline を組み立てる」ところだけを純関数にし、
 * **擬似の extractor を注入して CI から測る。**残る未測定は
 * 「`pipeline("feature-extraction", ...)` が返すものが、本当にこの形をしているか」だけであり、
 * それは live テスト（opt-in）が見る。
 *
 * 🔴 **上限の検査は推論の前に行う。**超過が確定している入力に、
 * 36MB のモデルを回す費用を払わせない。
 *
 * 投げるもの: `tokenizer.model_max_length` が正の整数でなければ（`Infinity` は「宣言されていない」）、組み立ての時点で
 * `kind: "unknown_input_limit"` の {@link LocalEmbeddingProviderError}。組み立てた pipeline は、上限を超える入力に
 * `kind: "input_too_long"` の {@link LocalEmbeddingProviderError} を投げる。
 */
export function buildLocalEmbeddingPipeline(
  extractor: LocalEmbeddingExtractor,
): LocalEmbeddingPipeline {
  const maxInputTokens = extractor.tokenizer.model_max_length;

  // ⚠ `Number.isInteger` は `Infinity` と `NaN` を弾く。**「宣言されていない」を
  // 「上限が無い」として通さない**——通せば、切り捨ては再び黙る。
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
    // 上流の dispose に委ねる（ADR 0419）。`this` を失わないよう extractor 越しに呼ぶ。
    // 持たない extractor には生やさない（呼ぶ側は「在れば呼ぶ」）。
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
 * transformers.js の feature-extraction が返すもの（`Tensor`）から `number[][]` を取り出す。
 *
 * **なぜ素直に `output.tolist() as number[][]` と書かないか**: `tolist()` の戻りは
 * テンソルの形に従う。pooling を指定し忘れれば `[batch][tokens][dim]` の3階になり、
 * `as` で黙らせると**「トークン列がベクトルとして DB に入る」**という、
 * 実行時まで気づけない壊れ方をする。ここで形を見て、違えば名前を付けて落とす。
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
 * `env.cacheDir`（transformers.js のプロセス全体で共有される大域）を触る処理を、
 * プロセス内で1本に直列化する待ち行列（Issue #1239）。**`index.ts` からは export しない
 * ——このパッケージの内部専用の実装詳細である。**
 *
 * 🔴 **なぜ要るか。**
 *
 * `spec.cacheDir` を transformers.js の読み込みの前段の確認にも反映させるには、
 * `pipeline()` を呼んでいる間だけ `env.cacheDir` を `spec.cacheDir` へ差し替えるしかない
 * （下の {@link createLocalEmbeddingPipeline} の doc）。だが `env` は**プロセス全体で1つの
 * 大域**であり、差し替えは「このパッケージがモデルを読み込んでいる間」だけ有効なつもりでも、
 * **同じプロセスで同時に走っている、別の読み込み（`cacheDir` を差し替えていない既定の
 * 読み込みも含む）から見えてしまう。**
 *
 * 【実測】2つの読み込み（片方は warm な `cacheDir`、もう片方は空の `cacheDir`）を、
 * 待ち行列を挟まずに並行させると、**本来成功するはずの側**が
 * `this.tokenizer is not a function` で落ちた——片方の `finally` の巻き戻しが、
 * もう片方の `pipeline()`呼び出しの途中に割り込んだためである。
 *
 * ⟹ **`cacheDir` の有無にかかわらず、`createLocalEmbeddingPipeline` を呼ぶ経路はすべて
 * この待ち行列を通す。**差し替えないだけの呼び出しも巻き込まないと、差し替えている最中の
 * 値が漏れて見える（差し替えていない側が、他人の `cacheDir` を見てしまう）。
 *
 * ⚠ **前の読み込みが失敗しても、待ち行列そのものは解放される。**`cacheDirQueue` に積むのは
 * 「決着したら（成功でも失敗でも）次へ進む」という番兵であり、実際の成功・失敗は
 * {@link withCacheDirLock} が返す `run` のほうに残して呼び出し元へ届ける——
 * 一度の失敗が、待ち行列そのものを永久に詰まらせることはない。
 */
let cacheDirQueue: Promise<void> = Promise.resolve();

/**
 * `task` を、`env.cacheDir` を触ってよい唯一の実行者として、待ち行列の最後尾へ並べる。
 *
 * ⚠ **同期の関数である**（`async` にしない）。`cacheDirQueue` の読み出しと書き戻しの間に
 * `await` を挟むと、そこが新しい競合の窓になる——`LocalEmbeddingProvider.#load()` が
 * `#ready` を同じ理由で同期に扱っているのと同じ注意である。
 */
function withCacheDirLock<T>(task: () => Promise<T>): Promise<T> {
  const run = cacheDirQueue.then(task);
  // `run` の成否にかかわらず、次の `task` へ進めてよいことだけを次の待ち行列に伝える
  // （`cacheDirQueue` 自身は reject しない——reject させると、次に並んだ呼び出しの
  // `.then(task)` が実行されずに巻き添えで失敗する）。
  cacheDirQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 既定の `createPipeline`。transformers.js をプロセス内で走らせる。
 *
 * **`import()` で遅延させている理由**: `createPipeline` を注入した呼び出し側
 * （＝テスト）が、`@huggingface/transformers` とその先の onnxruntime を
 * **一度も読み込まずに済む**ようにするため。トップレベルの `import` にすると、
 * このモジュールを読んだだけで onnxruntime のネイティブバイナリが load される。
 *
 * pooling / 正規化は **mean pooling + L2 normalize** で固定する。
 * ruri v3 の `1_Pooling/config.json` が mean pooling であることを確認済み。
 * **呼び出し側から変えられるようにはしない**——pooling を変えるとベクトルは
 * 別物になるが `EmbeddingSpaceId` は変わらないため、**同じ space に非互換な
 * ベクトルが混ざる。**
 *
 * 🔴 **`spec.cacheDir` を、`pipeline()` を呼んでいる間だけ `env.cacheDir` にも反映させる
 * （Issue #1239）。**
 *
 * `@huggingface/transformers@4.2.0` は、読み込みの前段の確認（`get_pipeline_files` /
 * `get_config` / `get_file_metadata` が `config.json`・`tokenizer_config.json` の有無を
 * 確かめるところ）に `cache_dir` を運ばない——**既定のキャッシュ（`env.cacheDir`）だけを見る。**
 * ⟹ `cache_dir`（`spec.cacheDir`）にモデルの4ファイルが揃っていても、既定のキャッシュが
 * 空なら、この前段の確認だけがネットワークへ出て、オフラインでは読み込みが失敗する
 * （README「`cacheDir` を渡しても…」節に実測を書いてある）。
 *
 * `env.cacheDir` を `spec.cacheDir` と同じ場所へ一時的に向ければ、前段の確認もそこを見る。
 * **`pipeline()` の呼び出しが終わったら（成功でも失敗でも）必ず元の値へ戻す**——`env` は
 * このパッケージだけのものではない共有の大域なので、戻し忘れると、この呼び出しが終わった後の
 * 他の読み込み（このパッケージの別の呼び出しも、同じプロセスの他の transformers.js の
 * 利用者も）が、意図せずこの `cacheDir` を見てしまう。
 *
 * ⚠ **`spec.cacheDir` が未指定のときは、`env.cacheDir` に触らない。**触らなければ、
 * transformers.js の既定（パッケージ自身の中の `.cache/`）のままになる。
 * ⚠ **差し替えるのは `env` を読めたときだけである。**`env` を持たない差し替え
 * （`vi.mock` が `pipeline` だけを返す形）もあるため、読み出しは try/catch で守る——
 * 読めなければ「差し替えられない」として、読み込みそのものは止めない
 * （下の `recordTransformersCacheDir` の読み出しと同じ理由・同じ形）。
 *
 * 🔴 **`spec.revision` があるときは、`revision` を `pipeline()` に渡さず、`env.remotePathTemplate`
 * に埋め込む（Issue #1403・ADR 0365）。**
 *
 * 前段の確認は `cache_dir` だけでなく `revision` も運ばないので、`revision` を渡すと、前段の確認だけが
 * `main` の鍵（`<repo>/config.json`）を探し、実際の読み込みは `<repo>/<revision>/<file>` を探す。
 * ⟹ `revision` を固定した利用者は、温めてもオフラインで読めなかった。
 * いまは `pipeline()` を呼んでいる間だけ、次の2つを差し替える（どちらも公開の設定）。
 *
 * - `env.remotePathTemplate` の `{revision}` を、`encodeURIComponent(revision)` に置き換える
 *   （利用者が変えた template を土台にする）。前段の確認も実際の読み込みも、同じ revision の URL を見る。
 * - キャッシュの根（`cache_dir` と `env.cacheDir`）を `<基の根>/<encodeURIComponent(revision)>` にする
 *   （`revisionCacheRoot`）。基の根は `spec.cacheDir`、無ければ既定の `env.cacheDir`。
 *
 * ⚠ `env` を読めない・`env.cacheDir` も `spec.cacheDir` も無い・`env.remotePathTemplate` が
 * 文字列でない、のどれかなら、この差し替えはせず、`revision` を `pipeline()` へそのまま渡す。
 * `spec.revision` が無いときは、何も変えない。
 *
 * ⛔ **この関数を呼ぶ経路は、上の {@link withCacheDirLock} を必ず通る。**
 * 直列化していないと、並行した2本目以降の呼び出しが、1本目の差し替えの最中の値を見てしまう
 * （`withCacheDirLock` の doc の実測）。
 */
export const createLocalEmbeddingPipeline: CreateLocalEmbeddingPipeline = (spec) =>
  withCacheDirLock(() => loadWithCacheDirSwap(spec));

async function loadWithCacheDirSwap(
  spec: LocalEmbeddingModelSpec,
): Promise<LocalEmbeddingPipeline> {
  const transformers = await import("@huggingface/transformers");
  const { pipeline } = transformers;
  // 読み込みに失敗したときのメッセージが、実際に置かれる場所を名指せるように、`pipeline()` を
  // 呼ぶ前に記録する（`transformers-cache-place.ts`）。`env` を持たない差し替えもある——vitest の
  // `vi.mock` は、返していない export を読むだけで例外を投げる。メッセージのための読み出しなので、
  // 読めなければ「分からない」にして、読み込みそのものは止めない。
  let env: SwappableTransformersEnv | undefined;
  try {
    env = (transformers as { env?: SwappableTransformersEnv }).env;
  } catch {
    env = undefined;
  }
  recordTransformersCacheDir(env?.cacheDir);

  // Issue #1403: `revision` を `env.remotePathTemplate` に埋め込めるか。埋め込めるときだけ、キャッシュの根を
  // revision ごとに分け、`revision` は `pipeline()` へ渡さない。埋め込めないときは渡す。
  const revisionPin = planRevisionPin(spec, env);
  const cacheDir = revisionPin?.cacheRoot ?? spec.cacheDir;

  // `env` が読めて、差し替える値があるときだけ差し替える。`restore` に戻す処理そのものを持たせる
  // （`env` を一度 const（`swappableEnv`）へ写すことで、以降のクロージャの中でも「読めた」という型の
  // 絞り込みを保つ——`let env` のままだと、`finally` の中で毎回 non-null 断定が要る）。
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
      // Issue #597: 指定されたときだけ渡す。未指定なら鍵ごと渡さず、いまと同じ呼び出しにする。
      // Issue #1403: template に埋め込んだときは渡さない（渡すと、鍵が `<repo>/<revision>/<file>` に戻る）。
      ...(spec.revision !== undefined && revisionPin === undefined
        ? { revision: spec.revision }
        : {}),
      // 32コア機での実測: 既定（コア数まかせ）819 文/秒 に対し、4スレッドで 985 文/秒。
      // スレッドを増やすほど速くなるわけではない——オーバーサブスクリプションのほうが高くつく。
      session_options: { intraOpNumThreads: spec.numThreads, interOpNumThreads: 1 },
    });
    // ⚠ **ここが、このパッケージで唯一ユニットテストに載らない場所である。**
    // `pipeline()` が返すものが `LocalEmbeddingExtractor` の形（呼べて、`tokenizer` を持つ）を
    // していることは、**型では確かめられない**（transformers.js の戻りは全 pipeline 種の union）。
    // ⟹ 形が違えば live テストが落ちる。**cast はここ1箇所に閉じてある。**
    return buildLocalEmbeddingPipeline(extractor as unknown as LocalEmbeddingExtractor);
  } finally {
    // ⭐ 成功でも失敗でも、必ず元の値へ戻す（`try` の中で return していても finally は走る）。
    for (const restore of restores.reverse()) restore();
  }
}

/** `loadWithCacheDirSwap` が読み書きする、transformers.js の `env` の項目（どちらも公開の設定）。 */
interface SwappableTransformersEnv {
  cacheDir?: unknown;
  remotePathTemplate?: unknown;
}

/**
 * `revision` を `env.remotePathTemplate` に埋め込むときの値（Issue #1403・ADR 0365）。埋め込めないなら
 * `undefined`——そのときは `revision` を `pipeline()` へそのまま渡す。
 *
 * 埋め込めないのは、`spec.revision` が無い・`env` を読めない・`env.remotePathTemplate` が文字列でない・
 * 基の根（`spec.cacheDir`、無ければ既定の `env.cacheDir`）が無い、のどれかのとき。
 */
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
    // transformers.js 自身も `{revision}` を `encodeURIComponent` して埋める（utils/hub.js）。同じ形にする。
    remotePathTemplate: template.replaceAll("{revision}", encodeURIComponent(spec.revision)),
  };
}
