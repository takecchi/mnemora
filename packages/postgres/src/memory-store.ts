import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { defaultActivityDecayStrategy, defaultDecayStrategy } from "@mnemora/core";
import {
  ContestedWithoutCompanionError,
  EMBEDDING_STATUS_ROLLBACK,
  isContestedWithoutCompanion,
  MemoryPurgeConflictError,
  MemoryStatusConflictError,
} from "@mnemora/core";
import type {
  AggregateScopeOptions,
  ArchiveDecayedOptions,
  ArchiveDecayedResult,
  ClaimKey,
  Ctx,
  EmbeddingStatus,
  EventActor,
  LabelSummary,
  Memory,
  MemoryEvent,
  MemoryId,
  MemoryStatus,
  MemoryStore,
  NewMemory,
  NewMemoryEvent,
  NewObservation,
  NewRecallRecord,
  Observation,
  ObservationId,
  OutboxJobKind,
  OutboxJobRecord,
  PurgeExpiredEventsOptions,
  PurgeExpiredEventsResult,
  RecallId,
  RecallRecord,
  RecallRecordReturnedMemories,
  RecallScope,
  ReinforceOptions,
  RequeueEmbedJobsOptions,
  RequeueEmbedJobsResult,
  ScopeAggregate,
} from "@mnemora/core";
import type { Db } from "./client.js";
import { maybeAnalyzeMemoriesAfterWrite } from "./memories-statistics.js";
import {
  isUuidLike,
  parsePgTimestamp,
  rowToLabel,
  rowToMemory,
  rowToMemoryEvent,
  rowToObservation,
  rowToOutboxJob,
  rowToRecallRecord,
  type LabelRow,
  type MemoryEventRow,
  type MemoryRow,
  type ObservationRow,
  type OutboxJobRow,
  type RecallRow,
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
/**
 * `db.transaction(async (tx) => ...)` に渡るコールバック引数と、トランザクションを
 * 開いていない `this.db` の両方を受け付けるための構造的な最小 interface。
 *
 * 個々の `.execute(sql\`...\`)` 呼び出ししか使わない `upsertProposedLabels` にとっては、
 * 呼び出し元が `Db`（`createMemory` のようにこのメソッド自身がトランザクションを開く場合）
 * であろうと、`db.transaction` のコールバック引数（`createMemoryWithOutbox`/
 * `supersedeWithNewMemories` のように、既に開いているトランザクションに相乗りする場合）
 * であろうと違いが無い——両方とも `.execute` を持つ。
 */
type SqlExecutor = Pick<Db, "execute">;

export class PostgresMemoryStore implements MemoryStore {
  constructor(private readonly db: Db) {}

  /**
   * Issue #201 / [ADR 0318](../../../docs/decisions/0318-taxonomy-labels.md):
   * 新規作成された Memory の `tags` から `proposed` ラベルを作り・件数を数え、
   * `memory_labels` で結び付ける。
   *
   * 🔴 **呼び出し元と同一トランザクションで実行すること。**`createMemory`/
   * `createMemoryWithOutbox`/`supersedeWithNewMemories` のいずれも、この呼び出しは
   * 「新しい Memory 行を実際に挿入した」ときだけ行う——冪等衝突で既存行を返した
   * ときは呼ばない（`tags` は作成時にしか書けない列であり、既存行に対してラベルを
   * 二重に数える理由が無い。`docs/memory-model.md` §8 にはこの区別についての明記は
   * 無いが、`createMemoryWithOutbox` が冪等衝突時に outbox ジョブを積まないのと
   * 同じ判断を踏襲する）。
   *
   * `tags` が空配列なら何もしない（ループが0回）。`tags` 内の重複は `Set` で1つに
   * 潰してから数える——1回の Memory 作成につき、同じラベルの `proposedCount` を
   * 1回だけ進める。`ON CONFLICT` は `status = 'proposed'` のときだけ
   * `proposed_count` を進める——`registered` に昇格済みのラベルは、`tags` に
   * 使われ続けても件数を増やさない（`listLabels?`/`registerLabel?` の doc コメント
   * 「`registered` 昇格後の意味」参照。`docs/memory-model.md` §8「strict モードが
   * 変えるのは検索側だけ」という決定と対称に、`registered` かどうかで書き込み側の
   * 挙動を変えるのはこの1点だけである）。
   */
  private async upsertProposedLabels(
    exec: SqlExecutor,
    ctx: Ctx,
    memoryId: MemoryId,
    tags: readonly string[],
  ): Promise<void> {
    const uniqueNames = Array.from(new Set(tags));
    for (const name of uniqueNames) {
      const labelResult = await exec.execute(sql`
        INSERT INTO labels (id, tenant_id, name, status, proposed_count)
        VALUES (gen_random_uuid(), ${ctx.tenantId}, ${name}, 'proposed', 1)
        ON CONFLICT (tenant_id, name) DO UPDATE
          SET proposed_count = labels.proposed_count
            + CASE WHEN labels.status = 'proposed' THEN 1 ELSE 0 END
        RETURNING id
      `);
      const labelId = (labelResult.rows[0] as unknown as { id: string }).id;
      await exec.execute(sql`
        INSERT INTO memory_labels (tenant_id, memory_id, label_id)
        VALUES (${ctx.tenantId}, ${memoryId}, ${labelId})
        ON CONFLICT DO NOTHING
      `);
    }
  }

  async createObservation(ctx: Ctx, input: NewObservation): Promise<Observation> {
    const externalId = input.externalId ?? null;
    const inserted = await this.db.execute(sql`
      INSERT INTO observations (id, tenant_id, subject_id, external_id, kind, payload, occurred_at, recorded_at, valid_from, valid_until, attributes)
      VALUES (
        gen_random_uuid(),
        ${ctx.tenantId},
        ${input.subjectId ?? null},
        ${externalId},
        ${input.kind},
        ${JSON.stringify(input.payload)}::jsonb,
        ${input.occurredAt ?? null},
        ${input.recordedAt ?? new Date()},
        ${input.validFrom ?? null},
        ${input.validUntil ?? null},
        ${JSON.stringify(input.attributes ?? {})}::jsonb
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
        INSERT INTO observations (id, tenant_id, subject_id, external_id, kind, payload, occurred_at, recorded_at, valid_from, valid_until, attributes)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          ${input.subjectId ?? null},
          ${externalId},
          ${input.kind},
          ${JSON.stringify(input.payload)}::jsonb,
          ${input.occurredAt ?? null},
          ${input.recordedAt ?? new Date()},
          ${input.validFrom ?? null},
          ${input.validUntil ?? null},
          ${JSON.stringify(input.attributes ?? {})}::jsonb
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
    // ADR 0140: DB へ1バイトも書く前に落とす（`supersededByIndex` の範囲検査と同じ位置）。
    if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
      throw new ContestedWithoutCompanionError("createMemory", null);
    }
    const sourceObservationId = input.sourceObservationId ?? null;
    const extractorVersion = input.extractorVersion ?? null;
    const provenanceKind = input.provenance.kind;

    // Issue #201 / ADR 0318: 新しく作った Memory の `tags` から `proposed` ラベルを
    // 同一トランザクションで作るため、このメソッド自身がトランザクションを開く
    // ようになった（本 PR 以前は単発の INSERT 文、衝突時は単発の SELECT 文だった——
    // 返す値は変わらない。`inserted`/`existing`/`rowToMemory` の呼び方は1行も
    // 変えていない）。Issue #152/#153 / ADR 0312: `attributes` 列を INSERT に足した
    // （PR #724 の追加をそのまま引き継ぐ）。Issue #371: `claim_key_subject`/
    // `claim_key_predicate` 列を足した（PR #736 の追加をそのまま引き継ぐ）。
    const result = await this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO memories (
          id, tenant_id, subject_id,
          source_observation_id, extractor_version,
          content, content_hash, digest, digest_source,
          provenance_kind, provenance,
          status, superseded_by_id, contested_with_id,
          tags,
          occurred_at, recorded_at, last_reinforced_at, valid_from, valid_until,
          claim_key_subject, claim_key_predicate,
          strength, half_life_hours, decay_floor_at,
          decay_base_seq, decay_floor_seq, half_life_recalls,
          embedding_status,
          attributes,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${ctx.tenantId}, ${input.subjectId ?? null},
          ${sourceObservationId}, ${extractorVersion},
          ${input.content}, ${input.contentHash}, ${input.digest}, ${input.digestSource},
          ${provenanceKind}, ${JSON.stringify(input.provenance)}::jsonb,
          ${input.status ?? "active"}, ${input.supersededById ?? null}, ${input.contestedWithId ?? null},
          ${sql.param(input.tags)},
          ${input.occurredAt ?? null}, ${input.recordedAt}, ${input.lastReinforcedAt ?? null},
          ${input.validFrom ?? null}, ${input.validUntil ?? null},
          ${input.claimKey?.subject ?? null}, ${input.claimKey?.predicate ?? null},
          ${input.strength}, ${input.halfLifeHours}, ${input.decayFloorAt},
          ${input.decayBaseSeq ?? null}, ${input.decayFloorSeq ?? null}, ${input.halfLifeRecalls ?? null},
          ${input.embeddingStatus},
          ${JSON.stringify(input.attributes ?? {})}::jsonb,
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
        return { memory: rowToMemory(existing.rows[0] as unknown as MemoryRow), created: false };
      }

      const memory = rowToMemory(inserted.rows[0] as unknown as MemoryRow);
      await this.upsertProposedLabels(tx, ctx, memory.id, memory.tags);
      return { memory, created: true };
    });

    if (result.created) {
      // Issue #269: 統計が実態から遅れているときだけ ANALYZE memories を撃つ
      // (詳細は ./memories-statistics.ts のファイル doc)。新しい行を実際に書いた
      // ときだけ数える——上の ON CONFLICT で既存行を返しただけの呼び出しは数えない。
      // トランザクションの**外側**で呼ぶ——`createMemoryWithOutbox` と同じ理由
      // （ANALYZE が保持する ShareUpdateExclusiveLock を、上のトランザクションが
      // 保持する行ロックに無用に重ねないため）。
      await maybeAnalyzeMemoriesAfterWrite(this.db);
    }
    return result.memory;
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
    // ADR 0140: トランザクションを開く前に落とす（`createMemory` と同じ位置・同じ理由）。
    if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
      throw new ContestedWithoutCompanionError("createMemoryWithOutbox", null);
    }
    const sourceObservationId = input.sourceObservationId ?? null;
    const extractorVersion = input.extractorVersion ?? null;
    const provenanceKind = input.provenance.kind;

    const result = await this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO memories (
          id, tenant_id, subject_id,
          source_observation_id, extractor_version,
          content, content_hash, digest, digest_source,
          provenance_kind, provenance,
          status, superseded_by_id, contested_with_id,
          tags,
          occurred_at, recorded_at, last_reinforced_at, valid_from, valid_until,
          claim_key_subject, claim_key_predicate,
          strength, half_life_hours, decay_floor_at,
          decay_base_seq, decay_floor_seq, half_life_recalls,
          embedding_status,
          attributes,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${ctx.tenantId}, ${input.subjectId ?? null},
          ${sourceObservationId}, ${extractorVersion},
          ${input.content}, ${input.contentHash}, ${input.digest}, ${input.digestSource},
          ${provenanceKind}, ${JSON.stringify(input.provenance)}::jsonb,
          ${input.status ?? "active"}, ${input.supersededById ?? null}, ${input.contestedWithId ?? null},
          ${sql.param(input.tags)},
          ${input.occurredAt ?? null}, ${input.recordedAt}, ${input.lastReinforcedAt ?? null},
          ${input.validFrom ?? null}, ${input.validUntil ?? null},
          ${input.claimKey?.subject ?? null}, ${input.claimKey?.predicate ?? null},
          ${input.strength}, ${input.halfLifeHours}, ${input.decayFloorAt},
          ${input.decayBaseSeq ?? null}, ${input.decayFloorSeq ?? null}, ${input.halfLifeRecalls ?? null},
          ${input.embeddingStatus},
          ${JSON.stringify(input.attributes ?? {})}::jsonb,
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
      // Issue #201 / ADR 0318: 同一トランザクションで proposed ラベルを作る
      // （冪等衝突〔上の `inserted.rows.length === 0`〕では呼ばない——`createMemory`
      // の doc コメントと同じ判断）。
      await this.upsertProposedLabels(tx, ctx, memory.id, memory.tags);
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

    if (result.created) {
      // Issue #269: `createMemory` と同じ理由で ANALYZE の要否を判定する。
      // トランザクションの**外側**で呼ぶ——`ANALYZE` はトランザクション内でも
      // 実行できるが、上のトランザクションが保持する行ロックと
      // `ShareUpdateExclusiveLock`（ADR 0143 決定3）を無用に重ねないため
      // （詳細は ./memories-statistics.ts のファイル doc）。
      await maybeAnalyzeMemoriesAfterWrite(this.db);
    }
    return result;
  }

  async get(ctx: Ctx, id: MemoryId): Promise<Memory | null> {
    // id 列は uuid 型。この口の契約は「無い == null」なので、形式が壊れた入力も
    // クエリを投げる前に同じ null へ寄せる（mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      return null;
    }
    const result = await this.db.execute(sql`
      SELECT * FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    return result.rows.length > 0 ? rowToMemory(result.rows[0] as unknown as MemoryRow) : null;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    // この口の契約は「無い id は静かに落とす」（D9）。形式が壊れた id も同じ扱いにする
    // ため、クエリを投げる前に取り除く——呼び出し全体を弾かない
    // （mapping.ts の isUuidLike の doc参照）。
    const wellFormedIds = ids.filter((id) => isUuidLike(id));
    if (wellFormedIds.length === 0) {
      return [];
    }
    const result = await this.db.execute(sql`
      SELECT * FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(wellFormedIds)}::uuid[])
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
    // source_observation_id 列は uuid 型。この口の契約は「無い == []」なので、
    // 形式が壊れた observationId もクエリを投げる前に空配列へ寄せる
    // （mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(observationId)) {
      return [];
    }
    const result = await this.db.execute(sql`
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId}
        AND source_observation_id = ${observationId}
        AND extractor_version IS NOT DISTINCT FROM ${extractorVersion}
    `);
    return result.rows.map((row) => rowToMemory(row as unknown as MemoryRow));
  }

  /**
   * ADR 0030（安全弁3）: `opts.expectedStatus` を渡すと `AND status = ${expectedStatus}` を
   * 足した条件付き UPDATE になる（compare-and-swap）。**`expectedStatus` が無いときは
   * 今日と一字も変えない**——このメソッドの大半の呼び出し元（`archived`/`forgotten` への
   * 遷移等）は無条件更新のままでよい。
   *
   * 条件付き UPDATE が0行だった場合、それが「対象の id がそもそも無い」のか
   * 「id はあるが status が期待と違う」のかを、追加の `SELECT` で読み直して区別する
   * ——前者は今日と同じ「memory not found」の `Error`、後者は
   * {@link MemoryStatusConflictError}。**この読み直しは弾かれた後に行うため、
   * `observedStatus` は弾かれた瞬間の値ではない**（`MemoryStatusConflictError` の
   * doc コメント参照）。
   */
  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
  ): Promise<Memory> {
    // ADR 0140: この口には contestedWithId を渡す引数が無いため、status: 'contested' への
    // 書き込みは常に単独になる。UPDATE を投げる前に落とす。
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatus", id);
    }
    // id 列は uuid 型。この口の契約は「無い == 例外」なので、形式が壊れた入力も
    // クエリを投げる前に同じ「memory not found」の Error へ寄せる——ドライバの
    // invalid input syntax for type uuid を呼び出し側に漏らさない
    // （mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const expectedStatus = opts?.expectedStatus;
    const statusCondition =
      expectedStatus !== undefined ? sql`AND status = ${expectedStatus}` : sql``;
    const result = await this.db.execute(sql`
      UPDATE memories
      SET status = ${status},
          superseded_by_id = COALESCE(${opts?.supersededById ?? null}, superseded_by_id),
          updated_at = now()
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id} ${statusCondition}
      RETURNING *
    `);
    if (result.rows.length > 0) {
      return rowToMemory(result.rows[0] as unknown as MemoryRow);
    }

    if (expectedStatus === undefined) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }

    // 0行だった理由を切り分けるための読み直し（上記 doc コメント参照）。
    const current = await this.db.execute(sql`
      SELECT status FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    if (current.rows.length === 0) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const observedStatus = (current.rows[0] as unknown as { status: MemoryStatus }).status;
    throw new MemoryStatusConflictError(id, expectedStatus, observedStatus);
  }

  /**
   * ADR 0031: `updateStatus` の UPDATE と `EventStore.append`（`packages/postgres/src/
   * event-store.ts`）の INSERT を**同一トランザクション**で行う。この2つが別コミット
   * だったこと自体が直された不具合——前者だけ成功し後者が失敗すると、行は永久に
   * 新しい status のまま、対応するイベントは永久に存在しないという永続化された
   * 不整合が残っていた（PR「supersede-status-and-event-in-one-transaction」）。
   *
   * `db.transaction()` のコールバック内で throw すると自動的にロールバックされる
   * （`createObservationWithOutbox`/`createMemoryWithOutbox` と同じ形——ADR 0012
   * D-ingest-1）。CAS に弾かれた場合・対象が存在しない場合は、UPDATE が0行のまま
   * この関数を抜けて例外を投げるだけなので、`memory_events` への INSERT は実行されない
   * ——ロールバックを待つまでもなく、そもそも書き込みコマンド自体を発行しない。
   */
  async updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    // ADR 0140: updateStatus と同じ理由（contestedWithId を渡す引数が無い）。
    // トランザクションを開く前に落とす。
    if (status === "contested") {
      throw new ContestedWithoutCompanionError("updateStatusWithEvent", id);
    }
    // id 列は uuid 型。この口の契約は「無い == 例外」なので、形式が壊れた入力は
    // トランザクションを開く前に同じ「memory not found」の Error へ寄せる——
    // トランザクション内で投げても結果（イベントが積まれない）は同じだが、そもそも
    // 開かないほうが意図が明確（mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    const expectedStatus = opts.expectedStatus;
    const statusCondition =
      expectedStatus !== undefined ? sql`AND status = ${expectedStatus}` : sql``;

    return this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE memories
        SET status = ${status},
            superseded_by_id = COALESCE(${opts.supersededById ?? null}, superseded_by_id),
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ${id} ${statusCondition}
        RETURNING *
      `);

      if (result.rows.length === 0) {
        if (expectedStatus === undefined) {
          throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
        }
        // 0行だった理由を切り分けるための読み直し（`updateStatus` の doc コメント参照）。
        const current = await tx.execute(sql`
          SELECT status FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
        `);
        if (current.rows.length === 0) {
          throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
        }
        const observedStatus = (current.rows[0] as unknown as { status: MemoryStatus }).status;
        throw new MemoryStatusConflictError(id, expectedStatus, observedStatus);
      }

      const memory = rowToMemory(result.rows[0] as unknown as MemoryRow);

      const eventResult = await tx.execute(sql`
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          ${event.memoryId},
          ${event.kind},
          ${event.at ?? new Date()},
          ${JSON.stringify(event.actor)}::jsonb,
          ${event.digestSnapshot ?? null},
          ${event.sizeBeforeBytes ?? null},
          ${JSON.stringify(event.meta)}::jsonb
        )
        RETURNING *
      `);
      const storedEvent = rowToMemoryEvent(eventResult.rows[0] as unknown as MemoryEventRow);

      return { memory, event: storedEvent };
    });
  }

  /**
   * Issue #134 / ADR 0100: `news`（新規 Memory の作成、複数可）と `supersede`（既存 Memory の
   * supersede、複数可）を1つの `db.transaction()` にまとめる——docs/memory-model.md §11 行5
   * 「旧行の status 更新と新 Memory の作成を1トランザクションで完結させる」を満たす。
   *
   * 中身は `createMemoryWithOutbox`（INSERT ... ON CONFLICT ... DO NOTHING / outbox INSERT）と
   * `updateStatusWithEvent`（条件付き UPDATE + `memory_events` INSERT）と同じ形——**この2つの
   * 既存メソッドは変更していない**。`news` を先に処理し、`supersede` を後に処理する
   * （書く順序で被害を最小にする。ADR 0089 決定5 と同じ理由——途中で落ちても、統合先が
   * 無いのに旧行だけ `superseded_by_id` が指す先を失う、という最悪の状態を避ける）。
   *
   * `supersede[].id` が存在しなければトランザクション内で throw し、`news` の INSERT も
   * 含めてロールバックされる。`supersededById` は `memories.superseded_by_id` の実 FK
   * （`0001_init.sql`）がそのまま検査する——`news` の INSERT は同一トランザクション内で
   * 先に実行されているため、`supersededById` が同じ呼び出しの `news` を指していても
   * FK 違反にはならない（Postgres は同一トランザクション内の自分の書き込みを見る）。
   * CAS に弾かれた場合（0行 UPDATE、かつ対象は存在する）は `conflicted` に積んで
   * トランザクションはそのまま commit する——ここで throw しない。
   */
  async supersedeWithNewMemories(
    ctx: Ctx,
    news: ReadonlyArray<{ input: NewMemory; jobKinds: OutboxJobKind[] }>,
    supersede: ReadonlyArray<{
      id: MemoryId;
      supersededByIndex: number;
      expectedStatus?: MemoryStatus;
      event: NewMemoryEvent;
    }>,
  ): Promise<{
    created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
    superseded: MemoryEvent[];
    conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }>;
  }> {
    // 呼び手が壊れた索引を渡した場合は、トランザクションを開く前に落とす（ADR 0100）。
    // ⛔ `conflicted` にも「memory not found」にも混ぜない——3つとも別の失敗である。
    // 開く前に落とすので、`news` の作成も当然起きない。
    for (const target of supersede) {
      if (
        !Number.isInteger(target.supersededByIndex) ||
        target.supersededByIndex < 0 ||
        target.supersededByIndex >= news.length
      ) {
        throw new RangeError(
          `PostgresMemoryStore: supersededByIndex out of range: ${target.supersededByIndex} (news.length=${news.length})`,
        );
      }
    }
    // ADR 0140: createMemory と同じ制約を `news` の各要素にも課す。1件でも違反があれば
    // トランザクションを開く前に落とす（`news`/`supersede` どちらの書き込みも起きない）。
    for (const { input } of news) {
      if (isContestedWithoutCompanion(input.status, input.contestedWithId)) {
        throw new ContestedWithoutCompanionError("supersedeWithNewMemories", null);
      }
    }

    const result = await this.db.transaction(async (tx) => {
      const created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> = [];

      for (const { input, jobKinds } of news) {
        const sourceObservationId = input.sourceObservationId ?? null;
        const extractorVersion = input.extractorVersion ?? null;
        const provenanceKind = input.provenance.kind;

        const inserted = await tx.execute(sql`
          INSERT INTO memories (
            id, tenant_id, subject_id,
            source_observation_id, extractor_version,
            content, content_hash, digest, digest_source,
            provenance_kind, provenance,
            status, superseded_by_id, contested_with_id,
            tags,
            occurred_at, recorded_at, last_reinforced_at, valid_from, valid_until,
            claim_key_subject, claim_key_predicate,
            strength, half_life_hours, decay_floor_at,
            decay_base_seq, decay_floor_seq, half_life_recalls,
            embedding_status,
            attributes,
            created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${ctx.tenantId}, ${input.subjectId ?? null},
            ${sourceObservationId}, ${extractorVersion},
            ${input.content}, ${input.contentHash}, ${input.digest}, ${input.digestSource},
            ${provenanceKind}, ${JSON.stringify(input.provenance)}::jsonb,
            ${input.status ?? "active"}, ${input.supersededById ?? null}, ${input.contestedWithId ?? null},
            ${sql.param(input.tags)},
            ${input.occurredAt ?? null}, ${input.recordedAt}, ${input.lastReinforcedAt ?? null},
            ${input.validFrom ?? null}, ${input.validUntil ?? null},
            ${input.claimKey?.subject ?? null}, ${input.claimKey?.predicate ?? null},
            ${input.strength}, ${input.halfLifeHours}, ${input.decayFloorAt},
            ${input.decayBaseSeq ?? null}, ${input.decayFloorSeq ?? null}, ${input.halfLifeRecalls ?? null},
            ${input.embeddingStatus},
            ${JSON.stringify(input.attributes ?? {})}::jsonb,
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
          created.push({
            memory: rowToMemory(existing.rows[0] as unknown as MemoryRow),
            created: false,
            jobs: [],
          });
          continue;
        }

        const memory = rowToMemory(inserted.rows[0] as unknown as MemoryRow);
        // Issue #201 / ADR 0318: `news` の各要素について、同一トランザクションで
        // proposed ラベルを作る（`createMemory`/`createMemoryWithOutbox` と同じ判断
        // ——冪等衝突〔上の `inserted.rows.length === 0`〕では呼ばない）。
        await this.upsertProposedLabels(tx, ctx, memory.id, memory.tags);
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
        created.push({ memory, created: true, jobs });
      }

      const superseded: MemoryEvent[] = [];
      const conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }> = [];

      for (const target of supersede) {
        if (!isUuidLike(target.id)) {
          throw new Error(`PostgresMemoryStore: memory not found for tenant: ${target.id}`);
        }
        const expectedStatus = target.expectedStatus;
        const statusCondition =
          expectedStatus !== undefined ? sql`AND status = ${expectedStatus}` : sql``;

        const anchorId = created[target.supersededByIndex]!.memory.id;
        const result = await tx.execute(sql`
          UPDATE memories
          SET status = 'superseded',
              superseded_by_id = ${anchorId},
              updated_at = now()
          WHERE tenant_id = ${ctx.tenantId} AND id = ${target.id} ${statusCondition}
          RETURNING *
        `);

        if (result.rows.length === 0) {
          if (expectedStatus === undefined) {
            throw new Error(`PostgresMemoryStore: memory not found for tenant: ${target.id}`);
          }
          const current = await tx.execute(sql`
            SELECT status FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${target.id} LIMIT 1
          `);
          if (current.rows.length === 0) {
            throw new Error(`PostgresMemoryStore: memory not found for tenant: ${target.id}`);
          }
          const observedStatus = (current.rows[0] as unknown as { status: MemoryStatus }).status;
          conflicted.push({ id: target.id, observedStatus });
          continue;
        }

        const eventResult = await tx.execute(sql`
          INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
          VALUES (
            gen_random_uuid(),
            ${ctx.tenantId},
            ${target.event.memoryId},
            ${target.event.kind},
            ${target.event.at ?? new Date()},
            ${JSON.stringify(target.event.actor)}::jsonb,
            ${target.event.digestSnapshot ?? null},
            ${target.event.sizeBeforeBytes ?? null},
            ${JSON.stringify({ ...target.event.meta, supersededById: anchorId })}::jsonb
          )
          RETURNING *
        `);
        superseded.push(rowToMemoryEvent(eventResult.rows[0] as unknown as MemoryEventRow));
      }

      return { created, superseded, conflicted };
    });

    if (result.created.some((entry) => entry.created)) {
      // Issue #269（2026-09-17 コメント）: `createMemory` / `createMemoryWithOutbox` と
      // 同じ理由で ANALYZE の要否を判定する。`news` は複数件渡せるため、`created` 配列の
      // どれか1件でも実際に新しい行を書いていれば呼ぶ——`ON CONFLICT` で既存行を
      // 返しただけの要素（`created: false`）だけの呼び出しでは数えない
      // （`createMemory` の doc コメントと同じ判定。詳細は ./memories-statistics.ts の
      // ファイル doc）。
      //
      // トランザクションの**外側**で呼ぶ——`createMemoryWithOutbox` と同じ理由
      // （上のコメント参照）: `ANALYZE` はトランザクション内でも実行できるが、
      // 上のトランザクションが保持する行ロックと `ShareUpdateExclusiveLock`
      // （ADR 0143 決定3）を無用に重ねないため。
      await maybeAnalyzeMemoriesAfterWrite(this.db);
    }
    return result;
  }

  /**
   * Issue #210 / ADR 0115: `memory_events` から期限切れ行を消す保守ジョブ本体。
   *
   * 🔴 **`PostgresEventStore` を一切呼ばない。**`memory_events` へ直接 SQL を発行する
   * ——`updateStatusWithEvent`/`supersedeWithNewMemories` が append を `PostgresEventStore`
   * 経由にせず直接 INSERT しているのと同じ形（`EventStore` interface はこの経路を
   * 経由しない、という `docs/memory-model.md` §9・§11 の要求を型だけでなく実装でも守る）。
   *
   * 対象の選定は {@link buildPurgeExpiredEventsTargetSelect} に切り出してある——
   * `packages/postgres/src/__tests__/memory-events-retention-index.test.ts` の `EXPLAIN`
   * がこの関数の返り値をそのまま測る（`buildRequeueEmbedTargetSelect` と同じ理由）。
   *
   * `dryRun` のときは対象を数えるだけで `db.transaction` を開かない——削除も INSERT も
   * 実行しないので、トランザクションで包む対象が無い。
   */
  async purgeExpiredEvents(
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): Promise<PurgeExpiredEventsResult> {
    const dryRun = opts.dryRun ?? false;
    const target = buildPurgeExpiredEventsTargetSelect(ctx, opts);

    if (dryRun) {
      const candidates = await this.db.execute(target);
      const rows = candidates.rows as unknown as { at: string }[];
      const reachedLimit = rows.length > opts.limit;
      const victims = rows.slice(0, opts.limit);
      return {
        purged: victims.length,
        reachedLimit,
        oldestPurgedAt: victims.length > 0 ? parsePgTimestamp(victims[0]!.at) : null,
        newestPurgedAt:
          victims.length > 0 ? parsePgTimestamp(victims[victims.length - 1]!.at) : null,
        dryRun,
      };
    }

    return this.db.transaction(async (tx) => {
      const candidates = await tx.execute(target);
      const rows = candidates.rows as unknown as { id: string; at: string }[];
      const reachedLimit = rows.length > opts.limit;
      const victims = rows.slice(0, opts.limit);

      if (victims.length === 0) {
        return { purged: 0, reachedLimit, oldestPurgedAt: null, newestPurgedAt: null, dryRun };
      }

      const victimIds = victims.map((row) => row.id);
      await tx.execute(sql`
        DELETE FROM memory_events
        WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${sql.param(victimIds)}::uuid[])
      `);

      const oldestPurgedAt = parsePgTimestamp(victims[0]!.at);
      const newestPurgedAt = parsePgTimestamp(victims[victims.length - 1]!.at);

      await tx.execute(sql`
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          NULL,
          'events_purged',
          now(),
          ${JSON.stringify({ type: "system" })}::jsonb,
          NULL,
          NULL,
          ${JSON.stringify({
            purgedCount: victims.length,
            oldestPurgedAt,
            newestPurgedAt,
            olderThan: opts.olderThan,
          })}::jsonb
        )
      `);

      return { purged: victims.length, reachedLimit, oldestPurgedAt, newestPurgedAt, dryRun };
    });
  }

  async setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory> {
    // id 列は uuid 型。この口の契約は「無い == 例外」なので、形式が壊れた入力も
    // クエリを投げる前に同じ「memory not found」の Error へ寄せる（mapping.ts の
    // isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }

    // 🔴 `ready` を `failed` へ巻き戻さない（ADR 0053）。`ready` は VectorStore.upsert が
    // 返った*後*にしか書かれない＝「ベクトル行が在る」の主張であり、リースを失った古い
    // ワーカーの catch から来る `failed`（ADR 0032 の at-least-once）に負けてはならない。
    //
    // 書こうとしている値（引数 `status`）は*読んだ状態*ではないので JS 側で見てよい。
    // WHERE に入れなければならないのは *読んだ状態* のほう（現在の embedding_status）だけ
    // ——アプリ側で現在値を読んで比べてから書くと、読みと書きの間に入った別の書き込みを
    // 上書きしうる（ADR 0048 の reinforce と同じ形。updateStatus の compare-and-swap
    // （ADR 0030）と同じ条件片の組み立て方をここでも使う）。
    //
    // ⚠ **共有述語 `isEmbeddingStatusRollback` はここでは呼べない。**比較そのものを DB の
    // 1文へ入れる必要があるため、値（`from`/`to`）だけを EMBEDDING_STATUS_ROLLBACK から
    // 取り、比較の形は SQL 側にもう一度書かれる（ADR 0053「引き受けた負債」）。
    const rollbackGuard =
      status === EMBEDDING_STATUS_ROLLBACK.to
        ? sql` AND embedding_status <> ${EMBEDDING_STATUS_ROLLBACK.from}`
        : sql``;

    // ⚠ **更新できなかったときに返す行も、同じ1文の中で読む。**1文なら、更新できた場合も
    // できなかった場合も同じスナップショットを通る（`reinforce`（ADR 0048）と同じ形）。
    //
    // 🔴 **⚠ 「1文であること」自体は歯で守られている**（Issue #766・ADR 0053 追記）。
    // `packages/postgres/src/__tests__/set-embedding-status-single-statement.postgres.test.ts`
    // が DB へ送られる文の数を数え、巻き戻しが弾かれる経路（`ready` の行へ `failed` を
    // 書こうとして0行更新→読み戻し）で1文であることを断言する。**実測: この1文を
    // 「`UPDATE ... RETURNING *` → 0 行なら別の `SELECT`」の2文へ割る変異（ADR 0053 の
    // Mu5a）は、この歯を追加する前は `test:db` 182 件のどれも赤くしなかったが、
    // 追加後は上記の歯1本が赤くなる**——Mu5a は今日は死ぬ。
    //
    // ⚠ ただし**その歯が断言しているのは「1文である」という形だけ**であり、下で
    // 実測したとおり「並行時にどちらのスナップショットを返すべきか」は断言していない
    // ——その判断はまだされていない（すぐ下）。
    //
    // ⚠ `reinforce` から借りた理由づけ（「上で読んだ古い値をそのまま返す」実装との差が
    // 外から観測できなくなる）は、**そのままでは当たらない**——`reinforce` は本体の手前で
    // `SELECT` を打つが、**`setEmbeddingStatus` には手前の `SELECT` が無い**（存在検査は
    // `isUuidLike` だけ）ので、その取り違えは今日のコードからは書けない。
    //
    // 実測した限りでは、並行時にどちらのスナップショットを返すかという判断そのものは
    // 今の口では置けない: 1文と2文の差は**並行時にだけ**出る（2文のあいだに他の接続の
    // コミットが landing すると、2文の側は新しいスナップショットの行を返す——実測した）が、
    // **ガードで弾かれる `UPDATE` は行ロックを取らない**（これも実測した。他の接続が
    // 未コミットで同じ行のロックを保持していても 0 行で即座に返る）ので、外からこの実装を
    // その窓で止める手段が無く、窓は sub-millisecond である。
    // ⟹ **その判断を塞ぐには、この実装の中に待ちを差し込める口が要る。**ADR 0053
    // 「引き受けた負債」・2026-09-25 追記。
    const result = await this.db.execute(sql`
      WITH updated AS (
        UPDATE memories
        SET embedding_status = ${status}, updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ${id}${rollbackGuard}
        RETURNING *
      )
      SELECT * FROM updated
      UNION ALL
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
        AND NOT EXISTS (SELECT 1 FROM updated)
    `);
    if (result.rows.length === 0) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
    return rowToMemory(result.rows[0] as unknown as MemoryRow);
  }

  async reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory> {
    // id 列は uuid 型。この口の契約は「無い == 例外」なので、形式が壊れた入力も
    // クエリを投げる前に同じ「memory not found」の Error へ寄せる（mapping.ts の
    // isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }
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

    // [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16:
    // `opts.nowSeq` が渡され、かつこの Memory が `halfLifeRecalls` を持つときに限り、
    // 活動時計側の起点・床（decay_base_seq/decay_floor_seq）も同じ強化イベントとして
    // 進める。`halfLifeRecalls` が無い（'wall' のテナントで作られた、あるいは
    // 活動時計を一度も使っていない）Memory はそもそも活動時計では沈まないので、
    // ここで列を作らない（`ReinforceOptions.nowSeq` の doc コメント参照）。
    //
    // ⚠ **壁時計側の SET 句・WHERE 句は1バイトも変えない**——この条件片は同じ SET の
    // 末尾に追記するだけであり、`opts.nowSeq` が無い呼び出し（既存の全呼び出し）では
    // 空文字列になって従来の SQL とバイト単位で同じ文になる。
    const activitySet =
      opts?.nowSeq !== undefined && memory.halfLifeRecalls != null
        ? sql`, decay_base_seq = ${opts.nowSeq}, decay_floor_seq = ${defaultActivityDecayStrategy.floorAt(
            {
              baseSeq: opts.nowSeq,
              strength: memory.strength,
              halfLifeRecalls: memory.halfLifeRecalls,
            },
          )}`
        : sql``;

    // 🔴 減衰の起点を巻き戻さない（ADR 0048）。**この条件は WHERE 句に置く**——
    // 上の SELECT で読んだ値をアプリ側で比べて書くかどうか決めると、読みと書きの間に
    // 入った別の強化を上書きしうる（同じ形を `updateStatus` は ADR 0030 の
    // compare-and-swap で塞いでいる）。ここは比較そのものを DB の1文へ入れる。
    //
    // ⚠ 古い `at` は**失敗にしない。**呼び出し側から見れば「すでにもっと新しい強化が
    // 入っている」だけであり、例外にすると `runtime.observe` の使用報告ループが
    // 途中で止まる（`updateStatus` の CAS とはここが違う——あちらは status の
    // 取り違えなので呼び出し側の次の一手が変わる）。
    //
    // ⚠ **更新できなかったときに返す行も、同じ1文の中で読む。**別の `SELECT` に分けると、
    // 「上で読んだ古い値をそのまま返す」実装との差が**外から観測できない枝**になる
    // （実際に変異を撃って確かめた。PR 本文参照）。1文なら、更新できた場合も
    // できなかった場合も同じ経路を通るので、その取り違えは歯で捕まる。
    //
    // ⚠ 活動時計側の3列も、壁時計側と**同じ WHERE 句**（同じ `at` の比較）で守る——
    // 両方とも「同じ強化イベント」の一部であり（ADR 0165 文脈節「起点は両方の時計で
    // 同じく『最後の書き込み』に置く」）、片方だけ別の条件で進むと2軸の起点がずれる。
    const result = await this.db.execute(sql`
      WITH updated AS (
        UPDATE memories
        SET last_reinforced_at = ${at}, decay_floor_at = ${decayFloorAt}, updated_at = now()${activitySet}
        WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
          AND (last_reinforced_at IS NULL OR last_reinforced_at < ${at})
        RETURNING *
      )
      SELECT * FROM updated
      UNION ALL
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
        AND NOT EXISTS (SELECT 1 FROM updated)
    `);
    return rowToMemory(result.rows[0] as unknown as MemoryRow);
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
   * **本 PR（ADR 0073 決定7）で目次帯（`digests`/`digestEligible`）を同じクエリに
   * 相乗りさせた。** `opts.digestBand` を渡すと、同じ SQL 文の中に追加のスカラー
   * サブクエリを足し、全体を1つの SQL 文・1回の往復で返す
   * （`packages/postgres/src/__tests__/recall.postgres.test.ts` の
   * 「aggregateScope は単一の SQL 往復で完結する」がこれを構造的に検査している）。
   * 別クエリにすると群カウントと帯が別スナップショットになり、並行する書き込みの下で
   * 被覆不変条件が構造的に崩れる。
   *
   * **⭐ Issue #329 / [ADR 0173](../../../docs/decisions/0173-decayed-omission-counted-by-aggregate-scope.md)
   * で忘却ゲートの件数（`decayed_filtered`）を同じ CTE に相乗りさせた。**
   * **別クエリで数えない。** 別クエリにすると (a) 往復が増え、(b) 別スナップショットに
   * なって `totalInScope` と食い違いうる。ここは `digestBand` を相乗りさせたのと
   * 同じ判断である。
   *
   * `status` の4分岐（scope 内 / archived / superseded / forgotten）と period の内外は、
   * すべて `FILTER (WHERE ...)` による条件付き集約として1回のスキャンで計算する。
   * **superseded と forgotten は別々の列として数える**（ADR 0027）——前者は
   * 機構の都合（より良い抽出への置き換え、または統合）、後者は製品の振る舞い（利用者が意図して
   * 忘れさせた）であり、束ねると呼び出し側がどちらだったか判定できない。
   *
   * ## 単一パス書き換え（Issue #355、[ADR 0307](../../../docs/decisions/0307-aggregate-scope-single-pass.md)）
   *
   * **旧実装は `WITH scoped AS (SELECT ... FROM memories WHERE tenant_id = $1 ...)` を
   * 3回参照していた**（本体の `count(*) FILTER` 群・`groups` の `GROUP BY` サブクエリ・
   * `digestBand` のサブクエリ）。3回参照される CTE は Postgres が実体化し（1回だけ実行して
   * tuplestore に積み、以後はそこから読む）、しかも `scoped` の projection には `digest`
   * （テキスト列）が含まれていたため、テナント全件（100k 行）の digest 本文ごと
   * tuplestore に積まれ、`work_mem` を超えてディスクへ溢れていた（【実測】
   * 100k 行で `temp read=2736 written=1368`、ADR 0307「測ったこと」）。
   * 加えて `groups` は独立した `Sort` + `GroupAggregate` で `scoped` を再スキャンしており、
   * `${'${x}'}::timestamptz IS NULL OR ...` 形の述語（`inPeriod`/`isValid` 等）を
   * `count(*) FILTER` の本数（最大10本強）だけ重複して評価していた。
   *
   * **新実装は各行の述語（`live`/`in_period`/`is_valid`/`is_expired`/`is_not_yet_valid`/
   * `is_decayed`）を `flags` CTE（`scoped` の素の射影の上に載る層）で1回だけ boolean として計算し、`GROUP BY subject_id`
   * で subject ごとの各カウンタ（`in_scope`・`not_indexed_*`・`archived`・`superseded`・
   * `forgotten`・`period_filtered`・`expired_filtered`・`not_yet_valid_filtered`・
   * `decayed_filtered`）を1パスで出す（`agg` CTE）。**
   *
   * `scoped` は `flags` から、`flags` は `agg` から、`agg` は外側の集約から各1回だけ参照されるので、
   * Postgres は既定でどちらも実体化せずインライン化する（PG12+ の「1回しか参照されない
   * 非再帰 CTE は自動的にインライン化される」という規則。`MATERIALIZED` を明示していない
   * ——実際に試したが採らなかった。理由は「単一パス書き換え」の実装コメント、ADR
   * 0307「採らなかった案」参照。要点だけ書くと、`scoped` を `MATERIALIZED`
   * すると、digest を持たない狭い行でも 100k 行では `work_mem`（既定 4MB。GUC は
   * アプリの既定を変えるので変えない）を超えてディスクへ溢れ、インライン化のまま
   * 述語を複数回再評価するより**遅くなった**（【実測】237ms 台 vs 254ms 台）。
   * 述語自体は単純な比較演算であり、行数分の重複評価より、たとえ狭くてもディスクへの
   * 実体化のほうが高くつく）。外側では `groups`（`in_scope > 0` の
   * subject のみ、`json_agg(...) FILTER (WHERE in_scope > 0)`）と各合計
   * （`coalesce(sum(...), 0)`——空テナントで `agg` が0行になっても `NULL` ではなく現物と
   * 同じ `0` を返す）を1回の `Aggregate` ノードで取る。
   *
   * **`digestBand` は `scoped`/`agg` を経由せず、`memories` を直接（同じ `tenant_id`/
   * `subjectFilter` の WHERE で）引くサブクエリにした。** `digests`（top-N の
   * `ORDER BY eff_time DESC, id DESC LIMIT`）は digest 本文が要るので `memories` を
   * 直接スキャンする——`scoped` に digest 列を持たせて共有する必要が無くなった。
   * `digest_eligible_count` は `scoped`/`memories` を再スキャンせず、**集計側
   * （`agg` の `in_scope` 合計）から、`excludeMemoryIds`（高々 digestBand.limit 件、
   * テナント規模に応じて増えない）に該当する行のうち in_scope 条件を満たす件数を
   * 引き算**して出す（`id = ANY(...)` は主キーに乗るので、この補正クエリはテナント規模に
   * 依存しない定数コストである）。
   *
   * **`groups` の出現順序は契約ではない**（`packages/core/src/recall.ts` の
   * `ScopeAggregate.groups` doc・`GroupCount` doc、いずれも順序に触れていない。
   * `IndexBand.groups` へそのまま代入する `recall-runtime.ts` もソートしない。
   * `packages/testkit` の適合テストも `Map`/`toContainEqual` で集合として比較しており、
   * 配列全体を順序込みで比較していない——ADR 0307「確かめたこと」で
   * 実際に確認した）。旧実装は `json_agg` に `ORDER BY` を持たず、`GroupAggregate` の
   * 実行順（Postgres が選ぶプラン依存）に従っていた。新実装も同様に `ORDER BY` を
   * 持たない——**返り値の意味は変わっていない**（呼び出し側は今日も順序に依存できない）。
   *
   * **等価性の歯**: `packages/postgres/src/__tests__/aggregate-scope-single-pass.postgres.test.ts`
   * が、旧実装の SQL をテスト内に参照オラクルとして写し、新実装の `aggregateScope` と
   * 完全一致することを、各 FILTER 枝・subject 有無・includeSubjectless・NULL subject・
   * period/validAt/decayFloor* の組合せ・digestBand 有無・除外 id・空テナント・
   * digest 同時刻 tie（id DESC）を踏むデータで検査する。
   */
  async aggregateScope(
    ctx: Ctx,
    scope: RecallScope,
    opts?: AggregateScopeOptions,
  ): Promise<ScopeAggregate> {
    // Issue #608 項目③(b) / ADR 0286: 段1（ANN・語彙）の押し下げと同じ opt-in。
    // `scope.subjectId` が無ければこの欄自体を見ない——「テナント全体」は定義上すでに
    // 主題なしを含む上位集合であり、広げる余地が無い。
    const subjectFilter =
      scope.subjectId !== undefined
        ? scope.includeSubjectless === true
          ? sql`AND (subject_id = ${scope.subjectId} OR subject_id IS NULL)`
          : sql`AND subject_id = ${scope.subjectId}`
        : sql``;
    // Issue #152/#153（ADR 0312）: `attributes` も `subjectId` と同じくスコープの外側の
    // 境界——`scoped` CTE の WHERE に足すことで、この絞り込みの外は `totalInScope` は
    // もちろん `filtered*` のどの列にも数えない（`recall.ts` の `ScopeAggregate` doc
    // 「2026-09 追記」参照）。`@>`（containment）は `idx_memories_attributes` の GIN 索引
    // （`jsonb_path_ops`）が効く述語。
    const attributesFilter =
      scope.attributes !== undefined
        ? sql`AND attributes @> ${JSON.stringify(scope.attributes)}::jsonb`
        : sql``;
    // Issue #201 PR-B（[ADR 0323](../../../docs/decisions/0323-taxonomy-recall-filter.md)）:
    // taxonomy は `attributes`/`subjectId` とは違う側——「スコープを定義する識別子の境界」
    // ではなく「period/validity と同じ、filtered として報告されるゲート」である
    // （`FILTERED_CONDITION_SCOPE_RELATION.taxonomy === 'outside_scope'` は ADR 0318 より
    // 前から固定済み）。⟹ `scoped` の WHERE には入れず、`flags`/`agg` の中で boolean と
    // して持つ（`isDecayed` と同じパターン）——`period_filtered`/`expired_filtered` と
    // 同じ「直前までのゲートを通過し、このゲートだけで落ちた」件数を数えるため。
    // `labels.name` は書き込み経路が `tags` からしか作らないため1対1で一致する
    // （ADR 0323「決定1」）——`memory_labels`/`labels` を JOIN せず `tags` の配列の重なり
    // だけで判定できる。
    const hasQualifyingLabel =
      scope.labels !== undefined ? sql`(tags && ${sql.param(scope.labels)}::text[])` : sql`true`;
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

    // Issue #280（Issue #202 第2弾）: validAt ゲート。`scope.validAt` が無ければ常に真
    // （`RecallQuery.includeOutsideValidity: true` のときと同じ「絞りなし」）。
    // 両端とも NULL は「いつでも真」（`RecallQuery.validAt` の doc 参照）。
    const validAt = scope.validAt ?? null;
    const isValid = sql`(
      ${validAt}::timestamptz IS NULL OR (
        (valid_from IS NULL OR valid_from <= ${validAt}::timestamptz)
        AND (valid_until IS NULL OR valid_until > ${validAt}::timestamptz)
      )
    )`;
    const isExpired = sql`(
      ${validAt}::timestamptz IS NOT NULL AND valid_until IS NOT NULL AND valid_until <= ${validAt}::timestamptz
    )`;
    const isNotYetValid = sql`(
      ${validAt}::timestamptz IS NOT NULL AND valid_from IS NOT NULL AND valid_from > ${validAt}::timestamptz
    )`;

    // ⭐ Issue #329 / ADR 0173: 忘却ゲート（`decay_floor_at` / `decay_floor_seq`）が
    // 落とした件数を、**段1の押し下げとまったく同じ述語**で厳密に数える。
    //
    // 押し下げ側は `PostgresVectorStore.search`（`vector-store.ts`）の
    // `decayFloorAtCondition` / `decayFloorSeqCondition` / `decayFloorAnyAxis` の3本である。
    // **ここはその否定（NOT）を組む**——生き残る側の述語を書いて否定することで、
    // 「押し下げが通したもの」と「ここが数えないもの」が定義上一致する。
    // ⚠ **`NOT` を分配して書き直さないこと。** 'either' は OR なので
    // `NOT (wall OR seq)` = `NOT wall AND NOT seq` であり、AND/OR を取り違えると
    // 「段1で落ちた数」と「集約が数えた数」が黙って食い違う（それがこの ADR の眼目である）。
    //
    // `decay_floor_at` は NOT NULL（`memories` の列定義）なので `NOT (x > p)` に
    // 三値論理の穴は無い。`decay_floor_seq` は NULL を取りうるが、生き残る側の述語が
    // `IS NULL OR ...` の形なので、その否定は `IS NOT NULL AND ... <= p` になり、
    // やはり NULL が UNKNOWN で漏れることは無い（ADR 0165 決めたこと4）。
    const decayFloorAtAfter = scope.decayFloorAtAfter;
    const decayFloorSeqAfter = scope.decayFloorSeqAfter;
    const wallAxisAlive =
      decayFloorAtAfter !== undefined
        ? sql`(decay_floor_at > ${decayFloorAtAfter}::timestamptz)`
        : undefined;
    const activityAxisAlive =
      decayFloorSeqAfter !== undefined
        ? sql`(decay_floor_seq IS NULL OR decay_floor_seq > ${decayFloorSeqAfter})`
        : undefined;
    let isDecayed: SQL;
    if (wallAxisAlive === undefined && activityAxisAlive === undefined) {
      // ゲート無効（`RecallQuery.includeFullyDecayed: true`）。**0件と数える**
      // ——「ゲートを外した」ことと「0件落ちた」ことは呼び出し側から見て同じである
      // （`omitted` に `decayed` が積まれない。`validAt` 未指定のときの
      // `expired_filtered` が常に 0 になるのと同じ形）。
      isDecayed = sql`false`;
    } else if (
      scope.decayFloorAnyAxis === true &&
      wallAxisAlive !== undefined &&
      activityAxisAlive !== undefined
    ) {
      isDecayed = sql`(NOT ${wallAxisAlive} AND NOT ${activityAxisAlive})`;
    } else if (wallAxisAlive !== undefined && activityAxisAlive !== undefined) {
      isDecayed = sql`(NOT ${wallAxisAlive} OR NOT ${activityAxisAlive})`;
    } else if (wallAxisAlive !== undefined) {
      isDecayed = sql`(NOT ${wallAxisAlive})`;
    } else {
      isDecayed = sql`(NOT ${activityAxisAlive!})`;
    }

    const digestBand = opts?.digestBand;
    // `digestBand` が無ければ余計な仕事をしない（doc コメント・PR 指示のとおり）——
    // このサブクエリ群自体を SQL テキストに載せない。
    //
    // Issue #355 / ADR 0307: `digestBand` は `scoped`/`agg` を経由せず、
    // `memories` を直接（同じ tenant_id/subjectFilter の WHERE で）引く。digest 本文が
    // 要る `digests` は仕方なく `memories` を再スキャンするが、`digest_eligible_count` は
    // 再スキャンしない——`in_scope`（`agg` の合計）から、除外 id のうち in_scope 条件を
    // 満たす件数（高々 `excludeMemoryIds.length` 件、主キー相当の `id` に乗るので
    // テナント規模に依存しない）を引き算するだけで出す。
    const digestBandColumns = digestBand
      ? sql`,
        (
          SELECT coalesce(
            json_agg(
              json_build_object('memoryId', id, 'digest', digest)
              ORDER BY eff_time DESC, id DESC
            ),
            '[]'::json
          )
          FROM (
            SELECT id, digest, COALESCE(occurred_at, recorded_at) AS eff_time
            FROM memories
            WHERE tenant_id = ${ctx.tenantId} ${subjectFilter} ${attributesFilter}
              AND status IN ('active', 'contested') AND ${inPeriod} AND ${isValid}
              AND ${hasQualifyingLabel}
              AND NOT (id = ANY(${sql.param([...digestBand.excludeMemoryIds])}::uuid[]))
            ORDER BY COALESCE(occurred_at, recorded_at) DESC, id DESC
            LIMIT ${digestBand.limit}
          ) band
        ) AS digests,
        (
          coalesce(sum(in_scope), 0) - coalesce((
            SELECT count(*)
            FROM memories
            WHERE tenant_id = ${ctx.tenantId} ${subjectFilter} ${attributesFilter}
              AND status IN ('active', 'contested') AND ${inPeriod} AND ${isValid}
              AND ${hasQualifyingLabel}
              AND id = ANY(${sql.param([...digestBand.excludeMemoryIds])}::uuid[])
          ), 0)
        )::int AS digest_eligible_count`
      : sql``;

    // Issue #201 PR-B（ADR 0323「決定5」）: `RecallQuery.taxonomyGroups: true` のときだけ
    // 追加する——`scope.taxonomyGroupCandidates` が `undefined` なら SQL テキストにも
    // 実行計画にも一切現れない（`digestBandColumns` と同じパターン）。`scoped`/`flags`/`agg`
    // を経由せず、`memories` を直接（同じ WHERE で）再スキャンする——`unnest(tags)` を伴う
    // `GROUP BY` は `agg` の `GROUP BY subject_id` と粒度が違うため、単一パスに混ぜない
    // （ADR 0307 が `digestBand` について下した判断と同じ理由）。**`hasQualifyingLabel`
    // （`RecallQuery.labels` による絞り込み、指定されていれば）の内側を数える**——
    // グルーピングは「絞り込み済みの現在のスコープ」をテナントの語彙全体で内訳する。
    const taxonomyGroupCandidates = scope.taxonomyGroupCandidates;
    const taxonomyGroupColumns =
      taxonomyGroupCandidates !== undefined
        ? sql`,
        (
          SELECT coalesce(json_agg(json_build_object('key', tag, 'count', tag_count)), '[]'::json)
          FROM (
            SELECT tag, count(*)::int AS tag_count
            FROM memories, unnest(tags) AS tag
            WHERE tenant_id = ${ctx.tenantId} ${subjectFilter} ${attributesFilter}
              AND status IN ('active', 'contested') AND ${inPeriod} AND ${isValid}
              AND ${hasQualifyingLabel}
              AND tag = ANY(${sql.param([...taxonomyGroupCandidates])}::text[])
            GROUP BY tag
          ) t
        ) AS taxonomy_label_groups,
        (
          SELECT count(*)::int
          FROM memories
          WHERE tenant_id = ${ctx.tenantId} ${subjectFilter} ${attributesFilter}
            AND status IN ('active', 'contested') AND ${inPeriod} AND ${isValid}
            AND ${hasQualifyingLabel}
            AND NOT (tags && ${sql.param([...taxonomyGroupCandidates])}::text[])
        ) AS taxonomy_residual_count`
        : sql``;

    // Issue #355 / ADR 0307: 各行の述語を `scoped` の中で1回だけ boolean として
    // 計算し（`live`/`in_period`/`is_valid`/`is_expired`/`is_not_yet_valid`/`is_decayed`）、
    // `agg` で `GROUP BY subject_id` して subject ごとの各カウンタを1パスで出す。
    // `scoped`・`agg` はどちらも1回しか参照されないので、Postgres は既定でどちらも
    // インライン化する（`MATERIALIZED` を明示していない）。
    //
    // ⚠ **`MATERIALIZED` を試したが、採らなかった**（ADR 0307「採らなかった案」）。
    // `scoped` は digest を持たない狭い行だが、`work_mem`（既定 4MB、GUC を変えない前提の
    // もとでは動かせない）を100k行で超え、実体化そのものがディスクへ溢れる
    // （`temp written` が実測で再発した）。**インライン化のままだと、`in_period`/`is_valid`
    // 等の式は `agg` 側の複数の `FILTER` から参照されるたびに再評価されるが、
    // これは単純な比較演算であり、`work_mem` を超えて生じるディスク書き込みより安い**
    // ——【実測】インライン化 237ms 台 vs `MATERIALIZED` 254ms 台（ADR「測ったこと」）。
    const result = await this.db.execute(sql`
      WITH scoped AS (
        SELECT subject_id, occurred_at, recorded_at, embedding_status, status,
               valid_from, valid_until, decay_floor_at, decay_floor_seq, tags
        FROM memories
        WHERE tenant_id = ${ctx.tenantId} ${subjectFilter} ${attributesFilter}
      ),
      -- 述語を1回だけ boolean にする層。scoped を素の射影のまま残すのは、ADR 0303 の
      -- 前提の歯（scripts/__tests__/decay-floor-owner-premises.test.mjs）が scoped の本体を
      -- 字句で読んで「status で絞らない」を検査しているため。どの CTE も1回しか参照されず
      -- インライン化されるので、層を分けてもプランは変わらない。
      flags AS (
        SELECT
          subject_id,
          status,
          embedding_status,
          (status IN ('active', 'contested')) AS live,
          (${inPeriod}) AS in_period,
          (${isValid}) AS is_valid,
          (${isExpired}) AS is_expired,
          (${isNotYetValid}) AS is_not_yet_valid,
          (${isDecayed}) AS is_decayed,
          (${hasQualifyingLabel}) AS has_qualifying_label
        FROM scoped
      ),
      agg AS (
        SELECT
          subject_id,
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND has_qualifying_label
          )::int AS in_scope,
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND has_qualifying_label
              AND embedding_status = 'pending'
          )::int AS not_indexed_pending,
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND has_qualifying_label
              AND embedding_status = 'failed'
          )::int AS not_indexed_failed,
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND has_qualifying_label
              AND embedding_status = 'skipped'
          )::int AS not_indexed_skipped,
          count(*) FILTER (WHERE status = 'archived')::int AS archived,
          count(*) FILTER (WHERE status = 'superseded')::int AS superseded,
          count(*) FILTER (WHERE status = 'forgotten')::int AS forgotten,
          count(*) FILTER (WHERE live AND NOT in_period)::int AS period_filtered,
          count(*) FILTER (WHERE live AND in_period AND is_expired)::int AS expired_filtered,
          count(*) FILTER (
            WHERE live AND in_period AND is_not_yet_valid
          )::int AS not_yet_valid_filtered,
          -- Issue #201 PR-B（ADR 0323）: taxonomy ゲートで落ちた件数。period_filtered/
          -- expired_filtered と同じ「直前までのゲートを通過し、このゲートだけで落ちた」
          -- 集計——in_scope から除かれる（decayed_filtered とは違う。下のコメント参照）。
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND NOT has_qualifying_label
          )::int AS taxonomy_filtered,
          -- Issue #329 / ADR 0173: 忘却ゲートで落ちた件数。in_scope と同じ絞り
          -- (status + period + validity + taxonomy) の上に載る = in_scope の部分集合であり、
          -- archived/period/expired/taxonomy のように in_scope から除かれた件数ではない。
          -- 被覆不変条件 (axis: 'subject' の群カウントの総和 = totalInScope) は動かない。
          count(*) FILTER (
            WHERE live AND in_period AND is_valid AND has_qualifying_label AND is_decayed
          )::int AS decayed_filtered
        FROM flags
        GROUP BY subject_id
      )
      SELECT
        -- 現物の groups と同じ集合（in_scope > 0 の subject のみ）。順序は契約ではない
        -- （doc コメント「単一パス書き換え」節、旧実装も json_agg に ORDER BY を持たない）。
        coalesce(
          json_agg(json_build_object('key', subject_id, 'count', in_scope)) FILTER (WHERE in_scope > 0),
          '[]'::json
        ) AS groups,
        -- 空テナント（agg が0行）でも NULL ではなく現物と同じ 0 を返す。
        coalesce(sum(in_scope), 0)::int AS in_scope,
        coalesce(sum(not_indexed_pending), 0)::int AS not_indexed_pending,
        coalesce(sum(not_indexed_failed), 0)::int AS not_indexed_failed,
        coalesce(sum(not_indexed_skipped), 0)::int AS not_indexed_skipped,
        coalesce(sum(archived), 0)::int AS archived,
        coalesce(sum(superseded), 0)::int AS superseded,
        coalesce(sum(forgotten), 0)::int AS forgotten,
        coalesce(sum(period_filtered), 0)::int AS period_filtered,
        coalesce(sum(expired_filtered), 0)::int AS expired_filtered,
        coalesce(sum(not_yet_valid_filtered), 0)::int AS not_yet_valid_filtered,
        coalesce(sum(taxonomy_filtered), 0)::int AS taxonomy_filtered,
        coalesce(sum(decayed_filtered), 0)::int AS decayed_filtered
        ${digestBandColumns}
        ${taxonomyGroupColumns}
      FROM agg
    `);

    const row = result.rows[0] as unknown as {
      groups: { key: string | null; count: number }[];
      in_scope: number;
      not_indexed_pending: number;
      not_indexed_failed: number;
      not_indexed_skipped: number;
      archived: number;
      superseded: number;
      forgotten: number;
      period_filtered: number;
      expired_filtered: number;
      not_yet_valid_filtered: number;
      taxonomy_filtered: number;
      decayed_filtered: number;
      digests?: { memoryId: string; digest: string }[];
      digest_eligible_count?: number;
      taxonomy_label_groups?: { key: string; count: number }[];
      taxonomy_residual_count?: number;
    };

    const groups: ScopeAggregate["groups"] = (row.groups ?? []).map((g) => ({
      axis: "subject" as const,
      key: g.key,
      count: g.count,
      countKind: "exact" as const,
    }));

    // Issue #201 PR-B（ADR 0323「決定5」）: `taxonomyGroupCandidates` が渡されたときだけ
    // `axis: 'taxonomy'` の群を足す。カウント0のラベルは載らない（`GROUP BY` が自然に
    // そうなる、`axis: 'subject'` の `in_scope > 0` フィルタと同じ規約）。残差
    // （`key: null`）もカウントが0なら載せない（同じ規約をここにも揃える）。
    if (taxonomyGroupCandidates !== undefined) {
      for (const g of row.taxonomy_label_groups ?? []) {
        groups.push({ axis: "taxonomy" as const, key: g.key, count: g.count, countKind: "exact" });
      }
      const residualCount = row.taxonomy_residual_count ?? 0;
      if (residualCount > 0) {
        groups.push({
          axis: "taxonomy" as const,
          key: null,
          count: residualCount,
          countKind: "exact",
        });
      }
    }

    const digests: ScopeAggregate["digests"] = digestBand
      ? (row.digests ?? []).map((d) => ({
          memoryId: d.memoryId as MemoryId,
          digest: d.digest,
        }))
      : [];
    const digestEligible: ScopeAggregate["digestEligible"] = digestBand
      ? { count: row.digest_eligible_count ?? 0, countKind: "exact" }
      : { count: 0, countKind: "exact" };

    return {
      groups,
      totalInScope: row.in_scope,
      countKind: "exact",
      notIndexed: {
        pending: { count: row.not_indexed_pending, countKind: "exact" },
        failed: { count: row.not_indexed_failed, countKind: "exact" },
        skipped: { count: row.not_indexed_skipped, countKind: "exact" },
      },
      filteredArchived: { count: row.archived, countKind: "exact" },
      filteredSuperseded: { count: row.superseded, countKind: "exact" },
      filteredForgotten: { count: row.forgotten, countKind: "exact" },
      filteredPeriod: { count: row.period_filtered, countKind: "exact" },
      filteredExpired: { count: row.expired_filtered, countKind: "exact" },
      filteredNotYetValid: { count: row.not_yet_valid_filtered, countKind: "exact" },
      filteredTaxonomy: { count: row.taxonomy_filtered, countKind: "exact" },
      filteredDecayed: { count: row.decayed_filtered, countKind: "exact" },
      digests,
      digestEligible,
    };
  }

  /**
   * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと5:
   * `record.advanceActivityClock === true` のとき、`recalls` への INSERT と**同一
   * トランザクションで** `tenant_activity.activity_seq` を `+1` する（UPSERT——行が
   * 無ければ `activity_seq = 1` の行を作る。`ON CONFLICT DO UPDATE` の `EXCLUDED` は
   * 使わない——`+1` は既存値に依存するため）。**`false`/未指定なら `UPDATE` を1本も
   * 撃たない**（既定 `'wall'` のテナントでは、この行を一度も触らない、という ADR の
   * 意味論をそのまま満たす）。
   */
  async createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId> {
    // Issue #298 / ADR 0155: 新しく書く行は常に breakdownCaptured: true。「内訳を持たない
    // 新規行」は無い（recall-runtime.ts が finalMemories から毎回内訳を計算しているため）。
    const returnedMemories: RecallRecordReturnedMemories = {
      breakdownCaptured: true,
      memories: record.returnedMemories,
    };
    const insertRecall = sql`
      INSERT INTO recalls (
        id, tenant_id, subject_id, query, budget, omitted, usage, index_band, explain,
        returned_memories, created_at
      ) VALUES (
        gen_random_uuid(), ${ctx.tenantId}, ${record.subjectId ?? null},
        ${JSON.stringify(record.query)}::jsonb,
        ${record.budget !== undefined && record.budget !== null ? JSON.stringify(record.budget) : null}::jsonb,
        ${JSON.stringify(record.omitted)}::jsonb,
        ${JSON.stringify(record.usage)}::jsonb,
        ${JSON.stringify(record.indexBand)}::jsonb,
        ${JSON.stringify(record.explain)}::jsonb,
        ${JSON.stringify(returnedMemories)}::jsonb,
        now()
      )
      RETURNING id
    `;

    if (record.advanceActivityClock !== true) {
      const result = await this.db.execute(insertRecall);
      return (result.rows[0] as unknown as { id: string }).id;
    }

    return this.db.transaction(async (tx) => {
      const result = await tx.execute(insertRecall);
      await tx.execute(sql`
        INSERT INTO tenant_activity (tenant_id, activity_seq, updated_at)
        VALUES (${ctx.tenantId}, 1, now())
        ON CONFLICT (tenant_id) DO UPDATE
          SET activity_seq = tenant_activity.activity_seq + 1, updated_at = now()
      `);
      return (result.rows[0] as unknown as { id: string }).id;
    });
  }

  /**
   * Issue #298 / [ADR 0155](../../../docs/decisions/0155-recall-score-breakdown-persisted.md):
   * `createRecall` が書いた `recalls` 行1件を、`recallId` から読み戻す。
   * 契約は `get`/`getObservation` と同じ——見つからなければ `null`（例外にしない）。
   */
  async getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null> {
    // id 列は uuid 型。形式が壊れた入力も「無い」と同じ扱いにする
    // （`get`/`getObservation` と同じ規律。mapping.ts の isUuidLike の doc参照）。
    if (!isUuidLike(id)) {
      return null;
    }
    const result = await this.db.execute(sql`
      SELECT * FROM recalls WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
    `);
    return result.rows.length > 0
      ? rowToRecallRecord(result.rows[0] as unknown as RecallRow)
      : null;
  }

  /**
   * ADR 0079: 索引に載っていない Memory を選んで `pending` へ戻し、**同じ1文の中で**
   * `embed` の outbox 行を積み直す。
   *
   * 🔴 **`memories` の更新と `outbox` の INSERT は、同一トランザクションでなければ
   * ならない。**片方だけ起きると次のどちらかになる:
   * - 更新だけ起きた: `pending` に戻ったのに運ぶジョブが無い。**その行は永久に
   *   `pending` のまま**で、`recall` は「待て」と案内し続ける——直すつもりが、
   *   直せない状態を一つ増やしたことになる。
   * - INSERT だけ起きた: `failed` のまま `embed` ジョブが積まれる。処理そのものは
   *   走るので致命的ではないが、`aggregateScope` の `notIndexed.failed` は
   *   ジョブが成功するまで減らない。
   *
   * **ここでは単一の `WITH ... INSERT ... SELECT` 文にしてある**——1文なら、
   * 明示的な `BEGIN`/`COMMIT` を書かなくても両方が同じトランザクションに入る
   * （`createMemoryWithOutbox` は複数文なので `db.transaction` で包む必要がある。
   * こちらは1文で済むので包まない）。**この選択には歯が在る**: 適合スイートの
   * 「更新と INSERT は片方だけ起きない」の検査（`memory-store-conformance.ts`）。
   *
   * `FOR UPDATE SKIP LOCKED` は `claimBatch`（`./outbox-store.ts`）と同じ理由で使う——
   * 2つの呼び出しが同時に走っても、同じ Memory を二重に積み直さない（取ろうとして
   * いる行はスキップして次へ行く）。
   */
  async requeueEmbedJobs(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult> {
    const target = buildRequeueEmbedTargetSelect(ctx, opts);
    // `memoryIds` を渡されたのに well-formed な id が1つも残らなかった場合
    // （空集合との積）。問い合わせる意味が無い。
    if (target === null) {
      return { requeued: 0, memoryIds: [] };
    }

    const result = await this.db.execute(sql`
      WITH target AS (
        ${target}
      ),
      requeued AS (
        UPDATE memories m
        SET embedding_status = 'pending', updated_at = now()
        FROM target t
        WHERE m.id = t.id
        RETURNING m.id
      )
      INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
      SELECT
        gen_random_uuid(), ${ctx.tenantId}, 'embed',
        jsonb_build_object('memoryId', r.id), now(), 0, now()
      FROM requeued r
      RETURNING (payload->>'memoryId') AS memory_id
    `);

    const memoryIds = result.rows.map((row) => (row as unknown as { memory_id: string }).memory_id);
    return { requeued: memoryIds.length, memoryIds };
  }

  /**
   * ADR 0114: `docs/memory-model.md` §11 行8 の掃引。doc コメントの契約そのものは
   * `MemoryStore.archiveDecayed`（`@mnemora/core`）側にある——ここはクエリの実装のみ。
   *
   * 🔴 `memories` の UPDATE と `memory_events` への INSERT は、`requeueEmbedJobs`
   * （ADR 0079、直上のメソッド）と同じ理由で**単一の `WITH ... UPDATE ... INSERT ...
   * SELECT` 文**にまとめてある——1文なら、明示的な `BEGIN`/`COMMIT` を書かなくても
   * 両方が同じトランザクションに入る（`片方だけ起きる」を構造的に作れない）。
   *
   * `digest_snapshot` には archived にする直前の `digest` を入れる
   * （`docs/memory-model.md` §9「記録時点の digest」）——`updateStatusWithEvent` を
   * 経由する `forget` が `digestSnapshot: current.digest` を渡すのと同じ規約を、
   * 1文の SQL の中で `RETURNING`/`SELECT` を通じて再現する。
   *
   * 最終 `SELECT` に `ORDER BY` を付けているのは、`archived`（返り値）の並びを
   * ターゲット選択の並び（`decay_floor_at` 昇順）と一致させるため——`UPDATE ...
   * FROM target` の `RETURNING` はターゲットの行順を保証しないので、返り値としての
   * 順序契約はここで別途つけ直す必要がある。
   */
  async archiveDecayed(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<ArchiveDecayedResult> {
    const target = buildArchiveDecayedTargetSelect(ctx, opts);

    const result = await this.db.execute(sql`
      WITH target AS (
        ${target}
      ),
      archived AS (
        UPDATE memories m
        SET status = 'archived', updated_at = now()
        FROM target t
        WHERE m.id = t.id
        RETURNING m.id AS id, m.decay_floor_at AS decay_floor_at, m.digest AS digest
      ),
      inserted_events AS (
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        SELECT
          gen_random_uuid(), ${ctx.tenantId}, a.id, 'archived', now(),
          '{"type":"system"}'::jsonb, a.digest, NULL, '{}'::jsonb
        FROM archived a
        RETURNING memory_id
      )
      SELECT id, decay_floor_at FROM archived
      ORDER BY decay_floor_at ASC, id ASC
    `);

    const archived = result.rows.map((row) => {
      const r = row as unknown as { id: string; decay_floor_at: string };
      return { memoryId: r.id as MemoryId, decayFloorAt: parsePgTimestamp(r.decay_floor_at) };
    });
    return { archived, reachedLimit: archived.length === opts.limit };
  }

  /**
   * Issue #198 / ADR 0124: `forgotten` かつ未 purge（`purged_at IS NULL`）の Memory だけを
   * 対象にした CAS。`updateStatusWithEvent`（本ファイル上部）と同じ形——条件付き `UPDATE`
   * が0行なら、対象がそもそも存在しないのか（`isUuidLike` の事前チェックで弾く、または
   * 読み直しで0行）、条件を満たさなかったのか（読み直して {@link MemoryPurgeConflictError}
   * を投げる）を切り分ける。`status` は更新しない——`purged` は `memories.status` の値
   * ではない（docs/memory-model.md §11 行10）。
   */
  async purgeMemory(
    ctx: Ctx,
    id: MemoryId,
    tombstone: { content: string; digest: string },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    if (!isUuidLike(id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
    }

    return this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE memories
        SET content = ${tombstone.content},
            digest = ${tombstone.digest},
            purged_at = now(),
            updated_at = now()
        WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
          AND status = 'forgotten' AND purged_at IS NULL
        RETURNING *
      `);

      if (result.rows.length === 0) {
        // 0行だった理由を切り分けるための読み直し（`updateStatusWithEvent` と同じ作法）。
        const current = await tx.execute(sql`
          SELECT status, purged_at FROM memories
          WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
        `);
        if (current.rows.length === 0) {
          throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
        }
        const row = current.rows[0] as unknown as {
          status: MemoryStatus;
          purged_at: string | null;
        };
        throw new MemoryPurgeConflictError(id, row.status, parsePgTimestamp(row.purged_at));
      }

      const memory = rowToMemory(result.rows[0] as unknown as MemoryRow);

      const eventResult = await tx.execute(sql`
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        VALUES (
          gen_random_uuid(),
          ${ctx.tenantId},
          ${event.memoryId},
          ${event.kind},
          ${event.at ?? new Date()},
          ${JSON.stringify(event.actor)}::jsonb,
          ${event.digestSnapshot ?? null},
          ${event.sizeBeforeBytes ?? null},
          ${JSON.stringify(event.meta)}::jsonb
        )
        RETURNING *
      `);
      const storedEvent = rowToMemoryEvent(eventResult.rows[0] as unknown as MemoryEventRow);

      return { memory, event: storedEvent };
    });
  }

  /**
   * Issue #197 / ADR 0134: 両側とも `status = 'active'` の CAS を課したうえで、
   * `status='contested'`・`contested_with_id` を相互に設定する——1トランザクションで
   * 完結し、`updateStatusWithEvent`/`purgeMemory` と同じ「条件付き UPDATE が0行なら
   * 読み直して切り分ける」作法を、対象2件それぞれについて行う。**どちらか一方が
   * 失敗したら、その場で throw してロールバックする**（もう一方が先に成功していても
   * 巻き戻る）——対向ペアは本質的に結合しており、部分成功を許さない。
   */
  async markContestedPair(
    ctx: Ctx,
    first: { id: MemoryId; event: NewMemoryEvent },
    second: { id: MemoryId; event: NewMemoryEvent },
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }> {
    if (first.id === second.id) {
      throw new RangeError("PostgresMemoryStore: first.id and second.id must differ");
    }
    if (!isUuidLike(first.id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${first.id}`);
    }
    if (!isUuidLike(second.id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${second.id}`);
    }

    return this.db.transaction(async (tx) => {
      // 事前検証——存在確認。**両方の UPDATE を撃つ前に済ませる**（先に第1の UPDATE で
      // `contested_with_id = second.id` を書こうとすると、`second.id` がそもそも
      // 存在しない場合に外部キー違反という別種の失敗になり、「memory not found」に
      // 揃わない。`supersedeWithNewMemories` が `supersededByIndex` の範囲検査を
      // 書き込み前に済ませるのと同じ理由）。
      //
      // ⚠ **`ORDER BY id ASC FOR UPDATE` で、両側の行ロックを呼び出し順ではなく
      // 常に id 昇順で取る。** `markContestedPair(A, B)` と `markContestedPair(B, A)`
      // （対を逆順で呼ぶ2つの並行呼び出し）が、もしそれぞれ「渡された引数の順」に
      // 行ロックを取っていたら、片方が A→B、もう片方が B→A の順で行を掴み合い、
      // 40P01（`deadlock detected`）で片方が落ちる——契約が約束する
      // {@link MemoryStatusConflictError} ではなく、生の Postgres 例外が漏れる形になる
      // （2接続での実測: `restore-superseded-concurrent-forget.postgres.test.ts` と同じ
      // 構えの歯 `contested-pair-lock-order-concurrency.postgres.test.ts` 参照）。
      // ロックを常に id 昇順で取れば、どちらの呼び出しも同じ順序でしか行を掴めないため
      // 循環待ちが構造的に起きない——後から来たほうは先着の行ロックの解放待ちでブロック
      // されるだけになり、解放後に読み直した `status` が `'active'` でなければ
      // 下の CAS がそのまま {@link MemoryStatusConflictError} を投げる。
      const existing = await tx.execute(sql`
        SELECT id, status FROM memories
        WHERE tenant_id = ${ctx.tenantId}
          AND id = ANY(${sql.param([first.id, second.id])}::uuid[])
        ORDER BY id ASC
        FOR UPDATE
      `);
      const statusById = new Map(
        existing.rows.map((row) => {
          const r = row as unknown as { id: string; status: MemoryStatus };
          return [r.id, r.status] as const;
        }),
      );
      if (!statusById.has(first.id)) {
        throw new Error(`PostgresMemoryStore: memory not found for tenant: ${first.id}`);
      }
      if (!statusById.has(second.id)) {
        throw new Error(`PostgresMemoryStore: memory not found for tenant: ${second.id}`);
      }
      if (statusById.get(first.id) !== "active") {
        throw new MemoryStatusConflictError(first.id, "active", statusById.get(first.id)!);
      }
      if (statusById.get(second.id) !== "active") {
        throw new MemoryStatusConflictError(second.id, "active", statusById.get(second.id)!);
      }

      const updateSide = async (id: MemoryId, oppositeId: MemoryId): Promise<Memory> => {
        const result = await tx.execute(sql`
          UPDATE memories
          SET status = 'contested',
              contested_with_id = ${oppositeId},
              updated_at = now()
          WHERE tenant_id = ${ctx.tenantId} AND id = ${id} AND status = 'active'
          RETURNING *
        `);
        if (result.rows.length === 0) {
          // 事前検証を通った直後にここへ来るとすれば TOCTOU（事前検証と UPDATE の間に
          // 別の書き込みが割り込んだ）——読み直して切り分ける（`updateStatusWithEvent`
          // と同じ作法）。
          const current = await tx.execute(sql`
            SELECT status FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} LIMIT 1
          `);
          if (current.rows.length === 0) {
            throw new Error(`PostgresMemoryStore: memory not found for tenant: ${id}`);
          }
          const observedStatus = (current.rows[0] as unknown as { status: MemoryStatus }).status;
          throw new MemoryStatusConflictError(id, "active", observedStatus);
        }
        return rowToMemory(result.rows[0] as unknown as MemoryRow);
      };

      const firstMemory = await updateSide(first.id, second.id);
      const secondMemory = await updateSide(second.id, first.id);

      const insertEvent = async (event: NewMemoryEvent) => {
        const eventResult = await tx.execute(sql`
          INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
          VALUES (
            gen_random_uuid(),
            ${ctx.tenantId},
            ${event.memoryId},
            ${event.kind},
            ${event.at ?? new Date()},
            ${JSON.stringify(event.actor)}::jsonb,
            ${event.digestSnapshot ?? null},
            ${event.sizeBeforeBytes ?? null},
            ${JSON.stringify(event.meta)}::jsonb
          )
          RETURNING *
        `);
        return rowToMemoryEvent(eventResult.rows[0] as unknown as MemoryEventRow);
      };

      const firstEvent = await insertEvent(first.event);
      const secondEvent = await insertEvent(second.event);

      return {
        first: firstMemory,
        second: secondMemory,
        events: [firstEvent, secondEvent] as [MemoryEvent, MemoryEvent],
      };
    });
  }

  /**
   * Issue #372（(B) 第2段）: `MemoryStore.findActiveByClaimKey?` の実装（interface 側の
   * doc コメントに契約全体がある。ここはクエリの組み立てだけ）。
   * `idx_memories_claim_key`（`(tenant_id, subject_id, claim_key_subject,
   * claim_key_predicate)`、`migrations/0021_memories_claim_key.sql`）に載る4列の等値比較で
   * 絞り込み、`status`/`content_hash`/有効期間の重なりを追加の `WHERE` で絞る。
   * **LLM を一度も呼ばない**——列の等値比較・範囲比較・索引アクセスだけで完結する
   * （北極星 問い5）。
   *
   * `subject_id` は `IS NOT DISTINCT FROM` で比較する（NULL 同士も一致として扱う）——
   * Postgres の `=` は `NULL = NULL` を（真ではなく）`NULL` に評価するため、素の `=` では
   * `subjectId: null` の Memory 同士が一致しない（`docs/memory-model.md` の
   * 「`NULLS NOT DISTINCT` が要る理由」と同じ配慮を、索引ではなく述語の側でやっている）。
   *
   * `excludeMemoryId` はここでは SQL の条件にしない——`id` は `uuid` 型の列であり、
   * 呼び出し側から壊れた形式の文字列が渡ると `<>` の暗黙キャストでクエリ全体が
   * 例外を投げる（`get`/`reinforce` が `isUuidLike` で入口で弾いているのと同じ問題）。
   * この口は「渡された id を除いた行を返す」という契約であって「壊れた id を拒否する」
   * 契約ではないため、**返ってきた行を JS 側で除く**——`getMany` が壊れた id を
   * クエリの前に取り除くのと対称の位置（クエリの後）で同じ頑健性を買う。
   *
   * 有効期間の重なりは半開区間 `[valid_from, valid_until)` の標準的な判定
   * （`a1 < b2 AND a2 < b1`）を、`NULL` を `-∞`/`+∞` として読み替えて書く
   * （`aggregateScope` の `validAt` ゲートは「1点」を判定するのに対し、こちらは
   * 「区間の重なり」を判定する——同じ NULL の読み方を区間判定に拡張しただけである）。
   */
  async findActiveByClaimKey(
    ctx: Ctx,
    query: {
      subjectId: string | null;
      claimKey: ClaimKey;
      excludeMemoryId: MemoryId;
      contentHash: string;
      validFrom: Date | null;
      validUntil: Date | null;
    },
  ): Promise<Memory[]> {
    const validFrom = query.validFrom ?? null;
    const validUntil = query.validUntil ?? null;
    const result = await this.db.execute(sql`
      SELECT * FROM memories
      WHERE tenant_id = ${ctx.tenantId}
        AND subject_id IS NOT DISTINCT FROM ${query.subjectId}
        AND claim_key_subject = ${query.claimKey.subject}
        AND claim_key_predicate = ${query.claimKey.predicate}
        AND status = 'active'
        AND content_hash <> ${query.contentHash}
        AND (
          ${validFrom}::timestamptz IS NULL OR valid_until IS NULL
          OR ${validFrom}::timestamptz < valid_until
        )
        AND (
          valid_from IS NULL OR ${validUntil}::timestamptz IS NULL
          OR valid_from < ${validUntil}::timestamptz
        )
    `);
    return result.rows
      .map((row) => rowToMemory(row as unknown as MemoryRow))
      .filter((memory) => memory.id !== query.excludeMemoryId);
  }

  /**
   * Issue #691続き（ADR 0329）: `MemoryStore.listActiveClaimPredicates?` の実装
   * （interface 側の doc コメントに契約全体がある。ここはクエリの組み立てだけ）。
   * `idx_memories_claim_key`（`(tenant_id, subject_id, claim_key_subject,
   * claim_key_predicate)`、`migrations/0021_memories_claim_key.sql`）の先頭2列
   * （`tenant_id`, `subject_id`）で絞り込み、`status`/`claim_key_predicate IS NOT NULL`
   * を追加の `WHERE` で絞ったうえで `GROUP BY claim_key_predicate` して
   * `MAX(created_at)` で新しい順に並べる。**新しい索引は足さない**——ADR 0329 決定4
   * 参照（この口はテナントの1 subjectId に閉じた、既に小さい行数を前提にしている）。
   *
   * `subject_id` は `findActiveByClaimKey` と同じ `IS NOT DISTINCT FROM`
   * （NULL 同士も一致として扱う）。
   *
   * `GROUP BY claim_key_predicate ORDER BY MAX(created_at) DESC` は「同じ predicate を
   * 持つ行のうち最も新しい `created_at` で代表させ、その代表値で降順に並べる」という
   * interface 側の契約をそのまま SQL に落としたもの——`DISTINCT ON` ではなく
   * `GROUP BY` にしたのは、`DISTINCT ON` が「先頭1行を残す」ことしかせず、複数行にまたがる
   * 集約（`MAX`）を表現できないため。
   */
  async listActiveClaimPredicates(
    ctx: Ctx,
    query: { subjectId: string | null; limit: number },
  ): Promise<string[]> {
    const result = await this.db.execute(sql`
      SELECT claim_key_predicate AS predicate
      FROM memories
      WHERE tenant_id = ${ctx.tenantId}
        AND subject_id IS NOT DISTINCT FROM ${query.subjectId}
        AND status = 'active'
        AND claim_key_predicate IS NOT NULL
      GROUP BY claim_key_predicate
      ORDER BY MAX(created_at) DESC
      LIMIT ${query.limit}
    `);
    return result.rows.map((row) => (row as unknown as { predicate: string }).predicate);
  }

  /**
   * Issue #197 / ADR 0150: `markContestedPair` の解決側。両側とも `status = 'contested'`
   * かつ相互参照が成立していることを CAS で課したうえで、`contested_with_id` を両側とも
   * `NULL` に戻し、呼び出し側が指定した `status`（`'active'`/`'superseded'`）へ更新する
   * ——1トランザクションで完結し、`markContestedPair`/`updateStatusWithEvent`/`purgeMemory`
   * と同じ「条件付き UPDATE が0行なら読み直して切り分ける」作法を、対象2件それぞれについて
   * 行う。**どちらか一方が失敗したら、その場で throw してロールバックする**（もう一方が
   * 先に成功していても巻き戻る）——対向ペアは本質的に結合しており、部分成功を許さない
   * （`markContestedPair` と同じ理由）。
   */
  async resolveContestedPair(
    ctx: Ctx,
    first: {
      id: MemoryId;
      status: "active" | "superseded";
      supersededById?: MemoryId;
      event: NewMemoryEvent;
    },
    second: {
      id: MemoryId;
      status: "active" | "superseded";
      supersededById?: MemoryId;
      event: NewMemoryEvent;
    },
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }> {
    if (first.id === second.id) {
      throw new RangeError("PostgresMemoryStore: first.id and second.id must differ");
    }
    if (!isUuidLike(first.id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${first.id}`);
    }
    if (!isUuidLike(second.id)) {
      throw new Error(`PostgresMemoryStore: memory not found for tenant: ${second.id}`);
    }

    return this.db.transaction(async (tx) => {
      // 事前検証——存在確認。両方の UPDATE を撃つ前に済ませる（`markContestedPair` と
      // 同じ理由: 相手 id が存在しない場合を、外部キー違反ではなく「memory not found」に
      // 揃えるため）。ここで `contested_with_id` も読み、CAS（相互参照の成立）を判定する。
      //
      // ⚠ `markContestedPair` と同じ理由で `ORDER BY id ASC FOR UPDATE`——
      // `resolveContestedPair(A, B)` と `resolveContestedPair(B, A)`（同じ対を逆順で
      // 呼ぶ2つの並行呼び出し）が引数の順に行ロックを取ると、40P01（deadlock detected）
      // で片方が落ち、契約が約束する {@link MemoryStatusConflictError} ではなく生の
      // Postgres 例外が漏れる。常に id 昇順でロックを取れば循環待ちが構造的に起きない
      // （`markContestedPair` の同じコメント、`contested-pair-lock-order-concurrency.postgres.test.ts`
      // 参照）。
      const existing = await tx.execute(sql`
        SELECT id, status, contested_with_id FROM memories
        WHERE tenant_id = ${ctx.tenantId}
          AND id = ANY(${sql.param([first.id, second.id])}::uuid[])
        ORDER BY id ASC
        FOR UPDATE
      `);
      const rowById = new Map(
        existing.rows.map((row) => {
          const r = row as unknown as {
            id: string;
            status: MemoryStatus;
            contested_with_id: string | null;
          };
          return [r.id, r] as const;
        }),
      );
      const firstExisting = rowById.get(first.id);
      if (!firstExisting) {
        throw new Error(`PostgresMemoryStore: memory not found for tenant: ${first.id}`);
      }
      const secondExisting = rowById.get(second.id);
      if (!secondExisting) {
        throw new Error(`PostgresMemoryStore: memory not found for tenant: ${second.id}`);
      }
      if (firstExisting.status !== "contested" || firstExisting.contested_with_id !== second.id) {
        throw new MemoryStatusConflictError(first.id, "contested", firstExisting.status);
      }
      if (secondExisting.status !== "contested" || secondExisting.contested_with_id !== first.id) {
        throw new MemoryStatusConflictError(second.id, "contested", secondExisting.status);
      }

      const updateSide = async (
        side: { id: MemoryId; status: "active" | "superseded"; supersededById?: MemoryId },
        oppositeId: MemoryId,
      ): Promise<Memory> => {
        const result = await tx.execute(sql`
          UPDATE memories
          SET status = ${side.status},
              contested_with_id = NULL,
              superseded_by_id = COALESCE(${side.supersededById ?? null}, superseded_by_id),
              updated_at = now()
          WHERE tenant_id = ${ctx.tenantId} AND id = ${side.id}
            AND status = 'contested' AND contested_with_id = ${oppositeId}
          RETURNING *
        `);
        if (result.rows.length === 0) {
          // 事前検証を通った直後にここへ来るとすれば TOCTOU（事前検証と UPDATE の間に
          // 別の書き込みが割り込んだ）——読み直して切り分ける（`markContestedPair` と
          // 同じ作法）。
          const current = await tx.execute(sql`
            SELECT status FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${side.id} LIMIT 1
          `);
          if (current.rows.length === 0) {
            throw new Error(`PostgresMemoryStore: memory not found for tenant: ${side.id}`);
          }
          const observedStatus = (current.rows[0] as unknown as { status: MemoryStatus }).status;
          throw new MemoryStatusConflictError(side.id, "contested", observedStatus);
        }
        return rowToMemory(result.rows[0] as unknown as MemoryRow);
      };

      const firstMemory = await updateSide(first, second.id);
      const secondMemory = await updateSide(second, first.id);

      const insertEvent = async (event: NewMemoryEvent) => {
        const eventResult = await tx.execute(sql`
          INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
          VALUES (
            gen_random_uuid(),
            ${ctx.tenantId},
            ${event.memoryId},
            ${event.kind},
            ${event.at ?? new Date()},
            ${JSON.stringify(event.actor)}::jsonb,
            ${event.digestSnapshot ?? null},
            ${event.sizeBeforeBytes ?? null},
            ${JSON.stringify(event.meta)}::jsonb
          )
          RETURNING *
        `);
        return rowToMemoryEvent(eventResult.rows[0] as unknown as MemoryEventRow);
      };

      const firstEvent = await insertEvent(first.event);
      const secondEvent = await insertEvent(second.event);

      return {
        first: firstMemory,
        second: secondMemory,
        events: [firstEvent, secondEvent] as [MemoryEvent, MemoryEvent],
      };
    });
  }

  /**
   * `docs/memory-model.md` §11 行15「`superseded → active`」。契約は
   * `MemoryStore.restoreSupersededBy`（`@mnemora/core`）側にある——ここはクエリの
   * 実装のみ。
   *
   * `archiveDecayed`（ADR 0114、本ファイル上部）と同じ理由で、UPDATE と INSERT を
   * 単一の `WITH ... UPDATE ... INSERT ... SELECT` 文にまとめてある——1文なら、
   * 明示的な `BEGIN`/`COMMIT` を書かなくても両方が同じトランザクションに入る
   * （「片方だけ起きる」を構造的に作れない）。
   *
   * `target` の `WHERE` は既存の部分索引 `idx_memories_superseded_by`
   * （`tenant_id, superseded_by_id`、`migrations/0001_init.sql`）がそのまま担う——
   * 新しい索引は足していない。`AND status = 'superseded'` を等値条件として含めている。
   *
   * ⚠ **`restored` の `UPDATE ... FROM target t WHERE m.id = t.id` に、`m.status =
   * 'superseded' AND m.superseded_by_id = ${supersededById}` を明示的に重ねている
   * （`t` ではなく `m`——生きている行に対する条件）。** `target` はこの文の先頭で1度
   * 読んだスナップショットであり、READ COMMITTED の下では「`target` を読んでから
   * `restored` の UPDATE が実際にその行をロックするまでの間」に、別のトランザクションが
   * 同じ行を `superseded → forgotten`（`updateStatusWithEvent` 経由の forget 等）へ
   * 進めてコミットしうる。`m.id = t.id` だけを条件にすると、Postgres は EvalPlanQual で
   * 最新版の行を再取得したうえで**この UPDATE 自身の WHERE**を再評価するが、`target` の
   * 条件（`status = 'superseded'`）はその再評価に含まれない——`t.id` は既に確定した
   * 値の集合でしかないため。**その結果、直前に forget/purge でコミットされた行を
   * `active` へ巻き戻し、`unsuperseded` イベントを誤って積みうる（2接続での実測は
   * `packages/postgres/src/__tests__/restore-superseded-concurrent-forget.postgres.test.ts`）。**
   * `m.status`/`m.superseded_by_id` を UPDATE 自身の WHERE に重ねることで、EvalPlanQual が
   * 再評価する対象にこの2条件が入り、最新版の行が既に条件を満たさなくなっていれば
   * その行は `restored` から自然に落ちる（`archiveDecayed`/`requeueEmbedJobs` の
   * `FOR UPDATE SKIP LOCKED` とは別の形だが、狙いは同じ——「読んだ後に承知の外で
   * 状態が変わった行を、確認せずに書き換えない」）。
   *
   * `digest_snapshot` には（変更しない）現在の `digest` を入れる——`archiveDecayed`/
   * `forget` と同じ規約。`meta` は `{ reason, supersededById }`——`reason` は
   * 呼び出し側が渡した値、省略時は固定タグ `'unsuperseded'`（`updateStatusWithEvent`
   * を経由する操作の「省略時はキー自体を持たせない」規律とはここだけ意図的に違う。
   * interface 側の契約節参照）。
   *
   * `filter?.onlyMemoryIds`（Issue #515 方向①、ADR 0258）: 指定すると `target` CTE に
   * `AND id = ANY(...)::uuid[]` を1行足すだけ——`digestBand.excludeMemoryIds`
   * （本ファイル上部、除外方向の同型パターン）を包含方向に転用しただけであり、
   * **新しい索引は要らない**（`memories.id` は既に `PRIMARY KEY`。
   * `idx_memories_superseded_by` による絞り込みの上に PK 条件を重ねるだけ）。
   */
  async restoreSupersededBy(
    ctx: Ctx,
    supersededById: MemoryId,
    event: { reason?: string; actor?: EventActor; at: Date },
    filter?: { onlyMemoryIds?: MemoryId[] },
  ): Promise<{ restored: Memory[] }> {
    if (!isUuidLike(supersededById)) {
      return { restored: [] };
    }
    const actor = event.actor ?? { type: "system" };
    const meta = { reason: event.reason ?? "unsuperseded", supersededById };
    const onlyMemoryIdsClause =
      filter?.onlyMemoryIds !== undefined
        ? sql`AND id = ANY(${sql.param([...filter.onlyMemoryIds])}::uuid[])`
        : sql``;

    const result = await this.db.execute(sql`
      WITH target AS (
        SELECT id FROM memories
        WHERE tenant_id = ${ctx.tenantId}
          AND superseded_by_id = ${supersededById}
          AND status = 'superseded'
          ${onlyMemoryIdsClause}
      ),
      restored AS (
        UPDATE memories m
        SET status = 'active', superseded_by_id = NULL, updated_at = now()
        FROM target t
        WHERE m.id = t.id
          AND m.status = 'superseded'
          AND m.superseded_by_id = ${supersededById}
        RETURNING m.*
      ),
      inserted_events AS (
        INSERT INTO memory_events (id, tenant_id, memory_id, kind, at, actor, digest_snapshot, size_before_bytes, meta)
        SELECT
          gen_random_uuid(), ${ctx.tenantId}, r.id, 'unsuperseded', ${event.at},
          ${JSON.stringify(actor)}::jsonb, r.digest, NULL, ${JSON.stringify(meta)}::jsonb
        FROM restored r
        RETURNING memory_id
      )
      SELECT * FROM restored ORDER BY id ASC
    `);

    const restored = result.rows.map((row) => rowToMemory(row as unknown as MemoryRow));
    return { restored };
  }

  /**
   * `restoreSupersededBy` を実際に呼ぶ**前**に見るための読み取り専用の口
   * （Issue #515、ADR 0237。契約は `MemoryStore.previewRestoreSupersededBy`（`@mnemora/core`）
   * 側にある——ここはクエリの実装のみ）。
   *
   * `target` の `WHERE` は `restoreSupersededBy` の `target` CTE と**1文字も違わない**
   * ——同じ部分索引 `idx_memories_superseded_by` をそのまま使う。`UPDATE`/`INSERT` を
   * 一切持たない `SELECT` のみの文であり、`restoreSupersededBy` と違って
   * トランザクションを開始する必要も無い（読み取りが1文で完結する）。
   *
   * `latest_superseded_event` は、対象ごとに直近の `kind = 'superseded'` の
   * `memory_events` 行を1件選ぶ（`DISTINCT ON (memory_id) ... ORDER BY memory_id,
   * at DESC`）。**新しい索引を足していない**——`idx_memory_events_by_memory`
   * （`tenant_id, memory_id, at`）が `memory_id = 対象` を絞る側をそのまま担い、
   * `kind = 'superseded'` は結果に対する追加のフィルタ（この列だけを絞る索引は無いが、
   * 対象がまず `target` で絞られているため、走査量は「群のサイズ」に比例する——
   * テナント全体の `memory_events` を走査しない）。`meta->>'reason'` が無い
   * （行はあるが `reason` キーが無い）場合は SQL の `->>` が `NULL` を返し、
   * 対象について一致する行が1件も無い場合は `LEFT JOIN` により `NULL` になる——
   * この2つを呼び出し側から区別する必要は無い（`MemoryStore.previewRestoreSupersededBy`
   * の doc コメント「取れないことを正直に返す」参照。どちらも「取れない」の一種）。
   *
   * `filter?.onlyMemoryIds`（Issue #515 方向①、ADR 0258）: `restoreSupersededBy` と
   * **1文字も違わない** `AND id = ANY(...)::uuid[]` を `target` CTE に足す——
   * 「対象の選び方を完全に一致させる」という既存の契約をここでも守る。
   */
  async previewRestoreSupersededBy(
    ctx: Ctx,
    supersededById: MemoryId,
    filter?: { onlyMemoryIds?: MemoryId[] },
  ): Promise<{ candidates: Array<{ memoryId: MemoryId; supersededReason: string | null }> }> {
    if (!isUuidLike(supersededById)) {
      return { candidates: [] };
    }
    const onlyMemoryIdsClause =
      filter?.onlyMemoryIds !== undefined
        ? sql`AND id = ANY(${sql.param([...filter.onlyMemoryIds])}::uuid[])`
        : sql``;

    const result = await this.db.execute(sql`
      WITH target AS (
        SELECT id FROM memories
        WHERE tenant_id = ${ctx.tenantId}
          AND superseded_by_id = ${supersededById}
          AND status = 'superseded'
          ${onlyMemoryIdsClause}
      ),
      latest_superseded_event AS (
        SELECT DISTINCT ON (me.memory_id) me.memory_id, me.meta ->> 'reason' AS reason
        FROM memory_events me
        JOIN target t ON t.id = me.memory_id
        WHERE me.tenant_id = ${ctx.tenantId}
          AND me.kind = 'superseded'
        ORDER BY me.memory_id, me.at DESC
      )
      SELECT t.id, lse.reason
      FROM target t
      LEFT JOIN latest_superseded_event lse ON lse.memory_id = t.id
      ORDER BY t.id ASC
    `);

    return {
      candidates: result.rows.map((row) => {
        const r = row as unknown as { id: string; reason: string | null };
        return { memoryId: r.id as MemoryId, supersededReason: r.reason };
      }),
    };
  }

  /**
   * Issue #201 / [ADR 0318](../../../docs/decisions/0318-taxonomy-labels.md):
   * `listLabels?`（`@mnemora/core` の interface doc 参照）。
   *
   * Issue #881 / ADR 0318 追記（2026-09-26、クローン miku の判断）: `name` の並び順は
   * **コードポイント順**（バイト順）と決めた。`ORDER BY name`（COLLATE 指定なし）は
   * DB の既定の照合順序に従うため、既定が `C` でない DB（例: `en_US.utf8`）では
   * ロケール依存の自然順になりコードポイント順とずれる——`COLLATE "C"` を明示して
   * DB の既定ロケールに関わらず常にコードポイント順（バイト順）で返す。
   */
  async listLabels(ctx: Ctx): Promise<LabelSummary[]> {
    const result = await this.db.execute(sql`
      SELECT * FROM labels WHERE tenant_id = ${ctx.tenantId} ORDER BY name COLLATE "C" ASC
    `);
    return result.rows.map((row) => rowToLabel(row as unknown as LabelRow));
  }

  /**
   * Issue #201 / [ADR 0318](../../../docs/decisions/0318-taxonomy-labels.md):
   * `registerLabel?`（`@mnemora/core` の interface doc 参照）。行が無ければ
   * `proposed_count: 0` の `registered` 行を作る。既に `proposed` なら `registered` へ
   * 更新し `registered_at` を今にする。既に `registered` なら `registered_at` を
   * 変えない——`COALESCE(labels.registered_at, now())` が「既存の値があればそれを保つ、
   * 無ければ今にする」を1つの UPSERT で表す。
   */
  async registerLabel(ctx: Ctx, name: string): Promise<LabelSummary> {
    const result = await this.db.execute(sql`
      INSERT INTO labels (id, tenant_id, name, status, proposed_count, registered_at)
      VALUES (gen_random_uuid(), ${ctx.tenantId}, ${name}, 'registered', 0, now())
      ON CONFLICT (tenant_id, name) DO UPDATE
        SET status = 'registered',
            registered_at = COALESCE(labels.registered_at, now())
      RETURNING *
    `);
    return rowToLabel(result.rows[0] as unknown as LabelRow);
  }
}

/**
 * ADR 0114 / [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと15:
 * `archiveDecayed` が「どの行を archived にするか」を選ぶ `SELECT`。
 *
 * **本体と `EXPLAIN` の歯（`packages/postgres/src/__tests__/archive-decayed-index.test.ts`）
 * が、同じものを使うために切り出してある**——`buildRequeueEmbedTargetSelect`
 * （ADR 0079、直上）と同じ理由。テスト側に述語を書き写すと、本体の述語を直したときに
 * 歯だけが古い述語を測り続ける。
 *
 * `opts.clock` で述語を切り替える（省略時は `'wall'`、本 ADR 以前と1バイトも変わらない）:
 * - `'wall'`: `decay_floor_at <= opts.now`（既存索引 `idx_memories_recall_gate`
 *   `(tenant_id, status, decay_floor_at)` を使う——**新しい索引は追加しない**。
 *   `status = 'active'` は部分索引の述語 `status IN ('active','contested')` を含意する）。
 * - `'activity'`: `decay_floor_seq IS NOT NULL AND decay_floor_seq <= opts.nowSeq`
 *   （`idx_memories_recall_gate_seq` を使う。`opts.nowSeq` 必須）。
 * - `'either'`: **AND**（両方の軸で沈んでいるものだけ掃く。ゲートの `'either'` が OR
 *   なのとは逆——`ArchiveDecayedOptions.clock` の doc コメント「⭐」参照）。
 *
 * ⚠ **`decay_floor_at <= opts.now`・`decay_floor_seq <= opts.nowSeq`（どちらも境界を含む）。**
 * `VectorFilter.decayFloorAtAfter`/`decayFloorSeqAfter`
 * （`packages/core/src/interfaces/vector-store.ts`）は狭義の `>`（境界を含まない）——
 * この非対称は意図である（`ArchiveDecayedOptions.clock` の doc コメント「境界の非対称」参照）。
 *
 * ⚠ **`ORDER BY decay_floor_at ASC` は `'activity'`/`'either'` でもそのまま使う。**
 * `MemoryStore.archiveDecayed`/`ArchiveDecayedResult.archived` の doc コメントは
 * ADR 0165 導入後も「`decay_floor_at` 昇順」としか書いておらず（`decay_floor_seq` 順の
 * 契約は無い）、返り値の型 `{ memoryId; decayFloorAt: Date }` も `decayFloorSeq` を
 * 持たない——`decay_floor_at` は常に non-null なので、この列で安定した順序を作れる。
 */
export function buildArchiveDecayedTargetSelect(ctx: Ctx, opts: ArchiveDecayedOptions): SQL {
  const clock = opts.clock ?? "wall";
  const wallCondition = sql`decay_floor_at <= ${opts.now}`;
  const activityCondition = (): SQL => {
    if (opts.nowSeq === undefined) {
      throw new Error(
        `PostgresMemoryStore.archiveDecayed: opts.nowSeq is required when clock is "${clock}"`,
      );
    }
    return sql`(decay_floor_seq IS NOT NULL AND decay_floor_seq <= ${opts.nowSeq})`;
  };

  let clockCondition: SQL;
  if (clock === "wall") {
    clockCondition = wallCondition;
  } else if (clock === "activity") {
    clockCondition = activityCondition();
  } else {
    // 'either': 掃引は AND（両方の軸で沈んでいるものだけ掃く。ゲートの OR とは逆向き）。
    clockCondition = sql`(${wallCondition} AND ${activityCondition()})`;
  }

  // ⭐ [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと8:
  // **並べる軸は、掃く軸に合わせる。** `clock: 'activity'` のときに `decay_floor_at` で
  // 並べると、`idx_memories_recall_gate_seq`（`(tenant_id, status, decay_floor_seq)`）は
  // **並び替えを満たせないので選ばれず**、プランナは壁時計側の索引を走査して
  // `decay_floor_seq` を Filter に落とす——【実測】2026-09-16、CI の
  // `archive-decayed-index.test.ts`「適用可能性（活動時計）」が実際にこれで赤くなった
  // （EXPLAIN 逐語: `Filter: ((decay_floor_seq IS NOT NULL) AND (decay_floor_seq <= '20000'::bigint))`）。
  // ⟹ 活動軸で沈んだ行が疎なテナントでは、`limit` 件を見つけるまで壁時計順に大量の行を
  // 走査することになる。**正しさではなく処理量の問題である。**
  //
  // 意味論の上でも、活動時計のテナントで「いちばん沈んだものから掃く」なら、
  // 並べるべきは活動軸である。
  //
  // ⚠ **これは `ArchiveDecayedResult.archived` の並び順の契約を変えない。**
  // 呼び出し元（`archiveDecayed`）の外側のクエリが、返す行を常に
  // `ORDER BY decay_floor_at ASC, id ASC` に並べ直している。ここで変わるのは
  // 「`limit` が効くときに *どの行を選ぶか*」だけである。
  //
  // `'either'` は壁時計のまま——掃引の条件が AND（両方の軸で沈んだものだけ）であり、
  // どちらの索引も単独では述語を満たしきれない。ADR 決めたこと9 が `'either'` について
  // 「1本の btree で範囲スキャンできるとは主張しない」と書いているのと同じ理由である。
  const targetOrder = clock === "activity" ? sql`decay_floor_seq ASC` : sql`decay_floor_at ASC`;

  return sql`
    SELECT id FROM memories
    WHERE tenant_id = ${ctx.tenantId}
      AND status = 'active'
      AND ${clockCondition}
    ORDER BY ${targetOrder}, id ASC
    LIMIT ${opts.limit}
    FOR UPDATE SKIP LOCKED`;
}

/**
 * ADR 0079: `requeueEmbedJobs` が「どの行を積み直すか」を選ぶ `SELECT`。
 *
 * **本体と `EXPLAIN` の歯が、同じものを使うために切り出してある。**
 * `packages/postgres/src/__tests__/memories-requeue-embed-index.test.ts` がこの関数の
 * 返り値をそのまま `EXPLAIN` する——**テスト側に SQL を書き写すと、本体の述語を
 * 直したときに歯だけが古い述語を測り続ける**（`outbox-claim-lease-index.test.ts` が
 * DDL をマイグレーションファイルから読むのと同じ理由。AGENTS.md が北極星の要約を
 * 置かないのと同じ理由でもある）。
 *
 * `memoryIds` を渡されたのに well-formed な id が1つも残らなかったときは `null` を返す
 * ——形式が壊れた id は `getMany` と同じく静かに落とす（uuid 列への cast で文全体が
 * 例外になるのを避ける。`mapping.ts` の `isUuidLike` の doc 参照）が、**絞り込みを
 * 渡されたのに残りが0件なら、それは空集合との積**であり、問い合わせる意味が無い。
 */
export function buildRequeueEmbedTargetSelect(ctx: Ctx, opts: RequeueEmbedJobsOptions): SQL | null {
  let idFilter = sql``;
  if (opts.memoryIds !== undefined) {
    const wellFormedIds = opts.memoryIds.filter((id) => isUuidLike(id));
    if (wellFormedIds.length === 0) {
      return null;
    }
    idFilter = sql` AND id = ANY(${sql.param(wellFormedIds)}::uuid[])`;
  }

  return sql`
    SELECT id FROM memories
    WHERE tenant_id = ${ctx.tenantId}
      AND status IN ('active', 'contested')
      -- ⚠ **ここに "AND embedding_status <> 'ready'" を書き足さないこと。**
      -- 部分索引 idx_memories_requeue_embed（migration 0007）の述語を WHERE へ写して
      -- 含意を助ける必要がある、と当初は考えた。**CI の EXPLAIN で逆だと分かった**
      -- （ADR 0079「測ったこと」に全文）: プランナは "= ANY($n)" の実引数を定数として
      -- 見るので（node-postgres の unnamed statement は custom plan になる）、
      -- 述語 "embedding_status <> 'ready'" は書かなくても含意される。
      -- そして**書くと逆に遅くなる**——その条件片が Recheck Cond に回って Bitmap Heap
      -- Scan が選ばれ、ORDER BY のために Sort が挟まる（cost 843、LIMIT の早期打ち切りが
      -- 効かない）。書かなければ素の Index Scan で並びがそのまま供給される（cost 58）。
      AND embedding_status = ANY(${sql.param(opts.statuses)}::text[])
      ${idFilter}
    ORDER BY updated_at ASC, id ASC
    LIMIT ${opts.limit}
    FOR UPDATE SKIP LOCKED`;
}

/**
 * Issue #210 / ADR 0115: `PostgresMemoryStore.purgeExpiredEvents` が「どの行を消すか」を
 * 選ぶ `SELECT`。**本体と `EXPLAIN` の歯が、同じものを使うために切り出してある**
 * （`buildRequeueEmbedTargetSelect` と同じ理由——テスト側に述語を書き写すと、本体の
 * 述語を直したときにその歯だけが古い述語を測り続ける）。
 *
 * `LIMIT opts.limit + 1` で1件多く取る——`reachedLimit`（「1回で消しきれなかった」）を
 * `purged === opts.limit` からの推測に頼らず、専用の信号として立てるため
 * （`packages/core/src/interfaces/memory-store.ts` の契約節参照）。
 *
 * ⚠ **`opts.limit` は0以上の整数を渡す前提であり、負数を渡したときの結果は未定義**
 * （`PurgeExpiredEventsOptions.limit` の doc 参照、Issue #876）。**この `+1` の算術ゆえに
 * `opts.limit === -1` だけは `LIMIT 0` になり例外にならない**——2026-09-26 実測
 * （PostgreSQL 17.11 + pgvector 0.8.0、`main` cb6d1db）で `purgeExpiredEvents(ctx,
 * { limit: -1, olderThan })` は `{ purged: 0, reachedLimit: true, oldestPurgedAt: null,
 * newestPurgedAt: null, dryRun }` を返した（`dryRun: true`/`false` とも同じ形）。
 * `reachedLimit: true` になるのは、この関数が返す0行に対して呼び出し側が
 * `rows.length > opts.limit`（`0 > -1`）で判定するため——**「1回で消しきれなかった」を
 * 意味する信号のはずが、ここでは取り違いを起こす**。`opts.limit <= -2` では
 * `LIMIT` に負数が渡り Postgres 自身が例外を投げる。**この `-1` の折れ方は狙って設計した
 * ものではなく、`+1` の算術が生んだ偶然である**——契約として真似る理由は無い
 * （採らなかった案は [ADR 0115](../../../../docs/decisions/0115-event-retention-purge.md)
 * の2026-09-26追記を参照）。
 *
 * `kind <> 'events_purged'` は `memory_events` に `(tenant_id, at)` の索引
 * （`migrations/0010_memory_events_retention_index.sql`）を張ったうえで Filter として
 * 残す——`kind` を索引に含めない（無限後退を避けるための除外は「対象の絞り込み」で
 * あり、行数の大半を削る述語ではないため、部分索引にする動機が薄い。実測は
 * `memory-events-retention-index.test.ts` 参照）。
 */
export function buildPurgeExpiredEventsTargetSelect(
  ctx: Ctx,
  opts: PurgeExpiredEventsOptions,
): SQL {
  return sql`
    SELECT id, at FROM memory_events
    WHERE tenant_id = ${ctx.tenantId}
      AND at < ${opts.olderThan}
      AND kind <> 'events_purged'
    ORDER BY at ASC
    LIMIT ${opts.limit + 1}`;
}
