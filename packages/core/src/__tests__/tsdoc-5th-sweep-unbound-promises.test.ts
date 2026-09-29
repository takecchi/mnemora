import { describe, expect, it } from "vitest";
import { decideAnnTruncation } from "../ann-truncation.js";
import { computeEventRetentionCutoff } from "../event-retention-purge.js";
import { buildNewMemoryFromCandidate } from "../extraction.js";
import type { Memory } from "../memory.js";
import type { Observation } from "../observation.js";
import { validateRecallOutput } from "../recall-output-validation.js";
import { classifyReextractTargets } from "../strategies/reextract.js";
import { defaultScoringStrategy } from "../strategies/scoring.js";

/**
 * TSDoc の5巡目の調査で、約束どおりに動くがどのテストも縛っていなかった振る舞いを縛る（B1〜B5 の core の分）。
 * 今の振る舞いの固定であり、望ましい姿の主張ではない。
 */

/**
 * ⚠ 2026-09-29 追記（Issue #1232、ADR 0354）: この B1 は元々
 * `purgeExpiredEventsForTenant` を通して cutoff の計算を縛っていた——当時はこの関数自身が
 * `olderThan` を計算し、`MemoryStore.purgeExpiredEvents` へ渡していたため。Issue #1232 の
 * 修正でこの計算は `computeEventRetentionCutoff`（`purgeExpiredEventsForTenant` と同じファイル、
 * `MemoryStore.purgeExpiredEventsByRetention?` を実装する各 adapter が共有する）へ切り出され、
 * `purgeExpiredEventsForTenant` 自身はもう `olderThan` を計算しない。**縛る対象を、抽出した
 * 純関数そのものへ動かした**——振る舞いは変えていない（`event-retention-purge.ts` の
 * `computeEventRetentionCutoff` の doc コメント参照）。
 */
describe("computeEventRetentionCutoff: 日数が Date の範囲を越えるときの cutoff（B1）", () => {
  const NOW = new Date("2026-09-28T00:00:00.000Z");

  it("約1億日を越える日数では Invalid Date にならず、表せる最も古い時刻（-8.64e15 ms）を渡す", () => {
    const olderThan = computeEventRetentionCutoff(NOW, 1e9);
    expect(Number.isNaN(olderThan.getTime())).toBe(false);
    expect(olderThan.getTime()).toBe(-8.64e15);
  });

  it("陽性対照: 範囲に収まる日数では now から days 日ぶん遡った時刻を返す", () => {
    const olderThan = computeEventRetentionCutoff(NOW, 30);
    expect(olderThan.toISOString()).toBe("2026-08-29T00:00:00.000Z");
  });
});

describe("buildNewMemoryFromCandidate（B2）", () => {
  const observation = {
    id: "obs-1",
    tenantId: "t",
    subjectId: "subject-of-observation",
    kind: "utterance",
    payload: { text: "x" },
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
  } as Observation;
  const base = {
    ctx: { tenantId: "t" },
    observation,
    hashContent: (content: string) => `hash(${content})`,
    extractorVersion: "v1",
    llmModelId: "model",
    promptVersion: "p1",
    halfLifeHours: 720,
    now: new Date("2026-01-01T00:00:00.000Z"),
    digestFallbackLength: 40,
  };
  const stated = { content: "本文", provenanceKind: "stated" as const };

  it.each([
    ["activitySeq だけ", { activitySeq: 5 }],
    ["halfLifeRecalls だけ", { halfLifeRecalls: 720 }],
  ])("%s を渡しても、活動時計の3つ組は作られない（両方揃ったときだけ）", (_label, extra) => {
    const memory = buildNewMemoryFromCandidate({ ...base, candidate: stated, ...extra });
    expect([memory.decayBaseSeq, memory.decayFloorSeq, memory.halfLifeRecalls]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("陽性対照: 両方揃えば3つ組が作られる", () => {
    const memory = buildNewMemoryFromCandidate({
      ...base,
      candidate: stated,
      activitySeq: 5,
      halfLifeRecalls: 720,
    });
    expect(memory.decayBaseSeq).toBe(5);
    expect(memory.halfLifeRecalls).toBe(720);
    expect(typeof memory.decayFloorSeq).toBe("number");
  });

  it("候補の subjectId: null（明示的な「主題なし」）は、observation の主題があってもそのまま通す", () => {
    const memory = buildNewMemoryFromCandidate({
      ...base,
      candidate: { ...stated, subjectId: null },
    });
    expect(memory.subjectId).toBeNull();
  });

  it("陽性対照: 候補が subjectId を省けば observation の主題に落ちる", () => {
    const memory = buildNewMemoryFromCandidate({ ...base, candidate: stated });
    expect(memory.subjectId).toBe("subject-of-observation");
  });
});

describe("decideAnnTruncation: ANN の最後の similarity が0以下なら判定不能（B3）", () => {
  const base = {
    strategy: defaultScoringStrategy,
    queryTags: [],
    lastReturnedTotal: 0.5,
    scoreThreshold: 0.1,
  };

  it.each([0, -0.2])(
    "lastAnnSimilarity = %s → undecidable（上界の不等式が total の順序を保証しない）",
    (sim) => {
      expect(decideAnnTruncation({ ...base, lastAnnSimilarity: sim }).kind).toBe("undecidable");
    },
  );

  it("陽性対照: 正の similarity なら判定できる（undecidable ではない）", () => {
    expect(decideAnnTruncation({ ...base, lastAnnSimilarity: 0.5 }).kind).not.toBe("undecidable");
  });
});

describe("validateRecallOutput: draft を書き換えない（B4）", () => {
  it.each(["report", "throw"] as const)(
    "mode: %s でも、検証の前後で draft の値は変わらない",
    (mode) => {
      const draft = {
        recallId: "r1",
        memories: [],
        omitted: [],
        usage: { chars: -1, extra: "unknown key" },
        unknownTopLevel: { nested: [1, 2, 3] },
      };
      const before = structuredClone(draft);
      try {
        validateRecallOutput(draft, mode, "r1");
      } catch {
        // throw モードでは落ちる。値が変わっていないことだけを見る。
      }
      expect(draft).toEqual(before);
    },
  );
});

describe("classifyReextractTargets（B5）", () => {
  const memory = (id: string, status: Memory["status"], contentHash: string) =>
    ({ id, status, contentHash }) as Memory;

  it("active 以外は status 付きで飛ばし、今回も作られた hash は unchanged、残りを supersede する（入力の順を保つ）", () => {
    const result = classifyReextractTargets(
      [
        memory("m1", "forgotten", "h1"),
        memory("m2", "active", "kept"),
        memory("m3", "contested", "h3"),
        memory("m4", "active", "old"),
        memory("m5", "superseded", "kept"),
      ],
      new Set(["kept"]),
    );
    expect(result.skipped).toEqual([
      { kind: "status_not_active", memoryId: "m1", status: "forgotten" },
      { kind: "unchanged", memoryId: "m2" },
      { kind: "status_not_active", memoryId: "m3", status: "contested" },
      { kind: "status_not_active", memoryId: "m5", status: "superseded" },
    ]);
    expect(result.toSupersede.map((m) => m.id)).toEqual(["m4"]);
  });

  it("空の入力は空の結果", () => {
    expect(classifyReextractTargets([], new Set(["x"]))).toEqual({ toSupersede: [], skipped: [] });
  });
});
