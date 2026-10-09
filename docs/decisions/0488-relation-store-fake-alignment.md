# ADR 0488: 穴探し57巡目 — `RelationStore`。core の `FakeRelationStore` だけが範囲外の kind を受け、`createdAt` を参照のまま返していた。`listRelated` の偽の kind は Postgres と fixture で割れていたので、fixture を Postgres に揃えた

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。直す線（約束に実装を戻す・フィクスチャの揃え）の中だけを直し、新しく断る入力や遡ってデータを書き換える直しに当たるものは「材料」に回した。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定。

- **文脈**: 57巡目は `RelationStore` の `link`・`unlink`・`listRelated`・`listRelatedMany?` を、Postgres・testkit の `InMemoryRelationStore`・core の `FakeRelationStore` で突き合わせた。両端のテナント検査（ADR 0398・0438）、recall の連想枠と群の面は数えない。

- **見つけたこと**:
  1. 【実測】`FakeRelationStore.link` は範囲外の kind（`""`・`null`・`"Contradicts"`・`"bogus"`・`"__proto__"`・`0`）を受けて行を書く。interface は `unknown relation kind` で断ると約束しており（ADR 0398 の追記）、InMemory と Postgres は断る。
  2. 【現物＋実測】`FakeRelationStore.listRelated` は保存している `createdAt` を参照のまま返す。interface は「複製して返す。呼び手が書き換えても store の中の行は変わらない」と約束し、InMemory は複製する。
  3. 【実測】割れ（のちにクローン miku が向きを決め、下の「決めたこと」4 で直した）: `listRelated`・`listRelatedMany` の `kind` が `""`・`null`・`0` のとき、Postgres は絞り込みをしない（`kind ?` の真偽で分岐するので全件を返す）が、InMemory は `kind === undefined` で分岐するので 0 件を返す。interface が「省略」と言うのは `undefined` だけである。型の外の値なので、`Runtime` からは来ない。

- **確かめ方**: 先に歯を書いて commit・push し、直す前に走らせて赤を取った【実測】。Fake の歯は `list-related-many-round-trips.test.ts` の末尾に足し、直す前は kind 7 件と `createdAt` 1 件の計 8 件が落ちた。Postgres と fixture を並べる歯は新規の `packages/postgres/src/__tests__/relation-store-parity.postgres.test.ts`（26 件。Postgres は元から通る＝陽性対照）。

- **決めたこと**【判断】:
  1. Fake の `link` は、範囲外の kind を両端の検査より前に `FakeRelationStore: unknown relation kind: <kind>` で断る。
  2. Fake の `listRelated` は `createdAt` を複製して返す。
  3. 本番の adapter（`@mnemora/postgres`）は変えない。1・2 はフィクスチャ（Fake）だけの揃えで、公開 API・CHANGELOG・migration-v1 に影響しない（4 は影響する）（ADR 0479・0480 と同じ線）。
  4. **（追記。クローン miku の決定）** `InMemoryRelationStore` と `FakeRelationStore` の `listRelated`・`listRelatedMany` は、`kind` が偽の値のとき絞り込まずに全件を返す（`!kind` で分岐。Postgres と同じ）。歯の向きを「揃った振る舞い」に替えて先に commit・push し、直す前に InMemory 3 件・Fake 3 件が赤になることを確かめてから直した【実測】。やりすぎの変異（`kind` に関わらず絞り込まない）は、正しい kind では絞り込む陽性対照の歯が落とす。公開の fixture の返りが 0 件から全件に変わるので、CHANGELOG の `[1.2.0]` と migration-v1 の 🟡 に載せた（落ちる入力が減る側の変更）。

- **歯の確かめ**【実測】: 変異 3 本（`.mgr-notes/mutations-0488.txt`）。kind 検査の削除（7 件落ちる）・複製の削除（1 件落ちる）・検査を常に真にするやりすぎ（18 件落ちる）の全てを歯が落とした。

- **照合して、割れていなかったもの**【実測】（Postgres と fixture を同じ入力で）: 同じ組の `link` の冪等、自己 link（どちらも書ける）、向き（片方だけ書く）、`unlink` の無い行・2回目・範囲外の kind（何もしない）、壊れた id（`listRelated` は空、`listRelatedMany` はその位置だけ空、`unlink` は何もしない、`link` は `memory not found`）、`listRelatedMany` の重複（別々の配列）・空、範囲外の kind での `link`（`unknown relation kind`）。観点4: 記憶を `forget` しても関係の行は残り、`listRelated` は返し、その記憶への `link` も断られない。3実装で同じ。Fake と fixture の `purge`・`supersede`・archive は記憶の行を消さないので同じ結果になる【現物】。

- **材料（直していない。決めるのはクローンまたはオーナー）**:
  - **選ばなかった向き**: Postgres を `kind === undefined` の分岐に揃えて 0 件にする手。本物の adapter の返りが全件から 0 件に減り、利用者の観測が変わる（`kind` に偽の値を渡していた JS の呼び出し側が、関係を見失う）ので採らなかった。これはオーナーの領分なので材料として残す。
  - 観点4で、関係が残ること、forgotten などの記憶への `link` を断らないことは、新しく断る・遡って行を消す直し（消した記憶の関係を消す migration、`link` で status を見る）に当たるので触っていない。
  - Fake は `assertWellFormedCtx` を呼ばず、`listRelatedMany?` も実装しない（任意メソッド）。Fake 全体の方針なので触っていない。

- **追記（Issue #1963、2026-10-09）: 「変異 3 本」の控え `.mgr-notes/mutations-0488.txt` は、repo に無い**。クローン miku の判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。本文は書き換えていない。
  - **何が分かったか**【実測。2026-10-09、main `8dad21bc`】: 上の「歯の確かめ」が指す `.mgr-notes/mutations-0488.txt` は、作業ツリーに無い。`git log --all --name-only` に `.mgr-notes` を含むパスは1件も出ず、`mutations-0488` の名前も出ない。`git log --all -S"mutations-0488"` が返すのは、この ADR を足した 5c040573（#1599）だけである。つまり、その控えは一度も commit されていない（担い手の作業場の控えで、repo には入らなかった）。
  - **読み手へ**: 変異の数と結果（kind 検査の削除は 7 件、複製の削除は 1 件、検査を常に真にするやりすぎは 18 件落ちた）は、上の「歯の確かめ」の本文に残っている。それが記録の全てである。控えのファイルで確かめ直すことはできない。確かめ直すなら、同じ変異を実装へ当てて試験を走らせること。
