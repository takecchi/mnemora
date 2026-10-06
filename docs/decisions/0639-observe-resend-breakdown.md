# ADR 0639: `Runtime.observe` の冪等な再送の戻り値に、記憶の内訳 `resend` を足す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

**担い手が書いた（マネージャー mgr-b4cde0e3 の指示）。オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**出所**: オーナーへのまとめ問い 374f6f88 の問10「reextract・observe の公開の型: CAS は今のまま、再送の内訳は足す方向で検討」。**オーナーが決めたのは、推奨どおりという採否だけ**である。**足すと決めたのはクローン miku の判断**で、**型の形・名前・読み方は担い手の設計**である。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

## 文脈

- 【現物】`Runtime.observe` の TSDoc は「呼び出し側は、この返り値だけでは『正常な冪等の再送』と『forgotten/purged が原因で無視された』を区別できない。`ObserveResult` に内訳を持たせる案は見送った（公開の型が増えるため）」と書いていた（Issue #897）。
- 【現物】[ADR 0454](./0454-reextract-anchor-observe-consolidate-state-matrix-round30.md) の負債4: `extract: 'sync'` の observe が abort した後、リースが切れる前に同じ `externalId` で再送すると `{ memoryIds: [], extraction: 'skipped' }` が返り、「正常な再送」と区別がつかない。決定4 は、再送にも渡していれば `rejectedSubjectIds: []`・`claimKeyFailure: null`・`contestedDetection: []` を付けると決めた。
- 【現物】既存の必須メソッド `MemoryStore.listBySourceObservationAllVersions(ctx, observationId)`（[ADR 0380](./0380-reextract-withdrawn-across-extractor-versions.md)）は、版も status も問わず全部返す（順序は規定しない）。`Memory.purgedAt` で purge 済みも分かる。`OutboxStore` に observation ごとのジョブを読む口は無い。

## 決めたこと

1. **冪等な再送（`createObservationWithOutbox` が `created: false`）のときだけ、`ObserveResult.resend?: ObserveResend` を付ける。** 新しく作った呼び出しには欄が無い。既存の欄の型・値は変えない（`memoryIds: []`・`extraction: 'skipped'`・ADR 0454 決定4 の3欄を含む）。
   ```ts
   interface ObserveResend { memories: ObserveResendMemory[] }
   interface ObserveResendMemory { memoryId: MemoryId; status: MemoryStatus; purged: boolean }
   ```
   `ObserveResend`・`ObserveResendMemory` は `@mnemora/core` から出る。
2. **`memories` は `listBySourceObservationAllVersions` の写し**で、版も status も問わず全部、**`memoryId` の昇順**（文字列の `<` 比較。store の並びには頼らない——口は順序を規定しない）。`purged` は `purgedAt` が `null` でないこと。`status` から推さない（purge 済みの `status` は `'forgotten'` のまま）。
3. **読み取りは再送の分岐で1回増えるだけ。** 新規作成の経路は変えない。再送でも書き込みはせず、LLM も呼ばない。
4. **読み方（TSDoc に書いた）**: `memories` が空 ＝ まだ抽出されていない（deferred で tick 待ち、sync の abort の後でリース中、ジョブが failed、または抽出が0件）。全部が `forgotten` ＝ forget のために無視された。`purged: true` ＝ purge 済み。
5. **限界（依頼主の確定。TSDoc にも書いた）: ジョブ（outbox）の状態は内訳に入れない。** `memories: []` からは「まだ抽出されていない」ことしか分からず、**tick 待ち・リース中・failed・抽出0件は区別できない**。
6. **conformance に約束を1本足した**: `listBySourceObservationAllVersions` は purge 済みの行（`status: 'forgotten'` のまま `purgedAt` が入った行）も返す（`supportsPurgeMemory: true` の枝。別テナントを返さない・forgotten を返すは既に在った）。[ADR 0546](./0546-conformance-suite-adds-round31-promises.md) の作法どおり Breaking に数え、CHANGELOG と migration の項目69に書いた（はじめ 67 で書いたが、空けておく番号なので 68 の後ろの 69 に振り直した）。
7. **出力の契約（`checkObserveContract`）を強めた**（緩めていない）: `resend` が在るなら `memoryIds: []`・`extraction: 'skipped'`・`extractionFailure: null`・`memories` は昇順で重複なし・`purged` は真偽値。`memory_usage` に `resend` は付かない。同じ `Runtime` が同じ Observation をもう一度返したのに `resend` が無ければ破れ。「新規には無い」は戻り値だけからは分からないので、`extraction` が `'skipped'` でないのに `resend` が在れば破れ、とする形で縛り、deferred の新規への混入は歯（`observe-resend-breakdown`）が縛る。

## 採らなかった案

1. **outbox のジョブの状態（`extractJob: 'open' | 'claimed' | 'failed' | 'done' | null`）を内訳に入れる。** 採らなかった。(a) `OutboxStore` に observation ごとのジョブを読む口を足すことになり、**store の公開の口が増える**（第三者の adapter への必須の追加は破壊的、任意にすると）。(b) **任意の口にすると、第三者の adapter が実装しない限り `null`（不明）になり**、「ジョブが無い」と「口が無い」が同じ顔になる。(c) **後から `ObserveResend` に任意の欄として足せる**ので、今決めなくてよい（依頼主の確定）。
2. **`memoryIds` に再送でも既存の id を入れる。** 採らなかった。既存の欄の値が変わる（TSDoc は「再送では空配列」と約束している）。
3. **`resend` を、再送でなくても常に付ける（新規なら空）。** 採らなかった。「新しく作った」と「再送で空」が区別できなくなる。
4. **`listBySourceObservation`（版で絞る口）を使う。** 採らなかった。版を上げた runtime で、前の版の記憶が見えなくなる（歯で縛った）。
5. **active だけを載せる。** 採らなかった。forget・purge のために無視されたことが分からなくなる（この ADR の目的そのもの）。
6. **新しい公開の口（`MemoryStore` のメソッド）を足す。** 採らなかった。既存の口で足りる。

## 引き受けた負債

- **ジョブの状態が分からない**（決定5）。`memories: []` の4つの理由を区別できない。後から任意の欄として足せる形にしてある。
- **件数に上限が無い。** `listBySourceObservationAllVersions` が全部返すので、1つの Observation から作られた記憶が非常に多いと、再送の戻り値も大きい（通常は抽出の候補の数）。
- **再送の戻り値が読み取り1回ぶん重くなる。** 新規の経路は変わらない。
- **conformance の約束を足した**（決定6）。足した約束は外せない。`supportsPurgeMemory: true` の自前の adapter が purge 済みの行を除いていると、新しく落ちる（【確かめていない】外部の adapter が実際に赤くなるか）。
- **別テナントの記憶が載らないことは、runtime 越しの歯では縛れない。** Observation の id がテナントごとに別なので、別テナントの記憶が同じ `source_observation_id` を持つ状況を runtime から作れない。縛っているのは conformance（store の口の約束）で、store の絞りを外す変異は conformance だけが赤くなった。
- **契約の検査は、別の `Runtime` インスタンスが作った Observation への再送を「最初に見た」として扱う**（`resend` の有無を問わない）。同じインスタンスの再送だけを強く縛る。

## これが覆るとしたら

- オーナーが `resend` を要らないとしたら、欄と型を消せる（任意の欄の削除は、型を使う呼び出し側には破壊的）。
- ジョブの状態が運用上どうしても要ると分かったら、`OutboxStore` に口を足し、`ObserveResend` に任意の欄を足す（別の ADR）。

## 歯と測ったこと

- 歯: `packages/core/src/__tests__/observe-resend-breakdown.test.ts`（core の Fake）、`packages/testkit/src/__tests__/observe-resend-breakdown.test.ts`（InMemory）、`packages/postgres/src/__tests__/observe-resend-breakdown.postgres.test.ts`（実 Postgres）の同じ10本（新規には無い／正常な再送で active と既存の欄／forget の後／purge の後／deferred の tick 前後／sync の abort の後／版違い／別テナント／昇順（store が逆順で返しても）／LLM を呼ばず書き換えない）。`observe-resend-contract-check.test.ts` が `checkObserveContract` の歯。conformance の1本は `memory-store-conformance.ts`。
- 【実測】実装の前: core・testkit・postgres のどれも10本中8本が赤（`resend` が無い）、2本は緑（新規には無い・書き換えない。実装前なので当然）。実装の後は全部緑。
- 【実測】変異試験（PR 本文の表）。**変異が生き残ったのは1件**: `purged` を `purgedAt !== null` にする変異（`!= null` との違い）は、どの adapter も非 purge の行の `purgedAt` を `null` で返すので、振る舞いが同じ（同値の変異）。
- 【確かめていないこと】全部入りの `test:db`（器が重く、HNSW の `EXPLAIN` の歯などが時間切れになったので途中で止めた。この変更と関係の無いファイル）。実 LLM・実 API。
