# ADR 0316: 主張キー（(B) 第1段）の実装 — `{subject, predicate}` を2列+部分索引で持ち、opt-inの別呼び出しで埋める（Issue #371）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-25

### 出所の凡例（ADR 0185/0315 以降の作法）

| 記号 | 意味 |
|---|---|
| 【実測】 | この作業者が、この器で実際に `OPENAI_API_KEY`（gpt-4o-mini）・本物の Postgres + pgvector を叩いて得た |
| 【現物】 | この作業者が、リポジトリの現物（コード・文書）を読んで確かめた |
| 【受】 | 人・他のエージェントから受け取った前提。自分で検証していない |

---

## 文脈

**この ADR が決めるのは Issue #371（(B) 第1段: 抽出に「何についての主張か」の鍵を持たせる。
検出はまだしない）の実装詳細である。** [ADR 0185](./0185-contradiction-detection-path.md)
決定2・決定3・決定4 が (B) を採る方向と鍵の推論としての扱いを決め、
[ADR 0315](./0315-claim-key-does-not-touch-extraction-cassettes.md) が「既定の抽出プロンプトは
変えない・(ii) separate を採る・鍵の形は `{subject, predicate}`」という機械的な前提を決めた。
**両 ADR とも「#371 が実装時に確定させる」として残した項目**（正規化規則、バッチ粒度、
索引の張り方、公開 API の形）を、この ADR で確定する。

⛔ **この ADR は検出（#372）を一切決めない。** `claimKey` が埋まるだけで `contested` は
1件も立たない——本 PR のコード（`packages/core/src/claim-key.ts` ほか）のどこにも
`status`/`contested` への言及が無いことがその実装上の証拠である。

---

## 決定

### 決定1: 鍵は `Memory`/`NewMemory` にネストした `claimKey?: {subject, predicate} | null` として持つ

`packages/core/src/claim-key.ts` に `ClaimKey`/`ClaimKeySchema` を新設し、
`Memory.claimKey?: ClaimKey | null` として `Memory`/`NewMemory` へ足した
（`packages/core/src/memory.ts`）。**`ExtractedMemoryCandidateSchema`（`extraction.ts`）は
1バイトも変更していない**——鍵は抽出の LLM 応答としてではなく、抽出**後**に
`runtime.ts` が別呼び出しの結果を `buildNewMemoryFromCandidate` へ注入する形で埋める
（決定4参照）。

**`Memory.subjectId`（この記憶が誰についてか）と `claimKey.subject`（主張の文法上の主語）を
混同しない。** 別の欄・別の型として持つ——実測（下記「測ったこと」）で、この2つが
実際に異なる値を取りうることを確認した（例: `subjectId: "subject-abc"` と
`claimKey.subject: "user"` が同時に存在する）。

### 決定2: 🔴 鍵は「推論」であることを、型・doc コメント・列名で表す（北極星 問い4）

`packages/core/src/claim-key.ts` の `ClaimKey` の doc コメントが逐語で「この鍵は LLM が
作る ⟹ 推論である」「`Memory.provenance` とは別の軸であり、混ぜない」と明記する。
`Memory.claimKey` の doc コメントも同じ注意を繰り返す。**`provenance`（`stated`/`inferred`
の判別共用体）に鍵を混ぜず、独立した optional 欄にした**——`stated` な Memory にも
`claimKey` が付きうる（「ユーザーが事実を言った」ことと「その事実がどの属性についての
主張かを LLM が分類した」ことは別の軸であるため）。

### 決定3: 正規化規則 — NFKC正規化 → 前後空白除去 → 小文字化 → 内部空白を `_` に畳む

`normalizeClaimKeyPart`（`claim-key.ts`）で確定した。ADR 0315 §3.1/3.2 が推奨した形
（小文字化・NFKC・空白除去）をそのまま実装し、べき等性（2回適用しても結果が変わらない）を
歯で固定した（`__tests__/claim-key.test.ts`）。

⚠ **これは表記ゆれ（全角/半角・大文字/小文字・空白の数）だけを吸収する。**
「好きな食べ物」と「好きな食物」のような**言い換えの統合**は正規化では解かない——
ADR 0315 §3.2 の実測どおり、統合は LLM 自身がバッチ内で行う（決定4参照）。

### 決定4: バッチ粒度 — 1回の `runExtraction`（＝1回の `observe()` の抽出）につき1回

`runtime.ts` の `runExtraction` が、`extractCandidates` の成功後・`candidates.length > 0` の
ときだけ、その回のすべての候補の `content` をまとめて `deriveClaimKeys` へ1回で渡す。
**候補が0件なら呼ばない**（ADR 0315 決定2「+0回にできる」をそのまま満たす——`claim-key.ts`
の `deriveClaimKeys` 自身も `contents.length === 0` を早期 return するため、二重の安全弁になっている。
実測でこの二重性を確認した——`runtime.ts` 側の早期 return を変異させても `deriveClaimKeys` 側の
早期 return がそのまま守ったため、当初の変異試験が赤くならなかった。下記「測ったこと」参照）。

**採らなかった選択肢**: 複数の `observe()` をまたいでバッチする（例: 1分間分の候補を
まとめて問う）。**採らない理由**: `runtime.observe()` は1回の呼び出しごとに同期で結果
（`ObserveResult`）を返す契約であり、複数呼び出しをまたぐバッチは「いつ確定するか」という
新しい非同期性を持ち込む。ADR 0315 が「正確なバッチ粒度は#371の実装判断」と明示的に
残した選択の中で、**既存の同期契約を壊さない**もっとも単純な形を採った。

### 決定5: 失敗の扱い — 長さ不一致は「対応付けを推測しない」。呼び出し失敗はMemory作成を止めない

`deriveClaimKeys` が返す配列の長さが入力と一致しないとき（**実際に real fixture で発生した**
——下記「測ったこと」）、**部分的な対応付けを機械的に推測しない**——全要素を `null` にし、
`failure.kind: "claim_key_length_mismatch"` を返す。これは `AGENTS.md`「機械には検出まで」
の裏返しであり、`sanitizeCandidateSubjectId`（ADR 0271）が「一覧に無い値を弾いて
`undefined` に戻す」のと同じ、**不確かな値を無理にでっち上げない**という規律の延長である。

`deriveClaimKeys` の呼び出し自体が失敗（例外）しても、`runExtraction` は Memory の作成を
止めない——各候補の `claimKey` が `null` のまま作られ、失敗は `ObserveResult.claimKeyFailure`
に残る（`rejectedSubjectIds` と同じ「黙って戻さない」規約、opt-in を使った呼び出しだけに
このキーを持たせる）。**claim key は「あれば良い」付加情報であり、その失敗が抽出全体を
道連れにしてはならない**——北極星問1（毎回渡す量を減らす方向）に対し、claim key 機構自体の
不調が Memory 作成という主機能を止めることは、増える量を正当化する理由（問3の説明可能性）
を上回る害になる。

### 決定6: opt-in の口 — `ObserveXxxInput.claimKey?: { enabled: boolean; knownPredicates?: string[] }`

`packages/core/src/claim-key.ts` の `ClaimKeyOptions` を `ObserveUtteranceInput`/
`ObserveEventInput`/`ObserveDocumentInput` に足した（`subjectCandidates`、ADR 0271 と同じ形）。
`extract: 'deferred'` とは併用不可（`CLAIM_KEY_WITH_DEFERRED_EXTRACT_ERROR_PREFIX`、
`subjectCandidates` と同じ理由——`claimKey` オプションは `Observation` に永続化しない）。
`reextract`/`processExtractJob`（deferred側）はこの口を持たない。

`knownPredicates`（ADR 0271 の `subjectCandidates` と同型の語彙ヒント）は独立した呼び出しに
渡すだけであり、抽出プロンプト本体の指示とは混線しない（ADR 0315 決定2の表が既に指摘した
利点）。

**公開 API への影響は「任意の純追加」のみ**（`docs/decisions/0178-public-api-surface-gate.md`
が semver 安全と定める形）: `Memory`/`NewMemory` に optional 欄1つ、`ObserveXxxInput` 3型に
optional 欄1つずつ、`ObserveResult` に optional 欄1つ。**公開の union 型（`ObserveInputKind`
等）には触れていない**（Issue #541 でオーナー回答待ちの論点を避けた）。

### 決定7: Postgres — 2つの flat text 列 + 部分 btree 索引（JSONB 1列にしない）

`migrations/0021_memories_claim_key.sql`: `claim_key_subject`/`claim_key_predicate`
（両方 `text NULL`）+ `idx_memories_claim_key`（`(tenant_id, subject_id, claim_key_subject,
claim_key_predicate)`、`WHERE claim_key_subject IS NOT NULL` の部分索引）。

**JSONB 1列にしなかった理由**: `provenance`（判別共用体、種類ごとに形が違う）と違い、
`claimKey` は常に同じ2スカラーの組でしかない。#372（未実装）が想定する検出クエリ
（「同じテナント・同じ `subject_id`・同じ claim key を持つ他の `active` な Memory を探す」）に
対して、平たい列 + 通常の複合索引のほうが式索引・JSONB 演算子より単純でプランナに読みやすい。

**部分索引にした理由**: `idx_memories_contested`/`idx_memories_superseded_by`
（`migrations/0004_contested_with_index.sql`）と同じ判断——opt-in を使わない大多数の行
（鍵が無い）をこの索引に含めても#372のクエリから一度も引かれない。

【実測】この器（`initdb` で立てた専用インスタンス、PostgreSQL 17 + pgvector）で
migration を実際に適用し、`\d memories` で列・索引の存在を確認、
`packages/testkit/src/memory-store-conformance.ts` の claimKey 歯（4件）を
`conformance.postgres.test.ts` 経由で実際に緑にした（下記「測ったこと」）。

### 決定8: 索引に `status` を含めない

`#372`（未実装）がどの `status` 集合を対象に検出クエリを組むか（`active` のみか
`active`+`contested` か）は、この ADR の射程外——決めてしまうと#372の実装判断を
この migration が先取りすることになる。**汎用の「claim key で引く」索引**として作り、
`status` の絞り込みは呼び出し側（将来の#372のクエリ自身）に委ねる。

---

## 採らなかった案

### 案A: `ExtractedMemoryCandidateSchema` に `claimKey` を optional で足し、抽出と同じ呼び出しで埋めさせる

**採らない理由**: ADR 0315 決定2 がこれを (i) inline として比較し、(ii) separate に
安定性（87.5% vs 95-100%、synthetic実験）・言い換え統合率（80% vs 100%）の両方で
劣ると判定済み。この ADR はその判定を覆す新しい根拠を見つけていない——むしろ本 ADR の
real-fixture 実測（下記）は、(ii) separate の構成でも実運用のテキストでは synthetic 実験
ほどの安定性が出ないことを示しており、(i) inline を採る理由はさらに乏しくなった。

### 案B: 正規化に、近い意味の predicate を機械的に統合する後処理（レーベンシュタイン距離等）を足す

**検討したが採らなかった。** ADR 0315 負債3「語彙一覧に無い新規 predicate 作成の安定性」への
対応として一度検討したが、(a) 「近い」の閾値が北極星問3（説明できるか）に対して
「距離が0.2未満だから同じ」という**数であって理由ではない**判定になりかねない（ADR 0134
案Dが埋め込み類似度で落ちたのと同型の穴）、(b) 実測（下記）では**語彙ヒントだけで
無関係主題間の誤衝突は0件**であり、この後処理を正当化する実害が今回の実測範囲では
見つからなかった。⟹ 見送る。必要になったら独立した issue にする。

### 案C: `claimKey` を `Memory.tags` の一部（特殊なタグ文字列）として持つ

**採らない理由**: `tags` は「LLM の推論を人間が読める形で残す」自由記述の場であり、
`(tenant_id, subject_id, claim_key)` の等値検索に構造として使うには型が弱すぎる
（配列の中の1文字列を等値検索するのは索引設計として不自然）。決定1の理由がそのまま
この案を却下する。

---

## 引き受けた負債

### 負債1: 🔴 real-fixture 実測は、synthetic 実験（ADR 0315）より低い安定性を示した

**【実測】**（下記「測ったこと」全文）。ADR 0315 の synthetic 実験（n=8、1話題1文）は
語彙ヒント付きで安定性100%だったが、**この ADR の real-fixture 実測（n=5、17件の実発話、
`examples/chat` の既存フィクスチャから）は語彙ヒント付きでも89.4%に留まった。**
⟹ **ADR 0315 負債1（「実験は小さい・合成であり、本番規模の保証ではない」）が実際に
顕在化した**——実際にもっと多様な実文で測ると、安定性は下がった。

⚠ **ただし、誤衝突（無関係な主題が同じ鍵になる）は real-fixture 実測で0件だった**
（下記）。**不安定性の現れ方は「同じ事実が別の鍵になる（false negative、#372の検出漏れ）」
であって「別の事実が同じ鍵になる（false positive、誤った contested）」ではなかった**——
これは北極星問4の観点で好ましい失敗の向きである（争いを見逃すことは害が小さい。
争いを捏造することのほうが信用を損なう）。**ただし n=7 の対だけでの観測であり、
一般化はできない。**

### 負債2: 3件以上が同じ鍵に並ぶケースを実測していない

Issue #371 が測定条件に挙げた「同じ鍵に3件以上並ぶ群の件数（#207 無しでは表せない件数）」を
**測っていない**——既存フィクスチャ（`probe-set.ts`/`correction-scenario.ts`）には、
同じ主題が3回以上言及される実データが無かった。**確かめていないこと**として記録する。

### 負債3: 有効期間（`validFrom`/`validUntil`）の重なりは実測していない

同様に、「対の有効期間が重なるか」も測っていない——real fixture のうち `travel` の対
（今回の出張/先月の出張）は本来 `occurredAt`/`validFrom` が異なるはずだが、
この実験は `content` 文字列だけを `deriveClaimKeys` へ渡しており、時刻情報を一切
見ていない（`deriveClaimKeys` の入力自体がそう設計されている——鍵は「何についての
主張か」だけを問い、いつのことかは既存の `occurredAt`/`validFrom`/`validUntil` 列が
既に持っている、ADR 0185 §6 の想定通り）。

### 負債4: 語彙ヒント一覧は、この実測用に作業者が手で作った8件——実運用の語彙構築方法は未定

`KNOWN_PREDICATES`（`favorite_color`/`favorite_food`/`pet_ownership`/...）は、この実測の
ために作業者が対象の7話題から逆算して作った一覧であり、**実運用でこの一覧をどう構築・
更新するか（新しい predicate が現れたときにどう一覧へ足すか）は、この ADR も #371 も
決めていない。** `buildSubjectCandidateInstruction`（ADR 0271）と同型の口を用意した
だけであり、その運用は呼び出し側（アプリケーション層）の設計判断として残る。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向か

**中立〜わずかに増える。** opt-in を有効にすると `observe()` 1回につき+1回の LLM 呼び出し
が増える（決定4）。ただし候補が0件なら+0回（決定4）。**この機構単体は削減しない**——
削減が実際に起きるのは#372（検出）が着地し、それを根拠に古い事実が recall から外れたときで
ある（ADR 0185 問1 と同じ構造）。

### 問2: 無効にしても Memory Framework として成立するか

**成立する。** `claimKey` を渡さない・`{enabled: false}` の呼び出しは、
`packages/core/src/__tests__/runtime.test.ts`「観測: claimKey」の歯で実測した通り
`deriveClaimKeys` を一度も呼ばない。既存の抽出プロンプト・カセット鍵も1バイトも
変わらない（`extraction.test.ts` の「subjectCandidates 省略時の鍵は固定値のまま動かない」
の歯がこの PR の変更後も緑のまま——実測、下記）。

### 問3: 選ばれた理由を後から説明できるか

**鍵そのものは説明できる**（LLM が返した `{subject, predicate}` をそのまま保持）。
⚠ **ただし「なぜその鍵になったか」は説明できない**（LLM の内部判断）——これは
ADR 0185 問3 が (B) 全体に認めた限界であり、この ADR で変わっていない。#372 が
「同じ鍵・重なる期間・違う内容」という列の等値比較で判定を組む限り、**判定自体は
説明できる**（鍵の生成理由は説明できないが、鍵の一致という事実は説明できる）。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

**区別している**（決定2参照）。`claimKey` を `provenance` と混ぜず独立した欄にし、
doc コメントで「これは推論である」と明記した。

### 問5: LLM を呼ばずに済ませられないか

**検出（列の等値比較）は呼ばずに済む——ただし検出はこの ADR の範囲外。**
鍵の生成自体は呼ぶ（`Memory` 型に主語・述語に当たる構造化フィールドが無いため、
ADR 0185 §5 が既に確認した通り「解けない」）。

---

## 測ったこと

### 1. 型・単体テスト・変異試験【実測】

- `packages/core`: `pnpm --filter @mnemora/core run typecheck` 緑。
  `vitest run`（対象ファイル名指し）: `claim-key.test.ts`（17件）・`runtime.test.ts`
  （117件、うち claimKey 関連15件）・`extraction.test.ts`・`schema-type-equals-parity.test.ts`
  ・`observe-occurred-at.test.ts` すべて緑（計184件）。
- **変異試験**（`docs/autonomy.md` §2、`cp`での退避・復元、`git checkout`は使っていない）:
  1. `runtime.ts` の `claimKeyOptions?.enabled === true` を `true` に変異 ⟹
     「既定では呼ばれない」歯が実際に赤くなった（`Cannot read properties of undefined
     (reading 'knownPredicates')` で早期に露呈）。復元後、同じ歯が緑に戻ることを確認。
  2. `runtime.ts` の `candidates.length === 0` 早期 return を `false` に変異 ⟹
     **この歯は赤くならなかった**——`deriveClaimKeys` 自身が持つ二重目の早期 return
     （`contents.length === 0`）が代わりに守っていたため。⟹ `claim-key.ts` 側の
     早期 return を `false` に変異させ直したところ、`claim-key.test.ts`「候補が0件なら、
     LLM を一度も呼ばずに空配列を返す」が実際に赤くなった。復元後、緑に戻ることを確認。
     **この二重の安全弁は意図的な設計ではなく、2箇所で独立に「0件なら呼ばない」を
     実装した結果である**——どちらか片方が壊れても、もう片方が守る形になっている。
  3. `packages/postgres/src/mapping.ts` の `rowToClaimKey` を常に `null` を返す実装へ
     変異 ⟹ `conformance.postgres.test.ts` の claimKey 歯4件中3件が実際に赤くなった
     （本物の Postgres に対して実行）。復元後、4件とも緑に戻ることを確認。

### 2. Postgres 実測【実測】

`initdb`（PostgreSQL 17、pgvector・btree_gin・pgcrypto）で専用インスタンスを立て
（`AGENTS.md`「手元で Postgres を立てる」手順どおり、既定の5432は使わず専用ポート）、
`migrations/0021_memories_claim_key.sql` を実際に適用した。`\d memories` で
`claim_key_subject`/`claim_key_predicate` 列と `idx_memories_claim_key`
（部分 btree 索引）の存在を確認。`conformance.postgres.test.ts` の claimKey 歯4件、
および `createMemory`/`supersedeWithNewMemories` を含む既存の書き込み系の歯
（-t 指定でそれぞれ28件・6件）を実際に実行し、すべて緑であることを確認した。
作業終了後、インスタンスは停止・データディレクトリごと削除した。

### 3. 実 API 測定【実測、2026-09-25、この作業者が自分の手で `gpt-4o-mini` に対して実行】

**入力**: すべて既存フィクスチャ由来（**合成していない**）。
`examples/chat/src/probe-set.ts` の `PROBES`（北極星の物差しに隣接する意味的関連性
ベンチで実際に使われている実データ）のうち7話題の `fact`/`distractor` を、
`examples/chat/cassettes/retrieval.json` に記録済みの**実際の抽出結果**（`content`）に
差し替えて使った（1文字も生成していない、既存カセットからそのままコピー）。
加えて `examples/chat/src/correction-scenario.ts` の実訂正ペア（`examples/chat` の
correction デモで実際に使われている）2発話を使った。計17件。

**方式**: 本番コード（`packages/core/dist/claim-key.js` の `deriveClaimKeys`、
`packages/openai/dist/llm-provider.js` の `OpenAILLMProvider`）をそのまま使った
——ADR 0315 の実験と異なり、翻訳規則を手で複製していない。各アイテムを**1件ずつの
バッチ**（実運用でその発話単体から抽出された場合の形）として n=5 回叩いた。
(A) 語彙ヒント無し、(B) 語彙ヒント有り（作業者が7話題から作った8件の predicate 一覧）
の2通り、計 17×5×2 = 170回。

⚠ **1回目の実行は方法論の誤りで失敗した**（記録として残す——`docs/autonomy.md`の
「出なかったことを事象が無いことの証明にしない」の逆側の教訓: 「出た」結果も、
それが測ろうとしたものを正しく測っているかを疑うべきである）: probe の `fact` 文字列
（抽出**前**の生発話）をそのまま1件の content として渡したところ、"私の好きな色は
青です。誕生日は4月3日です。" のような複数主張を含む発話に対し、LLM が2件の claim key
を返そうとして `claim_key_length_mismatch` になった（5回中4回）。これは claim key の
不安定性ではなく、**測定側が実際の使われ方（抽出後の1トピック1candidateという前提）を
再現できていなかった**ことが原因だった。抽出後の実際の候補 content に差し替えて
やり直した（上記「入力」の記述はやり直し後のもの）。

**結果**:

| 指標 | (A) 語彙ヒント無し | (B) 語彙ヒント有り |
|---|---|---|
| 安定性（多数決一致率、17項目×5回=85） | 63/85 = **74.1%** | 76/85 = **89.4%** |
| 無関係対の誤衝突（7対中） | 0/7 | 0/7（`travel`の1件は同一主体・異なる期間の対であり、本来同じ鍵になるべき対。誤衝突ではない——本文「引き受けた負債1」参照） |
| 真の訂正対の検出（correction 1対） | ⭕ 1/1（両側5/5で安定） | ⭕ 1/1（両側5/5で安定） |
| 呼び出し回数 | 85 | 85 |
| prompt tokens | 26,545 | 32,920 |
| completion tokens | 1,271 | 1,275 |
| 概算費用(USD) | $0.00474 | $0.00570 |

**合計**: 170回、$0.01045（`examples/chat/src/usage-meter.ts` の
`PRICING_USD_PER_MILLION_TOKENS["gpt-4o-mini"]` と同じ単価で概算）。
1回目の失敗した実行（160回、$0.00989）を含めた本 ADR の実測合計は330回、約$0.0203。

**観測**: 語彙ヒントは安定性を74.1%→89.4%へ押し上げた（ADR 0315 の synthetic 実験
（95%→100%）と同じ向き、ただし絶対値は低い）。**無関係主題間の誤衝突は両条件とも
実質0件**——real-fixture の範囲では、claim key は「別の事実を誤って同じ鍵にする」
方向にはほとんど倒れなかった。**唯一の真の訂正対（correction）は、両条件・全10回とも
一貫して同じ鍵になった**——`#372`（未実装）がこの対を検出できる土台になっている
ことを実データで示せた。

**レイテンシ**: 個別に計測していない（**確かめていないこと**参照）。使用モデル・
トークン規模は既存の抽出呼び出しと同等であり、定性的には同程度のレイテンシを
見込むが、実測はしていない。

---

## 確かめていないこと

- ⛔ **3件以上が同じ鍵に並ぶ群の実測**（負債2）。
- ⛔ **有効期間（`validFrom`/`validUntil`）の重なり判定との組み合わせ**（負債3）。
- ⛔ **opt-in 呼び出しのレイテンシ**（定性的な見込みのみ）。
- ⛔ **語彙ヒント一覧の実運用での構築・更新方法**（負債4）。
- ⛔ **多言語・英語混在の会話での挙動**——実測はすべて日本語（一部英語の固有名詞
  `TypeScript`/`Rust`/`Go` を含む）。
- ⛔ **`#372`（検出）と組み合わせたときの、real-fixture上での実際の contested 生成件数**
  ——この ADR は検出を実装していないため測りようがない。
- ⛔ **本番規模（実際のテナントの語彙・長い会話・数百〜数千件のMemory）での安定性**
  ——n=17は依然として小さい。

## これが覆るとしたら

1. **既定を on にする決定が下されたとき**（ADR 0185 決定7、オーナー専権、#372 着地後）
   ——決定6（opt-in の口）を既定値の変更に組み替える必要がある。⭐門・
   `retrieval`/`answer`の基準値は抽出プロンプトを変えない限り動かないため
   （決定1・ADR 0315 決定1）、既定 on 自体はカセットの録り直しを要求しない
   ——ただし claim key opt-in を既定で有効にすると、`retrieval`/`compare` の
   実行時に**新しい claim key 用の記録**が必要になる（決定4の呼び出しが常に発生する
   ため）。
2. **#372 の実装時に、より大規模な real-fixture 実測で安定性がさらに下がると
   分かったとき**——負債1が深刻化し、語彙ヒントの運用方法（負債4）の設計を
   先に固める必要が出る。
3. **`Memory.subjectId` と `claimKey.subject` を統合すべきという判断が下されたとき**
   ——決定1の分離を再検討する必要がある。今回の実測ではこの2つが必ずしも一致しない
   ことを確認しているため（例: `subjectId` はアプリケーション側のユーザーID、
   `claimKey.subject` は文法上の主語）、統合は情報を失う可能性が高い。
