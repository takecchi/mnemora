# ADR 0373: Issue #1412（Issue #1238 棚卸しの続き）のうち A8・A10・A11・コメント1・2 を conformance suite の `it` として足す

- **状態**: 採用 (2026-09)

- **文脈**:

  [Issue #1238](https://github.com/takecchi/mnemora/issues/1238) の棚卸しのうち、
  PR #1413（ADR 0372）は A1・A3・A4・A5・A6・A7・A9 の7件を conformance suite に
  足した。残りの候補は [Issue #1412](https://github.com/takecchi/mnemora/issues/1412)
  （クローン miku の委譲先が、A8・A10・A11・A12 と PR #1296 棚卸しのコメント1・2 を
  並べて記録した。推奨は書かず、足すかどうかは決めていなかった）に並んでいる。

  マネージャー（別クローンの委譲）から、A8・A10・A11・コメント1・コメント2 の5件を
  実際に足す作業が切り出された。**A12 は Issue #1412 のコメントが「conformance suite
  は外部の adapter を公開の口からしか呼べないため、adapter の中に遅延を差し込んで
  重なりを作れず、赤くなりうる歯を書けない」と明記しており、切り出しにも含まれて
  いない**（別 Issue へ回す判断は Issue #1412 のコメントに委ねる）。

  A8・A10・A11 について、事前のプローブで2実装（`@mnemora/postgres`・testkit の
  in-memory fixture）で既に成り立っていることを確認済みだった。コメント1
  （`resolveOrphanedContested?` の CAS）・コメント2（型付き例外の欄の値）は、
  conformance suite に歯が1本も無かった候補である。⟹ 本 PR は「実装を直す」PR
  ではなく、「既に成り立っている約束を歯で固定する」PR である——**実装
  （`@mnemora/postgres`・testkit の in-memory fixture）は1行も変えていない。**

- **決めたこと**:

  1. **A8（返す値・受け取った値が store の中と切り離されている）を、`MemoryStore`・
     `VectorStore`・`EventStore`・`OutboxStore` の4 suite にだけ足す。**

     | suite | 検査した口 |
     |---|---|
     | `MemoryStore` | `createMemory` の入力（tags の配列・attributes のオブジェクト・validFrom の Date）／`get`・`getMany` の返り値／任意メソッド `supersedeWithNewMemories` の返り値（`created[].memory`） |
     | `VectorStore` | `upsert` の入力配列／`getVectors`（任意メソッド）の返り値 |
     | `EventStore` | `append` の入力 `meta`／読み戻した `meta` |
     | `OutboxStore` | `claimBatch` の返り値の `payload`（`peekJob` を持つ adapter だけ——`claimBatch` 以外に claim 後の行を読む経路が無いため） |

     **`LexicalStore`・`TenantSettingsStore` は外した。** 下調べ（Issue #1412 本文
     「A8 の fixture の現状」）のとおり、この2つの fixture は複合値を受け取って
     保存する口をほぼ持たない——`InMemoryLexicalStore.search` は毎回新しいオブジェクトを
     組み立てて返し、`InMemoryTenantSettingsStore` の getter はプリミティブか毎回
     新しく組み立てた値を返す。**切り離すべき参照そのものが無く、歯の中身が無い。**

  2. **A10（`purgeExpiredEvents` が積む `events_purged` の `meta` の日時3欄は
     ISO 8601 の文字列）を `MemoryStore` に足す。** 縛るのは型（と形——正規表現で
     `toISOString()` の形を確認する）だけで、値そのものの正しさは既存の歯
     （`purgeExpiredEvents が積む events_purged は memoryId が null で、件数と期間を
     meta に持つ`）に任せる。

  3. **A11（`getRecall` が `query` を JSON で往復する値のまま読み戻す）を
     `MemoryStore` に足す。** `NewRecallRecord.query`/`RecallRecord.query` は
     `unknown`（`MemoryStore` 自身は中身を解釈せず素通しする）なので、JSON を
     通る欄（text・tags・attributes・labels・limit・association）だけで組んだ
     オブジェクトを渡し、`toEqual` で往復を確認する。**日付3欄
     （occurredAfter/occurredBefore/validAt）と `vector` は入れない**——
     [Issue #1206](https://github.com/takecchi/mnemora/issues/1206) のとおり
     adapter によって往復が違う。

  4. **コメント1（`resolveOrphanedContested?` の CAS 違反で
     {@link MemoryStatusConflictError}）を `MemoryStore` に足す。** 新しい任意
     フィールド `MemoryStoreConformanceOptions.supportsResolveOrphanedContested?:
     boolean` を追加した——既存の `supportsOnlyMemoryIdsFilter`/
     `supportsListActiveClaimPredicates` と同じ3状態（`true`/`false`/省略）の形に
     倣う（Issue #818 の教訓——新しい適合フラグを必須にすると、既存の外部 adapter の
     呼び出しが型エラーになる）。`true` の adapter に対して2本の歯を実行する:
     survivor が呼び出し時点で `status !== 'contested'` の場合、`contestedWithId`
     が実際の対向と食い違う場合、のどちらも `MemoryStatusConflictError`
     （`expectedStatus: 'contested'`）で弾かれ、行が無傷のまま残ることを検査する。
     **正常系・原子性等の他の契約は、この PR の切り出しに入っていない**
     ——Issue #1412 が挙げたのは CAS 違反の1点だけである。

  5. **コメント2（型付き例外の欄の値）を `MemoryStore` に足す。**

     - `ContestedWithoutCompanionError` の `method`/`memoryId`:
       `createMemory`/`createMemoryWithOutbox`/`supersedeWithNewMemories` は
       `memoryId: null`（作成時点なので対象の id が無い）、`updateStatus`/
       `updateStatusWithEvent` は対象の id。5つの throw 元すべてに、それぞれ
       専用の歯を足した。
     - `markContestedPair`/`resolveContestedPair`/`updateStatusWithEvent` が CAS
       違反で投げる `MemoryStatusConflictError` の3欄（`memoryId`/
       `expectedStatus`/`observedStatus`）。**逐次の呼び出しに限った約束として
       書く**——`MemoryStatusConflictError` の doc コメント自身が「`observedStatus`
       は弾かれた後に読み直した値であり、弾かれた瞬間の値とは限らない」と
       明記しているとおり、並行の下での正しさは検査しない（it 名に明記した）。
     - `purgeMemory` が2度目の呼び出しで投げる `MemoryPurgeConflictError` の
       `observedStatus`/`observedPurgedAt`。**同じく逐次の呼び出しに限った約束**。

     **`observedPurgedAt` の縛り方は、`MemoryPurgeConflictError` の宣言
     （`packages/core/src/interfaces/memory-store.ts`）に合わせた。** 宣言は
     `readonly observedPurgedAt: Date | null`——**具体の型（`Date`）** である
     （`unknown`/`string | Date` のような緩い型ではない）。⟹ `instanceof Date`
     と、1度目の `purgeMemory` が返した `purgedAt` との `getTime()` の一致の
     両方を見る。

     **宣言された型は公開の約束なので、conformance がそれを縛ってよい——
     一方 A10（`events_purged` の `meta`）は `Record<string, unknown>` を経由し、
     JSON を通る欄である（`packages/postgres` は jsonb 列に保存する）ため、
     「文字列である」という*形*だけを縛り、`Date` を求めない。** 同じ「日時を
     運ぶ欄」でも、型宣言が具体的な `Date` かどうかで縛り方を変えている——
     この非対称は本 ADR がここで明示する。

  6. **破壊的変更として数える。** `docs/migration-v1.md`「数え方の規律への追記
     （2026-09-28）」規律2 の ⛔ が「conformance スイートの判定を厳しくする変更は、
     これまでどおり上の定義と各世代の分け方で数える」と明記しており、ADR 0372
     （項目23、PR #1413）が同じ理由で先に破壊的変更と数えている。今回足した歯も、
     これまで緑だった第三者の `MemoryStore`/`VectorStore`/`EventStore`/
     `OutboxStore` 実装を、約束を満たしていなければ新しく赤にしうる——同じ扱いに
     した。CHANGELOG の `[1.1.0]` 節 `### Breaking` と `docs/migration-v1.md`
     項目24に記録した。

  7. **変異試験は一時的な確認に留め、恒久の歯として残さない。** ADR 0372「決めたこと」6
     と同じ判断——`packages/testkit/src/index.ts` 冒頭の #809 の決定「Fake と
     Postgres の食い違いは Fake を直し、その回帰の歯を `src/__tests__/` に置く」は、
     今回も Fake と Postgres が食い違っていない（両方とも既に約束を満たしている）
     ため当てはまらない。`__fixtures__/in-memory-*.ts` を一時的に変異させ
     （`cp` で退避 → 変異 → 対象の `it` を別の git worktree で `-t` で絞って赤を
     確認 → `cp` で復元 → 緑に戻ることを確認）、結果を本 ADR と PR 本文に記録した。

- **検討した代替案**:

  1. **A12 も一緒に足す。** ⛔ 採らなかった——Issue #1412 のコメントが実測で
     「conformance suite の外から adapter の中に遅延を差し込めず、赤くなりうる歯を
     書けない」と結論しており、マネージャーの切り出しにも入っていない。

  2. **`LexicalStore`・`TenantSettingsStore` にも A8 を足す（複合値を返す口を
     新設してから検査する）。** ⛔ 採らなかった——今の interface・fixture の形を
     変える理由が無く、範囲の逸脱になる。

  3. **`supportsResolveOrphanedContested` を必須フィールドにする。** ⛔ 採らなかった
     ——Issue #818 が `supportsLabels`/`supportsFindActiveByClaimKey` を必須にした
     ことで v1.0.0 の呼び出しがコンパイルできなくなっていた前例と同じ轍を踏まない。

  4. **`observedPurgedAt` を「値は見ず、真偽だけ」で縛る。** ⛔ 採らなかった——
     宣言が具体の `Date` である以上、`instanceof Date` まで見なければ「型」を
     縛ったことにならない。

- **引き受けた負債**:

  1. **A8 の対象は代表的な口だけである。** `MemoryStore` は `createMemory`/`get`/
     `getMany`/`supersedeWithNewMemories` の4口しか見ていない——他の全ての口
     （`updateStatus`・`reinforce`・`purgeMemory` 等）の返り値の切り離しは、
     `packages/testkit/src/__tests__/in-memory-return-snapshots.test.ts`
     （fixture 単体、Issue #1108）がすでに広く検査しているが、conformance suite
     には出ていない。
  2. **コメント1（`resolveOrphanedContested`）は CAS 違反の2本だけで、正常系・
     原子性の歯を持たない。**
  3. **A2・A10 のうち今回足さなかった値の中身・A12・A13〜A15 は、Issue #1412 の
     とおり引き続き未決のまま。**

- **これが覆るとしたら**:

  - A12 について、adapter の中に遅延を差し込める形（`packages/postgres` 側の
    独自の歯）が見つかったとき ⟹ 別の Issue で `packages/postgres/src/__tests__/`
    に足す判断が要る。
  - `resolveOrphanedContested` の正常系・原子性の歯を足す判断がされたとき ⟹
    `supportsResolveOrphanedContested` の `true` 分岐を広げる。

- **確かめたこと（変異試験、`AGENTS.md`/`docs/autonomy.md` §2 の作法——別の git
  worktree で `cp` により退避・変異・`-t` で絞って赤くなることを確認・`cp` で
  復元・緑に戻ることを確認）**:

  （後述——作業ツリー本体は変異させていない。詳細は PR 本文を見ること。）

- **確かめていないこと**:

  - `@mnemora/openai`・`@mnemora/anthropic`・`@mnemora/local-embedding`・
    `@mnemora/bullmq` など、`MemoryStore`/`VectorStore`/`EventStore`/
    `OutboxStore` を実装しないパッケージへの影響（公開 API snapshot の差分無し
    以上の確認はしていない）。
  - 本番相当の規模・並行度での挙動（in-memory fixture は同期的に実行されるため）。
