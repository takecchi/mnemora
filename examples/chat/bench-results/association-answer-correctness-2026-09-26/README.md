# 連想枠 off/on10 で `answer-time-weighting` の回答の正誤が変わるか(ADR 0337 追記 2026-09-26「回答の正誤」)

**この測定は既定を戻すかどうかを決める判定ではない。記録である。**
根拠・条件・読み取れること・確かめていないことの全文は
[docs/decisions/0337-recall-association-default-on.md](../../../../docs/decisions/0337-recall-association-default-on.md)
の「## 追記(2026-09-26、回答の正誤)」を見ること——ここには数字の要約だけを置く。

依頼元はクローン miku（オーナーではない）。前段の前提調査
（[docs/decisions/0337-recall-association-default-on.md](../../../../docs/decisions/0337-recall-association-default-on.md)
の先の追記「実 API ゼロで数え直す」段）を受けて、実際に gpt-4o-mini で正誤を測った。

## ファイル

- `measure-run.json` — 実測の生データ。段1(実 API ゼロ、`recorded`/`local` 両埋め込み)の
  32組ぶんの diff 明細、段2(実 API)の全60呼び出しぶんの回答文・verdict・プロンプト文字数/
  記憶行数、集計(組ごとの正答数、全体正答率、符号検定)を持つ。
- `run.log` — 実行時の標準出力(表・所見をそのまま含む。鍵は含まない)。

## 使ったコマンド

Postgres を専用ポートで立てたあと(手順は repo ルートの `AGENTS.md`
「手元で Postgres を立てる」節):

```bash
export DATABASE_URL="postgresql://worker@127.0.0.1:<専用ポート>/mnemora_test"
pnpm --filter @mnemora/core run build
pnpm --filter @mnemora/postgres run build
pnpm --filter @mnemora/postgres run migrate

DATABASE_URL="$DATABASE_URL" OPENAI_API_KEY=... \
  pnpm --filter @mnemora/example-chat exec tsx src/bench/association-answer-correctness-measure.ts
```

`OPENAI_API_KEY` が無ければ、段1(diff検出)まで実行して段2の手前で例外を投げて止まる
(実測——鍵を外して2回実行し、両方とも段1の結果は同一だった)。

## 層

| 段                                    | llmMode                 | embeddingMode                                           | 実 API                                                               |
| ------------------------------------- | ----------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| 段1: off/on10 の diff 検出(32組)      | `deterministic`         | `recorded`(`answer-time-weighting.order-legend.json`)   | 0回                                                                  |
| 段1: 同上(参考、比較用)               | `deterministic`         | `local`(実推論、カセット非依存)                         | 0回(ONNX重み取得はHFからの通常downloadで、鍵不要・実API扱いではない) |
| 段2: 対にした正誤測定(変わった組だけ) | `openai`(`gpt-4o-mini`) | `recorded`(同カセット。embed()の実API呼び出しは実測0回) | **60回**(回答生成のみ。このベンチは judge を持たない)                |

**温度(temperature)**: 明示的に渡していない(bench の既存の設定を維持——`OpenAILLMProvider`
の provider 既定のまま。`--temperature` フラグはこの道具には無い)。

## 段1: off/on10 でプロンプトが変わる組(実測)

32組(dev6+eval6+eval-undated4=16ケース×2方針)のうち:

- **`recorded`埋め込み(本番の層)**: **6組**で変化
  (`dev-a2-remote-work-day/legacy`, `dev-b2-current-project/legacy`,
  `dev-b2-current-project/eventAwareFreshness`, `eval-b2-relocation/legacy`,
  `eval-b2-relocation/eventAwareFreshness`, `eval-undated-c1-seat-floor-reinforced/legacy`)。
- **`local`埋め込み(参考)**: **14組**で変化——`recorded`より多い。実推論(ONNX)の近傍が
  記録時の実 OpenAI 埋め込みの近傍と異なるため(推測。原因の切り分けはしていない)。

実 API で対にした測定は**`recorded`埋め込みの6組だけ**を対象にした(本番の層、マネージャー指示)。

## 段2: 実 API(gpt-4o-mini)で対にした結果

n=5(予算190回 ÷ (2×6組)=15.8→15を5でcap)。呼び出し回数は実測60回(上限200に対して余裕あり)。
最初の1組×1回(`dev-a2-remote-work-day/legacy` trial=1)で `MNEMORA_LLM=openai` +
`MNEMORA_EMBEDDING=recorded` の混在指定が動くことを確認してから、残りを回した
(この1回も本番の集計に含めている——捨てていない)。

| 組                                           | off 正答/n | on 正答/n |
| -------------------------------------------- | ---------- | --------- |
| dev-a2-remote-work-day/legacy                | 0/5        | 5/5       |
| dev-b2-current-project/legacy                | 5/5        | 5/5       |
| dev-b2-current-project/eventAwareFreshness   | 5/5        | 5/5       |
| eval-b2-relocation/legacy                    | 5/5        | 5/5       |
| eval-b2-relocation/eventAwareFreshness       | 5/5        | 5/5       |
| eval-undated-c1-seat-floor-reinforced/legacy | 5/5        | 5/5       |

全体: off 25/30(83.3%) / on 30/30(100.0%)。
対にした差: on正・off誤=5 / off正・on誤=0 / 一致=25。
符号検定(exact 二項、p=0.5)の p 値 = **0.0625**（`min(5,0)=0` を使う両側 exact 検定。
食い違った対が5つしか無く、全部同じ向きでも0.05を下回れない——**「有意」とは書けない**）。
⚠ 食い違った5対はすべて同じ1組（dev-a2-remote-work-day/legacy）の試行であり、独立な5件ではない。
ケースを単位にすると「6組中1組で正誤が変わった（on が正）」の1件である。詳細は ADR 0337 追記参照。

## 確かめていないこと

- `local`埋め込みで変わった14組のうち、`recorded`埋め込みでは変わらなかった8組を
  実 API で測ってはいない(本番の層である`recorded`だけを対象にした、マネージャー指示)。
- n=5より多い試行(例: 同じ6組をさらに繰り返す)による検出力の向上は測っていない
  (200回の呼び出し上限の中で、6組×2×5=60回に留めた)。
- `dev-a2-remote-work-day/legacy`以外の5組はoff/on両方で5/5一致しており、
  「プロンプトが変わった」ことと「正誤が変わる」ことは別——今回はこの1組だけが
  実際に正誤への影響を示した。この1組についてもn=5だけでは母集団の真の効果量は
  分からない。
