import { defaultDecayStrategy, MemoryStatusConflictError } from "@mnemora/core";
import type { NotIndexedReason } from "@mnemora/core";
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
import { nextId } from "./id.js";

/**
 * `MemoryStore` のインメモリ・プレースホルダ実装。
 *
 * **本番用途ではない。** `packages/testkit` の適合テストが実際に実行できることを示す
 * ためだけの最小実装であり、`packages/postgres`（段階2）が実装すべき振る舞いの
 * 完全な参照ではない。特に索引・永続化・トランザクションは一切模していない。
 *
 * roadmap.md 段階3で `outboxJobs` を公開した。`InMemoryOutboxStore`
 * （`./in-memory-outbox-store.js`）にこの配列をそのまま渡すことで、`createObservationWithOutbox` /
 * `createMemoryWithOutbox` が積んだジョブを `OutboxStore` 側から claim/complete/fail できる
 * （`packages/postgres` が同一 DB・同一トランザクションで両方を実装するのと対応する、
 * ADR 0005・0003）。
 */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly observations = new Map<string, Observation>();
  private readonly memories = new Map<string, Memory>();
  /** `(tenant_id, source_observation_id, extractor_version, content_hash)` の冪等キー。 */
  private readonly extractionIndex = new Map<string, MemoryId>();
  /** `(tenant_id, recall_id, memory_id)` の使用報告の冪等キー。 */
  private readonly usages = new Set<string>();
  /** roadmap.md 段階4/5: recall 段6（記録）が書き込む `recalls` 相当のインメモリ表。 */
  readonly recalls = new Map<string, NewRecallRecord & { tenantId: string }>();
  /** `InMemoryOutboxStore` と共有する outbox ジョブの配列（同一プロセス内の参照共有）。 */
  readonly outboxJobs: OutboxJobRecord[] = [];

  async createObservation(ctx: Ctx, input: NewObservation): Promise<Observation> {
    if (input.externalId) {
      const existing = [...this.observations.values()].find(
        (o) => o.tenantId === ctx.tenantId && o.externalId === input.externalId,
      );
      if (existing) {
        return existing;
      }
    }
    const observation: Observation = {
      id: nextId("obs"),
      tenantId: ctx.tenantId,
      subjectId: input.subjectId ?? null,
      externalId: input.externalId ?? null,
      kind: input.kind,
      payload: input.payload,
      occurredAt: input.occurredAt ?? null,
      recordedAt: input.recordedAt ?? new Date(),
    };
    this.observations.set(observation.id, observation);
    return observation;
  }

  async getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null> {
    const observation = this.observations.get(id);
    if (!observation || observation.tenantId !== ctx.tenantId) {
      return null;
    }
    return observation;
  }

  private enqueueOutboxJob(
    ctx: Ctx,
    kind: OutboxJobKind,
    payload: Record<string, unknown>,
  ): OutboxJobRecord {
    const job: OutboxJobRecord = {
      id: nextId("job"),
      tenantId: ctx.tenantId,
      kind,
      payload,
      availableAt: new Date(),
      claimedAt: null,
      claimedBy: null,
      attempts: 0,
      completedAt: null,
      failedAt: null,
      lastError: null,
      createdAt: new Date(),
    };
    this.outboxJobs.push(job);
    return job;
  }

  async createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }> {
    const sizeBefore = this.observations.size;
    const observation = await this.createObservation(ctx, input);
    const created = this.observations.size > sizeBefore;
    if (!created) {
      return { observation, created: false, jobs: [] };
    }
    const jobs = jobKinds.map((kind) =>
      this.enqueueOutboxJob(ctx, kind, { observationId: observation.id }),
    );
    return { observation, created: true, jobs };
  }

  async createMemory(ctx: Ctx, input: NewMemory): Promise<Memory> {
    const idemKey = this.extractionKey(
      ctx.tenantId,
      input.sourceObservationId ?? null,
      input.extractorVersion ?? null,
      input.contentHash,
    );
    if (input.sourceObservationId) {
      const existingId = this.extractionIndex.get(idemKey);
      if (existingId) {
        const existing = this.memories.get(existingId);
        if (existing) {
          return existing;
        }
      }
    }

    const now = new Date();
    const memory: Memory = {
      id: nextId("mem"),
      tenantId: ctx.tenantId,
      subjectId: input.subjectId ?? null,
      sourceObservationId: input.sourceObservationId ?? null,
      extractorVersion: input.extractorVersion ?? null,
      content: input.content,
      contentHash: input.contentHash,
      digest: input.digest,
      digestSource: input.digestSource,
      provenance: input.provenance,
      status: input.status ?? "active",
      supersededById: input.supersededById ?? null,
      contestedWithId: input.contestedWithId ?? null,
      tags: input.tags,
      occurredAt: input.occurredAt ?? null,
      recordedAt: input.recordedAt,
      lastReinforcedAt: input.lastReinforcedAt ?? null,
      strength: input.strength,
      halfLifeHours: input.halfLifeHours,
      decayFloorAt: input.decayFloorAt,
      embeddingStatus: input.embeddingStatus,
      createdAt: now,
      updatedAt: now,
    };
    this.memories.set(memory.id, memory);
    if (input.sourceObservationId) {
      this.extractionIndex.set(idemKey, memory.id);
    }
    return memory;
  }

  async createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> {
    const sizeBefore = this.memories.size;
    const memory = await this.createMemory(ctx, input);
    const created = this.memories.size > sizeBefore;
    if (!created) {
      return { memory, created: false, jobs: [] };
    }
    const jobs = jobKinds.map((kind) => this.enqueueOutboxJob(ctx, kind, { memoryId: memory.id }));
    return { memory, created: true, jobs };
  }

  async get(ctx: Ctx, id: MemoryId): Promise<Memory | null> {
    const memory = this.memories.get(id);
    if (!memory || memory.tenantId !== ctx.tenantId) {
      return null;
    }
    return memory;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const id of ids) {
      const memory = this.memories.get(id);
      if (memory && memory.tenantId === ctx.tenantId) {
        results.push(memory);
      }
    }
    return results;
  }

  /**
   * ADR 0028: `reextract` が既存 Memory のうち今回作られなかったものを判定するための列挙
   * （**SELECT のみ**）。`extractorVersion: null` は `extractor_version IS NULL`
   * （postgres 実装の `IS NOT DISTINCT FROM` と同じ規約）を意味する。
   */
  async listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const memory of this.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      if (memory.sourceObservationId !== observationId) continue;
      if ((memory.extractorVersion ?? null) !== (extractorVersion ?? null)) continue;
      results.push(memory);
    }
    return results;
  }

  /** ADR 0030: `opts.expectedStatus` があるときだけ compare-and-swap にする（postgres 実装と同じ意味論）。 */
  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
  ): Promise<Memory> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
    }
    if (opts?.expectedStatus !== undefined && memory.status !== opts.expectedStatus) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    memory.status = status;
    if (opts?.supersededById !== undefined) {
      memory.supersededById = opts.supersededById;
    }
    memory.updatedAt = new Date();
    return memory;
  }

  async setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
    }
    memory.embeddingStatus = status;
    memory.updatedAt = new Date();
    return memory;
  }

  async reinforce(ctx: Ctx, id: MemoryId, at: Date): Promise<Memory> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`InMemoryMemoryStore: memory not found for tenant: ${id}`);
    }
    memory.lastReinforcedAt = at;
    memory.decayFloorAt = defaultDecayStrategy.floorAt({
      recordedAt: memory.recordedAt,
      lastReinforcedAt: memory.lastReinforcedAt,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });
    memory.updatedAt = new Date();
    return memory;
  }

  async recordUsage(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    const insertedMemoryIds: MemoryId[] = [];
    for (const memoryId of memoryIds) {
      const key = `${ctx.tenantId}:${recallId}:${memoryId}`;
      if (!this.usages.has(key)) {
        this.usages.add(key);
        insertedMemoryIds.push(memoryId);
      }
    }
    return { insertedMemoryIds };
  }

  /**
   * roadmap.md 段階4/5: `countByGroup` を置き換える単一集約（`ScopeAggregate`、
   * docs/recall.md §5・packages/core の recall.ts の doc コメント参照）。
   *
   * インメモリ実装なので「単一クエリ」という概念自体は無いが、契約として重要なのは
   * 「groups の総和が totalInScope と一致すること」——ここでは同じ1回のループで
   * 両方を積み上げることでそれを保証する（postgres 実装は単一 SQL 文でこれを保証する）。
   */
  async aggregateScope(ctx: Ctx, scope: RecallScope): Promise<ScopeAggregate> {
    const inScopeBySubject = new Map<string | null, number>();
    let totalInScope = 0;
    const notIndexed: Record<NotIndexedReason, number> = { pending: 0, failed: 0, skipped: 0 };
    let filteredArchived = 0;
    let filteredSuperseded = 0;
    let filteredForgotten = 0;
    let filteredPeriod = 0;

    for (const memory of this.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) {
        continue;
      }
      if (scope.subjectId !== undefined && memory.subjectId !== scope.subjectId) {
        continue;
      }

      if (memory.status === "archived") {
        filteredArchived += 1;
        continue;
      }
      if (memory.status === "superseded") {
        filteredSuperseded += 1;
        continue;
      }
      if (memory.status === "forgotten") {
        filteredForgotten += 1;
        continue;
      }
      // ここに来るのは status IN ('active','contested') のみ。

      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      const inPeriod =
        (scope.occurredAfter === undefined || effectiveTime >= scope.occurredAfter) &&
        (scope.occurredBefore === undefined || effectiveTime <= scope.occurredBefore);
      if (!inPeriod) {
        filteredPeriod += 1;
        continue;
      }

      totalInScope += 1;
      const key = memory.subjectId ?? null;
      inScopeBySubject.set(key, (inScopeBySubject.get(key) ?? 0) + 1);
      if (memory.embeddingStatus !== "ready") {
        notIndexed[memory.embeddingStatus] += 1;
      }
    }

    const groups: ScopeAggregate["groups"] = [...inScopeBySubject.entries()].map(
      ([key, count]) => ({
        axis: "subject" as const,
        key,
        count,
        countKind: "exact" as const,
      }),
    );

    return {
      groups,
      totalInScope,
      countKind: "exact",
      notIndexed: {
        pending: { count: notIndexed.pending, countKind: "exact" },
        failed: { count: notIndexed.failed, countKind: "exact" },
        skipped: { count: notIndexed.skipped, countKind: "exact" },
      },
      filteredArchived: { count: filteredArchived, countKind: "exact" },
      filteredSuperseded: { count: filteredSuperseded, countKind: "exact" },
      filteredForgotten: { count: filteredForgotten, countKind: "exact" },
      filteredPeriod: { count: filteredPeriod, countKind: "exact" },
    };
  }

  async createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId> {
    const id = nextId("rcl");
    this.recalls.set(id, { ...record, tenantId: ctx.tenantId });
    return id;
  }

  private extractionKey(
    tenantId: string,
    sourceObservationId: string | null,
    extractorVersion: string | null,
    contentHash: string,
  ): string {
    return `${tenantId}:${sourceObservationId ?? ""}:${extractorVersion ?? ""}:${contentHash}`;
  }
}
