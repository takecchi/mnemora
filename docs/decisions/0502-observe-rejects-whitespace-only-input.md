# ADR 0502: `observe()` が、本文が空白だけの入力（`utterance.text`・`event.name`・`document.content`）を入口で断る

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の決定。担い手が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
前提: 「型の中でも約束を壊す入力を、新しく断る直しは、クローンの線の内側」とクローンが決めた（2026-10-02。オーナーが v1.X.0 での破壊的変更を許したことの続き）。材料は [ADR 0482](./0482-observe-input-kinds-event-data-roundtrip-table-tooth.md) の材料1。migration-v1 の 🔴 項目は 58。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果（Node.js、Postgres 17 + pgvector を自分専用のポートで）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: `ObserveInputSchema` の `utterance.text`・`event.name`・`document.content` は `z.string().min(1)` だけで、空白・改行・タブだけの値が通る。LLM に空白だけが渡り、LLM が失敗すると、`content` が空白だけの active な Memory が全文フォールバックで残る（ADR 0482 の【実測】）。LLM が返した側の空白だけの本文・tags は、すでに「無い」と同じに扱う前例がある（Issue #1065、`llm-blank-content.test.ts`・`llm-blank-tags.test.ts`）。入力の側だけが通していた。

- **現物の確認**【現物】（依頼の記述と食い違いは無かった）: 3欄は依頼どおり `z.string().min(1)`（`packages/core/src/observation.ts`）。0482 の本文に「歯」の記述はあるが、空白だけの入力を縛る歯は無かった（0482 の探り棒は使い捨てで commit されていない）。`document.title` は TSDoc が「空でない文字列のときだけ `${title}\n\n${content}`」と書き、`extractTitle` の既定は `false`。

- **決めたこと**【判断】:
  1. 3欄を、共通の `NonBlankTextSchema`（`z.string().min(1).refine(v => v.trim().length > 0, ...)`、`observation.ts` の内部。export しない）にした。`trim` して空になる値は `ZodError` で断る。**`path` は欄名、message は `min(1)` の空文字のものと同じ文言**にした（`code` は `too_small` でなく `custom`。zod の `refine` の形で、`issues` の `code` までは揃えていない）。
  2. **「空白」の定義は JS の `String.prototype.trim` が落とす文字**。半角空白・タブ・改行・垂直タブ・改ページ・U+00A0・U+FEFF・U+2028/2029、U+3000（全角空白）や U+2003 などの Unicode の空白を含む。正規表現 `\s` や自前の一覧は使わない（`trim` と同じ集合を、別の書き方で二重に持たないため。LLM 側の前例も `trim`）。**U+200B（ZERO WIDTH SPACE）は `trim` が落とさないので通る**（歯で縛った）。
  3. **値は trim して保存しない**。前後に空白のある普通の文（`"  hello  "`）はそのまま通り、そのまま保存する。内側の空白も触らない。
  4. **`document.title` は変えない**。理由: (a) `title` は任意で、空文字は元から `min(1)` が断るが、空白だけの `title` は `content`（必須・今回から空白だけを断る）に添える飾りで、本文が空になる経路ではない。(b) TSDoc の「空でない文字列のときだけ」は、`extractTitle: true` のときの扱い（0482 の【実測】で、空白だけの `title` は本文が `"  \n\nC"` になる）で、`content` が実質のある文字列なら LLM への入力は壊れない。(c) 断るのは別の約束（title の空白の扱い）を新しく決めることになり、今回の材料1（本文が空になる）の範囲を出る。**`title` の空白だけを前置きにしないよう直すか、断るかは、別の判断**（引き受けた負債）。
  5. **`speaker` などの他の `min(1)` 欄は今回の範囲外**: `speaker`・`externalId`・`subjectId`・`recallId`・`usedMemoryIds` の要素・`subjectCandidates` の要素・`extractionContext.messages[].text`。識別子系は ADR 0423 の別の規則（孤立サロゲート・NUL）の側にあり、空白だけの `externalId` は大文字小文字・前後の空白を区別する冪等の規則（0482）と絡む。`extractionContext.messages[].text` は本文ではなく文脈。
  6. **抽出の LLM 出力側（候補の `content` が空白だけ）は触らない**。前例（Issue #1065）が既に在る。

- **採らなかった案**:
  1. **`trim` した値を保存する（正規化する）。** 黙って別の値で保存するのは、断るより悪い。`externalId` や `content` の hash・重複判定にも波及する。
  2. **LLM を呼ぶ手前（`runtime.observe` の中）で断る。** 入口の検査が `ObserveInputSchema` と `runtime.observe` の2か所に分かれ、`ZodError` の形も揃わない。スキーマに置けば、`ObserveInputSchema` を通る全経路に同じ規則が効く。
  3. **正規表現 `\s` で判定する。** `\s` と `trim` の集合は ECMAScript では同じ定義だが、`trim` を使えば「`trim` が落とす文字」と一言で書け、読む人が確かめやすい。
  4. **`z.string().trim().min(1)`（zod の `trim()` 変換）。** 値を trim して返す変換なので、案1と同じく保存される値が変わる。`satisfies z.ZodType<ObserveInput>` との型の一致（ADR 0181）にも触る。
  5. **`title` も断る。** 上の決定4。

- **赤→緑・変異**【実測。ファイルを名指しして走らせた】:
  - 直す前: core の `observe-rejects-whitespace-only-input.test.ts`・`observe-whitespace-only-rejects-before-write.test.ts` は 58 本中 39 本が赤（空白だけの値を断る側。通す側・範囲外の19本は直す前から緑）。postgres の `observe-whitespace-only-input.postgres.test.ts`（Postgres と fixture）は 14 本中 12 本が赤（断る側の6×2）。
  - 直した後: core 58 本・postgres 14 本とも緑。周辺（`observe-schema-rejects-before-write`・`schema-type-equals-parity`・`zod-schema-constraints-tsdoc-edges`・`observation-payload-json-roundtrip.postgres`）も緑。
  - 変異（足りない）: refine を `value.length > 0`（trim を外す）→ core 39 本・postgres 12 本が赤。ASCII の空白だけを落とす（`[ \t\n\r]`）→ 23 本が赤。U+3000 だけ落とさない → 7 本が赤（U+3000 と「種類の混在」の行と、before-write の utterance）。
  - 変異（やりすぎ）: 内側の空白まで断る（`!/\s/.test(value)`）→ 12 本が赤。前後に空白のある文を断る（`value.trim() === value`）→ 9 本が赤。
  - 戻した後は緑（`git status --porcelain` で本番ファイルの差分が意図した差分だけであることを確認。変異は `cp` で退避・復元）。

- **引き受けた負債**:

  | # | 負債 | 結果 | 覆る条件 |
  |---|---|---|---|
  | 1 | `title` が空白だけでも通り、`extractTitle: true` で本文の前置きが空白になる | 本文は空にならないが、LLM に空白の前置きが渡る | `title` の空白の扱いを決めるとき（別の ADR） |
  | 2 | `speaker` などの他の欄は空白だけでも通る | 空白だけの `speaker` が `stated` の出所に残る | 同じ規則を広げると決まったとき（欄ごとに意味が違う） |
  | 3 | エラーの `code` は `custom`（空文字は `too_small`）。message は同じ文言なので、空白だけの値に「`>=1 characters`」と出て紛らわしい | `issues[].code` で分岐している呼び出し側は、空白だけの場合を別に扱う | `code` を揃える（`superRefine` で `too_small` を積む）と決まったとき |
  | 4 | U+200B・U+2060 などの、`trim` が落とさない不可視文字だけの本文は通る | 見た目が空の Memory が残りうる | `trim` を超える「見た目が空」の定義を決めるとき |
  | 5 | すでに保存された空白だけの Memory は消さない | 残る | オーナーが掃除を決めたとき（データの書き換えはオーナーの領分） |

- **これが覆るとしたら**: 空白だけの本文を意図して送り、それを「空の観測」として記録したい利用者が多いと分かったとき（その場合は `event` の `name` を意味のある文字列にする移行を勧めた、migration-v1 項目58 を見直す）。

- **測っていないこと**【未確認】: 呼び出し側が実際に空白だけを送っている頻度。LLM が失敗しない経路での Postgres の挙動（空白だけの入力は入口で断るので、到達しなくなった）。`reextract` が読み直す、すでに保存された空白だけの Observation の扱い（スキーマを通らない経路で、今回は触っていない）。手元以外の環境。
