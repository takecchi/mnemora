import type { Ctx } from "./ctx.js";
import type { MemoryStore } from "./interfaces/memory-store.js";
import type { OutboxStore } from "./interfaces/outbox-store.js";
import type { TenantSettingsStore } from "./interfaces/tenant-settings-store.js";
import type { VectorStore } from "./interfaces/vector-store.js";

/**
 * Issue #1207 / [ADR 0383](../../../docs/decisions/0383-erase-tenant.md):
 * あるテナントに属する**全表・全行**を跡形なく消す。
 *
 * mnemora は今日、テナント単位で消去する口を持っていない——`Runtime.forget`/`purge` は
 * 1つの Memory を対象にし、`purgeExpiredEventsForTenant`（Issue #210、ADR 0115）は
 * `memory_events` だけを対象にする。Issue #994・#995・#1064 が「forget→purge→保持期間の
 * 掃除」を当てはめて実測したところ、`recalls`・`recall_usages`・`outbox`・
 * `provenance.speaker`・呼び手が渡した識別子など、消えずに残る表・列が多数あった
 * （#1207 本文の表）。この関数は、それらすべてを含めて「このテナントに属する行」を
 * 網羅的に消す、独立した新しい操作として実装する。
 *
 * 🔴 **`Runtime` のメソッドは増やさない。`tick()`/`observe()` にも配線しない。**
 * `purgeExpiredEventsForTenant`（同ディレクトリ、`event-retention-purge.ts`）と同じ
 * 置き方——呼び出すのは運用側のスクリプト・管理コンソール・法的要求への応答フローであり、
 * `packages/core` はその「呼ぶための部品」だけを提供する。**明示呼び出しのみ。**
 *
 * ## deps（4つの port、すべて任意メソッド）
 *
 * `{ memoryStore, vectorStore, outboxStore, tenantSettingsStore }` を受け取り、各 port の
 * `eraseTenant?`（任意メソッド）を呼ぶ。**4つのうち1つでも実装していない port があれば、
 * 何も消さずに `{ kind: "store_unsupported", missing }` を返す**——部分的なフォールバック
 * （「対応している port だけ消す」）はしない。理由: 「テナントを消した」という主張は
 * 全表が空になって初めて成立する。一部の表だけ消えた状態を「実行した」として返すと、
 * 呼び出し側が「もう消えている」と誤解し、残った表（法的な開示対象になりうる）を
 * 見落とす。`missing` は port の名前を名指しするので、呼び出し側は「どの adapter を
 * 差し替えれば実行できるか」をここから読める（`purgeExpiredEventsForTenant` の
 * `store_unsupported` が `MemoryStore` 単体について持つ性質を、4 port の組へ広げた形）。
 *
 * `EventStore` には足さない——`memory_events` は `MemoryStore.eraseTenant?` の内部で
 * 直接消す（ADR 0115 決定4が `EventStore` を経由せず `MemoryStore` 側で `memory_events` を
 * 扱ってきたのと同じ形。ADR 0383 参照）。
 *
 * ## 呼び出しの順序: memoryStore → vectorStore → outboxStore → tenantSettingsStore
 *
 * **`memoryStore` を最初にする。**`memoryStore.eraseTenant?` は
 * {@link EraseTenantOutcome} の `blocked_by_foreign_reference` を返しうる唯一の port で
 * あり、それが起きたときに**ほかの port へまだ1行も触れていない**状態を保つため
 * （クローン miku の決定「止めるときは、途中まで消えた状態を残さない」、ADR 0383）。
 * `blocked_by_foreign_reference` のとき、`memoryStore` の側は1行も消していない
 * （検査は削除と同じトランザクションの先頭で行う）。
 *
 * 設定（`tenantSettingsStore`）は最後にする——`getEventRetention` 等が読む設定は、
 * 途中で処理が中断してもまだ「テナントが存在する」ことの手がかりとして残る。
 *
 * ⚠ **4つの port は別々の呼び出しであり、分散トランザクションではない。**
 * `blocked_by_foreign_reference` 以外の理由（接続断など）で途中の port が例外を投げた
 * 場合、それより前の port の削除はコミット済みのまま残る。次に同じ `opts` で呼び直せば、
 * 済んだ port は0件で通過する——各 store の `eraseTenant?` は冪等であり、副作用が
 * 二重に起きることはない。
 *
 * ## 引数の検査（書き込み前）
 *
 * - `opts.confirmTenantId !== ctx.tenantId` なら `RangeError` を投げる——`ctx.tenantId`
 *   の1箇所だけを頼りに全表を消す操作は、呼び出し側の変数の取り違え（別テナントの `ctx`
 *   を渡してしまう等）に対して脆い。`confirmTenantId` を別引数として要求し、一致しない
 *   限り書き込みを一切行わないことで、「本当にこのテナントを消すつもりで呼んだか」の
 *   二重確認にする（取り消せない操作であるため）。
 * - `opts.limit` が正の整数でなければ `RangeError` を投げる。
 *
 * どちらも**書き込みより前**に投げる——`MemoryStore.markContestedPair?` の
 * `first.id === second.id` チェックと同じ「開く前に落とす」位置。
 *
 * ## 戻り値
 *
 * - `{ kind: "store_unsupported"; missing }` — 上記。
 * - `{ kind: "blocked_by_foreign_reference"; count }` — 他テナントの行がこのテナントの
 *   行を FK で参照しているため、`memoryStore` 側のバッチが何も消さずにロールバックした
 *   （`MemoryStore.eraseTenant` の doc コメント参照）。
 * - `{ kind: "executed"; dryRun; deleted; reachedLimit }` — 実行した（または `dryRun` で
 *   プレビューした）。`reachedLimit === true` なら、呼び出し側は同じ `opts` で
 *   呼び直すこと——**この関数は何度呼んでも安全**（既に空になった表は0件を返すだけ）。
 *   ⚠ **`reachedLimit === false` は「空になった」の証明ではない**（次の節）。
 *
 * ### ⚠ そのテナントへの書き込みを止めてから呼ぶ／`deleted` が全部 `0` になるまで呼び直す
 *
 * **同じテナントへ書き込み（`observe()`・`tick()` など）を続けながら呼ぶと、行が残りうる。**
 * 消している途中に別の処理が書いた行は、その回では消えない。⟹ **そのテナントへの書き込みを
 * 止めてから呼ぶこと**（止め方は呼び出し側の責務。この関数は書き込みを止めない）。
 *
 * **終わりの判定は、`reachedLimit` だけでなく `deleted` を見る。**書き込みが止まっていなければ、
 * `reachedLimit === false` で返った回の後にも行が残りうる（`reachedLimit` は「ある表でちょうど
 * `limit` 件消せた」ときだけ `true` になる近似であり、消している間に書かれた行は知らない）。
 * ⟹ **書き込みを止めたうえで、`deleted` の4欄が全部 `0` で返る回が1回出るまで、同じ `opts` で
 * 呼び直すこと。**「消えたか」の確認は、下の節のとおり、消去後に表を数えて行う
 * （`deleted.vectorStore` は CASCADE のため本番では `0` になりうるので、`deleted` が全部 `0` に
 * なったことは「この回は何も見つからなかった」だけを言う）。
 *
 * どの表に残りうるか（`@mnemora/postgres` の実装を読んで書いた。⚠ **書き込みを実際に割り込ませて
 * 起こしてはいない——コードから読んだ推論である**）:
 * - `memoryStore`: 1つのトランザクションだが、表ごとの削除は「先に対象の id を選び、その id だけを
 *   消す」文である。その文が始まった後に他のトランザクションがコミットした行（`memories`・
 *   `observations`・`memory_events`・`recalls`・`recall_usages`・`labels`・`memory_labels`・
 *   `memory_relations`）は、その回の対象にならず残る。`tenant_activity`・`tenant_subject_activity`
 *   も、`observe()`・`tick()` が書くたびに作り直されうる。
 * - `outboxStore`: `memoryStore` の後に消す。その後に積まれたジョブ（`embed`・`extract` など）は残る。
 * - `vectorStore`: `memoryStore` の後に消す。`memories` の削除で埋め込みは CASCADE で消えている。
 *   その後に走った `embed` の書き込みは、`memories` への外部キーで失敗するはずだが、確かめていない。
 * - `tenantSettingsStore`: 最後に消す。`setEventRetention` などが呼ばれると、行が作り直される。
 *
 * ### ⚠ `deleted.vectorStore` は、`dryRun` では実数、本番では `0` になりうる
 *
 * `memoryStore` を先に消す（上の順序）と、`memories` の行が消えた時点で、
 * `memory_embeddings_<space>.memory_id` の `ON DELETE CASCADE` が埋め込みの行を一緒に消す。
 * `vectorStore.eraseTenant?` が呼ばれる頃には、そのテナントの埋め込みはもう残っておらず、
 * 数えるものが無い——だから本番では `deleted.vectorStore` が `0` を返す（`dryRun` は何も消さないので、
 * 消える予定の埋め込みを数えて `26` のような実数を返す）。**行は正しく消えている。**
 * `deleted.vectorStore` は「`VectorStore.eraseTenant?` 自身が消した行数」であって、
 * 「消えた埋め込みの総数」ではない。CASCADE で消えた分は、どの欄にも数えられない
 * （`deleted.memoryStore` も `memories` 側の行数を数えるだけである）。
 * 呼び順は [ADR 0383](../../../docs/decisions/0383-erase-tenant.md) 決定5の不変条件のために変えない。
 * 「消えたか」は戻り値の件数ではなく、消去後に表を数えて確かめること。
 *
 * ## DB には消去の記録を何も残さない
 *
 * `purgeExpiredEventsForTenant` と違い、この操作は `memory_events` に
 * `events_purged` のような監査行を一切積まない——`memory_events` テーブル自体を
 * 消す対象に含めているため（`MemoryStore.eraseTenant?` の doc コメント参照）。
 * 呼び出し側に返すのは、この関数の戻り値だけである。
 *
 * ## 決めていないこと
 *
 * `recalls` の保持方針（生きているテナントの分）は、この ADR では決めていない
 * （[ADR 0290](../../../docs/decisions/0290-activity-seq-read-path-documented-not-implemented.md)
 * が「`recalls` の保持方針」を先の話として残したまま）。この関数は「テナントを丸ごと
 * 消す」操作の一部として `recalls` も消すが、それは未決の問いには答えていない。
 */
export type EraseTenantMissingStore =
  "memoryStore" | "vectorStore" | "outboxStore" | "tenantSettingsStore";

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
  dryRun?: boolean;
}

/** {@link eraseTenant} の deps。4つとも任意メソッド `eraseTenant?` を持ちうる port。 */
export interface EraseTenantDeps {
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
  outboxStore: OutboxStore;
  tenantSettingsStore: TenantSettingsStore;
}

export async function eraseTenant(
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

  // 順序: memoryStore → vectorStore → outboxStore → tenantSettingsStore（上の doc 参照）。
  // 上のチェックで4つとも存在することを確認済み（non-null アサーション）。
  //
  // 🔴 **`deps.xxxStore.eraseTenant` をローカル変数へ取り出してから呼ばない。**
  // `const f = deps.vectorStore.eraseTenant!; f(ctx, storeOpts)` は、関数をレシーバ
  // （`deps.vectorStore`）から切り離して呼ぶ形になり、実装が内部で `this`（例:
  // `PostgresVectorStore` のプールへの参照、`FakeVectorStore` の `this.entries`）を
  // 使っていると `this` が `undefined` になって壊れる。**必ず `deps.vectorStore.
  // eraseTenant!(...)` の形（プロパティアクセスした式をそのまま呼ぶ）で呼び、
  // レシーバを保つ。**
  const memoryResult = await deps.memoryStore.eraseTenant!(ctx, storeOpts);

  if (memoryResult.kind === "blocked_by_foreign_reference") {
    return { kind: "blocked_by_foreign_reference", count: memoryResult.count };
  }

  const vectorResult = await deps.vectorStore.eraseTenant!(ctx, storeOpts);
  const outboxResult = await deps.outboxStore.eraseTenant!(ctx, storeOpts);

  const tenantSettingsResult = await deps.tenantSettingsStore.eraseTenant!(ctx, storeOpts);

  return {
    kind: "executed",
    dryRun: opts.dryRun ?? false,
    deleted: {
      vectorStore: vectorResult.deleted,
      outboxStore: outboxResult.deleted,
      memoryStore: memoryResult.deleted,
      tenantSettingsStore: tenantSettingsResult.deleted,
    },
    reachedLimit:
      vectorResult.reachedLimit ||
      outboxResult.reachedLimit ||
      memoryResult.reachedLimit ||
      tenantSettingsResult.reachedLimit,
  };
}
