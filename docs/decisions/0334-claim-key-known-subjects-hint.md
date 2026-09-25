# ADR 0334: claim key の `subject` 誤帰属を、明示的な `knownSubjects` 語彙ヒントで減らす — store 自己蓄積版・`subjectCandidates` への暗黙の転用は、いずれも実測・設計検討の末に採らない（Issue #372負債6）

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

---

## 追記 2026-09-26: 負債2（`answer` 経路での /14・/4 実測）への回答（本文は書き換えていない）

> **クローン（miku）の委譲で動くセッションが書いた。オーナー本人ではない**
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)
> ——投稿者名は担い手とオーナーを区別しない）。**この追記に出てくる判断はすべて
> 「委譲された担い手（クローン miku）の判断（オーナーではない）」である。**
> `packages/core` の既定・`examples/chat` の既定はどちらも1バイトも変えていない
> （下記「足したもの」参照）。**この opt-in を既定にするかどうかの判断はここでは
> 行わない**——その判断はオーナー領分として残す。

### 足したもの

負債2が指摘した「`answer` harness がケースへ `subjectCandidates`（相当）を渡す口を
持たない」を埋めた。**既定を1バイトも変えない形**で:

- `examples/chat/src/answer-case.ts`: `AnswerCase.knownSubjects?: string[]`
  （任意項目）。省略すれば従来どおり。
- `examples/chat/src/answer-claim-key-options.ts`: `applyCaseKnownSubjects(claimKeyOptions,
  condition, caseKnownSubjects)`——`condition === "known-subjects"` かつケースが
  `knownSubjects` を持つときだけ合流する純関数。
- `examples/chat/src/scripts/record-answer-claim-key.ts`: `MNEMORA_RECORD_CONDITION`
  に第3の値 `"known-subjects"` を追加（ADR 0329 が足した
  `"known-predicates-from-store"` と同型）。省略・`"baseline"` は従来どおり。
- `answer-case-set.dev.ts`/`.eval.ts`: 会話に本人以外の第三者が出てくる4件
  （14件中）にだけ `knownSubjects` を埋めた。

| ケース | 集合 | 第三者 | `knownSubjects` | 選定理由 |
|---|---|---|---|---|
| `other-person-birthday` | dev | 妻 | `["user", "妻"]` | 会話本文の呼び方そのまま |
| `other-person-favorite-food` | eval | 息子 | `["user", "息子"]` | 同上 |
| `eval-misattribution-order-swapped` | eval | 同僚の佐藤さん | `["user", "佐藤さん"]` | 会話中の呼び方（「佐藤さん」）に揃えた。関係名詞「同僚」ではなく固有の呼称を選んだ——他5件の候補と違い、この会話には名前が明示されているため |
| `eval-inferred-habit-not-attributed-to-user` | eval | 友人の鈴木さん | `["user", "鈴木さん"]` | 同上（「鈴木さん」） |

残り10件（`pref-*`/`schedule-change-*`/`negation-*`/`other-period-*`/`unknown-*`）は
本人以外の第三者が会話に登場しないため、`knownSubjects` を持たない
（`answer-case.test.ts` の歯で固定——14件中4件だけが持つことを検査する）。

⚠ **これは上限（オラクル）測定である**——正解の第三者名を作業者が手で選んで渡した。
`answer-claim-key-options.ts` 冒頭の docstring が `knownPredicates` について述べている
懸念（「作業者が手で語彙を選ぶと、その語彙選択自体が正解を暗に漏らしうる」）が、
この4件の選定にもそのまま当てはまる。実運用で mnemora がこの正解を知っている保証は
無い（負債1・負債2がすでに明記している限定）。

**決定論のユニットテスト**（`MNEMORA_LLM=deterministic` 明示、ファイル名指定で実行）:

```
MNEMORA_LLM=deterministic pnpm --filter example-chat exec vitest run \
  src/__tests__/answer-claim-key-options.test.ts src/__tests__/answer-case.test.ts
```

37件全通過（既存30件 + `applyCaseKnownSubjects` 新規5件 + `knownSubjects` の
ケース一覧固定3件）。typecheck（`pnpm --filter example-chat run typecheck`）・
eslint（変更したファイルのみ）・prettier（`--check`）もすべてクリーン。

### 実測: `MNEMORA_RECORD_CONDITION=baseline`（off、"detect"、語彙ヒント無し）と `known-subjects`（on）を3回ずつ、1回ごとに対で実行

【実測】2026-09-26、`gpt-4o-mini`。dev6+eval8=14ケース全件、`initdb`（PostgreSQL 17、
pgvector・btree_gin・pgcrypto、専用ポート・作業ツリー外）で立てた専用インスタンス。
種カセットは常に `answer.order-legend.json`（ADR 0326/0329 と同じ）。
新カセット6本（`examples/chat/cassettes/answer.claim-key.known-subjects-{off,on}-{1,2,3}.json`）
へ記録し、既存カセット（`retrieval.json`/`compare.json`/`answer.order-legend.json`/
`answer-time-weighting.order-legend.json`・#748/ADR 0326/0329 の
`answer.claim-key*.json`）は1バイトも触っていない（`git status --porcelain` で
新規ファイルのみであることを確認）。

**基準は "detect"**（`knownPredicates`/`knownPredicatesFromStore`/`knownSubjects` の
いずれも渡さない、ADR 0326 決定1の "detect"）。off/on は同じ順で対にして実行した
（off-1, on-1, off-2, on-2, off-3, on-3）。

| run | 条件 | predicate一致/4 | contested/4 | 誤検出/14 | 誤検出したケース | 第三者subject誤帰属/4 |
|---|---|---|---|---|---|---|
| off-1 | baseline | 0/4 | 0/4 | 1/14 | other-period-city-this-year | 0/4 |
| on-1 | known-subjects | 1/4（negation-moved-job） | 1/4（同左） | 0/14 | （無し） | 0/4 |
| off-2 | baseline | 1/4（schedule-change-meeting-day） | 1/4（同左） | 1/14 | other-period-city-this-year | 0/4 |
| on-2 | known-subjects | 0/4 | 0/4 | 1/14 | other-period-city-this-year | 0/4 |
| off-3 | baseline | 0/4 | 0/4 | 1/14 | other-period-city-this-year | 0/4 |
| on-3 | known-subjects | 0/4 | 0/4 | 0/14 | （無し） | 0/4 |

**中心となる観測: 第三者 subject の誤帰属は、off・on どちらの3回でも一度も
起きなかった（4件×3回=12機会中0件、両条件とも）。** `other-person-birthday` の
「妻」→`user's_wife`/`妻`（off/on とも正しい第三者の subject）、
`other-person-favorite-food` の「息子」→`son`/`息子`、
`eval-misattribution-order-swapped` の「佐藤さん」→`sato`/`佐藤さん`、
`eval-inferred-habit-not-attributed-to-user` の「鈴木さん」→`friend_suzuki`/`鈴木さん`
——6回すべてで、baseline（語彙ヒント無し）の時点ですでに `"user"` へ落ちなかった。
⟹ **この14ケース・この3回という範囲では、`knownSubjects` が「直す」べき誤帰属が
そもそも観測されなかった**（decision4 が効くかどうかを判定できる対照が無い）。

**なぜ ADR 0324/決定2 の実測と食い違うか（差の構造、確かめた範囲での説明）**:
ADR 0324 の real-fixture 実測・本 ADR 決定2 の ON-ceiling 実測は、いずれも
「本人の事実」と「第三者の distractor」を**別々の `observe()` 呼び出し**（別バッチ）
として与えていた——`deriveClaimKeys` が比較材料を持たない、という決定1「型A」が
成り立つ設定だった。**この4ケースの会話は、本人の事実と第三者の事実が同じ1ターン
（例: 「わたしの誕生日は4月3日です。妻の誕生日は9月10日です。」）に同居しており、
`ingestConversation` は1ターン=1回の `observe()` として送る**（`mnemora-path.ts`）
——`extractCandidates` が同じ観測から両方の候補を抽出し、`deriveClaimKeys` は
**同じバッチ**でこの2候補を受け取る（`onObserved` の診断ログで実際に
`contestedDetection` 配列が同じ turn で2要素になっていることを確認した）。
⟹ **型Aの前提（1回の `deriveClaimKeys` 呼び出しは比較材料を持たない）が、この4ケースでは
成り立っていない**——本人と第三者の発話が同じバッチに同居するため、語彙ヒント無しでも
モデルは両者を対比できた。**これは推測ではなく、決定1の型Aの記述とこの実測結果が
構造的に整合することの確認である**が、①他のケース構成（本人と第三者が別ターン）でも
同じ結果になるか、②サンプル数を増やしても0/12のままか、は確かめていない
（下記「確かめていないこと」参照）。

**predicate一致/4・contested/4・誤検出/14 は、off/on の間で明確な差が見えなかった**
（off: 0,1,0 / on: 1,0,0。誤検出 off: 1,1,1 / on: 0,1,0）——ADR 0326/0329 が
記録した揺れの構造（(c) predicate がターンをまたぐと不安定、(d)
`other-period-city-this-year` が `validFrom`/`validUntil` 無しで構造的に誤検出になる）
がそのまま観測され、`knownSubjects` はこのどちらにも作用しない（`knownSubjects` は
`subject` だけを対象にする語彙ヒントであり、(c)(d) は `predicate`/有効期間の問題で
`subject` とは無関係——決定1の分類どおり）。**n=3という小さい回数のため、この
「差が見えない」を「差が無い」の証明として読まないこと**（下記参照）。

**呼び出し回数・費用**（`gpt-4o-mini`、`examples/chat/src/usage-meter.ts` と同じ単価）:

| run | chat 呼び出し | 費用（概算） |
|---|---|---|
| off-1 | 26 | $0.001522 |
| on-1 | 35 | $0.002249 |
| off-2 | 26 | $0.001518 |
| on-2 | 35 | $0.002245 |
| off-3 | 26 | $0.001519 |
| on-3 | 35 | $0.002242 |
| **合計** | **chat 183 / embedding 0** | **$0.011295**（費用上限 $0.30 の約3.8%） |

見積もり（実行前）: ADR 0329 の実測単価（baseline $0.0015/run、新案 $0.0028/run）を
基準に、6回で $0.02 未満と見積もり、上限 $0.30 を大きく下回ると判断してから実行した
——実測はほぼ一致した（$0.0113）。1回実行するたびに費用を確認し、上限に近づく兆候は
無かった。

### 確かめていないこと（この追記が新たに残す分）

- ⛔ **`knownSubjects` が実際に誤帰属を減らす効果**——本人と第三者が**別ターン**
  （型Aが成り立つ構成）の `answer` ケースが現在の14ケースに存在しないため、
  この追記の実測範囲では確認も反証もできていない。決定2の ON-ceiling 実測
  （`packages/core` を直接 import した使い捨てスクリプト、1発話=1バッチを
  意図的に強制した設定）でのみ効果を確認済み——`answer` harness を経由した確認は
  まだ無い。
- ⛔ **n=3という回数で「差が無い」と言えるか**——off/on とも12機会中0件の誤帰属
  だったのは、効果が無いからか、この14ケースの構成（本人と第三者が同バッチ）では
  そもそも誤帰属が起きにくいからかを、この実測だけでは切り分けられない。
- ⛔ **本人と第三者を別ターンに分けたケースを新設した場合の効果**——上記の差の
  構造説明が正しければ、型Aが成り立つケース（別ターン）を `answer-case-set.*.ts`
  に足せば、決定2と同じ効果が観測できるはずである。**その新設は本追記では行って
  いない**（既存14ケースを変えない、というこの追記の範囲を超える）。
- ⛔ **predicate一致/4・誤検出/14 の off/on 差**——両条件とも3回中の揺れの範囲に
  収まっており、6回という回数でこの揺れが `knownSubjects` の副作用か偶然かを
  判定できない（ADR 0329「負債1」がpredicate側で28〜45回という近い回数でも
  同じ限界を報告している）。
- ⛔ **この opt-in を既定にするかどうか**——本追記は判断しない（冒頭の注記）。

---

## 追記 2026-09-26（2）: 別ターンのケースでの `knownSubjects` 実測（本文・既存の追記は書き換えていない）

> **クローン（miku）の委譲で動くセッションが書いた。オーナー本人ではない**
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)
> ——投稿者名は担い手とオーナーを区別しない）。**この追記に出てくる判断はすべて
> 「委譲された担い手（クローン miku）の判断（オーナーではない）」である。**この
> opt-in を既定にするかどうかの判断はここでも行わない——その判断はオーナー領分
> として残す。

### 前提のずれ（依頼文の誤り・限定を先に訂正する）

この追記に着手する依頼（クローン miku からの委譲）には、以下4点のずれがあった。
**(1) は依頼側（クローン miku）の誤り・簡略化であり、この追記で訂正したうえで
進めた。(2)(3) は依頼の誤りではなく、過去の実測（ADR 0324 §4・本 ADR 決定2）と
`answer` 経路の構成との違いであり、この追記の実測を正しく解釈するために
明示しておく前提である。(4) は事実の確認。**

1. **型A を定義しているのは本 ADR（0334）決定1であって、[ADR 0324](./0324-claim-key-contested-detection.md)
   ではない。** 依頼文は「ADR 0324 の型A」という言い方をしていたが、0324 は型の
   分類そのものを持たない——分類（型A/B/C）は本 ADR 決定1が新たに導入したもので
   ある。また、依頼文にあった「三人称が `'user'` に振られる向きは型A」という説明も
   不正確——決定1を読むと、**その向き（三人称→`'user'`）は型B**（実測でしか
   分からない、方向性）である。**型Aは「1回の `deriveClaimKeys` 呼び出しが
   比較材料を構造的に持たない」という構造上の性質**であり、向きの話ではない。
2. **[ADR 0324](./0324-claim-key-contested-detection.md) §4 の「9/30」は
   `contested` の誤検出の件数であり、`predicate` が一致しないと数に入らない。**
   （ADR 0324 §4「誤検出（無関係な話題間…）」の定義そのまま。）`answer` 経路では、
   ターンをまたぐと `predicate` が揃いにくい（[ADR 0326](./0326-answer-path-claim-key-contested-opt-in-measurement.md)/
   [ADR 0329](./0329-claim-key-known-predicates-from-store.md) が指摘した揺れの
   構造 (c)）——下記「実測」節で、この追記自身の実測でも同じ傾向（predicate 一致
   9/40、**全9件が同一トピック "pet"**、他3トピックは10回とも0件）を確認した。
   **⟹ `contested` の
   誤検出だけを見ていると、predicate が揃わないせいで `subject` の誤帰属自体が
   見えなくなる**——だからこの追記は、`contested` フラグではなく
   `claim_key_subject` の値そのものを診断ログ・`memories` テーブルから直接数えた。
3. **[ADR 0324](./0324-claim-key-contested-detection.md) §4 と本 ADR 決定2は、
   抽出後の単文 `content` を直接渡していた。**§4 は `examples/chat/cassettes/
   retrieval.json` に記録済みの抽出結果をそのままコピーし、決定2も同様——どちらも
   `packages/core/dist` を直接 import した使い捨てスクリプトで `deriveClaimKeys` を
   直接呼んでいる。**`answer` 経路は生の発話（`AnswerCaseTurn.text`）を
   `ingestConversation` → `extractCandidates`（抽出）へ通してから
   `deriveClaimKeys` に渡す**——抽出という追加の LLM 呼び出し段を経由する。
   下記「実測」節で、この抽出段が実際に content を書き換えていないか（例:
   「ユーザーの妻は…」のように三人称の発話へ本人由来の語を混ぜていないか）を
   直接確認した——**結果、そのような書き換えは見つからなかった**（詳細は
   「型Aが再現しなかった理由」節）。
4. **Issue #372 は CLOSED だが、コメントは付けられる。** 依頼文にあったとおり、
   状態が CLOSED であることはコメント投稿の妨げにならないことを確認した
   （`gh issue view 372` で状態を確認した上でコメントする）。

### 足したもの

負債2・前回の追記（2026-09-26）が残した「本人と第三者を別ターンに分けた新ケースでの
測定」を埋めた。**既存の集合・既定は1バイトも変えない**:

- `examples/chat/src/answer-case-set.separate-turn.ts`（新規ファイル）: 4件。
  [ADR 0324](./0324-claim-key-contested-detection.md) §4 の `family`/`diet`/
  `language`（誤帰属率が高かった3類、家族4/5・言語3/5・食事2/5）と `pet`（0/5
  だった対照）の4類を参考にしたが、**関係名詞・文言はこの ADR/0324 が使った
  ものをそのまま流用せず、この集合独自の自然な文にした**（作り込んで型Aを無理に
  再現させないため）。**本人の事実と第三者の事実を意図的に別ターン（別の
  `AnswerCaseTurn`、したがって別の `observe()` 呼び出し）に分けている**——
  既存14件の4件（`other-person-birthday` 等）が同じターンに両方の事実を同居させて
  いたのとは対照的である。

  | ケース | 第三者 | 本人の事実（ターン） | 第三者の事実（ターン） | 質問 |
  |---|---|---|---|---|
  | `separate-turn-family-workplace` | 姉 | 「最近、大阪で新しい仕事を始めました。」(turn 0) | 「姉は先月、福岡に転勤になったそうです。」(turn 4) | 姉はどこで働いていますか? |
  | `separate-turn-spouse-diet` | 妻 | 「わたしは乳製品を控えています。」(turn 0) | 「妻は小麦を控えています。」(turn 4) | 妻は何を控えていますか? |
  | `separate-turn-colleague-language` | 同僚 | 「わたしは英語を話せます。」(turn 0) | 「同僚はフランス語を話せます。」(turn 4) | 同僚は何語を話せますか? |
  | `separate-turn-father-pet` | 父 | 「わたしは犬を飼っています。」(turn 0) | 「父は猫を飼っています。」(turn 4) | 父は何を飼っていますか? |

  全件 `knownSubjects: ["user", <第三者>]`（上限＝オラクル測定用、既存4件と同じ
  限定）・`tuningUse: "held-out"`（実装の挙動を見る前に会話・期待値を決めた）。
  `__tests__/answer-case-set.separate-turn.test.ts` が構造上の規約（3〜6件・全件
  `knownSubjects` を持つ・`expected.accept`/`expected.reject` の語が同じターンに
  同居しない＝別ターンであることの機械的な歯、他）を検査する——変異試験で
  「同じターンに同居させる」変異を入れると、この歯が実際に赤くなることを確認した
  （`cp` での退避・復元、`docs/autonomy.md` §2 の手順どおり）。
- `examples/chat/src/scripts/record-answer-claim-key.ts`: `MNEMORA_ANSWER_CASE_SET`
  （`"default"` 省略時の既定 | `"separate-turn"`）を追加。**既定は dev+eval
  14件（この env を足す前と1バイトも変わらない）。** `"separate-turn"` を指定すると
  `ANSWER_CASE_SET_SEPARATE_TURN` だけを走らせる——既存14件のケースセットは
  一切参照しない。

**既存14件（dev6+eval8）・既存カセット30本＋前回追記の6本（合わせて36本）は1バイトも
変えていない**（`git status --porcelain` で、新規ファイルのみであることを確認）。

**決定論のユニットテスト**（`MNEMORA_LLM=deterministic` 明示、ファイル名指定で実行）:

```
MNEMORA_LLM=deterministic pnpm --filter example-chat exec vitest run \
  src/__tests__/answer-case.test.ts src/__tests__/answer-claim-key-options.test.ts \
  src/__tests__/answer-case-set.separate-turn.test.ts
```

47件全通過（既存37件 + 新規10件）。typecheck（`pnpm --filter example-chat run
typecheck`）・eslint（変更した3ファイルのみ）・prettier（`--check`）もすべて
クリーン。

### 実測: `MNEMORA_RECORD_CONDITION=baseline`（off、"detect"）と `known-subjects`（on）を5回ずつ、1回ごとに対で実行

【実測】2026-09-26、`gpt-4o-mini`。`ANSWER_CASE_SET_SEPARATE_TURN` 4ケース全件、
`initdb`（PostgreSQL 17、pgvector・btree_gin・pgcrypto、専用ポート・作業ツリー外
`/tmp/mgr-a2c4ac80/pg`）で立てた専用インスタンス。種カセットは常に
`answer.order-legend.json`（前回追記と同じ）。新カセット10本
（`examples/chat/cassettes/answer.claim-key.separate-turn-{off,on}-{1,2,3,4,5}.json`）
へ記録し、既存カセット・既存ケースセットは1バイトも触っていない。

**基準は "detect"**（前回追記と同じ）。off/on は同じ順で対にして実行した
（off-1, on-1, …, off-5, on-5——依頼の「3回以上」を満たした上で、費用が
極めて低かった（1回あたり概算$0.002前後）ため、統計的な手がかりを増やす目的で
5回に増やした）。

**主指標: `memories` テーブルの `claim_key_subject`（診断ログ・直接 SELECT の両方から
確認、[ADR 0329](./0329-claim-key-known-predicates-from-store.md) までと同じやり方
——前提のずれ2で書いたとおり、`contested` フラグには頼らない）:**

| run | 条件 | 第三者→"user" 誤帰属 /4 | 本人→"user"以外 誤帰属 /4 | predicate一致 /4 | contested誤検出 /4 | 費用 |
|---|---|---|---|---|---|---|
| off-1 | baseline | 0/4 | 0/4 | 1/4（pet） | 0/4 | $0.002063 |
| on-1 | known-subjects | 0/4 | 0/4 | 1/4（pet） | 0/4 | $0.002265 |
| off-2 | baseline | 0/4 | 0/4 | 1/4（pet） | 0/4 | $0.002079 |
| on-2 | known-subjects | 0/4 | 0/4 | 1/4（pet） | 0/4 | $0.002350 |
| off-3 | baseline | 0/4 | 0/4 | 1/4（pet） | 0/4 | $0.001918 |
| on-3 | known-subjects | 0/4 | 0/4 | 1/4（pet） | 0/4 | $0.002201 |
| off-4 | baseline | 0/4 | 0/4 | 0/4（pet も不一致） | 0/4 | $0.002133 |
| on-4 | known-subjects | 0/4 | 0/4 | 1/4（pet） | 0/4 | $0.002345 |
| off-5 | baseline | 0/4 | 0/4 | 1/4（pet） | 0/4 | $0.002128 |
| on-5 | known-subjects | 0/4 | 0/4 | 1/4（pet） | 0/4 | $0.002281 |
| **合計/平均** | — | **0/20（off）・0/20（on）** | **0/20（off）・0/20（on）** | **4/20（off）・5/20（on）** | **0/20（off）・0/20（on）** | **$0.021763** |

**中心となる観測: 第三者 subject の誤帰属は、off・on どちらの5回でも一度も
起きなかった（4件×5回=20機会中0件、両条件とも。合わせて40機会中0件）。**
`separate-turn-family-workplace` の「姉」→ off/on とも `sister`/`姉`、
`separate-turn-spouse-diet` の「妻」→ `wife`/`妻`、`separate-turn-colleague-language`
の「同僚」→ `colleague`/`同僚`、`separate-turn-father-pet` の「父」→ `father`/`父`
——40回すべてで、baseline（語彙ヒント無し）の時点ですでに正しく本人以外へ
分離されていた。逆方向（本人の事実が `"user"` 以外になる）も40機会中0件だった。

**⟹ この4ケース・この5回という範囲では、`knownSubjects` が「直す」べき誤帰属が
そもそも観測されなかった**——前回の追記（同じ状況、既存4件）と同じ結果だが、
今回は本人の事実と第三者の事実が意図的に別ターン（別の `observe()`）にあり、
決定1「型A」の前提（比較材料を構造的に持たない）が成り立っている点が前回と違う。
**⟹ 型Aの前提を満たしてもなお、`answer` 経路のこの4ケースでは off の時点で
誤帰属が再現しなかった。**

**副指標**: predicate 一致は "pet"（user: `has_pet` 系、第三者: `has_pet` 系）に
**完全に限定して**発生した——一致した9件はすべて "pet" トピックであり（"pet" は
10回中9回一致、off-4 だけ `has_pet` 対 `has_pet_cat` で不一致になった）、
"family"/"diet"/"language" の3類は**10回とも一度も predicate が一致しなかった**（0/30）——
`avoiding_dairy_products` 対 `gluten_intolerance`、`new_job_location` 対
`moved_to` のように、別ターンでは同じ話題でも predicate の語彙が揃わない
（[ADR 0326](./0326-answer-path-claim-key-contested-opt-in-measurement.md)/
[ADR 0329](./0329-claim-key-known-predicates-from-store.md) の揺れ (c) の再確認）。
`contested` 誤検出は40機会中0件——`findActiveByClaimKey` の診断ログは全40turnとも
`{"matchCount":0,"result":{"kind":"no_conflict"}}` だった。predicate がほぼ揃わない
以上、`subject` が仮に誤帰属していたとしても `contested` は構造的に発火しにくい
——これが「`contested` の誤検出だけを見ていると `subject` の誤帰属が見えなくなる」
（前提のずれ2）の実例である。

### 型Aが再現しなかった理由（確かめた範囲）

依頼は「off で型A が再現しなければ、それ自体が結果である」「抽出後の content と
claim key を実際に見て原因を書く」と求めていた。実際に確認した:

**確かめたこと（【現物】診断ログ・`memories` テーブルの直接 SELECT）**:
抽出段が三人称の発話へ本人由来の語を混ぜていないか——**混ぜていなかった。**
10回すべてで、第三者ターンの抽出後 `content` は元の発話の関係名詞をそのまま保った
（例: `"姉は先月、福岡に転勤になった。"`／`"妻は小麦を控えている。"`／
`"同僚はフランス語を話せる。"`／`"父は猫を飼っています。"`——`"ユーザーの妻は…"`
のような書き換えは一度も観測しなかった）。**⟹ 依頼文が最有力候補として挙げていた
「抽出段の書き換え」という説明は、この4ケースでは当てはまらない。**

**確認した構造上の違い（[ADR 0324](./0324-claim-key-contested-detection.md) §4・
本 ADR 決定2 が使った `examples/chat/src/probe-set.ts` の `PROBES` との比較、
【現物】）**: 誤帰属率が高かった3類（family/language/diet）の `fact`（本人の事実、
`PROBES` 定義）は、いずれも**明示的な一人称代名詞を持たない**——`family` の
`fact: "弟は札幌に住んでいます。"` に至っては**本人の事実ですらなく、別の第三者
（弟）についての発話**である。`diet`（`"牛乳を飲むとお腹を壊します。"`）・
`language`（`"TypeScriptよりRustのほうが好みです。"`）も主語が省略された文で
ある。一方この追記の4ケースは、本人の事実の発話を常に明示的な一人称
（「わたしは…」）で始めている。**この構造上の違いは実在する**——ただし、
`deriveClaimKeys` は「1発話=1バッチ」（決定2・本追記とも）で呼ばれ、各呼び出しは
独立した1件の `content` だけを受け取る（前ターンの内容やバッチ内の他候補は
見えない、`buildClaimKeyPrompt` の実装どおり）ため、**「本人の事実の言い方」が
「第三者の事実」の呼び出しへ直接漏れる経路は無い**——この構造上の違いが今回の
0/40 の**直接の原因だと断定することはできない**（0/5 だった `color`/`pet` の
`fact` は明示的な一人称 `"私は"`/`"私の"` を持つが、同じく 0/5 だった `exercise`/
`travel` の `fact` は一人称を持たない——一人称の有無だけでは、誤帰属率が高い3類と
低い4類の分かれ方を完全には説明できない）。

**⟹ 確かめられたのは「抽出段の書き換えは原因ではない」ことと「入力文の一人称
明示という構造上の違いが実在する」ことまでであり、その違いが誤帰属率の差を
どれだけ説明するかは確認できていない。** 残る候補（ADR 0324 §4/本 ADR 決定2の
実測が使った独立スクリプト——「使い捨てスクリプト」でリポジトリに残っていない
——との、他の未特定の相違点／モデル出力のばらつき／`gpt-4o-mini` のモデル
バージョンが2026-09-25/26の間で変わった可能性）は、この時点では確認も反証もして
いなかった——下記「陽性対照の再実行」節で、この2つの候補のうち少なくとも一方に
手がかりを足した。

### 陽性対照の再実行（「ケースの作り方の問題か、モデルが変わったのか」の切り分け）

上記だけでは「この4ケースの作り方（answer 経路・別ターン構成）の問題」と「モデル
自体がもう誤帰属を起こさない（2026-09-25/26 の実測から変わった、またはその日の
揺れ）」を切り分けられない。切り分けるため、**ADR 0324 §4・本 ADR 決定2 が使った
のと同じ6話題（`color`/`pet`/`exercise`/`diet`/`family`/`language`）の
`fact`/`distractor` を `examples/chat/cassettes/retrieval.json` の抽出結果から
そのままコピーし**（`examples/chat/src/probe-set.ts` の `PROBES` に対応する
抽出結果、1文字も生成していない）、**1発話=1バッチで `deriveClaimKeys` を
`packages/core/dist`/`packages/openai/dist` から直接 import した使い捨てスクリプト
（`/tmp/mgr-a2c4ac80/positive-control.mjs`、リポジトリにはコミットしていない）
で n=3 回**、OFF（`knownPredicates`/`knownSubjects` とも渡さない）で再実行した
——**陽性対照（ADR 0324 §4・本 ADR 決定2 が誤帰属を観測した、まさにその入力）**。
同じスクリプトで、この追記の新4ケースの第三者ターンの抽出後 content（例:
`"妻は小麦を控えている。"`）も、`answer` harness を経由せず同じ形（1発話=1バッチ、
OFF、n=3）で直接渡した。

【実測】2026-09-26、`gpt-4o-mini`。

| トピック | distractor→"user" /3 | fact→"user" /3 | 備考 |
|---|---|---|---|
| color | 0/3 | 3/3 | fact は一人称（"私の好きな色は青である。"）——3/3とも正しく `user` |
| pet | 0/3 | 3/3 | 同上 |
| exercise | 0/3 | 3/3 | fact は主語省略——3/3とも正しく `user` |
| diet | 0/3 | 3/3 | 同上 |
| family | 0/3 | **0/3** | fact 自体が第三者（弟）の発話——3/3とも正しく `弟`/`brother`（`user` にならない） |
| language | 0/3 | 3/3 | fact は主語省略——3/3とも正しく `user` |
| **合計** | **0/18** | **15/18**（family 以外の5トピック×3が `user`、family の3は非`user`が正しいので分子に含めない） | — |

**この追記の新4ケースの第三者 content を harness を経由せず直接渡した場合**:
`separate-turn-family-workplace`（"姉は先月、福岡に転勤になった。"）・
`separate-turn-spouse-diet`（"妻は小麦を控えている。"）・
`separate-turn-colleague-language`（"同僚はフランス語を話せる。"）・
`separate-turn-father-pet`（"父は猫を飼っています。"）——**4件×3回=12機会すべてで
`"user"` への誤帰属は0件（0/12）。**

**陽性対照が「出なかった」——これは、この追記が最初に確認したかった対照そのものが
不発だったことを意味する。** ADR 0324 §4（2026-09-25）は同じ6話題で `family` 4/5・
`language` 3/5・`diet` 2/5（他3トピック0/5）の誤帰属を報告し、本 ADR 決定2
（2026-09-26、**同じ日**）も独立した再測定で off-1〜3 それぞれ 1/6・1/6・2/6
（0ではない）を報告している。**今回の陽性対照（同じ6話題・同じ抽出後 content・
同じ「1発話=1バッチ」・同じ OFF 条件・同じ `gpt-4o-mini`、n=3）は distractor→"user"
が0/18——family/language/diet を含め、一度も誤帰属が起きなかった。**

**これをどう読むか（確かめた範囲）**: 本 ADR 決定2 自身の3回の OFF 測定
（1/6・1/6・2/6、いずれも0ではない）を基準に、`family`/`language`/`diet` の
distractor 単体の誤帰属確率をそれぞれ 80%/60%/40% 程度と仮定すると、この3トピック
×n=3 の9機会すべてで誤帰属が0件になる同時確率は 0.2³×0.4³×0.6³ ≈ 0.01%
程度であり、**単なる標本のばらつきだけでこの0/18を説明するのは苦しい**。
一方、本 ADR 決定2 の OFF 測定も同じ2026-09-26 に行われており、**数時間〜1日の
間でモデルのバージョンそのものが変わったと断定するにも根拠が弱い**（OpenAI 側の
モデルバージョン情報を確認していない・両者の実測時刻の記録が無い）。**⟹ 「ケースの
作り方の問題」ではなく「モデル側の出力分布の何か（バージョンの違い、または
この種の分類判定自体が持つ、n=3〜5では均せないほど大きな試行間分散）」に寄る
手がかりを得たが、両者を最終的に切り分けるには至っていない。** ADR 0324 §4・
本 ADR 決定2 が使った実際のスクリプトはリポジトリに残っていない（使い捨て）ため、
この `positive-control.mjs` との逐語比較はできない——`openai` npm パッケージの
バージョン・`temperature` の既定値など、両者で異なりうる要素を個別には確認して
いない。

**呼び出し回数・費用**: `chat.completions.create` 48回（6話題×2×3 + 4ケース×3）。
`OpenAILLMProvider` を直接使い usage を読み取る仕組みを持たないため、費用は
ADR 0334 決定2 の実測単価（$0.0000669/呼び出し前後）を基準にした**概算**——
約 $0.003211（実測ではなく概算であることに注意）。

**追記(2)全体の費用**: `answer` harness 実測（10回、chat 371回・embedding 130回）
$0.021763（実測） + 陽性対照（chat 48回）概算 $0.003211 ＝ **合計 約 $0.024974**
（依頼された上限 $0.30 の約8.3%）。

### 確かめていないこと（この追記が新たに残す分）

- ⛔ **型A が再現しなかった根本原因の最終確定**——抽出段の書き換えは原因ではないと
  確認し、陽性対照（同じ6話題・同じ content・同じ手順での再実行）も0/18で
  「モデル側の出力分布の何か」に寄る手がかりを得たが、「バージョンが変わった」
  「この分類判定自体が n=3〜5 では均せない大きな試行間分散を持つ」のどちらか
  （または両方）かは確定できていない——ADR 0324 §4・本 ADR 決定2 が使った実際の
  スクリプトがリポジトリに残っていないため、逐語比較で差分を特定する経路が無い。
- ⛔ **`knownSubjects` が実際に誤帰属を減らす効果**——別ターンにしてもなお
  off で誤帰属が観測されなかった（0/20、陽性対照も0/18・新4ケース単独でも0/12）ため、
  on との比較（0/20 のまま）は「直す対象が無かった」以上のことを示さない。決定2の
  ON-ceiling 実測（1発話=1バッチを独立スクリプトで強制、当時は誤帰属が実在した
  状態での効果測定）でのみ効果を確認済みのまま——`answer` harness を経由した効果の
  確認は、この追記でもまだ得られていない。
- ⛔ **`gpt-4o-mini` のモデル出力が [ADR 0324](./0324-claim-key-contested-detection.md)
  §4（2026-09-25）・本 ADR 決定2（2026-09-26）の実測時点から変わったか**
  ——モデルのバージョン・重みが固定されているかどうかを OpenAI 側の情報で確認して
  いない。陽性対照の0/18は「変わった」側に寄る手がかりだが、確定的な証拠ではない
  （上記参照）。
- ⛔ **一人称明示という構造上の違いが誤帰属率にどれだけ効くか**——`color`/`pet`
  （一人称あり・0/5）と `exercise`/`travel`（一人称なし・0/5）が同じ0/5になって
  いる以上、この追記の比較だけでは因果を主張できない。
- ⛔ **陽性対照 n=3 という回数の限界**——上記「これをどう読むか」で示した同時確率の
  試算は、本 ADR 決定2 自身の3回（n=3〜5）の観測値を真の確率と仮定した粗い見積もり
  であり、厳密な統計検定ではない。
- ⛔ **本人・第三者の語順を入れ替えた別ターン版**（`eval-misattribution-order-swapped`
  相当の語順ストレスを、別ターン構成と組み合わせた場合）——今回は本人が常に先に
  発話する語順だけを扱った。
- ⛔ **この opt-in を既定にするかどうか**——本追記は判断しない（冒頭の注記）。
