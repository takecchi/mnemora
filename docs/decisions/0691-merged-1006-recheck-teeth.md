# ADR 0691: 10/06 マージ分の確かめ直し（#1877）で見つかった穴に歯を足す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1877](https://github.com/takecchi/mnemora/issues/1877)。測ったのは作業者。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。
これは試験だけの変更で、実装・TSDoc・migration・CHANGELOG・公開の適合テスト（`*-conformance.ts`）・`__fixtures__/` は触らない（[ADR 0671](./0671-merged-0930-front-rest-recheck-teeth-1523-1525-1527-1529.md)、[ADR 0677](./0677-merged-0930-front-tail-a-recheck-teeth-1545-1548-1549.md) と同じ）。

## 経緯【実測】

2026-10-06（UTC）にマージされた PR の確かめ直し（#1877）を、7群に分けて行った。測定は main `b82969b1`【実測】。変異は、足りない側とやりすぎた側の両方を、退避（`cp`）・1つ入れる・名指しのテストを前景で1本ずつ走らせる・`cp` で戻して `cmp` で一致を確かめる、の順で当てた。DB が要るものは専用の Postgres 17（`C.UTF-8`）を立てて走らせ、終わって止めた。全テストは走らせていない。

| 群  | 中身                                   | PR の数 | 当てた変異        | すり抜けを塞いだ歯のある PR       |
| --- | -------------------------------------- | ------- | ----------------- | --------------------------------- |
| B   | postgres・core・local-embedding の修正 | 9       | 108               | #1743・#1750・#1761・#1795・#1797 |
| A   | testkit・Fake を含む修正               | 4       | 139               | #1740・#1753・#1762・#1772        |
| E   | scripts・CI の門                       | 5       | 249               | #1747・#1783・#1789・#1816        |
| D   | 特定の約束に歯を足した試験の PR        | 5       | 40                | #1766・#1771                      |
| F   | コメント・TSDoc・README の PR          | 11      | 48                | #1757・#1773                      |
| C   | 確かめ直しの穴に歯を足した試験の PR    | 17      | 0（記録を読んだ） | なし                              |
| G   | 文書だけの PR                          | 4       | 11                | なし                              |

後の採用済み ADR で約束が狭まった PR は無く（#1753 の README の一文が #1762 で逆になったものは、今の約束の側で当てた）、そのまま今の約束に当てた。C 群は、17本すべてに「変異で赤・戻して緑」の記録が既にあったので、変異を当てず、記録を読んで済ませた【判断】。

## 決定【判断】

1. **実装は変えない。**公開の適合テストにも足さない。歯は各パッケージの固有のテストに置く。
2. 次の歯を足す（群・PR・歯のファイル・commit）。どの歯も、元の変異で赤、戻して緑を確かめた。

| 群  | PR    | すり抜けた変異                                                                                                              | 足した歯（`packages/` と `scripts/` の下の `__tests__/`）                                                                                                                                                                                                                    | commit                        |
| --- | ----- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| B   | #1795 | 同じ群の2件が同伴取得で戻る形で、差し引きを群ごとに1件に潰す                                                                | core の `recall-relation-over-limit-association-companion.test.ts` に (f) を足した                                                                                                                                                                                           | `d007cad0`                    |
| B   | #1797 | ROLLBACK が失敗したとき、元の例外を上書きする                                                                               | postgres の `migrate-pgvector-capability-search-path.test.ts`（DB 無し。create・verify の両方）                                                                                                                                                                              | `6837bf04`                    |
| B   | #1750 | ROLLBACK 成功の条件を外す・detail が文字列でないものを通す・null の入力で落ちる                                             | postgres の新規 `migrate-index-name-race-retry-rollback-condition.test.ts`（DB 無し）                                                                                                                                                                                        | `fba175f7`                    |
| B   | #1743 | 既定の20件・壊れた接続を捨てない                                                                                            | postgres の新規 `cross-tenant-reference-detection-defaults.postgres.test.ts`                                                                                                                                                                                                 | `03ccae49`                    |
| B   | #1761 | `resend.memories` の昇順を `localeCompare` にする                                                                           | core の新規 `observe-resend-order-code-unit.test.ts`                                                                                                                                                                                                                         | `ce7a94a5`                    |
| A   | #1772 | `purgeMemory`・contested 7か所の not found の綴り・`TypeError`・冪等の既存の行が在る形                                      | postgres の新規 `testkit-fixture-alignment-not-found-spelling-purge-and-contested.postgres.test.ts`、testkit の新規 `in-memory-decay-floor-at-must-be-a-date.test.ts`                                                                                                        | `07fcd385`                    |
| A   | #1753 | wall が `nowSeq` の範囲を見る・README の負の limit の行                                                                     | postgres の新規 `testkit-fixture-alignment-archive-decayed-wall-ignores-nowseq.postgres.test.ts`・`readme-exception-faces-negative-limit-and-contested-status.postgres.test.ts`                                                                                              | `7a85acc3`                    |
| A   | #1762 | 複数イベントを受ける口の2つ目以降・Invalid Date が `RangeError` になる・Fake の残りの口                                     | postgres の新規 `testkit-fixture-alignment-written-floor-later-members.postgres.test.ts`、testkit の新規 `in-memory-written-floor-leaves-invalid-date-alone.test.ts`、core の新規 `fake-written-timestamptz-floor-remaining-ports.test.ts`                                   | `7f1e96b7`                    |
| A   | #1740 | 2件目以降の壊れた news が、存在しない対象より先に断られない                                                                 | core の `fake-supersede-malformed-news-position-before-missing-target.test.ts`、testkit の `in-memory-supersede-malformed-news-position-before-missing-target.test.ts`、postgres の `supersede-malformed-news-position-before-missing-target.postgres.test.ts`（すべて新規） | `825630bf`                    |
| A   | #1740 | 例外が素の `Error` でない・拒んだ値を載せる・全候補が壊れたとき最後の例外を投げる                                           | core の新規 `new-memory-check-error-shape.test.ts`、postgres の新規 `create-memories-all-malformed-throws-first-error.postgres.test.ts`                                                                                                                                      | `52a83616`                    |
| E   | #1747 | CR 単独の正規化・名簿の形・`--write` が削除を見逃す・`ci.yml` の段と `package.json` のスクリプト                            | scripts の新規 `check-migration-checksums-edges.test.mjs`                                                                                                                                                                                                                    | `13dca757`                    |
| E   | #1783 | コメントを潰す部品が `CHANGELOG` を含む行を丸ごと潰す                                                                       | scripts の新規 `workflow-comment-blank-lib-keeps-changelog-lines.test.mjs`                                                                                                                                                                                                   | `2ba8cbc5`                    |
| E   | #1789 | 門の呼び出しの引数と env・隠しファイル・hash の種類・接頭辞の剥がし方・報告の文面                                           | scripts の新規 `ci-yml-local-embedding-fingerprint-invocation.test.mjs`・`check-local-embedding-fingerprint-cli-edges.test.mjs`・`check-local-embedding-fingerprint-lib-edges.test.mjs`                                                                                      | `6c97cdd5`（整形 `37f7981f`） |
| E   | #1816 | 追加された ADR が1本も無いときの `adr-renumber` の exit code                                                                | scripts の新規 `adr-renumber-cli-nothing-added.test.mjs`                                                                                                                                                                                                                     | `7902d809`                    |
| D   | #1771 | ルートの `test.isolate: false` を直列 project が `extends: true` で引き継ぐ                                                 | postgres の新規 `vitest-config-isolate-inherited.test.ts`                                                                                                                                                                                                                    | `e075cc8b`                    |
| D   | #1766 | purge・scrub の先取りの絞りを「どれかの記憶に付いたラベル」へ広げる                                                         | postgres の `label-lock-order-teeth.postgres.test.ts` に、他の記憶に付いたラベルを掴まない歯を足した                                                                                                                                                                         | `da3d6549`                    |
| F   | #1757 | `supersedeWithNewMemories` を持たない側で、`expectedStatus` を外す・競合を `skipped` に積まない・競合以外の例外を握りつぶす | core の新規 `reextract-unsupported-cas.test.ts`                                                                                                                                                                                                                              | `a45fd19a`                    |
| F   | #1773 | 本文以外の欄を空白だけで断る側へ広げる                                                                                      | core の新規 `observe-whitespace-only-ids-still-accepted.test.ts`                                                                                                                                                                                                             | `88ae4004`                    |
| F   | #1773 | opt-in の observe が、一覧が無いとき `sanitizeCandidateSubjectId` を飛ばす                                                  | core の新規 `llm-malformed-subject-id-opt-in.test.ts`                                                                                                                                                                                                                        | `46e6a342`                    |

3. **歯を足さないもの**は次のとおり。理由ごとに分ける。

   **等価の変異（結果が変わらない）**

   | PR    | 変異                                                                                       | 理由                                                                                                   |
   | ----- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
   | #1743 | `sampleLimit > 0 &&` を外す                                                                | `LIMIT 0` は空を返すだけ                                                                               |
   | #1761 | `purgedAt !== null` を `!= null` に・その逆                                                | どの adapter も `null` で返す                                                                          |
   | #1796 | `sliceAtGraphemeBoundary` の負の下限・`<=` を `<`・末尾の扱い（3つ）                       | 結果が変わらない                                                                                       |
   | #1740 | Postgres の検査を INSERT の後へ動かす                                                      | 同じトランザクションの中で ROLLBACK されるので見た目は同じ                                             |
   | #1762 | `purgeMemory` の2か所目の事前検査・supersede の事前検査の `skipAtFloor` 付き呼び出しを外す | 床は別の呼び出しが見る                                                                                 |
   | #1747 | 値が文字列でない名簿・「名簿に無い」の文面                                                 | 正規表現が数値を文字列にして弾く・理由の文面だけが変わる                                               |
   | #1816 | 未知ロケールの分岐を外す                                                                   | 理由の文面だけが変わる                                                                                 |
   | #1766 | 共有の `FOR NO KEY UPDATE`・purge の `l.tenant_id` を `true`                               | [ADR 0662](./0662-label-lock-order-teeth-observe-locks-directly.md) が等価・同値として足さないと書いた |
   | #1771 | 直列 project に明示の `isolate: true`                                                      | 既定と同じ                                                                                             |
   | #1800 | `search_path` の順を逆にする・末尾に `,public` を足す・能力検査を飛ばす（3つ）             | `vector` も表も別の名前で見つかる・能力検査は既存の歯が見る                                            |

   **約束の外・設計どおり**

   | PR    | 変異                                                       | 理由                                                                                                                                                 |
   | ----- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
   | #1747 | 名簿の1行を落とす                                          | [ADR 0637](./0637-migration-checksums-pinned-and-0027-deadlock-not-fixable-by-new-migration.md) の「引き受けた負債」（追加を赤にしない）の設計どおり |
   | #1783 | `CHANGELOG` の語を `CHANGE""LOG` のように割る書き方        | [ADR 0664](./0664-merged-0922-recheck-publish-changelog-gate-stays-withdrawn.md) が「確かめていないこと」に書いた既知の範囲                          |
   | #1813 | 3文書に載らない新メソッド・中核以外の改名で緑のまま        | 約束の外（3文書へメソッド名の列挙は求めない）                                                                                                        |
   | #1817 | `contestedWith` を片向きに読まなくなる（K3）               | 対は両向きの参照で拾えるので出力が変わらない。PR の約束の外                                                                                          |
   | #1761 | runtime 越しの歯で別テナントの記憶を読む変異が赤にならない | PR 本文に既出。適合テストの1本が赤にする                                                                                                             |

   **Redis でしか走らないもの**: #1765 の `*.redis.test.ts` 2本、#1756・#1787・#1807 の bullmq の `*.redis.test.ts`。この器には redis-server が無く（gcc・make も無いので建てられない）、変異も走りも確かめていない。CI の `redis` サービスで走る範囲に残る。#1765 の単体の歯は、9つの変異をすべて赤にした。

   **LLM の測定値で縛れないもの**: #1817 の TSDoc が書く「別々の発話どうしが語彙ヒントに吸い寄せられて同じ predicate になり、訂正ではない対も contested になる」は、LLM の応答に依る測定値（ADR 0329・0335 の 2026-10-07 の追記）で、コードに固定された約束ではない。試験では縛れない（記録の再生で縛る手はあるが、カセットの録り直しと実 API が要る）。印が届くこと（K1・K2・K4）は赤になった。

## 歯では直せない食い違い【現物】

文書・設計の側の直しで、この PR では直さない。

| PR                  | 食い違い                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #1753               | `packages/postgres/README.md`「例外の見分け方」が「DB に触れる前に断る `RangeError`」の行に負や `NaN` の `strength` を挙げるが、現物は DB が拒んだ例外（`cause.code` `23514`）で `RangeError` にならない（`RangeError` は testkit の入力を作る段と core の戦略が投げる）。歯は現物の顔を縛った                                 |
| #1816               | ADR 0675 の「足した歯」の本数: `adr-index-freshness-branch-lib-edges.test.mjs` は本文で7本、現物は8本（合計113本は合う）                                                                                                                                                                                                       |
| #1747               | 名簿は、載せ忘れた新しい migration を固定しない（ADR 0637 の負債）。機械で強制すると「追加を赤にしない」と矛盾する。設計の判断に残る                                                                                                                                                                                           |
| #1771               | 足した歯は、`extends: true` の引き継ぎの仕様を前提に実効値を計算する。vitest が実際にそう効くかは見ていない                                                                                                                                                                                                                    |
| #1768               | ADR 0641 が外した #1503 の食い違い: `autonomy.md` §4 の表の `adr-renumber` は「マージする側が」、索引の行は「PR の側で」                                                                                                                                                                                                       |
| #1764               | ADR 0521 は Postgres の `memoryNotFound` も小文字の id を載せると書くが、`updateStatus` などは渡された綴りのまま載せる（#1615）。`foo-bar` の数え方が Postgres と fixture で割れる（#1639）。InMemory の `decayFloorAt: null` は Postgres は断り fixture は通す（#1603）。fixture 側だけを縛ると割れを固めるので歯にしていない |
| #1754               | migration 0024 のコメントが「ADR 0352」と書く（実際は 0353）                                                                                                                                                                                                                                                                   |
| #1767               | 方針の判断待ちの3件（#1476・#1490・#1472）。#1472 は後の #1771 で歯になった                                                                                                                                                                                                                                                    |
| #1810               | ADR 0335 の追記の行番号（`runtime.ts:5668` ほか、`memory-store.ts:3982`）が、いまの main では指す先がずれている。書いた時点では正しかった。記述の内容は実装と合っている                                                                                                                                                        |
| #1811               | migration-v1 の項目70（68・69 も）の「⚠ 未リリース」「同じ番号が使われていたら振り直す」が、v1.3.0 の出荷後も残っている                                                                                                                                                                                                        |
| #1770・#1777・#1811 | `pnpm format:check` は `.md` を見ないので、文書だけの PR では何も見ずに通る                                                                                                                                                                                                                                                    |
| #1773               | `docs/` 側の文面（architecture・autonomy・conformance・migration-v1・ADR 0228・0413・0431・0442・0642・CHANGELOG）は、コードの約束ではない記述が大半で、変異では確かめていない                                                                                                                                                 |
| #1760               | 適合テストの「skip は件数集計のクエリを発行しない」の歯は、`countScopeAggregateQueries` を渡さない adapter（InMemory）では「未検査」の枝に入り、Postgres の適合テストでだけ走る                                                                                                                                                |

## 測ったこと【実測】

- 足した20本の commit（歯のファイル30本）は、main `b82969b1` に続く main を取り込んだあと（衝突なし）も、名指しで1本ずつ緑。DB が要るものは専用の Postgres で走らせた。Redis が要るものは足していない。足したファイルだけに `prettier --check` と `eslint` をかけ、どちらも通った。
- **core の `src` に入れた変異は、postgres のテストに届く。**postgres・testkit・local-embedding・openai・anthropic・bullmq の `vitest.config.mts` は、`@mnemora/core` を `core/src/index.ts` へ alias している（`packages/postgres` は testkit も `src` へ）。`new-memory-check.ts` の digest の検査を外すと、postgres の `create-memories-all-malformed-throws-first-error.postgres.test.ts` が赤になり、戻して緑になることを確かめた。F 群の原稿の「postgres のテストは `@mnemora/core` を `dist` から読む」は誤りで、その理由で確かめていないとされた箇所は、postgres のテストで確かめられる（core 側の歯でも縛られている）。判定が変わったものは0件。

## 引き受けた負債

- C 群の17本は、記録を読んだだけで、歯が今の main で本当に赤になるかを再測していない。再測するなら、記録が最も粗い #1807・#1754 を先にする。
- #1743 の大きな表での所要時間、#1750 の本物の同時実行での再現率は確かめていない（決定的な代用で縛られている）。
- #1765 の Redis の歯、`*.redis.test.ts` 全般は CI だけが走らせる。

## これが覆るとしたら

- Redis の歯が本物の Redis で緑・赤にならないと CI で分かれば、#1765 の「他が居る」の判定の歯を、単体の歯とあわせて直す。
- #1747 の名簿の欠落が約束だと分かれば、名簿に載っていない migration を赤にする歯を足す（ADR 0637 の設計の見直しが先）。
