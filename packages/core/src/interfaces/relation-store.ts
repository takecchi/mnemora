import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";

/**
 * `memory_relations` の `kind` 列が取りうる値（ADR 0292 決定1-a、ADR 0381）。**今は `'contradicts'` の1値だけ**で、
 * DB 側も CHECK で同じ1値に絞ってある。
 *
 * 型を union のまま残すのは、CHECK を広げる将来の migration と足並みを揃えるため。
 * union に値を足す変更は破壊的と数えない。
 */
export type RelationKind = "contradicts";

/**
 * `RelationStore.listRelated` が返す1件——`memoryId` から見た相手側。
 */
export interface Relation {
  /** 対向（相手側）の Memory の id。 */
  memoryId: MemoryId;
  /** 関係の種類（{@link RelationKind}）。 */
  kind: RelationKind;
  /** この関係の行が作られた時刻。監査・デバッグ用途で、並び順の契約には使わない。 */
  createdAt: Date;
}

/**
 * RelationStore（ADR 0292 決定1-c、ADR 0327、ADR 0381）。
 *
 * 3件以上の claim key 衝突（多者間の `contradicts`）を表現する関係グラフの読み書き。
 * 2者間の対は `Memory.status`/`Memory.contestedWithId` 列のまま（ADR 0378 決定1）で、この store が扱うのは3件以上になったときだけ。
 *
 * 🔴 **`Store` バンドルへの組み込みは任意**（`RuntimeDeps.relationStore?`、ADR 0292 決定1-c）。
 * 実装していない adapter でも `recall()` は動く必要がある。配線されていない場合、`Runtime.markContestedGroup` などは
 * 「対応していない」を返し、claim key の衝突検出（3件以上）は「状態を動かさず evidence だけ積む」経路のままになる（ADR 0378 決定5）。
 *
 * **群の作成・解消の書き込みはこの store の口ではない。** `MemoryStore` の任意メソッド
 * `markContestedGroup?`/`resolveContestedGroup?` が担い、`PostgresMemoryStore` は `PostgresRelationStore` の
 * `link`/`unlink` を経由せず `memory_relations` へ直接書く。この store が持つのは読み取り（`listRelated`）と、
 * 単発の（トランザクション外の）書き込み（`link`/`unlink`）だけである。
 */
export interface RelationStore {
  /**
   * `kind` の関係を `fromId`→`toId` の向きで1行作る。**対称関係の相手向き（`toId`→`fromId`）は呼び出し側の責務**で、
   * この口自体は片方向しか書かない（ADR 0292 決定1-b）。この口を単体で2回呼ぶ呼び出し側は、2回の間の原子性を自分で持つこと。
   *
   * 冪等——同じ `(tenantId, fromId, toId, kind)` の行が既にあれば、何もしない（エラーにしない）。
   *
   * **両端の記憶が `ctx.tenantId` のテナントに在ることを、書く前に確かめる**（ADR 0398）。次のとき
   * **例外を投げ、行は書かない**:
   * - `fromId`・`toId` のどちらかが、実在しない記憶を指す（uuid の形でない id も同じ）
   * - `fromId`・`toId` のどちらかが、`ctx.tenantId` 以外のテナントの記憶を指す
   *
   * 例外のメッセージは `memory not found for tenant: <id>` を含む（`MemoryStore` の同種の例外と同じ形）。
   * 「実在しない」と「別のテナントの記憶」は区別しない。DB 由来のエラー（外部キー違反・型変換エラー）は利用者へ漏らさない。
   * 冪等の扱いは両端が確かめられた後の話で、既に同じ行が在っても、端が確かめられなければ投げる。
   *
   * **`kind` が {@link RelationKind} の列挙の外の値のときも、例外を投げ、行は書かない**（JS の呼び出し側・型を `as` で曲げた呼び出し）。
   * 例外のメッセージは `unknown relation kind: <kind>` を含む。`kind` の検査は、両端の検査・DB への書き込みより前に行う。
   */
  link(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void>;
  /**
   * `link` の逆——`fromId`→`toId` の関係行を1行削除する。存在しない行を指定しても例外にしない（冪等）。
   * 相手向きの行には触れない。uuid の形でない id は、存在しない id と同じ扱い（何もしない）。
   * `link` は uuid の形でない端を `memory not found` で断るが、`unlink` は冪等の側に倒す。
   */
  unlink(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void>;
  /**
   * `memoryId` を `fromId` とする関係行から、相手側（`toId`）の一覧を返す
   * （双方向2行書き（ADR 0292 決定1-b）により、どちらの向きで張られていても全ての相手が引ける）。
   *
   * - `kind` を省略すると、すべての `kind` を対象にする。型の外の偽の値（`""`・`null`・`0`）が実行時に渡ったときも、
   *   `PostgresRelationStore`・`InMemoryRelationStore`・core の Fake は絞り込まずに全件を返す（ADR 0488。省略として約束する形ではない）。
   * - 返す順序は規定しない。呼び出し側（`Runtime`）が必要な順に並べ替える。
   * - テナント分離: `ctx.tenantId` と異なるテナントの行は返さない。
   * - 返した `Relation.createdAt`（`Date`）は呼び手のもの。呼び手が書き換えても、store の中の行は変わらない。
   * - uuid の形でない `memoryId` は、存在しない id と同じ扱い（空配列を返す）。
   */
  listRelated(ctx: Ctx, memoryId: MemoryId, kind?: RelationKind): Promise<Relation[]>;
  /**
   * **任意メソッド**（ADR 0402）。{@link RelationStore.listRelated} を複数の起点に対して**1回の往復**で行う。
   * 実装していない adapter では、`Runtime` は `listRelated` を起点ごとに直列に呼ぶ——**実装は義務ではなく、結果も変わらない**。
   *
   * - **返り値は `memoryIds` と同じ長さ・同じ並び**の配列で、`result[i]` は `listRelated(ctx, memoryIds[i], kind)` と
   *   **同じ集合**（同じ `kind` の扱い・同じテナント分離）。起点ごとの分け方は位置で決まる。
   * - `memoryIds` に**重複があってもよい**——同じ id の位置それぞれに同じ内容を返す（別々の配列）。
   * - **実在しない id・`ctx` のテナントに関係の行を持たない id は、その位置に空配列**を返し、他の位置には影響しない（例外にしない）。
   *   空の `memoryIds` は空配列を返す。
   * - 各要素の中の順序は規定しない（`listRelated` と同じ）。
   * - `listRelated` と違い、uuid の形でない id でも**例外にせず空配列**を返してよい（1つの不正な id がバッチ全体を落とさないため）。
   */
  listRelatedMany?(
    ctx: Ctx,
    memoryIds: readonly MemoryId[],
    kind?: RelationKind,
  ): Promise<Relation[][]>;
}
