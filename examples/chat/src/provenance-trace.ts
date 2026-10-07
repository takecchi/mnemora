import type { Ctx, MemoryStore } from "@mnemora/core";

/**
 * `recall()` が返した Memory がどの Observation から生まれたかを、公開 interface だけで辿る。
 * 証明するのは出典への到達だけで、`digest` の中身は一切見ない（要約で情報が失われていても true になる）。
 * 情報保持・回答正誤の証明には使えない（ADR 0226）。辿れないときは `null` を返し、文字列一致へのフォールバックはしない。
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

/** `recall()` の結果に、指定した `externalId` の Observation 由来の Memory が含まれているかを判定する。出典到達だけを見る（情報保持・回答正誤は測らない）。 */
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
