# ADR 0461: 穴探し34巡目 — v1.2.0 を出すための準備の点検（更新経路の fixture・CHANGELOG・migration の順序・migration-v1 の 🔴）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。点検の線はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**リリースそのもの（tag・GitHub Release・npm publish・`package.json` の version・CHANGELOG の見出しを日付付きにすること）はオーナーの手であり、この ADR は触れていない。**
出所の区別: 【現物】は読んだコード・文書、【実測】は手元の Postgres 17 などで走らせた結果、【判断】は担い手の判定。

- **文脈**: v1.1.0（`5eb6e9d`）から main までの 116 コミット（この点検の時点の `origin/main` = `86e21bb3`）を、v1.2.0 を出す前に横から点検した。

- **点検の結果**:

  1. **更新経路の fixture（ADR 0344 決定5、`docs/release-v1.md` §5.6）: ずれなし。**
     - `upgrade-from-released.postgres.test.ts` は `__fixtures__/upgrade-from-*.sql` を `readdirSync` で全部拾う【現物】。`upgrade-from-v1.1.0.sql` も拾われ、v1.1.0 の DB（台帳）から今の migration まで上げる歯が 10 本ある。
     - **fixture は v1.1.0 の状態で作られている**【実測】: 台帳（`_mnemora_migrations`）の 25 行が、`git ls-tree v1.1.0 -- packages/postgres/migrations` のファイル名 25 本と、名前も数も完全に一致する（0025 まで）。ファイルの先頭にも、作ったコードが v1.1.0 の `5eb6e9d` と書かれている。
     - **名指しで走らせた**【実測】: `upgrade-from-released.postgres.test.ts` は 42 本とも緑（v1.0.0・v1.0.1・v1.0.2・v1.1.0 の4 fixture ×10 本＋在り処の2本）。v1.1.0 だけでも緑。1回目の `runMigrations` が当てたのは台帳に無い 0026〜0032 だけ（歯が `applied[0]` を fixture の台帳から引いた `pendingBefore` と突き合わせる）、2回目は何も当てない。
     - **陽性対照**【実測】: `0030_recalls_digest_band_index.sql` の末尾に壊れた SQL を足すと、v1.1.0 の歯が `migration 0030_recalls_digest_band_index.sql failed: syntax error` で赤になった（`git checkout --` で戻した）。0026〜0032 がこの経路で実際に当たっている。
     - ⚠ 手元の Postgres で、最初の v1.0.0 の `describe` の `afterAll` が 30 秒で時間切れになった（`DROP DATABASE` が checkpoint 待ち。pg_stat_activity の `CheckpointDone`）。ADR 0414 が測ったうえで直さないと決めた形で、手元の遅いディスクの fsync による。`fsync=off` で立てた自分専用のインスタンスでは 42 本とも緑・ファイルも緑になった。main の CI では起きていない。
     - **v1.2.0 用の fixture は、出した後に足す**（この PR では足さない）。**v1.2.0 を出したら、`docs/release-v1.md` §5.6 の手順で `upgrade-from-v1.2.0.sql` を足すこと**——足さないと、次の版（v1.2.0 → 次）の更新経路が縛られない。
  2. **CHANGELOG `[1.2.0] - 未リリース`: コードを変えた PR の漏れなし。変更は 1 点だけ（下の決定2）。**
     - `git log v1.1.0..origin/main` の 116 本を、PR 番号・追加された ADR の番号・タイトルの語で `CHANGELOG.md` と突き合わせた【実測。`.mgr-notes/r34-commits.txt`】。直接ヒットしなかった 51 本は、次のとおり（理由つき）。
       - **載っている（Issue 番号・語で載っていた）**: #1460（#1370）・#1467（#1449）・#1483（z.record）・#1491（zod の peer・`StoredRelation`・bullmq の `'failed'`）・#1510（`Queue` 側の error）・#1512・#1514（判定関数）・#1517（R3・P2〜P6）・#1525（hunt-n）。
       - **載せない（docs だけ、または出荷されない面。節の「何を載せるか」の規則）**: docs/ADR/TSDoc だけの #1441・#1445・#1446・#1450・#1466・#1476・#1478・#1480・#1488・#1494・#1500・#1503・#1505・#1506・#1515・#1522・#1524・#1528・#1533・#1536・#1539・#1541・#1551・#1557・#1559・#1560・#1563・#1566。
         テストだけの #1453・#1485・#1486・#1489・#1501・#1508・#1547・#1472（test:db の設定）。スクリプト・CI だけの #1447・#1454・#1456。`examples/chat`（private で出荷されない）の #1451・#1513。コメント・テストだけの #1448。
     - 漏れは無かった。**陽性対照**: 検索の語を変えると未ヒットが出る（#1510 は最初「N」と出たが、`Queue` の語で載っていると確かめた）。
  3. **migration の順序: ずれなし。**
     - `git diff --name-status v1.1.0 origin/main -- packages/postgres/migrations` は 0026〜0032 の追加（`A`）7 本だけで、変更・削除は 0 件。0001〜0025 は v1.1.0 の tag のファイルと **sha256 が 25 本とも一致**した【実測】。
     - 番号は 0001〜0032 で飛びも重複も無い。**空の DB から**: `runMigrations` が 32 本を番号順に当て、台帳の並びがファイルの並びと一致、2回目は 0 本【実測。`.mgr-notes/r34-empty.mts`】。**v1.1.0 の fixture から**: 上の 1 のとおり 0026〜0032 を当てる。
     - checksum の仕組みは無い【現物】: 台帳は `name` と `applied_at` の 2 列だけで、適用済みはファイル名だけで判定する（ADR 0448 の B1 が既に記録している）。そのため「0001〜0025 が編集されていない」ことは、台帳ではなく git の diff と sha256 で確かめた。
  4. **migration-v1 の 🔴（v1.1.0 → 次の版）: 1 件の足りない項目を見つけた。**
     - 項目 29〜51 の記述を現物と照らした【実測。`.mgr-notes/r34-items.mjs`】: バッククォートの識別子（型・メソッド・例外・フラグ）が現在の `packages/*/src`・migration・公開 API の snapshot に在ること、引いた ADR 番号が実在すること、「PR #N」が main のコミットに在ること、`decisions/` へのリンク先が実在することを全項目で確かめた。見つからなかった識別子は `RowExclusiveLock`（Postgres の用語）と `supportsXxx`（項目51 の書き方の記号）だけ。陽性対照: この2つが出ている（走査が空振りしていない）。
     - 公開 API の snapshot の v1.1.0 からの差分を調べた【実測】: 削除・必須化・型の狭小化は無い。増えたものは、`?: T | undefined` への入力型の広がり（CHANGELOG の `### Changed` に在る）、union への値の追加（破壊的と数えない規律）、`eraseTenant` と `RelationStore`（項目29・31）、`MalformedIdentifierError`（項目41）、`LocalEmbeddingProvider.dispose()`（クラスのメソッドの追加。interface 側は任意）、`isOpenAILLMProviderError`・`isAnthropicLLMProviderError` 等の追加で、いずれも既に載っているか、破壊的ではない。CHANGELOG の `### Breaking` の箇条が指す項目番号も、全部実在する。
     - **足りなかったもの**: ADR 0456 の H4（`NewMemoryEvent.memoryId` が別テナントの記憶のとき、`@mnemora/postgres` の `MemoryStore` の書き込み口が断る。PR #1562）は、本物の adapter が以前は通っていた入力を新しく断る変更で、項目34・49・51 と同じ形である。CHANGELOG は `### Fixed` に「破壊的か: 新しく断る」と書いたが、この文書の一覧には無く、ADR 0459（PR #1566）はこれを 🟡 に置いていた。
       この文書の 🟡 の節自身が「落ちる入力が増える変更は🔴に載せる」と書いており、食い違っていた。

- **決めたこと**:

  1. **H4 を 🔴 の項目 52 として足し、🟡 の箇条は 🔴 への指し先に置き換える**（【判断】項目34・49・51 の「本物の adapter が新しく断る変更は 🔴」に揃えた。conformance suite は変えていないので、適合テストが厳しくなる側面は無い）。CHANGELOG の該当の箇条に、項目52 への指し先を足した。
     覆せる点: H4 を 🟡 に戻す（本物の adapter の新しい断りも、利用者が気づくだけで足りるとする）。その場合は項目52 を削り、🟡 の箇条を戻す。
  2. **testkit の新しい例外（#1565、ADR 0452）を 🔴 ではなく 🟡 に置いたのは、オーナーの回答 ask_human `3f3411c5`（「公開の fixture が新しく例外を投げる変更は破壊的と数えない」）の延長として読んだ【判断】であり、覆す余地がある。**回答が直接名指したのは `@mnemora/testkit/fixtures` の InMemory 一式で、`DeterministicEmbeddingProvider`・`CassetteRecorder`・`assertCassette` などの provider の fake・カセットまで含むかは、オーナーに確かめていない。
     含まないと読むなら、これらは 🔴（`@mnemora/testkit` の公開の部品が、以前は通っていた入力を新しく断る）に数え直す。同じ1文を、`docs/migration-v1.md` の 🟡 の testkit の項目にも足した。
  3. **v1.2.0 の upgrade fixture は、この PR では足さない。**出した後に、`docs/release-v1.md` §5.6 の手順で足す（上の 1）。
  4. **リリースの手は触らない。**tag・GitHub Release・npm publish・version・CHANGELOG の見出し・`[1.2.0]` の「未リリース」は、オーナーの手である。

- **検討した代替案**:

  1. **H4 を 🟡 のままにして、項目52 を足さない。** 採らなかった。🟡 の節の冒頭と、項目34・49・51 の分け方と食い違う。
  2. **v1.2.0 の fixture を今足す。** 採らなかった。fixture は出した版の tag の作業木で作る（ADR 0344）。出す前の main で作ると、「公開済みの版で作った DB」にならない。
  3. **checksum の仕組みを足す。** 採らなかった。リリース済みの migration の不変は git の diff で足りる点検であり、仕組みを足すのは別の判断（ADR 0448 の B1 は材料に回してある）。

- **引き受けた負債**:

  - 0001〜0025 の不変を機械で縛る歯は無い（git の diff と sha256 での手の点検）。リリースのたびに同じ点検が要る。
  - CHANGELOG の突き合わせは、PR 番号・ADR 番号・語での照合で、全 PR の diff を1本ずつ読んではいない（載せないと判断した docs だけの PR は、タイトルと変更ファイルで判定した）。
  - 項目 29〜51 の照合は、識別子・ADR・PR・リンクの実在と、公開 API の snapshot の差分までで、記述の意味（誰が影響を受けるか、どう直すか）を各項目について実装と再突き合わせてはいない。
  - 手元の Postgres で upgrade の歯の `afterAll` が時間切れになる件は、環境の遅さ（ADR 0414）であり、直していない。

- **これが覆るとしたら**: 上の決めたこと 1・2 に書いた。

- **測っていないこと**: v1.1.0 より前の版（v1.0.x）の fixture からの経路は、既存の歯が通ることだけを確かめた（中身は読んでいない）。実際の npm publish 後の確認（`docs/release-v1.md` §5）。
