# ADR 0535: 文書とコードのずれを横に掃く（第5弾の1回目）— ADR 0530 の分の文書を、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-d9378a02 の指示による）が書いた。文書の側の直しは無かった。コードの側を直すべき食い違いも見つからなかった。

**照合の基準は main `3c90e3b7`。** ADR 0533（#1630）の続きで、0530（#1628、`b6e30f6a`）の分を掃く（`git diff f3e44794 b6e30f6a`）。ADR 0533 の冒頭は 0505・0508・0530・0531・0532 などを「追い足す」と書いたが、クローンの決定で 0533 は 0503 までで締め、それ以降はこの ADR で掃く。**このあとマージされる 0505・0508・0531・0532・0510・0534 などは、マージされた順に追い足す。**

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 0530 は、1回の `tick` の2件目の処理中にリースが切れ、別の `tick` が再 claim して二重に処理したときの結末を、種類（`embed`・`extract`・`reflect`・`consolidate`）ごとに Fake・InMemory・Postgres の3者で測った。結果は TSDoc の約束どおりで一致し、`consolidate` の結末だけが TSDoc に書かれていなかったので、`runtime.ts` の `TickOptions.leaseMs` の TSDoc に1段落を足した（実装は変えていない。CHANGELOG・migration には載せていない。0530 決定1）。
  決まり（前回と同じ）: CHANGELOG の `[1.2.0]` と migration-v1 の v1.2.0 の節（「`v1.2.0` で出す」の節）には触らない。既存の ADR 本文は対象外。

- **探した場所**【現物】:
  - 差の確認: `git diff f3e44794 b6e30f6a`（`runtime.ts` の TSDoc 6 行、ADR、歯 2 本、索引）。`CHANGELOG.md`・`docs/migration-v1.md`・README・約束の文書の差は無い。
  - 語の grep: `二重|再配達|leaseConflicts` を `docs/architecture.md`・`memory-model.md`・`recall.md`・ルートと各パッケージの README・`interfaces/outbox-store.ts` に。`再配達|二重に|リース` を `runtime.ts`（3000 行目以降）に。ヒットした所を読んだ: `docs/architecture.md` §5.2（`leaseConflicts` を積んで次のジョブへ進む）・§5.11（`claimBatch` が二重に claim しない）、`docs/memory-model.md` の行13（`reflect` の再配達で内省の記憶が2件になる）、`interfaces/outbox-store.ts` の再配達の注記、`Runtime.reflect`・`Runtime.consolidate` の TSDoc（再配達の扱い）、`packages/bullmq/README.md` の「データは壊れない」。
  - 機械照合を、前回の最後（ADR 0533 の追い足しのあと）と同じ文書の集合に再度通した。

- **突き合わせの結果**【現物】:
  - 新しい TSDoc の4種類の結末（`embed` は同じベクトルを上書き、`extract` は事前の確認が効かないとき同じ候補なら冪等の鍵で1件・違う候補なら両方 `active`・遅れた側の LLM が落ちると全文フォールバックの記憶も残る、`reflect` は材料を `superseded` にしないので内省が2件、`consolidate` は書く前の読み直し〔ADR 0420〕で先に統合された元の記憶を見て何も書かずに打ち切る）と、「どの種類でも遅れた側の `complete`/`fail` は `leaseConflicts` に載り、行は先に完了した側のまま」は、ADR 0530 の表（12項目・3者一致）と一致する。`consolidate` の打ち切りは `runtime.ts` の書く前の読み直し（`recheckedBeforeConsolidateWrite`）、`reflect` の内省が材料を `superseded` にしないことは `runtime.ts` の `reflect` の `created` の組み立てと矛盾しない。
  - 既存の記述と矛盾しない: `docs/memory-model.md` の行13（`reflect` は再配達で2件）、`interfaces/outbox-store.ts` の「`embed`・`consolidate` は1回だけ処理したときと同じ」、`Runtime.reflect`・`Runtime.consolidate` の TSDoc、`docs/architecture.md` §5.2 の `leaseConflicts` の記述。新しい段落が先頭で挙げる参照先の歯（`fake-tick-batch-exceeds-lease-parity.test.ts`・`tick-batch-exceeds-lease-parity.postgres.test.ts`）も、実在する。
  - README・約束の文書に、二重処理の結末を種類ごとに書いた所は元から無く、古くなった記述は無かった。CHANGELOG `[1.3.0]`・migration-v1 に 0530 の項は無い（0530 決定1どおり。文書だけの訂正で、挙動も公開の型も変わらない）。
- **直したもの**: なし（文書の側に古い記述が無かった）。
- **コードの側を直すべき食い違い**: 見つからなかった。オーナーの領分の材料として、ADR 0530 が挙げる3点（`limit` の既定と `leaseMs` の関係、`OutboxStore` にリースを延ばす口を足すか、`reflect` の二重を許すか）が残る。変更なし。
- **前回との比較**【実測】: 識別子・パス・リンク・`Type.member`・import の照合は、前回の最後の出力と、行番号を除いて同じ。TSDoc の2つの照合も同じ。文言の照合は、ADR 0528（#1622）が `docs/architecture.md` に足した `setEventRetention` の int4 の文面の1行が、この基準（`3c90e3b7`）には入っているので、1行多い。それ以外は同じ。
- **陽性対照**【実測】: 一時の md に存在しないパス `docs/decisions/0530-nope.md` を書いてパスの照合に通し、拾った（実在する歯のパスは拾わなかった）。一時ファイルは削除した。種類ごとの結末と実装の突き合わせには機械の陽性対照が無い（手で読んだ）。
- **【未確認】**: 0530 の2つの歯（Fake・InMemory・実 Postgres）を走らせていない。ADR 0530 が書く4種類の結末の12項目そのもの。0530 が測っていないと書く範囲（複数プロセス・複数の接続プール、`reflect` の材料が処理の途中で `superseded` になる場合）。
- **走らせたコマンド**: `node scripts/generate-adr-index.mjs`、機械照合のスクリプト（repo の外）。ビルド・全テスト・DB の要るテストは走らせていない。

- **引き受けた負債**: この ADR の結果は `main` の `3c90e3b7` に対して測った記録で、`main` が進めば古くなる。照合の道具は repo に入れていない（ADR 0495 の代替案1のとおり）。
- **これが覆るとしたら**: 上の探し方が拾わない種類（散文の中で二重処理の結末を言い換えた文）の古さが見つかったとき。
