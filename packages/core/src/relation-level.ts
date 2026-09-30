import type { Ctx } from "./ctx.js";
import type { MemoryId } from "./ids.js";
import type { Relation, RelationKind, RelationStore } from "./interfaces/relation-store.js";

/**
 * 幅優先探索の1段（frontier）ぶんの `listRelated` を、`RelationStore.listRelatedMany?` があれば
 * 1往復で取る（Issue #1449、ADR 0402）。無い store では `undefined` を返す——呼び出し側は今までの
 * 直列の `listRelated` に倒れる（recall 段3のように、安全弁で途中で止める呼び出し側は、止めた後の
 * `listRelated` を呼ばない今の規則を保つため、ここで先読みしない）。
 *
 * 返り値は `ids` と同じ長さ・同じ並び（`result[i]` が `ids[i]` の相手側）。長さが違えば adapter の
 * 契約違反なので、黙って位置をずらさず例外にする。
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
 * {@link listRelatedManyIfSupported} が使えなければ、`ids` の順に `listRelated` を1件ずつ直列に呼ぶ
 * （今までの探索と同じ呼び出し順・同じ回数）。途中で止めない探索（`resolveContestedGroup` の部分解消の確認・
 * claim key の群の検出）が使う。
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
