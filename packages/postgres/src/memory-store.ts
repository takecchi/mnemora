import { sql } from "drizzle-orm";
import { defaultDecayStrategy } from "@mnemora/core";
import type {
  Ctx,
  EmbeddingStatus,
  Memory,
  MemoryId,
  MemoryStatus,
  MemoryStore,
  NewMemory,
  NewObservation,
  NewRecallRecord,
  Observation,
  ObservationId,
  OutboxJobKind,
  OutboxJobRecord,
  RecallId,
  RecallScope,
  ScopeAggregate,
} from "@mnemora/core";
import type { Db } from "./client.js";
import {
  isUuidLike,
  rowToMemory,
  rowToObservation,
  rowToOutboxJob,
  type MemoryRow,
  type ObservationRow,
  type OutboxJobRow,
} from "./mapping.js";

/**
 * `MemoryStore` の Postgres 実装（docs/architecture.md §5.1、docs/memory-model.md §10）。
 *
 * クエリは drizzle-orm の `sql` タグ付きテンプレートで書く。冪等な作成
 * （`createObservation` / `createMemory`）は `INSERT ... ON CONFLICT (...) WHERE ... DO NOTHING
 * RETURNING *` を使い、行が返らなかった場合（＝既存行と衝突した場合）だけ追加の SELECT で
 * 既存行を取得する。`ON CONFLICT` の衝突検出はテーブルの一意索引そのものが担うため、
 * 同時実行でも正しく機能する（先に commit した側の行だけが見える）。
 */
export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly db: Db) {}

  async createObservation(ctx: Ctx, input: NewObservation): Promise<Observation> {
    const externalId = input.externalId ?? null;
    const inserted = await this.db.execute(sql`
      INSERT INTO observations (id, tenant_id, subject_id, external_id, kind, payload, occurred_at, recorded_at)
      VALUES (
        gen_random_uuid(),
        ${ctx.tenantId},
        ${input.subjectId ?? null},
        ${externalId},
        ${input.kind},
        ${JSON.stringify(input.payload)}::jsonb,
        ${input.occurredAt ?? null},
        ${input.recordedAt ?? new Date()}
      )
      ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
      DO NOTHING
      RETURNING *
    `);
    if (inserted.rows.length > 0) {
      return rowToObservation(inserted.rows[0] as unknown as ObservationRow);
    }

    // externalId が null の場合は一意制約の対象外なので、ここに来るのは externalId が
    // 非 null で既存行と衝突したときだけである。
    const existing = await this.db.execute(sql`
      SELECT * FROM observations
      WHERE tenant_id = ${ctx.tenantId} AND external_id = ${externalId}
      LIMIT 1
    `);
    return rowToObservation(existing.rows[0] as unknown as ObservationRow);
  }

  async getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null> {
    // id 列は uuid 型。UUID の形をしていない入力は「存在しない」と同じ扱いにする
    // （実 DB 検査で判明: 素通しすると invalid input syntax for type uuid で例外になる）。
    if (!isUuidLike(id)) {
      return null;
    }
    const result = await this.db.execute(sql`
      SELECT * FROM observations WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    return result.rows.length > 0
      ? rowToObservation(result.rows[0] as unknown as ObservationRow)
      : null;
  }

  /**
   * transactional outbox（docs/architecture.md §3.4）: Observation の INSERT と outbox への
   * ジョブ書き込みを同一トランザクションで行う。`db.transaction()`（drizzle-orm が単一の
   * 接続上で `BEGIN`/`COMMIT` を発行する）を使う——`createObservation` と同じ
   * `ON CONFLICT ... DO NOTHING RETURNING *` の形を踏襲しつつ、新規作成が実際に起きた
   * ときだけ outbox 行を積む。
   */
  async createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }> {
    const externalId = input.externalId ?? null;
    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO observations (id, tenant_id, subject_id, external_id, kind, payload, occurred_at, recorded_at)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          ${input.subjectId ?? null},
          ${externalId},
          ${input.kind},
          ${JSON.stringify(input.payload)}::jsonb,
          ${input.occurredAt ?? null},
          ${input.recordedAt ?? new Date()}
        )
        ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL
        DO NOTHING
        RETURNING *
      `);

      if (inserted.rows.length === 0) {
        const existing = await tx.execute(sql`
          SELECT * FROM observations
          WHERE tenant_id = ${ctx.tenantId} AND external_id = ${externalId}
          LIMIT 1
        `);
        return {
          observation: rowToObservation(existing.rows[0] as unknown as ObservationRow),
          created: false,
          jobs: [],
        };
      }

      const observation = rowToObservation(inserted.rows[0] as unknown as ObservationRow);
      const jobs: OutboxJobRecord[] = [];
      for (const kind of jobKinds) {
        const jobResult = await tx.execute(sql`
          INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
          VALUES (
            gen_random_uuid(),
            ${ctx.tenantId},
            ${kind},
            ${JSON.stringify({ observationId: observation.id })}::jsonb,
            now(),
            0,
            now()
          )
          RETURNING *
        `);
        jobs.push(rowToOutboxJob(jobResult.rows[0] as unknown as OutboxJobRow));
      }
      return { observation, created: true, jobs };
    });
  }

  async createMemory(ctx: Ctx, input: NewMemory): Promise<Memory> {
    const sourceObservationId = input.sourceObservationId ?? null;
    const extractorVersion = input.extractorVersion ?? null;
    const provenanceKind = input.provenance.kind;

    const inserted = await this.db.execute(sql`
      INSERT INTO memories (
        id, tenant_id, subject_id,
        source_observation_id, extractor_version,
        content, content_hash, digest, digest_source,
        provenance_kind, provenance,
        status, superseded_by_id, contested_with_id,
        tags,
        occurred_at, recorded_at, last_reinforced_at,
        strength, half_life_hours, decay_floor_at,
        embedding_status,
        created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${ctx.tenantId}, ${input.subjectId ?? null},
        ${sourceObservationId}, ${extractorVersion},
        ${input.content}, ${input.contentHash}, ${input.digest}, ${input.digestSource},
        ${provenanceKind}, ${JSON.stringify(input.provenance)}::jsonb,
        ${input.status ?? "active"}, ${input.supersededById ?? null}, ${input.contestedWithId ?? null},
        ${sql.param(input.tags)},
        ${input.occurredAt ?? null}, ${input.recordedAt}, ${input.lastReinforcedAt ?? null},
        ${input.strength}, ${input.halfLifeHours}, ${input.decayFloorAt},
        ${input.embeddingStatus},
        now(), now()
      )
      ON CONFLICT (tenant_id, source_observation_id, extractor_version, content_hash)
        WHERE source_observation_id IS NOT NULL
      DO NOTHING
      RETURNING *
    `);
    if (inserted.rows.length > 0) {
      return rowToMemory(inserted.rows[0] as unknown as MemoryRow);
    }

    const existing = await this.db.execute(sql`
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId}
        AND source_observation_id = ${sourceObservationId}
        AND extractor_version IS NOT DISTINCT FROM ${extractorVersion}
        AND content_hash = ${input.contentHash}
      LIMIT 1
    `);
    return rowToMemory(existing.rows[0] as unknown as MemoryRow);
  }

  /**
   * transactional outbox（docs/architecture.md §3.4・memory-model.md §11 行3）: Memory の
   * INSERT と outbox への埋め込みジョブ書き込みを同一トランザクションで行う。抽出の
   * 冪等キーに衝突した場合（`created: false`）は埋め込みジョブを作らない——既に埋め込み済み
   * か、既に埋め込みジョブが積まれているはずの Memory に対して重複ジョブを積まない。
   */
  async createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> {
    const sourceObservationId = input.sourceObservationId ?? null;
    const extractorVersion = input.extractorVersion ?? null;
    const provenanceKind = input.provenance.kind;

    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO memories (
          id, tenant_id, subject_id,
          source_observation_id, extractor_version,
          content, content_hash, digest, digest_source,
          provenance_kind, provenance,
          status, superseded_by_id, contested_with_id,
          tags,
          occurred_at, recorded_at, last_reinforced_at,
          strength, half_life_hours, decay_floor_at,
          embedding_status,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${ctx.tenantId}, ${input.subjectId ?? null},
          ${sourceObservationId}, ${extractorVersion},
          ${input.content}, ${input.contentHash}, ${input.digest}, ${input.digestSource},
          ${provenanceKind}, ${JSON.stringify(input.provenance)}::jsonb,
          ${input.status ?? "active"}, ${input.supersededById ?? null}, ${input.contestedWithId ?? null},
          ${sql.param(input.tags)},
          ${input.occurredAt ?? null}, ${input.recordedAt}, ${input.lastReinforcedAt ?? null},
          ${input.strength}, ${input.halfLifeHours}, ${input.decayFloorAt},
          ${input.embeddingStatus},
          now(), now()
        )
        ON CONFLICT (tenant_id, source_observation_id, extractor_version, content_hash)
          WHERE source_observation_id IS NOT NULL
        DO NOTHING
        RETURNING *
      `);

      if (inserted.rows.length === 0) {
        const existing = await tx.execute(sql`
          SELECT * FROM memories
          WHERE tenant_id = ${ctx.tenantId}
            AND source_observation_id = ${sourceObservationId}
            AND extractor_version IS NOT DISTINCT FROM ${extractorVersion}
            AND content_hash = ${input.contentHash}
          LIMIT 1
        `);
        return {
          memory: rowToMemory(existing.rows[0] as unknown as MemoryRow),
          created: false,
          jobs: [],
        };
      }

      const memory = rowToMemory(inserted.rows[0] as unknown as MemoryRow);
      const jobs: OutboxJobRecord[] = [];
      for (const kind of jobKinds) {
        const jobResult = await tx.execute(sql`
          INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
          VALUES (
            gen_random_uuid(),
            ${ctx.tenantId},
            ${kind},
            ${JSON.stringify({ memoryId: memory.id })}::jsonb,
            now(),
            0,
            now()
          )
          RETURNING *
        `);
        jobs.push(rowToOutboxJob(jobResult.rows[0] as unknown as OutboxJobRow));
      }
      return { memory, created: true, jobs };
    });
  }

  async get(ctx: Ctx, id: MemoryId): Promise<Memory | null> {
    const result = await this.db.execute(sql`
      SELECT * FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    return result.rows.length > 0 ? rowToMemory(result.rows[0] as unknown as MemoryRow) : null;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    if (ids.length === 0) {
      return [];
    }
    const result = await this.db.execute(sql`
      SELECT * FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(ids)}::uuid[])
    `);
    return result.rows.map((row) => rowToMemory(row as unknown as MemoryRow));
  }

  /**
   * ADR 0028: `reextract` が「今回作られた content_hash の集合に含まれない既存 Memory」を
   * 判定するための列挙。**SELECT のみ**——索引は 0001_init.sql の一意索引
   * `uq_memories_extraction (tenant_id, source_observation_id, extractor_version, content_hash)`
   * が `(tenant_id, source_observation_id, extractor_version)` の前方一致で使える。
   */
  async listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]> {
    const result = await this.db.execute(sql`
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId}
        AND source_observation_id = ${observationId}
        AND extractor_version IS NOT DISTINCT FROM ${extractorVersion}
    `);
    return result.rows.map((row) => rowToMemory(row as unknown as MemoryRow));
  }

  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId },
  ): Promise<Memory> {
    const result = await this.db.execute(sql`
      UPDATE memories
      SET status = ${status},
          superseded_by_id = COALESCE(${opts?.supersededById ?? null}, superseded_by_id),
          updated_at = now()
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
      RETURNING *
    `);
    if (result.rows.length === 0) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    return rowToMemory(result.rows[0] as unknown as MemoryRow);
  }

  async setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory> {
    const result = await this.db.execute(sql`
      UPDATE memories
      SET embedding_status = ${status}, updated_at = now()
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
      RETURNING *
    `);
    if (result.rows.length === 0) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    return rowToMemory(result.rows[0] as unknown as MemoryRow);
  }

  async reinforce(ctx: Ctx, id: MemoryId, at: Date): Promise<Memory> {
    const current = await this.db.execute(sql`
      SELECT * FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    if (current.rows.length === 0) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const memory = rowToMemory(current.rows[0] as unknown as MemoryRow);
    const decayFloorAt = defaultDecayStrategy.floorAt({
      recordedAt: memory.recordedAt,
      lastReinforcedAt: at,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });

    const updated = await this.db.execute(sql`
      UPDATE memories
      SET last_reinforced_at = ${at}, decay_floor_at = ${decayFloorAt}, updated_at = now()
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
      RETURNING *
    `);
    return rowToMemory(updated.rows[0] as unknown as MemoryRow);
  }

  async recordUsage(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    if (memoryIds.length === 0) {
      return { insertedMemoryIds: [] };
    }
    const result = await this.db.execute(sql`
      INSERT INTO recall_usages (tenant_id, recall_id, memory_id, used_at)
      SELECT ${ctx.tenantId}, ${recallId}, m, now()
      FROM unnest(${sql.param(memoryIds)}::uuid[]) AS m
      ON CONFLICT (tenant_id, recall_id, memory_id) DO NOTHING
      RETURNING memory_id
    `);
    return {
      insertedMemoryIds: result.rows.map(
        (row) => (row as unknown as { memory_id: string }).memory_id,
      ),
    };
  }

  /**
   * roadmap.md 段階4/5・docs/recall.md §5「スコープの外延」（マネージャー決定、
   * packages/core の recall.ts の `ScopeAggregate` doc コメント参照）。
   *
   * **単一の集約クエリ**で、群カウント（第3階）・スコープ内総数・スコープを定義する
   * フィルタ（status/period）で落ちた件数・not_indexed 件数のすべてを返す。
   * ADR 0011 が段1から締め出した `count(*) OVER ()` と同じ理由——**別々のクエリから
   * 出すと、その間の書き込みで総和が一致しなくなる**——を、段5でも同じ形で守る。
   *
   * `status` の4分岐（scope 内 / archived / superseded / forgotten）と period の内外は、
   * すべて `FILTER (WHERE ...)` による条件付き集約として同じ `GROUP BY subject_id` の
   * 1回のスキャンで計算する。**superseded と forgotten は別々の列として数える**
   * （ADR 0027）——前者は機構の都合（より良い抽出に置き換えられた）、後者は製品の振る舞い
   * （利用者が意図して忘れさせた）であり、束ねると呼び出し側がどちらだったか判定できない。
   */
  async aggregateScope(ctx: Ctx, scope: RecallScope): Promise<ScopeAggregate> {
    const subjectFilter =
      scope.subjectId !== undefined ? sql`AND subject_id = ${scope.subjectId}` : sql``;
    const occurredAfter = scope.occurredAfter ?? null;
    const occurredBefore = scope.occurredBefore ?? null;

    // period 条件: 未指定側は常に真になる（フィルタなしを表す）。
    // occurred_at が NULL の Memory は recorded_at を代替の実効時刻として扱う
    // （docs/recall.md §7 の freshness 計算が occurred_at ?? recorded_at を使うのと同じ規約）。
    const inPeriod = sql`(
      ${occurredAfter}::timestamptz IS NULL OR COALESCE(occurred_at, recorded_at) >= ${occurredAfter}::timestamptz
    ) AND (
      ${occurredBefore}::timestamptz IS NULL OR COALESCE(occurred_at, recorded_at) <= ${occurredBefore}::timestamptz
    )`;

    const result = await this.db.execute(sql`
      SELECT
        subject_id AS key,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod}
        )::int AS in_scope,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND embedding_status = 'pending'
        )::int AS not_indexed_pending,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND embedding_status = 'failed'
        )::int AS not_indexed_failed,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND ${inPeriod} AND embedding_status = 'skipped'
        )::int AS not_indexed_skipped,
        count(*) FILTER (WHERE status = 'archived')::int AS archived,
        count(*) FILTER (WHERE status = 'superseded')::int AS superseded,
        count(*) FILTER (WHERE status = 'forgotten')::int AS forgotten,
        count(*) FILTER (
          WHERE status IN ('active', 'contested') AND NOT (${inPeriod})
        )::int AS period_filtered
      FROM memories
      WHERE tenant_id = ${ctx.tenantId} ${subjectFilter}
      GROUP BY subject_id
    `);

    const rows = result.rows.map(
      (row) =>
        row as unknown as {
          key: string | null;
          in_scope: number;
          not_indexed_pending: number;
          not_indexed_failed: number;
          not_indexed_skipped: number;
          archived: number;
          superseded: number;
          forgotten: number;
          period_filtered: number;
        },
    );

    const groups = rows
      .filter((row) => row.in_scope > 0)
      .map((row) => ({
        axis: "subject" as const,
        key: row.key,
        count: row.in_scope,
        countKind: "exact" as const,
      }));

    const sum = (
      field:
        | "in_scope"
        | "not_indexed_pending"
        | "not_indexed_failed"
        | "not_indexed_skipped"
        | "archived"
        | "superseded"
        | "forgotten"
        | "period_filtered",
    ) => rows.reduce((total, row) => total + row[field], 0);

    return {
      groups,
      totalInScope: sum("in_scope"),
      countKind: "exact",
      notIndexed: {
        pending: { count: sum("not_indexed_pending"), countKind: "exact" },
        failed: { count: sum("not_indexed_failed"), countKind: "exact" },
        skipped: { count: sum("not_indexed_skipped"), countKind: "exact" },
      },
      filteredArchived: { count: sum("archived"), countKind: "exact" },
      filteredSuperseded: { count: sum("superseded"), countKind: "exact" },
      filteredForgotten: { count: sum("forgotten"), countKind: "exact" },
      filteredPeriod: { count: sum("period_filtered"), countKind: "exact" },
    };
  }

  async createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId> {
    const result = await this.db.execute(sql`
      INSERT INTO recalls (
        id, tenant_id, subject_id, query, budget, omitted, usage, index_band, explain,
        returned_memory_ids, created_at
      ) VALUES (
        gen_random_uuid(), ${ctx.tenantId}, ${record.subjectId ?? null},
        ${JSON.stringify(record.query)}::jsonb,
        ${record.budget !== undefined && record.budget !== null ? JSON.stringify(record.budget) : null}::jsonb,
        ${JSON.stringify(record.omitted)}::jsonb,
        ${JSON.stringify(record.usage)}::jsonb,
        ${JSON.stringify(record.indexBand)}::jsonb,
        ${JSON.stringify(record.explain)}::jsonb,
        ${sql.param(record.returnedMemoryIds)}::uuid[],
        now()
      )
      RETURNING id
    `);
    return (result.rows[0] as unknown as { id: string }).id;
  }
}
