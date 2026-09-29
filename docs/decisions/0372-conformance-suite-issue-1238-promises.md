# ADR 0372: Issue #1238 の棚卸しのうち7件を conformance suite の `it` として足す

- **状態**: 採用 (2026-09)

- **文脈**:

  [Issue #1238](https://github.com/takecchi/mnemora/issues/1238) は、クローン miku の
  委譲先が「2026-09-27 にマージした歯のうち、外部 adapter にも課しうる約束」を
  読むだけで棚卸しした記録である——**推奨は書かない**とあらかじめ宣言しており、
  「足すなら何を」の一覧（A1〜A15、コメント1・2）を挙げるだけで、足すかどうか・
  どれを足すかは決めていなかった（[Issue #809](https://github.com/takecchi/mnemora/issues/809)
  の決定「conformance suite に要件を足すと、外部 adapter の CI を新しく赤にしうる」を
  踏まえての留保）。

  マネージャー（別クローンの委譲）から、A1・A3・A4・A5・A6・A7・A9 の7件を実際に
  足す作業が切り出された。**入力検証の要件は足さない**という #809 の決定
  （`packages/testkit/src/index.ts` 冒頭）は変えない——足した7件は、どれも
  「正しさの約束」（読み戻し・ロールバック・並行・鍵の一意性）であり、入力の
  受理・拒否そのものを新しく縛るものではない。

  事前のプローブで、7件とも今の testkit fixture・Postgres の両実装で既に成り立って
  いることを確認済みだった。⟹ 本 PR は「実装を直す」PR ではなく、「既に成り立って
  いる約束を歯で固定する」PR である。

- **決めたこと**:

  1. **次の7つの約束を、対応する conformance suite に `it` として足す**（住所は
     `packages/testkit/src/*-conformance.ts`）。

     | # | 約束 | suite | it |
     |---|---|---|---|
     | A1 | `supersedeWithNewMemories` の途中（news の2件目）で投げたら、書いた分（news[0]・outbox・ラベル）も旧行も一切残さない | MemoryStore | `supersedeWithNewMemories は news[1] の sourceObservationId が実在しないと投げ、news[0]・outbox・ラベルも旧行も一切残さない（1トランザクション）` |
     | A3 | 区切り文字（`:`・`::`）を含む tenantId・contentHash・extractorVersion・space の model でも、別の対象・別テナント・別 space と衝突しない | MemoryStore（2本）・VectorStore（1本） | `createMemory の冪等キーは …（区切り文字）` 2本、`ラベルは \`::\` を含むテナントでも分かれる（区切り文字）`、`space の model に \`:\` を含んでいても、前方一致で別の space のベクトルを拾わない（区切り文字）` |
     | A4 | 2テナントで同じ口を並行に撃っても、テナントをまたいで created・行を取り違えない | MemoryStore | `createObservationWithOutbox を2テナントで同じ externalId を使って並行に撃っても、テナントをまたいで created・行を取り違えない` |
     | A5 | `onlyMemoryIds`/preview 側に形式不正な id が混ざっても例外にせず、形の正しい id だけが戻る | MemoryStore（2本） | `restoreSupersededBy の onlyMemoryIds に形式不正な id が混ざっても…`、`previewRestoreSupersededBy の onlyMemoryIds に形式不正な id が混ざっても…` |
     | A6 | `lastReinforcedAt: null` の記憶に、`recordedAt`（作成時刻）より前の `at` で reinforce しても、減衰の起点を巻き戻さない（no-op） | MemoryStore | `reinforce は未強化（lastReinforcedAt: null）の記憶に、recordedAt より前の at を渡しても起点を巻き戻さない（no-op）` |
     | A7 | `listActiveClaimPredicates` は subject か predicate の片方しか無い claim key を数えない | MemoryStore | `subject か predicate の片方しか無い claim key を持つ Memory は数えない（null を混ぜない）` |
     | A9 | `EventStore.append` の `meta`・`actor` が、core が入れる形（文字列・id・id の配列）だけのまま読み戻る | EventStore | `append は core が入れる形（文字列・id・id の配列だけの meta・actor）を、そのままの値で読み戻す` |

     合計12本の `it`（A3 が4本、A5 が2本、他は1本ずつ）。

  2. **A1 は当初「`createMemoryWithOutbox` の再送で `created: true` になること」だけで
     ロールバックを確認していたが、変異試験で「冪等キーの索引だけロールバックされ、
     Memory 行そのものは孤児のまま残る」変異に対して緑のまま通ることが分かった
     （索引が空だと再送は「新規作成」として素通りする）。⟹ `listBySourceObservation`
     （必須メソッド）で直接「news[0] の行が無い」ことを見る形に直した。**この気づきが
     本 ADR に載る理由**——`docs/autonomy.md` §2 が要求する「歯が実際に噛むことを、
     変異試験で示した」を満たす過程で、歯そのものの穴を見つけて直した。

  3. **候補のうち7件は、この PR では足さない**（理由は各候補ごと）。

     - **A2**（イベントを書く口の「投げるなら、呼ぶ前と同じ」）: Issue 本文が「共通に
       使える入力は見つけていない」と明記しており、adapter ごとに失敗させる入力が
       違う。今回のマネージャーの切り出しにも含まれていない。
     - **A8**（返り値・渡した入力が store の中と切り離されている）: 同上、切り出しの
       範囲外。
     - **A10〜A15**（`events_purged` の meta の型・`getRecall` の `query` の JSON 往復・
       `LLMProvider.completeStructured` の4スキーマ・`LexicalStore` の語の分け方・
       adapter 間の差分ファズ・`purgeExpiredEvents` の並行）: Issue 本文がそれぞれ
       「adapter によって違う」「課すと語の分け方を adapter に強制する」等の留保を
       明記しており、切り出しにも含まれていない。
     - **コメント1**（`resolveOrphanedContested` の CAS 例外）・**コメント2**（例外の
       欄の値まで見る）: PR #1296 の棚卸しコメントであり、Issue #1238 本文とは別の
       候補。切り出しの範囲外。

     どれも「実装を直せば足せない」という意味ではなく、**この PR が扱う範囲の外**
     という理由である。足すかどうかの判断自体は、まだ誰もしていない。

  4. **足した7件は、テナント分離・区切り文字の一意性・トランザクション境界・
     並行安全性という、Postgres 固有ではない adapter 一般の約束である**——
     `docs/testkit` の入力検証除外（#809）には当たらない。

  5. **破壊的変更として数える。** `docs/migration-v1.md`「数え方の規律への追記
     （2026-09-28）」規律2 の ⛔ が「conformance スイートの判定を厳しくする変更は、
     これまでどおり上の定義と各世代の分け方で数える」と明記しており、
     [PR #1394](https://github.com/takecchi/mnemora/pull/1394)（Issue #1237、
     ADR 0355）が同じ理由で `migration-v1.md` 項目21として先に破壊的変更と
     数えている。今回足した7件も、これまで緑だった第三者の `MemoryStore`/
     `VectorStore`/`EventStore` 実装を、要件を満たしていなければ新しく赤にしうる
     ——同じ扱いにする。`v1.X.0` で破壊的変更してよいことは、オーナーの回答
     （ask_human `6911db12`）の範囲に入る。CHANGELOG の `[1.1.0]` 節 `### Breaking`
     と `docs/migration-v1.md` 項目23に記録した。

  6. **変異試験は一時的な確認に留め、恒久の歯として残さない。** [PR #1394]
     が変異試験を「別の作業ツリー（origin/main の実装に、この PR のテストファイル
     だけを写したもの）」で行い、結果を PR 本文に数字で記録するだけで、変異を
     入れた実装そのものは repo に残さなかった前例に倣った。今回も、testkit の
     `__fixtures__/in-memory-*.ts` を直接一時的に変異させ（`cp` で退避 →
     変異 → 対象の `it` を `-t` で絞って赤を確認 → `cp` で復元 → 緑に戻ることを
     確認）、結果を本 ADR と PR 本文に記録した。**恒久の「わざと壊れた wrapper
     store」を `packages/testkit/src/__tests__/` に追加する形は採らなかった**
     ——`packages/testkit/src/index.ts` 冒頭の #809 の決定は「Fake と Postgres の
     食い違いは Fake を直し、その回帰の歯を `src/__tests__/` に置く」であり、
     今回はそもそも Fake と Postgres が食い違っていない（両方とも既に約束を
     満たしている）ため、恒久の回帰の歯を新設する理由が無い。壊れた wrapper を
     残すと、それ自体を保守する負債になる。

- **検討した代替案**:

  1. **変異試験を恒久の歯として `packages/testkit/src/__tests__/` に残す。**
     ⛔ 採らなかった——上の決めたこと6のとおり、既存の「Fake と Postgres の
     食い違いを直す」という `src/__tests__/` の存在理由に当てはまらず、
     保守コストだけが残る。

  2. **A2・A8・A10〜A15・コメント1・2 も一緒に足す。**
     ⛔ 採らなかった——マネージャーの切り出しの範囲外であり、Issue 本文自身が
     「共通の入力が無い」「adapter によって違う」と留保している候補を、
     根拠を積み増さずに足すと #809 の決定（外部 adapter を新しく赤にしうる
     変更は慎重に選ぶ）に反する。

  3. **非破壊的変更として扱う（CHANGELOG に載せない）。**
     ⛔ 採らなかった——`docs/migration-v1.md` の規律2 の ⛔ と ADR 0355 の前例に
     明確に反する。

- **確かめたこと（変異試験、`AGENTS.md`/`docs/autonomy.md` §2 の作法——`cp` で
  退避 → 変異 → 対象の歯だけを `-t` で絞って赤くなることを確認 → `cp` で復元 →
  緑に戻ることを確認）**:

  | # | 約束 | 変異 | 結果（赤） | 復元後（緑） |
  |---|---|---|---|---|
  | A1 | `supersedeWithNewMemories` のロールバック | `in-memory-memory-store.ts` の catch 節から Memory 行の削除だけを外す（outbox・ラベル・索引のロールバックは残す） | 1 failed（`listBySourceObservation` が孤児行を検出） | 1 passed |
  | A3-1 | 冪等キーの区切り文字 | `extractionKey` を `JSON.stringify` の配列から `${tenantId}:${sourceObservationId}:${extractorVersion}:${contentHash}` の連結へ戻す | 2 failed（境界がずれた2件が衝突） | 2 passed |
  | A3-2 | ラベルキーの区切り文字 | `labelKey` を連結 `${tenantId}::${name}` へ戻し、`listLabels` のテナント絞り込みも前方一致へ戻す | 1 failed（`a::b`/`a` のタグが1件に潰れる） | 1 passed |
  | A3-3 | ベクトル空間キーの区切り文字 | `InMemoryVectorStore` の空間一致を `model !== space.model` から `!model.startsWith(space.model)` へ戻す | 1 failed（`m` の検索が `m:3` のベクトルを拾う） | 1 passed |
  | A4 | テナント分離 × 並行 | `createObservationIdempotent` の既存行検索から `tenantId` の絞り込みを外す | 1 failed（`bCreated: false`・`sameRow: true` で別テナントの行を再利用） | 1 passed |
  | A5 | `onlyMemoryIds` の形式不正 id | `restoreSupersededBy`/`previewRestoreSupersededBy` の先頭に、UUID 形式チェックで例外を投げるガードを追加 | 2 failed（両方とも例外を投げる） | 2 passed |
  | A6 | reinforce の起点（未強化） | `(memory.lastReinforcedAt ?? memory.recordedAt)` を `(memory.lastReinforcedAt ?? new Date(0))` へ変える | 1 failed（作成時刻より前の `at` でも書いてしまう） | 1 passed |
  | A7 | claim key の片方欠落 | `listActiveClaimPredicates` のガードを `subject == null \|\| predicate == null` から `subject == null && predicate == null` へ緩める | 1 failed（`undefined`/`home_city` が混ざる） | 1 passed |
  | A9 | EventStore の meta/actor 往復 | `InMemoryEventStore.append` で `stored.actor` を `{ type }` だけに削る | 1 failed（`actor.id` が消える） | 1 passed |

  各変異ごとに `git diff --stat packages/testkit/src/__fixtures__/` が空であることを
  復元後に確認した（意図しない変更が残っていないこと）。全体の再実行
  （`pnpm --filter @mnemora/testkit exec vitest run`・
  `DATABASE_URL=... pnpm --filter @mnemora/postgres exec vitest run
  src/__tests__/conformance.postgres.test.ts`）でも、復元後は緑のままだった。

- **引き受けた負債**:

  1. **A2・A8・A10〜A15・コメント1・2 は、この PR では判断していない。** 足すかどうかは
     Issue #1238 のとおり未決のまま——マネージャーか、さらに上位の判断を要する。
  2. **A3 の「区切り文字」の歯は `:`・`::` の2種類だけを対象にしている。** 他の区切り文字
     （例えばラベル名や tenantId に `|`・改行を含む場合）は検査していない。

- **これが覆るとしたら**:

  - A2・A8・A10〜A15 のどれかについて、「共通の入力」や「adapter 間で揃えられる形」が
    見つかったとき ⟹ 改めて Issue を切り、同じ形で conformance suite に足す判断が
    要る。

- **確かめていないこと**:

  - `@mnemora/openai`・`@mnemora/anthropic`・`@mnemora/local-embedding`・
    `@mnemora/bullmq` など、`MemoryStore`/`VectorStore`/`EventStore` を実装しない
    パッケージへの影響（そもそも対象外のはずだが、公開 API snapshot の差分無し
    （`pnpm run api:check`）以上の確認はしていない）。
  - 本番相当の規模・並行度での A4 の歯の振る舞い（in-memory fixture は同期的に
    実行されるため、真の並行（複数プロセス・複数接続）での再現は Postgres 側の
    テストでしか測れていない——今回の変異試験は in-memory 側だけで行った）。
