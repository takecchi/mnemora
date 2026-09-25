# ADR 0328: `local` 埋め込みの出力は、ランナーをまたいで同じになるか——x64 どうしはビット一致、x64 と arm64 は系統的に不一致（Issue #565、測っただけ。門にはしない）

- **状態**: 提案 (2026-09-25)
- **日付**: 2026-09-25

**⚠ この ADR はクローンの委譲で動く担い手が書いた。投稿者 `takecchi` はオーナー本人ではない**
（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**⛔ 門にするかどうかは、この ADR では決めない。**判断の材料を出すだけである。

### 出所の凡例

| 記号 | 意味 |
|---|---|
| 【実測】 | この担い手が、GitHub Actions の run の artifact を読んで数えた |
| 【現物】 | リポジトリの現物（コード・文書）を読んで確かめた |
| 【受】 | 受け取った前提で、自分では検証していないもの |

---

## 文脈

[ADR 0253](./0253-local-embedding-weights-fingerprint-gate.md) は、採らなかった案 (c)「推論出力そのものを指紋にする」を、
**「偽陽性率に上限を置けない」**という理由で却下した。ランナー間の再現性を一度も測っていなかったからである。
追記3（PR #668）は、測る仕組みとして `example-chat` / `root-gate-db-stage` の2ジョブに
固定3文の埋め込みの sha256 と `lscpu` を残した。ただし次の穴が残っていた【現物】:

- 2ジョブとも `ubuntu-latest`（x64）で、**アーキテクチャが違うランナーを1本も見ていない**。
- `numThreads` は既定の 4（`DEFAULT_LOCAL_EMBEDDING_NUM_THREADS`）で固定している。
- sha256 しか残していないので、**ずれたときにどの桁でずれたかが分からない**。

この ADR は、その3つを測った結果を残す。

## 測った方法

### A. 既存の2ジョブの artifact を集めた（x64、`numThreads=4`）【実測】

PR #668 以降の **244 run** から、`embedding-output-fingerprint-{example-chat,root-gate-db-stage}` を
すべて落とした（2026-09-25 時点。main と PR の両方を含み、期限切れは 0 件）。

### B. 新しい測定用 workflow（`.github/workflows/embedding-cross-runner-reproducibility.yml`）【実測】

- 脚: runner ∈ {`ubuntu-latest`, `ubuntu-22.04`, `ubuntu-24.04-arm`, `ubuntu-22.04-arm`} × `numThreads` ∈ {1, 2, 4}
  × rep ∈ {1, 2}（rep は別ジョブ、つまり別 VM での反復）。**24脚**になる。
- 同じ構成を3回走らせた: run [`36117549993`](https://github.com/takecchi/mnemora/actions/runs/36117549993)（pull_request）、
  [`36117926755`](https://github.com/takecchi/mnemora/actions/runs/36117926755)（workflow_dispatch）、
  [`36118651240`](https://github.com/takecchi/mnemora/actions/runs/36118651240)（pull_request）。**合わせて 72 脚。**
  ⚠ 下の「群」の表と差の数値は、最初の2 run で数えたものである。3本目は、sha256 がアーキテクチャごとに1種類ずつになることだけを確かめた。
- 各脚は、固定3文（`FIXED_EMBEDDING_FINGERPRINT_INPUTS`）の出力ベクトル（3×256 = 768 成分）を、
  float32 のビット列のまま丸ごと残す。一緒に `lscpu`、runtime の版、重みファイルの sha256 も残す。
- 比較ジョブは、どの結果でも exit 0 で終わる。

**条件をそろえたこと**【実測】: 最初の2 run の 48 脚で次がそろっていた。
node v22.23.2、onnxruntime-node 1.24.3、`@huggingface/transformers` 4.2.0、重みは
`sirasagi62/ruri-v3-30m-ONNX@cdf9391f…` で `model_quantized.onnx` の sha256 は `3d374a62…`。

## 結果

### A. x64、`numThreads=4`、244 run / 484 観測【実測】

| 項目 | 値 |
|---|---|
| status `ok` | 484 / 484 |
| 異なる sha256 の数 | **1**（`ac84b5d4…`） |
| 同じ run の2ジョブの対 | 240 対で、**240 対とも一致**（4 run は片方の artifact が欠けていたので数えていない） |
| そのうち CPU の型番が違う対 | 157 対で、**157 対とも一致** |

観測された CPU と命令セット（すべて同じ sha256 だった）:
AMD EPYC 7763（AVX2 のみ）、AMD EPYC 9V74（AVX2 のみ / AVX-512+VNNI+BF16 の2通り）、
AMD EPYC 9V45（AVX-512+VNNI+BF16+AVX-VNNI）、Intel Xeon Platinum 8370C（AVX-512+VNNI）、
Intel Xeon Platinum 8573C（AVX-512+VNNI / それに BF16+AMX を加えたものの2通り）、
Intel Xeon 6973P-C（AVX-512+VNNI+BF16+AMX）。**同じ型番でも、ゲストに見える命令セットは VM ごとに違う。**

### B. 24 脚 × 3 run【実測】

| 群 | 組数（1 run あたり） | 一致 |
|---|---|---|
| x64 どうし（`numThreads` と rep を問わない） | 66 | **全組ビット一致** |
| arm64 どうし（同上） | 66 | **全組ビット一致** |
| 同じランナー・同じ rep で `numThreads` だけ違う | 24 | **全組ビット一致** |
| 同じランナー・同じ `numThreads` で rep だけ違う（別 VM） | 12 | **全組ビット一致** |
| **x64 と arm64** | 144 | **0 組（全組が不一致）** |

- x64 の脚に出た CPU は AMD EPYC 7763 / 9V74 / 9V45、Intel Xeon 8370C / 8573C / 6973P-C だった。
  既存方式（float64 LE）で sha256 を取り直すと、**A の `ac84b5d4…` と一致した**。
  ⟹ A の 484 観測と B の x64 脚は、同じ出力として比べられる。
- arm64 の脚は、`ubuntu-24.04-arm` で `lscpu` が Neoverse-N2 を返した。`ubuntu-22.04-arm` は
  `Model name` を返さなかったが、Flags（asimd/sve2/i8mm/bf16 など）は N2 と同じ一式だった。
  arm64 の 36 脚はすべて同じ出力になった（既存方式の sha256 は `a72fac9c…`）。

### x64 と arm64 の差は、どの桁で出るか【実測。この担い手が artifact のビット列から再計算した】

| 項目 | 値 |
|---|---|
| 不一致の成分 | 768 のうち 514 |
| 最大の絶対差 | 5.96e-8（= 2^-24） |
| 最大の相対差 | 1.0e-4。**値が 2.0e-5 しかない、最も小さい成分で出た**。十進4桁目でずれるのはこの成分だけである |
| 典型的な成分 | 絶対値の中央値は 0.021。そこで差が 2^-24 なら、ずれは十進で7桁目前後になる |
| 最大の ULP 差 | 1115（小さい成分ほど ULP が細かいので、ULP で見ると大きく出る） |
| cosine 類似度（3ベクトルそれぞれ） | 0.9999999999999978 / 0.9999999999999993 / 0.9999999999999989 |
| 差の出方 | arm64 の脚すべてで**まったく同じ差**になった（3 run とも、arm64 の sha256 は1種類だった）。乱れではなく、系統的な差である |

**なぜ差が出るのかは確かめていない。**onnxruntime の x86 と ARM で量子化カーネルの実装が違う、というのは推測にすぎない。

## 判断の材料（⛔ 決定ではない）

1. **案 (c) を門にしたとき、x64 のランナーだけなら、観測の範囲では偽陽性が出ていない。**
   0 / 484 観測、0 / 240 対、0 / 157 対（CPU の型番が違う対）で、ここに B の x64 脚を足しても同じである。
   ただし偽陽性率の上限は「0 件だった」から言える範囲に限られる。たとえば 240 対で 0 件なら、
   95% 片側上限は約 1.2%（3/n の目安）になる。**ランナーイメージ・node・onnxruntime の版が変わったときの再現性は含まない。**
2. **ハッシュを一致させる形の門は、arm64 を1本でも混ぜると必ず赤くなる。**
   ⟹ そうするなら、期待値を**アーキテクチャごと**に持つ（ADR 0253 の「期待値を焼き込まない」とぶつかる）か、
   **許容誤差つきの比較**（例: 絶対差 ≤ 1e-6、または cosine ≥ 1 − 1e-12）にするかのどちらかが要る。
   **どちらにするかは、この ADR では決めない。**
3. **`numThreads` は、観測の範囲では出力に効かなかった**（1 / 2 / 4 のどれでもビット一致）。
   同じアーキテクチャの中では、`numThreads` の違いを門の偽陽性の要因として見なくてよい、という材料になる。
   **この固定3文に限った話である。**

## 変えたもの【現物】

- `.github/workflows/embedding-cross-runner-reproducibility.yml`（新規）。**required ではない。**
  起動するのは `workflow_dispatch` と、この workflow 自身と新しい script を変えた `pull_request` だけ。
  `ci.yml`、`.github/required-status-checks.json`、branch protection には触れていない。
- `scripts/cross-runner-embedding-fingerprint-lib.mjs`、`measure-…`、`compare-…`（新規）とその歯。
  変異試験は2本で、どちらも赤になり、戻すと緑に戻った（PR #751 に記録）。
- `examples/chat/src/embedding-fingerprint.ts`: 任意の env `MNEMORA_EMBEDDING_FINGERPRINT_NUM_THREADS` を足した。
  未設定なら既定の 4 を明示して渡すので、既存2ジョブの挙動は変わらない。raw JSON に
  runtime の版と重みの digest も足した。
- `packages/` には1バイトも触れていない。

## 確かめていないこと

- **日をまたいだとき、ランナーイメージが更新されたとき、node や onnxruntime-node の版が上がったときの再現性。**
  B は同じ日の、1時間足らずのうちに走った3 run だけであり、A も #668 以降の約2日分しかない。
- arm64 は Neoverse-N2 の一種類しか観測していない（`ubuntu-22.04-arm` の型番は flags から推測したもの）。
  Graviton など、別の ARM コアは見ていない。
- macOS と Windows のランナーは測っていない。
- 固定入力は3文だけで、長い入力やバッチの大きさの影響は見ていない。
- x64 と arm64 の差の原因（onnxruntime のカーネル）は追っていない。
- `weightsDigest` はキャッシュディレクトリの下を全部 hash している。flat 配置と revision 配置が同居していた
  （ADR 0253 追記5 の現象）ので `fileCount=8` になっていたが、両方の配置の sha256 は同じだった。

## これが覆るとしたら

- x64 の中で sha256 が割れる観測が1件でも出たら、判断の材料1は崩れる。そのときは、既存の2ジョブが
  残している `lscpu` の Flags の差から先に見ること。
- onnxruntime-node か transformers.js の版を上げたら、この測定をやり直す
  （`workflow_dispatch` で起こせる）。

## 未計上であることの明記

`CHANGELOG.md` と `docs/migration-v1.md` には計上していない。出荷物（`packages/`）は変わらないからである。
