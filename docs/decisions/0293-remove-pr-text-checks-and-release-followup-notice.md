# ADR 0293: PR タイトル/本文を見る CI ステップ3本と、リリース後の追随通知ワークフローを削除する

- **状態**: 採用 (2026-09-24)
- **日付**: 2026-09-24

> **⚠ 出所**: この削除は、Claude Code のセッションで利用者から受けた指示
> （「PR のコメントをチェックするとか、テストやビルド以外の無駄なワークフローを消してほしい」）
> と、その場で提示した選択肢への回答（下の「決定」の2項目を選択）に基づく。
> 利用者がオーナー本人であることを、この ADR の書き手は repo 上では確かめられない
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

## 文脈

`.github/workflows/` には `ci.yml` / `publish.yml` / `release-followup-notice.yml` の3本があった。
テスト・ビルドではなく **PR の文面（タイトル・本文）を見る処理**は、独立したワークフローではなく
`ci.yml` のステップとして入っていた:

1. `build` ジョブ: PR タイトル/本文が、このブランチが名乗って捨てた ADR 番号を名指ししていないか
   （`scripts/check-pr-adr-reference.mjs`、[ADR 0211](./0211-check-pr-adr-reference-catches-abandoned-numbers-in-title-and-body.md)）
2. `build` ジョブ: CHANGELOG 載せ漏れの候補を Job Summary に出す
   （`scripts/changelog-candidates-summary.mjs`、[ADR 0214](./0214-release-candidates-lists-not-judges.md) 追記）
3. `example-chat` ジョブ: compare の omitted stage 集合が動いたら PR 本文に申告を要求する
   （`scripts/check-compare-omitted-stage-declaration.mjs`、Issue #403）

`release-followup-notice.yml` は、Release の publish 時に CHANGELOG の節の有無を通知するだけの
非門ワークフローだった（[ADR 0251](./0251-release-follow-up-notice-not-a-gate.md)）。

## 決定

1. **上の3ステップを `ci.yml` から削除する。**呼んでいた script・lib・それぞれのテスト・配線テストも削除する。
   ジョブ名（required status check の文脈名）は変えない（[ADR 0274](./0274-required-check-context-name-is-frozen-annotate-dont-rename.md)）。
2. **`release-followup-notice.yml` を削除する。**`check-release-changelog-section.mjs` と
   `release-changelog-section-lib.mjs`・そのテストも削除する（同 script 自身の doc が
   「外すときも、この道具とワークフロー1本を消すだけである」と書いていた通り）。
3. `check-pr-adr-reference.mjs` と `SCOPE_CAVEAT_MARKER` を逐語で揃えていた歯
   （`gate-scope-caveat-marker.test.mjs`）は、相手が無くなったので削除する。
4. `adr-renumber` の警告文は「CI が本文を検査する」と名乗っていたので、
   「CI では検査していない。目で確かめること」に改める。

## 採らなかった案

- **計測だけのジョブ（`retrieval-quality` / `identifier-probes` ほか）も消す。**
  選択肢として提示したが、選ばれなかった。
- **`publish.yml` も消す。**リリースに使っているため提示時に残すことを勧め、選ばれなかった。
- **script を残して配線だけ外す。**呼ばれない道具と「CI で検査する」と名乗る文書が残り、
  嘘をつく状態になるため採らない。

## 引き受けた負債

- **PR 本文に古い ADR 番号が残っても、機械は気づかない。**ADR 0211 が塞いだ穴（PR #436 の実例）が
  再び開く。`adr-renumber.mjs` の警告と人の目だけが残る。
- **compare の omitted stage 集合が動いても、PR に申告は要求されない。**
  ⭐門（`compare-summary.mjs`）はそのまま残るが、stage 集合の変化は門に入っていない。
- **Release 後の CHANGELOG 節の有無は、`docs/release-v1.md` §5.5 を人が通すことだけが頼りになる。**
  ただし通知は過去3回とも読まれなかった（ADR 0252 決定4 / ADR 0267 決定5）。

## これが覆るとしたら

PR 本文の古い ADR 番号や CHANGELOG の節の欠落が `main` に再び着地し、
それを人手で防げないことが分かったとき。削除した script は git の履歴から戻せる。
