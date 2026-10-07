import type { Ctx } from "../ctx.js";
import type { MemoryStore } from "../interfaces/memory-store.js";
import type { Memory, NewMemory } from "../memory.js";

/**
 * 由来が `stated`・`inferred` の Memory は、元の Observation を持つ（`sourceObservationId` が `null` では書けない。
 * `MemoryStore.createMemory` の TSDoc、DB の CHECK）。試験が縛っているのは由来の中身や想起の振る舞いで、元の Observation では
 * ないので、列の `sourceObservationId` が空のときだけ Observation を1件作って埋める。ほかの欄は触らない。
 */
export async function withSourceObservation(
  store: MemoryStore,
  ctx: Ctx,
  input: NewMemory,
): Promise<NewMemory> {
  const { kind } = input.provenance;
  if ((kind !== "stated" && kind !== "inferred") || input.sourceObservationId != null) {
    return input;
  }
  const observation = await store.createObservation(ctx, {
    tenantId: ctx.tenantId,
    kind: "utterance",
    payload: { text: "source" },
  });
  return { ...input, sourceObservationId: observation.id };
}

export async function createObservedMemory(
  store: MemoryStore,
  ctx: Ctx,
  input: NewMemory,
): Promise<Memory> {
  return store.createMemory(ctx, await withSourceObservation(store, ctx, input));
}
