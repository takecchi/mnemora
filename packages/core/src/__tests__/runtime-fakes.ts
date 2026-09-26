import type { ClaimKey } from "../claim-key.js";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import type { EventStore } from "../interfaces/event-store.js";
import { OutboxLeaseConflictError } from "../interfaces/outbox-store.js";
import type { ClaimOutboxJobsOptions, OutboxStore } from "../interfaces/outbox-store.js";
import type { OutboxJobKind } from "../interfaces/scheduler.js";
import {
  assertValidDecayClock,
  assertValidEventRetentionDays,
  assertValidHalfLifeRecalls,
  assertValidTaxonomyMode,
  DEFAULT_DECAY_CLOCK,
  DEFAULT_HALF_LIFE_RECALLS,
  DEFAULT_TAXONOMY_MODE,
} from "../interfaces/tenant-settings-store.js";
import type {
  DecayClock,
  EventRetention,
  EventRetentionSetting,
  TaxonomyMode,
  TenantSettingsStore,
} from "../interfaces/tenant-settings-store.js";
import type { VectorStore, VectorFilter, VectorHit } from "../interfaces/vector-store.js";
import type { LexicalStore, LexicalFilter, LexicalHit } from "../interfaces/lexical-store.js";
import type { NotIndexedReason } from "../recall.js";
import type { MemoryId, ObservationId, RecallId } from "../ids.js";
import { isStrengthInRange, MAX_STRENGTH } from "../memory.js";
import type { EmbeddingStatus, Memory, MemoryStatus, NewMemory } from "../memory.js";
import type { NewObservation, Observation } from "../observation.js";
import type { EventActor, MemoryEvent, NewMemoryEvent, EventFilter } from "../event.js";
import type { EventId } from "../ids.js";
import {
  isEmbeddingStatusRollback,
  MemoryPurgeConflictError,
  MemoryStatusConflictError,
} from "../interfaces/memory-store.js";
import type {
  AggregateScopeOptions,
  ArchiveDecayedOptions,
  ArchiveDecayedResult,
  LabelSummary,
  MemoryStore,
  PurgeExpiredEventsOptions,
  PurgeExpiredEventsResult,
  ReinforceOptions,
  RequeueEmbedJobsOptions,
  RequeueEmbedJobsResult,
} from "../interfaces/memory-store.js";
import type { NewRecallRecord, RecallRecord, RecallScope, ScopeAggregate } from "../recall.js";
import type { EmbeddingSpaceId } from "../embedding.js";
import type { OutboxJobRecord } from "../outbox.js";
import { defaultActivityDecayStrategy, defaultDecayStrategy } from "../strategies/decay.js";
import { resolveIdempotentCreate } from "../idempotent-create.js";
import type { IdempotentCreateResult } from "../idempotent-create.js";

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

/**
 * `NewMemoryEvent` から永続化済みの `MemoryEvent` を組み立てる。`FakeEventStore.append`
 * と `FakeMemoryStore.updateStatusWithEvent`（ADR 0031）の両方がこれを使う
 * ——`packages/testkit` の `buildStoredMemoryEvent`（`in-memory-event-store.ts`）と
 * 同じ形だが、ファイル冒頭のコメントの通り意図的に独立している。
 */
function buildStoredEvent(ctx: Ctx, event: NewMemoryEvent): MemoryEvent {
  return {
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
}

class FakeBackingStore {
  observations = new Map<string, Observation>();
  memories = new Map<string, Memory>();
  extractionIndex = new Map<string, MemoryId>();
  usages = new Set<string>();
  recalls = new Map<string, NewRecallRecord & { tenantId: string; createdAt: Date }>();
  outboxJobs: OutboxJobMutable[] = [];
  /**
   * ADR 0031: `FakeMemoryStore.updateStatusWithEvent` と `FakeEventStore` が共有する
   * memory_events 相当の配列。以前は `FakeEventStore` が独立した配列を持っており
   * `FakeBackingStore` に載っていなかった——`outboxJobs` と同じ「同一トランザクションで
   * 書く2つの書き込み先を共有する」という形に揃えた。
   */
  events: MemoryEvent[] = [];
  /**
   * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと2・5:
   * `tenant_activity.activity_seq` 相当。`FakeMemoryStore.createRecall` と
   * `FakeTenantSettingsStore.getActivitySeq` が同じ `FakeBackingStore` を共有することで、
   * 本番の「`MemoryStore` と `TenantSettingsStore` は別 adapter だが、`activity_seq` は
   * `createRecall` と同一トランザクションで進む」という契約を、フェイクの世界でも
   * 「書く側（`createRecall`）と読む側（`getActivitySeq`）が同じ値を見る」という
   * 観測可能な形で再現する。
   */
  activitySeq = new Map<string, number>();
  /**
   * Issue #201 PR-B（[ADR 0323](../../../docs/decisions/0323-taxonomy-recall-filter.md)）:
   * `labels` 相当。`packages/testkit` の `InMemoryMemoryStore` と同じ key 形式
   * （`${tenantId}::${name}`）——`recall-taxonomy-filter.test.ts` が `listLabels`/
   * `registerLabel` 経由でここを操作する。
   */
  labels = new Map<string, LabelSummary>();

  extractionKey(
    tenantId: string,
    sourceObservationId: string | null,
    extractorVersion: string | null,
    contentHash: string,
  ): string {
    return `${tenantId}:${sourceObservationId ?? ""}:${extractorVersion ?? ""}:${contentHash}`;
  }
}

/**
 * ⭐ Issue #329 / [ADR 0173](../../../../docs/decisions/0173-decayed-omission-counted-by-aggregate-scope.md):
 * `aggregateScope` が `filteredDecayed` を数えるための述語。
 *
 * **`recall-runtime.ts` の `survivesDecayGate`（段1の押し下げ・後置フィルタの両方が使う
 * もの）の否定**であり、`PostgresMemoryStore.aggregateScope` の `isDecayed`（SQL）と
 * 同じものでなければならない。`period`/`validAt` と同じ「4箇所の複製」の5つ目である
 * ——**この一致そのものを、適合テストと `recall-decay-cross-day.postgres.test.ts` が検算する。**
 *
 * - 壁時計の軸が生きている: `decayFloorAt > decayFloorAtAfter`（狭義の `>`）
 * - 活動時計の軸が生きている: `decayFloorSeq` が無い（この軸に床が無い、ADR 0165 決めたこと4）
 *   か `decayFloorSeq > decayFloorSeqAfter`
 * - `decayFloorAnyAxis`（`decay_clock: 'either'`）: 2軸の **OR**（最も緩い）
 * - 軸が1本も渡されていない（ゲート無効）: 常に `false`（0件と数える）
 */
function isDecayedForScope(
  memory: Pick<Memory, "decayFloorAt" | "decayFloorSeq">,
  scope: RecallScope,
): boolean {
  const { decayFloorAtAfter, decayFloorSeqAfter } = scope;
  if (decayFloorAtAfter === undefined && decayFloorSeqAfter === undefined) return false;
  const wallAlive =
    decayFloorAtAfter === undefined ? undefined : memory.decayFloorAt > decayFloorAtAfter;
  const activityAlive =
    decayFloorSeqAfter === undefined
      ? undefined
      : memory.decayFloorSeq === undefined ||
        memory.decayFloorSeq === null ||
        memory.decayFloorSeq > decayFloorSeqAfter;
  if (scope.decayFloorAnyAxis === true && wallAlive !== undefined && activityAlive !== undefined) {
    return !(wallAlive || activityAlive);
  }
  if (wallAlive !== undefined && activityAlive !== undefined) return !(wallAlive && activityAlive);
  if (wallAlive !== undefined) return !wallAlive;
  return !activityAlive;
}

export class FakeMemoryStore implements MemoryStore {
  constructor(private readonly backing: FakeBackingStore) {}

  /**
   * ADR 0054: 判定と挿入を1つの同期区間に閉じ、`created` をその判定そのものから出す
   * （`InMemoryMemoryStore.createObservationIdempotent` と同じ形・同じ理由）。
   */
  private createObservationIdempotent(
    ctx: Ctx,
    input: NewObservation,
  ): IdempotentCreateResult<Observation> {
    const existing = input.externalId
      ? [...this.backing.observations.values()].find(
          (o) => o.tenantId === ctx.tenantId && o.externalId === input.externalId,
        )
      : undefined;
    return resolveIdempotentCreate(existing, () => {
      const observation: Observation = {
        id: nextId("obs"),
        tenantId: ctx.tenantId,
        subjectId: input.subjectId ?? null,
        externalId: input.externalId ?? null,
        kind: input.kind,
        payload: input.payload,
        occurredAt: input.occurredAt ?? null,
        recordedAt: input.recordedAt ?? new Date(),
        // Issue #280: `occurredAt` と同じ経路。
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        // Issue #152（ADR 0312）: 同じ経路。runtime は常に `{}` 以上の値を書く。
        attributes: input.attributes ?? {},
      };
      this.backing.observations.set(observation.id, observation);
      return observation;
    });
  }

  async createObservation(ctx: Ctx, input: NewObservation): Promise<Observation> {
    return this.createObservationIdempotent(ctx, input).value;
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
    const { value: observation, created } = this.createObservationIdempotent(ctx, input);
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

  /**
   * ADR 0054: 冪等キーの判定と挿入を1つの同期区間に閉じる
   * （`InMemoryMemoryStore.createMemoryIdempotent` と同じ形・同じ理由）。
   *
   * Issue #768（調査時、`packages/testkit` の `describeMemoryStoreConformance` へ
   * この Fake を一時的に通して実測——その通し方自体は採らず、PR には載せていない。
   * 見つけた食い違いのうち Fake 側のバグだった7件を、下の doc と同じ形で
   * `fake-*.test.ts` の専用テストとして固定している）: ADR 0078 の値域検査
   * （{@link isStrengthInRange}）を、`InMemoryMemoryStore` と同じ位置（冪等衝突の判定
   * より前／何も書く前）に持つ。既存の `packages/core` テストで無効な `strength` を
   * 使うものは無い（実測: 全テストファイルを通して実行して確認）。
   *
   * ⚠ **ADR 0140 の `ContestedWithoutCompanionError` 相当のガードと、ADR 0125 の
   * `halfLifeHours` 値域検査は、意図して持たない。**
   *
   * - ADR 0140 決定2が明記するとおり、`FakeMemoryStore` はこのガードの対象外
   *   ——`packages/core` 自身の単体テスト（`recall-pipeline.test.ts` 等）が ADR 0136
   *   の読み取り側の防御（対向未解決の `contested` は単位を組まない）を検査するには、
   *   まさにこのガードが塞ごうとする壊れた状態（`contestedWithId` 無しの `contested`）
   *   を `FakeMemoryStore` 経由で構成できる必要がある。ガードを足すとそれらの
   *   回帰テストが構造的に書けなくなる（Issue #768 の調査で実測: 19件の既存テストが
   *   赤くなった。`recall-pipeline.test.ts` ×12 など。下の `halfLifeHours` 側の2件とは
   *   別枠——合わせて21件が Issue #768 のコメントに載っている）。詳細は ADR 0140
   *   「決定2」「開いている穴1」「これが覆るとしたら」。
   * - ADR 0125「引き受ける負債」節が同じ形で明記するとおり、`FakeMemoryStore` には
   *   `halfLifeHours` の値域検査も元から無い。`recall-pipeline.test.ts`
   *   （score_not_comparable の三分割、ADR 0153）が `halfLifeHours: 0` の「壊れた」
   *   Memory を意図的に作り、scoring 側の NaN 処理の防御を検査している——検査を足すと
   *   この2件の回帰テストが書けなくなる（Issue #768 の調査で実測）。
   */
  private createMemoryIdempotent(ctx: Ctx, input: NewMemory): IdempotentCreateResult<Memory> {
    const idemKey = this.backing.extractionKey(
      ctx.tenantId,
      input.sourceObservationId ?? null,
      input.extractorVersion ?? null,
      input.contentHash,
    );
    const existingId = input.sourceObservationId
      ? this.backing.extractionIndex.get(idemKey)
      : undefined;
    const existing = existingId !== undefined ? this.backing.memories.get(existingId) : undefined;

    return resolveIdempotentCreate(existing, () => {
      // 外部キー相当（ADR 0047、`packages/testkit` の `InMemoryMemoryStore.createMemory` と
      // 同じ理由・同じ検査）: `sourceObservationId`/`supersededById`/`contestedWithId` は
      // 非 null なら実在する行を指さなければならない。**「存在」だけを見る**——一対一等の
      // 整合まではここでは踏み込まない。
      if (input.sourceObservationId && !this.backing.observations.has(input.sourceObservationId)) {
        throw new Error(
          `FakeMemoryStore: source observation not found: ${input.sourceObservationId}`,
        );
      }
      if (input.supersededById && !this.backing.memories.has(input.supersededById)) {
        throw new Error(`FakeMemoryStore: superseded-by memory not found: ${input.supersededById}`);
      }
      if (input.contestedWithId && !this.backing.memories.has(input.contestedWithId)) {
        throw new Error(
          `FakeMemoryStore: contested-with memory not found: ${input.contestedWithId}`,
        );
      }
      // 値域（ADR 0078）: `InMemoryMemoryStore.createMemoryIdempotent` と同じ位置・
      // 同じ理由——ここで放置すると「本番（Postgres の CHECK 制約）では落ちる書き込みが
      // 手元では黙って成功する」。`halfLifeHours`（ADR 0125）を検査しない理由は、この
      // メソッドの doc コメント参照。
      if (!isStrengthInRange(input.strength)) {
        throw new Error(
          `FakeMemoryStore: strength out of range (0, ${MAX_STRENGTH}]: ${input.strength}`,
        );
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
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        // Issue #371（ADR 0185/ADR 0315）: `InMemoryMemoryStore`（packages/testkit）と
        // 同じ理由・同じ形——`?? null` で転記しないと `undefined` のまま消える。
        claimKey: input.claimKey ?? null,
        strength: input.strength,
        halfLifeHours: input.halfLifeHours,
        decayFloorAt: input.decayFloorAt,
        // ADR 0165 決めたこと3: 活動時計の3つ組。以前はここで1つも転記しておらず、
        // `createMemory` で渡した `decayBaseSeq`/`decayFloorSeq`/`halfLifeRecalls` が
        // 常に `undefined` になって消えていた——`recall-decay-gate.test.ts` の
        // 活動時計の歯を書く過程で実測した(すべて `undefined` に化けるため
        // `activityAxisAlive` が「この軸に床が無い」と誤認して常に生存判定していた)。
        decayBaseSeq: input.decayBaseSeq ?? null,
        decayFloorSeq: input.decayFloorSeq ?? null,
        halfLifeRecalls: input.halfLifeRecalls ?? null,
        embeddingStatus: input.embeddingStatus,
        purgedAt: input.purgedAt ?? null,
        // Issue #152/#153（ADR 0312）: runtime は常に `{}` 以上の値を書く。
        attributes: input.attributes ?? {},
        createdAt: now,
        updatedAt: now,
      };
      this.backing.memories.set(memory.id, memory);
      if (input.sourceObservationId) {
        this.backing.extractionIndex.set(idemKey, memory.id);
      }
      // Issue #201 PR-B（ADR 0323）: `packages/testkit` の `InMemoryMemoryStore` と同じ
      // 契機——新しい行を実際に作ったときだけ `tags` から `proposed` ラベルを作る。
      this.upsertProposedLabels(ctx, memory.tags);
      return memory;
    });
  }

  private labelKey(tenantId: string, name: string): string {
    return `${tenantId}::${name}`;
  }

  /**
   * Issue #201 PR-B（[ADR 0323](../../../docs/decisions/0323-taxonomy-recall-filter.md)）:
   * `packages/testkit` の `InMemoryMemoryStore.upsertProposedLabels` と同じ意味論。
   */
  private upsertProposedLabels(ctx: Ctx, tags: readonly string[]): void {
    const uniqueNames = Array.from(new Set(tags));
    for (const name of uniqueNames) {
      const key = this.labelKey(ctx.tenantId, name);
      const existing = this.backing.labels.get(key);
      if (existing === undefined) {
        this.backing.labels.set(key, {
          name,
          status: "proposed",
          proposedCount: 1,
          registeredAt: null,
        });
        continue;
      }
      if (existing.status === "proposed") {
        this.backing.labels.set(key, { ...existing, proposedCount: existing.proposedCount + 1 });
      }
    }
  }

  /**
   * Issue #201 PR-B（ADR 0323）: `listLabels?`（`InMemoryMemoryStore.listLabels` と同じ契約）。
   */
  async listLabels(ctx: Ctx): Promise<LabelSummary[]> {
    const results: LabelSummary[] = [];
    const prefix = `${ctx.tenantId}::`;
    for (const [key, label] of this.backing.labels) {
      if (key.startsWith(prefix)) {
        results.push(label);
      }
    }
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
  }

  /**
   * Issue #201 PR-B（ADR 0323）: `registerLabel?`（`InMemoryMemoryStore.registerLabel` と
   * 同じ契約）。
   */
  async registerLabel(ctx: Ctx, name: string): Promise<LabelSummary> {
    const key = this.labelKey(ctx.tenantId, name);
    const existing = this.backing.labels.get(key);
    const registered: LabelSummary = {
      name,
      status: "registered",
      proposedCount: existing?.proposedCount ?? 0,
      registeredAt: existing?.registeredAt ?? new Date(),
    };
    this.backing.labels.set(key, registered);
    return registered;
  }

  async createMemory(ctx: Ctx, input: NewMemory): Promise<Memory> {
    return this.createMemoryIdempotent(ctx, input).value;
  }

  async createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> {
    const { value: memory, created } = this.createMemoryIdempotent(ctx, input);
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
    // `PostgresMemoryStore.getMany` は `WHERE id = ANY(...)` という集合演算で引くため
    // （実測）、同じ id が `ids` に複数回含まれていても一致する行は主キーの性質上1回しか
    // 無い。ここで検査せず単純にループで push すると同じ Memory を重複して返してしまう
    // ——`InMemoryMemoryStore.getMany`（`packages/testkit`、PR #806/#812）と同じ形の
    // 不一致（`fake-store-postgres-parity.test.ts` が歯）。`seen` で2回目以降を
    // スキップし、Postgres の集合演算と同じ「一意な id の集合」に揃える。
    const seen = new Set<MemoryId>();
    const results: Memory[] = [];
    for (const id of ids) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const memory = this.backing.memories.get(id);
      if (memory && memory.tenantId === ctx.tenantId) {
        results.push(memory);
      }
    }
    return results;
  }

  /** ADR 0028: `runtime.reextract` が既存 Memory を判定するための列挙（**SELECT のみ**）。 */
  async listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]> {
    const results: Memory[] = [];
    for (const memory of this.backing.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      if (memory.sourceObservationId !== observationId) continue;
      if ((memory.extractorVersion ?? null) !== (extractorVersion ?? null)) continue;
      results.push(memory);
    }
    return results;
  }

  /**
   * ADR 0030: `opts.expectedStatus` があるときだけ compare-and-swap にする
   * （postgres 実装・testkit の in-memory 実装と同じ意味論）。
   *
   * `beforeUpdateStatus`（テスト専用のフック）は CAS 判定の**直前**に呼ぶ——
   * `reextract` の TOCTOU（読んでから書くまでの間に別の書き込みが割り込む）を
   * 決定的に再現するための差し込み口。本番相当の実装には存在しない、このフェイク限りの機構。
   * ADR 0031 で追加した `updateStatusWithEvent` も、`reextract` が実際に呼ぶ経路として
   * 同じ位置（CAS 判定の直前）でこのフックを発火する——さもないと PR #28 が
   * このフックで決定的に再現している TOCTOU の歯が、`reextract` が `updateStatus` を
   * 呼ばなくなった時点で意味を失う。
   */
  beforeUpdateStatus?: (id: MemoryId) => void;

  async updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
  ): Promise<Memory> {
    // ⚠ Issue #768: ADR 0140 の `status: 'contested'` ガードは、この Fake には意図して
    // 持たない（`createMemoryIdempotent` の doc コメント参照——ADR 0140 決定2）。
    this.beforeUpdateStatus?.(id);
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    if (opts?.expectedStatus !== undefined && memory.status !== opts.expectedStatus) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    // 外部キー相当（ADR 0047）: `supersededById` を渡すなら実在する Memory を指さなければ
    // ならない。
    if (opts?.supersededById !== undefined && !this.backing.memories.has(opts.supersededById)) {
      throw new Error(`FakeMemoryStore: superseded-by memory not found: ${opts.supersededById}`);
    }
    memory.status = status;
    if (opts?.supersededById !== undefined) {
      memory.supersededById = opts.supersededById;
    }
    memory.updatedAt = new Date();
    return memory;
  }

  /**
   * ADR 0031: `updateStatus` と同じ CAS 判定のあと、通ったときだけイベントも積む。
   * `reextract` の supersede ループは、以前の「`updateStatus` を呼んでから
   * 別途 `eventStore.append` を呼ぶ」という2コミットの形をやめてこちらを呼ぶ
   * （`packages/core/src/runtime.ts`）——`beforeUpdateStatus` はここでも CAS 判定の
   * 直前に発火するため、PR #28 の TOCTOU の歯はそのまま生きる。
   */
  async updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    // ⚠ Issue #768: updateStatus と同じ理由——ADR 0140 のガードは意図して持たない。
    this.beforeUpdateStatus?.(id);
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    if (opts.expectedStatus !== undefined && memory.status !== opts.expectedStatus) {
      throw new MemoryStatusConflictError(id, opts.expectedStatus, memory.status);
    }
    // 外部キー相当（ADR 0047）: updateStatus と同じ理由・同じ検査。
    if (opts.supersededById !== undefined && !this.backing.memories.has(opts.supersededById)) {
      throw new Error(`FakeMemoryStore: superseded-by memory not found: ${opts.supersededById}`);
    }
    memory.status = status;
    if (opts.supersededById !== undefined) {
      memory.supersededById = opts.supersededById;
    }
    memory.updatedAt = new Date();
    const storedEvent = buildStoredEvent(ctx, event);
    this.backing.events.push(storedEvent);
    return { memory, event: storedEvent };
  }

  /**
   * Issue #134 / ADR 0100: `news`（新規 Memory の作成、複数可）と `supersede`（既存 Memory の
   * supersede、複数可）を1回の呼び出しにまとめる——`packages/testkit` の
   * `InMemoryMemoryStore.supersedeWithNewMemories` と同じ形だが、ファイル冒頭のコメントの
   * 通り意図的に独立している（`backing` を共有する既存の形に揃えただけ）。
   *
   * `beforeUpdateStatus` は `supersede` の各要素についても CAS 判定の直前に発火する
   * ——`updateStatus`/`updateStatusWithEvent` と同じ位置。この口を経由しても
   * TOCTOU 再現のフックが死なないようにする（ADR 0031 決定8 と同じ理由）。
   *
   * 事前検証（`supersede[].id`/`supersededById` の存在）を `news`/`supersede` のどちらにも
   * 書き込む前にすべて済ませることで、in-memory の「ロールバック」を模す
   * （`InMemoryMemoryStore.supersedeWithNewMemories` と同じ作法）。
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
    // 1. 事前検証——まだ何も書いていないうちに投げる。⛔ 3種類の失敗を潰さない（ADR 0100）。
    for (const target of supersede) {
      if (
        !Number.isInteger(target.supersededByIndex) ||
        target.supersededByIndex < 0 ||
        target.supersededByIndex >= news.length
      ) {
        throw new RangeError(
          `FakeMemoryStore: supersededByIndex out of range: ${target.supersededByIndex} (news.length=${news.length})`,
        );
      }
      const memory = this.backing.memories.get(target.id);
      if (!memory || memory.tenantId !== ctx.tenantId) {
        throw new Error(`FakeMemoryStore: memory not found for tenant: ${target.id}`);
      }
    }
    // ⚠ Issue #768: `InMemoryMemoryStore.supersedeWithNewMemories` は news 側にも
    // ADR 0140 の制約を課すが、この Fake は意図して課さない（`createMemoryIdempotent`
    // の doc コメント参照）。

    // 2. news を作る（`createMemoryWithOutbox` と同じ経路）。
    const created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }> = [];
    for (const { input, jobKinds } of news) {
      const { value: memory, created: wasCreated } = this.createMemoryIdempotent(ctx, input);
      if (!wasCreated) {
        created.push({ memory, created: false, jobs: [] });
        continue;
      }
      const jobs = jobKinds.map((kind) => this.enqueueJob(ctx, kind, { memoryId: memory.id }));
      created.push({ memory, created: true, jobs });
    }

    // 3. supersede を1件ずつ CAS で処理する。弾かれても conflicted に積んで続行する。
    const superseded: MemoryEvent[] = [];
    const conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }> = [];
    for (const target of supersede) {
      this.beforeUpdateStatus?.(target.id);
      const memory = this.backing.memories.get(target.id)!;
      if (target.expectedStatus !== undefined && memory.status !== target.expectedStatus) {
        conflicted.push({ id: target.id, observedStatus: memory.status });
        continue;
      }
      memory.status = "superseded";
      const anchorId = created[target.supersededByIndex]!.memory.id;
      memory.supersededById = anchorId;
      memory.updatedAt = new Date();
      // `meta.supersededById` は解決した id で埋める（interface の契約）。
      const storedEvent = buildStoredEvent(ctx, {
        ...target.event,
        meta: { ...target.event.meta, supersededById: anchorId },
      });
      this.backing.events.push(storedEvent);
      superseded.push(storedEvent);
    }

    return { created, superseded, conflicted };
  }

  /**
   * Issue #210 / ADR 0115: `InMemoryMemoryStore.purgeExpiredEvents`（`packages/testkit`）と
   * 同じ意味論。`backing.events` を直接操作し、`FakeEventStore` のメソッドは一切呼ばない
   * ——append-only の型に触れない、という契約を Fake 側でも保つ。
   */
  async purgeExpiredEvents(
    ctx: Ctx,
    opts: PurgeExpiredEventsOptions,
  ): Promise<PurgeExpiredEventsResult> {
    // `PostgresMemoryStore.purgeExpiredEvents` は `opts.limit`（+1件）を生 SQL の
    // `LIMIT`（bigint パラメータ）にそのまま渡すため、負数・`NaN`・`Infinity`・非整数は
    // 例外になる（実測）。ここで検査せず `candidates.slice(0, opts.limit)` へ渡すと
    // `Array.prototype.slice` の意味論を踏んで誤った件数を削除してしまう——
    // `InMemoryMemoryStore.purgeExpiredEvents`（`packages/testkit`、PR #804/#811）と
    // 同じ形の不一致（`fake-store-postgres-parity.test.ts` が歯）。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`purgeExpiredEvents: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`purgeExpiredEvents: limit must not be negative (got ${opts.limit})`);
    }
    const dryRun = opts.dryRun ?? false;
    const candidates = this.backing.events
      .filter(
        (event) =>
          event.tenantId === ctx.tenantId &&
          event.kind !== "events_purged" &&
          event.at.getTime() < opts.olderThan.getTime(),
      )
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    const reachedLimit = candidates.length > opts.limit;
    const victims = candidates.slice(0, opts.limit);
    const purged = victims.length;
    const oldestPurgedAt = purged > 0 ? victims[0]!.at : null;
    const newestPurgedAt = purged > 0 ? victims[purged - 1]!.at : null;

    if (dryRun || purged === 0) {
      return { purged, reachedLimit, oldestPurgedAt, newestPurgedAt, dryRun };
    }

    const victimIds = new Set(victims.map((event) => event.id));
    for (let i = this.backing.events.length - 1; i >= 0; i--) {
      if (victimIds.has(this.backing.events[i]!.id)) {
        this.backing.events.splice(i, 1);
      }
    }

    const storedEvent = buildStoredEvent(ctx, {
      tenantId: ctx.tenantId,
      memoryId: null,
      kind: "events_purged",
      actor: { type: "system" },
      meta: { purgedCount: purged, oldestPurgedAt, newestPurgedAt, olderThan: opts.olderThan },
    });
    this.backing.events.push(storedEvent);

    return { purged, reachedLimit, oldestPurgedAt, newestPurgedAt, dryRun };
  }

  /**
   * ADR 0053: `ready` を `failed` へ巻き戻さない。
   * `InMemoryMemoryStore.setEmbeddingStatus`（`packages/testkit`）と同じ意味論・
   * 同じ理由——禁じる遷移の判定は共有の {@link isEmbeddingStatusRollback} に固定し、
   * 実装ごとに条件式を書き直さない。巻き戻しは**例外にせず** no-op のまま現在の行を返す
   * （`runtime.tick` の `catch` の中が唯一の `failed` の呼び出し口であり、そこで投げると
   * 元の埋め込みエラーが握り潰される。ADR 0048 の `reinforce` と同じ理由の形）。
   * `failed → ready` は妨げない（片側だけの規則）。
   */
  async setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    if (isEmbeddingStatusRollback(memory.embeddingStatus, status)) {
      // no-op: 何も書かない。返すのは現在の（更新されなかった）行そのもの。
      return memory;
    }
    memory.embeddingStatus = status;
    memory.updatedAt = new Date();
    return memory;
  }

  /**
   * ADR 0048（Postgres）/ ADR 0049（本 fake）: 減衰の起点を巻き戻さない。
   * `InMemoryMemoryStore.reinforce`（`packages/testkit`）と同じ意味論・同じ理由
   * ——狭義の `<`（同じ `at` は no-op）で `lastReinforcedAt`/`decayFloorAt` を
   * 同じ条件でまとめて動かす。古い `at` は例外にせず、no-op のまま現在の行を返す。
   */
  async reinforce(ctx: Ctx, id: MemoryId, at: Date, opts?: ReinforceOptions): Promise<Memory> {
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    if (
      memory.lastReinforcedAt !== null &&
      memory.lastReinforcedAt !== undefined &&
      memory.lastReinforcedAt.getTime() >= at.getTime()
    ) {
      return memory;
    }
    memory.lastReinforcedAt = at;
    memory.decayFloorAt = defaultDecayStrategy.floorAt({
      recordedAt: memory.recordedAt,
      lastReinforcedAt: memory.lastReinforcedAt,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });
    // [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと16
    // （Issue #768 で実測して足した）: `opts.nowSeq` が渡され、かつこの Memory が
    // `halfLifeRecalls` を持つときに限り、活動時計側の起点・床も同じ強化イベントとして
    // 進める。`InMemoryMemoryStore.reinforce`/`PostgresMemoryStore.reinforce` と同じ分岐
    // ——壁時計側の「等しい/古い at は no-op」の分岐（上）を通り抜けたあとでだけ動かす
    // ことで、Issue #730 の「同じ at の2回目は活動時計側も動かさない」を1バイトも
    // 変えずに保つ。
    if (opts?.nowSeq !== undefined && memory.halfLifeRecalls != null) {
      memory.decayBaseSeq = opts.nowSeq;
      memory.decayFloorSeq = defaultActivityDecayStrategy.floorAt({
        baseSeq: opts.nowSeq,
        strength: memory.strength,
        halfLifeRecalls: memory.halfLifeRecalls,
      });
    }
    memory.updatedAt = new Date();
    return memory;
  }

  async recordUsage(
    ctx: Ctx,
    recallId: string,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }> {
    // 外部キー相当（ADR 0047、`packages/testkit` の `InMemoryMemoryStore.recordUsage` と
    // 同じ理由・同じ検査）: `recall_usages.recall_id → recalls(id)` /
    // `recall_usages.memory_id → memories(id)`。`memoryIds` が空配列なら Postgres 実装は
    // クエリを一切発行せず即座に空の結果を返す（`recallId` の実在は問われない）ため、
    // その早期リターンより後ろで検査する。
    if (memoryIds.length === 0) {
      return { insertedMemoryIds: [] };
    }
    if (!this.backing.recalls.has(recallId)) {
      throw new Error(`FakeMemoryStore: recall not found: ${recallId}`);
    }
    for (const memoryId of memoryIds) {
      if (!this.backing.memories.has(memoryId)) {
        throw new Error(`FakeMemoryStore: memory not found: ${memoryId}`);
      }
    }

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

  async aggregateScope(
    ctx: Ctx,
    scope: RecallScope,
    opts?: AggregateScopeOptions,
  ): Promise<ScopeAggregate> {
    const inScopeBySubject = new Map<string | null, number>();
    let totalInScope = 0;
    const notIndexed: Record<NotIndexedReason, number> = { pending: 0, failed: 0, skipped: 0 };
    let filteredArchived = 0;
    let filteredSuperseded = 0;
    let filteredForgotten = 0;
    let filteredPeriod = 0;
    let filteredExpired = 0;
    let filteredNotYetValid = 0;
    let filteredTaxonomy = 0;
    let filteredDecayed = 0;
    // 目次帯の候補（本 PR）: totalInScope に数える条件と**同じ条件**で in-scope の
    // Memory を集める。`digestBand` が要求されなかった場合はこの配列を使わない。
    const inScopeMemories: Memory[] = [];

    for (const memory of this.backing.memories.values()) {
      if (memory.tenantId !== ctx.tenantId) continue;
      // Issue #608 項目③(b) / ADR 0286（Issue #768 で実測して足した）:
      // `InMemoryMemoryStore.aggregateScope`/`PostgresMemoryStore.aggregateScope` と
      // 同じ意味論——`includeSubjectless: true` のときだけ `subjectId === null`
      // （主題なし）も scope 内に含める。
      const subjectMatches =
        scope.subjectId === undefined ||
        memory.subjectId === scope.subjectId ||
        (scope.includeSubjectless === true && memory.subjectId === null);
      if (!subjectMatches) continue;
      // Issue #152/#153（ADR 0312）: `attributes` も `subjectId` と同じくスコープの外側の
      // 境界——落ちた分は `filtered*` のどの列にも数えず、`totalInScope` にも入れない
      // （`recall.ts` の `ScopeAggregate` doc「2026-09 追記」参照）。
      if (scope.attributes !== undefined) {
        const memoryAttributes = memory.attributes ?? {};
        const matches = Object.entries(scope.attributes).every(
          ([key, value]) => memoryAttributes[key] === value,
        );
        if (!matches) continue;
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

      const effectiveTime = memory.occurredAt ?? memory.recordedAt;
      const inPeriod =
        (scope.occurredAfter === undefined || effectiveTime >= scope.occurredAfter) &&
        (scope.occurredBefore === undefined || effectiveTime <= scope.occurredBefore);
      if (!inPeriod) {
        filteredPeriod += 1;
        continue;
      }
      // Issue #280（Issue #202 第2弾）: validAt ゲート。`InMemoryMemoryStore`
      // （`packages/testkit`）と同じ意味論（独立した2条件として数える）。
      if (scope.validAt !== undefined) {
        const isNotYetValid = memory.validFrom != null && memory.validFrom > scope.validAt;
        const isExpired = memory.validUntil != null && memory.validUntil <= scope.validAt;
        if (isNotYetValid) {
          filteredNotYetValid += 1;
        }
        if (isExpired) {
          filteredExpired += 1;
        }
        if (isNotYetValid || isExpired) {
          continue;
        }
      }
      // Issue #201 PR-B（ADR 0323）: taxonomy ゲート。`attributes`（上）とは違い
      // `period`/`validity` と同じ側——`totalInScope` から除かれ、`filtered*` に数えられる。
      if (scope.labels !== undefined) {
        const labels = scope.labels;
        if (!memory.tags.some((tag) => labels.includes(tag))) {
          filteredTaxonomy += 1;
          continue;
        }
      }

      totalInScope += 1;
      // ⭐ Issue #329 / ADR 0173: 忘却ゲートで落ちた件数。**`continue` しない**
      // ——`archived`/`period`/`expired` と違い、減衰しきった Memory は
      // `totalInScope`・群カウント・目次帯のいずれからも除かれない（スコープ内に在る）。
      // 述語は `PostgresMemoryStore.aggregateScope` の `isDecayed` と、
      // `recall-runtime.ts` の `survivesDecayGate` の否定と、同じものでなければならない。
      if (isDecayedForScope(memory, scope)) {
        filteredDecayed += 1;
      }
      const key = memory.subjectId ?? null;
      inScopeBySubject.set(key, (inScopeBySubject.get(key) ?? 0) + 1);
      if (memory.embeddingStatus !== "ready") {
        notIndexed[memory.embeddingStatus] += 1;
      }
      inScopeMemories.push(memory);
    }

    const groups: ScopeAggregate["groups"] = [...inScopeBySubject.entries()].map(
      ([key, count]) => ({
        axis: "subject" as const,
        key,
        count,
        countKind: "exact" as const,
      }),
    );

    // Issue #201 PR-B（ADR 0323「決定5」）: `packages/testkit` の `InMemoryMemoryStore` と
    // 同じ意味論。
    if (scope.taxonomyGroupCandidates !== undefined) {
      const candidates = scope.taxonomyGroupCandidates;
      const perLabelCount = new Map<string, number>();
      let residual = 0;
      for (const memory of inScopeMemories) {
        const matchingLabels = new Set(memory.tags.filter((tag) => candidates.includes(tag)));
        if (matchingLabels.size === 0) {
          residual += 1;
          continue;
        }
        for (const label of matchingLabels) {
          perLabelCount.set(label, (perLabelCount.get(label) ?? 0) + 1);
        }
      }
      for (const [key, count] of perLabelCount) {
        groups.push({ axis: "taxonomy" as const, key, count, countKind: "exact" as const });
      }
      if (residual > 0) {
        groups.push({
          axis: "taxonomy" as const,
          key: null,
          count: residual,
          countKind: "exact" as const,
        });
      }
    }

    let digests: ScopeAggregate["digests"] = [];
    let digestEligible: ScopeAggregate["digestEligible"] = { count: 0, countKind: "exact" };
    if (opts?.digestBand) {
      // `PostgresMemoryStore.aggregateScope` は `digestBand.limit` を生 SQL の `LIMIT`
      // （bigint パラメータ）にそのまま渡すため、負数・`NaN`・`Infinity`・非整数は例外に
      // なる（実測）。ここで検査せず `eligibleMemories.slice(0, opts.digestBand.limit)`
      // へ渡すと `Array.prototype.slice` の意味論を踏む——
      // `InMemoryMemoryStore.aggregateScope`（`packages/testkit`、PR #804/#811）と
      // 同じ形の不一致（`fake-store-postgres-parity.test.ts` が歯）。
      if (!Number.isInteger(opts.digestBand.limit)) {
        throw new Error(
          `aggregateScope: digestBand.limit must be an integer (got ${opts.digestBand.limit})`,
        );
      }
      if (opts.digestBand.limit < 0) {
        throw new Error(
          `aggregateScope: digestBand.limit must not be negative (got ${opts.digestBand.limit})`,
        );
      }
      const exclude = new Set(opts.digestBand.excludeMemoryIds);
      const eligibleMemories = inScopeMemories.filter((m) => !exclude.has(m.id));
      // 決定的な順序: (occurredAt ?? recordedAt) の降順、同値なら id の降順（本 PR）。
      eligibleMemories.sort((a, b) => {
        const aTime = (a.occurredAt ?? a.recordedAt).getTime();
        const bTime = (b.occurredAt ?? b.recordedAt).getTime();
        if (aTime !== bTime) return bTime - aTime;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
      digestEligible = { count: eligibleMemories.length, countKind: "exact" };
      digests = eligibleMemories.slice(0, opts.digestBand.limit).map((m) => ({
        memoryId: m.id,
        digest: m.digest,
      }));
    }

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
      filteredExpired: { count: filteredExpired, countKind: "exact" },
      filteredNotYetValid: { count: filteredNotYetValid, countKind: "exact" },
      filteredTaxonomy: { count: filteredTaxonomy, countKind: "exact" },
      filteredDecayed: { count: filteredDecayed, countKind: "exact" },
      digests,
      digestEligible,
    };
  }

  async createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId> {
    const id = nextId("rcl");
    this.backing.recalls.set(id, { ...record, tenantId: ctx.tenantId, createdAt: new Date() });
    // ADR 0165 決めたこと5: `recalls` への INSERT と「同一トランザクション」で
    // `activity_seq` を +1 する。フェイクには本物のトランザクションが無いので、
    // 同期的に隣り合わせて書くことで同じ性質（片方だけが書かれることはない）を再現する。
    if (record.advanceActivityClock === true) {
      const current = this.backing.activitySeq.get(ctx.tenantId) ?? 0;
      this.backing.activitySeq.set(ctx.tenantId, current + 1);
    }
    return id;
  }

  /**
   * Issue #298 / ADR 0155: `createRecall` と対になる読む口。`InMemoryMemoryStore`
   * （`packages/testkit`）と同じ契約——見つからない、またはテナントが一致しなければ
   * `null`。このフェイクが保持する行は常に `createRecall` 経由の新規行なので
   * `breakdownCaptured: true` で固定する。
   */
  async getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null> {
    const row = this.backing.recalls.get(id);
    if (!row || row.tenantId !== ctx.tenantId) {
      return null;
    }
    return {
      recallId: id,
      tenantId: row.tenantId,
      subjectId: row.subjectId ?? null,
      query: row.query,
      budget: row.budget ?? null,
      omitted: row.omitted,
      usage: row.usage,
      indexBand: row.indexBand,
      explain: row.explain,
      returnedMemories: { breakdownCaptured: true, memories: row.returnedMemories },
      createdAt: row.createdAt,
    };
  }

  /**
   * ADR 0079: 索引に載っていない Memory を `pending` へ戻し、`embed` の outbox 行を
   * 積み直す。**更新と積み直しを `await` を挟まない同期区間で行う**ことで、
   * Postgres 側の単一文（＝同一トランザクション）と同じく「片方だけ起きた中間状態」を
   * 外から観測させない（ADR 0054 と同じ形）。
   */
  async requeueEmbedJobs(ctx: Ctx, opts: RequeueEmbedJobsOptions): Promise<RequeueEmbedJobsResult> {
    const targetStatuses: readonly EmbeddingStatus[] = opts.statuses;
    const idFilter = opts.memoryIds === undefined ? null : new Set<string>(opts.memoryIds);
    const targets = [...this.backing.memories.values()]
      .filter(
        (m) =>
          m.tenantId === ctx.tenantId &&
          (m.status === "active" || m.status === "contested") &&
          targetStatuses.includes(m.embeddingStatus) &&
          (idFilter === null || idFilter.has(m.id)),
      )
      .sort(
        (a, b) =>
          a.updatedAt.getTime() - b.updatedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .slice(0, Math.max(0, opts.limit));

    const memoryIds: MemoryId[] = [];
    for (const memory of targets) {
      memory.embeddingStatus = "pending";
      memory.updatedAt = new Date();
      this.enqueueJob(ctx, "embed", { memoryId: memory.id });
      memoryIds.push(memory.id);
    }
    return { requeued: memoryIds.length, memoryIds };
  }

  /**
   * ADR 0114: `docs/memory-model.md` §11 行8の掃引。`requeueEmbedJobs` と同じ作法
   * ——`status = 'active'` かつ `decayFloorAt <= opts.now`（境界を含む）の Memory を
   * `decayFloorAt` 昇順で `opts.limit` 件まで選び、更新とイベント追記を `await` を
   * 挟まない同期区間で行う（postgres 実装の単一トランザクションを模す）。
   */
  async archiveDecayed(ctx: Ctx, opts: ArchiveDecayedOptions): Promise<ArchiveDecayedResult> {
    const nowMs = opts.now.getTime();
    const clock = opts.clock ?? "wall";
    // [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと15
    // （Issue #768 で実測して足した）: `opts.clock` の分岐を
    // `InMemoryMemoryStore.archiveDecayed`/`PostgresMemoryStore.archiveDecayed` と
    // 同じ形に揃える——境界の非対称（ゲートは狭義 `>`、掃引は境界を含む `<=`）を
    // 1バイトも変えずに写す。`'either'` は AND（両方の軸で沈んでいるものだけ掃く）。
    const passesWall = (m: Memory): boolean => m.decayFloorAt.getTime() <= nowMs;
    const passesActivity = (m: Memory): boolean => {
      if (opts.nowSeq === undefined) {
        throw new Error(
          `FakeMemoryStore.archiveDecayed: opts.nowSeq is required when clock is "${clock}"`,
        );
      }
      const decayFloorSeq = m.decayFloorSeq ?? null;
      return decayFloorSeq !== null && decayFloorSeq <= opts.nowSeq;
    };
    const passesClock = (m: Memory): boolean => {
      if (clock === "wall") return passesWall(m);
      if (clock === "activity") return passesActivity(m);
      return passesWall(m) && passesActivity(m);
    };
    // ⭐ ADR 0165 決めたこと8: 並べる軸は掃く軸に合わせる（`clock: 'activity'` では
    // `decayFloorSeq` 昇順）。`InMemoryMemoryStore` と同じ形——返り値 `archived` の
    // 並び順の契約は変えない（下で `decayFloorAt` 昇順に並べ直す）。
    const byId = (a: Memory, b: Memory): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const selectionOrder = (a: Memory, b: Memory): number =>
      clock === "activity"
        ? (a.decayFloorSeq ?? 0) - (b.decayFloorSeq ?? 0) || byId(a, b)
        : a.decayFloorAt.getTime() - b.decayFloorAt.getTime() || byId(a, b);

    const targets = [...this.backing.memories.values()]
      .filter((m) => m.tenantId === ctx.tenantId && m.status === "active" && passesClock(m))
      .sort(selectionOrder)
      .slice(0, Math.max(0, opts.limit));

    const archived: Array<{ memoryId: MemoryId; decayFloorAt: Date }> = [];
    for (const memory of targets) {
      const digestSnapshot = memory.digest;
      memory.status = "archived";
      memory.updatedAt = new Date();
      const storedEvent = buildStoredEvent(ctx, {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "archived",
        actor: { type: "system" },
        digestSnapshot,
        sizeBeforeBytes: null,
        meta: {},
      });
      this.backing.events.push(storedEvent);
      archived.push({ memoryId: memory.id, decayFloorAt: memory.decayFloorAt });
    }
    archived.sort(
      (a, b) =>
        a.decayFloorAt.getTime() - b.decayFloorAt.getTime() ||
        (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0),
    );
    return { archived, reachedLimit: archived.length === opts.limit };
  }

  /**
   * Issue #198 / ADR 0124: `forgotten` かつ未 purge（`purgedAt === null`）な Memory だけを
   * 対象にした CAS。`beforeUpdateStatus`（テスト専用のフック）を CAS 判定の直前に発火する
   * ——`updateStatus`/`updateStatusWithEvent` と同じ位置・同じ理由（`purge` の並行の歯も
   * この既存のフックで決定的に再現する）。
   */
  async purgeMemory(
    ctx: Ctx,
    id: MemoryId,
    tombstone: { content: string; digest: string },
    event: NewMemoryEvent,
  ): Promise<{ memory: Memory; event: MemoryEvent }> {
    this.beforeUpdateStatus?.(id);
    const memory = await this.get(ctx, id);
    if (!memory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${id}`);
    }
    if (memory.status !== "forgotten" || (memory.purgedAt ?? null) !== null) {
      throw new MemoryPurgeConflictError(id, memory.status, memory.purgedAt ?? null);
    }
    memory.content = tombstone.content;
    memory.digest = tombstone.digest;
    memory.purgedAt = new Date();
    memory.updatedAt = new Date();
    const storedEvent = buildStoredEvent(ctx, event);
    this.backing.events.push(storedEvent);
    return { memory, event: storedEvent };
  }

  /**
   * Issue #197 / ADR 0134: 両側とも `status === 'active'` の CAS を課したうえで、
   * `status='contested'`・`contestedWithId` を相互に設定する。`InMemoryMemoryStore`
   * （testkit）/ `PostgresMemoryStore` と同じ「事前検証してから書く」作法——
   * まだ何も書いていないうちに、存在確認と CAS 判定を両方の対象について済ませる
   * ことで、in-memory の「ロールバック」を模す（`supersedeWithNewMemories` と同じ形）。
   *
   * `beforeUpdateStatus` は各対象の CAS 判定の**直前**に発火する——`updateStatus`/
   * `updateStatusWithEvent`/`supersedeWithNewMemories` と同じ位置。TOCTOU の歯が
   * この口でも決定的に再現できるようにする。
   */
  async markContestedPair(
    ctx: Ctx,
    first: { id: MemoryId; event: NewMemoryEvent },
    second: { id: MemoryId; event: NewMemoryEvent },
  ): Promise<{ first: Memory; second: Memory; events: [MemoryEvent, MemoryEvent] }> {
    if (first.id === second.id) {
      throw new RangeError("FakeMemoryStore: first.id and second.id must differ");
    }

    // 1. 事前検証——存在確認。まだ何も書いていない。
    const firstMemory = await this.get(ctx, first.id);
    if (!firstMemory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${first.id}`);
    }
    const secondMemory = await this.get(ctx, second.id);
    if (!secondMemory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${second.id}`);
    }

    // 2. 事前検証——CAS（両側とも `active` であること）。まだ何も書いていない。
    this.beforeUpdateStatus?.(first.id);
    if (firstMemory.status !== "active") {
      throw new MemoryStatusConflictError(first.id, "active", firstMemory.status);
    }
    this.beforeUpdateStatus?.(second.id);
    if (secondMemory.status !== "active") {
      throw new MemoryStatusConflictError(second.id, "active", secondMemory.status);
    }

    // 3. ここから先は両方成功する（in-memory であり、途中失敗の余地が無い）。
    firstMemory.status = "contested";
    firstMemory.contestedWithId = second.id;
    firstMemory.updatedAt = new Date();
    secondMemory.status = "contested";
    secondMemory.contestedWithId = first.id;
    secondMemory.updatedAt = new Date();

    const firstEvent = buildStoredEvent(ctx, first.event);
    const secondEvent = buildStoredEvent(ctx, second.event);
    this.backing.events.push(firstEvent, secondEvent);

    return { first: firstMemory, second: secondMemory, events: [firstEvent, secondEvent] };
  }

  /**
   * Issue #197 / ADR 0150: `markContestedPair` の解決側。両側とも `status === 'contested'`
   * かつ相互参照が成立していることを CAS で課したうえで、`contestedWithId` を両側とも
   * `null` に戻し、呼び出し側が指定した `status`（`'active'`/`'superseded'`）へ更新する
   * ——`markContestedPair` と同じ「事前検証してから書く」作法（まだ何も書いていないうちに
   * 存在確認と CAS 判定を両方の対象について済ませ、in-memory の「ロールバック」を模す）。
   *
   * `beforeUpdateStatus` は各対象の CAS 判定の**直前**に発火する——`markContestedPair` と
   * 同じ位置。TOCTOU の歯がこの口でも決定的に再現できるようにする。
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
      throw new RangeError("FakeMemoryStore: first.id and second.id must differ");
    }

    // 1. 事前検証——存在確認。まだ何も書いていない。
    const firstMemory = await this.get(ctx, first.id);
    if (!firstMemory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${first.id}`);
    }
    const secondMemory = await this.get(ctx, second.id);
    if (!secondMemory) {
      throw new Error(`FakeMemoryStore: memory not found for tenant: ${second.id}`);
    }

    // 2. 事前検証——CAS（両側とも `contested` かつ相互参照が成立していること）。
    //    まだ何も書いていない。
    this.beforeUpdateStatus?.(first.id);
    if (firstMemory.status !== "contested" || firstMemory.contestedWithId !== second.id) {
      throw new MemoryStatusConflictError(first.id, "contested", firstMemory.status);
    }
    this.beforeUpdateStatus?.(second.id);
    if (secondMemory.status !== "contested" || secondMemory.contestedWithId !== first.id) {
      throw new MemoryStatusConflictError(second.id, "contested", secondMemory.status);
    }

    // 3. ここから先は両方成功する（in-memory であり、途中失敗の余地が無い）。
    firstMemory.status = first.status;
    firstMemory.contestedWithId = null;
    if (first.supersededById !== undefined) {
      firstMemory.supersededById = first.supersededById;
    }
    firstMemory.updatedAt = new Date();
    secondMemory.status = second.status;
    secondMemory.contestedWithId = null;
    if (second.supersededById !== undefined) {
      secondMemory.supersededById = second.supersededById;
    }
    secondMemory.updatedAt = new Date();

    const firstEvent = buildStoredEvent(ctx, first.event);
    const secondEvent = buildStoredEvent(ctx, second.event);
    this.backing.events.push(firstEvent, secondEvent);

    return { first: firstMemory, second: secondMemory, events: [firstEvent, secondEvent] };
  }

  /**
   * Issue #372（(B) 第2段）: `MemoryStore.findActiveByClaimKey?` の実装
   * （`packages/testkit` の `InMemoryMemoryStore.findActiveByClaimKey` と同じロジック
   * ——このファイルは意図的に独立している、冒頭のコメント参照）。
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
    const targetFrom = query.validFrom ?? null;
    const targetUntil = query.validUntil ?? null;
    return [...this.backing.memories.values()].filter((m) => {
      if (m.tenantId !== ctx.tenantId) return false;
      if (m.id === query.excludeMemoryId) return false;
      if ((m.subjectId ?? null) !== query.subjectId) return false;
      if (!m.claimKey) return false;
      if (
        m.claimKey.subject !== query.claimKey.subject ||
        m.claimKey.predicate !== query.claimKey.predicate
      ) {
        return false;
      }
      if (m.status !== "active") return false;
      if (m.contentHash === query.contentHash) return false;
      const otherFrom = m.validFrom ?? null;
      const otherUntil = m.validUntil ?? null;
      const overlaps =
        (targetFrom === null || otherUntil === null || targetFrom < otherUntil) &&
        (otherFrom === null || targetUntil === null || otherFrom < targetUntil);
      return overlaps;
    });
  }

  /**
   * Issue #691続き（ADR 0329）: `MemoryStore.listActiveClaimPredicates?` の実装
   * （`packages/testkit` の `InMemoryMemoryStore.listActiveClaimPredicates` と同じ
   * ロジック——このファイルは意図的に独立している、冒頭のコメント参照）。
   */
  async listActiveClaimPredicates(
    ctx: Ctx,
    query: { subjectId: string | null; limit: number },
  ): Promise<string[]> {
    const latestByPredicate = new Map<string, number>();
    for (const m of this.backing.memories.values()) {
      if (m.tenantId !== ctx.tenantId) continue;
      if ((m.subjectId ?? null) !== query.subjectId) continue;
      if (m.status !== "active") continue;
      if (!m.claimKey) continue;
      const predicate = m.claimKey.predicate;
      const createdAtMs = m.createdAt.getTime();
      const existing = latestByPredicate.get(predicate);
      if (existing === undefined || createdAtMs > existing) {
        latestByPredicate.set(predicate, createdAtMs);
      }
    }
    return [...latestByPredicate.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, query.limit)
      .map(([predicate]) => predicate);
  }

  /**
   * `docs/memory-model.md` §11 行15「`superseded → active`」。`archiveDecayed` と同じ
   * 「範囲走査 + 一括更新」の形——`await` を挟まない同期区間で選定・更新・イベント
   * 追記を行うことで、postgres 実装の単一トランザクションを模す
   * （`packages/testkit` の `InMemoryMemoryStore.restoreSupersededBy` と同じ形だが、
   * ファイル冒頭のコメントの通り意図的に独立している）。
   *
   * `filter?.onlyMemoryIds`（Issue #515 方向①、ADR 0258）: 積集合フィルタ。
   */
  async restoreSupersededBy(
    ctx: Ctx,
    supersededById: MemoryId,
    event: { reason?: string; actor?: EventActor; at: Date },
    filter?: { onlyMemoryIds?: MemoryId[] },
  ): Promise<{ restored: Memory[] }> {
    const onlyMemoryIds = filter?.onlyMemoryIds;
    const targets = [...this.backing.memories.values()].filter(
      (m) =>
        m.tenantId === ctx.tenantId &&
        m.supersededById === supersededById &&
        m.status === "superseded" &&
        (onlyMemoryIds === undefined || onlyMemoryIds.includes(m.id)),
    );

    const actor = event.actor ?? { type: "system" };
    const meta = { reason: event.reason ?? "unsuperseded", supersededById };

    const restored: Memory[] = [];
    for (const memory of targets) {
      memory.status = "active";
      memory.supersededById = null;
      memory.updatedAt = new Date();
      const storedEvent = buildStoredEvent(ctx, {
        tenantId: ctx.tenantId,
        memoryId: memory.id,
        kind: "unsuperseded",
        at: event.at,
        actor,
        digestSnapshot: memory.digest,
        sizeBeforeBytes: null,
        meta,
      });
      this.backing.events.push(storedEvent);
      restored.push(memory);
    }
    return { restored };
  }

  /**
   * `restoreSupersededBy` を実際に呼ぶ**前**に見るための読み取り専用の口
   * （Issue #515、ADR 0237）。`packages/testkit` の `InMemoryMemoryStore.previewRestoreSupersededBy`
   * と同じ形——対象の選び方は `restoreSupersededBy` と同じ filter を使い、
   * `this.backing.events` から対象ごとに直近の `kind: 'superseded'` イベントを探して
   * `meta.reason` を運ぶ。書き込みは一切行わない。
   *
   * `filter?.onlyMemoryIds`（Issue #515 方向①、ADR 0258）: `restoreSupersededBy` と
   * 同じ積集合フィルタ。
   */
  async previewRestoreSupersededBy(
    ctx: Ctx,
    supersededById: MemoryId,
    filter?: { onlyMemoryIds?: MemoryId[] },
  ): Promise<{ candidates: Array<{ memoryId: MemoryId; supersededReason: string | null }> }> {
    const onlyMemoryIds = filter?.onlyMemoryIds;
    const targets = [...this.backing.memories.values()].filter(
      (m) =>
        m.tenantId === ctx.tenantId &&
        m.supersededById === supersededById &&
        m.status === "superseded" &&
        (onlyMemoryIds === undefined || onlyMemoryIds.includes(m.id)),
    );

    const candidates = targets.map((memory) => {
      let latest: MemoryEvent | undefined;
      for (const event of this.backing.events) {
        if (
          event.tenantId === ctx.tenantId &&
          event.memoryId === memory.id &&
          event.kind === "superseded" &&
          (latest === undefined || event.at.getTime() > latest.at.getTime())
        ) {
          latest = event;
        }
      }
      const reason = latest?.meta?.["reason"];
      return {
        memoryId: memory.id,
        supersededReason: typeof reason === "string" ? reason : null,
      };
    });

    return { candidates };
  }
}

export class FakeOutboxStore implements OutboxStore {
  constructor(private readonly backing: FakeBackingStore) {}

  /**
   * 歯が outbox 行の**終端状態**（`claimedAt` / `failedAt` / `lastError`）を直接測るための読み口。
   * ADR 0082 の歯が「対応していない kind のジョブは黙って lease 切れを待つのではなく
   * `fail()` で終端に落ちる」「頼まれていない kind は claim すらされない」を測るのに使う——
   * `TickResult` だけでは outbox 行がどうなったかは見えない。
   */
  listJobs(ctx: Ctx): OutboxJobRecord[] {
    return this.backing.outboxJobs
      .filter((job) => job.tenantId === ctx.tenantId)
      .map((job) => ({ ...job }));
  }

  // リース意味論（ADR 0032）は `packages/testkit` の `InMemoryOutboxStore`/
  // `PostgresOutboxStore` と一致させてある——この fake だけ古い意味論のままだと
  // `runtime.test.ts` が「今日の姿」を検査しているつもりで、実は直った後の姿を
  // 検査してしまう食い違いが起きる。
  async claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]> {
    // `PostgresOutboxStore.claimBatch` は `opts.limit` を生 SQL の `LIMIT`（bigint
    // パラメータ）にそのまま渡すため、負数・`NaN`・`Infinity`・非整数は例外になる
    // （実測）。ここで検査せず `eligible.slice(0, opts.limit)` へ渡すと
    // `Array.prototype.slice` の意味論を踏んでジョブを黙って claim してしまう——
    // `InMemoryOutboxStore.claimBatch`（`packages/testkit`、PR #804/#811）と同じ形の
    // 不一致（`fake-store-postgres-parity.test.ts` が歯）。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`claimBatch: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`claimBatch: limit must not be negative (got ${opts.limit})`);
    }
    const leaseExpiresBefore = opts.now.getTime() - opts.leaseMs;
    const eligible = this.backing.outboxJobs.filter((job) => {
      const claimedAt = job.claimedAt ?? null;
      return (
        job.tenantId === ctx.tenantId &&
        (opts.kinds === undefined || opts.kinds.includes(job.kind)) &&
        job.completedAt === null &&
        job.failedAt === null &&
        job.availableAt <= opts.now &&
        (claimedAt === null || claimedAt.getTime() <= leaseExpiresBefore)
      );
    });
    eligible.sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime());
    const claimed = eligible.slice(0, opts.limit);
    for (const job of claimed) {
      job.claimedAt = opts.now;
      job.claimedBy = opts.claimedBy;
      job.attempts += 1;
    }
    return claimed.map((job) => ({ ...job }));
  }

  // CAS 意味論（ADR 0142, Issue #233）も `packages/testkit` の `InMemoryOutboxStore`/
  // `PostgresOutboxStore` と一致させてある。complete/fail は互いに排他でもある
  // （Issue #826）——相手側の終端列（`completedAt`/`failedAt`）が既に付いていれば、
  // 後から来た呼び出しは行を一切変えず例外も投げない（先に付いた終端が勝つ）。
  // 同種の再呼び出し（complete+complete、fail+fail）の冪等な挙動は変えていない。
  async complete(ctx: Ctx, jobId: string, expectedAttempts: number): Promise<void> {
    const job = this.backing.outboxJobs.find((j) => j.id === jobId && j.tenantId === ctx.tenantId);
    if (!job) {
      return;
    }
    if (job.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, job.attempts);
    }
    // Issue #826: 相手側の終端（fail）が既に付いていれば、先に付いた終端を勝たせる
    // ——行を変えず、例外も投げない。
    if ((job.failedAt ?? null) !== null) {
      return;
    }
    job.completedAt = new Date();
  }

  async fail(ctx: Ctx, jobId: string, error: string, expectedAttempts: number): Promise<void> {
    const job = this.backing.outboxJobs.find((j) => j.id === jobId && j.tenantId === ctx.tenantId);
    if (!job) {
      return;
    }
    if (job.attempts !== expectedAttempts) {
      throw new OutboxLeaseConflictError(jobId, expectedAttempts, job.attempts);
    }
    // Issue #826: 相手側の終端（complete）が既に付いていれば、先に付いた終端を勝たせる
    // ——行を変えず、例外も投げない。
    if ((job.completedAt ?? null) !== null) {
      return;
    }
    job.failedAt = new Date();
    job.lastError = error;
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
    // ADR 0040: 契約は「ゼロベクトルが絡む候補は recall() の結果に出ない」——
    // どんな scoreThreshold でも `total >= scoreThreshold` を通らない値を返さなければならない。
    // `0` でも `1` でもだめ（どちらも scoreThreshold 次第で通りうる）。
    // `Infinity` もだめ——`similarity = 1 - Infinity = -Infinity` になり、
    // `scoreThreshold = -Infinity` のとき `-Infinity >= -Infinity` が真になって通ってしまう。
    // `NaN` は、どんな数との比較も false になる唯一の値である。
    // 🔴 この番人（`normA === 0 || normB === 0`）を「下の式が 0/0 で同じ NaN になるから」と
    // 消さないこと——消しても値は変わらない（等価変異）が、番人が保持しているのは値ではなく
    // 「0/1/Infinity ではなく NaN を選んだ」という決定そのもの。消すと、次に式を触った人が
    // その決定ごと落とす。
    return NaN;
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}

/**
 * `FakeVectorStore` は `packages/core` 自身のテスト用であり `@mnemora/testkit` に依存しない
 * （このファイル冒頭のコメント参照）。recall のテストが意味のある結果を得られるよう、
 * `upsert` されたベクトルに対して実際に cosine 距離で ANN を模する
 * （`FakeBackingStore.memories` を参照して `VectorFilter`（ADR 0034）を本物同様に適用する）。
 *
 * **`backing` を必須のコンストラクタ引数にしている（省略不可）。** `status` / `subjectId` /
 * `decayFloorAt` は Memory の属性であって、ベクトルの属性ではない
 * （`VectorFilter` — `packages/core/src/interfaces/vector-store.ts`、ADR 0034）。
 * `packages/testkit` の `InMemoryVectorStore` が `memoryStore` を必須にしたのと同じ理由——
 * **省略可能にしなかった理由（ADR 0034 の「採らなかった案」節）**: 省略できると
 * 「filter を実際に検査できる fake」と「検査できない（＝常に無視しても壊れない）fake」が
 * 同じ緑色の出力になる。このリポジトリは ADR 0011/0025/0027/0028 で同じ族の失敗
 * （名乗れる以上の精度を主張する）を繰り返しており、ここでも繰り返さない。唯一の生成箇所
 * （このファイルの `createFakeRuntimeStores`）は既に `backing` を渡している。
 */
export class FakeVectorStore implements VectorStore {
  entries = new Map<string, { tenantId: string; memoryId: MemoryId; vector: number[] }>();

  constructor(private readonly backing: FakeBackingStore) {}

  private key(space: EmbeddingSpaceId, tenantId: string, memoryId: MemoryId): string {
    return `${space.provider}:${space.model}:${space.dimensions}:${tenantId}:${memoryId}`;
  }

  async upsert(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryId: MemoryId,
    vector: number[],
  ): Promise<void> {
    // 外部キー相当（ADR 0047）: `memory_embeddings_<space>.memory_id → memories(id)`。
    // `search` は同じ `backing.memories` を真実の源として引いており（クラス doc 参照）、
    // 書き込み側（upsert）でも同じ非対称を強制する——ADR 0034 が実装した「MemoryStore が
    // 真実の源」を、書き込み時点でも成り立たせる。
    if (!this.backing.memories.has(memoryId)) {
      throw new Error(`FakeVectorStore: memory not found: ${memoryId}`);
    }
    this.entries.set(this.key(space, ctx.tenantId, memoryId), {
      tenantId: ctx.tenantId,
      memoryId,
      vector,
    });
  }

  async search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter },
  ): Promise<VectorHit[]> {
    // `PostgresVectorStore.search` は `opts.limit` を生 SQL の `LIMIT`（bigint
    // パラメータ）にそのまま渡すため、負数・`NaN`・`Infinity`・非整数は例外になる
    // （実測）。ここで検査せず `hits.slice(0, opts.limit)` へ渡すと
    // `Array.prototype.slice` の意味論を踏んでほぼ全件を静かに返してしまう——
    // `InMemoryVectorStore.search`（`packages/testkit`、PR #804/#811）と同じ形の不一致
    // （`fake-store-postgres-parity.test.ts` が歯）。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`search: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`search: limit must not be negative (got ${opts.limit})`);
    }
    // `InMemoryVectorStore`（packages/testkit）と同じ意味論に揃える（ADR 0065）:
    // 索引を模す prefix は space（provider/model/dimensions）だけで絞る。以前はここで
    // `space` を一度も参照しておらず（引数名も `_space` だった）、異なる space の vector を
    // 混同して返していた——`key()` が space を含む prefix を作っているのに、`search` だけが
    // それを見ていなかった。
    const prefix = `${space.provider}:${space.model}:${space.dimensions}:`;
    const hits: (VectorHit & { recordedAt: Date })[] = [];
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      if (entry.tenantId !== opts.filter.tenantId || entry.tenantId !== ctx.tenantId) continue;
      // status / subjectId / decayFloorAtAfter は Memory の属性であり、ベクトルの属性ではない
      // （ADR 0034）。`backing.memories` を真実の源として引く——`InMemoryVectorStore` の
      // `this.memoryStore.get(...)` に対応する一段。
      const memory = this.backing.memories.get(entry.memoryId);
      if (!memory) {
        // 真実の源に無い vector は返さない——Postgres の外部キー制約
        // （`memory_id → memories(id)`）に対応する扱い（ADR 0034 決定2、
        // `InMemoryVectorStore` と揃える）。このリポジトリ内で `vectorStore.upsert` を
        // 直接呼ぶテストは必ず `memoryStore.createMemory` で作った実在の memory.id を渡して
        // いるため（`recall-pipeline.test.ts`）、この既定によって既存の歯が落ちないことを
        // 確認済み。
        continue;
      }
      if (opts.filter.status !== undefined && !opts.filter.status.includes(memory.status)) {
        continue;
      }
      if (opts.filter.subjectId !== undefined && memory.subjectId !== opts.filter.subjectId) {
        continue;
      }
      // Issue #152/#153（ADR 0312）: AND 等値。`FakeLexicalStore.search` と同じ意味論。
      if (opts.filter.attributes !== undefined) {
        const memoryAttributes = memory.attributes ?? {};
        const matches = Object.entries(opts.filter.attributes).every(
          ([key, value]) => memoryAttributes[key] === value,
        );
        if (!matches) continue;
      }
      // ADR 0165 決めたこと1・12・14: 忘却ゲートの2軸。`decayFloorAnyAxis: true` かつ
      // 両方（`decayFloorAtAfter`・`decayFloorSeqAfter`）が与えられているときに限り OR で
      // 結ぶ（`interfaces/vector-store.ts` の `decayFloorAnyAxis` doc の契約そのもの）。
      // 以前はここで `decayFloorAtAfter` だけを常時 AND で見ており、`decayFloorSeqAfter`/
      // `decayFloorAnyAxis` を一度も参照していなかった——'either' のテナントで
      // 壁時計が死んでいるが活動時計は生きている候補が、ANN の push-down 段で
      // 誤って落ちる（実測: `recall-decay-gate.test.ts` の「'either' はOR: 活動時計は
      // 生きているが壁時計は沈んでいても通る」歯が最初に赤くなった）。
      const wallAxisAfter = opts.filter.decayFloorAtAfter;
      const seqAxisAfter = opts.filter.decayFloorSeqAfter;
      const wallAlive =
        wallAxisAfter === undefined ? undefined : memory.decayFloorAt > wallAxisAfter;
      const seqAlive =
        seqAxisAfter === undefined
          ? undefined
          : memory.decayFloorSeq === null || memory.decayFloorSeq === undefined
            ? true
            : memory.decayFloorSeq > seqAxisAfter;
      if (
        opts.filter.decayFloorAnyAxis === true &&
        wallAlive !== undefined &&
        seqAlive !== undefined
      ) {
        if (!wallAlive && !seqAlive) continue;
      } else {
        if (wallAlive === false) continue;
        if (seqAlive === false) continue;
      }
      // ADR 0056: 除外の列挙（status とは向きが逆）。`undefined`/空配列は no-op
      // （`VectorFilter.excludeProvenanceKinds` の doc 参照。`InMemoryVectorStore` と
      // 同じ意味論）。
      if (
        opts.filter.excludeProvenanceKinds !== undefined &&
        opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)
      ) {
        continue;
      }
      // ADR 0059: period（両端とも包含、`>=`/`<=`）。比較対象は `occurredAt ?? recordedAt`
      // （ADR 0039 の実効時刻）——`InMemoryVectorStore`（`packages/testkit`）と同じ意味論。
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
      // Issue #280（Issue #202 第2弾）: `validAt` ゲート。`InMemoryVectorStore`
      // （`packages/testkit`）と同じ意味論。
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
        distance: cosineDistance(query, entry.vector),
        recordedAt: memory.recordedAt,
      });
    }
    // `PostgresVectorStore.search`（ADR 0170、Issue #339）と同じ3段 tie-break:
    // 距離 → `recordedAt` DESC → `memoryId` 昇順。`InMemoryVectorStore`（`packages/testkit`）
    // と同じ理由・同じ修正——以前は距離だけのソートで、同点の中身が挿入順（通常の呼び出し順では
    // `recordedAt` が古いほうが先）に落ちており、Postgres の「新しい方が先」と逆向きだった
    // （`packages/core/src/__tests__/fake-vector-store-tiebreak.test.ts` が歯）。
    hits.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      const recordedAtDiff = b.recordedAt.getTime() - a.recordedAt.getTime();
      if (recordedAtDiff !== 0) return recordedAtDiff;
      return a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0;
    });
    return hits.slice(0, opts.limit).map(({ memoryId, distance }) => ({ memoryId, distance }));
  }

  async delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void> {
    this.entries.delete(this.key(space, ctx.tenantId, memoryId));
  }

  /**
   * Issue #200 / ADR 0151: 連想枠の歯が使う。`InMemoryVectorStore`
   * （`packages/testkit`）の同名メソッドと同じ意味論——存在しない memoryId・
   * 他テナントの memoryId は静かに結果から落ちる（tenant 境界は key の一致で掛かる）。
   */
  async getVectors(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    memoryIds: MemoryId[],
  ): Promise<{ memoryId: MemoryId; vector: number[] }[]> {
    // `PostgresVectorStore.getVectors` は `memory_id = ANY(...)` という集合演算で引くため
    // （実測）、同じ id を複数回渡しても一致する行は主キーの性質上1回しか無い。ここで
    // 検査せず `memoryIds` をそのまま for-of すると重複して返してしまう——
    // `InMemoryVectorStore.getVectors`（`packages/testkit`、PR #812）と同じ形の不一致
    // （`fake-store-postgres-parity.test.ts` が歯）。`seen` で2回目以降をスキップする。
    const seen = new Set<MemoryId>();
    const results: { memoryId: MemoryId; vector: number[] }[] = [];
    for (const memoryId of memoryIds) {
      if (seen.has(memoryId)) {
        continue;
      }
      seen.add(memoryId);
      const entry = this.entries.get(this.key(space, ctx.tenantId, memoryId));
      if (entry !== undefined) {
        results.push({ memoryId, vector: entry.vector });
      }
    }
    return results;
  }
}

/**
 * Issue #200 / ADR 0151: `getVectors` を実装していない `VectorStore` を模す薄いラッパー。
 * `FakeVectorStore` の `upsert`/`search`/`delete` へそのまま委譲するが、`getVectors` を
 * プロパティとして持たない——`deps.vectorStore.getVectors === undefined` を検査する歯
 * （`stage_skipped { reason: "vector_store_lacks_get_vectors" }`）専用。
 */
export function withoutGetVectors(store: FakeVectorStore): VectorStore {
  return {
    upsert: (ctx, space, memoryId, vector) => store.upsert(ctx, space, memoryId, vector),
    search: (ctx, space, query, opts) => store.search(ctx, space, query, opts),
    delete: (ctx, space, memoryId) => store.delete(ctx, space, memoryId),
  };
}

/**
 * Issue #316 / ADR 0167: `VectorStore.getVectors` の doc（「返す順序は memoryIds の
 * 順序と一致している必要はない」）を、字面だけでなく実際に踏む adapter を模す。
 *
 * `FakeVectorStore.getVectors` は `memoryIds` をそのまま for-of するため、常に
 * **入力順を保って**返す——`PostgresVectorStore.getVectors`（`ORDER BY` を持たず、
 * 実測では主キー Index Scan がランダムな UUID 昇順で返す）とは違う。この違いが、
 * `recall-runtime.ts` 側が「契約上どの順で来てもよい」ことを実装で守れているかを
 * 検査から隠していた——この wrapper は、`getVectors` の結果を**逆順**にして返すことで、
 * 呼び出し側が返り値の順序に依存していないかを暴く。
 */
export function withReversedGetVectorsOrder(store: FakeVectorStore): VectorStore {
  return {
    upsert: (ctx, space, memoryId, vector) => store.upsert(ctx, space, memoryId, vector),
    search: (ctx, space, query, opts) => store.search(ctx, space, query, opts),
    delete: (ctx, space, memoryId) => store.delete(ctx, space, memoryId),
    getVectors: async (ctx, space, memoryIds) => {
      const entries = await store.getVectors(ctx, space, memoryIds);
      return [...entries].reverse();
    },
  };
}

/**
 * `FakeLexicalStore` は `packages/core` 自身のテスト用であり `@mnemora/testkit` に依存しない
 * （このファイル冒頭のコメント参照）。`packages/testkit` の `InMemoryLexicalStore` とは
 * **意図的に独立している**——本 PR の時点で `InMemoryLexicalStore` はまだ書かれている最中
 * （Issue #106 の歯だけを先に置く作業。他の作業者が同時に `packages/testkit` を触っている）
 * ため、それを import しない。
 *
 * **契約は `interfaces/lexical-store.ts` の `LexicalStore` doc に従う**（ADR 0092）:
 * - `query` の語彙の**いずれか1つでも**含む候補を返す（OR 意味論）。1つも含まない候補は
 *   返さない——全件を無条件で返す実装は、この契約と `recall-channels.test.ts` 歯①の
 *   偽陽性点検（無関係な記憶が混ざっても返らないこと）で落ちる。
 * - `coverage`（一致した語彙数 ÷ クエリ語彙の総数）を返す。これがそのまま
 *   `ScoreBreakdown.lexicalMatch` に入る（`recall-runtime.ts`）。
 * - `filter` の各フィールドを実際に適用する（`FakeVectorStore.search` と同じ多層防御の作法）。
 * - 返り値は `coverage` の降順、同値なら `rank` の降順。`rank` はここでは
 *   「一致したトークンの出現回数の総和」という決定的で単調な値を使う——本物の
 *   `ts_rank_cd` を模す必要は無い。`LexicalHit.rank` の doc の通り、この値は
 *   `ScoreBreakdown` には一切入らない。
 *
 * `calls` / `shouldThrow` は `FakeEmbeddingProvider.shouldFail` と同じ形の診断・注入口——
 * 「一度も呼ばれていないこと」（既定チャンネルが語彙 store に触れない）と
 * 「配線されているが落ちる adapter」の両方を、歯から直接組み立てられるようにするため。
 */
export class FakeLexicalStore implements LexicalStore {
  /** `search` が呼ばれるたびに積む診断ログ。「一度も呼ばれていないこと」を歯が直接検査できる。 */
  calls: { ctx: Ctx; query: string; opts: { limit: number; filter: LexicalFilter } }[] = [];
  /** true にすると `search` は例外を投げる（配線されているが壊れている adapter を模す）。 */
  shouldThrow = false;

  constructor(private readonly backing: FakeBackingStore) {}

  async search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter },
  ): Promise<LexicalHit[]> {
    this.calls.push({ ctx, query, opts });
    if (this.shouldThrow) {
      throw new Error("FakeLexicalStore: simulated search failure");
    }
    // `PostgresLexicalStore.search`/`PostgresTrigramLexicalStore.search` は `opts.limit` を
    // 生 SQL の `LIMIT`（bigint パラメータ）にそのまま渡すため、負数・`NaN`・`Infinity`・
    // 非整数は例外になる（実測、両実装とも同じ）。ここで検査せず
    // `hits.slice(0, opts.limit)` へ渡すと `Array.prototype.slice` の意味論を踏んで
    // ほぼ全件を静かに返してしまう——`InMemoryLexicalStore.search`（`packages/testkit`、
    // PR #804/#811）と同じ形の不一致（`fake-store-postgres-parity.test.ts` が歯）。
    if (!Number.isInteger(opts.limit)) {
      throw new Error(`search: limit must be an integer (got ${opts.limit})`);
    }
    if (opts.limit < 0) {
      throw new Error(`search: limit must not be negative (got ${opts.limit})`);
    }
    const termSet = new Set(query.split(/\s+/).filter((t) => t.length > 0));
    const hits: (LexicalHit & { recordedAt: Date })[] = [];
    for (const memory of this.backing.memories.values()) {
      if (memory.tenantId !== opts.filter.tenantId || memory.tenantId !== ctx.tenantId) continue;
      if (opts.filter.status !== undefined && !opts.filter.status.includes(memory.status)) {
        continue;
      }
      if (opts.filter.subjectId !== undefined && memory.subjectId !== opts.filter.subjectId) {
        continue;
      }
      // Issue #152/#153（ADR 0312）: AND 等値。`FakeVectorStore.search` と同じ意味論。
      if (opts.filter.attributes !== undefined) {
        const memoryAttributes = memory.attributes ?? {};
        const matches = Object.entries(opts.filter.attributes).every(
          ([key, value]) => memoryAttributes[key] === value,
        );
        if (!matches) continue;
      }
      if (
        opts.filter.excludeProvenanceKinds !== undefined &&
        opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)
      ) {
        continue;
      }
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
      // Issue #280（Issue #202 第2弾）: `validAt` ゲート。`FakeVectorStore` と同じ意味論。
      if (opts.filter.validAt !== undefined) {
        if (memory.validFrom != null && memory.validFrom > opts.filter.validAt) {
          continue;
        }
        if (memory.validUntil != null && memory.validUntil <= opts.filter.validAt) {
          continue;
        }
      }
      // 🔴 契約（ADR 0092）: クエリの語彙が0個なら何も返さない。1個以上一致すれば返す
      // （OR 意味論）——AND（すべて含む候補しか返さない）ではない。
      if (termSet.size === 0) continue;
      const matchedTerms = [...termSet].filter((t) => memory.content.includes(t));
      if (matchedTerms.length === 0) continue;

      const coverage = matchedTerms.length / termSet.size;
      const rank = matchedTerms.reduce((sum, t) => sum + (memory.content.split(t).length - 1), 0);
      hits.push({ memoryId: memory.id, coverage, rank, recordedAt: memory.recordedAt });
    }
    // `PostgresLexicalStore.search`（`interfaces/lexical-store.ts` の `LexicalStore.search`
    // doc、Issue #345 / ADR 0175）と同じ4段 tie-break: coverage → rank → recordedAt DESC →
    // memoryId 昇順。以前は coverage/rank/memoryId の3段止まりで recordedAt を見ておらず、
    // Postgres の「新しい方が先」と食い違っていた
    // （`fake-store-postgres-parity.test.ts` が歯。`InMemoryLexicalStore`
    // （`packages/testkit`）と同じ形の不一致・同じ修正）。
    hits.sort(
      (a, b) =>
        b.coverage - a.coverage ||
        b.rank - a.rank ||
        b.recordedAt.getTime() - a.recordedAt.getTime() ||
        (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0),
    );
    return hits
      .slice(0, opts.limit)
      .map(({ memoryId, coverage, rank }) => ({ memoryId, coverage, rank }));
  }
}

export class FakeEventStore implements EventStore {
  /**
   * ADR 0031: `backing.events` を共有する（`FakeMemoryStore.updateStatusWithEvent` が
   * 積んだイベントもここから読めるようにするため）。以前は独立した配列を持っており
   * `FakeBackingStore` に載っていなかった——`FakeOutboxStore` が `backing.outboxJobs` を
   * 共有するのと同じ形に揃えた。`stores.eventStore.events` という既存の参照の仕方
   * （`runtime.test.ts` 等）を壊さないよう、`events` は `backing.events` を指す getter。
   */
  constructor(private readonly backing: FakeBackingStore) {}

  get events(): MemoryEvent[] {
    return this.backing.events;
  }

  async append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent> {
    // 外部キー相当（ADR 0047）: `memory_events.memory_id → memories(id)`（nullable。
    // `kind = 'events_purged'` の場合のみ NULL が正当）。**NULL は拒まない**——kind を
    // 問わず、`memoryId` が非 null のときだけ実在を要求する。
    if (event.memoryId !== null && !this.backing.memories.has(event.memoryId)) {
      throw new Error(`FakeEventStore: memory not found: ${event.memoryId}`);
    }
    const stored = buildStoredEvent(ctx, event);
    this.backing.events.push(stored);
    return stored;
  }

  async get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null> {
    return this.backing.events.find((e) => e.id === id && e.tenantId === ctx.tenantId) ?? null;
  }

  async list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]> {
    // `PostgresEventStore.list` は `filter.limit` を生 SQL の `LIMIT`（bigint パラメータ）
    // にそのまま渡すため、負数・`NaN`・`Infinity`・非整数は例外になる（実測）。ここで
    // 検査せず `sorted.slice(0, filter.limit)` へ渡すと `Array.prototype.slice` の
    // 意味論を踏んでほぼ全件を静かに返してしまう——`InMemoryEventStore.list`
    // （`packages/testkit`、PR #804/#811）と同じ形の不一致
    // （`fake-store-postgres-parity.test.ts` が歯）。
    if (filter.limit !== undefined && !Number.isInteger(filter.limit)) {
      throw new Error(`list: limit must be an integer (got ${filter.limit})`);
    }
    if (filter.limit !== undefined && filter.limit < 0) {
      throw new Error(`list: limit must not be negative (got ${filter.limit})`);
    }
    const matched = this.backing.events.filter((e) => {
      if (e.tenantId !== ctx.tenantId) return false;
      if (filter.memoryId !== undefined && e.memoryId !== filter.memoryId) return false;
      if (filter.kind !== undefined && e.kind !== filter.kind) return false;
      if (filter.since !== undefined && e.at < filter.since) return false;
      if (filter.until !== undefined && e.at > filter.until) return false;
      return true;
    });
    // EventStore.list の契約（../interfaces/event-store.ts）どおり `at` 昇順に並べ替えてから
    // `limit` を適用する。`filter()` は新しい配列を返すので、その配列を sort() すれば
    // `this.backing.events`（ADR 0031: FakeMemoryStore.updateStatusWithEvent と共有、
    // `store.events` getter 経由で runtime.test.ts が直接読む）を in-place で破壊しない
    // （`packages/testkit` の `InMemoryEventStore.list` と同じ形・同じ理由）。
    const sorted = matched.sort((a, b) => a.at.getTime() - b.at.getTime());
    return filter.limit !== undefined ? sorted.slice(0, filter.limit) : sorted;
  }
}

// `getEventRetention`/`setEventRetention` は `TenantSettingsStore` interface が必須にした
// ため（ADR 0050）、型を満たすためだけに足した最小実装。このファイル以外の既存テストは
// `getDefaultHalfLifeHours` しか使わず、これら2メソッドを呼ぶ既存テストは無い——
// `packages/testkit` の `InMemoryTenantSettingsStore`（適合スイートの対象）とは異なり、
// `FakeTenantSettingsStore` は適合スイートの対象外（ADR 0047 が明記した「core 専用の
// Fake は testkit の適合テストが届かない」構造と同じ）ため、ここに置いた実装を
// 独立に検査する歯は無い。
//
// [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md) 決めたこと13:
// `getDecayClock`/`setDecayClock`/`getDefaultHalfLifeRecalls`/`getActivitySeq` を実装する。
// **interface 上はすべて省略可能（`?`）だが、活動時計の歯を書くにはこの Fake 側で
// 実装が要る**——省略した adapter がどう振る舞うかは `readDecayClock` 等の
// フォールバック自身の歯（`tenant-settings-store.test.ts` 等）が別に持つ。
export class FakeTenantSettingsStore implements TenantSettingsStore {
  private eventRetention: EventRetention = { kind: "unset" };
  private decayClockByTenant = new Map<string, DecayClock>();
  private halfLifeRecallsByTenant = new Map<string, number>();
  /**
   * Issue #201 PR-B（[ADR 0323](../../../docs/decisions/0323-taxonomy-recall-filter.md)）:
   * `tenant_settings.taxonomy_mode` 相当。`decayClockByTenant` と同じ形——
   * `FakeMemoryStore` の `labels`（`FakeBackingStore` 側）とは違い、これを読むのは
   * `TenantSettingsStore` だけなので backing の共有は要らない。
   */
  private taxonomyModeByTenant = new Map<string, TaxonomyMode>();

  constructor(
    private readonly halfLifeHours = 720,
    /**
     * ADR 0165 決めたこと13 末尾の訂正どおり、`activity_seq` を進めるのは
     * `MemoryStore.createRecall`（別 adapter）である。フェイクの世界でその契約
     * （書く側と読む側が同じ値を見る）を再現するために、`FakeMemoryStore` と同じ
     * `FakeBackingStore` を共有する。省略すると `getActivitySeq` は常に `0` を返す
     * ——`tenant_activity` に一度も書かれていないテナントと同じ状態。
     */
    private readonly backing?: FakeBackingStore,
  ) {}

  async getDefaultHalfLifeHours(_ctx: Ctx): Promise<number> {
    return this.halfLifeHours;
  }

  async getEventRetention(_ctx: Ctx): Promise<EventRetention> {
    return this.eventRetention;
  }

  async setEventRetention(_ctx: Ctx, retention: EventRetentionSetting): Promise<void> {
    if (retention.kind === "days") {
      assertValidEventRetentionDays(retention.days);
    }
    this.eventRetention = retention;
  }

  async getDecayClock(ctx: Ctx): Promise<DecayClock> {
    return this.decayClockByTenant.get(ctx.tenantId) ?? DEFAULT_DECAY_CLOCK;
  }

  async setDecayClock(ctx: Ctx, clock: DecayClock): Promise<void> {
    assertValidDecayClock(clock);
    this.decayClockByTenant.set(ctx.tenantId, clock);
  }

  async getDefaultHalfLifeRecalls(ctx: Ctx): Promise<number> {
    return this.halfLifeRecallsByTenant.get(ctx.tenantId) ?? DEFAULT_HALF_LIFE_RECALLS;
  }

  /**
   * ⚠ **この Fake は `TenantSettingsStore.setDefaultHalfLifeRecalls`（[ADR 0197]
   * (../../../docs/decisions/0197-set-default-half-life-recalls.md) が足した、`?` 付きの
   * 本番の書き込み口）を実装していない。**このメソッドは、interface のメソッドとは
   * 別名の、テスト専用の口である——`getDefaultHalfLifeHours` がコンストラクタ引数で
   * 差し替えられるのと同じ役割を、テナントごとに持てるようにしたもの。名前が違うのは
   * 偶然ではなく、`packages/testkit` の `InMemoryTenantSettingsStore` が同じ理由
   * （本番メソッドとの名前衝突）で同名のテスト専用フックを削除したのと対になる決定
   * ——このファイルは適合スイートの対象外（上のコメント参照）なので衝突は起きないが、
   * 読む側の混乱を避けるため命名だけ揃えた（ADR 0197「決めたこと」参照）。
   */
  setDefaultHalfLifeRecallsForTest(tenantId: string, value: number): void {
    this.halfLifeRecallsByTenant.set(tenantId, value);
  }

  /**
   * miku 了承済み（マネージャー経由）: `TenantSettingsStore.setDefaultHalfLifeRecalls`
   * （[ADR 0197](../../../docs/decisions/0197-set-default-half-life-recalls.md) の本番の
   * 書き込み口、interface 上は `?` 付きの任意メソッド）を `packages/postgres`・
   * `packages/testkit` の `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls` と
   * 同じ意味論で実装する。値域は `assertValidHalfLifeRecalls`（core 共有）で検査する。
   *
   * `tenant_settings.default_half_life_recalls` は Postgres の `real`（IEEE 754
   * 単精度・float4）列であり、値域は約 `±3.4028235e38` までしか無い
   * （`migrations/0015_decay_activity_clock.sql` の CHECK 制約）。`assertValidHalfLifeRecalls`
   * の値域 `(0, ∞)` は JS の float64 では有限でも、float4 の範囲を超える値
   * （例: `1e300`）は Postgres 側で `real` への変換時に `Infinity` へ丸まり、CHECK
   * 制約違反の例外になる（実測。`in-memory-fixtures-half-life-recalls-float4-overflow.test.ts`
   * と同じ形・同じ `Math.fround` の境界判定）。
   */
  async setDefaultHalfLifeRecalls(ctx: Ctx, recalls: number): Promise<void> {
    assertValidHalfLifeRecalls(recalls);
    if (!Number.isFinite(Math.fround(recalls))) {
      throw new Error(
        `setDefaultHalfLifeRecalls: recalls does not fit in a Postgres "real" (float4) column (got ${recalls})`,
      );
    }
    this.halfLifeRecallsByTenant.set(ctx.tenantId, recalls);
  }

  async getActivitySeq(ctx: Ctx): Promise<number> {
    if (this.backing === undefined) return 0;
    return this.backing.activitySeq.get(ctx.tenantId) ?? 0;
  }

  /**
   * Issue #201 PR-B（ADR 0323）: `getTaxonomyMode?`（`InMemoryTenantSettingsStore` と
   * 同じ契約）。未設定のテナントは `DEFAULT_TAXONOMY_MODE`（`'open'`）。
   */
  async getTaxonomyMode(ctx: Ctx): Promise<TaxonomyMode> {
    return this.taxonomyModeByTenant.get(ctx.tenantId) ?? DEFAULT_TAXONOMY_MODE;
  }

  /**
   * Issue #201 PR-B（ADR 0323）: `setTaxonomyMode?`（`InMemoryTenantSettingsStore` と
   * 同じ契約）。
   */
  async setTaxonomyMode(ctx: Ctx, mode: TaxonomyMode): Promise<void> {
    assertValidTaxonomyMode(mode);
    this.taxonomyModeByTenant.set(ctx.tenantId, mode);
  }
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly space: EmbeddingSpaceId = { provider: "fake", model: "fake-model", dimensions: 2 };
  shouldFail = false;

  /**
   * ADR 0142 の「tick はリース競合が起きても他のジョブの処理を続ける」歯のための、
   * 決定的な差し込みフック（`FakeMemoryStore.beforeUpdateStatus`、ADR 0030と同じ形）。
   * `embed()` が値を返す直前に呼ばれる——`processEmbedJob` が
   * `deps.outboxStore.complete(...)` を呼ぶより前の、まさにその隙間を指す。
   * ここで（テストコードから）別ワーカーの再 claim を直接起こすことで、
   * 「処理には成功したが complete しようとした時点でリースを失っていた」を
   * 確率的な並行に頼らず毎回同じ形で再現できる。
   */
  beforeEmbedReturn?: () => Promise<void> | void;

  async embed(_ctx: Ctx, texts: string[]): Promise<number[][]> {
    if (this.shouldFail) {
      throw new Error("simulated embedding provider failure");
    }
    if (this.beforeEmbedReturn) {
      await this.beforeEmbedReturn();
    }
    // 決定的: 文字列長から機械的にベクトルを作る。
    return texts.map((text) => [text.length, [...text].filter((c) => c === "a").length]);
  }
}

export function createFakeRuntimeStores(): {
  memoryStore: FakeMemoryStore;
  outboxStore: FakeOutboxStore;
  vectorStore: FakeVectorStore;
  /**
   * 語彙チャンネル（ADR 0084、Issue #106）。**常に生成する**が、`RuntimeDeps.lexicalStore` へ
   * 配線するかどうかは呼び出し側（各テストの `createRuntime` 呼び出し）の裁量——
   * 配線しない歯（`recall-channels.test.ts` 歯④）は、この値を単に渡さないだけでよい。
   */
  lexicalStore: FakeLexicalStore;
  eventStore: FakeEventStore;
  tenantSettingsStore: FakeTenantSettingsStore;
  embeddingProvider: FakeEmbeddingProvider;
} {
  const backing = new FakeBackingStore();
  return {
    memoryStore: new FakeMemoryStore(backing),
    outboxStore: new FakeOutboxStore(backing),
    vectorStore: new FakeVectorStore(backing),
    lexicalStore: new FakeLexicalStore(backing),
    eventStore: new FakeEventStore(backing),
    // `backing` を共有することで、`createRecall({advanceActivityClock: true})` が進めた
    // `activity_seq` を `getActivitySeq` が同じ値として読み戻せる（上のクラス doc 参照）。
    tenantSettingsStore: new FakeTenantSettingsStore(720, backing),
    embeddingProvider: new FakeEmbeddingProvider(),
  };
}
