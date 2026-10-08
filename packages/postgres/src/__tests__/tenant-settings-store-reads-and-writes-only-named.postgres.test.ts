import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/** `PostgresTenantSettingsStore` の口は、名前の付いた欄・渡した subjectId だけを書き・読む。 */

const ctx: Ctx = { tenantId: "tenant-settings-only-named" };

afterAll(async () => {
  await closeTestClient();
});

async function setup() {
  await resetTestDatabase();
  const { db } = await getTestClient();
  return {
    memoryStore: new PostgresMemoryStore(db),
    settings: new PostgresTenantSettingsStore(db),
  };
}

const recallInput = {
  tenantId: ctx.tenantId,
  query: { text: "q" },
  omitted: [],
  usage: {
    chars: 0,
    estimatedTokens: 0,
    counter: "heuristic" as const,
    byTier: { full: 0, digest: 0, index: 0 },
    indexChars: 0,
  },
  indexBand: { groups: [], totalInScope: 0, countKind: "exact" as const },
  explain: { stages: [] },
  returnedMemories: [],
};

describe("setEventRetention は、同じテナントの他の設定を動かさない", () => {
  it.each([
    ["days", { kind: "days", days: 30 }],
    ["unlimited", { kind: "unlimited" }],
  ] as const)(
    "%s を書いても、decay_clock・taxonomy_mode・default_half_life_recalls は前の値のまま",
    async (_label, retention) => {
      const { settings } = await setup();
      await settings.setDecayClock(ctx, "activity");
      await settings.setTaxonomyMode(ctx, "strict");
      await settings.setDefaultHalfLifeRecalls(ctx, 5000);

      await settings.setEventRetention(ctx, retention);

      expect(await settings.getEventRetention(ctx)).toEqual(retention);
      expect(await settings.getDecayClock(ctx)).toBe("activity");
      expect(await settings.getTaxonomyMode(ctx)).toBe("strict");
      expect(await settings.getDefaultHalfLifeRecalls(ctx)).toBe(5000);
    },
  );
});

describe("getSubjectActivitySeqs は、渡した subjectId の行だけを返す", () => {
  it("同じテナントに行のある別の subjectId は、渡していなければ返さない", async () => {
    const { memoryStore, settings } = await setup();
    for (const [subjectId, n] of [
      ["alice", 2],
      ["bob", 3],
    ] as const) {
      for (let i = 0; i < n; i += 1) {
        await memoryStore.createRecall(ctx, {
          ...recallInput,
          subjectId,
          advanceActivityClock: { scope: "subject", subjectId },
        });
      }
    }

    const seqs = await settings.getSubjectActivitySeqs(ctx, ["alice", "carol"]);

    expect(Object.keys(seqs)).toEqual(["alice"]);
    expect(seqs["alice"]).toBe(2);
    // 陽性対照: 渡せば bob も読める。
    expect((await settings.getSubjectActivitySeqs(ctx, ["bob"]))["bob"]).toBe(3);
  });
});
