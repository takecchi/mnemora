# ADR 0582: ADR 0573 の歯の穴（updatedAt の同一 ms・UTF-16 順・updatedAt 並び・NUL の「何も書かない」）を塞ぐ

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

ADR 0573 の歯（`packages/core/src/__tests__/fake-event-time-nul-claim-controls.test.ts`）に対し、確かめ直しで、どの歯にも捕まらなかった変異が4件見つかった。テストだけの変更で、`packages/core/src/__tests__/runtime-fakes.ts` は変えない（開いている #1690 が触っている）。

出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

## 見つかった穴（直す前にすり抜けた変異）

1. `archiveDecayed`・`purgeMemory` の `updatedAt` 更新を消す変異が、確率で通った。歯が `updatedAt >= before`（`before = Date.now()`）だけを見ており、`createMemory` が書いた `updatedAt` と `before` が同じ ms だと、書かなくても通る。確かめ直しでは archive 6回中2回赤、purge 5回中1回赤。【実測（前回の確かめ直し）】
2. `listActiveClaimPredicates` の同着の副キーを、コードポイント順（`Buffer.compare`）から UTF-16 コード単位順（`a < b`）に変えても通った。歯の入力が ASCII だけだった。
3. 並びの時刻を `createdAt` から `updatedAt` に取り違えても通った。歯が作成直後の行（`createdAt` = `updatedAt`）しか見なかった。
4. `createMemory` の `extractorVersion` の NUL の検査を保存の後ろへ移しても通った。「何も書かない」を見る読み口が、claim key の無い行を作ろうとして `listActiveClaimPredicates` が `[]` であることだった。書かれても claim key が無いので `[]` になり、空振りしていた。

## 決定

1. **時計を注入する。** `vi.useFakeTimers({ toFake: ["Date"] })` と `vi.setSystemTime` で Fake の `new Date()` を制御できる（既存の同ファイルの並びの歯と同じ）。作成を 2030-01-01、archive / purge を 2030-01-02 に置き、`updatedAt` が作成時より大きい（`toBeGreaterThan`）ことと、書いた壁時計に等しいこと（`toEqual`）を見る。同じ ms になる経路が無いので、確率で通る形は残らない。`opts.now`（2031）・`event.at`（2020）を書く変異も、壁時計と等しいかを見るので従来どおり捕まる。
2. **コードポイント順と UTF-16 順が食い違う組を、同着で入れる。** testkit の適合テスト（`memory-store-conformance.ts` の「同着の並びは照合順序（collation）に依らず、コードポイント順である」）と同じ入力 `["😀", "a", "～", "Z", "é", "_", "B"]` を使う。期待は `["B", "Z", "_", "a", "é", "～", "😀"]`。UTF-16 順では 😀（D83D DE00）が ～（FF5E）より前に来る。
3. **作った後に `reinforce` して `updatedAt` だけ進めた行を入れる。** `older_created`（2030-01-01 作成）を 2030-01-03 に強化し、`newer_created`（2030-01-02 作成）との並びが `createdAt` に従う（`["newer_created", "older_created"]`）ことを縛る。強化後も `status` は active、`createdAt` は不変、`updatedAt` は強化の時刻であることも確かめる。
4. **`claimKey` を持つ行で、NUL の `extractorVersion` を断った後に何も書かれていないことを見る。** `listActiveClaimPredicates` が `[]` であること、対照として同じ `claimKey` で NUL の無い行を作ると `["nul_refused"]` が見えること（読み口が常に空を返しているのではない）。元の NUL の歯からは、claim key の無い行を使った「何も書かない」の読み口を外し、断りの形（素の `Error`・メッセージ）だけにした。

### Postgres 側の歯は足さなかった

項目2の入力は、Postgres（`COLLATE "C"`）に既に当たっている。`packages/testkit/src/memory-store-conformance.ts` の同名の歯を `packages/postgres/src/__tests__/conformance.postgres.test.ts` が走らせる。同じ歯を postgres 側に写すと、conformance と二重になるので足さない。【判断】穴は Fake の歯（core）が ASCII だけだったことで、Postgres の歯ではなかった。

## 実測

自前の Postgres 17（`initdb`、ポート 55473、データ・ログは `/tmp/mgr-4ba236a4-wt3-pg/`）で測った。変異は `cp` で退避・復元した。

- **項目1**: `archiveDecayed` の `memory.updatedAt = new Date()` を消す変異で、archive の歯を別々に10回走らせて10回とも赤（直す前は6回中2回赤）。戻して緑。`purgeMemory` の `memory.updatedAt = new Date()` を消す変異で、purge の歯を別々に10回走らせて10回とも赤（直す前は5回中1回赤）。戻して、ファイル全体を別々に13回走らせて13回とも緑。時計を注入できたので、確率に依らない。【実測】
- **項目2**: `Buffer.compare(...)` を `a[0] < b[0] ? -1 : …` に変える変異で、新しい歯が赤（既存の歯は ASCII で通ったまま）。戻して緑。【実測】
- **項目3**: 並びの時刻の元を `m.createdAt` から `m.updatedAt` に変える変異で、新しい歯が赤（既存の歯は通ったまま）。戻して緑。【実測】
- **項目4**: `extractorVersion` の検査を `this.backing.memories.set(...)` の後ろへ移す変異で、新しい歯が赤。戻して緑。【実測】
- **Postgres**: `listActiveClaimPredicates` の `claim_key_predicate COLLATE "C" ASC` から `COLLATE "C"` を外す変異で、conformance の該当の歯を測った。
  - `--locale=C.UTF-8` の DB（`CLAUDE.md` の手順どおりの既定）では、**外しても緑のまま**。`C.UTF-8` の既定の照合順序が既にコードポイント順だから。【実測】
  - ICU（`LOCALE_PROVIDER icu ICU_LOCALE 'en-US'`）の DB では、外すと赤、戻すと緑。【実測】
  - 項目2の入力が、実装どおりの `COLLATE "C"` の Postgres で一致して通ることも、両方の DB で確かめた。【実測】
- 立てた Postgres は、測定の後に自分のものだけ `pg_ctl stop` で止めた。

## 直さないもの（約束の外と見立てた2件）

- **孤立サロゲートも断る変異**: ADR 0573 は NUL だけを約束している。Fake の `createMemory` のコメント（「孤立サロゲートは検査しない。入力をそのまま保持する。Postgres は node-postgres が静かに U+FFFD へ置換する」）が、挙動を現状の契約として書いている【現物】。断る変異は、その契約を変える側であり、歯で縛る対象ではない。
- **`sourceObservationId` の NUL も断る変異**: InMemory も Postgres の `assertNoNulInNewMemory` も検査しない【現物】。Fake だけが断ると、Postgres より厳しい非対称になる。約束の外。

どちらも、約束を足す判断（オーナー領分）が先にあるとき、歯を足す。

## CHANGELOG

変えない。利用者に見える変更が無い（テストだけで、`runtime-fakes.ts` も触らない）。CHANGELOG の「何を載せるか」は「テスト追加のみの PR は載せない」と書いており、前例の ADR 0572（a3d3d818）も載せていない。#1686（ADR 0574）が変えたのは、先に書いた CHANGELOG の記述を訂正する必要があったためで、本件には訂正すべき記述が無い。

## 引き受けた負債

- `--locale=C.UTF-8` の既定の手順の DB では、`COLLATE "C"` を外す変異は conformance の歯でも捕まらない。捕まえるには照合順序が C でない DB（ICU など）が要る。CI の脚（UTF8 / SQL_ASCII+C）の構成で捕まるかは測っていない。
- 項目2の入力は testkit の conformance と複製になっている。conformance の入力を変えたら、この歯も合わせること。
