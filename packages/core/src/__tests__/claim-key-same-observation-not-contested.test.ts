import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #835・ADR 0377（候補1）: `createMemoriesFromCandidates`（ADR 0347、PR #1318）が
 * 抽出の書き込みを「全件書く → 全件について `created`/検出」の2ループへ分けたことで、
 * 同じ observation（＝同じ発話）から抽出された兄弟 Memory どうしが、互いの検出時点で
 * 既に `active` になっていた。その結果:
 *
 * - **(a)** 1回の `observe()` から同じ claim key の2件が抽出されると
 *   （例: 「去年は札幌で働いていた。今年は福岡で働いている。」）、互いが `matches` に
 *   混入して誤って contested になっていた（誤検出）。
 * - **(b)** 先行 observe の Memory M1 が在り、後続の1回の observe が同じ claim key の
 *   2件（訂正の新値と旧値の言い直し）を生むと、一致が [M1, 兄弟] の2件になり、両方
 *   `unresolved_conflict` になって `markContested` が一度も呼ばれず、M1 が訂正されて
 *   いることを検出できなかった（退行。`negation-moved-city`・`schedule-change-deadline`
 *   が記録の再生で 4/4→2/4 に落ちた——bisect で `8c45801`〔ADR 0347〕が境目だと特定した）。
 *
 * `Runtime.detectClaimKeyContested`（`runtime.ts`）は、`findActiveByClaimKey` が返した
 * 一致から「検出中の memory と同じ `sourceObservationId`」を件数を数える前に除くように
 * なった（`memory.sourceObservationId` が `null` のときは除かない）。この歯は core の
 * Fake（`createFakeRuntimeStores`）だけで、(a)(b) が直っていることを固定する。
 *
 * ⚠ **この歯は「失うもの」も固定する**——1つの発話の中の言い直し（例:
 * 「金曜じゃなくて水曜」）が抽出で2件の候補に分かれ、たまたま同じ claim key に当たる
 * 場合も同じ経路を通るので、今後は互いに contested にならない。下の
 * 「1つの発話内の言い直しが2件に分かれても、今後は互いに contested にならない」テストが
 * それを明示する（`docs/decisions/0377-*.md` 参照）。
 */

const ctx: Ctx = { tenantId: "tenant-835" };

/**
 * `runtime.test.ts` の `sequencedLlm` と同じ形（1回目=抽出、2回目=claim key 導出、
 * ...の順で呼ばれる前提の単純化）。設定した回数を超えて呼ばれたら例外を投げる。
 */
function sequencedLlm(responses: unknown[]): LLMProvider {
  const calls: StructuredRequest<unknown>[] = [];
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      const index = calls.length;
      calls.push(req as StructuredRequest<unknown>);
      if (index >= responses.length) {
        throw new Error(`sequencedLlm: no response configured for call #${index + 1}`);
      }
      return req.schema.parse(responses[index]) as T;
    },
  };
}

function buildRuntime(llmProvider: LLMProvider) {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
  });
  return { runtime, stores };
}

describe("claim key の検出: 同じ observation の兄弟どうしを誤って contested にしない（Issue #835、ADR 0377、core の Fake）", () => {
  it("(R) 回帰の歯: 先行 observe の M1 が在るとき、後続の1回の observe が生む同じ claim key の2件（訂正の新値・旧値の言い直し）は、片方が M1 と contested になり、もう片方は active のまま残る", async () => {
    const llm = sequencedLlm([
      // 1件目の observe: M1（京都に住んでいた）
      { memories: [{ content: "以前は京都に住んでいた", provenanceKind: "stated" }] },
      { claims: [{ subject: "user", predicate: "lived_in_city" }] },
      // 2件目の observe: 同じ発話から2件抽出される——新値（神戸）と旧値の言い直し（京都）
      {
        memories: [
          { content: "現在、神戸に住んでいる", provenanceKind: "stated" },
          { content: "以前は京都に住んでいた", provenanceKind: "stated" },
        ],
      },
      {
        claims: [
          { subject: "user", predicate: "lived_in_city" },
          { subject: "user", predicate: "lived_in_city" },
        ],
      },
    ]);
    const { runtime, stores } = buildRuntime(llm);

    const first = await runtime.observe(ctx, {
      kind: "utterance",
      text: "以前は京都に住んでいた。",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(first.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    const m1Id = first.memoryIds[0]!;

    const second = await runtime.observe(ctx, {
      kind: "utterance",
      text: "もう京都には住んでいません。いまは神戸に住んでいます。",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(second.memoryIds).toHaveLength(2);
    const [newValueId, restatedOldValueId] = second.memoryIds as [string, string];

    // 候補1が無ければ（8c45801 以降）: newValueId の検出時点で active な一致が
    // [M1, restatedOldValueId] の2件になり、unresolved_conflict になって
    // markContested が一切呼ばれない——M1 は active のまま、退行そのもの。
    // 候補1を入れると: 兄弟（restatedOldValueId）は同じ observation なので除外され、
    // 一致は [M1] の1件だけになり、markContested(newValueId, M1) が呼ばれる。
    expect(second.contestedDetection).toHaveLength(2);
    const newValueOutcome = second.contestedDetection!.find((d) => d.memoryId === newValueId)!;
    expect(newValueOutcome.matchCount).toBe(1);
    expect(newValueOutcome.result.kind).toBe("contested");
    if (newValueOutcome.result.kind !== "contested") throw new Error("unreachable");
    expect(newValueOutcome.result.withMemoryId).toBe(m1Id);

    const restatedOutcome = second.contestedDetection!.find(
      (d) => d.memoryId === restatedOldValueId,
    )!;
    // 兄弟（restatedOldValueId）が処理される時点では、M1 はもう `active` ではない
    // （newValueId との対で `contested` になっている）ので一致は0件。
    expect(restatedOutcome.matchCount).toBe(0);
    expect(restatedOutcome.result.kind).toBe("no_conflict");

    const m1 = await stores.memoryStore.get(ctx, m1Id);
    const newValueMemory = await stores.memoryStore.get(ctx, newValueId);
    const restatedOldValueMemory = await stores.memoryStore.get(ctx, restatedOldValueId);
    expect(m1?.status).toBe("contested");
    expect(m1?.contestedWithId).toBe(newValueId);
    expect(newValueMemory?.status).toBe("contested");
    expect(newValueMemory?.contestedWithId).toBe(m1Id);
    // 訂正の言い直し（restatedOldValueId）は active のまま——同じ observation の兄弟とは
    // 対にならない。
    expect(restatedOldValueMemory?.status).toBe("active");
    expect(restatedOldValueMemory?.contestedWithId ?? null).toBeNull();
  });

  it("(a) 1回の observe の2件が同じ claim key でも、互いに contested にならない（#835 の誤検出そのものの歯）", async () => {
    const llm = sequencedLlm([
      {
        memories: [
          { content: "去年は札幌で働いていた", provenanceKind: "stated" },
          { content: "今年は福岡で働いている", provenanceKind: "stated" },
        ],
      },
      {
        claims: [
          { subject: "user", predicate: "work_location" },
          { subject: "user", predicate: "work_location" },
        ],
      },
    ]);
    const { runtime, stores } = buildRuntime(llm);

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "去年は札幌で働いていました。今年は福岡で働いています。",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(result.memoryIds).toHaveLength(2);
    expect(result.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);

    const memories = await Promise.all(
      result.memoryIds.map((id) => stores.memoryStore.get(ctx, id)),
    );
    expect(memories.map((m) => m?.status)).toEqual(["active", "active"]);
    expect(memories.map((m) => m?.contestedWithId ?? null)).toEqual([null, null]);
  });

  it("(L) 失うもの: 1つの発話内の言い直しが2件の候補に分かれ、同じ claim key に当たっても、今後は互いに contested にならない", async () => {
    // 「金曜じゃなくて水曜」のような、1つの発話の中の言い直しが抽出で2件に分かれて
    // しまい、たまたま同じ claim key（会議の曜日）に当たった場合の想定。今回の直しの
    // 前は、同じ observation の兄弟どうしでも `matches.length === 1` になれば
    // contested になっていた（(a) と同じ機序）——今後は、同じ observation の兄弟は
    // 検出の対象から外れるので、このケースも contested にならない。
    // ⚠ **これは意図して受け入れた損失である**（ADR 0377「失うもの」）。実際の
    // `answer-case-set` の `schedule-change-meeting-day` では、この言い直しは1件の
    // Memory にまとまり（2件に分かれない）、旧値は別の observation（別ターン）に
    // 在るため、この損失の対象にならない——記録の再生で確かめた（ADR 0377 参照）。
    const llm = sequencedLlm([
      {
        memories: [
          { content: "定例会議は水曜日に変更", provenanceKind: "stated" },
          { content: "定例会議は金曜日ではない", provenanceKind: "stated" },
        ],
      },
      {
        claims: [
          { subject: "user", predicate: "meeting_day" },
          { subject: "user", predicate: "meeting_day" },
        ],
      },
    ]);
    const { runtime, stores } = buildRuntime(llm);

    const result = await runtime.observe(ctx, {
      kind: "utterance",
      text: "すみません、やはり定例会議は水曜日に移してください。金曜日は都合が悪くなりました。",
      claimKey: { enabled: true, detectContested: true },
    });
    expect(result.memoryIds).toHaveLength(2);
    expect(result.contestedDetection).toEqual([
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
      expect.objectContaining({ matchCount: 0, result: { kind: "no_conflict" } }),
    ]);
    const memories = await Promise.all(
      result.memoryIds.map((id) => stores.memoryStore.get(ctx, id)),
    );
    expect(memories.map((m) => m?.status)).toEqual(["active", "active"]);
  });
});
