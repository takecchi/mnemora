# ADR 0600: 多者間 contested の群（ADR 0381）の確かめ直しで見つかった穴を塞ぐ（解消での関係の削除の範囲・段3が抜けたメンバーを越えない・同伴の `attributes` の絞り・claim key の合併と人数の境界・`markContestedGroup` の対の片割れ）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンのマネージャー（mgr-9a36f2f4）の作業者が書いた。歯を書く穴を選んだのはクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・CHANGELOG は触らない（[ADR 0598](./0598-adr-0490-0480-0485-merged-pr-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯【実測】

PR #1442（多者間 contested の関係グラフと書き込み経路、[ADR 0381](./0381-contested-group-write-path-implementation.md)）を確かめ直したとき、約束ごとに「足りない実装」「やりすぎた実装」の変異を当て、次の6つがすり抜けた。

| # | 約束 | すり抜けた変異 | 通った理由 |
|---|---|---|---|
| 1 | 解消が消す関係の行は群の中だけ | `resolveContestedGroup` の DELETE の条件を `from ANY AND to ANY` から `OR` にする（postgres・testkit・core の Fake の3実装すべて） | forget で抜けた記憶との行・群の外の記憶と `link` した行が、解消の後も残ることを見る歯が無かった |
| 2 | 段3は群を離れたメンバーを越えて辿らない | 段3の幅優先で `status !== 'contested'` のメンバーも次の frontier に入れる | 既存の歯は三角形の群で、真ん中が抜けても他の道で届くので区別できなかった |
| 3 | 群の同伴は `attributes` の絞りを通る | 段3の `survivesAttributesFilter` の絞りを外す | `attributes` で絞った recall に群の同伴が入る構図が無かった |
| 4 | claim key の合併は contested の記憶だけを足す | 合併で読み直した記憶の `status === 'contested'` の絞りを外す | 群を離れた記憶へ関係の行が残る構図で、観測を重ねる歯が無かった |
| 5 | 広げた結果が2件なら群にしない（`size >= 3`） | `memberIdSet.size >= 3` を `>= 2` にする | `relationStore` を配線して、広げた結果が2件で終わる構図を踏む歯が無かった |
| 6 | testkit・Fake の `markContestedGroup` は群の外の対の片割れを断る | eligible の判定（`contestedWithId` が null か群の中を指す）を常に真にする（testkit の InMemory・Fake。Postgres は捕まる） | 対 A-B の A と C・D を渡す歯が無かった |

## 決定【判断】

1. 実装は変えない。
2. 歯を足す（試験だけ）。
   - **1**: 実装横断は `packages/testkit/src/__tests__/memory-store-round31-teeth.ts` に「A17b」（InMemory と postgres に同じ本文が流れる）。群5件のうち1件を forget し、残り4件で解消した後、forget 済みの記憶・群の外の記憶（`link` で両向きに張る）との行だけが `relatedIds` に残ることを見る。そのため `Round31Kit` に `linkContradicts` を足し、`memory-store-round31.test.ts`（InMemory）と `memory-store-round31.postgres.test.ts` が `relationStore.link` へ配線した。Fake は `packages/core/src/__tests__/resolve-contested-group.test.ts` に同じ構図の1本。
   - **2**: `recall-relation-group-companion.test.ts` と postgres 版 `recall-relation-group-companion.postgres.test.ts` に、鎖 a-b-c（有効期間をずらして a-c を重ねない）の真ん中の b を archived にして a を引き、b も c も入らないことを縛る。⚠ forget した記憶は `getMany` が返さないので、探索に入らず、status の門に当たらない。門に当たるのは「まだ読めるが contested でなくなった」記憶なので、archived にした【実測】。
   - **3**: 同じ2ファイルに、群3件のうち1件の `attributes` を絞りの外にして、`attributes` で絞った recall の同伴にその1件が入らないことを縛る。`subjectId`・`period` は同伴取得では見ない設計（`fetchMandatoryCompanions` の TSDoc）なので、`attributes` の絞りだけを縛った。
   - **4・5**: `claim-key-contested-group-detection.test.ts` に2本。3件の群のうち1件を archived にして、残り2件と重なる新しい記憶を `observe` すると `contested_group` になること（4）。残りが1件だけの contested に重なる新しい記憶を `observe` すると、例外を投げず `unresolved_conflict` になること（5）。どちらも `relationStore` を配線する。
   - **6**: `memory-store-round31-teeth.ts` に「A17c」（InMemory と postgres）、Fake は `mark-contested-group.test.ts`。対 A-B のうち A と C・D の3件を渡すと `MemoryStatusConflictError` で、B は contested のまま、C・D は active のまま。対の両方（A・B・C）を渡せば通ることも見る（断る条件を締めすぎる実装を捕まえる）。Fake の本文は、Runtime が先に `ineligible` で弾くので、store の `markContestedGroup` に直に当てる。

## 変異試験【実測】

実装ファイルを `cp` で退避し、変異を Edit で1つずつ入れ、名指しのファイルを走らせ、`cp` で戻して `cmp` で同一を確かめ、同じファイルを緑に戻した。

| 変異 | 赤 | 戻して |
|---|---|---|
| 1 やりすぎ: postgres の DELETE を `OR` | A17b（`expected [] to deeply equal [ …(2) ]`） | 3本緑 |
| 1 足りない: postgres の DELETE に `from_memory_id < to_memory_id` を足す | A17b（`expected [ …(3) ] to deeply equal [ …(2) ]`） | 3本緑 |
| 1 やりすぎ・足りない: InMemory の DELETE（`OR`／同じ `<` の条件） | A17b | 3本緑 |
| 1 やりすぎ・足りない: Fake の DELETE（`OR`／同じ `<` の条件） | resolve-contested-group の新しい1本（`expected [] to deeply equal [ 'mem-106', 'mem-107' ]`／`[ 'mem-102', 'mem-106' ] to deeply equal [ 'mem-106' ]`） | 15本緑 |
| 2 やりすぎ: 段3で非 contested も `nextFrontier` に入れる | core・postgres の鎖の歯（`expected [ … ] to not include …`） | core 15本・postgres 11本緑 |
| 3 やりすぎ: 絞りを外す（`eligible = discoveredMemories`） | core・postgres の `attributes` の歯 | 同上 |
| 3 足りない: 絞りを反転（`!survivesAttributesFilter`） | core の11本が赤（同伴が1件も入らない） | 15本緑 |
| 4 やりすぎ: 合併の `status === 'contested'` の絞りを外す | 4 の歯（`contested_group` にならない） | 7本緑 |
| 5 やりすぎ: `size >= 2` | 5 の歯（`RangeError: … must have at least 3 entries`） | 7本緑 |
| 4・5 足りない: `size >= 4` | 既存の2本と4の歯の計3本 | 7本緑 |
| 6 やりすぎ: InMemory・Fake の eligible を `contested && true` | A17c（`expected false to be true`）・Fake の歯（`promise resolved … instead of rejecting`） | 3本・13本緑 |
| 6 足りない: `ids.includes(…)` の分岐を外す | A17c（対の両方を渡す側が `MemoryStatusConflictError`）・Fake の歯 | 同上 |

## 縛っていないもの

- **2 の足りない側（群を離れていないメンバーまで frontier に入れない変異）**: 既存の「A-B・A-C がつながり B-C はつながっていない」鎖の歯（2段で届く）が捕まえると読み、新しい歯では変異を当てていない【未確認】。
- **6 の Postgres の変異**: Postgres はもとから捕まる（確かめ直しで確認済み）ので、再度は当てていない。
- **4・5 の postgres 版**: Fake だけで足りる構図（`runtime.ts` の分岐は実装に依らない）と見て、足していない【判断】。
- **forget した記憶が `getMany` に出ないこと自体**: この PR の約束ではなく、2 の歯の前提として確かめただけ（forget のまま書くと変異がすり抜けた【実測】）。

## これが覆るとしたら

解消が消す関係の行を群の外にも広げると決めたとき（ADR 0381 の「一度解消したら再び争わせない」印を作る場合）。段3が群を離れたメンバーの先も辿ると決めたとき。群の同伴が `attributes` を見ないと決めたとき（`fetchMandatoryCompanions` の設計）。群の最小人数を3から変えるとき。
