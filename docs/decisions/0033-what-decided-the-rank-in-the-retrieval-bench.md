# ADR 0033: `retrieval` ベンチが順位の理由を捨てていたのをやめる — 実際に順位を決めていた項の実測

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-06

**⚠ この文書の各主張には、出所を付ける。**「私が実行して確かめた」と
「作業者の報告として受け取った」を分ける（[AGENTS.md](../../AGENTS.md)「確かめていないことは
『確かめていない』と書く」の適用）。**節ごとに明示する。**

---

## 文脈

[ADR 0019 §7.5](./0019-real-openai-measurement-cost.md) は、本物の provider での
`retrieval` ベンチの結果をこう記録していた:

> **本物の埋め込みでも、7件中3件で distractor が gold より上に来た。**
> 共通する形が2つある: **1. 主語を見ていない。 2. 時制を見ていない。**

**この2つは、返り値から測ったものではなく、順位の表を人が読んで立てた解釈だった。**
そう書けたのは、**ベンチが順位しか記録していなかった**からである——
`runRetrievalQualityArm` は `goldRank` / `distractorRank` / `hit@1` / `hit@10` / MRR を
記録し、`recall()` が返した `RecalledMemory.score`（[docs/recall.md](../recall.md) §7 の
スコア内訳）と `explain` を**その場で捨てていた。**

**⟹ 北極星の問い3（この記憶が選ばれた理由を、後から説明できるか）を第一級と書いている
製品の、想起の質を測るベンチが、説明を捨てていた。**

---

## 決定

1. **`retrieval` ベンチは、順位と一緒にスコア内訳を記録・印字する。**
   `ProbeOutcome` に `scoreDetails`（gold / distractor / 1位の `ScoreBreakdown`）と
   `termSpreads`（返った候補全体で各項が取った値の幅）を足す。
2. **⚠ 閾値・重み・`limit`・`overFetchFactor` は1つも変えない。**
   足したのは**記録と印字だけ**である（[ADR 0022](./0022-fake-provider-compare-does-not-claim-recall-quality.md)
   の線: 見栄えの良い数字のために測る条件を選び直さない）。
3. **`termSpreads` を「幅」として出す。**「重みが小さい」と「候補間で差が付いていない」は
   別物であり、後者は**その項が順位に一切寄与していない**ことを意味する。
   幅が最大の項が、その `recall()` の順位を実際に決めた項である。
4. **項を持つ候補が0件のとき、`spread` を `0` と書かず `null` にする。**
   「差が無かった」と「測る対象が無かった」を同じ顔にしない
   （[ADR 0008](./0008-absence-taxonomy.md) の「無いには種類がある」の、この文脈への適用）。

---

## 1. 実測: 5項のうち4項は、この測定では動いていない

**出所: 私が実行した。**環境は §5 に明記する（本節の数字は**本物の PostgreSQL 17.9 +
pgvector 0.8.2 の HNSW 索引の上**で、本決定で足した計装を使って測ったものである）。

本決定で足した `termSpreads` の実出力（arm C、7 probe 分）:

```
color    : similarity=0.445818 decay=1.818e-5 tagMatch=0.000000 freshness=1.818e-5 strength=0.000000
pet      : similarity=0.206730 decay=1.782e-5 tagMatch=0.000000 freshness=1.782e-5 strength=0.000000
exercise : similarity=0.246424 decay=1.723e-5 tagMatch=0.000000 freshness=1.723e-5 strength=0.000000
diet     : similarity=0.128160 decay=1.122e-5 tagMatch=0.000000 freshness=1.122e-5 strength=0.000000
family   : similarity=0.190770 decay=1.536e-5 tagMatch=0.000000 freshness=1.536e-5 strength=0.000000
language : similarity=0.353909 decay=1.675e-5 tagMatch=0.000000 freshness=1.675e-5 strength=0.000000
travel   : similarity=0.191745 decay=1.231e-5 tagMatch=0.000000 freshness=1.231e-5 strength=0.000000
```

**`tagMatch` と `strength` の幅は 7 probe すべてで厳密に 0 である。**
**`decay` と `freshness` の幅は、7 probe すべてで互いに同一の値である。**
なぜそうなるかを、コードを読んで確かめた:

| 項 | 観測された値 | なぜそうなるか（コードを読んで確かめた） |
|---|---|---|
| `tagMatch` | **厳密に 1.000000** | ベンチは `recall(ctx, {text})` しか呼ばず、`tags` を渡さない。`computeTagMatch` は `1 + 0.1 × 一致数` なので、クエリタグが空なら常に 1 |
| `strength` | **厳密に 1.000000** | `buildNewMemoryFromCandidate`（`packages/core/src/extraction.ts`）が**無条件に `strength: 1`** を書く。ベンチは `observe({kind:'memory_usage'})` を呼ばないので強化も起きない |
| `freshness` | **`decay` と同じ値** | `freshness` の起点は `occurredAt ?? recordedAt`、`decay` の起点は `lastReinforcedAt ?? recordedAt`。`occurredAt` は全件 `null`（§4）、`lastReinforcedAt` も `null` なので、**両方とも `recordedAt` 起点の同じ数**になる |
| `decay` | 0.99998 前後（幅は 1.1〜1.8×10⁻⁵） | 半減期は既定の 720時間（`DEFAULT_HALF_LIFE_HOURS`）。取り込み全体が1〜2分で終わるので、最初と最後の Memory の差はこの桁にしかならない |
| `similarity` | 0.21 〜 0.69（幅は 0.128〜0.446） | 埋め込みのコサイン類似度（`1 - distance`） |

**⟹ `total = similarity × decay × tagMatch × freshness × strength` は、
この測定では実質 `similarity × decay²` であり、`decay²` は全候補でほぼ同一である。**

### 幅の比

hit@1 を落とした3件の、`total` の逆転幅（distractor − gold）:

| probe | distractor の total | gold の total | 逆転幅 | その probe の `decay` の幅 | 比 |
|---|---|---|---|---|---|
| exercise | 0.468811 | 0.449739 | **0.019072** | 1.723e-5 | 約 1110倍 |
| diet | 0.318255 | 0.206570 | 0.111685 | 1.122e-5 | 約 9950倍 |
| travel | 0.421283 | 0.388142 | 0.033141 | 1.231e-5 | 約 2690倍 |

**最小の逆転幅は exercise の 0.019072。**7 probe を通じて `decay` の幅の最大は 1.818e-5 なので、
**最も不利に取っても約1050倍の開きがある。**

**⟹ `decay` / `freshness` / `tagMatch` / `strength` のどれも、この3件のどれ1つ
順位を動かせない。**

**⟹ 「スコアが主語と時制を*見ていない*」のではない。スコアに*見る場所が無い*。**
この2つは違う——前者は重みの問題に見えるが、後者は**項を足しても入れる値が無い**という
構造の問題である。

---

## 2. 実測: 失敗3件の原因は、3件とも違う

**出所: 私が実行した。**各行は本物の `text-embedding-3-small`（256次元）に対する
反実仮想（片方だけを変えて測り直す）である。**probe set 自体は1文字も変えていない。**

**⚠ 反実仮想の相手に使った「gold / distractor」は、ある1回の実行で本物の `gpt-4o-mini` が
実際に作った `content` である。**抽出は実行ごとに揺れる（例: distractor の content は
「先月大阪へ出張した。」のときも「本人が先月大阪へ出張した。」のときもあった）。
**⟹ 下の絶対値は、その実行の content に対する値である。順位の向きは3回の実行すべてで
同じだったが、小数第3位まで再現するとは主張しない。**

### 2.1 travel — 時制。ただし**埋め込みは時制を見ている。向きが逆なだけ**

質問の表層だけを現在形に変え、記憶にもスコアにも触らずに測った:

| 質問 | gold「来月、京都へ出張する予定です。」 | distractor「本人が先月大阪へ出張した。」 |
|---|---|---|
| 「次の遠出の行き先はどこ**でしたか**?」（probe の実際の質問） | 0.3904 | **0.4057**（gold が負ける） |
| 「次の遠出の行き先はどこ**ですか**?」（表層だけ現在形にした反実仮想） | **0.4084**（gold が勝つ） | 0.3680 |

記憶側の時制を振っても一貫する（同じ質問に対し 先月-京都 0.4193 > 来月-京都 0.3904、
先月-大阪 0.4057 > 来月-大阪 0.3381）。

**⟹ 埋め込みは時制を符号化して照合している。**probe の質問が「次の」と言いながら
**表層は過去形「でしたか」**なので、埋め込みは表層に忠実に過去の記憶を上げている。

**🔴 だからといって質問文を書き直さない。**それは
[ADR 0022](./0022-fake-provider-compare-does-not-claim-recall-quality.md) が引いた
「測る条件を選び直さない」という線を越える。**しかも「〜でしたか」は日本語の想起質問として
自然であり、実運用で来る形である。**直すなら mnemora の側で直す。

### 2.2 exercise — 主語。ただし**埋め込みは主語の一致を見ている。gold に主語が無い**

| 質問 ＼ 事実 | 「毎朝…ジョギング」（主語なし） | 「**私は**毎朝…ジョギング」 | 「**父は**毎晩ウォーキング」 |
|---|---|---|---|
| **私の**運動の習慣は…? | 0.4496 | **0.5082** | 0.4717 |
| **父の**運動の習慣は…? | 0.3865 | 0.3662 | **0.5888** |
| 運動の習慣は…?（主語なし） | 0.4302 | 0.4229 | 0.4345 |

**⟹ 埋め込みは主語の一致を強く見ている**（「父の」で問えば「父は」が +0.20 で圧勝する）。
壊れているのは、**gold の主語が日本語のゼロ代名詞で落ちている**ことである——
「毎朝5時に起きてジョギングをしています。」には照合できる主語が存在しない。
**gold のゼロ代名詞を復元するだけで（0.4497 → 0.5083）distractor 0.4718 を抜く。**
スコアには一切触れない。

### 2.3 diet — **主語でも時制でもない。しかも差が最大**

| 事実 | cos |
|---|---|
| gold（arm C の実 content）「牛乳を飲むとお腹を壊す。」 | **0.2067** |
| gold に主語だけ復元「私は牛乳を飲むとお腹を壊す。」 | 0.2524（まだ負ける） |
| gold から推論を1つ作る「牛乳は避けたほうがよい。」 | **0.5946**（圧勝） |
| distractor「妻は卵アレルギーがある。」 | 0.3183 |

**記憶は症状を書いており、質問は帰結を訊いている。**主語の復元では届かない
（差 0.128 に対して +0.046）。

`recall()` の実出力では、gold は**4位**であり、その上に
**「妻は卵アレルギーがある。」**のほか、話題がまったく無関係な記憶が来ている
（DB を使わない再現では gold が9位で、その上に「好きな色は青」「妹の好きな色は緑です」が来ていた。§5）。
**⚠ diet の goldRank は実行ごとに揺れる**——
5（[ADR 0019 §7.2](./0019-real-openai-measurement-cost.md)）/ 9（DB 無しの再現）/ 7 / **4**（本測定）。
**抽出が本物の LLM である以上、content が実行ごとに変わるためだと読んでいる
（切り分けて確かめてはいない）。ただし「hit@1 = 4/7」と「外す3件が
exercise / diet / travel であること」は、4回とも変わらなかった**——
**⚠ この4回のうち、私が走らせたのは3回である。**残る1回は ADR 0019 の記録であり、
**私が実行したものではない。**

### 2.4 まとめ

| probe | gold の主語 | 主要因 | スコアの項を足せば直るか |
|---|---|---|---|
| exercise | **省略（ゼロ代名詞）** | gold に照合できる主語が無い | **いいえ**（抽出側） |
| diet | **省略** | 症状しか記憶にならず、帰結の推論が作られない | **いいえ**（抽出側） |
| travel | 省略（gold・distractor とも） | 質問が指す時間の向きを表す場所が無い | **いいえ**（§4。入れる値が無い） |

**⟹ ADR 0019 §7.5 が書いた「共通する形が2つある」は、成立しない。
3件の原因は3件とも違い、そのうち2件はスコアの問題ですらない。**

---

## 3. 実測: gold の主語が明示されている3件は、全部1位だった

**出所: 私が実行した。**

| gold の主語 | probe | arm C の goldRank |
|---|---|---|
| **明示**（「私の」） | color | 1 |
| **明示**（「私は」） | pet | 1 |
| **明示**（「弟は」） | family | 1 |
| 省略 | exercise | 2 |
| 省略 | diet | 4 |
| 省略 | language | 1 |
| 省略 | travel | 2 |

**🔴 ⚠ 標本は probe 7件である。ここから失敗率も成功率も主張しない。**
言えるのは「この対応がこの7件では成り立っていた」までであり、
**「主語が明示されていれば1位になる」ではない**（language は主語が省略されているが1位である——
話題の差 +0.12 で押し切っている）。

---

## 4. 実測: `occurredAt` は、この設計では原理的に常に `null` になる

**出所: 私が実行した（コードを読み、検索した）。**

- `ExtractedMemoryCandidateSchema`（`packages/core/src/extraction.ts`）に**時刻の欄が無い。**
  LLM は `content` / `digest` / `tags` / `provenanceKind` / `confidence` しか返せない。
- `buildNewMemoryFromCandidate` は `occurredAt: params.observation.occurredAt ?? null`。
  **発話の中の「来月」「先月」を読む経路はどこにも無い。**
- `Observation.occurredAt` は `observe()` の呼び出し側が渡すものだけ
  （`runtime.ts`: `occurredAt: input.occurredAt ?? null`）。
- **リポジトリ内で `observe()` に `occurredAt` を渡している箇所は 0件**
  （`packages/*/src` と `examples/*/src` を検索した。テストを含む）。
  **⚠ ただし列そのものが死んでいるわけではない**——`packages/testkit` の適合テストは
  `createMemory` に直接 `occurredAt` を渡して store の往復を検査している。
  **死んでいるのは `observe()` → 抽出 → `Memory.occurredAt` の経路である。**
- `recall-runtime.ts` は `effectiveTime = memory.occurredAt ?? memory.recordedAt` で
  `occurredAfter` / `occurredBefore` を当てている。

**⟹ `RecallQuery.occurredAfter` / `occurredBefore` は「いつの出来事か」を絞ると読める名前だが、
実際に絞っているのは「いつ言われたか」である。**「来月、京都へ出張する」を今日 observe すれば、
その Memory の `effectiveTime` は今日になる。

**⟹ 時制を扱う道具は既に在り、データが空のまま使えなくなっている。**
**これは travel が直るかどうかとは独立に、欄の名前が約束していることを値が満たしていない
という欠陥である。**（この repo で2度目である——`countKind: 'exact'` がリテラルで固定されたまま、
出どころが `hnsw.ef_search` に依存する値へ変わっても名乗りが変わらなかった件が1度目。
[ADR 0011](./0011-no-window-count-in-ann-stage.md)、および
[ADR 0029](./0029-reextract-skip-visibility.md) がその教訓を引いている箇所）

**この ADR ではこれを直さない。**別の変更として扱う。

### 4.1 測定が残した DB を、そのまま数えた

**出所: 私が実行した。**§5.1 の測定が `memories` に書いた 75件を、そのまま SQL で数えた
（推測ではなく行を数えている）:

```sql
SELECT count(*),
       count(*) FILTER (WHERE subject_id IS NOT NULL),
       count(*) FILTER (WHERE occurred_at IS NOT NULL),
       count(*) FILTER (WHERE cardinality(tags) > 0),
       count(*) FILTER (WHERE provenance->>'kind' = 'inferred')
FROM memories WHERE tenant_id = 'retrieval-quality-arm-c';
```

| 列 | 値が入っている件数 / 75 |
|---|---|
| `subject_id` | **0** |
| `occurred_at` | **0** |
| `tags`（非空） | 15 |
| `provenance.kind = 'inferred'` | **0**（75件すべてが `stated`） |

**⟹ 順位を決めうる構造化された列は、この会話では1つも埋まっていない。**
`tags` だけが15件で埋まっているが、**hit@1 を落とした3件の gold と distractor は
4件とも `tags = {}` である**（`毎朝5時に起きてジョギングをしている。` /
`父は毎晩ウォーキングをしている。` / `牛乳を飲むとお腹を壊す。` /
`妻は卵アレルギーがある。` のいずれも）。
**⚠ 一方 color の distractor には `{妹, 好きな色, 緑}` が付いていた**——
**`tags` に主語が入ることはあるが、入るとは限らない。**
「事実が誰について述べているか」を機械的に読める列は、この設計には無い。

**⟹ `Memory.subjectId` はこの穴を埋めない。**`Ctx.subjectId` は
「テナント内の整理の単位」＝**記憶の持ち主**であり（`docs/vision.md`「Tenant と Subject を
混同しない」の Discord の例では、ギルド内の各ユーザ）、**事実の指示対象ではない。**
「父は毎晩ウォーキングをしている」を私が話したなら、それは**私の**記憶であって
**父の**記憶ではない。

---

## 5. 実測の環境と、この測定が言えないこと

**出所: 私が実行した。**

### 5.1 主測定（Postgres の ANN 上）

`pnpm --filter @mnemora/example-chat run retrieval` を、**本物の PostgreSQL 17.9 +
pgvector 0.8.2**（HNSW 索引）に対して1回走らせた。§1〜§3 の順位とスコアはこれである。

| arm | LLM | 埋め込み | MRR(全体) | MRR(対照群) | MRR(非語彙) |
|---|---|---|---|---|---|
| A | 擬似 | 擬似 | 0.018 | 0.000 | 0.021 |
| B | 擬似 | 本物 | 0.714 | 1.000 | 0.667 |
| C | 本物 | 本物 | **0.750** | 1.000 | 0.708 |

**arm A・B は [ADR 0019 §7.1](./0019-real-openai-measurement-cost.md) の実測値と一致した**
（0.018 / 0.714）。**arm C は 0.743 → 0.750 とわずかに上がった**が、これは diet の goldRank が
5 → 4 に動いたことによるものであり、**hit@1 = 4/7 と、外す3件の顔ぶれは変わっていない。**

**⚠ ADR 0019 §7 の arm C 実測は PR #17 の時点で取られたものであり、その後に
recall パイプラインは3回変わっている**（PR #19 = [ADR 0023](./0023-subject-filter-in-ann-stage.md) 段1の subject 絞り、
PR #23 = [ADR 0026](./0026-ann-unreached-omission.md)、
PR #24 = [ADR 0027](./0027-split-superseded-forgotten-omission.md)。
`git log` で `recall-runtime.ts` / `retrieval-quality.ts` を触ったコミットを数えた）。
**さらに本 PR の作業中に PR #31（[ADR 0032](./0032-outbox-claim-lease.md)、outbox の claim に
リースを入れる）が main へ入ったため、その上へ rebase して測り直した。**
§1〜§3 の数字は rebase 後の head に対するものである。
**本測定はそれらを含んだ head での測り直しでもある。**

### 5.2 交差確認（DB を使わない再現）

Postgres を用意する前に、**同じ arm C を `packages/core` のテスト用フェイク store の上でも
1回走らせた。**同じ: `createRuntime` / `recall()` / `defaultScoringStrategy`、本物の
`gpt-4o-mini`、本物の `text-embedding-3-small`(256次元)、**距離はコサイン**
（`FakeVectorStore` は `cosineDistance` を使う＝pgvector の `<=>` と同じ）、probe set、
既定パラメータ。違う: store が Postgres でなく、**ANN が近似ではなく全走査**
（HNSW の取りこぼしが起きない分、Postgres より甘い）。

この配置でも **hit@1 = 4/7、外すのは exercise / diet / travel** だった。

**🔴 この2つを潰さないこと。**「コサイン距離・全走査の store 上での再現」と
「Postgres の ANN 上の測定」は**別の主張**である。片方が他方の証拠になるわけではない——
**同じ結論が2つの経路で出た、というだけである。**

### 5.3 実 API の呼び出し回数（usage-meter による実測）

| 何 | `chat.completions.create` | `embeddings.create` | USD |
|---|---|---|---|
| `retrieval`（Postgres、3 arm 合計） | 74回 | 82回 | $0.004502 |
| 同（DB 無しの交差確認） | 74回 | 90回 | $0.004499 |
| 反実仮想の測定（§2） | 0回 | 5回 | 約 $0.00001 |
| 抽出内容の確認（§6） | 6回 | 1回 | 約 $0.0003 |

**`compare`（[ADR 0019 §7.8](./0019-real-openai-measurement-cost.md) の $0.0321 の側）は
1回も走らせていない。**

---

## 6. この測定が、どの実装の根拠になるか

**⚠ ここに書くのは「測れたこと」までであり、実装の承認ではない。**

- **§2.3 の diet の数字は、推論（`inferred`）記憶を作る実装の根拠になる。**
  [roadmap.md §5.5](../roadmap.md) は 2026-09-06 のオーナー回答で
  **「既定の recall に含める。ただし `provenance.kind` で区別して返す」**に確定した。
  **⟹ 「含める」と答えた以上、推論記憶が存在しうることは前提として承認されている。**
  （この ADR を書いた時点より前は §5.5 が未決であり、推論記憶を作ることは
  **オーナーの判断の前提そのものを先に決めてしまう**ため保留されていた。その保留は解けた。）
- **⚠ 条件が付いている: `stated` と `inferred` を分けたまま返すこと。**
  §5.5 の追記のとおり、**いまの `RecalledMemory` は `provenance` を持たない**ため、
  この条件は現状の返り値では満たせない。**推論記憶を作る前に、そこが要る。**

### 実測: スキーマに在る ≠ 作られている

**出所: 私が実行した。**本物の `gpt-4o-mini` に、probe の gold / distractor 6発話を
`buildExtractionPrompt` そのままで抽出させた:

| 発話 | 返ってきた content | `provenanceKind` |
|---|---|---|
| 毎朝5時に起きてジョギングをしています。 | 毎朝5時に起きてジョギングをしている。 | `stated` |
| 父は毎晩ウォーキングをしています。 | 父は毎晩ウォーキングをしています。 | `stated` |
| 牛乳を飲むとお腹を壊します。 | 牛乳を飲むとお腹を壊す | `stated` |
| 妻は卵アレルギーがあります。 | 妻は卵アレルギーがある。 | `stated` |
| 来月、京都へ出張します。 | 来月、京都へ出張する予定である。 | `stated` |
| 先月は大阪へ出張しました。 | 先月、大阪へ出張した。 | `stated` |

**6発話すべてで `stated` が1件だけ返り、`inferred` は1件も作られなかった。**
**§4.1 のとおり、測定が残した 75件でも `inferred` は 0件である**（6発話だけの偏りではない）。

**⟹ `ExtractedMemoryCandidateSchema` は `provenanceKind: 'stated' | 'inferred'` を
最初から持っているが、実際の抽出は推論を作っていない。**
**スキーマに在ることと、作られていることは別である。**
この非対称は、スキーマを読んだだけでは見えない——実際に叩いて初めて見えた。

---

## 7. 検討した代替案

- **スコアに「主語一致」の項を足す。** 採らない。§2.2 が測ったとおり、
  **埋め込みは既に主語の一致を見ている。**足りないのは項ではなく、gold の側の主語である。
  項を足しても、比べる相手（構造化された「この事実は誰の話か」）が存在しない
  （`Memory.subjectId` は「テナント内の整理の単位」＝**記憶の持ち主**であり、
  **事実が誰について述べているか**ではない。`docs/vision.md`「Tenant と Subject を混同しない」）。
- **スコアに「時制」の項を足す。** 採らない。§4 のとおり、入れる値が無い。
  `occurredAt` を埋めるほうが先である。
- **`limit` や `scoreThreshold` を調整して 3件を通す。** 採らない。
  **7件のうち3件を通すように係数を回せば `hit@1` は上がるが、それは何も測っていない。**
- **`explain.stages` も記録する。** 今回は採らない。段の通過記録は
  「どの段で落ちたか」を答えるが、**順位の理由は答えない**。落ちた理由は
  `omitted`（ベンチは既に `omittedKinds` を記録している）が答える。
  **必要になったら足す。予約として型だけ置かない**（[ADR 0024](./0024-remove-exact-counts-option.md)）。

---

## 8. 引き受ける負債・覆えていない範囲

- **`retrieval` ベンチの検査は、`DATABASE_URL` が無いと走らない。**
  新しく足した純関数の検査（`examples/chat/src/__tests__/retrieval-quality-score.test.ts`）は
  DB を要求しないが、`examples/chat` には `test` スクリプトが無く `test:db` しか無いため、
  ルートの DB 無しの門はこのファイルを実行しない（[ADR 0015](./0015-root-test-gate-reports-skipped-db-tests.md)
  / [ADR 0016](./0016-db-test-gate-explicit-exclusion.md) が定めた分割。既存の
  `format.test.ts` 等も同じ扱いであり、本 ADR はこの分割を変えない）。
- **diet の goldRank が実行ごとに 5 / 9 / 7 と揺れる。**本物の LLM が作る `content` が
  実行ごとに変わるためだと読んでいるが、**そう読んでいるだけで、切り分けて確かめてはいない。**
- **§4 の欠陥（`occurredAt` が常に null）を直していない。**
- **§6 の条件（`RecalledMemory` が `provenance` を持たない）を直していない。**
- **[roadmap.md §5.4](../roadmap.md) の「テナント単位で保持期間を短縮できる口は必須」に対して、
  `TenantSettingsStore` にその経路が無い。**

---

## 9. これが覆るとしたら

- **埋め込みモデルを替えたとき。**§1〜§3 の数字はすべて
  `text-embedding-3-small`(256次元) に固有である。**§2.2 の「主語の一致を見ている」も、
  モデルの性質であって mnemora の性質ではない。**
- **抽出プロンプトを変えたとき。**§6 の「`inferred` が1件も作られない」は、
  いまのプロンプト（「それ以外の推論は `inferred` として区別してください」）に対する
  `gpt-4o-mini` の振る舞いである。
- **`recall()` に tags や `subjectId` を渡す呼び出し側が現れたとき。**
  §1 の「4項が定数」は、**このベンチの呼び方**（`recall(ctx, {text})` だけ）に対する
  観測である。**スコアリング戦略そのものの性質ではない。**
