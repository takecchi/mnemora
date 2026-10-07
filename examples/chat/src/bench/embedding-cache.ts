/**
 * `association-scale-bench` 専用のファイル埋め込みキャッシュ。
 *
 * 保証するのは「同じテキストには同じ Float64 配列を返す」ところまで。pgvector は float4 で格納するため、
 * INSERT 後の値が arm 間で一致するかは保証せず、`association-scale-bench.ts` が DB から読み戻して確かめる。
 *
 * 保存は追記のみにしてある。途中終了してもファイルを壊さないため。起動時にインデックス行数と
 * `.vectors.f64` の実サイズが食い違えば例外にする。壊れたキャッシュを黙って使わない。
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

function keyFor(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const BYTES_PER_FLOAT = 8;

/**
 * ファイル裏付けの `text -> vector` キャッシュ。1インスタンス = 1つの `EmbeddingSpaceId`。
 *
 * 単一プロセス内での使用が前提。複数プロセスが同じ cacheDir へ同時に `put` すると、追記が割り込んで壊れうる。
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
  realEmbedMs: number;
}

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
 * `texts`（重複を含んでよい）を一意化し、キャッシュに無い分だけ `inner.embed()` をバッチで埋める。
 *
 * `concurrency` の既定は 1（直列）。ONNX セッションは既にスレッド内並列を使っており、
 * 複数バッチの同時実行で速くなるかは確かめていない。
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
