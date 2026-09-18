# ADR 0245: `publish.yml` の門ステップが既定シェル（`bash -e`）で走るという前提を歯で縛る（Issue #476）

- **状態**: 草案（`docs/decisions/README.md` は触っていない——ADR 0137 決定2。索引はマージする側が直前に再生成する）
- **日付**: 2026-09-19

> **⚠ この判定は、自動化された担い手（クローンのマネージャーのセッション）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: クローンの署名は repo 上では `takecchi` になり、**オーナー本人と区別が付かない**
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が
> 要るなら、オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0241 / 0244 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git` / `node` / `vitest` を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

**測定条件**: 断りの無い【実測】は `origin/main` = `bcecc02`（本 ADR の作業を始めた時点）の木で、
2026-09-19 に行った。

---

## 文脈

[Issue #476](https://github.com/takecchi/mnemora/issues/476) は、
[ADR 0210](./0210-root-test-gate-runs-all-stages-regardless-of-failure.md) が
「同じ族は6箇所在り、直すのは2箇所」として数え直した表の**6番**
（`.github/workflows/publish.yml` の「Typecheck / Lint / Format / Test / Build」ステップ、
`shell` の `-e`）に住所を与えるために立った ISSUE である。表の逐語:

> | 6 | `.github/workflows/publish.yml` の「Typecheck / Lint / Format / Test / Build」ステップ
> （`run: \|` の5行、`bash -e` の既定） | shell の `-e` | 🔴 **触らない** —— リリース直前に
> 出荷経路（publish の一連）へ手を入れないという依頼者の明示指示による。この族に属することは
> 記録するが、直す判断はここでは行わない |

⛔ **Issue #476 の本文も、判定コメントも、逐語で「`publish.yml` を読んでいない」と名乗っている。**

本文（逐語）:

> 🔴 **`.github/workflows/publish.yml` を読んでいない。**「リリース直前なので publish の経路には
> 触らない」という依頼者の明示指示を受けているため。
> ⟹ **ステップの構成・`run: \|` が5行であること・`bash -e` が既定であることは、すべて
> ADR 0210 の記述をそのまま引いた【受】である。現物で検算していない。**

判定コメント（逐語、`takecchi` 名義。⚠ このアカウントはオーナー本人と担い手を区別しない
——[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)。
本 ADR はこのコメントを「オーナー本人の決定」としては読まない）:

> 🔴 **判定した側も `.github/workflows/publish.yml` を読んでいない。**
> ⟹ **この判定は、本文とまったく同じ【受】（ADR 0210 の記述）の上に立っている。**
> ⛔ **現物を読んだ人は、この判定の鎖の中に1人もいない。**
>
> ⚠ **`bash -e` が本当に既定であることを、誰も現物で確かめていない。**
> ⟹ 🔴 **もし `set +e` 相当が在れば、この判定は逆になる。**
> **判定の全体が、この1点に乗っている。**

⟹ **判定「⭕ `v1.0.0` を止めない」は成り立っているが、その根拠（現物で `bash -e` が
効いていること）は誰も確かめていなかった。**

## 【現物】今回、初めて `publish.yml` を読んだ。⛔ 1バイトも書き換えていない

本 ADR の作業で、`.github/workflows/publish.yml`（241行）を全文読んだ。分かったこと:

- 門ステップ（137〜147行目、「Typecheck / Lint / Format / Test / Build（非 DB の門を全部通す）」）
  は **`run: |` の5行**である（逐語）:

  ```yaml
  run: |
    pnpm run typecheck
    pnpm run lint
    pnpm run format:check
    pnpm run test
    pnpm run build
  ```

- **`shell:` の上書きが、ファイル全体に1つも無い。** 【実測】:

  ```
  $ grep -n "shell:" .github/workflows/publish.yml
  (該当なし。exit 1)
  ```

- **`defaults:` ブロックも無い。** 【実測】:

  ```
  $ grep -n "^defaults:\|^ defaults:\|^  defaults:" .github/workflows/publish.yml
  (該当なし。exit 1)
  ```

⟹ **上書きが無いので、GitHub Actions の既定シェルがそのまま効く。** GitHub Actions が
`run:` の既定として与えるコマンドは、Linux runner では
`bash --noprofile --norc -eo pipefail {0}` であり、**`-e` を含む**（2026-09 時点の GitHub の
既定。本 ADR が新たに確かめたのはこの逐語の値そのものではなく、「`publish.yml` 側にそれを
上書きする記述が無いこと」である）。

⟹ **【受】（Issue #476 判定の「`bash -e` が既定」という前提）は、現物の上でも成り立つ。**
判定「偽陽性の緑は起きない」は正しい。

⚠ **ただし、この【受】と【現物】が一致したことは、Issue #476 判定の他の【受】が正しいことを
何も言っていない。** 確かめたのは「`shell:` の上書きが無いこと」と「`defaults:` ブロックが
無いこと」の2点だけである——ADR 0210 の記述の他の部分（ステップの構成・`run: \|` が5行で
あること等）は、上の引用の通り今回も現物で個別に確認しており、それ以上の主張はしていない。

## なぜ「追認する」で終わらせないか

🔴 **判定が依存している前提（門ステップが既定シェルで走ること）は、いま何にも縛られていない。**
`shell: bash {0}`（`-e` を含まない自前テンプレート）を1行足すだけで、前段のコマンドが落ちても
ステップが緑のまま終わりうる——リリース経路に偽陽性の緑が戻る。**そして誰も気づけない**
——判定の根拠だった「`-e` が既定」という一文が、次の変更で黙って崩れても、それを検知する
仕組みが無い。

⟹ **前提を歯にする。** ⛔ `publish.yml` は直さない（リリース直前に出荷経路へ手を入れない、
という依頼者の明示指示は生きている）。**縛るだけ。**

## 決定

### 1. Issue #476 の判定（`v1.0.0` を止めない）を、現物の上で追認する

上の【現物】が示す通り、判定の根拠（`shell:` の上書きが無く、既定の `bash -e` が効く）は
現物でも成り立つ。⛔ **`publish.yml` は直さない。**

### 2. 判定が依存している前提を歯で縛る

**門ステップが既定シェル（`bash -e`）で走ること**——この前提が黙って崩れないようにする。
🔑 **これが本 ADR の中身である。**

`scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs` を置いた。ルートの
`vitest.config.mts` の `include: ["scripts/**/*.test.mjs"]` が拾い、required ジョブ
`typecheck / lint / test / build` の `pnpm run test`（`scripts/run-root-test-gate.mjs` の
段1、ADR 0210）で走る。⛔ **`ci.yml` は無変更。**

歯は5本の `it` を持つ:

1. **`publish.yml` を実際に読んでいる**（存在・1000文字以上・コメント潰しが `unhandled` を
   出していないこと）。
2. **門ステップが実在し、1つの `run:` ブロックに `pnpm run <名前>` が2本以上並んでいる**
   （陽性対照。1本しか無ければ「前段の失敗が後段を止める」性質そのものが意味を持たない）。
3. **`defaults:` ブロックが無い**（既定シェルを黙って差し替えていない）。
4. **⭐ 本体**: `shell:` の上書きが在るなら、値は `bash` / `sh`（どちらも既定が `-e` を含む）
   に限られる。`{0}` を含む自前テンプレート・`pwsh`/`powershell`/`python`/`cmd` は赤くする。
5. **門ステップが呼ぶ各 `pnpm run <名前>` が、ルートの `package.json` の `scripts` に実在する**
   （パスの書き間違いで静かに空回りしない）。

⚠ **全体を通じて、`blankOutWorkflowComments`（`scripts/workflow-comment-blank-lib.mjs`）で
コメントを潰した本文に対して判定する**——注釈の中に `shell:` という文字列があるだけで赤く
なる誤検出を避けるため（Issue #148/#155 と同じ判断）。

### 3. 縛るのは「`-e` を失う `shell:` の上書きが無いこと」だけ

門の中身・並び・`ci.yml` との一致は縛らない。下の「⛔ この歯が捕まえないもの」を見ること。

### 4. 新しい CI ジョブ・ステップを足さない

ルートの `vitest.config.mts` の `include` に相乗りする。
[ADR 0212](./0212-local-embedding-size-noun-correspondence-tooth.md) 決定6 /
[ADR 0244](./0244-runtime-method-doc-correspondence-tooth.md) 決定6 と同じ論拠——
新しいジョブを足すと CI の待ち時間が伸び、既存の門に乗せられる検査を乗せない理由が無い。

### 5. YAML パーサの依存を足さない

既存の workflow 検査の歯（`publish-yml-dry-run-wiring.test.mjs` /
`ci-yml-postgres-regime-wiring.test.mjs` 等）と同じ判断。依存追加はオーナー専権
（`docs/autonomy.md` / ADR 0014・0061）。⟹ **YAML は文字列として読む。書き方の変更に弱い**
——下の「引き受けた負債」に記す。

---

## ⛔ この歯が捕まえないもの

⚠ **検査が存在することは、それが何を保証するかを何も言っていない。**この節を消さないこと。

1. 🔴 **`run:` の中身が正しいかは見ていない。** 門ステップの並び順・過不足（`typecheck` /
   `lint` / `format:check` / `test` / `build` の内容そのもの・追加や削除）は縛らない。
2. 🔴 **`ci.yml` 側との一致は見ていない。** ADR 0210 が数え直した「族」（6箇所）そのものを
   塞いだわけではない——**塞いでいるのは「Issue #476 の判定の前提が黙って崩れること」だけ
   である。**
3. 🔴 **GitHub Actions が将来 `bash` / `sh` の既定から `-e` を外したら、この歯は嘘になる。**
   ⟹ 前提は「2026-09 時点の GitHub の既定」である。

⭐ **⟹ この歯が実際に止めるのは、`shell:` の上書きで `-e` を失う変更が `publish.yml` に
黙って入ること、1つだけである。** ⛔ **それ以上のことは主張しない。**

## 引き受けた負債

- **文字列で読んでいるので書き方の変更に弱い。** `run: |` ブロックの切り出し・`shell:` の
  値の抽出は正規表現であり、YAML の構造としては解釈していない。壊れたときは「配線が変わった」
  か「書き方が変わった」かを見分け、後者なら取り出し方のほうを直すこと（歯を消さないこと）。
- **GitHub の既定が変われば前提が崩れる。** 本 ADR が縛っているのは「`publish.yml` が既定を
  上書きしていないこと」であって、「GitHub 自身の既定に `-e` が含まれること」ではない
  ——後者は歯の射程外である。

## これが覆るとしたら何が起きたときか

- GitHub Actions が `bash` / `sh` の既定シェルコマンドから `-e` を外したとき
  （⟹ `ALLOWED_SHELLS` の前提が崩れる。歯を書き直す前に、この ADR と Issue #476 の判定
  そのものを引き直す必要がある）。
- `publish.yml` の門ステップを意図して1段ずつに割ったとき、または別のシェルへ意図して
  変えたとき（⟹ Issue #476 の判定「偽陽性の緑は起きない」の前提が変わるので、判定を
  引き直してからこの歯を更新すること。⛔ この歯を通すために門ステップを割ることを、
  この歯自身が目的化してはならない——それは別の判断であり、ADR 0210 の6番を読むこと）。

## 採らなかった案

### 1. `publish.yml` の門ステップを1段ずつに割る（＝族を本当に塞ぐ）

⛔ リリース直前に出荷経路へ手を入れない、という依頼者の明示指示による。ADR 0210 の6番
自身が同じ理由で「触らない」としている。

### 2. 何もしない（判定だけ追認して閉じる）

⛔ 判定の前提が何にも縛られていないままになる。**1行の書き換えで静かに崩れる**——それに
気づく仕組みが無いことが、本 ADR の出発点そのものである。

### 3. `ci.yml` の門と `publish.yml` の門が一致することを縛る

⛔ 別の主張であり、`ci.yml` を巻き込む。1 PR = 1 ADR に反する。

### 4. YAML パーサを入れて構造で読む

⛔ 依存追加はオーナー専権。既存の workflow 検査の歯と判断を揃える。

---

## 測ったこと / 確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

- 【実測】`grep -n "shell:" .github/workflows/publish.yml` — 該当なし（exit 1）。
- 【実測】`grep -n "^defaults:\|^ defaults:\|^  defaults:" .github/workflows/publish.yml`
  — 該当なし（exit 1）。
- 【実測】`.github/workflows/publish.yml` 全文（241行）を読んだ。門ステップの位置
  （137〜147行目）・`run: |` の5行を確認した。
- 【実測】`pnpm exec vitest run scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs`
  （変異前）— 5 passed。
- 【実測】**変異試験（3本。`cp` で退避・`cp` で復元。`git checkout` は使っていない）**:
  - **変異A**: 門ステップに `shell: bash {0}` を1行足す →
    `シェルを上書きしている段が在るなら、それは -e を保つ shell に限られる` が赤に。
    失敗メッセージ:
    ```
    .github/workflows/publish.yml が、既定シェルの -e を失う形で shell を上書きしている:

      142: shell: bash {0}

    ⟹ なぜこれが赤いのか: ...（本文どおり）
    ```
    戻すと5 passed。`git status --porcelain` 空。
  - **変異B**: `shell: bash`（`{0}` 無し）を足す → **5 passed のまま**（許容側を誤って
    赤にしていないことの確認）。戻すと `git status --porcelain` 空。
  - **変異C**: `pnpm run typecheck` を `pnpm run typechek`（綴り違い）にする →
    `門ステップ（非 DB の門を全部通す段）が実在し...` と
    `この歯が読んでいる publish.yml が、門を実際に走らせる段を持っている`（`it` 5）の
    **2本**が赤に（`it` 2 も道連れで赤くなる——門ブロックの検出そのものが
    `pnpm run typecheck` という文字列を錨にしているため。詳細は下の「確かめていないこと」
    直後の注記）。戻すと5 passed、`git status --porcelain` 空。
- 【実測】`pnpm exec eslint scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs` —
  エラー無し。
- 【実測】`pnpm exec prettier --check scripts/__tests__/publish-yml-gate-shell-wiring.test.mjs
docs/decisions/0245-publish-gate-shell-default-pinned.md` — 整形済み。
- 【実測】`node scripts/adr-renumber.mjs --next` — `0245`。
- 【受】Issue #476 の本文・判定コメントの逐語（`gh issue view 476 --json title,body,state`
  / `gh issue view 476 --comments`）。

### 確かめていないこと

- ⛔ **ルートの `pnpm run test`（全体）は走らせていない**（依頼元の指示どおり、新規テスト
  ファイル1本だけを走らせた）。
- ⛔ **CI（GitHub Actions 上の実行）そのものでこの歯を走らせて確認していない。** 手元の
  `vitest` 実行のみ。CI の緑は、この PR を出した後に別途確認すること
  （`docs/autonomy.md` §2.1）。
- ⛔ **GitHub Actions が実際に `bash --noprofile --norc -eo pipefail {0}` を既定として使う
  ことを、この repo の runner 上で実行して確かめてはいない。** これは GitHub の公開文書上の
  既定であり、この ADR が新たに確かめたのは「`publish.yml` 側にそれを上書きする記述が無い
  こと」だけである。
- ⛔ **`publish.yml` の門ステップの中身（`typecheck`/`lint`/`format:check`/`test`/`build`）
  が実際に正しく振る舞うかは確かめていない**（本 ADR の変更は `scripts/` のテスト1本と
  ADR 文書1本のみで、`publish.yml` 自体は1バイトも触れていない）。
- ⛔ **オーナー本人の確認は取っていない**（冒頭のバナーのとおり、これはクローンの判定
  である）。
