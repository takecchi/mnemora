import { describe, expect, it } from "vitest";
import {
  buildNewMemoryEventFixture,
  buildNewObservationFixture,
  buildProvenanceFixture,
} from "../test-data.js";

describe("buildNewObservationFixture: TSDoc に書いた既定値と、浅いマージ", () => {
  it("何も渡さなければ、TSDoc に書いた既定値どおりの NewObservation を返す", () => {
    expect(buildNewObservationFixture()).toEqual({
      tenantId: "tenant-1",
      subjectId: null,
      externalId: null,
      kind: "utterance",
      payload: { text: "テスト用の発話" },
      occurredAt: null,
    });
  });

  it("payload を渡すと、既定の payload と混ぜずに丸ごと置き換える（浅いマージ）", () => {
    const observation = buildNewObservationFixture({ payload: { title: "題" } });
    expect(observation.payload).toEqual({ title: "題" });
  });
});

describe("buildNewMemoryEventFixture: memoryId の既定は null", () => {
  it("何も渡さなければ memoryId は null", () => {
    expect(buildNewMemoryEventFixture().memoryId).toBeNull();
  });
});

describe("buildProvenanceFixture: stated・inferred は作らずに投げる", () => {
  it.each(["stated", "inferred"] as const)(
    "%s は例外を投げ、別の種類の provenance を返さない",
    (kind) => {
      expect(() => buildProvenanceFixture(kind)).toThrow(/is not supported/);
    },
  );

  it.each(["consolidated", "reflected", "imported"] as const)(
    "%s は同じ kind の provenance を返す",
    (kind) => {
      expect(buildProvenanceFixture(kind).kind).toBe(kind);
    },
  );
});
