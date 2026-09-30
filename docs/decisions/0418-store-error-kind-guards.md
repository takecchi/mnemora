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

---

## 追記 (2026-09-30): 残りの公開エラー2クラスに `kind` と判定関数を付けた

> **⚠ 2026-09-30 追記:** 上の本文は書き換えていない。「引き受けた負債」の4つ目
> （`ContestedWithoutCompanionError` ほか、runtime が `instanceof` で分岐していない store 例外には付けていない）を片付けた記録である。
> 書いたのは、上と同じくクローンの委譲先であり、オーナーの判断ではない。

- **列挙（公開面から辿った）。** `packages/core/src/index.ts` の `export *` の先（`packages/core/src` の非テストの `.ts`）で
  `class … extends …` を grep し、`scripts/__snapshots__/public-api/core.d.ts` の `export declare class … extends Error` と突き合わせた。
  - `Error` を継承するクラスは7つで、snapshot の7つと一致した。`Error` 以外を継承するクラス・`Error` を間接的に継承するクラスは無い。
  - 旧5クラス（上の決めたこと1）に加え、**`ContestedWithoutCompanionError`（`interfaces/memory-store.ts`）と
    `RecallOutputValidationError`（`recall-output-validation.ts`）の2つが `kind` を持っていなかった。**これで7つすべてが `kind` を持つ。
  - **外したもの: 無い。**公開されていない例外クラスは core の src に見つからなかった。
    （core 以外のパッケージの例外——`AnthropicLLMProviderError` など——は、本 ADR の「core の store 例外」の範囲外であり、
    既に `kind` と判定関数を持つ。）
  - 2クラスとも `name` は既に設定されていた。`kind` という名前の別の意味の欄も無く、衝突しなかった。
- **付けた `kind` の値。** `ContestedWithoutCompanionError` は `"contested_without_companion"`、
  `RecallOutputValidationError` は `"recall_output_validation"`。判定関数は `isContestedWithoutCompanionError`・
  `isRecallOutputValidationError`（どちらも「`kind`、無ければ `name`」。共通の `matchesStoreErrorKind` を使う）。
  **2クラスの `name` も変えないこと**（旧5クラスと同じ理由）。値は公開 API であり、変えるのは破壊的変更である。
  - ⚠ `RecallOutputValidationError` は store 例外ではなく、`recall()` の `outputValidation: "throw"` が投げる検証の例外である。
    同じ作法（別 realm でも読める判別子）が要るので同じ形にしたが、共通の道具のファイル名 `store-error-kind.ts` は変えていない（公開しない内部の名前のため）。
- **core の外の `instanceof` の grep（`packages/*/src` と `examples/`、`node_modules`・`dist` を除く）。**
  対象は上の7クラスの名前で、`instanceof <クラス名>` の形。
  - 前: **6行、2ファイル**（どちらも `packages/postgres/src/__tests__/`。
    `store-boundary-diff.postgres.test.ts` の4行（`ContestedWithoutCompanionError`・`MemoryStatusConflictError`・`MemoryPurgeConflictError`・`OutboxLeaseConflictError`）と、
    `contested-pair-lock-order-concurrency.postgres.test.ts` の2行（`MemoryStatusConflictError`））。
    `packages/*/src` の非テストのファイルと `examples/` には無かった。
  - 後: **0行**。6行を判定関数（`isXxxError`）へ置き換えた（テストの中も）。
  - core の `__tests__` に `instanceof` は2行残っている（`foreign-realm-store-errors.test.ts` の陽性対照。
    「別 realm の例外は本物のクラスの `instanceof` では false になる」ことを示すために、意図して置いている）。
  - **置き換えていないもの（判断を要する）:** `toBeInstanceOf(<クラス>)` と `rejects.toThrow(<クラス>)` は、実体は `instanceof` である。
    `packages/*/src` に**74行、13ファイル**ある（`packages/testkit/src/memory-store-conformance.ts` 28行・`outbox-store-conformance.ts` 4行・
    testkit の `__tests__` 4ファイル・postgres の `__tests__` 7ファイル）。本 PR の依頼は「`instanceof`」の置き換えなので、これらは触っていない。
    ただし **適合テスト（`memory-store-conformance.ts` / `outbox-store-conformance.ts`）は利用者が自分の adapter に当てる公開の道具**であり、
    core が2つの版に分かれた環境で当てると、ここが同じ理由で赤になりうる。**直すかどうかは別の判断として残した**（測っていない）。
- **歯。** `foreign-realm-errors.ts` に、`ContestedWithoutCompanionError`・`RecallOutputValidationError` の別 realm 版
  （`kind` 無し・有りの両方）を作る口を足し、`store-error-guards.test.ts` に、**全7クラス**を別 realm のクラスで検査する節を足した
  （`instanceof` が false であること・判定関数が通ること・`kind` の有無が変種どおりであること・他の6種を通さないこと）。
  - 変異試験（`packages/core`、手元。`store-error-guards.test.ts`）: `name` フォールバックを消すと 15 本が赤、`kind` を見ないようにすると 14 本が赤、
    `isRecallOutputValidationError` を `instanceof` に戻すと 6 本が赤、`isContestedWithoutCompanionError` を `instanceof` に戻すと 6 本が赤、
    `kind` の値を1文字変えると 1 本が赤になり、戻すとすべて緑（72 本）に戻った。
  - 置き換えた postgres の `typedError` は、`isMemoryPurgeConflictError` の分岐を潰すと `store-boundary-diff.postgres.test.ts` の1本が赤になり、戻すと緑（5本）に戻った
    （手元の Postgres 17。`contested-pair-lock-order-concurrency.postgres.test.ts` を含む2ファイル 7 本が緑）。

---

## 追記 (2026-09-30): testkit の適合テストも、core の例外を `instanceof` ではなく判定関数で見る

> **⚠ 2026-09-30 追記:** 上の本文と、直前の追記は書き換えていない。直前の追記が「直すかどうかは別の判断として残した（測っていない）」とした
> 適合テストの穴を、直した記録である。書いたのは、上と同じくクローンの委譲先であり、オーナーの判断ではない。

- **直したもの。** `packages/testkit/src/memory-store-conformance.ts` の28か所と `outbox-store-conformance.ts` の4か所
  （core の公開エラーのクラスを取るもの。内訳は `expect(x).toBeInstanceOf(<クラス>)` 19か所・`rejects.toBeInstanceOf(<クラス>)` 8か所・
  `rejects.toThrow(<クラス>)` 4か所・`rejects.not.toBeInstanceOf(<クラス>)` 1か所。複数行にまたがる書き方も数えた）を、core の判定関数（`isMemoryStatusConflictError` など。「`kind`、無ければ `name`」）で見る形に置き換えた。
  - 置き換えの道具は `packages/testkit/src/error-guards.ts`（`expectStoreError` / `expectRejectsWithStoreError` / `expectRejectsWithoutStoreError`）。
    **公開しない**（`index.ts` から export していない）。判定関数が通らなかったときは、実際に来た値の `name` / `kind` / `message` を添えて落ちる。
  - `memoryId` / `expectedStatus` / `observedStatus` / `expectedAttempts` / `method` などの欄を読む検査は、そのまま残した。
    判定関数は型の絞り込み（`value is <クラス>`）を返すので、欄の読み方も変わらない。
  - **置き換えなかったもの:** `Date`・`Error`・`RangeError` への `toBeInstanceOf` / `toThrow`（core の公開エラーではない。ADR 0418 の範囲外）。
    `instanceof Date`（`purgedAt` の型の検査）も同じ。
- **なぜ直したか。** 適合テストは利用者が自分の adapter に当てる公開の道具である。core が2つの版に分かれた環境では、
  正しい adapter が投げる例外も適合テストが import したクラスとは別物になり、`toBeInstanceOf` / `toThrow(クラス)`（中身は `instanceof`）が
  誤って赤になる。runtime の穴（本文）と同じ原因で、置き換えた側だけが残っていた。
- **歯。** `packages/testkit/src/__tests__/foreign-realm-conformance.test.ts`。testkit の in-memory 実装を `Proxy` で包み、投げる（reject する）core の例外だけを
  `vm` の別 context で定義し直したもの（`kind` 無し・有りの両方）へ差し替えて、`describeMemoryStoreConformance` / `describeOutboxStoreConformance` をそのまま当てる。
  in-memory の設定は `in-memory-conformance-options.ts` へ切り出し、通常の適合テスト（`in-memory-fixtures.conformance.test.ts`）と共有した。
  **修正前の適合テストに対して、この歯は 39 本 × 2 種 = 78 本が赤になった**（PR #1514 の最初の commit）。修正後は緑。
- **変異試験（手元、`packages/testkit`）。** いずれも戻すと緑に戻った。
  - `updateStatus` の CAS が投げる例外を素の `Error` にすると、通常・別 realm 2種の計6本が赤（判定関数が「別のものを通さない」）。
  - 同じ箇所で別の core の例外（`ContestedWithoutCompanionError`）を投げさせても、同じ6本が赤。
  - `InMemoryOutboxStore.complete` の例外を素の `Error` にすると、3本が赤。
  - 歯の側で別 realm の例外から欄（`memoryId` など）を落とすと、別 realm の2種で計30本が赤（**欄の検査が弱まっていない**ことの確認）。
- **引き受けた負債。**
  - `packages/*/src/__tests__` に、同じ形（`toBeInstanceOf(<クラス>)`・`instanceof <クラス>` など）が残っている。これらは利用者に渡らない内部の検査で、
    同じ realm のクラスを見る限り正しい。**触っていない**（別 realm の対照として意図して置いている `foreign-realm-store-errors.test.ts` の2行を含む）。
  - 適合テストは core の判定関数を import するようになった。判定関数を持たない古い版の core（1.1.0 以前）と組み合わせた testkit は動かない
    （testkit は core を `dependencies` で持つので、通常は同梱の版が使われる）。
  - `Error` / `RangeError` への `toBeInstanceOf` は、別 realm の組み込みエラーでは同じ理由で false になりうる。core の公開エラーではないので、今回は範囲外にした。
  - 新しい適合テストの検査を足すときにも `toBeInstanceOf(<core のクラス>)` を書けてしまう。この規律を機械では縛っていない
    （歯は、現在ある検査が別 realm で通ることだけを見る。**新しく書かれる検査は、in-memory の設定を共有する歯が、同じ store 例外を投げさせる限りで拾う**）。
- **測っていないこと。** 本物の `@mnemora/postgres` を core 2版の組で当てた再実測はしていない（歯は `vm` による別 realm の再現）。

## 追記 (2026-09-30): 「古い core と組み合わせた testkit は動かない」の範囲を正す

> **⚠ 2026-09-30 追記:** 上の本文と、これまでの追記は書き換えていない。直前の追記の「引き受けた負債」の2つ目
> （「判定関数を持たない古い版の core（1.1.0 以前）と組み合わせた testkit は動かない」）が、実際より重く読めるので、範囲を正す。
> 書いたのは、上と同じくクローンの委譲先であり、オーナーの判断ではない。

- **動かなくなるのは、override などで testkit の下の core を、判定関数を持たない版（1.1.0 以前）へ無理に下げた場合だけである。**
  適合テストが import する判定関数は、testkit 自身が `dependencies` で引いた core から来る。
- **通常の install では起きない。** publish は testkit の `"@mnemora/core": "workspace:^"` を、その版のキャレット範囲に書き換える
  （【実測】registry の `@mnemora/testkit@1.1.0` の `dependencies` は `"@mnemora/core": "^1.1.0"`）。
  そのため、判定関数を持つ版の testkit は、判定関数を持つ版以上の core を引く。
  - 利用者が自分で古い core を直接入れていても、同じことが言える。古い core が testkit の範囲の外にあれば、testkit の下には別の core が入る
    （本文の「段1の実測」と同じ形）。
  - 利用者の adapter が古い core の例外を投げても、適合テストは通る。判定関数は「`kind`、無ければ `name`」で見るので、`kind` を持たない古い版の例外にも効く。

## 追記 (2026-09-30): 本文26行目の「provider のエラーは、既に判定関数を持つ」は、openai・anthropic には当たらなかった

> **⚠ 2026-09-30 追記:** 上の本文と、これまでの追記は書き換えていない。本文の「文脈」の終わり近く（26行目）に、
> 「`@mnemora/local-embedding` などの provider のエラーは、既に値の判別子 `kind` と `instanceof` を使わない判定関数
> （`isLocalEmbeddingProviderError`）を持つ」と書いた。実態は次のとおりで、「など」に openai・anthropic を含めて読むと違っていた。
> 書いたのは、上と同じくクローンの委譲先であり、オーナーの判断ではない。

- **違っていた点**: `OpenAILLMProviderError`・`AnthropicLLMProviderError` は値の判別子 `kind`（ADR 0075・ADR 0072 の追記）を持っていたが、
  `instanceof` を使わない判定関数は持っていなかった。判定関数を持っていたのは `@mnemora/local-embedding` の
  `isLocalEmbeddingProviderError` だけだった。呼び出し側が2つの版の同じパッケージに挟まれたとき（bundler の二重読み込みなど）、
  この2つの provider の例外は、`kind` を自分で読まない限り `instanceof` に頼るしかなかった。
- **[ADR 0428](./0428-provider-abort-reason-and-error-guards.md) で足したもの**: `@mnemora/openai` に `isOpenAILLMProviderError`、
  `@mnemora/anthropic` に `isAnthropicLLMProviderError` を、公開 export として足した（追加のみ。既存の公開面は変えていない）。
  判定は本文の作法（「`kind` を見て、`kind` が無ければ `name` を見る」）を基にし、`kind` があるときは、その値が各パッケージの
  `*LLMFailureKind` のどれかであることに加えて、`name` が文字列ならそれが自分のクラス名であることも見る。openai と anthropic は
  `kind` の値が重なる（`"refusal"` など）ので、`kind` だけでは相手の provider の例外を取り違えるためである。

## 追記 (2026-10-01): 「core 以外のパッケージの例外は、既に `kind` と判定関数を持つ」は、`@mnemora/postgres` の公開9クラスには当たらなかった

> **⚠ 2026-10-01 追記:** 上の本文と、これまでの追記は書き換えていない。2026-09-30 の追記の「列挙」の括弧書き
> 「core 以外のパッケージの例外——`AnthropicLLMProviderError` など——は、本 ADR の「core の store 例外」の範囲外であり、
> 既に `kind` と判定関数を持つ」は、`@mnemora/postgres` の公開の例外クラスについては事実と違っていた。
> 書いたのは、上と同じくクローンの委譲先であり、オーナーの判断ではない。

- **事実**: `scripts/__snapshots__/public-api/postgres.d.ts` と `packages/postgres/src` で確かめた。`@mnemora/postgres` が公開する
  例外クラスは9つで、いずれも `kind` も `is*` の判定関数も持たない（`name` だけ）。
  `AdvisoryLockTimeoutError`・`AdvisoryLockUnavailableError`・`PgvectorVersionUnsupportedError`・`MissingExtensionsError`・
  `MigrationLockTimeoutError`・`MigrationLockUnavailableError`・`RegisterEmbeddingSpaceLockTimeoutError`・
  `RegisterEmbeddingSpaceLockUnavailableError`・`TrigramLexicalStoreUnavailableError`。
  （`packages/postgres/src` で `kind` を含むのは SQL の `provenance_kind` だけで、`is*Error` の公開関数も無い。）
- **扱い**: postgres の9クラスは `name` だけ。揃えるかは [Issue #1184](https://github.com/takecchi/mnemora/issues/1184) の判断
  （v1 の中では揃えない）に従う。9クラスのコードは変えていない。
- 訂正は [ADR 0441](./0441-changelog-migration-refs-consumer-smoke-names.md) で行った。
