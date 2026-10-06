# ADR 0620: 09/27 にマージされた #1156（空間の組の衝突を拒む）の確かめ直しで見つかった穴に歯を足す（専用 schema・同時の登録・大文字小文字だけが違う組・provider だけが違う組）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1724](https://github.com/takecchi/mnemora/issues/1724) の #1156 のコメント（前の担当の確かめ直しの結果を写したもの）。そこで見つかった重さ「高」の4本だけをこの PR で塞ぐ。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】はマネージャーの判定。
これは試験だけの変更で、実装・migration・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない（[ADR 0614](./0614-merged-0927-postgres-recheck-teeth.md) などの試験だけの PR と同じ）。

## 経緯

#1156（Issue #1151）は、`registerEmbeddingSpace` がテーブルのコメントに空間の組を記録し、同じテーブルに潰れる別の組の登録を拒むようにした。前の担当の確かめ直しで、どの歯にも捕まらない変異が7本見つかり、うち4本が重さ「高」だった。残る3本（E9 `escapeLiteral`・E17 索引の前後・E19 `WITH (m = 16)`）は重さが中〜低で、この PR では足さない。

## 決定【判断】

1. 実装は変えない。
2. 歯を足す。どの歯も、今の main で緑、穴の変異で赤、`cp` で戻して `cmp` で一致させた後に緑、を実測した【実測。自分専用の PostgreSQL 17 + pgvector、`C.UTF-8`】。

| 変異（#1724 の番号） | 足した歯 | 置き場 | 赤にした変異 |
| --- | --- | --- | --- |
| E16 | 専用 schema で、衝突する2つの組を登録する。2つ目が拒まれ、コメントが1つ目の組のままで、public 側にテーブルが無い | `embedding-space-table-conflict-schema.postgres.test.ts`（新規。専用 schema はこのファイルが作って消す） | 読みの `to_regclass` から schema の修飾を外す |
| E8 | 1つ目が「コメントを読んでから書くまで」の間に止まっている間に2つ目を始める（`COMMENT ON TABLE` の直前に 400ms 待つ Pool の見せかけで、順序を固定する）。2つ目が拒まれ、コメントが1つ目の組のまま。加えて、衝突する別々の2つの組を `Promise.all` で同時に登録し、片方だけが拒まれる | `embedding-space-table-conflict.postgres.test.ts` | 突き合わせを advisory lock の外（解放の後）へ出す |
| E4 | provider が `ZzProbe` と `zzprobe` で、ほかは同じ組 | 同上の `PAIRS` に追加 | 組の比較で大文字小文字を畳む |
| E12 | provider だけが違う組（`zz_probe_p` と `zz-probe-p`） | 同上の `PAIRS` に追加 | 比較から provider を外す |

E8 は、`Promise.all` で単に同時に走らせるだけでは、変異を入れても3回のうち1回しか赤にならなかった【実測】（窓が数ミリ秒で、1つ目の記録が2つ目の DDL より先に終わる）。順序を固定した歯は、変異で3回とも赤、戻して3回とも緑だった。`Promise.all` の歯は、実際の同時登録の形を残すために置いてあり、E8 を縛るのは順序を固定した歯のほうである。
