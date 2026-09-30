import type { Ctx } from "../ctx.js";
import type { MemoryId } from "../ids.js";

/**
 * Issue #207/#933 PR2（ADR 0292 決定1-a、ADR 0381）: `memory_relations` の `kind` 列が
 * 取りうる値。**今は `'contradicts'` の1値だけ**——DB 側も `CHECK (kind IN
 * ('contradicts'))` で同じ1値に絞ってある（`packages/postgres/migrations/0026_memory_relations.sql`）。
 * `supersedes`/`consolidates_from`/`derived_from`/`supports` は入れない（ADR 0292 §2
 * 決定1-a——既に列・jsonb に保存済み、または出所不明）。
 *
 * 型を union のまま残す理由は、CHECK を広げる将来の migration と足並みを揃えるため——
 * union に値を足す変更は破壊的と数えない規律（オーナーの回答 ask_human `d9364c91`）
 * に乗せられる形にしておく。
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
  /** この関係の行が作られた時刻。監査・デバッグ用途——並び順の契約には使わない。 */
  createdAt: Date;
}

/**
 * RelationStore — Phase 2（Issue #207、ADR 0292 決定1-c、ADR 0327、ADR 0381）。
 *
 * 3件以上の claim key 衝突（多者間の `contradicts`）を表現する関係グラフの読み書き。
 * 2者間の対は今日どおり `Memory.status`/`Memory.contestedWithId` 列のまま
 * （ADR 0378 決定1 の (ii) 別口新設）——この store が扱うのは**3件以上になったとき
 * だけ**である。
 *
 * 🔴 **`Store` バンドルへの組み込みは任意**（`RuntimeDeps.relationStore?`、
 * ADR 0292 決定1-c）。北極星 問い2（これを無効にしたとき Memory Framework として
 * 成立するか）——`memory_relations` を実装していない adapter でも `recall()` は
 * 今日どおり動く必要がある。配線されていない場合、`Runtime.markContestedGroup`
 * などは「対応していない」を返し、claim key の衝突検出（3件以上）は PR1（ADR 0378
 * 決定5）の「状態を動かさず evidence だけ積む」経路のままになる。
 *
 * **書き込み（群の作成・解消・穴Aの合流）はこの store の口ではない**——`MemoryStore`
 * の任意メソッド `markContestedGroup?`/`resolveContestedGroup?` が担う
 * （`createMemoryWithOutbox`/`markContestedPair` と同じ作法——複合トランザクションを
 * 要する書き込みは、トランザクションを持つ `MemoryStore` 実装の内部で、他のテーブル
 * （ここでは `memory_relations`）へも直接書く。Postgres 実装では `PostgresMemoryStore`
 * が `memory_relations` へも直接 SQL を発行する——`PostgresRelationStore` の
 * `link`/`unlink` を経由しない）。この store が持つのは**読み取り**（`listRelated`）
 * と、単発の（トランザクション外の）**書き込み**（`link`/`unlink`）だけである。
 */
export interface RelationStore {
  /**
   * `kind` の関係を `fromId`→`toId` の向きで1行作る。**対称関係の相手向き
   * （`toId`→`fromId`）は呼び出し側の責務**——この口自体は片方向しか書かない
   * （ADR 0292 決定1-b の「双方向2行」は、複合トランザクションの中で
   * `MemoryStore.markContestedGroup?` などが2回呼ぶ形、またはそれに相当する
   * 直接 SQL で実現する。この口を単体で2回呼ぶ呼び出し側は、2回の呼び出しの間の
   * 原子性を自分で持たないことに注意）。
   *
   * 冪等——同じ `(tenantId, fromId, toId, kind)` の行が既にあれば、何もしない
   * （2度目の呼び出しでエラーにしない。`UNIQUE` 制約への `ON CONFLICT DO NOTHING`
   * 相当）。
   *
   * **両端の記憶が `ctx.tenantId` のテナントに在ることを、書く前に確かめる**（ADR 0398）。次のとき
   * **例外を投げ、行は書かない**:
   * - `fromId`・`toId` のどちらかが、実在しない記憶を指す（uuid の形でない id も同じ）
   * - `fromId`・`toId` のどちらかが、`ctx.tenantId` 以外のテナントの記憶を指す
   *
   * 例外のメッセージは `memory not found for tenant: <id>` を含む（`MemoryStore` の同種の例外と同じ形）。
   * 「実在しない」と「別のテナントの記憶」は区別しない。DB 由来のエラー（外部キー違反・型変換エラー）は
   * 利用者へ漏らさない。冪等の扱い（上）は両端が確かめられた後の話で、既に同じ行が在っても、
   * 端が確かめられなければ投げる。
   *
   * **`kind` が {@link RelationKind} の列挙の外の値のときも、例外を投げ、行は書かない**（型を外れた値が実行時に
   * 渡ったとき——JS の呼び出し側・型を `as` で曲げた呼び出し）。例外のメッセージは `unknown relation kind: <kind>`
   * を含む。`kind` の検査は、両端の検査・DB への書き込みより前に行う。Postgres では `memory_relations.kind` の
   * CHECK 違反を生のまま漏らさず、INSERT の前にこの例外で断る（in-memory 実装も同じ）。
   */
  link(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void>;
  /**
   * `link` の逆——`fromId`→`toId` の関係行を1行削除する。存在しない行を指定しても
   * 例外にしない（冪等）。相手向きの行には触れない（`link` と対称）。
   */
  unlink(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void>;
  /**
   * `memoryId` を `fromId` とする関係行から、相手側（`toId`）の一覧を返す
   * （ADR 0292 決定1-b の双方向2行書きにより、`fromId`・`toId` どちらの向きで
   * 張られていても、張られた全ての相手がここから引ける）。
   *
   * - `kind` を省略すると、すべての `kind` を対象にする（今日は `'contradicts'`
   *   の1種類しか無いので実質差は無いが、将来 `kind` が増えたときのため型を残す）。
   * - 返す順序は規定しない——呼び出し側（`Runtime`）が必要な順（例:
   *   `validFrom` の新しい順）に並べ替える。
   * - テナント分離: `ctx.tenantId` と異なるテナントの行は返さない。
   * - 返した `Relation.createdAt`（`Date`）は呼び手のもの——呼び手が書き換えても、store の中の行は変わらない
   *   （store は保存している `Date` を参照のまま返さず、複製して返す）。
   */
  listRelated(ctx: Ctx, memoryId: MemoryId, kind?: RelationKind): Promise<Relation[]>;
  /**
   * **任意メソッド**（Issue #1449、ADR 0402）。{@link RelationStore.listRelated} を複数の起点に対して
   * **1回の往復**で行う。`Runtime` の幅優先探索（recall 段3の群の同伴取得・`resolveContestedGroup` の
   * 部分解消の確認・claim key の群の検出）は、1段の frontier をまるごとこれに渡す。実装していない
   * adapter では、`Runtime` は今までどおり `listRelated` を起点ごとに直列に呼ぶ——**実装は義務ではなく、
   * 結果も変わらない**（任意メソッドの追加は非破壊）。
   *
   * - **返り値は `memoryIds` と同じ長さ・同じ並び**の配列で、`result[i]` は
   *   `listRelated(ctx, memoryIds[i], kind)` と**同じ集合**（同じ `kind` の扱い・同じテナント分離）。
   *   起点ごとの分け方は位置で決まるので、綴り（uuid の大文字小文字）の揺れに依らない。
   * - `memoryIds` に**重複があってもよい**——同じ id の位置それぞれに同じ内容を返す（別々の配列）。
   * - **実在しない id・`ctx` のテナントに関係の行を持たない id は、その位置に空配列**を返し、
   *   他の位置には影響しない（例外にしない）。空の `memoryIds` は空配列を返す。
   * - 各要素の中の順序は**規定しない**（`listRelated` と同じ）。呼び出し側（`Runtime`）が必要な順に
   *   並べ替える。位置の順だけは上のとおり規定する。
   * - `listRelated` と違い、uuid の形でない id（Postgres では型変換エラーになる形）でも**例外にせず空配列**を
   *   返してよい（1つの不正な id がバッチ全体を落とさないため）。
   */
  listRelatedMany?(
    ctx: Ctx,
    memoryIds: readonly MemoryId[],
    kind?: RelationKind,
  ): Promise<Relation[][]>;
}
