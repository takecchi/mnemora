# ADR 0554: 言語の事後検査（0490）の偽陽性を、記録の再生と手で作った境界の入力で測る（問24「基準は測ってから」）

- **状態**: 提案（Draft。オーナーの判断待ち）
- **日付**: 2026-10-03

クローンの委譲先（マネージャー mgr-021b84d7 の指示による担い手）が書いた。**オーナーの判断ではない。**この ADR は測定の記録と、基準を変えるときの材料であって、基準も `rule` の名前も何も決めていない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未測定】は測っていないこと。

## 問い【現物】

オーナーへの問24（言語の事後検査、[ADR 0490](./0490-language-mismatch-latin-letters-only.md)）の推奨は「拡張しない、基準は測定後、`rule` 名の解釈は要確認」だった。
この ADR は「基準は測定後」の測定をする。検査の本体は `packages/core/src/language-mismatch.ts` の `detectLanguageMismatchFromProfile` と `profileObservationLanguage`。呼び出し元は `runtime.ts` の `buildCreatedEventFor` だけで、`index.ts` からは export していない。
`rule` は `"cjk_observation_latin_content"` の1つで、次の6条件をすべて満たすと印が付く（以下、条件の番号はこの表のもの）。

| 条件 | 内容 | 既定の閾値 |
|---|---|---|
| 1a | 観測のかな・漢字が下限以上 | 4字 |
| 1b | 観測の かな・漢字 /（かな・漢字 + ラテン文字）が下限以上 | 0.3 |
| 2 | 本文にかな・漢字が無い | - |
| 3 | 本文に `CODE_MARKER`（バッククォート・括弧記号・`&&`・`=>`・`--flag`・パス）が無い | - |
| 4 | URL を除いた本文のラテン文字が下限以上 | 20字 |
| 5 | 本文の文字のうちラテン文字が下限以上 | 0.9 |
| 6 | `LOWERCASE_WORD = /^[a-z]+(?:'[a-z]+)?[.,!?;:]?$/` に合う語が下限以上 | 3語 |

⚠ 本体の TSDoc は「実データでの偽陽性率・取りこぼし率は測っていない」と書いている（ADR 0391）。この ADR もそれを埋めない。下のとおり、**この repo の材料では取りこぼし率は測れず、偽陽性率の測定も条件3〜6を1件も試せていない。**

## 測り方【実測】

- 測った commit: `fb17ef28dbf436acab96bb371e76af88b5783ac9`（main）に、測定のスクリプトを足した作業ツリー。本体（`packages/core/src/**`）・閾値・`rule` 名・検査の範囲は変えていない。
- 実行: `pnpm --filter @mnemora/example-chat run language-mismatch-measure`（実体は `examples/chat/src/scripts/language-mismatch-false-positive-measure.ts`。入力の手作りデータは隣の `language-mismatch-boundary-cases.ts`）。実 API・DB は使わない。
- ⛔ スクリプトは門ではない。CI にも package.json の `test` にも載せていない。終了コードは結果を見ない（常に 0）。件数・割合はファイルに保存せず、実行のたびに数え直して、数えた記録のパスと件数を出力が名乗る。
- 判定の正規表現（`CJK`・`LATIN`・`CODE_MARKER`・`LOWERCASE_WORD` など）は本体が export していないので、スクリプトに写した。写しがずれたら検知できるよう、全入力で「写しの最終判定」と本体 `detectLanguageMismatch` の戻り値（印の有無・`contentLatinLetters`・`contentLatinShare`）を突き合わせる。ずれが出たら出力の先頭に大きく出る。
- **突き合わせの結果**: 本体との突き合わせ: 371 件すべて一致（不一致 0 件。(a) と (b) の全入力で、最終判定と contentLatinLetters・contentLatinShare を比べた）
- 閾値の差し替えは、スクリプトの中の写しの側で行った。本体は変えていない。

## (a) 記録の再生での、実際に出た分布【実測】

鍵なしで読める、抽出の出力の記録を2つ数えた。

- カセット: `examples/chat/cassettes/*.json` の `llm.entries` のうち、`prompt.system` が抽出の system prompt で始まるもの。同じ (system, messages, value) は1つに数える。観測は `prompt.messages` の user の content。
- フィクスチャ: `packages/core/src/__tests__/fixtures/extraction-context-*recorded*.json`。応答（`response.message.content` の JSON 文字列、または `runs[*].response`）の `memories[].content`。観測は本体と同じ `observationPayloadText` で `observation.payload` から読んだ。同じ観測への同一の応答（複数 run が同じ文を返す）は1つに数える。

数えた記録（応答数と memory 数。1 memory = 1 本文 = 1 件）:

| 材料 | 記録 | 応答数 | memory 数（= 本文の数） |
| --- | --- | --- | --- |
| カセット | examples/chat/cassettes/answer.claim-key.after-on-v1-1.json | 29 | 33 |
| カセット | examples/chat/cassettes/answer.claim-key.separate-turn-off-1.json | 9 | 9 |
| カセット | examples/chat/cassettes/answer.claim-key.separate-turn-off-2.json | 2 | 2 |
| カセット | examples/chat/cassettes/answer.claim-key.separate-turn-off-3.json | 2 | 2 |
| カセット | examples/chat/cassettes/answer.claim-key.separate-turn-off-4.json | 1 | 1 |
| カセット | examples/chat/cassettes/answer.claim-key.separate-turn-off-5.json | 1 | 1 |
| カセット | examples/chat/cassettes/answer.claim-key.separate-turn-on-1.json | 1 | 1 |
| カセット | examples/chat/cassettes/answer.claim-key.separate-turn-on-2.json | 4 | 4 |
| カセット | examples/chat/cassettes/answer.claim-key.separate-turn-on-3.json | 1 | 1 |
| カセット | examples/chat/cassettes/answer.claim-key.separate-turn-on-4.json | 2 | 2 |
| カセット | examples/chat/cassettes/answer.claim-key.separate-turn-on-5.json | 2 | 2 |
| カセット | examples/chat/cassettes/compare.json | 10 | 9 |
| カセット | examples/chat/cassettes/retrieval.json | 74 | 75 |
| フィクスチャ | packages/core/src/__tests__/fixtures/extraction-context-eval-agreement-recorded.json | 40 | 38 |
| フィクスチャ | packages/core/src/__tests__/fixtures/extraction-context-eval-coverage-recorded.json | 8 | 6 |
| フィクスチャ | packages/core/src/__tests__/fixtures/extraction-context-eval-factors-recorded.json | 60 | 61 |
| フィクスチャ | packages/core/src/__tests__/fixtures/extraction-context-eval-more-recorded.json | 51 | 53 |
| フィクスチャ | packages/core/src/__tests__/fixtures/extraction-context-recorded.eval.json | 10 | 7 |
| フィクスチャ | packages/core/src/__tests__/fixtures/extraction-context-recorded.json | 6 | 5 |

条件ごとに、どこで落ちたか（先の条件で落ちた本文は、後の条件を試されていない）:

| 材料 | N | 1aで落ちた | 1bで落ちた | 2で落ちた | 3で落ちた | 4で落ちた | 5で落ちた | 6で落ちた | 印あり |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| カセット | 142 | 0 | 0 | 142 | 0 | 0 | 0 | 0 | 0 |
| フィクスチャ | 170 | 0 | 0 | 170 | 0 | 0 | 0 | 0 | 0 |
| 合計 | 312 | 0 | 0 | 312 | 0 | 0 | 0 | 0 | 0 |

- 印が付いた件数 / N = 0 / 312
- 各条件に到達した（その条件を実際に試された）件数: 1a: 312 / 1b: 312 / 2: 312 / 3: 0 / 4: 0 / 5: 0 / 6: 0

### 0/N だが、境界は試されていない【判断】

**0/N を安全の証拠として読まないこと。**全件が条件2（本文にかな・漢字がある。つまり日本語で書かれている）で落ちた。条件3〜6は、この材料では **1件も試されていない**。印が付く側の入力が1件も無いので、陽性対照が無く、検査が「付けるべきものに付けられるか」も「付けるべきでないものに付けないか」も、この表からは何も言えない。
言えるのは、「日本語の観測に対して日本語で書かれた本文は、条件2で漏れなく印から外れる」ことだけで、これは条件2の定義そのものである。

### カセットの観測が近似である誤差の可能性【現物】

カセットの観測は `prompt.messages` の user の content から読んだ近似である。実際に検査が数える観測は `observationPayloadText`（`extractTitle: true` なら `title` + 本文、`extractData: true` なら `name` + `JSON.stringify(data)` に合成したもの）で、合成が記録に残らない。したがって、`extractTitle`・`extractData` の経路で作られた記録では、本物の観測とここで使った観測がずれている可能性がある。ずれ方は、かな・漢字・ラテン文字の数（条件1a・1b）に効く。`JSON.stringify(data)` はラテン文字（キー名）を増やして条件1bを落としやすくする向きにずれうる。【未測定】どの記録が合成の経路で作られたかは、記録から分からない。
ただし、この材料では全件が条件2で落ちているので、観測がずれても (a) の結果（0/N、全件が条件2）は、条件1a・1bを通る限り変わらない。この誤差が効くのは、将来、英文の本文を含む記録を数えるときである。
フィクスチャの観測は `observation.payload` そのもの（`extractionContext` は含まない。本体も含めない）なので、この誤差は無い。

## (b) 境界の例と当たり方【実測】

**これは「率」ではない。**境界を突くために手で作った入力で、分布ではない。母集団から選んだのでも、実データから抜いたのでもない。誤検出・取りこぼしの件数を、偽陽性率・取りこぼし率として読まないこと。

### ラベルの基準【判断】

ラベルは、検査の結果を見る前に、次の基準だけで目視で付けた（結果に合わせて直していない）。

- **付くべき**: 日本語（または中国語）の観測から、その言語で書くべき記憶が、別の言語の**散文**で書かれたもの。英語に限らない（スペイン語・ドイツ語・フランス語・ロシア語・ハングルの観測に対する英文も含む）。短くても、文として書かれていれば付くべき。URL・メールアドレス・数字を含んでいても、散文が別の言語なら付くべき。
- **付くべきでない**: 言語を持たないもの——固有名詞の羅列・書名・社名・識別子（大文字の ID、16進のハッシュ）・コマンド・コード・SQL・URL だけ・メールアドレスだけ・数字だけ。観測自体が英語主体のときの英文の本文。
- **割れる**: 次の場合は割れると書き、誤検出・取りこぼしの数に入れない。(1) 全語が大文字始まりの見出し。(2) コマンドやコード片の後ろに英語の散文が続く、またはコードを含む英文。(3) ローマ字で書かれた日本語。(4) 観測が短い（かな・漢字が4字以下）か、英語が混じって日本語の観測と言い切れない（割合が0.3の前後）。(5) 英文にキリル文字が混じる（ラテン文字の割合が0.9の前後）。
- 【判断】この基準は担い手が置いたもので、オーナーの判断ではない。特に「中国語の観測に対する英文も付くべき」「スペイン語の本文も付くべき」は、`rule` の名前（`cjk_observation_latin_content`）が指すものと、ADR 0391 が狙った「日本語の観測に対する英語の本文」の間にあり、後者だけを狙うなら変わる（下の「`rule` 名の解釈」）。

### 境界の例と当たり方

観測は、特に書いていなければ「来週の火曜日は大阪で取引先と打ち合わせをします。」。中国語・ハングル・英語主体・短い観測の入力は、表の id（`obs-*`）で、観測を `language-mismatch-boundary-cases.ts` に書いてある。「ラテン文字」「割合」は条件4・5に到達した入力だけに出る（到達しなければ `-`）。

| id | ラテン文字 | 割合 | 本文 | ラベル | 落ちた条件 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| en-prose-long | 54 | 1.00 | `The user will visit the Osaka office next Tuesday to meet a client.` | 付くべき | 印あり | 一致 |
| en-prose-habit | 60 | 1.00 | `He prefers working from home on Fridays and takes the train on other days.` | 付くべき | 印あり | 一致 |
| en-len-17 | 17 | - | `He likes the blue one.` | 付くべき | 条件4 | 取りこぼし |
| en-len-19 | 19 | - | `She likes the blue ones.` | 付くべき | 条件4 | 取りこぼし |
| en-len-20 | 20 | 1.00 | `She likes the green ones.` | 付くべき | 印あり | 一致 |
| en-len-21 | 21 | 1.00 | `She likes the green sofas.` | 付くべき | 印あり | 一致 |
| en-two-lower-words | 25 | 1.00 | `Alice Johnson works remotely` | 付くべき | 条件6 | 取りこぼし |
| en-four-lower-words | 36 | 1.00 | `Alice Johnson works remotely every Friday` | 付くべき | 印あり | 一致 |
| en-capitalized-sentence | 45 | 1.00 | `Meeting moved to Thursday afternoon at headquarters` | 付くべき | 印あり | 一致 |
| en-title-case-only | 38 | 1.00 | `Quarterly Sales Report Review Meeting Notes` | 割れる | 条件6 | （判断が割れる） |
| proper-nouns-hotel | 35 | 1.00 | `Tokyo Disneyland Resort Hotel MiraCosta` | 付くべきでない | 条件6 | 一致 |
| proper-nouns-people | 33 | 1.00 | `Alice Bob Carol David Emily Frank Grace` | 付くべきでない | 条件6 | 一致 |
| proper-nouns-products | 41 | 1.00 | `Mnemora Postgres OpenAI Anthropic Redis BullMQ` | 付くべきでない | 条件6 | 一致 |
| title-with-small-words | 35 | 1.00 | `The Lord of the Rings: The Return of the King` | 付くべきでない | 印あり | 誤検出 |
| company-with-small-words | 35 | 1.00 | `Bank of America and Bank of New York Mellon` | 付くべきでない | 印あり | 誤検出 |
| title-apostrophe | 34 | 1.00 | `Harry Potter and the Philosopher’s Stone` | 付くべきでない | 条件6 | 一致 |
| ids-uppercase | 12 | - | `ABC-1234 DEF-5678 GHI-9012 JKL-3456` | 付くべきでない | 条件4 | 一致 |
| hex-ids | 30 | 1.00 | `deadbeef cafebabe feedface baadf00d` | 付くべきでない | 印あり | 誤検出 |
| code-command-and | - | - | `npm run build && npm test` | 付くべきでない | 条件3 | 一致 |
| code-flags | - | - | `git commit --amend --no-edit before the release branch` | 割れる | 条件3 | （判断が割れる） |
| code-arrow | - | - | `const ids = items.map((item) => item.id);` | 付くべきでない | 条件3 | 一致 |
| code-backtick-prose | - | - | `Run `npm run build` before deploying the application to production` | 割れる | 条件3 | （判断が割れる） |
| code-sql | 26 | 1.00 | `SELECT name FROM users WHERE id = 1` | 付くべきでない | 印あり | 誤検出 |
| code-pip | 29 | 1.00 | `pip install requests numpy pandas` | 付くべきでない | 印あり | 誤検出 |
| code-kubectl | 33 | 1.00 | `kubectl get pods namespace production` | 付くべきでない | 印あり | 誤検出 |
| url-only | 0 | - | `https://example.com/docs/getting-started/installation-guide` | 付くべきでない | 条件4 | 一致 |
| url-short-prose | 9 | - | `Docs are at https://example.com/docs` | 付くべきでない | 条件4 | 一致 |
| url-with-prose | 31 | 1.00 | `See the documentation at https://example.com/very/long/path/to/some/page for details` | 付くべき | 印あり | 一致 |
| email-only | 21 | 1.00 | `tanaka.kenji@example.com` | 付くべきでない | 条件6 | 一致 |
| email-with-prose | 54 | 1.00 | `Contact tanaka@example.com or suzuki@example.org for the details` | 付くべき | 印あり | 一致 |
| numbers-heavy-prose | 25 | 1.00 | `Order 12345 shipped on 2026-04-10 for 48000 yen total` | 付くべき | 印あり | 一致 |
| numbers-only | 2 | - | `ID 4829-11 / 2026-04-10 / 48,000 / 3.5%` | 付くべきでない | 条件4 | 一致 |
| curly-apostrophe | 31 | 1.00 | `Kenji doesn’t think it’s Bob’s decision` | 付くべき | 条件6 | 取りこぼし |
| straight-apostrophe | 31 | 1.00 | `Kenji doesn't think it's Bob's decision` | 付くべき | 印あり | 一致 |
| curly-apostrophe-common | 36 | 1.00 | `She isn’t going to the Osaka office on Friday` | 付くべき | 印あり | 一致 |
| quoted-words | 34 | 1.00 | `Kenji replied "works fine" and "sounds good"` | 付くべき | 条件6 | 取りこぼし |
| quoted-words-pair | 34 | 1.00 | `Kenji replied works fine and sounds good` | 付くべき | 印あり | 一致 |
| parenthesized-words | 42 | 1.00 | `Kenji (the manager) approved (well-known) vendor Acme` | 付くべき | 条件6 | 取りこぼし |
| parenthesized-words-pair | 42 | 1.00 | `Kenji the manager approved well known vendor Acme` | 付くべき | 印あり | 一致 |
| hyphen-words | 52 | 1.00 | `The well-known state-of-the-art long-term high-quality solution` | 付くべき | 条件6 | 取りこぼし |
| hyphen-words-pair | 52 | 1.00 | `The well known state of the art long term high quality solution` | 付くべき | 印あり | 一致 |
| hyphen-words-mild | 43 | 1.00 | `Kenji prefers a well-known, long-term, low-cost option` | 付くべき | 印あり | 一致 |
| spanish-ascii | 54 | 1.00 | `El usuario prefiere trabajar desde casa los viernes por la tarde` | 付くべき | 印あり | 一致 |
| german-ascii | 46 | 1.00 | `Der Benutzer arbeitet freitags lieber von zu Hause aus` | 付くべき | 印あり | 一致 |
| spanish-accents | 40 | 1.00 | `Prefiere reunirse mañana, después también allí` | 付くべき | 条件6 | 取りこぼし |
| french-accents | 37 | 1.00 | `Il préfère être là dès demain à côté de l’école` | 付くべき | 条件6 | 取りこぼし |
| russian | 0 | - | `Пользователь предпочитает работать из дома по пятницам` | 付くべき | 条件4 | 取りこぼし |
| romaji | 29 | 1.00 | `Watashi wa Osaka ni ikimasu to itta` | 割れる | 印あり | （判断が割れる） |
| obs-chinese | 48 | 1.00 | `The user will go to Osaka next Tuesday for a client meeting` | 付くべき | 印あり | 一致 |
| obs-chinese-zh-content | - | - | `用户下周二要去大阪和客户开会` | 付くべきでない | 条件2 | 一致 |
| obs-korean | - | - | `The user will meet a client in Osaka next Tuesday` | 付くべき | 条件1a | 取りこぼし |
| obs-ja-4chars | 35 | 1.00 | `The user agreed to the proposal on Tuesday` | 割れる | 印あり | （判断が割れる） |
| obs-ja-2chars | - | - | `The user agreed to the proposal on Tuesday` | 割れる | 条件1a | （判断が割れる） |
| obs-english-with-jp-name | - | - | `The user asked to send the quarterly report to Tanaka by Friday afternoon` | 付くべきでない | 条件1b | 一致 |
| obs-share-over-0.3 | 55 | 1.00 | `The user wants weekly meeting notes for the Tanaka project review` | 割れる | 印あり | （判断が割れる） |
| obs-share-under-0.3 | - | - | `The user wants weekly meeting notes for the Tanaka project review` | 割れる | 条件1b | （判断が割れる） |
| obs-ja-quote-english | 44 | 1.00 | `Tanaka said "Hello world" to the staff at the front desk` | 付くべき | 印あり | 一致 |
| mixed-script-share-high | 27 | 0.90 | `She likes green sofas and tables ДОМ` | 割れる | 印あり | （判断が割れる） |
| mixed-script-share-low | 27 | 0.84 | `She likes green sofas and tables ДОМИК` | 割れる | 条件5 | （判断が割れる） |

入力 59 件の内訳（率ではない）: 一致 32 / 誤検出 6 / 取りこぼし 11 / 判断が割れる 10

見立て【判断】（率ではなく、例の読み方）:

- **誤検出（付くべきでないのに印が付いた）の型**: 小文字の語を含む書名・社名（`of`・`the`・`and`）、16進の識別子、記号を持たないコマンド・SQL。どれも、条件3（コード片）と条件6（小文字語3語）をすり抜ける。固有名詞の羅列（全語が大文字始まり）は条件6で正しく落ちる。
- **取りこぼし（付くべきなのに印が付かない）の型**: 20字未満の短い英文（条件4）、小文字語が2語以下の英文（条件6）、`’`・囲み語・ハイフン語・アクセント付きの語で小文字語が数えられない英文（条件6、次節）、ラテン文字でない言語・ハングルの観測（検査の範囲外）。

## `’` と囲み語で漏れる入力【実測】

条件6の `LOWERCASE_WORD` は `[a-z]` と ASCII の `'` だけを認め、語の前後の括弧・引用符、語の中のハイフン、アクセント付きの文字を認めない。次の英文（日本語の観測の下で、本文として）は、6条件のうち条件6だけで落ちる。対は、同じ文の `’` を `'` に、囲みやハイフンを外して作った。

| 漏れる文 | 落ちた条件 | 対（印が付く） |
|---|---|---|
| `Kenji doesn’t think it’s Bob’s decision` | 条件6（数えられた小文字語は `think`・`decision` の2語） | `Kenji doesn't think it's Bob's decision`（`doesn't`・`think`・`it's`・`decision` の4語で印あり） |
| `Kenji replied "works fine" and "sounds good"`（囲み語） | 条件6（`replied`・`and` の2語） | `Kenji replied works fine and sounds good`（印あり） |
| `Kenji (the manager) approved (well-known) vendor Acme`（括弧・ハイフン） | 条件6（`approved`・`vendor` の2語） | `Kenji the manager approved well known vendor Acme`（印あり） |
| `The well-known state-of-the-art long-term high-quality solution`（ハイフン語） | 条件6（小文字語は `solution` の1語だけ） | `The well known state of the art long term high quality solution`（印あり） |

⚠ 漏れは、1文に小文字語が少ないときだけ起きる。`She isn’t going to the Osaka office on Friday` や `Kenji prefers a well-known, long-term, low-cost option` は、`’`・ハイフン語を含んでも、他の小文字語が3語以上あるので印が付く（`curly-apostrophe-common`・`hyphen-words-mild`）。
⚠ 想定外の漏れとして、**アクセント付きの文字を含む語**も数えられない（`[a-z]` は ASCII だけ）。`Il préfère être là dès demain à côté de l’école`（フランス語）と `Prefiere reunirse mañana, después también allí`（スペイン語）は、ラテン文字の割合が1.00で条件6だけで落ちた。ASCII だけで書けるスペイン語・ドイツ語の文は印が付いた。

## 取りこぼし率は、この repo の材料では測れない【判断】

**取りこぼし率（言語の取り違えなのに印が付かない割合）は、この repo の材料では測れない。**英文の本文（本当の陽性）が、repo の記録には1件も無いからである（(a) で全件が条件2で落ちたのが、その表れ）。(b) の手作りの入力は分布ではないので、率の代わりにならない。
測るのに要るもの: **英文の本文を含む実データ**。たとえば、利用側の `EventStore` の `created` イベント（`meta.languageMismatch` と、元の観測・本文）、ADR 0391 の問いの「4,556件中25件」の母集団。それを人の目でラベル付けすれば、取りこぼし率と、印が付いたものの偽陽性率の両方が測れる。この repo の外にあるので、この ADR は測っていない。【未測定】

偽陽性率についても、同じ理由で上限は置けない。(a) の0件は条件2が落としたもので、検査が付けるべきでないものに付けなかった証拠ではない。(b) の6件の誤検出は、型の存在を示すだけで、頻度を示さない。AGENTS.md の「偽陽性率に上限を置けない検査は、門にしない」に従い、この検査は今のまま「疑いの印」であり、門ではない。

## 基準を変えるなら何が動くか【実測】

変えない。**材料として**、スクリプトの中で閾値を1つずつ差し替え、(b) のどの判定が入れ替わるかを出した（本体は変えていない）。「LOWERCASE_WORD を広げる」は、語の前後の `("“‘` と `.,!?;:)"”’` を外したうえで `^[a-z]+(?:['’-][a-z]+)*$` に合えば小文字語とする試験用の版（アクセント付きは広げていない）。
「(a) の印あり」は、どの差し替えでも (a) が 0 件のまま動かないことを示す——**(a) からは基準の良し悪しは言えない**。

| 変えたもの | (a) の印あり | (b) の印あり | (b) の誤検出・取りこぼし | 判定が入れ替わった入力（現行→変更後） |
| --- | --- | --- | --- | --- |
| 条件4 ラテン文字の下限 20 → 10 | 0 / 312 | 31 | 誤検出 6 / 取りこぼし 9 | en-len-17（付くべき。なし→印あり）<br>en-len-19（付くべき。なし→印あり） |
| 条件4 ラテン文字の下限 20 → 15 | 0 / 312 | 31 | 誤検出 6 / 取りこぼし 9 | en-len-17（付くべき。なし→印あり）<br>en-len-19（付くべき。なし→印あり） |
| 条件4 ラテン文字の下限 20 → 30 | 0 / 312 | 22 | 誤検出 4 / 取りこぼし 14 | en-len-20（付くべき。印あり→なし）<br>en-len-21（付くべき。印あり→なし）<br>code-sql（付くべきでない。印あり→なし）<br>code-pip（付くべきでない。印あり→なし）<br>numbers-heavy-prose（付くべき。印あり→なし）<br>romaji（割れる。印あり→なし）<br>mixed-script-share-high（割れる。印あり→なし） |
| 条件6 小文字語の下限 3 → 2 | 0 / 312 | 35 | 誤検出 7 / 取りこぼし 6 | en-two-lower-words（付くべき。なし→印あり）<br>title-apostrophe（付くべきでない。なし→印あり）<br>curly-apostrophe（付くべき。なし→印あり）<br>quoted-words（付くべき。なし→印あり）<br>parenthesized-words（付くべき。なし→印あり）<br>french-accents（付くべき。なし→印あり） |
| 条件6 小文字語の下限 3 → 4 | 0 / 312 | 24 | 誤検出 3 / 取りこぼし 13 | en-four-lower-words（付くべき。印あり→なし）<br>company-with-small-words（付くべきでない。印あり→なし）<br>hex-ids（付くべきでない。印あり→なし）<br>code-sql（付くべきでない。印あり→なし）<br>hyphen-words-mild（付くべき。印あり→なし） |
| 条件6 小文字語の下限 3 → 5 | 0 / 312 | 19 | 誤検出 2 / 取りこぼし 17 | en-len-20（付くべき。印あり→なし）<br>en-len-21（付くべき。印あり→なし）<br>en-four-lower-words（付くべき。印あり→なし）<br>title-with-small-words（付くべきでない。印あり→なし）<br>company-with-small-words（付くべきでない。印あり→なし）<br>hex-ids（付くべきでない。印あり→なし）<br>code-sql（付くべきでない。印あり→なし）<br>email-with-prose（付くべき。印あり→なし）<br>straight-apostrophe（付くべき。印あり→なし）<br>hyphen-words-mild（付くべき。印あり→なし） |
| 条件5 ラテン文字の割合 0.9 → 0.8 | 0 / 312 | 30 | 誤検出 6 / 取りこぼし 11 | mixed-script-share-low（割れる。なし→印あり） |
| 条件5 ラテン文字の割合 0.9 → 0.95 | 0 / 312 | 28 | 誤検出 6 / 取りこぼし 11 | mixed-script-share-high（割れる。印あり→なし） |
| 条件5 ラテン文字の割合 0.9 → 1 | 0 / 312 | 28 | 誤検出 6 / 取りこぼし 11 | mixed-script-share-high（割れる。印あり→なし） |
| 条件1a 観測のかな・漢字の下限 4 → 2 | 0 / 312 | 30 | 誤検出 6 / 取りこぼし 11 | obs-ja-2chars（割れる。なし→印あり） |
| 条件1a 観測のかな・漢字の下限 4 → 8 | 0 / 312 | 28 | 誤検出 6 / 取りこぼし 11 | obs-ja-4chars（割れる。印あり→なし） |
| 条件1b 観測のかな・漢字の割合 0.3 → 0.2 | 0 / 312 | 30 | 誤検出 6 / 取りこぼし 11 | obs-share-under-0.3（割れる。なし→印あり） |
| 条件1b 観測のかな・漢字の割合 0.3 → 0.5 | 0 / 312 | 28 | 誤検出 6 / 取りこぼし 11 | obs-share-over-0.3（割れる。印あり→なし） |
| 条件6 LOWERCASE_WORD を ’・囲み語・ハイフン語へ広げる | 0 / 312 | 33 | 誤検出 6 / 取りこぼし 7 | curly-apostrophe（付くべき。なし→印あり）<br>quoted-words（付くべき。なし→印あり）<br>parenthesized-words（付くべき。なし→印あり）<br>hyphen-words（付くべき。なし→印あり） |

読み方【判断】:

- 条件4・6の閾値は、誤検出と取りこぼしを**入れ替える**だけで、同時には減らない。下限を上げると誤検出（`code-sql`・`hex-ids`・書名・社名）が減るが、取りこぼし（短い英文、`straight-apostrophe` のような普通の英文）が増える。下げると逆。
- 条件5・1a・1b は、(b) では割れる入力だけが動く。(b) のラベルでは、動いても誤検出・取りこぼしの数は変わらない。
- `LOWERCASE_WORD` を広げると、`’`・囲み語・ハイフン語の取りこぼしが減り、(b) では誤検出は増えなかった。ただし、(b) の入力は手で作ったもので、広げたときに新しく誤検出する型（たとえば、ハイフンでつないだ識別子や、引用符で囲んだコマンド）が (b) に無いだけかもしれない。【未測定】
- どれを選ぶかは、実データでの偽陽性率・取りこぼし率が測れてからである。この ADR は選ばない。

**判定が変わると、印の読み方が過去と変わる。**条件・閾値・`LOWERCASE_WORD` のどれを変えても、保存済みの `created` イベントの印（`meta.languageMismatch`）は書き換えない前提では、同じ `rule` の名前の印に、新旧2つの規則の結果が混ざる。したがって [ADR 0391](./0391-language-mismatch-mark-on-created-event.md) の引き受けた負債（「規則を変えたら `rule` の名前を変えること」）と、[ADR 0490](./0490-language-mismatch-latin-letters-only.md) が `rule` を変えなかった判断が、再び問いになる。この ADR は答えない。

## 「`rule` 名の解釈は要確認」の材料【現物・実測】

1. **名前は言語を区別しない。**`cjk_observation_latin_content` が指すのは、観測の「かな・漢字」と本文の「ラテン文字」だけである。(b) では、中国語の観測に対する英文（`obs-chinese`）も、日本語の観測に対するスペイン語・ドイツ語（`spanish-ascii`・`german-ascii`）も、ローマ字の日本語（`romaji`）も、印が付いた。「日本語の観測に対する英語の本文」という ADR 0391 の動機より、名前も検査も広い。逆に、ハングルの観測・ラテン文字でない本文（ロシア語）は範囲の外である。
2. **TSDoc と運用が対立している。**`LanguageMismatch.rule` の TSDoc は「判定規則の名前（規則を変えたときに、過去の印と区別できるようにする）」と書く。ADR 0391 の負債も同じ。一方、ADR 0490 は、数え方の修正は規則の変更ではないとして `rule` を変えなかった（0490 の追記も同じ）。`rule` が「規則を変えたら変える」ものなら、条件・閾値・`LOWERCASE_WORD` の変更は改名の対象になるはずで、「変えない」運用はこの TSDoc と合わない。どちらが正かは、オーナーの判断になる。
3. 材料として、上の「基準を変えるなら何が動くか」の表は、変えると印の付く入力が変わることを示す。変えないなら `rule` の意味は「いまの規則」に固定され、変えるなら改名か、印の読み手への注意が要る。

## 判断したこと（担い手）【判断】

- 測るだけで、検査の本体・閾値・`rule` 名・範囲は変えない。
- スクリプトは門にしない。CI にも `test` にも載せない。終了コードを結果で変えない。出力に、数えた記録のパスと件数、本体との突き合わせの結果、0/N の読み方の警告を焼いた。
- 件数・割合は、この ADR（日付と commit を付けた記録）にだけ書き、スクリプト・生成物には書かない。
- ラベルは結果を見る前に付けた。判断が割れるものは割れると書いた。
- CHANGELOG は書かない: 公開 API・振る舞いに変更が無い（`examples/chat` は private）。ファイルの作法（「利用者に見える変更だけを載せる」「`[0.3.0]` 以降は publish 対象のパッケージの変更だけ」）に当たらない。

## 採らなかった案

- 本体に正規表現を export して写しをやめる案: 本体に触れない条件のため採らない。写しのずれは突き合わせで検知する。
- (b) を自動で作る案（文法規則や生成で量産する）: 率に見えてしまう。境界の例として手で作った。
- 英文の本文をこの repo の記録へ足す案: 実 API の鍵が要る録画になる。この ADR の範囲外。

## 残っていること【未測定】

- 英文の本文を含む実データでの、取りこぼし率と偽陽性率（利用側の `EventStore` の `created`、ADR 0391 の母集団）。
- 基準（閾値・`LOWERCASE_WORD`）を変えるか。変えるなら `rule` を改名するか。オーナーの判断。
- アクセント付きの語（フランス語・スペイン語）が条件6で数えられないことを、取りこぼしとして扱うか。

## これが覆るとしたら何が起きたときか

- 英文の本文を含む実データで測ったとき、(b) の見立て（誤検出の型・取りこぼしの型）と違う型が多く出たとき、この ADR の「何が動くか」の表は役に立たない。
- カセットの観測の近似が、実際の観測（`extractTitle`・`extractData` の合成）と大きくずれていると分かったとき、(a) の条件1a・1b の列は読み直す。

## 追記（2026-10-09）: オーナーは推奨を採った。基準は変えず、`rule` の TSDoc を運用に合わせた（[ADR 0698](./0698-owner-decisions-purge-scope-retention-tick-limit-rule-name.md)）

**決めたのはオーナーである**（まとめ問い c9335e43 の問13、2026-10-08。回答は「全部推奨で」）。この追記はクローンのマネージャーが書いた。上の本文は書き換えていない。状態欄も変えていない。

- 判定の基準（閾値・`LOWERCASE_WORD`・範囲）は変えない。`rule` の名前（`cjk_observation_latin_content`）も変えない。
- 「`rule` 名の解釈は要確認」の材料2（TSDoc と運用の対立）は、**運用（ADR 0490: 数え方の修正は規則の変更ではない）の側に TSDoc を合わせる**に決まった。`LanguageMismatch.rule` の doc を「判定の基準を変えたときに名前を変える。数え方の修正だけなら変えない」に直した。
- 「残っていること」の、実データでの取りこぼし率・偽陽性率と、アクセント付きの語の扱いは、この判断でも決まっていない。
