# ADR 0265: `local-embedding` fingerprint 門の `case` 分岐を、`bash` で実際に実行して固定する（Issue #574 後半）

- **状態**: 草案（`docs/decisions/README.md` は触っていない——ADR 0137 決定2。索引はマージする側が直前に再生成する）
- **日付**: 2026-09-22

> **⚠ この判定は、自動化された担い手（クローンのセッション）のものである。**
> **⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> GitHub 上の `takecchi` はオーナー本人・クローン・担い手が共用しており、この ADR の
> 決定を「オーナーが決めた」と読まないこと。方向そのものの変更が要るなら、
> オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0244 / 0245 / 0247 / 0253 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git` / `node` / `vitest` / `bash` を走らせて確かめた。
- **【受】** — 報告として受け取り、この ADR の書き手は再導出していない（出所を明記する）。

---

## 文脈

[ADR 0253](./0253-local-embedding-weights-fingerprint-gate.md) が置いた
`check-local-embedding-fingerprint.mjs`（local-embedding が実際に読み込んだ重みが、
宣言された Hugging Face repo の内容と今まさに一致しているかを照合する門）は、
同 ADR 自身の 2026-09-21 追記が認めている通り、**本番の CI で `exit 0`（一致）の
枝しか通っていなかった。** `exit 1`（赤）・`exit 2`（保留）・`exit 3` は一度も走って
おらず、特に `exit 2` は `case` 文の `2)` 枝がジョブを落とさない設計であるため、
**この枝が壊れていても CI は緑のまま流れる**——これが [Issue #574](https://github.com/takecchi/mnemora/issues/574)
の主題である。

## 【受】前半: 本番のランナーで `exit 1` / `exit 2` を1回ずつ通した観測

依頼者が、使い捨ての PR [#599](https://github.com/takecchi/mnemora/pull/599)（マージせず
観測後すぐ close）を使い、`example-chat` ジョブの門ステップの `case` 分岐を逐語で写した
一時ジョブを本番のランナーで2本走らせた。Issue #574 のコメント
`#issuecomment-5766805876`（run [35648302199](https://github.com/takecchi/mnemora/actions/runs/35648302199)）に記録がある。

**⚠ 以下は【受】であり、この ADR の書き手は再現していない。**

- `exit 2`（保留）→ ジョブは **success**。`::warning::` が Checks 画面に
  `annotation_level=warning` として立ち、Job Summary に
  「🟡 local-embedding fingerprint: 判定していない(…)」の1行が残った。
- `exit 1`（赤）→ ジョブは **failure**（`##[error]Process completed with exit code 1.`）。
- `exit 3` と `exit 0` はこの観測では通していない（`exit 0` は別の過去の本番 run で
  通っている、と Issue 本文にある。`exit 3` は本番では一度も観測されていない）。

依頼者自身がこの観測の末尾で明記している通り、**これは1回きりの観測であって、
回帰を守る歯ではない**——`run:` の本文を変える PR が来ても、この観測は再走しない。

## 決定

### 1. `ci.yml` の `run:` 本文を、YAML の外の文字列検査ではなく `bash` で実際に実行して固定する

`scripts/__tests__/ci-yml-local-embedding-fingerprint-shell.test.mjs` を置いた。

- **`run: |` の行より深いインデントで続く連続行**という形だけを見て本文を抽出する
  （`scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs` の `extractRunBlocks`
  と同じ形。ステップ名には依存しない）。
- 候補ブロックのうち `check-local-embedding-fingerprint.mjs` を含むものを選ぶ。
  **ちょうど1つに定まらなければ（0個・2個以上）赤にする。**
- 選んだ本文を**1バイトも書き換えずに**一時ファイルへ書き出し、
  `bash --noprofile --norc -e <file>` で実行する。
- `node` は差し替える——一時ディレクトリに `#!/bin/sh\nexit N` という実行可能ファイルを
  置き、`PATH` の先頭に足す。**本文への文字列置換はしない。**
- `GITHUB_STEP_SUMMARY` と `MNEMORA_LOCAL_EMBEDDING_CACHE_DIR` を一時パスへ向けた
  環境変数として渡す。
- `exit 0/1/2/3` それぞれについて、(a) シェル自身の終了状態、(b) stdout に
  `::warning::` が出たか、(c) `GITHUB_STEP_SUMMARY` に書かれた行数と中身、を確かめる。

### 2. なぜ「文字列検査のまま」では足りなかったか

既存の `ci-yml-local-embedding-fingerprint-wiring.test.mjs` は、ステップの**配線**
（存在する・`test:db` より後・`continue-on-error` を持たない・`GITHUB_STEP_SUMMARY`
という文字列を含む、等）を YAML の構造だけで見ている。**しかしこれは `case` 文の
中身までは見ていない。**

【実測】下の「測ったこと」の変異試験が示す通り、`case` の `*)` 枝を `exit "${CODE}"`
から `exit 0` へ変える変異（=「不一致・実行時エラーを黙って success 扱いにする」、
実質的な門の無力化）を入れても、既存の文字列検査は緑のままである——
`GITHUB_STEP_SUMMARY` も `check-local-embedding-fingerprint.mjs` も `continue-on-error`
の不在も、変異の前後で1文字も変わらないからである。**新しい歯だけがこの変異を
捕まえる。**

### 3. `ci-yml-local-embedding-fingerprint-wiring.test.mjs` の「確かめていないこと」を1箇所直した

同ファイルの docstring が「`case` 文が判定表どおりに分岐するかは、この歯では
シェルとして実行して確かめていない」と書いていた箇所を、**新しい歯
（`ci-yml-local-embedding-fingerprint-shell.test.mjs`）を指すように直した。**
⛔ **既存の歯の判定（`it` の中身）は1つも変えていない。**

## 検討して採らなかった案

### (a) 文字列検査のまま（既存の wiring 歯だけで足りるとする）

**却下。** 上の「なぜ文字列検査のままでは足りなかったか」の通り、`case` の分岐ロジック
そのものへの変異を、文字列検査は構造的に捕まえられない——検査対象が「配線」であって
「分岐の意味論」ではないため。

### (b) 本番の CI を毎回わざと赤くして確かめ続ける

**却下。** Issue #574 前半が1回だけ行ったこの方法は、**再現性を持つ歯ではない**——
`run:` の本文を変える将来の PR に対して自動では走らない。加えて、この repo は
`v1.0.0` の tag 待ちであり（Issue #574 コメントが明記）、意図した赤い run であっても
「リリースが壊れている」という誤読を招く経路を都度塞ぐ運用コストがある。**1回きりの
観測としては有効だったが、回帰を守る仕組みにはならない。**

### (c) `run:` の中身を独立した script へ切り出して単体試験する

⭐ **これは魅力的な案であり、却下した理由を正直に書く。**

`run:` の本文を `scripts/ci-fingerprint-gate.sh` のような独立ファイルへ切り出し、
`ci.yml` からは `run: ./scripts/ci-fingerprint-gate.sh` のように**1行で**呼ぶ形に
すれば、この ADR が採った「YAML から文字列で抽出する」という壊れやすい手順が丸ごと
不要になり、そのスクリプト自体を直接テストできる——**構造としてはこちらのほうが
筋が良いと考える。**

**それでも採らなかった理由**: この変更は `ci.yml` の `run:` ステップの中身を書き換える
ことになる。今回の依頼は「`ci.yml` は変更しなくても済むはずであり、変更が要ると
判断したら手を止めて報告すること」という明示の境界を持っていた。切り出しは
`required` な6ジョブの名前も挙動も変えないので安全だとは考えるが、**「ci.yml へ
手を入れるかどうか」は依頼者の判断を仰ぐべき一線だと判断し、この PR では見送った。**
⟹ **将来 `ci.yml` の変更が許される作業の中でなら、(c) を採ることを推奨する。**
この ADR はその推奨を記録として残す。

## これが覆るとしたら何が起きたときか

- **`ci.yml` の当該ステップが (c) の形（独立 script への切り出し）に変わったとき。**
  そのときはこの歯の「YAML から文字列で抽出する」手順が丸ごと不要になり、
  切り出した script に対する直接の単体試験へ置き換えるべきである。
- **GitHub Actions が Linux runner の既定シェルの挙動を変えたとき**
  （`shell:` 未指定の既定が `bash -e {0}` 以外になったとき）。下の「⛔ 確かめていないこと」
  参照。
- **`check-local-embedding-fingerprint.mjs` の終了コードの意味（判定表）が変わったとき**
  ——このとき、まず直すべきは `check-local-embedding-fingerprint.mjs` の docstring の
  判定表であり、この歯の期待値はそれに追随して直す。

## 測ったこと

**測定条件**: 断りの無い【実測】は `origin/main` = `6a4ab66` から切った作業ツリーで、
2026-09-22 に行った。

- 【実測】新しい歯を先に置き、期待値を1つ意図的に間違えた状態（exit 0 の期待
  シェル終了状態を `1` に書き換え）で `npx vitest run scripts/__tests__/ci-yml-local-embedding-fingerprint-shell.test.mjs`
  を実行し、その1件だけが赤くなることを確認した:

  ```
  × exit 0(match) → シェルは成功終了。::warning:: は出ない。GITHUB_STEP_SUMMARY に🟢の1行 19ms
  AssertionError: expected +0 to be 1
   Tests  1 failed | 6 passed (7)
  ```

  `cp` で退避しておいた原本に戻し、7 tests 全て green に戻ることを確認した。

- 【実測】変異試験1: `ci.yml` の `case` の `*)` 枝を `exit "${CODE}"` から `exit 0`
  （不一致・実行時エラーを黙って success 扱いにする変異）へ書き換えたところ、
  **狙った2件（exit 1 / exit 3 の it）だけが赤くなった**（exit 0 / exit 2 の it は
  無傷のまま green）:

  ```
  × exit 1(mismatch) → ... AssertionError: expected +0 to be 1
  × exit 3(実行時エラー) → ... AssertionError: expected +0 to be 3
   Tests  2 failed | 5 passed (7)
  ```

  ⟹ この赤は「取り出しに失敗して落ちているだけ」ではない——取り出し自体は成功し
  （ちょうど1ブロックが見つかる it・陰性対照の it は green のまま）、
  **実際に変異させた分岐（`*)`）に対応する2つの it だけがピンポイントで赤くなった。**
  `cp` で退避しておいた原本に戻し、`diff` で1バイトも差が無いことと、7 tests 全て
  green に戻ることを確認した。

- 【実測】変異試験2: `ci.yml` の `case` から `2)` 枝を丸ごと削除した（保留を
  `*)` へ落として、`exit "${CODE}"` により **保留までジョブを落とす**変異）ところ、
  **狙った1件（exit 2 の it）だけが赤くなった**:

  ```
  × exit 2(undetermined/保留) → ... AssertionError: expected 2 to be +0
   Tests  1 failed | 6 passed (7)
  ```

  `cp` で退避しておいた原本に戻し、`diff` で1バイトも差が無いことと、7 tests 全て
  green に戻ることを確認した。

- 【実測】対象の歯 (`ci-yml-local-embedding-fingerprint-shell.test.mjs`, 7 tests) と、
  `ci.yml` を読む既存の姉妹の歯3本
  （`ci-yml-local-embedding-cache-wiring.test.mjs` / `ci-yml-local-embedding-fingerprint-wiring.test.mjs`
  / `ci-yml-measurement-jobs-wiring.test.mjs`）を合わせて実行し、**4ファイル・49 tests
  すべて green** であることを確認した（`ci-yml-local-embedding-fingerprint-wiring.test.mjs`
  の docstring 修正を含む）。

- 【実測】GitHub Actions の Linux runner の既定シェルについて、この ADR を書く過程で
  web を調べ直した。`shell:` を指定しないときの既定は **`bash -e {0}`**
  （`--noprofile --norc` も `-o pipefail` も含まない）であり、`shell: bash` と
  **明示した**ときだけ `bash --noprofile --norc -eo pipefail {0}` になる、という
  記述を GitHub のドキュメントと `actions/runner` 側の issue（`actions/runner#353`）
  の双方で確認した。**この2つは別物である。**
  ⚠ **[ADR 0245](./0245-publish-gate-shell-default-pinned.md) の本文は
  「Linux runner では既定として `bash --noprofile --norc -eo pipefail {0}` であり」
  と書いており、これは `shell: bash` を明示したときの値と一致する——`shell:` 未指定の
  既定（`bash -e {0}`）とは食い違う。** ADR 0245 自身が「本 ADR が新たに確かめたのは
  この逐語の値そのものではない」と断っており、**恐らくドキュメントの「明示した bash」
  の行を「未指定の既定」の行と取り違えたものと考えられるが、この ADR ではそれ以上
  検算していない。** `docs/decisions/README.md` の規律によりADR 0245 の本文は
  書き換えない——この食い違いをここに記録するに留める。
  ⟹ **実務上の影響はほぼ無い**——`ci.yml` の当該 `run:` 本文にパイプ（`|`）は
  1つも無いため、`-o pipefail` の有無はこの門の判定結果を左右しない
  （`--noprofile --norc` も、非対話・非ログインの子プロセスとして `bash <file>`
  を実行する限り no-op である）。この歯は `bash --noprofile --norc -e <file>` を
  使う——`--noprofile --norc` を含めているのは実害が無いための保守的な選択であり、
  「これが本物の既定と完全に一致する」という主張ではない。

## 引き受けた負債

1. **YAML を構造として解析していない（文字列で見ている）。** `ci.yml` の書き方が
   変わると（例えば `run: |` を `run: >` に変える、ステップの並びを変える等）、
   この歯は「配線が変わった」のか「取り出し方が古い」のかを自分では判定できない。
   既存の wiring 歯群と同じ負債であり、依存（YAML パーサ）を足す判断はオーナー専権
   のため据え置いた。
2. **`node` を丸ごと偽物に差し替えているため、`check-local-embedding-fingerprint.mjs`
   自身の判定ロジックはこの歯の実行対象に含まれない。** CLI 本体の正しさは
   `check-local-embedding-fingerprint-lib.test.mjs`（純関数側）に委ねている——
   この歯が緑でも CLI 自体にバグが無いことは示さない。
3. **推奨した (c) 案（script への切り出し）を採らなかったことで、YAML からの
   文字列抽出という壊れやすい手順が残り続ける。** 上記1と同じ根の負債である。

## ⛔ 確かめていないこと

- **`exit 3` と `exit 0` は、本番の GitHub Actions ランナー上では一度も通っていない。**
  Issue #574 前半の本番観測は `exit 1` / `exit 2` の2つだけである。この ADR が置いた
  歯は4つとも手元の `bash` 実行で固定するが、それは「本番のランナーで通した」こととは
  別の主張である。
- **Actions の `run:` ステップとして実際に走ったことは、この歯では測っていない。**
  測ったのは「同じ本文を、GitHub Actions の既定と同じ形のシェル呼び出しに食わせた
  ときの振る舞い」であり、チェックアウト後の作業ディレクトリ・`${{ github.workspace }}`
  の展開・`actions/cache` のヒット/ミス等、YAML の他の部分が絡む経路は一切通していない。
- **GitHub Actions の Linux runner が `shell:` 未指定のときに実際に何を実行するか**を、
  この ADR の書き手は自分の手で GitHub Actions のランナー上で再現していない
  （web 検索で見つけたドキュメント・issue の記述に基づく【受】に近い——ただし
  この歯自身の判定結果には影響しないことは上で示した）。
- **`ci.yml` の書き方がどこまで変わると、この歯の抽出（`extractRunBlocks` +
  `check-local-embedding-fingerprint.mjs` を含むブロックの選択）が壊れるか**は、
  網羅的には確かめていない——上に挙げた2種類の変異試験の範囲でしか確認していない。
