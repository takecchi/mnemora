# examples/chat

roadmap.md 段階7「サンプル」。**このサンプルの主目的は「動くデモ」ではなく、
[docs/north-star.md](../../docs/north-star.md) の物差し——

> 使う側が、会話ログを全部プロンプトへ積むのをやめられたか。

——を実際に測ることである。** 機能が動くこと自体は物差しに対して何も言えない
（同 doc「記憶の件数でも、機能の数でも、recall の平均スコアでもない」）。

同じ会話に対して2つの経路を並べて走らせ、実際にプロンプトへ積む量を実測して比較する。

- **経路A（naive）**: 会話ログを全部プロンプトへ積む（mnemora を使わない、今の普通のやり方）。
- **経路B（mnemora）**: `observe()` で会話を取り込み、`recall()` が返した `memories`（の
  digest）と `index` だけを積む。`budget` を渡すと実際に切り詰められる。

---

## 動かし方

前提: Node 22 / pnpm（corepack）。ローカルに Postgres + pgvector が必要
（[AGENTS.md](../../AGENTS.md) 参照、または CI の `example-chat` ジョブと同じ
`pgvector/pgvector:pg17` イメージ）。

```bash
# リポジトリルートで
pnpm install
pnpm run build   # @mnemora/core 等の workspace パッケージを dist へビルドする
                 # （tsx で直接実行する examples/chat の CLI は dist を node_modules 経由で
                 #   解決するため、ビルドが要る。vitest はテスト時だけ src を直接見るため
                 #   ビルド無しでも動く——後述「テスト」参照）

export DATABASE_URL="postgresql://user@host/dbname?host=/path/to/sockdir&port=5544"
pnpm --filter @mnemora/postgres run migrate

# observe → recall の往復、omitted/usage/budget を実演する
pnpm --filter @mnemora/example-chat run chat

# 会話の長さを変えて、経路A/経路Bの量を実測する（このサンプルの主目的）
pnpm --filter @mnemora/example-chat run compare
```

`OPENAI_API_KEY` を環境に設定すると本物の OpenAI（LLM 抽出・Embedding）で動く。
設定しなければ `@mnemora/testkit` の決定的な擬似 provider で動く——**どちらで動いているかは
起動直後に必ず画面へ出す**（黙って擬似物にフォールバックしない）。

### テスト

```bash
export DATABASE_URL=...
pnpm --filter @mnemora/example-chat run test:db
```

本物の Postgres に接続する（擬似物では代替しない）。`observe → recall` の往復・
`budget` による切り詰め・`runComparison` の量の計測をすべて実DBに対して検査する。
ビルド不要（`vitest.config.mts` が `@mnemora/*` を各パッケージの `src` へ直接エイリアスする）。

リポジトリのルートから `DATABASE_URL=... pnpm run test` を実行すれば、この検査も一緒に走る。
`DATABASE_URL` を設定していない場合、ルートの門は**この検査を実行していないと明示して**通る
（[ADR 0015](../../docs/decisions/0015-root-test-gate-reports-skipped-db-tests.md)）。

---

## `chat`: observe/recall の往復・omitted・usage・budget

固定の合成会話（後述）を `observe()` で取り込み、終盤の質問を `recall()` する。
`recall()` の返り値のうち roadmap.md 段階7の完了条件そのものである `omitted` と
`usage` を画面に出し、さらに小さな `budget`（`maxMemoryChars`）を渡した場合に実際に候補が
落ちること（`omitted` に `budget_dropped` が現れ、`memories` の件数が減ること）を示す。

---

## `compare`: 量の比較（このサンプルの主目的）

会話の長さ（filler の往復数）を `[0, 1, 2, 3, 4, 5, 10, 20, 40, 80, 160, 320, 642(turns)]`
と変化させ、各長さについて独立のテナントで:

- **経路A**: 全ターンを `role: text` 形式で連結した文字列の長さ（`chars`）と、
  `heuristicTokenCounter`（core の既定の文字数ベース推定）によるトークン数。
- **経路B**: 同じ会話を `observe()` で取り込み、終盤の質問を `recall()`（**budget 無し**）
  した際の `usage.chars` / `usage.estimatedTokens`——`recall()` 自身が計測した値を
  そのまま使う（自前で数え直さない）。

を測る。**budget は渡さない**——docs/roadmap.md §4「計測と抑止を混同しない」の通り、
ここで見せたいのは「切り詰めずに、そのままだと何文字になるか」であり、強制ではなく
計測の比較だからである（budget が実際に切り詰めることは `chat` サブコマンドの方で見せる）。

### 実測結果（2026-09-05、`@mnemora/testkit` の決定的な擬似 provider・`pgvector/pgvector:pg17` 相当のローカル環境）

`pnpm --filter @mnemora/example-chat run compare` の実際の出力（再現可能。同じ環境・
同じ会話生成関数であれば同じ数字になる——`buildConversation()` は乱数を使わない）。

| 会話ターン数 | naive chars | naive tokens(概算) | mnemora chars | mnemora tokens(概算) | mnemora/naive (chars) |
|---|---|---|---|---|---|
| 2 | 49 | 13 | 131 | 33 | **267.3%** |
| 4 | 97 | 25 | 142 | 36 | **146.4%** |
| 6 | 150 | 38 | 161 | 41 | **107.3%** |
| 8 | 197 | 50 | 178 | 46 | 90.4% |
| 10 | 243 | 61 | 193 | 50 | 79.4% |
| 12 | 294 | 74 | 211 | 54 | 71.8% |
| 22 | 552 | 138 | 288 | 75 | 52.2% |
| 42 | 1048 | 262 | 292 | 76 | 27.9% |
| 82 | 2064 | 516 | 310 | 80 | 15.0% |
| 162 | 4083 | 1021 | 303 | 78 | 7.4% |
| 322 | 8134 | 2034 | 305 | 79 | 3.7% |
| 642 | 16223 | 4056 | 305 | 79 | 1.9% |

**⚠⚠ 2026-09-06 追記: この表は、いまのコードでは再現しない。** 同じ擬似 provider・
本物の PostgreSQL 17 + pgvector 0.8.2 で測り直したところ、長い会話（322 / 642 ターン）の
数字は一致したが、**短〜中の会話では mnemora 側が記録値より小さく出た**——経路Bが naive を
下回り始める閾値も **8ターン → 6ターン**へ動いている（例: 6ターンで 161 chars / 107.3% と
記録されているものが 109 chars / 72.7% になる）。測り直した表は
[ADR 0019 §5b](../../docs/decisions/0019-real-openai-measurement-cost.md) にある。
**どの変更がこの差を作ったかは特定していない。**

**⚠ この表の数値は 2026-09-05 に、改名前の名前（`mnemo`）で走らせた実測そのままである。**
`mnemora` への改名は呼称の変更であって計測の経路には触れていないが、**改名後に測り直しては
いない**——この改名作業を行った環境には Postgres が無く、`compare` を実行できなかった。
列見出しだけは現在の `compare` の出力（`mnemora chars` 等）に合わせてある。

### 正直に読むべきこと

**⚠ 会話が短いうちは経路Bのほうが多い。** `2`〜`6` ターンでは mnemora のほうが naive より
**大きい**（最大 +167%）。理由は2つ:

1. `recall()` は index band（目次帯・第3階の群カウント）の JSON を必ず含む固定費を持つ。
   会話が短いとこの固定費が相対的に大きく見える。
2. `observe()` → 抽出 → 埋め込み → `recall()` という往復自体にも、返す memory 1件あたり
   digest という形の一定のオーバーヘッドがある。

**この実測では、`8` ターン（filler 往復3組＋事実表明1組）から経路Bが下回り始める。**
それ以降は単調に差が開く——naive は会話が伸びる限り線形に増え続けるのに対し、mnemora は
既定の `recall()` の `limit`（10件）と index band の固定費でほぼ頭打ちになる
（`162`→`642` ターンで naive は 4倍になるが mnemora はほぼ変わらない）。

**この閾値（8ターン）は、この会話生成関数・この既定パラメータ（`limit=10` 等）・
この擬似 provider に固有の数字であり、一般的な閾値として主張しない。** 会話の内容
（filler の長さ・事実の長さ）や `recall()` のオプションを変えれば動く。


### 本物の OpenAI で走らせた実測（2026-09-06、`gpt-4o-mini` + `text-embedding-3-small`(256次元)）

**所要 約11分 / 実費 約 3.2セント**（呼び出し 889回。内訳は
[ADR 0019 §7.8](../../docs/decisions/0019-real-openai-measurement-cost.md)）。

| 会話ターン数 | naive chars | mnemora chars（本物） | 比（本物） | 比（擬似・同日測定） |
|---|---|---|---|---|
| 2 | 49 | 125 | 255.1% | 222.4% |
| 6 | 150 | 134 | **89.3%** | 72.7% |
| 22 | 552 | 211 | 38.2% | 19.7% |
| 82 | 2064 | 247 | 12.0% | 5.4% |
| 322 | 8134 | 231 | 2.8% | 3.7% |
| 642 | 16223 | **244** | **1.5%** | 1.9% |

（全12行は [ADR 0019 §7.7](../../docs/decisions/0019-real-openai-measurement-cost.md)）

**⟹ 北極星の物差しは本物の provider でも成立する——むしろ良くなる**（642ターンで 1.5%）。
経路Bが naive を下回り始める閾値は **6ターン**で擬似と同じ。

**⚠ ただし干し草の中身が擬似とは別物である。**本物の LLM は世間話の多くを記憶にしないので、
スコープ内 Memory は擬似の 321件よりずっと少ない。**この表が言えるのは「積む量」までである。**
「正しく引けたか」は後述の `retrieval` のほうが答える。

### ⭐ 削減率だけでは意味を持たない——答えが残っているか

**何も返さなければ削減率は 0% になる。** 削減が意味を持つのは、**呼び出し側が探している
答えが、削られた後にも残っている**場合だけである。物差し（「会話ログを全部プロンプトへ
積むのをやめられたか」）は、積むのをやめても答えが得られることを含意している。

そこで、冒頭で一度だけ表明した事実（`FACT_STATEMENT` = 「私の好きな色は青です。……」）が、
絞り込みの後にも `recall()` の返り値に残っているかを、全ての会話長で確認した。

| 会話ターン数 | スコープ内の Memory | 返った件数 | 冒頭の事実が残っているか |
|---|---|---|---|
| 2 | 1 | 1 | ✅ |
| 8 | 4 | 4 | ✅ |
| 32 | 16 | 10 | ✅ |
| 82 | 41 | 10 | ✅ |
| 162 | 81 | 10 | ✅ |
| 322 | 161 | 10 | ✅ |
| 642 | 321 | 10 | ✅ |

**642ターン（321件のうち10件だけを返す＝ naive の 1.9%）まで削っても、冒頭の事実は落ちなかった。**
これが「1.9%」という数字に意味を与えている唯一の根拠である。

この検査は `src/__tests__/mnemora-path.postgres.test.ts` に歯として入れてある（162ターン）。
歯には「実際に大幅な絞り込みが起きていること」の前提検査も含めてある——
絞り込みが起きていなければ「残った」ことに意味が無く、`limit` が緩んだ瞬間に
この歯は無意味な緑になるため。

**⚠⚠ 2026-09-06 追記: この ✅ は、思っていたより弱い。** 本物の埋め込みで測り直した結果
（後述「`retrieval`」）、**擬似 embedding は、内容の違う記憶が60件並ぶ場面では
目的の記憶をほとんど返せない**（7件中6件で圏外。語彙が重なる問いですら落ちる）。
この表の干し草が**12種類の filler の使い回し**であることが、この ✅ を成立させていた
可能性が高い。さらに、`tick()` の既定 `limit` は 50 で `ingestConversation` は `tick()` を
1回しか呼ばないため、**「スコープ内 321件」のうち実際に埋め込まれて ANN の候補に
なれたのは最大 50件である**（冒頭の事実は最初のジョブなので必ずこの 50件に入る）。
実際に確かめた結果（642ターン・既存の `ingestConversation` のまま）は
`omitted = [ann_truncated, over_limit:30, not_indexed(pending):271]` であり、
**321件のうち 271件は埋め込まれていない。実際に競ったのは 50件である。**
**⟹ この表は「321件と競って勝った」とは読めない。**
`recall()` はこれを `omitted` に正直に出していた——**隠していたのは mnemora ではなく、
`omitted` を読まずにこの表を書いた側である。**

**⚠⚠⚠ 追記（本 PR、[ADR 0021](../../docs/decisions/0021-drain-embed-ticks-in-ingest.md)）:
上の欠陥はこの PR で直した。** `ingestConversation`（`examples/chat/src/mnemora-path.ts`）は
`tick({kinds:["embed"]})` を1回だけ呼ぶのをやめ、`processed === 0` になるまで
回し切るようになった（`examples/chat/src/embed-drain.ts` の `drainEmbedTicks`。
`retrieval-quality.ts` が使っていた同じ関数を共有モジュールへ切り出して使い回している）。
「`omitted` に `not_indexed(pending)` が残らないこと」は
`src/__tests__/mnemora-path.postgres.test.ts` に歯として足した（DEFAULT_TICK_LIMIT
= 50 を超える61件の観測を ingest し、`ingestConversation` を tick() 1回に戻すと
必ず赤くなることを想定した歯——この作業を行った環境には `DATABASE_URL` が無く、
CI で実際に走らせたわけではない）。

**⟹ 上の表（173〜181行の「スコープ内の Memory」列）と直前の `omitted` の実測値は、
いずれも修正前（tick() 1回・271件が `pending` のまま）の挙動で測定したものであり、
**本 PR ではこの数値を測り直していない**（この作業を行った環境には PostgreSQL が
無く、`compare` を実行できない）。「直したので改善するはず」と決め打って数値を
書き換えることはしない。修正後に実際に321件（あるいはそれ以上のスコープ）全件と
競わせた結果は、次に `compare` を実測できる環境で埋める:

| 会話ターン数 | スコープ内の Memory | 実際に ANN の候補になれた件数（修正後） | 返った件数 | 冒頭の事実が残っているか | `omitted` の内訳 |
|---|---|---|---|---|---|
| 642 | TODO(実測) | TODO(実測) | TODO(実測) | TODO(実測) | TODO(実測) |

（「実際に ANN の候補になれた件数」列は、修正が効いていれば「スコープ内の Memory」と
一致し、`not_indexed(pending)` が `omitted` に現れないはずである——ただしこれも
**実測で確認するまでは主張しない**。）

**⚠ この表が主張しないこと**: 擬似 embedding は意味的な類似度を持たないので、これは
「意味的に関連する記憶が正しく上位に来る」ことの証明では**ない**。主張しているのは、
**この決定的なシナリオにおいて、量を1桁以上削っても目的の記憶が落ちなかった**という
事実だけである。実 API キーでの検証は行っていない（下記「この実測の限界」）。

### この実測の限界

- **擬似 embedding は意味的な類似度を表現しない。** `DeterministicEmbeddingProvider`
  は文字コードの合計から機械的にベクトルを作るだけで、実際に「関連する記憶が正しく
  上位に来ているか」はこの実測では検証していない（`packages/testkit` 自身のコメントに
  明記されている限界であり、隠していない）。**主に測っているのは「recall がどれだけの量を
  返すか」である。**「正しいものを返すか」については、上記の通り
  **この決定的なシナリオで目的の記憶が落ちないこと**までは確認したが、
  **一般に意味的な関連度で正しく順位付けできるかは確認していない。**この2つを混同しないこと。
  後者を測るには
  `OPENAI_API_KEY` を使った実行が必要だが、このリポジトリの CI・この実測環境には
  実 API キーが無いため、**確認していない。**
- **naive path はシステムプロンプト・ツール定義を含まない生の transcript だけを測る。**
  実際のアプリケーションはこれらが上乗せされる分、絶対値としての削減幅はさらに
  大きくなりうる（逆に mnemora 側の固定費の比率は相対的に小さくなる）。
- **`budget` は `memories` tier（digest の合計文字数）だけを切り詰め、`index` tier
  （目次帯の JSON）は切り詰めない。** これは意図した設計である——目次帯の唯一の存在理由は
  「recall が0件でも、何が在るかは言える」ことであり
  （[ADR 0008](../../docs/decisions/0008-absence-taxonomy.md)）、
  **呼び出し側が渡した数字ひとつでその保証が消えてはならない。**
  したがって `budget.maxMemoryChars` より目次帯のほうが大きい場合、
  `usage.chars`（全量）は予算を上回る。これは隠さずそのまま出す。
  ただし `usage.share` は「**予算の対象が予算のどれだけを使ったか**」なので 1 を超えない。
  目次帯の実費は `usage.indexChars` として別に返るため、
  呼び出し側は `chars` と `indexChars` を見れば「なぜ全量が予算を上回ったか」が分かる。

  **この節は当初、`share` が 248.3% になることを「仕様どおりの挙動」として記録していた。
  それは誤りだった**——割合として成立しない数を割合の顔で返していた。
  予算の項目名（`maxChars` → `maxMemoryChars`）と `share` の定義を直してある
  （[docs/recall.md §6](../../docs/recall.md) の2つの訂正節を参照）。
  「セッション全体でどれだけ削れたか」ではない（[docs/recall.md §6](../../docs/recall.md)
  「セッション基準値を持たない」を参照。mnemora はセッションという概念を持たない）。
- この比較は**会話1本・固定のシナリオ**に基づく。実際の効果は会話の性質
  （どれだけ「思い出す価値のある事実」対「filler」の比率があるか）に強く依存する。

---

## `retrieval`: 意味的関連性の測定（本 PR で追加）

`compare` の限界として上に明記した通り、擬似 embedding は意味的な類似度を表現しないため、
「recall がどれだけの量を返すか」は測れても「正しいものを返すか」は測れない。`retrieval`
サブコマンドはこの後者——**意味的に関連する記憶が正しく上位に来るか**——を、本物の
OpenAI（LLM・embedding）を使って測るためのものである。

```bash
DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run retrieval
```

**本物の API を叩く。CI には載せていない**（`.github/**` は変更していない）。手動で
`OPENAI_API_KEY` を指定して実行したときだけ動く。

### 何を測るか(`src/probe-set.ts`・`src/retrieval-quality.ts`)

- `src/probe-set.ts` に、色・ペット・運動・食べ物/アレルギー・家族の居住地・
  プログラミング言語・出張の7領域の probe を置く。probe ごとに gold(冒頭で1度だけ
  表明される事実)・distractor(同じ話題・違う主語や値)・質問(gold と内容語を
  共有しない——`lexicalControl: true` の1件だけ例外)を持つ。
- gold・distractor(計14件)の後ろに、probe の話題と重ならない領域(事務手続き・
  家電の修理・書籍や文房具の購入・部屋の片付け・郵便物・季節の行事の準備)の
  「haystack」を敷き詰める。haystack は決定的に生成され(乱数を使わない)、
  probe の話題語を含まないことを機械的に検査してある(`findTopicKeywordViolations`)。
  ⚠ `scenario.ts` の filler(「今日はいい天気ですね。」等)は使っていない——本物の
  gpt-4o-mini で実際に確認したところ、この種の世間話には `{"memories":[]}` が返り、
  記憶として残らないため(干し草が消えてしまう)。
- `recall().memories` に返ってきた `memoryId` から、`memoryStore.get`/`getObservation`
  (`packages/core`/`packages/postgres` 既存の公開 interface。変更していない)を辿って
  元の `externalId`(`gold-<id>`/`distractor-<id>`/`filler-NNNN`)へ戻し、gold/distractor
  の順位(`goldRank`/`distractorRank`)・`hit@1`/`hit@10`・`distractorBeatsGold`・MRR
  (全体・`lexicalControl`・非語彙で分けて集計)を probe ごとに計算する。

### 3つの arm

LLM と embedding を別々に選べる(`MNEMORA_LLM`/`MNEMORA_EMBEDDING`、`src/providers.ts`)
ようにしたのはこのため——「順位が変わったのは embedding のせいか抽出のせいか」を
切り分けられないと、どちらが効いたか言えない。

| arm | LLM | Embedding |
|---|---|---|
| A | 擬似(`DeterministicLLMProvider`) | 擬似(`DeterministicEmbeddingProvider`) |
| B | 擬似 | 本物(`text-embedding-3-small`) |
| C | 本物(`gpt-4o-mini`) | 本物(`text-embedding-3-small`) |

arm ごとに別テナントを使う。outbox は `tick()` の `processed === 0` まで繰り返して
干上がらせる——haystack の既定件数(`DEFAULT_HAYSTACK_SIZE`)は `tick()` の既定 `limit`
(50、`packages/core/src/runtime.ts` の `DEFAULT_TICK_LIMIT`)を超えており、
`ingestConversation`(`chat`/`compare` が使う、`tick()` を1回しか呼ばない実装)のままでは
51件目以降が埋め込まれずに残ることを、`retrieval` 自身が実行結果として示す。

呼び出し回数・トークン・USD の実測(`src/usage-meter.ts`。費用は2026-09時点の公開価格を
コードに書いた定数表による概算であり、OpenAI の請求 API から取得した実額ではない)を
arm ごとに画面へ出す。擬似 provider だけの arm(A)ではその旨を明示する
(「OpenAI の API は一切叩いていない」)。

### 実測結果（2026-09-06、本物の `gpt-4o-mini` / `text-embedding-3-small`(256次元)）

観測 74件（gold 7 + distractor 7 + haystack 60）。`recall()` は既定（`limit`=10）。
**閾値・件数・over-fetch は一切いじっていない。**

| arm | LLM | Embedding | MRR（全体） | MRR（対照群・語彙が重なる1件） | MRR（語彙が重ならない6件） |
|---|---|---|---|---|---|
| **A（＝ `compare` と同じ配置）** | 擬似 | 擬似 | **0.018** | **0.000** | 0.021 |
| **B** | 擬似 | 本物 | **0.714** | 1.000 | 0.667 |
| **C（実運用の配置）** | 本物 | 本物 | **0.743** | 1.000 | 0.700 |

probe ごとの gold の順位（`(無し)` は `recall().memories` に返らなかったことを表す）:

| probe | 語彙が重なるか | A | B | C | distractor が gold より上（C） |
|---|---|---|---|---|---|
| color（好きな色） | **重なる（対照群）** | **(無し)** | 1 | 1 | いいえ |
| pet（ペット） | 重ならない | (無し) | 1 | 1 | いいえ |
| exercise（運動の習慣） | 重ならない | (無し) | 2 | 2 | **はい** |
| diet（避けるべき食べ物） | 重ならない | (無し) | **(無し)** | 5 | **はい** |
| family（家族の居住地） | 重ならない | (無し) | 1 | 1 | いいえ |
| language（好きな言語） | 重ならない | 8 | 1 | 1 | いいえ |
| travel（次の行き先） | 重ならない | (無し) | 2 | 2 | **はい** |

#### 読み方1: 擬似 provider は、この物差しに対して目が見えていない

**arm A は7件中6件で gold を返せなかった。**残る1件も8位である。
**語彙が重なる対照群（色）ですら落ちた。**

**⟹ 上の「冒頭の事実が残るか ✅」の表は、
「意味的に関連する記憶が正しく上位に来た」ことを示していない。**
あの表の干し草は12種類の filler の使い回しだが、**別々の内容が60件並ぶとこの通り崩れる。**

**⚠ ただし、これは上の表を実行し直して否定したものではない。**測ったのは
新しい probe シナリオでの arm A であり、旧シナリオを多様な干し草で回し直してはいない。

#### 読み方2: 効いているのは埋め込みのほうである

**arm A → arm B で MRR が 0.018 → 0.714。**この間で変えたのは**埋め込みだけ**である。
arm B → arm C（LLM も本物に）の上積みは 0.714 → 0.743 と小さい。

**⟹ 北極星の物差しに対して: 本物の埋め込みでは hit@10 が 7/7。**
`limit`=10 は 74件の 13% であり、**87% を削っても目的の記憶は落ちなかった。**
擬似 provider で言えていたのは「量を1桁削っても落ちなかった」までだったが、
**本物では「意味で引いた上で落ちなかった」まで言える。**

#### 読み方3: ⚠ 悪い結果もそのまま——「話題は合うが、答えが違う」

**本物の埋め込みでも、7件中3件で distractor が gold より上に来た（hit@1 は 4/7）。**

| probe | 質問 | 1位に来たもの（distractor） | gold |
|---|---|---|---|
| exercise | 「私の運動の習慣はどんなものでしたか?」 | **「父は毎晩ウォーキングをしています。」** | 「毎朝5時に起きてジョギングをしています。」（2位） |
| diet | 「私が避けたほうがいい食べ物はありますか?」 | **「妻は卵アレルギーがあります。」** | 「牛乳を飲むとお腹を壊します。」（**5位**） |
| travel | 「次の遠出の行き先はどこでしたか?」 | **「先月は大阪へ出張しました。」** | 「来月、京都へ出張します。」（2位） |

共通する形が2つある。

1. **主語を見ていない。**「私の」と聞いているのに「父は」「妻は」が先に来る。
   埋め込みの類似度は話題の近さを測っており、**誰の話かを区別しない。**
   `Ctx.subjectId` はスコープの次元として既に在るが、**埋め込みだけでは主語は分かれない。**
2. **時制を見ていない。**「次の」と聞いているのに「先月は」が先に来る。
   [docs/recall.md](../../docs/recall.md) §7 のスコアは
   `similarity × decay × tagMatch × freshness × strength` であり、
   **質問が未来を指しているか過去を指しているかを見る項が無い。**

**⟹ 「載せる量を削っても答えが残る」は言えるが、
「一番上に正しいものが来る」はまだ言えない。**この2つを混同しないこと。

**⚠ 標本は probe 7件である。**ここから一般的な失敗率は主張できない。
言えるのは**この失敗の形が実在する**ということまでである。

#### 実測した実費

| arm | chat 呼び出し | LLM tokens (in/out) | embeddings 呼び出し | embed tokens | USD |
|---|---|---|---|---|---|
| A | 0（API を叩いていない） | — | 0 | — | $0 |
| B | 0 | — | 81 | 2,154 | $0.000043 |
| C | 74 | 15,968 / 3,433 | 83 | 1,790 | $0.004491 |
| **合計** | 74 | | 164 | | **約 $0.0045（0.45セント）** |

3 arm 合わせて所要 約4分。**実費の 99% は LLM 抽出側であり、埋め込みは 1% に満たない。**
費用の内訳と、`compare` を本物で走らせた場合の実費は
[ADR 0019](../../docs/decisions/0019-real-openai-measurement-cost.md) にある。


---

## この会話生成（`src/scenario.ts`）について

`buildConversation(fillerPairs)` は乱数を使わない決定的な関数——同じ `fillerPairs` を
渡せば誰が実行しても同じ会話・同じ文字数になる（測定の再現性のため）。冒頭に1件だけ
「後から参照される事実」（好きな色・誕生日）を置き、その後に filler な世間話の往復を
`fillerPairs` 組並べ、最後に冒頭の事実を尋ねる質問を置く。

**決めたこと**: `observe()` するのは user の発話だけで、assistant の応答は取り込まない
（`ingestConversation` 参照）。実際のアプリケーションが「ユーザーが言った事実だけを
覚えさせ、assistant 側の文面は都度生成する」という使い方をする、という想定に基づく
裁量である。naive path（経路A）は逆に両方の発話を含む全 transcript を積む——
これは「今の普通のやり方」（会話ログを全部渡す）を模すためであり、両者に同じ会話を
与えつつ、経路ごとに扱いが違うのは意図的である。

---

## 設計上の決めたこと（本 PR の裁量）

- **`ingestConversation`（取り込み）と `queryRecall`（想起）を分離した。** 当初
  `runMnemoraPath` に両方を混ぜていたところ、`budget` 有り/無しで2回 recall を試すために
  同じ会話をもう一度 `observe()` してしまい、Memory が重複するバグを自分で踏んだ
  （`externalId` を設定していなかったため）。修正として `externalId: turn-${index}` を
  付けて冪等にした上で、取り込みと想起を別関数に分けた。**この経緯は
  `src/mnemora-path.ts` のコメントに残してある。**
- 会話の長さを変えて測る際（`runComparison`）、**長さごとに別のテナントを使う。**
  同じテナントに会話を積み増すと、後の計測が前の会話の記憶を引きずり、
  「その長さの会話単体で何文字になるか」を独立に測れなくなるため
  （`src/compare.ts` 参照。この分離が効いていることは
  `src/__tests__/compare.postgres.test.ts` の「長い会話を先に測ってから短い会話を測る」
  テストで検査している——短い方を先に測る順序ではこの種のバグを検出できないことに、
  実際にテストを書く過程で気づいた）。

---

## 本 PR で見つけて直した既存の不具合

`@mnemora/core` の `package.json` に `"type": "module"` が無く、`dist/` が
CommonJS として出力されていた（他の3パッケージ——`@mnemora/openai`・`@mnemora/postgres`・
`@mnemora/testkit`——はいずれも `"type": "module"` を持ち ESM を出力する）。

このサンプルアプリが `tsx` で `dist` を実際に実行する初めての利用者になったところ、
`import { heuristicTokenCounter } from "@mnemora/core"` が
`SyntaxError: does not provide an export named 'heuristicTokenCounter'` で落ちた
（プレーンな `node` 経由の ESM import では問題が顕在化せず、`tsx` のローダー経由でのみ
再現した——CJS→ESM 相互運用の名前付き export 検出が、ローダーの実装によって挙動が
変わるため）。これまでの `packages/*` のテストはすべて `vitest.config.mts` が
`@mnemora/core` を `src` へ直接エイリアスしており、`dist` を経由する経路が
一度も検査されていなかった。`packages/core/package.json` に `"type": "module"` を
追加し、`dist/index.js` が名前付き `export` 文を持つ本物の ESM になることを確認して
修正した。**新しい ADR は起こしていない**——既存のどの ADR の決定も覆していない、
実装側の設定漏れの修正であるため。
