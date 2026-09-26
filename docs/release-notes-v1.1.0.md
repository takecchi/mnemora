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
| **書いた日** | 初版 2026-09-26（`origin/main` = `190f365` の木）。**改版 2026-09-26**（`origin/main` = `ec39629` の木、下の「解消した」経緯を反映） |
| **書いた人** | **担い手（クローン miku の委譲先）。オーナーではない。**（冒頭のバナー） |
| **正はどれか** | ⛔ **この草稿ではない。**変更の一覧と根拠 ADR/Issue は [`CHANGELOG.md`](../CHANGELOG.md) の `## [1.1.0] - 未リリース` 節（**`v1.0.1` … `ec39629`** を数えたもの）が正、`v1.0.1` として既に出荷済みの分は [`CHANGELOG.md`](../CHANGELOG.md) の `## [1.0.1] - 2026-09-25` 節が正。既定 on の決定は [ADR 0337](./decisions/0337-recall-association-default-on.md)、`contestedWith` は [ADR 0335](./decisions/0335-recalled-memory-contested-with.md)、`embeddingInput` は [ADR 0336](./decisions/0336-embedding-input-opt-in-hook.md)、破壊的変更の定義・移行手順は [`migration-v1.md`](./migration-v1.md)、testkit の Fake の例外化を破壊的変更として扱うかは [Issue #809](https://github.com/takecchi/mnemora/issues/809) が正 |
| **腐りの判定** | **次のいずれかが起きていたら腐っている**: ① `CHANGELOG.md` の `[1.1.0]` 節が数えた sha が `ec39629` から動いた（＝新しい変更が積まれた）。② [Issue #809](https://github.com/takecchi/mnemora/issues/809) が決着した（この草稿は🔶マークの箇所を未決のまま書いている）。③ `packages/postgres/migrations/` の本数が3本（`0019`〜`0021`）から増減した。④ `v1.0.1`（tag `cf11cd6`）より新しい `v1.0.x` Release が切られた。⟹ **どれか1つでも当てはまったら、この草稿ではなく当日の一次情報を信じ、貼る前に本文を直すこと。** |

⚠ **この文書は、正典の内容を意図的に複製している。**理由は `docs/release-notes-v1.0.0.md` と同じ——**Release 本文を読むのは repo の外に居る採用者**であり、リンクだけでは伝わらない。⟹ **複製を許す代わりに、上の「正はどれか」を必ず添える。**

🔴 **⛔ この草稿に、`v1.1.0` の変更の総件数を書かないこと。** `v1.1.0` の tag はまだ切られておらず、`main` に1件着地するたびに写した数が腐る（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)。`CHANGELOG.md` `[1.1.0]` 節の前置きにも同じ規律が書いてある）。⟹ **各項目には根拠の PR/ADR/Issue へのリンクを付け、合計は数えない。**

### 🟢 解消した——`v1.0.1` の存在と `[1.1.0]` の数え直し

**初版が「🔴 未解決のまま残した重大な食い違い（v1.0.1）」として報告していた食い違いは、この改版で解消した。**

【実測 2026-09-26】経緯の再確認:

- `git tag -l "v1.*"` → `v1.0.0` と `v1.0.1` の両方が存在する。`v1.0.1` タグが指す commit は `cf11cd6`（PR #827「`supportsTaxonomyMode`/`supportsLabels`/`supportsFindActiveByClaimKey` を任意へ戻す」）。
- `v1.0.1` は 2026-09-25T21:16:41Z にオーナーが Release として作成し、npm へも公開している（6パッケージとも `dist-tags.latest` が `1.0.1`。publish の CI run は success）。
- **解消のしかた**: `CHANGELOG.md` に `## [1.0.1] - 2026-09-25` 節を新設し、`v1.0.0` から `cf11cd6` までに `[1.1.0]` 節が計上していた項目（Added 22件・Changed 6件・Fixed 12件の見出し）をそちらへ移した。`## [1.1.0]` 節はその後、`v1.0.1`（`cf11cd6`）から数え直し、**この節は `v1.0.1` からの差分を対象とする**に書き換えた。
- ⟹ **この草稿も同じ形に合わせて書き直した。**下の草稿本文のうち、`v1.0.1` として既に出荷済みになった項目（既定で `attributes` 欄が付く／`claimKey: null` が常に付く／`knownSubjects`／`describeLLMProviderConformance`／`speaker`・`subjectId`・`recordedAt`・`occurredAt`・`affinityMeasured` などの任意欄・migration 3本など）は、`v1.1.0` の変更としては書かない——**`CHANGELOG.md` の `[1.0.1]` 節を見てください、として案内する。**

---

## 貼る前に確かめること

1. **`CHANGELOG.md` の `## [1.1.0] - 未リリース` 節が数えた sha が、まだ `ec39629` か。**
   `grep -n '数えた基準を明記する' -A2 CHANGELOG.md` などで当日引き直すこと。⛔ **`ec39629` から動いていたら、この草稿の「新しく足した機能」「主な修正」の一覧が漏れを持つ**——動いた分だけ CHANGELOG の該当節を読み、この草稿へ追記すること。
   ⚠ **【実測】この文書の初版を書く過程・改版する過程で、PR が sha を動かさずに `[1.1.0]` の `### Fixed` へ追記される（または追記された後にこの担い手が sha を数え直す）ことが3度起きた**（PR #845・PR #846・PR #851。#851 はこの改版の push 直後に着地し、CHANGELOG の同じ位置へ追記されて競合したため、`ec39629` まで数え直した上で個別に取り込んだ）。⟹ **「表示されている sha が同じ」だけでは、内容が増えていないことの証明にならない**——`git diff` で `CHANGELOG.md` 自体の差分も当日見ること。
2. **[Issue #809](https://github.com/takecchi/mnemora/issues/809) が決着しているか。**`gh issue view 809 --json state,title` で当日確認する。**この issue が対象とする PR #811/#813/#815 は、`v1.0.1` として既に出荷済みである**——決着してもこの草稿（`v1.1.0`）に新しい破壊的変更節は増えない。決着の結果は `CHANGELOG.md` の `## [1.0.1]` 節へ反映すること（この文書の担当範囲外）。
   - **まだ `OPEN` なら**: 下の草稿の🔶マーク（[Issue #809](https://github.com/takecchi/mnemora/issues/809) 待ちである旨の注記）はそのままでよい。
   - **決着したら**: `docs/migration-v1.md`・`CHANGELOG.md` `[1.0.1]` 節が更新されているはずなので、そちらの表現に合わせて下の注記の文言だけ直すこと（この草稿に破壊的変更節を新設する必要はない——対象 PR は `v1.1.0` の範囲に無い）。
3. **マイグレーションの本数が `packages/postgres/migrations/` と一致しているか。**`ls packages/postgres/migrations/ | tail -5` で当日 `0019`/`0020`/`0021` が最後尾か確認する。**4本目が増えていたら**、下の「postgres を使っている方へ」の案内を更新すること（新しい migration が `v1.0.1` より後＝`v1.1.0` の範囲に入ったことになる）。
4. **`v1.0.1` より新しい `v1.0.x` Release が切られていないか。**`git tag -l "v1.*"`・`gh release list --limit 5`・`npm view @mnemora/core dist-tags` を当日その場で引き直すこと。**新しい `v1.0.x` があれば、`CHANGELOG.md` にも対応する節が足されているはずである。**無ければこの草稿の前提が再び壊れているので、貼る前に本文を書き直すこと。
5. **本文中のリンク（PR/Issue/ADR）が実在し、番号を間違えていないか。**貼る前にもう一度 `gh pr view <n>` で軽く見直すこと。

---

## 草稿（ここから下を貼る）

> ## mnemora v1.1.0
>
> **⚠ 本文は草稿です。この Release を実際に作るのはオーナーです。**
>
> mnemora は、LLM アプリケーションに「思い出す」を与えようとしています。「保存する」ではなく。この節は **`v1.0.1`** からの差分です。変更の一覧とそれぞれの根拠 ADR/Issue は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.1.0]` 節が正です。
>
> **`v1.0.0` から直接この版へ上げる方へ**: この節より前に `v1.0.1` があります。`attributes`・`claimKey`・`knownSubjects`・`describeLLMProviderConformance` などの変更と、postgres のマイグレーション3本（`0019`〜`0021`）は `v1.0.1` の内容です。[CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.0.1]` 節も合わせて読んでください。
>
> ### 🔴 まず — 既定の挙動が変わるものがあります
>
> - **連想枠（`RecallQuery.association`、段3.5）の既定が off → on になりました。** `recall()` を呼ぶときに `association` を省略すると、これまでは連想が一切走りませんでしたが、`v1.1.0` からは新設の `DEFAULT_RECALL_ASSOCIATION`（`{ maxCount: 10 }`）で連想が走ります——クエリに直接は当たらなかったが、当たった記憶（アンカー）の近傍として引いた候補（`retrievedVia: "association"`）が、`association` を渡さない呼び出しでも結果に混ざりうるようになります。
>   **従来どおり連想を一切走らせたくない場合は、`association: null` を明示的に渡してください**（`undefined`＝省略＝既定を適用、`null`＝明示的に off、という新しい区別です）。
>   **型としては破壊的変更ではありません**——`RecallQuery.association` の型が `| null` を受け付けるように広がっただけで、既存の呼び出しはそのまま型検査を通ります。（Issue #337 / [ADR 0337](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0337-recall-association-default-on.md)、PR #838）
> - **postgres を使っている方へ**: `v1.0.1` からマイグレーションは増えていません。`v1.0.1` を既に使っているなら、`v1.1.0` への migrate 手順はありません。`v1.0.0` から直接上げる場合は、上の案内のとおり `v1.0.1` の migrate（`0019`〜`0021`）が必要です。
>
> <!-- ⚠ #809 待ち: 下の一文は Issue #809 の決着で書き換わる可能性があるが、対象の PR(#811/#813/#815) 自体は v1.0.1 で既に出荷済みなので、決着してもこの節（v1.1.0）に新しい破壊的変更節は増えない。文言だけ CHANGELOG [1.0.1] の記述に合わせて直すこと。 -->
> 🔶 **この節（`v1.0.1` からの差分）が数えた範囲に破壊的変更はありません。** ただし `v1.0.1` として既に出荷済みの3件（PR #811/#813/#815、testkit の Fake の入力検査）を破壊的変更として扱うかは、まだ未決です（[Issue #809](https://github.com/takecchi/mnemora/issues/809)）——詳細は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.0.1]` 節を見てください。
>
> ### 新しく足した機能（すべて opt-in・既定の挙動は変えません）
>
> - **`RecalledMemory.contestedWith?: MemoryId`** — 矛盾する2件が、同伴取得（`mandatory_companion`）を経由せず、両方とも自然に候補へ入った場合にも、相手の memoryId を返すようになりました。回答生成側が「この2件は矛盾している」と気づく経路が広がります（[Issue #691](https://github.com/takecchi/mnemora/issues/691) / [ADR 0335](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0335-recalled-memory-contested-with.md)、PR #832）。
> - **`RuntimeDeps.embeddingInput?: (memory) => string`** — 埋め込み入力が上限を超えて `embeddingStatus: 'failed'` になった Memory を、`reembed()` だけでは回復できなかった問題に、送る文字列を差し替える opt-in の回復手段を用意しました。省略時は `memory.content` をそのまま送る従来どおりの挙動です（[Issue #753](https://github.com/takecchi/mnemora/issues/753) / [ADR 0336](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0336-embedding-input-opt-in-hook.md)、PR #834）。
> - 一覧と根拠は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.1.0]` `### Added` を見てください——ここでは複製しません。**`attributes`・`claimKey`・`knownSubjects` など、すでに `v1.0.1` として出荷済みの opt-in 機能は、この節ではなく [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.0.1]` `### Added` を見てください。**
>
> ### 主な修正
>
> - **有限だが巨大な半減期（`halfLifeHours`/`halfLifeRecalls`）を設定すると、「ほぼ永久に減衰しない」つもりの記憶が「作成直後から忘却済み」と逆転して判定される不具合を直しました。** `Date` で表現できる上限・`Number.MAX_SAFE_INTEGER` を超える値を、それぞれ表現可能な上限へ丸めるようにしました。新しく例外を投げる箇所はありません（PR #845）。
> - **`deriveClaimKeys` が、LLM が空白だけの `subject`/`predicate` を返したときに空文字列の claim key を作り、無関係な記憶どうしを誤って `contested` にしていた不具合を直しました。** 正規化後に空文字列になった要素は、鍵が取れなかったもの（`null`）として扱うようにしました（PR #846）。
> - **`@mnemora/postgres` で、2つの接続から同時に呼んだときに壊れる不具合を直しました**——`restoreSuperseded` と `forget` の並行実行、`markContested`/`resolveContested` を逆順で並行に呼んだときのデッドロックです（PR #839）。
> - **`OutboxStore.complete`/`fail` を互いに排他にしました。** 同じ `attempts` のまま `complete` → `fail` を呼ぶと、逐次でも本物の Postgres の2接続からの並行でも、両方の終端列が付く矛盾した状態を作れていました。先に付いた終端を勝たせるようにしました（[Issue #826](https://github.com/takecchi/mnemora/issues/826)、PR #830）。
> - **自動経路の `reflect` ジョブ（`processReflectJob`）が、`consolidate` 側と同じ不具合（subject をまたいで反映し、結果の `subjectId` が `null` に畳まれる）を持ったまま直っていませんでした。** `consolidate` 側と同じ形で、種の Memory の `subjectId` を `ctx.subjectId` に置いてから `reflect()` を呼ぶよう直しました（[Issue #820](https://github.com/takecchi/mnemora/issues/820) / [ADR 0317](https://github.com/takecchi/mnemora/blob/main/docs/decisions/0317-auto-consolidate-scopes-neighbor-search-to-seed-subject.md) 追記、PR #851）。
> - 一覧と根拠は [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.1.0]` `### Fixed` を見てください。**段1 ANN 窓の全滅・`"null"` 文字列の誤扱い・自動統合の subject 跨ぎ・`runMigrations()` の同時実行衝突・`dimensions > 2000` の HNSW 失敗・負数の切り詰め処理2件・strict モード JSON Schema の `null` 不具合・`retry.attempts: NaN`・擬似実装の重複 id・forget 済み対向の混入など、すでに `v1.0.1` として出荷済みの修正は、この節ではなく [CHANGELOG.md](https://github.com/takecchi/mnemora/blob/main/CHANGELOG.md) の `[1.0.1]` `### Fixed` を見てください。**
>
> **移行手順とマイグレーションの詳細一覧は [docs/migration-v1.md](https://github.com/takecchi/mnemora/blob/main/docs/migration-v1.md) が正です。**
