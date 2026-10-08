import type {
  Ctx,
  EmbeddingSpaceId,
  EraseTenantResult,
  EraseTenantStoreOptions,
  MemoryId,
  VectorEntry,
  VectorFilter,
  VectorHit,
  VectorStore,
} from "@mnemora/core";
import { assertWellFormedCtx, assertWellFormedFilter } from "@mnemora/core";
import type { InMemoryMemoryStore } from "./in-memory-memory-store.js";
import { replaceLoneSurrogates } from "./well-formed-text.js";
import {
  assertFloat4Vector,
  assertQueryBigint,
  assertQueryJsonWithoutNul,
  assertQueryLabelsWithoutNul,
  assertQueryDate,
  seqSumOverflowsBigint,
} from "./query-check.js";

interface Entry {
  tenantId: string;
  memoryId: MemoryId;
  vector: number[];
}

/**
 * `VectorHit.distance` の契約どおりコサイン距離を返す（pgvector の `<=>`。`recall-runtime.ts` は `1 - distance` を similarity として扱う）。
 * `packages/core` のテストファイルは import できない（core の実行時依存が zod のみであることを壊す）ので、`FakeVectorStore` の同じ実装を意図して重複させている。
 *
 * ゼロベクトルが絡む候補、長さが違う2本は、`NaN` を返す（ADR 0040）: `NaN` はどんな `scoreThreshold` との比較も false になり `recall()` の結果に出ない。
 * 0 や 1 を返すと `scoreThreshold` が 0 以下のときだけ候補が出て、adapter ごとに答えが割れる。`Infinity` は `scoreThreshold = -Infinity` で通るので使わない。
 * 長さの検査は `Math.max`/zero-pad より先に置く: zero-pad すると `NaN` 経路に乗らず、意味の無い類似度をヒットとして返す。
 */
function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return Number.NaN;
  }
  const length = a.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) {
    // `NaN` を返す（0・1・`Infinity` ではなく）。理由は上の doc を参照。
    return Number.NaN;
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}

/**
 * `VectorStore` のインメモリ・プレースホルダ実装。索引・pgvector を模さない最小実装。
 *
 * `memoryStore` は必須: `status` / `subjectId` / `decayFloorAt` は Memory の属性で、Postgres は `JOIN memories` で得ている。
 * 省略できると、filter を検査できる adapter と検査できない adapter が同じ緑の出力になる（ADR 0034）。
 *
 * ベクトルは float4 に丸めて持つ: `upsert` は成分を `Math.fround` で丸めて保存し、`search` はクエリも丸めてから比べる。
 * 何が距離の同点になるかを Postgres と揃えるため。`getVectors` が返すのも丸めた値。距離の値の下の桁は Postgres と揃わない。
 */
export class InMemoryVectorStore implements VectorStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly memoryStore: InMemoryMemoryStore) {
    // `memories` の行が消えたら、全 space からその埋め込みを消す（`ON DELETE CASCADE` に当たる動き）。
    memoryStore.onMemoriesDeleted((tenantId, memoryIds) => {
      const idSet = new Set<MemoryId>(memoryIds);
      for (const [key, entry] of this.entries) {
        if (entry.tenantId === tenantId && idSet.has(entry.memoryId)) {
          this.entries.delete(key);
        }
      }
    });
  }

  private key(space: EmbeddingSpaceId, tenantId: string, memoryId: MemoryId): string {
    // 区切り文字で繋がず `JSON.stringify` の配列にする: `provider`・`model` は `:` を含みうる（`nomic-embed-text:latest`）ので、前方一致で空間 `{p, m, 3}` が空間 `{p, m:3, 3}` のベクトルを拾う。
    return JSON.stringify([space.provider, space.model, space.dimensions, tenantId, memoryId]);
  }

  async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
    assertWellFormedCtx(ctx);
    // 大文字の id も同じ記憶として受け、小文字で持つ。
    memoryId = memoryId.toLowerCase() as MemoryId;
    // 外部キー相当: 書き込み側でも `memoryStore` を真実の源とする。
    const memory = await this.memoryStore.get(ctx, memoryId);
    if (!memory) {
      throw new Error(`InMemoryVectorStore: memory not found for tenant: ${memoryId}`);
    }
    // float4 に収まらない成分は、`Infinity` にして保存せず断る（検索のクエリ側は投げない）。
    assertFloat4Vector("InMemoryVectorStore.upsert", vector);
    this.entries.set(this.key(space, ctx.tenantId, memoryId), {
      tenantId: ctx.tenantId,
      memoryId,
      // 呼び手の配列と切り離して保存する。
      vector: vector.map(Math.fround),
    });
  }

  async search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    assertWellFormedCtx(ctx);
    assertWellFormedFilter(opts.filter, "opts.filter");
    // `labels`・`attributes` の NUL は、Postgres ではクエリの時点で拒まれる。
    assertQueryLabelsWithoutNul("search", "filter.labels", opts.filter.labels);
    // `filter.labels` の孤立サロゲートは、Postgres では U+FFFD に置き換わって比べられる。
    opts = {
      ...opts,
      filter: {
        ...opts.filter,
        ...(opts.filter.labels === undefined
          ? {}
          : { labels: opts.filter.labels.map((label) => replaceLoneSurrogates(label)) }),
      },
    };
    assertQueryJsonWithoutNul("search", "filter.attributes", opts.filter.attributes);
    // 読みの口の日時は下限（4714-11-24 BC）より前でも断らず、そのまま比べる（Postgres は下限へ寄せるが答えは同じ）。Invalid Date だけ断る。
    assertQueryDate("search", "filter.occurredAfter", opts.filter.occurredAfter);
    assertQueryDate("search", "filter.occurredBefore", opts.filter.occurredBefore);
    assertQueryDate("search", "filter.validAt", opts.filter.validAt);
    assertQueryDate("search", "filter.decayFloorAtAfter", opts.filter.decayFloorAtAfter);
    // `decayFloorSeqAfter` は `bigint` の引数（範囲外なら、行が無くても Postgres はクエリの時点で拒む）。
    assertQueryBigint("search", "filter.decayFloorSeqAfter", opts.filter.decayFloorSeqAfter);
    // 整数でない・負の `limit` は先に断る: `slice` は `NaN`→空、`Infinity`→全件、負数→「末尾から数えた除外」と黙って別の値に丸め、limit が効かない結果を返す。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`search: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`search: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値も Postgres は拒む。
    if (opts.limit >= 2 ** 63) {
      throw new Error(`search: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    // テナント分離は `opts.filter.tenantId` と `ctx.tenantId` の両方の一致で行う（AND）。隔離の境界は `ctx.tenantId`（ADR 0007）だが、
    // `filter.tenantId` も見ないと、`filter` を無視する誤りがこのプレースホルダで隠れる。食い違えば0件（例外は投げない）。
    const memoryCtx: Ctx = { tenantId: opts.filter.tenantId };
    // pgvector はクエリも `::vector`（float4）に変換してから比べる。
    const float4Query = query.map(Math.fround);
    const hits: (VectorHit & { recordedAt: Date })[] = [];
    for (const [key, entry] of this.entries) {
      // 空間は完全一致で比べる（前方一致にしない。`key()` 参照）。
      const [provider, model, dimensions] = JSON.parse(key) as [string, string, number];
      if (provider !== space.provider || model !== space.model || dimensions !== space.dimensions) {
        continue;
      }
      if (entry.tenantId !== opts.filter.tenantId || entry.tenantId !== ctx.tenantId) {
        continue;
      }
      // `status` / `subjectId` / `decayFloorAt` は Memory の属性なので、`memoryStore` を引いて見る。
      const memory = await this.memoryStore.get(memoryCtx, entry.memoryId);
      if (!memory) {
        // 真実の源に無い vector は返さない（外部キー制約に対応する）。
        continue;
      }
      if (opts.filter.status !== undefined && !opts.filter.status.includes(memory.status)) {
        continue;
      }
      // `includeSubjectless: true` のときだけ、`subject_id IS NULL`（主題なし）も通す。
      const subjectMatches =
        opts.filter.subjectId === undefined ||
        memory.subjectId === opts.filter.subjectId ||
        (opts.filter.includeSubjectless === true && memory.subjectId === null);
      if (!subjectMatches) {
        continue;
      }
      // AND 等値の絞り込み（`m.attributes @> ...::jsonb` と同じ）。
      if (opts.filter.attributes !== undefined) {
        const memoryAttributes = memory.attributes ?? {};
        const attributesMatch = Object.entries(opts.filter.attributes).every(
          ([key, value]) => memoryAttributes[key] === value,
        );
        if (!attributesMatch) {
          continue;
        }
      }
      // OR の集合絞り込み（`m.tags && ...::text[]` と同じ）。
      if (opts.filter.labels !== undefined) {
        const labels = opts.filter.labels;
        if (!memory.tags.some((tag) => labels.includes(tag))) {
          continue;
        }
      }
      // 忘却ゲートの2軸。`decayFloorAnyAxis` が true で両方の境界が渡されているときだけ OR で結び、それ以外は AND で個別に効く。
      const passesDecayFloorAt =
        opts.filter.decayFloorAtAfter === undefined ||
        // 狭義の `>`（境界とちょうど同じものは除外）。
        memory.decayFloorAt > opts.filter.decayFloorAtAfter;
      // `decay_floor_seq IS NULL` の行は通す（この軸には床が無い）。`decayFloorSeqUsesSubjectCounters` が true のときだけ、その行の subject の `S_x` を足す。
      const effectiveDecayFloorSeqAfter =
        opts.filter.decayFloorSeqAfter === undefined
          ? undefined
          : opts.filter.decayFloorSeqUsesSubjectCounters === true && memory.subjectId != null
            ? opts.filter.decayFloorSeqAfter +
              (this.memoryStore.subjectActivitySeq.get(ctx.tenantId)?.get(memory.subjectId) ?? 0)
            : opts.filter.decayFloorSeqAfter;
      const passesDecayFloorSeq =
        effectiveDecayFloorSeqAfter === undefined ||
        (memory.decayFloorSeq ?? null) === null ||
        memory.decayFloorSeq! > effectiveDecayFloorSeqAfter;

      // `decayFloorSeqAfter + S_x` が `bigint` を溢れるとき、Postgres は文ごと失敗する。ただし式が評価される行があるときだけ:
      // `decay_floor_seq` が非 NULL で subject を持つ行。2軸のときは壁時計が先に評価されるので、壁時計で落ちる行は式まで行かない。
      // ここでは印だけ付け、最後に（ほかの条件を通った行について）投げる。
      let seqSumOverflows = false;
      let rejectedBySeqCondition: boolean;
      const markSeqSumOverflow = (): void => {
        if (
          opts.filter.decayFloorSeqAfter !== undefined &&
          opts.filter.decayFloorSeqUsesSubjectCounters === true &&
          memory.subjectId != null &&
          (memory.decayFloorSeq ?? null) !== null &&
          seqSumOverflowsBigint(
            opts.filter.decayFloorSeqAfter,
            this.memoryStore.subjectActivitySeq.get(ctx.tenantId)?.get(memory.subjectId) ?? 0,
          )
        ) {
          seqSumOverflows = true;
        }
      };
      if (
        opts.filter.decayFloorAnyAxis === true &&
        opts.filter.decayFloorAtAfter !== undefined &&
        opts.filter.decayFloorSeqAfter !== undefined
      ) {
        if (!passesDecayFloorAt) {
          markSeqSumOverflow();
        }
        rejectedBySeqCondition = !(passesDecayFloorAt || passesDecayFloorSeq);
      } else {
        if (!passesDecayFloorAt) {
          continue;
        }
        markSeqSumOverflow();
        rejectedBySeqCondition = !passesDecayFloorSeq;
      }
      // 除外の列挙（status とは向きが逆）。`undefined`/空配列は no-op。
      if (
        opts.filter.excludeProvenanceKinds !== undefined &&
        opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)
      ) {
        continue;
      }
      // period（両端とも包含）。比較対象は `occurredAt ?? recordedAt`（`COALESCE(m.occurred_at, m.recorded_at)` に対応）。
      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      if (
        opts.filter.occurredAfter !== undefined &&
        !(effectiveTime >= opts.filter.occurredAfter)
      ) {
        continue;
      }
      if (
        opts.filter.occurredBefore !== undefined &&
        !(effectiveTime <= opts.filter.occurredBefore)
      ) {
        continue;
      }
      // `validAt` ゲート。両端 NULL は「いつでも真」。`validUntil` は狭義の `>`（非包含）。
      if (opts.filter.validAt !== undefined) {
        if (memory.validFrom != null && memory.validFrom > opts.filter.validAt) {
          continue;
        }
        if (memory.validUntil != null && memory.validUntil < opts.filter.validAt) {
          continue;
        }
      }
      if (seqSumOverflows) {
        throw new Error(
          `search: filter.decayFloorSeqAfter + own subject seq must fit in a Postgres bigint (got ${opts.filter.decayFloorSeqAfter} + ${this.memoryStore.subjectActivitySeq.get(ctx.tenantId)?.get(memory.subjectId!) ?? 0})`,
        );
      }
      if (rejectedBySeqCondition) {
        continue;
      }
      hits.push({
        memoryId: entry.memoryId,
        distance: cosineDistance(float4Query, entry.vector),
        recordedAt: memory.recordedAt,
      });
    }
    // 距離 → `recordedAt` DESC → `memoryId` 昇順の3段 tie-break（`PostgresVectorStore.search` と同じ）。距離だけだと同点が挿入順になり、Postgres の「新しい方が先」と逆になる。
    hits.sort((a, b) => {
      // 距離 `NaN`（ゼロベクトル）は Postgres の `float8` と同じくどの有限値よりも大きく、`NaN` どうしは同点とする。`a.distance - b.distance` だと比較関数が一貫しない。
      const aNaN = Number.isNaN(a.distance);
      const bNaN = Number.isNaN(b.distance);
      if (aNaN !== bNaN) return aNaN ? 1 : -1;
      if (!aNaN && a.distance !== b.distance) return a.distance - b.distance;
      const recordedAtDiff = b.recordedAt.getTime() - a.recordedAt.getTime();
      if (recordedAtDiff !== 0) return recordedAtDiff;
      return a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0;
    });
    return hits.slice(0, opts.limit).map(({ memoryId, distance }) => ({ memoryId, distance }));
  }

  /** `search()` を呼ぶ形にする: 例外・float4 の丸め・テナント境界が `search()` と自動で一致する（契約は、各クエリを単独に呼んだ結果と一致すること）。 */
  async searchMany(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    queries: { key: string; vector: number[] }[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<Map<string, VectorHit[]>> {
    assertWellFormedCtx(ctx);
    assertWellFormedFilter(opts.filter, "opts.filter");
    // `queries` が空でも、Postgres は往復の前に絞りの NUL を断る。
    assertQueryLabelsWithoutNul("searchMany", "filter.labels", opts.filter.labels);
    // `filter.labels` の孤立サロゲートは、Postgres では U+FFFD に置き換わって比べられる。
    opts = {
      ...opts,
      filter: {
        ...opts.filter,
        ...(opts.filter.labels === undefined
          ? {}
          : { labels: opts.filter.labels.map((label) => replaceLoneSurrogates(label)) }),
      },
    };
    assertQueryJsonWithoutNul("searchMany", "filter.attributes", opts.filter.attributes);
    const result = new Map<string, VectorHit[]>();
    // `queries` が空なら `search()` を呼ばないので、`limit` が不正でも投げない（`PostgresVectorStore.searchMany` も同じ）。
    for (const q of queries) {
      result.set(q.key, await this.search(ctx, space, q.vector, opts));
    }
    return result;
  }

  async delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void> {
    assertWellFormedCtx(ctx);
    this.entries.delete(this.key(space, ctx.tenantId, memoryId.toLowerCase() as MemoryId));
  }

  /** `ctx.tenantId` に属する `memoryIds` の行を、この store が持つ全 space から消す（space は問わない）。 */
  async deleteAcrossSpaces(ctx: Ctx, memoryIds: readonly MemoryId[]): Promise<void> {
    assertWellFormedCtx(ctx);
    if (memoryIds.length === 0) {
      return;
    }
    const idSet = new Set<MemoryId>(memoryIds.map((id) => id.toLowerCase() as MemoryId));
    for (const [key, entry] of this.entries) {
      if (entry.tenantId === ctx.tenantId && idSet.has(entry.memoryId)) {
        this.entries.delete(key);
      }
    }
  }

  /** `ctx.tenantId` に属する行を、全 space から `opts.limit` を目安に消す。 */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
    // `limit` は `bigint` の引数へ渡される。
    assertQueryBigint("eraseTenant", "limit", opts.limit);
    const matchingKeys: string[] = [];
    for (const [key, entry] of this.entries) {
      if (matchingKeys.length >= opts.limit) {
        break;
      }
      if (entry.tenantId === ctx.tenantId) {
        matchingKeys.push(key);
      }
    }
    if (!opts.dryRun) {
      for (const key of matchingKeys) {
        this.entries.delete(key);
      }
    }
    return { deleted: matchingKeys.length, reachedLimit: matchingKeys.length === opts.limit };
  }

  async getVectors(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryIds: MemoryId[],
  ): Promise<VectorEntry[]> {
    assertWellFormedCtx(ctx);
    // 同じ id を複数回渡しても1回しか返さない: Postgres は `memory_id = ANY(...)` の集合演算で引くので、重複した `VectorEntry` を返すと食い違う。
    const seen = new Set<MemoryId>();
    const results: VectorEntry[] = [];
    for (const rawMemoryId of memoryIds) {
      const memoryId = rawMemoryId.toLowerCase() as MemoryId;
      if (seen.has(memoryId)) {
        continue;
      }
      seen.add(memoryId);
      const entry = this.entries.get(this.key(space, ctx.tenantId, memoryId));
      if (entry !== undefined) {
        results.push({ memoryId, vector: [...entry.vector] });
      }
    }
    return results;
  }
}
