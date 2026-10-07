import type { Ctx } from "./ctx.js";
import type { MemoryStore } from "./interfaces/memory-store.js";
import type { OutboxStore } from "./interfaces/outbox-store.js";
import type { TenantSettingsStore } from "./interfaces/tenant-settings-store.js";
import type { VectorStore } from "./interfaces/vector-store.js";
import { omitParamsFromError } from "./failure-description.js";

/**
 * あるテナントに属する**全表・全行**を跡形なく消す（[ADR 0383](../../../docs/decisions/0383-erase-tenant.md)）。
 *
 * `Runtime.forget`/`purge` は1つの Memory、`purgeExpiredEventsForTenant` は `memory_events` だけが対象で、
 * `recalls`・`recall_usages`・`outbox`・`provenance.speaker`・呼び手が渡した識別子など消えずに残る表・列が
 * 多数あった。この関数は、それらすべてを含めて「このテナントに属する行」を網羅的に消す独立した操作である。
 *
 * 🔴 **`Runtime` のメソッドは増やさない。`tick()`/`observe()` にも配線しない。**
 * `purgeExpiredEventsForTenant`（`event-retention-purge.ts`）と同じ置き方で、呼ぶのは運用側のスクリプト・
 * 管理コンソール・法的要求への応答フローである。**明示呼び出しのみ。**
 *
 * ## deps（4つの port、すべて任意メソッド）
 *
 * `{ memoryStore, vectorStore, outboxStore, tenantSettingsStore }` の各 port の `eraseTenant?` を呼ぶ。
 * **1つでも実装していない port があれば、何も消さずに `{ kind: "store_unsupported", missing }` を返す。**
 * 「対応している port だけ消す」部分的なフォールバックはしない。一部の表だけ消えた状態を「実行した」として
 * 返すと、呼び出し側が「もう消えている」と誤解し、残った表（法的な開示対象になりうる）を見落とすため。
 * `missing` は port の名前を名指しする。
 *
 * `EventStore` には足さない。`memory_events` は `MemoryStore.eraseTenant?` の内部で直接消す（ADR 0383）。
 *
 * ## 呼び出しの順序: memoryStore → vectorStore → outboxStore → tenantSettingsStore
 *
 * **`memoryStore` を最初にする。**`blocked_by_foreign_reference` を返しうる唯一の port で、それが起きたときに
 * ほかの port へまだ1行も触れていない状態を保つため（止めるときは途中まで消えた状態を残さない。ADR 0383）。
 * そのとき `memoryStore` の側も1行も消していない（検査は削除と同じトランザクションの先頭で行う）。
 * 設定（`tenantSettingsStore`）は最後にする。途中で処理が中断しても「テナントが存在する」手がかりとして残る。
 *
 * 🔴 **いずれかの port が `reachedLimit: true` を返したら、そこで打ち切り、後ろの port は呼ばない**
 * （`reachedLimit: true` で返る）。`limit` で止まった回に後ろの port まで進むと、`memories` が残ったまま
 * 設定・outbox・埋め込みだけが先に消えるため。
 *
 * - **呼ばなかった port の `deleted` は `0`** を返す（欠落や `undefined` にすると戻り値の型が割れる）。
 * - **`dryRun` も同じ経路を通る**: `memoryStore` が `reachedLimit` なら、後ろの port は数えずに `0` で返す。
 *   プレビューの形と実際に起きる形を割らないため。
 *
 * ⚠ **4つの port は別々の呼び出しであり、分散トランザクションではない。**
 * `blocked_by_foreign_reference` 以外の理由（接続断など）で途中の port が例外を投げた場合、それより前の
 * port の削除はコミット済みのまま残る。同じ `opts` で呼び直せば、済んだ port は0件で通過する
 * （各 store の `eraseTenant?` は冪等）。
 *
 * ⚠ **同じテナントへの同時呼び出しは直列になる**（[ADR 0430](../../../docs/decisions/0430-concurrent-create-erase-and-standalone-params.md)）。
 * `@mnemora/postgres` は、`memoryStore`・`vectorStore`・`outboxStore` の各 `eraseTenant` のトランザクションの
 * 先頭で、テナントごとの advisory lock（`pg_advisory_xact_lock`）を取る。後から来た呼び出しは、先の呼び出しの
 * **その port のトランザクション**のコミットを待ち、コミット後の状態から数え始める（待ちに mnemora の上限は
 * 掛けない）。直列になるのは port ごとで、4つの port をまたぐ全体ではない（別の呼び出しが port の間に割り込みうる）。
 * 別のテナントは待たない。この lock を取らない実装（自前の adapter など）では、同時に呼ぶと相手が先に消した行が
 * 数えられず、「予算未満なら表は空」と読み違えうる。
 *
 * ⚠ **投げる例外の message から、drizzle の `params:` より後ろを落とす**（ADR 0430。`Runtime` の全メソッドと
 * 同じ作法、[ADR 0423](../../../docs/decisions/0423-identifier-well-formed-and-error-message-without-params.md)）。
 *
 * ## 引数の検査（書き込み前）
 *
 * - `opts.confirmTenantId !== ctx.tenantId` なら `RangeError` を投げる。`ctx.tenantId` の1箇所だけを頼りに
 *   全表を消す操作は、呼び出し側の変数の取り違えに脆い。`confirmTenantId` を別引数として要求し、一致しない限り
 *   書き込みを一切行わないことで二重確認にする（取り消せない操作であるため）。
 * - `opts.limit` が正の整数でなければ `RangeError` を投げる。
 *
 * どちらも**書き込みより前**に投げる。
 *
 * ## 戻り値
 *
 * - `{ kind: "store_unsupported"; missing }` — 上記。
 * - `{ kind: "blocked_by_foreign_reference"; count }` — 他テナントの行がこのテナントの行を FK で参照している
 *   ため、`memoryStore` 側のバッチが何も消さずにロールバックした（`MemoryStore.eraseTenant` の doc 参照）。
 * - `{ kind: "executed"; dryRun; deleted; reachedLimit }` — 実行した（または `dryRun` でプレビューした）。
 *   `reachedLimit === true` なら、同じ `opts` で呼び直すこと。**この関数は何度呼んでも安全**（既に空になった表は
 *   0件を返すだけ）。⚠ **`reachedLimit === false` は「空になった」の証明ではない**（次の節）。
 *
 * ### ⚠ そのテナントへの書き込みを止めてから呼ぶ／`deleted` が全部 `0` になるまで呼び直す
 *
 * **同じテナントへ書き込み（`observe()`・`tick()` など）を続けながら呼ぶと、行が残りうる。**消している途中に別の
 * 処理が書いた行は、その回では消えない。⟹ **そのテナントへの書き込みを止めてから呼ぶこと**（止め方は呼び出し側の
 * 責務）。
 *
 * **終わりの判定は、`reachedLimit` だけでなく `deleted` を見る。**`reachedLimit` は「ある表でちょうど `limit` 件
 * 消せた」ときだけ `true` になる近似で、消している間に書かれた行は知らない。⟹ **書き込みを止めたうえで、
 * `deleted` の4欄が全部 `0` で返る回が1回出るまで、同じ `opts` で呼び直すこと。**「消えたか」の確認は、消去後に
 * 表を数えて行う。
 *
 * どの表に残りうるか（`@mnemora/postgres` の実装から読んだ推論で、書き込みを実際に割り込ませては確かめていない）:
 * - `memoryStore`: 表ごとの削除は「先に対象の id を選び、その id だけを消す」文である。その文が始まった後に
 *   他のトランザクションがコミットした行は、その回の対象にならず残る。`tenant_activity`・`tenant_subject_activity`
 *   も、`observe()`・`tick()` が書くたびに作り直されうる。
 * - `outboxStore`: `memoryStore` の後に消す。その後に積まれたジョブは残る。
 * - `vectorStore`: `memories` の削除で埋め込みは CASCADE で消えている。その後に走った `embed` の書き込みは、
 *   `memories` への外部キーで失敗するはずだが、確かめていない。
 * - `tenantSettingsStore`: 最後に消す。`setEventRetention` などが呼ばれると、行が作り直される。
 *
 * ### ⚠ `deleted` の各欄は「その port 自身が、この呼び出しで消した行数」である
 *
 * 合計ではなく、CASCADE で巻き込まれて消えた行も数えない。とくに **`deleted.vectorStore`**: `memoryStore` を
 * 先に消すと、`memories` の行が消えた時点で `memory_embeddings_<space>.memory_id` の `ON DELETE CASCADE` が
 * 埋め込みの行を一緒に消す。
 *
 * - **1回で消し切ったとき**: `vectorStore.eraseTenant?` が呼ばれる頃には埋め込みはもう残っていないので、本番の
 *   `deleted.vectorStore` は `0` になる（`dryRun` は何も消さないので、消える予定の埋め込みを数えた実数を返す）。
 *   埋め込みは正しく消えている。
 * - **`limit` で途中で止まったとき**: `vectorStore` は呼ばれず、`deleted.vectorStore` は `0`（`dryRun` でも `0`）。
 *   この回に消えた `memories` の埋め込みは CASCADE で消えているが、どの欄にも数えられない。
 *
 * 本番で `deleted.vectorStore` が実数になるのは、`memoryStore` が消し切ったあとになお埋め込みの行が残っている
 * とき（CASCADE を持たない `VectorStore` の別実装など）だけで、**確かめていない**。
 * `deleted.memoryStore` も、`memoryStore` が消した全表（`memories` を含む。一覧は `MemoryStore.eraseTenant` の doc）の
 * 行数の合計であり、`memories` だけの行数ではない。呼び順は ADR 0383 の不変条件のために変えない。
 * 「消えたか」は戻り値の件数ではなく、消去後に表を数えて確かめること。
 *
 * ## DB には消去の記録を何も残さない
 *
 * `purgeExpiredEventsForTenant` と違い、この操作は `memory_events` に `events_purged` のような監査行を積まない
 * （`memory_events` テーブル自体が消す対象のため）。呼び出し側に返すのは、この関数の戻り値だけである。
 *
 * ## 決めていないこと
 *
 * `recalls` の保持方針（生きているテナントの分）は決めていない（[ADR 0290](../../../docs/decisions/0290-activity-seq-read-path-documented-not-implemented.md)）。
 * この関数は「テナントを丸ごと消す」操作の一部として `recalls` も消すが、未決の問いには答えていない。
 */
export type EraseTenantMissingStore =
  "memoryStore" | "vectorStore" | "outboxStore" | "tenantSettingsStore";

/** {@link eraseTenant} の戻り値。各 `kind` の意味は `EraseTenantMissingStore` の直上の doc の「戻り値」節を見ること。 */
export type EraseTenantOutcome =
  | { kind: "store_unsupported"; missing: EraseTenantMissingStore[] }
  | { kind: "blocked_by_foreign_reference"; count: number }
  | {
      kind: "executed";
      dryRun: boolean;
      deleted: {
        memoryStore: number;
        vectorStore: number;
        outboxStore: number;
        tenantSettingsStore: number;
      };
      reachedLimit: boolean;
    };

/** {@link eraseTenant} の引数。 */
export interface EraseTenantOptions {
  /**
   * `ctx.tenantId` と一致することを要求する二重確認（上の interface doc 参照）。
   * **必須・既定値なし。**
   */
  confirmTenantId: string;
  /**
   * 1回の呼び出しで削除する目安の上限。各 port へそのまま渡す。**必須・既定値なし**
   * （`PurgeExpiredEventsForTenantOptions.limit` と同じ理由）。
   */
  limit: number;
  /** `true` なら削除を一切行わず、削除していたら消えていたであろう件数だけを返す。省略時は `false`。 */
  dryRun?: boolean | undefined;
}

/** {@link eraseTenant} の deps。4つとも任意メソッド `eraseTenant?` を持ちうる port。 */
export interface EraseTenantDeps {
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
  outboxStore: OutboxStore;
  tenantSettingsStore: TenantSettingsStore;
}

/**
 * テナント1つの全表・全行を消す（詳細は `EraseTenantMissingStore` の直上の doc。ADR 0383）。
 *
 * `opts.confirmTenantId !== ctx.tenantId`（完全一致で比べる）、または `opts.limit` が正の整数でないときは、
 * 書き込みの前に `RangeError` を投げる。port が1つでも `eraseTenant?` を持たなければ何も消さず
 * `store_unsupported` を返す。投げる例外は drizzle の `params:` 以降を落とした message になる（ADR 0430）。
 */
export async function eraseTenant(
  ctx: Ctx,
  deps: EraseTenantDeps,
  opts: EraseTenantOptions,
): Promise<EraseTenantOutcome> {
  try {
    return await eraseTenantBody(ctx, deps, opts);
  } catch (error) {
    // 公開の独立関数が投げる例外も、drizzle の `params:` を落とす（ADR 0430）。
    throw omitParamsFromError(error);
  }
}

async function eraseTenantBody(
  ctx: Ctx,
  deps: EraseTenantDeps,
  opts: EraseTenantOptions,
): Promise<EraseTenantOutcome> {
  if (opts.confirmTenantId !== ctx.tenantId) {
    throw new RangeError(
      `eraseTenant: opts.confirmTenantId ("${opts.confirmTenantId}") must equal ctx.tenantId ("${ctx.tenantId}")`,
    );
  }
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
    throw new RangeError(`eraseTenant: opts.limit must be a positive integer, got ${opts.limit}`);
  }

  const missing: EraseTenantMissingStore[] = [];
  if (!deps.memoryStore.eraseTenant) {
    missing.push("memoryStore");
  }
  if (!deps.vectorStore.eraseTenant) {
    missing.push("vectorStore");
  }
  if (!deps.outboxStore.eraseTenant) {
    missing.push("outboxStore");
  }
  if (!deps.tenantSettingsStore.eraseTenant) {
    missing.push("tenantSettingsStore");
  }
  if (missing.length > 0) {
    return { kind: "store_unsupported", missing };
  }

  const storeOpts = { limit: opts.limit, dryRun: opts.dryRun };

  // 順序は上の doc のとおり。上のチェックで4つとも存在することを確認済みなので non-null アサーションで呼ぶ。
  //
  // 🔴 `deps.xxxStore.eraseTenant` をローカル変数へ取り出してから呼ばない。レシーバから切り離すと、
  // 実装が内部で `this` を使っているときに `this` が `undefined` になって壊れる。
  // `deps.vectorStore.eraseTenant!(...)` の形でレシーバを保つ。
  const memoryResult = await deps.memoryStore.eraseTenant!(ctx, storeOpts);

  if (memoryResult.kind === "blocked_by_foreign_reference") {
    return { kind: "blocked_by_foreign_reference", count: memoryResult.count };
  }

  // 止まった回は後ろの port を呼ばない（上の doc）。
  const deleted = {
    memoryStore: memoryResult.deleted,
    vectorStore: 0,
    outboxStore: 0,
    tenantSettingsStore: 0,
  };
  const stopped = (): EraseTenantOutcome => ({
    kind: "executed",
    dryRun: opts.dryRun ?? false,
    deleted: { ...deleted },
    reachedLimit: true,
  });
  if (memoryResult.reachedLimit) {
    return stopped();
  }

  const vectorResult = await deps.vectorStore.eraseTenant!(ctx, storeOpts);
  deleted.vectorStore = vectorResult.deleted;
  if (vectorResult.reachedLimit) {
    return stopped();
  }

  const outboxResult = await deps.outboxStore.eraseTenant!(ctx, storeOpts);
  deleted.outboxStore = outboxResult.deleted;
  if (outboxResult.reachedLimit) {
    return stopped();
  }

  const tenantSettingsResult = await deps.tenantSettingsStore.eraseTenant!(ctx, storeOpts);
  deleted.tenantSettingsStore = tenantSettingsResult.deleted;

  return {
    kind: "executed",
    dryRun: opts.dryRun ?? false,
    deleted,
    reachedLimit: tenantSettingsResult.reachedLimit,
  };
}
