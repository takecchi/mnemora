# ADR 0333: Issue #109 残件 A・C — 識別子2群の判定候補と `intrusionMargin` の定義候補を実測で比較する（B は範囲外）

- **状態**: 提案 (2026-09)
- **日付**: 2026-09-25

> **⚠ この ADR を書いているのは、マネージャー（クローンのセッション）から切り出された
> 作業者である。⛔ オーナー本人の決定ではない。**投稿者欄・commit の著者欄が誰であっても、
> それだけでは人間かクローンかを区別しない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> **ここに書く判断はすべて「クローン miku の判断（オーナーではない）」であり、
> オーナーの確認・承認を得たものではない。**

**⚠ 各主張の出所を分ける**（ADR 0316/0321/0322 の体裁を踏む）。

- **【実測】** — 実測担当の作業者（ブランチ `measure/109-identifier-verdict-candidates`・
  `measure/109-intrusion-margin-candidates`）が、自分の手で実 API・本物の Postgres 17 +
  pgvector（`initdb` の自分専用インスタンス）に対して走らせた。この ADR の担当者自身は
  再導出していない部分を含む——その場合はその旨を明記する。
- **【現物】** — この repo のコード・文書を、この ADR の担当者が自分で読んで確かめた
  （cherry-pick したコミットの diff・JSON 生成物を `node -e` で読んで数字を突き合わせた）。
- **【受】** — マネージャー・実測担当者からの報告として受け取り、この ADR の担当者は
  再導出していない。

---

## 0. Issue #109 残件の仕分け — A・B・C（B はこの ADR の範囲外）

Issue #109 の最新コメント「残っているもの」は次の4項目を挙げている【現物、
`gh issue view 109 --comments` で確認】:

1. 識別子2群の判定をどうするか（margin に基づく判定、多数決など）。未着手。
2. 門にする判断（required の変更）。オーナーの領分。
3. `intrusionMargin` の定義の欠陥（ADR 0291 §5.5）。
4. ADR 0322 で sparse と dense の結果が全く同じになる原因（仮説のみ、未確認）。

**この ADR が扱うのは 1（＝A）と 3（＝C）だけである。**

- **2（＝B、門にする判断・`required` への変更）は、この ADR では一切扱わない。**
  `docs/decisions/0254-no-gate-without-a-false-positive-ceiling.md` と `AGENTS.md`
  「⚠ 偽陽性率に上限を置けない検査は門にしない」が示すとおり、CI ジョブを required に
  昇格する判断は branch protection の変更を伴う——**オーナー領分である**（ADR 0274 が
  同種の branch protection 変更をオーナー領分と扱っている前例に倣う）。
- **4（sparse/dense が完全に同じ結果になる原因）は、この ADR では扱わない。**PR #788
  （ADR 0322 の追記）が候補の突き合わせで既に確かめた（red/green 判定は165/165一致、
  MRR 実値は σ が上がると分岐する）。

**素材**: A は branch `measure/109-identifier-verdict-candidates`（commit `f7f6959`）、
C は branch `measure/109-intrusion-margin-candidates`（commit `6bc0f3d`）。両方ともこの
ADR のブランチへ cherry-pick 済みであり、既存ファイルへの変更は1つも含まない
（`git show --stat` で両コミットとも新規ファイルのみであることを確認済み）。

---

## 1. 検証方法 — 数字は JSON の実物と突き合わせた

以下の数字はすべて、cherry-pick 後のコミット済み JSON（`examples/chat/*.json`）を
`node -e` で読み直し、実測メモ（`results-A.md`/`results-C.md`、この ADR の担当者の外に
ある一時ファイルであり repo には含まれない）の記載と一致することを確認した値である。

**⚠ 突き合わせで1件、実測メモ側の誤記を見つけた**——`results-A.md` は追加した3ファイル
（`verdict-candidate-margin.test.ts`・`verdict-candidate-kofn.test.ts`・
`local-noise-margin.test.ts`）の合計を「38件」としているが、実行し直すと
**10 + 18 + 7 = 35件**である（`verdict-candidate-kofn.test.ts` は `it(` が18個であり、
メモの「21件」は誤り）。**この ADR は実行し直した値（35件）を採る。**
`intrusion-margin-candidates.test.ts`（19件）は突き合わせて一致した。

```
$ npx vitest run src/__tests__/verdict-candidate-margin.test.ts \
    src/__tests__/verdict-candidate-kofn.test.ts \
    src/__tests__/local-noise-margin.test.ts \
    src/__tests__/intrusion-margin-candidates.test.ts
 Test Files  4 passed (4)
      Tests  54 passed (54)   # 10 + 18 + 7 + 19 = 54
```

---

## 2. A — 識別子2群（ASCII identifiers sparse/dense）の判定候補

### 2.0 前提（【現物】）

- **`decideEmbeddingDriftVerdict`（`examples/chat/src/openai-arm-verdict.ts`）は、CI の
  どのジョブからも直接呼ばれていない。** 呼び出し元は手動スクリプト
  （`scripts/openai-embedding-fp-ceiling.ts`・`scripts/local-embedding-synthetic-noise-fp.ts`、
  後者は内部で `synthetic-score-noise.ts` の `decideNoiseRoundRed` を使う）だけである。
- **CI の Job Summary に実際に出る「並走の判定」は、`scripts/openai-arm-summary-lib.mjs`
  の `decideShadowVerdict`/`buildShadowVerdictSection` という、別ファイルへ手で複製した
  実装である。** この `.mjs` は `tsx` を通さず CI で直接 `node` 実行されるため
  `openai-arm-verdict.ts` を import できず、閾値定数（`MRR_DROP_THRESHOLD = 0.01`）を
  手で二重管理している——同ファイルの doc コメント自身が「値を変えるときは両方直すこと」
  「片方だけ変えてもどちらの歯も検出できない」と明記している。**⟹ 案1/2を実際に CI の
  表示へ効かせるには、`examples/chat/src/` 側だけでなく `scripts/openai-arm-summary-lib.mjs`
  （と `scripts/__tests__/openai-arm-summary-lib.test.mjs`）を書き換える必要がある。**
- **`identifier-probes`/`numeral-token-probes` ジョブの local 5+2群側
  （`scripts/identifier-probe-summary-lib.mjs`）には red/green の判定関数が無い**
  （`buildDiffSection` による基準値との差分表だけ）——この案の対象外。
- **ADR 0316 本文と実物の食い違い**: ADR 0316 §「測ったこと」は「identifier probe の
  margin 分布は `identifier-probe-baseline.openai.json` の `marginStats` を見ること」と
  書いているが、**実物の `identifier-probe-baseline.openai.json` に `marginStats` という
  フィールドは存在しない**（`grep -c "marginStats"` で0件を確認済み。同ファイルは
  `groups` 配列に群レベルの集約値だけを持つ）。**バグなのは実装側**（`AGENTS.md`「正典と
  実装が食い違ったら、バグなのは実装のほう」の適用対象は北極星文書だが、同じ考え方を
  ここでも採る——ADR 本文が指す値が実際には出力されていない、という食い違いであり、
  ADR 本文の記述の是非そのものはこの ADR では判断しない）。この食い違いの経緯（実装側の
  欠落なのか、ADR が別バージョンを指しているのか）は確かめていない。

### 2.1 実データの再利用可否

既存の集計 JSON（`openai-embedding-fp-ceiling-measurement.json`、ADR 0316 測定B）は
群レベルの集約値だけを round ごとに持ち、probe ごとの margin を保存していない
（`measureGroup` が `report.probes` を捨てて `ProxyGroupMetrics` だけを返すため）。
**⟹ 案1（margin基準）を識別子2群の実 OpenAI 埋め込みデータで検証するには、per-probe
margin を新たに捕捉する測定が要ると判断し、実 API を使った**（既存関数は1文字も変えず、
`report.probes` を捨てずに保存する新しいスクリプトを追加した）。一方、案2（k-of-n）と、
`local` 埋め込みに対する案1の検証は、既存にコミット済みの測定Bと ADR 0322 の反実仮想
データを読むだけの後処理であり、実 API を使っていない。

### 2.2 候補案の定義

**案0（現行、比較の基準）**: ADR 0316 の `decideEmbeddingDriftVerdict` そのまま——hit@1 が
基準値の件数を1件でも下回ったら red、または MRR が基準値から0.01以上落ちたら red。

**案1（margin基準、`verdict-candidate-margin.ts`）**: hit@1 という二値ではなく、margin
（gold−distractor の類似度差）という連続値の「縮み幅」を見る。

- 単位: baseline(round0) の margin の標本標準偏差（`computeMarginStats`、
  `identifier-arm.ts`、変更していない、を呼ぶだけ）。識別子群と数詞群で margin の絶対
  スケールが違うため、相対単位にした。
- **閾値（測定前に固定。後出しにしない）**: `stdDevMultiplier = 3`（変化検知で一般的に
  使われる目安であり、この repo・この測定に固有の値ではなく外部の一般的な目安をそのまま
  採用）、`minShrunkProbes = 2`（1件では red にしない——現行の hit@1 判定がまさに
  「1件でも」で高FP率を出しているため、そこを緩めるのがこの案の趣旨）。
- baseline margin の標本標準偏差が定義できない（`count<2` または `stdDev===0`）ときは
  red にしない（「比較できない」を「悪化した」と同じ顔にしない）。
- **これらの数値は、識別子2群の実測 margin 分布を見る前に決めた**（コード化してから
  実測スクリプトを走らせた）。

**案2（k-of-n、`verdict-candidate-kofn.ts`）**: (a) sparse/dense 一致（追加録画なしで
CI に実装できる）、(b) N本の独立な録画のうちk本以上（**CI が1本のカセットを再生するだけ**
という現行構造と相性が悪く、N本の独立なカセットをあらかじめ録画してコミットする必要が
ある——録画コストがN倍になる）。

### 2.3 数字（新規測定 K=60、実 API。JSON と突き合わせ済み）

| 群 | 案0 red/60 | 上限95% | 案1(margin) red/60 | 上限95% |
|---|---|---|---|---|
| identifiersSparse | 7 | 20.80% | **0** | **4.87%** |
| identifiersDense | 7 | 20.80% | **0** | **4.87%** |
| japaneseNamesSparse | 0 | 4.87% | 0 | 4.87% |
| japaneseNamesDense | 0 | 4.87% | 0 | 4.87% |
| numeralSparse | 0 | 4.87% | 0 | 4.87% |
| numeralDense | 0 | 4.87% | 0 | 4.87% |
| **6群合算** | 7/360 | — | **0/360** | **0.83%**（閉じた式 `1-0.05^(1/360)`） |

比較のための既存データ（ADR 0316）: 測定A(K=59) 22/59(48.80%)、測定B(K=59) 11/59(28.97%)、
合算(K=118) 33/118(35.56%)。**今回の新規測定(K=60)の7/60は、既存2回(22・11)と同じ桁の
ばらつきを示した**——独立な追加標本であり、上限を低く置けないという ADR 0316 の結論と
整合する。

**⟹ 識別子2群について、案1は今回の実測で偽陽性を0件にし、上限（4.87%）が ADR 0316が
「上限を置けた」とした4群と同じ水準に達した。**

**local 反実仮想（ADR 0322 と同型、σ11段×seed15）でも同じ傾向**: identifiersSparse/Dense・
numeralSparse/Dense・japaneseNamesSparse/Dense のいずれも、小さい σ（無害な揺れの領域）で
案1が案0より一貫して低い red 率を示し、σ=0.08 以降（baseline hit@1 が既に大きく崩れている
水準）で案0に追いつく。

**k-of-n（案2）**: sparse/dense 一致は**両方の実測データセットで効果ゼロ**——red 集合が
完全に一致した（既存59巡: 11/11、新規60巡: 7/7、`exactlyOneRed=0`件。JSON の
`sparseDenseAgreements` で確認）。ADR 0316 の「実質的に独立な信号は6本ではなく3本」という
指摘の直接の裏付け。N本委託録画は点推定こそ改善する（既存59巡: 単独11/59=18.6%上限28.97%
→ 2-of-2実測1/29=3.4%上限15.3%、3-of-3実測0/19=0%上限14.6%。新規60巡: 単独7/60=11.7%
上限20.80% → 2-of-2実測0/30上限9.5%、3-of-3実測0/20上限13.9%。理論値(p=28.97%のCP上限を
代入): 2-of-2→8.39%、3-of-3→2.43%、5-of-5→0.20%）が、**窓の数自体が少なく、上限はまだ
10〜15%台に留まる**——点推定の改善と、上限を置けたと言えるかは別問題。

### 2.4 感度（見逃していないか）

- local反実仮想の陽性対照（σ=5.0、格子外）: 案0・案1とも全群で15/15 red（探り棒は生きている）。
- 実測(OpenAI) margin を土台にした変異: probe **1件**を baseline標準偏差の6倍縮める変異
  → red=false（`minShrunkProbes=2` により想定通り）。probe **2件**を同じだけ縮める変異
  → **red=true**（陽性対照成功）。
- **⚠ 懸念点**: ADR0322の7群のうち `japanese`（意味probe7件、識別子2群とは別の群）では、
  案1は中間的な劣化（σ=0.08〜0.24）で案0より明確に感度が低い（σ=0.08: 案0=15/15 vs
  案1=0/15、σ=0.12: 15/15 vs 4/15、σ=0.24: 15/15 vs 12/15、σ=0.32でようやく15/15に追いつく。
  local反実仮想JSONで確認済み）。probe数が7件と少なく、baseline margin の標本標準偏差の
  推定自体が不安定なためと推測するが、**確認していない**。**今回の主対象である識別子2群・
  数詞2群・日本語固有名詞2群では、この「中間劣化の見逃し」は観測していない**（σ=0.08で
  全群案0に追いつく）——ただし群数が少ないため、他の群でも同型の弱点が無いとは言い切れない。

### 2.5 既存CI判定への影響

`decideEmbeddingDriftVerdict` 自体は CI のどこからも呼ばれていない（§2.0）ため、今回の
候補案をコード化しても既存 CI 経路への接続は1つも行っていない。**案1/2を実際に CI の
表示に反映するなら、次のファイルを書き換える必要がある**:

- `scripts/openai-arm-summary-lib.mjs`（`decideShadowVerdict`/`buildShadowVerdictSection`
  の閾値・判定ロジックそのもの）
- `scripts/__tests__/openai-arm-summary-lib.test.mjs`（対応するテスト）
- 案2（N本委託録画）を採用する場合は、CI ジョブの構造自体（カセット本数・cache キー・
  実行時間）への設計変更が別途要る——この実測ではその設計まで踏み込んでいない。

`.github/workflows/ci.yml`・`identifier-probe-summary-lib.mjs`（local 5+2群側）には
触れていない。

### 2.6 実 API 使用量・可逆性

**使用量**: embed 呼び出し**61回**・**746,457トークン**・概算費用**$0.014929**
（`text-embedding-3-small` 公開価格。JSON の `cost.totalUsd` で確認）。上限$0.30の約5%。
**新規カセットは1つも書いていない**（round ごとのカセットはメモリ上だけで使用、ディスクに
保存していない）。既存カセット（`identifier-probes.openai.json` 等）は1バイトも触れていない。

**可逆性**: 追加した全ファイルは新規ファイルであり、既存ファイルへの変更は無い
（`git show --stat f7f6959` で確認）。このコミットを revert すれば Issue #109 以前の状態に
完全に戻る。将来 CI へ配線する場合も、`scripts/openai-arm-summary-lib.mjs` へ**並走の判定
として追加**（既存の案0の判定はそのまま残し、新しい列/行を追加する形）にすれば、既存の
表示を壊さずに比較を続けられる。

---

## 3. C — `intrusionMargin` の定義候補

### 3.0 現状の使われ方（【現物】）

`intrusionMargin` は `examples/chat/src/correction-candidate-arm.ts`
（`computeIntrusionMargin`）・`correction-candidate-json.ts`・
`scripts/correction-candidate-probe-summary-lib.mjs`・
`correction-candidate-probe-baseline.json`・`examples/chat/README.md`・直下 `README.md`・
`docs/decisions/README.md`（ADR 0321 の1行要約）に現れる。**CI の基準値比較には入っている
（`DIFF_FIELDS` に `summary.intrusionMarginStats.count/mean/stdDev/min` が含まれる）が、
非 gate である**——`correction-candidate-probe-summary-lib.mjs` 自身の docstring が
「🔴 基準値ファイルと相違しても exit 0 のままである。⛔ このスクリプトは門ではない」と
明記し、実際に `process.exit(0)` で終わる（`DIFF_FIELDS`・該当コメント、`grep` で確認済み）。
`correction-candidate-probes` ジョブ自体も non-required（`.github/required-status-checks.json`
に載っていない）。**⟹ `intrusionMargin` の値が変わっても CI が赤くなることは無い。**

### 3.1 現行（常に0）と `protectionMargin` の実測分布

**案0（現行）**: `intrusionMargin = topScore − protectedFactScore`。深い誤爆
（`protectedAtTop===true`）のときだけ定義。**今日のB群32件は全ケース `protectedFacts`
が0〜1件しか無いため、深い誤爆のとき `topScore === protectedFactScore` となり、
`intrusionMargin` は常に0**（実測 n=20 mean=0 stdDev=0 min=0 max=0——コミット済み
`intrusion-margin-candidates-measurement.json` の `candidates["0_current_intrusionMargin"]`
で確認済み）。

**案1/2（数値は同一）: `protectionMargin = protectedFactScore − topNonProtectedScore`**。
`topNonProtectedScore` は保護対象でない候補の中の最大スコア。`protectedFacts` が1件以上
返っていれば、深い誤爆・誤爆(浅)の両方で定義される。符号: 正=深い誤爆側、負=誤爆(浅)側。

**53件中の実測**（B群32件のうち `protectedFacts=[]` の vague 8件を除く24件で定義される。
JSON `candidates["1_2_protectionMargin"]` で確認済み）:

| 区分 | n | mean | stdDev | min | max |
|---|---|---|---|---|---|
| 全体 | 24 | +0.030195 | 0.022252 | −0.008776 | +0.061133 |
| 深い誤爆のみ | 20 | +0.037452 | 0.016274 | +0.003528 | +0.061133 |
| 誤爆(浅)のみ | 4 | −0.006089 | 0.003500 | −0.008776 | −0.001123 |

**⟹ 0に潰れない。符号が今回の53件では深い誤爆/誤爆(浅)の二値と完全に一致して分離する**
（深い誤爆側は全件正、誤爆(浅)側は全件負、重なりゼロ）。ただし誤爆(浅)側の絶対値は深い
誤爆側よりずっと小さく、n=4なので統計的には主張しない。

### 3.2 出荷方法の違い — 案1（その場で書き換え）vs 案2（別名新設）

| 変更が要るファイル | 案1（`intrusionMargin` の定義域を書き換える） | 案2（別名 `protectionMargin` を新設、`intrusionMargin` は凍結） |
|---|---|---|
| `correction-candidate-arm.ts` | 編集（ガードを外す/式を差し替え） | 編集（新フィールド追加。既存関数は残す） |
| `correction-candidate-json.ts` | 編集（既存フィールドの意味が変わる） | 編集（新フィールド追加のみ） |
| `correction-candidate-arm-margin.test.ts` | **既存3件が失敗し書き換えが要る**——ADR 0321
  自身が「誤爆(浅)のときはnull」を検証するテストと、「ガードを外すのはバグ」として検出する
  変異テストを、まさにこの変更が指して「壊れた」と言う設計になっている | **無改変で全部
  緑のまま** |
| `correction-candidate-probe-summary-lib.mjs`/`.test.mjs` | 編集（`DIFF_FIELDS`・
  フィクスチャの意味が変わる） | 編集（新フィールド追記。出さない選択も可能） |
| `correction-candidate-probe-baseline.json` | 再測定して更新（既存 `intrusionMargin` の
  値そのものが変わる） | 再測定して更新（新フィールドを追記するだけ、既存列は不変） |
| `examples/chat/README.md` | 編集（「常に0になる。実装の欠陥ではなく定義どおり」が事実で
  なくなる） | 編集（新フィールドの説明を追記。既存の考察文はそのまま歴史的記述として残せる） |
| ADR 0291/0321 | 本文は書き換えない。ただし新 ADR が 0291§5.5 を「後に別 ADR で置き換え」と
  明記する必要がある | 本文は書き換えない。新 ADR は「追加」であり 0291§5.5 の逐語と矛盾しない |

**可逆性**: 案0→案1は `git revert` で戻せるが、一度公開した `intrusionMargin` の意味が
変わった事実は戻らない（型シグネチャ `number|null` は変わらないためコンパイルエラーには
ならない）。案0→案2は完全に加法的——`protectionMargin` フィールドを消せば案2導入前に
戻り、`intrusionMargin` は一度も触っていないので後方互換は最初から保たれる（ただし
「いつ `intrusionMargin` を消すか」という非推奨運用は案2固有の新しい未決事項として残る）。

### 3.3 「欠陥」という呼び方の食い違い

- **Issue #109 のコメントは、この「常に0」を「定義の欠陥」と呼んでいる**（最新コメント
  「残っているもの」3番: 「`intrusionMargin` の定義の欠陥（ADR 0291 §5.5）」）。
- **ADR 0321 §4 は「これは実装の欠陥ではなく、定義どおりの挙動である」と書いている**
  （1位そのものが保護対象である以上、自明な結果だとする——保護対象が0〜1件の母集合では
  数学的に導かれる帰結であって、コードのバグではないという主張）。
- **どちらも事実の記述としては矛盾しない**——「定義どおりに動いている」ことと「その定義
  自体が使う側にとって欠陥（情報を運ばない）である」ことは両立する。**この ADR は
  どちらの呼び方が「正しい」かを判定しない**——両方の記述を並べて残す。
- **ADR の状態が違う点に注意**: ADR 0291（式を決めた §5.5 を含む）は**状態=提案のまま**
  である。ADR 0321（実装した §4 を含む）は**採用済み**である。**⟹ 実装（採用済み）は
  提案のままの設計文書の逐語に従っている、という状態**——設計側を書き換えるなら、まず
  提案のままの ADR 0291 の状態そのものをどう扱うかが前提として残る（この ADR は
  ADR 0291 の状態欄を書き換えない）。

### 3.4 ADR 0291 §5.5 の逐語との関係

ADR 0291 §5.5 の逐語（【現物】）:

> intrusionMargin: 深い誤爆のとき: topScore − protectedFactScore（正なら誤爆が「強く」
> 1位に来ている）誤爆していない/棄権のとき: null

- **案0**: 逐語どおり。
- **案1**（その場で書き換え）: **この逐語と正面から矛盾する**——「誤爆していない/棄権の
  ときは null」という制約を外すことになる。ADR 0291 は状態=提案のままであり、
  「採用済み ADR の本文は書き換えない」規律（`docs/decisions/README.md`）に照らしても、
  **提案のままの ADR の逐語ですら、無断で反する実装をこの ADR は正当化しない**——
  案1を選ぶ場合は、新しい ADR が 0291§5.5 を名指しで「後に置き換える」と明記する形でしか
  正当化できない。
- **案2**: 矛盾しない——`intrusionMargin` の逐語をそのまま満たし続けたまま、別名の値を
  追加するだけである。

### 3.5 `protectedFacts` が複数件のときの未検証点

**今日の32件は全ケース `protectedFacts` が0〜1件**（ADR 0321 §4 の制約、この実測も
変えていない）。代数的に確認したこと（実データでは検証できていない）:

- `protectedFactScore`（両案が共有する既存の定義）は保護対象のうち**最小**（最も危うい
  もの）。`protectedAtTop` は「1位そのものが保護対象か」——保護対象が複数件のときは
  「最大スコアの保護対象が1位か」と同値。
- **保護対象が2件以上あるケースでは、`protectionMargin`（min協定）の符号が
  `protectedAtTop` と食い違いうる。** 例: 保護対象がスコア0.95（1位）と0.3（下位）の2件、
  非保護の最有力候補が0.5だったとする。`protectedAtTop=true`（深い誤爆）だが
  `protectedFactScore=min(0.95,0.3)=0.3` なので `protectionMargin=0.3−0.5=−0.2`
  （負＝見かけ上「誤爆(浅)側」の符号になる）。**これは実装のバグではなく、「最も危うい
  保護対象」と「1位に来た保護対象」が異なる問いになるために起きる。**
- **⟹ 案1/2は、`protectedFactScore` の `min` という既存の設計判断（ADR 0321§4が「複数件の
  ケースで実際にどう振る舞うかを実測していない」と自ら明記した部分）をそのまま引き継ぐ。**
  この限界は案0にも既に存在したが、案0は「深い誤爆のときしか値を出さない」ためこの
  不整合が表面化しない。**案1/2は定義域を広げる分だけ、この既存の限界を可視化する。**
- **代替案（検討したが実装していない）**: `protectedFactScore` に `min` ではなく `max`
  （最も安全な保護対象）を使う版を `protectionMarginBest` として別に持てば、
  `protectedAtTop` の符号と常に一致する（代数的に導ける）。**min版（実装済み）とmax版
  （未実装）は別の問いに答える**——今日のデータ（`protectedFacts`≤1件）では両者が
  一致するため区別できない。

---

## 4. 推奨（実測担当・この ADR の担当者としての所見。決定ではない）

**A について案1（margin基準、`stdDevMultiplier=3`、`minShrunkProbes=2`）を、C について
案2（別名 `protectionMargin` を新設し `intrusionMargin` は凍結・非推奨と明記する）を、
次の候補として推す。** ⚠ **これは「採用する」という決定ではない。** 根拠と限界を以下に
分けて書く。

### 4.1 A（案1）を推す根拠

1. 実データ（新規60巡・実API）で偽陽性を0件にし、上限（4.87%）が ADR 0316が「上限を
   置けた」とした4群と同じ水準に達した——ADR 0316が「上限を置けなかった」と結論した
   識別子2群について、初めて「置けるかもしれない」という具体的な手がかりを与える。
2. 感度を失っていない——local反実仮想の陽性対照・実測marginの変異試験のどちらでも
   genuine degradation を正しく拾う。
3. 既存の判定コードを1つも書き換えず、並走できる（可逆性が高い）。

**限界**: 標本数がまだ小さい（K=60、ADR 0316のK=118相当には届いていない）。
`japanese`（7probe）群で中間劣化の見逃しを観測した（§2.4）——識別子2群では見えていないが、
probe数が少ない群では同型の弱点が起こりうる。`stdDevMultiplier`/`minShrunkProbes` の
組み合わせはグリッドサーチしていない（1点しか測っていない）。

### 4.2 C（案2）を推す根拠

1. 53件の実測で、深い誤爆/誤爆(浅)の二値と符号が完全に整合し、0に潰れない連続値が
   取れた——Issue #109 が指摘した「常に0」を実際に解消できる。
2. 既存の二値を置き換えず、ADR 0135/0291 が要求する「二値と併記する」設計方針に忠実。
3. ADR 0321 自身が書いた回帰テスト（「誤爆(浅)のときはnull」の歯・「ガードを外す変異」を
   検出する歯）を壊さずに済む。ADR 0291§5.5 の逐語と矛盾しない。可逆性が高い。

**限界**: `protectedFacts` が複数件になったときの `min`/`max` の選択が未解決のまま
（§3.5）。実データが今日の母集合（0〜1件）では区別できないため、実測では確かめられない。

### 4.3 採用する場合に要る後続作業（列挙のみ、着手はしない）

- **A**: `scripts/openai-arm-summary-lib.mjs`・`scripts/__tests__/openai-arm-summary-lib.test.mjs`
  の書き換え（並走の判定として追加する形を推奨）。門にするか（B、required化）は
  オーナー領分であり、この ADR も次の実装 PR も扱わない。
- **C**: `correction-candidate-arm.ts`・`correction-candidate-json.ts`・
  `correction-candidate-probe-summary-lib.mjs`/`.test.mjs`・
  `correction-candidate-probe-baseline.json`（再測定）・`examples/chat/README.md` の
  新フィールド追記。`intrusionMargin` の非推奨運用（いつ消すか）は別途決める必要がある。
  `protectedFacts` が複数件になるケースが実際に追加されたら、`protectionMarginBest`
  （max版）の要否を再検討する。

---

## 5. これが覆るとしたら

- **A**: 識別子2群の判定基準についてさらに大きな標本（K=118相当以上）で偽陽性率を
  測り直したとき。`stdDevMultiplier`/`minShrunkProbes` のグリッドサーチが行われ、
  より良い組み合わせが見つかったとき。`japanese`（7probe）群の中間劣化の見逃しの原因が
  切り分けられ、識別子2群にも同型の弱点があると分かったとき。
- **C**: `protectedFacts` が複数件のケースが実際に増え、`protectionMargin`（min協定）の
  符号が `protectedAtTop` とねじれる実例が観測されたとき——そのとき min 版と max 版
  （`protectionMarginBest`）のどちらを一級の値にするかを再検討する必要がある。

## 6. 確かめていないこと

**A（実測メモ `results-A.md` §9 から引き継ぐ）**:

- K=60・K=118を超える、より大きな標本での案1のFP率。
- `stdDevMultiplier`/`minShrunkProbes` のグリッドサーチ（3・2という1点しか測っていない）。
- `japanese`（7probe）群で観測した中間劣化の見逃しの原因（baseline標本標準偏差の推定
  不安定という推測は検算していない）。
- 実際のモデル交代・週単位の経年変化に対する案1の挙動。
- k-of-n（N本委託録画）を実際にCIへ実装したときの運用コスト。
- `identifier-probe-baseline.openai.json` にADR 0316本文が言及する `marginStats` が
  実際には無いという食い違いの経緯（実装のバグなのか、ADR本文が別の版を指しているのか）。
- `scripts/openai-arm-summary-lib.mjs` を実際に書き換えたときの挙動。

**C（実測メモ `results-C.md` §7 から引き継ぐ）**:

- `protectedFacts` が複数件のケースでの `protectionMargin` の実際の振る舞い（§3.5、
  類推のみ）。
- `protectionMarginBest`（max版）を実装・実測していない。
- 本番（Postgres+pgvector/HNSW、実テナント規模）での実測。
- OpenAI実埋め込みでの実測（ローカル埋め込みのみ）。
- `correction-candidate-probe-summary-lib.mjs`/`.test.mjs`・`correction-candidate-json.ts`・
  READMEを実際に編集した場合の差分（§3.2 の表は見立てであり、実装はしていない）。
- ADR 0322流の合成ノイズでの安定性。
- 2回実行の再現性はこのスクリプトの2回のみで確認——3回目以降の安定性は見ていない。

**この ADR 自身の限界**:

- **Issue #109 残件4（sparse/dense が完全に同じ結果になる原因）はこの ADR の範囲外**
  （§0）——PR #788（ADR 0322 の追記）で確かめ済みであり、ここでは再検証していない。
- **A・C の実測は、それぞれ別の担当者が行ったものであり、この ADR の担当者は再導出せず、
  JSON との数値突き合わせと既存コード・ADR の現物確認だけを行っている。** 突き合わせで
  見つけた誤記（§1）以外に、まだ見つけていない誤記が残っている可能性を排除しない。
- **「推奨」節（§4）は、この ADR の担当者1名の所見であり、独立レビューは受けていない。**

---

Refs #109, ADR 0094, ADR 0220, ADR 0254, ADR 0274, ADR 0291, ADR 0316, ADR 0321, ADR 0322

---

## 追記（2026-09-26）: A・C の推奨を「影で並べた」——状態は提案のまま

> **⚠ クローン miku の判断（オーナーではない）。**この追記は採用の決定ではない。
> **この ADR の状態は「提案」のままである。**採用へ倒すかは次の判断として残す。

§4 の推奨を、**既存の判定・既定値・公開 API・required checks を1つも変えずに**、
既存の値の隣へ並べて出す形で入れた（§2.6・§3.2 の「並走の判定として追加」「案2」の形）。

**A（margin 基準、`stdDevMultiplier=3`・`minShrunkProbes=2`）**:

- `scripts/openai-arm-summary-lib.mjs` の Job Summary に、既存の「並走の判定」（ADR 0316
  のまま）の直後へ「**参考: margin基準の判定候補**」節を足した。**参考であり判定には
  使っていない**と節の中に明記した。`decideShadowVerdict`・`MRR_DROP_THRESHOLD`・
  `DIFF_FIELDS`・exit code は変えていない。
- 判定に要る probe ごとの margin は、既存の CI artifact には無かった（群集約の
  `marginStats` だけ）。そこで `openai-arm-json.ts` の群 JSON に `probeMargins` を追記し、
  2つの基準値 `*-baseline.openai.json` に `marginStats`・`probeMargins` を**追記**した。
  値は**コミット済みカセットを `recorded` で再生して**得たもの（`env -u OPENAI_API_KEY
  MNEMORA_LLM=deterministic`、実 API 不使用）。再生で得た既存フィールド（MRR・hit@1・
  hit@10・probe 件数）はコミット済み基準値と全群一致した。§2.0 が指摘した「ADR 0316 本文の
  `marginStats` が基準値に無い」食い違いは、この追記で基準値側に値が入った（経緯は
  確かめていない）。
- **正本は `examples/chat/src/verdict-candidate-margin.ts`**（`decideMarginDropVerdict`・
  `DEFAULT_MARGIN_DROP_OPTIONS`）。`.mjs` は `tsx` を通さないため手複製になる——
  ADR 0316 側（`decideShadowVerdict`）と同じ二重管理である。ただし今回は、同じ入力を
  両方に通して結果が一致するかを見る歯（`scripts/__tests__/openai-arm-margin-verdict-crosscheck.test.mjs`）
  を足した。ADR 0316 側の手複製にはこの歯が無い。無理に統合はしていない。

**C（案2: `protectionMargin` を別名で新設、`intrusionMargin` は凍結）**:

- `correction-candidate-arm.ts` に `protectionMargin = protectedFactScore − topNonProtectedScore`
  を別フィールドとして足し、`correction-candidate-json.ts`（probe ごとの値と
  `summary.protectionMarginStats`）・`correction-candidate-probe-summary-lib.mjs`
  （Job Summary で `intrusionMargin` の隣に表示＋基準値との「参考」節）・
  `correction-candidate-probe-baseline.json`（追記のみ）・`examples/chat/README.md` に出した。
- **`intrusionMargin` の定義・値と ADR 0321 の回帰テスト（`correction-candidate-arm-margin.test.ts`）は
  変えていない。**`protectionMargin` は `DIFF_FIELDS` に入れていないため、既存の
  一致/相違の判定は変わらない。
- 本物の Postgres 17 + pgvector と `@mnemora/local-embedding` で再測定した分布は、§3.1 と
  一致した（n=24、深い誤爆20件は全件正、誤爆(浅)4件は全件負）。
- §3.5 の限界（`protectedFacts` が複数件のとき）は残ったままである。`protectionMarginBest`
  は実装していない。

**確かめていないこと**: CI 実機での Job Summary の見え方（手元で summary スクリプトを
直接走らせて確かめただけ）。`intrusionMargin` をいつ消すか（非推奨運用）。§2.4 の
`japanese` 群の感度の弱点。
