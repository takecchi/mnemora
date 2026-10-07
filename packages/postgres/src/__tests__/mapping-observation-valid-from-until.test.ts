import { describe, expect, it } from "vitest";
import { rowToObservation, type ObservationRow } from "../mapping.js";

function baseRow(overrides: Partial<ObservationRow> = {}): ObservationRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    tenant_id: "tenant-1",
    subject_id: null,
    external_id: null,
    kind: "utterance",
    payload: { text: "本文" },
    occurred_at: null,
    recorded_at: "2026-01-01 00:00:00+00",
    valid_from: null,
    valid_until: null,
    attributes: {},
    ...overrides,
  };
}

describe("rowToObservation — valid_from/valid_until（Issue #280、Issue #202 第2弾）", () => {
  it("valid_from/valid_until が非 null なら Date に変換する", () => {
    const observation = rowToObservation(
      baseRow({
        valid_from: "2025-01-01 00:00:00+00",
        valid_until: "2025-12-31 23:59:59+00",
      }),
    );
    expect(observation.validFrom).toBeInstanceOf(Date);
    expect(observation.validUntil).toBeInstanceOf(Date);
    expect(observation.validFrom?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(observation.validUntil?.toISOString()).toBe("2025-12-31T23:59:59.000Z");
  });

  it("valid_from/valid_until が null なら null のまま返す", () => {
    const observation = rowToObservation(baseRow({ valid_from: null, valid_until: null }));
    expect(observation.validFrom).toBeNull();
    expect(observation.validUntil).toBeNull();
  });

  it("occurred_at と valid_from/valid_until を混同しない — 3つの列がそれぞれ独立に変換される", () => {
    const observation = rowToObservation(
      baseRow({
        occurred_at: "2024-06-01 00:00:00+00",
        valid_from: "2025-01-01 00:00:00+00",
        valid_until: "2025-12-31 23:59:59+00",
      }),
    );
    expect(observation.occurredAt?.toISOString()).toBe("2024-06-01T00:00:00.000Z");
    expect(observation.validFrom?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(observation.validUntil?.toISOString()).toBe("2025-12-31T23:59:59.000Z");
  });
});
