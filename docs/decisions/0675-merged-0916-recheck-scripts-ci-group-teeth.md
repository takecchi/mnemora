# ADR 0675: 09/16 にマージされた scripts/CI の PR 10本（#365・#380・#385・#398・#414・#423・#434・#436・#438・#444）の確かめ直しで見つかった穴に歯を足す（Issue #1815、G1）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1815](https://github.com/takecchi/mnemora/issues/1815)。
これは試験だけの変更で、`scripts/*.mjs`・`.github/workflows/ci.yml`・`package.json`・実装は触らない。

## 経緯【実測】

2026-09-16（UTC）にマージされた PR は68本で、機械の約束を持つ32本を5群（G1 scripts/CI・G2 core の recall ゲート・G3 core 大型の feat・G4 postgres・G5 examples/chat）に分けた。残り36本は文書だけ、またはコメント・docstring だけで、機械の約束が無い（`#341`・`#356`・`#430`・`#431` は実行される部分に触れない差分であることを PR の diff で確かめた）。分母と群の順番は Issue #1815 にある。**この ADR は G1（10本）だけを扱う。** 残りの群は同じ Issue で続ける。

変異は main `65c5a45a` の上で、控えを `cp` で取って当て、`cp` で戻して `cmp` で一致を確かめた（走らせたのは対象の試験ファイルだけ、`--maxWorkers=2`）。

### 約束とその後の変化（狭まったものは無かった）

- #365・#436（`adr-renumber`、ADR 0179・0200）: 後の ADR 0277（連なりの参照の検出）・0540（ファイル名の規則の共有）・0293（PR タイトル・本文を見る CI の検査を削除）が足したり外したりしたが、`adr-renumber.mjs` が「このブランチが足した行だけを書き換える」「付け替えたら PR タイトルと本文の警告を出す」という約束は残っている。ADR 0293 が外したのは CI 側の機械検査で、警告そのものではない。今の約束に当てた。
- #385（`ci-green-check`、ADR 0191）: ADR 0215（required status checks を下限にする）・0281（0件の理由の切り分け）が足された形。`--match-head-commit` に判定した sha を埋めたコマンドを緑のときだけ出す、は変わっていない。
- #398（ADR 0192）・#414（ADR 0196）・#380（ADR 0178）・#423・#434（Issue #425）・#438・#444（ADR 0202・0204）: 後の ADR で約束が狭まったものは見当たらなかった（`docs/decisions/` を各道具のファイル名で引いた）。

## 見つかった穴（歯を足す前に素通りしたもの）

### #365・#436 `adr-renumber`

純関数の側（`adr-renumber-lib.test.mjs`）は42本あったが、**CLI としての振る舞いを見る歯は、形の外れた名前の拒否（ADR 0540）だけだった**。CLI に当てた変異16形のうち15形が素通りした（うち2形は下の決定3の等価）:

- 追加された ADR だけを対象にする（`--diff-filter=A` を `AM` にしても赤くならない）
- 書き換えは追加行だけ（継承した行も書き換える形にしても赤くならない）
- バイナリ（NUL を含む）の読み飛ばし
- 付け替えたときの警告（PR タイトルと本文）を出さない／略記の連なりに残った旧番号を `exit 1` で人に渡さない
- 書き換えたファイルの末尾に改行を足す
- `--check` の `exit 1`・「衝突なし」の出力・`--next` が他のリモートブランチと open な PR の主張を数えること・`--check` と `--next` の同時指定（`exit 3`）

純関数の側の穴: `pickNextFreeNumber` が降順の入力で最大値を取らない／衝突しない新規 ADR の番号を横取りする／`10146-slug` の途中の `0146-slug` を書き換える／連なりの1番目も「届かない位置」として報告する／警告が「タイトルと本文の両方」でなくなる／`addedLineNumbers` が `++` で始まる追加行を落とす・削除行で行番号を進める・コンテキスト行で進めない。

### #385 `ci-green-check`

既存の CLI の歯は引数検査（`gh` を呼ぶ前に決着する経路）だけで、**`gh` を呼んだ後の配線（どの `gh` を呼び、判定を exit code とマージコマンドに落とす）は誰も走らせていなかった**。CLI に当てた変異は、等価の2形（決定3）を除いて全形が素通りした: 緑でも `--pr` が無ければコマンドを出さない／判定を exit code に写す／下限の取得失敗を pending に倒す／`--base` と PR の base の優先／`--repo` の明示／0件のときだけ PR の `mergeable_state` を引く／`--recheck-after` の引き直し（head sha が変わったとき・名前集合が変わったときに green を pending へ落とす）／`--paginate`／赤のときだけ ADR 索引の陳腐化を言う（ADR 0192）。

### #398 `adr-index-freshness-branch-lib`

`refs/pull/N/merge` の正規表現の両端の錨と数字の1桁以上、`GITHUB_REF` が空文字のときの扱い、detached HEAD（`HEAD`）と tag の ref を有効にしない、が素通りした。

### #414 `initdb-args-lib`

`C.UTF-8`（`C.utf8` と並ぶ既知のロケール）の行を消しても赤くならない／`--locale=` と `--encoding=` の値に引用符を含めない（`ci.yml` の行の形）／`ANY_ENCODING` が Symbol であること（文字列にしない、が ADR 0196 の明示の決定）／`--encoding=` の値を読み替えない。

### #434 `identifier-probes-readme-freshness-lib`

20形のうち、見出しの欠落・一覧表の余分な群・実測表の行の欠落と余分・probe 件数・hit@1 と hit@10 の分母・MRR（丸めてちょうど一致を見ること）・節と表の終わりの切り方・`###` の無い地の文を主張として読まないこと、が素通りした。**`checkReadmeMatchesBaseline` が検知する形は、群数・件数の片方・hit@1 の数・一覧表の抜けだけだった。**

### #438・#444 `readme-postgres-objects-lib`

`CREATE TABLE IF NOT EXISTS`・`CREATE INDEX CONCURRENTLY`（`IF NOT EXISTS` との組み合わせも）・`DROP INDEX CONCURRENTLY`・`DROP FUNCTION IF EXISTS`・小文字の DDL が拾われない形、節が `## ` の見出しで終わらない形、見出しの途中にラベルを含むだけで拾う形、半角の括弧 `(N)`、字下げした箇条書き、箇条書きでない行の途中の `- `x``、負の `MIGRATION_LOCK_KEY`。**README の一覧と migrations の最終形の突き合わせが、その書き方のオブジェクトを黙って数えない形になる。**

### #380・#423 公開 API 表面の門

- 同じ長さの書き換え（`number` → `string`）が差分として見えない形（長さの比較にしても赤くならない）
- **#423 が足した「先に `pnpm run build` で dist を作り直す」という手順の文が消えても赤くならない**
- dist が無いパッケージを黙って通す形（エラーを violations に積まず出力だけにする）
- 親ディレクトリへの相対 import（`../x.js`）を辿らない／`types` を持たない `exports` の項で落ちる／連結の形（ファイルの間の空行）
- `ci.yml` の `api:check` の段に `|| true`・`continue-on-error: true`・`if:`・`shell:` を足しても、既存の配線の歯は緑だった（段の行は `run: pnpm run api:check` のまま）。job ごと `continue-on-error` や `defaults.run.shell` にする形も同じ

**先の #1784（ADR 0666）・#1804（ADR 0670）が見つけた形がここでも出た。ある書き方しか見ない歯は、同じ門を別の書き方で外す変異を通す。** `ci.yml` の別の配線の歯（`ci-yml-*-wiring.test.mjs`）にも同じ族の穴があるかは、この ADR では掃いていない（確かめていないこと）。

## 決定【判断】

1. 実装・`ci.yml`・`package.json` は変えない。足すのは試験だけである（新規9ファイル・113本）。
2. 足した歯:
   - `scripts/__tests__/adr-renumber-cli.test.mjs`（14本）: 一時 git リポジトリに道具を写し、偽の `gh` を PATH の先頭に置いて CLI を走らせる。実リポジトリには触らない
   - `scripts/__tests__/adr-renumber-lib-edges.test.mjs`（10本）
   - `scripts/__tests__/ci-green-check-cli.test.mjs`（27本）: 偽の `gh`（node スクリプト）で、`gh` を呼んだ後の配線と `--recheck-after`、ADR 索引の相乗り（道具を一時ディレクトリへ写し、その `docs/decisions` を作業木にする）を見る
   - `scripts/__tests__/adr-index-freshness-branch-lib-edges.test.mjs`（7本）
   - `scripts/__tests__/initdb-args-lib-edges.test.mjs`（7本）
   - `scripts/__tests__/identifier-probes-readme-freshness-drift.test.mjs`（15本）
   - `scripts/__tests__/readme-postgres-objects-lib-edges.test.mjs`（17本）
   - `scripts/__tests__/public-api-surface-gate-edges.test.mjs`（7本）
   - `scripts/__tests__/ci-yml-api-check-step-unconditional.test.mjs`（8本）
3. 等価な変異は歯にしない（行番号は main `65c5a45a` の版）:
   - `adr-renumber-lib.mjs` の `escapeRegExp` と `escapeRegExp(slug)`: slug は `ADR_FILENAME_RE`（`generate-adr-index-lib.mjs` の `[a-z0-9][a-z0-9-]*`）で作られ、正規表現の特殊文字を含まない
   - `adr-renumber.mjs` の `idx < 0 || idx >= lines.length`（行番号は同じファイルの diff から作るので範囲外にならない）と、`git diff --name-only` を `git ls-files` に替える変異（差分の無いファイルは `addedLines.size === 0` で飛ばされる）
   - `ci-green-check.mjs` の `fetchMergeableState` が `"null"` を返す形（`verdict()` は `"dirty"` だけを見る）と、`isAdrIndexStaleLocally` の `README.md` の除外（`buildAdrEntries` が許す一覧と `isAdrFilename` で外れる）
   - `adr-index-freshness-branch-lib.mjs` の `isPullRequestMergeRef` の `typeof githubRef === "string"`（正規表現の `test` は文字列に直してから比べる）
   - `readme-postgres-objects-lib.mjs` の予約語の先読みのうち `OR`・`REPLACE`（名前は `FUNCTION`・`TABLE` の直後にしか来ないので、この2語は名前の位置に現れない）
   - `initdb-args-lib.mjs` の `serverEncoding` の大文字小文字の比較（`ci.yml` は大文字、initdb の側の大文字小文字は確かめていない）と、`--locale` を空白区切りや `--lc-collate=` まで広げる変異（広げるのは歯を強める向きで、「扱っていない書き方」は ADR 0196 が名乗っている）
4. `ci-yml-api-check-step-unconditional.test.mjs` の「job に `defaults:` が無い」は、「門が既定の shell で走る」という今の約束に照らしたクローンの判断で、ADR 0178 の条文ではない。必要な理由が出たら、ADR を積んでこの歯を直す。

当てた変異は全部、赤になること・戻して緑になること・`cmp` で控えと一致することを確かめた。

## 確かめていないこと

- `ci-green-check` の偽の `gh` は、実物の `gh` の出力形式（`--paginate -q` の行ごとの JSON など）を写している。実物の `gh` が返す形そのものは、この歯では測っていない（CI の実行がその確認である）。
- `ci.yml` の他の配線の歯（`ci-yml-*-wiring.test.mjs`）に同じ族の穴（段への `|| true`・`continue-on-error`・`if:`・`shell:`）があるか。
- G2〜G5（core・postgres・examples/chat の 22本）。Issue #1815 で続ける。
- 文書だけの PR 36本は、機械の約束が無いので測っていない。
