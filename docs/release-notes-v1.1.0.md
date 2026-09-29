# `v1.1.0` の Release 本文（草稿）

**クローン miku の委譲先が CHANGELOG から起こした草稿。載せ方の最終判断はオーナー**

> **⚠ この文書は、自動化された担い手（クローン miku の委譲先セッション）が書いたものである。**
> **⛔ オーナー本人の文章ではない。**
> **理由**: 担い手の署名は repo 上では `takecchi` になり、**オーナー本人と区別が付かない**
> （[ADR 0220](./decisions/0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この文書を「オーナーが書いた」と読まないこと。**⛔ **そのまま貼る前に、下の「貼る前に確かめること」を必ず踏むこと。**

**⛔ この文書は Release を作る手順ではない。「Release を作るときに GitHub の本文へ貼るテキスト」の草稿である。Release を作るのはオーナーである。**

出荷済みの版の release-notes 草稿（例: `v1.0.0` のもの。Issue #762 により出荷済みで削除済み）と
同じ理由で独立した文書にしてある——手順（`docs/release-v1.md`）と当日の成果物を混ぜない。

🔶 **版の種類について**: 問い `3f3411c5` の答えで版の種類が変わりうる。⟹ この文書の題と草稿の見出しの `v1.1.0` は、`CHANGELOG.md` の節名（`## [1.1.0] - 未リリース`）に合わせただけである。（⚠ 2026-09-28 追記: 答えは「公開の fixture が新しく例外を投げる変更は、破壊的変更として扱わない」だった（オーナーの回答（ask_human `3f3411c5`））。⟹ `CHANGELOG.md` の `[1.1.0]` 節に確定した破壊的変更は無く、題と見出しの `v1.1.0` と矛盾しない。版を決めるのは、これまでどおりオーナーである）（⚠ 2026-09-29 追記（19回目の棚卸し）: 直前の「確定した破壊的変更は無く」は、もう現在の状態ではない——PR #1377（Issue #1221）が着地し、`CHANGELOG.md` の `[1.1.0]` 節に確定した破壊的変更が1件ある。下の「🔴 破壊的変更」を見ること。版を決めるのは、これまでどおりオーナーであり、この草稿からは決めない）（⚠ 2026-09-29 追記（20回目の棚卸し）: 直前の「確定した破壊的変更が1件ある」も、もう現在の状態ではない——PR #1385（Issue #548 方向2、ADR 0352）も着地し、`CHANGELOG.md` の `[1.1.0]` 節に確定した破壊的変更が2件ある。下の「🔴 破壊的変更」を見ること。版を決めるのは、これまでどおりオーナーであり、この草稿からは決めない）

---

## ⚠ この文書の腐りの判定条件

**`docs/roadmap.md` §7.0 と同じ形を持たせる**——日付と数字を持つ文書は放っておけば必ず腐るので、読む人が自分で判定できるようにする。

| | |
|---|---|
| **書いた日** | 初版 2026-09-26（`origin/main` = `190f365` の木）。改版 2026-09-26（`ec39629` の木）。改版 2026-09-27（`ef03a8f` の木。下の「改版の経緯」）。改版 2026-09-27（2回目）（`23f0076` の木。CHANGELOG の8回目の棚卸しに合わせた）。改版 2026-09-28（`c6ca5a4` の木。CHANGELOG の9回目の棚卸しに合わせた）。改版 2026-09-28（2回目）（`de8a160` の木。CHANGELOG の10回目の棚卸しに合わせた）。改版 2026-09-28（3回目）（`dcf6ccb` の木。CHANGELOG の11回目の棚卸しに合わせた）。改版 2026-09-28（4回目）（`7d5f944` の木。CHANGELOG の12回目の棚卸しに合わせた）。改版 2026-09-28（5回目）（`a2fb621` の木。CHANGELOG の13回目の棚卸しに合わせた）。改版 2026-09-28（6回目）（`9378719` の木。CHANGELOG の15回目の棚卸しに合わせた。14回目は直すものが無く、改版しなかった）。改版 2026-09-28（7回目）（`0d282c1` の木。CHANGELOG の16回目の棚卸しに合わせた）。改版 2026-09-29（`86b42b1` の木。CHANGELOG の17回目の棚卸しに合わせた）。**改版 2026-09-28（UTC。直前の「2026-09-29」は日本時間の日付で、UTC では同じ 2026-09-28）**（`origin/main` = `f5ad59f` の木。CHANGELOG の18回目の棚卸しに合わせた）。改版 2026-09-28（8回目）（`origin/main` = `545cc54` の木に PR #1376 を載せたもの。問い `3f3411c5` の答えと、CHANGELOG の追記19 に合わせた）。改版 2026-09-29（`36f5f13` の木。Issue #762 により
`docs/release-notes-v1.0.0.md` を削除したのに合わせ、同ファイルへの参照2箇所を出荷済み版への
言及として書き換えた——CHANGELOG の棚卸し内容は変えていない）。**改版 2026-09-29（19回目の棚卸し）**（`origin/main` = `80c79df` の木。CHANGELOG の19回目の棚卸し・追記20 に合わせた。この回で PR #1377（Issue #1221）の破壊的変更が範囲に入ったので、「🔴 破壊的変更」の節を新設した）。**改版 2026-09-29（20回目の棚卸し）**（`origin/main` = `329bdb1` の木。CHANGELOG の20回目の棚卸し・追記21 に合わせた。この回で PR #1385（Issue #548 方向2、ADR 0352）の破壊的変更も範囲に入ったので、「🔴 破壊的変更」の節に2件目の項目を足した） |
| **書いた人** | **担い手（クローン miku の委譲先）。オーナーではない。**（冒頭のバナー） |
| **正はどれか** | ⛔ **この草稿ではない。**変更の一覧と根拠の PR/Issue は [`CHANGELOG.md`](../CHANGELOG.md) の `## [1.1.0] - 未リリース` 節（**`v1.0.2` … `329bdb1`** を数えたもの）が正。`v1.0.2`・`v1.0.1` として既に出荷済みの分は、同じファイルの `## [1.0.2] - 2026-09-27`・`## [1.0.1] - 2026-09-25` 節が正。保留と非破壊の数え方は `[1.1.0]` 節の前書きが正、破壊的変更の定義・移行手順は [`migration-v1.md`](./migration-v1.md) の「v1.0.2 → 次の版」の節が正 |
| **腐りの判定** | **次のいずれかが起きていたら腐っている**: ① `CHANGELOG.md` の `[1.1.0]` 節が数えた sha が `329bdb1` から動いた、または sha が同じまま `[1.1.0]` 節の中身が変わった。② `CHANGELOG.md` の `[1.1.0]` 節の前書きの「保留と非破壊の数え方」で、公開の fixture が新しく例外を投げる変更の扱いが「破壊的変更として扱わない」（オーナーの回答（ask_human `3f3411c5`））から変わった（⚠ 2026-09-28 まではここを「問い `3f3411c5` に答えが出た」としていた。答えが出たので、この草稿を答えに合わせて直した）。③ `packages/postgres/migrations/` の最後尾が `0023_lexical_query_inner_quote_as_space.sql` でなくなった。④ `v1.0.2`（tag `b981ecd`）より新しい Release が切られた。⑤ `CHANGELOG.md` の `[1.1.0]` 節 `### Breaking` の中身（PR #1377・Issue #1221、PR #1385・Issue #548 方向2）が変わった、またはこの節に3件目以降の破壊的変更が増えた。⟹ **どれか1つでも当てはまったら、この草稿ではなく当日の一次情報を信じ、貼る前に本文を直すこと。** |

⚠ **この文書は、正典の内容を意図的に複製している。**理由は出荷済みの版の release-notes 草稿と同じ——**Release 本文を読むのは repo の外に居る採用者**であり、リンクだけでは伝わらない。⟹ **複製を許す代わりに、上の「正はどれか」を必ず添える。**

🔴 **⛔ この草稿に、`v1.1.0` の変更の総件数を書かないこと。** tag はまだ切られておらず、`main` に1件着地するたびに写した数が腐る（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)。`CHANGELOG.md` `[1.1.0]` 節の前書きにも同じ規律が書いてある）。⟹ **各項目には根拠の PR/Issue へのリンクを付け、合計は数えない。**

### 改版の経緯（2026-09-27）

- 前の版のこの草稿は「`v1.0.1` からの差分」を名乗り、本文に連想枠の既定 on（PR #838）・`contestedWith`（PR #832）・`embeddingInput`（PR #834）や、PR #830・#839・#845・#846・#851 の修正を載せていた。
- オーナーは 2026-09-27T01:58:27Z に Release `v1.0.2`（tag が指す commit は `b981ecd`、PR #1098）を作り、npm へも公開していた。`CHANGELOG.md` はそれに合わせて `## [1.0.2]` 節を作り、`[1.1.0]` 節を `v1.0.2` から数え直した（PR #1192）。⟹ **前の版の本文の項目は、どれも `v1.0.2` として出荷済みになった**（今は `CHANGELOG.md` の `[1.0.2]` 節にある）。
- ⟹ **この改版で、草稿本文を `CHANGELOG.md` の `[1.1.0]` 節の事実だけから起こし直した。**`[1.1.0]` 節に無いことは書いていない。前の版の自己点検にあった [Issue #809](https://github.com/takecchi/mnemora/issues/809)（`CLOSED`）は、対象の PR #811・#813・#815 が `v1.0.1` で出荷済みで、この差分の範囲に無いので外した。

---

## 貼る前に確かめること

1. **`CHANGELOG.md` の `## [1.1.0] - 未リリース` 節が数えた sha が、まだ `329bdb1` か。**
   `grep -n '数えた基準を明記する' -A2 CHANGELOG.md` などで当日引き直すこと。⛔ **`329bdb1` から動いていたら、この草稿の一覧が漏れを持つ**——動いた分だけ CHANGELOG の該当節（追記22 以降。追記19 は「保留の解消」、追記20・追記21 はこの改版の根拠で、どちらも織り込み済み）を読み、この草稿へ足すこと。
   ⚠ **「表示されている sha が同じ」だけでは、内容が増えていないことの証明にならない**（前の版を書く過程で、sha を動かさずに `[1.1.0]` の `### Fixed` へ追記されることが3度起きた。PR #845・#846・#851）。⟹ `git diff 329bdb1 -- CHANGELOG.md` で `CHANGELOG.md` 自体の差分も当日見ること。
2. **公開の fixture が新しく例外を投げる変更の扱いが、まだ「破壊的変更として扱わない」か。**`CHANGELOG.md` `[1.1.0]` 節の前書きの「保留と非破壊の数え方」を見る（オーナーの回答（ask_human `3f3411c5`）、2026-09-28）。
   - **そう書いてあれば**: 下の草稿の「公開の fixture が新しく例外を投げるもの」の節はそのままでよい。
   - **変わっていたら**: `CHANGELOG.md` `[1.1.0]` 節と `docs/migration-v1.md` の「v1.0.2 → 次の版」の表現に合わせて、下の節の見出し・文言と、この文書の題と草稿の見出しの版を直すこと。
   - ⚠ 2026-09-28 まで、この項目は「問い `3f3411c5` に答えが出ているか」だった。答えが出たので、上のとおり直した。
3. **マイグレーションの最後尾が `packages/postgres/migrations/` と一致しているか。**`ls packages/postgres/migrations/ | tail -2` で、当日 `0023_lexical_query_inner_quote_as_space.sql` が最後尾か確認する。**`0024` 以降が増えていたら**、下の「postgres を使っている方へ」の案内を直すこと。
4. **`v1.0.2` より新しい Release が切られていないか。**`git tag -l "v1.*"`・`gh release list --limit 5`・`npm view @mnemora/core dist-tags` を当日その場で引き直すこと。**新しい版があれば、`CHANGELOG.md` にも対応する節が足されているはずである。**無ければこの草稿の起点が壊れているので、貼る前に本文を書き直すこと。
5. **本文中のリンク（PR/Issue）が実在し、番号を間違えていないか。**貼る前にもう一度 `gh pr view <n>` で軽く見直すこと。
6. **`CHANGELOG.md` `[1.1.0]` 節の `### Breaking` が、まだ PR #1377（Issue #1221）・PR #1385（Issue #548 方向2）の2件だけか。**`LC_ALL=C.UTF-8 grep -n '^### Breaking' -A3 CHANGELOG.md` で当日引き直すこと。**3件目以降が増えていたら**、下の「🔴 破壊的変更」の節を CHANGELOG の内容に合わせて足すこと。**この節自体が消えていたら**（例: PR #1377・#1385 が両方とも revert された）、下の「🔴 破壊的変更」の節も削ること。

---

## 草稿（ここから下を貼る）

> ## mnemora v1.1.0
>
> **⚠ 本文は草稿です。この Release を実際に作るのはオーナーです。**
>
> mnemora は、LLM アプリケーションに「思い出す」を与えようとしています。「保存する」ではなく。この節は **`v1.0.2`** からの差分です。変更の一覧とそれぞれの根拠 PR/Issue は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.1.0]` 節が正です。
>
> **`v1.0.1` 以前から直接この版へ上げる方へ**: この節より前に `v1.0.2`（と `v1.0.1`）があります。[CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.0.2]` 節（`v1.0.0` からなら `[1.0.1]` 節も）を合わせて読んでください。
>
> ### 🔴 まず
>
> - **postgres を使っている方へ**: `v1.0.2` からマイグレーションが1本増えています（`0023_lexical_query_inner_quote_as_space.sql`、語彙チャンネルのクエリの `"` の扱い、[PR #1187](https://github.com/takecchi/mnemora/pull/1187)）。`mnemora-postgres-migrate`（または `runMigrations`）を打ってください。`v1.0.1` から上げる場合は `0022`・`0023` の2本、`v1.0.0` から上げる場合は `0019`〜`0023` の5本が要ります。
>
> <!-- ⚠ 19回目の棚卸しで新設。中身は CHANGELOG [1.1.0] の ### Breaking の複製（AGENTS.md の反重複規律の例外——Release 本文は repo の外の読者向けなので、この文書自体が意図的に複製している。上の「この文書は、正典の内容を意図的に複製している」参照）。 -->
> ### 🔴 破壊的変更
>
> - **`@mnemora/openai`・`@mnemora/anthropic` の `*ProviderOptions.client` の型が、SDK のクラスから切り出した型から、SDK のクラスを名指ししない自前の構造型へ変わりました**（`OpenAILLMProviderOptions.client`・`OpenAIEmbeddingProviderOptions.client`・`AnthropicLLMProviderOptions.client`。[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)、[PR #1377](https://github.com/takecchi/mnemora/pull/1377)、[ADR 0350](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0350-provider-client-type-decoupled-from-sdk-classes.md)）。
>   - **`Pick<OpenAI, "chat">`・`Pick<OpenAI, "embeddings">`・`Pick<Anthropic, "messages">` を自分のコードの型注釈にそのまま書いている方**は、新しい型名（`OpenAIChatClient`・`OpenAIEmbeddingsClient`・`AnthropicMessagesClient`。どちらのパッケージからも export されています）へ書き換えてください。
>   - **SDK の client インスタンス（`new OpenAI(...)`・`new Anthropic(...)`）をそのまま `client` に渡しているだけの方は、型検査・実行時のどちらも影響を受けません。**むしろ、固定している版と違う版の SDK を入れると型検査が壊れていたのが、この変更で通るようになります。
>   - `client` を渡さない方（`apiKey` だけ、または環境変数）は影響を受けません。
>   - 詳しい移行手順は [docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) の「v1.0.2 → 次の版」の節、一覧・根拠は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.1.0]` `### Breaking` を見てください。
>
> <!-- ⚠ 20回目の棚卸しで追加。中身は CHANGELOG [1.1.0] の ### Breaking 2件目の項目の複製。 -->
> - **連想枠（`retrievedVia: "association"`）・必須の同伴取得（`retrievedVia: "mandatory_companion"`）で返ってくる記憶の `score` が、`total`・`similarity`・`lexicalMatch` という欄を持たなくなりました**（`undefined` になるのではなく、欄自体が無くなります。[Issue #548](https://github.com/takecchi/mnemora/issues/548) 方向2、[PR #1385](https://github.com/takecchi/mnemora/pull/1385)、[ADR 0352](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0352-association-score-without-total.md)）。`RecalledMemory.score`/`RecallRecordMemory.score`/`CorrectionCandidate.score` の型が `ScoreBreakdown` から新設の union `RecalledScore`（`ScoreBreakdown | AffinityUnmeasuredScore`）に変わります。
>   - **これらの欄を型を絞り込まずに読んでいる方**（例: `memory.score.total`）は、この版から型検査に落ちます。`affinityMeasured !== false` で絞り込んでください:
>     ```ts
>     const total = m.score.affinityMeasured !== false ? m.score.total : null;
>     ```
>   - **`.decay`/`.tagMatch`/`.freshness`/`.strength` だけを読んでいる方、独自の `ScoringStrategy` を実装している方は影響を受けません。**
>   - **順位・既定値・どの記憶が返るかは1ビットも変わりません**——実行時はもともと `association`/`mandatory_companion` の `total` は比較可能ではなかった値で、今回はその事実を型でも表すようにしただけです。DB マイグレーションは不要です。
>   - 詳しい移行手順は [docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) の「v1.0.2 → 次の版」の節（項目19）、一覧・根拠は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.1.0]` `### Breaking` を見てください。
>
> <!-- ⚠ 下の節を破壊的変更と数えないのは、オーナーの回答（ask_human 3f3411c5）による（CHANGELOG [1.1.0] の前書きと各項目の注）。 -->
> ### ⚠ 公開の fixture が新しく例外を投げるもの（`@mnemora/testkit/fixtures`。破壊的変更とは数えていません）
>
> 公開の fixture（`@mnemora/testkit/fixtures` の InMemory 一式）が、これまで受け入れていた不正な入力に、`@mnemora/postgres` と同じく新しく例外を投げるようになりました。**破壊的変更としては数えていません。**ただし、Postgres が拒む値や型の外の値を fixture に渡しているテストは、この版から例外になります。
>
> - `InMemoryMemoryStore.registerLabel` が、NUL（U+0000）を含む名前を拒みます（[PR #1135](https://github.com/takecchi/mnemora/pull/1135)）。
> - `InMemoryMemoryStore.listActiveClaimPredicates` が、`query.limit` の負数・`NaN`・`Infinity`・非整数・bigint に収まらない値を拒みます（[PR #1157](https://github.com/takecchi/mnemora/pull/1157)）。
> - `InMemoryTenantSettingsStore` の半減期の口（`setDefaultHalfLifeRecalls`・`setDefaultHalfLifeHours`）が、Postgres の `real` 列が拒む値を拒みます（[PR #1165](https://github.com/takecchi/mnemora/pull/1165)）。
> - `InMemoryEventStore.append` とイベントを受け取る `InMemoryMemoryStore` の口が、`MemoryEventKind` に無い kind を拒みます（[Issue #1096](https://github.com/takecchi/mnemora/issues/1096)、[PR #1170](https://github.com/takecchi/mnemora/pull/1170)）。
> - `InMemoryMemoryStore` が、`memories` の列挙の列（`status`・`digestSource`・`embeddingStatus`・`provenance.kind`）に列挙に無い値を拒みます（[PR #1183](https://github.com/takecchi/mnemora/pull/1183)）。
> - `InMemoryMemoryStore` の `createMemory` 系が、冪等の鍵が同じ既存の行が在っても、書けない値を拒みます（[PR #1190](https://github.com/takecchi/mnemora/pull/1190)）。
> - `InMemoryMemoryStore` の `createObservation`・`createObservationWithOutbox` が、日時の欄の Invalid Date を拒みます（[PR #1243](https://github.com/takecchi/mnemora/pull/1243)）。
> - `InMemoryMemoryStore` が、Postgres の CHECK 制約と型の変換に当たる値（`stated`/`inferred` で `sourceObservationId` が無い、活動時計の通し番号・`halfLifeRecalls` の範囲の外、`events_purged` で `memoryId` が在るイベント）を拒みます（[PR #1250](https://github.com/takecchi/mnemora/pull/1250)）。
> - `InMemoryMemoryStore` が、空文字 `""` の参照（`sourceObservationId`・`supersededById`・`contestedWithId`）を、参照先が無いとして拒みます。空文字の `externalId` は、2回目から既存の行を返すようになります（こちらは例外ではなく結果が変わるだけです。[PR #1252](https://github.com/takecchi/mnemora/pull/1252)）。
> - 読みの口（`purgeExpiredEvents`・`archiveDecayed`・`aggregateScope`・`findActiveByClaimKey`・`InMemoryEventStore.list` など）が、条件の Invalid Date と整数でない通し番号を拒みます（[PR #1265](https://github.com/takecchi/mnemora/pull/1265)）。
> - `InMemoryTenantSettingsStore.setEventRetention` が、Postgres の `integer` に収まらない `days` を拒みます（[PR #1270](https://github.com/takecchi/mnemora/pull/1270)）。
> - `InMemoryMemoryStore.createRecall` と `InMemoryOutboxStore.claimBatch` が、Postgres が書けない値（NUL を含む文字列・JSON にならない値など）を拒みます（[PR #1280](https://github.com/takecchi/mnemora/pull/1280)）。
>
> <!-- ⚠ 下の2件を非破壊と数えたのはクローン miku の判断であり、オーナーの判断ではない（CHANGELOG [1.1.0] の各項目の注）。 -->
> ### ⚠ ほかに新しく例外を投げるが、破壊的変更とは数えていないもの
>
> どれも、一度も意図どおりに動いたことの無い入力を、本物の adapter が早めに拒むものです。
>
> - **`@mnemora/postgres` の `registerEmbeddingSpace` が、同じテーブル名に潰れる別の埋め込み空間の登録を、`EmbeddingSpaceTableConflictError` で拒むようになりました**（[Issue #1151](https://github.com/takecchi/mnemora/issues/1151)、[PR #1156](https://github.com/takecchi/mnemora/pull/1156)）。これまでは黙って通り、2つの空間のベクトルが混ざっていました。**衝突する2つの空間を起動のたびに両方登録していたデプロイは、この版から2つ目の登録で落ちるようになります。**混ざった行は分けません。
> - **`TenantSettingsStore.setEventRetention` が、型の外の `kind`（`{ kind: "bogus" }` や `{ kind: "Days", days: 30 }` など）を拒むようになりました**（[Issue #1168](https://github.com/takecchi/mnemora/issues/1168)、[PR #1171](https://github.com/takecchi/mnemora/pull/1171)）。これまでは保持期間を無期限として書いていました。`@mnemora/postgres` と `@mnemora/testkit/fixtures` の両方で同じです。
>
> ### 新しく足した名前
>
> - **`@mnemora/core` の `EVENT_RETENTION_KIND_INVALID_MESSAGE` と `assertValidEventRetentionKind(value: string)`**（[PR #1171](https://github.com/takecchi/mnemora/pull/1171)）——上の `setEventRetention` の `kind` の検査の口です。公開の名前の追加だけで、既存の宣言は変えていません。
>
> ### 主な修正
>
> - **`@mnemora/openai` で `runtime.reflect()` が毎回 `llm_failed` になっていた不具合を直しました。**根が object でないスキーマを、OpenAI の strict な Structured Outputs が受け付けない形で送っていました（[PR #1147](https://github.com/takecchi/mnemora/pull/1147)）。
> - **`consolidate()` / `reflect()` の `{ seedMemoryId }` 形は、種が forget・purge された記憶なら、近傍を集めなくなりました**（自動 job の `tick()` 経由も同じ。[Issue #1136](https://github.com/takecchi/mnemora/issues/1136)、[PR #1145](https://github.com/takecchi/mnemora/pull/1145)）。
> - **`MemoryStore.reinforce`（と `reinforceMany`・`recordUsageAndReinforce`）が、未強化の記憶に作成時刻より前の `at` を渡されると、減衰の起点を作成時刻より前へ戻していた不具合を直しました**（[Issue #1093](https://github.com/takecchi/mnemora/issues/1093)、[PR #1173](https://github.com/takecchi/mnemora/pull/1173)）。
> - **`@mnemora/postgres` の `purgeExpiredEvents` が、同時に走った掃除で、実際には消していない行まで件数に数えていた不具合を直しました。**極大の保持日数で掃除が例外になっていた件もあわせて直しました（[PR #1129](https://github.com/takecchi/mnemora/pull/1129)）。
> - **`@mnemora/postgres` の語彙チャンネルで、クエリの語の途中の `"` のせいで、本文と同じ文字列でも当たらなかった不具合を直しました**（[PR #1187](https://github.com/takecchi/mnemora/pull/1187)。上のマイグレーション `0023`）。
> - **LLM が空白だけの本文を返したときに、その本文の Memory が書かれていた不具合を直しました**（[Issue #1065](https://github.com/takecchi/mnemora/issues/1065)、[PR #1128](https://github.com/takecchi/mnemora/pull/1128)）。
> - **`@mnemora/postgres` の `runMigrations()`（と `mnemora-postgres-migrate`）が、advisory lock を持つ接続だけが切れたときに、ロックの無いまま適用を続け、別の実行と重なりえた不具合を直しました。**ロックの下の本体を、ロックを持つ接続そのもので流します（[Issue #1212](https://github.com/takecchi/mnemora/issues/1212)、[PR #1220](https://github.com/takecchi/mnemora/pull/1220)）。
> - **`@mnemora/local-embedding` のモデルの読み込みに失敗したときのメッセージが、`cacheDir` を省いたときのキャッシュの場所を npm の配置で決め打ちに名指していた不具合を直しました。**pnpm などでも、実際に解決された場所を名指します（[PR #1223](https://github.com/takecchi/mnemora/pull/1223)）。
> - **`@mnemora/postgres` の `aggregateScope()` が、`digestBand.excludeMemoryIds` に uuid の形をしていない id が混ざると、DB の例外を投げていた不具合を直しました。**形の崩れた id は、ほかの読みの口と同じく「無いもの」として扱います（[Issue #1262](https://github.com/takecchi/mnemora/issues/1262)、[PR #1289](https://github.com/takecchi/mnemora/pull/1289)）。
> - **`@mnemora/postgres` の `PostgresVectorStore.searchMany()` が、`queries` の `key` に NUL を含む文字列が在ると、DB の例外を投げていた不具合を直しました。**同じベクトルの `search()` と同じく投げません（[Issue #1285](https://github.com/takecchi/mnemora/issues/1285)、[PR #1299](https://github.com/takecchi/mnemora/pull/1299)）。
> - **`@mnemora/postgres` の `PostgresVectorStore.searchMany()` が、`queries` に同じ `key` が2回以上あると、その key のクエリすべての結果を続けて積み、`limit` を超えうる結果を返していた不具合を直しました。**同じ key では最後のクエリの結果だけを返します（[Issue #1284](https://github.com/takecchi/mnemora/issues/1284)、[PR #1308](https://github.com/takecchi/mnemora/pull/1308)）。
> - **`runtime.observe()` と `tick()` の抽出が、LLM の抽出結果に保存できない候補（本文の NUL、`@mnemora/postgres` の tsvector の上限を超える本文など）が在ると、手前の候補だけを書いたまま例外で止まっていた不具合を直しました。**その候補だけを落とし、残りの候補を書いて、投げません。落とした候補は、残った候補の `created` イベントの `meta.droppedCandidates` に残ります（本文は写しません）。全件が保存できないときは、これまでどおり例外を投げます（[Issue #1063](https://github.com/takecchi/mnemora/issues/1063)、[PR #1318](https://github.com/takecchi/mnemora/pull/1318)）。
> - **`tick()` の抽出のジョブが、リースが切れて逐次に再配達されると、LLM の出力が変わったときに2回分の Memory を両方 `active` で残していた不具合を直しました。**その Observation から今の抽出器の版で作られた Memory が在れば、LLM を呼ばずにジョブを完了にします。1回目が候補の一部だけを書いて止まった場合、残りの候補は作られないので、`reextract` で回復してください。並行に2本が同じジョブを処理する場合は、まだ塞げていません（[Issue #1092](https://github.com/takecchi/mnemora/issues/1092)、[PR #1318](https://github.com/takecchi/mnemora/pull/1318)）。
> - **`runtime.reextract()` が、forget・purge・訂正で退けた記憶の元の Observation に対しても抽出をやり直し、LLM が言い換えると、退けた事実が印の無い新しい `active` な記憶として戻っていた問題を直しました。**退けた記憶を持つ Observation では LLM を呼ばず、何も書かず、`extraction: "skipped"`・`atomicity: "not_attempted"` を返します。型は変わりませんが、これまでの TSDoc は「`reextract` の `extraction` は `'skipped'` を取らない」と約束していました。その前提で書いたコードは見直してください（[Issue #1079](https://github.com/takecchi/mnemora/issues/1079)・[Issue #1149](https://github.com/takecchi/mnemora/issues/1149)、[PR #1319](https://github.com/takecchi/mnemora/pull/1319)。CHANGELOG では `### Changed`）。
> - **`@mnemora/postgres` に大文字の UUID を渡すと、`get()` が同じ記憶を返すのに「memory not found」や `not_found` になっていた不具合を直しました。**`reinforceMany()`・`markContestedPair()`・`resolveContestedPair()` と、`runtime.forget()`・`restoreArchived()`・`purge()`・`markContested()`・`resolveContested()`・`consolidate()`・`reflect()` は、大文字の UUID も在る記憶として扱います（`{ seedMemoryId }` の種が近傍にも入って2回並ぶことも無くなりました）。`restoreSupersededBy()` と `markContested()`・`resolveContested()` がイベントの `meta` に載せる id も、列の値（小文字）に揃います。小文字で渡したときと、大文字小文字を区別する store での結果は変わりません（[PR #1324](https://github.com/takecchi/mnemora/pull/1324)、[PR #1327](https://github.com/takecchi/mnemora/pull/1327)、[PR #1329](https://github.com/takecchi/mnemora/pull/1329)）。
> - **`@mnemora/postgres` の `markContestedPair()`・`resolveContestedPair()`・`resolveOrphanedContested()` が、TSDoc の約束と違う種類の例外を投げていた不具合を直しました。**同じ記憶を小文字と大文字で渡したときは `RangeError` を、`resolveOrphanedContested()` に uuid の形でない `contestedWithId` を渡したときは DB の例外ではなく `MemoryStatusConflictError`（記憶が無ければ「memory not found」）を投げます。例外になる入力は変わりませんが、これまでの例外の文面や `err.cause.code` で分けていたコードは見直してください。大文字の UUID で今も例外になるときは、例外の文面と `MemoryStatusConflictError.memoryId` の id が小文字になります（[PR #1327](https://github.com/takecchi/mnemora/pull/1327)）。
> - **`@mnemora/openai` の `completeStructured()` で、スキーマがもともと `null` を許す欄（必須の `.nullable()`・`.nullable()` の配列の要素・根の `.nullable()`）にモデルが `null` を返すと `ZodError` になっていた不具合を直しました。**その `null` は `null` のまま返ります。`.optional()` と `.nullable().optional()` の欄の `null` はこれまでどおり省略として返り、これまで通っていた入力の結果は変わりません（[PR #1337](https://github.com/takecchi/mnemora/pull/1337)）。
> - 一覧と根拠は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.1.0]` `### Fixed` を見てください——ここでは複製しません（イベントの欄の約束どおりの記録、testkit の fixture を Postgres に揃えた修正、例外の文面の改善などが載っています）。
>
> **移行手順の詳細は [docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) の「v1.0.2 → 次の版」の節が正です。**
