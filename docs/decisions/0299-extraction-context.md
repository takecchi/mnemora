# ADR 0299: 抽出文脈を観測と保存し、相対日付の暦計算をモデルから分ける

- **状態**: 提案
- **日付**: 2026-09-24

## 問題と決定

Issue #689。単独発話だけでは同意の対象・相対日時を解決できない。
`extractionContext` を任意入力に追加し、既存の observation payload に保存する。
sync/deferred/reextract は同じ保存値を見る。DB列は増やさない。
省略時は旧プロンプトを維持する。空オブジェクトでも明示的な有効化になる。
上限はスキーマが定め、文脈を黙って切り捨てず入力エラーにする。

呼び手が選んだ文脈だけを使う。テナント全履歴の自動取得は費用と対象範囲を
制御できないため採らない。文脈の他人の発言は新しい観測として抽出しない。
話者と観測日時は構造化して渡す。相対日付は occurredAt と IANA timeZone が
両方ある場合だけ計算する。recordedAt による代用は過去ログの取込みで誤るため採らない。
暦日の計算はコードで行い、対象・選択の意味判断はモデルに残す。

## 評価と引き受けた負債

gpt-4.1-mini-2025-04-14で、同意・日付境界・別話者の3開発ケースを旧/新で比較。
初回は新経路でも同意が0件、日付が1日ずれた。2回目は同意を保持したが日付は誤った。
現地日付に加えて相対日付の計算結果を渡した3回目では、同意対象・正しい翌日・
対象話者の好みをdigestに保持した。記録はcoreのextraction-context-recorded.json。
これは見て調整した開発ケースであり、未知の会話の品質保証ではない。
入力不足・複雑な時間表現・多義的参照の意味的精度は未評価。

coreの契約テストでは文脈保存を外す変異でsync/deferredの2件が失敗し、復元で成功。
実Postgresでもruntimeを作り直してdeferred/reextractの同一プロンプトを確認。
記録した応答と現行プロンプトの一致・答えを含むdigestは通常coreテストで検査する。
API記録手順は `node --env-file=.env scripts/record-extraction-context.mjs <output>`。
録音は手動のみ。実行上限とモデルはスクリプトが宣言する。

省略時の従来経路の弱点は残る。呼び手が必要文脈を選ぶ負担も残る。
既定変更は、既存カセットの再記録と独立した品質評価が揃ったとき再検討する。
プロンプトの指示は意味的正しさを保証しない。出典は対象観測を指し、文脈はそのpayloadで辿れる。

## 採らなかった案・覆る条件

全文自動投入と全カセット即時更新は採らない。原観測だけを保存して同期時のみ
文脈を渡す案も、再実行の意味が変わるため採らない。
利用側に文脈選択が成立しない実例、またはより小さい文脈での独立評価が得られたら再設計する。

## 引き継ぎ（2026-09-24〜25）

このドラフト（当時 ADR 0293、コミット `e22890c`/`4f528f8`、最終 push
2026-09-24T15:33Z）は、別セッションが作業を止めたまま PR #694 として残っていた。
**このセッションは、それを作り直さずに引き継いだ。**

出自を一人称で名乗る: 本セッションは Claude Code である。起こしたのは、オーナー
takecchi の依頼を受けたクローン（takecchi の価値観を写した代理）であり、
[ADR 0220](./0220-issue-comment-author-identity-owner-vs-agent-not-distinguishable-from-author-name.md)
に倣えば、投稿者欄・commit 上の `takecchi` はここでも人間本人とクローンの両方を
指しうる——**この ADR とこの PR の投稿者名から、どちらが書いたかは判別できない。**

引き継いで行ったこと:

1. `docs/decisions/` の番号衝突を解消した。`origin/main` が先に 0293〜0294 を
   使っていたため（PR #686・#695）、`scripts/adr-renumber.mjs` の流儀で本 ADR を
   0293 → **0295** へ付け替え、`scripts/generate-adr-index.mjs` で索引を再生成した。
   本節の直前までの日付欄の誤り（コミット時刻は JST 2026-09-25 00:33〜だが、
   UTC の暦日は 2026-09-24）も直した。
2. Issue #689 が挙げる4つの回帰ケースのうち、このドラフトに無かった「文脈なし
   （捏造しない）」を契約テストとして足した。
3. 期待値と根拠を、実装より前に定義する（Issue の完了条件）体裁で、下の表として
   明文化した。
4. 変異試験を、不足側1本・やりすぎ側6本の計7本に広げた（元は不足側1本だけ
   だった）。結果は下の表。

### 期待値と根拠（マネージャーが実装前に定義し、本セッションが ADR とテストへ書き込んだ）

| # | ケース | 入力 | 期待 | 根拠 |
|---|---|---|---|---|
| 1 | 文脈付き参照 | context: assistant「会議室は青葉でよいですか？」／本文: 田中「それでお願いします」 | 田中を対象とする記憶に「青葉」が入る。assistant を選択者にしない | 同意の対象は文脈でしか決まらない |
| 2 | 相対日時 | occurredAt: 2026-01-01T23:00Z、tz: Asia/Tokyo、本文「明日は大阪へ出張」 | 出張日は 2026-01-03 | JST ではその発話は 01-02。UTC のまま数えると1日誤る |
| 2' | tz/occurredAt 欠落 | 上記のどちらか一方だけを欠く | 暦日を確定しない（observedLocalDate/relativeDates は null）。recordedAt でも既定 tz でも代用しない | 過去ログの取込みで誤るため（recordedAt は発話日時ではない。既定 tz は発話の実際の tz と無関係） |
| 3 | 話者違い | context: 佐藤「コーヒーが好き」／本文: 田中「私は紅茶派」 | 田中の記憶は紅茶だけ。コーヒーを田中の stated にしない。文脈の発話から別の観測・記憶を作らない。出典（sourceObservationId 等）は対象の観測だけを指す | 話者を取り違えると事実を誤帰属する |
| 4 | 文脈なし | `extractionContext: {}`（messages 無し）で「それでお願いします」 | 具体的な対象を補わない | 契約として検査できるのは「プロンプトに捏造の材料が入らないこと」（context は空、日付は null）だけ。**意味評価（実際に対象を補わないか）は本セッションでは未評価** |

ケース1・3の意味評価（LLM が実際にどう応答するか）は、前セッションが録った
`extraction-context-recorded.json`（`reference`/`other-speaker`）で見ている
——ただし下の「未評価の範囲」の通り、これは見て調整した開発ケースである。
ケース2は `buildExtractionPrompt` の暦計算がコード側の純粋な計算であるため、
契約テストだけで（意味評価を経ずに）実装の正しさを検査できる。ケース4の
意味評価は本セッションを含め、まだどのセッションでも行っていない。

### 変異試験（本セッションで追加・実施）

`packages/core/src/extraction.ts` / `runtime.ts` を一時的に壊し、
`packages/core/src/__tests__/extraction-context.test.ts` を実行して赤を確認、
`cp` で退避した原本に戻して緑に戻ることを確認した（`git checkout` は使っていない）。

| # | 変異 | 側 | 結果 |
|---|---|---|---|
| M1 | `extractObservationPayload` が `extractionContext` を保存しない | 不足側 | 赤: 「sync/deferred and reextract retain context」2件（元からある歯） |
| M2 | `reextract` が保存済み observation から `extractionContext` を落として抽出する | 不足側 | 赤: 同上2件（`prompts[1]` が `prompts[0]` と一致しなくなる） |
| M3 | `occurredAt` が無いとき `recordedAt` で暦日を作る | やりすぎ側 | 赤: 「missing occurredAt alone does not fix a calendar date」（本セッションで追加） |
| M4 | `timeZone` が無いとき既定で `UTC` を使う | やりすぎ側 | 赤: 「missing timeZone alone…」と「no context: …」の2件（本セッションで追加） |
| M5 | `context.messages` を `observation.text` へ連結する | やりすぎ側 | 赤: 「case 3: own text/speaker are not replaced」（本セッションで追加）に加え、記録済みカセット3件中2件（`reference`/`other-speaker`）のプロンプト同一性も同時に壊れた——既存カセットが守る歯としても機能していた |
| M6 | 同一テナントの直前の観測を、呼び手が渡していなくても context へ自動で足す | やりすぎ側 | 赤: 「a later observer does not have a same-tenant prior observation silently folded…」（本セッションで追加。この機能自体は現物には無く、歯が効くことを確かめるための一時的な追加機能として入れて壊した） |
| M7 | 文脈の最後の発話者を、observation 自身が speaker を持たないときの speaker として渡す | やりすぎ側 | **最初は緑のまま残った**——既存テストは全て observation 自身が speaker を持つケースだったため、`observationSpeaker(observation) ?? <context由来>` の `??` の右側が一度も評価されていなかった。「an observation without its own speaker does not inherit a context speaker」を新たに足し、同じ変異を再度当てて赤になることを確認してから、歯として残した |

M7 以外はすべて、最初の1回で狙った歯が赤くなった。M7だけ、歯が無い
という発見そのものが変異試験の成果であり、その場で歯を足した
（AGENTS.md「線は「『出なかった』を根拠にするときだけ」である」の節が求める陽性対照は、
足した歯を同じ変異へもう一度当てて確認している）。

### 未評価の範囲

- **本セッションは実 API を1回も叩いていない**（API 鍵が無く、実 API の課金は
  オーナー領分であるため）。ケース1・2・3・4のいずれについても、本セッションに
  よる意味的な正しさの独立検証は無い。
- 前セッションが `extraction-context-recorded.json` に録った3件
  （`reference`＝ケース1、`relative-date`＝ケース2、`other-speaker`＝ケース3）は、
  上の「評価と引き受けた負債」に書かれている通り**見て調整した開発ケース**であり、
  未知の入力に対する独立評価ではない。本セッションもこの記録を改変・再録音して
  いない（既存カセットの偽造/改変は禁止事項）。
- **ケース4（文脈なし）の意味評価は、本 PR のどのセッションでも実施していない。**
  契約テストが検査しているのは「プロンプトに捏造の材料が入らないこと」だけであり、
  「LLM が実際に対象を補わずに応答するか」は未評価のまま Draft としている。
- 曖昧な参照・複雑な日時表現（例: 「来週の水曜」のような週跨ぎ）は、この PR の
  範囲でも前セッションの範囲でも評価していない。

## 独立意味評価（本セッション、2026-09-25）

上の「未評価の範囲」が指摘していた欠落——開発ケース（reference/relative-date/
other-speaker）は見て調整したものであり独立評価ではない、ケース4（文脈なし）は
どのセッションでも意味評価していない——を埋めるため、本セッションが実 API で
独立した意味評価を1回録音した。

出自を一人称で名乗る: 本セッションは Claude Code である。起こしたのは、オーナー
takecchi の依頼を受けたクローン（takecchi の価値観を写した代理）であり、
[ADR 0220](./0220-issue-comment-author-identity-owner-vs-agent-not-distinguishable-from-author-name.md)
に倣えば、この ADR・この PR の投稿者欄 `takecchi` は人間本人とクローンの両方を
指しうる——投稿者名だけからは、どちらが書いたか判別できない。

### 手順（順序を commit で示す）

1. `packages/core/src/__tests__/fixtures/extraction-context-eval-cases.mjs`
   （ケース・期待値・根拠）と、それを録るための
   `scripts/record-extraction-context-eval.mjs` を、**Issue #689 本文の完了条件だけを
   読み、`extraction.ts` のプロンプト実装は読まずに**書いて commit した
   （commit `0a7309b`）。開発ケースとは tenantId（`context-eval-independent`）・
   話題・文面を変えてある。
2. 上のコミット済みスクリプトを1回実行し、結果をそのまま commit した
   （commit `d0ef6a2`）。実行前に全10ケース分の費用を保守的に合算し（$0.050）、
   上限（$0.10）以内であることを確認してから、初めて実 API を呼んだ
   （1ケースにつき1回、計10リクエスト、試し撃ちはしていない）。
3. 録音結果に対する機械判定テスト
   `packages/core/src/__tests__/extraction-context-eval.test.ts` を、**録音結果を
   見たあとに**書いて commit した（commit `6598e20`）。ここで期待値
   （`extraction-context-eval-cases.mjs` の `expect`）はどのケースも変更していない
   ——判定に外れたケース（下記）も、期待値を結果に合わせて直すのではなく、
   テスト側で「既知の未達」として明示する扱いにした。

### 評価ケースと結果（10件、gpt-4.1-mini-2025-04-14、実測トークン合計6155、
実測ベース費用概算 $0.003、事前予約上限 $0.050／実行前ハード上限 $0.10）

| id | 類 | 入力の要旨 | 期待 | 結果 |
|---|---|---|---|---|
| eval-a1-restaurant-reference | a 文脈付き参照 | 店員「さくら亭でよいですか？」／田中「そこにしましょう」 | 「さくら亭」を含む | ✅ 通過 |
| eval-a2-meeting-time-reference | a 文脈付き参照 | assistant「19時からでいいですか？」／田中「それで大丈夫です」 | 「19時」を含む | ❌ **未達** —— stated として了承は拾えたが、digest/contentのどちらにも「19時」が残らなかった |
| eval-b1-relative-date-jst | b 相対日時 | occurredAt 2026-03-14T15:30Z、tz Asia/Tokyo、「明日は歯医者」 | 解決日 2026-03-16 を含む | ✅ 通過 |
| eval-b2-relative-date-ny-boundary | b 相対日時 | occurredAt 2026-06-30T02:00Z、tz America/New_York（UTCより遅れる境界）、「明後日に出発」 | 解決日 2026-07-01 を含む | ✅ 通過 |
| eval-c1-other-speaker-drink | c 話者違い | context 鈴木「ビール党」／田中「私はワイン派」 | 「ワイン」を含み「ビール」を含まない | ✅ 通過 |
| eval-c2-other-speaker-rhythm | c 話者違い | context 同僚「朝型人間」／田中「私は夜型人間」 | 「夜型」を含み「朝型」を含まない | ✅ 通過 |
| eval-d1-no-context-contrast-of-a1 | d 文脈なし（a1と対照） | a1と同一発話、context だけ空 | 「さくら亭」を含まない | ✅ 通過（memories自体は残したが場所を捏造しなかった） |
| eval-d2-no-context-contrast-of-a2 | d 文脈なし（a2と対照） | a2と同一発話、context だけ空 | 「19時」を含まない | ✅ 通過（何も記憶しなかった＝捏造の余地なし） |
| eval-d3-missing-timezone-no-date-fabrication | d 文脈なし | occurredAtあり・tzなし、「明日健診」 | 暦日文字列を含まない | ✅ 通過（何も記憶しなかった） |
| eval-d4-bare-consent-no-context-no-occurredat | d 文脈なし | context・occurredAtとも無し、「了解しました、そちらで」 | 他ケース由来の固有名詞・暦日文字列いずれも含まない | ✅ 通過（何も記憶しなかった） |

**9/10 通過。未達は eval-a2（文脈付き参照のうち、対象が「時刻」の場合）1件。**
同じ「参照解決」でも対象が「場所」（eval-a1、さくら亭）だと通っており、
「時刻」だと通らなかった——対象の種類によって参照解決の精度にむらがあることが、
本セッションで初めて実測された（開発ケースは場所の参照解決1件しか見ていなかった
ため、この非対称は見えていなかった）。

**重大な未達（捏造・他人の発話の stated 化）は無い。** d系4件はいずれも文脈が
無い/足りない状況で対象や日時を捏造せず、むしろ「何も記憶しない」という保守的な
振る舞いを3/4件で見せた。c系2件は他人の発話を対象話者の stated として取り込んで
いない。この評価結果を根拠に、Draft を外す（下記 PR 本文参照）。

### この評価の射程と限界

- ケースは10件・1話者（田中）・1タイムゾーン系列（Asia/Tokyo と America/New_York
  各1件）にとどまる。曖昧な参照・複雑な日時表現（週またぎ等）・3人以上の会話・
  長い文脈は引き続き未評価。
- 機械判定は文字列の包含/非包含・日付パターンの有無という一次の検査であり、
  「memories を返さない」ことが d系のように許容できる場合と、逆に本来拾うべき
  情報を拾わなかった場合（eval-a2 がまさにこれ）を、機械だけでは区別しきれない
  ——今回は根拠（rationale）を人が見て「拾うべきだった」と判定した。
- 1回の録音であり、同じ入力を複数回叩いた再現性（LLM出力のばらつき）は見ていない。

## 追記（Issue #704 / branch `fix/704-extraction-context-time`、2026-09-25）

Issue #704 は上の「未達: 文脈付き参照で、参照先が『時刻』のとき値が落ちる（eval-a2）」を
1回だけの録音（n=1）から起こしていた。本セッションはこれを引き受けて修正を試みる前に、
AGENTS.md「「出なかった」を、事象が無いことの証明にしない」節（陽性対照ではなく再現性の
話だが、同じ形——1回の観測だけで事象の有無を断定しない——が当てはまる）と、Issue #704
自身が「未評価の範囲」に挙げていた「出力のばらつき…今回は1回しか録っていない」を先に埋めた。

出自を一人称で名乗る: 本セッションは Claude Code である。起こしたのは、オーナー takecchi
の依頼を受けたクローンの委譲で動くマネージャーセッション（mgr-ba63c84b）からさらに切り出された
作業者セッションであり、ADR 0220 に倣えば、この ADR の投稿者名からはどのセッションが
書いたか判別できない。

### 1. 再現性の実測（`extraction.ts` は1バイトも変えていない）

`scripts/reproduce-extraction-context-eval-a2.mjs`（本セッションで新規に書いた、
チューニング用途ではない再現性測定専用スクリプト）で、eval-a2 と同一の入力を main の
`buildExtractionPrompt`（無変更）に対して5回叩いた。結果は
`packages/core/src/__tests__/fixtures/extraction-context-eval-a2-reproduction.json`
（実測 artifact としてコミット。AGENTS.md「⛔ 対象外 —— 実測して repo にコミットした
基準値」に当たる）に残した。**5/5 で「19時」が digest/content に残った**
（実行前の予約費用 $0.0252、上限 $0.10 以内であることを確認してから呼んでいる）。

この直前に、同じ入力・同じ無変更コードで、コミットしない使い捨てスクリプトでも1回
5回叩いており（このセッション内の別の5回、こちらは repo に残していない）、そちらは
4/5 だった。**合わせて2バッチ・計10回中9回、「19時」は残った。** 元の Issue #704 が
根拠にした録音（1/10 相当の1回）は、外れ値側の1回だったと考えるのが自然である
——**本セッションでは、`buildExtractionPrompt` の現行の文面が時刻の参照解決を
系統的に落とすという主張を支持する追加の証拠は得られなかった。**

### 2. 修正を実装する前に見つかった壁 —— カセット鍵が「context 分岐」全体を覆っている

Issue #704・本 ADR の上の節は「抽出プロンプトの context 分岐を直す」ことを前提にしていたが、
実装に入る前に次を確かめた:

- `packages/testkit/src/__fixtures__/cassette.ts` の `llmCassetteKey` は
  `PromptSpec`（`system` 全文 + `messages`）の SHA-256 で決まる。**部分一致ではない。**
- `buildExtractionPrompt` の「context を渡したときだけ出る部分」（`rawContext !== undefined`
  の分岐）は、**参照解決・相対日付・話者違いのどのカテゴリでも同じ1本の system 文面と
  JSON 構造を共有している。** カテゴリ別の分岐は無い。
- この分岐は `packages/core/src/__tests__/fixtures/extraction-context-recorded.json`
  （ADR 0299 が「評価と引き受けた負債」節で言及する開発ケース、`reference`/`relative-date`/
  `other-speaker` の3本、`enabled: true` 側）で**バイト単位の完全一致**として固定されている
  （`extraction-context.test.ts`「recorded development cases: prompt identity and retained
  answer information」、`buildExtractionPrompt(...)` を `toEqual(row.prompt)` で検査）。
  このうち `reference`（店員が「会議室は青葉でよいですか？」と提案し、田中が同意する）は、
  eval-a2（assistant が時刻を提案し、田中が同意する）と**構造的に同じカテゴリ
  （a: 文脈付き参照）である。**

⟹ **時刻の参照解決だけを狙って system 文面や JSON 構造に手を入れると、`reference` を
含む3本の recorded development cases 全部の「プロンプト再構築が記録と一致する」検査が
壊れる。** これは「context を渡したときだけ出る部分」に閉じた変更であっても避けられない
——**カテゴリで条件分岐する仕組みがそもそも無い**ため、a2 のためだけに文言を足せば、
その文言は `reference` にも同じように付く。

この `extraction-context-recorded.json` は、Issue の依頼文が「既存カセット」として
名指ししていた対象そのものであり、**書き換えないことが明示的な制約**になっている
（依頼文: 「既存の fixture やカセットは書き換えない」「既存カセットを書き換えないと
CI が通らない形になるなら、そこで作業を止めて報告すること」）。上の分析はその条件に
文字通り当てはまる。

### 3. 結論と、この session が止めた理由

1で見た通り、**現行のプロンプトが a2 を系統的に落とすという主張自体が、1回の観測に
基づく脆いものだった**可能性が高い（10回中9回成功）。2で見た通り、**それでも
「時刻の扱いを強化する」ような一般的なプロンプト変更を試みれば、無関係な
`reference`/`relative-date`/`other-speaker` の recorded fixture を道連れに壊す。**

この2点を合わせ、本セッションは `extraction.ts` を変更せずに止めた。
`packages/core/src/__tests__/extraction-context-eval.test.ts` の `eval-a2-meeting-time-reference`
に対する `it.fails`（本 ADR 上の節「9/10 通過」参照）はそのまま維持している——単発の
録音に対する機械判定としては、その1回の記録で「19時」が欠けていたことは事実であり、
それ自体を書き換える理由は無い。変えたのは**その1回だけを根拠に「系統的な欠陥」と
断定しないための、追加の再現性データを残したこと**である。

### 4. 残された選択肢（オーナー/マネージャーの判断が要る点）

- **(a) 何もしない。** 再現性データにより、a2 は「時刻の参照解決を系統的に落とす
  プロンプト欠陥」ではなく「10回に1回程度の変動」である可能性が高いと分かった。
  Issue #704 のこの項目は、実装変更ではなく「観測が甘かった」として close してよいかもしれない。
- **(b) recorded development cases を再録音してでも直す。** `reference`/`relative-date`/
  `other-speaker` を意図的に道連れで書き換える——ADR 0299 決定・Issue の依頼文の両方が
  明示的に禁じている操作であり、少なくとも本セッションの権限では行わない。
- **(c) `buildExtractionPrompt` にカテゴリ別分岐を新設する。** 例えば「同意対象が具体的な
  値（時刻・数量等）であることを明示する」ような追加のオプトイン引数を足し、
  既存呼び出し（引数を渡さない）は1バイトも変わらないようにする。ただし
  a2 の入力自体（`extraction-context-eval-cases.mjs`、実装より前に確定済み）は
  そのようなオプトイン引数を渡していないため、a2 をこの経路で「直った」ことにするには
  **a2 の入力定義そのものを実装後に変える**ことになり、依頼文の「評価ケースは実装を見て
  調整しない」規律に触れる。設計として筋は通るが、この PR の a2 を直接救う手ではない。

本セッションは (a) を推奨するが、確定させるのはオーナー/マネージャーの判断である
（AGENTS.md「機械には『検出』まで——確定と書き込みは人に残す」と同じ理由。ここでの
「機械」は本セッション自身の分析にも当てはめている）。
