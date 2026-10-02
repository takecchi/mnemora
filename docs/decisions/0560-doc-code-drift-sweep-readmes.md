# ADR 0560: 文書とコードのずれを横に掃く（第8弾）— README 4つ（ルート・core・openai・local-embedding）を、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

ADR 0550（#1659）の続き。0550 は ADR 単位で掃いた。今回は文書単位で、公開の README 4つを掃く。文書だけの PR で、コードの振る舞いは変えない。

**照合の基準は main `e14e8d3b`。**

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

決まり（前回と同じ）: CHANGELOG の `[1.2.0]` 以前、採用済み ADR の本文、`docs/memory-model.md`・`docs/migration-v1.md`・`docs/conformance.md`・`docs/architecture.md`、他パッケージの README は触らない。「clock は `availableAt` に届かない」に関する主張は ADR 0559 が直すので触らない。ずれがあれば文書をコードに合わせ、コードの側が約束を破っていそうなら直さずに材料として残す。公開 TSDoc は直していないので、CHANGELOG は触っていない。

## 掃いたもの

- `README.md`（ルート）
- `packages/core/README.md`
- `packages/openai/README.md`
- `packages/local-embedding/README.md`

## 直したもの

- **ルート `README.md`「いまの状態」**: パッケージの列挙に `packages/bullmq` が無かった（`packages/` には anthropic・bullmq・core・local-embedding・openai・postgres・testkit の7つが在り、同じ README の後半は bullmq の README にリンクしている）。`packages/bullmq`（`runtime.tick()` を BullMQ で駆動する）を足した。
- **ルート `README.md`「版の付け方」の 2026-09-29 追記**: 「`v1.1.0`（minor）に破壊的変更が1件入っている」と書いていたが、CHANGELOG の「v1.1.0 の記載の訂正」で数え直されており、`v1.1.0` の破壊的変更は複数件である（`v1.2.0` にも `### Breaking` がある）。「1件」を「入っている」に直し、ADR 0352 は「そのうちの1件」と言い直し、数え直しの在りかを指す1文を足した（数は写していない）。
- **`packages/local-embedding/README.md`**:
  - 破損キャッシュの節で、失敗のメッセージが名指す場所を `<cacheDir>/<repo>` とだけ書いていた。`revision` を渡すと根が `<cacheDir>/<encodeURIComponent(revision)>` に変わり、名指す場所も `<その根>/<repo>` になる（`local-embedding-provider.ts` の `describeLoadFailure` が `revisionCacheRoot` を通す。【現物】）。この注記を足した。
  - 「修正済み」と書くはずの所にキリル文字の誤字（「патched」）が混ざっていた。「修正済み（patched）」に直した。
  - `warmup()` の段落と次の見出しの間に空行が無かった。空行を1つ足した（見え方だけ）。

## 直さなかったもの（実装側を変えるべき食い違い）

**無かった。** 4つの README のどこにも、文書が正しくコードが約束を破っている、という食い違いは見つからなかった。

## ずれなしと確かめたもの

- **`packages/openai/README.md`**【現物】: `OpenAILLMProviderError` の `kind` の4種、`isOpenAILLMProviderError`（`instanceof` を使わない判定）、zod `^4.5.4`・`openai` 7.10.0 固定、`dimensions`・`temperature` の構築時検査（`TypeError`／`RangeError`、ADR 0498）、`embed()` の応答検査（件数・`index`・次元・有限性。メッセージは `OpenAIEmbeddingProvider:` で始まる）、空配列と abort 済みの扱い、`content_filter` を `refusal` に数える扱い、根が union のときの `result` の包み、`toStrictJsonSchema` を送る前に通す経路。参照先の ADR 12本、歯のテスト4本、`docs/architecture.md` の §3.8・§5.4・§5.5 は実在する。ずれなし。軽微なメモ: 187 行目の「上の『送る前には検査しない』」は、上の節（当時の振る舞いの節）の文面と逐語では一致しない。当時の記述を指す言い方なので直していない。
- **`packages/core/README.md`**【現物】: 末尾の表に並べた名前はすべて公開面（`scripts/__snapshots__/public-api/core.d.ts`）に在る。既定値（`DEFAULT_RECALL_ASSOCIATION = { maxCount: 10 }`、アンカー数 3、類似度の下限 0.5、目次帯 50）、`tick` の `leaseMs` が必須、`createRuntime` の7つの依存と `hashContent`、`ExtractionContextSchema` の形、`heuristicTokenCounter` の係数（CJK 0.9・非 CJK 0.25）、`ErrorOptions` を使う例外クラス、参照先の ADR と `docs/recall.md` の節。ずれなし。
- **ルート `README.md`**【現物】: probe の件数（想起の質 7、識別子 30、数詞 18、訂正の相手探しは A群 21・B群 32）、カセット `retrieval.json` の 152 件・`text-embedding-3-small`・256 次元、`ci.yml` のジョブ名（`retrieval-quality`・`identifier-probes`・`numeral-token-probes`・`correction-candidate-probes`・`consolidation-cost`・`association-probes`・`archive-sweep-cost`・`time-term`・`validity`）、再計測スクリプトの既定 59 回と `cost.totalUsd`、`Runtime` のメソッド名（3層の列挙のうち markContestedGroup・resolveContestedGroup・resolveOrphanedContested を含む）、`applyCorrection` の引数と4つの `kind`、`eraseTenant` の `deps`・`opts`・戻りの名前、`compareWithFullLog` の戻り、適合テストの文言3本、`pnpm ... run correction`／`correction-candidates` の script、参照先のファイル・ADR・節。ずれなし。「ADR 0232 の A群15件・B群8件」の表は、ADR 0232 の時点の実測として書いてある（今の評価集合の件数とは別）ので、そのままにした。

## 照らした範囲

読んだもの: 4つの README の全文。`packages/openai/src` の `errors.ts`・`embedding-provider.ts`・`llm-provider.ts`・`option-check.ts`・`structured-root.ts`・`index.ts`、`packages/core/src` の `recall.ts`・`runtime.ts`・`observation.ts`・`apply-correction.ts`・`correction-candidates.ts`・`erase-tenant.ts`・`recall-footprint.ts`・`heuristic-token-counter.ts`・`strategies/decay.ts`、`packages/local-embedding/src` の `local-embedding-provider.ts`・`pipeline.ts`・`transformers-cache-place.ts`・`errors.ts`・`option-check.ts`、各 `package.json`、`examples/chat/src` の probe の集合、`examples/chat/package.json`、`.github/workflows/ci.yml` のジョブ名、`docs/decisions/` の参照先の実在、`docs/recall.md`・`docs/memory-model.md` の節。grep の語は、各 README に出てくる識別子（`DEFAULT_*`・`kind`・`leaseMs`・`ErrorOptions`・`revisionCacheRoot`・`confirmTenantId` ほか）。local-embedding と core の突き合わせの一部は、担い手の下請け（サブエージェント）が行い、その報告を読んだ【判断】。core の README は担い手も自分で名前・既定値・参照先を確かめ、報告と一致した。local-embedding の既定値（`DEFAULT_LOCAL_EMBEDDING_*`）と `describeLoadFailure` は担い手が自分で再確認した。

## 【未確認】

- 走らせていないもの: ビルド・テスト・DB の要るテスト。`ts check` の型検査（コード片は1つも触っていない）。
- 外部の実測を写した主張は、再現していない: OpenAI の実 API に当てた入力の境界の表（2026-09-27）、SDK の既定の再試行・timeout の実測値、TypeScript 5.0〜7.0 の `TS1479` の実測、`subjectId` 有無のコスト表（ms）、local-embedding の 2026-09-26/27 の実測値（cos の値、npm audit の件数、CUDA のサイズなど）。local-embedding の ADR 0085・0358 の数字との一致は確かめた。
- ルート README の「`@mnemora/bullmq` は `v1.1.0` から npm に出ている」は、npm を見ていない。CHANGELOG と `packages/bullmq/README.md` の記述との一致までを下請けが見た。
- ルート README の GitHub Issue 番号（#109・#197・#371・#372・#534・#692・#232・#605）の実在と内容は、`gh` で見ていない。
- この clone には `node_modules` が無く、`scripts/__tests__` の vitest テスト（`doc-reference`・`markdown-link`・`check-doc-snippets-lib` ほか）は走らせていない（`vitest` が解決できない）。CI に任せる。
- `packages/local-embedding/README.md` のオプション表の2行（`numThreads`・`maxBatchSize`）は他の行より列が広い。md に prettier を検査する CI があるかは見ていない（触っていない）。
- 実装の振る舞い（`tick` 無しの `recall()` が空を返す、など）は実行して確かめていない。コードと TSDoc を読んだだけ。

## 引き受けた負債

- この ADR の結果は `main` の `e14e8d3b` に対して測った記録で、`main` が進めば古くなる。
- README の日付つき追記（「2026-09-27 追記」など）は、当時の記述と明示してあるものは直していない。

## これが覆るとしたら

- 探し方が拾わない種類（散文で既定値や例外の形を言い換えた文）の古さが見つかったとき。
- 【未確認】に挙げた実測の主張のどれかが、再現で食い違ったとき。
