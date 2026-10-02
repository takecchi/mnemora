# ADR 0567: 文書とコードのずれを横に掃く（第10弾）— `scripts/` のコメント・`AGENTS.md`・`docs/autonomy.md` を、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

ADR 0561（#1673）の続き。0561 は文書4つを掃いた。今回は、道具（`scripts/*.mjs`）の冒頭の説明とコメント、それに手順やファイルの場所を指している `AGENTS.md` と `docs/autonomy.md` の記述を掃く。文書とコメントだけの PR で、コードの振る舞いは変えない。

**照合の基準は main `8521906f`。**

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

決まり（前回と同じ）: CHANGELOG の `[1.2.0]` 以前、採用済み ADR の本文、`scripts/__snapshots__/**`・`scripts/__fixtures__/**`、`packages/core/src/__tests__/**`、開いている PR が触るファイルは触らない。ずれがあれば記述を現物に合わせ、実装の側が約束を破っていそうなら直さずに材料として残す。`AGENTS.md` と `docs/autonomy.md` は、**規約そのもの（何をしてよいか・してはいけないか）を変えず**、指している先（ファイル名・節名・コマンド・数）が古くなっているところだけを直した。日付の付いた追記・訂正の本文は1字も変えていない。数（件数など）は写さず、在りかを指す。公開 TSDoc は直していないので、CHANGELOG は触っていない。

## 掃いたもの

- `scripts/*.mjs` の冒頭の説明とコメント。`scripts/__tests__/**` のコメントは、指しているファイル名・コマンド・ADR を機械的に突き合わせた（下の「照らした範囲」）。
- `AGENTS.md`（全文）
- `docs/autonomy.md`（全文）

開いている PR（#1644 #1654 #1655 #1657 #1658 #1660 #1661 #1662 #1663 #1664 #1675 #1676。#1671 は取り込み済み）が触るファイルを `gh pr view --json files` で集めた。`scripts/__snapshots__/public-api/*.d.ts` と `examples/chat/src/scripts/*.ts` が挙がったが、今回直したファイルとは1つも重ならなかった。【現物】

## 直したもの

`scripts/` のコメント:

- **`scripts/north-star-default-probe.mjs` の冒頭**: 「7項目の充足判定は `docs/roadmap.md` が正であり続ける」。roadmap の該当節（§7）は #762 で削除され、いまの在りかは `docs/north-star-paths.md`。「`docs/north-star-paths.md` が持つ（当初は roadmap §7 が正だったが #762 で削除した）」に直した。同じ文が `scripts/north-star-default-probe-lib.mjs` の冒頭と、その `buildSummaryMarkdown` が出す Job Summary の文面（件数を roadmap の唯一の出所に、と書いていた2文）にもあったので、同じく直した。出力の文面は変わるが、テストは固定していない。【現物・実測】
- **`scripts/ci-green-check-lib.mjs` と `scripts/__tests__/ci-green-check-lib.test.mjs`**: 「`adr-index-completeness-lib.mjs` と同じ分担」。そのファイルは ADR 0137 で索引を機械生成にしたとき消えている。生きている同じ分担の `generate-adr-index-lib.mjs` を指すようにした。
- **`scripts/__tests__/publish-gates.test.mjs`**: 「`scripts/root-test-gate.test.mjs`」は `scripts/__tests__/root-test-gate.test.mjs` が正しい。
- **`scripts/__tests__/ci-yml-local-embedding-cache-wiring.test.mjs`**: 「`identifier-probes-wiring.test.mjs`」は `ci-yml-identifier-probes-wiring.test.mjs` が正しい。
- **`scripts/apply-release-version.mjs`**: 「6つの `package.json`」。publish 対象は `PUBLISH_TARGETS` が唯一の定義で、`@mnemora/bullmq` が加わって数が合わなくなっていた。数を消し、`PUBLISH_TARGETS` を指すようにした（2か所）。
- **`scripts/check-cjs-transpile-parse.mjs`**: 同じく「現在は 6 パッケージの名前」を写していて、bullmq が抜けていた。名前も数も消し、`PUBLISH_TARGETS` を指すようにした。同じコメントが「ここに2つ目の固定リストを書けば、いずれ2つが食い違う」と書いており、その自分自身が2つ目のリストになっていた。
- **`scripts/check-required-status-checks-lib.mjs`**: 「私たちが思っている6本のままか」「この repo は常に6本の required check を持つことを前提にした門」。required の集合は `.github/required-status-checks.json` が持つので、数を消した。
- **`scripts/public-api-breaking-diff.mjs`**: snapshot の一覧に 6 パッケージの名前を写していて、`bullmq.d.ts` が抜けていた。`<パッケージ dir 名>.d.ts`（対象は `PUBLISH_TARGETS`）に直した。また `docs/migration-v1.md` を行番号（633〜638行・854〜889行）で指していた。いま該当の段落はそこに無い（行番号がずれた）ので、節と項目の名前で指すようにした。AGENTS.md が行番号で指さない作法を求めている。
- **`scripts/record-token-count-reference.mjs`**: 「`docs/autonomy.md:115`」（コメントと、エラーメッセージの文字列の2か所）。行番号がずれていた。`docs/autonomy.md` §3 の表を指すようにした。
- **`scripts/measure-cross-runner-embedding-fingerprint.mjs`**: 冒頭が「`--runner-label` / `--num-threads` / `--rep` を必須で受け取る。`--raw` の `numThreads` と食い違えば `note` に残す」と書いていた。現物の CLI は `--num-threads` を受け取らず（`numThreads` は `--raw` の値をそのまま転記する）、食い違いを `note` に残す処理も無い。ワークフローも `--num-threads` を渡していない。コメントを現物に合わせ、元の記述を「（2026-10-03 訂正）」で残した。【現物】
- **`scripts/archive-sweep-cost-summary.mjs`・`archive-sweep-cost-summary-lib.mjs`・`time-term-summary.mjs`・`recall-footprint-calibration-samples-summary.mjs`・`recall-footprint-calibration-samples-summary-lib.mjs`**: 「基準値ファイル（`archive-sweep-baseline.json` ほか）は無い／まだ存在しない」。3つとも `examples/chat/` にあり、`ci.yml` の各ジョブが `--baseline` に渡している。書いた当時の記述（「この PR では作らない」）は本文を変えず、直後に「（2026-10-03 訂正）」を足した。recall-footprint の2か所（見出しと検査関数の説明）は現在形の誤りなので書き換えた。門ではない、という主張は変わらない。【現物】
- **`scripts/conformance-hook-wiring-lib.mjs`**: 「registry の `dist-tags.latest` は `0.1.5`」。書いた当時の値で、版を写している。直後に「（2026-10-03 訂正）」を足し、`npm view` で引くことを指した。
- **`scripts/check-publish-pack.mjs`**: 「`NEVER_PUBLISHED_TARGETS` に載っているもの」の説明は、いまその集合が空であること（`publish-pack-checks.mjs` の doc が「いまは空」と書く）に触れていなかった。直後に「（2026-10-03 訂正）」を足した。
- **`scripts/generate-adr-index-lib.mjs`**: 索引の鮮度の歯を「`main` に限って検査する、PR を塞ぐ門ではない」と書いていた。ADR 0192 以降は CI の `pull_request` でも有効で、required status check の中で動く。ADR 0137 当時の設計である旨を、直後に「（2026-10-03 訂正）」で足した。

`AGENTS.md`:

- **「required status check（上の6件）」**: 「上の」が指す一覧は文中に無く、6 は数の写しだった。件数と名前は `.github/required-status-checks.json` の `contexts` が正、と指すようにした。規約（突き合わせは手で実行する、など）は変えていない。

`docs/autonomy.md`:

- **§4 の表「手元の `pnpm run test` が緑」の「DB 側は CI の3ジョブで見届ける」**: DB を要するジョブは `ci.yml` で増えており、3 は合わない。数を消し、`ci.yml` で `DATABASE_URL` を渡しているジョブ、と指すようにした。
- **§2.1 の項目8（2か所）**: 「ADR 0281〔仮番号。マージ時に確定〕」「ファイル名・番号は仮」。ADR 0281 は確定していて、リンク先も実在する。「仮」の注を、確定した旨に直した。

## 直さなかったもの

### (i) 実装を変えるべき食い違い

- **無かった。** 今回見つけたずれは、すべて記述の側が古かったものである。`measure-cross-runner-embedding-fingerprint.mjs` の `--num-threads` は、実装を足す（引数を受け取り、食い違いを `note` に残す）選択肢もあったが、`numThreads` は provider が実際に使った値が `--raw` に入っており、そちらが測定の事実に近い。コメントを現物に合わせた。実装を足す価値があるかは【判断】しない。

### (ii) `AGENTS.md`・`docs/autonomy.md` の規約の中身が実態と合っていないと思った点

- **見つからなかった。** 指している先のファイル・節・コマンド・スクリプトの引数・CI のジョブ名・ADR の実在は、機械的に確かめた範囲で現物と合っていた（下の「ずれなし」）。規約の中身の当否は、今回の範囲ではない。

### (iii) 他の PR と重なるため、または範囲の外にあるため触らなかったずれ

- **`.github/workflows/north-star-tarball-probe.yml`** の冒頭近くに「7項目の充足判定は `docs/roadmap.md` が正」が残っている（`scripts/north-star-default-probe.mjs` と同じ文）。`.github/` は今回の範囲の外なので触っていない。【現物】
- **`scripts/compare-summary-lib.mjs`** が出す Job Summary の文面（「他5本と異なり門である」）。名指しした5つのベンチを指す言い方で、今も事実と合うので直していない。ただし非ゲートのベンチは増えており、「他の」とは言えない。読み手の誤読は残る。
- **`scripts/postgres-auth-parity-lib.mjs`** の「`NON_MATRIX_POSTGRES_JOBS` に列挙した8ジョブ」。いまは配列の長さと合っている。数の写しではあるが、ずれてはいないので直していない。
- 開いている PR と重なって直せなかったものは、**無かった**。

## ずれなしと確かめたもの

- **`scripts/`** 全体から、`docs|scripts|packages|examples|.github` 配下のパスを機械的に抜き出し、実在を確かめた。実在しないものは、ビルド成果物（`dist/`）、テストの合成データ、すでに「削除済み」と書いて指している道具（`check-pr-adr-reference.mjs`・`check-release-changelog-section-gate.mjs`・`release-followup-notice.yml`）だった。【現物・機械的に確かめた】
- `pnpm run <名前>` / `pnpm --filter <パッケージ> run <名前>` は、ルートと各パッケージの `package.json` の `scripts` に在る。`ADR NNNN` は `docs/decisions/` にファイルが在る（例示として使っている 0999・9998・0189 を除く）。`ci.yml` のジョブ名（`build`・`postgres`・`example-chat`・`root-gate-db-stage`・`cjs-require-smoke` ほか）は実在する。【現物】
- `scripts/` の説明が名指しする CLI の引数（`ci-green-check.mjs` の `--pr`・`--sha`・`--repo`・`--base`・`--recheck-after`・`--json` と終了コード、`adr-renumber.mjs` の `--next`・`--check`）は、実装と合っている。【現物】
- **`AGENTS.md`・`docs/autonomy.md`**: markdown のリンク先、バッククォートで囲んだファイル名、`ADR NNNN` の実在。`initdb` の手順が使う `pnpm --filter @mnemora/postgres run migrate`・`test:db`、拡張3本（`vector`・`btree_gin`・`pgcrypto`）が `ci.yml` の `postgres` ジョブと同じであること、`conformance.postgres.test.ts` と `trigram-lexical-store.postgres.test.ts` の実在、`ProviderMode` の4値、専用カセットの実在。`docs/autonomy.md` の「6つの門」が `ci.yml` の `build` ジョブにそろっていること（`typecheck`・`lint`・`format:check`・`test`・`build`・`pack:check`）、`ci-green-check.mjs` が印字する `gh pr merge … --match-head-commit` の文面、ADR 索引の鮮度の歯の失敗メッセージ。【現物】
- 日付の付いた追記・訂正（`AGENTS.md`「いまの状態」の 2026-09-29 追記、`docs/autonomy.md` §2.1.1 の 2026-09-17 追記ほか）、`scripts/check-local-embedding-fingerprint.mjs` の 2026-09-24 追記、`scripts/lexical-regime-summary-lib.mjs` の 2026-09-12 訂正は、本文を変えていない。

## 照らした範囲

読んだもの: `scripts/*.mjs` の冒頭の説明とコメント（すべてのファイルの冒頭の説明の部分。長いファイルの本体の途中にあるコメントは、`grep` で拾った語――行番号・「6つ」などの数・「まだ無い」「この PR では」の類・参照先のファイル名――の周辺だけを読んだ）、`AGENTS.md` と `docs/autonomy.md` の全文、`.github/workflows/ci.yml` のジョブ名とステップ、`.github/required-status-checks.json`、`examples/chat/*-baseline.json`、`packages/*/package.json`、`scripts/__snapshots__/public-api/` のファイル名、`docs/migration-v1.md` の見出し。`scripts/__tests__/**` は、パス・pnpm のコマンド・ADR の番号の機械的な突き合わせだけをした（コメントを1本ずつは読んでいない）。

## 【未確認】

- 走らせたテスト: 触ったスクリプトに対応するテスト（`north-star-default-probe-lib`・`north-star-paths`・`archive-sweep-cost-summary(-lib)`・`time-term-summary(-lib)`・`recall-footprint-calibration-samples-summary(-lib)`・`ci-green-check(-lib)`・`publish-gates`・`ci-yml-local-embedding-cache-wiring`・`check-required-status-checks-lib`・`conformance-hook-wiring-lib`・`public-api-breaking-diff-lib`・`generate-adr-index-lib`・`apply-release-version`・`check-cjs-transpile-parse`・`check-publish-pack`・`adr-citation`・`doc-reference`・`agents-md-quote-attribution`・`adr-index-freshness`・`markdown-link` ほか）を名指しで実行し、通った。【実測】全テストは走らせていない。
- `scripts/__tests__/**` のコメントは、機械的に突き合わせた範囲（パス・コマンド・ADR 番号）しか見ていない。Issue の開閉や、散文で書かれた既定値の言い換えは見ていない。
- `scripts/` のコメントに現れる Issue の状態（「未実装」「open」など）は、1件ずつは確かめていない。
- 外部の実測を写した主張（CI の run の id、`PostgreSQL 16.15` で赤くなる挙動、各ベンチの標本数など）は再現していない。
- `AGENTS.md` の「`OPENAI_API_KEY` があれば本物に切り替わる」は、`examples/chat/src/providers.ts` の `selectProviderMode` を読んでいない。
- `docs/autonomy.md` §4.1 の表の各行の【実測】（`gh` の挙動）は再現していない。
- Postgres は立てていない。DB を要するテストは走らせていない。

## 引き受けた負債

- この ADR の結果は `main` の `8521906f` に対して測った記録で、`main` が進めば古くなる。
- 数（件数）をコメントに写している箇所は、ほかにも残っている（上の「直さなかったもの」(iii)）。ずれてから直す形のままで、写さない仕組みにはしていない。
- 日付の付いた追記・訂正の構造は直していない（0560・0561 と同じ負債）。

## これが覆るとしたら

- 探し方が拾わない種類（散文で既定値や挙動を言い換えた文、Issue の状態）の古さが、`scripts/` のコメントに残っていたとき。今回はパス・コマンド・ADR・ジョブ名・数・引数を軸に、冒頭の説明を読んで突き合わせた。
- 【未確認】に挙げた範囲で、記述と現物の食い違いが見つかったとき。
