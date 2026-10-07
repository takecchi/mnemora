import { describe, expect, it } from "vitest";
import type { Ctx, Memory, MemoryStore, Observation, RecallResult } from "@mnemora/core";
import { resultContainsObservation } from "../provenance-trace.js";
import { buildMnemoraPrompt } from "../mnemora-path.js";

// testkit の InMemoryMemoryStore は公開 API ではないので使わない。get/getObservation だけの最小の fake を自作する。

const ctx: Ctx = { tenantId: "provenance-trace-test" };

const TARGET_EXTERNAL_ID = "ext-fact-statement";
const OTHER_EXTERNAL_ID = "ext-unrelated";

function buildFakeMemoryStore(
  memories: Record<string, Pick<Memory, "sourceObservationId"> & { digest: string }>,
  observations: Record<string, Pick<Observation, "externalId">>,
): MemoryStore {
  return {
    get: async (_ctx: Ctx, id: string) => {
      const m = memories[id];
      if (!m) return null;
      return { id, digest: m.digest, sourceObservationId: m.sourceObservationId } as Memory;
    },
    getObservation: async (_ctx: Ctx, id: string) => {
      const o = observations[id];
      if (!o) return null;
      return { id, externalId: o.externalId } as Observation;
    },
  } as unknown as MemoryStore;
}

describe("resultContainsObservation: 出典到達は digest の中身に依らない（Issue #496）", () => {
  it("答えの情報を欠く digest・答えをそのまま含む digest・別の出典の3件を並べ、区別しているのが出典だけであることを示す", async () => {
    const memoryStore = buildFakeMemoryStore(
      {
        "mem-info-lost": {
          digest: "[要約失敗。内容は保持していません]",
          sourceObservationId: "obs-target",
        },
        "mem-info-kept": {
          digest: "私の好きな色は青です。",
          sourceObservationId: "obs-target",
        },
        "mem-other-source": {
          digest: "私の好きな色は青です。",
          sourceObservationId: "obs-other",
        },
      },
      {
        "obs-target": { externalId: TARGET_EXTERNAL_ID },
        "obs-other": { externalId: OTHER_EXTERNAL_ID },
      },
    );

    await expect(
      resultContainsObservation(
        memoryStore,
        ctx,
        [{ memoryId: "mem-info-lost" }],
        TARGET_EXTERNAL_ID,
      ),
    ).resolves.toBe(true);

    await expect(
      resultContainsObservation(
        memoryStore,
        ctx,
        [{ memoryId: "mem-info-kept" }],
        TARGET_EXTERNAL_ID,
      ),
    ).resolves.toBe(true);

    await expect(
      resultContainsObservation(
        memoryStore,
        ctx,
        [{ memoryId: "mem-other-source" }],
        TARGET_EXTERNAL_ID,
      ),
    ).resolves.toBe(false);
  });
});

// judge は走らせない。変異後のプロンプトは cassette に無く、記録し直すには実 API と鍵が要る（ADR 0236）。
describe(
  "buildMnemoraPrompt vs resultContainsObservation: 出典到達は内容保持を保証しない" +
    "（Issue #498 完了条件4・内容保持の側。⛔ 回答評価は測らない——評価器(gradeAnswer/judge)を" +
    "1度も走らせていないため、§7 が意図した陽性対照は未達のままである）",
  () => {
    const ANSWER_WORD = "青";
    const DIGEST_WITH_ANSWER = `私の好きな色は${ANSWER_WORD}です。`;
    const DIGEST_INFO_LOST = "[要約失敗。内容は保持していません]";
    const MEMORY_ID = "mem-answer-retention";

    function buildFakeRecall(digest: string): RecallResult {
      return {
        recallId: "recall-answer-retention-test",
        memories: [
          {
            memoryId: MEMORY_ID,
            digest,
            retrievedVia: "ann",
            provenanceKind: "stated",
            speaker: null,
            subjectId: null,
          },
        ],
        omitted: [],
        index: { groups: [], totalInScope: 1, countKind: "exact" },
        usage: {},
        explain: { stages: [] },
      } as unknown as RecallResult;
    }

    it("digest から答えの語を落としても層1(出典到達)は true のままで、しかしモデルへ渡る文からは答えが消え、復元すると戻る", async () => {
      const memoryStore = buildFakeMemoryStore(
        {
          [MEMORY_ID]: { digest: DIGEST_INFO_LOST, sourceObservationId: "obs-target" },
        },
        {
          "obs-target": { externalId: TARGET_EXTERNAL_ID },
        },
      );

      const recallInfoLost = buildFakeRecall(DIGEST_INFO_LOST);
      const recallInfoKept = buildFakeRecall(DIGEST_WITH_ANSWER);

      await expect(
        resultContainsObservation(memoryStore, ctx, recallInfoLost.memories, TARGET_EXTERNAL_ID),
      ).resolves.toBe(true);

      expect(buildMnemoraPrompt(recallInfoLost)).not.toContain(ANSWER_WORD);

      expect(buildMnemoraPrompt(recallInfoKept)).toContain(ANSWER_WORD);
      await expect(
        resultContainsObservation(memoryStore, ctx, recallInfoKept.memories, TARGET_EXTERNAL_ID),
      ).resolves.toBe(true);
    });
  },
);
