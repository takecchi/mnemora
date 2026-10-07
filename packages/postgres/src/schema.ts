import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle のテーブル定義（docs/memory-model.md §10）。クエリビルダに型を与えるためだけにあり、スキーマの生成には使わない。
 * テーブル・索引の実体は `migrations/` の手書き DDL が作り、ここの `CHECK` 制約や `DEFAULT` の宣言はドキュメントでしかない
 * （二重管理は、`drizzle-kit push` の operator class 欠落バグを踏まないための意図的なトレードオフ。ADR 0001）。
 * `memory_embeddings_<space>` は空間ごとに動的に増えるので定義しない（`vector-space.ts` が生 SQL で扱う）。
 */

export const observations = pgTable("observations", {
  id: uuid("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  subjectId: text("subject_id"),
  externalId: text("external_id"),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }),
  validUntil: timestamp("valid_until", { withTimezone: true, mode: "date" }),
});

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subjectId: text("subject_id"),

    sourceObservationId: uuid("source_observation_id"),
    extractorVersion: text("extractor_version"),

    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    digest: text("digest").notNull(),
    digestSource: text("digest_source").notNull(),

    /**
     * `provenance.kind`（jsonb 側が正）と意図して二重に持つ、書き込み専用の列（ADR 0117）。
     * `rowToMemory` はこの列を読み戻さない。役割はフィルタ述語で、`excludeProvenanceKinds` が
     * `provenance_kind <> ALL(...)` で直接引き、`idx_memories_provenance_kind` に載せるためにある。
     * 読み戻す側が増えると、jsonb とこの列のずれが結果へ静かに混入する経路ができるので、増やさない。
     */
    provenanceKind: text("provenance_kind").notNull(),
    provenance: jsonb("provenance").notNull(),

    status: text("status").notNull(),
    supersededById: uuid("superseded_by_id"),
    contestedWithId: uuid("contested_with_id"),

    tags: text("tags").array().notNull(),

    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
    lastReinforcedAt: timestamp("last_reinforced_at", { withTimezone: true, mode: "date" }),
    validFrom: timestamp("valid_from", { withTimezone: true, mode: "date" }), // Phase 2
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "date" }), // Phase 2

    strength: real("strength").notNull(),
    halfLifeHours: real("half_life_hours").notNull(),
    decayFloorAt: timestamp("decay_floor_at", { withTimezone: true, mode: "date" }).notNull(),

    decayBaseSeq: bigint("decay_base_seq", { mode: "number" }),
    decayFloorSeq: bigint("decay_floor_seq", { mode: "number" }),
    halfLifeRecalls: real("half_life_recalls"),

    embeddingStatus: text("embedding_status").notNull(),

    purgedAt: timestamp("purged_at", { withTimezone: true, mode: "date" }), // Issue #198 / ADR 0124

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [index("idx_memories_by_subject").on(table.tenantId, table.subjectId, table.status)],
);

export const memoryEvents = pgTable("memory_events", {
  id: uuid("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  memoryId: uuid("memory_id"),
  kind: text("kind").notNull(),
  at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
  actor: jsonb("actor").notNull(),
  digestSnapshot: text("digest_snapshot"),
  sizeBeforeBytes: integer("size_before_bytes"),
  meta: jsonb("meta").notNull(),
});

export const recalls = pgTable("recalls", {
  id: uuid("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  subjectId: text("subject_id"),
  query: jsonb("query").notNull(),
  budget: jsonb("budget"),
  omitted: jsonb("omitted").notNull(),
  usage: jsonb("usage").notNull(),
  indexBand: jsonb("index_band").notNull(),
  explain: jsonb("explain").notNull(),
  returnedMemories: jsonb("returned_memories").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
});

export const recallUsages = pgTable(
  "recall_usages",
  {
    tenantId: text("tenant_id").notNull(),
    recallId: uuid("recall_id").notNull(),
    memoryId: uuid("memory_id").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.recallId, table.memoryId] })],
);

export const outbox = pgTable("outbox", {
  id: uuid("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  availableAt: timestamp("available_at", { withTimezone: true, mode: "date" }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
  claimedBy: text("claimed_by"),
  attempts: integer("attempts").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
});

export const tenantSettings = pgTable("tenant_settings", {
  tenantId: text("tenant_id").primaryKey(),
  defaultHalfLifeHours: real("default_half_life_hours").notNull(),
  eventRetentionDays: integer("event_retention_days"),
  taxonomyMode: text("taxonomy_mode").notNull(),
  decayClock: text("decay_clock").notNull(),
  defaultHalfLifeRecalls: real("default_half_life_recalls").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});

/** テナントごとに1行の活動カウンタ。`tenant_settings` に相乗りさせない（recall のたびの UPDATE が設定の読み出しまで行ロックで待たせるため。ADR 0165）。 */
export const tenantActivity = pgTable("tenant_activity", {
  tenantId: text("tenant_id").primaryKey(),
  activitySeq: bigint("activity_seq", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
});

/** taxonomy の語彙（docs/memory-model.md §8）。`UNIQUE (tenant_id, name)` は migration 側で宣言する。 */
export const labels = pgTable("labels", {
  id: uuid("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  proposedCount: integer("proposed_count").notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
});

/** Memory と label の多対多の結び付け。 */
export const memoryLabels = pgTable(
  "memory_labels",
  {
    tenantId: text("tenant_id").notNull(),
    memoryId: uuid("memory_id").notNull(),
    labelId: uuid("label_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.memoryId, table.labelId] })],
);
