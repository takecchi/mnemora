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
   */
  listRelated(ctx: Ctx, memoryId: MemoryId, kind?: RelationKind): Promise<Relation[]>;
}
