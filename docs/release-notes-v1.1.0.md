# `v1.1.0` の Release 本文（草稿）

**クローン miku の委譲先が CHANGELOG から起こした草稿。載せ方の最終判断はオーナー**

> **⚠ この文書は、自動化された担い手（クローン miku の委譲先セッション）が書いたものである。**
> **⛔ オーナー本人の文章ではない。**
> **理由**: 担い手の署名は repo 上では `takecchi` になり、**オーナー本人と区別が付かない**
> （[ADR 0220](./decisions/0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この文書を「オーナーが書いた」と読まないこと。**⛔ **そのまま貼る前に、下の「貼る前に確かめること」を必ず踏むこと。**

**⛔ この文書は Release を作る手順ではない。「Release を作るときに GitHub の本文へ貼るテキスト」の草稿である。Release を作るのはオーナーである。**

`docs/release-notes-v1.0.0.md` と同じ理由で独立した文書にしてある——手順（`docs/release-v1.md`）と当日の成果物を混ぜない。

🔶 **版の種類について**: 問い `3f3411c5` の答えで版の種類が変わりうる。⟹ この文書の題と草稿の見出しの `v1.1.0` は、`CHANGELOG.md` の節名（`## [1.1.0] - 未リリース`）に合わせただけである。

---

## ⚠ この文書の腐りの判定条件

**`docs/roadmap.md` §7.0 と同じ形を持たせる**——日付と数字を持つ文書は放っておけば必ず腐るので、読む人が自分で判定できるようにする。

| | |
|---|---|
| **書いた日** | 初版 2026-09-26（`origin/main` = `190f365` の木）。改版 2026-09-26（`ec39629` の木）。**改版 2026-09-27**（`origin/main` = `8a403d1` の木。下の「改版の経緯」） |
| **書いた人** | **担い手（クローン miku の委譲先）。オーナーではない。**（冒頭のバナー） |
| **正はどれか** | ⛔ **この草稿ではない。**変更の一覧と根拠の PR/Issue は [`CHANGELOG.md`](../CHANGELOG.md) の `## [1.1.0] - 未リリース` 節（**`v1.0.2` … `8a403d1`** を数えたもの）が正。`v1.0.2`・`v1.0.1` として既に出荷済みの分は、同じファイルの `## [1.0.2] - 2026-09-27`・`## [1.0.1] - 2026-09-25` 節が正。保留と非破壊の数え方は `[1.1.0]` 節の前書きが正、破壊的変更の定義・移行手順は [`migration-v1.md`](./migration-v1.md) の「v1.0.2 → 次の版」の節が正 |
| **腐りの判定** | **次のいずれかが起きていたら腐っている**: ① `CHANGELOG.md` の `[1.1.0]` 節が数えた sha が `8a403d1` から動いた、または sha が同じまま `[1.1.0]` 節の中身が変わった。② オーナーへの問い `3f3411c5` に答えが出た（この草稿は、公開の fixture が新しく例外を投げる変更を「破壊的として扱うかは未決」のまま書き、版の種類も決めていない）。③ `packages/postgres/migrations/` の最後尾が `0023_lexical_query_inner_quote_as_space.sql` でなくなった。④ `v1.0.2`（tag `b981ecd`）より新しい Release が切られた。⟹ **どれか1つでも当てはまったら、この草稿ではなく当日の一次情報を信じ、貼る前に本文を直すこと。** |

⚠ **この文書は、正典の内容を意図的に複製している。**理由は `docs/release-notes-v1.0.0.md` と同じ——**Release 本文を読むのは repo の外に居る採用者**であり、リンクだけでは伝わらない。⟹ **複製を許す代わりに、上の「正はどれか」を必ず添える。**

🔴 **⛔ この草稿に、`v1.1.0` の変更の総件数を書かないこと。** tag はまだ切られておらず、`main` に1件着地するたびに写した数が腐る（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)。`CHANGELOG.md` `[1.1.0]` 節の前書きにも同じ規律が書いてある）。⟹ **各項目には根拠の PR/Issue へのリンクを付け、合計は数えない。**

### 改版の経緯（2026-09-27）

- 前の版のこの草稿は「`v1.0.1` からの差分」を名乗り、本文に連想枠の既定 on（PR #838）・`contestedWith`（PR #832）・`embeddingInput`（PR #834）や、PR #830・#839・#845・#846・#851 の修正を載せていた。
- オーナーは 2026-09-27T01:58:27Z に Release `v1.0.2`（tag が指す commit は `b981ecd`、PR #1098）を作り、npm へも公開していた。`CHANGELOG.md` はそれに合わせて `## [1.0.2]` 節を作り、`[1.1.0]` 節を `v1.0.2` から数え直した（PR #1192）。⟹ **前の版の本文の項目は、どれも `v1.0.2` として出荷済みになった**（今は `CHANGELOG.md` の `[1.0.2]` 節にある）。
- ⟹ **この改版で、草稿本文を `CHANGELOG.md` の `[1.1.0]` 節の事実だけから起こし直した。**`[1.1.0]` 節に無いことは書いていない。前の版の自己点検にあった [Issue #809](https://github.com/takecchi/mnemora/issues/809)（`CLOSED`）は、対象の PR #811・#813・#815 が `v1.0.1` で出荷済みで、この差分の範囲に無いので外した。

---

## 貼る前に確かめること

1. **`CHANGELOG.md` の `## [1.1.0] - 未リリース` 節が数えた sha が、まだ `8a403d1` か。**
   `grep -n '数えた基準を明記する' -A2 CHANGELOG.md` などで当日引き直すこと。⛔ **`8a403d1` から動いていたら、この草稿の一覧が漏れを持つ**——動いた分だけ CHANGELOG の該当節（追記8 以降）を読み、この草稿へ足すこと。
   ⚠ **「表示されている sha が同じ」だけでは、内容が増えていないことの証明にならない**（前の版を書く過程で、sha を動かさずに `[1.1.0]` の `### Fixed` へ追記されることが3度起きた。PR #845・#846・#851）。⟹ `git diff 8a403d1 -- CHANGELOG.md` で `CHANGELOG.md` 自体の差分も当日見ること。
2. **オーナーへの問い `3f3411c5` に答えが出ているか。**`CHANGELOG.md` `[1.1.0]` 節の前書きの「保留と非破壊の数え方」が、まだ「未回答」と書いているかを見る。
   - **まだ未回答なら**: 下の草稿の「破壊的として扱うかは未決のもの」はそのままでよい。版の種類も、この草稿からは決めないこと。
   - **答えが出たら**: `CHANGELOG.md` `[1.1.0]` 節と `docs/migration-v1.md` の「v1.0.2 → 次の版」が書き換わっているはずなので、その表現に合わせて、下の節の見出し・文言と、この文書の題と草稿の見出しの版を直すこと。
3. **マイグレーションの最後尾が `packages/postgres/migrations/` と一致しているか。**`ls packages/postgres/migrations/ | tail -2` で、当日 `0023_lexical_query_inner_quote_as_space.sql` が最後尾か確認する。**`0024` 以降が増えていたら**、下の「postgres を使っている方へ」の案内を直すこと。
4. **`v1.0.2` より新しい Release が切られていないか。**`git tag -l "v1.*"`・`gh release list --limit 5`・`npm view @mnemora/core dist-tags` を当日その場で引き直すこと。**新しい版があれば、`CHANGELOG.md` にも対応する節が足されているはずである。**無ければこの草稿の起点が壊れているので、貼る前に本文を書き直すこと。
5. **本文中のリンク（PR/Issue）が実在し、番号を間違えていないか。**貼る前にもう一度 `gh pr view <n>` で軽く見直すこと。

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
> <!-- ⚠ 問い 3f3411c5 待ち: 下の節は、公開の fixture が不正な入力に新しく例外を投げる変更を、破壊的として扱うか決まっていないことを書いたもの。答えが出たら CHANGELOG [1.1.0] の記述に合わせて見出しと文言を直すこと。 -->
> ### 🔶 破壊的として扱うかは未決のもの（`@mnemora/testkit/fixtures`）
>
> 公開の fixture（`@mnemora/testkit/fixtures` の InMemory 一式）が、これまで受け入れていた不正な入力に、`@mnemora/postgres` と同じく新しく例外を投げるようになりました。**破壊的として扱うかは未決です。**Postgres が拒む値や型の外の値を fixture に渡しているテストは、この版から例外になります。
>
> - `InMemoryMemoryStore.registerLabel` が、NUL（U+0000）を含む名前を拒みます（[PR #1135](https://github.com/takecchi/mnemora/pull/1135)）。
> - `InMemoryMemoryStore.listActiveClaimPredicates` が、`query.limit` の負数・`NaN`・`Infinity`・非整数・bigint に収まらない値を拒みます（[PR #1157](https://github.com/takecchi/mnemora/pull/1157)）。
> - `InMemoryTenantSettingsStore` の半減期の口（`setDefaultHalfLifeRecalls`・`setDefaultHalfLifeHours`）が、Postgres の `real` 列が拒む値を拒みます（[PR #1165](https://github.com/takecchi/mnemora/pull/1165)）。
> - `InMemoryEventStore.append` とイベントを受け取る `InMemoryMemoryStore` の口が、`MemoryEventKind` に無い kind を拒みます（[Issue #1096](https://github.com/takecchi/mnemora/issues/1096)、[PR #1170](https://github.com/takecchi/mnemora/pull/1170)）。
> - `InMemoryMemoryStore` が、`memories` の列挙の列（`status`・`digestSource`・`embeddingStatus`・`provenance.kind`）に列挙に無い値を拒みます（[PR #1183](https://github.com/takecchi/mnemora/pull/1183)）。
> - `InMemoryMemoryStore` の `createMemory` 系が、冪等の鍵が同じ既存の行が在っても、書けない値を拒みます（[PR #1190](https://github.com/takecchi/mnemora/pull/1190)）。
>
> <!-- ⚠ 下の2件を非破壊と数えたのはクローン miku の判断であり、オーナーの判断ではない（CHANGELOG [1.1.0] の各項目の注）。 -->
> ### ⚠ 新しく例外を投げるが、破壊的変更とは数えていないもの
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
> - 一覧と根拠は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.1.0]` `### Fixed` を見てください——ここでは複製しません（イベントの欄の約束どおりの記録、testkit の fixture を Postgres に揃えた修正、例外の文面の改善などが載っています）。
>
> **移行手順の詳細は [docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) の「v1.0.2 → 次の版」の節が正です。**
