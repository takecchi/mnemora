# 連想枠の既定 on が既存の記録済みベンチで何を動かすか(ADR 0337 追記 2026-09-26)

**この測定は既定を戻すかどうかを決める判定ではない。記録である。**
根拠・条件・読み取れること・確かめていないことの全文は
[docs/decisions/0337-recall-association-default-on.md](../../../../docs/decisions/0337-recall-association-default-on.md)
の「## 追記(2026-09-26)」を見ること——ここには数字の要約だけを置く。

## ファイル

- `measure-run.json` — 実測の生データ(1回目)。schemaVersion 1。
  `notes`(例外・スキップの一覧、今回は空)と、ベンチごとの4段
  (`off`/`on5`/`on10`/`on20`)の `headline`(表示用の集計)・`raw`(各 arm の
  生の report)を持つ。
- `determinism-check.json` — 同じ条件で2回走らせ、`headline` が一致したかの記録
  (`allMatched: true`)。2回目の生データそのもの(1.3MB)はここに残していない
  ——一致したことの記録だけを残す。
- `run.log` — 1回目の実行時の標準出力(表・所見をそのまま含む)。

## 使ったコマンド

Postgres を専用ポートで立てたあと(手順は repo ルートの `AGENTS.md`
「手元で Postgres を立てる」節):

```bash
export DATABASE_URL="postgresql://worker@127.0.0.1:<専用ポート>/mnemora_test"
pnpm --filter @mnemora/core run build
pnpm --filter @mnemora/postgres run build
pnpm --filter @mnemora/postgres run migrate

cd examples/chat
MNEMORA_ASSOCIATION_DEFAULT_ON_MEASURE_JSON=bench-results/association-default-on-2026-09-26/measure-run.json \
  pnpm run association-default-on-measure
```

**2回目**(決定性の確認。`measure-run.json` は上書きしない別パスへ):

```bash
MNEMORA_ASSOCIATION_DEFAULT_ON_MEASURE_JSON=/tmp/run2.json pnpm run association-default-on-measure
```

## 層(ベンチごとに違う。⚠ 一括ではない)

| ベンチ | llmMode | embeddingMode | 備考 |
|---|---|---|---|
| retrieval-quality | `deterministic` | `recorded`(`retrieval.json`) | 既存 arm B と同じ組み合わせ |
| compare | `recorded` | `recorded`(`compare.json`) | `DEFAULT_COMPARE_SEQUENCE` 全12点 |
| time-term | `deterministic` | `local` | CLI 既定は `deterministic`+`deterministic` だが、この測定だけ embedding を `local` へ上書き(理由は本体 docstring) |
| validity | `deterministic` | `local` | 同上 |
| identifier-probes | `deterministic` | `local` | sparse haystack のみ(dense・日本語固有名詞群は対象外) |
| numeral-token-probes | `deterministic` | `local` | 同上 |
| consolidation-cost | `deterministic` | `local` | `budgetLadder` を既定9段→ `[32,128]` の2段に縮小(この測定専用。`DEFAULT_BUDGET_LADDER` は変えていない) |
| answer-time-weighting | `deterministic` | `local` | recall 側の量だけを読む。dev集合(6件)のみ、trials=1 |
| answer | `deterministic` | `local` | recall 側の量だけを読む。dev+eval(14件) |

archive-sweep-cost は対象外(理由はスクリプト本体の docstring、ADR 追記の
「確かめていないこと」)。

## 実 API

呼び出し回数: **0**。理由: この測定が読む差(off/on5/on10/on20 の間で
recall() の候補集合・量・omitted がどう動くか)は `recorded`/`local` 層で
構造的に決まり、provider が本物かどうかに依らない
(`RecallQuery.association` の段3.5は `VectorStore.getVectors`/`search` しか
呼ばない——`embeddingProvider`/`llmProvider` には触れない)。answer/
answer-time-weighting は「回答の正誤」を読んでいない(deterministic LLM の
出力に正誤の意味を持たせられないため)ので、実 API での再測定が要る問い
(「回答の正誤が on/off で変わるか」)はそもそもこの測定の対象外である。
