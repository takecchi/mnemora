# ADR 0329: `knownPredicates` を store の既存 predicate 一覧から動的に渡す — ADR 0326「採らなかった案B」を実装し、実測する（Issue #691 続き）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

**⚠ この PR はクローンの委譲で動く担い手が書いた。投稿者 `takecchi` はオーナー本人ではない**
（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)
——投稿者名は担い手とオーナーを区別しない）。**この ADR に出てくる判断はすべて
「クローン miku の判断（オーナーではない）」である。**オーナーの確認・承認を得たものではない。

⚠ **番号について**: この ADR は当初 `0327` を仮番号として想定していたが、着手中に
`0327`（[Issue #207](https://github.com/takecchi/mnemora/issues/207) の `memory_relations`
書き込み経路設計、別の担い手）が先に `main` へ着地した（PR #749）。続いて `0328` も
Issue #565 の測定（PR #751）が先に着地したため、`node scripts/adr-renumber.mjs` で
**`0329`** に振り直した（[ADR 0179](./0179-adr-number-assigned-at-merge.md) のとおり、
最終番号はマージ直前に確定させる。この後さらに `main` が進めば再び振り直す）。

### 出所の凡例（ADR 0185/0315/0320/0324/0326 以降の作法）

| 記号 | 意味 |
|---|---|
| 【実測】 | この作業者が、この器で実際に本物の Postgres + pgvector・`OPENAI_API_KEY` を叩いて得た |
| 【現物】 | この作業者が、リポジトリの現物（コード・文書）を読んで確かめた |
| 【受】 | 人・他のエージェントから受け取った前提。自分で検証していない |

---

## 文脈

[ADR 0326](./0326-answer-path-claim-key-contested-opt-in-measurement.md)（Issue #691 続き）は、
`examples/chat` の `answer` 経路で `claimKey`/`detectContested` を評価用に opt-in し、
`[矛盾候補:]` タグが実際には0件しか出ないことを実測した。原因を (a)〜(g) の段で切り分け、
主な原因は次の2つだと特定している:

- **(c)** claim key の predicate が、同じ会話でも別の `observe()` 呼び出し（別ターン）を
  またぐと一致しないことがある——訂正・否定の4ケース中3件で不一致（1件のみ一致）。
- **(g)** `contested` が成立しても、対向がすでに `withinLimit`（通常の候補集合）に自然に
  入っていると `companionOf` が立たず、`[矛盾候補:]` タグが描画されない。

ADR 0326 は「採らなかった案B」として、**store の既存 predicate 一覧を `knownPredicates`
語彙ヒントとして動的に渡し、(c) の一致率を上げる**案を検討したが、2つの理由で保留した:

1. 「(g) が残る限り、predicate の一致率を上げても `[矛盾候補:]` タグは届かない——先に
   (g) の扱いが決まらないと、語彙ヒントの効果を測る意味が無い」。
2. 「既存 predicate 一覧を動的に渡す実装は『どのテナント・どの時点の一覧を使うか』という
   新しい設計判断を持ち込み、[ADR 0326] の範囲を超える」。

**この ADR が答えるのはこの2点である**:

- **1点目への答え**: 評価の物差しを「`[矛盾候補:]` タグが出たか」ではなく、**「(c) の
  predicate 一致が起きたか」「(B) 第2段の `contested` 成立（`markContested` が実際に
  呼ばれたか）が起きたか」の段に置き直す。** (g) は `packages/core` の公開契約（`recall()`
  の `companionOf`）に触れる変更を要し、この PR の裁量では判断できない
  （ADR 0326「採らなかった案A」参照）——(g) 自体はこの PR でも直さない。だが、(c) が
  改善するかどうかは (g) を直さなくても測れる——`memories` テーブルの `claim_key_predicate`/
  `status`/`contested_with_id` を直接見れば、`[矛盾候補:]` タグを介さずに (c)/(B)第2段の
  成立を観測できる（ADR 0326・ADR 0324 の実測で既に使われている手法と同じ）。
- **2点目への答え**: 「どのテナント・どの時点の一覧」を本 ADR で明示的に決める（決定1参照）
  ——**同じテナント・同じ `subjectId`・現時点で `active` な記憶**。

⛔ **正規化の強化・類義の統合**（[ADR 0320](./0320-claim-key-field-implementation.md) が
検討した案B相当）と**埋め込み類似度による predicate 統合**
（[ADR 0134](./0134-mark-contested-explicit-operation.md) 案A(b)相当、
[ADR 0185](./0185-contradiction-detection-path.md) (D) 相当）は、いずれも既に別の ADR で
却下済みであり、本 PR では実装しない。本 ADR では比較のためだけに参照する
（「採らなかった案」参照）。

⛔ **`packages/core/src/recall-runtime.ts` の段3（`companionOf` の付与、(g) の実体）には
一切触れていない。** ADR 0326 が「採らなかった案A」として保留したままである。

---

## 決定

### 決定1: `MemoryStore` に任意メソッド `listActiveClaimPredicates?` を足す

`packages/core/src/interfaces/memory-store.ts` に、`findActiveByClaimKey?`
（ADR 0324 決定3）と同じ「任意メソッド・フォールバック無し」の判断で追加する
（`@mnemora/core` は npm に公開済み、必須にすると第三者 adapter を壊す）。

契約（全文は同ファイルの doc コメント）:

- **同じ `ctx.tenantId`・同じ `query.subjectId`**（`subjectId` は `IS NOT DISTINCT FROM`
  ——NULL 同士も一致、`findActiveByClaimKey?` と同じ規約）。
- **`status = 'active'` の行だけを対象にする。** `contested`/`superseded`/`archived`/
  `forgotten` は対象外——「今読むべき主張」の定義を `findActiveByClaimKey?` とそろえる。
- **`claim_key_predicate` が非 `null` の行だけを対象にする**
  （`idx_memories_claim_key` の部分索引の条件と同じ）。
- 返す `string[]` は predicate の**重複を除いた**一覧。同じ predicate を持つ行が複数あれば、
  そのうち最も新しい行（`created_at` が最大）で代表させる。
- **新しい順**（代表行の `created_at` 降順）に並べる——`findActiveByClaimKey?` の
  「順序は規定しない」とは異なる。こちらは語彙ヒントの優先順位に順序がそのまま使われる。
- `query.limit` を超えない件数を返す。**既定値は口自身は持たない**——呼び出し側
  （`ClaimKeyOptions.knownPredicatesFromStore`）が決める。

`packages/postgres/src/memory-store.ts`（`GROUP BY claim_key_predicate ORDER BY
MAX(created_at) DESC LIMIT $limit`）・`packages/testkit`
の `InMemoryMemoryStore`・`packages/core/src/__tests__/runtime-fakes.ts` の
`FakeMemoryStore`（既存の慣行どおり、独立した複製）の3箇所に実装した。

**「同じテナント・同じ subjectId・現時点で active」であることの理由**: `findActiveByClaimKey?`
（ADR 0324 決定3）が検出クエリで既に採っている境界と完全に揃える——`claimKey` の語彙は
「そのテナントの、その主題について、いま何を主張しているか」の一覧であるべきで、別テナント・
別主題・過去に `superseded`/`archived` になった主張を混ぜると、語彙ヒント自体が「もう有効で
ない主張」を含むことになり、ADR 0315/0320 の語彙ヒント実験が前提にした「その場に実在する
語彙」という性質から外れる。

### 決定2: migration は追加しない——`idx_memories_claim_key`（ADR 0320 決定7）をそのまま使う

`listActiveClaimPredicates` のクエリは `WHERE tenant_id = ... AND subject_id IS NOT
DISTINCT FROM ... AND status = 'active' AND claim_key_predicate IS NOT NULL GROUP BY
claim_key_predicate ORDER BY MAX(created_at) DESC LIMIT $n` である。`idx_memories_claim_key`
（`(tenant_id, subject_id, claim_key_subject, claim_key_predicate)` の部分索引、
`migrations/0021_memories_claim_key.sql`）の先頭2列（`tenant_id`, `subject_id`）で、対象を
「鍵を持つ行」まで既に絞り込める——`status`/`created_at` は索引に含まれないため、絞り込み後の
集約・整列はこの2列に対して行われる。

**この PR の対象範囲では、絞り込み後の行数が小さいと判断した**——ADR 0326 の実測（`answer`
経路の実ケース）は1テナント・1主題あたり claim key を持つ行が2〜5件、本 ADR の実測も同様
（下記「測ったこと」）。`findActiveByClaimKey?`（ADR 0324 決定3）も同じ索引を、`status`/
有効期間の絞り込みを追加の `WHERE` に任せる形でそのまま使っており、新しい索引を足していない
——本口も同じ判断を踏襲する。

**測っていない**: 1 `subjectId` あたりの claim key 行数が数百〜数千件に達する本番規模での
実行計画・レイテンシ。そのときは `(tenant_id, subject_id, status, claim_key_predicate,
created_at)` のような covering index を migration `0022` として追加する余地があるが、
測定に基づかない索引を先回りで足すことは `docs/north-star.md`「迷ったときの問い」に照らして
避けた——**引き受けた負債**参照。

### 決定3: `ClaimKeyOptions.knownPredicatesFromStore?: boolean | { limit?: number }`（既定 off）

`packages/core/src/claim-key.ts` に追加。`enabled: true`（ADR 0320 決定6）と組み合わせた
ときだけ意味を持つ——`detectContested`（ADR 0324 決定1）と同じ「渡されたが効かない」規約
（`enabled: false`/省略のままこれだけ渡してもエラーにしない）。

- **省略・`false`**: 既定。`deriveClaimKeys` へ渡る `knownPredicates` は、呼び出し側が
  明示的に渡した `ClaimKeyOptions.knownPredicates` のみ（従来どおり）。`MemoryStore.
  listActiveClaimPredicates` は一度も呼ばれない。
- **`true`**: {@link DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT}（既定 `20`、決定5参照）件
  まで store から集める。
- **`{ limit: number }`**: その件数まで集める。

`packages/core/src/runtime.ts` の `runExtraction` に足した `resolveKnownPredicates` が、
`deriveClaimKeys`（`claim-key.ts`）を呼ぶ**前**に:

1. `claimKeyOptions.knownPredicatesFromStore` が偽、または `deps.memoryStore.
   listActiveClaimPredicates` を持たない adapter なら、**store を一度も読まずに**
   `claimKeyOptions.knownPredicates` をそのまま使う（渡していなければ `undefined`）。
   ⟹ **opt-in していない既存呼び出しの挙動・抽出プロンプト・カセット鍵は1バイトも
   変わらない。**
2. それ以外は `listActiveClaimPredicates(ctx, { subjectId: observation.subjectId ?? null,
   limit })` を1回呼び、**利用者が渡した `knownPredicates` を先に、store から集めた一覧を
   後ろに、重複を除いて連結する**。

### 決定4: `subjectId` は「1回の `observe()` 呼び出しが持つ既定の `subjectId`」——候補ごとの上書きは見ない

`deriveClaimKeys` は抽出候補群 `candidates` に対して**バッチで1回**呼ばれる（ADR 0315
決定2 の (ii) separate）——`knownPredicates` はバッチ全体に対する単一の語彙ヒントであり、
候補ごとに変えられない。一方、`ExtractedMemoryCandidate.subjectId`（ADR 0271）は候補ごとに
`observation.subjectId` を上書きできる。

**この PR は `observation.subjectId ?? null`（候補ごとの上書きが確定する前の値）を使う。**
理由: (a) 候補ごとの `subjectId` は `buildNewMemoryFromCandidate`——`deriveClaimKeys` の
呼び出しより**後**——で初めて確定する。`knownPredicates` はそれより前に必要なので、候補
ごとの値をそもそも参照できない。(b) `observation.subjectId` は1回の `observe()` 呼び出しに
つき単一の値であり、「バッチ全体に対する単一のヒント」という `knownPredicates` の形と
自然に合う。

**これは判断に迷った点である**——候補ごとの `subjectId` 上書きが実際に使われる場面
（例: 複数話者の発言を1回で観測する場合）では、この口が集める語彙は「観測全体の既定の
主題」に閉じたものになり、候補固有の主題（例: 家族の発言）の語彙は集めない。この限定を
「引き受けた負債」に記録する。

### 決定5: 既定の上限は `20`

**根拠**: ADR 0315/0320/0324 の語彙ヒント実験はいずれも作業者が手で作った **5〜8件**の
predicate で語彙ヒントの効果（ADR 0320: 安定性 74.1%→89.4%、ADR 0324: predicate 弁別は
100%一致）を確認している。`20` は、その実験規模（最大8件）のおよそ2.5倍——**実験で効果が
確認された範囲を十分に覆いつつ、主題を持つ1人の会話が現実的に蓄積する claim key predicate
の語彙が数十件規模に増えても、`deriveClaimKeys` の system プロンプトへ際限なく積み上がらない
よう上限を切る**、という判断である。「実測でこの値が最適」という測定結果ではない
——`packages/core/src/__tests__/runtime.test.ts`「`knownPredicatesFromStore: true`
で...既定値...を store へ渡す」の歯で値を固定し、変えるときはその歯を直すことで変更が
見える形にする。

**測っていない**: 本 ADR の実測（下記）はいずれもテナントあたり claim key を持つ行が最大
5件程度であり、`limit: 20` が実際に切り詰めとして効いた場面は無い（上限の効果は
`packages/testkit`/`packages/postgres` の単体テスト・適合テストでのみ確認済み）。

### 決定6: `examples/chat` の記録スクリプトに条件・保存先の選択肢を足す（既定は変えない）

`examples/chat/src/answer-claim-key-options.ts` の `ANSWER_CLAIM_KEY_MODES` に
`"detect-known-predicates-from-store"` を追加した——`MNEMORA_ANSWER_CLAIM_KEY` にこの値を
渡すと `{ enabled: true, detectContested: true, knownPredicatesFromStore: true }` を返す
（既存の `"detect"` は `{ enabled: true, detectContested: true }` のまま、1バイトも
変えていない）。

`examples/chat/src/scripts/record-answer-claim-key.ts` に2つの環境変数を足した
（両方省略すれば、この PR より前と完全に同じ挙動——既定の保存先 `answer.claim-key.json`・
既定の条件 `"detect"`）:

- `MNEMORA_RECORD_CONDITION`（`"baseline"` 省略時の既定 | `"known-predicates-from-store"`）
- `MNEMORA_RECORD_CASSETTE_PATH`（省略時の既定 = `ANSWER_CLAIM_KEY_CASSETTE_PATH`）

**種カセットは常に `answer.order-legend.json` だけ**——#748 の `answer.claim-key.json`
（既に claimKey opt-in 込みで記録済み）を種にしない。#748 を種にすると、claim key 派生の
呼び出し自体が「記録済みの応答の再生」になり、実 API に落ちる対照にならないため
（マネージャー指示）。**既存カセット（`retrieval.json`/`compare.json`/
`answer.order-legend.json`/`answer-time-weighting*.json`・#748 の `answer.claim-key.json`）は
1バイトも変更していない**——`git diff --stat` で確認済み（下記「測ったこと」）。

---

## 測ったこと

【実測】2026-09-25、`gpt-4o-mini`、`examples/chat/src/answer-case-set.dev.ts`（6件）+
`.eval.ts`（8件）の全14ケース、`initdb`（PostgreSQL 17、pgvector・btree_gin・pgcrypto、
専用ポート・作業ツリー外）で立てた専用インスタンス。**同じ回**（この PR の作業中、
連続した実行）に、基準（`knownPredicatesFromStore` を渡さない、ADR 0326 と同じ設定）と
新案（`knownPredicatesFromStore: true`）を、それぞれ n=3 回、種は
`answer.order-legend.json` だけを使って実行した。反復ごとに別のカセット
（`examples/chat/cassettes/answer.claim-key.{baseline,known-predicates}-{1,2,3}.json`、
新規ファイル）に記録した。

### 1. 訂正4件の predicate 一致 / 4

| ケース | 基準 run1 | 基準 run2 | 基準 run3 | 新案 run1 | 新案 run2 | 新案 run3 |
|---|---|---|---|---|---|---|
| schedule-change-meeting-day | ✗（`next_meeting_day`/`weekly_meeting_day`） | ✗（`weekly_meeting_day`/`meeting_schedule`） | ✗（`meeting_schedule`/`meeting_day_changed`） | ✓（`meeting_schedule`） | ✓（`upcoming_meeting_day`） | ✓（`upcoming_meeting_day`） |
| negation-moved-city | ✗（`lived_in`/`current_location`,`previous_location`） | ✗（`lived_in_city`/`current_location`,`previous_location`） | ✗（`previous_residence`/`previous_location`,`current_location`） | ✓（`lived_in_kyoto`×3） | ✓（`lived_in`×3） | ✓（`lived_in_location`×3） |
| schedule-change-deadline | ✗（`report_submission_deadline`/`request_extension`,`deadline_issue`） | ✗（同左/`deadline_extension_request`,`submission_timeline`） | ✗（同左/`deadline_request`,`deadline_concern`） | ✓（`report_submission_due_date`×3） | ✓（`report_submission_deadline`×3） | ✓（`report_submission_deadline`×3） |
| negation-moved-job | ✗（`previous_occupation`/`occupation`） | ✗（`former_profession`/`current_occupation`） | ✗（`previous_occupation`/`occupation`） | ✓（`former_profession`） | ✓（`occupation`） | ✓（`former_occupation`） |
| **一致数/4** | **0/4** | **0/4** | **0/4** | **4/4** | **4/4** | **4/4** |

**基準は3回とも0/4——ADR 0326（訂正・否定4件中3件で不一致）と方向は一致するが、本実測の
基準では3回とも「4件中0件」で、ADR 0326 の単発実測（4件中1件一致、negation-moved-job）
より悪い。**⟹ 一致・不一致は run ごとに揺れる（negation-moved-job は ADR 0326 の1回では
一致したが、本 ADR の基準3回ではいずれも不一致）——**単発の実測を代表値として読まない
ことの裏付けである。**

**新案は3回とも4/4——揺れが無い。** 基準の揺れの幅（0/4〜1/4、ADR 0326含め4回中3回は
0/4）を明確に超えている。

### 2. 訂正4件の `contested` 成立 / 4（`matchCount: 1` かつ `markContested` 成功）

| 条件 | run1 | run2 | run3 |
|---|---|---|---|
| 基準 | 0/4 | 0/4 | 0/4 |
| 新案 | 4/4 | 4/4 | 4/4 |

predicate が一致した回だけ `contested` が成立している——本 ADR の実測範囲では predicate
一致と `contested` 成立は完全に連動した（1対1）。

### 3. 誤検出（訂正でないケースでの `contested` 成立）/ 14

| 条件 | run1 | run2 | run3 |
|---|---|---|---|
| 基準 | 1/14（`other-period-city-this-year`のみ、ADR 0326 (d) と同一） | 1/14（同左） | 1/14（同左） |
| 新案 | 4/14（`other-period-city-this-year`/`other-person-birthday`/`other-person-favorite-food`/`unknown-favorite-number`） | 3/14（`other-period-city-this-year`/`eval-misattribution-order-swapped`/`unknown-favorite-number`） | 3/14（`other-period-city-this-year`〔2対〕/`eval-misattribution-order-swapped`/`unknown-favorite-number`） |

**基準は3回とも1/14で揺れが無い**（構造的原因、ADR 0326 (d)——`validFrom`/`validUntil`を
渡さないため常に重なる。この PR は (d) を直していない）。

**新案は3〜4/14——基準を明確に上回り、かつ run ごとに対象ケースが変わる。**
原因は検出コード自体ではなく、**claim key 派生（`deriveClaimKeys`）が、語彙ヒントに
含まれる predicate を無関係な filler 発話（「最近のニュースについての意見は述べていない。」
「相談したいことがある」等）にも再利用してしまう**こと——語彙ヒントが「訂正対象の
predicate」だけでなく「その場に存在するどの predicate も使い回してよい候補」として働き、
本来別の主張であるはずの2つの filler 発話が同じ predicate（例: `unrelated`/
`hobby_intention`/`trip_planning`）に落ちて `contested` になった。**これは (c) を直す
効果の副作用であり、この PR が意図して直したものではない。**

### 4. `[矛盾候補:]` タグ / 14（参考値、(g) は未着手のため大半は0のままの見込み）

| 条件 | run1 | run2 | run3 |
|---|---|---|---|
| 基準 | 0/14 | 0/14 | 0/14 |
| 新案 | 2件（`other-person-birthday`のみ） | 2件（`eval-misattribution-order-swapped`のみ） | 2件（`eval-misattribution-order-swapped`のみ） |

**基準は3回ともADR 0326と同じく完全に0**——(g) の再現性を裏付ける。

**新案は3回とも、いずれか1ケースだけ2件（1対）のタグが出た。** ⚠ **重要な観測**:
**タグが出たのは3回とも誤検出側（訂正4ケースではない）だった。** 訂正4ケース（本来
タグが出てほしい対象）は、6回の実行を通じて**一度も** `[矛盾候補:]` タグに到達しなかった
——(g)（対向が自然に `withinLimit` に入っていると `companionOf` が立たない）は、この実測
範囲では訂正ケースに対して6/6回とも遮断し続けた。**新案がタグを届けたのは、たまたま
誤検出側の対（互いに短い filler 発話で、自然に近接して想起された対）が (g) の外側に
落ちた、偶然の結果である。** ⟹ **本 ADR の実測は、(g) を直さない限り predicate 一致の
改善が「回答に出る矛盾候補」という目に見える効果に結びつかない、という ADR 0326 の
仮説をそのまま裏付けた。**

### 5. 呼び出し回数・費用

| run | 条件 | chat 呼び出し | embedding 呼び出し | 費用（概算） |
|---|---|---|---|---|
| baseline-1 | 基準 | 26 | 0 | $0.001518 |
| baseline-2 | 基準 | 26 | 0 | $0.001521 |
| baseline-3 | 基準 | 26 | 0 | $0.001516 |
| known-predicates-1 | 新案 | 45 | 0 | $0.002804 |
| known-predicates-2 | 新案 | 45 | 0 | $0.002802 |
| known-predicates-3 | 新案 | 45 | 0 | $0.002798 |
| **合計** | | **chat 193** | **embedding 0** | **$0.012959**（費用上限 $0.50 の約2.6%） |

**新案は基準より実 API 呼び出しが多い**（26→45回）——`knownPredicatesFromStore: true` が
claim key 呼び出しの system プロンプトへ語彙ヒントを足すため、種カセット
（`answer.order-legend.json` から作った claim key 呼び出し記録）のプロンプト文字列と
一致しなくなり、2ターン目以降の claim key 呼び出しが種から外れて実 API に落ちる
（種命中: 基準は LLM 76/102、新案は LLM 74/119）。価格は
`examples/chat/src/usage-meter.ts` の `PRICING_USD_PER_MILLION_TOKENS["gpt-4o-mini"]` と
同じ単価定数。

**費用見積もりは実行前に立てていた**: ADR 0326 の単発実測（$0.001518）を基準に、基準3回・
新案3回（新案は語彙ヒント分のプロンプト増加を見込んでも1回あたり基準の2倍未満と予想）で
合計 $0.02 未満と見積もり、$0.30 の見積もり上限を大きく下回ると判断してから実行した
——実測は見積もりとほぼ一致した（$0.013）。

---

## 採らなかった案

### 案A: `claimKey.enabled: true` にしたら自動的に `knownPredicatesFromStore` も有効にする（別オプションにしない）

**採らない理由**: `claimKey.enabled: true` は ADR 0320 以来、既に本番外の呼び出し
（`examples/chat` の一部・単体テスト・#748 のカセット記録）で使われている。
`knownPredicatesFromStore` を `enabled` に紐付けて自動化すると、**store に既存の
claim key 付き記憶がある状況では、`deriveClaimKeys` の system プロンプトへ語彙ヒントが
黙って足される**——これは `RecordedLLMProvider`（ADR 0051）の完全一致再生の前提を壊す。
具体的には: (1) #748 の `answer.claim-key.json` は `knownPredicatesFromStore` 無しで
記録済み。自動化すると、そのカセットを再生する既存の経路（もしあれば）のプロンプトが
実行時に変わり、「記録に無い入力」として例外になりうる。(2) `packages/core` の単体テスト
（`runtime.test.ts` の「observe: claimKey」節）は `claimKey: { enabled: true }` だけを
渡すケースを多数持ち、`knownPredicatesFromStore` が自動で有効になると、これらの歯が
`FakeMemoryStore.listActiveClaimPredicates` の呼び出し回数・戻り値に暗に依存するように
なり、テストの意図（「呼ばれない」ことを確認する歯）が壊れる。**既存の動作を保つには、
明示的な opt-in の第2段（別オプション）にするしかない**——これは ADR 0324 の
`detectContested`（`enabled: true` と独立した第2の opt-in）と同じ形であり、この PR も
同じ形を踏襲した。

### 案B: 正規化の強化・類義の統合（ADR 0320 が検討した案B相当）

**採らない理由**: 既に [ADR 0320](./0320-claim-key-field-implementation.md) で検討され、
「LLM 自身がバッチ内で言い換えを統合する（実測100%）」を理由に、統計的な言い換え統合の
後処理は追加しないと決まっている（`claim-key.ts` の `normalizeClaimKeyPart` の doc
コメント参照——NFKC 正規化・空白畳み込みだけを行い、意味の統合は行わない）。本 PR は
この決定を変えない。

### 案C: 埋め込み類似度による predicate の統合（ADR 0134 案A(b)、ADR 0185 (D) 相当）

**採らない理由**: 既に [ADR 0134](./0134-mark-contested-explicit-operation.md)・
[ADR 0185](./0185-contradiction-detection-path.md) で、埋め込み類似度による矛盾検出は
「偽陽性率に上限を置けない」ことを理由に却下されている（`docs/north-star.md`「迷ったときの
問い」・`AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」と同型の判断）。
`knownPredicates` の語彙統合に限定しても、埋め込み類似度で「近い predicate」をまとめる
処理は同じ性質の問題（閾値をどこに置くかで偽陽性/偽陰性の境界が動く）を持ち込む——
本 PR はこの方向を採らない。

### 案D: 総合の語彙一覧（利用者指定 + store 分）にも上限を掛ける

**検討したが、この PR では採らなかった。** 決定3のとおり、store から集める件数は
`limit`（既定20）で切るが、利用者が明示的に渡した `knownPredicates` と合成した後の
**総数**には上限を掛けていない——利用者が数十件の `knownPredicates` を渡した場合、
理論上は `limit + |knownPredicates|` まで膨らみうる。**採らない理由**: 利用者が明示的に
渡す `knownPredicates` は既存の口（ADR 0320 決定6）であり、この PR が新しい制約を
持ち込むと、既存の呼び出し側の挙動を変えてしまう。**これは判断に迷った点である**
——「引き受けた負債」に記録する。

---

## 引き受けた負債

### 負債1: 語彙ヒントが、無関係な filler 発話の predicate を誤って統合し、誤検出を増やす

「測ったこと」3節のとおり、誤検出は基準の1/14から新案の3〜4/14へ増えた。**これは
`detectClaimKeyContested`（検出コード、ADR 0324）自体の欠陥ではない**——渡された鍵に
対して規則どおりに動いている。原因は claim key 派生（`deriveClaimKeys`、ADR 0320）が
語彙ヒントに含まれる predicate を、意味的に無関係な発話にも再利用してしまうことに
ある。**この PR はこれを塞がない**——(c) を直す語彙ヒント自体が持つ副作用であり、
`claim-key.ts` の `CLAIM_KEY_PROMPT_SYSTEM`/`buildKnownPredicateInstruction`
（プロンプト文面）側の改善が必要になる可能性がある。**なぜここで塞がないか**:
(a) プロンプト文面の変更は抽出プロンプトと違い claim key 呼び出しの文言そのものを
変えることになり、この PR の主張（store から語彙を集める配線）とは別の主張
（プロンプトエンジニアリングによる弁別精度の改善）になる。(b) 直す前に、この頻度
（3〜4/14）が14ケースという小さい範囲に固有かどうかを確かめる必要がある——本 ADR の
実測はその追加実験を行っていない。

#### 追記（2026-09-25）: 負債1 を語彙ヒントの文言で塞ぐ試み（否定的結果）

**⚠ この追記もクローンの委譲で動く担い手が書いた。オーナー本人ではない**
（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**この追記に出てくる判断もすべて「委譲された担い手の判断（オーナーではない）」である。**

負債1（(b)「直す前に、この頻度が14ケースという小さい範囲に固有かどうかを確かめる必要が
ある」）を受け、`deriveClaimKeys`（`claim-key.ts`）の語彙ヒント文言
（`buildKnownPredicateInstruction`）だけを変えて誤検出を減らせるか試みた。**結果は
否定的である**——4種の文言のいずれも、旧文言（本 ADR、以下「基準」）の run 間の揺れの幅を
超えて誤検出を下げつつ predicate 一致を保つことはできなかった。**この試みはコードへ
反映していない**（`claim-key.ts`/`runtime.ts` は本 ADR の時点のまま）。

##### 観測: force-fit の機構

旧文言（本 ADR、`buildKnownPredicateInstruction`）:

> 既知の predicate 候補一覧: {predicates}。この一覧に当てはまる場合は**必ずそのまま
> 使い**、どれにも当てはまらない場合だけ新しい predicate を作ってください。

「測ったこと」3節で観測した誤検出（`answer.claim-key.known-predicates-{1,2,3}.json` の
claim-key 呼び出しを機械的に抽出して確認）は、次の機構で起きていた:

1. filler 発話（「最近のニュースについての意見は述べていない。」「旅行の計画を
   立てている」等、実質的な主張が薄い記憶）を claim key 化するとき、既知 predicate
   一覧の中に**それ自体が過去の filler から生まれた汎用的・曖昧な predicate**
   （例: `unrelated`、`news_opinion`、`intention_to_start_new_hobby`）が含まれている
   ことがある。
2. 「必ずそのまま使い」という強い指示のもとで、LLM はこの曖昧な predicate を
   「なんでも当てはまるバケツ」として再利用する——例えば「最近のニュースについての
   意見は述べていない。」と「ペットの調子があまり良くないため、心配している。」という
   意味的に無関係な2つの filler が、どちらも predicate `unrelated` に落ちる
   （`answer.claim-key.known-predicates-1.json` で実際に観測）。
3. 同じ tenant・同じ subjectId で `active` な2件が同じ claim key（subject/predicate）を
   持つと、`detectClaimKeyContested`（ADR 0324）が規則どおり `contested` を成立させる
   ——検出コード自体の欠陥ではなく、渡された鍵が誤っていることの結果である。

##### 試した4変種（`buildKnownPredicateInstruction` の store 経由分岐、逐語）

いずれも実装は「`knownPredicatesFromStore` を実際に経由した呼び出しだけ」新しい文言を
使う分岐（off path・利用者が明示的に渡す `knownPredicates` だけの経路は触れない）を
想定して試作した。**リポジトリには反映していない**——下の文言は試作コードから
そのまま転記した記録である。

- **v1**:
  > 既知の predicate 候補一覧（このテナント・主題について過去に使われたもの）:
  > {predicates}。ある記憶が、一覧のいずれかと同じ主体の同じ属性について述べていると
  > 確信できる場合に限り、その predicate をそのまま使ってください。話題が一覧の
  > どれとも異なる場合や、記憶の内容が「言及していない」「特に述べていない」
  > 「〜したいことがある」のように実質的な主張を持たない場合は、一覧を無理に
  > 当てはめず、新しい predicate を作ってください。無関係な記憶どうしを同じ
  > predicate にまとめないでください。
- **v2**:
  > 既知の predicate 候補一覧（このテナント・主題について過去に使われたもの）:
  > {predicates}。ある記憶が、一覧のいずれかと同じ主体の同じ属性について具体的な値を
  > 述べている場合に限り、その predicate をそのまま使ってください（値を更新する記憶・
  > 以前の値を否定して新しい値に置き換える記憶も、同じ属性についてのものであれば
  > 含みます）。記憶の話題が一覧のどれとも明らかに異なる場合、または記憶の内容が
  > 「言及していない」「特に述べていない」のように具体的な値を伴わない場合は、一覧を
  > 無理に当てはめず、新しい predicate を作ってください。無関係な記憶どうしを同じ
  > predicate にまとめないでください。
- **v3**:
  > 既知の predicate 候補一覧（このテナント・主題について過去に使われたもの）:
  > {predicates}。ある記憶が、一覧のいずれかと同じ主体の同じ属性について具体的な値を
  > 述べている場合に限り、その predicate をそのまま使ってください（値を更新する記憶・
  > 以前の値を否定して新しい値に置き換える記憶も、同じ属性についてのものであれば
  > 含みます）。記憶の話題が一覧のどれとも明らかに異なる場合、または記憶の内容が
  > 「言及していない」「特に述べていない」のように具体的な値を伴わない場合や、
  > 「旅行の計画を立てている」「新しい趣味を始めようと思っている」のように具体的な
  > 対象を挙げない漠然とした意向の表明である場合は、一覧を無理に当てはめず、新しい
  > predicate を作ってください。特に、話題が異なる漠然とした意向どうしを同じ
  > predicate にまとめないでください。
- **v4**:
  > 既知の predicate 候補一覧（このテナント・主題について過去に使われたもの）:
  > {predicates}。ある記憶が、一覧のいずれかと同じ主体の同じ属性について述べていると
  > 確信できる場合に限り、その predicate をそのまま使ってください。以前の値を否定して
  > 新しい値に置き換える記憶（例:「エンジニアではなく、デザイナーとして働いている」）
  > も、同じ属性について述べていれば含みます。話題が一覧のどれとも異なる場合や、
  > 記憶の内容が「言及していない」「特に述べていない」「〜したいことがある」のように
  > 実質的な主張を持たない場合は、一覧を無理に当てはめず、新しい predicate を作って
  > ください。無関係な記憶どうしを同じ predicate にまとめないでください。

##### 測ったこと【実測】

2026-09-25、`gpt-4o-mini`、`examples/chat/src/answer-case-set.dev.ts`（6件）+
`.eval.ts`（8件）の全14ケース、`initdb`（PostgreSQL 17、pgvector・btree_gin・pgcrypto、
専用ポート・作業ツリー外）で立てた専用インスタンス。**同一セッション**（この追記の
作業中、連続した実行）に、基準（本 ADR の文言、以下 before-on）と4変種
（after-on-v1〜v4）を、それぞれ n=3 回、種は `answer.order-legend.json` だけを使って
実行した。反復ごとに別のカセット
（`examples/chat/cassettes/answer.claim-key.{before-on,after-on-v1,after-on-v2,after-on-v3,after-on-v4}-{1,2,3}.json`、
新規ファイル）に記録した。誤検出したケース名は、記録した診断ログをスクリプトで
機械的に集計した（手で転記していない）。

| 条件 | run | predicate一致/4 | contested/4 | 誤検出/14 | 誤検出したケース |
|---|---|---|---|---|---|
| before-on | run1 | 4/4 | 4/4 | 3/14 | other-person-birthday, other-period-city-this-year, unknown-favorite-number |
| before-on | run2 | 4/4 | 4/4 | 3/14 | other-person-birthday, other-period-city-this-year, unknown-favorite-number |
| before-on | run3 | 4/4 | 4/4 | 2/14 | other-period-city-this-year, unknown-favorite-number |
| after-on-v1 | run1 | **3/4** | **3/4** | 2/14 | other-period-city-this-year, unknown-favorite-number |
| after-on-v1 | run2 | 4/4 | 4/4 | 2/14 | other-period-city-this-year, unknown-favorite-number |
| after-on-v1 | run3 | 4/4 | 4/4 | 2/14 | other-period-city-this-year, unknown-favorite-number |
| after-on-v2 | run1 | 4/4 | 4/4 | 3/14 | other-period-city-this-year, pref-window-seat, unknown-favorite-number |
| after-on-v2 | run2 | 4/4 | 4/4 | 4/14 | other-person-birthday, other-period-city-this-year, unknown-favorite-number, eval-misattribution-order-swapped |
| after-on-v2 | run3 | 4/4 | 4/4 | 2/14 | other-period-city-this-year, unknown-favorite-number |
| after-on-v3 | run1 | 4/4 | 4/4 | 4/14 | other-person-birthday, other-period-city-this-year, pref-window-seat, unknown-favorite-number |
| after-on-v3 | run2 | 4/4 | 4/4 | 3/14 | other-period-city-this-year, other-person-favorite-food, unknown-favorite-number |
| after-on-v3 | run3 | 4/4 | 4/4 | 3/14 | other-period-city-this-year, other-person-favorite-food, unknown-favorite-number |
| after-on-v4 | run1 | 4/4 | 4/4 | 2/14 | other-period-city-this-year, pref-window-seat |
| after-on-v4 | run2 | 4/4 | 4/4 | 2/14 | other-period-city-this-year, unknown-favorite-number |
| after-on-v4 | run3 | 4/4 | 4/4 | 3/14 | other-person-birthday, other-period-city-this-year, unknown-favorite-number |

条件ごとの誤検出（run1, run2, run3・平均・範囲）:

| 条件 | 誤検出/14（run1, run2, run3） | 平均 | 範囲 |
|---|---|---|---|
| before-on | 3, 3, 2 | 2.67 | 2〜3 |
| after-on-v1 | 2, 2, 2 | 2.00 | 2〜2 |
| after-on-v2 | 3, 4, 2 | 3.00 | 2〜4 |
| after-on-v3 | 4, 3, 3 | 3.33 | 3〜4 |
| after-on-v4 | 2, 2, 3 | 2.33 | 2〜3 |

ケース別誤検出インシデンス（3回中何回）:

| ケース | before-on | v1 | v2 | v3 | v4 |
|---|---|---|---|---|---|
| `other-period-city-this-year` | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| `unknown-favorite-number` | 3/3 | 3/3 | 3/3 | 3/3 | 2/3 |
| `other-person-birthday` | 2/3 | 0/3 | 1/3 | 1/3 | 1/3 |
| `pref-window-seat` | 0/3 | 0/3 | 1/3 | 1/3 | 1/3 |
| `other-person-favorite-food` | 0/3 | 0/3 | 0/3 | 2/3 | 0/3 |
| `eval-misattribution-order-swapped` | 0/3 | 0/3 | 1/3 | 0/3 | 0/3 |

##### 判定: 否定的結果

**どの変種も、before-on の run 間の揺れの幅（2〜3/14）を明確に超えて誤検出を下げつつ、
predicate 一致・`contested` 成立を4/4に保つことはできなかった**:

- **v1**（誤検出は3回とも2/14で before-on の下限と同着）は、predicate 一致を3回に
  1回落とした（`negation-moved-job`、否定を伴う訂正の取りこぼし）——マネージャー指示
  「predicate 一致 4/4・`contested` 4/4 を落とさない」を満たさない。
- **v2**（3, 4, 2）・**v3**（4, 3, 3）は predicate 一致を3回とも保ったが、誤検出は
  before-on の平均（2.67）を**上回った**——「誤検出を減らす」という目的そのものを
  達成できていない。
- **v4**（2, 2, 3）は predicate 一致を3回とも保ち、誤検出の平均（2.33）は before-on
  （2.67）よりわずかに低いが、**run3で3/14——before-on の run 間の揺れの範囲
  （2〜3/14）に完全に収まっている**。差は「3回あたり誤検出1件」に相当し、統計的に
  意味のある差と主張できる根拠が無い。**v4は4変種を実測した*あとで*、結果を見てから
  選んだもの**（4変種を実測する前に「これを採用する」と決めていたわけではない）——
  事後選択（post-hoc selection）であり、5番目の独立したサンプルで再現するかどうかは
  確かめていない。
- **v2〜v4はいずれも、before-on/v1では一度も観測されなかった新しい誤検出
  `pref-window-seat` を誘発した**（v2: 1/3、v3: 1/3、v4: 1/3）。文言変更は「誤検出の
  総数」を動かすだけでなく、「誤検出になるケースの集合」そのものを入れ替える副作用を
  持つ——ある種の誤検出（`other-person-birthday`）を減らす代わりに、別の種類の誤検出を
  稀に誘発する。
- **`other-period-city-this-year` は全5条件・全15runで誤検出**——ADR 0326 (d) と
  同一の構造的原因（`去年は札幌で働いていた。`/`今年は福岡で働いている。`の2文が、
  語彙ヒントが影響する前の最初の `deriveClaimKeys` 呼び出しで、既に同じ predicate
  `work_location` を割り当てられる。`validFrom`/`validUntil` を渡していないため
  period が重ならず `contested` になる）——**本追記の対象外**（プロンプト文言変更が
  触れる余地が無い）。

**⟹ 結論: プロンプト文言の変更だけでは、この誤検出を「n=3程度の実測で有意に確認できる
形で」減らせなかった。** 費用: 5条件 × n=3 = 679 chat 呼び出し、合計 $0.051076
（gpt-4o-mini、上限 $0.50 の約10.2%）。

##### 次の手がかり（未測定）

- ⛔ **n=3を超える反復（例: n=10）で、v4 のような「僅かな改善に見える」変種が
  統計的に有意な差として確認できるか。**本追記は試していない。
- ⛔ **`unknown-favorite-number` 型の force-fit（旅行の計画↔新しい趣味のような、
  具体的な対象を欠く漠然とした意向どうしの混同）に絞った、専用の判定ロジック**
  （例: claim key 派生とは別に、記憶の「実質的な内容の有無」を判定する前段を挟む）
  ——プロンプト文言の範囲を超えるため本追記は試していない。
- ⛔ **`other-period-city-this-year`（ADR 0326 (d)）を先に直した場合、語彙ヒント文言の
  効果測定がやり直しになるか。**(d) を直せば構造的な誤検出1件が消え、n=14ケース中の
  誤検出率の分母・分子が変わるため、本追記の実測をそのまま使い回せない可能性がある。
- ⛔ **本追記が試した4変種以外の方向**（例: 語彙ヒントを system prompt ではなく
  user message 側へ移す、predicate ごとに個別の確信度を返させる等）。マネージャー
  指示の範囲（プロンプト文言の変更のみ、正規化強化・埋め込み類似度統合は既に却下済み）
  では、本追記が試した4変種が予算内で試した範囲のすべてである。

### 負債2: (g) が残る限り、predicate 一致の改善は `[矛盾候補:]` タグに届かない（ADR 0326 の仮説の再確認）

「測ったこと」4節のとおり、訂正4ケースは6/6回とも `[矛盾候補:]` タグに到達しなかった。
**この PR は (g) を直さない**——ADR 0326「採らなかった案A」のままオーナーの判断を待つ。

### 負債3: `subjectId` は観測全体の既定値であり、候補ごとの上書きを見ない

決定4のとおり。複数話者の発言を1回の `observe()` で観測し、候補ごとに異なる `subjectId`
（ADR 0271）を使う場面では、この口が集める語彙は「観測全体の既定の主題」に閉じ、候補
固有の主題の語彙は集めない。

### 負債4: 総合の語彙一覧に上限を掛けていない

案D参照。利用者が渡す `knownPredicates` が大きい場合、`limit`（既定20）を超えて
プロンプトへ積まれうる。

### 負債5: `limit`（既定20）の切り詰め効果を実データで測っていない

決定5参照。本 ADR の実測はいずれもテナントあたり claim key を持つ行が最大5件程度であり、
`limit: 20` が実際に切り詰めとして働く場面を経験していない。

### 負債6: 大規模テナント（1 subjectId あたり claim key 行が数百〜数千件）での性能を測っていない

決定2参照。新しい索引を足していないため、この規模での実行計画・レイテンシは未測定。

---

## 確かめていないこと

- ⛔ **語彙ヒントによる誤検出増加（負債1）が、14ケースという範囲を超えても同じ頻度か。**
- ⛔ **(g) を直した場合に、predicate 一致の改善が実際に `[矛盾候補:]` タグの増加へ
  つながるか**（負債2、案A参照）。
- ⛔ **候補ごとの `subjectId` 上書きがある場面での挙動**（負債3）。
- ⛔ **`limit`（既定20）が実データで切り詰めとして働く場面の効果**（負債5）。
- ⛔ **大規模テナントでの `listActiveClaimPredicates` の性能**（負債6）。
- ⛔ **claim key の `subject` 誤帰属（ADR 0324 負債6、家族・同僚等への誤帰属）との
  相互作用**——本 PR の実測では `subject` 弁別に起因する誤検出（他者の発話を `"user"` に
  誤帰属）は観測されなかったが、これは本 PR の対象ケースの構成に依存する可能性があり、
  一般化はできない。

## これが覆るとしたら

- **オーナーが案A（(g) を `packages/core` で直す、ADR 0326「採らなかった案A」）を採る
  決定を下したとき**——本 PR が実測した「predicate 一致 4/4・`contested` 成立 4/4」が
  初めて `[矛盾候補:]` タグとして実際に届くようになる。そのときは、負債1（語彙ヒントに
  よる誤検出増加）も同時に `[矛盾候補:]` タグへ現れるようになるため、誤検出対策
  （プロンプト文面の改善、または `validFrom`/`validUntil` の付与、ADR 0326 案C）を
  合わせて検討する必要が生じる。
- **claim key 派生プロンプトが、無関係な発話への predicate 再利用を防ぐよう改善された
  とき**（負債1）——誤検出率が下がり、`knownPredicatesFromStore` を既定 on にする判断の
  材料が変わる。
- **`listActiveClaimPredicates` の性能が大規模テナントで問題になると測定されたとき**
  （負債6）——`(tenant_id, subject_id, status, claim_key_predicate, created_at)` の
  covering index を migration として追加する余地がある。

## 関連

- Issue #691（本 ADR の対象）、Issue #371/#372（claimKey/detectContested 本体）
- [ADR 0326](./0326-answer-path-claim-key-contested-opt-in-measurement.md)（`answer`
  経路の opt-in・(a)〜(g) の切り分け・「採らなかった案B」＝本 ADR の前身）
- [ADR 0324](./0324-claim-key-contested-detection.md)（`findActiveByClaimKey?`・検出
  実装、real-fixture 誤検出30%の先行研究）・
  [ADR 0320](./0320-claim-key-field-implementation.md)（claim key 実装・語彙ヒントの
  効果測定）・[ADR 0315](./0315-claim-key-does-not-touch-extraction-cassettes.md)
  （claimKey はカセットを壊さない、種カセットの推奨）
- [ADR 0179](./0179-adr-number-assigned-at-merge.md)（ADR 番号はマージ直前に確定、本
  ADR が `0327`→`0328`→`0329` と振り直した経緯の根拠）
