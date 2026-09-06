# ADR 0013: 抽出の失敗を、成功と同じ顔で記録しない

- **状態**: 採用 (2026-09)

- **これは [ADR 0008](./0008-absence-taxonomy.md) を置き換えない。**
  0008 が `recall()` に対して定めた原則——**「無い」には種類があり、
  区別があると呼び出し側の次の一手が変わるなら潰してはいけない**——を、
  `observe()` の取り込み経路にも適用するものである。0008 の記述は有効なまま。

- **文脈**:
  [memory-model.md](../memory-model.md) §4 は、digest 生成が失敗しても Memory を
  「digest だけの薄い状態」に落とさないという安全弁を定めている（**曖昧なら厚い側に倒す**）。
  実装ではこれを2段階に持っている。

  1. LLM が候補は返したが digest が空・欠落 → 機械的な先頭切り出しへ倒し、
     `digest_source = 'fallback'` を記録する。
  2. **LLM 呼び出し自体が失敗した** → Observation の全文を1件の `stated` Memory として残す
     （`fallbackWholeObservationCandidate`）。

  安全弁そのものは正しい。**しかし当初の実装は、2 が起きたことをどこにも残していなかった。**

  - `extractCandidates()` は `usedWholeObservationFallback` を計算していたが、
    呼び出し元（`runtime.runExtraction`）が破棄していた。
  - `ObserveResult` は `extracted: boolean` しか持たず、
    **「抽出が成功した」と「抽出が失敗して全文を落とした」が同じ `true` になっていた。**
  - `memory_events` の `created` イベントは、失敗時も `meta.reason = 'extracted'` を記録していた。
    ⟹ **監査ログが、起きなかったこと（抽出）を起きたと主張していた。**

- **なぜこれが問題か（0008 の判定基準を当てる）**:
  基準は「その区別があると、呼び出し側の次の一手が変わるか」である。**変わる。**

  - `llm_failed_whole_observation` なら、**provider が復旧した後に抽出をやり直す**という
    一手がある。生テキストのまま置いておくべきものではない。
  - `ok`（LLM が正常に応答し、結果として0件だった場合を含む）には、その一手が無い。
    何も記憶に値しないという判断は**正常な抽出結果**であって、失敗ではない。

  この2つを `extracted: true` に潰すと、**一過性の LLM 障害が、気づかれないまま
  未処理の生テキストを「抽出済みの記憶」として残す。** しかも監査ログを見ても分からない
  ——監査ログこそがその嘘を記録している側だからである。

  これは mnemora の一本の原則「文脈を剥がして提示しない」の姿3
  （結果は、そこから漏れたものと必ず同時に提示する）が、`recall()` ではなく
  `observe()` の側で破れていた例である。

- **決定**:
  `ObserveResult.extracted: boolean` を廃し、**`ObserveResult.extraction: ExtractionOutcome`** を持つ。

  ```ts
  type ExtractionOutcome =
    | 'ok'                            // LLM が正常に応答した（0件を返した場合も ok）
    | 'llm_failed_whole_observation'  // LLM 呼び出しが失敗し、全文フォールバックへ倒れた
    | 'skipped'                       // この呼び出しでは抽出していない（deferred / memory_usage / 冪等な再送）
  ```

  併せて、`memory_events` の `created` イベントの `meta.reason` を抽出の成否で分ける。

  | 状況 | `meta.reason` |
  |---|---|
  | 正常に抽出できた | `extracted` |
  | LLM が失敗し全文フォールバックへ倒れた | `extraction_failed_whole_observation_fallback` |

- **検討した選択肢**:
  - **`extracted: boolean` のまま、失敗はログにだけ出す**: ADR 0008 が同じ形の案を
    却下したのと同じ理由で却下。**呼び出し側が実行時に次の一手を変えられない。**
  - **失敗時に例外を投げて `observe()` 全体を失敗させる**: 安全弁の目的（記憶を失うくらいなら
    受け取る）と正面から衝突する。却下。
  - **`digest_source = 'fallback'` で代用する**: これは「LLM は動いたが digest が無かった」
    場合にも立つため、2つの異なる状況を1つの値に潰す。区別の目的を果たさない。却下。
  - **`ExtractionOutcome` を返し、監査ログでも分ける**: 採用。

- **結果（この決定が招くもの）**:
  良い面: 一過性の LLM 障害で作られた「抽出されていない Memory」を、
  呼び出し側が実行時に検知でき、監査ログからも後追いで特定できる
  （`meta.reason` で `memory_events` を引ける）。

  引き受ける負債:
  - `ObserveResult` の型が boolean より複雑になる。呼び出し側は3値を扱う必要がある。
  - **やり直しの経路自体は Phase 1 では提供しない。**検知できるようになっただけで、
    「失敗した抽出を再実行する」操作は無い。抽出の冪等キーは
    `(observationId, extractorVersion)` であり、同じ版で再実行しても
    content_hash が変わるため、**やり直すと生テキストの Memory が残ったまま
    正しい Memory が追加される**（重複）。この掃除をどうするかは未解決である。
    **2026-09 追記**: [ADR 0028](./0028-reextract-superseded-cleanup.md) で `runtime.reextract`
    を追加し、この掃除（`superseded` にする）を実装した。

- **これが覆るとしたら**:
  - `ExtractionOutcome` の3値で実運用の失敗パターンを表せない（例えば
    「LLM は応答したがスキーマ検証に落ちた」を別扱いしたい）と分かったら、値を増やす。
    ADR 0008 と同じく、これは閉じた集合として設計していない。
  - 上記の「やり直しの経路」を Phase 2 以降で実装する際、
    生テキスト Memory を `superseded` にするのか `forgotten` にするのかを決める必要があり、
    その時点で別の ADR を起こす。

- **確かめていないこと**:
  - 実運用で LLM 呼び出しがどの程度の頻度で失敗するかは分からない。
    この分類が実際に役に立つ頻度は、運用を経ないと分からない。
