/**
 * 冪等な作成の結果——「この呼び出し自身が行を作ったか」。
 *
 * `created` の意味は `MemoryStore`（`interfaces/memory-store.ts`）が定めている:
 * 冪等キーに衝突して既存の行を返したときは `false`、自分が新しい行を挿入したときだけ `true`。
 */
export interface IdempotentCreateResult<T> {
  /** 作った行、または冪等キーに衝突したときの既存の行。 */
  readonly value: T;
  /** この呼び出しが新しい行を挿入したなら `true`。既存の行を返したなら `false`。 */
  readonly created: boolean;
}

/**
 * 擬似実装（`InMemoryMemoryStore` / `FakeMemoryStore`）が `created` を導くための唯一の形（ADR 0054）。
 *
 * 守る不変条件: **`created` は、挿入するかどうかを決めたその判定そのものから出る。**
 * 「既存が見つかったか」と「`created` に何を入れるか」を別々の式にすると、その間に他の書き込みが
 * 割り込む余地が生まれる。実 adapter はこの関数を使わず、`INSERT ... ON CONFLICT DO NOTHING
 * RETURNING *` の戻り行数から `created` を得る（判定と挿入が1文）。
 *
 * **`insert` は同期でなければならない。**`await` を挟むと、判定と挿入の間に他のタスクの同期区間が
 * 入りうる。戻り値を `Promise` にしていないのは、その窓を型で塞ぐため。
 *
 * @param existing 冪等キーで引いた既存の行。無ければ `null`/`undefined`。
 * @param insert   既存が無いときだけ呼ばれる、新しい行を挿入して返す**同期**関数。
 */
export function resolveIdempotentCreate<T>(
  existing: T | null | undefined,
  insert: () => T,
): IdempotentCreateResult<T> {
  if (existing !== null && existing !== undefined) {
    return { value: existing, created: false };
  }
  return { value: insert(), created: true };
}
