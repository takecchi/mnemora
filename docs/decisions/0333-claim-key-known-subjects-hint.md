# ADR 0333: claim key の `subject` 誤帰属を、明示的な `knownSubjects` 語彙ヒントで減らす — store 自己蓄積版・`subjectCandidates` への暗黙の転用は、いずれも実測・設計検討の末に採らない（Issue #372負債6）

- **状態**: 採用 (2026-09-26)
- **日付**: 2026-09-26

**⚠ この PR はクローンの委譲で動く担い手が書いた。投稿者はオーナー本人ではない**
（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)
——投稿者名は担い手とオーナーを区別しない）。**この ADR に出てくる判断はすべて
「委譲された担い手の判断（オーナーではない）」である。**オーナーの確認・承認を得た
ものではない。

⚠ **番号について**: 着手時点で `docs/decisions/` の最大番号は `0332` だったため
`0333` を仮に採った。着手中に別の PR（#791、Issue #109 関連、未マージ）も同じ番号
`0333` を仮に使っていることを確認した——[ADR 0179](./0179-adr-number-assigned-at-merge.md)
のとおり、最終番号はマージ直前に `node scripts/adr-renumber.mjs` で確定させる
（どちらが先に着地するかで、後から着地するほうが振り直される）。

### 出所の凡例（ADR 0185/0315/0320/0324/0326/0329 以降の作法）

| 記号 | 意味 |
|---|---|
| 【実測】 | この作業者が、この器で実際に本物の `OPENAI_API_KEY`（`gpt-4o-mini`）を叩いて得た |
| 【現物】 | この作業者が、リポジトリの現物（コード・文書）を読んで確かめた |
| 【受】 | 人・他のエージェントから受け取った前提。自分で検証していない |

---

## 文脈

[ADR 0324](./0324-claim-key-contested-detection.md) の real-fixture 実測（負債6）は、
無関係な話題間の fact/distractor 30組中9組（30%）が誤って `contested` になり、**その
9組すべてが claim key の `subject` 誤帰属**（三人称の発話——「姉は福岡で働いています」
「同僚はGoを推しています」「妻は卵アレルギーがあります」——の `subject` が `"user"` に
誤って割り当てられる）で説明できると記録した。ADR 0324 はこれを塞がない
（「claim key 派生プロンプトの変更であり、検出の変更ではない」）と明記し、
**「Issue #371（またはその後継）に、この実測結果を持ち帰ることを推奨する」**として
残していた。

predicate 側の同型の弱さ（claim key の predicate が呼び出しをまたぐと安定しない）は
[ADR 0326](./0326-answer-path-claim-key-contested-opt-in-measurement.md)/
[ADR 0329](./0329-claim-key-known-predicates-from-store.md) が
「store の既存 predicate 一覧を `knownPredicates` 語彙ヒントとして動的に渡す」で改善し、
実 API で効果（predicate 一致 0/4→4/4）を確認して `knownPredicatesFromStore` として
出荷済みである。**ただし ADR 0329「負債1」とその追記（2026-09-25）は、この語彙ヒント
自体が「無関係な filler 発話の predicate を誤って統合し、誤検出を増やす」副作用を持ち、
4種の文言変更を試したが解消できなかった（否定的結果）ことも記録している。**

**この ADR が答えるのは、ADR 0324 負債6が持ち帰りを推奨した「subject 側」の対応で
ある。**ADR 0329「負債1」の教訓（語彙ヒントが無関係な発話へ流用される副作用）を
意識しながら、predicate と同型の `knownSubjects` 語彙ヒントを実装し、実 API で効果と
副作用の両方を測った。

⛔ **正規化の強化・類義の統合**（[ADR 0320](./0320-claim-key-field-implementation.md)
案B相当）と**埋め込み類似度による統合**（[ADR 0134](./0134-mark-contested-explicit-operation.md)
案A(b)相当、[ADR 0185](./0185-contradiction-detection-path.md) (D) 相当）は、いずれも
既に別の ADR で却下済みであり、本 PR でも実装しない。「候補から選ばせる語彙ヒント」の
形に留める。

---

## 決定

### 決定1: 揺れの型を分類する——subject 誤帰属は「無関係発話への流用」の**上位互換**の汚染を起こしうる

【現物】`packages/core/src/claim-key.ts` の `deriveClaimKeys` は `contents`（発話群の
`content` 文字列）だけを受け取り、`extraction.ts` が候補ごとに持つ `subjectId`
（Issue #608 項目①・②(b)）を一切参照しない。本番の呼び出し元
（`runtime.ts` の `runExtraction`）は `subjectCandidates`（Issue #608 項目②(b)）を
抽出（`extractCandidates`）にだけ渡し、claim key 派生には渡していなかった——これが
ADR 0324 負債6の構造的な原因である。

分類:

- **型A（構造的、コード読解だけで判定できる）**: 1回の `deriveClaimKeys` 呼び出しは、
  本番では通常「1件の Observation から抽出された候補群」だけを含む——ADR 0324 の
  real-fixture 実測でも、6話題を横断した比較材料は与えられていない（1話題ずつ別の
  `observe()` 呼び出し）。⟹ **モデルは「他の発話と比べて、これは誰の話か」を判断する
  材料を構造的に持たない。**
- **型B（実測でしか分からない、方向性）**: 【実測】(下記2節) 誤帰属は一方向にしか
  起きない——三人称の発話（distractor）が `"user"` に誤って割り当てられることは
  何度も観測したが、逆（一人称の発話が `"user"` 以外になる）は語彙ヒント無しでは
  一度も観測しなかった。ADR 0324 の記述と整合する。
- **型C（本 ADR で新たに実測発見）**: **語彙ヒントに「候補が1つでも入る」と、型Bとは
  別の、より深刻な誤帰属が起きうる。** LLM が語彙ヒントの中の**曖昧な代表値**
  （例: 日本語の「妹」を英語の汎用語 `"sibling"` に翻訳した値）を、**話題の異なる
  無関係な第三者の発話にまで indiscriminately 使い回す**——「妹の話」で得た
  `"sibling"` が、後続の「同僚の話」「父の話」「妻の話」すべてに再利用され、
  異なる実在の人物の claim key `subject` が同一の値に収束した（下記2節（3）参照）。
  **これは ADR 0329「負債1」（predicate の語彙が無関係な filler へ再利用される）と
  同型の機構だが、影響がより深刻である**——predicate の誤結合は「本来別の主張のはず
  だった2つの記憶が同じ属性の話として隣接提示される」に留まるが、subject の誤結合は
  **別々の実在の人物の主張が同一人物のものとして扱われる**——`docs/north-star.md`
  問い4（AI の推論とユーザーが言った事実を区別する）の精神により深く抵触する。

⟹ **型A・型Bは「渡さなければ何も変わらない」ため対応の必要が薄い一方（既定 off の
プロンプトはそもそも1バイトも変えない）、型Cは「対応（語彙ヒントを足す）」自体が
新たなリスクを持ち込む**——だから決定2・決定3で両方を実測してから採否を決める。

### 決定2: `knownSubjects` 語彙ヒント自体の効き目を「上限値（ceiling）」実測で確かめる——正解の語彙を渡せば直る

【実測】2026-09-26、`gpt-4o-mini`。ADR 0324 と同じ6話題（`color`/`pet`/`exercise`/
`diet`/`family`/`language`）の fact/distractor を、`examples/chat/cassettes/
retrieval.json` に記録済みの実際の抽出結果からそのままコピーし（1文字も生成して
いない）、**ADR 0324 と同じ「1発話=1バッチ」**（本番の `runExtraction` が1回の
`observe()` につき1回 `deriveClaimKeys` を呼ぶ構造を再現——最初の予備実験では誤って
6話題ぶんを1回のバッチにまとめてしまい、モデルが他の話題を比較材料に使えてしまう
ことで baseline が 0/6 になった。バッチサイズの効果を測ってしまっていたと気付き、
やり直した）で、`deriveClaimKeys`（`packages/core/dist` を直接 import、実 API を
n=3 回）を呼んだ。使い捨てスクリプト（ADR 0315 以来の慣行どおりリポジトリには
コミットしていない）。

**条件 OFF**（現行の既定、`knownSubjects` を渡さない）:

| run | 誤検出（同じ話題の fact/distractor が同じ claim key に落ちた数） /6 |
|---|---|
| off-1 | 1/6（family: 弟/姉ともに `subject: "user"`） |
| off-2 | 1/6（language: 同僚/user ともに `subject: "user"`） |
| off-3 | 2/6（diet: 妻/user ともに `"user"`、language も同様） |

ADR 0324 の30%（9/30）と同じ桁数の誤帰属を、独立した実測・独立した話題部分集合
（6話題×1発話/バッチ×n=3=18組中4組=22%）で再現した——**「出た」ことの確認であり、
陽性対照として機能した**（`AGENTS.md`「先に陽性対照を示す」）。

**条件 ON-ceiling**（呼び出し側が正解の第三者ラベルを静的に渡す、`knownSubjects:
["user","妹","同僚","父","妻","姉"]` を6話題すべての呼び出しに固定で渡す）:

| run | 誤検出 /6 |
|---|---|
| ceiling-1 | 0/6 |
| ceiling-2 | 0/6 |
| ceiling-3 | 0/6 |

**3/3回とも誤帰属が完全に消えた。** fact は6話題すべてで一貫して `user`（または
`弟`/`brother` 等、家族トピックでは fact 自身も三人称だが distractor と異なる値）、
distractor は6話題すべてで渡した正解ラベル（`妹`/`同僚`/`父`/`妻`/`姉`）にそのまま
一致した。⟹ **「候補から選ばせる語彙ヒント」という仕組み自体は有効である**——
問題は「どうやって正確な候補を渡すか」に絞られる。

### 決定3: store 自己蓄積版（`knownPredicatesFromStore` の対）は実測で汚染を確認し、採らない

決定2の ON-ceiling は「呼び出し側が最初から正解を知っている」という理想条件である。
predicate 側の先例（ADR 0329）に倣い、「store が過去に確定させた claim key subject を
自動的に語彙ヒントへ足す」（`knownSubjectsFromStore`、`MemoryStore.
listActiveClaimSubjects?`）を実装し、**同じ手法で実測した**。

【実測】2026-09-26、同じ6話題・同じ「1発話=1バッチ」方式、n=3。各話題を順に処理し、
「まず distractor を1回コールドで観測 → その返り値を店に書き込んだことにして、以後
**全話題の**呼び出し（fact も他話題の distractor も）へ累積語彙として渡す」
——`resolveKnownPredicates`/`listActiveClaimPredicates?` が実際に行う「tenant・
`subjectId` 単位で全 predicate 横断に集める」動きを、subject 版でそのまま模した
（predicate を跨がない絞り込みは元の実装にも無いため、これは実装の欠陥ではなく
設計をそのまま反映した再現である）。

| run | 誤検出（初回 distractor 基準）/6 | 誤検出（2回目の同じ distractor 基準）/6 |
|---|---|---|
| warm-1 | 1/6 | 2/6 |
| warm-2 | 1/6 | 1/6 |
| warm-3 | 1/6 | 1/6 |

**改善しなかった——それどころか、条件 OFF（1/6, 1/6, 2/6）と同程度か、わずかに悪化
する回もあった。** 詳細を見ると、原因は型C（決定1）そのものだった:

- `color` 話題の distractor（「妹の好きな色は緑」）をコールドで処理した際、
  モデルは `subject: "sibling"`（英語の汎用語）を返した。
- この `"sibling"` が「店の累積語彙」として以後**全話題**の呼び出しへ渡り、
  `pet`（同僚）・`exercise`（父）・`diet`（妻）の distractor まで `"sibling"` に
  収束した回があった（3回中2回、`warm-1`/`warm-3` のログに逐語で残る）。
- `family` 話題では fact（弟）・distractor（姉）が両方とも `"sibling"`/`"sister"` に
  収束し、3/3回とも誤検出になった——**OFF 条件では family が誤検出になったのは
  1/3回だけであり、店由来の語彙ヒントが「その話題の識別性を上げる」どころか
  「別トピックの語彙を持ち込んで悪化させた」。**

**文言を変えても直らないことも確認した**: `buildKnownSubjectInstruction` から
「三人称なら `user` でなくその人物を使え」という追加文（本 ADR 決定4で最終的に
採用した文言の一部）を外した、predicate 側 `buildKnownPredicateInstruction` の
逐語コピーに近い v1 文言でも、同じ汚染が同じ頻度（3/3回とも2/6、`warm` 条件と
同等かやや悪い）で再現した。⟹ **原因は追加した一文ではなく、「一覧にあれば必ず
そのまま使え」という指示そのもの**——ADR 0329「負債1」の追記が predicate 側で
確認した「文言だけでは塞げない」という否定的結果と、原因の構造が一致する。

**判定**: `knownSubjectsFromStore`/`MemoryStore.listActiveClaimSubjects?` は
**実装したが、この PR には含めない**（採らなかった案、下記参照）。predicate 側の
語彙誤用（ADR 0329「負債1」、同じ属性についての別の主張が隣接提示されるだけ）より
**深刻**（別人の主張を同一人物のものとして扱う）であり、店が自己蓄積した曖昧値を
無条件に横流しする設計のままでは出荷できないと判断した。

### 決定4: 採用する形——`ClaimKeyOptions.knownSubjects`（呼び出し側が明示的に渡したときだけ効く）

決定2・決定3を踏まえ、**呼び出し側が渡す静的な候補一覧**だけを対象にする:

- `packages/core/src/claim-key.ts`: `buildClaimKeyPrompt`/`deriveClaimKeys` に
  `knownSubjects?: readonly string[]` を追加の**末尾引数**として足した（`knownPredicates`
  と同型、`buildKnownSubjectInstruction`）。**`knownPredicates`/`knownSubjects` を
  両方省略すれば `CLAIM_KEY_PROMPT_SYSTEM` は1バイトも変わらない**
  （`__tests__/claim-key.test.ts` に逐語の一致テストを追加）。
- `ClaimKeyOptions.knownSubjects?: string[]`（`knownPredicates` と同型）を足した。
- `runtime.ts` の `runExtraction`: `resolveKnownSubjects(claimKeyOptions)` は
  **`claimKeyOptions.knownSubjects` だけを見る**。`subjectCandidates`（Issue #608
  項目②(b)、`runtime.observe` に同じ呼び出しで渡された抽出用の主題候補一覧）が
  渡されていても、`knownSubjects` を省略すればヒントには一切使わない。

⚠ **当初案は `knownSubjects` 省略時に `subjectCandidates` を既定値として自動転用する
設計だった（レビューで指摘を受け、この案は採らないことにした）。** 採らない理由:
`claimKey.enabled: true` と `subjectCandidates` を**既に**併用している呼び出し側
（Issue #608 項目②(b) の既存利用者）が、`knownSubjects` という**この ADR で新しく
足す opt-in を一切選んでいない**のに、claim key 派生の system プロンプト・
カセット鍵（`llmCassetteKey`）が動いてしまう——「既定 off のプロンプトは1バイトも
変えない」（決定5、`buildClaimKeyPrompt` の doc コメント）という、この ADR 自身が
掲げた制約に反する。**`subjectCandidates` と同じ語彙を claim key のヒントにも
使いたい呼び出し側は、同じ配列を明示的に `claimKeyOptions.knownSubjects` へ渡す**
——1行の追加で済み、かつ「この opt-in を選んだ」ことがコードから読み取れる
（`__tests__/runtime.test.ts` の regression テスト「`subjectCandidates` あり・
`knownSubjects` 省略」でプロンプトが完全に不変であることを固定した）。

**決定2の ON-ceiling 実測（正解ラベルを `knownSubjects` に静的に渡す）は、この設計の
効き目をそのまま裏付ける**——`subjectCandidates` を経由するかどうかに関わらず、
`knownSubjects` に正確な語彙が渡ってさえいれば機構は同一である。

### 決定5: 既定・公開 API は変えない

`ClaimKeyOptions.enabled`/`knownPredicates`/`detectContested`/`knownPredicatesFromStore`
は1バイトも変えていない。`knownSubjects` は既定 `undefined`（省略）——**渡さなければ、
`subjectCandidates` の有無・中身に関わらず** `deriveClaimKeys` の system プロンプトは
決定4以前と1バイトも変わらない（決定4の「採らなかった当初案」を参照）。公開 API の
変更は次の2箇所だけで、いずれも**末尾への追加**（`node scripts/
check-public-api-surface.mjs` の diff で確認、追加行のみ）:

- `buildClaimKeyPrompt`/`deriveClaimKeys` に任意の末尾引数 `knownSubjects` を追加。
- `ClaimKeyOptions`/`ClaimKeyOptionsSchema` に任意フィールド `knownSubjects` を追加。

`MemoryStore` インターフェースへの変更は**無い**（`listActiveClaimSubjects?` は
実装した後、決定3の判断で取り除いた——`packages/testkit`/`packages/core/src/
__tests__/runtime-fakes.ts` も同様）。

---

## 測ったこと（まとめ）

| 条件 | 誤検出 /6（run1, run2, run3） | 備考 |
|---|---|---|
| OFF（既定） | 1, 1, 2 | ADR 0324 の30%と同じ桁数を独立実測で再現（陽性対照） |
| ON-ceiling（正解ラベルを静的に渡す） | 0, 0, 0 | 決定4で採用した設計の実効性を直接裏付ける |
| ON-warm（store 自己蓄積、v2文言） | 1, 1, 1（初回）/ 2, 1, 1（2回目） | 改善なし、家族トピックは3/3回とも悪化 |
| ON-warm（store 自己蓄積、v1文言＝predicate 側の逐語コピー） | — | 2, 2, 2（2回目基準）、文言を変えても同じ汚染 |

呼び出し回数・費用（`gpt-4o-mini`、`examples/chat/src/usage-meter.ts` と同じ単価）:

| 実験 | chat 呼び出し | 費用（概算） |
|---|---|---|
| 決定2（OFF/ceiling、1バッチ全話題版、予備実験） | 12 | $0.002148 |
| 決定2〜3（OFF/ceiling/warm、1発話=1バッチ版） | 126 | $0.009851 |
| 決定3 v1文言の再現チェック | 54 | $0.004017 |
| **合計** | **192** | **$0.016016**（費用上限 $0.50 の約3.2%） |

見積もり（実行前）: ADR 0329 の実測単価（$0.0000669/呼び出し前後）を基準に、
200回未満で $0.02 未満と見積もり、上限 $0.50 を大きく下回ると判断してから実行した
——実測は見積もりとほぼ一致した。

**単体テスト**（`MNEMORA_LLM=deterministic` 明示、ファイル名を指定して実行）:

- `packages/core exec vitest run src/__tests__/claim-key.test.ts` →
  既存17件 + 新規6件（off 時の逐語一致・`knownSubjects` の文言追加・空配列規約・
  predicate/subject 併用時の順序）で計23件、全通過。
- `packages/core exec vitest run src/__tests__/runtime.test.ts` → 既存の claim key
  関連テストに加え、`knownSubjects`（明示のときだけ効く・`subjectCandidates` の
  有無で system が動かない regression を含む）の5件を新規追加、計124件、全通過
  （既存回帰なし）。
- `packages/core exec vitest run src/__tests__/schema-type-equals-parity.test.ts` →
  4件、全通過（`ClaimKeyOptions`/`ClaimKeyOptionsSchema` の型一致）。
- `packages/core exec vitest run src/__tests__/extraction.test.ts
  src/__tests__/observation.test.ts` → 75件、全通過（`subjectCandidates` 周りの
  既存契約に影響していないことの確認）。
- typecheck（`@mnemora/core`/`@mnemora/testkit`/`example-chat`）・eslint
  （変更したファイルのみ）→ すべてクリーン。
- 公開 API snapshot（`node scripts/check-public-api-surface.mjs --write`）→
  `core.d.ts` のみ更新、diff は追加のみ（`testkit.d.ts`/`openai.d.ts`/
  `postgres.d.ts`/`anthropic.d.ts`/`local-embedding.d.ts` は無変更）。
- 既存カセット30本の sha256 を作業前後で突き合わせ、完全一致を確認
  （実 API 測定はすべて `packages/core/dist`/`packages/openai/dist` を直接 import
  する使い捨てスクリプトで行い、リポジトリのカセット・テストは一切経由していない）。

---

## 採らなかった案

### 案A: `knownSubjectsFromStore`（`MemoryStore.listActiveClaimSubjects?`、predicate 側の完全な対）

決定3で実測した。**一度実装し、テスト・型検査まで通した上で、実測結果を理由に
取り除いた**（実装は本 PR の履歴に残らない——`git commit` していない作業ツリー上の
変更を revert したため）。店が自己蓄積した曖昧な `subject` 値（LLM の自由記述）を
汎用語彙ヒントとして横流しすると、無関係な話題の主張へ誤って使い回される汚染を
実測で確認した。**predicate 側の同型の負債（ADR 0329「負債1」）より深刻**
（別人の主張を同一人物のものとして扱いうる）と判断し、文言の変更でも解消しなかった
（v1/v2 両方で汚染を確認）ことから、この PR には含めなかった。

### 案B: `deriveClaimKeys` に extraction 候補の `subjectId` を直接渡す（候補③、per-item ヒント）

`extraction.ts` の `ExtractedMemoryCandidate.subjectId`（Issue #608 項目①、
`subjectCandidates` を渡したときだけ LLM が埋める）を、claim key 派生のヒントに
使えないか検討した。**採らない理由**: (a) `deriveClaimKeys` は候補群をまとめて
1回のバッチで呼ぶ設計（ADR 0315 決定2「候補が0件なら+0回にできる」・呼び出し回数を
抑える設計）であり、候補ごとに異なるヒントを与える口が無い——1バッチ全体で1つの
system プロンプトを共有するため、「この候補だけ `subjectId: '妻'` というヒントを
使う」という per-item の伝達手段が無い。(b) `subjectCandidates` を渡さない呼び出し
では `ExtractedMemoryCandidate.subjectId` はそもそも埋まらない（Issue #608 の既定
挙動）ため、ADR 0324 の real-fixture 実測のような「`subjectCandidates` を渡さない」
シナリオでは何も渡すものが無い。⟹ 呼び出し側が明示的に `knownSubjects` を渡す
（決定4）ほうが単純であり、per-item の伝達手段が無いという制約にもぶつからない。

### 案C: 正規化の強化・類義統合（ADR 0320 案B相当）

⛔ 既に却下済み。文脈節参照。

### 案D: 埋め込み類似度による subject 統合（ADR 0134 案A(b)、ADR 0185 (D) 相当）

⛔ 既に却下済み。文脈節参照。

### 案E: `knownSubjects` 省略時に `subjectCandidates` を既定値として自動転用する（当初案）

決定4に書いたとおり、当初はこの案を採用していた——`subjectCandidates`（呼び出し側が
その場で選ぶ静的な一覧、店の履歴を自己蓄積したものではない）は決定3で確認した汚染の
経路（店の自己蓄積）に当たらないため、渡して問題無いと判断していた。**レビューで
指摘を受け、この判断を覆した**。

**採らない理由**: 「汚染が起きない」ことと「既定 off のプロンプトを変えない」こと
は別の要求である。`subjectCandidates` は claim key とは独立した既存の口（Issue #608
項目②(b)、ADR 0287）であり、**`claimKey.enabled: true` と `subjectCandidates` を
既に併用している呼び出し側が実在しうる**（この ADR より前から両方渡している設計は
何もおかしくない——`subjectCandidates` は抽出の `subjectId` 判定のために渡すもので
あり、claim key のためではない）。その呼び出し側にとって、この ADR が足す
`knownSubjects` という新しい opt-in は「存在すら知らない・選んでいない」機能である。
にもかかわらず `subjectCandidates` を暗黙に読み替えると、**opt-in していないのに
claim key 派生の system プロンプト・カセット鍵が動く**——「既定 off のプロンプトは
1バイトも変えない」という、この ADR 自身の決定5・`buildClaimKeyPrompt` の doc
コメントが掲げる制約に反する。`ClaimKeyOptions.knownPredicatesFromStore`（ADR 0329）
も同様に「明示的に `true`/`{ limit }` を渡したときだけ効く」設計であり、既存の別の
口（`subjectCandidates`）の値を読んで挙動を変える例は無い——本 ADR もその先例に揃える。

---

## 引き受けた負債

### 負債1: `knownSubjects` を明示的に渡さない呼び出しでは、この ADR は subject 誤帰属を一切改善しない

決定4の設計は `claimKeyOptions.knownSubjects` を**呼び出し側が明示的に**渡して
初めて効く（`subjectCandidates` を渡していても、それだけでは効かない——決定4「採らな
かった当初案」参照）。**ADR 0324 の real-fixture 実測自体（`knownSubjects` を渡さない
`observe()` 呼び出し）は、この ADR の変更だけでは1件も直らない**——決定2の ON-ceiling
実測は「呼び出し側が正解を `knownSubjects` に渡せば効く」ことを示しただけであり、
「呼び出し側が正解を知らない・渡していない」cold start な状況（mnemora が subject の
台帳を持たないという設計上の前提、`docs/architecture.md` §3.7）には効かない。この
負債は ADR 0324 負債6が指摘した問題の一部だけに答えている——**しかもこの ADR は
「`subjectCandidates` があれば自動で使う」という、より広く効く当初案をレビューで
明示的に退けている**ため、この負債の射程は当初案より狭い（意図した狭さである、
決定4参照）。

### 負債2: `answer` 経路（`examples/chat`）での /14・/4 の実測は行っていない

[ADR 0326](./0326-answer-path-claim-key-contested-opt-in-measurement.md)/
[ADR 0329](./0329-claim-key-known-predicates-from-store.md) が使った
`examples/chat/src/scripts/record-answer-claim-key.ts`（dev6+eval8=14ケース、
訂正4件の predicate 一致 /4・`contested` 成立 /4・誤検出 /14）による実測は
**行っていない**。理由: (a) 本物の Postgres を要し、(b) この harness
（`answer-bench.ts`/`answer-case-set.*.ts`）は現時点で `subjectCandidates` を
ケースへ渡す口を持たず、決定4の設計を実地で通すには harness 自体の変更が要る
——本 PR の主張（claim key 派生レベルでの `knownSubjects` の効き目）とは別の
作業になる。`other-person-birthday`（「わたしの誕生日は4月3日です。妻の誕生日は
9月10日です。」）のように、この ADR の対象にぴったり当てはまるケースが既存の
ケースセットに実在することは確認した（`examples/chat/src/answer-case-set.dev.ts`）
——次にこの ADR の効果を測るときの自然な入口として記録しておく。

### 負債3: 呼び出し側が `subjectCandidates` と同じ配列を `knownSubjects` にも渡した場合、抽出そのものの `subjectId` 判定に副作用を持たないかは実測していない

決定4は `knownSubjects` を claim key 派生へ**追加で**渡すだけであり、
`extraction.ts`/`buildExtractionPrompt` の呼び出しには一切触れていない
（プロンプト・カセット鍵は不変、`__tests__/extraction.test.ts` の既存回帰テストで
確認済み）。**この ADR は `subjectCandidates` を自動では転用しない**（決定4）ため、
既定では抽出と claim key 派生が別々に判定するだけで、この負債は「呼び出し側が
意図的に同じ配列を両方へ渡した」場合に限って生じる。ただし「同じ語彙一覧を2つの
独立した LLM 呼び出し（抽出・claim key 派生）へ渡したときに、両者が独立に矛盾した
判定をしないか」（例: 抽出は `subjectId: null` を返すが、claim key 派生は
`subject: '妻'` を返す、といった不整合）は実測していない。

### 負債4: `knownSubjects` に多数の候補が入っている場合の挙動は測っていない

決定2の ON-ceiling 実測は6件のラベルで行った。ADR 0329 決定5が predicate 側の
`DEFAULT_KNOWN_PREDICATES_FROM_STORE_LIMIT` を「実験規模5〜8件の2倍強」として20に
置いたのと同種の判断——本 ADR は subject 側の上限を一切設けていない（決定3で
`knownSubjectsFromStore` 自体を採らなかったため、上限を要する動的な蓄積が無い）。
`knownSubjects`（呼び出し側が明示的に渡す一覧、`subjectCandidates` 由来かどうかに
関わらず）が数十件に膨らむ呼び出し側の使い方は想定していない・測っていない。

## 確かめていないこと

- ⛔ **`answer` 経路での /14・/4 の効果**（負債2）。
- ⛔ **claim key 派生と抽出の `subjectId` 判定の整合性**（負債3）。
- ⛔ **多数の `subjectCandidates` を渡した場合の挙動**（負債4）。
- ⛔ **`knownSubjectsFromStore`（案A）の汚染が、文言以外の設計変更（例: 話題ごとに
  スコープを絞る、値を正規化してから語彙に足す）で解消できるか**——本 ADR は文言の
  変更だけを試し、設計そのものの変更は試していない。
- ⛔ **7話題という小さい範囲を超えた場合の、OFF条件の30%という頻度の一般化可能性**
  ——ADR 0324 が既に明記している限定であり、本 ADR もそれを引き継ぐ。

## これが覆るとしたら

- **`answer` harness がケースへ `knownSubjects`（または `subjectCandidates`）を
  渡せるようになったとき**（負債2）——`record-answer-claim-key.ts` 相当の実測で
  この ADR の効果を検証できる。
- **`knownSubjectsFromStore`（案A）の汚染を解消する設計変更が見つかったとき**
  ——決定3の判断を覆し、store 自己蓄積版を再検討できる。
- **mnemora が subject の台帳を持つ設計に変わったとき**（`docs/architecture.md`
  §3.7 の前提が変わったとき）——`subjectCandidates` に頼らない、より確実な
  subject 決定手段が使えるようになる可能性がある。

## 関連

- [ADR 0324](./0324-claim-key-contested-detection.md) 負債6（この ADR の出発点）
- [ADR 0326](./0326-answer-path-claim-key-contested-opt-in-measurement.md)
- [ADR 0329](./0329-claim-key-known-predicates-from-store.md) とその追記
  （語彙ヒントの流用という同型の副作用を predicate 側で先に発見した記録）
- [ADR 0287](./0287-extraction-subject-candidates-caller-supplied.md)（`subjectCandidates`
  の導入、Issue #608 項目②(b)）
