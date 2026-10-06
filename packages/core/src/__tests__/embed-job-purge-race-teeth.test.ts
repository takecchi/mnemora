import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { EmbeddingProvider } from "../interfaces/embedding-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import type { NewMemory } from "../memory.js";
import { createRuntime } from "../runtime.js";
import type { Runtime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

/**
 * Issue #1035 / ADR 0124 決定5（PR #1036）の確かめ直しで、既存の歯（`runtime-branch-teeth.test.ts` の
 * 「embed の最中に forget と purge が完了しても、書いたベクトルは消える」と、postgres の
 * `purge-during-embed-job.postgres.test.ts`）がすり抜けた変異を、それぞれの約束に当てて押さえる歯。
 *
 * 約束（PR 本文・ADR 0124 の 2026-09-27 追記）:
 * - 書いた後の読み直しで `purgedAt` が付いていれば、書いた埋め込みを消す。付いていなければ消さない
 *   （forget だけの記憶の埋め込みは残す。ADR 0453 の負債1）。
 * - `embeddingStatus` は触らない（purge 自身も `ready` の記憶を `ready` のまま残す）。
 * - 読み直し・削除の失敗は、`failed` を書かずにジョブの失敗として投げる（埋め込み自体は成功しているため）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function newMemory(): NewMemory {
  const strength = 1;
  const halfLifeHours = 24 * 365 * 10;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: NOW,
    lastReinforcedAt: null,
    strength,
    halfLifeHours,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt: NOW,
      lastReinforcedAt: null,
      strength,
      halfLifeHours,
    }),
    embeddingStatus: "pending",
  };
}

/** embed の最中（provider が返る前）に `during` を走らせる runtime。 */
function setup(during: (runtime: Runtime, memoryId: string) => Promise<void>) {
  const stores = createFakeRuntimeStores();
  const late: { runtime?: Runtime; memoryId?: string } = {};
  const base: EmbeddingProvider = stores.embeddingProvider;
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw new Error("not used");
      },
    },
    embeddingProvider: {
      space: base.space,
      embed: async (c, texts) => {
        const vectors = await base.embed(c, texts);
        await during(late.runtime!, late.memoryId!);
        return vectors;
      },
    },
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => new Date() },
  });
  late.runtime = runtime;
  const create = async () => {
    const { memory } = await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);
    late.memoryId = memory.id;
    return memory;
  };
  return { runtime, stores, create };
}

/** `setEmbeddingStatus` に渡された status を、呼ばれた順に記録する（`ready` の後の `failed` は store が巻き戻しとして no-op にする（ADR 0053）ので、状態の読みでは見えない）。 */
function recordStatusWrites(stores: ReturnType<typeof createFakeRuntimeStores>): string[] {
  const writes: string[] = [];
  const real = stores.memoryStore.setEmbeddingStatus.bind(stores.memoryStore);
  stores.memoryStore.setEmbeddingStatus = async (...args) => {
    writes.push(args[2]);
    return real(...args);
  };
  return writes;
}

async function vectorsOf(
  stores: ReturnType<typeof createFakeRuntimeStores>,
  memoryId: string,
): Promise<unknown[]> {
  return stores.vectorStore.getVectors!(ctx, stores.embeddingProvider.space, [memoryId]);
}

describe("tick の embed：埋め込みの最中の purge の後始末の約束", () => {
  // 変異 E3（読み直しの条件を `purgedAt` ではなく `status === "forgotten"` にする）を捕まえる。
  // forget だけで purge していない記憶の埋め込みは、消さずに残す（ADR 0124 追記は purge だけを対象にし、
  // ADR 0453 は forgotten の記憶の埋め込みが残ることを負債1として記録している）。
  it("embed の最中に forget だけが完了したときは、書いたベクトルを消さない", async () => {
    const { runtime, stores, create } = setup(async (rt, id) => {
      await rt.forget(ctx, { memoryId: id });
    });
    const memory = await create();

    const tick = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });

    expect(tick.processed).toBe(1);
    expect(tick.failed).toBe(0);
    const after = await stores.memoryStore.get(ctx, memory.id);
    expect(after?.status).toBe("forgotten");
    expect(after?.purgedAt ?? null).toBeNull();
    expect(await vectorsOf(stores, memory.id)).toHaveLength(1);
  });

  // 変異 E7（消した後に embeddingStatus を `pending` に戻す）・E8（`failed` を書く）・
  // E9（消したあとにジョブを失敗として投げる）を捕まえる。約束: `embeddingStatus` は触らない
  // （purge 自身も `ready` の記憶を `ready` のまま残す）・ジョブは失敗にしない（埋め込み自体は成功している）。
  it("embed の最中に purge が完了したとき、ジョブは成功で終わり、embeddingStatus は ready のまま", async () => {
    const { runtime, stores, create } = setup(async (rt, id) => {
      await rt.forget(ctx, { memoryId: id });
      await rt.purge(ctx, { memoryId: id });
    });
    const memory = await create();
    const writes = recordStatusWrites(stores);

    const tick = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });

    expect(tick.processed).toBe(1);
    expect(tick.failed).toBe(0);
    expect(writes).toEqual(["ready"]);
    const after = await stores.memoryStore.get(ctx, memory.id);
    expect(after?.purgedAt ?? null).not.toBeNull();
    expect(after?.embeddingStatus).toBe("ready");
    expect(await vectorsOf(stores, memory.id)).toEqual([]);
  });

  // 変異 E5（削除の失敗を握り潰す）・E8（失敗に `failed` を書く）を捕まえる。
  // 約束: 削除の失敗はジョブの失敗として投げる（握り潰すと purge 済みの埋め込みが残ったまま成功に見える）。
  // `failed` は書かない（埋め込み自体は成功している）。
  it("purge 済みの埋め込みの削除が失敗したときは、ジョブの失敗として数え、embeddingStatus に failed を書かない", async () => {
    const { runtime, stores, create } = setup(async (rt, id) => {
      await rt.forget(ctx, { memoryId: id });
      await rt.purge(ctx, { memoryId: id });
    });
    const memory = await create();
    const writes = recordStatusWrites(stores);
    // purge 自身の削除（ベストエフォート）は先に済んでいるので、ジョブ側の削除だけが落ちる。
    // purge は embed の最中に走る＝provider が返る前なので、ここで壊すのは「upsert の後」の削除だけ。
    const realUpsert = stores.vectorStore.upsert.bind(stores.vectorStore);
    stores.vectorStore.upsert = async (...args) => {
      await realUpsert(...args);
      stores.vectorStore.delete = async () => {
        throw new Error("delete failed");
      };
    };

    const tick = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });

    expect(tick.processed).toBe(0);
    expect(tick.failed).toBe(1);
    expect((await stores.memoryStore.get(ctx, memory.id))?.embeddingStatus).toBe("ready");
    expect(writes).toEqual(["ready"]);
  });

  // 変異 E6（読み直しを `failed` を書く try の中へ入れる）を捕まえる。
  // 約束: 読み直しの失敗も、`failed` を書かずにジョブの失敗として投げる。
  it("書いた後の読み直しが失敗したときは、ジョブの失敗として数え、embeddingStatus に failed を書かない", async () => {
    const { runtime, stores, create } = setup(async () => {});
    const memory = await create();
    const writes = recordStatusWrites(stores);
    const realSetStatus = stores.memoryStore.setEmbeddingStatus.bind(stores.memoryStore);
    const realGet = stores.memoryStore.get.bind(stores.memoryStore);
    let armed = false;
    // `ready` の書き込みが済んだ直後（＝書いた後の読み直しの直前）から、次の get だけが落ちる。
    stores.memoryStore.setEmbeddingStatus = async (...args) => {
      await realSetStatus(...args);
      if (args[2] === "ready") armed = true;
    };
    stores.memoryStore.get = async (...args) => {
      if (armed) {
        armed = false;
        throw new Error("get failed");
      }
      return realGet(...args);
    };

    const tick = await runtime.tick(ctx, { kinds: ["embed"], leaseMs: 60_000 });

    expect(tick.processed).toBe(0);
    expect(tick.failed).toBe(1);
    expect((await realGet(ctx, memory.id))?.embeddingStatus).toBe("ready");
    expect(writes).toEqual(["ready"]);
  });
});
