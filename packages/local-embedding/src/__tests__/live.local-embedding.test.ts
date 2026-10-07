import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_EMBEDDING_DTYPE,
  DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE,
  DEFAULT_LOCAL_EMBEDDING_NUM_THREADS,
  DEFAULT_LOCAL_EMBEDDING_REPO,
  LocalEmbeddingProvider,
} from "../local-embedding-provider.js";
import { buildLocalEmbeddingPipeline, createLocalEmbeddingPipeline } from "../pipeline.js";
import type {
  CreateLocalEmbeddingPipeline,
  LocalEmbeddingExtractor,
  LocalEmbeddingModelSpec,
  LocalEmbeddingTokenizer,
} from "../pipeline.js";
import { describeEmbeddingProviderConformance } from "@mnemora/testkit";
import { isLocalEmbeddingProviderError } from "../errors.js";
import type { LocalEmbeddingProviderError } from "../errors.js";

/**
 * opt-in を要求する理由は課金ではなく、4ファイル計42MB（うち重み36MB）のダウンロードと peak RSS 362MB の推論が `pnpm run test` 1回で走ってしまうこと。ネットワークの無い環境ではダウンロードで固まり、CI では毎回落とし直す。
 * `MNEMORA_LIVE_LOCAL_EMBEDDING` は空でない値なら何でも opt-in とみなす。特定の綴りだけ受けて他を黙って無視すると、「設定したのに走らない」罠になる。
 * `it.skipIf` を使う（`describe.skip` やファイルを読み込まない形、`if (!live) return` は、skipped が出なかったり「1件パスした」誤った印象を残す）。
 * ローカルで実行するには（モデルを落とす。初回は数十秒かかる）:
 *   MNEMORA_LIVE_LOCAL_EMBEDDING=1 pnpm --filter @mnemora/local-embedding test
 */
const live = (process.env.MNEMORA_LIVE_LOCAL_EMBEDDING ?? "") !== "";

/** ベクトルは L2 正規化済みなので内積と一致するが、前提を置かずに割る。 */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [index, value] of a.entries()) {
    const other = b[index] ?? 0;
    dot += value * other;
    na += value * value;
    nb += other * other;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 「ビット一致」を実際にバイトで比べるため。 */
function toFloat32Bytes(vectors: number[][]): Buffer {
  const f32 = new Float32Array(vectors.flat());
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

describe("live: local embedding (MNEMORA_LIVE_LOCAL_EMBEDDING が無ければ skipped と表示される)", () => {
  it.skipIf(!live)(
    "日本語2文を埋め込むと、宣言どおり 256 次元のベクトルが返る",
    async () => {
      const provider = new LocalEmbeddingProvider();
      const vectors = await provider.embed({ tenantId: "live-test" }, [
        "今日は雨が降っている",
        "会議は水曜日に延期になった",
      ]);

      expect(vectors).toHaveLength(2);
      expect(vectors[0]).toHaveLength(256);
      expect(vectors[1]).toHaveLength(256);
      expect(cosine(vectors[0] ?? [], vectors[0] ?? [])).toBeCloseTo(1, 5);
    },
    120_000,
  );

  it.skipIf(!live)(
    "同義のペアのほうが、無関係なペアより cos が大きい",
    async () => {
      const provider = new LocalEmbeddingProvider();
      const [a, b, c] = await provider.embed({ tenantId: "live-test" }, [
        "猫が窓辺で眠っている",
        "ネコが窓のそばで寝ている",
        "為替相場が円安に振れた",
      ]);

      const synonymous = cosine(a ?? [], b ?? []);
      const unrelated = cosine(a ?? [], c ?? []);

      // 測っているのはその程度のことだけ。「否定・時制・矛盾を解ける」ことは測っていない（実際、解けない。README「何が良くならないか」）。
      expect(synonymous).toBeGreaterThan(unrelated);
    },
    120_000,
  );
});

/**
 * 8192 という数字そのものは `input-token-limit.test.ts` では測れない（モデルが持つ事実で、本物のモデルを落とさないと確かめられない）ので、ここで固定する。
 * 3本目では、私たちの検査を外したら実際に何が起きるか（8192 トークンを超えた入力が黙って切り捨てられ、後ろが一切ベクトルに効かない）を見せる。
 */
describe("live: 8192トークンの壁 (MNEMORA_LIVE_LOCAL_EMBEDDING が無ければ skipped と表示される)", () => {
  /** 巡回文字列にして連続する同一文字を無くす。`"あ".repeat(n)` は同じ文字の連続が大きな塊トークンに圧縮され（100文字で15トークン）、1文字足したときの増分が予測できず、二分探索が「ちょうど」を飛び越える。巡回させると増分が常に 0 か 1 になるので、「ちょうど target」を必ず一度は通る。 */
  const KANA_CYCLE =
    "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";

  function kanaText(length: number): string {
    let s = "";
    for (let i = 0; i < length; i++) s += KANA_CYCLE[i % KANA_CYCLE.length];
    return s;
  }

  /** 前提が崩れていたら返る文字列のトークン数は `target` と一致しない。呼び出し側で `tokenizer.encode(text).length` を実測して assert すること（この関数は成立を保証しない）。 */
  function findKanaTextWithExactTokenCount(
    tokenizer: LocalEmbeddingTokenizer,
    target: number,
  ): { text: string; length: number } {
    const tokenCountAt = (n: number) => tokenizer.encode(kanaText(n)).length;
    let hi = 1;
    while (tokenCountAt(hi) < target) hi *= 2;
    let lo = 0;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (tokenCountAt(mid) >= target) hi = mid;
      else lo = mid + 1;
    }
    return { text: kanaText(lo), length: lo };
  }

  function extendKanaTextToExactTokenCount(
    tokenizer: LocalEmbeddingTokenizer,
    fromLength: number,
    target: number,
  ): { text: string; length: number } {
    let n = fromLength;
    let text = kanaText(n);
    while (tokenizer.encode(text).length < target) {
      n += 1;
      text = kanaText(n);
    }
    return { text, length: n };
  }

  /** `tokenizer.model_max_length` だけ巨大な値に差し替えて包む。`encode` は本物をそのまま使う。こうすると私たちの事前チェックは発火せず、`extractor(texts, ...)` 内部の本物の `model_max_length`（8192）による `truncation: true` の黙った切り詰めが露出する。それが3本目で実測する「穴」。 */
  function withHugeDeclaredLimit(extractor: LocalEmbeddingExtractor): LocalEmbeddingExtractor {
    return Object.assign(
      (texts: string[], options: { pooling: "mean"; normalize: boolean }) =>
        extractor(texts, options),
      {
        tokenizer: {
          model_max_length: 10_000_000,
          encode: (text: string) => extractor.tokenizer.encode(text),
        },
      },
    ) as unknown as LocalEmbeddingExtractor;
  }

  /** プロセス内で1回だけ読み込んで使い回し、36MB のモデル読み込みを1回に畳む。`live` が真の `it` の中からしか呼ばない（opt-in していないときにモデルを読み込まない）。1本目は公開関数 `createLocalEmbeddingPipeline` を直接使うので、意図的に別読み込みになる。 */
  let sharedRealExtractorPromise: Promise<LocalEmbeddingExtractor> | null = null;
  function loadSharedRealExtractor(): Promise<LocalEmbeddingExtractor> {
    sharedRealExtractorPromise ??= (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const extractor = await pipeline("feature-extraction", DEFAULT_LOCAL_EMBEDDING_REPO, {
        dtype: DEFAULT_LOCAL_EMBEDDING_DTYPE,
        session_options: {
          intraOpNumThreads: DEFAULT_LOCAL_EMBEDDING_NUM_THREADS,
          interOpNumThreads: 1,
        },
      });
      return extractor as unknown as LocalEmbeddingExtractor;
    })();
    return sharedRealExtractorPromise;
  }

  it.skipIf(!live)(
    "歯1: 本物のモデルが宣言する上限は、逐語で 8192 トークンである",
    async () => {
      const spec: LocalEmbeddingModelSpec = {
        repo: DEFAULT_LOCAL_EMBEDDING_REPO,
        dtype: DEFAULT_LOCAL_EMBEDDING_DTYPE,
        cacheDir: undefined,
        numThreads: DEFAULT_LOCAL_EMBEDDING_NUM_THREADS,
      };
      const pipeline = await createLocalEmbeddingPipeline(spec);

      // 二分探索は要らない。「確実に超えている」ことだけが要る（かな巡回 20,000 文字は 15,000 トークン超になる）。
      const error = await pipeline.embed([kanaText(20_000)]).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(isLocalEmbeddingProviderError(error)).toBe(true);
      const typed = error as LocalEmbeddingProviderError;
      expect(typed.kind).toBe("input_too_long");
      // 8192 をどこかの定数から組み立てない。モデルが持つ事実を、逐語のリテラルで固定する。
      expect(typed.detail?.maxInputTokens).toBe(8192);
      console.error(`[歯1] detail.maxInputTokens = ${typed.detail?.maxInputTokens}`);
    },
    120_000,
  );

  it.skipIf(!live)(
    "歯2: 上限ちょうど（8192トークン）は通り、1トークン超える（8193トークン）と落ちる",
    async () => {
      const extractor = await loadSharedRealExtractor();
      const tokenizer = extractor.tokenizer;
      const pipeline = buildLocalEmbeddingPipeline(extractor);

      const exact8192 = findKanaTextWithExactTokenCount(tokenizer, 8192);
      const exact8192Tokens = tokenizer.encode(exact8192.text).length;
      expect(exact8192Tokens).toBe(8192);

      const exact8193 = extendKanaTextToExactTokenCount(tokenizer, exact8192.length + 1, 8193);
      const exact8193Tokens = tokenizer.encode(exact8193.text).length;
      expect(exact8193Tokens).toBe(8193);

      console.error(
        `[歯2] 8192トークンちょうど: ${exact8192.text.length} 文字 / ` +
          `8193トークンちょうど: ${exact8193.text.length} 文字`,
      );

      const vectors = await pipeline.embed([exact8192.text]);
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toHaveLength(256);

      // 境界が `>` であることの固定（`>=` なら8192ちょうども落ちるはず）。
      const error = await pipeline.embed([exact8193.text]).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(isLocalEmbeddingProviderError(error)).toBe(true);
      const typed = error as LocalEmbeddingProviderError;
      expect(typed.kind).toBe("input_too_long");
      expect(typed.detail?.tokens).toBe(8193);
      expect(typed.detail?.maxInputTokens).toBe(8192);
    },
    240_000,
  );

  it.skipIf(!live)(
    "歯3: 🔴 検査を外すと、8192トークンを超えた分は黙って切り捨てられ、ベクトルに一切効かない",
    async () => {
      const extractor = await loadSharedRealExtractor();
      const tokenizer = extractor.tokenizer;

      // 共有の前半は 8300 トークンにして、「後半200文字が違う」という分岐点が切り詰め点よりずっと後ろに来るようにする。
      const shared = findKanaTextWithExactTokenCount(tokenizer, 8300);
      expect(tokenizer.encode(shared.text).length).toBe(8300);

      const variantA = shared.text + "X".repeat(200);
      const variantB = shared.text + "Y".repeat(200);
      const tokensA = tokenizer.encode(variantA).length;
      const tokensB = tokenizer.encode(variantB).length;
      expect(tokensA).toBeGreaterThan(8192);
      expect(tokensB).toBeGreaterThan(8192);

      const brokenPipeline = buildLocalEmbeddingPipeline(withHugeDeclaredLimit(extractor));
      const [vectorA] = await brokenPipeline.embed([variantA]);
      const [vectorB] = await brokenPipeline.embed([variantB]);
      const cos = cosine(vectorA ?? [], vectorB ?? []);
      // 報告に数字を持ち帰るため、有効桁を落とさずに出力する。
      console.error(
        `[歯3] 検査を外したときの cos(variantA, variantB) = ${cos} ` +
          `(共有前半 ${shared.text.length} 文字 / ${tokensA}トークン、後半200文字が違う)`,
      );
      expect(cos).toBeCloseTo(1, 6);

      const realPipeline = buildLocalEmbeddingPipeline(extractor);
      const error = await realPipeline.embed([variantA, variantB]).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(isLocalEmbeddingProviderError(error)).toBe(true);
      const typed = error as LocalEmbeddingProviderError;
      expect(typed.kind).toBe("input_too_long");
      expect(typed.detail?.maxInputTokens).toBe(8192);
    },
    300_000,
  );
});

/** 分割ありと無しの provider を比べる歯ではない。`maxBatchSize` 以下ではどちらも分割しないので、既定の provider と `maxBatchSize` を巨大にして分割を無効化した provider が、どちらも同じ1回の推論に帰着することを本物のモデル越しに確かめる。同じ `extractor` を両方に注入して、「2回モデルを読み込んだら値が変わった」という別の要因を排除する。 */
describe("live: maxBatchSize 以下の件数は、既定値と無効化のどちらでもビット一致する (Issue #1141 / ADR 0358、MNEMORA_LIVE_LOCAL_EMBEDDING が無ければ skipped と表示される)", () => {
  let sharedExtractorPromise: Promise<LocalEmbeddingExtractor> | null = null;
  function loadSharedExtractorForBatchTest(): Promise<LocalEmbeddingExtractor> {
    sharedExtractorPromise ??= (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const extractor = await pipeline("feature-extraction", DEFAULT_LOCAL_EMBEDDING_REPO, {
        dtype: DEFAULT_LOCAL_EMBEDDING_DTYPE,
        session_options: {
          intraOpNumThreads: DEFAULT_LOCAL_EMBEDDING_NUM_THREADS,
          interOpNumThreads: 1,
        },
      });
      return extractor as unknown as LocalEmbeddingExtractor;
    })();
    return sharedExtractorPromise;
  }

  it.skipIf(!live)(
    "既定値ちょうど（128件）: 既定の provider と maxBatchSize を無効化した provider の出力が Float32 のバイト列で完全一致する",
    async () => {
      const extractor = await loadSharedExtractorForBatchTest();
      const createPipeline: CreateLocalEmbeddingPipeline = async () =>
        buildLocalEmbeddingPipeline(extractor);

      const providerDefault = new LocalEmbeddingProvider({ createPipeline });
      const providerNoSplit = new LocalEmbeddingProvider({
        createPipeline,
        maxBatchSize: Number.MAX_SAFE_INTEGER,
      });

      const texts = Array.from(
        { length: DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE },
        (_, i) => `テスト用の短い文その${i}。`,
      );

      // 直列で呼ぶ（同じ extractor へ同時に2本の推論を投げて競合させない）。
      const vectorsDefault = await providerDefault.embed(
        { tenantId: "live-max-batch-size" },
        texts,
      );
      const vectorsNoSplit = await providerNoSplit.embed(
        { tenantId: "live-max-batch-size" },
        texts,
      );

      expect(vectorsDefault).toHaveLength(DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE);
      expect(vectorsNoSplit).toHaveLength(DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE);
      expect(toFloat32Bytes(vectorsDefault)).toEqual(toFloat32Bytes(vectorsNoSplit));
    },
    120_000,
  );

  it.skipIf(!live)(
    "既定値より少ない件数（3件）でも、同様にビット一致する",
    async () => {
      const extractor = await loadSharedExtractorForBatchTest();
      const createPipeline: CreateLocalEmbeddingPipeline = async () =>
        buildLocalEmbeddingPipeline(extractor);

      const providerDefault = new LocalEmbeddingProvider({ createPipeline });
      const providerNoSplit = new LocalEmbeddingProvider({
        createPipeline,
        maxBatchSize: Number.MAX_SAFE_INTEGER,
      });

      const texts = ["今日は雨が降っている", "会議は水曜日に延期になった", "猫が窓辺で眠っている"];

      const vectorsDefault = await providerDefault.embed(
        { tenantId: "live-max-batch-size" },
        texts,
      );
      const vectorsNoSplit = await providerNoSplit.embed(
        { tenantId: "live-max-batch-size" },
        texts,
      );

      expect(toFloat32Bytes(vectorsDefault)).toEqual(toFloat32Bytes(vectorsNoSplit));
    },
    120_000,
  );
});

/**
 * `./local-embedding-provider.conformance.test.ts` は本物のモデルの出力を写した再生に当てているので、onnxruntime の推論そのものと、バッチの組み方に依らないかはここでしか測れない。
 * `deterministic: true` の根拠は実測: 同じ extractor に同じ3本を2回渡し、768 成分を要素ごとに比較して不一致 0 件（`./fixtures/real-ruri-embeddings.json` の `provenance.determinismCheck`）。これは仕様の保証ではない。別のハードウェア・dtype・onnxruntime で崩れたら、契約を緩めて通さず、崩れたことを報告すること。
 * 順序の歯は、ここで初めて padding を伴う本物のバッチ処理に当たる。`embed([a,b])` と `embed([b,a])` は別々のバッチなので、成立するかは走らせるまで分からない。
 */
describe.skipIf(!live)(
  "live: 本物のモデルに対する EmbeddingProvider 適合テスト（ADR 0095 / Issue #116）",
  () => {
    describeEmbeddingProviderConformance({
      name: "LocalEmbeddingProvider（本物のモデル）",
      // 既定のまま、本物の重みを落としてプロセス内で推論する。suite は `createProvider` を `it` ごとに呼ぶ契約なので、モデルのロードも `it` ごとに走る。
      createProvider: () => new LocalEmbeddingProvider(),
      deterministic: true,
      texts: {
        a: "図書館は月曜日が休館日だ",
        b: "去年の夏は記録的な猛暑だった",
        c: "この味噌汁には出汁が効いている",
      },
      // モデルのロード（初回は取得も）が入るため、vitest の既定 5 秒ではまったく足りない。
      timeout: 300_000,
      // `overLimitText` は渡さない。「字数」は上限（トークン数）の代わりにならず（`"あ".repeat(100)` は15トークンにしかならない）、この歯を走らせずに正しい「確実に上限を超える」文字列を用意できないので、同じファイル内の歯1〜3（8192/8193 トークン境界）に測定を委ねる。
    });
  },
);
