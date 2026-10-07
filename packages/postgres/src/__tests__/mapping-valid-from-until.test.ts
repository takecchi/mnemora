import { describe, expect, it } from "vitest";
import { rowToMemory, type MemoryRow } from "../mapping.js";

function baseRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    tenant_id: "tenant-1",
    subject_id: null,
    source_observation_id: null,
    extractor_version: null,
    content: "本文",
    content_hash: "hash-1",
    digest: "digest",
    digest_source: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    status: "active",
    superseded_by_id: null,
    contested_with_id: null,
    tags: [],
    occurred_at: null,
    recorded_at: "2026-01-01 00:00:00+00",
    last_reinforced_at: null,
    valid_from: null,
    valid_until: null,
    claim_key_subject: null,
    claim_key_predicate: null,
    strength: 1,
    half_life_hours: 720,
    decay_floor_at: "2026-06-01 00:00:00+00",
    decay_base_seq: null,
    decay_floor_seq: null,
    half_life_recalls: null,
    embedding_status: "pending",
    purged_at: null,
    attributes: {},
    created_at: "2026-01-01 00:00:00+00",
    updated_at: "2026-01-01 00:00:00+00",
    ...overrides,
  };
}

describe("rowToMemory — valid_from/valid_until（Issue #202、ADR 0145）", () => {
  it("valid_from/valid_until が非 null なら Date に変換する", () => {
    const memory = rowToMemory(
      baseRow({
        valid_from: "2025-01-01 00:00:00+00",
        valid_until: "2025-12-31 23:59:59+00",
      }),
    );
    expect(memory.validFrom).toBeInstanceOf(Date);
    expect(memory.validUntil).toBeInstanceOf(Date);
    expect(memory.validFrom?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(memory.validUntil?.toISOString()).toBe("2025-12-31T23:59:59.000Z");
  });

  it("valid_from/valid_until が null なら null のまま返す", () => {
    const memory = rowToMemory(baseRow({ valid_from: null, valid_until: null }));
    expect(memory.validFrom).toBeNull();
    expect(memory.validUntil).toBeNull();
  });

  it("occurred_at と valid_from/valid_until を混同しない — 3つの列がそれぞれ独立に変換される", () => {
    const memory = rowToMemory(
      baseRow({
        occurred_at: "2024-06-01 00:00:00+00",
        valid_from: "2025-01-01 00:00:00+00",
        valid_until: "2025-12-31 23:59:59+00",
      }),
    );
    expect(memory.occurredAt?.toISOString()).toBe("2024-06-01T00:00:00.000Z");
    expect(memory.validFrom?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(memory.validUntil?.toISOString()).toBe("2025-12-31T23:59:59.000Z");
  });
});
