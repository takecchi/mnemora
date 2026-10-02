# ADR 0558: testkit の InMemory の自己置換の検査は、`supersededById` と対象の id の両側を畳んで比べる

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の委譲先（担い手。マネージャー mgr-94dd433c の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポート 55438 で。`C.UTF-8`）、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 割れ【現物・実測】

[ADR 0503](./0503-superseded-by-checks-resolve-contested-update-status.md) は、`supersededById` に自分自身を渡す自己置換を、書く前に `RangeError` で断ると決めた。

- `PostgresMemoryStore`（`packages/postgres/src/memory-store.ts`）は `normalizeUuidCase(supersededById) === normalizeUuidCase(selfId)` で**両側**を畳んで比べる。
- `InMemoryMemoryStore` の `assertSupersededByShape`（`packages/testkit/src/__fixtures__/in-memory-memory-store.ts`）は `supersededById === selfId` だった。呼び出し側の `updateStatus`・`updateStatusWithEvent` は対象の `id` だけを `normId`（ADR 0521 の小文字化）にかけ、`opts.supersededById` は畳まない。そのため、id が `mem-1`・`supersededById` が `MEM-1` の呼び出しは比べで食い違って通り、続く `assertOwnMemoryRef` も（大文字小文字を畳んで引くので）通り、**自分を指す `superseded` の行**が書かれた。
- 【実測】直す前、`updateStatus`・`updateStatusWithEvent` の「id 小文字・`supersededById` 大文字」が `expected undefined to be an instance of RangeError`（断らずに書いた）で赤。Postgres は断る。
- 逆向き（id 大文字・`supersededById` 小文字）は、入口で id が畳まれるので元から断っていた。
- `resolveContestedPair`・`resolveContestedGroup` は入口の `normPairSide` で両側を畳むので穴は無い。

## 決定【判断】

1. `assertSupersededByShape` の自己置換の比べを `normId(supersededById) === normId(selfId)` にする。呼び出し側が畳んだ id を渡す現状では `normId(selfId)` は冗長だが、比べの関数が呼び出し側の事前処理に依存しないよう、Postgres と同じ両側の形にする。
2. 公開 API・既定値・Postgres・core の Fake は変えない。

## 歯と実測【実測】

- `packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts`: `updateStatus`・`updateStatusWithEvent` それぞれに、自己置換（id 小文字・`supersededById` 大文字／id 大文字・`supersededById` 小文字）が `RangeError` で何も書かない（行・イベントが変わらない）こと、対照として別の記憶を大文字で渡すと通り小文字で保存されること。
- `packages/postgres/src/__tests__/uppercase-target-id-parity.postgres.test.ts`: 同じ4つの自己置換を Postgres を基準に testkit と突き合わせる。

**直す前の赤**: testkit の単体で2本（`updateStatus`・`updateStatusWithEvent` の「id 小文字・`supersededById` 大文字」）。直した後は27本とも緑、突き合わせは59本とも緑。

**変異試験**（`in-memory-memory-store.ts` の比べを書き換え、歯を走らせ、`git checkout -- <ファイル>` で戻した。戻した後は緑）:

| 変異 | 赤になった歯 |
|---|---|
| M1 元の `===`（畳まない） | 単体の「id 小文字・by 大文字」2本（2口）。突き合わせ `edge.updateStatus(...UP, id lo)`・`edge.updateStatusWithEvent(...UP, id lo)` の2本 |
| M2a `supersededById` だけ畳む | 赤にならない（等価変異。対象の id は呼び出し側が畳み済みなので、`normId(selfId)` を外しても入力が変わらない。決定1の「冗長」の根拠） |
| M2b `selfId` だけ畳む | M1 と同じ（単体2本・突き合わせ2本） |
| M3a 粗すぎる比べ（数字を落として比べる） | 単体11本（別の記憶を指す正当な呼び出し・ADR 0503 の循環・forgotten の検査など。うち今回足した対照は2口分） |
| M3b `supersededById` が小文字でなければ常に断る | 今回足した対照2本（`updateStatus`・`updateStatusWithEvent` の「別の記憶を大文字で渡すと通る」）だけ。【未確認】突き合わせ側では走らせていない |
| M4 自己置換の検査ごと消す | 単体8本（既存の自己置換4本＋今回の4本）。突き合わせ4本 |

## 直さないもの【判断】

- **core の `FakeMemoryStore`**: ADR 0503 の検査を持たず、自己置換を通す。別担当が ADR 0557 で直している。突き合わせの4件は `SKIP_FAKE` に入れ、理由をコメントに書いた。Fake が直ったら外す。
- Postgres の振る舞い。

## CHANGELOG【判断】

`@mnemora/testkit` は公開物で `./fixtures` を出しているので、`[1.3.0]` の `### Fixed` に1項目足した（ADR 0521・0556 と同じ理由）。`[1.2.0]` には触らない。綴り違いの自己置換が新しく断られる点は、Postgres が今断る入力だけなので、項目にそう書いた。

## 採らなかった案

- 呼び出し側（`updateStatus` ほか）で `opts.supersededById` を畳む: `assertOwnMemoryRef` など後続の検査も畳み済みの値で動くので効くが、比べる関数が自分で両側を畳む Postgres の形と離れる。呼び出し口が増えたときに同じ穴が再発する。

## これが覆るとしたら

Postgres が自己置換を綴りで区別するようになったとき（ADR 0503・0521 と一緒に見直す）。
