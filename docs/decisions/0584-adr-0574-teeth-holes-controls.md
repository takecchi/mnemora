# ADR 0584: ADR 0574 の歯の穴（外の forgotten と CAS の順・壊れた id と形の違反の順・形の検査の位置）を塞ぐ

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の委譲先（担い手。マネージャー mgr-4ba236a4 の指示による）が書いた。決めたのはクローンで、オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。テストだけの変更で、実装（`runtime-fakes.ts`・`memory-store.ts`・testkit の InMemory）は変えない。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（PostgreSQL 17 + pgvector を自分専用のポート 55474 で。`C.UTF-8`）、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 背景【現物】

[ADR 0574](./0574-adr-0557-superseded-by-controls.md)（#1686）の歯を入れたあとの確かめ直しで、次の変異がどの歯にも捕まらなかった（または 0557 の歯1本だけが捕まえた）。

| 番号 | 変異 | どう生き残ったか |
|---|---|---|
| F14（Fake）・P16（Postgres） | pair で「対の外の `forgotten` を指す」検査を CAS より前へ動かす | 3実装とも、検査は CAS の後。非 contested の行と外の forgotten を同時に渡すと、本物は `MemoryStatusConflictError`、変異は `RangeError` になるが、その入力が無かった |
| P12（Postgres） | `updateStatus` の形の検査を、`isUuidLike` による not found の後ろへ動かす | ADR 0574 決定3は「`isUuidLike` による not found は、形・循環の検査より後」。壊れた id と形の違反を同時に渡す入力が無かった |
| F10・F12（Fake） | pair・group の形の検査を、存在確認や CAS の後ろへ動かす | 0574 の歯は、循環の検査の位置だけを縛っていた（0557 の歯が1本だけ捕まえた） |

## 決定【判断】

1. 実装は変えない。`runtime-fakes.ts` は触っていない（#1690 が触っている）。3実装とも ADR 0574 決定3の順になっていて、足りなかったのは歯だけだった。
2. 歯を足す（2ファイル。0574 の2ファイルへの追記）。
   - `packages/postgres/src/__tests__/store-superseded-by-checks-controls.postgres.test.ts`（9 本 × 3実装 = 27 本）。同じ入力を testkit の InMemory・core の Fake・Postgres に流す。
   - `packages/core/src/__tests__/fake-superseded-by-checks-controls.test.ts`（9 本。Fake だけ。DB 不要で、Fake に変異を入れたとき DB 無しで赤くなる）。
3. 足した歯の中身。
   - F14・P16（pair）: contested でない2件 + 対の外の `forgotten` を指す `superseded` は、`RangeError` ではなく `MemoryStatusConflictError`（`isMemoryStatusConflictError` で判定。core が2つの版に分かれても読めるよう、`instanceof` では比べない。[ADR 0418](./0418-store-error-kind-guards.md)）。
   - F14・P16（group）: group も外の `forgotten` の検査が CAS の後なので、同じ形（contested でない3件）で足した。さらに、4件の群の一部（3件）を渡し + 群の外の `forgotten` を指す入力は、`RangeError` ではなく `ContestedGroupMembershipMismatchError`（部分解消の検査も、外の forgotten の検査より前）。
   - P12: 壊れた id（`not-a-uuid`）+ `supersededById` 無しの `superseded`・自己置換・active への付与は、not found の `Error` ではなく形の `RangeError`（`updateStatus`・`updateStatusWithEvent`・pair・group）。陽性対照として、壊れた id でも形が正しければ、`RangeError` ではなく「memory not found」の `Error` になることも縛る（「`RangeError` が常に先」ではないこと）。
   - F10・F12: pair・group の形の違反（`supersededById` 無しの `superseded`・自己置換）が、存在しない行でも、contested でない行（CAS が外れる）でも、`MemoryStatusConflictError`・not found ではなく形の `RangeError`。Fake の側は hook（`beforeUpdateStatus`）を呼ばないことも見る。
4. 「壊れた id」の入力は、InMemory・Fake にも同じものを流した（3実装とも緑）。InMemory・Fake に `isUuidLike` は無いが、形の検査が先であることは3実装に掛かる約束である【実測】。

## 実測【実測】

### 直す前にすり抜けた

0574 時点の2ファイル（`adf73fc5` の版）を一時ファイルとして置き、`packages/postgres/src/memory-store.ts` に次の変異を同時に入れて走らせた。24 本とも緑（すり抜けた）。

- P12: `updateStatus` の形の検査を `isUuidLike` の後ろへ
- P16: pair の外の `forgotten` の検査を、トランザクションの先頭（CAS の前）へ

F10・F12・Fake の F14 は、背景の表（前回の確かめ直しの結果）のとおり。この ADR では取り直していない【未確認】。

### 変異で赤・戻して緑

変異は対象ファイルを変異ごとに `cp` で退避し、Edit で入れ、`cp` で戻した。戻した後に同じ歯が緑に戻ることと `git status --porcelain` が空であることを毎回見た。列は「core の新ファイル（Fake）/ Postgres の新ファイル（`-t Postgres:` または `-t InMemory`）で赤になった it の数」。

| 変異 | 場所 | 赤 | 戻して |
|---|---|---|---|
| F14 pair: 外の forgotten の検査を CAS より前へ | Fake | core 1（pair） / Postgres ファイルの Fake 脚 1 | 緑 |
| F14 group: 外の forgotten の検査を存在確認・CAS より前へ | Fake | core 2（group・部分解消） / 同 2 | 緑 |
| F14 group: 同じ検査を、CAS の後・部分解消の検査の前へ | Fake | core 1（部分解消） | 緑 |
| P16 pair | Postgres | 1 | 緑 |
| P16 group（存在確認より前へ） | Postgres | 2（group・部分解消） | 緑 |
| P16 group（CAS の後・部分解消の前へ） | Postgres | 1（部分解消） | 緑 |
| P16 pair | InMemory | 1 | 緑 |
| P16 group（存在確認より前へ） | InMemory | 2 | 緑 |
| P16 group（CAS の後・部分解消の前へ） | InMemory | 1 | 緑 |
| P12 `updateStatus` の形の検査を `isUuidLike` の後ろへ | Postgres | 2（壊れた id の欠落・壊れた id の自己置換） | 緑 |
| P12 `updateStatusWithEvent` | Postgres | 2（同上。`updateStatus` が通ったあとの2つ目の呼び出しで落ちる） | 緑 |
| F10 pair の形の検査を、存在確認の後（CAS の前）へ | Fake | core 2 / Postgres ファイルの Fake 脚 2（F10・P12 の pair・group 版） | 緑 |
| F10 pair の形の検査を、CAS の後へ | Fake | core 3 / 同 2 | 緑 |
| F12 group を存在確認の後へ | Fake | core 2 / 同 2 | 緑 |
| F12 group を CAS の後へ | Fake | core 3 / 同 2 | 緑 |
| F10 pair を `isUuidLike`・`checkedRef` の後へ（ここで形の検査が循環の検査より後になる） | Postgres | 2 | 緑 |
| F10 pair を、トランザクション内の存在確認の後へ | Postgres | 2 | 緑 |
| F10 pair を、トランザクション内の CAS の後へ | Postgres | 2 | 緑 |
| F12 group を、存在確認の後・CAS の前へ | Postgres | 2 | 緑 |
| F12 group を、CAS の後へ | Postgres | 2 | 緑 |
| F10 pair を、CAS の後へ | InMemory | 2 | 緑 |
| F12 group を、CAS の後へ | InMemory | 2 | 緑 |

group の `isUuidLike` の後ろへ形の検査を動かす変異・InMemory の存在確認の後ろへ動かす変異は試していない（ほかの位置の変異で、同じ歯が赤になることは見た）【未確認】。

### 走らせたもの

core の新ファイル 23 本（14 + 9）・Postgres の新ファイル 51 本（24 + 27）が緑。tsc（core・postgres）・eslint・prettier も緑。

## 変えなかったこと・知っておくこと【判断】

- **形の検査は、循環の検査より前**（3実装とも、形 → 循環の順）。自己置換の入力（`superseded` で自分を指す）は、形の検査を循環の検査の後ろへ動かすと、形の `RangeError` ではなく循環の `RangeError` になる。この順は ADR 0503・0557 の本文には明記されていない。足した歯（自己置換の message を見る）はこの順も縛る。覆したいときは、この歯の message を直すこと。
- group の「外の `forgotten`」の検査は、`ContestedGroupMembershipMismatchError`（部分解消）の後ろにも置いてある（3実装で同じ）。これも歯が縛る。
- `markContestedPair`・`markContestedGroup` など、ほかの口の検査の順は見ていない【未確認】。
- CHANGELOG は変えない。テストだけの変更で、利用者に見える振る舞いも、CHANGELOG に書いた約束も変わらない（#1686 が CHANGELOG を触ったのは、`[1.3.0]` の「確かめていないこと」の記述が現物と食い違っていたのを直すためだった。この変更にはそれに当たる記述が無い）。

## これが覆るとしたら

ADR 0574 決定3（形・循環の検査 → 存在確認 → CAS → 外の forgotten）や ADR 0557 決定3が変わるとき。3実装と一緒にこの歯を直す。
