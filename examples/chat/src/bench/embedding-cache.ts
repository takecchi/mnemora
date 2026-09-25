/**
 * `association-scale-bench` 専用のファイル埋め込みキャッシュ（Issue #337 段1）。
 *
 * ## なぜ要るか
 *
 * `association-scale-bench.ts` は同じテキスト集合（probe + haystack + filler）を、
 * arm（off/on-3/on-5/on-10）の数だけ繰り返し ingest する（各 arm を「きれいな比較」の
 * ために独立した TRUNCATE+ingest として走らせるため——本ファイルの利用元の docstring
 * 参照）。**埋め込み自体（`local` / ruri-v3-30m、実 ONNX 推論）はテキストの関数であり、
 * arm には依存しない。** 毎回 CPU 推論をやり直すと、10万行規模では埋め込み生成の
 * コストが arm 数倍（本ベンチでは4倍）に膨らむ——ここをテキスト→ベクトルのファイル
 * キャッシュで断つ。
 *
 * ## 何を保証するか / しないか
 *
 * - **保証する**: 同じテキスト（バイト同一）に対しては、同じ `EmbeddingSpaceId`
 *   （provider/model/dimensions）の下で、**常に同じ Float64 配列を返す**
 *   （初回は実推論 → キャッシュへ書き込み、2回目以降はキャッシュから読む）。
 *   ⟹ 全 arm が同じキャッシュを共有する限り、DB へ upsert する直前の JS 配列は
 *   arm 間でビット単位（Float64 として）で同一になる——**構造的に**そうなる
 *   （同じ Map から同じ key で読むだけであり、arm ごとに何かを作り直さない）。
 * - **保証しない**: pgvector の列型は `vector(dims)`＝**float4（単精度）**で格納する
 *   （`packages/postgres/src/vector-space.ts` の `CREATE TABLE`）。ここでの Float64 の
 *   ビット同一性は「アプリ側で構築した配列」までの話であり、**Postgres に INSERT した
 *   後の値**は float4 への丸めを経る。丸め後の値が arm 間で一致するかどうかは、
 *   `association-scale-bench.ts` 側が実際に DB から読み戻して確かめる
 *   （本ファイルの責務ではない——ここは「同じ入力を渡している」ことだけを保証する）。
 *
 * ## 保存形式
 *
 * `${cacheDir}/${spaceSlug}.index.ndjson`（追記のみ、`{"key":"<sha256>","row":<int>}\n`）と
 * `${cacheDir}/${spaceSlug}.vectors.f64`（追記のみ、Float64 の LE バイト列を row 順に
 * 連結）の2ファイル1組。**追記のみ**にしてあるのは、途中終了（プロセスが落ちる・
 * Ctrl-C）してもファイルが壊れない設計にするため——起動時に「インデックスの行数 ×
 * 次元 × 8バイト」と `.vectors.f64` の実サイズを突き合わせ、食い違っていれば
 * （末尾が壊れている可能性があるので）例外にする。**壊れたキャッシュを黙って使わない。**
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Ctx, EmbeddingProvider, EmbeddingSpaceId } from "@mnemora/core";

function spaceSlug(space: EmbeddingSpaceId): string {
  const raw = `${space.provider}_${space.model}_${space.dimensions}`;
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

/** テキストの sha256(hex)。空間ごとにファイルを分けているので空間名は key に含めない。 */
function keyFor(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const BYTES_PER_FLOAT = 8;

/**
 * ファイル裏付けの `text -> vector` キャッシュ。1インスタンス = 1つの `EmbeddingSpaceId`。
 *
 * ⚠ **単一プロセス内での使用を前提にしている**（複数プロセスが同じ cacheDir へ同時に
 * `put` すると、追記の割り込みで壊れうる——本ベンチは単一プロセスから直列に呼ぶ
 * ことを前提にしており、並列化する場合はプロセス内の `Promise.all` に留めること）。
 */
export class FileEmbeddingCache {
  readonly #dims: number;
  readonly #indexFd: number;
  readonly #dataFd: number;
  readonly #map: Map<string, number>;
  #rows: number;

  constructor(cacheDir: string, space: EmbeddingSpaceId) {
    mkdirSync(cacheDir, { recursive: true });
    const slug = spaceSlug(space);
    const indexPath = join(cacheDir, `${slug}.index.ndjson`);
    const dataPath = join(cacheDir, `${slug}.vectors.f64`);
    this.#dims = space.dimensions;
    this.#map = new Map();
    this.#rows = 0;

    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        const rec = JSON.parse(trimmed) as { key: string; row: number };
        this.#map.set(rec.key, rec.row);
        this.#rows = Math.max(this.#rows, rec.row + 1);
      }
    }

    this.#indexFd = openSync(indexPath, "a");
    this.#dataFd = openSync(dataPath, "a+");

    const stat = fstatSync(this.#dataFd);
    const expectedBytes = this.#rows * this.#dims * BYTES_PER_FLOAT;
    if (stat.size !== expectedBytes) {
      throw new Error(
        `FileEmbeddingCache: ${dataPath} のサイズ(${stat.size}バイト)が、` +
          `インデックス(${this.#rows}行 × ${this.#dims}次元 × ${BYTES_PER_FLOAT}バイト = ` +
          `${expectedBytes}バイト)と食い違う。前回の書き込みが途中で終わった可能性がある。` +
          `${indexPath} / ${dataPath} を退避してやり直すこと。`,
      );
    }
  }

  get size(): number {
    return this.#map.size;
  }

  has(text: string): boolean {
    return this.#map.has(keyFor(text));
  }

  get(text: string): number[] | undefined {
    const row = this.#map.get(keyFor(text));
    if (row === undefined) {
      return undefined;
    }
    const buf = Buffer.alloc(this.#dims * BYTES_PER_FLOAT);
    readSync(this.#dataFd, buf, 0, buf.length, row * this.#dims * BYTES_PER_FLOAT);
    const out = new Array<number>(this.#dims);
    for (let i = 0; i < this.#dims; i += 1) {
      out[i] = buf.readDoubleLE(i * BYTES_PER_FLOAT);
    }
    return out;
  }

  /** 既にある key への `put` は無視する(冪等——先勝ち。同じテキストは同じベクトルのはず)。 */
  put(text: string, vector: number[]): void {
    const key = keyFor(text);
    if (this.#map.has(key)) {
      return;
    }
    if (vector.length !== this.#dims) {
      throw new Error(
        `FileEmbeddingCache.put: 次元不一致(期待 ${this.#dims}, 実際 ${vector.length})。` +
          "cacheDir を空間ごとに分けているか確認すること。",
      );
    }
    const row = this.#rows;
    const buf = Buffer.alloc(this.#dims * BYTES_PER_FLOAT);
    for (let i = 0; i < this.#dims; i += 1) {
      buf.writeDoubleLE(vector[i]!, i * BYTES_PER_FLOAT);
    }
    writeSync(this.#dataFd, buf);
    writeSync(this.#indexFd, `${JSON.stringify({ key, row })}\n`);
    this.#map.set(key, row);
    this.#rows += 1;
  }

  close(): void {
    closeSync(this.#indexFd);
    closeSync(this.#dataFd);
  }
}

export interface CachingEmbeddingProviderStats {
  hits: number;
  misses: number;
  /** 実推論(cache miss)に使った累計ms。 */
  realEmbedMs: number;
}

/**
 * `EmbeddingProvider` を包み、`FileEmbeddingCache` 経由でテキスト→ベクトルを引く。
 * miss したテキストだけ内側の provider（実 ONNX 推論）へ渡し、結果をキャッシュへ書く。
 *
 * **`packages/core`/`packages/local-embedding` は一切変更していない**——このクラスは
 * `EmbeddingProvider` 契約（`embed(ctx, texts) => Promise<number[][]>`）を満たすだけの
 * 薄いラッパーであり、`examples/chat` の中だけに閉じる。
 */
export class CachingEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  readonly stats: CachingEmbeddingProviderStats = { hits: 0, misses: 0, realEmbedMs: 0 };
  readonly #inner: EmbeddingProvider;
  readonly #cache: FileEmbeddingCache;

  constructor(inner: EmbeddingProvider, cache: FileEmbeddingCache) {
    this.#inner = inner;
    this.#cache = cache;
    this.space = inner.space;
  }

  async embed(ctx: Ctx, texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const out: (number[] | undefined)[] = texts.map((t) => this.#cache.get(t));
    const missIndexes: number[] = [];
    for (let i = 0; i < texts.length; i += 1) {
      if (out[i] === undefined) {
        missIndexes.push(i);
      }
    }
    if (missIndexes.length > 0) {
      const missTexts = missIndexes.map((i) => texts[i]!);
      const t0 = performance.now();
      const missVectors = await this.#inner.embed(ctx, missTexts);
      this.stats.realEmbedMs += performance.now() - t0;
      this.stats.misses += missIndexes.length;
      for (let j = 0; j < missIndexes.length; j += 1) {
        const i = missIndexes[j]!;
        const vector = missVectors[j]!;
        out[i] = vector;
        this.#cache.put(missTexts[j]!, vector);
      }
    }
    this.stats.hits += texts.length - missIndexes.length;
    // `out` の各要素は上で全部埋まっている(cache hit か、直前の miss 処理のどちらか)。
    return out as number[][];
  }
}

export interface PrecomputeEmbeddingCacheResult {
  uniqueTextCount: number;
  hitCount: number;
  missCount: number;
  ms: number;
}

/**
 * `texts`(重複を含んでよい)を一意化し、キャッシュに無い分だけ `inner.embed()` を
 * バッチ呼び出しで埋める(「生成は並列化・バッチ化して速くしてよい」——Issue #337
 * 段1の依頼)。
 *
 * **バッチ化**: `batchSize` 件ずつ1回の `embed()` 呼び出しにまとめる——
 * `runtime.observe()`→`tick()` の通常経路は1ジョブ1テキストで `embed()` を呼ぶ
 * （`packages/core/src/runtime.ts` の `processEmbedJob`）が、ここは ingest 経路を
 * 経由しない直接呼び出しなので、まとめて渡せる。
 *
 * **並列化**: `concurrency > 1` でバッチを `Promise.all` で束ねる。既定は 1(直列)。
 * `@mnemora/local-embedding` の ONNX セッションは `numThreads`(既定4)でスレッド内
 * 並列を既に使っており、複数バッチを同時に investigate わせたときに追加の高速化が
 * あるかは**確かめていない**——確かめた上で有効にしたい場合は呼び出し側で
 * `concurrency` を上げること。
 */
export async function precomputeEmbeddingCache(
  inner: EmbeddingProvider,
  cache: FileEmbeddingCache,
  texts: readonly string[],
  options: { batchSize?: number; concurrency?: number; ctx?: Ctx } = {},
): Promise<PrecomputeEmbeddingCacheResult> {
  const batchSize = options.batchSize ?? 64;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const ctx: Ctx = options.ctx ?? { tenantId: "embedding-cache-precompute" };

  const uniqueTexts = Array.from(new Set(texts));
  const missing = uniqueTexts.filter((t) => !cache.has(t));
  const hitCount = uniqueTexts.length - missing.length;

  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += batchSize) {
    batches.push(missing.slice(i, i + batchSize));
  }

  const t0 = performance.now();
  for (let i = 0; i < batches.length; i += concurrency) {
    const chunk = batches.slice(i, i + concurrency);
    const vectorsByBatch = await Promise.all(chunk.map((batch) => inner.embed(ctx, batch)));
    for (let b = 0; b < chunk.length; b += 1) {
      const batch = chunk[b]!;
      const vectors = vectorsByBatch[b]!;
      for (let k = 0; k < batch.length; k += 1) {
        cache.put(batch[k]!, vectors[k]!);
      }
    }
  }
  const ms = performance.now() - t0;

  return { uniqueTextCount: uniqueTexts.length, hitCount, missCount: missing.length, ms };
}
