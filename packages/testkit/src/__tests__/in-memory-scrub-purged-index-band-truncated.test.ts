import { describe, expect, it } from "vitest";
import type { Ctx, NewRecallRecord } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "../test-data.js";
import { InMemoryMemoryStore } from "../__fixtures__/in-memory-memory-store.js";

// 確かめ直し（Issue #1759、B 群 #1634 / ADR 0512）の歯。
// ADR 0512 決定1: 伏せるエントリは `{ memoryId, digest }` に作り直す（`truncated` は落とす。Postgres の SQL は
// `jsonb_build_object` で常に作り直す）。既存の歯は digest が違うエントリでしか `truncated` を見ず、
// 「digest が既にトゥームストーンと同じで `truncated` だけ付いているエントリ」を作り直さない変異が赤にならなかった。
describe("InMemoryMemoryStore.scrubPurged: digest が既にトゥームストーンのエントリも truncated を落とす（ADR 0512）", () => {
  it("{ digest: '[purged]', truncated: true } は { digest: '[purged]' } になる", async () => {
    const store = new InMemoryMemoryStore();
    const ctx: Ctx = { tenantId: "band-trunc" };
    const m = await store.createMemory(
      ctx,
      buildNewMemoryFixture({ tenantId: ctx.tenantId, contentHash: "p", status: "forgotten" }),
    );
    await store.purgeMemory(
      ctx,
      m.id,
      { content: "[purged]", digest: "[purged]" },
      buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: m.id, kind: "purged" }),
    );
    const record: NewRecallRecord = {
      tenantId: ctx.tenantId,
      subjectId: "s",
      query: { text: "q" },
      budget: null,
      omitted: [],
      usage: {
        chars: 0,
        estimatedTokens: 0,
        counter: "heuristic",
        byTier: { full: 0, digest: 0, index: 0 },
        indexChars: 0,
      },
      indexBand: {
        groups: [],
        totalInScope: 0,
        countKind: "exact",
        digestBand: [{ memoryId: m.id, digest: "[purged]", truncated: true }],
      },
      explain: { stages: [] },
      returnedMemories: [],
    };
    const recallId = await store.createRecall(ctx, record);
    await store.scrubPurged(ctx, [m.id]);
    const band = (await store.getRecall(ctx, recallId))!.indexBand.digestBand;
    expect(band).toEqual([{ memoryId: m.id, digest: "[purged]" }]);
  });
});
