import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider, StructuredRequest } from "../interfaces/llm-provider.js";
import { ExtractionResultSchema } from "../extraction.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * claim key の自動 contested 検出（ADR 0324）で、同じ鍵の主張が1件ずつ届く経路の振る舞い
 * （Issue #933。`docs/memory-model.md` §5 の追記、ADR 0324 の2026-09-27追記、
 * ADR 0378 が直した後の姿）。
 *
 * **直す前（PR1 より前）**: 毎回 `detectContested: true` を渡して1件ずつ observe すると、
 * 2件目で1件目と対になって両方 `contested` になり、`findActiveByClaimKey`（`active` だけ）
 * の一致から外れる。⟹ 3件目は `no_conflict` で `active` のまま痕跡を残さず、4件目は3件目と
 * 新しい対になる。`claim_key_conflict_unresolved` のイベントは一度も積まれない——これが
 * Issue #933 の症状だった。
 *
 * **直した後（本ファイル、ADR 0378 決定7・Issue #933 案2）**: `MemoryStore.
 * findContestedByClaimKey?`（新設の任意メソッド）を実装している store（core の Fake も
 * その1つ）では、`detectClaimKeyContested` が `findActiveByClaimKey`（`active`）に加えて
 * `findContestedByClaimKey`（`contested`）の一致も数える。
 *
 * - 1件目: 一致0件 ⟹ `no_conflict`、`active` のまま。
 * - 2件目: 1件目（`active`）と1件一致 ⟹ `contested`。`markContested` が発火し、
 *   1件目・2件目は互いに `contested` になる（今までどおり）。
 * - 3件目: 1件目・2件目は `active` ではないが、どちらも `findContestedByClaimKey` の一致に
 *   入る ⟹ 一致2件 ⟹ `unresolved_conflict`。`markContested` は呼ばれない
 *   （#207/`memory_relations` が無いと1対1では表現できないため、ADR 0324 決定5・決定6）
 *   ——**状態は動かさず**、3件目は `active` のまま、`memory_events` に
 *   `claim_key_conflict_unresolved` の evidence が1件積まれる。**1件目・2件目の対は
 *   壊れない**——この関数は一致の `status`/`contestedWithId` を一切書き換えない
 *   （ADR 0378 決定2、PR1 の範囲。多者間グループを実際に `contested` として束ねる書き込みは
 *   `RelationStore` が要る PR2 の範囲）。
 * - 4件目: 3件目（`active`）+ 1件目・2件目（`contested`）で一致3件 ⟹ `unresolved_conflict`。
 *   4件目も同じ形で検出される——3件目と新しい対を作ったりはしない。
 *
 * `findContestedByClaimKey?` を実装していない store では、この直しは効かない
 * （後方互換。`findActiveByClaimKey` の一致だけで判定する今までの振る舞いのまま）——
 * `claim-key-sequential-arrival-no-find-contested.test.ts` が別途縛る。
 *
 * Postgres でも同じ直った振る舞いを
 * `packages/postgres/src/__tests__/claim-key-sequential-arrival.postgres.test.ts` が縛る。
 */

const ctx: Ctx = { tenantId: "tenant-933" };
const CLAIMS = [
  "好きな食べ物はラーメン",
  "好きな食べ物は寿司",
  "好きな食べ物はカレー",
  "好きな食べ物は餃子",
];

/** 抽出には発話をそのまま1件返し、claim key の導出にはいつも同じ鍵を返す偽の LLM。 */
function sameKeyLlm(): LLMProvider {
  let next = 0;
  return {
    complete: async () => {
      throw new Error("not used");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      if ((req.schema as unknown) === ExtractionResultSchema) {
        const content = CLAIMS[next++]!;
        return req.schema.parse({ memories: [{ content, provenanceKind: "stated" }] });
      }
      return req.schema.parse({ claims: [{ subject: "user", predicate: "favorite_food" }] });
    },
  };
}

describe("claim key の検出: 同じ鍵の主張が1件ずつ届く経路（Issue #933、ADR 0378 で直った後。core の Fake）", () => {
  it("3件目・4件目は unresolved_conflict で matchCount が2件以上になり、evidence が積まれる。1・2件目の対は壊れない", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: sameKeyLlm(),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });

    const results = [];
    for (const text of CLAIMS) {
      results.push(
        await runtime.observe(ctx, {
          kind: "utterance",
          text,
          claimKey: { enabled: true, detectContested: true },
        }),
      );
    }
    const ids = results.map((r) => r.memoryIds[0]!);

    expect(
      results.map((r) => r.contestedDetection?.map((d) => [d.matchCount, d.result.kind])),
    ).toEqual([
      [[0, "no_conflict"]],
      [[1, "contested"]],
      [[2, "unresolved_conflict"]],
      [[3, "unresolved_conflict"]],
    ]);

    const memories = await Promise.all(ids.map((id) => stores.memoryStore.get(ctx, id)));
    expect(memories.map((m) => m?.status)).toEqual(["contested", "contested", "active", "active"]);
    // 1件目・2件目の対は、3件目・4件目が届いても壊れない。
    expect(memories[0]?.contestedWithId).toBe(ids[1]);
    expect(memories[1]?.contestedWithId).toBe(ids[0]);
    // 3件目・4件目はどの相手とも対にならない（2件以上の分岐は markContested を呼ばない）。
    expect(memories[2]?.contestedWithId ?? null).toBeNull();
    expect(memories[3]?.contestedWithId ?? null).toBeNull();

    // 決定6の evidence（Issue #933 が直る前は一度も積まれなかった）は、3件目・4件目に積まれる。
    // 1件目・2件目には積まれない（`markContested` の経路であり、evidence を積むのは
    // 「2件以上」の分岐だけ）。
    const unresolvedEventsFor = async (id: (typeof ids)[number]) => {
      const events = await stores.eventStore.list(ctx, { memoryId: id });
      return events.filter(
        (e) => (e.meta as { reason?: string } | null)?.reason === "claim_key_conflict_unresolved",
      );
    };
    expect(await unresolvedEventsFor(ids[0]!)).toEqual([]);
    expect(await unresolvedEventsFor(ids[1]!)).toEqual([]);
    const thirdEvents = await unresolvedEventsFor(ids[2]!);
    expect(thirdEvents).toHaveLength(1);
    const thirdNote = JSON.parse((thirdEvents[0]!.meta as { note: string }).note) as {
      matchCount: number;
      matches: Array<{ id: string; status: string }>;
    };
    expect(thirdNote.matchCount).toBe(2);
    // 3件目の一致は、1件目・2件目（どちらも contested）——`findContestedByClaimKey` 由来
    // であることが `status` から分かる（北極星 問い3、ADR 0378）。
    expect(thirdNote.matches.map((m) => m.status).sort()).toEqual(["contested", "contested"]);
    expect(thirdNote.matches.map((m) => m.id).sort()).toEqual([ids[0], ids[1]].sort());

    const fourthEvents = await unresolvedEventsFor(ids[3]!);
    expect(fourthEvents).toHaveLength(1);
    const fourthNote = JSON.parse((fourthEvents[0]!.meta as { note: string }).note) as {
      matchCount: number;
      matches: Array<{ id: string; status: string }>;
    };
    expect(fourthNote.matchCount).toBe(3);
    // 4件目の一致は、3件目（active、findActiveByClaimKey 由来）+ 1件目・2件目（contested、
    // findContestedByClaimKey 由来）。
    expect(fourthNote.matches.map((m) => m.status).sort()).toEqual([
      "active",
      "contested",
      "contested",
    ]);
    expect(fourthNote.matches.map((m) => m.id).sort()).toEqual([ids[0], ids[1], ids[2]].sort());
  });

  it("3件目を observe した直後は、3件目は active で contestedWithId を持たない（対にはならない）", async () => {
    const stores = createFakeRuntimeStores();
    const runtime = createRuntime({
      memoryStore: stores.memoryStore,
      outboxStore: stores.outboxStore,
      vectorStore: stores.vectorStore,
      eventStore: stores.eventStore,
      tenantSettingsStore: stores.tenantSettingsStore,
      llmProvider: sameKeyLlm(),
      embeddingProvider: stores.embeddingProvider,
      hashContent: (content: string) => `sha256(${content})`,
    });
    let third;
    for (const text of CLAIMS.slice(0, 3)) {
      third = await runtime.observe(ctx, {
        kind: "utterance",
        text,
        claimKey: { enabled: true, detectContested: true },
      });
    }
    expect(third!.contestedDetection).toEqual([
      expect.objectContaining({
        matchCount: 2,
        result: expect.objectContaining({ kind: "unresolved_conflict" }),
      }),
    ]);
    const memory = await stores.memoryStore.get(ctx, third!.memoryIds[0]!);
    expect(memory?.status).toBe("active");
    expect(memory?.contestedWithId ?? null).toBeNull();
  });
});
