import type { Ctx, MemoryStore } from "@mnemora/core";

/**
 * `recall()` が返した Memory が、どの Observation から生まれたかを辿る（ADR 0052）。
 *
 * **なぜ切り出したか**: この関数はもともと `retrieval-quality.ts` の中に在ったが、
 * `compare.ts` も同じ経路を必要とするようになった。`compare.ts` から
 * `retrieval-quality.ts` を import すると、量の計測（compare）が想起の質の計測
 * （retrieval）に依存することになり、片方を触ると他方が壊れうる。**両方が依存する
 * 共有の部品として、ここへ降ろす。**`retrieval-quality.ts` は互換のため re-export する。
 *
 * **なぜ文字列一致ではだめか（ADR 0052 の中心）**: 本物の LLM は発話を書き換えて記憶を
 * 作る（要約・言い換え）ため、`digest` に元の語が残る保証が無い。
 * 「digest に『青』が含まれるか」で「元の発話が `FACT_STATEMENT` だったか」を判定すると、
 * **言い換えられれば偽陰性、無関係な記憶がたまたまその語を含めば偽陽性**になる。
 *
 * 使う経路は**公開 interface だけ**である:
 *
 *   `recall().memories[i].memoryId`
 *     → `memoryStore.get(ctx, memoryId)`
 *     → `Memory.sourceObservationId`
 *     → `memoryStore.getObservation(ctx, sourceObservationId)`
 *     → `Observation.externalId`
 *
 * 辿れないケース（`sourceObservationId` が無い、`getObservation` が null）は `null` を返す
 * ——**辿れないことを黙って別の何かに読み替えない**（文字列一致へのフォールバックはしない）。
 */
export async function resolveExternalId(
  memoryStore: MemoryStore,
  ctx: Ctx,
  memoryId: string,
): Promise<string | null> {
  const memory = await memoryStore.get(ctx, memoryId);
  if (!memory || !memory.sourceObservationId) {
    return null;
  }
  const observation = await memoryStore.getObservation(ctx, memory.sourceObservationId);
  return observation?.externalId ?? null;
}

/**
 * `recall()` の結果に、指定した `externalId` の Observation 由来の Memory が
 * 含まれているかを判定する。
 *
 * **provider が擬似か本物かに依らない。**digest の中身を一切見ないため、
 * 記録の再生（ADR 0051）でも実 API でも、同じ意味の判定になる。
 */
export async function resultContainsObservation(
  memoryStore: MemoryStore,
  ctx: Ctx,
  memories: readonly { memoryId: string }[],
  externalId: string,
): Promise<boolean> {
  for (const memory of memories) {
    if ((await resolveExternalId(memoryStore, ctx, memory.memoryId)) === externalId) {
      return true;
    }
  }
  return false;
}
