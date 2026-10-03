/**
 * ADR 0554: 言語の事後検査（`packages/core/src/language-mismatch.ts`）の「境界の例」。
 * `language-mismatch-false-positive-measure.ts` が読む。⛔ テストではない（門にしない）。
 *
 * 各入力の `label` は、**検査の結果を見る前に**、ADR 0554 の「ラベルの基準」だけで目視で付けた。
 * 検査の結果に合わせて直していない。
 * - `should`    : 印が付くべき（日本語・中国語の観測から、その言語で書くべき記憶が、別の言語の散文で書かれた）
 * - `shouldNot` : 印が付くべきでない（固有名詞・コード・識別子・URL・書名など、言語を持たないもの。
 *                 観測自体が英語主体のもの）
 * - `split`     : 判断が割れる（割れる理由を `note` に書く）。誤検出・取りこぼしの数に入れない。
 *
 * ⚠ これは分布ではない。実データから抽いたものでも、母集団から無作為に選んだものでもなく、
 * 境界を突くために手で作った。件数や割合を「率」として読まないこと。
 */

export type BoundaryLabel = "should" | "shouldNot" | "split";

export interface BoundaryCase {
  readonly id: string;
  readonly group: string;
  readonly observation: string;
  readonly content: string;
  readonly label: BoundaryLabel;
  readonly note?: string;
}

const JA = "来週の火曜日は大阪で取引先と打ち合わせをします。";
const ZH = "我下周二要去大阪和客户开会。";

export const BOUNDARY_CASES: readonly BoundaryCase[] = [
  // --- 本当に取り違えた英文（長さ・語数の境界）---
  {
    id: "en-prose-long",
    group: "英文",
    observation: JA,
    content: "The user will visit the Osaka office next Tuesday to meet a client.",
    label: "should",
  },
  {
    id: "en-prose-habit",
    group: "英文",
    observation: JA,
    content: "He prefers working from home on Fridays and takes the train on other days.",
    label: "should",
  },
  {
    id: "en-len-17",
    group: "英文・20字の前後",
    observation: JA,
    content: "He likes the blue one.",
    label: "should",
    note: "短くても、英語の文として書かれている",
  },
  {
    id: "en-len-19",
    group: "英文・20字の前後",
    observation: JA,
    content: "She likes the blue ones.",
    label: "should",
  },
  {
    id: "en-len-20",
    group: "英文・20字の前後",
    observation: JA,
    content: "She likes the green ones.",
    label: "should",
  },
  {
    id: "en-len-21",
    group: "英文・20字の前後",
    observation: JA,
    content: "She likes the green sofas.",
    label: "should",
  },
  {
    id: "en-two-lower-words",
    group: "英文・小文字語の数",
    observation: JA,
    content: "Alice Johnson works remotely",
    label: "should",
    note: "主語と述語のある英文。小文字語は works / remotely の2語",
  },
  {
    id: "en-four-lower-words",
    group: "英文・小文字語の数",
    observation: JA,
    content: "Alice Johnson works remotely every Friday",
    label: "should",
  },
  {
    id: "en-capitalized-sentence",
    group: "大文字で始まる文",
    observation: JA,
    content: "Meeting moved to Thursday afternoon at headquarters",
    label: "should",
  },
  {
    id: "en-title-case-only",
    group: "大文字で始まる文",
    observation: JA,
    content: "Quarterly Sales Report Review Meeting Notes",
    label: "split",
    note: "全語が大文字始まりの見出し。見出しなら言語の取り違えとも言えるが、固有名詞の列とも読める",
  },
  // --- 固有名詞・識別子・書名（付くべきでない）---
  {
    id: "proper-nouns-hotel",
    group: "固有名詞の羅列",
    observation: JA,
    content: "Tokyo Disneyland Resort Hotel MiraCosta",
    label: "shouldNot",
  },
  {
    id: "proper-nouns-people",
    group: "固有名詞の羅列",
    observation: JA,
    content: "Alice Bob Carol David Emily Frank Grace",
    label: "shouldNot",
  },
  {
    id: "proper-nouns-products",
    group: "固有名詞の羅列",
    observation: JA,
    content: "Mnemora Postgres OpenAI Anthropic Redis BullMQ",
    label: "shouldNot",
  },
  {
    id: "title-with-small-words",
    group: "固有名詞（書名）",
    observation: JA,
    content: "The Lord of the Rings: The Return of the King",
    label: "shouldNot",
    note: "書名。of / the が小文字",
  },
  {
    id: "company-with-small-words",
    group: "固有名詞（社名）",
    observation: JA,
    content: "Bank of America and Bank of New York Mellon",
    label: "shouldNot",
    note: "社名の列。of / and が小文字",
  },
  {
    id: "title-apostrophe",
    group: "固有名詞（書名）",
    observation: JA,
    content: "Harry Potter and the Philosopher’s Stone",
    label: "shouldNot",
  },
  {
    id: "ids-uppercase",
    group: "識別子",
    observation: JA,
    content: "ABC-1234 DEF-5678 GHI-9012 JKL-3456",
    label: "shouldNot",
  },
  {
    id: "hex-ids",
    group: "識別子",
    observation: JA,
    content: "deadbeef cafebabe feedface baadf00d",
    label: "shouldNot",
    note: "16進の識別子。3語が小文字だけ",
  },
  // --- コード・コマンド ---
  {
    id: "code-command-and",
    group: "コード片",
    observation: JA,
    content: "npm run build && npm test",
    label: "shouldNot",
  },
  {
    id: "code-flags",
    group: "コード片",
    observation: JA,
    content: "git commit --amend --no-edit before the release branch",
    label: "split",
    note: "コマンドの後ろに英語の散文が続く。コード片か英文かで割れる",
  },
  {
    id: "code-arrow",
    group: "コード片",
    observation: JA,
    content: "const ids = items.map((item) => item.id);",
    label: "shouldNot",
  },
  {
    id: "code-backtick-prose",
    group: "コード片",
    observation: JA,
    content: "Run `npm run build` before deploying the application to production",
    label: "split",
    note: "コード片を含む英文。コードを含むので判定自体をしない設計だが、散文は英語",
  },
  {
    id: "code-sql",
    group: "コード片（記号なし）",
    observation: JA,
    content: "SELECT name FROM users WHERE id = 1",
    label: "shouldNot",
    note: "SQL。CODE_MARKER の記号を持たない",
  },
  {
    id: "code-pip",
    group: "コード片（記号なし）",
    observation: JA,
    content: "pip install requests numpy pandas",
    label: "shouldNot",
    note: "コマンド。記号なし・全語が小文字",
  },
  {
    id: "code-kubectl",
    group: "コード片（記号なし）",
    observation: JA,
    content: "kubectl get pods namespace production",
    label: "shouldNot",
  },
  // --- URL・メール・数字 ---
  {
    id: "url-only",
    group: "URL",
    observation: JA,
    content: "https://example.com/docs/getting-started/installation-guide",
    label: "shouldNot",
  },
  {
    id: "url-short-prose",
    group: "URL",
    observation: JA,
    content: "Docs are at https://example.com/docs",
    label: "shouldNot",
    note: "URL を除くと短い",
  },
  {
    id: "url-with-prose",
    group: "URL",
    observation: JA,
    content: "See the documentation at https://example.com/very/long/path/to/some/page for details",
    label: "should",
    note: "URL を含むが、散文は英語",
  },
  {
    id: "email-only",
    group: "メールアドレス",
    observation: JA,
    content: "tanaka.kenji@example.com",
    label: "shouldNot",
  },
  {
    id: "email-with-prose",
    group: "メールアドレス",
    observation: JA,
    content: "Contact tanaka@example.com or suzuki@example.org for the details",
    label: "should",
  },
  {
    id: "numbers-heavy-prose",
    group: "数字の多い文",
    observation: JA,
    content: "Order 12345 shipped on 2026-04-10 for 48000 yen total",
    label: "should",
  },
  {
    id: "numbers-only",
    group: "数字の多い文",
    observation: JA,
    content: "ID 4829-11 / 2026-04-10 / 48,000 / 3.5%",
    label: "shouldNot",
  },
  // --- ’ ・囲み語・ハイフン語（条件6の取りこぼし）。対は ' / 囲みなしに替えたもの ---
  {
    id: "curly-apostrophe",
    group: "’（U+2019）",
    observation: JA,
    content: "Kenji doesn’t think it’s Bob’s decision",
    label: "should",
  },
  {
    id: "straight-apostrophe",
    group: "’（U+2019）の対（' に替えた）",
    observation: JA,
    content: "Kenji doesn't think it's Bob's decision",
    label: "should",
  },
  {
    id: "curly-apostrophe-common",
    group: "’（U+2019）",
    observation: JA,
    content: "She isn’t going to the Osaka office on Friday",
    label: "should",
    note: "’ の語は1つ。他の小文字語が3つ以上ある",
  },
  {
    id: "quoted-words",
    group: "囲み語",
    observation: JA,
    content: 'Kenji replied "works fine" and "sounds good"',
    label: "should",
  },
  {
    id: "quoted-words-pair",
    group: "囲み語の対（囲みなし）",
    observation: JA,
    content: "Kenji replied works fine and sounds good",
    label: "should",
  },
  {
    id: "parenthesized-words",
    group: "囲み語",
    observation: JA,
    content: "Kenji (the manager) approved (well-known) vendor Acme",
    label: "should",
  },
  {
    id: "parenthesized-words-pair",
    group: "囲み語の対（括弧・ハイフンなし）",
    observation: JA,
    content: "Kenji the manager approved well known vendor Acme",
    label: "should",
  },
  {
    id: "hyphen-words",
    group: "ハイフン語",
    observation: JA,
    content: "The well-known state-of-the-art long-term high-quality solution",
    label: "should",
  },
  {
    id: "hyphen-words-pair",
    group: "ハイフン語の対（ハイフンを空白に）",
    observation: JA,
    content: "The well known state of the art long term high quality solution",
    label: "should",
  },
  {
    id: "hyphen-words-mild",
    group: "ハイフン語",
    observation: JA,
    content: "Kenji prefers a well-known, long-term, low-cost option",
    label: "should",
    note: "ハイフン語があっても、他の小文字語が3つ以上ある",
  },
  // --- ラテン文字の他言語 ---
  {
    id: "spanish-ascii",
    group: "他言語（ラテン文字）",
    observation: JA,
    content: "El usuario prefiere trabajar desde casa los viernes por la tarde",
    label: "should",
    note: "スペイン語。日本語で書くべき記憶が別の言語で書かれた、という点では英語と同じ",
  },
  {
    id: "german-ascii",
    group: "他言語（ラテン文字）",
    observation: JA,
    content: "Der Benutzer arbeitet freitags lieber von zu Hause aus",
    label: "should",
  },
  {
    id: "spanish-accents",
    group: "他言語（アクセント付き）",
    observation: JA,
    content: "Prefiere reunirse mañana, después también allí",
    label: "should",
  },
  {
    id: "french-accents",
    group: "他言語（アクセント付き）",
    observation: JA,
    content: "Il préfère être là dès demain à côté de l’école",
    label: "should",
  },
  {
    id: "russian",
    group: "他言語（ラテン文字でない）",
    observation: JA,
    content: "Пользователь предпочитает работать из дома по пятницам",
    label: "should",
    note: "ラテン文字でない言語。検査は ラテン文字だけを数える",
  },
  {
    id: "romaji",
    group: "ローマ字",
    observation: JA,
    content: "Watashi wa Osaka ni ikimasu to itta",
    label: "split",
    note: "日本語のローマ字書き。英語ではないが、日本語の文字でもない",
  },
  // --- 観測の側の境界 ---
  {
    id: "obs-chinese",
    group: "中国語の観測",
    observation: ZH,
    content: "The user will go to Osaka next Tuesday for a client meeting",
    label: "should",
    note: "観測の言語（中国語）で書くべき、という基準で should。検査は中国語と日本語を区別しない",
  },
  {
    id: "obs-chinese-zh-content",
    group: "中国語の観測",
    observation: ZH,
    content: "用户下周二要去大阪和客户开会",
    label: "shouldNot",
  },
  {
    id: "obs-korean",
    group: "ハングルの観測",
    observation: "다음 주 화요일에 오사카에서 거래처와 회의를 합니다.",
    content: "The user will meet a client in Osaka next Tuesday",
    label: "should",
    note: "検査はハングルを数えない",
  },
  {
    id: "obs-ja-4chars",
    group: "観測の短さ（かな・漢字の数）",
    observation: "了解です",
    content: "The user agreed to the proposal on Tuesday",
    label: "split",
    note: "観測が4字。言語を言うには短い",
  },
  {
    id: "obs-ja-2chars",
    group: "観測の短さ（かな・漢字の数）",
    observation: "OKです",
    content: "The user agreed to the proposal on Tuesday",
    label: "split",
    note: "観測が2字。日本語とも英語混じりとも読める",
  },
  {
    id: "obs-english-with-jp-name",
    group: "観測が英語主体",
    observation: "Please send the quarterly report to 田中さん by Friday afternoon",
    content: "The user asked to send the quarterly report to Tanaka by Friday afternoon",
    label: "shouldNot",
    note: "観測が英語。英語の本文は自然",
  },
  {
    id: "obs-share-over-0.3",
    group: "観測のかな・漢字の割合（0.3 の前後）",
    observation: "Weekly meeting notes for 田中さん案件の確認",
    content: "The user wants weekly meeting notes for the Tanaka project review",
    label: "split",
    note: "観測が英語混じり。日本語の観測と言えるか割れる",
  },
  {
    id: "obs-share-under-0.3",
    group: "観測のかな・漢字の割合（0.3 の前後）",
    observation: "Weekly meeting notes for 田中さん案件の確認 a",
    content: "The user wants weekly meeting notes for the Tanaka project review",
    label: "split",
    note: "同上（ラテン文字を1字足した）",
  },
  {
    id: "obs-ja-quote-english",
    group: "観測が日本語・英語を引用",
    observation: "田中さんは「Hello world」と言いました。",
    content: 'Tanaka said "Hello world" to the staff at the front desk',
    label: "should",
  },
  // --- 本文のラテン文字の割合（0.9 の前後）---
  {
    id: "mixed-script-share-high",
    group: "本文の割合（0.9 の前後）",
    observation: JA,
    content: "She likes green sofas and tables ДОМ",
    label: "split",
    note: "英文にキリル文字が混じる。どちらの言語とも言いにくい",
  },
  {
    id: "mixed-script-share-low",
    group: "本文の割合（0.9 の前後）",
    observation: JA,
    content: "She likes green sofas and tables ДОМИК",
    label: "split",
    note: "同上（キリル文字を2字足した）",
  },
];
