# ADR 0418: store 例外は `instanceof` ではなく `kind`（無ければ `name`）で判定する

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

クローン miku の委譲先が書いた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  利用者の手元で `@mnemora/core` が2つの版に分かれることがある。adapter（`@mnemora/postgres` ほか）は core を
  `dependencies` の `^` で持つので、利用者が core を範囲外の版に固定すると、adapter 側にもう1つの core が入る。
  そうなると、adapter が投げる store 例外のクラスと、runtime（利用者が固定したほうの core）が
  `instanceof` で比べるクラスは**別物**であり、`instanceof` は false になる。

  【実測】（段1、本物の `@mnemora/postgres` 1.1.0 と `@mnemora/core` 1.0.2 の組）:

  - **`tick()` の complete 経路**で `OutboxLeaseConflictError` が見分けられない。runtime は「complete が
    リース競合以外の理由で失敗した」と読んで `fail()` へ進み、それも CAS で弾かれ、こちらも見分けられず
    `throw failErr` になる。その結果、**`tick()` 全体が reject され、同じバッチの後続ジョブは処理されない**。
    `leaseConflicts` も返らない（[ADR 0142](./0142-outbox-complete-fail-compare-and-swap.md) 決定3が約束した
    「1件の良性の競合で他のジョブを止めない」が破れる）。
  - **`restoreArchived`** では、`MemoryStatusConflictError` が見分けられず `kind: "failed"` になる。
    本来は再読して `status_not_archived` になるべきもの。

  `@mnemora/local-embedding` などの provider のエラーは、既に値の判別子 `kind` と `instanceof` を使わない
  判定関数（`isLocalEmbeddingProviderError`）を持つ（[ADR 0075](./0075-openai-refusal-and-truncation.md)・
  [ADR 0090](./0090-embedding-input-token-limit.md) と同じ理由）。store 例外だけが `instanceof` のままだった。

- **決めたこと**:

  1. **core の store 例外5クラスに、値の判別子 `kind` を付ける。** `OutboxLeaseConflictError`
     （`"outbox_lease_conflict"`）、`MemoryStatusConflictError`（`"memory_status_conflict"`）、
     `ContestedGroupMembershipMismatchError`（`"contested_group_membership_mismatch"`）、
     `SourceMemoryForgottenError`（`"source_memory_forgotten"`）、`MemoryPurgeConflictError`（`"memory_purge_conflict"`）。
  2. **判定関数を公開する。** `isOutboxLeaseConflictError`・`isMemoryStatusConflictError`・
     `isContestedGroupMembershipMismatchError`・`isSourceMemoryForgottenError`・`isMemoryPurgeConflictError`。
     **判定は「`kind` を見て、`kind` が在ればそれで決める。`kind` が無ければ `name` を見る」**。
     `kind` が無い古い版の core を引いた adapter が投げた例外にも効かせるためである。`kind` が在って別の種類なら、
     `name` が一致しても通さない。
  3. **`runtime.ts` の19か所と `strategies/reextract.ts` の1か所、計20か所の `instanceof` をすべて判定関数へ置き換えた。**
     core の src（テスト以外）にこの5クラスの `instanceof` は残っていない。
  4. **歯**: store に「別の realm の例外」（`vm` で定義し直したクラス。`kind` 無しの版と有りの版の両方）を投げさせ、
     (a) `tick()` が reject されない、(b) その衝突が `leaseConflicts` に積まれ後続のジョブが処理される、
     (c) `restoreArchived` が `status_not_archived` になる、を検査する（`packages/core/src/__tests__/foreign-realm-store-errors.test.ts`）。
     判定関数そのものの歯は `store-error-guards.test.ts`。

- **`name` を偽装できる点**:

  `name` は誰でも書ける文字列であり、判定を `name` に頼ると、同じ名前を付けた別の例外を本物と読む。
  **実害は無いと判断した。** store は利用者が自分で配線する、信頼された部品であり（`createRuntime` に渡すのは利用者自身）、
  信頼できない入力が store 例外を作る経路は無い。偽装できるのは、store 自身を書き換えられる者だけである。
  `kind` も値であり同じく偽装できるが、上と同じ理由で扱いは変えない。

- **検討した代替案**:

  1. **案 B: core を adapter の `peerDependencies` にする。** 採らなかった。core が1つに揃うので根本的だが、
     **破壊的変更**である（既存の利用者の install が変わる。`dependencies` の `^` を前提にした配線が壊れる）。
     今回の目的（見分けられない穴を塞ぐ）に対して代償が大きい。
  2. **案 C: 2つの版を検知して警告する。** 採らなかった。**警告しても、壊れ方は変わらない**（`tick()` は reject される）。
     また、2つの版の検知（実行時に core の重複を数える仕組み）は今回の範囲外である。
  3. **`name` だけで判定する。** 採らなかった。`kind` は既存の provider のエラーと揃った作法であり、
     将来 `name` を変えても（`name` は表示用）判別が壊れない。

- **引き受けた負債**:

  - `kind` を持たない古い版の core を引いた adapter は、`name` の一致に頼り続ける。`name` を変えると効かなくなるので、
    **5クラスの `name` は変えない**こと（`store-error-guards.test.ts` の「name だけが一致するもの」の歯が縛る）。
  - `kind` の値も公開 API になった。値を変えるのは破壊的変更である。
  - store 例外を新しく足すときは、`kind` と判定関数を付け、`instanceof` を使わないこと。この規律を機械では縛っていない
    （今回の置き換えの後、src に `instanceof` が残っていないことは grep で確かめた）。
  - `ContestedWithoutCompanionError` ほか、runtime が `instanceof` で分岐していない store 例外には付けていない。
  - 2つの版が並ぶ状況そのものは、直していない（案 B・C を採っていない）。`instanceof` 以外の版差（欄の増減など）は別の問題である。

- **これが覆るとしたら**:

  core を `peerDependencies` にする破壊的変更を出す機会（メジャー版）が来たら、案 B に切り替えられる。その場合も、
  判定関数は残してよい（`kind` を見る判定は core が1つでも害が無い）。

- **測ったこと**:

  - 段1の実測は上の「文脈」。
  - 歯の変異試験（`packages/core`、手元）: 判定の `name` フォールバックを消すと「kind 無し」の3本（tick・restoreArchived・判定関数）が赤、
    `kind` を見ずに `name` だけにすると `kind` 優先・`kind` 一致の歯が赤、runtime の complete/fail 経路（2か所）を `instanceof` に戻すと
    tick の歯が赤、restoreArchived の1か所を戻すと restoreArchived の歯が赤になり、戻すとどれも緑に戻った。
  - **測っていないこと**: 修正後の版で、本物の `@mnemora/postgres` と2つの版の組を作って再実測はしていない
    （歯は `vm` による別 realm の再現であり、本物の2版の組ではない）。
