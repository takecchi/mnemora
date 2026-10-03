# ADR 0579: 門が赤くなる歯は、`--bail=1` で打ち切らず、DB テストのファイルを1本だけ名指しして走らせる

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（マネージャー mgr-919c76c2）が書いた。直す向き（門ではなく歯の側で直す・門の約束は変えない）はクローンが決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・CI のログ、【実測】は手元で走らせた結果、【判断】は担い手の判定。

## 文脈

1. **【現物】** `scripts/__tests__/run-db-tests.test.mjs` の「DATABASE_URL が在って DB テストが落ちるとき: 門が赤くなる」が、
   [ADR 0465](./0465-gate-red-tooth-sees-db-test-file-not-vitest-summary.md) の直しの後も、CI で3回同じ形で落ちた
   （#1680 の run `37071494074`、#1684 の run `37079213466` の1回目、#1690 の run `37089588111` の1回目。どれもジョブの再実行で緑）。
   3回とも、歯が捕まえた出力は次の形だった:

   ```text
    RUN  v5.0.0 /home/runner/work/mnemora/mnemora/packages/postgres

    Test Files   (335)
         Tests   (99)
      Duration  4.87s
   ...
   ✗ DB テストが落ちました（@mnemora/postgres）。
   ```

   門は正しく赤くなっていた（終了コード非 0、`DB テストが落ちました`）。ところが vitest の出力に `FAIL` の行もスタックも無く、
   集計にも落ちた数が無い。0465 の印（落ちた DB テストのファイルの名前 `src/__tests__/….test.ts`）が出力のどこにも無かった。
2. **【実測】** 手元で門を `node scripts/run-db-tests.mjs --bail=1`（届かない `DATABASE_URL`）で8回起動すると、1回が同じ形になった
   （終了コード 1、`Tests  51 passed (91)`、落ちたファイルの名前0件）。残り7回は `Tests  1 failed | …` と落ちたファイルの名前が出た。
   歯そのもの（`vitest run … -t "門が赤くなる"`）を8回走らせたときは、8回とも緑だった——揺れは確率で出る。
3. **【現物】vitest 5.0.0 の機序**（`node_modules/.pnpm/vitest@5.0.0_…/node_modules/vitest/dist/chunks/`）:
   - `index.5J3Pr46F.js:184-189` — worker の `onAfterRunTask` は、`config.bail` が在ってテストが `fail` なら、
     `rpc().onCancel("test-failure")` を**その場で**親へ送る。
   - `run.CQOUYP-x.js:3796-3804` — 一方、テストの結果（`task.result`）は `updateTask` が `packs` に積み、
     `sendTasksUpdateThrottled`（`throttle(sendTasksUpdate, 100)`）で**最大 100ms まとめてから**親へ送る。
   - `index.B89dZ0-N.js:21194-21199` — 親の `cancelCurrentRun` は `isCancelling = true` にして pool を止める。
     `index.B89dZ0-N.js:11713-11718` — 打ち切り中のファイルは `ctx.state.cancelFiles(...)` で「打ち切った」として片付ける。
   - `index.B89dZ0-N.js:19979-19980` — 実行の終わりは `isCancelling` なら `interrupted` とし、`process.exitCode = 1` にする。
   - ⟹ 打ち切りの合図が、まとめて送られる落ちた結果より先に親へ着くと、親は落ちたテストを一度も知らないまま
     `interrupted` で exit 1 する。落ちたファイルの `FAIL` の行も、集計の落ちた数も出ない。
     まとめて送る途中の結果が、worker を止めたときにどこで捨てられるかまでは追っていない（【判断】。上の行から読める範囲の推論）。
4. **【現物】0465 がこれを覆わなかった理由。** 0465 が見た回（main `e4e27fd`）は、`Tests  1 failed` が数えられ、`FAIL` の行も出ていた。
   欠けていたのは集計のファイル数だけで、0465 は「集計の行は不安定だが、落ちたテストを報告する行は届く」と読んで印を選んだ。
   今回の3回は、その報告の行そのものが届いていない。根は同じ競争で、0465 が「引き受けた負債」に置いた
   「`--bail=1` のとき集計の行が落ちた数を出さない理由（vitest 5.0.0 の内部）は追っていない」の、追っていなかった部分だった。
5. **【現物】門の約束。** `scripts/run-db-tests.mjs` の先頭の表が約束するのは、DB テストが落ちたら終了コードが非 0、
   出力は pnpm の出力そのまま、落ちたパッケージを名指しすること。落ちたファイルの名前を出すことは約束していない。
   門に `--bail=1` を渡すのはこのリポジトリの歯だけで（`run-db-tests.mjs:233-236` のコメント）、ルートの門・CI は何も渡さない。
   ⟹ CI を読む人が見る出力は打ち切られないので、この揺れは利用者には出ていない。揺れていたのは歯の側だけ。

## 決めたこと

1. **歯は `--bail=1` をやめ、`packages/postgres` の DB テストのファイルを1本だけ名指しして門に渡す**
   （`DB_TEST_FILE = "src/__tests__/contested-with-index.test.ts"`）。門はその引数を `test:db`（`vitest run`）へそのまま渡すので、
   vitest はそのファイルだけを、打ち切らずに走らせる。打ち切りが無いので、上の競争が起きない。
2. **名指しするのは、DB が無いと走らない本物の DB テストにする。** DB が無くても通るファイルを選ぶと、落ちた理由が DB でなくなり、
   「届かない DB へ実際に繋ぎに行って落ちた」の印にならない。`contested-with-index.test.ts` は、どの it も `beforeEach` の
   `resetTestDatabase()` で DB に触り、`EXPLAIN` を本物の Postgres に撃つ。
   【実測】DB 在り（PostgreSQL 17 + pgvector、自分専用のポート 55920）で3本とも緑。`DATABASE_URL` 無しでは `requireDatabaseUrl` が断る。
   選んだ理由は歯のコメントに書いた。
3. **印を `FAIL` の行に絞った**（`FAIL\s+(?:\|?<project>\|?\s+)?src/__tests__/contested-with-index\.test\.ts`）。
   名指しした引数は pnpm が `$ vitest run src/__tests__/contested-with-index.test.ts` と書き出すので、0465 の印
   （ファイルの名前だけ）のままでは、DB テストが走らなくても通る（下の M3）。
   `FAIL` とファイルの名前の間の vitest の project 名（`postgres-db-parallel`）は、色が無いと `|postgres-db-parallel|`、
   色が有ると（CI の `FORCE_COLOR`）色の付いた札になり、色の符号を外すと ` postgres-db-parallel ` になる。両方の形を許す。
   【現物】最初に push した形は `|…|` だけを許していて、この PR の CI の最初の run（`37091331864`）で落ちた
   （ログには `FAIL   postgres-db-parallel  src/__tests__/contested-with-index.test.ts > …` が3行、決まった形で出ていた）。
   【実測】手元で `FORCE_COLOR=1` を付けると、`|…|` だけの形は赤、両方を許す形は緑（8回とも）。
4. **名指しするファイルが在ることを、歯の中で先に確かめる。** 消えたら vitest は `No test files found` で exit 1 し、
   その文言（`filter: src/__tests__/….test.ts`）にもファイルの名前が出る。
5. **門の振る舞いは変えていない。** 変えたのは `run-db-tests.mjs:235-236` のコメント（「歯は `--bail=1` を渡す」の記述）だけ。
   `MNEMORA_DB_TESTS_SKIP` の歯は `--bail=1` のまま残した——終了コードと門の文言だけで判定し、vitest の出力に頼らないので、
   この揺れを受けない。
6. CHANGELOG は足していない（利用者に見える変更が無い）。

## 測ったこと（【実測】）

手元の器で、歯から本物の門を子プロセスとして起動する形。変異は `cp` で退避・復元した。

| 門・歯 | 新しい歯 |
|---|---|
| 元のまま（8回） | 緑（8回とも。所要 7〜9 秒。`FORCE_COLOR=1` でも8回とも緑） |
| M1: 門が `test:db` を起動せず `{ status: 1 }` で「落ちた」とだけ言う | **赤** |
| M2: `test:db` の代わりに `false` を起動する | **赤** |
| M3: `test:db` の代わりに、pnpm の書き出し（`$ vitest run <引数>`）だけを真似て exit 1 する | **赤**（同じ出力に、ファイルの名前だけの印は合う。project 名の両方の形を許した後も、`FORCE_COLOR=1` で赤） |
| M4: 歯の `DB_TEST_FILE` を存在しない名前にする | **赤**（在ることの検査） |

- ファイル全体（8本）は緑。eslint・prettier は通った。
- 直す前の赤は確率でしか出ない（文脈2）。直す前の形を8回走らせた歯は8回とも緑で、赤は門を直接8回起動した1回で示した。

## 採らなかった案

- **門の側で、打ち切られても落ちたファイルの名前を必ず出す。** vitest が打ち切りで捨てた結果は、門からは取り戻せない。
  門がファイルの名前を出すようになると、0465 の印（門はファイルの名前を出さないので、在れば本当に走った）が意味を失う。
  歯の都合で門に新しい約束を足すことにもなる。
- **門の終了コードと文言だけで判定する。** 0465 が退けたとおり、「DB テストが本当に走った」を測れなくなり、歯が弱くなる。
- **`--bail` の数を上げる。** 競争の確率が下がるだけで、決定的にはならない。
- **`--bail` を外して全ファイルを走らせる。** 0465 以前の時間の問題（`testTimeout` 180s に近づいていた）に戻る。

## 引き受けた負債

- 歯は、名指ししたファイル1本の名前と、vitest の `FAIL` の行の形（project 名を `|…|` か色の札で挟む形を含む）に依る。
  形が変われば歯は赤い側に倒れるので、黙って弱くはならない。
- 名指ししたファイルの中身が変わり、DB が無くても通る it が増えても、この歯は気付かない（DB に触る it が1本でも残れば `FAIL` は出る）。

## これが覆るとしたら

- **vitest の版が上がったとき。** 上の機序（打ち切りの合図をその場で送り、結果は 100ms まとめて送る）は vitest 5.0.0 の行番号つきの現物で、
  版が上がれば変わりうる。打ち切りでも落ちた結果が必ず届くようになれば `--bail=1` に戻せるし、`FAIL` の行の形が変われば印を選び直す。
- `contested-with-index.test.ts` が改名・削除されたとき（在ることの検査が赤くなる）。DB に触る別の DB テストを選び直す。
- 門が自分でテストのファイルの名前を出すようになったとき（0465 と同じ）。
- 直したあとも同じ歯が CI で落ちたとき。ログから切り分け直す。
