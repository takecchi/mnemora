import type { Ctx } from "../ctx.js";
import type { MemoryId, ObservationId, RecallId } from "../ids.js";
import type { EmbeddingStatus, Memory, MemoryStatus, NewMemory } from "../memory.js";
import type { NewObservation, Observation } from "../observation.js";
import type { OutboxJobRecord } from "../outbox.js";
import type { NewRecallRecord, RecallScope, ScopeAggregate } from "../recall.js";
import type { OutboxJobKind } from "./scheduler.js";

/**
 * `updateStatus` に `opts.expectedStatus` を渡したとき、書き込み時点の実際の status が
 * それと一致しなかったことを表す（PR「update-status-compare-and-swap」、ADR 0030）。
 * `packages/postgres/src/advisory-lock.ts` の型付きエラー階層（`AdvisoryLockTimeoutError` /
 * `AdvisoryLockUnavailableError`）に倣い、`Error` を継承した専用の型として定義する
 * ——呼び出し側が `instanceof` で「対象が無かった」と区別できることが目的。
 *
 * **`observedStatus` は「弾かれた後に読み直した値」であり、弾かれた瞬間の値とは限らない。**
 * adapter（`packages/postgres`）は `UPDATE ... WHERE status = expectedStatus` が0行だった
 * ときに追加の `SELECT` で読み直して詰めるため、その `SELECT` と実際に条件が破れた瞬間の
 * 間にも別の書き込みが割り込む余地がある。「衝突があったこと」は確実だが、「衝突した
 * 相手が何だったか」の正確な値としては読まないこと。
 */
export class MemoryStatusConflictError extends Error {
  constructor(
    readonly memoryId: MemoryId,
    readonly expectedStatus: MemoryStatus,
    readonly observedStatus: MemoryStatus | null,
  ) {
    super(
      `MemoryStore.updateStatus: expected status "${expectedStatus}" for memory ${memoryId}, ` +
        `but observed ${observedStatus === null ? "(memory disappeared)" : `"${observedStatus}"`}`,
    );
    this.name = "MemoryStatusConflictError";
  }
}

/**
 * MemoryStore — Phase 1（docs/architecture.md §5.1）。
 *
 * 実装は adapter 側（`packages/postgres` 等）に置く。ここは型のみ。
 *
 * 契約（振る舞い。型からは読み取れないため、`packages/testkit` の適合テストで検査する）:
 * - `createMemory` は `(tenant_id, source_observation_id, extractor_version, content_hash)` の
 *   一意制約により冪等（docs/architecture.md §3.5）。
 * - `reinforce` は挿入が実際に起きたときだけ `last_reinforced_at` / `strength` を更新し、
 *   `decay_floor_at` を再計算する。
 * - `status = 'contested'` の Memory を単独で返してはならない。対向する Memory を
 *   スコアに関係なく必ず一緒に取得できなければならない（mandatory companion retrieval）。
 * - `aggregateScope` の返り値は近似を許すが、`countKind` を必ず伴う（Phase 1 は常に厳密。
 *   PR 本文の「設計上の疑義」参照）。`groups` の総和は必ず `totalInScope` と一致する。
 * - テナント分離: すべてのメソッドは `ctx.tenantId` に一致しない行を返してはならない。
 *   `testkit` は2テナントを同時に投入し、クロステナントの取得が0件になることを検査する。
 *
 * D9（マネージャー決定）で以下2メソッドを追加した。理由は docs/architecture.md §5.1 に
 * 追記済み:
 * - `getMany` — recall 段3の mandatory companion retrieval が `get` の連続呼び出し
 *   （N+1）にならないようにするため。
 * - `recordUsage` — 「実際に挿入が起きたときだけ強化する」という契約
 *   （docs/memory-model.md §6）を呼び出し側が知るための戻り値
 *   （`insertedMemoryIds`）を持つ。`reinforce` 単体では「実際に挿入されたか」を
 *   呼び出し側は知れない。
 *
 * roadmap.md 段階3（取り込み）で以下4メソッドを追加した:
 * - `getObservation` — `runtime.tick`（`extract: 'deferred'` の消化・ADR 0005）が
 *   outbox ジョブの payload から `observationId` だけを受け取り、本文を取り直すために使う。
 * - `createObservationWithOutbox` / `createMemoryWithOutbox` — transactional outbox
 *   （docs/architecture.md §3.4）を実現するための書き込み口。`observe()` の DB コミットと
 *   「抽出/埋め込みジョブを outbox に積む」を同一トランザクションで行うには、
 *   Observation/Memory の作成そのものにジョブ書き込みを同居させる必要がある
 *   （PR 本文の「決めたこと」参照）。**新規に行を作成できたとき（`created: true`）だけ
 *   ジョブを積む**——冪等な再送（`created: false`）でジョブを重複させない。
 * - `setEmbeddingStatus` — `embeddingStatus` の `pending → ready | failed` 遷移
 *   （roadmap.md 段階3の完了条件）を書き込む。
 *
 * ADR 0028（`runtime.reextract`）で以下1メソッドを追加した:
 * - `listBySourceObservation` — ある Observation から、ある版の抽出器で作られた Memory を
 *   列挙する（**SELECT のみ**）。`reextract` が「今回作られた content_hash の集合に
 *   含まれない既存 Memory」を判定するために使う。マイグレーション・索引の追加は伴わない
 *   ——`(tenant_id, source_observation_id, extractor_version, content_hash)` の一意索引
 *   （0001_init.sql）は既に `source_observation_id` を先頭から使える形をしている。
 *
 * roadmap.md 段階4/5（想起・説明）で以下2メソッドを追加した（本 PR）:
 * - `aggregateScope` — `countByGroup` を置き換える。旧 `countByGroup` は群カウント
 *   （`GroupCount[]`）しか返さず、`totalInScope`・`filtered` 系の件数を別のクエリで
 *   取らざるを得なかった。マネージャー決定（docs/recall.md §5 の「スコープの外延」
 *   補完）により、群カウント・スコープ内総数・スコープを定義するフィルタ（period/status）
 *   で落ちた件数・`not_indexed` 件数を**単一の集約クエリ**から返す必要が生じたため、
 *   戻り値を `ScopeAggregate` に拡張した契約として置き換えた。
 * - `createRecall` — recall 段6（記録）の書き込み口。`recallId` を発行して `recalls`
 *   テーブルへ1行残す（docs/recall.md §2 段6、ADR 0008）。この段は省略可能な段ではない
 *   ——`recallId` が発行されないと `observe({kind:'memory_usage'})` が recall を
 *   参照できなくなる。
 *
 * PR「update-status-compare-and-swap」（ADR 0030）で `updateStatus` に `opts.expectedStatus`
 * を足した: `reextract` の「`status !== 'active'` なら触らない」という安全弁が、読み（
 * `listBySourceObservation`）と書き（`updateStatus`）の間に別の書き込みが割り込む
 * TOCTOU で破れる穴を塞ぐ。省略時の振る舞いは変えていない。
 */
export interface MemoryStore {
  createObservation(ctx: Ctx, input: NewObservation): Promise<Observation>;
  /** roadmap.md 段階3: outbox ジョブから observationId を渡された側が本文を取り直すための読み出し。 */
  getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null>;
  /**
   * roadmap.md 段階3: Observation の作成と outbox ジョブ書き込みを同一トランザクションで行う。
   * `jobKinds` の各要素につき1件のジョブを作る。ジョブの `payload` は
   * `{ observationId: <作成された Observation の id> }` に固定される（adapter が作成後の
   * id を使って組み立てる。呼び出し側が id をまだ知らない時点で呼ぶための設計）。
   * 冪等な再送（`externalId` が既存行と衝突）の場合は `created: false` を返し、
   * ジョブは一切作らない（`jobs` は空配列）。
   */
  createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[],
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }>;
  createMemory(ctx: Ctx, input: NewMemory): Promise<Memory>;
  /**
   * roadmap.md 段階3: Memory の作成と outbox ジョブ書き込み（主に `embed`）を
   * 同一トランザクションで行う。`createObservationWithOutbox` と対になる契約。
   * 抽出の冪等性（`(tenant_id, source_observation_id, extractor_version, content_hash)`）で
   * 既存行に衝突した場合は `created: false` を返し、ジョブは作らない
   * （同じ内容に対して埋め込みジョブを重複させない）。
   */
  createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[],
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
  get(ctx: Ctx, id: MemoryId): Promise<Memory | null>;
  /** D9: recall 段3の mandatory companion retrieval のための一括取得。 */
  getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]>;
  /**
   * ADR 0028: ある Observation から、ある版の抽出器で作られた Memory を列挙する
   * （**SELECT のみ**。マイグレーション・索引を追加しない）。`extractorVersion` は
   * `NULLS NOT DISTINCT`（0001_init.sql）と同じ規約で `null` を1つの値として扱う
   * ——`extractorVersion: null` を渡すと `extractor_version IS NULL` の行を返す。
   */
  listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null,
  ): Promise<Memory[]>;
  /**
   * PR「update-status-compare-and-swap」（安全弁3、docs/decisions/0030-*.md）:
   * `opts.expectedStatus` を渡すと、書き込み時点で対象 Memory の `status` が
   * その値と一致するときだけ更新する（compare-and-swap）。**省略時は今日と同じ振る舞い**
   * ——status を条件にせず常に更新する。
   *
   * `expectedStatus` と実際の status が食い違っていた場合は {@link MemoryStatusConflictError}
   * を投げる。対象の Memory がそもそも存在しない場合は（`expectedStatus` の有無に関わらず）
   * 今日と同じ「memory not found」の例外のまま——「対象が無い」と「status が期待と
   * 違った」は別の例外で区別できる。
   *
   * `expectedStatus` を**単数**にしている理由: 現時点の唯一の呼び出し元
   * （`runtime.ts` の `reextract`）が要る条件は `"active"` の1つだけであり、
   * 集合（配列）にする理由が無い。採らなかった案は ADR 0030 参照。
   */
  updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
  ): Promise<Memory>;
  /** roadmap.md 段階3: `embeddingStatus` の `pending → ready | failed` 遷移を書き込む。 */
  setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory>;
  reinforce(ctx: Ctx, id: MemoryId, at: Date): Promise<Memory>;
  /**
   * D9: 使用報告を記録する。`(recall_id, memory_id)` の挿入が実際に起きたものだけを
   * `insertedMemoryIds` として返す（再送は空配列になりうる）。
   */
  recordUsage(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[],
  ): Promise<{ insertedMemoryIds: MemoryId[] }>;
  /**
   * roadmap.md 段階4/5: 群カウント・スコープ内総数・スコープを定義するフィルタ
   * （status/period）で落ちた件数・not_indexed 件数を単一の集約クエリから返す
   * （`ScopeAggregate` の doc コメント、docs/recall.md §5 参照）。
   * 契約: 返り値の `groups` の総和は必ず `totalInScope` と一致する
   * （同一クエリから導出するため、並行する書き込みがあっても構造的に崩れない）。
   */
  aggregateScope(ctx: Ctx, scope: RecallScope): Promise<ScopeAggregate>;
  /** roadmap.md 段階4/5: recall 段6（記録）。`recalls` へ1行書き込み、発行した recallId を返す。 */
  createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId>;
}
