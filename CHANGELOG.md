# Changelog

このファイルは [Keep a Changelog](https://keepachangelog.com/) の形式に倣う。
**手で書く**（tag や commit ログからの自動生成ではない）。理由と、版の権威が
Release の tag にあるという既存の決定（[ADR 0070](./docs/decisions/0070-version-comes-from-the-release-tag.md)）
との関係は [ADR 0169](./docs/decisions/0169-changelog-hand-curated.md) を見ること。

## 過去のバージョンについて

**v0.1.0 〜 v0.1.9 の変更は、このファイルには書き起こしていない。**
[GitHub Releases](https://github.com/takecchi/mnemora/releases) の各 tag を参照すること
（理由: [ADR 0169](./docs/decisions/0169-changelog-hand-curated.md) 決定4）。

⚠ **このファイルの初版と ADR 0169 決定4 は「v1.0.0 以降を対象とする」と書いていた。**
そう書いた時点では、次に出る Release が `v1.0.0` になる見込みだった。**実際に出たのは
2026-09-16 の `v0.2.0` である**（tag が指すのは `c52be47`）。⟹ **このファイルが実際に
対象としているのは `0.2.0` 以降である。**書き起こさない範囲（v0.1.0 〜 v0.1.9）は
決定4 のまま変えていない。⛔ **ADR 0169 の本文は当時の記録なので書き換えていない**
（`AGENTS.md`）。

## 何を載せるか

**利用者に見える変更だけを載せる。** docs のみの PR・内部スクリプトの修正・ADR 索引の
再生成・テスト追加のみの PR は載せない——GitHub が自動生成する Release notes（全 PR を
無差別に列挙する）との意図的な違いである。各項目は1〜2行の要約と ADR/Issue へのリンクに
留め、詳細は複製しない（`AGENTS.md` の反重複規律）。

⭐ **`[0.3.0]` 以降は、publish 対象のパッケージの変更だけを載せる。**出所は
`scripts/publish-targets.mjs` の `PUBLISH_TARGETS` である（⛔ **本数も名前もここに写さない**
——`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。⟹ **`examples/chat` は `private` であり、
出荷される面の外なので載せない。**

⚠ **これは途中で変わった形である。**【現物】`[0.2.0]` 節は `### Added` に `examples/chat` の
項目を2つ持っている（`memory_usage` 報告の実践 / 想起経路が連想枠を既定で使うようになった）。
⛔ **その2項目は書き換えていない**——当時の記録である（`AGENTS.md`）。
⟹ ⭐ **`[0.3.0]` 以降で `examples/chat` の変更が載っていないのは、書き漏れではなく方針である。**
理由・採らなかった案・引き受けた負債は
[ADR 0243](./docs/decisions/0243-changelog-lists-publish-targets-only.md)。

---

## [1.1.0] - 未リリース

⛔ **`v1.1.0` の tag はまだ切られていない。**

**この節は `v1.0.0` からの差分を対象とする。**

⭐ **数えた基準を明記する。**この節は `v1.0.0` … **`7987de4`** の範囲を数えたものである。
⭐ **この sha が名乗るのは「この節がどこまで数えたか」であって、「ここで打ち切った」ではない。**
⟹ ⭕ **`origin/main` がこれより進んでいても、この節は腐っていない**——**まだ数えていない範囲が
増えただけである。**🔴 **この性質が成り立つのは、この節が件数を持たないからである。**
⛔ **ここに件数を書かないこと**（[ADR 0234](./docs/decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。

🔴 **この節は以前、`v1.0.0` … `8cf82b1` を数えたと名乗っていたが、それは偽だった。** `8cf82b1`
（PR #728）へ pin を進めたのは PR #733 だったが、#733 は自分が足す Fixed 1項目のために sha を
書き換えただけで、`v1.0.0..8cf82b1` の間を実際には数え直していなかった——`#684`/`#694`/
`#703`/`#711`/`#724`/`#728` など、publish 対象パッケージに触れる PR が未計上のまま残っていた。
この節は、`v1.0.0` から `7987de4` までの PR を1本ずつ見て数え直したものである
（載せる／載せないの全数表と理由は [PR #747](https://github.com/takecchi/mnemora/pull/747) の本文）。

**この節が数えた範囲に破壊的変更は無い。**【実測】`git diff v1.0.0..7987de4 --
scripts/__snapshots__/public-api/` の削除行は、すべて（a）zod スキーマの欄の並べ替え、
（b）`import type` 一覧への新しい型名の追加、（c）任意の末尾引数を足したことによる関数
シグネチャの再フォーマット、のいずれかであり、削除・必須化・型の狭小化は無かった
（`buildExtractionPrompt`/`extractCandidates`/`previewRestoreSupersededBy` はいずれも任意引数の
追加のみ）。⟹ **公開 API への影響は、任意の欄・任意の引数・任意のメソッド・新しい export の
追加のみである。** `### Breaking` の節は無い。

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。

**postgres 利用者へ**: 新しいマイグレーションが3本増えている
（`0019_observations_memories_attributes.sql` / `0020_taxonomy_labels.sql` /
`0021_memories_claim_key.sql`）。⟹ `v1.0.0` から上げるなら
`pnpm --filter @mnemora/postgres run migrate` が要る。

### Added

- **`restoreSuperseded`/`previewRestoreSupersededBy` に任意の `filter?: { onlyMemoryIds?:
  MemoryId[] }` を足し、1回の統合・訂正操作の単位まで戻す範囲を絞れるようにした**
  （`MemoryStoreConformanceOptions.supportsOnlyMemoryIdsFilter?` は既存必須8本と違い**任意**）。
  ⭕ 省略時は従来どおり群全体を戻す（[Issue #515](https://github.com/takecchi/mnemora/issues/515) /
  [ADR 0258](./docs/decisions/0258-restore-superseded-operation-scope.md)、PR #573）。
- **`@mnemora/testkit` に `describeLLMProviderConformance`（`LLMProvider` の適合テスト一式）を
  新設し、`@mnemora/openai`・`@mnemora/anthropic` の両方に当てた**——`@mnemora/anthropic` は
  publish 対象でありながらこれまで適合テストに1本も当たっていなかった
  （[Issue #389](https://github.com/takecchi/mnemora/issues/389) /
  [ADR 0266](./docs/decisions/0266-llm-provider-conformance.md)、PR #603）。
- **抽出候補（`ExtractedMemoryCandidateSchema`）に任意欄 `subjectId?: string | null` を足した**——
  1回の `observe()` から出る複数の Memory に、それぞれ違う主題を持たせられる。`undefined`
  （省略）＝未指定（従来どおり observation の主題へ）、明示的な `null`＝主題なしの明示
  （[Issue #608](https://github.com/takecchi/mnemora/issues/608) 項目① /
  [ADR 0271](./docs/decisions/0271-extraction-candidate-subject-id-overrides-observation.md)、
  PR #612）。
- **`ScoreBreakdown` に任意欄 `affinityMeasured?: boolean` を足した**——連想枠（段3.5）が
  affinity を測っていない状態で返した記憶かどうかを、`score.total` を比較する前に呼び手が
  見分けられるようにする（[Issue #548](https://github.com/takecchi/mnemora/issues/548) 方向1 /
  [ADR 0282](./docs/decisions/0282-score-breakdown-affinity-measured.md)、PR #642）。
  ⭕ 既存欄は型・名前・必須性とも無変更。
- **`@mnemora/local-embedding` の `LocalEmbeddingProviderOptions`/`LocalEmbeddingModelSpec` に
  任意欄 `revision?: string` を足し、`pipeline()` へ素通しするようにした**——モデルの repo・
  ミラーの汚染を固定の revision で予防できる
  （[Issue #597](https://github.com/takecchi/mnemora/issues/597)、PR #664）。
  ⭕ 省略時は既定（transformers.js の `"main"`）のまま。
- **`RecallQuery`/`RecallScope`/`VectorFilter`/`LexicalFilter` に任意欄
  `includeSubjectless?: boolean` を足した**——「subject X、または主題なし」を1回の `recall()`
  で引けるようにする（[Issue #608](https://github.com/takecchi/mnemora/issues/608) ③(b) /
  [ADR 0286](./docs/decisions/0286-recall-include-subjectless.md)、PR #679）。
  ⭕ 既定（省略・`false`）の挙動は無変更。
- **`observe` の入力に任意欄 `subjectCandidates?: string[]` を足し、抽出器に主題を候補一覧から
  選ばせられるようにした**——一覧に無い値は runtime が弾き、弾いた値を
  `ObserveResult.rejectedSubjectIds?` に返す
  （[Issue #608](https://github.com/takecchi/mnemora/issues/608) 項目②(b) /
  [ADR 0287](./docs/decisions/0287-extraction-subject-candidates-caller-supplied.md)、PR #680）。
  ⭕ 候補を渡さない呼び出しはプロンプト（カセット鍵）も挙動も無変更。
- **`AnnUnreachedOmission` に任意欄 `severity?: "info" | "warning"` を足した**——同じ `recall()`
  で ANN 窓が実際に到達可能な下限に届かなかったときだけ `"warning"`、構造的に鳴っているだけなら
  `"info"`。呼び手が構造的発火と実損の兆候を濾せるようにする
  （[Issue #361](https://github.com/takecchi/mnemora/issues/361) /
  [ADR 0288](./docs/decisions/0288-ann-unreached-severity.md)、PR #682）。
- **`RecalledMemory` に任意欄 `speaker?: string | null`・`subjectId?: string | null` を足した**——
  recall の場で誰が言ったか・誰との会話かが見えるようにする
  （Issue #579 案D /
  [ADR 0289](./docs/decisions/0289-recalled-memory-speaker-subject.md)、PR #684）。
- **観測（`observe`）に呼び手が渡す任意の `extractionContext`（保存した文脈と日時）を抽出へ
  渡せるようにした**——単独発話では失われる同意の対象・話者・相対日付を、同期・非同期・
  再抽出の経路すべてで同じ入力として使う。省略時は既存プロンプトのまま
  （Refs #689 /
  [ADR 0299](./docs/decisions/0299-extraction-context.md)、PR #694）。
  ⚠ 曖昧な参照・複雑な日時表現は未評価。既定経路の置換ではない。
- **`RecallQuery`/`ScoringInput` に任意欄 `timeWeighting?: "legacy" | "eventAwareFreshness"` を
  足した**——`"eventAwareFreshness"` を明示すると、`occurredAt` を持たない記憶（恒常的な事実・
  好み）の `freshness` を、記録時刻の古さで二重に減衰させなくなる。**省略時は `"legacy"` で
  既定の挙動は無変更**（[Issue #690](https://github.com/takecchi/mnemora/issues/690) /
  [ADR 0300](./docs/decisions/0300-time-weighting-policy-opt-in.md)、PR #697）。
  併せて `@mnemora/openai` の `OpenAILLMProviderOptions` に任意欄 `temperature?: number` を
  足した（純追加、既定は渡さない——既存呼び出しの挙動は無変更、PR #697）。
- **`RecalledMemory` に任意欄 `recordedAt?: Date`・`occurredAt?: Date | null` を足した**——
  回答生成側で「後で訂正された」を時点から読めるようにする下地
  （[Issue #702](https://github.com/takecchi/mnemora/issues/702) /
  [ADR 0298](./docs/decisions/0298-recalled-memory-recorded-occurred-at.md)、PR #703）。
- **`EmbeddingProvider` の契約に「上限超過は例外。黙って切り詰めたベクトルを返さない」を
  明記し、testkit 適合 suite に任意欄 `overLimitText?: string` を足した**——省略時は
  「測っていない」と `it.skip` で名乗る
  （[Issue #449](https://github.com/takecchi/mnemora/issues/449) /
  [ADR 0305](./docs/decisions/0305-embedding-provider-input-limit-contract.md)、PR #715）。
- **`@mnemora/testkit` に `SeededLLMProvider`/`SeededEmbeddingProvider` を足した**——「種
  カセット」から実 API を呼ばずに再生し、種に無い入力だけ実 API（delegate）へ渡す provider
  （記録そのものは別層が担う）
  （Issue #691 /
  [ADR 0309](./docs/decisions/0309-answer-prompt-order-legend-and-cassette-migration.md)、
  PR #716）。
- **`@mnemora/postgres` に taxonomy（`labels`/`memory_labels`）の保存・語彙側を足した（PR-A）**
  ——`tags` の書き込みから `proposed` ラベルを同一トランザクションで自動生成し、
  `MemoryStore.listLabels?`/`registerLabel?`（いずれも**任意**メソッド）・
  `TenantSettingsStore.getTaxonomyMode?`/`setTaxonomyMode?` で語彙を管理する。新しい migration
  `0020_taxonomy_labels.sql` を含む（[Issue #201](https://github.com/takecchi/mnemora/issues/201) /
  [ADR 0318](./docs/decisions/0318-taxonomy-labels.md)、PR #717）。
  ⭕ 既存の `tagMatch` 加点・`taxonomy_mode` に関わらないスコアリングは無変更。
- **`observe`/`recall` に呼び手専用の `attributes?: Record<string,string>` を足した**——
  公開範囲・区分などの、mnemora が解釈しない申告された属性を、段1（ANN・語彙）・段3.5から
  絞り込める。新しい migration `0019_observations_memories_attributes.sql` を含む
  （[Issue #152](https://github.com/takecchi/mnemora/issues/152)/
  [Issue #153](https://github.com/takecchi/mnemora/issues/153) /
  [ADR 0312](./docs/decisions/0312-observe-recall-caller-attributes.md)、PR #724）。
  ⭕ 絞り込みの挙動・既定値は無変更。⚠ **訂正**（初出時の記述は不正確だった）:
  `recall()` の返り値には常に `RecalledMemory.attributes` が載るようになる——`attributes`
  を渡さない呼び出しでも、対象の Memory が `attributes` を持たなくても欄自体は省略されない
  （詳細は下の `### Changed`）。
- **抽出に主張キー `claimKey: { subject, predicate }` を持たせた（(B) 第1段。既定 off・検出は
  まだしない）**——「この記憶は何についての主張か」を LLM に分類させて構造化された鍵として
  持たせるだけで、同じ鍵を持つ記憶どうしの衝突検出はこの段では行わない。新しい migration
  `0021_memories_claim_key.sql` を含む
  （[Issue #371](https://github.com/takecchi/mnemora/issues/371) /
  [ADR 0320](./docs/decisions/0320-claim-key-field-implementation.md)、PR #736）。
  ⚠ **訂正**（初出時の「既定 off」は値の導出だけを指しており、欄そのものの挙動を書いて
  いなかった）: 「既定 off」は LLM を呼んで値を導出する opt-in（`observe` の
  `claimKey?: ClaimKeyOptions`）についてであり、抽出で作られる `Memory` 自体には
  opt-in の有無に関わらず常に `claimKey` 欄（値が無ければ `null`）が入る（詳細は下の
  `### Changed`）。
- **`@mnemora/postgres` に opt-in の語彙ストア `PostgresTrigramLexicalStore` を足した**——
  `pg_trgm` で日本語（非 ASCII）部分を照合する。`PostgresTrigramLexicalStore.create()` が拡張と
  ロケール（`server_encoding`・日本語トライグラムの自己一致）を検査し、満たせなければ投げる
  （黙って0件にしない）（[Issue #278](https://github.com/takecchi/mnemora/issues/278) /
  [ADR 0319](./docs/decisions/0319-optional-trigram-lexical-store.md)、PR #738）。
  ⭕ **既定は変えていない**——`PostgresLexicalStore`・`REQUIRED_EXTENSIONS`・migration は無変更で、
  導入側が差し替えたときだけ効く。
  ⚠ 選定に使っていない質問文での精度・閾値は測っていない（ADR 0319）。
- **taxonomy の recall 側絞り込みを実装した（PR-B。Closes #201）**——`RecallQuery.labels?:
  string[]`（OR の集合絞り込み）・`taxonomyGroups?: boolean`（既定 `false`）を新設し、
  `taxonomy_mode`（open/strict）に応じた参加資格で段1・段3.5・`aggregateScope` を絞る。
  `GroupCount.axis: 'taxonomy'`・`FilteredOmission.condition: 'taxonomy'` も新設
  （[Issue #201](https://github.com/takecchi/mnemora/issues/201) /
  [ADR 0323](./docs/decisions/0323-taxonomy-recall-filter.md)、PR #743）。
- **主張キーの衝突を列と索引で検出し `contested` にする（(B) 第2段、既定 off）**——同じ
  `claimKey`（正規化済み）を持つ複数の Memory を検出する。既定では発火しない
  （[Issue #372](https://github.com/takecchi/mnemora/issues/372) /
  [ADR 0324](./docs/decisions/0324-claim-key-contested-detection.md)、PR #745）。
- **`MemoryStore` に任意メソッド `listActiveClaimPredicates?` を足し、`ClaimKeyOptions.
  knownPredicatesFromStore?`（既定 off）で claim key 派生の語彙ヒントを店の既存 predicate
  一覧から動的に集められるようにした**——ADR 0326「採らなかった案B」の実装。real データ
  （`examples/chat` の `answer` 経路、n=3）で訂正の predicate 一致・`contested` 成立を
  0/4→4/4 に改善したが、誤検出も1/14→3〜4/14 に増える副作用が実測された
  （[Issue #691](https://github.com/takecchi/mnemora/issues/691) /
  [ADR 0329](./docs/decisions/0329-claim-key-known-predicates-from-store.md)、PR #750）。
- **`RecalledMemory` に任意欄 `contestedWith?: MemoryId` を足した**——矛盾する2件が
  同伴取得（`retrievedVia: 'mandatory_companion'`、`companionOf`）を経由せず、
  `"ann"`/`"lexical"` で両方とも自然に候補に入った場合にも、相手の memoryId を返す
  （`companionOf` の意味は無変更）。相手が budget 切り詰め後の最終的な結果集合に
  含まれるときだけ付く（オーナーの決定、ask_human 327fd89b /
  [Issue #691](https://github.com/takecchi/mnemora/issues/691) /
  [ADR 0335](./docs/decisions/0335-recalled-memory-contested-with.md)、PR #832）。
  ⭕ `RecallRecordMemory`（`recalls.returned_memories` への永続化）は変更していない
  （ADR 0335「引き受けた負債」参照）。
- **`RuntimeDeps` に任意欄 `embeddingInput?: (memory: Memory) => string` を足した**——
  埋め込み入力の上限超過で `embeddingStatus: 'failed'` になった Memory を、`reembed()`
  （ADR 0079）だけでは回復できなかった問題に、opt-in の回復手段を用意する。省略時は
  `memory.content` をそのまま送る従来どおりの挙動（`Memory.content` 自体はどちらの場合も
  無変更）（[Issue #753](https://github.com/takecchi/mnemora/issues/753) /
  [ADR 0336](./docs/decisions/0336-embedding-input-opt-in-hook.md)、PR #834）。

### Changed（後方互換だが挙動が変わりうるもの）

- **`@mnemora/postgres` の語彙チャンネルで `ts_rank_cd` の normalization ビットに文書長
  （`1 + ln(length)`）の項を足した（`TS_RANK_CD_NORMALIZATION` を `32` から `32 | 1` = `33`
  へ）**——被覆率が同じでも内容量が違う候補の `rank` が完全同点になる問題を減らす。`rank` は
  段2のスコア（`LexicalHit.coverage`/`ScoreBreakdown.lexicalMatch`）には入らないが、段1の
  `PostgresLexicalStore.search()` の `ORDER BY`/`LIMIT` による切り詰めには効く——**そのため
  段1の窓境界に近い候補の並びが変わりうる**（日本語本文に埋もれた単一 ASCII 識別子では効果は
  限定的、とADRに明記）。
  （[Issue #394](https://github.com/takecchi/mnemora/issues/394) /
  [ADR 0308](./docs/decisions/0308-lexical-rank-length-normalization.md)、PR #711）。
- **`estimateRecallFootprint`/`calibrateRecallFootprint`（想起の想定文字数の見積もり）の精度を
  直し、既定の係数が変わった。**`indexBand` の実 JSON 構造から決まる帯のカンマ・桁上がり・`limitedBy` などの
  構造項が推定式から欠落しており、`calibrateRecallFootprint` はその構造項を較正の前に
  差し引けず二重計上していた。較正標本も CI artifact から7点→15点に増やし、hold-in/hold-out の
  分け方を「帯が空であること」そのものに揃えた。**この結果、既定プロファイル
  `BUILTIN_RECALL_FOOTPRINT_PROFILE` の値が変わった**——`charsPerDigest` は
  `15.458` → **`16.175`**、`fixedIndexChars` は `170.881` → **`168.503`**（【実測】
  `git diff v1.0.0..7987de4 -- packages/core/src/recall-footprint.ts`）。既定プロファイルで
  見積もりを使っている呼び手が受け取る数値は変わるが、公開の型・関数シグネチャは無変更
  （[Issue #340](https://github.com/takecchi/mnemora/issues/340) /
  [ADR 0302](./docs/decisions/0302-recall-footprint-structural-terms.md) /
  [ADR 0306](./docs/decisions/0306-recall-footprint-calibration-subtracts-structural-terms.md) /
  [ADR 0314](./docs/decisions/0314-recall-footprint-calibration-samples-need-ci-sourcing.md)、
  PR #710 / #722 / #728）。
- **`recall()` の既定の呼び出し（`attributes` によるフィルタを渡さない呼び出しを含む）でも、
  返ってくる `RecalledMemory` には `attributes` 欄が常に載るようになった**——対象の Memory が
  `attributes` を持たない場合は `{}`（`packages/core/src/recall-runtime.ts` の
  `attributes: member.memory.attributes ?? {}`）。絞り込みの挙動そのものは無変更だが、
  `RecalledMemory` の形（返り値の欄の有無）は変わる——欄の有無を見る比較・スナップショットは
  影響を受けうる
  （[Issue #152](https://github.com/takecchi/mnemora/issues/152) /
  [Issue #153](https://github.com/takecchi/mnemora/issues/153) /
  [ADR 0312](./docs/decisions/0312-observe-recall-caller-attributes.md)、PR #724）。
- **抽出（`observe` → 抽出）で作られる `Memory` には、claim key opt-in を使っていない
  呼び出しでも `claimKey: null` が常に入るようになった（欄が省略されることは無い）**——
  `buildNewMemoryFromCandidate`（`packages/core/src/extraction.ts`）が
  `claimKey: params.claimKey ?? null` を常に書く。`@mnemora/postgres` から読み出した
  `Memory`（`rowToMemory`、`packages/postgres/src/mapping.ts`）も同様に、値が無ければ
  `claimKey: null` を返す——読み出し側でも欄自体は省略されない。**LLM を呼んで値を導出する
  opt-in（`observe` の `claimKey?: ClaimKeyOptions`）は引き続き既定 off**——変わるのは
  欄の有無であって、値が付く条件ではない
  （[Issue #371](https://github.com/takecchi/mnemora/issues/371) /
  [ADR 0320](./docs/decisions/0320-claim-key-field-implementation.md)、PR #736）。
- **`@mnemora/testkit` の `InMemoryVectorStore.search`（擬似 `VectorStore`）で、距離が完全
  一致したヒットの順序を、挿入順から Postgres と同じ3段 tie-break（距離 → `recordedAt`
  DESC → `memoryId` 昇順）に揃えた。** `VectorStore.search` の interface（ADR 0170）は
  同点でも決定的な順序を返すことを約束しているが、擬似物はこれまで
  `Array.prototype.sort` の安定性により挿入順（通常の呼び出し順では `recordedAt` の
  古い方が先）に落ちており、Postgres の「新しい方が先」とは逆向きだった。返す形
  （`{ memoryId, distance }`）は変えていない
  （[Issue #339](https://github.com/takecchi/mnemora/issues/339) /
  [ADR 0049](./docs/decisions/0049-reinforce-monotonicity-in-pseudo-implementations.md) /
  [ADR 0170](./docs/decisions/0170-association-search-tiebreak-nondeterminism.md)、
  PR #828）。
  ⚠ 擬似物の同点順序に依存する呼び出し側（自前のテスト・スナップショット等）があれば、
  結果が変わりうる。

### Fixed

- **`@mnemora/postgres` の段1 `search()` で、他テナントの near-duplicate が HNSW の候補窓
  （既定 `hnsw.ef_search`=40）を埋め尽くすと、自テナントの候補を1件も見ないまま `recall()` が
  0件を返すことがあった。** `PostgresVectorStore.search()` に
  `SET LOCAL hnsw.iterative_scan = relaxed_order` を採用して塞いだ（ADR 0063 決定1 を、
  当時測っていなかった条件の新しい実測で覆す）。併せて、ANN 窓が実際に到達可能な下限に
  届かなかったことを `RecallResult.explain.stages` の型無し診断欄
  （`annReturnedFewerThanReachable`）に名乗らせるようにした——「探して見つからなかった」と
  「探していない」を同じ顔で返さないため
  （[Issue #671](https://github.com/takecchi/mnemora/issues/671) /
  [ADR 0284](./docs/decisions/0284-hnsw-iterative-scan-relaxed-order-adopted.md) /
  [ADR 0285](./docs/decisions/0285-ann-window-empty-of-in-scope-candidates-stage-detail.md)、
  PR #673 / #672 / #676）。
  ⭕ **公開型は変えていない**——診断欄は `explain.stages[...].detail` の型無し欄に条件成立時
  だけ足す形で、既定の出力は変わらない。SQL の `WHERE`/`ORDER BY` も変えていない。
- **`sanitizeCandidateSubjectId` が、LLM が「主題なし」のつもりで返す文字列 `"null"`（JSON の
  `null` リテラルではない）を、候補一覧に無い値として弾いていた。**弾かれた値は
  `undefined`（未指定）へ戻り、意図せず observation の主題へフォールバックしていた
  （実 API で `gpt-4o-mini` に対し5/5回再現）。候補一覧に文字列 `"null"` 自体が含まれていない
  場合に限り、明示的な主題なしとして扱う特例を追加した
  （[Issue #608](https://github.com/takecchi/mnemora/issues/608) /
  [ADR 0304](./docs/decisions/0304-subject-candidates-string-null-literal.md)、PR #712）。
- **自動経路（`RuntimeConfig.autoQueueConsolidateReflectOnExtract: true` のときに `tick()` が
  処理する `consolidate` ジョブ、`processConsolidateJob`）が、subject をまたいで統合し、
  統合後の `Memory.subjectId` が `null` に畳まれることがあった。** `tick()` は `consolidate`
  ジョブを subject で絞って claim できないため、`tick()` に渡した `ctx.subjectId` と種の
  `subjectId` が食い違うと、近傍探索が種と別の subject から候補を拾っていた。
  `processConsolidateJob` は、種の Memory の `subjectId` を `ctx.subjectId` に置いてから
  `consolidate()` を呼ぶように直した——種が見つからない、または種の `subjectId` が `null` の
  場合は今日どおり（[Issue #579](https://github.com/takecchi/mnemora/issues/579) /
  [ADR 0310](./docs/decisions/0310-subject-crossing-consolidate-frequency-measured.md) /
  [ADR 0317](./docs/decisions/0317-auto-consolidate-scopes-neighbor-search-to-seed-subject.md)、
  PR #733）。
  ⭕ **公開型は変えていない**——`autoQueueConsolidateReflectOnExtract` の既定（`false`）の
  利用者には何も起きない。migration も不要。
  ⚠ **フラグを有効にしている利用者から見ると挙動が変わる**——subject をまたぐ統合が
  構造的に起きなくなる（実測は ADR 0310/0317）。
  明示的な `runtime.consolidate(ctx, { target: { seedMemoryId } })` の呼び出しは変えていない。
- **`@mnemora/postgres` の `runMigrations()` に、`schema` の違う呼び出しを同じ（まっさらな）
  DB へ同時に流すと `CREATE EXTENSION IF NOT EXISTS` が `pg_extension_name_index`（拡張は
  DB 全体に1つしか置けない）で衝突し、決定的にどちらかが落ちることがあった。** 拡張を
  作る段だけを、schema に依らない共有の advisory lock（新設の `EXTENSION_LOCK_KEY`）で
  追加に直列化した——schema ごとのロック（ADR 0057 決定6）はそのまま残し、取得順は常に
  「schema ごとのロック → 共有の拡張ロック」に固定してある（逆順は無い）
  （[Issue #757](https://github.com/takecchi/mnemora/issues/757) /
  [ADR 0331](./docs/decisions/0331-extension-creation-shared-advisory-lock.md)、PR #780）。
  ⭕ **公開型・既定値は変えていない**——`extensionMode: "verify"` はこの共有ロックも
  一切参照しない。⚠ `schema` 未指定の経路は、初回適用時だけ advisory lock の制御用
  クエリが2回増える（DDL・DML は1文字も変わらない。ADR 0057 決定2との関係は ADR 0331
  参照）。

- **`@mnemora/postgres` の `registerEmbeddingSpace()` に `dimensions > 2000` を渡すと、
  `CREATE TABLE IF NOT EXISTS` は成功するが続く HNSW 索引の作成が pgvector の `54000`
  （"column cannot have more than 2000 dimensions for hnsw index"）で失敗し、**テーブルだけが
  DB に残っていた**（ADR 0018 が「C-2」として実測・記録していたが、当時は直さない方針だった）。
  テーブルを作る前（advisory lock を取る前の既存バリデーションと同じ場所）で
  `dimensions > 2000` を拒否するようにした。上限値 2000 は pgvector の README（`vector` 型に
  対する HNSW 索引: "up to 2,000 dimensions"）と、手元の pgvector 0.8.0 に対する実測の
  両方で裏取りしている
  （[Issue #776](https://github.com/takecchi/mnemora/issues/776) /
  ADR 0018 追記、PR #777）。
  ⭕ **公開型は変えていない**——新しいエラークラスは足さず、既存の dimensions バリデーション
  （`Number.isInteger(dimensions) && dimensions > 0`）と同じ流儀（`Error`）で拒否する。
  `dimensions <= 2000` の既存呼び出しの挙動は無変更。
- **`@mnemora/testkit` の `TenantSettingsStoreConformanceOptions.supportsTaxonomyMode`・
  `MemoryStoreConformanceOptions.supportsLabels`/`supportsFindActiveByClaimKey` が、
  v1.0.0 には無かったにもかかわらず必須の `boolean` として足され、v1.0.0 時点の
  `describeTenantSettingsStoreConformance(...)`/`describeMemoryStoreConformance(...)`
  呼び出しをコンパイルできなくしていた。** 3つとも `?: boolean` へ戻し、省略時は
  該当する適合項目を実行しない（`false` 相当）
  （[Issue #818](https://github.com/takecchi/mnemora/issues/818) /
  [ADR 0318](./docs/decisions/0318-taxonomy-labels.md) 追記 /
  [ADR 0324](./docs/decisions/0324-claim-key-contested-detection.md) 追記）。
  ⭕ **この repo に同梱の実装（`packages/postgres`/`packages/testkit`）の呼び出しは
  引き続き明示で `true` を渡しており、挙動は無変更。**
- **`packDigestBand`（`packages/core/src/digest-band.ts`）に負数の `maxEntryChars` を渡すと、
  `String.prototype.slice` の「末尾から除く」意味に化けて切り詰めが効かず、ほぼ全文が
  残っていた。** `Math.max(0, maxEntryChars)` で下限0にクランプした。正の値の既存呼び出しの
  挙動は無変更（PR #801）。
- **`truncateForFallbackDigest`（`packages/core/src/extraction.ts`、digest 生成の安全弁）にも
  同じ形の不具合があった**——負数の `maxLength` で同じく切り詰めが効かなかった。同様に
  `Math.max(0, maxLength)` でクランプした。正の値の既存呼び出しの挙動は無変更（PR #802）。
- **`@mnemora/openai` の strict モード向け JSON Schema 変換（`makeNullable`）で、省略可能な
  `z.enum`/`z.literal` が `null` を選べず実質必須になっていた。** `const` を持つ形は
  `anyOf` で包み、`enum` を持つ形は `enum` にも `null` を足すよう直した。core が現に渡す
  3スキーマ（`ExtractionResultSchema`/`ClaimKeyBatchResultSchema`/`ConsolidationLLMResultSchema`）
  の翻訳結果はバイト単位で不変——既存カセットに影響しない（PR #808）。
  ⚠ 独自のスキーマで `completeStructured()` を呼ぶ呼び出し側には、出力が変わりうる。
- **`@mnemora/local-embedding` の `LocalEmbeddingProvider` に `retry: { attempts: NaN }` を
  渡すと、`Math.max(1, NaN)` が `NaN` になり、モデルを一度も読み込もうとせず（読み込みの
  `for` ループが一度も回らず）原因不明のエラーになっていた。** `NaN` は0以下と同じ扱いに
  倒し、1回は試みるよう直した。既定値・正の値の挙動は無変更（PR #810）。
- **`@mnemora/testkit` の `InMemoryMemoryStore.getMany`・`InMemoryVectorStore.getVectors`
  （擬似実装）が、重複した id を渡されると重複したまま返していた。** Postgres 実装と同じく
  1件に畳むよう直した。適合テストには触れていない（Issue #809）
  （PR #812 / #814）。
- **`recall()` の段3（必須の同伴取得）が、forget 済み（または `contested` でなくなった）
  対向を companion として返すことがあった。** `contested` の組の片方を `forget()`（または
  直接の status 書き換え）した後も、生き残った側が recall に当たると forget 済みの相手が
  `retrievedVia: "mandatory_companion"` として結果に混ざり、「forget した記憶は recall に
  出ない」（[ADR 0087](./docs/decisions/0087-runtime-forget-shape.md) 決定6）に違反していた。
  段3の companion フィルタに `status === "contested"` を足した——弾かれた対向は「対向が
  見つからない contested」と同じ扱いに倒れ、既存の `unit_assembly_dropped`（ADR 0043）に
  合流する。新しい Omission 種別も公開 API の変更も無い（PR #824）。
  ⚠ **既定の recall 結果が変わりうる**——`contested` の組の片方を forget した状態で、
  もう片方が recall に当たる呼び出し。

---

## [1.0.0] - 2026-09-23

**Release**: [v1.0.0](https://github.com/takecchi/mnemora/releases/tag/v1.0.0)（pre-release ではない）。
**tag が指すのは `c27ca959`**、**前の版は `v0.5.0`**（`509f4e7`）。⟹ **この節は
`v0.5.0` → `v1.0.0` の差分である**（【実測】`git rev-list --count v0.5.0..v1.0.0` = 29）。
⚠ **published は `2026-09-22T23:54:08Z`（UTC）である**——**見出しの日付は JST**（この repo の
commit の日付と同じ `+0900`）。🔴 **この版も UTC と JST で日付が1日ずれる**——UTC では 9/22、
JST では 9/23（08:54）である。⚠ **tag が指す commit 自体の日付は `2026-09-23 05:31 +0900` で、
出荷の3時間あまり前である**——**commit の時と出荷の時は別物である**（この版では JST の日付は揃った）。

⭐ **この節は Release を作る *前* に起こしてあった**（[docs/release-v1.md](./docs/release-v1.md) §0.10 /
[ADR 0252](./docs/decisions/0252-release-changelog-section-is-a-publish-gate.md)）。⟹ **上の段落がいま埋まっているのは、
同 §0.10 が「後からしか分からない事実（`published` の時刻・Release へのリンク）は後から埋めてよい」と
定めているのに従って、公開後にその時点の現物で埋めたからである。**

🔴 **この版の Release 本文は、前の版と違って自動生成ではない。**【実測】
`gh release view v1.0.0 --json body -q .body | grep -c '^\* '` は **0** を返す（`v0.5.0` は 8 だった）。
⟹ **本文は [docs/release-notes-v1.0.0.md](./docs/release-notes-v1.0.0.md) の草稿を起こしたもので、
commit を無差別に並べた一覧ではない。**⟹ ⭐ **「分類も除外もこの節が初めて与える」という前の版での
関係は、この版には当てはまらない。**

**この節は `v0.5.0` からの差分を対象とする。**⭐ **`v0.4.0` → `v0.5.0` の分は、下の `[0.5.0]` 節に在る**
——⛔ **この節へ混ぜない。**

🔴 **出荷される面は、`v0.5.0` から1バイトも動かなかった。**【実測、⭐ **両端が tag なので範囲は閉じている**】:

```
$ git diff --stat v0.5.0..v1.0.0 -- packages/                              → （差分なし）
$ git diff --stat v0.5.0..v1.0.0 -- scripts/__snapshots__/public-api/      → （差分なし）
```

⟹ **この節に項目が1件も並んでいないのは、書き漏れではない。**
⭐ **そしてこの2本は、節を起こした時点の `v0.5.0..origin/main` と違って、もう腐らない**
——**両端が tag に固定されているからである。**

⭐ **数えた基準を明記する。**この節は `v0.5.0` … **`509f4e7`** の範囲を数えたものである。
⭐ **この sha が名乗るのは「この節がどこまで数えたか」であって、「ここで打ち切った」ではない。**
⟹ ⭕ **`origin/main` がこれより進んでいても、この節は腐っていない**——**まだ数えていない範囲が
増えただけである。**読む人は `git log --oneline 509f4e7..origin/main` で、その増分を自分で見られる。
🔴 **この性質が成り立つのは、この節が件数を持たないからである。**
⛔ **ここに件数を書かないこと**——書いた瞬間、次の1件が着地した時点で腐る
（[#433](https://github.com/takecchi/mnemora/issues/433) /
[ADR 0234](./docs/decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。
**数えるなら、下の項目そのものを数えること。**
⚠ **この pin は `scripts/release-candidates.mjs` の入力でもある**
（[ADR 0214](./docs/decisions/0214-release-candidates-lists-not-judges.md) 決定5。⛔ 道具は書き換えない）。

### 🔴 この pin を置いた時点で、`v0.5.0` と `origin/main` は同じ commit だった

**【実測 2026-09-21】**pin を置いた時点では `git rev-parse origin/main v0.5.0^{commit}` が
2行とも `509f4e739ca1ad017876a5b661062d23c2ead773` を返し、
`git rev-list --count v0.5.0..origin/main` は **0** だった。
⟹ **この節が空なのは、まだ数えていないからではなく、数える範囲そのものが空だったからである。**

🔴 **⛔ ただし、その2つのコマンドを「この節が今も空か」の検査に使わないこと。**
**どちらも docs だけの commit で動く**——**実際、この節を書いた commit 自身が `main` を1本進めた。**
⟹ ⭐ **「利用者に届く変更が在るか」を見たいなら、出荷される面を直接当てること:**

```
$ git diff --stat v0.5.0..origin/main -- packages/                      → （差分なし）
$ git diff --stat v0.5.0..origin/main -- scripts/__snapshots__/public-api/  → （差分なし）
```

⚠ **この2本も「利用者に見える変更が無い」の証明ではない**——**publish 対象の外の `scripts/` や
`examples/` は当たらないし、`packages/` の差分がテストだけのこともある。**
⟹ ⭐ **下の「数え直すこと」に従って、その場で一覧を出すこと。**
⚠ **上の2本は、節を起こした時点では `v0.5.0..origin/main` を当てた予告だった**
——⛔ **「何も載らない」の証明ではなかった。**⟹ ⭐ **出荷された今は `v0.5.0..v1.0.0` で引き直してあり**
（この節の冒頭）、**予告ではなく閉じた範囲の実測になっている。**
⚠ **次の版を切る側は、この pin ではなく `v1.0.0` から数え直すこと**
（道具は `node scripts/release-candidates.mjs --since v1.0.0`。
⚠ **`--since` を省くと最新リリースの tag が入る**——**いまは `v1.0.0` なので一致するが、
次の Release が出れば一致しなくなる。**⟹ 明示して撃つこと）。

⟹ ⭐ **`v0.5.0` の利用者に届く変更は、結果として1件も無かった。**
**`v1.0.0` が節目なのは、コードが変わったからではない。**理由は
[docs/roadmap.md](./docs/roadmap.md) の §7 と
[docs/release-notes-v1.0.0.md](./docs/release-notes-v1.0.0.md) に在る。

⭐ **「`v1.0.0` へ上げるときに何が壊れるか」の正本は
[docs/migration-v1.md](./docs/migration-v1.md) である**——**あちらは世代ごとに分けてある。**
🔴 **`v0.4.0` からの利用者が受ける破壊的変更は、この節ではなく下の `[0.5.0]` 節に在る**
——**`v0.5.0` で出荷済みだからである。**

⚠ **`v1.0.0` をいつ切るかは、この節を書いた時点では決まっていなかった。**
⟹ **出たのは `2026-09-22T23:54:08Z`（UTC）である**（上の冒頭）。7項目の現在地は
[docs/roadmap.md](./docs/roadmap.md) の **§7 の末尾の節**に在る
（⛔ **節番号を固定で信じないこと**——同文書は前の節を書き換えず、後から決まったことを
新しい節として積む。⟹ `grep -nE '^### 7\.[0-9]+ ' docs/roadmap.md` の末尾を見ること）。
**Release 本文の草稿は [docs/release-notes-v1.0.0.md](./docs/release-notes-v1.0.0.md) に在る。**
⛔ **どちらも件数をここへ写さない**——正は各文書である。

---

## [0.5.0] - 2026-09-21

**Release**: [v0.5.0](https://github.com/takecchi/mnemora/releases/tag/v0.5.0)（pre-release ではない）。
**tag が指すのは `509f4e7`**、**前の版は `v0.4.0`**（`3cf2663`）。⟹ **この節は
`v0.4.0` → `v0.5.0` の差分である**（【実測】`git rev-list --count v0.4.0..v0.5.0` = 8）。
⚠ **published は `2026-09-20T15:25:56Z`（UTC）である**——**見出しの日付は JST**（この repo の
commit の日付と同じ `+0900`）。🔴 **この版は UTC と JST で日付が1日ずれる**
——UTC では 9/20、JST では 9/21（00:25）である。⚠ **tag が指す commit 自体の日付は
`2026-09-19 13:42 +0900` で、さらに前である**——**commit の日と出荷の日は別物である。**

⚠ **GitHub の Release `v0.5.0` の本文は自動生成であり、8 commit を無差別に1行ずつ
並べたものである**【実測】（`gh release view v0.5.0 --json body -q .body | grep -c '^\* '` = 8）。
⟹ ⭐ **分類も、docs のみ・テストのみの除外も、この節が初めて与える。**

🔴 **この節も、出荷に遅れて起こしたものである。これで3回目である。**
`v0.5.0` が published された時点では、`[1.0.0]`（未リリース）の節が逐語で
「**この節に並ぶものは、1件も出荷されていない**」と名乗り、pin を `v0.4.0 … 420e0f4` に置いていた
——**どちらも、その時点で既に偽だった。**
⚠ **同じ形は `v0.3.0`（[Issue #536](https://github.com/takecchi/mnemora/issues/536)）と
`v0.4.0`（[ADR 0248](./docs/decisions/0248-changelog-and-migration-guide-follow-the-release.md)）でも起きている。**
⭐ **ただし今回は、リリース直後に機械が名指しで知らせていた**——
[ADR 0251](./docs/decisions/0251-release-follow-up-notice-not-a-gate.md) の
「Release follow-up notice」が `v0.5.0` の tag で走り、逐語で
「**🔴 CHANGELOG.md に `## [0.5.0]` の節が無い。**」と出力して終わっている（⛔ **門ではないので、何も止めていない**）。
🔴 **⟹ 3回目は「気づけなかった」ではなく「知らされたが、追随が遅れた」である。**

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更は `@mnemora/local-embedding` の1本だけに在る**
（`@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` / `@mnemora/openai` /
`@mnemora/anthropic` に破壊的変更は無い）。

**postgres 利用者へ**: ⭕ **新しいマイグレーションは無い。**
【実測】`git diff --stat v0.4.0..v0.5.0 -- packages/postgres/migrations/` は**差分を返さない**。
⟹ **`v0.4.0` から `v0.5.0` へ上げるのに `migrate` は要らない**
（⚠ **`v0.3.0` 以前から上げるなら要る**——`0018` が `v0.4.0` に在る。
[docs/migration-v1.md](./docs/migration-v1.md) を見ること）。

### ⭐ この節が数えた範囲の全体（⛔ 見落としが無いことを、後から検算できる形で残す）

**【実測 2026-09-21】出荷される面のソースを触ったのは、次の2ファイルだけである。**

```
$ git diff --name-only v0.4.0..v0.5.0 \
    | grep -E '^(packages|examples|scripts)/' \
    | grep -vE '__tests__|\.test\.ts|__fixtures__'
packages/core/src/recall-runtime.ts
packages/local-embedding/README.md
packages/local-embedding/src/local-embedding-provider.ts
scripts/check-release-changelog-section.mjs
scripts/release-changelog-section-lib.mjs

$ git diff --stat v0.4.0..v0.5.0 -- scripts/__snapshots__/public-api/   → （差分なし）
$ git diff --stat v0.4.0..v0.5.0 -- packages/postgres/migrations/       → （差分なし）
```

⟹ **`scripts/` の2本は publish 対象の外**（出所は `scripts/publish-targets.mjs` の
`PUBLISH_TARGETS`。⛔ **本数も名前もここに写さない**——`AGENTS.md`）、
**`README.md` は挙動ではない** ⟹ ⭐ **残る2ファイルが、下に載せた2件に1対1で対応する。**
🔴 **そして公開 API の型スナップショットは1バイトも動いていない**
⟹ ⭐ **「型が変わったのに載っていない」形の見落としは、この世代には無い。**
⛔ **これは「利用者に見える変更が2件しか在りえない」の証明ではない**——
**型に現れない挙動の変更は、この2つのコマンドでは捕まらない。**上の一覧を人が読んで分類した。

### Breaking

⭐ **1件である。**⭕ **`v0.4.0` と `v0.5.0` の両端が tag で閉じているので、`main` が動いてもこの数は変わらない。**
⚠ **正本は [docs/migration-v1.md](./docs/migration-v1.md) の番号付き一覧の 18 であり、
下の表はその写しである**——**`#` 欄はあちらの通し番号で、この表の中での連番ではない。**

🔴 **この世代は、`[0.4.0]` までと壊れ方の種類が違う**——**型ではなく実行時に壊れる。**
【実測 2026-09-21】`git diff --stat v0.4.0..v0.5.0 -- scripts/__snapshots__/public-api/` は
**差分を返さない** ⟹ ⭕ **公開 API の型は1バイトも動いていない。**
⚠ それでも破壊的として数えるのは、移行ガイドの定義が逐語で
「**既存の利用者のコードが型検査 *または実行時* に壊れる変更**」だからである。

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 18 | `LocalEmbeddingProvider` のコンストラクタが、**既定と異なる `repo` を `modelId` 無しで渡された宣言**を `throw` で落とすようになった（`@mnemora/local-embedding`） | 🔴 **`repo` を既定以外にし、かつ `modelId` を渡していなかった人だけ。**⭕ `repo` を渡していないなら影響なし。⚠ **該当していた人は元から壊れていた側である**——`repo` は `space.model` に反映されず、別モデルのベクトルが同じ space へ静かに混ざっていた | [ADR 0247](./docs/decisions/0247-local-embedding-repo-model-id-declaration-guard.md) / [#142](https://github.com/takecchi/mnemora/issues/142)（PR #550） |

⚠ **移行手順は複製しない**——直し方は [docs/migration-v1.md](./docs/migration-v1.md) の項目 **18** を見ること。
⛔ **これを「#142 が解決した」と読まないこと**——#142 は2件を名指ししており、
**「実 API に一度も当てていない」ほうは手つかずで残っている**（同 Issue はいまも OPEN）。

### Changed（後方互換だが挙動が変わりうるもの）

- **連想枠（段3.5）の席が、減衰を含む順位で埋まるようになった**（`@mnemora/core`）。
  順位キーは `hit.similarity * score.total`（＝ `anchorSimilarity × decay × tagMatch × freshness × strength`）で、
  `maxCount` を超える候補が在るときに**席に座る記憶が変わる**
  （[ADR 0246](./docs/decisions/0246-association-rank-includes-decay.md) /
  [#402](https://github.com/takecchi/mnemora/issues/402)、PR #549）。

  ⚠ **以下は [ADR 0246](./docs/decisions/0246-association-rank-includes-decay.md)「誰が壊れうるか」からの逐語である**
  ——**この節の書き手はこの変更を作っておらず、自分で測り直してもいない**【受】:

  > **`RecallQuery.association` を渡している呼び手の、返る記憶の顔ぶれが変わりうる。**
  > … **型は1バイトも変わらない。**新しい欄も新しいつまみも無い ⟹ **破壊的変更ではない。**
  > … **既定 off なので、`association` を渡していない呼び手は1バイトも影響を受けない。**

  🔴 **この変更は、正典項目4 の判定にも効いている**——経緯は
  [docs/roadmap.md](./docs/roadmap.md) §7.17 と §7.18 に在る。

---

## [0.4.0] - 2026-09-19

**Release**: [v0.4.0](https://github.com/takecchi/mnemora/releases/tag/v0.4.0)（pre-release ではない）。
**tag が指すのは `3cf2663`**、**前の版は `v0.3.0`**（`6851629`）。⟹ **この節は
`v0.3.0` → `v0.4.0` の差分である**（【実測】`git rev-list --count v0.3.0..v0.4.0` = 27）。
⚠ **published は `2026-09-18T20:36:04Z`（UTC）である**——**見出しの日付は JST**（この repo の
commit の日付と同じ `+0900`）。⟹ **UTC で読むと1日ずれる。**

⚠ **GitHub の Release `v0.4.0` の本文は自動生成であり、27 commit を無差別に1行ずつ
並べたものである**【実測】（`gh release view v0.4.0 --json body -q .body | grep -c '^\* '` = 27）。
⟹ ⭐ **分類も、docs のみ・テストのみの除外も、この節が初めて与える。**

🔴 **この節は、出荷に遅れて起こしたものである。**`v0.4.0` が published された時点では、
中身は `[1.0.0]`（未リリース）の節に置かれたままで、同節は逐語で「**この節に並ぶものは、
1件も出荷されていない**」と名乗っていた。⚠ **同じ形の遅れは `v0.3.0` でも起きている**
（[Issue #536](https://github.com/takecchi/mnemora/issues/536) /
[ADR 0243](./docs/decisions/0243-changelog-lists-publish-targets-only.md)）⟹ **2回目である。**
経緯と、3回目を防ぐ手の検討は
[ADR 0248](./docs/decisions/0248-changelog-and-migration-guide-follow-the-release.md)。

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更は `@mnemora/core` / `@mnemora/testkit` の2本に在る**
（`@mnemora/postgres` / `@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding` に
破壊的変更は無い）。

**postgres 利用者へ**: 新しいマイグレーション（`0018`）が増えている。
⟹ **`v0.3.0` から上げるなら `pnpm --filter @mnemora/postgres run migrate` が要る。**
🔴 **「新機能を使うときだけ要る」ものではない**——理由と適用手順は
[docs/migration-v1.md](./docs/migration-v1.md) を見ること。このファイルには複製しない。

### Breaking

⭐ **6件である。**⭕ **`v0.3.0` と `v0.4.0` の両端が tag で閉じているので、`main` が動いてもこの数は変わらない。**
⚠ **正本は [docs/migration-v1.md](./docs/migration-v1.md) の番号付き一覧の 12〜17 であり、
下の表はその写しである**——**`#` 欄はあちらの通し番号で、この表の中での連番ではない。**

⚠ **壊れ方は2つの形に分かれる。**

**1つ目は「`interface` に必須メンバが増えた」形**（項目 **12**〜**16**）。
⟹ ⭕ **`createRuntime()` が返すものを使っているだけなら、何もしなくてよい。**
壊れるのは、**自分で `Runtime` を実装している側**と、**`@mnemora/testkit` の適合テストを
呼んでいる側**だけである。⚠ これは新しい判定基準ではない——`[0.2.0]` の Breaking 表
**1**・**5**・**6** が同じ理由で破壊的と数えられている。

🔴 **2つ目は「union に値が増えた」形**（項目 **17**）。⟹ **壊れるのは実装する側ではなく、消費する側である。**
⭕ **値を読むだけ・比較するだけなら非破壊**——`never` で網羅性を検査しているコードだけが壊れる。
⚠ これも新しい判定基準ではない——`[0.2.0]` の Breaking 表 **4** が同じ形で数えられている。

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 12 | `Runtime` に必須メソッド `restoreSuperseded` が増えた（`@mnemora/core`） | `Runtime` を自分で実装している側だけ。`createRuntime()` が返すものを使っているなら影響なし | [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md) / [#369](https://github.com/takecchi/mnemora/issues/369)（PR #464）。⚠ **ADR 0230 の本文だけを読むと、これが破壊的であることに気づけない**——2026-09-18 に冒頭への追記で名指しされた |
| 13 | `MemoryStoreConformanceOptions.supportsRestoreSupersededBy` が必須フィールドになった（`@mnemora/testkit`）。**12 と同じ PR #464 で入っている** | `describeMemoryStoreConformance` を呼んでいる側だけ | [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md)（PR #464）。🔴 **この項目は 2026-09-18 まで、CHANGELOG にも ADR にも一度も書かれていなかった** |
| 14 | `Runtime` に必須メソッド `findCorrectionCandidates` が増えた（`@mnemora/core`） | **12 と同じ** | [ADR 0232](./docs/decisions/0232-correction-candidates-returned-not-chosen.md) / [#369](https://github.com/takecchi/mnemora/issues/369)（PR #517） |
| 15 | `MemoryStoreConformanceOptions.supportsPreviewRestoreSupersededBy` が必須フィールドになった（`@mnemora/testkit`） | **13 と同じ** | [ADR 0237](./docs/decisions/0237-restore-superseded-dry-run-preview.md) / [#515](https://github.com/takecchi/mnemora/issues/515)（PR #524） |
| 16 | `Runtime` に必須メソッド `applyCorrection` が増えた（`@mnemora/core`）。`findCorrectionCandidates` が返した候補の中から**人が選んだ1件**を受け取り、`markContested` → `resolveContested` の書き込みまでを1つの口にまとめる | **12 と同じ** | [ADR 0242](./docs/decisions/0242-runtime-apply-correction.md) / [#369](https://github.com/takecchi/mnemora/issues/369)（PR #537） |
| 17 | 🔴 `MemoryEventKind` の union に `"unsuperseded"` が増えた（`@mnemora/core`）。**12・13 と同じ PR #464 で入っている** | ⚠ **届く経路は `EventStore` である**——`MemoryEvent.kind` は必須フィールドで、`EventStore.append`/`.get`/`.list` が返す。⟹ ⭕ **`Runtime` の口からは届かない**ので、**5つの動詞だけを使う利用者には影響しない。**⚠ **同じ形に対する扱いがこの repo に2つ在り、線は引かれていない**——[#541](https://github.com/takecchi/mnemora/issues/541) を見ること | [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md)（PR #464） |

⚠ **移行手順は複製しない**——直し方は
[docs/migration-v1.md](./docs/migration-v1.md) の同じ番号の項目を見ること。

### Added

- **`Runtime.restoreSuperseded`**（および `MemoryStore.restoreSupersededBy` — **任意**メソッド）。
  `superseded` になった Memory を `active` へ戻す**復旧口**。粒度は群単位で、
  `target: { supersededById }`（置き換えた側の id）で指定する
  （[#369](https://github.com/takecchi/mnemora/issues/369) /
  [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md)、PR #464）。
  ⚠ **これは北極星 項目5（間違いを正すと、古いほうが先に出てこなくなる）を満たすものではない**——
  訂正の口そのものは入っていない
- **`restoreSuperseded` の dry-run**（および `MemoryStore.previewRestoreSupersededBy` — **任意**メソッド）。
  **戻す前に、何が戻るかを返す**（[#515](https://github.com/takecchi/mnemora/issues/515) /
  [ADR 0237](./docs/decisions/0237-restore-superseded-dry-run-preview.md)、PR #524）
- **`Runtime.findCorrectionCandidates`** — 訂正の相手の**候補を返す**口。
  ⛔ **mnemora は選ばない。書き込みを1件もせず、LLM を1回も呼ばない**
  （[ADR 0232](./docs/decisions/0232-correction-candidates-returned-not-chosen.md)、PR #517）
- **`Runtime.applyCorrection`** — 訂正の**選択**の段を、出荷される面へ持ち上げた口。
  ⭐ **選ぶのは人である**——候補を返す `findCorrectionCandidates` と、書き込む
  `markContested`/`resolveContested` のあいだを繋ぐ
  （[ADR 0242](./docs/decisions/0242-runtime-apply-correction.md)、PR #537）
- **`CassetteRecorder.lookupLLM` / `lookupEmbedding`**（`@mnemora/testkit`）— 記録した
  カセットを照会する口。⭕ **追加のみで後方互換**
  （[ADR 0233](./docs/decisions/0233-answer-quality-measured-once-against-the-real-api.md)、PR #514）

---

## [0.3.0] - 2026-09-17

**Release**: [v0.3.0](https://github.com/takecchi/mnemora/releases/tag/v0.3.0)（pre-release ではない）。
**tag が指すのは `6851629`**、**前の版は `v0.2.0`**（`c52be47`）。⟹ **この節は
`v0.2.0` → `v0.3.0` の差分である**（【実測】`git rev-list --count v0.2.0..v0.3.0` = 101）。

⚠ **GitHub の Release `v0.3.0` の本文は自動生成であり、101 commit を無差別に1行ずつ
並べたものである**【実測】（`gh release view v0.3.0 --json body -q .body | grep -c '^\* '` = 101）。
⟹ ⭐ **分類も、docs のみ・テストのみの除外も、この節が初めて与える。**

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更は `@mnemora/core` / `@mnemora/testkit` / `@mnemora/local-embedding` の3本に在る**
（`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/postgres` に破壊的変更は無い）。
🔴 **⚠ `@mnemora/local-embedding` を落とさないこと**——この repo は 2026-09-18 まで
「`@mnemora/local-embedding` に破壊的変更は無い」と書いており、**それは誤りだった**
（[Issue #532](https://github.com/takecchi/mnemora/issues/532)）。

**postgres 利用者へ**: 新しいマイグレーション（`0016`/`0017`）が増えている。
⟹ **`v0.2.0` から上げるなら `pnpm --filter @mnemora/postgres run migrate` が要る。**
適用手順・破壊的変更ごとの対応方法は [docs/migration-v1.md](./docs/migration-v1.md) を見ること
——このファイルには詳細を複製しない。

### Breaking

⭐ **4件である。**⭕ **`v0.2.0` と `v0.3.0` の両端が tag で閉じているので、`main` が動いてもこの数は変わらない。**
⚠ **正本は [docs/migration-v1.md](./docs/migration-v1.md) の番号付き一覧の 8〜11 であり、
下の表はその写しである**——**`#` 欄はあちらの通し番号で、この表の中での連番ではない。**

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 8 | `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls`（`@mnemora/testkit`）の署名が `(tenantId: string, recalls: number): void` → `(ctx: Ctx, recalls: number): Promise<void>` へ変わった。ADR 0197 が `TenantSettingsStore` に同名の**本番**メソッドを足して名前が衝突したため、テスト専用フックのほうを消した | 🔴 **旧署名で呼んでいた側。⛔ 引数を直すだけでは足りない**——同期から `Promise` へ変わったので `await` が要る。構築して渡すだけなら影響なし | [ADR 0197](./docs/decisions/0197-set-default-half-life-recalls.md)（PR #416） |
| 9 | `FilteredOmission` に必須フィールド `scopeRelation` が増えた（`@mnemora/core`）。`decayed` だけが `totalInScope` の**内側**を数えるという非対称を、契約として明示するもの | **返り値の型なので、読むだけの利用者には非破壊。** `FilteredOmission` を自分で組み立てている側（独自 adapter の `aggregateScope` 実装・テストダブル）だけ | [ADR 0174](./docs/decisions/0174-filtered-omission-scope-relation.md) / [#352](https://github.com/takecchi/mnemora/issues/352)（PR #376） |
| 10 | `Omission` の `over_limit` に必須フィールド `stage` が増えた（`@mnemora/core`）。連想枠（段3.5）の `maxCount` 切り捨てを段1 の打ち切りと区別して名乗るため | **9 と同じ形**——`omission.count` を読むだけなら非破壊。`OverLimitOmission` を自分で組み立てている側だけ | [ADR 0188](./docs/decisions/0188-association-over-limit-omission.md) / [#375](https://github.com/takecchi/mnemora/issues/375)（PR #391） |
| 11 | 🔴 `LocalEmbeddingPipeline`（`@mnemora/local-embedding`）が呼び出し可能な関数型から、`countTokens` / `embed` / `maxInputTokens` を要求する必須 `interface` になった | 🔴 **呼んでいる側と、自前で渡していた側の両方**——この4件で唯一「呼ぶだけの側も壊れる」形である。⛔ **渡すものの形そのものが変わっている** | [ADR 0205](./docs/decisions/0205-local-embedding-pipeline-required-interface.md) / [#137](https://github.com/takecchi/mnemora/issues/137)（PR #446） |

⚠ **`@mnemora/core` だけを見て数えると、8 と 11 が落ちる**——`@mnemora/testkit` と
`@mnemora/local-embedding` も publish 対象である。
⚠ **移行手順は複製しない**——直し方は [docs/migration-v1.md](./docs/migration-v1.md) の
同じ番号の項目を見ること。

### Changed（後方互換だが挙動が変わりうる）

- **`ann_unreached` が「窓が満杯のときにも」鳴るようになった。**従来は
  `annHits.length < kPrime` のときだけ鳴っていたため、**近似索引が取りこぼしたのに窓は満杯**
  という場合に沈黙していた（[ADR 0193](./docs/decisions/0193-ann-unreached-covers-full-window.md)、PR #399）。
  ⟹ 北極星「知らないことを、知らないと言える」の穴を1つ塞いだ
- **`sweepArchive` が `opts.clock` 省略時に `tenant_settings.decay_clock` へ従うようになった。**
  従来は掃引だけが常に壁時計で動いていたため、`decay_clock = activity`/`either` を選んだ
  テナントで「想起では生きている記憶が archive される」ことがあった
  （[#364](https://github.com/takecchi/mnemora/issues/364) /
  [ADR 0186](./docs/decisions/0186-sweep-archive-follows-decay-clock.md)、PR #379）
- **語彙チャンネルの `search()` に決定的な最終キーが入った。**同点の候補の順序が
  呼び出しごとに変わりうる状態を解消（[#345](https://github.com/takecchi/mnemora/issues/345) /
  [ADR 0175](./docs/decisions/0175-lexical-search-tiebreak-nondeterminism.md)、PR #390）
- **`PostgresVectorStore.upsert` が、閾値を越えたときだけ埋め込み表を `ANALYZE` するようになった。**
  新しい埋め込み空間へ大量投入した直後は統計が無く、**HNSW 索引が選ばれない窓**が在った
  （[#360](https://github.com/takecchi/mnemora/issues/360) /
  [ADR 0194](./docs/decisions/0194-embedding-space-analyze-threshold.md)、PR #406）。
  ⭕ **公開 API は変わっていない**——変わるのは実行計画である
- **`memories` への書き込み経路にも、同じ閾値つき `ANALYZE` のフックが入った**
  （[#269](https://github.com/takecchi/mnemora/issues/269) /
  [ADR 0221](./docs/decisions/0221-memories-analyze-on-write.md)、PR #492）。
  ⚠ **`supersedeWithNewMemories` だけが取り残されていたので、後から塞いだ**
  （[ADR 0225](./docs/decisions/0225-supersede-with-new-memories-analyze-hook.md)、PR #502）

### Added

- **`TenantSettingsStore.setDefaultHalfLifeRecalls`**（**任意**メソッド）。テナント既定の
  半減期を「recall 回数」で設定する本番の経路
  （[ADR 0197](./docs/decisions/0197-set-default-half-life-recalls.md)、PR #416）。
  ⭕ **任意メソッドなので、この追加そのものは後方互換**——実装していない adapter は従来どおり動く。
  ⚠ **ただし同じ PR #416 は破壊的変更も1件持っている**（上の表の **8**）。
  ⟹ **「任意メソッドだから丸ごと後方互換」と読まないこと。**
- **`OutboxStoreConformanceOptions.supportsRealConcurrency`**（`@mnemora/testkit`、**任意**フィールド）。
  adapter 作者が「同時 `claimBatch` を本物の並行で検査してよいか」を自己申告できる
  （[ADR 0206](./docs/decisions/0206-outbox-concurrent-claim-conformance.md)、PR #450）

### Fixed

- **`recall()` の返り値で `memories` と `omitted` が排他であることを、契約として明示して直した。**
  同じ Memory が両方に現れうる状態を塞いだ（[#421](https://github.com/takecchi/mnemora/issues/421) /
  [ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md)、PR #435）。
  ⭕ **公開型は変えていない**——変わったのは返る中身である

---

## [0.2.0] - 2026-09-16

**Release**: [v0.2.0](https://github.com/takecchi/mnemora/releases/tag/v0.2.0)（pre-release ではない）。
**tag が指すのは `c52be47`**、**前の版は `v0.1.9`**（`6c9d101`）。⟹ **この節は
`v0.1.9` → `v0.2.0` の差分である**（【実測】`git rev-list --count v0.1.9..v0.2.0` = 30）。

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更はすべて `@mnemora/core` と `@mnemora/testkit` に限られる**
（`openai`/`anthropic`/`local-embedding` の `src` に v0.1.9 からの差分は無い。【実測】
`git diff --stat v0.1.9..v0.2.0 -- packages/openai/src packages/anthropic/src packages/local-embedding/src`
が空を返す）。

**postgres 利用者へ**: 新しいマイグレーション（`0013`/`0014`/`0015`）が増えている。
適用手順・破壊的変更ごとの対応方法は [docs/migration-v1.md](./docs/migration-v1.md) を見ること
——このファイルには詳細を複製しない。

### Breaking

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 1 | `MemoryStore.getRecall` が必須メソッドとして追加された。 | `MemoryStore` を自前実装している adapter 作者 | [ADR 0155](./docs/decisions/0155-recall-score-breakdown-persisted.md) |
| 2 | `NewRecallRecord.returnedMemoryIds: MemoryId[]` を削除し、`returnedMemories: RecallRecordMemory[]` に置き換えた。 | `createRecall` を呼ぶ側・実装する側の両方 | [ADR 0155](./docs/decisions/0155-recall-score-breakdown-persisted.md) |
| 3 | `ScopeAggregate` に必須フィールド `filteredExpired`/`filteredNotYetValid` が増えた。 | `aggregateScope` を自前実装している adapter 作者 | [ADR 0164](./docs/decisions/0164-valid-from-until-recall.md) |
| 4 | `FilteredOmission.condition` の union に `"expired"`/`"not_yet_valid"` が増えた。 | 消費するだけなら非破壊。**`never` で網羅性を検査しているコードは壊れる** | [ADR 0164](./docs/decisions/0164-valid-from-until-recall.md) |
| 5 | `Runtime.getRecall` が必須メソッドとして追加された。 | `Runtime` を自前実装している側。⚠ 根拠 ADR に破壊性の言及が無い——[移行ガイド](./docs/migration-v1.md)を必ず見ること | [ADR 0161](./docs/decisions/0161-runtime-get-recall.md) |
| 6 | `TenantSettingsStoreConformanceOptions.supportsDecayClock`（`@mnemora/testkit`）が必須フィールドとして追加された。 | `describeTenantSettingsStoreConformance(...)` を呼んでいる adapter 作者。⚠ 根拠 ADR は当初「非破壊」と誤記載していたが訂正済み | [ADR 0165](./docs/decisions/0165-decay-activity-clock.md) |
| 7 | `RecallFootprintEstimate.associationCount`（`@mnemora/core`）が必須フィールドとして追加された。 | **返り値の型なので、読むだけ・呼ぶだけの利用者には非破壊。** `RecallFootprintEstimate` を自前で構築している側だけが影響を受ける。入力側（`estimateRecallFootprint`）は省略可能フィールドとして追加されており非破壊（省略時は `?? 0`）。（【実測】`packages/core/src/recall-footprint.ts:392` が必須、入力側の `RecallFootprintShape.associationCount` は `:368` で省略可能、既定は `:463` の `?? 0`） | ADR 0166 |

### Changed（後方互換だが挙動が変わりうる）

- **`RecallQuery.validAt` ゲートが既定で有効になった**（opt-out は `includeOutsideValidity: true`）。
  **影響を受けるのは、v0.1.9 で `MemoryStore.createMemory` を直接呼んで `validFrom`/`validUntil`
  に non-null を書いていた利用者だけ**——`Runtime.observe` 経由ではこれらの列に値を
  書く経路が v0.1.9 には無かったため、通常の利用者には影響しない。
  ([ADR 0164](./docs/decisions/0164-valid-from-until-recall.md))
- **`TICK_SUPPORTED_JOB_KINDS` が2値から4値へ増えた**（`consolidate`/`reflect` を追加）。
  値を消費するだけなら非破壊だが、**網羅性検査（`never`）をしているコードは壊れる。**
  ([ADR 0157](./docs/decisions/0157-tick-drives-consolidate-and-reflect.md))
- **`PostgresVectorStore.search` の `ORDER BY` に `memory_id` の tie-break が追加された。**
  距離が完全一致した候補の順序が決定的になった（以前は未定義）。
  ([ADR 0167](./docs/decisions/0167-association-getvectors-order-nondeterminism.md))
- **連想枠の非決定性は、上の修正だけでは消えていなかった（第2段）。** `search()` が返す
  候補に距離の完全一致タイが在ると、`memory_id` による tie-break が取り込みのたびに
  揺れていた。段1と段2の両方で順序を決定的にして直した（Issue #339）。
  ([ADR 0170](./docs/decisions/0170-association-search-tiebreak-nondeterminism.md))

### Added

- **`Runtime.getRecall(ctx, recallId)`** — `recall()` を離れた後でも、`recallId` から
  スコア内訳・`retrievedVia`・`companionOf`/`associationOf` を読み戻せる。
  ([ADR 0161](./docs/decisions/0161-runtime-get-recall.md))
- **`memory_usage` 報告の実践**（`examples/chat`）— プロンプトへ積んだ Memory を
  `observe({ kind: 'memory_usage' })` で伝え返し、`reinforce` を実アプリで発火させる。
  ([ADR 0163](./docs/decisions/0163-memory-usage-reporting-example-chat.md))
- **`validAt` ゲート** — 「この時刻において真だった記憶」を問える。`expired`/`not_yet_valid`
  を `omitted` で名指しする。([ADR 0164](./docs/decisions/0164-valid-from-until-recall.md))
- **減衰の時計を2本持てる（`decay_clock`）** — 壁時計（`wall`、既定）に加え、活動時計
  （`activity`）・両方（`either`）をテナントごとに選べる。低頻度利用のテナントが
  一律に沈むのを避けられる。([ADR 0165](./docs/decisions/0165-decay-activity-clock.md))
- **`estimateRecallFootprint` が連想枠の分も見積もれる** — 入力
  `RecallFootprintShape.associationCount?`（**省略可能**）を渡すと、返り値に
  `associationCount` が出る。**渡さなければ従来と同じ値が返る**（`?? 0`）。
  ([ADR 0166](./docs/decisions/0166-recall-footprint-association-term.md))
- **`examples/chat` の想起経路が連想枠を既定で使うようになった**（`maxCount=10`）。
  ⚠ **`@mnemora/core` の `recall()` の既定は off のままである**——連想枠は
  `query.association` を渡したときだけ走る（`packages/core/src/recall.ts:1132`
  「省略時は連想を一切走らせない」）。**変わったのは採用側が明示して使うようになったこと**であって、
  ライブラリの既定ではない。
  ([ADR 0168](./docs/decisions/0168-examples-chat-uses-association.md))
- **`tick()` が `consolidate()`/`reflect()` を駆動できる**（既定 off の opt-in、
  `RuntimeConfig.autoQueueConsolidateReflectOnExtract`）。
  ([ADR 0157](./docs/decisions/0157-tick-drives-consolidate-and-reflect.md))

### Fixed

- **連想枠（段3.5）の結果が、同一データに対して実行のたびに変わることがあった。**
  原因は `VectorStore.getVectors()` の返却順（adapter が保証しない順序）にそのまま
  依存していたことで、HNSW の近似性とは無関係だった。アンカーの処理順をランク順に
  固定して直した（Issue #316）。
  ([ADR 0167](./docs/decisions/0167-association-getvectors-order-nondeterminism.md))
