# ADR 0210: ルートの `test` 門は、前段が落ちても後段を必ず起動する（Issue #453）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

**⚠ 各主張の出所を分ける**（[ADR 0195](./0195-six-gates-verified-in-ci.md) /
[ADR 0207](./0207-dry-run-reads-existence-and-coverage-degrades-silently.md) と同じ体裁）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手（または依頼者）が自分の手で走らせて確かめた。

---

## 問い

[Issue #453](https://github.com/takecchi/mnemora/issues/453)。ルートの `package.json` の
`test` 門 **【現物】**:

```json
"test": "vitest run && pnpm -r --if-present run test && node scripts/run-db-tests.mjs"
```

3段が `&&` で連結されている。段1（`vitest run`）が落ちると、shell は左辺が非0の
時点で評価を止めるため、段2（`pnpm -r --if-present run test`）と段3
（`node scripts/run-db-tests.mjs`）は**一度も起動されない**。手元や CI の出力には
「テストが赤い」としか出ず、どの段がそもそも走っていないかは読み取れない
——**「赤1件」の裏に「未起動の段」が隠れる。**

**⚠ 壊れているのは「赤の読み方」だけで「緑の意味」は壊れていない**（Issue #453 本文）。
3段すべてが実際に通ったときの緑は、直す前も直した後も同じ意味を持つ。壊れていたのは、
赤が出たときに「どこまで実際に検査されたか」を読み取れないことだけである。

**Issue #426 とは層が違う。** Issue #426 は CI の**同じジョブ内の別ステップ**が
`if:` 条件で `skipped` になる話であり、`skipped` という状態自体は GitHub Actions の
UI にそのまま出る。本 Issue #453 は、shell の `&&` によって**ステップにすら現れない**
——起動されたステップの中の exit code だけが「テストが落ちた」の1件として見え、
起動されなかった段は run のログにも UI にも痕跡を残さない。**「skipped と表示される」
vs「表示すらされない」の違いが、この2つを別の層にしている。**

## 数え直した結果 — 同じ族は6箇所在り、直すのは2箇所

**【現物】** 「1つの赤の裏で、まだ走っていない検査が在り、そのことが出力から
読み取れない」という形（**前段の失敗が後段の起動そのものを止め、かつ止まったこと自体が
出力に出ない**）を repo 全体で数え直すと、**1箇所ではなく族として6箇所**在る。

| # | 場所 | 形 | 扱い |
|---|---|---|---|
| 1 | ルート `package.json` の `test` の `&&` ×2 | `&&` | ⭐ **直す** |
| 2 | 段2 の `pnpm -r`（既定で bail する） | pnpm の既定動作 | ⭐ **直す**（`--no-bail` を足す） |
| 3 | `scripts/run-db-tests.mjs:204-212`（for ループ + 失敗時の `process.exit`） | 早期 exit | **直さない** — この2パッケージ（`packages/postgres` / `examples/chat`）の DB 検査は `.github/workflows/ci.yml` の専用ジョブ（`postgres` / `example-chat`）でも独立に走る。この段が早期に止まっても、CI 側で同じ検査の合否は別途確定するため、情報は失われていない |
| 4 | ルートの `typecheck`（`pnpm -r`） | pnpm の既定動作 | **直さない** — `typecheck` はパッケージ間に依存の向きがある。ある型が壊れると依存先パッケージの型検査も連鎖して壊れるのが自然な結果であり、`--no-bail` にすると「壊れた根本原因」と「その波及」が同じ数の赤として並び、雑音が増える |
| 5 | ルートの `build`（`pnpm -r`） | pnpm の既定動作 | **直さない** — 理由は4番と同じ（依存の向き） |
| 6 | `.github/workflows/publish.yml` の「Typecheck / Lint / Format / Test / Build」ステップ（`run: \|` の5行、`bash -e` の既定） | shell の `-e` | 🔴 **触らない** — リリース直前に出荷経路（publish の一連）へ手を入れないという依頼者の明示指示による。この族に属することは記録するが、直す判断はここでは行わない |

⚠ **`.github/workflows/ci.yml` の `psql ... && psql ...`（`postgres` ジョブ等、
計10箇所）はこの族ではない。** 見た目は同じ `&&` だが、**前段（接続確認）が失敗した
状態で後段（`CREATE EXTENSION` 等）を実行しても意味を持たない**——繋がっていない
DB に対して拡張を作ろうとしても、それ自体が無意味な操作であり、「後段が検査すべき
情報を失う」ことにはならない。**意図した前提条件**であり、「まだ走っていない検査が
隠れている」形とは違う。次にこの族を数える人が同じ調査をやり直さないよう、
ここに明記しておく。

## 【実測】所要時間 — 緑では変わらず、赤のときだけ最大 ~10秒増える

**【実測】** 2026-09-17、`main` の緑 run `35173334607` の job `105049519492` の
ログのタイムスタンプから: `Test` ステップ全体 49秒のうち、段2（`pnpm -r --if-present
run test`）≈ 10秒、段3（`node scripts/run-db-tests.mjs`）≈ 0秒
（このジョブには `DATABASE_URL` が設定されておらず、段3は「実行していません」と
明示して即終わる）。

⟹ **全段が通るとき（緑）、3段を常に走らせても所要時間は変わらない**
——直す前から、緑のときは3段とも最後まで走っていたため。**赤のとき**だけ、
直す前は段1が落ちた時点で止まっていたのに対し、直した後は段2・段3も走るため
**最大で ~10秒増える。** 「未起動の段が見えるようになる」対価は、赤のときに限って
発生する高々十秒程度であり、CI の1周が数分〜十数分であることを踏まえると小さい。

## 検討した選択肢

1. **`&&` を `;` に置き換えるだけ（シェルレベルの変更）。**
   各段の exit code を集約する仕組みが無いままだと、**最後に実行されたコマンドの
   exit code だけ**が門全体の結果になる（bash の既定）。段1が落ちて段2・段3が
   通っても、門全体は緑になってしまう——直したい欠陥（未起動が見えないこと）は
   直るが、**新しい欠陥（失敗が握り潰される）を作る**。採らない。
2. **`concurrently` 等の外部ツールを導入する。** 3段は元々逐次実行（段2が段1の
   dist に依存する場面は無いが、出力の可読性のため直列を維持したい）であり、
   外部ツールを1本増やす価値が無い。採らない。
3. **各段の結果を集約する専用スクリプトを書く（採用）。** `scripts/publish-dry-run.mjs` /
   `scripts/decide-publish-dry-run.mjs` と同じ「判定関数（`scripts/root-test-gate.mjs`）と
   実行部（`scripts/run-root-test-gate.mjs`）を分ける」形を踏襲する。判定側は副作用が
   無いので歯から直接検査できる。

## 決定

### 1. ルートの `test` を専用スクリプトに置き換える

`package.json`:

```json
"test": "node scripts/run-root-test-gate.mjs"
```

`scripts/run-root-test-gate.mjs` は3段を**前段の成否に関わらず順に全部**起動する:

| 段 | コマンド |
|---|---|
| 1 | `pnpm exec vitest run` |
| 2 | `pnpm -r --if-present --no-bail run test` |
| 3 | `node scripts/run-db-tests.mjs` |

各段の stdout/stderr は `stdio: "inherit"` でそのまま流す。握り潰したり加工したりしない
——特に段3は、出力そのもの（「DB テストは実行していません」等）に意味を持たせている
（ADR 0015）。

### 2. 段2に `--no-bail` を足す（数え直した結果の2番）

`pnpm -r --if-present run test` を `pnpm -r --if-present --no-bail run test` にする。
段2の中でも、対象パッケージのうち1つが落ちただけで残りのパッケージの `test` が
未起動のまま終わる、という同じ族の欠陥を塞ぐ。

### 3. 判定は `scripts/root-test-gate.mjs` の純関数に持たせる

- `summarizeStages(results)` — 各段の結果（名前・`ran`・`exitCode`）から、
  1画面で読める要約テキストを作る。**全段が失敗していても、要約には
  「3/3 段が実際に走りました」と出る**——これがこの Issue の芯である。
- `gateExitCode(results)` — 同じ配列から門全体の終了コードを決める。
  1つでも段が失敗、または1つでも段が未起動（`ran: false`）であれば非ゼロ。

歯は `scripts/__tests__/root-test-gate.test.mjs` に置き、この2関数だけを検査する。
**門そのもの（`scripts/run-root-test-gate.mjs`）を子プロセスとして起動する歯は
置かない**——段2が `pnpm -r run test` を呼ぶため、歯の中から起動すると再帰する。

⭐ **配線の実体（`STAGES` 配列）も、この純関数側に置く。**`run-root-test-gate.mjs` は
import された時点で3段を起動してしまうので、**歯から import できない。**配線を
そちらに置くと、配線を釘付けにする歯（`scripts/__tests__/run-db-tests.test.mjs` の
「ルートの test 門の配線」）は**ソースを文字列として読むしかなくなる**——そして
`run-root-test-gate.mjs` の冒頭コメントには3段が同じ順で表になって書いてあるため、
⛔ **`indexOf` で順序を測る歯は、コードを並べ替えても緑のままになる。**
⟹ 副作用の無い `root-test-gate.mjs` に `STAGES` を置き、歯はそれを import して
**データそのものを測る。**

**【実測】この歯が本当に噛むことを、変異を当てて確かめた**（2026-09-17、手元）:
段2から `--no-bail` を落とすと2件、段3（`run-db-tests.mjs`）を配列から消すと1件が
赤くなり、戻すと5件とも緑に戻った。

### 4. 数え直した族のうち、直すのは1番・2番だけ

上の表の通り。3番（`run-db-tests.mjs` の早期 exit）・4番・5番（`typecheck` /
`build` の `pnpm -r` 既定動作）・6番（`publish.yml`）は、それぞれ個別の理由で
今回は直さない。

## 理由

困っていたのは「段2・段3が動かないこと」ではなく、
**「動かなかったことが、動いて通ったことと出力の上で区別できないこと」**である。
だから直すべきは実行の可否ではなく、**全段を必ず起動したうえで、何が走って
何が通って何が落ちたかを門自身が報告する**ことである。

`typecheck` / `build` に `--no-bail` を入れない判断は、`test` とは性質が違う
——`test` は各パッケージのテストが独立しているため1つの失敗が他のテストの
意味を変えないが、`typecheck` / `build` は依存の向きに沿って壊れが伝播するため、
全部を無理に走らせても「同じ原因の重複した赤」が増えるだけで、
未起動が見えないことの穴を埋める効果が薄い。

## 結果（この決定が招くもの）

- **緑のときの所要時間は変わらない**（【実測】上記）。
- **赤のとき、最大で ~10秒増える**（段1が落ちても段2・段3を最後まで走らせるため）。
- ルートの `test` の実装は shell の1行から Node スクリプト2本
  （`scripts/root-test-gate.mjs` / `scripts/run-root-test-gate.mjs`）に増える。
  `scripts/publish-dry-run.mjs` 系と同じ形に揃えたので、この repo の読み手にとって
  見慣れた構造のはずである。
- `scripts/run-db-tests.mjs`（ADR 0015 が定めた段3の意味・出力）は変更していない。
  この ADR が変えるのは「段3が確実に起動されること」だけである。

## これが覆るとしたら

- **段2・段3が、段1の成果物（ビルド済み dist 等）に依存するようになったとき。**
  いまは3段とも独立に実行できるため前段の成否に関わらず走らせられるが、
  依存関係が生まれれば「前段が失敗しても後段を強行する」ことがかえって
  意味の無い失敗を増やす可能性がある。そのときは選択肢を見直す必要がある。
- **`typecheck` / `build` についても「未起動が見えないこと」が実際に問題として
  顕在化したとき。** 今回は `test` に限って直した。同じ族の3番・4番・5番を
  直す判断が要るなら、それぞれ別の ADR で扱う。

## 確かめたこと・確かめていないこと

- **確かめた**: `scripts/root-test-gate.mjs` の2関数の歯（`scripts/__tests__/root-test-gate.test.mjs`）を
  `pnpm exec vitest run scripts/__tests__/root-test-gate.test.mjs` で走らせ、全7件が
  緑であることを実測した。同ファイルに対する `eslint` / `prettier --check` も実測した。
- 🔴 **確かめていない**: この PR の CI（`typecheck / lint / test / build` ジョブ）が
  実際に緑になることは、CI 側の結果を見るまでは確認できていない
  ——PR 本文・この ADR の追記で報告する。
- 🔴 **確かめていない**: `run-root-test-gate.mjs` を実際に「段1をわざと失敗させて
  段2・段3が起動されること」を手元で変異試験することは行っていない
  （ローカルで全テストを走らせることを避けたため）。CI 上でこの門自体が実行される
  ことをもって、配線が壊れていないことの実測に代える。

## 追記（2026-09-24、Issue #476）: 族の6番（`publish.yml` の門ステップ）も同じ形で直した

⛔ **本文は書き換えていない。** 上の「数え直した結果」の表・6番と「4. 数え直した族の
うち、直すのは1番・2番だけ」は、この追記を書いた時点でもなお**当時の判断の記録として
正しい**——当時は「リリース直前に出荷経路へ手を入れない」という依頼者の明示指示により、
6番（`.github/workflows/publish.yml` の門ステップ）は意図的に対象から外されていた。
[Issue #476](https://github.com/takecchi/mnemora/issues/476) は、この6番に「族に属する
ことは記録するが、直す判断はここでは行わない」という住所を与えるために立てられ、
2026-09-17 の判定コメントは「⭕ `v1.0.0` を止めない」——理由は「`bash -e` が既定な
限り、偽陽性の緑（壊れているのに通る）は起きない。失われるのは診断の解像度だけ」
であり、`v1.0.0` の後に改めて判断する対象として残っていた。

**この追記の時点で、`v1.0.0` の tag 待ちが外れ、`publish.yml` の門ステップに手を
入れる作業が明示的に依頼された。**⟹ 族の6番を、1番・2番と同じ形で直した。

### 直した形 —— 1番・2番とまったく同じ形

`.github/workflows/publish.yml` の門ステップ（直す前、`bash -e` の既定に任せた5行）:

```yaml
run: |
  pnpm run typecheck
  pnpm run lint
  pnpm run format:check
  pnpm run test
  pnpm run build
```

これを、`scripts/publish-gates.mjs`（判定・副作用なし）と `scripts/run-publish-gates.mjs`
（CLI 入口）に切り出した——**本体（1番。`scripts/root-test-gate.mjs` /
`scripts/run-root-test-gate.mjs`）と同じ「判定関数と実行部を分ける」形**を、意図的に
コードは共有せずに踏襲している（理由は `scripts/publish-gates.mjs` の docstring
に書いた——本体側は「歯から `run-root-test-gate.mjs` を子プロセスとして起動しない
（段2の `pnpm -r run test` が再帰するため）」という固有の制約を抱えており、この
制約をこちらへ持ち込みたくなかった）。5段を前段の成否に関わらず全部起動し、
どれか1本でも失敗・未起動なら最後に非ゼロで終わる。落ちた段の名前は要約に
名指しで出る（`summarizeStages()` が「N/5 段が実際に走りました」「失敗した段: …」
を出す——本体の `summarizeStages()` と同じ書式）。`publish.yml` 側は
`node scripts/run-publish-gates.mjs` を1行呼ぶだけになった。

### 既存の「`-e` を保つ」歯（`publish-yml-gate-shell-wiring.test.mjs`）との関係

Issue #476 の 2026-09-18 のコメントが置いた歯
（`scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs`。ADR 0245 / Issue #476）は、
「門ステップが `bash -e` で走ること」——`shell:` の上書きで `-e` が失われていないこと
——を縛っていた。**この歯は消していない。** ただし、この追記の変更により
偽陽性の緑を防ぐ責務の主体が移ったため、次の2点を直した:

1. **門ステップの検出方法**を「`pnpm run` の行が2本以上並ぶブロック」から
   「`run-publish-gates.mjs` を含むブロック」に変えた（旧方式は、門ステップが
   `node scripts/run-publish-gates.mjs` の1行だけになった時点で、候補が0件に
   なってしまうため）。
2. **「2本以上のコマンドが並ぶこと」を測っていた `it` を、「`node
   scripts/run-publish-gates.mjs` の1行だけであり、`|| true` のような終了コードを
   握り潰す尾が付いていないこと」を測る `it` に置き換えた。**

歯自身の**意図**（偽陽性の緑を出さない）は変えていない——変えたのは、その意図を
どの層で果たすかである。単一コマンドの `run:` は、`-e` の有無に関わらず
その終了コードがそのままステップの終了コードになるため、偽陽性の緑を防ぐ主な
責務はいまや `scripts/publish-gates.mjs` の `gateExitCode()`（歯:
`scripts/__tests__/publish-gates.test.mjs` / `run-publish-gates.test.mjs`）が持つ。
それでも `-e` を保つ確認自体は残した——将来この `run: |` へ行が足されたときの
回帰を捕まえるのは、この歯だけだからである（防御の重ね掛け。詳細は同ファイルの
docstring）。

### 歯

- `scripts/__tests__/publish-gates.test.mjs`（判定関数の純関数試験。本体の
  `root-test-gate.test.mjs` と同じ形）
- `scripts/__tests__/run-publish-gates.test.mjs`（CLI を実プロセスとして起動する試験。
  `MNEMORA_PUBLISH_GATE_STAGES_JSON` というテスト専用の環境変数で、本物の
  `pnpm run typecheck` 等を一切起動せずに、偽の段（成功・失敗を選べる
  `node -e "process.exit(N)"`）に差し替える）
- `scripts/__tests__/publish-yml-gates-wiring.test.mjs`（配線の歯。`publish.yml` から
  実際の起動コマンドを取り出し、偽の段に差し替えてそのまま子プロセスとして起動する
  ——`publish-yml-dry-run-wiring.test.mjs` と同じ形）
- `scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs`（既存の歯を上記のとおり
  改修）

**【実測】変異試験**: `scripts/run-publish-gates.mjs` / `scripts/publish-gates.mjs` を
`cp` で退避したうえで、3種の変異を1つずつ当てた。

1. `-e` のまま（段の実行を、前段が失敗した時点で `break` する形に変える）→
   「2本目が失敗 ⟹ 3〜5本目も走る」の歯が赤くなった（3〜5本目に相当する偽の段の
   名前が出力に出なかった）。
2. **やりすぎた変異**（`gateExitCode()` を「全部走らせても常に0を返す」に書き換える）
   → 「2本目が失敗」「最後の1本だけ失敗」の歯、および純関数側の `gateExitCode` の
   歯4件が赤くなった。
3. 落ちた段の名前を出力しない（`summarizeStages()` から「失敗した段: …」の行を
   削る）→ 「2本目が失敗」の歯が赤くなった。

3種とも、`cp` で退避しておいた原本に戻し、`diff` で1バイトも差が無いことと、
対象の歯がすべて緑に戻ることを確認した。

### ⭐ テスト専用の差し替え口は、publish の workflow の中では断る

`scripts/run-publish-gates.mjs` は、歯が本物の `pnpm run test` / `build` を起動しないように、
環境変数 `MNEMORA_PUBLISH_GATE_STAGES_JSON` で段を偽の段へ差し替えられる。**リリースの門に
抜け道を残さないため、`GITHUB_WORKFLOW` が `Publish`（`publish.yml` の `name:`）のときは、
偽の段を1本も走らせずに exit 3 で断る。** 差し替えたときは「本物の門ではない」と出力で名乗る。

⚠ **`publish.yml` の門そのものが `pnpm run test` でこの歯を走らせる**ので、publish の job の中では
親の `GITHUB_WORKFLOW` が `Publish` になる。歯は子プロセスの `GITHUB_WORKFLOW` を明示的に
上書きして起動する（上書きを外すと、`GITHUB_WORKFLOW=Publish` の下で歯が4件赤になり、publish を
止めることを手元で確かめた）。

### ⛔ 確かめていないこと —— 本番の `publish.yml`（`workflow_dispatch` の `dry_run`）は走らせていない

**この追記を書いた担い手は、`gh workflow run` 等で `publish.yml` を GitHub 上で
一度も起動していない。予行（`workflow_dispatch` の `dry_run: true`）も含めて、
本番の Actions ランナー上でこの変更が動くことは実測していない。**

**理由**: **クローン（miku）の判断である**（2026-09-24）——予行（`dry_run: true`）で
あっても、publish の実行経路（Trusted Publishing / OIDC・tag の ancestor 検査・
`npm publish` まで含む一連）を担い手の手に置かない。これは `docs/autonomy.md` §3
「してはいけないこと」が挙げる「npm への publish・Release の作成・npm 側の設定」
そのものではないが、**同じ経路を1個の workflow ファイルの中で実際に動かす行為**
だからである。オーナー本人の判定ではない。

**代わりに何で確かめたか**: 上の「歯」節の4本（うち3本は本物の子プロセスとして
`node` を実際に起動する）と、`pnpm run lint` / `pnpm run format:check`。特に
`scripts/__tests__/publish-yml-gates-wiring.test.mjs` は、`publish.yml` のテキストから
実際に取り出した起動コマンド（`node scripts/run-publish-gates.mjs`）を、偽の段に
差し替えてそのまま子プロセスとして起動しており、「yml に書いてある文字列が、
確かに動く実行可能ファイルを指している」ことまでは実測している。**それでも、
GitHub Actions のランナー環境（`actions/checkout` 後の作業ディレクトリ・
`actions/setup-node` が整えた `PATH`・OIDC の `id-token` 等）の中でこの script が
実際に動くことは、この実測の範囲外である。**

⟹ **この変更を含む次の Release 作業（`v*` の Release を作る、または
`workflow_dispatch` の予行を走らせる）で、この門ステップが初めて本番の
Actions ランナー上を通る。** そのとき緑になることをもって、ここでの実測を
補うこと。赤くなった場合は、上の歯がすべて緑であるにも関わらず本番だけ落ちた
ことになるので、GitHub Actions のランナー環境固有の要因（`PATH` に `pnpm` /
`node` が無い等）を疑うこと。

### ADR 索引の再生成

この追記は既存 ADR（0210）への追記であり、新しい ADR ファイルを増やしていない
——ファイル名・1行目の見出し・状態欄はどれも変えていないため、
`docs/decisions/README.md` の生成済み索引（ADR 0137）は影響を受けない。
**【実測】`node scripts/generate-adr-index.mjs --check` を走らせ、再生成不要
（差分なし）であることを確認した。**
