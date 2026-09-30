# ADR 0422: `reextract` の `created` イベントの `at` を同じ操作の `superseded` と揃え、meta に再抽出の印を足す。同じ `at` のイベントの並びは約束しない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

> **⚠ これはクローンの委譲で動く担い手が書いた。オーナーの判断ではない**（ADR 0220）。
> 方針（`at` は入口の `now` に揃える・meta には足すだけで既存の意味は変えない・同じ `at` の並びは約束しない）は、
> 委譲元のマネージャーが決めた。この ADR はその内側の設計と、確かめたことを書く。

---

## 文脈

[ADR 0416](./0416-created-event-same-tx-remaining-paths.md)（#1507）が `reextract` の `created` を記憶と同じトランザクションで積むようにしたとき、
`reextract` の `created` の中身に、次の穴2つが残っていることが分かった。

1. **`at` のずれ。** `reextract` は入口で `now = clock.now()` を1回読み、`superseded` の `at` にはこの `now` を使う（Issue #1237）。
   一方 `created` は `buildCreatedEventFor` が**組み立てるときに** `clock.now()` を読み直す。LLM の応答を待った分だけ、`created` は同じ操作の `superseded` より後の時刻になる。
   `consolidate` は `created` と `superseded` が同じ `at`（`now`）を持つので、同じ「置き換え」でも操作によって `at` の関係が違っていた。
2. **再抽出から来たことが meta で区別できない。** `reextract` の `created` の meta は、observe の `created` と同じ形（`reason: "extracted"`・`sourceObservationId`・`extractorVersion` …）で、
   監査ログを読んでも、その `created` が `observe` の抽出か `reextract` かが見分けられない。

あわせて、ADR 0416 は `created` と `superseded` の**挿入順**を入れ替えた（`created` が先）。`consolidate` は同じ `at` なので、`PostgresEventStore.list` の `ORDER BY at ASC` の下では、
この2つの並びが入れ替わりうる。この ADR で `reextract` も同じ `at` になるので、並びの約束をはっきり書く必要がある。

## 決めたこと

1. **`reextract` の `created` の `at` は、同じ操作の `superseded` と同じ入口の `now` にする。**
   - `buildCreatedEventFor`（と、別の append の `appendCreatedEvent`）に、任意の追加の指定 `{ at?: Date; reextracted?: boolean }` を足した。`at` を渡さなければ今までどおり組み立て時の `clock.now()`
     なので、observe・抽出（sync／deferred）の経路の振る舞いは変わらない。
   - `reextract` は入口で1つの指定 `{ at: now, reextracted: true }` を作り、**3経路すべて**に同じ値を渡す: 口あり（`supersedeWithNewMemories` の `opts.buildCreatedEvent`）、
     名乗らない adapter の別の `appendCreatedEvent`、口なし（`createMemoryWithOutbox` のループ）。3経路で `at` も印も同じになる。
   - **入口の `now` に揃える理由**: (a) `superseded` がすでにこの `now` を使っている。`created` だけを `superseded` の `at` に寄せれば、`reextract` の中で同じ値が1つになり、
     どちらが先に書かれたかに依らず2つの `at` は等しい。(b) この `now` は Issue #1237 が「この呼び出し全体で1回だけ読む」と決めたもので、`consolidate`・`reflect` と同じ規律である。
     (c) `created` の `at` は、store が `opts.buildCreatedEvent` をトランザクションの中で呼ぶ経路でも、core が呼ぶ経路でも、**組み立てる側で決まる**ので、store の実装に手を入れずに済む
     （第三者の adapter が `buildCreatedEvent` をそのまま書く限り、`at` は core が決めた値になる）。
2. **`created` の meta に `reextracted: true` を足す。足すだけで、既存のキーの意味は変えない。**
   - 既存のキー（`reason: "extracted"`・`sourceObservationId`・`extractorVersion`・`languageMismatch`・`droppedCandidates`・`failureKind`）は、値も意味も変えない。`reason` は `"extracted"` のまま
     （「抽出の結果として作られた」という意味であり、`reextract` も抽出をやり直して作るので、この意味は合っている）。
   - observe の `created` の meta の形は変えない（印は `reextract` が渡したときだけ足す。歯が、observe の `created` に印が無いことを縛る）。
   - キー名は `reextracted`（値は真偽値の `true`。足すときは常に `true`。偽は足さず、キーごと無い）。歯（`REEXTRACT_META_KEY`）と同じ名前である。
   - `memory_events.meta` は既存の jsonb NOT NULL 列で、キーを足すだけなのでマイグレーションは要らない。
3. **同じ `at` を持つイベントどうしの並びは約束しない。当てにしてはいけない。** 順が要るときは `kind` と meta（例: `superseded` の `meta.supersededById`）で関係を読む。
   - 書いた場所: `EventStore.list` の interface の doc（元からあった「`at` が同値の行同士の順序は規定しない」に、当てにしてはいけないことと例を足した）、`docs/architecture.md` §5.8 の契約欄、
     `buildCreatedEventFor` の doc、この ADR。ADR 0416 の末尾に、この ADR への参照を追記した（本文は書き換えていない）。
   - **並びを縛るテストは足さない。** 約束しないことを歯にすると、実装が偶然持っている並びまで仕様になってしまう。
   - タイブレーク（`ORDER BY at ASC, <何か>`）で並びを約束する案は採らなかった（下）。

## 並びを現物で確かめた結果

「約束しない」が、現物の振る舞いと矛盾しない（約束しても守れない）ことを、実装を読むだけでなく、実際に動かして確かめた（確かめた日: 2026-09-30、手元の Postgres 17）。

- **`InMemoryEventStore.list`**: `Array.prototype.sort`（安定）で `at` の昇順に並べるので、`at` が同じなら**挿入順**が保たれる。`supersedeWithNewMemories` の `superseded`（戻り値）は入力順。
- **`PostgresEventStore.list`**: SQL は `ORDER BY at ASC` だけ。`memory_events` と同じ列・索引（`INCLUDING INDEXES` で写した）を持つ別の表に、`created` → `superseded` の順で同じ `at` の行を2万行入れ
  （挿入順＝行の物理順）、同じ `at` の組が逆順に返るかを、各組について数えた。
  | 状況 | 逆順になった組 |
  | --- | --- |
  | 既定の計画（索引走査）、挿入直後 | 0 |
  | 索引走査を止めて、全件走査＋ソート（メモリ内） | 0 |
  | 同、`work_mem` を小さくして外部ソート | 0 |
  | `created` の行を `UPDATE` して行の物理位置を後ろへ動かしたあと、既定の計画（索引走査） | 全組（1万組中1万） |
  | 同じあと、全件走査＋ソート | 約半分（1万組中5076） |
  つまり、普通は挿入順に見えるが、行の物理位置が動く（`UPDATE`・削除のあとの領域の再利用など）と入れ替わり、ソートを使う計画では不定になる。
  `memory_events` は追記専用なので `UPDATE` の経路は無いが、削除（保持期間の掃除）の後の領域の再利用は起こりうる。**挿入順は、Postgres では約束できない。**
  （⚠ 上の実験は別の表で行った。この repo の `PostgresEventStore.list` が、ある操作の後に実際に入れ替わった実例を得たわけではない。）
- **イベントを返すほかの口**: `MemoryStore.supersedeWithNewMemories` の `superseded`・`consolidate` 系の口の `events` は、**`at` で並べ替えず入力順**で返る
  （`insertMemoryEventsBatch` が「入力と同じ順で返す」）。`at` の順を約束する口は `EventStore.list` だけで、ほかの口は並びを約束していない。
- **`list` の結果の並びを当てにしている core の呼び出し側**: `eventStore.list(` の呼び出しは `packages/core/src` の非テストコードで1か所（`listWithdrawnAmong`）。
  `kind: "superseded"` で絞ったうえで**最後の1件**を読むので、`created` と `superseded` の並びには依らない（同じ Memory の別々の `superseded` どうしが同じ `at` になる場合だけが当たる。
  観測した限りそういう経路は無いが、確かめてはいない）。`@mnemora/postgres` の `DISTINCT ON (memory_id) … ORDER BY memory_id, at DESC`（`previewRestoreSupersededBy`）も `kind = 'superseded'` だけを見る。
  `grep -rn "eventStore.list\|\.list(ctx" packages/core/src packages/postgres/src packages/bullmq/src examples` で探した範囲（網羅の証明ではない）。

## 既存の文書との矛盾

**矛盾する約束は、見つからなかった**（探した場所: `docs/architecture.md`・`docs/memory-model.md`・`docs/conformance.md`・`packages/core/src/interfaces/event-store.ts`・
`packages/testkit/README.md`・`docs/decisions/*.md` を「同値」「同じ `at`」「挿入順」「昇順」「並び」で `grep`。網羅の証明ではない）。

- [ADR 0042](./0042-event-store-list-order-and-limit.md) と `EventStore.list` の doc は、元から「`at` が同値の行同士の順序は規定しない」と書いていた。この ADR はそれを強め、例と読み方を足しただけである。
- [ADR 0049](./0049-reinforce-monotonicity-in-pseudo-implementations.md) の表は、InMemory は安定ソート（挿入順）・Postgres は規定しない、と「割れている」ことを既に書いている。合っている。
- `docs/memory-model.md` §11 行1842 は、統合の `memory_events` を「統合元の `superseded`・統合先の `created`」と列挙するが、これは**並べて挙げただけ**で、読み出しの並びの約束ではない。
  書き換えていない。
- `docs/memory-model.md` §9 の追記（Issue #1234）は「`at` の順に読んでも、状態が変わった順とは限らない」と書く。この ADR の約束と同じ向きである。
- 修正が要る文書は無かった。

## 採らなかった案

- **`at` を組み立て時に揃える案**（`buildCreatedEventFor` の中で、`superseded` と同じ値を別の経路で得る）。組み立てる関数は `reextract` の入口の `now` を知らないので、
  知らせる口（引数）が結局要る。observe・抽出の経路と共有する関数に、別の経路の時刻を読む仕組みを隠すよりも、呼び出し側が渡す形のほうが、何が違うかが呼び出しの場所で読める。
- **`superseded` を後ろへ寄せる案**（`superseded` の `at` を `created` の `at` より後にする）。`superseded` の `now` は Issue #1237 が決めた規律（この呼び出し全体で1回）で、
  `consolidate` も同じ。`reextract` だけ `superseded` の `at` を変えると、`consolidate` との対称が崩れ、outbox の `now` ともずれる。
- **`reason` を `"reextracted"` に変える案。** 既存のキーの意味を変える（`reason: "extracted"` を前提にして読んでいる呼び出し側が壊れうる。確かめてはいない）。
  足すだけで済むので採らない。
- **`meta.reason` を変えず、`reextractedFrom` のような値を持つキーを足す案。** 区別だけが目的で、値を持たせる理由が無い（元の `created` は `sourceObservationId` で辿れる）。真偽値の印で足りる。
- **同じ `at` に、タイブレークを入れて並びを約束する案**（`ORDER BY at ASC, <連番か kind の順>`）。`memory_events` に並びを決める列が無い（追加はマイグレーションと適合テストの変更になる）うえ、
  `kind` の順は「`created` が先」という意味を固定してしまい、ADR 0416 が入れ替えた挿入順と、どちらが正しいかの決めが新しく要る。読み手が要るのは順ではなく**関係**（どの `superseded` がどの `created` の置き換えか）で、
  それは `meta.supersededById` で読める。約束を増やすより、当てにしないと書くほうが小さい。
- **`created` の `at` を store に決めさせる案**（`opts.now` を使う）。`created` の組み立ては core の `buildCreatedEvent` が持つので、store が上書きする経路が増え、
  名乗らない adapter・口なしの経路には効かない。core が `at` を決める形を保つ。

## 守れないもの・引き受けた負債

- 🔴 **`reextract` の `created` の `at` は、この ADR より前に書かれた行では直らない。** 既にある `memory_events` の `created` の `at` は、LLM の待ちの分だけ `superseded` より後のまま。
  書き直す道具は足していない（`memory_events` は追記専用）。
- 🔴 **`reextracted: true` の印は、この ADR より前の `reextract` の `created` には付いていない。** 印が無いことは「observe 由来」を意味しない。過去の行は `reextract` 由来かどうかを meta からは区別できない。
- **名乗らない・口なしの経路は、`at` と印は揃うが、同じトランザクションではない**（ADR 0416 の負債のまま）。
- **別の時計の読みは残る。** `created` の `at` は入口の `now`（core の `clock`）で、store が DB の `now()` を使う列（outbox の `available_at` など）とは別の時計である。この ADR は `memory_events` の `at` だけを揃えた。
- **`consolidate` の `created` の `at` は、この ADR の前から `now`。** `reflect` の `created` は別の時計（組み立て時）のままで、この ADR では触れていない。
- 並びの約束をしないので、呼び出し側が順を必要とすると `kind` と meta で関係を読む手間がかかる。

## これが覆るとしたら

- **オーナーが「同じ `at` のイベントの並びも約束する」と決めたとき。** そのときは、タイブレークの列（連番など）を `memory_events` に足すマイグレーションと、`EventStore` の適合テストが要る。
  ADR 0042 の「規定しても守れない約束になる」が、守れる形になる（そのための道具が入った）ときだけ成り立つ。
- **`reextracted` のほかに、`created` の由来を区別するキーが要るとき**（例: `consolidate`・`reflect` の `created` との区別）。`reason` は既に `consolidated`・`reflected` で区別できるので、足す必要が出るのは、
  `reason` が同じで由来が違う場合だけ。

## 確かめたこと

- **歯（`packages/postgres/src/__tests__/runtime-reextract-created-at-and-meta.postgres.test.ts`、InMemory / Postgres × 口あり・名乗らない・口なし × (a)(b)(c) = 18本）**:
  実装前（歯だけの commit `2f1071b`）は **12本が赤**（(a)(b) が全6組、(c) は実装前から緑の6本）。実装後は **18本すべて緑**。歯は変えていない。
  歯の `REEXTRACT_META_KEY` は `"reextracted"` で、この ADR のキー名と同じ。
- **変異試験**（1つ入れて赤くなることを見て、戻して緑に戻ることを確かめた。戻しは `cp`）:

  | 変異 | 赤くなった歯 |
  | --- | --- |
  | M1a: 口ありの経路に `at` を渡さない | (a) の2本（Postgres・InMemory の口あり） |
  | M1b: 名乗らない adapter の別の追記に `at` を渡さない | (a) の2本（名乗らない） |
  | M1c: 口なしの経路に `at` を渡さない | (a) の2本（口なし） |
  | M2: 印を足さない | (b) の6本（全経路） |
  | M3: 印を observe（抽出）の `created` にも足す | (c) の6本（全経路） |

  どれも、戻したあと18本が緑に戻った。
- core・testkit のテスト全体は緑（core 191 ファイル、testkit 73 ファイル）。`@mnemora/postgres` の適合テストと、既存の `created` 系の歯（`runtime-created-event-same-tx`・`observe-created-event-same-tx`）も緑。
  DB ありの全体実行（`test:db`）は走らせていない（この器では DB の作成・削除系の時間切れで揺れるため、門の条件にしていない）。

## 確かめていないこと

- 同じ Memory の別々の `superseded` が同じ `at` になる経路があるか（`listWithdrawnAmong` が最後の1件を読む箇所が、その並びに依るか）。観測した限りは無いが、網羅は確かめていない。
- `PostgresEventStore.list` が、実運用の操作（`reextract`・`consolidate`）のあとで、同じ `at` の `created` と `superseded` を実際に入れ替えて返した実例。上の表は同じ形の表での実験で、この repo の実装での再現ではない。
- 第三者の `EventStore` 実装が、同じ `at` をどう並べるか（約束しないので、歯も足していない）。
- `reflect` の `created` の `at` が、同じ操作の他のイベントと揃っているか（この ADR の範囲外）。
