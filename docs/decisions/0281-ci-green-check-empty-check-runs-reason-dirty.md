# ADR 0281: `total === 0` の *理由* を `mergeable_state` で切り分ける——緑の根拠は変えない（Issue #615）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-23

**⚠ 各主張の出所を分ける**（[ADR 0210](./0210-root-test-gate-runs-all-stages-regardless-of-failure.md) /
[ADR 0215](./0215-ci-green-check-lower-bound-from-required-status-checks.md) と同じ体裁）。

- **【現物】** — この repo のコード・文書・設定を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で走らせて確かめた。
- **【受】** — 書き手が報告として受け取っただけで、自分では確かめていない。

---

## 問い

**`scripts/ci-green-check.mjs` が `total === 0`（check-runs が0件）を `pending` と判定するのは
正しい。だが、そのとき *添える理由* は正しいか。**

## 背景 —— [Issue #615](https://github.com/takecchi/mnemora/issues/615)

**【受】** Issue #615 は、`docs/decisions/README.md`（ADR 索引）の再生成 PR
（[PR #612](https://github.com/takecchi/mnemora/pull/612)）が base と衝突した状態で push され、
CI の check が1本も作られないまま20分（`d03a4a0`）・22分（`3d551ab`）、**計42分**を
ポーリングに費やした実測を報告している。

**機序【受・Issue本文】**:

```
$ gh api repos/takecchi/mnemora/pulls/612 --jq '{mergeable, mergeable_state}'
{"mergeable":false,"mergeable_state":"dirty"}
```

**base と衝突している ⟹ GitHub は merge ref（`refs/pull/612/merge`）を作れない ⟹
`pull_request` の workflow run が作られない。** check-runs は「まだ走っていない」のではなく
「走れない」——両者は API 上で区別できない（どちらも空配列）。

**【現物】確かめた**——`scripts/ci-green-check-lib.mjs` の `verdict()` は `total === 0` を
明示的に `pending` として扱っており（この点は Issue のコメントが自分で訂正している：
「本文が懸念した『空集合に対する全称命題で緑と読む』形は、この道具には無い。道具は安全側に
倒れている」）、**偽の緑は出さない。**

**🔴 だが、添える理由は次のとおりだった**（本 PR での変更前・逐語）:

```
check-runs が0件——まだ登録されていない可能性がある（Issue #228 観測1）
```

**この文言は読む側に「待て」と勧める。しかし `mergeable_state: "dirty"` のときは、待っても
永久に来ない**（merge ref が作れない以上、run は作られない）。⟹ **道具は、真逆の一手を
勧めている。**

**【現物】確かめた**——`mergeable`/`mergeable_state`/`dirty` は、変更前の
`scripts/ci-green-check.mjs` にも `scripts/ci-green-check-lib.mjs` にも1箇所も現れない
（`grep -cE "mergeable|dirty"` が両ファイルとも `0`）。⟹ **区別する材料を、そもそも取っていない。**

## オーナーの決定

Issue #615 は3つの案を並べた（A: 道具が `mergeable_state` を引いて理由を分岐する／B: 文書に
書くだけ／C: A + B）。**オーナーは案C（道具＋文書）を採ると決めた。**本 ADR は、その実装の記録である。

**Issue #615 自身が、検知と予防を明示的に分けている**——本 ADR が扱うのは**検知**
（0件の理由を正しく名乗ること）だけである。**予防**（ADR 採番・索引の直列化そのもの）と、
観測3（CHANGELOG に `[1.0.0]` 以降の変更を積む場所が無いこと）は、**Issue #615 が
「ここでは決めない」と明記しており、本 ADR も決めない。** Issue #615 は本 ADR のマージ後も
開いたままにする（予防側が未決のため）。

## 🔴 次の3点は、この ADR の核であり、削らない

### 1. ⛔ 緑の *根拠* は1バイトも変えない

`docs/autonomy.md` §2.1 の3番「`mergeStateStatus` を判定に使わない」は、そのまま生かす。
**この ADR が使うのは「0件の *理由*」であって「緑の *根拠*」ではない。** `verdict()` が
`green`/`red` を返す条件（`summarizeCheckRuns`/`summarizeRequiredContexts` の判定ロジック）は
1行も変えていない——変わるのは `total === 0` のときに `pending` へ添える `reason` の
文字列だけである。

**⟹ これを書かないと、この ADR は「3番を緩めた」と読まれる。それはオーナーが許可していない。**
【実測】`git diff` で確認済み——`green`/`red` を決める分岐（`requiredSummary.missing`・
`summary.allCompleted`・`requiredSummary.nonSuccess`・`summary.allSuccess` の4つの `if`）は
1文字も変更していない。変更は「`total === 0` の1つの `if` ブロック内の `reason` の値」のみ。

### 2. ⛔ 何を防がないか（射程）

- **衝突そのもの。** 予防（直列化）は別の層であり、Issue #615 が「決めない」と明記している。
  本 ADR は、衝突が**起きたあとに、それを来ない run の待機と取り違えないこと**だけを扱う。
- **番号を奪われること。** ADR 採番の衝突（Issue #615 観測2）は、この ADR の射程外。
- 🔴 **`mergeable_state` が `"unknown"` のときの切り分けは未検証。** GitHub が
  mergeability をまだ計算中のときに `unknown` を返すことは知られているが、
  **その状態で `pull_request` の run が作られるかどうかは、このセッションでも
  Issue #615 でも確かめていない。** ⟹ だから `unknown` は `dirty` と同じ扱いにしない
  （下の「決定」参照）。

### 3. ⛔ 引き受ける負債

- **GitHub API を1回余計に引く。** `--pr` 実行時、`total === 0` の窓に入ったときだけ
  `gh api repos/<owner>/<repo>/pulls/<番号> -q .mergeable_state` を追加で呼ぶ
  （常時ではなく、必要なときだけ——`total === 0` でなければ呼ばない）。
- **分岐が増える。** `describeEmptyCheckRunsReason()` に `dirty`/`unknown`/それ以外の
  3方向の分岐が増えた。
- 🔴 **`mergeable_state` の値と「run が作られない」の対応は n=2 の観測でしか裏づけられて
  いない。** Issue #615 の実測は `d03a4a0`/`3d551ab` の2件、どちらも `dirty` で
  check-runs が0件のまま変わらなかった、というだけである。

  ⟹ ⭐ **後から n が増えて対応が崩れたら、この ADR は覆る。** 例えば「`dirty` のまま
  run が作られた」実例が1件でも観測されれば、本 ADR の「機序」節の前提（merge ref が
  作れない ⟹ run が作られない、を `mergeable_state` の値から一意に判定できる）が崩れ、
  `describeEmptyCheckRunsReason()` の `dirty` 分岐の文言（「待っても来ない」と言い切る）
  を再検討する必要がある。

## 検討した選択肢

### 案X: `mergeStateStatus`（GraphQL、大文字）を使い回す

⛔ **採らない。** `resolvePrHead()` が既に取得している `mergeStateStatus` を流用すれば
API 呼び出しは増えないが、**Issue #615 の実測は REST の `mergeable_state`（小文字）に
基づいている**（`gh api repos/.../pulls/612 --jq '{mergeable, mergeable_state}'` の
逐語）。GraphQL の `MergeStateStatus` enum（`DIRTY`/`UNKNOWN`/`CLEAN` 等）と REST の
`mergeable_state`（`dirty`/`unknown`/`clean` 等）が同じタイミングで同じ値を返すかは
**確かめていない**。実測の裏付けがある側（REST）に合わせ、API 呼び出しが1本増えることを
負債として引き受けた。

### 案Y: `unknown` も `dirty` と同じ理由にする

⛔ **採らない。** Issue #615 自身が「これは未検証」と明記している
（`unknown` のときに run が作られるかは確かめていない）。**同じ扱いにすると、
確かめていないことを確かめたかのように言い切ることになる**——AGENTS.md
「確かめていないことは『確かめていない』と書く」に反する。

### 案Z（採用）: `dirty` だけを特別扱いし、それ以外（`unknown` を含む）は現状維持

⭐ **これだけが、実測の裏付けがある範囲だけを主張する。** `unknown` は「まだ登録されて
いない可能性がある」という従来の理由のままにし、待つことを禁じない——安全側に倒す。

## 決定

### 1. `ci-green-check-lib.mjs`（純関数）は `mergeable_state` を**引数として**受け取る

`verdict(checkRuns, requiredContexts, mergeableState)` とし、**第3引数は省略可能**
（`undefined`/`null` を「不明」として扱う）。既存の呼び出し側（テストを含む）は
第3引数を渡さなくても、これまでどおりの結果を返す——**壊さない。**

`total === 0` の理由だけを、新しいヘルパー `describeEmptyCheckRunsReason(mergeableState)`
に切り出した:

- `mergeableState === "dirty"`: 「base と衝突しており（`mergeable_state=dirty`）、
  GitHub が merge ref を作れないため run 自体が作られない（Issue #615 実測）。
  待っても来ない——base を取り込み直して衝突を解くこと。」
- `mergeableState === "unknown"`: 🔴 **`dirty` と同じ扱いにしない。**
  従来の理由（「まだ登録されていない可能性がある」）のまま。
- それ以外・`null`/`undefined`: **従来の理由のまま**（劣化を黙ってやらない——
  取得できなかったなら、取得できなかったときの振る舞いを保つ）。

### 2. I/O（`gh api` を叩く）は CLI（`ci-green-check.mjs`）側に置く

`fetchMergeableState(repo, prNumber)` を CLI 側に追加した。**`total === 0` かつ
`--pr` が指定されているときだけ**呼ぶ（`--sha` 直指定では PR が無いため呼びようがなく、
呼ばない——従来どおりの理由のままになる）。取得に失敗したら `null` を返し、
`verdict()` にはそのまま `null` を渡す（「取得できなかった」を「衝突している」に
すり替えない）。

**これは `resolvePrHead()` が既に取っている `mergeStateStatus`（GraphQL、大文字）とは
別の値であり、別の `gh api` 呼び出しである**——上の「検討した選択肢」案X を参照。

### 3. 緑の判定ロジックは変更しない

`green`/`red` を決める4つの分岐（`requiredSummary.missing`・`summary.allCompleted`・
`requiredSummary.nonSuccess`・`summary.allSuccess`）は1行も触っていない。
`docs/autonomy.md` §2.1 の3番（`mergeStateStatus` を判定に使わない）はそのまま。

### 4. CLI の終了コードは変更しない——`pending`（`2`）のまま

**検討した**: `dirty` と判明したときに専用の終了コード（例: `4`）を新設する案。
**採らなかった。** 理由は ADR 0215 決定4 と同じ構造:

1. **意味論が合っている。** `dirty` で run が作られない状態は、機械的には
   「まだ緑とも赤とも判定できない」以外の何物でもない——それが `pending`（`2`）の
   意味そのものである。この道具は「マージしてよいか」だけを判定するのであって、
   「衝突を解決せよ」という*確定した次の一手*を主張する立場にはない
   （AGENTS.md「機械には『検出』まで——確定と書き込みは人に残す」）。
2. **`reason` の文言だけで問題は解決する。** 元の不具合は「`pending`（待て、の含意）を
   返すこと」自体ではなく、「`pending` に添える理由が、来ない run を待てと勧めること」
   だった。理由を直せば、終了コードを増やさなくても「待てと読める出力」は無くなる。
3. **追随先を増やさない。** `docs/release-v1.md` §0.1・`docs/autonomy.md` §2.1・
   ADR 0132・ADR 0215 の4箇所が既に「`0`=green・`1`=red・`2`=pending・`3`=実行時エラー」
   を前提にしている。新しいコードを足すと、この4箇所すべてに追随の要否を検討する
   負担が生まれる。

⟹ **`dirty` と判明しても、CLI は `exit 2` のまま。** ただし `--recheck-after` を渡していても、
`v1.status === "pending"` のままなので**再ポーリング（sleep）には入らない**——これは
本 ADR で変えた挙動ではなく、既存の「`recheckAfter` は `pending` のときは走らせない」
ロジックがそのまま効いている（`if (args.recheckAfter != null && v1.status !== "pending")`）。
⟹ **`dirty` の場合、道具は「待て」と言う出力もしなければ、実際に待ちもしない。**

## 結果（この決定が招くもの）

- `--pr` 実行で `total === 0` の窓に入ったときだけ、`gh api .../pulls/<番号>` の
  呼び出しが1本増える（前述の負債）。
- `describeEmptyCheckRunsReason()` という新しい純関数が増え、`verdict()` の
  シグネチャに第3引数が増える（省略可能）。
- **文書側**: `docs/autonomy.md` §2.1 に8番を追加し、「これは判定ではなく0件の理由の
  切り分けである」と明記した。3番（`mergeStateStatus` を判定に使わない）は書き換えて
  いない。

## これが覆るとしたら

- **`mergeable_state` と「run が作られない」の対応が崩れたとき**（前述、n=2 の負債）。
  `dirty` のまま run が作られた実例が観測されれば、`dirty` 分岐の文言を見直す必要がある。
- **`unknown` のときに run が作られない実例が確かめられたとき。** そのときは
  `unknown` にも `dirty` と同様の理由を与える拡張ができるが、**それは今回やらない**
  ——確かめていないことを確かめたかのように書かないため。
- **GitHub が REST `mergeable_state` の enum 値を変えたとき**（例: 新しい値の追加）。
  `describeEmptyCheckRunsReason()` は未知の値を「それ以外」として扱い、従来の理由に
  留めるので、**未知の値で誤って衝突と言い切ることはない**——安全側に倒れる設計である。

## 確かめたこと・確かめていないこと

- **確かめた**【実測】: 変更前の `scripts/ci-green-check-lib.mjs`・`scripts/ci-green-check.mjs`
  に `mergeable`/`dirty` の文字列が1箇所も無いこと（`grep -cE "mergeable|dirty"` が
  両ファイルとも `0`）。
- **確かめた**【実測】: 赤→緑の実測。`verdict([], ["a"], "dirty")` に「待て」と読める
  文言（「まだ登録されていない」「可能性がある」）が無く、「衝突」を含むことを検査する
  歯を先に書き、実装前に赤くなることを確認した（`AssertionError: expected '...まだ
  登録されていない可能性がある...' not to contain 'まだ登録されていない'`）。実装後、
  同じ歯が緑になった（`scripts/__tests__/ci-green-check-lib.test.mjs`・
  `scripts/__tests__/ci-green-check.test.mjs` 合わせて30件 pass）。
- **確かめた**【実測】: 変異試験・足りない側。`describeEmptyCheckRunsReason()` を
  常に旧来の理由だけを返す形に潰すと、`⭕ dirty: 待てと読める文言を含まず…` の歯が
  `expected '...まだ登録されていない可能性がある...' not to contain 'まだ登録されて
  いない'` で赤くなった。
- **確かめた**【実測】: 変異試験・やりすぎ側。`if (mergeableState === "dirty")` を
  `if (mergeableState === "dirty" || mergeableState === "unknown")` に広げると、
  `⛔ やりすぎの側: unknown は dirty と同じ扱いにしない` の歯が
  `expected '...衝突...' not to contain '衝突'` で赤くなった——**契約の両側に歯が
  効いている。**
- **確かめた**【実測】: 上記2つの変異は `cp` で退避・復元し、`diff` で復元後のファイルが
  実装後の版と完全に一致することを確認した上で戻した。`git status --porcelain` は
  最終的に、意図した3ファイル（lib・CLI・テスト）の変更だけを示す。
- **確かめた**【実測】: 巻き込みが無いこと。`scripts/__tests__/` 配下86ファイル
  （1件は元々 skip）全件、1552 件 pass（2件 skip）。
- **確かめた**【実測】: CLI 全体を、偽の `gh` を `PATH` に置いて end-to-end で撃った。
  `mergeable_state=dirty` かつ check-runs 0件 ⟹ `status=pending`・reason が
  「衝突」を含み「待って」の含意を含まない・`exit 2`。`mergeable_state=unknown` ⟹
  reason は従来どおり・`exit 2`。`--sha` 直指定（PR 無し）⟹ `pulls/<番号>` を一切
  呼ばず、従来どおりの理由・`exit 2`。check-runs が揃って success ⟹
  `status=green — 1件すべてが completed かつ success`・`exit 0`（文言・終了コードとも
  変更前と同一）。
- 🔴 **確かめていない**: `mergeable_state === "unknown"` のときに実際に
  `pull_request` の run が作られるかどうか（Issue #615 も未検証としている）。
- 🔴 **確かめていない**: `mergeable_state` の値と「run が作られない」の対応は
  n=2（Issue #615 の実測）のままであり、このセッションで新たに実測は増やしていない。
- 🔴 **確かめていない**: この PR の CI が緑になること（CI 側の結果を見るまで確認できない）。
- 🔴 **確かめていない**: `gh pr view --json mergeStateStatus`（GraphQL）と
  `gh api .../pulls/<番号> -q .mergeable_state`（REST）が、同じ PR・同じ瞬間に
  対応する値（`DIRTY`/`dirty` 等）を返すかどうか。今回は実測の裏付けがある REST 側を
  採用したため、この対応関係そのものは検証していない。

## ⚠ 安全側に倒れていても害はある——沈黙も誤誘導になりうる

**Issue #615 が訂正した点を、ここでも明記する。**`ci-green-check.mjs` は最初から
偽の緑を出していない——**安全側の判定そのものは正しかった。** それでも実害
（計42分の待機）が出たのは、**判定が安全側でも、添える理由が誤った次の一手を
勧め得るからである。** ⟹ **「偽陽性を出さない」ことと「読む側を正しい行動へ導くこと」は
別の性質であり、前者を満たしても後者が満たされるとは限らない。** 沈黙（理由を
名乗らない）も、誤った理由を名乗ることも、どちらも読む側を誤らせ得る——
この ADR が直したのは後者である。
