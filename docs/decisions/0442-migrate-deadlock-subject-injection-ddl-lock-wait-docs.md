# ADR 0442: migration `0027` の deadlock・LLM が返す `subjectId` の注入・DDL のロック待ちを、文書に書く

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（マネージャー mgr-0629e6a2）が書いた。直し方（文書だけにすること）はクローン miku が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

- **文脈**:

  穴探し17巡目で、手元の PostgreSQL 17 に負荷を掛けて走らせ、次の3つを確かめた。どれも、今の文書には書かれていなかった。

  1. **migration `0027_erase_tenant_fk_indexes.sql` が、動いているアプリの `observe()` と deadlock する。**`0027` は1つのトランザクションの中で
     `memory_events`・`recall_usages`・`memory_labels`・`memories` などに `CREATE INDEX` を続けて撃ち、それぞれの表の `ShareLock` をコミットまで持つ。
     `observe()` のトランザクションは `memories` に書いて `RowExclusiveLock` を持ったまま `memory_events` へ書く。2つが互い違いに表を取り合う。
     memories 10万件・recalls 3万件の DB で、observe・recall・tick を4本のループで回しながら `0025`・`0027`〜`0032` を当てると、5回のうち4回で deadlock になった。
     migrate が犠牲になった2回は `migration 0027_erase_tenant_fk_indexes.sql failed: deadlock detected` で失敗し、ロールバックされ、再実行で当たった。
     アプリが犠牲になった計4件は `observe()` が `40P01` で落ち、observation は残り、memory は作られず、extract のジョブは claim されたまま残った
     （リースが切れた後に `tick` が拾い直す。同期抽出が途中で失敗したときと同じ扱い）。
     `docs/migration-v1.md` の `0027` の項目と [ADR 0383](./0383-erase-tenant.md) は「索引を作るあいだ、書き込みが止まる」とだけ書いていた。
     README の「複数プロセスが同時に実行しても安全」は、migrate どうしの話である。
  2. **`subjectCandidates` を渡さない抽出では、LLM が返す `subjectId` をそのまま受ける。**`sanitizeCandidateSubjectId`（`packages/core/src/extraction.ts`）は、
     一覧が渡されていなければ「検証しようがないので常に有効」とし、候補の `subjectId` は observation の `subjectId` より優先される（ADR 0271）。
     `extract: 'deferred'` の `tick` と `reextract` は一覧を持てないので、常にこの経路を通る。擬似の LLM に `subjectId: "victim-subject"` を返させると、
     `subjectId: "alice"` で observe した記憶が `victim-subject` に書かれた。`claimKey: { enabled: true, detectContested: true }` を付け、別の subject の既存の記憶と
     同じ claim key を返させると、その記憶が `contested` に変わった（`@mnemora/postgres` と testkit のインメモリの両方）。テナントの境界は越えない。
     このことはコードのコメントにしか書かれていなかった。
  3. **DDL がロックを待っている間は、その後ろに並んだアプリの操作も止まる。**8秒続くアプリのトランザクションが `memories` に書いている裏で
     `CREATE INDEX` を当てると、後から来た `observe()` の書き込みが約8秒止まった（索引の構築そのものは約0.15秒。読み取りは止まらなかった）。
     `ALTER TABLE … ADD COLUMN` では `recall()` も止まった。接続側で `lock_timeout=3s` を渡すと、migrate が3秒で失敗し、アプリが止まるのも3秒で済んだ。
     `packages/postgres/README.md` は `lock_timeout` の渡し方を書いていたが、後ろに並んで止まることは書いていなかった。

- **決めたこと**:

  1. **1（`0027` の deadlock）は、文書だけを直した。**`docs/migration-v1.md` の `0027` の項目に追記を足し、`packages/postgres/README.md` に節を足し、
     ADR 0383 の末尾に追記を足した。書いた中身は次のとおり。
     - `0027` のように複数の表を1トランザクションで触る migration は、アプリの書き込みを止めてから当てる。
     - 止めずに当てると、`observe()` が `40P01` で落ちうる。そのとき observation は残り、extract のジョブはリースが切れた後に拾い直される。
       migrate が犠牲になったときはロールバックされ、再実行で当たる。
     - `0027` 以外の同じ形の migration（`0020`・`0032` など）は、測っていない。
  2. **2（`subjectId` の注入）は、文書の警告だけにした。**`ExtractedMemoryCandidateSchema.subjectId` と `SubjectCandidatesInput` の TSDoc、
     `docs/architecture.md` の抽出の主題の節に書いた。一覧を渡さない経路（deferred の `tick`・`reextract` を含む）では LLM の `subjectId` をそのまま受けること、
     観察文の注入で同じテナントの別の subject の記憶が `contested` になりうること、信用できない本文なら `subjectCandidates` を渡して選ばせること。
  3. **3（DDL のロック待ち）は、`packages/postgres/README.md` の `lockTimeoutMs` の節に1項目足した。**後ろに並んだアプリの操作も止まること、
     接続側の `lock_timeout` が、アプリが止まる時間の上限にもなること。
  4. 文書だけの変更なので、CHANGELOG には載せていない（CHANGELOG の「何を載せるか」は docs のみの PR を載せない）。
     `docs/migration-v1.md` は、既存の `0027` の項目に追記を足しただけで、新しい項目は数えていない。

- **検討した代替案**:

  1. **`0027` を分割するか、先頭で決まった順に `LOCK TABLE` する。**採らなかった。適用済みの migration を編集しても、既に `0027` を当てた DB には効かない。
     編集するか次の番号で足すかは、リリースの方針に関わるので、オーナーへのまとめ問いに回した。
  2. **アプリ側で `40P01` を受けて再試行する。**今回はしなかった。
  3. **`subjectCandidates` が無いとき、observation や `ctx` の `subjectId` と違う値を捨てる。**採らなかった。Issue #608 の設計（候補ごとの主題の上書きを許す、ADR 0271）に
     触れるので、オーナーに回した。

- **引き受けた負債**:

  - `0027` の deadlock は、文書を読まずに稼働中のアプリへ当てた利用者には、今までどおり起こりうる。
  - `0020`・`0032` など、ほかの複数の表を触る migration が deadlock するかは測っていない。
  - `subjectId` の注入は、`subjectCandidates` を渡さない利用者には、今までどおり起こりうる。

- **これが覆るとしたら**:

  オーナーが `0027` の分割（または次の番号の migration での置き換え）や、`subjectId` の検証の変更を決めたら、この ADR の文書は、その変更に合わせて書き直すことになる。

- **測ったこと**:

  - 1〜3の実測は、穴探し17巡目（2026-10-01、PostgreSQL 17・ローカル）で行った。数字は上の「文脈」のとおり。
  - この変更自体は文書だけで、コードは変えていない。

## 追記（2026-10-06）: `subjectId` の注入への答えは、ADR 0635 で既定が逆になった

クローン（miku）の判断で残す訂正。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1734](https://github.com/takecchi/mnemora/issues/1734) の #1551 のコメント（確かめ直しの記録）。**本文は書き換えていない。**

- **ADR 0635 への指し先**: [ADR 0635](./0635-llm-subject-id-dropped-by-default-without-candidates.md)（オーナー回答 374f6f88 の問15）で、`subjectCandidates` を渡さない経路（`tick`・`reextract` を含む）では、runtime は LLM が返した `subjectId` を**既定で捨て**、observation の `subjectId` へ落とす形になった（`RuntimeConfig.acceptLlmSubjectIdWithoutCandidates`、既定 `false`）。この ADR の次の3か所は、その答えを待っていた記述で、今は古い。
  - **決定2**（「文書の警告だけにした」）: 警告だけで止める形は、既定の反転で置き換わった。警告は `acceptLlmSubjectIdWithoutCandidates: true`（opt-in）のときの話になった。
  - **検討した代替案3**（「違う値を捨てる。採らなかった。…オーナーに回した」）: 捨てる案が、オーナーの回答で既定になった。
  - **「引き受けた負債」の3つ目**と**「これが覆るとしたら」**（「`subjectId` の検証の変更を決めたら…」）: 変更は決まった。注入は、`true` にした利用者にだけ今も起こりうる。
- **「検証されない」の言い過ぎ**: 本文の「検証されない」は、ADR 0456（2026-10-01）以降は正確でない。NUL・孤立サロゲートを含む識別子は、一覧の有無に関わらず弾く（`sanitizeCandidateSubjectId`）。検証されないのは、一覧に照らす検証である。別の subject の名前を言わせられるという主旨は変わらない。
- **この追記で変えなかったもの**: この ADR のほかの決定（`0027` の deadlock の文書化、DDL のロック待ちの文書化）は、ADR 0635 の影響を受けていない。
