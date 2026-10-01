# ADR 0451: `createMemoriesWithOutboxAndEvents` の候補ごとの savepoint の `rollback to savepoint` が失敗しても、元のエラーを消さない（`dropped` に積まず、続けず、元のエラーを投げる）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。直し方の線はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**
出所の区別: 【現物】は読んだコード、【実測】は手元（PostgreSQL 17、`initdb` で立てた自分専用のインスタンス）で走らせた結果、【判断】は担い手の判定。

- **文脈**:

  [ADR 0444](./0444-pool-begin-release-rollback-error-preserved.md) は、drizzle-orm 0.45.2 の `NodePgSession.transaction` が `rollback` の失敗で元のエラーを消すことを、`createPostgresClient` の包みで直した。
  同じ形が入れ子の `NodePgTransaction.transaction`（savepoint 版）にもある。穴探し24巡目の調査で確かめた。

  1. **【現物】** drizzle の `NodePgTransaction.transaction`（`node_modules/drizzle-orm/node-postgres/session.js`）は
     `catch (err) { await tx.execute(rollback to savepoint …); throw err; }` で、`rollback to savepoint` が投げると `throw err` に届かず、元のエラーを捨てる。
     本体が成功したあとの `release savepoint` の失敗も、同じ `catch` に落ちて、続けて `rollback to savepoint` を撃つ。
  2. **【現物】** `@mnemora/postgres` の store で入れ子の `tx.transaction(` を使っているのは `createMemoriesWithOutboxAndEvents` の候補ごとの1か所だけ（`grep -n "\.transaction(" packages/postgres/src/*.ts`）。
     **ADR 0444 の「引き受けた負債」の「store が入れ子の `transaction` を使っていないことを確かめていない【未確認】」は、使っているが正しい。**
  3. **【実測】** その1か所で、`rollback to savepoint` が失敗すると次の形になる。`Client.prototype.query` を差し替え、`rollback to savepoint` だけを送らずに reject させた（接続・トランザクションは生きている）。
     悪い候補は本文に NUL（22021）。JS 側で落ちる候補は `status: "contested"` で `contestedWithId` なし（SQL を撃つ前に `ContestedWithoutCompanionError`）。

     | 場面 | 直す前 |
     |---|---|
     | S1 全候補が悪い | 投げられるのは `Failed query: rollback to savepoint sp1`。元の 22021 は消える |
     | S2 良い→悪い | `created` の INSERT が 25P02（aborted）で落ち、それが投げられる。元の 22021 も巻き戻しの失敗も消える |
     | S3 良い→JS 側で落ちる候補 | **正常終了する**。`created` の `meta.droppedCandidates` に載る理由は、`ContestedWithoutCompanionError` ではなく「rollback の失敗」 |
     | S6 良い→良い、最初の outbox INSERT がクライアント側だけで失敗し、巻き戻しも失敗 | **正常終了する**。最初の候補の `memories` 行が outbox 行なしで残り（embed ジョブが積まれない）、その候補は `dropped` に積まれて報告される |
     | 接続ごと切る | 投げられるのは外側の `rollback` の失敗。元のエラーは消える（ADR 0444 の BG-2 と同じ） |

     `runtime.observe` 経由でも確かめた。
     - NUL 候補を含む抽出結果＋巻き戻しの失敗（S2 型）: 直す前は 25P02 が呼び出し側へ届いた。
     - **S3 型（runtime.observe 経由）**: runtime 自身は `contested` の候補を作らないので、store の手前（Proxy）で2件目を `status: "contested"`（相手なし）に書き換えて通した。
       **直す前は `observe` が正常に返り**（`memoryIds` は1件）、**`created` イベントの `meta.droppedCandidates` に載った理由は注入した巻き戻しの失敗**だった
       （実測: `{"code":null,"index":1,"message":"INJECTED: rollback to savepoint failure",…}`。本物の `ContestedWithoutCompanionError` ではない）。`ObserveResult` 自体には落とした候補の欄は無く、載るのはイベントの `meta`。
       **直したあとは `observe` が `ContestedWithoutCompanionError` で落ち**（`cause` に巻き戻しの失敗）、記憶も `created` も残らない。
       対照（巻き戻しが成功）: 直す前も後も、`observe` は1件を返し、`meta` に `ContestedWithoutCompanionError` の理由が載る。
  4. **【実測】** ADR 0444（#1555）の包みは、この穴を塞がない。`ROLLBACK_STATEMENT`（`/^\s*rollback\s*;?\s*$/i`）が `rollback to savepoint sp1` に合致せず、`transactionPreservingOriginalError` が包むのは `db.transaction` だけである。

- **決めたこと**:

  1. **本体が投げたエラーを控え、`rollback to savepoint` 自体が失敗したと判定したら、続けず、`dropped` に積まず、元のエラーを投げる。**
     コールバックの中で本体が投げたエラーを控える（`bodyError`）。入れ子の `tx.transaction` が外へ投げたものが `bodyError` と同一なら、巻き戻しは成功した（従来どおり `dropped` に積む）。
     同一でなければ、巻き戻しの失敗が元のエラーを置き換えている。トランザクションの状態は不明（aborted のまま・savepoint の中の書き込みが残る・接続が死んでいる）なので、続けない。
  2. **巻き戻しの失敗は ADR 0444 と同じ作法で付ける。** 元のエラーが `Error` で `cause` が空なら `cause` に、埋まっていれば（drizzle の `DrizzleQueryError` はこちら）`rollbackError` に置く。**新しい例外の型は作らない。**
     例外オブジェクトは同一のまま投げる（包み直さない）。ふつうの失敗（巻き戻しが成功する）は何も足さない。
  3. **`release savepoint` の失敗**（本体は成功したのに外へ投げられた）は、その候補を `dropped` に積まず、その失敗を投げる。savepoint の中の書き込みが残るか戻るかが外から分からないため。
     このとき外へ出るのが `release` の失敗か、続く `rollback to savepoint` の失敗かは区別できない（どちらもそのまま投げる。元のエラーは無い）。
  4. **外側の `db.transaction()` は変えない。** 上のどれでも、外へ出るのは元のエラーで、外側のトランザクションごと戻る（何も書かない）。外側の `rollback` も失敗したときは、ADR 0444（#1555）の包みがその失敗を付ける。
     `client.ts` の仕組みとは食い違わない。接続ごと切れた場合は、投げられる元のエラーは `DrizzleQueryError`（`cause` が埋まっている）なので、巻き戻しの失敗は `rollbackError` に置かれ、その後に外側の失敗が同じ `rollbackError` を上書きする（下の「引き受けた負債」）。
  5. **上流の drizzle-orm には報告しない。** 上流の不具合（savepoint 版も同じ形）で、ここで包んで直した。drizzle が `rollback to savepoint` の失敗で元のエラーを消さなくなれば、この判定（`error !== bodyError.error`）は働かなくなるだけで、壊れない。
  6. **通常の悪い候補の振る舞いは変えていない。** 巻き戻しが成功する悪い候補（NUL・claim key の索引の上限・`ContestedWithoutCompanionError` など）は、従来どおり `dropped` に積まれ、他は書かれる。全候補が悪ければ最初の例外が投げられる。

- **検討した代替案**:

  1. **`client.ts` の包みを広げ、`rollback to savepoint` も握る。** 採らなかった。握って元のエラーを `dropped` に積むと、aborted のトランザクション・死んだ接続の上で次の候補を続けることになる（S2 の 25P02、S6 の ghost 行はこちらのほうが悪化する）。
     savepoint の巻き戻しの失敗は「その候補が落ちた」ではなく「トランザクションを信用できない」であり、判断は store の側にある。
  2. **巻き戻しの失敗を `dropped` に積んだまま、理由だけ元のエラーに差し替える。** 採らなかった。S3・S6 の「正常終了するのに行が不整合に残る」は変わらない。
  3. **savepoint をやめ、候補ごとに別のトランザクションにする。** 採らなかった。全候補と `created` を1トランザクションで書く（ADR 0410）という約束が変わる。
  4. **新しい例外の型（`SavepointRollbackFailedError` など）を作る。** 採らなかった（ADR 0444 と同じ。`code` 付きの元のエラーが届くことが目的で、`instanceof` の枝を増やさない）。

- **歯と変異試験**【実測】（`packages/postgres/src/__tests__/savepoint-rollback-error.postgres.test.ts`。直列の群。注入は `pool-fault-injection.ts` の `rejectStatement` と既存の `killConnectionBeforeStatement`）:

  - **直す前（`origin/main` の `memory-store.ts`）で 11 本のうち 7 本が赤**（S1・S2・S3・S6・`release savepoint` の失敗・接続ごと切る・`runtime.observe` 経由）。出力は作業メモの `red-before-0451.txt`（リポジトリには入れていない）。
    S1 は `expected undefined to be '22021'`、S2 は `expected '25P02' to be '22021'`、S3 は `expected 'RESOLVED' to be an instance of ContestedWithoutCompanionError`。
  - **やりすぎで赤**:
    - 「どんな失敗でも throw」（`dropped.push` を `throw error` に）で、巻き戻しが成功する悪い候補の対照が赤（3本）。
    - 元のエラーを新しい `Error` で包み直す変異で 5 本が赤（例外オブジェクトの同一性・`cause` の位置）。
  - **足りなくて赤**: `release savepoint` の失敗を `dropped` に積む変異で、その歯だけが赤。巻き戻しの失敗を付けない変異で 5 本が赤。
  - 直したあとは 13 本とも緑。

- **引き受けた負債**:

  - **外側の `rollback` も失敗したとき、`rollbackError` が先の巻き戻しの失敗を上書きする。** 元のエラーが `DrizzleQueryError` のとき、savepoint の巻き戻しの失敗はまず `rollbackError` に置かれ、その後 ADR 0444 の包みが外側の失敗で同じ欄を上書きする。
    接続ごと切れた場合は同じ原因なので、情報はほぼ失われない。欄を分けるなら `client.ts` に触れる別の判断になる。
  - **`release savepoint` の失敗**（決定3）は、元のエラーが無いので、`release` の失敗と、その後の `rollback to savepoint` の失敗を区別できない。
  - S3・S6 の形（トランザクションが生きたまま `rollback to savepoint` だけが失敗する）は、実運用ではその文へのキャンセルやクライアント側の `query_timeout` くらいでしか起きない。注入で作った形であり、実際の頻度は測っていない。
  - `rejectStatement` は `pg` の内部の呼び方（promise 形の `query`）に依る。`pg` の版を上げたら、注入が当たらず歯が空振りしないかを見ること（当たらなければ、巻き戻しの失敗を要求する歯は赤になる。静かに通らない）。
  - 例外の形は揃っていない（ADR 0444 の BG-3 のまま）。

- **これが覆るとしたら**:

  - drizzle-orm が入れ子の `transaction` で元のエラーを消さなくなったとき。この判定は働かなくなるだけで、残しても害は無い。
  - `dropped` に積む対象を「巻き戻しが成功した候補の失敗だけ」から広げたい（巻き戻しが失敗しても残りを書く）と決めるとき。トランザクションの状態が分からない以上、現状は勧めない。
  - 入れ子の `transaction` を使う store が増えたとき。同じ作法で判定する（共通の関数にするかは、そのとき決める）。

- **測っていないこと**: Postgres 17 以外・`pg` の別の版での注入の当たり方。`runtime.observe` 経由で `ObserveResult` に載る形は、巻き戻しの失敗の注入1形（NUL 候補）でしか測っていない。
