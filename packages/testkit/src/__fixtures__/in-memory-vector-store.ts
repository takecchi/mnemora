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
import { assertFloat4Vector, assertQueryDate, assertQueryInteger } from "./query-check.js";

interface Entry {
  tenantId: string;
  memoryId: MemoryId;
  vector: number[];
}

/**
 * `VectorHit.distance` の契約（`packages/core/src/interfaces/vector-store.ts`）に合わせて
 * コサイン距離を返す。以前はユークリッド距離だったが、`packages/postgres/src/vector-store.ts`
 * はコサイン距離（pgvector の `<=>`、`vector_cosine_ops`）を使っており、
 * `recall-runtime.ts` は `1 - distance` を similarity として扱う——ユークリッド距離のままでは
 * その意味論が崩れ、in-memory と postgres で「同じ入力に別の順序」が出てしまう。
 *
 * `packages/core/src/__tests__/runtime-fakes.ts` の `FakeVectorStore` に全く同じ実装
 * （`cosineDistance`）が既にあるが、`packages/testkit` は `packages/core` の**テストファイル**を
 * import できない（`packages/core` の実行時依存が zod のみであることを壊すことになる）ため、
 * ここで意図して重複させている。
 *
 * ゼロベクトルはコサインが未定義（0/0）になる。
 *
 * **🔴 訂正（[ADR 0040](../../../../docs/decisions/0040-zero-vector-never-returned.md)）**:
 * ここには以前「pgvector の `<=>` はゼロベクトルに対してエラーを返す」と書いてあったが、
 * **それは誤りだった。実測すると `NaN` を返す**（pgvector 0.8.2。両引数位置・両方ゼロ・
 * `ORDER BY` の中でも例外にならない）。
 *
 * そしてこの実装は「無関係（距離1）」を返していた。**⟹ 同じ呼び出しが adapter によって
 * 別の答えになっていた**——`similarity = 1 - distance` なので in-memory は
 * `similarity = 0`、Postgres は `NaN`。既定の `scoreThreshold`（0.1）では
 * どちらも落ちるが、**呼び出し側が `scoreThreshold` を 0 以下にすると
 * in-memory だけが候補を返していた。**
 *
 * **契約（ADR 0040）: ゼロベクトルが絡む候補は `recall()` の結果に出ない。**
 * `NaN` はどんな数との比較も false になるので、**どんな `scoreThreshold` でも通らない。**
 * `Infinity` は `scoreThreshold = -Infinity` で通ってしまうため使わない。
 *
 * **Issue #867 / 案B: 長さが違う2本を比較不能として扱う。** 以前はここが
 * `Math.max(a.length, b.length)` まで回し、足りない側を `?? 0` で zero-pad してから
 * 計算を続けていた——ノルムが0にならないため ADR 0040 の `NaN` 経路に乗らず、
 * 意味の無い実数の類似度を普通のヒットとして返していた（`omitted` にも何も残らない）。
 * `Postgres`（pgvector）は同じ入力で「different vector dimensions」の DB エラーになり、
 * adapter 間で挙動が割れていた。**長さが違う時点で比較不能**——`Math.max`/zero-pad より先に
 * `a.length !== b.length` を見て `NaN` を返す。`PostgresVectorStore.search` も
 * （`packages/postgres/src/vector-store.ts`）同じ場面でゼロベクトルに差し替えて
 * 同じ `NaN` 経路に乗せている。
 */
function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    // 上の doc コメント（Issue #867 / 案B）参照——長さが違う時点で比較不能。
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
    // ⚠ 0 でも 1 でも Infinity でもなく NaN を返す。理由は上の doc を参照
    //（どんな閾値と比べても通らない値でなければ契約を満たせない）。
    return Number.NaN;
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}

/**
 * `VectorStore` のインメモリ・プレースホルダ実装。索引・pgvector を模さない
 * 最小実装であり、`packages/testkit` の適合テストを実行できることを示すためだけのもの。
 *
 * **`memoryStore` を必須のコンストラクタ引数にしている（省略不可）。** `status` /
 * `subjectId` / `decayFloorAt` は Memory の属性であって、ベクトルの属性ではない
 * （`VectorFilter` — `packages/core/src/interfaces/vector-store.ts`）。
 * `packages/postgres/src/vector-store.ts` はこれを `JOIN memories m` で得ている
 * ——ADR 0003（`MemoryStore` が真実の源であり、`VectorStore` は再構築可能な派生索引で
 * あるという非対称）をそのまま実装した形であり、Postgres 側は外部キー
 * （`memory_id → memories(id)`）でこの非対称を強制してもいる。in-memory 実装が
 * `InMemoryMemoryStore` を参照するのは、同じ非対称を写しただけである
 * （`InMemoryOutboxStore` が `InMemoryMemoryStore.outboxJobs` を共有参照で受け取るのと
 * 同じ形、同じ理由）。
 *
 * **省略可能にしなかった理由（ADR 0034）**: 省略できると「filter を実際に検査できる
 * adapter」と「検査できない（＝常に無視しても壊れない）adapter」が同じ緑色の出力に
 * なる。このリポジトリは ADR 0011/0025/0027/0028 で同じ族の失敗
 * （名乗れる以上の精度を主張する）を繰り返しており、ここでも繰り返さない。
 *
 * **ベクトルは float4 に丸めて持つ**（Issue #1268）。`upsert` は成分を `Math.fround` で丸めて保存し、`search` は
 * クエリも丸めてから比べる——`@mnemora/postgres`（pgvector）が成分を float4 で持つのに揃え、何が距離の同点になるかを
 * Postgres と同じにする。`getVectors` が返すのも丸めた値である。距離の値の下の桁は Postgres と揃わない
 * （`VectorStore.search` の doc の 2026-09-28 追記を参照）。
 */
export class InMemoryVectorStore implements VectorStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly memoryStore: InMemoryMemoryStore) {
    // ADR 0426: `memory_embeddings_<space>.memory_id` の `ON DELETE CASCADE` に当たる動き——
    // `memories` の行が消えたら、全 space からその埋め込みを消す。
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
    // 区切り文字で繋がず、`JSON.stringify` の配列で表す。`provider`・`model` は `:` を含みうる
    // （`nomic-embed-text:latest` など）。繋いだ文字列の前方一致で空間を絞ると、空間 `{p, m, 3}` が
    // 空間 `{p, m:3, 3}` のベクトルを拾っていた（`joined-string-keys.postgres.test.ts`）。
    return JSON.stringify([space.provider, space.model, space.dimensions, tenantId, memoryId]);
  }

  async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
    assertWellFormedCtx(ctx);
    // ADR 0521: 大文字の id も同じ記憶として受け、小文字（この fixture の id の綴り）で持つ。
    memoryId = memoryId.toLowerCase() as MemoryId;
    // 外部キー相当（ADR 0047）: `memory_embeddings_<space>.memory_id → memories(id)`。
    // `search` は既に `this.memoryStore.get(...)` を真実の源として引いている
    // （クラス doc 参照）——書き込み側（upsert）でも同じ非対称を強制する。
    const memory = await this.memoryStore.get(ctx, memoryId);
    if (!memory) {
      throw new Error(`InMemoryVectorStore: memory not found for tenant: ${memoryId}`);
    }
    // 穴 O-6-2（ADR 0424）: float4 に収まらない成分は、`Math.fround` で Infinity にして保存せず断る
    // （Postgres の upsert は pgvector が拒む）。検索のクエリ側は投げない（下の `search`）。
    assertFloat4Vector("InMemoryVectorStore.upsert", vector);
    this.entries.set(this.key(space, ctx.tenantId, memoryId), {
      tenantId: ctx.tenantId,
      memoryId,
      // Issue #1108: 呼び手の配列と切り離して保存する（Postgres は値を写す）。
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
    // 条件の日時・通し番号は Postgres の型へ変換できなければならない（query-check.ts）。
    assertQueryDate("search", "filter.occurredAfter", opts.filter.occurredAfter);
    assertQueryDate("search", "filter.occurredBefore", opts.filter.occurredBefore);
    assertQueryDate("search", "filter.validAt", opts.filter.validAt);
    assertQueryDate("search", "filter.decayFloorAtAfter", opts.filter.decayFloorAtAfter);
    assertQueryInteger("search", "filter.decayFloorSeqAfter", opts.filter.decayFloorSeqAfter);
    // `PostgresVectorStore.search` は `opts.limit` を生 SQL の `LIMIT` にそのまま渡すため、
    // 負数を渡すと Postgres 自身が `LIMIT must not be negative` で例外を投げる
    // （実測済み）。ここで検査せず `hits.slice(0, opts.limit)` へ渡すと、
    // `Array.prototype.slice` の負数引数は「末尾から数えた除外」という別の意味になり、
    // ほぼ全件を静かに返してしまう——クエリを投げる前に弾く Postgres 側に揃える。
    //
    // ⚠ 負数だけでは足りない——`LIMIT` の SQL パラメータは bigint 型であり、`NaN`/
    // `Infinity`/非整数（例: `1.5`）を渡すと Postgres は
    // `invalid input syntax for type bigint: "NaN"` の形で例外を投げる（実測済み）。
    // `Array.prototype.slice` はこれらを黙って別の値へ丸める
    // （`ToIntegerOrInfinity`: `NaN`→`0`＝空配列、`Infinity`→全件、`1.5`→切り捨てて`1`）ため、
    // 検査しないと「limit が全く効いていない/黙って縮む」という誤った結果を返してしまう。
    // 既存の「負数」ガード（上の段落）とは別の例外メッセージにして、PR #811 が固定した
    // 「負数は例外」の回帰テストの文言を変えずに済ませる。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`search: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`search: limit must not be negative (got ${opts.limit})`);
    }
    // `LIMIT` の bigint に収まらない値（2^63 以上）も Postgres は拒む（実測: `value
    // "9223372036854776000" is out of range for type bigint`）。
    if (opts.limit >= 2 ** 63) {
      throw new Error(`search: limit must fit in a Postgres bigint (got ${opts.limit})`);
    }
    // 索引を模す prefix は space（provider/model/dimensions）だけで絞る。
    // テナント分離は `opts.filter.tenantId` と `ctx.tenantId` の**両方**の一致で行う（AND）。
    // ⚠ 以前は「`filter.tenantId` の一致だけで行う。`ctx.tenantId` で二重に絞ると
    // 『filter.tenantId を無視しても壊れない』誤ったプレースホルダになる」と書いて、
    // 意図して `ctx` を見ていなかった。Issue #1050 で、隔離の境界は `ctx.tenantId` だと
    // 決め直した（ADR 0007。`VectorStore.getVectors` の doc も同じ境界）——`filter.tenantId`
    // だけだと、2つが食い違ったとき `filter` 側のテナントの行が返る。`filter.tenantId` も
    // 引き続き見るので、`filter` を無視する誤りはこのプレースホルダでも隠れない。
    // 食い違えば0件（例外は投げない。`PostgresVectorStore` と core の `FakeVectorStore` も同じ）。
    // 歯は `in-memory-search-ctx-tenant-boundary.test.ts`。
    const memoryCtx: Ctx = { tenantId: opts.filter.tenantId };
    // pgvector はクエリも `::vector`（float4）に変換してから比べる。
    const float4Query = query.map(Math.fround);
    const hits: (VectorHit & { recordedAt: Date })[] = [];
    for (const [key, entry] of this.entries) {
      // 空間は `key()` の組の先頭3つを完全一致で比べる（前方一致にしない。`key()` の doc）。
      const [provider, model, dimensions] = JSON.parse(key) as [string, string, number];
      if (provider !== space.provider || model !== space.model || dimensions !== space.dimensions) {
        continue;
      }
      if (entry.tenantId !== opts.filter.tenantId || entry.tenantId !== ctx.tenantId) {
        continue;
      }
      // `status` / `subjectId` / `decayFloorAt` は Memory の属性であり、`memories`
      // 相当（`this.memoryStore`）を引かないと見られない（クラス doc 参照）。
      // Postgres 実装の `JOIN memories m ON m.id = e.memory_id` に対応する一段。
      const memory = await this.memoryStore.get(memoryCtx, entry.memoryId);
      if (!memory) {
        // Postgres の外部キー制約に対応する扱い——真実の源に無い vector は返さない。
        continue;
      }
      if (opts.filter.status !== undefined && !opts.filter.status.includes(memory.status)) {
        continue;
      }
      // Issue #608 項目③(b) / ADR 0286: `includeSubjectless: true` のときだけ、
      // `subject_id IS NULL`（主題なし）も通す——`PostgresVectorStore.search`
      // （`vector-store.ts` の `m.subject_id = ... OR m.subject_id IS NULL`）と同じ意味論。
      const subjectMatches =
        opts.filter.subjectId === undefined ||
        memory.subjectId === opts.filter.subjectId ||
        (opts.filter.includeSubjectless === true && memory.subjectId === null);
      if (!subjectMatches) {
        continue;
      }
      // Issue #152/#153（ADR 0312）: AND 等値の絞り込み——`PostgresVectorStore.search`
      // （`m.attributes @> ...::jsonb`）と同じ意味論。
      if (opts.filter.attributes !== undefined) {
        const memoryAttributes = memory.attributes ?? {};
        const attributesMatch = Object.entries(opts.filter.attributes).every(
          ([key, value]) => memoryAttributes[key] === value,
        );
        if (!attributesMatch) {
          continue;
        }
      }
      // Issue #201 PR-B（ADR 0323）: OR の集合絞り込み——`PostgresVectorStore.search`
      // （`m.tags && ...::text[]`）と同じ意味論。
      if (opts.filter.labels !== undefined) {
        const labels = opts.filter.labels;
        if (!memory.tags.some((tag) => labels.includes(tag))) {
          continue;
        }
      }
      // ADR 0165 決めたこと1・4・12（Issue #305）: 忘却ゲートの2軸。`decayFloorAnyAxis` が
      // true かつ両方の境界が渡されているときだけ OR で結ぶ——`PostgresVectorStore.search`
      // （`packages/postgres/src/vector-store.ts`）と同じ意味論。それ以外は今日どおり
      // AND のまま個別に効く。
      //
      // ⚠ **前任の作業者が実際に踏んだ漏れ2**（core commit 5e37afb の doc 参照）:
      // `decayFloorSeqAfter`/`decayFloorAnyAxis` を一度も見ない実装のままだと、
      // 'activity'/'either' の忘却ゲートが段1で正しく再現できない。ここで同じ漏れを
      // 作らない。
      const passesDecayFloorAt =
        opts.filter.decayFloorAtAfter === undefined ||
        // 狭義の `>`（境界とちょうど同じものは除外）。postgres 実装の
        // `m.decay_floor_at > ${decayFloorAtAfter}` と揃える。
        memory.decayFloorAt > opts.filter.decayFloorAtAfter;
      // 契約: `decay_floor_seq IS NULL` の行は通す（ADR 0165 決めたこと4「NULL はこの軸には
      // 床が無い＝活動時計では沈まない」）。ADR 0353（Issue #338）:
      // `decayFloorSeqUsesSubjectCounters` が true のときだけ、この行の subjectId に
      // 対応する `S_x`（`this.memoryStore.subjectActivitySeq`）を足す
      // （`activityFloorSeqAliveCondition`（postgres 側）と同じ式）。
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

      if (
        opts.filter.decayFloorAnyAxis === true &&
        opts.filter.decayFloorAtAfter !== undefined &&
        opts.filter.decayFloorSeqAfter !== undefined
      ) {
        if (!(passesDecayFloorAt || passesDecayFloorSeq)) {
          continue;
        }
      } else {
        if (!passesDecayFloorAt) {
          continue;
        }
        if (!passesDecayFloorSeq) {
          continue;
        }
      }
      // ADR 0056: 除外の列挙（status とは向きが逆）。`undefined`/空配列は no-op
      // （`VectorFilter.excludeProvenanceKinds` の doc 参照）。
      if (
        opts.filter.excludeProvenanceKinds !== undefined &&
        opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)
      ) {
        continue;
      }
      // ADR 0059: period（両端とも包含、`>=`/`<=`）。比較対象は
      // `occurredAt ?? recordedAt`——postgres 実装の
      // `COALESCE(m.occurred_at, m.recorded_at)` に対応する一段（ADR 0039 の実効時刻）。
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
      // Issue #280（Issue #202 第2弾）: `validAt` ゲート。両端 NULL は「いつでも真」
      // （`VectorFilter.validAt` の doc 参照）。`validUntil` は狭義の `>`（非包含）——
      // postgres 実装の `m.valid_until > ${validAt}` と揃える。
      if (opts.filter.validAt !== undefined) {
        if (memory.validFrom != null && memory.validFrom > opts.filter.validAt) {
          continue;
        }
        if (memory.validUntil != null && memory.validUntil <= opts.filter.validAt) {
          continue;
        }
      }
      hits.push({
        memoryId: entry.memoryId,
        distance: cosineDistance(float4Query, entry.vector),
        recordedAt: memory.recordedAt,
      });
    }
    // `PostgresVectorStore.search`（ADR 0170、Issue #339）と同じ3段 tie-break:
    // 距離 → `recordedAt` DESC → `memoryId` 昇順。以前はここが距離だけのソートで、
    // 同点の中身は `Array.prototype.sort` の安定性により**挿入順**（＝通常の呼び出し順では
    // `recordedAt` が古いほうが先）に落ちていた——Postgres 側の「新しい方が先」とは
    // 逆向きになり、`VectorStore.search` の doc が明記する「同点の順序も adapter の責務」
    // （距離だけでなく完全なタイブレークまで含めて決定的な順序を返すこと）を満たしていなかった
    // （`packages/testkit/src/__tests__/in-memory-vector-store-tiebreak.test.ts` が歯）。
    hits.sort((a, b) => {
      // 距離 `NaN`（ゼロベクトル、ADR 0040）は Postgres の `float8` と同じく、どの有限値よりも
      // 大きく、`NaN` どうしは同点として扱う（Issue #983）。`a.distance - b.distance` だけだと
      // `NaN` で比較関数が一貫せず、ゼロベクトルの候補の位置が挿入順しだいで揺れる。
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

  /**
   * Issue #377 / Issue #1412 の続き: `VectorStore.searchMany?` の実装。契約そのものが
   * 「各クエリを `search()` で単独に呼んだ結果と一致する。同じ key は後勝ち、`Map` の並びは最初に
   * 現れた位置」なので、`search()` を呼ぶ形にする——例外（`limit`・日時の検査）・float4 の丸め・
   * テナント境界が `search()` と自動で一致する。往復を束ねる利点は、DB を持たないこの実装には無い。
   */
  async searchMany(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    queries: { key: string; vector: number[] }[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<Map<string, VectorHit[]>> {
    assertWellFormedCtx(ctx);
    assertWellFormedFilter(opts.filter, "opts.filter");
    const result = new Map<string, VectorHit[]>();
    // `queries` が空なら `search()` を一度も呼ばないので、`limit` が不正でも投げない
    // （`PostgresVectorStore.searchMany` も空配列は往復せず空の Map を返す）。
    for (const q of queries) {
      result.set(q.key, await this.search(ctx, space, q.vector, opts));
    }
    return result;
  }

  async delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void> {
    assertWellFormedCtx(ctx);
    this.entries.delete(this.key(space, ctx.tenantId, memoryId.toLowerCase() as MemoryId));
  }

  /**
   * `ctx.tenantId` に属する `memoryIds` の行を、**この store が持つ全 space**（`key()` が
   * 区切る単位のすべて）から消す（Issue #1425、ADR 0382）。`key` は
   * `[provider, model, dimensions, tenantId, memoryId]` の組から作られるが、この store は
   * `entries` の値自身にも `tenantId`/`memoryId` を平文で持つ（`key()` を JSON.parse し
   * 直す必要が無い）——`tenantId`/`memoryId` の一致だけを見て、space（key の先頭3要素）は
   * 問わない。
   */
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

  /**
   * Issue #1207 / ADR 0383: `ctx.tenantId` に属する行を、**全 space**から `opts.limit`
   * を目安に消す。`deleteAcrossSpaces` と同じ「space（key の先頭3要素）は問わず、
   * `tenantId` の一致だけを見る」形。
   */
  async eraseTenant(ctx: Ctx, opts: EraseTenantStoreOptions): Promise<EraseTenantResult> {
    assertWellFormedCtx(ctx);
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
    // `key` は space + tenantId + memoryId から機械的に決まる（クラス冒頭の `key` 参照）
    // ので、tenant 境界は search と同じくキーの一致だけで自然に掛かる——他テナントの
    // memoryId が渡っても、そのテナントの key には一致しない。
    //
    // `PostgresVectorStore.getVectors` は `memory_id = ANY(...)` という集合演算で引く
    // （実測。`packages/postgres/src/vector-store.ts`）ため、同じ id を複数回渡しても
    // 一致する行は主キーの性質上1回しか無い（`InMemoryMemoryStore.getMany` の重複 id
    // 対応、PR #812 と同じ形の不一致）。ここで検査せず `memoryIds` をそのまま for-of
    // すると、同じ id の `VectorEntry` を重複して返してしまう——`seen` で2回目以降を
    // スキップし、Postgres の集合演算と同じ「一意な id の集合」に揃える。
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
