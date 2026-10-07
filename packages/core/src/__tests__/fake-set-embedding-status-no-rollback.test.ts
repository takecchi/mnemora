import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { NewMemory } from "../memory.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

const ctx: Ctx = { tenantId: "tenant-1" };
let contentHashCounter = 0;

function newMemory(overrides: Partial<NewMemory> = {}): NewMemory {
  contentHashCounter += 1;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${contentHashCounter}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 720,
    decayFloorAt: new Date("2026-06-01T00:00:00.000Z"),
    embeddingStatus: "pending",
    ...overrides,
  };
}

describe("FakeMemoryStore.setEmbeddingStatus — ready を failed へ巻き戻さない（ADR 0053）", () => {
  it("⚠ 'ready' のところへ 'failed' を書いても巻き戻らない（例外も投げない）", async () => {
    // ⚠ `ready` は VectorStore.upsert が返った後にしか書かれない。`failed` はリースを失った古いワーカーの catch からも書かれうる。
    // ⚠ 例外を投げないことも歯の一部: `failed` の唯一の呼び出し口は `runtime.tick` の catch の中で、そこで投げると元の埋め込みエラーが握り潰される。
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());

    const readied = await stores.memoryStore.setEmbeddingStatus(ctx, memory.id, "ready");
    // 前提: 'ready' への遷移は実際に効いている。下の正の等値比較だけでも赤くなるが、この行は赤くなる位置を足す。
    expect(readied.embeddingStatus).toBe("ready");

    // ⚠ プリミティブへ即座に写し取る: FakeMemoryStore は行オブジェクトへの参照をそのまま返すので、`readied` を保持したまま比べると
    // 同じオブジェクトを2回見るだけになり、比較が常に真になって歯が死ぬ。
    const readyUpdatedAtMs = readied.updatedAt.getTime();

    // ⚠ `updatedAt` は壁時計。2回の呼び出しが一瞬で終わると、ガードが外れて書き込む実装でもミリ秒の解像度で同じ値になりうる。
    // 実際に時間を進めてから「変わっていない」を確かめる。
    await new Promise((resolve) => setTimeout(resolve, 5));

    const rolledBack = await stores.memoryStore.setEmbeddingStatus(ctx, memory.id, "failed");
    expect(rolledBack.embeddingStatus).toBe("ready");
    expect(rolledBack.updatedAt.getTime()).toBe(readyUpdatedAtMs);

    // 読み直しても同じ（返り値だけを繕う実装を弾く）。
    const reread = await stores.memoryStore.get(ctx, memory.id);
    expect(reread?.embeddingStatus).toBe("ready");
    expect(reread?.updatedAt.getTime()).toBe(readyUpdatedAtMs);
  });

  it("'failed' を 'ready' へ進めることは妨げない（片側だけの規則）", async () => {
    // ⚠ 規則が片側だけであることを固定する: 「ready と failed を対称に禁じる」や「常に何も書かない」へずれても、上の歯だけでは緑のままになる。
    const stores = createFakeRuntimeStores();
    const memory = await stores.memoryStore.createMemory(ctx, newMemory());

    const failed = await stores.memoryStore.setEmbeddingStatus(ctx, memory.id, "failed");
    // 前提: 'failed' への遷移は実際に効いている。
    expect(failed.embeddingStatus).toBe("failed");
    // ⚠ 上の歯と同じ理由でプリミティブへ写し取る（参照を持ち回らない）。
    const failedUpdatedAtMs = failed.updatedAt.getTime();

    await new Promise((resolve) => setTimeout(resolve, 5));

    const readied = await stores.memoryStore.setEmbeddingStatus(ctx, memory.id, "ready");
    expect(readied.embeddingStatus).toBe("ready");
    // 行が実際に触られたこと（no-op ではないこと）を updatedAt で確かめる。
    expect(readied.updatedAt.getTime()).toBeGreaterThan(failedUpdatedAtMs);

    const reread = await stores.memoryStore.get(ctx, memory.id);
    expect(reread?.embeddingStatus).toBe("ready");
  });

  it("setEmbeddingStatus は存在しない Memory に対して失敗する（既存の挙動を壊していないことの確認）", async () => {
    const stores = createFakeRuntimeStores();
    await expect(
      stores.memoryStore.setEmbeddingStatus(ctx, "does-not-exist", "ready"),
    ).rejects.toThrow(/memory not found for tenant/);
  });
});
