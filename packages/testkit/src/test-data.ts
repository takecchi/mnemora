import { defaultDecayStrategy } from "@mnemora/core";
import type {
  NewMemory,
  NewMemoryEvent,
  NewObservation,
  Provenance,
  ProvenanceKind,
} from "@mnemora/core";

/**
 * 適合テスト（および testkit 自身の自己テスト）で使う、妥当な `NewMemory` のひな型。
 * 実際の adapter 実装向けではなく、テストデータの生成専用。
 *
 * [ADR 0165](../../../docs/decisions/0165-decay-activity-clock.md)（Issue #305）:
 * 活動時計の3つ組（`decayBaseSeq`/`decayFloorSeq`/`halfLifeRecalls`）は `base` に含めない
 * ——`overrides` で明示的に渡さない限り `undefined`（＝「この軸には床が無い」、ADR 0165
 * 決めたこと4）のままになる。壁時計の3つ組（`strength`/`halfLifeHours`/`decayFloorAt`）と
 * 違い、活動時計側は既定で「未使用」を表すのが正しい既定値であるため、計算済みの値を
 * `base` へ持たせない。
 *
 * ⚠ **既定の `recordedAt`（`2026-01-01T00:00:00.000Z` 固定）は、既定の `halfLifeHours`
 * （720h）・`strength`（1）と組むと、`decayFloorAt` が `defaultDecayStrategy.floorAt`
 * （`halfLifeHours × log2(strength / DEFAULT_DECAY_THRESHOLD)` = `720 × log2(1/0.05)`
 * 時間後）で **`2026-05-10T15:47Z`** になる。この既定値そのものは変えない——
 * ここに書かれている以上、変えるのはこの doc コメントの主張が崩れたときだけである。**
 *
 * ⟹ **その日以降に、実時計（あるいは今日の日付の偽時計）で `recall()` を通すと、
 * 段1の忘却ゲート（[ADR 0153](../../../docs/decisions/0153-recall-decay-floor-gate.md)）で
 * 候補が0件になる。** エラーにはならず、黙って0件で出る——`explain.stages
 * .candidate_generation.hits: 0` を実際に読まない限り気づけない
 * （[Issue #731](https://github.com/takecchi/mnemora/issues/731)・
 * [ADR 0310](../../../docs/decisions/0310-subject-crossing-consolidate-frequency-measured.md)
 * が実測で踏んだ経路）。
 *
 * ⟹ **実時計（あるいは今日付の偽時計）で `recall()` を通すフィクスチャは、
 * `recordedAt`（必要なら `decayFloorAt` も）を明示して渡すこと。** 渡さなければ、
 * この関数の既定値のまま床を越え、上の0件が起きる。
 */
export function buildNewMemoryFixture(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? new Date("2026-01-01T00:00:00.000Z");
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? 720;
  const base: NewMemory = {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "テスト用の本文",
    contentHash: "fixture-hash-1",
    digest: "テスト用の要旨",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture-batch" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
  };
  return { ...base, ...overrides };
}

/**
 * `ProvenanceKind` から、その kind に妥当な `Provenance` フィクスチャを組み立てる
 * （ADR 0056）。`vector-store-conformance.ts` の `excludeProvenanceKinds` の歯が使う。
 *
 * **`"stated"`/`"inferred"` は意図的にサポートしない。** `memories` の CHECK 制約
 * （`packages/postgres/migrations/0001_init.sql:68`、
 * `CHECK (provenance_kind NOT IN ('stated','inferred') OR source_observation_id IS NOT NULL)`）
 * により、この2つは実在する Observation を指す `source_observation_id` を要求する——
 * このフィクスチャはそこまで用意しない（`buildNewMemoryFixture` の `sourceObservationId`
 * 既定値は `null`）。実在の Observation を紐づけたいテストは、この関数を使わず個別に
 * `Provenance` を組み立てること。
 */
export function buildProvenanceFixture(kind: ProvenanceKind): Provenance {
  switch (kind) {
    case "consolidated":
      return { kind: "consolidated", sources: ["fixture-source-memory"] };
    case "reflected":
      return { kind: "reflected" };
    case "imported":
      return { kind: "imported", batchId: "fixture-batch" };
    case "stated":
    case "inferred":
      throw new Error(
        `buildProvenanceFixture: "${kind}" is not supported — it requires a real sourceObservationId (CHECK constraint). See the doc comment.`,
      );
  }
}

export function buildNewObservationFixture(
  overrides: Partial<NewObservation> = {},
): NewObservation {
  return {
    tenantId: "tenant-1",
    subjectId: null,
    externalId: null,
    kind: "utterance",
    payload: { text: "テスト用の発話" },
    occurredAt: null,
    ...overrides,
  };
}

/**
 * `memoryId` の既定は `null` にする。docs/memory-model.md §9 の DDL では
 * `memory_events.memory_id` が `memories(id)` への外部キーであり（`events_purged` の場合のみ
 * NULL、という制約はあるが、それ以外の kind で NULL であること自体は妨げない）、実在しない
 * `memories` 行を指す固定文字列を既定値にすると、外部キー制約を持つ実装（`packages/postgres`）
 * に対して常に失敗する。「実在する Memory に紐づく監査ログ」を検査したいテストは
 * `EventStoreConformanceOptions.prepareMemoryId`（adapter が実在の Memory を用意して id を
 * 返すフック）を使う。
 */
export function buildNewMemoryEventFixture(
  overrides: Partial<NewMemoryEvent> = {},
): NewMemoryEvent {
  return {
    tenantId: "tenant-1",
    memoryId: null,
    kind: "created",
    actor: { type: "system" },
    digestSnapshot: null,
    sizeBeforeBytes: null,
    meta: {},
    ...overrides,
  };
}
