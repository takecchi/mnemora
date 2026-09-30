# ADR 0416: `created` イベントを記憶と同じトランザクションで積む範囲を、reextract・consolidate の口あり経路と reflect へ広げる（穴 D-3 の続き）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

> **⚠ これはクローンの委譲で動く担い手が書いた。オーナーの判断ではない**（ADR 0220）。
> 方針（`supersedeWithNewMemories` の `opts` に組み立て関数を足し、store が積んだことを戻り値で名乗る・
> `createMemoriesWithOutboxAndEvents?` を reflect へ広げる・口なしの経路は直さない・経路ごとに新しい任意メソッドは足さない）は、
> 委譲元のマネージャーが決めた。この ADR はその内側の設計と、確かめたことを書く。

---

## 文脈

[ADR 0410](./0410-extract-created-event-in-same-transaction.md) は、抽出の経路の `created` だけを、記憶と同じトランザクションで積むようにした
（任意メソッド `createMemoriesWithOutboxAndEvents?`）。同 ADR の「残り」が、範囲外の経路の `created` は今までどおり別コミットで、
**記憶を書いたあと・イベントを積む前に落ちると、抽出と同じ形の取りこぼし**（記憶は在るのに `created` が0件。再試行は素通りする）を残す、と書いていた。

この ADR は、そのうち**口あり**の経路を直す。

### 数え方（「6経路」と5か所の差）

`runtime.ts` で `created` を別の文（`appendCreatedEvent` または `eventStore.append`）で積む所は、#1496（ADR 0410）の実装後に次のとおり。

| # | 経路 | 口 | 今回 |
| --- | --- | --- | --- |
| 1 | 抽出（`createMemoriesFromCandidates`）の、`createMemoriesWithOutboxAndEvents?` を持たない adapter 向けの旧経路 | 口なし | 直さない |
| 2 | `reextract` の `supersedeWithNewMemories` を使う経路 | 口あり | **直す** |
| 3 | `reextract` の `createMemoryWithOutbox` のループ | 口なし | 直さない |
| 4 | `consolidate` の `supersedeWithNewMemories` を使う経路 | 口あり | **直す** |
| 5 | `consolidate` の `createMemoryWithOutbox` | 口なし | 直さない |
| 6 | `reflect` | （口は `createMemoriesWithOutboxAndEvents?`） | **直す**（口が無い adapter は直さない） |

合わせて **6か所**。ADR 0410 の「残り」は、このうち #1 を抽出の旧経路として数えず、#2〜#6 の**5か所**と書いた
（同 ADR は「委譲の指示は『6経路』と数えていたが、`grep` で見つけたのはこの5箇所」と書き、差は「数え方の違いか、見落としか確かめていない」としていた）。
**差は数え方の違いだった**: 「6」は #1496 より前の数えで、抽出の口なし（#1）を含む。ADR 0410 の「5」は #1 を「すでに扱った経路」として除いた数である。
見落とした箇所は無い（今回 `grep -n "appendCreatedEvent\|eventStore.append" packages/core/src/runtime.ts` と `kind: "created"` で数え直した。網羅の証明ではない）。

## 決めたこと

1. **`supersedeWithNewMemories` の `opts` に、任意の `buildCreatedEvent?: (memory: Memory, index: number) => NewMemoryEvent` を足す。**

   ```ts
   supersedeWithNewMemories?(
     ctx: Ctx,
     news: ReadonlyArray<{ input: NewMemory; jobKinds: OutboxJobKind[] }>,
     supersede: ReadonlyArray<{ id: MemoryId; supersededByIndex: number; expectedStatus?: MemoryStatus; event: NewMemoryEvent }>,
     opts?: {
       now?: Date;
       abortIfForgotten?: ReadonlyArray<MemoryId>;
       buildCreatedEvent?: (memory: Memory, index: number) => NewMemoryEvent;
     },
   ): Promise<{
     created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
     superseded: MemoryEvent[];
     conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }>;
     createdEventsWritten?: true;
   }>;
   ```

   - store は、`created: true` になった `news[index]` の Memory ごとに `buildCreatedEvent(memory, index)` を**同じトランザクションの中で**呼び、
     返ったイベントを `memory_events` へ INSERT する（`EventStore.append` は経由しない）。`created: false`（冪等な再送で既存行に衝突した要素）には呼ばない。
     `meta.supersededById` のような追記はせず、返り値をそのまま書く。関数は ADR 0410 の `buildCreatedEvent` と同じく**同期・副作用なし**。
   - INSERT が失敗したら**トランザクション全体が巻き戻る**（`news`・`supersede`・outbox が残らない）。
   - 書く順は、`news` → `created` → `supersede`。`created` を `supersede` の処理より前に置いた。`supersede` の対象が「無い」失敗は今までどおり全体を巻き戻し、
     `created` が落ちても `supersede` にはまだ触れていない（InMemory が、`supersede` の事前検証後は投げない形を保てる）。
   - 引数の名前と形（`buildCreatedEvent`）は ADR 0410 の関数に揃えた。第2引数だけ、`dropped` ではなく `news` の索引（`index`）にした——
     この口に「落とした候補」は無く、呼び出し側が索引で `news[index]` を引けるほうが使いやすいため。
   - `abortIfForgotten`（ADR 0375 決定7・0406）は今までどおり `news`/`supersede` のどちらの書き込みよりも前に見直す。
     `SourceMemoryForgottenError` の扱い（`reextract` は `aborted_source_forgotten`、`consolidate` も同様）は**変えていない**。

2. **積んだことは、戻り値の `createdEventsWritten: true` で名乗る。core は、名乗られたときだけ別の `created` の append を省く。**

   - 名乗るのは `opts.buildCreatedEvent` を**渡された**呼び出しのときだけ（渡していなければ付けない）。
   - **理由**: オプション引数だけでは、core から store の対応の有無が見えない。`supersedeWithNewMemories` を実装するが `opts.buildCreatedEvent` を知らない既存の第三者の adapter は、
     引数を**黙って無視する**。core が「引数を渡したから積まれた」と決めて別の append を省くと、そういう adapter で `created` がまるごと消える（退行）。
     名乗りがあれば、名乗らない adapter は今までどおり別の文で積まれる。
   - ⛔ 撃って投げられたときに旧経路（別の append）で撃ち直さない（ADR 0100 の規律。二重に書きうる）。core の `catch` は `SourceMemoryForgottenError` を結果に写す以外は投げ直す。
   - core の呼び出し側:
     - `reextract`: `buildCreatedEvent: (memory) => buildCreatedEventFor(ctx, memory, observation, "ok", null)`（ADR 0410 が切り出した `buildCreatedEventFor`。別の append の旧経路とずれない）。
     - `consolidate`: 既存の `buildCreatedEvent`（`meta.reason: "consolidated"`）を、`memoryId: ""`・`digestSnapshot: ""` のプレースホルダを呼び出し側が上書きする形から、
       Memory を受け取って `memoryId`/`digestSnapshot` を埋める形に直して共有した（口あり・口なしの両経路で同じ関数）。

3. **`createMemoriesWithOutboxAndEvents?` の `opts` に `abortIfForgotten` を足し、`reflect` がそれを1件で使う。**

   - store は、どの候補の書き込みより前に、同じトランザクションで対象を見直し（Postgres: `assertNotForgottenForUpdate` = `SELECT … FOR UPDATE`）、forgotten が1件でもあれば
     `SourceMemoryForgottenError`（`method: "createMemoriesWithOutboxAndEvents"`）を投げる。候補ごとの SAVEPOINT の**外**で呼ぶので、`dropped` には積まれずそのまま投げられ、何も書かれない。
     InMemory は `createMemoryWithOutbox`・`supersedeWithNewMemories` と同じく**実装しない**（渡しても無視。適合テストは `supportsAbortIfForgotten: false` でそれを assert する）。
   - `reflect` は、store が口を持つなら内省の Memory を1件でこの口に書く（`created` の組み立ては core の関数。`meta.reason: "reflected"`）。**全件が落ちたら**（候補は1件なので、その1件が落ちたら）
     store が最初の例外を投げる——今までの `createMemoryWithOutbox` が投げたのと同じ例外が、そのまま伝わる。`dropped` は空のはずで、契約に反して `written` が空で返ったときだけ core が投げる。
   - 口が無い adapter は、**今までの経路のまま**（`createMemoryWithOutbox` ＋別の `eventStore.append`）。口の有無だけで経路を選び、撃って投げられたときに撃ち直さない。
   - この口には名乗りを足さない。口そのものが「`created` を同じトランザクションで積む」契約であり、ADR 0410 が口の有無だけで経路を選んでいる形を変えない（口を持つのに積まない adapter は、適合テスト（ADR 0410 の2本）が見抜く）。
   - **このメソッドは 1.2.0 で未リリースである**（CHANGELOG の `## [1.2.0] - 未リリース` に載っている。リリース済みの版には無い）。だから `opts` を広げても、リリース済みの第三者の実装を壊さない。
     もし 1.2.0 が出たあとに同じことをしたら、任意の引数の追加でも、実装側の型が合わなくなる adapter が出うる（実装側は `opts` の型を狭く書いていると受け取れない）。
   - `reflect` の `catch` は、同じ関数内の既存の分岐と同じく `isSourceMemoryForgottenError`（`kind` で判定。[ADR 0418](./0418-store-error-kind-guards.md)）で判定する。`instanceof` は使わない。
   - 公開の型に1点、小さな変化がある。`SourceMemoryForgottenError.method` の union に `"createMemoriesWithOutboxAndEvents"` を足した。この欄で網羅的に分岐（`never` 検査）している呼び出し側は、型検査で新しい値を指摘される
     （ADR 0410 が `ContestedWithoutCompanionError.method` に足したのと同じ形）。

4. **口なしの経路は直さない**（reextract・consolidate・reflect・抽出の口なし）。上の表の #1・#3・#5 と、#6 のうち口が無い adapter の経路。引き受けた負債として、下に書く。

5. **実装は `@mnemora/postgres` の `PostgresMemoryStore` と、`@mnemora/testkit` の `InMemoryMemoryStore`。**
   - Postgres: `memory_events` への `created` の INSERT を モジュール内の関数 `insertCreatedEventRow` に切り出し、`createMemoriesWithOutboxAndEvents`（ADR 0410）と
     `supersedeWithNewMemories` が共有する（SQL を書き写さない）。`supersedeWithNewMemories` は `news` の INSERT のあと、`supersede` の処理の前に、`created: true` の要素ぶんを積む。
   - InMemory: `news` を書いた同じ同期区間で、`supersede` に触れる前に `created` を共有の `events` 配列へ積む。積めなければ（イベントが書けない値・`push` が投げる）、`news` の Memory・outbox・ラベルと積みかけのイベントを全部戻して投げる。
   - `created` が `superseded` より前に積まれる（今までは `superseded` のあと）。`PostgresEventStore.list` の並びは `ORDER BY at ASC` だけで、同点の並びは仕様の外なので、読み出しの並びは仕様上は変わらない。
     ⚠ `consolidate` は `created` と `superseded` が同じ `at`（`now`）を持つ。同点の並びを当てにしていた呼び出し側があれば順が入れ替わりうる（確かめていない。そういう呼び出し側は今のところ見つけていない）。

6. **適合テストを足す**（`@mnemora/testkit`）。
   - `supportsSupersedeCreatedEvents?`（任意の3状態フラグ。`supportsCreateMemoriesWithOutboxAndEvents?` と同じ形）。`true` は3本（`created: true` の `news` ごとに積む・`created: false` には積まない・名乗る／
     `buildCreatedEvent` を渡さなければ名乗らず積まない／`created` が失敗したら `news`・`supersede`・outbox が残らない）、`false` は1本（渡されても名乗らず積まないことを assert）、省略は「⚠ 未検査」の named it。
     Postgres と InMemory で `true`。`conformance-omitted-flags-named-it.test.ts` の一覧に足した。
   - `createMemoriesWithOutboxAndEvents` の `abortIfForgotten`: `supportsAbortIfForgotten: true` の adapter で2本（forgotten を含むと `SourceMemoryForgottenError`・何も書かない／forgotten でなければ書いて `created` も積む・空配列と省略は見直さない）、
     `false` の adapter で1本（無視して書く）。口を持たない adapter（`supportsCreateMemoriesWithOutboxAndEvents` が `true` でない）では登録しない。

## 採らなかった案

- **(a) 経路ごとに新しい任意メソッドを足す案**（例: reextract・consolidate 用に `supersedeWithNewMemoriesAndEvents?`、reflect 用に `createMemoryWithOutboxAndEvent?`）。
  `MemoryStore` の口が増える。`supersedeWithNewMemories` の意味論（CAS・`conflicted` の部分成功・`supersededByIndex`・`abortIfForgotten`・`created` と `news` の対応）を新しい口が複製するか、
  ほとんど同じ口を2つ持つことになり、適合テストと第三者の実装の負担が2倍になる。口の有無の組合せ（`supersede` の有無 × 新しい口の有無）も増え、core の分岐が読みにくくなる。
  引数を足すだけなら、既存の口の意味論は1箇所のまま、足す欄は `created` に限られる。
- **名乗りの無いオプション引数だけの案**（`buildCreatedEvent` を足し、戻り値は変えず、core は渡したら別の append を省く）。
  上の決定2の理由のとおり、引数を黙って無視する既存の adapter で `created` がまるごと消える退行になる。`createdEventsWritten` の1欄で、core が対応の有無を見分けられる。
- **`createMemoriesWithOutboxAndEvents` を `supersede` まで広げる案**（`supersede` の引数と `conflicted` を足す）。
  この口は候補ごとの SAVEPOINT・`dropped`・全候補の成否が確定してから `created` を積む順序・`written`/`dropped` の戻り値という、抽出に寄せた意味論を持つ。
  `supersedeWithNewMemories` の CAS・`conflicted`（部分成功で commit）・`supersededByIndex` の範囲検査・`abortIfForgotten` をそこへ混ぜると、2つの意味論が1つの口に同居し、
  ADR 0410 の適合テストと ADR 0100 の適合テストの両方が書き換わる。**reflect への `abortIfForgotten` の追加は、未リリースの口への小さな引数の追加で足りる**ので、それだけを広げた（決定3）。
- **`created` の追記が失敗したときだけ、旧経路で撃ち直す案。** ADR 0410 と同じ理由（記憶が既にコミットされたか判断できず、二重に書きうる。ADR 0100 の規律）で採らない。
- **口なしの経路も直す案**（`createMemoryWithOutbox` に `created` のイベントを渡す引数を足す、など）。口なしの経路は `createMemoryWithOutbox` と別の `updateStatusWithEvent` を並べる形で、1件ずつコミットする設計そのものである
  （ADR 0100「旧経路」）。`created` だけを同じトランザクションに入れても、`supersede` との非同時性は残る。決められた方針（口なしは直さない）に従う。

## 引き受けた負債（守れないもの）

- 🔴 **口なしの4経路は、今までどおり取りこぼしうる。**抽出の口なし（#1）・`reextract` の口なし（#3）・`consolidate` の口なし（#5）・`reflect` の口なし（`createMemoriesWithOutboxAndEvents?` を持たない adapter。#6 の一部）。
  記憶を書いたあと・`created` を積む前に落ちると、記憶だけが残る。再試行は、`reextract` は同じ内容の記憶が「在る」と見て素通り、`consolidate` は統合元が `superseded` なので対象なし、`reflect` は孤児の反映先が残る。
  ⛔「ADR 0416 が入ったから `created` を取りこぼさない」と読まないこと。守られるのは、口を実装した adapter（`@mnemora/postgres`・`@mnemora/testkit` のインメモリ）の上だけ。
- 🔴 **名乗らない adapter（`supersedeWithNewMemories` を実装するが、`opts.buildCreatedEvent` を知らない既存の第三者の実装）では、`reextract`・`consolidate` の `created` は今までどおり別の文で積まれる。**
  退行は無い（`created` は消えない）が、取りこぼしの窓は残る。core の `FakeMemoryStore`（テスト用）は名乗らない。`FakeMemoryStore` に対する core のテストが緑なのは、名乗らない経路の歯として意図したもの
  （`created-event-claim.test.ts` の「名乗らない adapter」、`consolidate.test.ts`、`language-mismatch-mark.test.ts`）。
- 🔴 **名乗るのにトランザクションを張らない adapter は、この機構では見抜けない。**`createdEventsWritten: true` は「積んだと宣言した」ことしか意味しない（ADR 0100・0410 の「原子性の証拠ではない」と同じ）。
  適合テストは失敗の注入（`at` が Invalid Date のイベント）の1形で「`created` が落ちたら `news`/`supersede`/outbox が残らない」を縛るが、第三者 adapter がその形では巻き戻し、別の形の失敗では巻き戻さない、
  という実装は見抜けない。
- 🔴 **名乗るのに積まない adapter** は、core が別の append を省くので `created` が消える。適合テストの「名乗る」の歯（積まれた `created` の件数を見る）がこれを見抜く。ただし適合テストを走らせていない adapter では見抜けない。
- **`conflicted`（CAS に弾かれた対象）があっても、`created` は積まれる。**`supersedeWithNewMemories` は CAS に弾かれても `news` を commit する部分成功の設計（ADR 0100 決定3）で、`created` はその `news` のものである。
- **`abortIfForgotten` を実装しない adapter（InMemory・core の `FakeMemoryStore`）では、`reflect` の口を通っても同トランザクションの見直しは行われない**（呼び出し側の `getMany` の見直しだけが保護。ADR 0375 決定7の限界のまま）。
- 公開の型の小さな変化: `SourceMemoryForgottenError.method` の union に値が1つ増えた（決定3）。
- `created` と `superseded` の挿入順が入れ替わった（決定5）。

## これが覆るとしたら

- **オーナーが「`created` イベントも §11 行5 の対に含める」と決めたとき。**そのとき任意メソッドでは足りず、口なしの4経路と名乗らない adapter の扱い（必須化＝破壊的変更）の判断が要る（ADR 0410 の同じ項）。
- **`supersedeWithNewMemories` を実装しながら `buildCreatedEvent` を無視する adapter が実運用で見つかったとき。**名乗りの仕組みは、その adapter で `created` が消えないことを守るが、窓は閉じない。その adapter を直す（口を実装させる）判断が別に要る。
- **口なしの経路の取りこぼしが実運用で見つかったとき。**その経路を直す判断（別の ADR）。
- **`createMemoriesWithOutboxAndEvents` が 1.2.0 でリリースされたあとに、同じ形の広げ方が必要になったとき。**未リリースだから引数を足して済ませた決定3は使えない。

## 確かめたこと

- **歯（`packages/postgres/src/__tests__/runtime-created-event-same-tx.postgres.test.ts`、InMemory / Postgres × 5本 = 10本）**: 実装前は歯だけを commit した `751de94` で **10本すべて赤**（手元で再確認した）。
  実装後は **10本すべて緑**。**歯を1行だけ直した**: reextract の歯の末尾が `listBySourceObservation` の結果を「新しい記憶だけ」と期待していたが、この口は status で絞らない
  （`superseded` になった旧い記憶も返す。interface の doc どおり）ので、旧い記憶が混ざって赤になっていた（実装の退行ではなく、歯の期待の誤り）。`status === "active"` で絞る形に直した。
  縛っている内容（失敗中は何も残らない・再試行後に新しい記憶の数だけ `created` が揃う・旧い記憶が `superseded`）は弱めていない。
- **変異試験**（実測。1つ入れて赤くなることを見て、戻して緑に戻ることを確かめた。戻しは `cp`）:

  | 変異 | 赤くなった歯 |
  | --- | --- |
  | M1: Postgres の `supersedeWithNewMemories` が名乗りを返さない | 歯 Postgres の2本（reextract・consolidate 直接。二重に積まれて件数が揃わない）＋適合の2本 |
  | M1': InMemory の `supersedeWithNewMemories` が名乗りを返さない | 歯 InMemory の2本＋適合（InMemory）の2本 |
  | M2: Postgres が名乗るのに `created` を積まない | 歯 Postgres の3本（reextract・consolidate の直接とジョブ）＋適合の2本 |
  | M2': InMemory が名乗るのに `created` を積まない | 歯 InMemory の3本＋適合（InMemory）の2本 |
  | M3: Postgres の `supersedeWithNewMemories` が `created` を tx の外（commit のあと）に出す | 歯 Postgres の3本＋適合の1本（`created` 失敗で巻き戻らない） |
  | M3': Postgres の `createMemoriesWithOutboxAndEvents` が `created` を tx の外に出す | 歯 Postgres の2本（reflect の直接とジョブ）＋適合の1本（ADR 0410 の `created` 失敗の歯） |
  | M3'': InMemory の `supersedeWithNewMemories` が失敗時に巻き戻さない | 歯 InMemory の3本＋適合（InMemory）の2本（うち1本は既存の「`news` の途中で失敗したら何も残さない」の歯） |
  | M4: `reflect` が口を使わない（`createBatch` を `undefined` にする） | 歯の reflect 4本（InMemory・Postgres × 直接・ジョブ）＋core の新しい歯2本 |
  | M5: Postgres の `createMemoriesWithOutboxAndEvents` が `abortIfForgotten` を無視する | 適合の1本＋`consolidate-reflect-source-forgotten-for-update-race` の reflect（口あり）10本（下の「既存の歯の調整」。調整前は実装が正しくても時間切れで赤になっていたので、この変異の根拠にしたのは調整後の実測） |
  | M6: core が名乗りを見ず、常に別の append を省く | 名乗らない adapter の歯: core の既存の3本（`consolidate.test.ts` の2本・`language-mismatch-mark.test.ts` の1本）＋新しい2本 |
  | M6': core が名乗りを見ず、常に別の append も足す | 名乗る adapter の歯: core の新しい2本（二重に積まれる） |

- **既存の歯1ファイルを、reflect が使う口に合わせて直した**（`consolidate-reflect-source-forgotten-for-update-race.postgres.test.ts`）。この歯は `createMemoryWithOutbox` の入口に障壁を置いて reflect を止め、その間に forget・purge を割り込ませる。
  reflect が `createMemoriesWithOutboxAndEvents` を呼ぶようになったので障壁に届かず、reflect の10本が30秒の時間切れで赤になった（**実装の退行ではなく、歯が縛っていた経路が口を持つ store では通らなくなった**。ADR 0410 が2本の歯を直したのと同じ形）。
  歯を弱めず、(1) 同じ障壁を `createMemoriesWithOutboxAndEvents` の入口にも置いた reflect（口あり）10本にし、(2) 口を `undefined` にして `createMemoryWithOutbox` の経路を走らせる reflect（口なし）10本を足した。どちらも、見直しを外す変異（M5）で赤になる（口なしの経路の見直しを外した場合は、既存の `createMemoryWithOutbox` の適合の歯が縛る）。
- **手元の `pnpm run test` で赤が3つ残った（この変更とは無関係）**: `dedicated-schema.postgres.test.ts`・`migrate-ledger-handover.test.ts`・`role-name-schema-lock-key.postgres.test.ts` の `afterAll` が30秒で時間切れ。
  [ADR 0414](./0414-drop-database-checkpoint-wait-not-fixed.md)（`DROP DATABASE` の checkpoint 待ち。直さないと判断した）が記録している症状と一致する。この3本を単独で走らせると3ファイルとも緑（19本）で、全体実行（並列）の1回目だけ時間切れになり、歯を直したあとの2回目の全体実行では赤が無く、ルートの test 門は通過した。main で全体実行して同じ赤が出るかは確かめていない（この3本は本変更のコードを通らない）。
- **名乗らない adapter の経路の歯**: core の `FakeMemoryStore` は `supersedeWithNewMemories` を持つが第4引数を受け取らず名乗らない。`FakeMemoryStore` に対する既存の core のテスト（reextract・consolidate の `created` を数える歯）が緑であること自体が、
  名乗らない経路の歯になる（M6 で赤になる）。加えて `created-event-claim.test.ts` が、名乗る adapter・名乗った後に投げる adapter（旧経路で撃ち直さない）・reflect の口の有無と `SourceMemoryForgottenError` を縛る。
- 適合テスト: Postgres とインメモリの両方で、追加した歯が緑（実行した数字は PR 本文）。

## 確かめていないこと

- 口なしの経路（#1・#3・#5・#6 の一部）が、実際に取りこぼす入力を歯で確かめていない（同じ形であることをコードで読んだだけ）。
- **本物の並行**での、`created` の INSERT と `abortIfForgotten` の `FOR UPDATE` の相互作用。`reflect` の既存の並行の歯（`consolidate-reflect-forget-race`・`consolidate-reflect-source-forgotten-for-update-race`）は口を通っても緑だが、`created` の INSERT の有無で変わる窓は測っていない。
- 第三者 adapter が `buildCreatedEvent` を実装し、かつ `created` の失敗で正しく巻き戻すか（決定2・負債）。
- 同じ `at` の `created` と `superseded` の並びを当てにする呼び出し側が無いこと（決定5。見つけていないだけで、網羅は確かめていない）。

## 追記 (2026-09-30): `reextract` の `created` の `at` と meta、同じ `at` のイベントの並びは [ADR 0422](./0422-reextract-created-event-at-and-meta.md)

- 決定5の「`created` と `superseded` の挿入順が入れ替わった」と「確かめていないこと」の最後の項（同じ `at` の並びを当てにする呼び出し側）について、[ADR 0422](./0422-reextract-created-event-at-and-meta.md) が
  **同じ `at` のイベントどうしの並びは約束しない・当てにしてはいけない**ことを文書に明記した（`EventStore.list` の doc・`docs/architecture.md` §5.8・ADR 0422）。`InMemoryEventStore.list` は挿入順を保つが、
  Postgres の `ORDER BY at ASC` は保たない（行の物理位置が動くと入れ替わる。ADR 0422 に実測）。
- この ADR が入れた `reextract` の `created` には、`at` が同じ操作の `superseded` と揃っていない（組み立て時の `clock.now()`）点と、再抽出から来たことを示す meta の印が無い点が残っていた。
  ADR 0422 が、`at` を入口の `now` に揃え、meta に `reextracted: true` を足した。
