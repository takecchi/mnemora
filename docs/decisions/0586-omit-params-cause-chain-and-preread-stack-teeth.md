# ADR 0586: `omitParamsFromError` の doc が約束する「`cause` の連鎖にも掛ける」と「`stack` も書き換える」を、偽の例外の歯で縛る

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローンの委譲先（マネージャー mgr-919c76c2）が書いた。歯を書くと決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポート 55933 で）、【判断】は担い手の判定。

## 文脈

1. **【現物】** `packages/postgres/src/omit-params.ts` の `omitParamsFromError`（[ADR 0504](./0504-vector-store-omits-params-from-thrown-errors.md)）の doc は、
   例外の `message` の `params:` より後ろと、その文字列を含む `stack` を落とし、「`cause` の連鎖にも掛ける」と約束している。
2. **【実測】** [ADR 0575](./0575-outbox-negative-limit-teeth-independent-of-planner-stats.md)（#1687）の確かめ直しで変異を入れたところ、次の2つは既存の歯
   （`error-message-omits-params.postgres.test.ts`・`outbox-last-error-omits-params.postgres.test.ts`）が緑のままだった。
   - `cause` の連鎖をたどらない（`current = target.cause` を外す）。
   - `stack` を書き換えない。
3. **【判断】** 既存の歯は本物の drizzle の例外を使う。その `cause` は pg のエラーで `params:` を持たないので、連鎖をたどらなくても params は残らない。
   また、`stack` は書き換えより前には読まれておらず、V8 は `stack` を最初に読んだときの `message` で文字列にするように見える
   （`message` を書き換えた後に初めて読むと、すでに落ちた形になっている）。どちらも、今の本物の経路では実害が出ない。
   ただし doc が約束している以上、縛る。

## 決めたこと

1. **`packages/postgres/src/__tests__/omit-params.test.ts` を足す。** DB を使わず、`Failed query: …\nparams: <秘密の文字列>` の形の偽の例外で縛る
   （パッケージのテストは `test:db` の下で走るが、このファイルは DB に触らない）。
   - `cause` の連鎖: 3段の連鎖のどの段の `message`・`stack` からも秘密の文字列が消え、SQL の文と省略の印（`(omitted by mnemora, N chars)`）が残る。
     連鎖の形（同じオブジェクト）は変えない。`params:` を持たない段（pg のエラーの形）を挟んでも、その先の段まで掛ける。
   - 先に読まれた `stack`: 書き換えより前に `stack` を読んで params 入りの文字列に固めた例外で、`stack` から秘密の文字列が消え、
     SQL の文と呼び出し位置の行は残る。`cause` の段の先に読まれた `stack` も同じ。
2. 実装（`omit-params.ts`）は変えていない。CHANGELOG は足していない（利用者に見える変更が無い）。

## 測ったこと（【実測】）

変異は `omit-params.ts` を `cp` で退避し、Edit で入れ、`cp` で戻した。

| 変異 | 新しい歯（4本） | 既存の `error-message-omits-params.postgres.test.ts` |
|---|---|---|
| 元のまま | 緑（4本） | — |
| MA: `cause` の連鎖をたどらない（`current = undefined`） | **赤**（3本） | 緑（#1687 の確かめ直しで、関係する2ファイル 39 本が緑） |
| MB: 1段目の `cause` までしかたどらない | **赤**（深い段を見る2本） | — |
| MC: `stack` を書き換えない | **赤**（2本） | 緑（38 本） |

- 戻した後、新しい歯は4本とも緑。packages/postgres の typecheck、新しいファイルの eslint・prettier --check も通った。全テストは走らせていない。

## 引き受けた負債

- 「先に読まれた `stack`」の歯は、V8 が `stack` を最初に読んだときに文字列へ固める振る舞いに依る。固めない実行環境では、
  変異 MC でも `stack` が `message` に追従して緑になりうる（歯は弱くなる側に倒れる）。歯の中で、先に読んだ `stack` に秘密の文字列が在ることを
  `expect` しているので、前提が崩れればその `expect` で赤になる。

## これが覆るとしたら

- `omitParamsFromError` の doc の約束（`cause` の連鎖・`stack`）が変わったとき。
- Node（V8）の `stack` の組み立て方が変わり、上の前提の `expect` が赤になったとき。
- （ADR 0575 の確かめ直しで分かった結びつきの記録）`PostgresOutboxStore` が負の `limit` を自分で断るようになったとき、
  `error-message-omits-params.postgres.test.ts` の outbox の歯（2201W と `Failed query:` を前提にする `claimBatch`・`eraseTenant`）は、
  約束（params を落とす）が守られていても赤になる。そのときは、試しに撃つ口を選び直す。
