# ADR 0705: `consolidated`・`reflected` の provenance にも、設定したモデルと応答を実際に返したモデルを残す

- **状態**: 採用 (2026-11)
- **日付**: 2026-11-10

**これは担い手（Claude Code のセッション）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所は、対話セッションでの利用者の依頼「残ってる課題に着手してください」。[ADR 0701](./0701-provenance-records-responded-model.md) の「引き受けた負債」の1つ目を片付ける。Issue [#2115](https://github.com/takecchi/mnemora/issues/2115)。

**⚠ この ADR の番号は仮である。** マージの直前に `node scripts/adr-renumber.mjs` が確定する（[ADR 0179](./0179-adr-number-assigned-at-merge.md)）。

## 文脈【現物】

ADR 0701 は、`inferred` の provenance に `respondedModel` を足した。だが、`consolidate`・`reflect` が LLM で作る記憶の provenance は `{ kind, sources }` だけで、どのモデルが作ったかが設定値すら残っていなかった。

## 何を決めたか【判断】

1. **`ConsolidatedProvenance`・`ReflectedProvenance` に、任意の欄 `model?`・`respondedModel?` を足す。**意味は `inferred` と同じである。
   - `model` は設定したモデル名（`RuntimeConfig.llmModelId`）。
   - `respondedModel` は、応答を実際に返したモデル名（ADR 0701 の契約）。
2. **`consolidate`・`reflect` は、`model` を常に書く**（`inferred` と同じく、設定が無ければ `"unknown"`）。`respondedModel` は、provider が `completeStructuredWithMeta` で返したときだけ書く。そのため、LLM 呼び出しを内部の `callStructuredWithMeta` に替えた。
3. **欄は任意にする。**この欄が入る前に作られた記憶（`model` が無い）を、schema で拒まないため。
4. 公開されている builder `buildConsolidatedMemory`・`buildReflectedMemory` には、任意の引数 `llmModelId`・`respondedModel` を足した。省けば書かない（既存の呼び出し側の出力は変わらない）。
5. 壊れた入力の表（testkit の適合テストと core の両方）に、4つの欄の空文字を足した。

## 互換性

- 型の上では非破壊である（任意の欄・任意の引数の追加）。DB マイグレーションも無い（jsonb）。
- `runtime.consolidate`・`runtime.reflect` が作る記憶の provenance に `model` が増える。provenance を完全一致で比べていた呼び出し側だけが影響を受ける（既存のテスト4件がそうだったので、期待値に `model: "unknown"` を足した）。

## 採らなかった案

- **`model` を必須にする。**欄が入る前の記憶を schema が拒むようになる。
- **claim key の LLM 呼び出しのモデルも残す。**claim key は記憶の列（主語・述語）で、provenance を持たない。残す場所を新しく作ることになるので、今回は見送った。

## 確かめたこと【実測】

- core `consolidate-reflect-provenance-model.test.ts`（6件）: consolidate・reflect の両方で、`model` が設定値になり、`respondedModel` は応答の値になる。任意の口が無い・空文字のときは残らない。
- 壊れた入力の表に足した歯は、core・testkit・Postgres（適合テスト）でいずれも緑。
- 変異試験の結果は PR に書く。

## これが覆るとしたら

- claim key の鍵の出所（どのモデルが付けたか）を監査する必要が出たとき。
