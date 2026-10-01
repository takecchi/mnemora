# ADR 0482: 穴探し53巡目 — `observe()` の入力の種類ごとの扱い。`event.data` の「JSON で往復しない値」の表に歯が無く、関数・`Symbol`・`toJSON` の3行も載っていなかった

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-3a4ae979 の指示による）が書いた。面は「`observe()` の入力の種類（`utterance`・`event`・`document`）ごとに、payload から本文を作る部分、`ObserveInputSchema` の種類ごとの検査、`externalId` による冪等、それを受ける Postgres・testkit の InMemory・core の Fake の口」。直す線（文書の直し・歯の追加）の内側だけで動き、**実装は1行も変えていない**。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（Node.js v22.23.3、Postgres 17 + pgvector を自分専用のポートで）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: `ObserveEventInput.data` の TSDoc（`packages/core/src/observation.ts`）は、JSON で往復しない値が `@mnemora/postgres` と testkit の fixture でどう読み戻るかを表にしている（Issue #1076）。`docs/memory-model.md` にも同じ趣旨の追記がある。

- **見つけたこと**:
  1. 【現物】その表（`NaN`・`±Infinity`・`-0`・`Date`・値が `undefined` の欄・`BigInt`）を縛るテストは、どこにも無かった。探した場所: `git grep -n "ISO 8601 の文字列に変わる\|Date のまま保持"` は `packages/core/src/event.ts`・`observation.ts` の TSDoc だけに当たり、`packages/*/src/__tests__` の `NaN`・`Infinity` を含むファイルのうち `createObservation` または event の `data` を扱うもの（`observation-event-input-current-behaviour.postgres.test.ts`・`store-boundary-diff.postgres.test.ts`・`observation-invalid-date.postgres.test.ts` ほか）に、`data` の往復を見る `it` は無かった（当たった範囲での結果であり、網羅の断定ではない）。
  2. 【実測】表に無い値があり、2実装で違う。`createObservation` に `payload: { name, data }` を渡して `getObservation` で読み戻した結果:

     | `data` の値 | `@mnemora/postgres` | testkit の fixture |
     |---|---|---|
     | `{ a: () => 1, b: 1 }`・`{ a: Symbol("s") }` | 成功。欄ごと消える（`{ b: 1 }`） | `DataCloneError`（`structuredClone` が投げる）。行は書かない |
     | `{ a: { toJSON: () => "z" } }` | 成功。`{ a: "z" }` で保存 | `DataCloneError` |
     | `{ toJSON: () => 1 }`（`data` 自体） | 成功。**`data` が `1`（object でない）で読み戻る** | `DataCloneError` |

     core の Fake（`FakeMemoryStore`）は、関数・`Symbol` を欄ごと落とし、`toJSON` も呼ぶ（Postgres と同じ形）。つまり fixture だけが違う。
  3. 【実測】`extractData: true` で、値が `undefined` の欄だけの `data`（`{ a: undefined }`）は、LLM を失敗させた全文フォールバックの Memory の本文が Postgres では `n`（欄が消えてキー0個）、fixture では `n\n\n{}`（キーが1個残る）になる。TSDoc の「`JSON.stringify(data)` の中身が変わりうる」の範囲だが、**前置きの `name\n\n` の有無まで変わる**ことは書いていなかった。

- **決めたこと**【判断】（文書の直し・歯の追加のみ。実装は変えない）:
  1. `ObserveEventInput.data` の TSDoc の表に、関数・`Symbol`、`toJSON` の2行と、上の3.の注意を足した。値の扱いは今のまま。
  2. 表の全行に歯を付けた: `packages/postgres/src/__tests__/observation-payload-json-roundtrip.postgres.test.ts`（16件。Postgres と fixture の両方で、表の各行と、`extractData: true` の本文を `observe()` を通して縛る。**今の振る舞いを縛る歯であって、望ましい姿の主張ではない**）。
  3. fixture を Postgres に揃える（関数を落とす・`toJSON` を呼ぶ）案は採らなかった。fixture は表のとおり「JS の値をそのまま保持する」側（`NaN`・`-0`・`Date` を保つ）に立っており、揃えるには値ごとの分岐が要る。揃えるかはオーナーの領分（下の材料）。

- **歯の確かめ**【実測】: 歯は実装を変えない（今の振る舞いを縛る）ので、「直す前に赤」の代わりに変異試験で噛むことを示した。変異は `cp` で退避・復元（`git checkout` は使っていない）。
  - 変異A: fixture の `createObservation` が payload を `JSON.parse(JSON.stringify(...))` で保存する → 16件中7件が赤（`NaN`・`-0`・`Date`・`undefined` の欄・関数と `Symbol`・`toJSON`・`extractData` の本文の fixture）。
  - 変異B: Postgres の payload の `JSON.stringify` に、`NaN` を `"NaN"`・関数を `"fn"` に置く replacer を足す → 2件が赤（`NaN` の行・関数の行）。
  - 戻した後は16件とも緑（`git status --porcelain` で本番ファイルの差分が空であることも確認）。

- **当てた形と結果**【実測】（走らせた探り棒は `zz-` で始まる使い捨て。commit していない）:
  - 入力の種類ごとの payload（Postgres と fixture で `runtime.observe`、LLM は常に失敗させ、全文フォールバックの本文で見る）: `utterance` の `text` が空白だけ・改行だけ（どちらも成功し、本文は空白のまま）、数値の `text`（ZodError）、`event` の `name` が空白だけ（成功）、`data` が配列・`null`・`Date`・`Map`（ZodError）、`extractData` が文字列（ZodError）、`extractData: true` で `data` が無い・`{}`（本文は `name` だけ）、`data` に `text` キーを持たせた `event`（本文は `name`。`data.text` は拾わない）、`document` の `title` が空白だけで `extractTitle: true`（本文は `"  \n\nC"`。TSDoc の「空でない文字列」のとおり）、`title` が無いまま `extractTitle: true`（`content` だけ）、`content` が空白だけ（成功）、`kind` が大文字・省略、入力が `null`・`undefined`・配列、`speaker`・`externalId` が空文字、`externalId`・`subjectId` が `null`、`extract` が列挙の外、`occurredAt` が文字列（いずれも ZodError）。Postgres と fixture で同じ。
  - `data` の値（上の表の行）。違いは上のとおり。BigInt と循環参照はどちらも `TypeError`。
  - `externalId`（Postgres と fixture、`runtime.observe`、LLM は1回ごとに呼び出し数を数える）: 同じ `externalId` で本文・`subjectId` が違う2回目、`event` として送り直した3回目 → どちらも既存の Observation の id を返し、`extraction: "skipped"`・`memoryIds: []`・LLM は呼ばれない。大文字小文字だけ違う（`X` と `x`）・前後の空白だけ違う（`X` と ` X`）→ 別の Observation になり、抽出も走る（正規化しない）。`deferred` で作った後の `sync` の送り直し → `skipped`。同じ `externalId` を3本並行（sync）→ 1本が `ok`、2本が `skipped`、LLM は1回、Observation の id は1つ。種類の違う2本の並行 → 1本が `ok`、1本が `skipped`。作られた件数は Postgres の `observations`・`outbox`・`memories`・`memory_events` と fixture の `outboxJobs`・`events` で同じ（outbox 11 = extract 6 + embed 5、`memory_events` 5）。
  - **陽性対照**: 「揃っていた」を言うのに先立って、探り棒が違いを拾えることを示した。(a) `data` の値の探り棒が、Postgres と fixture の違い（上の表）をそのまま拾った。(b) `externalId` の探り棒は、同じ実行の中で「新しい行が作られて `ok`」と「既存を返して `skipped`」の両方を出した（`X`/`x`/` X` の3つは `ok`、送り直しは `skipped`）。(c) 歯は変異A・Bで赤になる（上）。これらの探り棒が「出なかった」を言うのは、`externalId` の冪等の結果の食い違いについてだけで、探した場所は上の入力の一覧に限る。

- **材料（直していない。決めるのはクローンまたはオーナー）**:
  1. **`utterance.text`・`event.name`・`document.content` が空白だけの入力を拒むか**。いま `z.string().min(1)` なので空白だけは通り、LLM に空白だけが渡り、LLM が失敗すると空白だけの Memory（`content` が `"   "`）が active で残る（【実測】Postgres。`digest` が `（内容なし）` になるのは `truncateForFallbackDigest` を読んだ【現物】で、走らせて確かめてはいない）。LLM が失敗しない経路の fixture の挙動は【未確認】。新しい断りで前例が無いのでオーナーの領分。拒むなら docs/migration-v1.md の 🔴 の項目が要る。
  2. **fixture の `DataCloneError` を Postgres（関数・`Symbol` を落とす、`toJSON` を呼ぶ）に揃えるか、Postgres の側で拒むか**。どちらも表の「揃える約束はしていない」の見直しになる。fixture を緩める案は表の「そのまま保持」と両立させにくい。
  3. **`data` 自体が `toJSON` を持つとき、Postgres が object でない値（`1`）で保存する**。型は `Record<string, unknown>` なので型の約束には反する。拒むなら新しい断り（オーナーの領分）。【未確認】`toJSON` を持つ `data` が現実の呼び出し側に在るか。
  4. 深い入れ子の `data` で、`RangeError: Maximum call stack size exceeded` になる深さが実装で違う。【実測】深さ3000は Postgres が通し、fixture（`structuredClone` の後の NUL 検査と思われる再帰）は `RangeError`、深さ1000は両方通る、6000は両方 `RangeError`。値は Node のスタックの大きさに依存し、約束された上限ではない。【未確認】`RangeError` の出どころ（fixture 側の再帰の位置）は特定していない。
  5. `extractionContext.messages[].text` の `max(2000)` は UTF-16 のコード単位で数える（zod の `max`）。TSDoc は単位を書いていない。【未確認】サロゲートペアの文字で2000「文字」と1000「文字」のどちらを境に拒むかは、今回走らせていない。

- **引き受けた負債**: 表の2行は「今の振る舞い」を書いただけで、どちらに揃えるかは決めていない。歯もそのまま縛るので、揃えるときは表と歯を同時に書き換える。CHANGELOG は書いていない（TSDoc の追記とテストの追加だけで、利用者に見える変更が無い）。

- **これが覆るとしたら**: オーナーが `data` を JSON の値に限る（入力を狭める）と決めたとき。そのときは表の全行がこの ADR ごと置き換わる。
