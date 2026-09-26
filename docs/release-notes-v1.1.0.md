# `v1.1.0` の Release 本文（草稿）

> **⚠ この文書は、自動化された担い手（クローン miku の委譲先セッション）が書いたものである。**
> **⛔ オーナー本人の文章ではない。**
> **理由**: 担い手の署名は repo 上では `takecchi` になり、**オーナー本人と区別が付かない**
> （[ADR 0220](./decisions/0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この文書を「オーナーが書いた」と読まないこと。**⛔ **そのまま貼る前に、下の「貼る前に確かめること」を必ず踏むこと。**

**⛔ この文書は Release を作る手順ではない。「Release を作るときに GitHub の本文へ貼るテキスト」の草稿である。Release を作るのはオーナーである。**

`docs/release-notes-v1.0.0.md` と同じ理由で独立した文書にしてある——手順（`docs/release-v1.md`）と当日の成果物を混ぜない。

---

## ⚠ この文書の腐りの判定条件

**`docs/roadmap.md` §7.0 と同じ形を持たせる**——日付と数字を持つ文書は放っておけば必ず腐るので、読む人が自分で判定できるようにする。

| | |
|---|---|
| **書いた日** | **2026-09-26**（`origin/main` = `190f365` の木で書いた） |
| **書いた人** | **担い手（クローン miku の委譲先）。オーナーではない。**（冒頭のバナー） |
| **正はどれか** | ⛔ **この草稿ではない。**変更の一覧と根拠 ADR/Issue は [`CHANGELOG.md`](../CHANGELOG.md) の `## [1.1.0] - 未リリース` 節（**`v1.0.0` … `747acaf`** を数えたもの）が正、既定 on の決定は [ADR 0337](./decisions/0337-recall-association-default-on.md)、`contestedWith` は [ADR 0335](./decisions/0335-recalled-memory-contested-with.md)、`embeddingInput` は [ADR 0336](./decisions/0336-embedding-input-opt-in-hook.md)、破壊的変更の定義・移行手順は [`migration-v1.md`](./migration-v1.md)、testkit の Fake の例外化を破壊的変更として扱うかは [Issue #809](https://github.com/takecchi/mnemora/issues/809) が正 |
| **腐りの判定** | **次のいずれかが起きていたら腐っている**: ① `CHANGELOG.md` の `[1.1.0]` 節が数えた sha が `747acaf` から動いた（＝新しい変更が積まれた）。② [Issue #809](https://github.com/takecchi/mnemora/issues/809) が決着した（この草稿は🔶マークの箇所を未決のまま書いている）。③ `packages/postgres/migrations/` の本数が3本（`0019`〜`0021`）から増減した。④ 下の「⚠ 未解決のまま残した重大な食い違い（v1.0.1）」が解消・説明された。⟹ **どれか1つでも当てはまったら、この草稿ではなく当日の一次情報を信じ、貼る前に本文を直すこと。** |

⚠ **この文書は、正典の内容を意図的に複製している。**理由は `docs/release-notes-v1.0.0.md` と同じ——**Release 本文を読むのは repo の外に居る採用者**であり、リンクだけでは伝わらない。⟹ **複製を許す代わりに、上の「正はどれか」を必ず添える。**

🔴 **⛔ この草稿に、`v1.1.0` の変更の総件数を書かないこと。** `v1.1.0` の tag はまだ切られておらず、`main` に1件着地するたびに写した数が腐る（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)。`CHANGELOG.md` `[1.1.0]` 節の前置きにも同じ規律が書いてある）。⟹ **各項目には根拠の PR/ADR/Issue へのリンクを付け、合計は数えない。**

### 🔴 未解決のまま残した重大な食い違い（v1.0.1）

**この草稿を書く過程で見つけた、この作業の範囲では解決していない食い違いをここに書く。** ⛔ **CHANGELOG.md・tag・release には触っていない**（依頼の禁止事項）——**見つけたことを報告するだけである。**

【実測 2026-09-26】

- `git tag -l "v1.*"` → `v1.0.0` と **`v1.0.1`** の両方が存在する。
- `gh api repos/takecchi/mnemora/releases` → `v1.0.1` は **2026-09-25T21:16:41Z に published**（draft でも pre-release でもない）。
- `npm view @mnemora/core dist-tags` → `{ latest: '1.0.1' }`。**npm 上の最新は `1.0.0` ではなく `1.0.1` である。**
- `v1.0.1` タグが指す commit は **`cf11cd6`**（PR #827「`supportsTaxonomyMode`/`supportsLabels`/`supportsFindActiveByClaimKey` を任意へ戻す」）。
- **`cf11cd6` は、`CHANGELOG.md` の `[1.1.0]` 節が「`v1.0.0` から数えた未リリースの変更」として扱っている範囲のちょうど真ん中に位置する**——`git log --oneline c27ca95..190f365`（`c27ca95` = `v1.0.0` タグの commit）で見ると、`cf11cd6`（PR #827）は PR #828 の直後・PR #831/#832（`contestedWith`、ADR 0335）の直前にある。
- ⟹ **`v1.0.1` が実際に npm へ公開されているなら、`CHANGELOG.md` の `[1.1.0]` 節が「未リリース」として数えている変更のうち、少なくとも `v1.0.0` から `cf11cd6` までの分は、既に `v1.0.1` として出荷済みである可能性がある。** `CHANGELOG.md` には `## [1.0.1]` 節が無く、`docs/migration-v1.md` にも `v1.0.1` への言及が無い。

⛔ **この草稿は、この食い違いを解消していない。** `CHANGELOG.md` の記述（「この節は `v1.0.0` からの差分を対象とする」）に合わせて書いた——依頼が「CHANGELOG と食い違う記述は書かない」ことを求めているため。**だが `CHANGELOG.md` 自身がこの `v1.0.1` の存在と整合しているかどうかは、この担い手には判定できない**（`v1.0.1` が誤って切られた tag なのか、追随漏れなのかも含め、この repo の中だけからは決められない）。⟹ **この草稿を実際に貼る前に、マネージャー・オーナーがこの食い違いを解消していることを確認すること。** 解消のしかたによっては、この草稿の前提（「`v1.0.0` からの差分」）そのものが書き直しになる。

---

## 貼る前に確かめること

1. **`CHANGELOG.md` の `## [1.1.0] - 未リリース` 節が数えた sha が、まだ `747acaf` か。**
   `grep -n '数えた基準を明記する' -A2 CHANGELOG.md` などで当日引き直すこと。⛔ **`747acaf` から動いていたら、この草稿の「新しく足した機能」「主な修正」の一覧が漏れを持つ**——動いた分だけ CHANGELOG の該当節を読み、この草稿へ追記すること。
   ⚠ **【実測 2026-09-26】この草稿を書く途中の `git merge origin/main` で、PR #845（`decay.ts` の `floorAt` 修正）が sha を動かさずに `[1.1.0]` の `### Fixed` へ1項目追記されているのを見つけた**（`747acaf` という表示は変わっていない）。⟹ **「表示されている sha が同じ」だけでは、内容が増えていないことの証明にならない**——`git diff` で `CHANGELOG.md` 自体の差分も当日見ること。この1件はこの草稿に反映済み。
2. **[Issue #809](https://github.com/takecchi/mnemora/issues/809) が決着しているか。**`gh issue view 809 --json state,title` で当日確認する。
   - **まだ `OPEN` なら**: この草稿の🔶マーク（`<!-- ⚠ #809 待ち -->` の直後）2箇所はそのままでよい。
   - **`CLOSED` になっており、「破壊的変更として扱う」と決まった場合**: 「🔴 まず」節末尾の「破壊的変更はありません」を「一部破壊的変更があります」に直し、PR #811/#813/#815（負数・`NaN`・`Infinity`・非整数の `limit`、float4 範囲外の値を testkit の Fake が例外にする変更）を新しい「### 破壊的変更」節へ移すこと。移行手順は、その時点で `docs/migration-v1.md` に新しい番号付き項目が足されているはずなので、それを指す（この草稿は先回りして番号を書かない——`migration-v1.md` は担い手の作業範囲外）。
   - **`CLOSED` になっており、「破壊的変更としては扱わない」と決まった場合**: 「⚠ まだ決まっていないこと」節を削り、PR #811/#813/#815 を「主な修正」節の通常の1項目（他の Fake 修正と同じ扱い）へ書き直すこと。
3. **マイグレーションの本数が `packages/postgres/migrations/` と一致しているか。**`ls packages/postgres/migrations/ | tail -5` で当日 `0019`/`0020`/`0021` が最後尾か確認する。**4本目が増えていたら**、「🔴 まず」節の migrate の案内を更新すること。
4. **tag の範囲——上の「🔴 未解決のまま残した重大な食い違い（v1.0.1）」が解消しているか。**`git tag -l "v1.*"`・`gh release list --limit 5`・`npm view @mnemora/core dist-tags` を当日その場で引き直すこと。**解消済み（CHANGELOG.md に `[1.0.1]` 節が足された、または `v1.0.1` が取り消された等）なら、この草稿の前提を当日の状態に合わせて書き直すこと。**未解決のまま貼ると、採用者に誤った差分範囲を伝える。
5. **本文中のリンク（PR/Issue/ADR）が実在し、番号を間違えていないか。**この草稿は `gh pr view <n>` で番号を確認しながら書いたが、貼る前にもう一度軽く見直すこと。

---

## 草稿（ここから下を貼る）

> ## mnemora v1.1.0
>
> **⚠ 本文は草稿です。この Release を実際に作るのはオーナーです。**
>
> mnemora は、LLM アプリケーションに「思い出す」を与えようとしています。「保存する」ではなく。この節は `v1.0.0` からの差分です。変更の一覧とそれぞれの根拠 ADR/Issue は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.1.0]` 節が正です。
>
> ### 🔴 まず — 既定の挙動が変わるものがあります
>
> - **連想枠（`RecallQuery.association`、段3.5）の既定が off → on になりました。** `recall()` を呼ぶときに `association` を省略すると、これまでは連想が一切走りませんでしたが、`v1.1.0` からは新設の `DEFAULT_RECALL_ASSOCIATION`（`{ maxCount: 10 }`）で連想が走ります——クエリに直接は当たらなかったが、当たった記憶（アンカー）の近傍として引いた候補（`retrievedVia: "association"`）が、`association` を渡さない呼び出しでも結果に混ざりうるようになります。
>   **従来どおり連想を一切走らせたくない場合は、`association: null` を明示的に渡してください**（`undefined`＝省略＝既定を適用、`null`＝明示的に off、という新しい区別です）。
>   **型としては破壊的変更ではありません**——`RecallQuery.association` の型が `| null` を受け付けるように広がっただけで、既存の呼び出しはそのまま型検査を通ります。オーナーの決定（Issue #337、[ADR 0337](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0337-recall-association-default-on.md)）によるものです。
> - **`recall()` の返り値 `RecalledMemory` に、`attributes` 欄が常に付くようになりました。** `attributes` によるフィルタを渡さない呼び出しでも、対象の Memory が `attributes` を持たなくても、欄自体は省略されなくなりました（無ければ `{}`）。絞り込みの挙動そのものは変わりません（[Issue #152](https://github.com/takecchi/mnemora/issues/152) / [Issue #153](https://github.com/takecchi/mnemora/issues/153)、PR #724）。欄の有無を見るスナップショット比較は影響を受けることがあります。
> - **抽出で作られる `Memory` に、`claimKey: null` 欄が常に付くようになりました。** claim key を導出する opt-in（`observe` の `claimKey?`）を使っていない呼び出しでも、欄自体は省略されません。値を導出する opt-in は引き続き既定 off のままです（[Issue #371](https://github.com/takecchi/mnemora/issues/371)、PR #736）。
> - **postgres を使っている方へ**: 新しいマイグレーションが3本増えています（`0019_observations_memories_attributes.sql` / `0020_taxonomy_labels.sql` / `0021_memories_claim_key.sql`）。`v1.0.0` から上げるなら、次を実行してください:
>   ```
>   pnpm --filter @mnemora/postgres run migrate
>   ```
>
> <!-- ⚠ #809 待ち: 下の一文は Issue #809 の決着で書き換わる。「破壊的変更である」と決まった場合はこの段落を「一部破壊的変更があります」に直し、対象PR(#811/#813/#815)を独立の「破壊的変更」節へ移すこと。 -->
> 🔶 **#809 の判断次第で書き換え**: **上記を含め、この節が数えた範囲に破壊的変更はありません**（下の「⚠ まだ決まっていないこと」に挙げる保留中の3件を除く）。
>
> ### 新しく足した機能（すべて opt-in・既定の挙動は変えません）
>
> - **`RecalledMemory.contestedWith?: MemoryId`** — 矛盾する2件が、同伴取得（`mandatory_companion`）を経由せず、両方とも自然に候補へ入った場合にも、相手の memoryId を返すようになりました。回答生成側が「この2件は矛盾している」と気づく経路が広がります（[Issue #691](https://github.com/takecchi/mnemora/issues/691) / [ADR 0335](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0335-recalled-memory-contested-with.md)、PR #832）。
> - **`RuntimeDeps.embeddingInput?: (memory) => string`** — 埋め込み入力が上限を超えて `embeddingStatus: 'failed'` になった Memory を、`reembed()` だけでは回復できなかった問題に、送る文字列を差し替える opt-in の回復手段を用意しました。省略時は `memory.content` をそのまま送る従来どおりの挙動です（[Issue #753](https://github.com/takecchi/mnemora/issues/753) / [ADR 0336](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0336-embedding-input-opt-in-hook.md)、PR #834）。
> - **`ClaimKeyOptions.knownSubjects?: string[]`** — 主張キー（claim key）の subject 誤帰属を減らすための語彙ヒントです。省略・空配列なら渡していないときと挙動もプロンプトも変わりません（[Issue #372](https://github.com/takecchi/mnemora/issues/372) / [ADR 0334](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0334-claim-key-known-subjects-hint.md)、PR #792）。
> - ほかにも、抽出候補ごとの `subjectId`、`recall()` の `includeSubjectless`、`timeWeighting`、taxonomy（`labels`/`taxonomyGroups`）、主張キーの衝突検出（既定 off）、`@mnemora/testkit` の `describeLLMProviderConformance` など、opt-in の新機能が足されています。すべて既定の挙動を変えません。一覧と根拠は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.1.0]` `### Added` を見てください——ここでは複製しません。
>
> ### 主な修正
>
> - **有限だが巨大な半減期（`halfLifeHours`/`halfLifeRecalls`）を設定すると、「ほぼ永久に減衰しない」つもりの記憶が「作成直後から忘却済み」と逆転して判定される不具合を直しました。** `Date` で表現できる上限・`Number.MAX_SAFE_INTEGER` を超える値を、それぞれ表現可能な上限へ丸めるようにしました。新しく例外を投げる箇所はありません（PR #845）。
> - **`@mnemora/postgres` で、2つの接続から同時に呼んだときに壊れる不具合を直しました**——`restoreSuperseded` と `forget` の並行実行、`markContested`/`resolveContested` を逆順で並行に呼んだときのデッドロックです（PR #839）。
> - **`OutboxStore.complete`/`fail` を互いに排他にしました。** 同じ `attempts` のまま `complete` → `fail` を呼ぶと、逐次でも本物の Postgres の2接続からの並行でも、両方の終端列が付く矛盾した状態を作れていました。先に付いた終端を勝たせるようにしました（[Issue #826](https://github.com/takecchi/mnemora/issues/826)、PR #830）。
> - ほかにも、段1 ANN 窓が他テナントの候補で埋め尽くされて0件を返す不具合、LLM が返す文字列 `"null"` を主題として誤って扱う不具合、自動統合が subject をまたいで記憶を混ぜる不具合、`runMigrations()` の拡張作成が同時実行で衝突する不具合、`dimensions > 2000` で HNSW 索引の作成だけが失敗してテーブルが残る不具合、負数の切り詰め処理2件、strict モードの JSON Schema 変換で省略可能な値が `null` を選べない不具合、`retry.attempts: NaN` でモデル読み込みが一度も試みられない不具合、擬似実装が重複 id をそのまま返す不具合、forget 済みの対向が recall の同伴取得に混ざる不具合を直しています。一覧と根拠は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.1.0]` `### Fixed` を見てください。
>
> ### ⚠ まだ決まっていないこと
>
> <!-- ⚠ #809 待ち: この節全体が Issue #809 の決着で書き換わる。決着後は「貼る前に確かめること」2番の指示に従って書き直すこと。 -->
> 🔶 **#809 の判断次第で書き換え**: PR #811 / #813 / #815 で、`@mnemora/testkit` の Fake（`fixtures`）が、これまで黙って受け入れていた不正な入力——負数・`NaN`・`Infinity`・非整数の `limit`、float4 の範囲外の値——に対して例外を投げるようになりました。型には現れませんが、公開の Fake を直接使っている外部の実装者には実行時に壊れる可能性があります。**これを破壊的変更として扱うかは、まだ未決です**（[Issue #809](https://github.com/takecchi/mnemora/issues/809)）。
>
> **移行手順とマイグレーションの詳細一覧は [docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) が正です。**
