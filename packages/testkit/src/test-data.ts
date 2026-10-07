import { DEFAULT_HALF_LIFE_HOURS, defaultDecayStrategy } from "@mnemora/core";
import type {
  NewMemory,
  NewMemoryEvent,
  NewObservation,
  Provenance,
  ProvenanceKind,
} from "@mnemora/core";

/**
 * 適合テスト（と testkit 自身の自己テスト）で使う、妥当な `NewMemory` のひな型。テストデータの生成専用。
 *
 * 活動時計の3つ組（`decayBaseSeq`/`decayFloorSeq`/`halfLifeRecalls`）は含めない。`overrides` で渡さない限り `undefined`（床が無い）。
 *
 * ⚠ 既定の `recordedAt`（`2026-01-01T00:00:00.000Z` 固定）は、既定の `halfLifeHours`（720h）・`strength`（1）と組むと
 * `decayFloorAt` が `2026-05-10T15:47Z` になる。実時計（または今日付の偽時計）で `recall()` を通すフィクスチャは、
 * `recordedAt`（必要なら `decayFloorAt` も）を明示すること。渡さないと忘却ゲートで候補が黙って0件になる。
 */
export function buildNewMemoryFixture(overrides: Partial<NewMemory> = {}): NewMemory {
  const recordedAt = overrides.recordedAt ?? new Date("2026-01-01T00:00:00.000Z");
  const strength = overrides.strength ?? 1;
  const halfLifeHours = overrides.halfLifeHours ?? DEFAULT_HALF_LIFE_HOURS;
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
    // `decayFloorAt` を上書きするときは計算しない: `decayFloorOffset` が壊れた `strength` を断るので、値域の歯が壊れた値を渡せなくなる。
    decayFloorAt:
      overrides.decayFloorAt ??
      defaultDecayStrategy.floorAt({
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
 * `ProvenanceKind` に妥当な `Provenance` のフィクスチャ。
 * `"stated"`/`"inferred"` は非対応: `memories` の CHECK 制約が実在の Observation を指す `source_observation_id` を要求し、
 * このフィクスチャはそこまで用意しない。必要なテストは個別に組み立てること。
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

/**
 * テスト用の `NewObservation` を作る。既定は `tenantId: "tenant-1"`・`kind: "utterance"`・`payload: { text: "テスト用の発話" }`、
 * `subjectId`・`externalId`・`occurredAt` は `null`。`overrides` で渡した欄だけを上書きする（浅いマージ）。
 */
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

/** `memoryId` の既定は `null`: 実在しない行を指す固定文字列だと、外部キー制約を持つ実装で常に失敗する。実在の Memory に紐づけるときは `EventStoreConformanceOptions.prepareMemoryId` を使う。 */
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
