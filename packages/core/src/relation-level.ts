import type { Ctx } from "./ctx.js";
import type { MemoryId } from "./ids.js";
import type { Relation, RelationKind, RelationStore } from "./interfaces/relation-store.js";

/**
 * 幅優先探索の1段（frontier）ぶんの `listRelated` を、`RelationStore.listRelatedMany?` があれば
 * 1往復で取る（ADR 0402）。無い store では `undefined` を返す。recall 段3のように安全弁で途中で
 * 止める呼び出し側は、止めた後の `listRelated` を呼ばない規則を保つため、ここで先読みしない。
 *
 * 返り値は `ids` と同じ長さ・同じ並び。長さが違えば adapter の契約違反なので、黙って位置を
 * ずらさず例外にする。
 */
export async function listRelatedManyIfSupported(
  store: RelationStore,
  ctx: Ctx,
  ids: readonly MemoryId[],
  kind: RelationKind,
): Promise<Relation[][] | undefined> {
  if (store.listRelatedMany === undefined) return undefined;
  const result = await store.listRelatedMany(ctx, ids, kind);
  if (result.length !== ids.length) {
    throw new Error(
      `RelationStore.listRelatedMany returned ${result.length} results for ${ids.length} ids`,
    );
  }
  return result;
}

/**
 * {@link listRelatedManyIfSupported} が使えなければ、`ids` の順に `listRelated` を1件ずつ直列に呼ぶ。
 * 途中で止めない探索（`resolveContestedGroup` の部分解消の確認・claim key の群の検出）が使う。
 */
export async function listRelatedLevel(
  store: RelationStore,
  ctx: Ctx,
  ids: readonly MemoryId[],
  kind: RelationKind,
): Promise<Relation[][]> {
  const batched = await listRelatedManyIfSupported(store, ctx, ids, kind);
  if (batched !== undefined) return batched;
  const result: Relation[][] = [];
  for (const id of ids) {
    result.push(await store.listRelated(ctx, id, kind));
  }
  return result;
}
