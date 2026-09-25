# ADR 0306: ADR 0135 §8 の残件1〜3を実装する — CI ジョブ・summary script・基準値ファイルを配線し、「sparse/dense が完全一致し margin の min が正」という基準値の見た目の不自然さを実測で検証する

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

**⚠ 各主張の出所を分ける**（[ADR 0135](./0135-numeral-token-discriminator-probe-domain-design.md) と同じ体裁）。

- **【実測】** — この ADR の担当者が、この手元の器（in-memory ではなく、`docs/autonomy.md` の
  `initdb` 手順で立てた自分専用の Postgres 17 + pgvector 0.8.0 + `@mnemora/local-embedding` と
  `DeterministicLLMProvider`）に対して実際に走らせた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 前任の作業者が残したコード・コミットメッセージから、自分では再導出していない。

---

## 0. 引き継ぎの経緯

[ADR 0135](./0135-numeral-token-discriminator-probe-domain-design.md) §8「引き受けた負債・
残件」の1〜3（`numeral-token-probe-set.ts` 本体・`identifier-arm.ts` への `margin` 追加・
CLI サブコマンド/CI ジョブ/基準値ファイル/summary script の配線）のうち、前任の作業者は
1・2と CLI サブコマンドの土台（`cli.ts` の `runNumeralTokenProbes`）・仮の基準値ファイル
（`examples/chat/numeral-token-probe-baseline.json`）まで進めた状態で、API エラーにより
途中終了した(WIP コミット `5e8acc5`)。この ADR の担当者はそこから引き継ぎ、**残っていた
CI ジョブ・summary script の配線**（§8-3の残り）と、**マネージャーから明示的に指示された
検証**（前任の基準値ファイルで「sparse/dense の全指標が完全一致」「hit@1が3件外れているのに
margin の min が正」という2点が不自然に見える、原因を確かめよ）を行った。

**⟹ この ADR が新たに決めているのは3点だけである**（§1〜§3）。残りは前任の実装の検証
（§4）と、この ADR 自身の残件（§5）である。

---

## 1. 【実測】前任の基準値ファイルの「不自然さ」を検証した — 原因は margin の定義どおりの挙動であり、手書き・誤記ではない

マネージャーから、`numeral-token-probe-baseline.json` の次の2点が不自然に見えると
指摘された:

1. sparse/dense で MRR・hit@1・hit@10・margin の統計が**すべて同じ値**になっている。
2. hit@1 で3件（`kanji-medium-a`/`kanji-short-a`/`kanji-short-b`）外れているのに、
   margin の min が正である。

### 1.1 やったこと

この ADR の担当者は、`docs/autonomy.md` §2 の `initdb` 手順で自分専用の Postgres 17 +
pgvector 0.8.0 インスタンスを立て、**前任のコードを1文字も変えずに** `numeral-token-probes`
サブコマンドを2回実行した(`env -u OPENAI_API_KEY DATABASE_URL=... pnpm --filter
@mnemora/example-chat run numeral-token-probes`)。

### 1.2 分かったこと

- **2回の実行結果は `measuredAt`/`commit` を除いてビット一致した。**さらに、
  前任がコミットした `numeral-token-probe-baseline.json` とも(`label` フィールドの
  有無を除いて)完全一致した。**⟹ 基準値ファイルは手書き・改ざんされたものではなく、
  実際に CLI を走らせた出力そのものである。**
- **原因(1)(sparse/dense の一致)**: `NUMERAL_TOKEN_PROBE_SET_SPEC` は全18 probe の
  gold/distractor を**1本の共有会話**に ingest する(識別子集合・日本語固有名詞集合と
  同じ配線)。hit@1 で外れた3件は、**登録した distractor に負けたのではない**——
  `distractorBeatsGold` はこの3件を含め18件すべてで `false` であり、margin(gold−登録
  distractor の similarity 差)も18件全部が正(最小 `+1.048e-2`)。実際に1位を取ったのは、
  **同じ会話に同居する別セルの「兄弟」probe**である(例: `kanji-medium-a`(「総務部の
  三番窓口は…」)の1位は、ほぼ同じ語幹を持つ `arabic-medium-a` の gold 文
  「総務部の3番窓口は…」)。この兄弟 probe は sparse でも dense でも常に会話に居る
  ——haystack の違い(sparse=索引0件/dense=索引90件、ただし probe とは重ならない値域
  ——`numeral-token-probe-set.ts` の `DENSE_NUMERAL_TOKEN_FAMILIES` のコメント参照)は
  この3件の勝敗を**一切動かさない**。⟹ 2群の数字がビット一致するのは、haystack が
  「効いていない」からではなく、**この3件の勝敗を決めているのが haystack ではなく
  同じ会話内の兄弟 probe だから**である。
- **原因(2)(margin min が正)**: `computeMargin`(`identifier-arm.ts`)は
  `similarity(gold) − similarity(登録したdistractor)` であり、**「1位を取った候補」とは
  無関係**である(ADR 0135 §5.5 の定義どおり)。hit@1 の失敗が「別の probe の gold」に
  よるものである以上、margin は登録した distractor との差でしかなく、これが負に
  なる理由が無い。**⟹ margin の定義に矛盾は無く、「登録した gold/distractor 対では
  健全だが、名指ししていない近傍には敏感」という、まさに ADR 0135 §5.5 が二値と
  分布を併記する理由そのものの実例である。**

### 1.3 この発見の扱い

**この現象自体は前任の基準値ファイルの `provenance.note` に、この ADR の担当者が
確認した内容とほぼ同じ形で既に記録されていた**——前任は API エラーで作業を中断した
ものの、基準値の provenance には既にこの説明を残していた。**⟹ この ADR は「バグを
見つけて直した」のではなく、「前任の説明を独立に再現し、正しいことを確認した」もの
である。** ⚠ **`examples/chat/README.md` の `numeral-token-probes` 節にも同じ説明を
転記した**——README の読者は provenance の JSON を必ず開くとは限らないため。

**⟹ 決めたこと**: 基準値ファイル・実装のいずれも修正しない(修正すべき誤りが無い)。

---

## 2. CI ジョブ・summary script・基準値ファイルの配線(ADR 0135 §8-3 の残り)

前任が `cli.ts` に置いた `numeral-token-probes` サブコマンドと、
`numeral-token-json.ts`(機械可読な出力口)・`numeral-token-probe-baseline.json`(基準値、
§1で実測により正当性を確認した)は変更していない。この ADR で新たに足したのは:

1. **`.github/workflows/ci.yml` の `numeral-token-probes` ジョブ**——`identifier-probes`
   ジョブと**同じ形**(services/postgres・cache鍵の決定・モデル重みのキャッシュ・
   `if: always()` の summary/artifact ステップ・⛔ 相違では落とさない・🔴 重み取得
   失敗では意図して落とす)。**`identifier-probes` ジョブ自体には1文字も触れていない。**
   キャッシュキー空間は `identifier-probes`/`consolidation-cost`/`archive-sweep-cost`
   と**意図して共有する**(同じモデル `sirasagi62/ruri-v3-30m-ONNX` を使うため)。
2. **`scripts/numeral-token-probe-summary(-lib).mjs`**——`scripts/identifier-probe-
   summary(-lib).mjs` と同じ分担(純関数/CLIラッパー)・同じ規律(⛔ 門にしない、
   `weights_unavailable` と `measured` を型で区別、一致なら1行・違うときだけ展開)。
   **群は `sparse`/`dense` の2つだけ**(識別子集合の5群とは違う——ADR 0135 は第3の
   比較対象を持たない、§5.3)。比べる項目に `marginStats`(count/mean/stdDev/min)の
   4項目を追加した——`identifier-probe-summary-lib.mjs` には無い項目である。
3. **README**(`examples/chat/README.md` に `numeral-token-probes` 節、ルート
   `README.md` の「想起の質をどう測っているか」表に行を追加。数値は焼き込まず
   ADR 0135 と `numeral-token-probe-baseline.json` を指すだけにした。件数「18件」は
   `identifier-probes` 行の「30件」と同じ扱い(structural な事実として明示))。
4. **`AGENTS.md`** の「`local` を固定で使う3ジョブ」の記述を4ジョブへ更新した
   (`identifier-probes` / `numeral-token-probes` / `consolidation-cost` /
   `archive-sweep-cost`)——放置すると、この ADR がまさに戒めている「実装と文書の
   食い違い」をこの ADR 自身が新たに作ることになる。

**基準値ファイルとの一致は §1 の実測で確認済みであり、この ADR のために新たに測り直して
いない**(既に実測済みの値を再利用した——ADR 0094 §6「値を見てから調整しない」の
精神に反しないよう、CLI・probe・arm のいずれも変更していないため、同じ入力から同じ
出力が出ることは §1 の実測が既に示している)。

---

## 3. `identifier-arm.ts` の `margin` 追加が既存2集合を壊していないことを、変異試験で示した(ADR 0135 §8-2 の要求)

ADR 0135 §8-2 は「実装 PR では、既存2集合の出力が壊れないこと(既存の歯がすべて緑のまま)を
変異試験で示す必要がある」と明示している。前任のコード(`identifier-arm-margin.test.ts`
のコメント)は「変異試験で示した」と自認していたが、この ADR の担当者は**自分の手で
独立に**再確認した:

1. **`goldRank`/`distractorRank` の取り違え変異**(`identifier-arm.ts` の
   `goldRank = goldIndex === -1 ? null : goldIndex + 1` を `distractorIndex` に
   差し替える)→ `identifier-arm.postgres.test.ts`(本物の Postgres + pgvector に対して
   `IDENTIFIER_PROBES` 30件を実際に ingest/recall する既存の歯)が**赤くなった**
   (digest の取り違えを検出する assertion で失敗)。`cp` で退避してから戻し、
   同じ歯が緑に戻ることを確認した。
2. **`computeMargin` の減算→加算変異** → `identifier-arm-margin.test.ts` の3件が
   **赤くなった**。同様に戻して緑に戻ることを確認した。

**⟹ 既存の識別子集合の歯(本物の Postgres に対して実際に走る)は、この変更後も実際に
噛んでいる。**⚠ **日本語固有名詞集合には専用の postgres 歯が無く**(`identifier-arm.ts`
の `probeSet` オプションで走らせる形は CLI(`identifier-probes` サブコマンド)側でのみ
使われている)、この ADR の担当者は日本語固有名詞集合について**別途の postgres 歯を
新設していない**——理由は範囲外(§5「確かめていないこと」に明記)。

---

## 4. 検討して採らなかった案

- ⛔ **`.github/workflows/ci.yml` の `numeral-token-probes` ジョブの配線を検査する
  `ci-yml-*-wiring.test.mjs` 相当の歯(`scripts/__tests__/ci-yml-identifier-probes-
  wiring.test.mjs` は585行)を新設する。** 採らなかった——時間予算に対して見合わない
  と判断した。代わりに、この ADR の担当者は手作業で(a) YAML の段構造を
  `extractJob`/`parseSteps` と同じロジックで抜き出して段の名前・indent を確認し、
  (b) `numeral-token-probe-summary.mjs` を実測の JSON・基準値ファイルへ実際に対して
  走らせ、出力が期待どおりであることを確認した(§2)。**⟹ これは configuration drift
  を機械的に検出する歯ではなく、この ADR の担当者が1度確認した記録に留まる**——
  次に `ci.yml` の該当ジョブが書き換わっても、この PR の歯は何も検出しない。
  **この差は§5「引き受けた負債」に明記する(次の人への引き継ぎ)。**
- ⛔ **`examples/chat/README.md` の `numeral-token-probes` 節と基準値ファイルの
  食い違いを検出する freshness 歯(`scripts/identifier-probes-readme-freshness-lib.mjs`
  相当)を新設する。** 要らなくした——**README の節には実測値を1つも写さず、
  基準値ファイルを指すだけにした**(`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」)。
  写さなければ食い違いは起きない。`identifier-probes` 節が(Issue #425 で)踏んだ drift は、
  歯ではなく数を置かないことで避けた。
- ⛔ **日本語固有名詞集合相当の第3の比較対象をこの集合に追加する。** ADR 0135 §5.3が
  既に却下している(lexicalControl 相当の対照群は置かない)——この ADR はその決定を
  変えない。
- ⛔ **基準値ファイルの `note` を「原因が分かった」ことを理由に削る。** 採らなかった
  ——§1 で確認した内容は既に `provenance.note` に書かれており、消すと「なぜこの値で
  良いのか」の記録が失われる。この ADR は、その記録を独立に検証した記録として
  README にも転記する形を採った(§1.3)。

---

## 5. 引き受けた負債・確かめていないこと

1. **`numeral-token-probes` ジョブの CI 配線は、機械の歯で守られていない**
   (§4)——ジョブ名・env var 名・summary script の呼び出しが将来書き換わっても、
   検出する歯は無い。次にこの領域へ手を入れる人が、`identifier-probes` と同水準の
   厳密さを求めるなら、`ci-yml-identifier-probes-wiring.test.mjs` を写経して作る
   ことになる。
2. **README の `numeral-token-probes` 節には freshness 歯が無い**(§4)——数を写して
   いないので今は要らないが、後から誰かが数を書き足しても検出する歯は無い。
3. **日本語固有名詞集合(`japanese-name-probe-set.ts`)専用の postgres 歯は新設して
   いない**——`identifier-arm.postgres.test.ts` は `IDENTIFIER_PROBES` だけを対象に
   している。§3 の変異試験は識別子集合の歯でのみ確認しており、日本語固有名詞集合
   経由での確認は行っていない(CLI 経由での目視確認のみ——本 PR の作業ログに実行結果
   がある)。
4. **本番(Postgres + pgvector / HNSW)での `numeral-token-probes` の実測は無い**
   (ADR 0135 §8-4 が既に残件として明記している。この ADR は在庫のこの項目を
   減らしていない——§1 の実測はすべて自分専用の Postgres 17 + pgvector 0.8.0 の
   単一ノードに対するものであり、HNSW の近似性・テナント規模の影響は範囲外)。
5. **「第3の要因」**(ADR 0135 §3.3・§9 が残した、`long-kanji`/`long-kanji-2` の
   違いを生む機序)は、この ADR でも特定していない。
6. **「関係の反転」「否定」の設計**(ADR 0135 §7 が範囲外にした2領域)は、この ADR
   でも着手していない。

---

## 6. これが覆るとしたら

- **§4で挙げた「歯を持たない配線」(CI ジョブ・README)のどちらかで実際に drift が
  起きたとき。**`identifier-probes`(Issue #425)と同じ形の drift が起きたら、
  そのとき初めて専用の歯を作る判断をする——先回りして作らなかったこと自体を、
  この ADR は「時間予算に対する判断」として記録している(先送りが誤りだったとは
  主張しない)。
- **`numeral-token-probes` に閾値の門を検討する提案が出たとき。**ADR 0135 §8-6が
  既に「そのときにADR 0133 相当の揺れの実測を行う」と明記しており、この ADR は
  その判断を変えない。

---

Refs #109, ADR 0135
