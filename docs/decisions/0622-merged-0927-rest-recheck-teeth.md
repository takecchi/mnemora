# ADR 0622: 09/27 にマージされた #1087・#1086・#1143・#1116 の確かめ直しで見つかった穴に歯を足す（restoreSuperseded の束ねた強化の対象・時刻・設定・戻り値・例外の文面の起きたこと／直し方・claimKey の述語の等値の索引・migrate CLI の `--` の例ほか）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-06

クローンのマネージャー（mgr-0495eb46）の依頼で担い手が書いた。歯を書くと決めたのも、範囲を決めたのもクローンの判断で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手（またはマネージャー）の判定。
これは試験だけの変更で、実装・CHANGELOG・適合テスト（`*-conformance.ts`）は触らない。
Issue #1724 の残り4本（#1087・#1086・#1143・#1116）である。#1724 の先の歯は ADR 0614（#1727）・ADR 0620（#1738）にある。

## 経緯

2026-09-27（UTC）にマージされた PR のうち、#1724 の残り4本を、約束ごとに足りない側とやりすぎ側の変異を入れて確かめ直し、どの歯にも捕まらない変異を拾った【実測】。結果は Issue #1724 に PR ごとにコメントとして残してある。

- 変異は、#1087 は `packages/core/src/runtime.ts` の `restoreSuperseded`、#1143 は例外を投げる5ファイル（core の `memory-store.ts`・openai と anthropic の `errors.ts`・postgres の `embedding-space-table.ts` と `vector-space.ts`）、#1086 は `packages/postgres/src/memory-store.ts`、#1116 は `packages/postgres/src/bin/cli-options.ts`（と、エラー文を出す口として `migrate.ts` に1つ）に当てた。
- 変異ごとに退避から戻して `cmp` で一致を確かめ、緑に戻ることを見た。
- testkit の fixture・core の Fake には変異を当てていない（#1725 の受け持ち）。

約束の出所は、各 PR 本文・実装の TSDoc とコメント・ADR である【現物】。後の ADR で約束が変わっていないかは、関数名・文面を `docs/decisions` から `grep` して該当箇所を読んだ。すべての後続 ADR を通読したわけではない【判断】。

## 決定【判断】

1. 実装は変えない。適合テストにも足さない。歯は `__tests__` に置く。
2. 歯を足す（試験だけ）。出所と置き場は次のとおり。実測では、穴の変異で赤になり、戻して緑に戻ることまで見た。

### #1087（`restoreSuperseded` の束ねた強化）

出所: PR 本文（「直し方」の `MemoryStore.reinforceMany?` の1回への束ね、「小さな違い」の時刻）と `runtime.ts` の実装コメント（強化の設定は1件ずつの経路と同じ。ADR 0165 決めたこと16）。この PR 専用の ADR は無い。束ねた経路では群の全件の強化時刻が同じ `clock.now()` の1回分であること、束ねた強化が失敗したら1件ずつへ戻ることは PR 本文の約束である。

- `packages/core/src/__tests__/restore-superseded-reinforce-many.test.ts`（6本足した）: 束ねる対象は戻した記憶だけ（群4件のうち1件を archived にし、`onlyMemoryIds` に戻る1件と archived の1件を渡す）。時刻は `clock.now()` そのもの。活動時計のテナントでは `nowSeq` が束ねた強化にも渡る。戻した記憶が0件なら束ねた強化も1件ずつの強化も呼ばない。outcome の `decayFloorAt` は束ねた強化が返した値。束ねた強化が成功したら1件ずつの `reinforce` は1回も呼ばない。

### #1143（例外の文面）

出所: PR 本文の E1（`MemoryStatusConflictError` は `MemoryStore:` と名乗り、期待した status・観測した status・記憶の id と直し方を書く）、E2（openai の `truncated` は設定の無い `max_tokens` を勧めず入力を短くするよう書き、`finish_reason` を名乗る）、E3（anthropic の `truncated` は `stop_reason` ごとに直し方を分け、`stop_reason` を名乗る）、E6（`registerEmbeddingSpace` の次元の拒否は渡された値・正の整数が要ること・テーブルを作っていないことを書く）、E7（`assertSafeIdentifier` の拒否は識別子と使える形を書く）、「秘密」（本文・鍵を載せない）。

- `packages/core/src/__tests__/memory-status-conflict-error-message.test.ts`（新規、5本）: 起きたこと・直し方・どの口から投げても `updateStatus` と名乗らない・記憶が消えたときの `(memory disappeared)`。
- `packages/openai/src/__tests__/truncated-message.test.ts`（新規、4本）と `packages/anthropic/src/__tests__/truncated-message.test.ts`（新規、6本）: 起きたこと（`finish_reason`・`stop_reason` の名乗り）と直し方（anthropic は2つの `stop_reason` を分ける）。
- `packages/postgres/src/__tests__/identifier-and-dimensions-messages.test.ts`（新規、12本）: 正の整数でない数（0・負・小数）で渡された値を名乗ること、数でない値で「テーブルは作成していない」を書くこと。`assertSafeIdentifier` を直接見る歯（E7 系は既存の歯でも噛んでいたが、直接見る歯が無かった）。
- 足した歯は、provider が実際に投げる例外の文面に、プロンプトと応答の本文が入らないことも見ている（赤になる変異は無し）。

### #1086（claimKey の find 系 SQL の索引）

出所: PR 本文（`subject_id IS NOT DISTINCT FROM $n` を `subject_id = $n` / `subject_id IS NULL` に分け、計画の Index Cond が4列）と `findActiveByClaimKey` の TSDoc（4列の等値比較で絞り込み）。置き場: `packages/postgres/src/__tests__/claim-key-index.postgres.test.ts`（`it.each` 4件）。`findActiveByClaimKey`・`findContestedByClaimKey` × subjectId が文字列・null で、Index Cond / Recheck Cond の行に `claim_key_predicate = 'p3'`（等値）が入ること。`idx_memories_claim_key` を選んでも `idx_memories_claim_predicates` を選んでも述語の等値は Index Cond に入るので、プランナがどちらを選んでも通る。

### #1116（migrate CLI の `--`）

出所: PR 本文（`--` は未知のオプションのまま exit 1。2行目に `--` を付けない書き方の例。ほかの未知のオプションのエラー文は1行のまま。実際の CLI でも2行が出る）。

- `packages/postgres/src/__tests__/cli-options.test.ts`: 複数の引数が空白区切りで並ぶこと。例のコマンドの前半（`pnpm --filter @mnemora/postgres run migrate ...`）。`--` 単体のとき余る空白が無いこと。`=` 付きの未知のオプション（`--analyze-memories=true`・`--no-such-flag=1`）と `-x` が `unknown option: <arg>` と完全に一致すること。
- `packages/postgres/src/__tests__/migrate-cli-process.test.ts`: 実プロセスで `--` と `--analyze-memories` を渡し、終了コード1・1行目が `unknown option: --`・2行目が `run migrate --analyze-memories` を含み `migrate -- --` を含まないこと。PR 本文の「実際の CLI でも確かめた」は手での確認だけで歯が無かった。

3. ほかの ADR には追記しない。

## 実測【実測】

PostgreSQL 上（#1143 は自分専用の Postgres 17）で、対象ファイルを退避し、変異を1つずつ入れ、名指しのファイルを走らせ、戻して緑に戻ることまで見た。数は各コメントの見出しのとおり（等価を含む）。

| PR    | 走らせた変異 | すり抜けた                                           | 足した歯                                                                                         |
| ----- | ------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| #1087 | 8            | 5（M1・M2・M3・M4・M6）                              | 6本（core 1ファイル）。M5 は core の歯を素通りしたため、1件ずつの reinforce を呼ばない歯も足した |
| #1143 | 22           | 12（C1・C2・C3・C4・O1・O2・O3・A1・A2・A3・V2・V3） | 4ファイル（core 5本・openai 4本・anthropic 6本・postgres 12本）                                  |
| #1086 | 14           | 1（M13。M14 の文字列側も既存の歯は片側だけ）         | 4件（`it.each`）                                                                                 |
| #1116 | 10           | 6（B1・B2・B5・B6・B7・B10）                         | 2ファイル。B2 の歯は外した（下記）。B1・B5・B6・B7・B10 の5つを塞いだ                            |

M12（#1086）と M5（#1087）は上の「すり抜けた」には数えていない。M5 は postgres の往復数の歯で噛んだ。M11（#1086）は等価で、数に含めて外した。

## 外したもの【判断】

等価で歯にしなかったもの:

- #1086 M11: null の枝を `subject_id IS NOT DISTINCT FROM NULL` にする変異。Postgres が定数 NULL との比較を `subject_id IS NULL` に書き換える（`EXPLAIN` で確かめた）ので、結果も計画も変わらない。
- #1087: 束ねた強化が途中まで書いて失敗したあとの1件ずつのやり直し。強化は減衰の起点を巻き戻さない（ADR 0048）ので、観測できる差が無い。
- #1087: 1件ずつへ戻る経路の時刻。テストの clock は固定で、何回読んでも値が同じなので区別できない。

約束がまだ決まっていないので歯にしなかったもの:

- #1116 B2: 例に `--` より前の引数（`--schema app -- --analyze-memories` の `--schema app`）を含めるか。PR 本文は「残りの引数」の範囲を決めていない。いったん歯を足したが、実装の挙動を固定するだけになるので外した（コミット 48a7c008）。B2 はすり抜けたまま残る。
- #1116 B11: `--help` との優先順位。#887 の約束で、この PR の外なので当てていない。

約束が逆転したので当てなかったもの:

- #1143: PR 本文の「例外の種類は変えない」は、`registerEmbeddingSpace` の次元の拒否については ADR 0525 が逆にした（数でなければ `TypeError`、数として不正なら `RangeError`）。種類の約束には当てていない（足した歯の種類の検査は ADR 0525 の既存の歯と重なるだけ）。文面の約束は残っていて、当てた。

そのほか当てなかったもの:

- #1143 の「本文を丸ごと載せない」のやりすぎ側（本文や鍵を足す変異）: この5ファイルは本文を受け取らない組み立てで、変異を作れず当てていない。載せていた testkit の `Recorded*Provider` には当てていない（#1725 の受け持ち）。
- #1143 の上限超（hnsw 2000 次元）の文面（ADR 0018 の文面で PR の外）、`schema_unsupported`・`refusal`・`no_content` の文面（変えていない）、`RegisterEmbeddingSpaceLockTimeoutError` など同じファイルのほかの例外（PR の外）。
- #1086 の `claim_key_subject` の比較だけを索引で引けない形にする変異（matcher が一致せず、歯が「SQL を捕まえられない」で赤になるだけで、約束への噛み方を測れない）、データの規模・件数を変える変異（ADR 0329 の追記が測っている）、`subject_id = $n` の型キャスト違い（等価と見て、実行していない）。
- #1087 の `dryRun` の枝と、`reinforceMany` を持たない adapter の経路: この PR が触っていない。
- #1116 の `examples/chat/README.md` と CHANGELOG の文言: README を読む歯は別の歯が受け持つ。
- testkit の fixture・core の Fake には変異を当てていない（#1725 の受け持ち）。

## 約束の変わり方【判断】

どの約束がどの ADR でどう変わったか（1件1行）。

- #1143: `registerEmbeddingSpace` の次元の拒否の例外の種類は、PR 本文の「変えない」を ADR 0525 が逆にした（数でなければ `TypeError`、数として不正なら `RangeError`）。文面は変えていない（ADR 0525 決定2）。種類は当てず、文面は当てた。
- #1143: `assertSafeIdentifier`（と `assertSafeSchemaName`）は ADR 0525 の「対象外にしたもの」で、素の `Error` のまま。約束は変わっていない。
- #1086: ADR 0329 の 2026-09-30 の追記（`idx_memories_claim_predicates`、migration 0029）で、約束は「`idx_memories_claim_key` を `subject_id` まで使う」から「どちらの索引でも `subject_id` まで使う」に広がった。`claim-key-index.postgres.test.ts` の期待は「どちらかの索引」に緩んでいて、広がった側で当てた。
- #1086: ADR 0630 が、片方だけの claim key を書き込みの口で拒むようにした。PR 本文の「片方だけ非 NULL の行は以前は拾い、今は拾わない」は読み側の約束として残っている（適合テストの該当節が、読み側は Postgres の歯が縛ると書いている）。
- #1087: 約束を変えた ADR・PR は見つからなかった（PR 専用の ADR も無い）。
- #1116: 約束を変えた ADR・PR は見つからなかった（ADR 0093・0143・0178・0126 は `cli-options` に触れるだけで、`--` の扱いには触れていない。本文は全部は読んでいない）。

## 直しが要りそうなもの（実装は変えていない）【判断】

無し。4本とも、変異を当てたファイルは退避と `cmp` で一致し、実装を直す必要のあるものは見つからなかった。

## 縛っていないもの

- #1086 M12: `listActiveClaimPredicates` の `claim_key_subject IS NOT NULL` を `claim_key_subject = 'user'` に絞る変異は、`claim-predicates-index` の EXPLAIN の歯（Index Only Scan でなくなる）が偶然噛んだだけで、結果を見る歯は緑のまま。`claim_key_subject` が `user` 以外の行を使う歯が無く、「値を問わない」ことを直接縛る歯は無い。EXPLAIN の側が見張っているので足していない。
- #1086: 時間・件数・データの分布を変える変異（上記）。
- #1087: 1件ずつへ戻る経路の時刻（上記。等価）。
- #1116 B2: `--` より前の引数を例に含めるか（約束が決まっていない）。
- #1143: testkit の `Recorded*Provider` の文面。
- #1087 の M5 は core の歯では通り、postgres の往復数の歯（`restore-superseded-roundtrip-count.postgres.test.ts`）だけが噛んだ。
- 全テストは走らせていない。名指しのファイルだけである。DB の要る試験は、この仕上げの段では走らせていない。

## これが覆るとしたら

`restoreSuperseded` が戻した記憶だけを `clock.now()` の1回分で束ねて強化し、失敗したら1件ずつへ戻ること、例外の文面が起きたこと・直し方を書き本文を載せないこと、claimKey の find 系が述語の等値まで索引で引くこと、migrate CLI が `--` を未知のオプションとして弾き `--` 無しの例を添えることが変わるとき。ADR 0525 の例外の型の扱いが変わるときは、#1143 の「約束の変わり方」の読み替えをやり直す。
