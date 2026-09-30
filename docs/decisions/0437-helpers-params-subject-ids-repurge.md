# ADR 0437: 公開ヘルパー9本の例外から `params` を落とす・`subjectIds` と `advanceActivityClock.subjectId` を識別子の検査の内側に置く・v1.1.0 より前に purge した行の残骸を purge のかけ直しで消す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の決定である。**前例 ADR 0423・0430・0382 と同じ作法で塞ぐだけ**で、新しい方針は立てていない。書いたのはクローンの委譲先の担い手で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【クローン】はクローンが先に測って依頼に書いた値（担い手は再現の歯で確かめた）、【判断】は担い手の判定。

- **文脈**:

  穴探しで見つかった3件（AV-2・AV-3・AU-1）と、同じ巡りで追加された1件を、1本の PR にまとめた。

  **(1) AV-2: core の公開ヘルパーが `params` を落とさない。**【現物】`packages/core/src/interfaces/tenant-settings-store.ts` に、`TenantSettingsStore` を第1引数に取る公開の `read*`／`write*` が9本ある（`readDecayClock`・`readActivitySeq`・`readDefaultHalfLifeRecalls`・`readHasSubjectActivityCounters`・`readSubjectActivitySeqs`・`readSubjectActivitySeq`・`writeDecayClock`・`readTaxonomyMode`・`writeTaxonomyMode`。公開 API の snapshot `scripts/__snapshots__/public-api/core.d.ts` から引いた）。[ADR 0430](./0430-concurrent-create-erase-and-standalone-params.md) 決定3は、`omitParamsFromError` を掛ける対象を `runRecall`・`eraseTenant`・`purgeExpiredEventsForTenant` の3つに限っていた。
  【クローン】偽の store に drizzle 形の例外（message が `Failed query: …\nparams: LEAKPARAM`）を投げさせると、`readDecayClock` 経由では message に params が残り、`eraseTenant` 経由では `(omitted by mnemora, N chars)` に落ちる。【実測】（本 PR の歯、直す前）9本すべてで params が残った。

  **(2) AV-3: `getSubjectActivitySeqs` の `subjectIds` が、識別子の検査の外にある。**【現物】Postgres とインメモリの `getSubjectActivitySeqs(ctx, subjectIds)` は `ctx` だけを検査し、`subjectIds` の各要素は検査しない。[ADR 0423](./0423-identifier-well-formed-and-error-message-without-params.md) 決定4(b) の一覧に、この口が載っていなかった。【クローン】NUL を含む値は Postgres で生の `DrizzleQueryError`（message に値が載る）になり、孤立サロゲートを含む値はそのまま通った。
  **追加（同じ巡り）**: `createRecall` の `advanceActivityClock: { scope: "subject", subjectId }` の `subjectId`（書き込む先の subject のカウンタ `tenant_subject_activity.subject_id`）も同じ穴にいた。【クローン】NUL は Postgres が生の例外（22021）を投げ、孤立サロゲートは通り、インメモリは断らず Postgres と食い違う。【現物】`record.subjectId`（recall 自身の subject）は #1520 で検査済みだったが、こちらは別の欄で漏れていた。

  **(3) AU-1: v1.1.0 より前に purge した行が残る。**【現物】v1.0.0〜v1.0.2 の `purgeMemory` は `content`・`digest`・`purged_at` しか書き換えなかった。v1.1.0 の [ADR 0375](./0375-purge-scope-widened.md) から、purge は `tags`・`attributes`・`claim_key_subject`／`claim_key_predicate`・`memory_labels`（と `proposed` な `labels.proposed_count` の減算）も消す。しかし**既に purge 済みの行にはこれが効かない**——migration は遡らない。purge をかけ直しても `Runtime.purge` は `already_purged` を返すだけで、後始末は埋め込みの `deleteAcrossSpaces`（[ADR 0382](./0382-vector-store-delete-across-spaces.md) 決定3）だけであり、`purgeMemory` の SQL は `purged_at IS NULL` の条件に当たる。

- **決めたこと**:

  1. **(AV-2) 9本すべてで、store が投げた例外に `omitParamsFromError`（`packages/core/src/failure-description.ts`）を掛けてから投げ直す。**
     - 内部の小さな包み（`omittingParams`）を1つ置き、9本がそれを通す（`readSubjectActivitySeq` は `readSubjectActivitySeqs` の薄い包みなので、二重に掛かる。ADR 0430 決定3で `omitDrizzleParams` をべき等にしてあるので害は無い）。
     - 例外そのものを返す（新しい例外を作らない、`kind`・`cause` は変わらない）点は ADR 0423 決定6・ADR 0430 決定3のまま。「未実装」のときに投げる `*_UNSUPPORTED_MESSAGE` の `Error` は params を持たないので通さない。
     - **ADR 0430 決定3の対象を、この ADR で広げた**（0430 の末尾に日付付きの追記を入れた。本文は書き換えていない）。
  2. **(AV-3) 両 adapter（`@mnemora/postgres`・testkit の `InMemoryTenantSettingsStore`・`InMemoryMemoryStore`）で、次の2つを `assertWellFormedIdentifier`（`@mnemora/core`）にかけ、書く・読む前に断る。**
     - `TenantSettingsStore.getSubjectActivitySeqs` の `subjectIds` の各要素。field 名は `subjectIds[i]`。
     - `MemoryStore.createRecall` の `record.advanceActivityClock.subjectId`（`{ scope: "subject" }` のとき）。field 名は `record.advanceActivityClock.subjectId`。
     - 例外は ADR 0423 決定2の `MalformedIdentifierError` のまま。対をなすサロゲート（絵文字）は断らない。
     - core の test 用 Fake（`runtime-fakes.ts`）は、`ctx` も含めて識別子を一切検査していないので、そこには足していない（Fake は公開物ではない）。
     - **ADR 0423 決定4(b) の一覧に、この2つが加わった**（0423 の末尾に追記を入れた。本文は書き換えていない）。**適合テストにも、ADR 0423 と同じ作法で `it` を足した**（`describeTenantSettingsStoreConformance` の識別子の `it` に `subjectIds[1]` の行と陽性対照、`describeMemoryStoreConformance` の「識別子の文字の扱い」に `advanceActivityClock.subjectId` の `it` と陽性対照）。**破壊的変更として数える**（通っていた入力が throw する。CHANGELOG の `[1.2.0]` の Breaking と `docs/migration-v1.md` の項目49）。
  3. **(AU-1 (b)) `already_purged` の経路でも、`tags`・`attributes`・claim key・`memory_labels` を消し、`labels.proposed_count` を揃える。**
     - **分担**（ADR 0375・0382 の形を読んで決めた）。`MemoryStore.purgeMemory` の契約（`forgotten` かつ未 purge だけを対象にする CAS。2回目は `MemoryPurgeConflictError`）は**変えない**（変えると、自前の adapter の適合テストが壊れる）。代わりに **`MemoryStore` に任意メソッド `scrubPurged?(ctx, memoryIds)` を足す**（ADR 0382 が `VectorStore` に `deleteAcrossSpaces` を足し、`Runtime.purge` が `already_purged` のときも呼ぶ形にしたのと同じ骨格。ただし `MemoryStore` は第三者が実装するので、必須にせず任意にした。`purgeMemory?` が任意なのと同じ理由、ADR 0100 決定1）。
     - `Runtime.purge` は、`already_purged` の対象（`dryRun` でないとき。競合の再読で `already_purged` になる枝も含む）に、`deleteAcrossSpaces`（ADR 0382）と**独立に**、ベストエフォートで `scrubPurged` を呼ぶ。片方の失敗がもう片方を止めない。**失敗しても `kind` は `already_purged` のまま**で、失敗だけを任意の欄 `residueCleanup?: { status: "failed"; error: string }` で知らせる（ADR 0399 の `embeddingCleanup` と同じ形。成功時は欄が無い）。`scrubPurged` が無い adapter では飛ばす。**`dryRun: true` では呼ばない**（ADR 0382 と同じ）。`purged`・`would_purge`・`status_not_forgotten`・`not_found` でも呼ばない。
     - **契約**（`MemoryStore.scrubPurged` の doc）: `status = 'forgotten'` かつ `purgedAt` が非 `null` の行**だけ**を対象にする（未 purge の行・他テナントの行は、id を渡されても触らない）。**べき等**: 残骸の無い行（今のコードで purge した行を含む）には何も書かず、`updatedAt` も動かさない。`proposedCount` は**実際に外した紐付けの本数だけ**減らす（`DELETE … RETURNING` の本数。今のコードで purge した行の分を二重に数え減らさない）。床は0。存在しない・形式不正な id は例外にしない。**監査イベントは積まない**（新しい `kind` を足さない）。`content`・`digest`・`purged_at`・`recalls` は書かない。
     - **Postgres** は1トランザクション・2文（`memories` の UPDATE は「残骸が在る行」だけ。`memory_labels` の DELETE は `purged_at IS NOT NULL` の行だけを `RETURNING` し、その本数で `labels.proposed_count` を `GREATEST(…, 0)` で減らす）。同時に2本が同じ行を消しにきても、`READ COMMITTED` で後の DELETE は先の DELETE の確定後に行を見直すので、二重には数えない。**インメモリ**は同期区間で完結する。
  4. **(AU-1 (a)) v1.1.0 より前に purge した行は残る、という事実と見つけ方を CHANGELOG・`docs/migration-v1.md` に書く。**「v1.1.0 より前に purge した行は、purge をかけ直すと消える。かけ直すまでは残る」と、見つけるための SQL（`purged_at IS NOT NULL` で、`tags`・`attributes`・claim key のどれかが残っている、または `memory_labels` が残っている行）。
  5. **(AU-1 (c)) migration で遡って一括で消すことは、やらない。**オーナーの領分（過去に保存された行を一括で書き換える判断）である。この ADR は、利用者が purge をかけ直す経路だけを足す。
  6. **`recalls.index_band` の digest（#994 の系統）は触らない。【未確認・範囲外】** v1.0.x の purge が残した `recalls.index_band` の `digestBand` の digest が、今も残っているかどうかを、この PR では確かめていない。`scrubPurged` は `recalls` を書かない。

- **検討した代替案**:

  1. **(AU-1) `purgeMemory` 自体を、既に purge 済みの行にも効く形に変える（CAS の `purged_at IS NULL` を外し、残骸があれば書く）。** 採らなかった。`purgeMemory` の契約（2回目は `MemoryPurgeConflictError`、ADR 0124 決定2）を変えると、適合テストの既存の `it`（べき等性の要）と、自前の adapter が壊れる。`Runtime.purge` は `already_purged` を `purgeMemory` を呼ぶ前に判定しており、その前提も変わる。
  2. **(AU-1) `Runtime.purge` が `MemoryStore` の既存メソッドを組み合わせて直す（`getMany` で残骸を見て、何かで上書き）。** 採らなかった。`tags`・`attributes`・claim key を既存行に書く口も、`memory_labels` を外す口も、`MemoryStore` には無い（`purgeMemory` の中にしか無い）。
  3. **(AU-1) `scrubPurged` を必須メソッドにする。** 採らなかった。第三者の `MemoryStore` を壊す破壊的変更になる（`purgeMemory?` などと同じ）。任意にして、`Runtime.purge` は無ければ飛ばす。
  4. **(AU-1) `scrubPurged` に監査イベントを積ませる。** 採らなかった。`memory_events.kind` に値を足すには migration（CHECK 制約）が要る。この穴は「過去の purge の取りこぼしを、今の purge の範囲に揃える」だけで、新しい出来事ではない。
  5. **(AU-1 (c)) migration で遡って一括で消す。** 採らなかった（決定5。オーナーの領分）。
  6. **(AV-2) 9本それぞれに try/catch を書く。** 採らなかった。`omittingParams` 1つに寄せれば、ヘルパーが増えたときの足し忘れが1箇所で済む。さらに歯が公開 API の snapshot から一覧を引くので、足し忘れは赤になる。
  7. **(AV-2) store 側（`@mnemora/postgres`）の各メソッドで params を落とす。** 採らなかった（ADR 0423 の代替案7・ADR 0430 の代替案7と同じ理由）。
  8. **(AV-3) `Ctx` のように、`getSubjectActivitySeqs` の `subjectIds` を core の `readSubjectActivitySeqs` で検査する。** 採らなかった。store を直接呼ぶ呼び出しが素通りする（ADR 0423 は store の実装の入口を断る場所に含めている、決定4(b)）。

- **引き受けた負債**:

  - **通っていた入力が通らなくなる（破壊的変更）。** 孤立サロゲートか NUL を含む `subjectIds` の要素と `advanceActivityClock.subjectId` は、これまで Postgres では U+FFFD への置き換え（孤立サロゲート）か生の例外（NUL）になり、インメモリでは通っていた。適合テストに `it` を足したので、自前の store 実装は新しく落ちうる。
  - **`scrubPurged` は、purge をかけ直した行にしか効かない。** 自動では走らない。v1.1.0 より前に purge した行は、利用者が `purge` をかけ直すまで残る（決定4の SQL で見つける）。`Runtime.purge` は `forgotten` かつ purge 済みの id を受け取るので、id は見つけた行から渡せる。テナントをまたいで一括でかけ直す口は無い。
  - **`scrubPurged` を実装しない adapter は、かけ直しても残骸が消えない。**任意メソッドなので、適合テストでは `supportsScrubPurged`（省略可の3状態フラグ）で named it として見える。
  - **`scrubPurged` は監査イベントを積まない。** 残骸を消したことは、`memory_events` からは読めない。
  - **`proposed_count` は近似のままである。** ADR 0318「引き受けた負債」1・ADR 0375 決定2と同じ。legacy の行の分を外す前の値が、既に実数とずれていた場合（別の経路でずれた場合）、この掃除は `GREATEST(…, 0)` で止まるだけで、実数には直さない。
  - **`recalls.index_band` の digest・`recalls.query` は触らない**（決定6、【未確認・範囲外】）。ADR 0375 が「(b) 残る」とした表の、purge 後に残る他の経路（`contentHash`・元の Observation の `payload`・`digestSnapshot` など）も、この ADR では変えていない。
  - **core の test 用 Fake は識別子を検査しない**（`ctx` も含めて）。Fake と adapter の食い違いは、この PR でも残る。
  - **`readSubjectActivitySeqs`（core のヘルパー）が「`getSubjectActivitySeqs` を持たない adapter」では、渡された id をそのまま `0` に倒す。**そこでは識別子を検査しない（store が無いので、書く・読む先が無い）。

- **これが覆るとしたら**:

  - オーナーが「migration で遡って一括で消す」（決定5）を選んだとき。`scrubPurged` の SQL は、そのまま migration の本体にできる。そのときは `scrubPurged` は残してもよいし、外してもよい。
  - `memory_events.kind` に値を足す migration を入れる判断が出たとき。`scrubPurged` が監査イベントを積む形に寄せられる。
  - `MemoryStore` の必須メソッドを増やしてよいという判断（公開 API の破壊的変更の許容）が出たとき。`scrubPurged` を必須にできる。
  - 識別子の正規化を採る判断（ADR 0423 が挙げた条件）が出たとき。`subjectIds` の検査も正規化に置き換える。

- **測ったこと**（【実測】2026-10-01、手元の Postgres 17、UTF8（`C.UTF-8`）。歯を置いたあと、直す前の実装（一時的に外した）で赤を、直した後で緑を、やりすぎた実装（一時的に入れた）で赤を見た）:

  - **AV-2**（`packages/core/src/__tests__/tenant-settings-helpers-omit-params.test.ts`）: 直す前（`omittingParams` が `omitParamsFromError` を通さない）は9本とも赤、直した後は13本緑。やりすぎ（`message` を常に書き換える）は「params の無い message・独自の欄は書き換えない」の1本が赤。公開 API の snapshot から「第1引数が `store: TenantSettingsStore` の公開関数」を正規表現で引き、9本であることと表の一致を縛った。
  - **AV-3**（`describeTenantSettingsStoreConformance` の `getSubjectActivitySeqs の subjectIds[1]`、`describeMemoryStoreConformance` の `createRecall の advanceActivityClock.subjectId`）: Postgres・インメモリの両方で、直す前は各5本（孤立した上位・下位、逆順、後ろに文字、NUL）が赤、直した後は緑。やりすぎ（ASCII 以外の要素を断る）は、絵文字を含む値を断らない陽性対照の1本が赤（両 adapter、両方の欄）。
  - **AU-1**: (1) `packages/testkit/src/memory-store-conformance.ts` の `supportsScrubPurged` の歯5本（Postgres・インメモリ）。`scrubPurged` が無い（直す前）と5本とも赤。やりすぎ: 「`purged_at IS NOT NULL` と `forgotten` を見ない」は「未 purge の行・他テナントの行を触らない」が赤（Postgres・インメモリ）、「`purged_at` を見ず `forgotten` だけ見る」は同じ1本が赤（Postgres。`status` だけ見る形は `forgotten` で未 purge の行を巻き込むため）、「外した本数でなく紐付けを数えて減らす（二重に数え減らす）」は label の1本が赤、「残骸の無い行も更新する」は `updatedAt` の1本が赤。(2) `packages/postgres/src/__tests__/repurge-legacy-residue.postgres.test.ts`: v1.0.x の purge が残した状態を SQL で作り、`Runtime.purge` をかけ直すと `tags`・`attributes`・claim key・`memory_labels` が消え、`labels.proposed_count` が実数（残りの紐付けの本数）に揃い、dryRun は何も書かず、2回目以降は変わらない。直す前は赤、二重に数え減らす実装も赤。(3) `packages/core/src/__tests__/purge.test.ts`: `Runtime.purge` が `already_purged`（競合の枝を含む）でだけ `scrubPurged` を呼び、`dryRun`・`purged`・`status_not_forgotten`・`not_found` では呼ばないこと。失敗しても `kind` は変わらず `residueCleanup` が付くこと。直す前は3本赤、`dryRun` でも呼ぶ実装は2本赤、`purged` でも呼ぶ実装は1本赤。(4) `packages/postgres/src/__tests__/upgrade-from-released.postgres.test.ts`: fixture（v1.0.0〜v1.1.0）で復元した DB の purge 済みの行に `tags` を残し、migration の前後で `tags`（行スナップショットに足した列）が変わらないこと、purge をかけ直すと消えることを見る。`attributes`・claim key の列は v1.0.x の DB に無い（migration 0019・0021 が足す）ので、migration の前には見ていない。直す前は4本赤。
  - **測っていないこと**: 本番規模のデータでの `scrubPurged` の時間。`recalls.index_band` に v1.0.x の purge が残した digest があるか（決定6）。SQL_ASCII の DB での本 PR の歯（手元は UTF8 だけ。CI の2脚で見る）。`scrubPurged` を実装しない第三者の adapter の挙動。
