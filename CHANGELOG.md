# Changelog

このファイルは [Keep a Changelog](https://keepachangelog.com/) の形式に倣う。
**手で書く**（tag や commit ログからの自動生成ではない）。理由と、版の権威が
Release の tag にあるという既存の決定（[ADR 0070](./docs/decisions/0070-version-comes-from-the-release-tag.md)）
との関係は [ADR 0169](./docs/decisions/0169-changelog-hand-curated.md) を見ること。

## 過去のバージョンについて

**v0.1.0 〜 v0.1.9 の変更は、このファイルには書き起こしていない。**
[GitHub Releases](https://github.com/takecchi/mnemora/releases) の各 tag を参照すること
（理由: [ADR 0169](./docs/decisions/0169-changelog-hand-curated.md) 決定4）。

⚠ **このファイルの初版と ADR 0169 決定4 は「v1.0.0 以降を対象とする」と書いていた。**
そう書いた時点では、次に出る Release が `v1.0.0` になる見込みだった。**実際に出たのは
2026-09-16 の `v0.2.0` である**（tag が指すのは `c52be47`）。⟹ **このファイルが実際に
対象としているのは `0.2.0` 以降である。**書き起こさない範囲（v0.1.0 〜 v0.1.9）は
決定4 のまま変えていない。⛔ **ADR 0169 の本文は当時の記録なので書き換えていない**
（`AGENTS.md`）。

## 何を載せるか

**利用者に見える変更だけを載せる。** docs のみの PR・内部スクリプトの修正・ADR 索引の
再生成・テスト追加のみの PR は載せない——GitHub が自動生成する Release notes（全 PR を
無差別に列挙する）との意図的な違いである。各項目は1〜2行の要約と ADR/Issue へのリンクに
留め、詳細は複製しない（`AGENTS.md` の反重複規律）。

⭐ **`[0.3.0]` 以降は、publish 対象のパッケージの変更だけを載せる。**出所は
`scripts/publish-targets.mjs` の `PUBLISH_TARGETS` である（⛔ **本数も名前もここに写さない**
——`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。⟹ **`examples/chat` は `private` であり、
出荷される面の外なので載せない。**

⚠ **これは途中で変わった形である。**【現物】`[0.2.0]` 節は `### Added` に `examples/chat` の
項目を2つ持っている（`memory_usage` 報告の実践 / 想起経路が連想枠を既定で使うようになった）。
⛔ **その2項目は書き換えていない**——当時の記録である（`AGENTS.md`）。
⟹ ⭐ **`[0.3.0]` 以降で `examples/chat` の変更が載っていないのは、書き漏れではなく方針である。**
理由・採らなかった案・引き受けた負債は
[ADR 0243](./docs/decisions/0243-changelog-lists-publish-targets-only.md)。

---

## [1.0.0] - 2026-09-23

⚠ **この節は、`v1.0.0` の Release を作る *前* に起こしてある**——[docs/release-v1.md](./docs/release-v1.md) §0.10 が
「**節は Release を作る前に起こす。後からしか分からない事実（`published` の時刻・Release へのリンク・
自動生成本文の行数）は後から埋めてよい——門が見るのは節の存在だけである**」と定めているのに従った
（[ADR 0252](./docs/decisions/0252-release-changelog-section-is-a-publish-gate.md)）。

🔴 **【現物 2026-09-23】この見出しを起こした時点で、tag `v1.0.0` も Release `v1.0.0` も存在しない**
（`git ls-remote --tags origin v1.0.0` は空、`gh release view v1.0.0` は `release not found`）。
⟹ **Release へのリンク・tag が指す sha・`published` の時刻は、現物が無いので埋めていない**
——⛔ **無いものを在るかのように書かない。**Release が公開された後、その時点の現物で埋めること。

⚠ **見出しの日付は、この節を起こした日（JST）である。**⟹ **Release を出す日がこれとずれたら、その日へ直すこと**
——⛔ **門は日付の妥当性を見ない。**合わせるのは人の側である。

**この節は `v0.5.0` からの差分を対象とする。**⭐ **`v0.4.0` → `v0.5.0` の分は、下の `[0.5.0]` 節に在る**
——⛔ **この節へ混ぜない。**⟹ **この節に並ぶものは、1件も出荷されていない。**

⭐ **数えた基準を明記する。**この節は `v0.5.0` … **`509f4e7`** の範囲を数えたものである。
⭐ **この sha が名乗るのは「この節がどこまで数えたか」であって、「ここで打ち切った」ではない。**
⟹ ⭕ **`origin/main` がこれより進んでいても、この節は腐っていない**——**まだ数えていない範囲が
増えただけである。**読む人は `git log --oneline 509f4e7..origin/main` で、その増分を自分で見られる。
🔴 **この性質が成り立つのは、この節が件数を持たないからである。**
⛔ **ここに件数を書かないこと**——書いた瞬間、次の1件が着地した時点で腐る
（[#433](https://github.com/takecchi/mnemora/issues/433) /
[ADR 0234](./docs/decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。
**数えるなら、下の項目そのものを数えること。**
⚠ **この pin は `scripts/release-candidates.mjs` の入力でもある**
（[ADR 0214](./docs/decisions/0214-release-candidates-lists-not-judges.md) 決定5。⛔ 道具は書き換えない）。

### 🔴 この pin を置いた時点で、`v0.5.0` と `origin/main` は同じ commit だった

**【実測 2026-09-21】**pin を置いた時点では `git rev-parse origin/main v0.5.0^{commit}` が
2行とも `509f4e739ca1ad017876a5b661062d23c2ead773` を返し、
`git rev-list --count v0.5.0..origin/main` は **0** だった。
⟹ **この節が空なのは、まだ数えていないからではなく、数える範囲そのものが空だったからである。**

🔴 **⛔ ただし、その2つのコマンドを「この節が今も空か」の検査に使わないこと。**
**どちらも docs だけの commit で動く**——**実際、この節を書いた commit 自身が `main` を1本進めた。**
⟹ ⭐ **「利用者に届く変更が在るか」を見たいなら、出荷される面を直接当てること:**

```
$ git diff --stat v0.5.0..origin/main -- packages/                      → （差分なし）
$ git diff --stat v0.5.0..origin/main -- scripts/__snapshots__/public-api/  → （差分なし）
```

⚠ **この2本も「利用者に見える変更が無い」の証明ではない**——**publish 対象の外の `scripts/` や
`examples/` は当たらないし、`packages/` の差分がテストだけのこともある。**
⟹ ⭐ **下の「数え直すこと」に従って、その場で一覧を出すこと。**
⛔ **これは「`v1.0.0` には何も載らない」という予告ではない**——**`main` が動けば増える。**
⟹ `v1.0.0` を切る側は、**切る直前にこの pin から数え直すこと**
（道具は `node scripts/release-candidates.mjs --since v0.5.0`。
⚠ **`--since` を省くと最新リリースの tag が入るので、この pin と一致するとは限らない**）。

⚠ **⟹ いまこの瞬間に `v1.0.0` を切ると、`v0.5.0` の利用者に届く変更は1件も無い。**
**その場合 `v1.0.0` が節目なのは、コードが変わったからではない。**理由は
[docs/roadmap.md](./docs/roadmap.md) の §7 と
[docs/release-notes-v1.0.0.md](./docs/release-notes-v1.0.0.md) に在る。

⭐ **「`v1.0.0` へ上げるときに何が壊れるか」の正本は
[docs/migration-v1.md](./docs/migration-v1.md) である**——**あちらは世代ごとに分けてある。**
🔴 **`v0.4.0` からの利用者が受ける破壊的変更は、この節ではなく下の `[0.5.0]` 節に在る**
——**`v0.5.0` で出荷済みだからである。**

⚠ **`v1.0.0` をいつ切るかは、この節を書いた時点で決まっていない。**7項目の現在地は
[docs/roadmap.md](./docs/roadmap.md) の **§7 の末尾の節**に在る
（⛔ **節番号を固定で信じないこと**——同文書は前の節を書き換えず、後から決まったことを
新しい節として積む。⟹ `grep -nE '^### 7\.[0-9]+ ' docs/roadmap.md` の末尾を見ること）。
**Release 本文の草稿は [docs/release-notes-v1.0.0.md](./docs/release-notes-v1.0.0.md) に在る。**
⛔ **どちらも件数をここへ写さない**——正は各文書である。

---

## [0.5.0] - 2026-09-21

**Release**: [v0.5.0](https://github.com/takecchi/mnemora/releases/tag/v0.5.0)（pre-release ではない）。
**tag が指すのは `509f4e7`**、**前の版は `v0.4.0`**（`3cf2663`）。⟹ **この節は
`v0.4.0` → `v0.5.0` の差分である**（【実測】`git rev-list --count v0.4.0..v0.5.0` = 8）。
⚠ **published は `2026-09-20T15:25:56Z`（UTC）である**——**見出しの日付は JST**（この repo の
commit の日付と同じ `+0900`）。🔴 **この版は UTC と JST で日付が1日ずれる**
——UTC では 9/20、JST では 9/21（00:25）である。⚠ **tag が指す commit 自体の日付は
`2026-09-19 13:42 +0900` で、さらに前である**——**commit の日と出荷の日は別物である。**

⚠ **GitHub の Release `v0.5.0` の本文は自動生成であり、8 commit を無差別に1行ずつ
並べたものである**【実測】（`gh release view v0.5.0 --json body -q .body | grep -c '^\* '` = 8）。
⟹ ⭐ **分類も、docs のみ・テストのみの除外も、この節が初めて与える。**

🔴 **この節も、出荷に遅れて起こしたものである。これで3回目である。**
`v0.5.0` が published された時点では、`[1.0.0]`（未リリース）の節が逐語で
「**この節に並ぶものは、1件も出荷されていない**」と名乗り、pin を `v0.4.0 … 420e0f4` に置いていた
——**どちらも、その時点で既に偽だった。**
⚠ **同じ形は `v0.3.0`（[Issue #536](https://github.com/takecchi/mnemora/issues/536)）と
`v0.4.0`（[ADR 0248](./docs/decisions/0248-changelog-and-migration-guide-follow-the-release.md)）でも起きている。**
⭐ **ただし今回は、リリース直後に機械が名指しで知らせていた**——
[ADR 0251](./docs/decisions/0251-release-follow-up-notice-not-a-gate.md) の
「Release follow-up notice」が `v0.5.0` の tag で走り、逐語で
「**🔴 CHANGELOG.md に `## [0.5.0]` の節が無い。**」と出力して終わっている（⛔ **門ではないので、何も止めていない**）。
🔴 **⟹ 3回目は「気づけなかった」ではなく「知らされたが、追随が遅れた」である。**

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更は `@mnemora/local-embedding` の1本だけに在る**
（`@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` / `@mnemora/openai` /
`@mnemora/anthropic` に破壊的変更は無い）。

**postgres 利用者へ**: ⭕ **新しいマイグレーションは無い。**
【実測】`git diff --stat v0.4.0..v0.5.0 -- packages/postgres/migrations/` は**差分を返さない**。
⟹ **`v0.4.0` から `v0.5.0` へ上げるのに `migrate` は要らない**
（⚠ **`v0.3.0` 以前から上げるなら要る**——`0018` が `v0.4.0` に在る。
[docs/migration-v1.md](./docs/migration-v1.md) を見ること）。

### ⭐ この節が数えた範囲の全体（⛔ 見落としが無いことを、後から検算できる形で残す）

**【実測 2026-09-21】出荷される面のソースを触ったのは、次の2ファイルだけである。**

```
$ git diff --name-only v0.4.0..v0.5.0 \
    | grep -E '^(packages|examples|scripts)/' \
    | grep -vE '__tests__|\.test\.ts|__fixtures__'
packages/core/src/recall-runtime.ts
packages/local-embedding/README.md
packages/local-embedding/src/local-embedding-provider.ts
scripts/check-release-changelog-section.mjs
scripts/release-changelog-section-lib.mjs

$ git diff --stat v0.4.0..v0.5.0 -- scripts/__snapshots__/public-api/   → （差分なし）
$ git diff --stat v0.4.0..v0.5.0 -- packages/postgres/migrations/       → （差分なし）
```

⟹ **`scripts/` の2本は publish 対象の外**（出所は `scripts/publish-targets.mjs` の
`PUBLISH_TARGETS`。⛔ **本数も名前もここに写さない**——`AGENTS.md`）、
**`README.md` は挙動ではない** ⟹ ⭐ **残る2ファイルが、下に載せた2件に1対1で対応する。**
🔴 **そして公開 API の型スナップショットは1バイトも動いていない**
⟹ ⭐ **「型が変わったのに載っていない」形の見落としは、この世代には無い。**
⛔ **これは「利用者に見える変更が2件しか在りえない」の証明ではない**——
**型に現れない挙動の変更は、この2つのコマンドでは捕まらない。**上の一覧を人が読んで分類した。

### Breaking

⭐ **1件である。**⭕ **`v0.4.0` と `v0.5.0` の両端が tag で閉じているので、`main` が動いてもこの数は変わらない。**
⚠ **正本は [docs/migration-v1.md](./docs/migration-v1.md) の番号付き一覧の 18 であり、
下の表はその写しである**——**`#` 欄はあちらの通し番号で、この表の中での連番ではない。**

🔴 **この世代は、`[0.4.0]` までと壊れ方の種類が違う**——**型ではなく実行時に壊れる。**
【実測 2026-09-21】`git diff --stat v0.4.0..v0.5.0 -- scripts/__snapshots__/public-api/` は
**差分を返さない** ⟹ ⭕ **公開 API の型は1バイトも動いていない。**
⚠ それでも破壊的として数えるのは、移行ガイドの定義が逐語で
「**既存の利用者のコードが型検査 *または実行時* に壊れる変更**」だからである。

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 18 | `LocalEmbeddingProvider` のコンストラクタが、**既定と異なる `repo` を `modelId` 無しで渡された宣言**を `throw` で落とすようになった（`@mnemora/local-embedding`） | 🔴 **`repo` を既定以外にし、かつ `modelId` を渡していなかった人だけ。**⭕ `repo` を渡していないなら影響なし。⚠ **該当していた人は元から壊れていた側である**——`repo` は `space.model` に反映されず、別モデルのベクトルが同じ space へ静かに混ざっていた | [ADR 0247](./docs/decisions/0247-local-embedding-repo-model-id-declaration-guard.md) / [#142](https://github.com/takecchi/mnemora/issues/142)（PR #550） |

⚠ **移行手順は複製しない**——直し方は [docs/migration-v1.md](./docs/migration-v1.md) の項目 **18** を見ること。
⛔ **これを「#142 が解決した」と読まないこと**——#142 は2件を名指ししており、
**「実 API に一度も当てていない」ほうは手つかずで残っている**（同 Issue はいまも OPEN）。

### Changed（後方互換だが挙動が変わりうるもの）

- **連想枠（段3.5）の席が、減衰を含む順位で埋まるようになった**（`@mnemora/core`）。
  順位キーは `hit.similarity * score.total`（＝ `anchorSimilarity × decay × tagMatch × freshness × strength`）で、
  `maxCount` を超える候補が在るときに**席に座る記憶が変わる**
  （[ADR 0246](./docs/decisions/0246-association-rank-includes-decay.md) /
  [#402](https://github.com/takecchi/mnemora/issues/402)、PR #549）。

  ⚠ **以下は [ADR 0246](./docs/decisions/0246-association-rank-includes-decay.md)「誰が壊れうるか」からの逐語である**
  ——**この節の書き手はこの変更を作っておらず、自分で測り直してもいない**【受】:

  > **`RecallQuery.association` を渡している呼び手の、返る記憶の顔ぶれが変わりうる。**
  > … **型は1バイトも変わらない。**新しい欄も新しいつまみも無い ⟹ **破壊的変更ではない。**
  > … **既定 off なので、`association` を渡していない呼び手は1バイトも影響を受けない。**

  🔴 **この変更は、正典項目4 の判定にも効いている**——経緯は
  [docs/roadmap.md](./docs/roadmap.md) §7.17 と §7.18 に在る。

---

## [0.4.0] - 2026-09-19

**Release**: [v0.4.0](https://github.com/takecchi/mnemora/releases/tag/v0.4.0)（pre-release ではない）。
**tag が指すのは `3cf2663`**、**前の版は `v0.3.0`**（`6851629`）。⟹ **この節は
`v0.3.0` → `v0.4.0` の差分である**（【実測】`git rev-list --count v0.3.0..v0.4.0` = 27）。
⚠ **published は `2026-09-18T20:36:04Z`（UTC）である**——**見出しの日付は JST**（この repo の
commit の日付と同じ `+0900`）。⟹ **UTC で読むと1日ずれる。**

⚠ **GitHub の Release `v0.4.0` の本文は自動生成であり、27 commit を無差別に1行ずつ
並べたものである**【実測】（`gh release view v0.4.0 --json body -q .body | grep -c '^\* '` = 27）。
⟹ ⭐ **分類も、docs のみ・テストのみの除外も、この節が初めて与える。**

🔴 **この節は、出荷に遅れて起こしたものである。**`v0.4.0` が published された時点では、
中身は `[1.0.0]`（未リリース）の節に置かれたままで、同節は逐語で「**この節に並ぶものは、
1件も出荷されていない**」と名乗っていた。⚠ **同じ形の遅れは `v0.3.0` でも起きている**
（[Issue #536](https://github.com/takecchi/mnemora/issues/536) /
[ADR 0243](./docs/decisions/0243-changelog-lists-publish-targets-only.md)）⟹ **2回目である。**
経緯と、3回目を防ぐ手の検討は
[ADR 0248](./docs/decisions/0248-changelog-and-migration-guide-follow-the-release.md)。

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更は `@mnemora/core` / `@mnemora/testkit` の2本に在る**
（`@mnemora/postgres` / `@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding` に
破壊的変更は無い）。

**postgres 利用者へ**: 新しいマイグレーション（`0018`）が増えている。
⟹ **`v0.3.0` から上げるなら `pnpm --filter @mnemora/postgres run migrate` が要る。**
🔴 **「新機能を使うときだけ要る」ものではない**——理由と適用手順は
[docs/migration-v1.md](./docs/migration-v1.md) を見ること。このファイルには複製しない。

### Breaking

⭐ **6件である。**⭕ **`v0.3.0` と `v0.4.0` の両端が tag で閉じているので、`main` が動いてもこの数は変わらない。**
⚠ **正本は [docs/migration-v1.md](./docs/migration-v1.md) の番号付き一覧の 12〜17 であり、
下の表はその写しである**——**`#` 欄はあちらの通し番号で、この表の中での連番ではない。**

⚠ **壊れ方は2つの形に分かれる。**

**1つ目は「`interface` に必須メンバが増えた」形**（項目 **12**〜**16**）。
⟹ ⭕ **`createRuntime()` が返すものを使っているだけなら、何もしなくてよい。**
壊れるのは、**自分で `Runtime` を実装している側**と、**`@mnemora/testkit` の適合テストを
呼んでいる側**だけである。⚠ これは新しい判定基準ではない——`[0.2.0]` の Breaking 表
**1**・**5**・**6** が同じ理由で破壊的と数えられている。

🔴 **2つ目は「union に値が増えた」形**（項目 **17**）。⟹ **壊れるのは実装する側ではなく、消費する側である。**
⭕ **値を読むだけ・比較するだけなら非破壊**——`never` で網羅性を検査しているコードだけが壊れる。
⚠ これも新しい判定基準ではない——`[0.2.0]` の Breaking 表 **4** が同じ形で数えられている。

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 12 | `Runtime` に必須メソッド `restoreSuperseded` が増えた（`@mnemora/core`） | `Runtime` を自分で実装している側だけ。`createRuntime()` が返すものを使っているなら影響なし | [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md) / [#369](https://github.com/takecchi/mnemora/issues/369)（PR #464）。⚠ **ADR 0230 の本文だけを読むと、これが破壊的であることに気づけない**——2026-09-18 に冒頭への追記で名指しされた |
| 13 | `MemoryStoreConformanceOptions.supportsRestoreSupersededBy` が必須フィールドになった（`@mnemora/testkit`）。**12 と同じ PR #464 で入っている** | `describeMemoryStoreConformance` を呼んでいる側だけ | [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md)（PR #464）。🔴 **この項目は 2026-09-18 まで、CHANGELOG にも ADR にも一度も書かれていなかった** |
| 14 | `Runtime` に必須メソッド `findCorrectionCandidates` が増えた（`@mnemora/core`） | **12 と同じ** | [ADR 0232](./docs/decisions/0232-correction-candidates-returned-not-chosen.md) / [#369](https://github.com/takecchi/mnemora/issues/369)（PR #517） |
| 15 | `MemoryStoreConformanceOptions.supportsPreviewRestoreSupersededBy` が必須フィールドになった（`@mnemora/testkit`） | **13 と同じ** | [ADR 0237](./docs/decisions/0237-restore-superseded-dry-run-preview.md) / [#515](https://github.com/takecchi/mnemora/issues/515)（PR #524） |
| 16 | `Runtime` に必須メソッド `applyCorrection` が増えた（`@mnemora/core`）。`findCorrectionCandidates` が返した候補の中から**人が選んだ1件**を受け取り、`markContested` → `resolveContested` の書き込みまでを1つの口にまとめる | **12 と同じ** | [ADR 0242](./docs/decisions/0242-runtime-apply-correction.md) / [#369](https://github.com/takecchi/mnemora/issues/369)（PR #537） |
| 17 | 🔴 `MemoryEventKind` の union に `"unsuperseded"` が増えた（`@mnemora/core`）。**12・13 と同じ PR #464 で入っている** | ⚠ **届く経路は `EventStore` である**——`MemoryEvent.kind` は必須フィールドで、`EventStore.append`/`.get`/`.list` が返す。⟹ ⭕ **`Runtime` の口からは届かない**ので、**5つの動詞だけを使う利用者には影響しない。**⚠ **同じ形に対する扱いがこの repo に2つ在り、線は引かれていない**——[#541](https://github.com/takecchi/mnemora/issues/541) を見ること | [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md)（PR #464） |

⚠ **移行手順は複製しない**——直し方は
[docs/migration-v1.md](./docs/migration-v1.md) の同じ番号の項目を見ること。

### Added

- **`Runtime.restoreSuperseded`**（および `MemoryStore.restoreSupersededBy` — **任意**メソッド）。
  `superseded` になった Memory を `active` へ戻す**復旧口**。粒度は群単位で、
  `target: { supersededById }`（置き換えた側の id）で指定する
  （[#369](https://github.com/takecchi/mnemora/issues/369) /
  [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md)、PR #464）。
  ⚠ **これは北極星 項目5（間違いを正すと、古いほうが先に出てこなくなる）を満たすものではない**——
  訂正の口そのものは入っていない
- **`restoreSuperseded` の dry-run**（および `MemoryStore.previewRestoreSupersededBy` — **任意**メソッド）。
  **戻す前に、何が戻るかを返す**（[#515](https://github.com/takecchi/mnemora/issues/515) /
  [ADR 0237](./docs/decisions/0237-restore-superseded-dry-run-preview.md)、PR #524）
- **`Runtime.findCorrectionCandidates`** — 訂正の相手の**候補を返す**口。
  ⛔ **mnemora は選ばない。書き込みを1件もせず、LLM を1回も呼ばない**
  （[ADR 0232](./docs/decisions/0232-correction-candidates-returned-not-chosen.md)、PR #517）
- **`Runtime.applyCorrection`** — 訂正の**選択**の段を、出荷される面へ持ち上げた口。
  ⭐ **選ぶのは人である**——候補を返す `findCorrectionCandidates` と、書き込む
  `markContested`/`resolveContested` のあいだを繋ぐ
  （[ADR 0242](./docs/decisions/0242-runtime-apply-correction.md)、PR #537）
- **`CassetteRecorder.lookupLLM` / `lookupEmbedding`**（`@mnemora/testkit`）— 記録した
  カセットを照会する口。⭕ **追加のみで後方互換**
  （[ADR 0233](./docs/decisions/0233-answer-quality-measured-once-against-the-real-api.md)、PR #514）

---

## [0.3.0] - 2026-09-17

**Release**: [v0.3.0](https://github.com/takecchi/mnemora/releases/tag/v0.3.0)（pre-release ではない）。
**tag が指すのは `6851629`**、**前の版は `v0.2.0`**（`c52be47`）。⟹ **この節は
`v0.2.0` → `v0.3.0` の差分である**（【実測】`git rev-list --count v0.2.0..v0.3.0` = 101）。

⚠ **GitHub の Release `v0.3.0` の本文は自動生成であり、101 commit を無差別に1行ずつ
並べたものである**【実測】（`gh release view v0.3.0 --json body -q .body | grep -c '^\* '` = 101）。
⟹ ⭐ **分類も、docs のみ・テストのみの除外も、この節が初めて与える。**

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更は `@mnemora/core` / `@mnemora/testkit` / `@mnemora/local-embedding` の3本に在る**
（`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/postgres` に破壊的変更は無い）。
🔴 **⚠ `@mnemora/local-embedding` を落とさないこと**——この repo は 2026-09-18 まで
「`@mnemora/local-embedding` に破壊的変更は無い」と書いており、**それは誤りだった**
（[Issue #532](https://github.com/takecchi/mnemora/issues/532)）。

**postgres 利用者へ**: 新しいマイグレーション（`0016`/`0017`）が増えている。
⟹ **`v0.2.0` から上げるなら `pnpm --filter @mnemora/postgres run migrate` が要る。**
適用手順・破壊的変更ごとの対応方法は [docs/migration-v1.md](./docs/migration-v1.md) を見ること
——このファイルには詳細を複製しない。

### Breaking

⭐ **4件である。**⭕ **`v0.2.0` と `v0.3.0` の両端が tag で閉じているので、`main` が動いてもこの数は変わらない。**
⚠ **正本は [docs/migration-v1.md](./docs/migration-v1.md) の番号付き一覧の 8〜11 であり、
下の表はその写しである**——**`#` 欄はあちらの通し番号で、この表の中での連番ではない。**

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 8 | `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls`（`@mnemora/testkit`）の署名が `(tenantId: string, recalls: number): void` → `(ctx: Ctx, recalls: number): Promise<void>` へ変わった。ADR 0197 が `TenantSettingsStore` に同名の**本番**メソッドを足して名前が衝突したため、テスト専用フックのほうを消した | 🔴 **旧署名で呼んでいた側。⛔ 引数を直すだけでは足りない**——同期から `Promise` へ変わったので `await` が要る。構築して渡すだけなら影響なし | [ADR 0197](./docs/decisions/0197-set-default-half-life-recalls.md)（PR #416） |
| 9 | `FilteredOmission` に必須フィールド `scopeRelation` が増えた（`@mnemora/core`）。`decayed` だけが `totalInScope` の**内側**を数えるという非対称を、契約として明示するもの | **返り値の型なので、読むだけの利用者には非破壊。** `FilteredOmission` を自分で組み立てている側（独自 adapter の `aggregateScope` 実装・テストダブル）だけ | [ADR 0174](./docs/decisions/0174-filtered-omission-scope-relation.md) / [#352](https://github.com/takecchi/mnemora/issues/352)（PR #376） |
| 10 | `Omission` の `over_limit` に必須フィールド `stage` が増えた（`@mnemora/core`）。連想枠（段3.5）の `maxCount` 切り捨てを段1 の打ち切りと区別して名乗るため | **9 と同じ形**——`omission.count` を読むだけなら非破壊。`OverLimitOmission` を自分で組み立てている側だけ | [ADR 0188](./docs/decisions/0188-association-over-limit-omission.md) / [#375](https://github.com/takecchi/mnemora/issues/375)（PR #391） |
| 11 | 🔴 `LocalEmbeddingPipeline`（`@mnemora/local-embedding`）が呼び出し可能な関数型から、`countTokens` / `embed` / `maxInputTokens` を要求する必須 `interface` になった | 🔴 **呼んでいる側と、自前で渡していた側の両方**——この4件で唯一「呼ぶだけの側も壊れる」形である。⛔ **渡すものの形そのものが変わっている** | [ADR 0205](./docs/decisions/0205-local-embedding-pipeline-required-interface.md) / [#137](https://github.com/takecchi/mnemora/issues/137)（PR #446） |

⚠ **`@mnemora/core` だけを見て数えると、8 と 11 が落ちる**——`@mnemora/testkit` と
`@mnemora/local-embedding` も publish 対象である。
⚠ **移行手順は複製しない**——直し方は [docs/migration-v1.md](./docs/migration-v1.md) の
同じ番号の項目を見ること。

### Changed（後方互換だが挙動が変わりうる）

- **`ann_unreached` が「窓が満杯のときにも」鳴るようになった。**従来は
  `annHits.length < kPrime` のときだけ鳴っていたため、**近似索引が取りこぼしたのに窓は満杯**
  という場合に沈黙していた（[ADR 0193](./docs/decisions/0193-ann-unreached-covers-full-window.md)、PR #399）。
  ⟹ 北極星「知らないことを、知らないと言える」の穴を1つ塞いだ
- **`sweepArchive` が `opts.clock` 省略時に `tenant_settings.decay_clock` へ従うようになった。**
  従来は掃引だけが常に壁時計で動いていたため、`decay_clock = activity`/`either` を選んだ
  テナントで「想起では生きている記憶が archive される」ことがあった
  （[#364](https://github.com/takecchi/mnemora/issues/364) /
  [ADR 0186](./docs/decisions/0186-sweep-archive-follows-decay-clock.md)、PR #379）
- **語彙チャンネルの `search()` に決定的な最終キーが入った。**同点の候補の順序が
  呼び出しごとに変わりうる状態を解消（[#345](https://github.com/takecchi/mnemora/issues/345) /
  [ADR 0175](./docs/decisions/0175-lexical-search-tiebreak-nondeterminism.md)、PR #390）
- **`PostgresVectorStore.upsert` が、閾値を越えたときだけ埋め込み表を `ANALYZE` するようになった。**
  新しい埋め込み空間へ大量投入した直後は統計が無く、**HNSW 索引が選ばれない窓**が在った
  （[#360](https://github.com/takecchi/mnemora/issues/360) /
  [ADR 0194](./docs/decisions/0194-embedding-space-analyze-threshold.md)、PR #406）。
  ⭕ **公開 API は変わっていない**——変わるのは実行計画である
- **`memories` への書き込み経路にも、同じ閾値つき `ANALYZE` のフックが入った**
  （[#269](https://github.com/takecchi/mnemora/issues/269) /
  [ADR 0221](./docs/decisions/0221-memories-analyze-on-write.md)、PR #492）。
  ⚠ **`supersedeWithNewMemories` だけが取り残されていたので、後から塞いだ**
  （[ADR 0225](./docs/decisions/0225-supersede-with-new-memories-analyze-hook.md)、PR #502）

### Added

- **`TenantSettingsStore.setDefaultHalfLifeRecalls`**（**任意**メソッド）。テナント既定の
  半減期を「recall 回数」で設定する本番の経路
  （[ADR 0197](./docs/decisions/0197-set-default-half-life-recalls.md)、PR #416）。
  ⭕ **任意メソッドなので、この追加そのものは後方互換**——実装していない adapter は従来どおり動く。
  ⚠ **ただし同じ PR #416 は破壊的変更も1件持っている**（上の表の **8**）。
  ⟹ **「任意メソッドだから丸ごと後方互換」と読まないこと。**
- **`OutboxStoreConformanceOptions.supportsRealConcurrency`**（`@mnemora/testkit`、**任意**フィールド）。
  adapter 作者が「同時 `claimBatch` を本物の並行で検査してよいか」を自己申告できる
  （[ADR 0206](./docs/decisions/0206-outbox-concurrent-claim-conformance.md)、PR #450）

### Fixed

- **`recall()` の返り値で `memories` と `omitted` が排他であることを、契約として明示して直した。**
  同じ Memory が両方に現れうる状態を塞いだ（[#421](https://github.com/takecchi/mnemora/issues/421) /
  [ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md)、PR #435）。
  ⭕ **公開型は変えていない**——変わったのは返る中身である

---

## [0.2.0] - 2026-09-16

**Release**: [v0.2.0](https://github.com/takecchi/mnemora/releases/tag/v0.2.0)（pre-release ではない）。
**tag が指すのは `c52be47`**、**前の版は `v0.1.9`**（`6c9d101`）。⟹ **この節は
`v0.1.9` → `v0.2.0` の差分である**（【実測】`git rev-list --count v0.1.9..v0.2.0` = 30）。

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更はすべて `@mnemora/core` と `@mnemora/testkit` に限られる**
（`openai`/`anthropic`/`local-embedding` の `src` に v0.1.9 からの差分は無い。【実測】
`git diff --stat v0.1.9..v0.2.0 -- packages/openai/src packages/anthropic/src packages/local-embedding/src`
が空を返す）。

**postgres 利用者へ**: 新しいマイグレーション（`0013`/`0014`/`0015`）が増えている。
適用手順・破壊的変更ごとの対応方法は [docs/migration-v1.md](./docs/migration-v1.md) を見ること
——このファイルには詳細を複製しない。

### Breaking

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 1 | `MemoryStore.getRecall` が必須メソッドとして追加された。 | `MemoryStore` を自前実装している adapter 作者 | [ADR 0155](./docs/decisions/0155-recall-score-breakdown-persisted.md) |
| 2 | `NewRecallRecord.returnedMemoryIds: MemoryId[]` を削除し、`returnedMemories: RecallRecordMemory[]` に置き換えた。 | `createRecall` を呼ぶ側・実装する側の両方 | [ADR 0155](./docs/decisions/0155-recall-score-breakdown-persisted.md) |
| 3 | `ScopeAggregate` に必須フィールド `filteredExpired`/`filteredNotYetValid` が増えた。 | `aggregateScope` を自前実装している adapter 作者 | [ADR 0164](./docs/decisions/0164-valid-from-until-recall.md) |
| 4 | `FilteredOmission.condition` の union に `"expired"`/`"not_yet_valid"` が増えた。 | 消費するだけなら非破壊。**`never` で網羅性を検査しているコードは壊れる** | [ADR 0164](./docs/decisions/0164-valid-from-until-recall.md) |
| 5 | `Runtime.getRecall` が必須メソッドとして追加された。 | `Runtime` を自前実装している側。⚠ 根拠 ADR に破壊性の言及が無い——[移行ガイド](./docs/migration-v1.md)を必ず見ること | [ADR 0161](./docs/decisions/0161-runtime-get-recall.md) |
| 6 | `TenantSettingsStoreConformanceOptions.supportsDecayClock`（`@mnemora/testkit`）が必須フィールドとして追加された。 | `describeTenantSettingsStoreConformance(...)` を呼んでいる adapter 作者。⚠ 根拠 ADR は当初「非破壊」と誤記載していたが訂正済み | [ADR 0165](./docs/decisions/0165-decay-activity-clock.md) |
| 7 | `RecallFootprintEstimate.associationCount`（`@mnemora/core`）が必須フィールドとして追加された。 | **返り値の型なので、読むだけ・呼ぶだけの利用者には非破壊。** `RecallFootprintEstimate` を自前で構築している側だけが影響を受ける。入力側（`estimateRecallFootprint`）は省略可能フィールドとして追加されており非破壊（省略時は `?? 0`）。（【実測】`packages/core/src/recall-footprint.ts:392` が必須、入力側の `RecallFootprintShape.associationCount` は `:368` で省略可能、既定は `:463` の `?? 0`） | ADR 0166 |

### Changed（後方互換だが挙動が変わりうる）

- **`RecallQuery.validAt` ゲートが既定で有効になった**（opt-out は `includeOutsideValidity: true`）。
  **影響を受けるのは、v0.1.9 で `MemoryStore.createMemory` を直接呼んで `validFrom`/`validUntil`
  に non-null を書いていた利用者だけ**——`Runtime.observe` 経由ではこれらの列に値を
  書く経路が v0.1.9 には無かったため、通常の利用者には影響しない。
  ([ADR 0164](./docs/decisions/0164-valid-from-until-recall.md))
- **`TICK_SUPPORTED_JOB_KINDS` が2値から4値へ増えた**（`consolidate`/`reflect` を追加）。
  値を消費するだけなら非破壊だが、**網羅性検査（`never`）をしているコードは壊れる。**
  ([ADR 0157](./docs/decisions/0157-tick-drives-consolidate-and-reflect.md))
- **`PostgresVectorStore.search` の `ORDER BY` に `memory_id` の tie-break が追加された。**
  距離が完全一致した候補の順序が決定的になった（以前は未定義）。
  ([ADR 0167](./docs/decisions/0167-association-getvectors-order-nondeterminism.md))
- **連想枠の非決定性は、上の修正だけでは消えていなかった（第2段）。** `search()` が返す
  候補に距離の完全一致タイが在ると、`memory_id` による tie-break が取り込みのたびに
  揺れていた。段1と段2の両方で順序を決定的にして直した（Issue #339）。
  ([ADR 0170](./docs/decisions/0170-association-search-tiebreak-nondeterminism.md))

### Added

- **`Runtime.getRecall(ctx, recallId)`** — `recall()` を離れた後でも、`recallId` から
  スコア内訳・`retrievedVia`・`companionOf`/`associationOf` を読み戻せる。
  ([ADR 0161](./docs/decisions/0161-runtime-get-recall.md))
- **`memory_usage` 報告の実践**（`examples/chat`）— プロンプトへ積んだ Memory を
  `observe({ kind: 'memory_usage' })` で伝え返し、`reinforce` を実アプリで発火させる。
  ([ADR 0163](./docs/decisions/0163-memory-usage-reporting-example-chat.md))
- **`validAt` ゲート** — 「この時刻において真だった記憶」を問える。`expired`/`not_yet_valid`
  を `omitted` で名指しする。([ADR 0164](./docs/decisions/0164-valid-from-until-recall.md))
- **減衰の時計を2本持てる（`decay_clock`）** — 壁時計（`wall`、既定）に加え、活動時計
  （`activity`）・両方（`either`）をテナントごとに選べる。低頻度利用のテナントが
  一律に沈むのを避けられる。([ADR 0165](./docs/decisions/0165-decay-activity-clock.md))
- **`estimateRecallFootprint` が連想枠の分も見積もれる** — 入力
  `RecallFootprintShape.associationCount?`（**省略可能**）を渡すと、返り値に
  `associationCount` が出る。**渡さなければ従来と同じ値が返る**（`?? 0`）。
  ([ADR 0166](./docs/decisions/0166-recall-footprint-association-term.md))
- **`examples/chat` の想起経路が連想枠を既定で使うようになった**（`maxCount=10`）。
  ⚠ **`@mnemora/core` の `recall()` の既定は off のままである**——連想枠は
  `query.association` を渡したときだけ走る（`packages/core/src/recall.ts:1132`
  「省略時は連想を一切走らせない」）。**変わったのは採用側が明示して使うようになったこと**であって、
  ライブラリの既定ではない。
  ([ADR 0168](./docs/decisions/0168-examples-chat-uses-association.md))
- **`tick()` が `consolidate()`/`reflect()` を駆動できる**（既定 off の opt-in、
  `RuntimeConfig.autoQueueConsolidateReflectOnExtract`）。
  ([ADR 0157](./docs/decisions/0157-tick-drives-consolidate-and-reflect.md))

### Fixed

- **連想枠（段3.5）の結果が、同一データに対して実行のたびに変わることがあった。**
  原因は `VectorStore.getVectors()` の返却順（adapter が保証しない順序）にそのまま
  依存していたことで、HNSW の近似性とは無関係だった。アンカーの処理順をランク順に
  固定して直した（Issue #316）。
  ([ADR 0167](./docs/decisions/0167-association-getvectors-order-nondeterminism.md))
