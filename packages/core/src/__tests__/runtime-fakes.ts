import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { EventStore } from "../interfaces/event-store.js";
import type { ClaimOutboxJobsOptions, OutboxStore } from "../interfaces/outbox-store.js";
import type { OutboxJobKind } from "../interfaces/scheduler.js";
import type { TenantSettingsStore } from "../interfaces/tenant-settings-store.js";
import type { VectorStore, VectorFilter, VectorHit } from "../interfaces/vector-store.js";
import type { NotIndexedReason } from "../recall.js";
import type { MemoryId, ObservationId, RecallId } from "../ids.js";
import type { EmbeddingStatus, Memory, MemoryStatus, NewMemory } from "../memory.js";
import type { NewObservation, Observation } from "../observation.js";
import type { MemoryEvent, NewMemoryEvent, EventFilter } from "../event.js";
import type { EventId } from "../ids.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { NewRecallRecord, RecallScope, ScopeAggregate } from "../recall.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { OutboxJobRecord } from "../outbox.js";
import { defaultDecayStrategy } from "../strategies/decay.js";

/**
 * `packages/core` 自身の runtime テスト用フェイク一式。
 *
 * **`@mnemora/testkit` を import しない。** core は誰にも依存されるが誰にも依存しない
 * （docs/architecture.md §4）——`testkit` は `core` に依存するパッケージであり、逆方向の
 * 依存を core のテストからも作らない。ここでのフェイクは testkit の in-memory 実装と
 * 似ているが意図的に独立している（1つを直せばもう1つが壊れる、という結合を作らない）。
 */

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

type OutboxJobMutable = OutboxJobRecord;

class FakeBackingStore {
  observations = new Map<string, Observation>();
  memories = new Map<string, Memory>();
  extractionIndex = new Map<string, MemoryId>();
  usages = new Set<string>();
  recalls = new Map<string, NewRecallRecord & { tenantId: string }>();
  outboxJobs: OutboxJobMutable[] = [];

  extractionKey(
    tenantId: string,
    sourceObservationId: string | null,
    extractorVersion: string | null,
    contentHash: string,
  ): string {
    return `${tenantId}:${sourceObservationId ?? ""}:${extractorVersion ?? ""}:${contentHash}`;
  }
}

export class FakeMemoryStore implements MemoryStore {
  constructor(private readonly backing: FakeBackingStore) {}

  async createObservation(ctx: Ctx, input: NewObservation): Promise<Observation> {
    if (input.externalId) {
      const existing = [...this.backing.observations.values()].find(
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
    this.backing.observations.set(observation.id, observation);
    return observation;
  }

  async getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null> {
    const observation = this.backing.observations.get(id);
    if (!observation || observation.tenantId !== ctx.tenantId) {
      return null;
    }
    return observation;
  }

  async createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }> {
    const before = this.backing.observations.size;
    const observation = await this.createObservation(ctx, input);
    const created = this.backing.observations.size > before;
    if (!created) {
      return { observation, created: false, jobs: [] };
    }
    const jobs = jobKinds.map((kind) =>
      this.enqueueJob(ctx, kind, { observationId: observation.id }),
    );
    return { observation, created: true, jobs };
  }

  private enqueueJob(
    ctx: Ctx,
    kind: OutboxJobKind,
    payload: Record<string, unknown>,
  ): OutboxJobRecord {
    const job: OutboxJobMutable = {
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
    this.backing.outboxJobs.push(job);
    return job;
  }

  async createMemory(ctx: Ctx, input: NewMemory): Promise<Memory> {
    const idemKey = this.backing.extractionKey(
      ctx.tenantId,
      input.sourceObservationId ?? null,
      input.extractorVersion ?? null,
      input.contentHash,
    );
    if (input.sourceObservationId) {
      const existingId = this.backing.extractionIndex.get(idemKey);
      if (existingId) {
        const existing = this.backing.memories.get(existingId);
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
    this.backing.memories.set(memory.id, memory);
    if (input.sourceObservationId) {
      this.backing.extractionIndex.set(idemKey, memory.id);
    }
    return memory;
  }

  async createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> {
    const before = this.backing.memories.size;
    const memory = await this.createMemory(ctx, input);
    const created = this.backing.memories.size > before;
    if (!created) {
      return { memory, created: false, jobs: [] };
    }
    const jobs = jobKinds.map((kind) => this.enqueueJob(ctx, kind, { memoryId: memory.id }));
    return { memory, created: true, jobs };
  }

  async get(ctx: Ctx, id: MemoryId): Promise<Memory | null> {
    const memory = this.backing.memories.get(id);
    if (!memory || memory.tenantId !== ctx.tenantId) {
      return null;
    }
    return memory;
  }

  async getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const id of ids) {
      const memory = this.backing.memories.get(id);
      if (memory && memory.tenantId === ctx.tenantId) {
        results.push(memory);
      }
    }
    return results;
  }

  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId },
  ): Promise<Memory> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
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
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    memory.embeddingStatus = status;
    memory.updatedAt = new Date();
    return memory;
  }

  async reinforce(ctx: Ctx, id: MemoryId, at: Date): Promise<Memory> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
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
    recallId: string,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    const insertedMemoryIds: MemoryId[] = [];
    for (const memoryId of memoryIds) {
      const key = `${ctx.tenantId}:${recallId}:${memoryId}`;
      if (!this.backing.usages.has(key)) {
        this.backing.usages.add(key);
        insertedMemoryIds.push(memoryId);
      }
    }
    return { insertedMemoryIds };
  }

  async aggregateScope(ctx: Ctx, scope: RecallScope): Promise<ScopeAggregate> {
    const inScopeBySubject = new Map<string | null, number>();
    let totalInScope = 0;
    const notIndexed: Record<NotIndexedReason, number> = { pending: 0, failed: 0, skipped: 0 };
    let filteredArchived = 0;
    let filteredSuperseded = 0;
    let filteredForgotten = 0;
    let filteredPeriod = 0;

    for (const memory of this.backing.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      if (scope.subjectId !== undefined && memory.subjectId !== scope.subjectId) continue;

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
    this.backing.recalls.set(id, { ...record, tenantId: ctx.tenantId });
    return id;
  }
}

export class FakeOutboxStore implements OutboxStore {
  constructor(private readonly backing: FakeBackingStore) {}

  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    const eligible = this.backing.outboxJobs.filter(
      (job) =>
        job.tenantId === ctx.tenantId &&
        (opts.kinds === undefined || opts.kinds.includes(job.kind)) &&
        job.completedAt === null &&
        job.failedAt === null &&
        job.availableAt <= opts.now,
    );
    eligible.sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime());
    const claimed = eligible.slice(0, opts.limit);
    for (const job of claimed) {
      job.claimedAt = opts.now;
      job.claimedBy = opts.claimedBy;
      job.attempts += 1;
    }
    return claimed.map((job) => ({ ...job }));
  }

  async complete(ctx: Ctx, jobId: string): Promise<void> {
    const job = this.backing.outboxJobs.find((j) => j.id === jobId && j.tenantId === ctx.tenantId);
    if (job) {
      job.completedAt = new Date();
    }
  }

  async fail(ctx: Ctx, jobId: string, error: string): Promise<void> {
    const job = this.backing.outboxJobs.find((j) => j.id === jobId && j.tenantId === ctx.tenantId);
    if (job) {
      job.failedAt = new Date();
      job.lastError = error;
    }
  }
}

/**
 * cosine 距離（pgvector の `<=>` 演算子と同じ定義: `1 - cosine_similarity`）。
 * `packages/postgres` の `PostgresVectorStore.search` が実際に使う演算子と同じ式にする
 * ——recall のテストが「本物の pgvector とスコアの意味が違う」という食い違いを生まないため。
 */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  if (normA === 0 || normB === 0) {
    return 1; // 無関係（類似度0）として扱う。ゼロベクトル同士の割り算を避ける。
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}

/**
 * `FakeVectorStore` は `packages/core` 自身のテスト用であり `@mnemora/testkit` に依存しない
 * （このファイル冒頭のコメント参照）。recall のテストが意味のある結果を得られるよう、
 * `upsert` されたベクトルに対して実際に cosine 距離で ANN を模する
 * （`FakeBackingStore.memories` を参照して `status` フィルタも本物同様に適用する）。
 */
export class FakeVectorStore implements VectorStore {
  entries = new Map<string, { tenantId: string; memoryId: MemoryId; vector: number[] }>();

  constructor(private readonly backing?: FakeBackingStore) {}

  private key(space: EmbeddingSpaceId, tenantId: string, memoryId: MemoryId): string {
    return `${space.provider}:${space.model}:${space.dimensions}:${tenantId}:${memoryId}`;
  }

  async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
    this.entries.set(this.key(space, ctx.tenantId, memoryId), {
      tenantId: ctx.tenantId,
      memoryId,
      vector,
    });
  }

  async search(
    ctx: Ctx,
    _space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    const hits: VectorHit[] = [];
    for (const entry of this.entries.values()) {
      if (entry.tenantId !== opts.filter.tenantId || entry.tenantId !== ctx.tenantId) continue;
      if (opts.filter.status !== undefined && this.backing) {
        const memory = this.backing.memories.get(entry.memoryId);
        if (!memory || !opts.filter.status.includes(memory.status)) continue;
      }
      if (opts.filter.decayFloorAtAfter !== undefined && this.backing) {
        const memory = this.backing.memories.get(entry.memoryId);
        if (!memory || memory.decayFloorAt <= opts.filter.decayFloorAtAfter) continue;
      }
      hits.push({ memoryId: entry.memoryId, distance: cosineDistance(query, entry.vector) });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits.slice(0, opts.limit);
  }

  async delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void> {
    this.entries.delete(this.key(space, ctx.tenantId, memoryId));
  }
}

export class FakeEventStore implements EventStore {
  events: MemoryEvent[] = [];

  async append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent> {
    const stored: MemoryEvent = {
      id: nextId("evt"),
      tenantId: ctx.tenantId,
      memoryId: event.memoryId,
      kind: event.kind,
      at: event.at ?? new Date(),
      actor: event.actor,
      digestSnapshot: event.digestSnapshot ?? null,
      sizeBeforeBytes: event.sizeBeforeBytes ?? null,
      meta: event.meta,
    };
    this.events.push(stored);
    return stored;
  }

  async get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null> {
    return this.events.find((e) => e.id === id && e.tenantId === ctx.tenantId) ?? null;
  }

  async list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]> {
    return this.events.filter((e) => {
      if (e.tenantId !== ctx.tenantId) return false;
      if (filter.memoryId !== undefined && e.memoryId !== filter.memoryId) return false;
      if (filter.kind !== undefined && e.kind !== filter.kind) return false;
      return true;
    });
  }
}

export class FakeTenantSettingsStore implements TenantSettingsStore {
  constructor(private readonly halfLifeHours = 720) {}

  async getDefaultHalfLifeHours(_ctx: Ctx): Promise<number> {
    return this.halfLifeHours;
  }
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId = { provider: "fake", model: "fake-model", dimensions: 2 };
  shouldFail = false;

  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    if (this.shouldFail) {
      throw new Error("simulated embedding provider failure");
    }
    // 決定的: 文字列長から機械的にベクトルを作る。
    return texts.map((text) => [text.length, [...text].filter((c) => c === "a").length]);
  }
}

export function createFakeRuntimeStores(): {
  memoryStore: FakeMemoryStore;
  outboxStore: FakeOutboxStore;
  vectorStore: FakeVectorStore;
  eventStore: FakeEventStore;
  tenantSettingsStore: FakeTenantSettingsStore;
  embeddingProvider: FakeEmbeddingProvider;
} {
  const backing = new FakeBackingStore();
  return {
    memoryStore: new FakeMemoryStore(backing),
    outboxStore: new FakeOutboxStore(backing),
    vectorStore: new FakeVectorStore(backing),
    eventStore: new FakeEventStore(),
    tenantSettingsStore: new FakeTenantSettingsStore(),
    embeddingProvider: new FakeEmbeddingProvider(),
  };
}
