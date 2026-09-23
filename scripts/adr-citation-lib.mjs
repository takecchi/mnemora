/**
 * 「生きた文書から ADR を指す参照が、機械で追える形か」を検査する純関数の側
 * （マネージャーの作業指示「歯を1本足す」）。
 *
 * `scripts/identifier-probes-readme-freshness-lib.mjs` と同じ分担——ファイル I/O・
 * `process.argv`・`process.exit` を一切持たない。呼び出す側
 * （`scripts/__tests__/adr-citation.test.mjs`）がファイルを読んで渡す。
 *
 * ## 検査する2つのこと
 *
 * 1. **行番号による ADR 引用**（`findAdrLineNumberCitations`）。ADR は当時の記録であり
 *    本文を書き換えない（`docs/decisions/*.md` は「当時の記録として書き換えない」規律に
 *    従う一方、ADR 自身の行番号が動くリスクは常に在る——リファクタ・追記・訂正の追記で
 *    行はずれる）。⟹ **生きた文書（`docs/decisions/` を除いた `docs/**\/*.md`・
 *    `AGENTS.md`・`README.md`）が ADR を行番号で指していたら、それは機械で追えない
 *    引用である。**
 *
 * 2. **アンカー引用（`ADR NNNN「実在する文字列」`）の実在性**（`findAdrAnchorCitations` +
 *    `anchorExistsInTarget`）。新しい作法は「行番号」ではなく「引用先に実在する文字列」で
 *    指す。⟹ その文字列が本当に引用先の ADR に在るかを検査できて初めて、この作法は
 *    「壊れても赤くならない」問題を解消したことになる。
 *
 * ## ⭐ 「見つけたもの全部」を返し、判定は呼び出し側に任せる
 *
 * この2つの純関数は、**入力テキストのファイルパスや docs/decisions/ 所属を一切知らない
 * ——渡された文字列の中から機械的に見つかるものを、全部返すだけ**である。
 * 「生きた文書か ADR 本体か」「赤くするか除外するか」は歯（テスト）の側が決める。
 * これにより、後で方針が変わっても（例: ADR 本体自身にも行番号引用を禁止したくなる等）
 * この検出器を書き直さずに済む。
 *
 * ## (1) 洗い出した「書き方の一族」— 高再現率の根拠
 *
 * マネージャーからの指示・実地の grep で見つかった実在の書き方（詳細は
 * `scripts/__tests__/adr-citation.test.mjs` の再現率の歯にある fixture を見ること）:
 *
 * - **combined**: バッククォートで囲んだ `<ファイル名>:<行番号[-行番号]>`。
 *   ファイル名は `docs/decisions/` 接頭辞の有無どちらも在り、**接頭辞の後ろの
 *   スラグ部分が `....`（省略の中黒でも点々でもなく、リテラルな4連続ピリオド）に
 *   短縮される形が `docs/release-v1.md` に10件在った**（マネージャーが実地の grep
 *   ミス（`[a-z0-9-]+\.md` がこの省略形に一致しなかったこと）で見つけた一族）。
 *   ⟹ スラグ部分の正規表現は `\S+?`（非空白文字なら何でも、`.md` の直前まで
 *   非貪欲に）にした——ファイル名の綴りを一切当てにしない。
 *   **バッククォートの中に改行を1つ挟んで行番号リストが続く形**
 *   （`` `docs/decisions/0066-....md:11,\n241-267` ``）も実在するため、
 *   行番号部分の文字クラスは改行を許す。
 * - **adr-comma-line**: `ADR <4桁>、<行番号[-行番号]>行`（全角読点、直後に行番号、
 *   直後に「行」。オプションで「目」「付近」が続く）。
 * - **adr-paren-colon**: `ADR <4桁>（`:<行番号[-行番号]>`）`——カッコの中にバッククォート
 *   コロン形。
 * - **md-link-colon**: `[ADR <4桁>](<パス>)` の直後（0文字、または「の」1語程度の
 *   ごく短い接続）にバッククォートコロン形が続く。
 * - **omitted-reference**: 直前に登場した対象（ADR かどうかを問わず）を指す省略形
 *   `同 `:<行番号>`` / `同ファイル `:<行番号>``。**対象が直前に登場した ADR なら
 *   ADR 引用として数え、対象がソースコードファイル（`.ts` 等）なら数えない**——
 *   `docs/conformance.md`・`docs/roadmap.md` に「同ファイル `:NNN`」でソースコードの
 *   行を指す形が多数在り、これらを ADR 引用と誤認しないための区別。
 *
 * ## ⛔ 意図的に検出しない形（偽陽性ゼロを優先した判断）
 *
 * `ADR <4桁>` の後ろに緩い文字数の窓（例: 40字以内、句点をまたがない）を張って
 * 「NNN〜NNN行付近」のような全角ダッシュ形を拾う案も検討したが、**採らなかった**。
 * 理由（実地で確認した反例）:
 *
 * - 拾いたかった実例: `docs/decisions/0194-embedding-space-analyze-threshold.md:141`
 *   「ADR 0189 進行中の段1 ANN 経路、`kPrime` 周辺・1145〜1200行付近」——
 *   「ADR 0189」から「1145」までの間隔は約24字。
 * - 拾ってはいけない実例（同じ間隔の長さでは区別できない）:
 *   `docs/decisions/0207-dry-run-reads-existence-and-coverage-degrades-silently.md:199`
 *   「ADR 0067 は `#` の見出しを1行目にしか持たず」——「ADR 0067」から「1行目」の「1」
 *   までの間隔は約12字（**上の拾いたい例より短い**）。ここでの「1行目」は
 *   「ADR 0067 というファイルの構造上の性質（最初の行に見出しを持つ）」を述べているだけで、
 *   特定の主張を検証するための行番号引用ではない。
 * - 間隔の長さでは両者を区別できない（後者の方が短い）ため、**この一族は検出対象から
 *   外した**。結果として上の1件（0194:141）は見逃す。この見逃しは意図的であり、
 *   「確かめていないこと」に明記する。ただし、この1件は `docs/decisions/` 配下
 *   （ADR 本体）に在り、検査対象（生きた文書）には最初から入らない。
 *
 * ## (2) アンカー引用の見分け方（すべての「...」をアンカーと見なさない）
 *
 * `「...」`（全角鉤括弧）は、この repo の文章でごく普通に会話や強調のために使われており、
 * 大量に存在する。**「ADR <4桁>」という言及の直後（同じ行内・句点をまたがない・
 * 30字以内）に「...」が続く形だけをアンカー候補とする。** 30字という上限は
 * マネージャーの指示「数十字以内」の解釈であり、実地の分布
 * （`ADR 0165「これが覆るとしたら」` のような0字接続から、
 * `ADR 0038 が実測した「実装が2つあると食い違う」` のような6字程度の接続まで、
 * 「近い」引用はおおむね30字以内に収まる一方、遠い引用は改行や句点をまたぐ）を
 * 見て決めた。**改行・句点をまたぐものは除外する**——これにより、無関係な段落の
 * 「...」を「ADR NNNN」の直後というだけで誤って拾うことを防ぐ。
 *
 * この窓の外側にある `「...」`（自由な逐語引用・会話文の再現等）は、この検出器の
 * 対象外である。**この線引きは判断であり、唯一の正解ではない**——境界事例は
 * 報告に明記する。
 *
 * ### アンカー文字列の実在性チェック
 *
 * `anchorExistsInTarget(quote, targetText)` は、`quote`（「」の中身）が `targetText`
 * （引用先 ADR の生テキスト）に**そのまま部分文字列として存在するか**を見る。
 * 見つからなければ、**末尾に付いた素の数字（オプションで「番」）を1つ取り除いた形**
 * でも試す——`ADR 0119「採らなかった案4」` のように数字が引用そのものの一部として
 * ADR 本文に現れる場合と、`ADR 0202「引き受けた負債1」` のように数字が「Nつ目の項目」
 * という索引であって ADR 本文の見出しには現れない場合（実際に確認した:
 * `docs/decisions/0119-....md` の見出しは「引き受けた負債・覆えていない範囲」であり
 * 「引き受けた負債3」という文字列はそのまま存在しないが、末尾の数字を除いた
 * 「引き受けた負債」は見出しの前方一致で存在する）の、両方をカバーするため。
 *
 * ⚠ **この末尾数字除去は「セクションの存在」までしか確認しない。**
 * 「その数字が指す個別の箇条書き項目が本当にNつ目か」までは検証していない
 * （構造化されたリスト項番の解析が要るため、この検出器のスコープ外）。
 */

/**
 * @typedef {{
 *   index: number,
 *   line: number,
 *   raw: string,
 *   adrNumber: string,
 *   kind: "combined" | "adr-comma-line" | "adr-paren-colon" | "md-link-colon" | "omitted-reference",
 * }} AdrLineCitation
 */

/**
 * @typedef {{ index: number, line: number, raw: string, adrNumber: string, quote: string }} AdrAnchorCitation
 */

/**
 * `index`（0始まりの文字オフセット）から1始まりの行番号を計算する。
 *
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
export function lineNumberAt(text, index) {
  let line = 1;
  const upTo = text.slice(0, index);
  for (let i = 0; i < upTo.length; i++) {
    if (upTo[i] === "\n") {
      line++;
    }
  }
  return line;
}

const FILE_LINE_RE = /`((?:docs\/decisions\/)?(\d{4})-\S+?\.md):([0-9][0-9,\s-]{0,60})`/g;
const ADR_COMMA_LINE_RE = /ADR\s*(\d{4})[、,]\s*(\d+(?:[-〜~]\d+)?行(?:目|付近)?)/g;
const ADR_PAREN_COLON_RE = /ADR\s*(\d{4})\s*[（(]\s*`:(\d+(?:-\d+)?)`\s*[）)]/g;
const MD_LINK_COLON_RE = /\[ADR\s*(\d{4})\]\([^)\n]*\)(?:\s*の)?\s*`:(\d+(?:-\d+)?)`/g;
const OMITTED_COLON_RE = /同(?:ファイル)?\s*`:(\d+(?:-\d+)?)`/g;

/** ADR ファイル名パターン（`docs/decisions/` 接頭辞の有無どちらも）。 */
const ADR_FILE_MENTION_RE = /`(?:docs\/decisions\/)?(\d{4})-\S+?\.md`/g;
/** 素の "ADR NNNN" 言及（markdown link の中の "ADR NNNN" も、このパターンで拾える）。 */
const ADR_BARE_MENTION_RE = /ADR\s*(\d{4})/g;
/** ADR ではないファイルへの言及（`同`/`同ファイル` の対象が ADR かどうかを見分けるため）。 */
const OTHER_FILE_MENTION_RE = /`([^`\n]*\.(?:ts|tsx|js|mjs|cjs|json|sql|ya?ml))[^`\n]*`/g;

/**
 * 「対象への言及」を出現順に集める（ADR かどうかのラベル付き）。
 * `同`/`同ファイル` 省略形が指す直前の対象を解決するために使う。
 *
 * @param {string} text
 * @returns {Array<{ index: number, end: number, isAdr: boolean, adrNumber: string | null }>}
 */
function collectMentions(text) {
  /** @type {Array<{ index: number, end: number, isAdr: boolean, adrNumber: string | null }>} */
  const mentions = [];

  for (const re of [ADR_FILE_MENTION_RE, ADR_BARE_MENTION_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      mentions.push({ index: m.index, end: re.lastIndex, isAdr: true, adrNumber: m[1] });
    }
  }

  OTHER_FILE_MENTION_RE.lastIndex = 0;
  let om;
  while ((om = OTHER_FILE_MENTION_RE.exec(text))) {
    mentions.push({
      index: om.index,
      end: OTHER_FILE_MENTION_RE.lastIndex,
      isAdr: false,
      adrNumber: null,
    });
  }

  // combined 形・md-link-colon 形自体も、後続の省略形にとっては「直前の対象」になりうる。
  FILE_LINE_RE.lastIndex = 0;
  let fm;
  while ((fm = FILE_LINE_RE.exec(text))) {
    mentions.push({ index: fm.index, end: FILE_LINE_RE.lastIndex, isAdr: true, adrNumber: fm[2] });
  }
  MD_LINK_COLON_RE.lastIndex = 0;
  let lm;
  while ((lm = MD_LINK_COLON_RE.exec(text))) {
    mentions.push({
      index: lm.index,
      end: MD_LINK_COLON_RE.lastIndex,
      isAdr: true,
      adrNumber: lm[1],
    });
  }

  mentions.sort((a, b) => a.index - b.index);
  return mentions;
}

/**
 * `position` の直前にある、最も近い「対象への言及」を返す（無ければ `null`）。
 *
 * @param {Array<{ index: number, end: number, isAdr: boolean, adrNumber: string | null }>} mentions
 * @param {number} position
 */
function nearestPrecedingMention(mentions, position) {
  let best = null;
  for (const mention of mentions) {
    if (mention.end <= position) {
      if (!best || mention.end > best.end) {
        best = mention;
      }
    } else {
      break;
    }
  }
  return best;
}

/**
 * 生きた文書・ADR 本体を問わず、渡されたテキストの中から「行番号による ADR 引用」を
 * 全部見つけて返す（見つけたもの全部——docs/decisions/ 由来を除外するかどうかは
 * 呼び出し側が決める）。
 *
 * @param {string} text
 * @returns {AdrLineCitation[]}
 */
export function findAdrLineNumberCitations(text) {
  /** @type {AdrLineCitation[]} */
  const citations = [];

  FILE_LINE_RE.lastIndex = 0;
  let m;
  while ((m = FILE_LINE_RE.exec(text))) {
    citations.push({
      index: m.index,
      line: lineNumberAt(text, m.index),
      raw: m[0],
      adrNumber: m[2],
      kind: "combined",
    });
  }

  ADR_COMMA_LINE_RE.lastIndex = 0;
  while ((m = ADR_COMMA_LINE_RE.exec(text))) {
    citations.push({
      index: m.index,
      line: lineNumberAt(text, m.index),
      raw: m[0],
      adrNumber: m[1],
      kind: "adr-comma-line",
    });
  }

  ADR_PAREN_COLON_RE.lastIndex = 0;
  while ((m = ADR_PAREN_COLON_RE.exec(text))) {
    citations.push({
      index: m.index,
      line: lineNumberAt(text, m.index),
      raw: m[0],
      adrNumber: m[1],
      kind: "adr-paren-colon",
    });
  }

  MD_LINK_COLON_RE.lastIndex = 0;
  while ((m = MD_LINK_COLON_RE.exec(text))) {
    citations.push({
      index: m.index,
      line: lineNumberAt(text, m.index),
      raw: m[0],
      adrNumber: m[1],
      kind: "md-link-colon",
    });
  }

  const mentions = collectMentions(text);
  OMITTED_COLON_RE.lastIndex = 0;
  while ((m = OMITTED_COLON_RE.exec(text))) {
    const antecedent = nearestPrecedingMention(mentions, m.index);
    if (antecedent && antecedent.isAdr && antecedent.adrNumber) {
      citations.push({
        index: m.index,
        line: lineNumberAt(text, m.index),
        raw: m[0],
        adrNumber: antecedent.adrNumber,
        kind: "omitted-reference",
      });
    }
  }

  citations.sort((a, b) => a.index - b.index);
  return citations;
}

const ANCHOR_RE =
  /(?:\[ADR\s*(\d{4})\]\([^)\n]*\)|ADR\s*(\d{4}))([^「\n。]{0,30})「([^」\n]{1,200})」/g;

/**
 * 「ADR <4桁>」の直後（同じ行内・句点をまたがない・30字以内）に続く `「...」` を、
 * アンカー引用の候補として全部返す。
 *
 * @param {string} text
 * @returns {AdrAnchorCitation[]}
 */
export function findAdrAnchorCitations(text) {
  /** @type {AdrAnchorCitation[]} */
  const citations = [];
  ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = ANCHOR_RE.exec(text))) {
    const adrNumber = m[1] ?? m[2];
    citations.push({
      index: m.index,
      line: lineNumberAt(text, m.index),
      raw: m[0],
      adrNumber,
      quote: m[4],
    });
  }
  return citations;
}

/**
 * `quote` の末尾に付いた素の数字（オプションで「番」）を取り除く。
 * 「Nつ目の項目」という索引が、引用先の見出しそのものには現れない場合のため。
 *
 * @param {string} quote
 * @returns {string}
 */
function stripTrailingIndex(quote) {
  return quote.replace(/[0-9０-９]+\s*番?$/u, "").trimEnd();
}

/**
 * Markdown の装飾（太字 `**`・インラインコード `` ` ``）を取り除く。
 *
 * ⚠ **これは「実測」で足した正規化である**——最初の実装（装飾を見ない素の部分文字列比較）を
 * repo 全体に走らせたところ、次の2形が「実在しない」と誤判定された:
 *
 * 1. 引用側が `similarity` のようにバッククォート無しで書き、引用先は
 *    `` `similarity` ``（コードとして）と書いている（`0038-vector-hit-distance-is-cosine.md:87`
 *    が `0036-clamp-freshness-at-one.md` を引く実例）。
 * 2. 引用側の `「...」` が **太字の境界を跨いで**囲んでいる
 *    （`「**オーナーの承認待ちである 【伝】**」` のように、`**` ごと引用符の中に入る）ため、
 *    素の部分文字列比較では `**` の位置が引用先の実際の境界（例: 句点の前後）と1文字ずれて
 *    不一致になる（`docs/roadmap.md:402` が `docs/decisions/0151-....md` を引く実例）。
 *
 * どちらも**中身は一致しているのに記法の飾りだけがずれている**ケースであり、
 * 太字とインラインコードの記号を両側から取り除いてから比較すれば解決する。
 *
 * @param {string} value
 * @returns {string}
 */
function stripMarkdownDecoration(value) {
  return value.replaceAll("**", "").replaceAll("`", "");
}

/**
 * `quote`（「」の中身）が `targetText`（引用先 ADR の生テキスト）に実在するかを検査する。
 *
 * 4段階で試す（どれか1つでも一致すれば実在とみなす）:
 * 1. 生のままの部分文字列比較。
 * 2. 末尾の素の数字（「Nつ目」索引）を取り除いた形。
 * 3. 太字 `**`・インラインコード `` ` `` を両側から取り除いた形
 *    （`stripMarkdownDecoration` を参照。記法の飾りだけがずれている場合を拾う）。
 * 4. 3に加えて末尾索引も取り除いた形。
 *
 * @param {string} quote
 * @param {string} targetText
 * @returns {boolean}
 */
export function anchorExistsInTarget(quote, targetText) {
  if (quote.length === 0) {
    return false;
  }
  if (targetText.includes(quote)) {
    return true;
  }
  const stripped = stripTrailingIndex(quote);
  if (stripped.length > 0 && stripped !== quote && targetText.includes(stripped)) {
    return true;
  }
  const normalizedTarget = stripMarkdownDecoration(targetText);
  const normalizedQuote = stripMarkdownDecoration(quote).trim();
  if (normalizedQuote.length > 0 && normalizedTarget.includes(normalizedQuote)) {
    return true;
  }
  const normalizedStripped = stripTrailingIndex(normalizedQuote);
  if (
    normalizedStripped.length > 0 &&
    normalizedStripped !== normalizedQuote &&
    normalizedTarget.includes(normalizedStripped)
  ) {
    return true;
  }
  return false;
}

/**
 * ## 3つ目の歯 —「ADR X 決定N」への参照が、機械で追える形か
 *
 * ここまでの2つ（行番号引用・アンカー引用）は「引用先の場所が動いたら壊れる」形を検出した。
 * この3つ目が検出するのは別の壊れ方——**「ADR X 決定N」という書き方そのものが、
 * 曖昧または実在しない先を指してしまう2つの規則**である（マネージャーの作業指示）。
 *
 * ### 背景 — Issue #505 が生んだ略記
 *
 * Issue #505 は、ある ADR（以下「元 ADR」）の複数の決定を、1本ずつ別の ADR（以下「着地先」）へ
 * 分けて成文化した。着地先の見出し（h1）は自分を次の逐語の形で名乗る:
 *
 * `# ADR <着地先番号>: … — ADR <元番号> 決定<N> の射程を \`AGENTS.md\` へ広げる（Issue #505）`
 *
 * ⟹ 書き手は「`ADR <元番号> 決定<N>` を着地させた `ADR <着地先番号>`」を、
 * **`ADR <着地先番号> 決定<N>`** と縮めて呼ぶことが実地で何度も起きている。
 * ⛔ **これは誤字ではなく体系的な略記である**——「着地先の ADR 番号」と「元 ADR の決定番号」を
 * そのまま並べてしまう。
 *
 * ### 規則A（死んだポインタ）
 *
 * 参照 `ADR X 決定N` について、**X 自身の決定セクションに `決定N` が無ければ違反**。
 * （`findAdrDecisionSectionNumbers` が返す集合に `N` が入っているかで判定する。）
 *
 * ### 規則B（曖昧な略記）
 *
 * X の h1 が「ADR S 決定N の射程を…へ広げる」と名乗っている（＝ X は元 ADR S の決定N の
 * 着地先である）とき、**`ADR X 決定N`（同じ番号）という参照は曖昧であり違反**。
 * 正しくは `ADR S 決定N`（`ADR X` で着地、のように書く）である。
 * （`findAdrLandingClaim` が返す `{ sourceAdrNumber, decisionNumber }` の `decisionNumber` と
 * 参照側の decisionNumber が一致するかで判定する。）
 *
 * ⭐ **どちらの規則も、対応表（「決定2→0250」のような固定リスト）をコードに焼かない。**
 * 両側（参照元の文字列・指し先 ADR の実物）を実行時に repo から読んで突き合わせる
 * （`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」/ ADR 0223 決定9 の自己適用）。
 *
 * ### ⭐ なぜ2つの規則が別々に要るか —— 【実測】着地先が h1 で出自を名乗らないと、規則Bが効かない
 *
 * **【実測】`ADR 0223 決定N` の着地先6本（`0250`/`0254`/`0255`/`0256`/`0257`/`0234`）のうち、
 * h1 で「`ADR 0223 決定N` の射程を広げる」と名乗っていないのは `0234` だけであり、
 * `ADR <着地先> 決定<N>` の形で誤引用されたのも `0234` が最多だった**
 * （`scripts/__tests__/adr-citation.test.mjs` の実行結果と報告の集計より）。
 * ⛔ **標本が6本と小さいので、これ以上は断定しない**——「h1 で出自を名乗らない ADR は
 * 誤引用が増える」という一般則までは主張しない。**実測はここまでである。**
 *
 * ⟹ この観測は、**規則Bだけでは足りない理由**そのものでもある。`0234` は h1 で
 * 「ADR 0223 決定9 の射程を…へ広げる」と名乗っていない（`findAdrLandingClaim` が `null` を
 * 返す）ため、`0234` を決定9として指す誤引用は**規則B（着地先の名乗りから導出する）では
 * 捕まらない**。この誤引用を捕まえているのは**規則A**（`0234` 自身の決定セクションに
 * `決定9` が無いことを直接見る）のほうである。⟹ **2つの規則は独立に要る**
 * ——規則Bは「着地先が h1 で自分の出自を名乗っている」ときにしか効かない後ろ盾であり、
 * 規則Aは着地先が出自を名乗るかどうかに関わらず効く、より根本的な検査である。
 *
 * ### 🔴 この歯が止めないもの —— 番号は合っているが中身が別の節にある形
 *
 * この歯は **`ADR X 決定N` という文字列の形**しか見ない。`X` の決定セクションに `決定N` という
 * *見出しが実在する*ことまでは確認するが、**引用者がその参照に帰している主張の中身が、
 * 本当にその決定Nの節に書いてあるかは検証していない**——これは逐語照合でしか見えず、
 * 構造化された「どの見出しが何を主張しているか」の解析はこの歯のスコープ外である。
 * 【実測】`ADR 0201 決定3` を名指ししていた2箇所（ADR 0227 本文と、`examples/chat` の
 * retrieval-quality-regression の歯の docstring）は、`0201` に
 * `### 3. CI ジョブは増やさない` という見出しが実在するため、この歯では「正常」と分類された
 * ——だが、その参照が実際に帰していた主張は、番号を持たない FLOOR の節（案A・案B）の話だった。
 * （Issue #634 で docstring の指し先を直し、ADR 0227 には本文を書き換えずに訂正を追記した。
 * ⟹ ADR 0227 の本文には、いまも同じ文字列が残っている。）
 * これは Issue #634 が報告している形そのものであり、⛔ **この歯はそれを検出しない。**
 *
 * ### 🔴 実装で必ず守る2つの細部
 *
 * ① **記法を外してから当てる。** 素の文字列一致・素の正規表現は次のようなずれで空振りする:
 * `[表示文字](url)` というリンク記法、`*`/`_`/`` ` ``/`~`/`\` の装飾、表の `|`、
 * そして**改行を含む空白**（`ADR <番号>` と `決定<N>` が行をまたぐ実例が在る）。
 * ⟹ `normalizeForAdrDecisionReferences` がこれを1回で正規化してから探す。
 *
 * ② 🔴 **見出しの行頭に空白と `- + * >` を許すこと。**
 * ⛔ **見出し検出を `^#{2,4}` と決め打つと、箇条書きの中に字下げして置かれた
 * `  ## 決定` を1つも拾えない。** 実地で `0087`/`0089`/`0091`/`0114`/`0119`/`0155` などが
 * この形（`- **決定**:` の直下に、字下げした `## 決定N: …` が続く）を持ち、
 * 【実測】この罠を踏むと**参照の25.4%（119/468）が静かに「判定不能」になった**。
 * ⚠ **これを知らない次の人が `^#{2,4}` に戻したら、この歯は緑のまま無力化する**
 * ——`HEADING_LINE_RE` の定義に、この段落と同じ警告を逐語で繰り返して残す。
 */

/**
 * `[表示文字](url)` を表示文字へ、`*`/`_`/`` ` ``/`~`/`\` を除去、表の `|` を空白へ、
 * 改行を含む全空白を1個の半角空白へ正規化する。
 *
 * 「ADR 決定」参照だけに絞った軽量な正規化であり、`anchorExistsInTarget` 側が使う
 * `stripMarkdownDecoration`（`**`・バッククォートだけを外す、部分文字列比較用）とは別物。
 * こちらは「参照そのものの検出」に使うため、検出後に元テキストの行番号を引けるよう
 * `indexMap`（正規化後の各文字が、元テキストのどの位置から来たか）も返す。
 *
 * @param {string} text
 * @returns {{ normalized: string, indexMap: number[] }}
 */
export function normalizeForAdrDecisionReferences(text) {
  const outChars = [];
  const indexMap = [];
  const n = text.length;
  const linkRe = /^\[([^\]\n]*)\]\(([^)\n]*)\)/;
  let i = 0;
  while (i < n) {
    const linkMatch = linkRe.exec(text.slice(i));
    if (linkMatch) {
      const display = linkMatch[1];
      const displayStart = i + 1; // '[' の次から表示文字が始まる
      for (let k = 0; k < display.length; k++) {
        outChars.push(display[k]);
        indexMap.push(displayStart + k);
      }
      i += linkMatch[0].length;
      continue;
    }
    const ch = text[i];
    if (ch === "*" || ch === "_" || ch === "`" || ch === "~" || ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "|") {
      outChars.push(" ");
      indexMap.push(i);
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      const start = i;
      while (i < n && /\s/.test(text[i])) {
        i += 1;
      }
      outChars.push(" ");
      indexMap.push(start);
      continue;
    }
    outChars.push(ch);
    indexMap.push(i);
    i += 1;
  }
  return { normalized: outChars.join(""), indexMap };
}

/** @typedef {{ index: number, line: number, raw: string, adrNumber: string, decisionNumber: string }} AdrDecisionReference */

const ADR_DECISION_REF_RE = /ADR ?(\d{4}) ?決定 ?(\d+)/g;

/**
 * 正規化したテキストから `ADR X 決定N` 形の参照を全部見つけて返す
 * （見つけたもの全部——生きたコード・生きた文書・ADR 本体を問わない。除外は呼び出し側が決める）。
 *
 * `index`/`line` は**正規化前の元テキスト**での位置（`indexMap` で引き戻す）。
 *
 * @param {string} text
 * @returns {AdrDecisionReference[]}
 */
export function findAdrDecisionReferences(text) {
  const { normalized, indexMap } = normalizeForAdrDecisionReferences(text);
  /** @type {AdrDecisionReference[]} */
  const citations = [];
  ADR_DECISION_REF_RE.lastIndex = 0;
  let m;
  while ((m = ADR_DECISION_REF_RE.exec(normalized))) {
    const originalIndex = indexMap[m.index] ?? 0;
    citations.push({
      index: originalIndex,
      line: lineNumberAt(text, originalIndex),
      raw: m[0],
      adrNumber: m[1],
      decisionNumber: m[2],
    });
  }
  return citations;
}

/**
 * 見出し行を判定する。
 *
 * 🔴 **行頭に空白と `- + * >` を許すこと。** `^#{2,4}` に戻すと、箇条書きの中に字下げして
 * 置かれた見出し（実地で `0087`/`0089`/`0091`/`0114`/`0119`/`0155` などに在る
 * `- **決定**:` の直下の字下げ `## 決定N: …` の形）を1つも拾えなくなり、
 * 【実測】参照の約25%（119/468）が静かに「判定不能」になる。⚠ **この正規表現を
 * 書き直すときは、必ずこの段落を読み直すこと。**
 *
 * @param {string} line
 * @returns {{ level: number, text: string } | null}
 */
const HEADING_LINE_RE = /^[ \t]*(?:[-+*>][ \t]*)*(#{2,4})[ \t]+(.*)$/;
function matchHeadingLine(line) {
  const m = HEADING_LINE_RE.exec(line);
  if (!m) {
    return null;
  }
  return { level: m[1].length, text: m[2] };
}

/** 見出しテキストから、絵文字・太字・インラインコードの装飾を外す。 */
function stripHeadingDecoration(text) {
  return text
    .replace(/[⭐🔴⚠⛔⭕🟢🔵💡]/gu, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}

/** 決定セクションの「見出し語」（コンテナ側）。 */
const DECISION_SECTION_TITLES = new Set(["決めたこと", "決定", "決めること", "結論"]);

/**
 * ADR 本文から、その ADR が自前で持つ「決定N」の番号の集合を返す。
 *
 * 2種類の書き方を認識する（マネージャーの実地調査）:
 *
 * 1. **見出し自身が決定を名乗る形**（`### 決定N. …` / 字下げした `## 決定N: …` を含む）。
 *    これは見出しテキストが「決定」に続けて数字を持つので、コンテナの有無を問わず
 *    どこに在っても安全に決定Nとして数えられる。
 * 2. **コンテナ配下の番号だけの項**（`### N.` 見出し／箇条書きの `N. `／太字段落の
 *    `**N. …**`／表の `| N |`）。こちらは番号だけでは何の一覧か分からないため、
 *    直前に開いた「決定セクションのコンテナ」の配下に在るときだけ数える。
 *
 *    ⚠ **コンテナの開き方は2種類ある**（実地の ADR corpus に両方が実在する）:
 *    - **見出し型**: `## 決定` / `## 決めたこと` 等（`DECISION_SECTION_TITLES`）そのものが
 *      見出し。次に**同レベル以下**の見出しが来たら閉じる（後続の `### 決定1.` のような
 *      見出しは上の1.が拾うので、コンテナ判定には関与しない）。
 *    - **太字箇条書きラベル型**（古い ADR、例: `0060`）: `- **決定**:` のように、
 *      見出しではなく箇条書きの1項目としてラベルが在り、配下は**字下げした段落**として
 *      `**1. 本文…**` の形で番号付き決定が並ぶ（見出しも `N.` 箇条書きも使わない）。
 *      次に**同じかそれより浅い字下げの箇条書き行**（例: 兄弟の `- **採らなかった案**:`）
 *      か、**見出し行**が来たら閉じる。
 *
 * @param {string} adrText
 * @returns {Set<string>}
 */
export function findAdrDecisionSectionNumbers(adrText) {
  const lines = adrText.split("\n");
  const numbers = new Set();
  /** @type {{ kind: "heading", level: number } | { kind: "bullet", indent: number } | null} */
  let container = null;

  const BULLET_LABEL_RE = /^([ \t]*)[-+*]\s+\*\*(決めたこと|決定|決めること|結論)\*\*\s*:?\s*$/;
  const BULLET_ITEM_RE = /^[ \t]*[-+*]\s/;

  for (const line of lines) {
    const heading = matchHeadingLine(line);
    if (heading) {
      const headingText = stripHeadingDecoration(heading.text);

      const directMatch = headingText.match(/^決定\s*(\d+)/);
      if (directMatch) {
        numbers.add(directMatch[1]);
        // 太字箇条書きラベル型コンテナは、見出しが出てきた時点で構造が変わったとみなし閉じる
        // （見出し自身は上ですでに拾っているので、閉じても取りこぼしは無い）。
        if (container?.kind === "bullet") {
          container = null;
        }
        continue;
      }

      if (DECISION_SECTION_TITLES.has(headingText)) {
        container = { kind: "heading", level: heading.level };
        continue;
      }

      if (container?.kind === "heading" && heading.level > container.level) {
        const bareMatch = headingText.match(/^(\d+)\./);
        if (bareMatch) {
          numbers.add(bareMatch[1]);
        }
        continue;
      }

      // コンテナと同じか、より浅い見出しが来たら（見出し型・箇条書き型どちらも）閉じる。
      container = null;
      continue;
    }

    const bulletLabel = line.match(BULLET_LABEL_RE);
    if (bulletLabel) {
      container = { kind: "bullet", indent: bulletLabel[1].length };
      continue;
    }

    if (container === null) {
      continue;
    }

    if (container.kind === "bullet") {
      const siblingBullet = line.match(BULLET_ITEM_RE);
      if (siblingBullet) {
        const indent = line.match(/^[ \t]*/)[0].length;
        if (indent <= container.indent) {
          container = null;
          continue;
        }
      }
    }

    const boldParagraphMatch = line.match(/^[ \t]*\*\*(\d+)\.\s/);
    if (boldParagraphMatch) {
      numbers.add(boldParagraphMatch[1]);
      continue;
    }
    const bulletMatch = line.match(/^[ \t]*(\d+)\.\s/);
    if (bulletMatch) {
      numbers.add(bulletMatch[1]);
      continue;
    }
    const tableMatch = line.match(/^[ \t]*\|\s*(\d+)\s*\|/);
    if (tableMatch) {
      numbers.add(tableMatch[1]);
    }
  }

  return numbers;
}

const ADR_LANDING_CLAIM_RE = /ADR ?(\d{4}) ?決定 ?(\d+) の射程を[^\n]*?へ広げる/;

/**
 * ADR の h1（1行目）が「この ADR は元 ADR S の決定N の射程を広げたものである」と
 * 名乗っているかを判定する。名乗っていれば `{ sourceAdrNumber, decisionNumber }` を、
 * 名乗っていなければ `null` を返す。
 *
 * ⚠ **リンク記法・改行をまたぐ書き方は想定しない**（h1 は1行の見出しであり、この一族の
 * 実例はすべて素の `ADR NNNN 決定N の射程を…へ広げる` という同一行の文言である）。
 * ⟹ ここでは正規化を掛けない素の h1 テキストに直接当てる。
 *
 * @param {string} adrText
 * @returns {{ sourceAdrNumber: string, decisionNumber: string } | null}
 */
export function findAdrLandingClaim(adrText) {
  const firstLine = adrText.split("\n", 1)[0] ?? "";
  const m = ADR_LANDING_CLAIM_RE.exec(firstLine);
  if (!m) {
    return null;
  }
  return { sourceAdrNumber: m[1], decisionNumber: m[2] };
}

/**
 * 規則A・規則Bを判定する（純関数——ファイルは読まない）。呼び出し側が、参照先 ADR
 * （`ADR X 決定N` の `X`）について `findAdrDecisionSectionNumbers`/`findAdrLandingClaim`
 * を実行した結果を渡す。`targetSectionNumbers` が `null` なら「X という ADR 自体が
 * 存在しない」を表す。
 *
 * 🔴 **規則Bは「番号が一致するときだけ」曖昧である。** X が何らかの着地先であること
 * 自体は違反ではない——**同じ番号を使い回したときだけ**曖昧になる。番号が違えば
 * （例: X の自前の決定1 を指す場合）、X が別の決定Nの着地先であっても曖昧ではない。
 * ⛔ **この「番号が一致するときだけ」を外して `Boolean(targetLandingClaim)` にすると、
 * X が何かの着地先でありさえすれば毎回 ruleB が立つ、という過剰実装になる**
 * ——`adr-citation.test.mjs` の対応する fixture がこの過剰実装を赤で検出する。
 *
 * @param {string} decisionNumber
 * @param {{ targetSectionNumbers: Set<string> | null, targetLandingClaim: { sourceAdrNumber: string, decisionNumber: string } | null }} target
 * @returns {{ ruleA: boolean, ruleB: boolean }}
 */
export function classifyAdrDecisionCitation(decisionNumber, target) {
  if (target.targetSectionNumbers === null) {
    return { ruleA: true, ruleB: false };
  }
  const ruleA = !target.targetSectionNumbers.has(decisionNumber);
  const ruleB = Boolean(
    target.targetLandingClaim && target.targetLandingClaim.decisionNumber === decisionNumber,
  );
  return { ruleA, ruleB };
}
