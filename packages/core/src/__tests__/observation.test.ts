import { describe, expect, it } from "vitest";
import {
  NewObservationSchema,
  ObservationSchema,
  ObserveInputSchema,
  observeInputKindToObservationKind,
} from "../observation.js";

describe("ObservationSchema / NewObservationSchema", () => {
  it("accepts 完全な Observation", () => {
    const result = ObservationSchema.safeParse({
      id: "obs-1",
      tenantId: "tenant-1",
      subjectId: null,
      externalId: null,
      kind: "utterance",
      payload: { text: "hello" },
      occurredAt: null,
      recordedAt: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects tenantId を欠く Observation", () => {
    const result = ObservationSchema.safeParse({
      id: "obs-1",
      kind: "utterance",
      payload: {},
      recordedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it("NewObservation は id / recordedAt を省略できる", () => {
    const result = NewObservationSchema.safeParse({
      tenantId: "tenant-1",
      kind: "event",
      payload: {},
    });
    expect(result.success).toBe(true);
  });

  it("NewObservation も kind が無ければ弾く", () => {
    const result = NewObservationSchema.safeParse({
      tenantId: "tenant-1",
      payload: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("ObserveInputSchema — 各 kind ごとに 1 本ずつ", () => {
  it("accepts kind: 'utterance'", () => {
    const result = ObserveInputSchema.safeParse({ kind: "utterance", text: "こんにちは" });
    expect(result.success).toBe(true);
  });

  it("rejects kind: 'utterance' が text を欠く場合", () => {
    const result = ObserveInputSchema.safeParse({ kind: "utterance" });
    expect(result.success).toBe(false);
  });

  it("accepts kind: 'event'", () => {
    const result = ObserveInputSchema.safeParse({ kind: "event", name: "signed_up" });
    expect(result.success).toBe(true);
  });

  it("rejects kind: 'event' が name を欠く場合", () => {
    const result = ObserveInputSchema.safeParse({ kind: "event", data: {} });
    expect(result.success).toBe(false);
  });

  it("accepts kind: 'document'", () => {
    const result = ObserveInputSchema.safeParse({ kind: "document", content: "本文" });
    expect(result.success).toBe(true);
  });

  it("rejects kind: 'document' が content を欠く場合", () => {
    const result = ObserveInputSchema.safeParse({ kind: "document", title: "t" });
    expect(result.success).toBe(false);
  });

  it("accepts kind: 'memory_usage'", () => {
    const result = ObserveInputSchema.safeParse({
      kind: "memory_usage",
      recallId: "rcl-1",
      usedMemoryIds: ["m1", "m2"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects kind: 'memory_usage' の usedMemoryIds が空配列", () => {
    const result = ObserveInputSchema.safeParse({
      kind: "memory_usage",
      recallId: "rcl-1",
      usedMemoryIds: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects 未知の kind", () => {
    const result = ObserveInputSchema.safeParse({ kind: "not_a_real_kind" });
    expect(result.success).toBe(false);
  });

  it("既定の extract は明示しなくても入力として妥当（既定値の適用は runtime 側の責務）", () => {
    const result = ObserveInputSchema.safeParse({ kind: "utterance", text: "hi" });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "utterance") {
      expect(result.data.extract).toBeUndefined();
    }
  });
});

/**
 * Issue #608 項目②(b): `subjectCandidates` はスキーマの時点では素通しする
 * （空配列の意味づけ・deferred との組み合わせの検証は `runtime.observe` 側の責務。
 * `runtime.test.ts`「observe: subjectCandidates（Issue #608 項目②(b)）」参照）。
 */
describe("ObserveInputSchema — subjectCandidates（Issue #608 項目②(b)）", () => {
  it("utterance / event / document のいずれでも省略できる（既定は undefined）", () => {
    for (const input of [
      { kind: "utterance", text: "hi" },
      { kind: "event", name: "signed_up" },
      { kind: "document", content: "本文" },
    ] as const) {
      const result = ObserveInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success && result.data.kind !== "memory_usage") {
        expect(result.data.subjectCandidates).toBeUndefined();
      }
    }
  });

  it("空配列を受け付ける", () => {
    const result = ObserveInputSchema.safeParse({
      kind: "utterance",
      text: "hi",
      subjectCandidates: [],
    });
    expect(result.success).toBe(true);
  });

  it("非空の候補一覧を受け付ける", () => {
    const result = ObserveInputSchema.safeParse({
      kind: "utterance",
      text: "hi",
      subjectCandidates: ["user:a", "user:b"],
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "utterance") {
      expect(result.data.subjectCandidates).toEqual(["user:a", "user:b"]);
    }
  });

  it("空文字の候補は、他の subject 系文字列欄と同じ min(1) 規約で弾く", () => {
    const result = ObserveInputSchema.safeParse({
      kind: "utterance",
      text: "hi",
      subjectCandidates: [""],
    });
    expect(result.success).toBe(false);
  });
});

describe("observeInputKindToObservationKind — 4つの分岐すべて", () => {
  it("'utterance' -> 'utterance'", () => {
    expect(observeInputKindToObservationKind("utterance")).toBe("utterance");
  });

  it("'event' -> 'event'", () => {
    expect(observeInputKindToObservationKind("event")).toBe("event");
  });

  it("'document' -> 'document'", () => {
    expect(observeInputKindToObservationKind("document")).toBe("document");
  });

  it("'memory_usage' -> 'usage'（D の要求どおり DB 列名に変換される）", () => {
    expect(observeInputKindToObservationKind("memory_usage")).toBe("usage");
  });
});
