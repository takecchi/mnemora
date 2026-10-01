# 移行ガイド（v0.1.9 → v0.2.0 → v0.3.0 → v0.4.0 → v0.5.0 → v1.0.0 → v1.0.1 → v1.0.2 → v1.1.0 → 次の版）

**この文書は、利用者が版を上げるときに何をどう直すかだけを扱う。**⭐ **5世代を持つ**（⚠ 2026-09-18 に2→3世代、2026-09-19 に3→4世代、**2026-09-21 に4→5世代**へ訂正した。下記）**:**

| 世代 | 破壊的変更 | どこ |
|---|---|---|
| **v0.1.9 → v0.2.0**（出荷済み） | **7件** | 「🔴 破壊的変更（v0.1.9 → v0.2.0）」の **1〜7** |
| **v0.2.0 → v0.3.0**（🔴 **出荷済み**） | **4件** | **8**・**9**・**10**・**11** |
| **v0.3.0 → v0.4.0**（🔴 **出荷済み**） | **6件** | **12**〜**17** |
| **v0.4.0 → v0.5.0**（🔴 **出荷済み**） | **1件** | **18** |
| **v0.5.0 → v1.0.0**（🔴 **出荷済み**） | **0件** | 無し（この世代には最後まで何も着地しなかった） |
| **v1.0.0 → v1.0.1**（🔴 **出荷済み**） | **0件**（計上を保留していたものは、破壊的と数えないと決まった。「数え方の規律への追記（2026-09-28）」） | 「🔴 破壊的変更（v1.0.0 → v1.0.1）」 |
| **v1.0.1 → v1.0.2**（🔴 **出荷済み**） | **0件**（計上を保留していたものは、破壊的と数えないと決まった。「数え方の規律への追記（2026-09-28）」） | 「🔴 破壊的変更（v1.0.1 → v1.0.2）」 |
| **v1.0.2 → v1.1.0**（🔴 **出荷済み**） | **12件**（確定。両端が tag で閉じている） | 「🔴 破壊的変更（v1.0.2 → v1.1.0）」 |
| **v1.1.0 → 次の版**（未リリース） | 件数はここに書かない（`main` が動けば変わる） | 「🔴 破壊的変更（v1.1.0 → 次の版）」 |

⭐ **全5世代の件数を書いてよいのは、両端が tag で閉じているからである。**`v0.1.9`→`v0.2.0` も
`v0.2.0`→`v0.3.0` も `v0.3.0`→`v0.4.0` も `v0.4.0`→`v0.5.0` も `v0.5.0`→`v1.0.0` も、
**`main` が動いても変わらない——この文書が表題に掲げた範囲は、これで閉じた。**

⭐ **【実測 2026-09-26】`v0.5.0` → `v1.0.0` の世代には、最後まで1件も着地しなかった。**
`v1.0.0` は **2026-09-22T23:54:08Z に published**（draft でも pre-release でもない。
`gh release view v1.0.0 --json isDraft,isPrerelease,publishedAt,targetCommitish` で確認）。
`git diff --stat v0.5.0..v1.0.0 -- packages/` も
`git diff --stat v0.5.0..v1.0.0 -- scripts/__snapshots__/public-api/` も**どちらも
差分を返さない。**⟹ **「いまのところ空」ではなく「空のまま出荷された」に確定した。**

🔴 **`v1.0.0` の tag はもう切られている。**⛔ **この文書は、それに追随していなかった**
——`CHANGELOG.md` は `## [1.0.0] - 2026-09-23` を既に持っている（追随済み）のに対し、
この文書は本節を含め随所で `v1.0.0` を「未リリース」のまま書き続けていた。
**2026-09-18・2026-09-19・2026-09-21（2回目まで）の「訂正の履歴」と同じ形が、
今回は文書の表題そのものが指す版で起きた**（経緯は下の「訂正の履歴」に畳む）。

⚠ **`v1.0.0` より後に着地した変更を、この文書はまだ数えていない。**そのうち3件
（`TenantSettingsStoreConformanceOptions.supportsTaxonomyMode`・
`MemoryStoreConformanceOptions.supportsLabels`/`supportsFindActiveByClaimKey`）は、
一時的に必須フィールドとして着地し v1.0.0 時点の呼び出しを壊していたが、
[Issue #818](https://github.com/takecchi/mnemora/issues/818) の結果、3つとも
`?: boolean`（省略時は該当する適合項目を実行しない）へ戻したため、**もう破壊的変更
ではない**——次の世代の節に計上する対象からは外れた（詳しくは **6** の末尾、
[ADR 0318](./decisions/0318-taxonomy-labels.md) / [ADR 0324](./decisions/0324-claim-key-contested-detection.md)
の追記）。**この3件以外に、`v1.0.0` より後に着地してまだ数えていない変更が残っている
かどうかは、別途棚卸しが要る**——次の世代の節はまだ起こさない。

**⚠ 2026-09-27 追記（クローン miku の委譲先。出自は各節に書いた）**: 冒頭の「5世代を持つ」と、直前の段落の「`v1.0.0` より後に着地した変更を、この文書はまだ数えていない」「次の世代の節はまだ起こさない」は、もう成り立たない。`v1.0.0` → `v1.0.1`（出荷済み）と `v1.0.1` → 次の版（未リリース）の2つの世代の節を、下の「🔴 破壊的変更（v0.5.0 → v1.0.0）」の後に起こした。どちらの世代にも、確定した破壊的変更は無い。ただし、公開の場所が不正な入力に新しく例外を投げる変更は、破壊的変更として扱うかがオーナーへの問いとして未決なので、計上を保留している。上の表にも2行を足した。

**⚠ 2026-09-28 追記（クローン miku の委譲先）**: 直前の段落の「計上を保留している」は、もう成り立たない。オーナーの回答（ask_human `3f3411c5`）で、公開の fixture が新しく例外を投げる変更は破壊的変更として扱わないと決まった。あわせて、union に値を足す変更も破壊的として数えないと決まった（ask_human `d9364c91`、[Issue #541](https://github.com/takecchi/mnemora/issues/541)）。どちらも下の「数え方の規律への追記（2026-09-28）」に書いた。

⚠ **これは [Issue #532](https://github.com/takecchi/mnemora/issues/532) が指した腐り方と同じ形である**
——数を正しく直しても、次の破壊的変更が着地した時点でまた同じ場所が腐りうる。
⟹ ⭐ **数えるなら、下の番号付きの一覧を数えること。**冒頭のこの表は一覧の**写し**であって、
**正本は一覧のほうである**（`AGENTS.md`「**複製した瞬間から、正本と写しはずれ始める**」——
🔴 **実際にずれたのは、この写しのほうだった**）。

### ⛔ 「出荷済みか」を `npm view dist-tags` で判定しないこと

🔴 **これが [Issue #532](https://github.com/takecchi/mnemora/issues/532) の根本原因である**
——下の **12**・**13** は、`npm view @mnemora/core dist-tags` が `latest: 0.3.0` を返すことを根拠に
「既に `v0.3.0` で出荷済み」と書かれていた。**どちらも `v0.3.0` に入っていない。**

⛔ **`dist-tags` が答えるのは「最新版は何か」であって、「*この変更が*その版に入っているか」ではない。**
⟹ **入っているかは、次のどちらかで見ること:**

```bash
# (a) その変更を運んだ commit が、その tag の祖先か
git merge-base --is-ancestor <commit> v0.3.0   # exit 0 なら入っている
# (b) その版の現物の型定義に在るか
npm pack @mnemora/core@0.3.0
d=$(mktemp -d) && tar -xzf mnemora-core-0.3.0.tgz -C "$d"
grep -r restoreSuperseded --include='*.d.ts' "$d/package/dist"   # 1行でも出れば入っている
```

### ⚠ この文書の訂正の履歴（2026-09-18 / 2026-09-19）

⭐ **この文書は生きた移行ガイドであって、ADR ではない。**⟹ **誤った記述は本文を直す。**
⛔ **ADR 流の「本文を書き換えず訂正を積む」作法は、この文書には当てない**——それは
`docs/decisions/README.md` が **ADR について**定めた則であり、生きた文書へ当てると
**読む人に「どこを信じてよいか」を判断させる形**になる
（[ADR 0213](./decisions/0213-live-docs-cite-adrs-by-anchor-not-line-number.md) /
[ADR 0241](./decisions/0241-migration-guide-is-a-live-doc-not-an-adr.md)）。
⟹ **経緯はこの1箇所に畳む。**

| 2026-09-18 以前はこう書いてあった | いまの記述 |
|---|---|
| 世代が**2つ**（`v0.1.9→v0.2.0` / `v0.2.0→v1.0.0`）で、後者は「**3件・未リリース**」 | **3世代。8〜11 は `v0.3.0` で出荷済み** |
| 「`@mnemora/local-embedding` に破壊的変更は無い」 | 🔴 **在る**（**11**。PR #446 / ADR 0205、`v0.3.0` で出荷済み） |
| `v0.2.0`→`v0.3.0` は「**6件**」（8〜13） | **4件**（8・9・10・11） |
| **12**・**13** は「既に `v0.3.0` で出荷済み」 | ⛔ **未出荷。**`v0.3.0` より後である（根拠は各項目） |
| 🟡3件は「`v0.2.0` → `v1.0.0`」の分 | **3件とも `v0.3.0` で出荷済み** |
| DB マイグレーションは `0016`/`0017` まで | **`0018` を足した**（`v0.3.0`→`v0.4.0` で新たに要るのはこれだけ） |

⚠ **上の表の「いまの記述」欄は 2026-09-18 時点のものである。**⛔ **書き換えていない**——
**下の 2026-09-19 の訂正で、12〜17 と `0018` は「未リリース」から「`v0.4.0` で出荷済み」へ変わった。**

⭐ **なぜ腐ったか —— 誰も嘘を書いていない。正しかった記述が、現物が動いて嘘になった。**
「`local-embedding` に破壊的変更は無い」は **2026-09-16 に書かれた時点では正しかった**（PR #341）。
**2026-09-17 に PR #446 が `LocalEmbeddingPipeline` を必須 interface にし**（ADR 0205）、
**同日 `v0.3.0` がリリースされ**、**この文書は更新されなかった。**
⟹ ⭐ **だから、`main` が動けば変わる数をここに写さない**（上の ⛔ を見ること）。
🔴 **12・13 の取り違えのほうは、原因が別である**——根拠に `npm view dist-tags` を使っていた。
上の「⛔ 「出荷済みか」を `npm view dist-tags` で判定しないこと」を見ること
（[Issue #532](https://github.com/takecchi/mnemora/issues/532)）。

#### ⭐ 2026-09-19 の訂正 —— **`v0.4.0` が出たのに、この文書が追随していなかった**

🔴 **これは同じ形の2回目である。**上の「なぜ腐ったか」が逐語で「**同日 `v0.3.0` がリリースされ**、
**この文書は更新されなかった**」と記録しているのと、**同じことが `v0.4.0` で起きた。**

| 2026-09-19 以前はこう書いてあった | いまの記述 |
|---|---|
| 世代が**3つ**で、3つ目は `v0.3.0` → `v1.0.0`（**未リリース**） | **4世代。12〜17 は `v0.4.0` で出荷済み**で、未リリース世代は `v0.4.0` → `v1.0.0` になった |
| **12**〜**17** は「⛔ まだ出荷されていない」 | ⚠ **`v0.4.0` で出荷済み**（根拠は各項目の【実測】） |
| DB マイグレーション `0018` は「⛔ 未リリース」 | ⚠ **`v0.4.0` で出荷済み** |

**【実測 2026-09-19】** `v0.4.0` は **2026-09-18T20:36:04Z に published**（draft でも pre-release でもない）、
publish ワークフローの run は **success**、npm の `@mnemora/core` の版一覧に **`0.4.0` が在る**。
そして `git merge-base --is-ancestor <12〜17 の各 commit> v0.4.0` は**すべて真**である。

⛔ **この文書だけの問題ではなかった**——[CHANGELOG.md](../CHANGELOG.md) も同時に、
出荷済みの中身を `[1.0.0] - 未リリース` の節に置いたままだった。
⟹ **同じ PR で両方を直した。**経緯と、3回目を防ぐ手の検討は
[ADR 0248](./decisions/0248-changelog-and-migration-guide-follow-the-release.md)。

#### 🔴 2026-09-21 の訂正 —— **`v0.5.0` が出たのに、この文書が追随していなかった（3回目）**

🔴 **同じ形の3回目である。**⛔ **「2回目まで」と書いていた上の節は、当時の記録なので書き換えない。**

| 2026-09-21 以前はこう書いてあった | いまの記述 |
|---|---|
| 世代が**4つ**で、4つ目は `v0.4.0` → `v1.0.0`（**未リリース**） | **5世代。18 は `v0.5.0` で出荷済み**で、未リリース世代は `v0.5.0` → `v1.0.0` になった |
| `v0.4.0` → `v1.0.0` の世代には「**まだ1件も無い**」 | ⚠ **在った**——**18**（PR #550 / ADR 0247）が `v0.4.0` より後に着地し、**そのまま `v0.5.0` で出荷された。この文書にも `CHANGELOG.md` にも計上されていなかった** |

**【実測 2026-09-21】** `v0.5.0` は **2026-09-20T15:25:56Z に published**（draft でも pre-release でもない）、
publish ワークフローの run は **success**、npm の `@mnemora/core` の版一覧に **`0.5.0` が在る**
（6パッケージとも `dist-tags.latest` が `0.5.0`）。
そして `git merge-base --is-ancestor a6caef1 v0.5.0` は**真**、`… v0.4.0` は**偽**である
（`a6caef1` = **18** を運んだ [PR #550](https://github.com/takecchi/mnemora/pull/550) の squash）。

🔴 **1回目・2回目と違い、今回は「気づけなかった」ではない。**
[ADR 0247](./decisions/0247-local-embedding-repo-model-id-declaration-guard.md) は逐語で
**「この変更は `CHANGELOG.md` / `docs/migration-v1.md` へ未計上である」**と自ら書き残し、
**番号を振らなかった理由まで「世代表が `v0.4.0` へ追随した後に決まる」と明記していた。**
⟹ ⭐ **担い手は正しく申し送った。落ちたのは、その申し送りを受けて計上する側である。**
⚠ **そのうえ、リリース直後に機械も知らせていた**——
[ADR 0251](./decisions/0251-release-follow-up-notice-not-a-gate.md) の「Release follow-up notice」が
`v0.5.0` の tag で走り、逐語で「**🔴 CHANGELOG.md に `## [0.5.0]` の節が無い。**」と出力して終わっている
（⛔ **門ではないので、何も止めていない**）。

⭐ **【実測 2026-09-21】この世代に、他の計上漏れは無い。**
出荷される面のソースで `v0.4.0..v0.5.0` に差分が在るのは **2ファイルだけ**である:

```bash
git diff --name-only v0.4.0..v0.5.0 \
  | grep -E '^(packages|examples|scripts)/' \
  | grep -vE '__tests__|\.test\.ts|__fixtures__'
# → packages/core/src/recall-runtime.ts           （PR #549 / ADR 0246。⭕ 破壊的ではない）
#   packages/local-embedding/README.md            （⭕ 挙動ではない）
#   packages/local-embedding/src/local-embedding-provider.ts  （PR #550 / ADR 0247 = 18）
#   scripts/check-release-changelog-section.mjs   （⭕ publish 対象の外）
#   scripts/release-changelog-section-lib.mjs     （⭕ publish 対象の外）

git diff --stat v0.4.0..v0.5.0 -- scripts/__snapshots__/public-api/  # → （差分なし）
git diff --stat v0.4.0..v0.5.0 -- packages/postgres/migrations/      # → （差分なし）
```

⟹ ⭕ **公開 API の型スナップショットが1バイトも動いていない**ので、
**「型が変わったのに載っていない」形の漏れは、この世代には無い。**
⛔ **ただしこれは「漏れが無いことの証明」ではない**——**型に現れない挙動の変更は、この2つのコマンドでは捕まらない。**
⟹ **上の一覧を人が読んで分類した**（`AGENTS.md`「⚠ 機械には『検出』まで」）。

#### 🔴 2026-09-21（2回目）の訂正 —— **「この世代は空か」の根拠が、commit の本数のまま2箇所に残っていた**

🔴 **⭐ 結論は、どちらも真のままである。**⛔ **腐ったのは根拠のほうだけである。**

| 2026-09-21（2回目）以前はこう書いてあった | いまの記述 |
|---|---|
| `v0.5.0` → `v1.0.0` で要るマイグレーションが無い根拠が「`git rev-list --count v0.5.0..origin/main` が **0**」（「v0.3.0 → v0.4.0 で追加されたマイグレーション」節） | **`git diff --stat v0.5.0..origin/main -- packages/postgres/migrations/` が差分を返さない**（⭐ 出荷される面を直接当てる） |
| 「🔴 破壊的変更（v0.5.0 → v1.0.0）」節の検算が `git rev-parse` と `git rev-list --count` の2本 | **`git diff --stat … -- packages/` と `… -- scripts/__snapshots__/public-api/` の2本。**⛔ 旧2本は「この判定には使えない」として残した |

**【実測 2026-09-21、`origin/main` = `89f8dd5`】**`git rev-list --count v0.5.0..origin/main` は
**0 → 17**（`v0.5.0` の後に 17 本の PR が着地した）。
⛔ **そのうち `scripts/publish-targets.mjs` の `PUBLISH_TARGETS` の中を触ったものは1本も無い**
——`git diff --name-only v0.5.0..origin/main -- packages/` は **0 件**、6つの `dir` を
1本ずつ当てても全部 0 件である。⟹ **結論（マイグレーション無し／この世代の破壊的変更 0件）は動かない。**

🔴 **同型の訂正は [PR #559](https://github.com/takecchi/mnemora/pull/559) が既に一度やっている。**
同 PR は**この文書の冒頭**と `CHANGELOG.md` の `[1.0.0]` 節で、根拠を「commit の本数」から
「出荷される面の差分」へ移した。⟹ ⚠ **本文の下のほうに在るこの2箇所には、手が届いていなかった。**

🔴 **そして、この判定の「使えない理由」は
`docs/release-notes-v1.0.0.md` が既に逐語で書いていた**
——「⛔ **`git rev-list --count v0.5.0..origin/main` を、この判定に使わないこと**——
**docs だけの commit でも増える**（実際に増えた）」。
⟹ ⭐⭐ **同じ判定を2つの文書が別々に持ち、片方だけが腐った形である。**
⛔ **これは「書き忘れ」ではなく、複製の帰結である**（`AGENTS.md` の反重複規律）。

**⚠ 2026-09-29 追記（クローン miku の委譲先。Issue #762、オーナー回答「すでに完了した計画は
全部消しちゃっていいと思うよ」により本 PR で削除）**: 上で引いた `docs/release-notes-v1.0.0.md`
はこの追記時点で削除済みであり、当該の逐語はもう `main` に無い。**`v1.0.0` は出荷済み・tag は
凍結済みであり、GitHub Release 本文と `CHANGELOG.md` の `[1.0.0]` 節に内容が残っている。**
⛔ 上の本文（2026-09-21（2回目）の訂正）は書き換えていない——この追記は参照先が消えたことだけを記録する。

⚠ **この文書は複製をやめられない**——世代ごとの手順を持つのがこの文書の役目であり、
**マイグレーションの要否は各世代の節に書かないと読む人に届かない。**
⟹ ⭐ **代わりに、上の2箇所へ「⛔ この判定には使えない」を現物として焼いた。**
⛔ **これは機械の歯ではない**——**次に同じ根拠を書こうとした人が、その場で気づく形にしただけである。**

#### 🔴 2026-09-26 の訂正 —— **`v1.0.0` が出たのに、この文書が追随していなかった（5回目、今回は表題の版そのもの）**

🔴 **同じ形の5回目である。**⛔ **1〜4回目までの節は当時の記録なので書き換えない。**

| 2026-09-26 以前はこう書いてあった | いまの記述 |
|---|---|
| 世代が**5つ**で、5つ目は `v0.5.0` → `v1.0.0`（**未リリース**） | **同じ5世代のまま。`v0.5.0` → `v1.0.0` は0件のまま出荷済み** |
| `v0.5.0` → `v1.0.0` の世代には「**まだ1件も無い**」 | ⚠ **最後まで1件も無いまま出荷された**（両端が tag で閉じたので、いま「0件」と書ける） |

**【実測 2026-09-26】** `v1.0.0` は **2026-09-22T23:54:08Z に published**
（`gh release view v1.0.0` で `isDraft: false`・`isPrerelease: false`・`targetCommitish: main` を確認）、
`git diff --stat v0.5.0..v1.0.0 -- packages/` と
`-- scripts/__snapshots__/public-api/` はどちらも差分なし。`CHANGELOG.md` は
`## [1.0.0] - 2026-09-23` を既に持ち、追随済みだった。**この文書だけが追随していなかった。**

⚠ **`v1.0.0` より後に着地した変更を、この文書が数え直す作業はまだ終わっていない。**
この移行ガイド自身の §6 の例を `@mnemora/testkit`（当時の `main`）に対して型検査したところ、
`TenantSettingsStoreConformanceOptions.supportsTaxonomyMode`（`?` の付かない必須フィールド、
PR #717・commit `ba6e5dd`）が足りずコンパイルできなくなっていることが分かった——さらに
棚卸しで `MemoryStoreConformanceOptions.supportsLabels`（同じ commit）・
`supportsFindActiveByClaimKey`（PR #745・commit `7987de4`）も同じ壊れ方をしていたことが
見つかった。[Issue #818](https://github.com/takecchi/mnemora/issues/818) の結果、
3つとも `?: boolean` へ戻し、省略時は該当する適合項目を実行しないようにした
（[ADR 0318](./decisions/0318-taxonomy-labels.md) /
[ADR 0324](./decisions/0324-claim-key-contested-detection.md) の追記）——**破壊的変更として
次の世代の節に計上する対象からは外れた。**§6 の例は再びそのままコンパイル・実行できる
——詳細は **6** の末尾。**この3件以外に、`v1.0.0` より後に着地してまだ数えていない
変更が残っているかどうかは、別途棚卸しが要る。**

#### 🔴 2026-09-30 の訂正 —— **冒頭の世代表と表題が、`v1.1.0` の出荷と節の改題に追随していなかった（6回目）**

⛔ **これまでの節は当時の記録なので書き換えない。出荷済みの節（「🔴 破壊的変更（v1.0.2 → v1.1.0）」ほか）の本文にも触れていない。**直したのは冒頭の表題・世代表の行・本節だけである（と、下の `tar` の1箇所）。

| 2026-09-30 以前はこう書いてあった | いまの記述 |
|---|---|
| 世代表の最終行が「**v1.0.2 → 次の版**（未リリース）」で、指す先は「🔴 破壊的変更（v1.0.2 → 次の版）」 | **この見出しは存在しない。**`v1.1.0` の出荷で、節は「🔴 破壊的変更（v1.0.2 → v1.1.0）」（出荷済み・確定12件）と「🔴 破壊的変更（v1.1.0 → 次の版）」（未リリース）に分かれていた。表も **v1.0.2 → v1.1.0**（出荷済み）と **v1.1.0 → 次の版**（未リリース）の2行にした |
| 表題が「…→ v1.0.0」で止まっていた（本文は v1.0.1 以降の世代も持っている） | 表題を「…→ v1.0.0 → v1.0.1 → v1.0.2 → v1.1.0 → 次の版」へ直した |

⚠ 冒頭の「5世代を持つ」「全5世代の件数を書いてよいのは……」の段落は、**v1.0.0 までの5世代**についての記述であり、表が v1.0.0 より後に持つ行は含まない（この段落は書き換えていない）。

⚠ 同じ日、「`dist-tags` で判定しないこと」の節の (b) の手順（`tar -xzOf … 'package/dist/*.d.ts' | grep`）も直した。**GNU tar はパターン（`*`）を既定で展開せず `Not found in archive` で落ち、パイプの先の `grep` は0件を返す——「その版に入っていない」と誤判定する形だった。**展開してから `grep -r` する形にした。GNU tar 1.35 で、旧形が `Not found`・新形が一致を返すことを実際に打って確かめた。BSD tar では打っていない（新形が使うのは `-xzf` と `-C` だけである）。

---

⚠ **番号は通しである**（**1** から。⛔ **総数をここに写さない**——`main` が動けば増える）。
⛔ **「全部合わせて N 件ある」と読まないこと**——**どちらの版へ上げるかで、読む範囲が変わる。**
各変更の設計判断・検討した代替案・引き受けた負債は、リンク先の ADR を見ること
——ここでは複製しない（`AGENTS.md` の反重複規律）。ユーザー向けの新機能・バグ修正の
一覧は [CHANGELOG.md](../CHANGELOG.md) を見ること。

---

## ⚠ この文書は当初「v0.1.9 → v1.0.0」として書かれた

**そう書いた時点では、次に出る Release が `v1.0.0` になる見込みだった。**
**実際に出たのは 2026-09-16 の `v0.2.0` であり、下に挙げる🔴6+1件・🟡3件は
すべて `v0.2.0` に入って出荷された**（tag `v0.2.0` が指すのは `c52be47`。
【実測】`gh release list --limit 10` の最新が `v0.2.0`、
`npm view @mnemora/<pkg> dist-tags` が6パッケージとも `latest: 0.2.0`）。
⟹ **表題と本文の版を `v0.2.0` に直した。手順の中身は1件も変えていない。**

⛔ **（この段落を書いた 2026-09-17 の時点では）`v1.0.0` はまだ切られていなかった。**経緯は [docs/roadmap.md](https://github.com/takecchi/mnemora/blob/635c93d/docs/roadmap.md#712--v100-をどう切るか--オーナーの決定2026-09-16-項目2-は半分のまま切る) §7.12 に在る。（⚠ 2026-09-29 追記: 参照先の §7.12 は削除した（#762）。リンク先は削除前の `635c93d` の版である。）
⚠ **2026-09-26 訂正**: その後 `v1.0.0` は **2026-09-22T23:54:08Z に published** された（冒頭の「2026-09-26 の訂正」）。当初ここは日付を付けずに「まだ切られていない」と書いており、出荷後も現在形のまま残っていた。

⭐ **この文書はかつて「`v0.2.0` → `v1.0.0` の移行手順は、この文書には無い」と宣言していた。
2026-09-17、その宣言を撤回した**（[Issue #432](https://github.com/takecchi/mnemora/issues/432)）。

🔴 **撤回した理由は、宣言のほうが現物から遅れていたからである。**【実測】撤回の時点で、
**この文書は既に `v0.2.0` → `v1.0.0` の記述を2箇所持っていた**——「DB マイグレーション」の
`0016`/`0017` の節（当時の見出しは「`v0.2.0` 以降に追加されたマイグレーション」。
2026-09-18 に「v0.2.0 → v0.3.0 で追加されたマイグレーション」へ改題した）と、破壊的変更の **8**。
**どちらも `v0.2.0` より後に入ったものである。**

⟹ ⛔ **中身を宣言に合わせて削ると、現に在る有用な記述を捨てることになる。**
**宣言を現実に合わせるほうを採った。**そして**欠けていた 9・10 を足した**——
`CHANGELOG.md` と `v1.0.0` の Release 本文がどちらもこの文書を移行の送り先として
名指ししており、**リンクを踏んだ先に3件のうち1件しか無い**状態だったためである。

**ファイル名が `migration-v1.md` のままである理由**: この名前は
[`docs/roadmap.md`](./roadmap.md)・[ADR 0165](./decisions/0165-decay-activity-clock.md)・
[ADR 0169](./decisions/0169-changelog-hand-curated.md) から参照されており、
**それらは当時の記録なので書き換えない**（`AGENTS.md`）。⟹ **名前は据え置き、中身だけを実態に合わせた。**

---

## まず: 影響を受けない人

**ほとんどの利用者は何もしなくてよい。** `createRuntime()`（`@mnemora/postgres` /
`@mnemora/openai` などの実装を渡して組み立てる）で作った `Runtime` を、
`observe()`/`recall()`/`reflect()`/`consolidate()`/`forget()` の5つの動詞だけで
使っているなら、v0.2.0 でも v1.0.0 でもコードの変更は要らない。

下の🔴の項目はすべて「**独自の adapter・独自の `Runtime` 実装・独自のテスト基盤コードを
書いている場合**」にだけ影響する。あなたが該当するかどうかは、次の表で判定できる
（⚠ **`8`〜`11` が `v0.2.0` → `v0.3.0`、`12`〜`17` が `v0.3.0` → `v0.4.0`、`18` が `v0.4.0` → `v0.5.0` の分で、**
**🔴 どれも出荷済みである。`v0.5.0` → `v1.0.0` の分は0件のまま出荷された**。`v1.0.0` より後に
一時的に必須化されていた3件（`supportsTaxonomyMode`/`supportsLabels`/
`supportsFindActiveByClaimKey`）は [Issue #818](https://github.com/takecchi/mnemora/issues/818)
の結果すべて任意へ戻したため、破壊的変更としては数えない——**6** の末尾を見ること）:

| していること | 影響 |
|---|---|
| `@mnemora/postgres` の `PostgresMemoryStore`/`PostgresVectorStore`/… をそのまま使っている | **影響なし** |
| `@mnemora/testkit` の in-memory 実装をテストでそのまま使っている | **影響なし**（ただし `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls` を直接呼んでいる場合だけ 🔴 8 を見ること） |
| `createRuntime()` が返す `Runtime` をそのまま使っている（自分で `Runtime` interface を実装していない） | **影響なし** |
| `MemoryStore`/`VectorStore`/`TenantSettingsStore` を自分で実装している（自作 adapter） | 🔴 1・2・3・6 を見ること |
| `Runtime` interface を自分で実装している（`createRuntime()` を使わず、独自に組み立てている） | 🔴 5 を見ること |
| `MemoryStore.createRecall`/`aggregateScope` の戻り値を直接読んでいる、または `FilteredOmission.condition` を網羅的に分岐している | 🔴 2・3・4 を見ること |
| `TICK_SUPPORTED_JOB_KINDS` の値を網羅的に分岐している | 🟡「`TICK_SUPPORTED_JOB_KINDS`」を見ること |
| v0.1.9 で `MemoryStore.createMemory` を直接呼び、`validFrom`/`validUntil` に non-null を書いていた | 🟡「`validAt` ゲート」を見ること |
| `RecallFootprintEstimate` オブジェクトを自分で組み立てている（`estimateRecallFootprint()` の戻り値をそのまま使うだけではない） | 🔴 7 を見ること |
| **`FilteredOmission` を自分で組み立てている**（自作 adapter の `aggregateScope` 実装・テストダブル） | 🔴 **9** を見ること（⚠ **`v0.3.0` で出荷済み**） |
| **`Omission` の `over_limit` を自分で組み立てている** | 🔴 **10** を見ること（⚠ **`v0.3.0` で出荷済み**） |
| **`LocalEmbeddingPipeline` を自前で渡している／呼んでいる**（`@mnemora/local-embedding`） | 🔴 **11** を見ること（⚠ **`v0.3.0` で出荷済み**） |
| **`Runtime` interface を自分で実装している**（再掲。`v0.3.0` → `v0.4.0` の分） | 🔴 **12**・**14**・**16** を見ること（⚠ **`v0.4.0` で出荷済み**） |
| **`@mnemora/testkit` の `MemoryStore` 適合テスト（`describeMemoryStoreConformance`）を呼んでいる** | 🔴 **13**・**15** を見ること（⚠ **`v0.4.0` で出荷済み**） |
| **`MemoryEvent.kind` を網羅的に分岐している**（`EventStore` の戻り値を `never` で検査している） | 🔴 **17** を見ること（⚠ **`v0.4.0` で出荷済み**） |
| **`LocalEmbeddingProvider` に `repo` を渡している**（既定と異なるモデル／私設ミラー。`@mnemora/local-embedding`） | 🔴 **18** を見ること（⚠ **`v0.5.0` で出荷済み**。⭕ `repo` を渡していないなら影響なし）。🔴 **この行だけ、壊れるのが型検査ではなく実行時である** |

---

## DB マイグレーション

**postgres を使っているなら、まずこれを実行する。**

`@mnemora/postgres` が提供する `mnemora-postgres-migrate`
（[`packages/postgres/README.md`](../packages/postgres/README.md) に詳細）は、
`migrations/*.sql` を**ファイル名の昇順ですべて自動適用する**——特定のバージョンだけを
選んで適用する形にはなっていないので、個別の呼び方は不要である。

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb npx mnemora-postgres-migrate
# または、このリポジトリの workspace 内なら
DATABASE_URL=... pnpm --filter @mnemora/postgres run migrate
```

v0.1.9 の時点で `0012_half_life_hours_range.sql` まで適用済みであれば、上のコマンドは
次の3本を追加で適用する（**現物のファイル名で確認済み**）:

| ファイル | 内容 | 対応する変更 |
|---|---|---|
| `0013_recall_returned_memories_jsonb.sql` | `recalls.returned_memory_ids`（uuid[]）を削除し、`recalls.returned_memories`（jsonb）へ置き換える | 🔴 2 |
| `0014_observations_valid_from_until.sql` | `observations` に `valid_from`/`valid_until` を追加する | 🔴 3・🟡「`validAt` ゲート」 |
| `0015_decay_activity_clock.sql` | `tenant_activity` テーブルを新設し、`memories` に `decay_base_seq`/`decay_floor_seq`/`half_life_recalls` を追加する | 新機能「`decay_clock`」 |

**`0013` は破壊的マイグレーションである**（列の削除を含む）。適用前に `recalls` テーブルの
バックアップを取ることを推奨する。マイグレーション自体は列の移行（`returned_memory_ids`
→ `returned_memories` への変換、`breakdownCaptured: false` で移行元行を明示）を
自動で行う——手作業でのデータ移行は不要。

新規インストールの場合は、初回データ投入後に `--analyze-memories` を実行すること
（v0.1.9 から変わっていない手順、[packages/postgres/README.md](../packages/postgres/README.md) 参照）。

**この移行ガイドの作業者はこの環境で上記マイグレーションを実際に Postgres へ適用していない**
（`DATABASE_URL` が無い作業環境のため）——SQL の内容はファイルを読んで確認したが、
実行結果の検算は CI／実運用の DB に委ねている。

### v0.2.0 → v0.3.0 で追加されたマイグレーション（`0016`/`0017`）—— ⚠ **`v0.3.0` で出荷済み**

⭐ **`v0.3.0` を使っているなら、この2本は適用済みのはずである**——`0016`/`0017` はどちらも
`v0.3.0` に入って出荷された。⟹ **この節は「`v0.2.0` から上げる人」向けである。**
**`v0.3.0` から `v0.4.0` 以降へ上げるときに新たに要るのは、次の `0018` だけである。**

v0.2.0 の時点で `0015_decay_activity_clock.sql` まで適用済みであれば、上のコマンドは
次の2本を追加で適用する（**現物のファイル名で確認済み**）:

| ファイル | 内容 | 対応する変更 |
|---|---|---|
| `0016_provenance_kind_matches_provenance.sql` | `memories` に CHECK 制約 `memories_provenance_kind_matches_provenance`（`provenance_kind = provenance->>'kind'`）を `NOT VALID` で足す。既存行は走査しないが、この時点から先の INSERT/UPDATE には即座に効く | [Issue #273](https://github.com/takecchi/mnemora/issues/273) / [ADR 0182](./decisions/0182-provenance-kind-matches-provenance-check.md) |
| `0017_provenance_kind_matches_provenance_validate.sql` | `0016` の制約を既存行に対して `VALIDATE CONSTRAINT` する | 同上 |

**`0013`〜`0015` と違い、`0016`/`0017` は非破壊的である**（列の削除も型変更も無い。足すのは
CHECK 制約だけ）。**ただし `0017` は、既存の `memories` 行に
`provenance_kind`（列）と `provenance->>'kind'`（jsonb）が実際にずれている行があれば、
そこで失敗する。** 失敗した場合は `0016` の保護（新規の不一致行の拒否）は適用済みのまま残る
——**その場で失敗したデータを直そうとせず、原因（何がその行を作ったか）を先に特定すること**
（[`0017_provenance_kind_matches_provenance_validate.sql`](../packages/postgres/migrations/0017_provenance_kind_matches_provenance_validate.sql)
「🔴 このファイルが失敗したら」参照）。通常の書き込み経路（`@mnemora/postgres` が
提供する `PostgresMemoryStore` をそのまま使っている場合）ではこの2列は常に同じ値から書かれる
ため、通常は `0017` も無事に適用される。

**この節の作業者は、上記2本を実際に Postgres へ適用して確認した**（`/tmp` に自前で立てた
PostgreSQL 17、`0001`〜`0015` を先に適用した DB に対して実際のコード経路
（`createMemory`/`createMemoryWithOutbox`/`supersedeWithNewMemories`）で行を投入した後、
`0016`/`0017` を追加適用して成功することを確認した。詳細は ADR 0182「測ったこと」参照）。

### v0.3.0 → v0.4.0 で追加されたマイグレーション（`0018`）—— ⚠ **`v0.4.0` で出荷済み**

v0.3.0 の時点で `0017_provenance_kind_matches_provenance_validate.sql` まで適用済みであれば、
上のコマンドは次の1本を追加で適用する（**現物のファイル名で確認済み**）:

| ファイル | 内容 | 対応する変更 |
|---|---|---|
| `0018_memory_events_kind_unsuperseded.sql` | `memory_events.kind` の CHECK 制約の許容値に `'unsuperseded'` を足す（`0011` が `'restored'` を足したのと同じ形。他の列・索引・制約は一切変えない） | 🔴 **12**（`Runtime.restoreSuperseded`）/ [ADR 0230](./decisions/0230-restore-superseded-recovery-path.md)、PR #464 |

⚠ ****【実測 2026-09-19、`origin/main` = `420e0f4`】** `git merge-base --is-ancestor ba9f9a1 v0.4.0` は**真**である**
（`ba9f9a1` = `0018` を運んだ PR #464 の squash）。⟹ **`v0.4.0` を使っているなら、この1本は適用が要る。**
⛔ **`v0.4.0` → `v0.5.0` で新たに要るマイグレーションは無い**
（【実測 2026-09-21】`git diff --stat v0.4.0..v0.5.0 -- packages/postgres/migrations/` は差分を返さない）。
⭕ **両端が tag で閉じているので、この「無い」は `main` が動いても変わらない。**
⛔ **`v0.5.0` → `v1.0.0` で新たに要るマイグレーションも、いまのところ無い**
（【実測 2026-09-21、`origin/main` = `89f8dd5`】
`git diff --stat v0.5.0..origin/main -- packages/postgres/migrations/` は差分を返さない）
——⚠ **こちらは `main` が動けば変わりうる。**
🔴 **⛔ この判定に `git rev-list --count v0.5.0..origin/main` を使わないこと**
——**`docs` だけの commit でも増えるので、この判定には最初から使えない。**
⚠ **この行は、実際にそれで腐った**（根拠が `… --count` → **0** のまま残っていた）。
経緯は上の「⚠ この文書の訂正の履歴」節を見ること。

**`0013`〜`0015` と違い、`0018` は非破壊的である**（列の削除も型変更も無い）。
🔴 **ただし「新機能を使うときだけ要る」ものではない。**`Runtime.restoreSuperseded` は
`kind = 'unsuperseded'` の `memory_events` 行を積むので、**`0018` を流さずにこの口を呼ぶと
CHECK 制約で書き込みが落ちる。** ⟹ **`v0.4.0` 以降へ上げるなら流すこと。**

⚠ **`0018` は制約名をハードコードしない。**`pg_constraint`/`pg_get_constraintdef` の定義文字列
（`LIKE '%= ANY%'`）で対象の CHECK 制約を1本に特定し、**0本または2本以上なら `RAISE EXCEPTION` で
失敗する**——黙って何もしない形にはなっていない。⚠ **1つの DB に複数の専用スキーマ（ADR 0057）を
同居させている場合**は `pg_table_is_visible` で `search_path` 上の1行に絞る（`0011` が CI で
実際に踏んだ問題）。理由はファイル自身の冒頭コメントに書いてある——**ここには複製しない。**

**この節の作業者は `0018` を実際に Postgres へ適用していない**（`DATABASE_URL` が無い作業環境）
——SQL の内容はファイルを読んで確認したが、実行結果の検算は CI／実運用の DB に委ねている。

---

## 🔴 破壊的変更（v0.1.9 → v0.2.0）—— **1〜7。出荷済み**

⭐ **`v0.2.0` から `v1.0.0` へ上げるだけの人は、この節を読まなくてよい。**次の節（**8** 以降）へ飛ぶこと。

対象はすべて `@mnemora/core` と `@mnemora/testkit`。`@mnemora/openai` / `@mnemora/anthropic` /
`@mnemora/local-embedding` に破壊的変更は無い（`src` に v0.1.9 からの差分が無いことを確認済み）。

### 1. `MemoryStore.getRecall` が必須メソッドになった

**誰が影響を受けるか**: `MemoryStore` interface を自分で実装している場合
（`@mnemora/postgres`/`@mnemora/testkit` が提供する実装をそのまま使っているなら影響なし）。

**何をすればよいか**: 次のシグネチャでメソッドを実装する。

```ts
getRecall(ctx: Ctx, id: RecallId): Promise<RecallRecord | null>;
```

契約（`get`/`getObservation` と同じ規律）:
- 対象の行が存在しない、または `tenant_id` が `ctx.tenantId` と一致しない場合は
  **例外を投げず** `null` を返す。
- `RecallRecord` は `recalls` 行1件ぶん全部
  （`recallId`/`tenantId`/`subjectId`/`query`/`budget`/`omitted`/`usage`/`indexBand`/
  `explain`/`returnedMemories`/`createdAt`）を返す。

根拠: [ADR 0155](./decisions/0155-recall-score-breakdown-persisted.md)。

### 2. `NewRecallRecord.returnedMemoryIds` → `returnedMemories`

**誰が影響を受けるか**: (a) `MemoryStore.createRecall` を直接呼んでいる側、
(b) `MemoryStore.createRecall`/`getRecall` を自分で実装している adapter 作者。
`Runtime.recall()`/`Runtime.observe()` を使っているだけなら影響なし
（この変更は `Runtime` の外に出ない内部の記録経路である）。

**何をすればよいか**:

```ts
// 旧（v0.1.9）
interface NewRecallRecord {
  returnedMemoryIds: MemoryId[];
  // ...
}

// 新（v0.2.0）
interface NewRecallRecord {
  returnedMemories: RecallRecordMemory[]; // { memoryId, score, retrievedVia, companionOf?, associationOf? }
  // ...
}
```

**`memoryId` の配列だけが必要な場合の最小の読み替え**——⚠ **どちらの型を読んでいるかで形が違う**
（後述「1」の `RecallRecord`（`getRecall()` の戻り値）は、この時点よりさらに後（ADR 0155本体、
`0013` と同じ変更）で `returnedMemories` 自体が判別可能ユニオンになっている。**`NewRecallRecord`
（`createRecall` への入力）側は素朴な配列のままである**）:

```ts
// (a) NewRecallRecord（createRecall への入力）を組み立てている場合:
// 旧: const ids = record.returnedMemoryIds;
const ids = record.returnedMemories.map((m) => m.memoryId);

// (b) RecallRecord（getRecall() の戻り値）を読んでいる場合:
// `returnedMemories` は `RecallRecordReturnedMemories`
// （`{ breakdownCaptured: true; memories: RecallRecordMemory[] }
//   | { breakdownCaptured: false; memories: { memoryId: MemoryId }[] }`）
// ——配列ではないので、(a) と同じ書き方は tsc エラーになる
// （`Property 'map' does not exist on type 'RecallRecordReturnedMemories'`）。
const ids = record.returnedMemories.memories.map((m) => m.memoryId);
// `breakdownCaptured: false` は「この行は返り値のスコア内訳を持ったことが無い」印であり
// （`0013` が移行元行にこの値を立てる）、そちら側の要素は `memoryId` しか持たない——
// `memoryId` だけを取り出すこの読み替えでは breakdownCaptured の値を分岐する必要はない。
```

`MemoryStore.createRecall`/`getRecall` を自分で実装している場合は、単なるリネームでは
済まない——`score`/`retrievedVia`/`companionOf`/`associationOf` も保存・読み戻しする
必要がある（`RecallRecordMemory` の全フィールド）。

根拠: [ADR 0155](./decisions/0155-recall-score-breakdown-persisted.md)。

### 3. `ScopeAggregate` に必須フィールド `filteredExpired`/`filteredNotYetValid` が増えた

**誰が影響を受けるか**: `MemoryStore.aggregateScope` を自分で実装している場合
（提供済みの実装をそのまま使っているなら影響なし）。

**何をすればよいか**: 次の2フィールドを `ScopeAggregate` の戻り値に足す。

```ts
filteredExpired: { count: number; countKind: CountKind };      // validUntil <= validAt で落ちた件数
filteredNotYetValid: { count: number; countKind: CountKind };  // validFrom > validAt で落ちた件数
```

`validAt` ゲート（下記🟡参照）を実装しない・対応しない adapter であれば、
**両方とも `{ count: 0, countKind: 'exact' }` を固定で返してよい**——`validFrom`/
`validUntil` に non-null を書く経路が無い限り、この値は常に0で正しい。

根拠: [ADR 0164](./decisions/0164-valid-from-until-recall.md)。

### 4. `FilteredOmission.condition` の union に `"expired"`/`"not_yet_valid"` が増えた

**誰が影響を受けるか**: `Omission`/`FilteredOmission` を消費するだけなら影響なし。
**`condition` を `switch`+`never` などで網羅的に分岐しているコードはコンパイルが壊れる。**

**何をすればよいか**: 分岐に2ケースを足す。

```ts check
switch (omission.condition) {
  case "tenant": /* ... */ break;
  case "superseded": /* ... */ break;
  case "forgotten": /* ... */ break;
  case "archived": /* ... */ break;
  case "taxonomy": /* ... */ break;
  case "period": /* ... */ break;
  case "decayed": /* ... */ break;
  case "expired": /* 追加: validUntil を過ぎて落ちた */ break;
  case "not_yet_valid": /* 追加: validFrom に未到達で落ちた */ break;
  default: {
    const exhaustive: never = omission.condition;
    throw new Error(`unhandled condition: ${exhaustive}`);
  }
}
```

根拠: [ADR 0164](./decisions/0164-valid-from-until-recall.md)。

### 5. ⭐ `Runtime.getRecall` が必須メソッドになった

**⚠ 根拠 ADR（[ADR 0161](./decisions/0161-runtime-get-recall.md)）にも、この変更を
導入した commit にも、破壊的変更である旨の言及が無い。この移行ガイドが唯一の告知である。**

**誰が影響を受けるか**: `Runtime` interface を**自分で実装している**場合——
`createRuntime()`（`@mnemora/core`）で組み立てた `Runtime` をそのまま使っているだけなら
影響しない（`createRuntime()` は v0.2.0 で `getRecall` を実装済みで返す）。自分で
`Runtime` を実装するのは主に次のようなケース: テストのための mock/stub、`Runtime` を
ラップする独自の facade、`Runtime` interface に依存するが `createRuntime()` を経由しない
独自実装。

**何をすればよいか**: 次のメソッドを実装する。多くの場合、`MemoryStore.getRecall` への
単純な委譲でよい（`createRuntime()` 自身の実装がまさにこの形）。

```ts
async getRecall(ctx: Ctx, recallId: RecallId): Promise<RecallRecord | null> {
  return this.memoryStore.getRecall(ctx, recallId);
}
```

契約は `MemoryStore.getRecall`（上記1番）と同じ——見つからない・別テナントなら
`null`、例外にしない。

### 6. ⭐ `TenantSettingsStoreConformanceOptions.supportsDecayClock`（`@mnemora/testkit`）が必須フィールドになった

**⚠ 根拠 ADR（[ADR 0165](./decisions/0165-decay-activity-clock.md)）は当初「この PR
全体が非破壊である」と書いていたが、それは誤りだった——ADR 本文の「🔴 訂正」節で
自己訂正されている。この移行ガイドと CHANGELOG がその訂正の反映先である。**

**誰が影響を受けるか**: `@mnemora/testkit` の `describeTenantSettingsStoreConformance(...)`
を、自作の `TenantSettingsStore` adapter のテストから呼んでいる場合。`@mnemora/postgres`/
`@mnemora/testkit` 同梱の実装をそのまま使っているだけなら影響しない。

**何をすればよいか**: 呼び出しに `supportsDecayClock: boolean` を追加する。

```ts check
import { describeTenantSettingsStoreConformance } from "@mnemora/testkit";

describeTenantSettingsStoreConformance({
  name: "my-tenant-settings-store",
  createStore: () => new MyTenantSettingsStore(),
  // v0.2.0 で必須になった:
  supportsDecayClock: false, // 自作 adapter が getDecayClock/setDecayClock/
                              // getDefaultHalfLifeRecalls/getActivitySeq を実装していないなら false
  supportsEraseTenant: false, // v1.2.0 から必須（項目31）
});
```

- 自作 adapter が `TenantSettingsStore` の4つの**任意**メソッド
  （`getDecayClock`/`setDecayClock`/`getDefaultHalfLifeRecalls`/`getActivitySeq`、
  いずれも `?` 付きで非破壊に追加された）を実装していないなら、**`supportsDecayClock: false`
  を渡すだけでよい**——4メソッドはもともと任意なので、実装していないこと自体は
  v0.1.9 から変わっていない。
- 実装している場合は `supportsDecayClock: true` にし、追加のフック
  （`setDefaultHalfLifeRecalls`/`advanceActivitySeq`、いずれも任意）も検討する
  （`packages/testkit/src/tenant-settings-store-conformance.ts` の doc コメント参照）。

⚠ **2026-09-25〜26 の一時期、`main` 上で `supportsTaxonomyMode`・
`@mnemora/testkit` の `MemoryStoreConformanceOptions.supportsLabels`（どちらも PR #717）と
`supportsFindActiveByClaimKey`（PR #745）も必須になっており、この例やそれに類する
呼び出しがコンパイルできなくなっていた。**[Issue #818](https://github.com/takecchi/mnemora/issues/818)
の結果、3つとも `?: boolean` へ戻し、省略時は該当する適合項目を実行しないようにしたため
（`false` 相当）、**この例は再びそのままコンパイル・実行できる**
（[ADR 0318](./decisions/0318-taxonomy-labels.md) /
[ADR 0324](./decisions/0324-claim-key-contested-detection.md) の追記）。

### 7. `RecallFootprintEstimate.associationCount`（`@mnemora/core`）が必須フィールドになった

**【実測】2026-09-16、PR #336 の着地後に現物（`packages/core/src/recall-footprint.ts`）で
確かめた**: 返り値の `RecallFootprintEstimate.associationCount: number` は `:392` で**必須**、
入力の `RecallFootprintShape.associationCount?: number` は `:368` で**省略可能**、
省略時の既定は `:463` の `Math.max(0, shape.associationCount ?? 0)` である。

**誰が影響を受けるか**: **読むだけ・呼ぶだけの利用者には非破壊。**
`estimateRecallFootprint()`/`compareWithFullLog()` を呼んで戻り値を読んでいるだけなら
影響しない。**`RecallFootprintEstimate` 型のオブジェクトを自分でリテラルとして
組み立てている場合だけ**、コンパイルが壊れる。

**何をすればよいか**: 自分で構築している場合は `associationCount: number` を追加する。
入力側（`estimateRecallFootprint` への引数）は省略可能フィールドとして追加されており、
**省略すれば `0` として扱われる**（非破壊）。

---

## 🔴 破壊的変更（v0.2.0 → v0.3.0）—— **8〜10。⚠ 3件とも出荷済み**

⚠ **この節の 8〜10 と、次の節の 11 は同じ世代である**（`v0.2.0` → `v0.3.0`）。節が2つに
分かれているのは **11 以降を後から数え直して足した**という経緯によるもので、⛔ **世代の境目ではない**
——境目は **11** と **12** のあいだに在る。

**壊れ方が2種類ある:**

- **9・10 は「返り値の型に必須フィールドが増えた」形**（どちらも `@mnemora/core`）。
  ⟹ **読むだけ・消費するだけなら影響しない。**自分で組み立てている側だけがコンパイルで落ちる。
- 🔴 **8 は「公開クラスのメソッドの署名が変わった」形**（`@mnemora/testkit`）。
  ⟹ **呼んでいれば壊れる。**同期から `Promise` へ変わったので、**引数を直すだけでは足りない。**

⚠ **`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/postgres` に破壊的変更は無い。**
🔴 **`@mnemora/local-embedding` は違う**——`LocalEmbeddingPipeline` が関数型から必須 `interface` へ
変わっている（下の **11**）。

⭐ **一覧と根拠 ADR は、この文書の番号付きの項目そのものが正本である。**
⛔ **[CHANGELOG.md](../CHANGELOG.md) の `[1.0.0]` へ送らないこと**——同節は `v0.4.0` 以降を
pin しており（節自身がそう名乗っている）、**この世代の破壊的変更を1件も持っていない。**
⭐ **CHANGELOG 側でこの世代に当たるのは `[0.3.0]` 節の `### Breaking` である**
——⚠ **あちらはこの一覧の 8〜11 の写しであって、正本はこちらである。**
⭐ **12〜17 に当たるのは `[0.4.0]` 節の `### Breaking` である**（同じく写しである）。

⚠ **ここで「破壊的」と呼んでいるもの**: **`scripts/publish-targets.mjs` の `PUBLISH_TARGETS` 6パッケージの
公開契約について、既存の利用者のコードが型検査または実行時に壊れる変更**
（`examples/chat` は `private` なので数えない）。
⛔ **`packages/*/src` の差分では数えないこと**——マイグレーションの追加のように `src` を1行も
触らない変更を取りこぼす（[docs/release-v1.md](./release-v1.md)「⚠ 「`packages/*/src` の差分を
数える」では取りこぼす」）。⟹ **公開 API の実 diff（`scripts/__snapshots__/public-api/`）から数えること。**

#### ⭐ 数え方の規律への追記（2026-09-28。オーナーの回答）

⚠ **この追記は、オーナーの回答をクローン miku の委譲先が書き写したものである。**回答そのものは下の2つの問いへの答えで、当てはめ方の判断（「当たるもの」の範囲・遡って数え直さないこと）は委譲先のものである。

1. **公開の union 型に値を足す変更は、破壊的変更として数えない**（オーナーの回答（ask_human `d9364c91`）、[Issue #541](https://github.com/takecchi/mnemora/issues/541)）。
   - 当たるもの: `MemoryEventKind` とその zod enum `MemoryEventKindSchema`・`Omission.kind`・`FilteredOmission.condition`・`GroupCount.axis` などの union に、値を足す変更。網羅的に分岐している（`never` で検査している）コードは型検査で落ちうるが、それでも数えない。
   - ⛔ 当たらないもの: union から値を**減らす**・型を狭める変更は、これまでどおり破壊的と数える。必須メンバの追加など、union の値の追加でない形も、これまでどおり上の定義で数える。
   - この規律より前に数えた項目（**4**〈`FilteredOmission.condition`〉と **17**〈`MemoryEventKind` の `"unsuperseded"`〉、CHANGELOG の `[0.2.0]`・`[0.4.0]` 節の `### Breaking` の写し）は、その版を出荷したときの数え方の記録として残し、**遡って数え直さない**。冒頭の表の件数も変えない。
2. **公開の fixture（`@mnemora/testkit/fixtures` の InMemory 一式）が、これまで受け入れていた不正な入力に新しく例外を投げる変更は、破壊的変更として数えない**（オーナーの回答（ask_human `3f3411c5`））。
   - 当たるもの: `v1.0.0` → `v1.0.1` の PR #811・#813・#815（問いが直接名指した3件）、`v1.0.1` → `v1.0.2` の節の 🔴 に挙げたもの（PR #923・#928・#1058・#1059・#1061・#1073・#1095。ほかに CHANGELOG の `[1.0.2]` 節で同じ「保留」の ⚠ を付けた項目も）、`v1.0.2` → 次の版の PR #1135・#1157・#1165・#1170・#1183・#1190・#1243・#1250・#1252・#1265・#1270・#1280（CHANGELOG の `[1.1.0]` 節の追記19）。⟹ **下の各世代の「計上を保留しているもの」は、どれも番号付きの一覧に足さない。**
   - ⛔ 当たらないもの: fixture 以外の公開の場所（本物の adapter・`@mnemora/core`）が新しく例外を投げる変更と、conformance スイートの判定を厳しくする変更。これらは、これまでどおり上の定義と各世代の分け方で数える。
   - CHANGELOG の `[1.0.1]`・`[1.0.2]` 節は出荷済みなので、そこに書かれた「保留」「未決」は書き換えていない。この規律が優先する。

### 8. ⭐ `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls`（`@mnemora/testkit`）のシグネチャが変わった

**【現物】2026-09-17、ADR 0197（Issue #338 の第1弾）で変わった**:

```diff
-setDefaultHalfLifeRecalls(tenantId: string, recalls: number): void
+setDefaultHalfLifeRecalls(ctx: Ctx, recalls: number): Promise<void>
```

**なぜ変わったか**: `TenantSettingsStore` に本番の口 `setDefaultHalfLifeRecalls?(ctx, recalls)`
が足された（ADR 0197）。`InMemoryTenantSettingsStore` は `TenantSettingsStore` を
`implements` しているため、**同名で引数の形が違う旧テスト専用フックと共存できない。**
⟹ 旧フックを削除し、本番の口だけを残した。**回避できる形は無い**——名前の衝突そのものが
原因であり、旧フックを別名へ寄せる案も「旧名の削除」である点は変わらない。

**誰が影響を受けるか**: **`InMemoryTenantSettingsStore` を `TenantSettingsStore` として
構築して渡しているだけなら影響しない。** `setDefaultHalfLifeRecalls` を
**旧シグネチャで直接呼んでいる場合だけ**、コンパイルが壊れる。

**何をすればよいか**:

```diff
-store.setDefaultHalfLifeRecalls(tenantId, 3000);
+await store.setDefaultHalfLifeRecalls({ tenantId }, 3000);
```

第1引数が `Ctx` になり、**戻り値が `Promise` になったので `await` が要る。**
値域は `(0, ∞)`（有限の正の実数。`isHalfLifeRecallsInRange`）で、外れた値は
`HALF_LIFE_RECALLS_INVALID_MESSAGE` を含む `Error` で**拒まれる**——旧フックは
検証していなかったので、**0・負・`NaN`・`Infinity` を渡していたテストは落ちるようになる。**

⚠ **この変更は `@mnemora/core` と `@mnemora/postgres` には及ばない**（どちらも非破壊。
interface 側は `?` 付きの追加、`PostgresTenantSettingsStore` はメソッドの追加のみ）。
パッケージごとの内訳は ADR 0197「破壊的変更か否か」の表にある。

---

### 9. `FilteredOmission` に必須フィールド `scopeRelation` が増えた（`@mnemora/core`）

**誰が影響を受けるか**: `FilteredOmission` を**自分で組み立てている**場合だけ
——自作 adapter の `aggregateScope` 実装や、`omitted` を作るテストダブルなど。
⭕ **`recall()` の戻り値を読むだけなら影響しない。**

**何をすればよいか**: `scopeRelation` を足す。⭐ **値を自分で決めないこと**——
`condition` から引く公開定数が `@mnemora/core` に在る。

```diff
+import { FILTERED_CONDITION_SCOPE_RELATION } from "@mnemora/core";

 omitted.push({
   kind: "filtered",
   condition,
+  scopeRelation: FILTERED_CONDITION_SCOPE_RELATION[condition],
   count,
   countKind,
 });
```

⚠ **式を手で書き写さないこと。**`FilteredOmission.scopeRelation` の doc コメントが逐語で
「**`FILTERED_CONDITION_SCOPE_RELATION` である——ここでは決めない・重複させない
（式を2箇所に書くと必ずずれる、ADR 0038 が実測した穴）**」と書いている。

**何を意味する欄か**: `decayed` **だけ**が `totalInScope` の**内側**を数える
（`"within_scope"`）という非対称を、契約として名乗るための欄である。他の condition は
すべて `"outside_scope"`。⟹ **この非対称は以前から在ったが、型としては見えていなかった。**

根拠: [Issue #352](https://github.com/takecchi/mnemora/issues/352) /
[ADR 0174](./decisions/0174-filtered-omission-scope-relation.md)。

---

### 10. `Omission` の `over_limit` に必須フィールド `stage` が増えた（`@mnemora/core`）

**誰が影響を受けるか**: `OverLimitOmission` を**自分で組み立てている**場合だけ。
⭕ **`omission.count` を読むだけなら影響しない。**

**何をすればよいか**: `stage` を足す。値は2つで、**どちらで切ったかで決まる**:

```diff
 omitted.push({
   kind: "over_limit",
+  stage: "rescore",       // 段2 の limit で打ち切った分
   count,
   countKind,
 });
```

| 値 | いつ |
|---|---|
| `"rescore"` | **段2 の `RecallQuery.limit` で打ち切った**分（従来から在った唯一の経路） |
| `"association"` | **連想枠（段3.5）の `RecallAssociationQuery.maxCount` で切り捨てた**分 |

⭐ **従来の `over_limit` はすべて `"rescore"` に相当する。**⟹ **既存のコードは
`stage: "rescore"` を足せば意味が変わらない。**

**なぜ増えたか**: 連想枠の切り捨てを段1 の打ち切りと**区別して名乗る**ため。
⚠ **区別が要る理由は、次の一手が違うからである**——`"rescore"` は `limit` を上げれば減るが、
`"association"` は `limit` では直らない（切り捨ての件数を決めているのは `maxCount` だけである）。

根拠: [Issue #375](https://github.com/takecchi/mnemora/issues/375) /
[ADR 0188](./decisions/0188-association-over-limit-omission.md)。

---

---

## 🔴 破壊的変更 —— **11〜17。⚠ 11 は `v0.3.0`、12〜17 は `v0.4.0` で出荷済み**

⚠ **世代の境目はこの節の中に在る**——**11 は `v0.2.0` → `v0.3.0`（出荷済み）**、
**12〜17 が `v0.3.0` → `v0.4.0`（🔴 これも出荷済みである）**である。
⚠ **2026-09-19 まで、この節は 12 以降を「未リリース」と書いていた。**`v0.4.0` は 2026-09-18T20:36Z に
published されており、**その時点で誤りになっていた**（経緯は上の「訂正の履歴」）。
⭐ **CHANGELOG 側でこの世代に当たるのは [CHANGELOG.md](../CHANGELOG.md) の `[0.4.0]` 節の
`### Breaking` である**——⚠ **あちらはこの一覧の 12〜17 の写しであって、正本はこちらである。**
**公開 API の実 diff**（`v0.2.0` の `.d.ts` と `main` の `scripts/__snapshots__/public-api/*.d.ts` の
比較）から拾った——⛔ **`src` の差分では数えていない**（理由は上の節の末尾）。

**壊れ方は2つの形に分かれる:**

- 🔴 **11 は「署名そのものが変わった」形** ⟹ **呼んでいる側も、自前で渡していた側も壊れる。**
- **12〜16 は「`interface` に必須メンバが増えた」形** ⟹ **その `interface` を自分で実装している側だけが壊れる。**
  ⭐ **`mnemora` が提供する実装をそのまま使っているなら、何もしなくてよい。**
  ⚠ これは新しい判定基準ではない——上の **1**・**5**・**6** が同じ理由で破壊的と数えられている。

### 11. 🔴🔴 `LocalEmbeddingPipeline`（`@mnemora/local-embedding`）が関数型から必須 `interface` になった

**⚠ 既に `v0.3.0` で出荷済み。**
**【実測 2026-09-18、`main` = `93a083eb41eb480121ff897f8bbbd80d10631b12`】**
`git merge-base --is-ancestor b84f120 v0.3.0` は**真**（`b84f120` = この変更を運んだ PR #446 の squash）。
⟹ **この節で最も急ぐ項目である。**

**誰が影響を受けるか**: `LocalEmbeddingPipeline` を**呼んでいる**側と、**自前で渡していた**側の両方。

**何が変わったか**: 呼び出し可能な関数型だったものが、`countTokens` / `embed` / `maxInputTokens` を
要求する `interface` になった（[#137](https://github.com/takecchi/mnemora/issues/137) /
[ADR 0205](./decisions/0205-local-embedding-pipeline-required-interface.md)、PR #446）。

**どう直すか**: 関数を1つ渡していた箇所を、3つのメンバを持つオブジェクトに置き換える。
⚠ **引数を直すだけでは足りない**——渡すものの形が変わっている。詳細は ADR 0205 を見ること。

### 12. `Runtime` に必須メソッド `restoreSuperseded` が増えた（`@mnemora/core`）

⚠ **`v0.4.0` で出荷済みである**（`v0.3.0` には入っていない）。
**【実測 2026-09-19、`origin/main` = `420e0f4`】** `git merge-base --is-ancestor ba9f9a1 v0.4.0` は**真**、
`… v0.3.0` は**偽**（`ba9f9a1` = この変更を運んだ PR #464 の squash）。
⚠ **【実測 2026-09-18、`main` = `93a083eb41eb480121ff897f8bbbd80d10631b12`】**の時点では
npm の `@mnemora/core@0.3.0` の `dist/*.d.ts` にも `restoreSuperseded` は無かった
——**`v0.3.0` から上げる人にとっては、いまも破壊的変更である。**

**誰が影響を受けるか**: `Runtime` interface を**自分で実装している**場合だけ
（`createRuntime()` が返すものを使っているなら影響なし）。

**どう直すか**: `restoreSuperseded(ctx, target, opts?)` を実装する。
`superseded` を `active` へ戻す復旧口である（[ADR 0230](./decisions/0230-restore-superseded-recovery-path.md)、PR #464）。

⚠ **ADR 0230 の *本文* は、これが破壊的であることに触れていない。**
⟹ 2026-09-18、ADR 0230 に「🔴🔴 訂正2」が追記されて名指しされた（PR #530）が、
⛔ **本文だけを読むといまも気づけない**ので、ここに書く。
⚠ **その追記は「`v0.3.0` で既に出荷されている」と書いている。それも誤りである**
——同じ 2026-09-18 に、ADR 0230 へさらに訂正を積んだ。

### 13. `MemoryStoreConformanceOptions.supportsRestoreSupersededBy` が必須フィールドになった（`@mnemora/testkit`）

⚠ **`v0.4.0` で出荷済みである**（`v0.3.0` には入っていない）。**12 と同じ commit（`ba9f9a1`、PR #464）で入っており、
根拠も 12 と同じ**——npm の `@mnemora/testkit@0.3.0` の `dist/*.d.ts` に
`supportsRestoreSupersededBy` は無い。

**誰が影響を受けるか**: `@mnemora/testkit` の `MemoryStore` 適合テストを**呼び出している**場合
（独自 adapter の作者）。

**どう直すか**: 適合テストへ渡すオプションに `supportsRestoreSupersededBy: boolean` を足す。
`MemoryStore.restoreSupersededBy` を実装していないなら `false` を渡す。

🔴 **この項目は、2026-09-18 まで `CHANGELOG.md` にも ADR にも一度も書かれていなかった。**
⟹ **印を持たない破壊的変更の実例である。**

### 14. `Runtime` に必須メソッド `findCorrectionCandidates` が増えた（`@mnemora/core`）

⚠ **`v0.4.0` で出荷済みである**（`v0.3.0` には入っていない）。
**【実測 2026-09-19、`origin/main` = `420e0f4`】** `git merge-base --is-ancestor 96106c8 v0.4.0` は**真**、`… v0.3.0` は**偽**
（`96106c8` = この変更を運んだ PR #517 の squash）。

**誰が影響を受けるか**: **12 と同じ**（`Runtime` を自分で実装している場合だけ）。

**どう直すか**: `findCorrectionCandidates(ctx, input)` を実装する。訂正の相手の**候補を返す**口であり、
⛔ 書き込みを1件もせず、LLM を1回も呼ばない（[ADR 0232](./decisions/0232-correction-candidates-returned-not-chosen.md)、PR #517）。

### 15. `MemoryStoreConformanceOptions.supportsPreviewRestoreSupersededBy` が必須フィールドになった（`@mnemora/testkit`）

⚠ **`v0.4.0` で出荷済みである**（`v0.3.0` には入っていない）。
**【実測 2026-09-19、`origin/main` = `420e0f4`】** `git merge-base --is-ancestor c5d022e v0.4.0` は**真**、`… v0.3.0` は**偽**
（`c5d022e` = この変更を運んだ PR #524 の squash）。

**誰が影響を受けるか**: **13 と同じ。**

**どう直すか**: 適合テストへ渡すオプションに `supportsPreviewRestoreSupersededBy: boolean` を足す
（[ADR 0237](./decisions/0237-restore-superseded-dry-run-preview.md)、PR #524）。

### 16. `Runtime` に必須メソッド `applyCorrection` が増えた（`@mnemora/core`）

⚠ **`v0.4.0` で出荷済みである**（`v0.3.0` には入っていない）。
**【実測 2026-09-19、`origin/main` = `420e0f4`】** `git merge-base --is-ancestor dc995fa v0.4.0` は**真**、`… v0.3.0` は**偽**
（`dc995fa` = この変更を運んだ PR #537 の squash）。

**誰が影響を受けるか**: **12・14 と同じ**（`Runtime` interface を自分で実装している場合だけ。
`createRuntime()` が返すものを使っているなら影響なし）。

**どう直すか**: `applyCorrection(ctx, input)` を実装する。**`findCorrectionCandidates` が返した
候補の中から人が選んだ1件**を受け取り、`markContested` → `resolveContested` の書き込みまでを
1つの口にまとめたものである（[ADR 0242](./decisions/0242-runtime-apply-correction.md)、PR #537）。
⭐ **ADR 0242 自身が破壊性を申告している**——逐語「**`Runtime` を自前で実装している側には
破壊的変更である**」。⚠ **同 ADR は「この ADR では `CHANGELOG.md`/`docs/migration-v1.md` を
一切変更していない」とも書いている**——⟹ **この項目は、そこで先送りされた分をここへ積んだものである。**

### 17. `MemoryEventKind` の union に `"unsuperseded"` が増えた（`@mnemora/core`）

⚠ **`v0.4.0` で出荷済みである**（`v0.3.0` には入っていない）。**12・13 と同じ PR #464（`ba9f9a1`）で入っている。**
**【実測 2026-09-19、`origin/main` = `420e0f4`】**

```diff
-export type MemoryEventKind = "created" | … | "restored";
+export type MemoryEventKind = "created" | … | "restored" | "unsuperseded";
```

⚠ **12〜16 とは壊れ方が違う**——あちらは「`interface` に必須メンバが増えた」形で、
**実装する側**だけが壊れた。**こちらは union に値が増えた形で、消費する側が壊れる。**

**誰が影響を受けるか**: **`MemoryEvent.kind` を網羅的に分岐している側**
（`switch` の `default` で `const _x: never = event.kind` を書いているコード）。
⭕ **値を読むだけ・比較するだけなら非破壊。**

⟹ **経路は公開面に在る**【実測】:
`MemoryEvent.kind` は**必須**フィールドであり、`EventStore.append` / `.get` / `.list` が
`MemoryEvent` / `MemoryEvent[]` を返す（`scripts/__snapshots__/public-api/core.d.ts`）。
そして `RuntimeDeps.eventStore: EventStore` なので、**`createRuntime()` を呼ぶ利用者は
必ず `EventStore` を自分で組み立てて握っている**（`@mnemora/postgres` は
`PostgresEventStore` を export しており、`.list()` の返り値がそのまま届く）。
⚠ **`Runtime` の口からは届かない**——【実測】`Runtime` の17メンバに `MemoryEvent` を返すものは1つも無い。
⟹ ⭐ **「5つの動詞だけを使う利用者」には影響しない。**

**どう直すか**: `"unsuperseded"` の分岐を足す。
`Runtime.restoreSuperseded` が `superseded` を `active` へ戻したときに積む種別である
（[ADR 0230](./decisions/0230-restore-superseded-recovery-path.md)、PR #464）。
⚠ **`MemoryEventKindSchema`（export された zod enum）にも同じ値が増えている**
——この schema で `parse` している側は、**新しい値を通すようになる。**

**⚠ この項目を立てた根拠と、確かめていないこと**:
⭐ **同じ形を `[0.2.0]` の Breaking 表 `4`（`FilteredOmission.condition` の union 拡張）が
破壊的と数えている**——どちらも**出力側の型の union に値が増えた**形で、向きが同じである。
🔴 **⚠ だが同じ `[0.2.0]` は、`TICK_SUPPORTED_JOB_KINDS` の2値→4値を
「Changed（後方互換だが挙動が変わりうるもの）」に置いている**——逐語で
「**網羅性検査（`never`）をしているコードは壊れる**」と書きながら、である。
⟹ ⛔ **この repo には、同じ形に対する扱いが2つ在り、線は引かれていない。**
この項目は**前者（Breaking 側）に揃えた**が、**その線そのものは
[Issue #541](https://github.com/takecchi/mnemora/issues/541) に残っている。**
⛔ **外部の利用者が実際に網羅的分岐を書いているかは観測していない**——
これは 12〜16 を破壊的と数えている前提（`Runtime` を自前実装している人が居るか）と同じ限界である。

⭕ **2026-09-28 追記**: 線は引かれた——**union に値を足す変更は、破壊的変更として数えない**（オーナーの回答（ask_human `d9364c91`）、[Issue #541](https://github.com/takecchi/mnemora/issues/541)）。上の「数え方の規律への追記（2026-09-28）」を参照。⟹ この項目 **17** と **4** は、`v0.4.0`・`v0.2.0` を出荷したときの数え方の記録として残し、遡って一覧から外さない（冒頭の表の件数も変えない）。これから union に値を足す変更は、番号付きの一覧に足さない。

---

## 🔴 破壊的変更（v0.4.0 → v0.5.0）—— **18。⚠ 出荷済み**

⭐ **1件である。**⭕ **`v0.4.0` と `v0.5.0` の両端が tag で閉じているので、`main` が動いてもこの数は変わらない。**

🔴 **この世代は、1〜17 と壊れ方の種類が違う。**

| | **1〜17** | **18** |
|---|---|---|
| どこで壊れるか | **型検査**（`interface` に必須メンバが増えた／union に値が増えた／署名が変わった） | 🔴 **実行時**（コンストラクタが `throw` するようになった） |
| 公開 API の型 | 変わった | ⭕ **1バイトも変わっていない** |

**【実測 2026-09-21】**
`git diff --stat v0.4.0..v0.5.0 -- scripts/__snapshots__/public-api/` は**差分を返さない。**
⚠ **それでもこの文書は破壊的として数える**——**この文書自身の定義が、逐語で
「既存の利用者のコードが型検査または実行時に壊れる変更」だからである**
（上の「⚠ ここで「破壊的」と呼んでいるもの」）。

### 18. `LocalEmbeddingProvider` のコンストラクタが、`repo` だけ差し替えた宣言を落とすようになった（`@mnemora/local-embedding`）

⚠ **`v0.5.0` で出荷済み。**
**【実測 2026-09-21】** `git merge-base --is-ancestor a6caef1 v0.5.0` は**真**、
`git merge-base --is-ancestor a6caef1 v0.4.0` は**偽**である
（`a6caef1` = この変更を運んだ [PR #550](https://github.com/takecchi/mnemora/pull/550) の squash）。
⟹ **`v0.4.0` 以前から上げる人が踏む。`v0.5.0` を使っているなら、もう踏んでいる。**

**誰が影響を受けるか**: 🔴 **`new LocalEmbeddingProvider({ repo: … })` に既定と異なる `repo` を渡し、
かつ `modelId` を渡していなかった場合だけ。**
⭕ **`repo` を渡していない（既定のまま使っている）なら、何もしなくてよい。**

⭐ **範囲は狭いが、届く深さは浅い。**`LocalEmbeddingProvider` のコンストラクタは
`createRuntime()` へ渡す provider を組み立てる**公開の口**であり、
`observe`/`recall` など5つの動詞しか使わない利用者でも、**組み立てのために必ず通る場所**である
——この点が、`EventStore` 経由でしか届かない **17** とは違う。

⚠ **該当していた人は、元から壊れていた側である。**`space.model` は `options.modelId` からしか
作られず、`options.repo` は反映されない ⟹ `repo` だけ差し替えると**別のモデルのベクトルが
同じ space（`EmbeddingSpaceId`。テーブル名スラグの導出元）へ静かに混ざり、後から分けられなかった。**
⟹ ⭐ **この変更が変えたのは、その混入を「静かな破損」から「その場で止まる例外」へ移したことである。**

**どう直すか**: `modelId` を明示的に渡す。
[ADR 0247](./decisions/0247-local-embedding-repo-model-id-declaration-guard.md) 決定3 が逐語でこう書いている:

> 同じ重みの私設ミラー（`repo` だけ変え、モデルの実体は同じ）を使いたい人は、既定と同じ `modelId`
> （`DEFAULT_LOCAL_EMBEDDING_MODEL_ID`）を明示的に渡せば通る。別のモデルを使う人は、
> そのモデルを名乗る別の `modelId` を渡すことになる

#### ⛔ これは [Issue #142](https://github.com/takecchi/mnemora/issues/142) を閉じた変更ではない

#142 は**2件**を名指ししており、**①「実 API に一度も当てていない」は手つかずで残っている**
（`OPENAI_API_KEY` が要る）。⟹ **#142 はいまも OPEN である**【現物】。
⚠ **②についても、#142 本文自身が、今回採った形（案(い)）について逐語で
「宣言どうしの整合しか見ないので、『宣言と実物』のずれは相変わらず見えない」と書いている。**
⟹ ⭐ **この項目が言えるのは「出荷される挙動がこう変わった」までである。**

---

## 🔴 破壊的変更（v0.5.0 → v1.0.0）—— ⚠ **出荷済み。0件のまま出荷された**

⭐ **両端が tag で閉じたので、この節はもう更新されない。**`v1.0.0` は
**2026-09-22T23:54:08Z に published**（`gh release view v1.0.0` で `isDraft: false`・
`isPrerelease: false` を確認）、`git diff --stat v0.5.0..v1.0.0 -- packages/` も
`-- scripts/__snapshots__/public-api/` も**差分を返さない**——
**この世代に着地した破壊的変更は、最後まで0件だった。**

🔴 **空である理由は「まだ着地していなかった」ではない。**`v0.5.0` タグを切った時点で
`v0.5.0` と当時の `origin/main` が同じ commit（`509f4e7`）を指しており、
**この世代を起こした時点で数える範囲そのものが空だった**——その後 `v1.0.0` が切られるまでに
着地した29本の commit（`git log --oneline v0.5.0..v1.0.0`）のうち、`scripts/publish-targets.mjs` の `PUBLISH_TARGETS`（6パッケージ）
を触ったものは1本も無かった。

⚠ **判定に使った手順・使ってはいけない手順（`git rev-list --count` 等とその理由）の詳細は、
上の「訂正の履歴」の「2026-09-21（2回目）の訂正」に残してある**（ここでは複製しない）。

⚠ **`v1.0.0` より後に着地した破壊的変更の節は、まだここに無い。**理由は冒頭と **6** の末尾に
書いたとおり——一時的に必須化されていた3件（`supportsTaxonomyMode`/`supportsLabels`/
`supportsFindActiveByClaimKey`）は [Issue #818](https://github.com/takecchi/mnemora/issues/818)
の結果すべて任意へ戻したため、この3件を理由に次の節を起こす必要は無くなった。**この3件
以外に `v1.0.0` より後に着地してまだ数えていない変更が残っているかどうかは、別途棚卸しが
要る。**

⭐ **この「別途棚卸し」の候補一覧を、実行時に出す道具が `scripts/public-api-breaking-diff.mjs`
である**（Issue #818 / `#811`/`#813`/`#815`）。**候補であって判定ではない**——検出する5形・
検出しない形（型に現れない実行時だけの意味変更である `#811`/`#813`/`#815` を含む）は
同スクリプト冒頭のコメントに書いてある。**この節・番号付きの一覧への計上（確定と書き込み）は、
この道具が出す候補を人が読んでから行う**——道具自身は `docs/migration-v1.md` を書き換えない。

## 🔴 破壊的変更（v1.0.0 → v1.0.1）—— ⚠ **出荷済み。0件（保留していたものは、破壊的と数えないと決まった）**

`v1.0.1` は **2026-09-25T21:16:41Z に published**（`gh release view v1.0.1` で `isDraft: false`・`isPrerelease: false`、tag が指す commit は `cf11cd6`）。**両端が tag で閉じたので、この世代の範囲はもう動かない。**

**型の上**: `git diff v1.0.0..v1.0.1 -- scripts/__snapshots__/public-api/` の削除行は、zod スキーマの欄の並べ替え・`import type` 一覧への型名の追加・任意の末尾引数を足したことによる再フォーマットだけであり、削除・必須化・型の狭小化は無い（[CHANGELOG.md](../CHANGELOG.md) の `[1.0.1]` 節の判定をそのまま写した）。

🔴 **計上を保留しているもの**: PR #811 / #813 / #815——`@mnemora/testkit/fixtures` の擬似ストアが、これまで黙って受け入れていた不正な入力（負数・`NaN`・`Infinity`・非整数の `limit`、float4 の範囲外の値）に対して例外を投げるようになった。型には現れないが、公開の fixture を直接使う利用者には実行時に壊れうる。**破壊的変更として扱うかは、オーナーへの問い（ask_human `3f3411c5`、未回答。論点は [Issue #809](https://github.com/takecchi/mnemora/issues/809)）として未決である。**答えが「扱う」なら、この3件は番号付きの一覧に足す。

⭕ **2026-09-28 追記**: 答えは「扱わない」だった（オーナーの回答（ask_human `3f3411c5`））。⟹ この3件は番号付きの一覧に足さず、この世代の破壊的変更は0件である。上の「数え方の規律への追記（2026-09-28）」を参照。

**DB マイグレーション**: `0019`〜`0021` の3本が増えている（`0019_observations_memories_attributes.sql`・`0020_taxonomy_labels.sql`・`0021_memories_claim_key.sql`）。

## 🔴 破壊的変更（v1.0.1 → v1.0.2）—— ⚠ **出荷済み。0件（保留していたものは、破壊的と数えないと決まった）**

`v1.0.2` は **2026-09-27T01:58:27Z に published**（tag が指す commit は `b981ecd`、PR #1098。npm の `@mnemora/core` の `dist-tags.latest` は `1.0.2`、2026-09-27T02:05:56Z 公開）。**両端が tag で閉じたので、この世代の範囲はもう動かない。**

⚠ **2026-09-27 訂正**: この節は `v1.0.2` の出荷の前に「v1.0.1 → 次の版（未リリース）」として書いたものである。数えた範囲（下の `v1.0.1`…`3a8448c`）は `v1.0.2` を含み、`b981ecd` より後の PR #1100・#1102・#1103 は docs・テストだけだった。⟹ 下の一覧は、どれも `v1.0.2` に入って出荷された変更である。計上を保留していたもの（下の 🔴）も出荷されたが、⛔ オーナーがそれを破壊的変更と数えたかどうかは記録から分からない（問い `3f3411c5` は未回答）。以下の本文は、この訂正の前に書いたままである。（⭕ 2026-09-28 追記: 問い `3f3411c5` の答えは「扱わない」だった。下の 🔴 の保留は、どれも破壊的変更と数えない。上の「数え方の規律への追記（2026-09-28）」）

⛔ **（当時）次の版の tag はまだ切られていなかった。**この節は `v1.0.1`（`cf11cd6`）… **`3a8448c`**（PR #1103）の範囲を数えたものである（2026-09-27 の2回目の棚卸しで `951ad44` から広げた）。`main` がこれより進めば、数えていない範囲が増える——**件数はこの節にも冒頭の表にも書かない。**

**型の上**: `git diff dce0f71..951ad44 -- scripts/__snapshots__/public-api/` は追加だけで、削除行は0だった（`dce0f71` までの分は [CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` 節が判定済み）。足されたのは任意のメソッド（`reinforceMany?`・`recordUsageAndReinforce?`・`resolveOrphanedContested?`・`searchMany?`）、任意の欄（`basisLost?`・`externalId?`）、新しい型と関数である。`git diff 951ad44..3a8448c -- scripts/__snapshots__/public-api/` も追加だけで、`@mnemora/postgres` の公開関数 `buildLexicalSearchSelect`/`buildTrigramLexicalSearchSelect` に任意の `ctxTenantId?` が増えたことと、引数名の変更（`_ctx` → `ctx`）だけである。

**実行時**: 次の2種類に分けた。

- 🔴 **計上を保留しているもの**——公開の fixture が、これまで受け入れていた不正な入力に新しく例外を投げるもの（オーナーへの問い `3f3411c5` の射程）。上の世代の PR #811/#813/#815 と同じ論点であり、**同じ問い（ask_human `3f3411c5`、未回答）の答えを待つ。**（⭕ 2026-09-28 追記: 答えは「扱わない」だった。オーナーの回答（ask_human `3f3411c5`）。下の一覧は破壊的変更と数えない）この基準は当初「…または公開の fixture の結果が変わるもの」と書いていたが、2026-09-27 にクローン miku の判断で狭めた（[CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` 節の前書きの訂正）。
  - `@mnemora/testkit/fixtures` の `InMemoryMemoryStore` が、Postgres の拒む入力（`archiveDecayed` の不正な `limit`・`reinforce` の Invalid Date・float4 の範囲外の `halfLifeHours`・NUL を含む文字列）で例外を投げるようになった（Issue #880・#807・#817・#816、PR #923・#928）。
  - `@mnemora/testkit/fixtures` の `InMemoryMemoryStore.requeueEmbedJobs` が、Postgres の拒む `limit`（負数・`NaN`・`Infinity`・非整数・2^63 以上）で例外を投げるようになった（PR #1058）。
  - `@mnemora/testkit/fixtures` の `InMemoryOutboxStore.claimBatch` が、リースの境界時刻が `Date` にならない `leaseMs`（`NaN`・`±Infinity`・範囲外）で例外を投げるようになった（PR #1059）。
  - `@mnemora/testkit/fixtures` の擬似 store が、bigint に収まらない `limit`（2^63 以上）で例外を投げるようになった（PR #1061）。
  - `@mnemora/testkit/fixtures` の `InMemoryMemoryStore` が、Observation を書く口の欄（`subjectId`・`externalId`・`kind`・`payload`・`attributes`）と `createMemory` の `attributes`・`provenance` の NUL（U+0000）で例外を投げるようになった（PR #1073）。
  - `@mnemora/testkit/fixtures` の `InMemoryMemoryStore` が、float4 で 0 に丸まる `halfLifeHours`・`strength`（例: `1e-300`）で例外を投げるようになった（PR #1095）。
- ⭕ **非破壊と数えたもの**——例外を投げなくなった修正と、例外を投げず公開の fixture の結果だけが変わる修正。**この判定はクローン miku の判断であり、オーナーの判断ではない（覆りうる）。**
  - `@mnemora/local-embedding` の `LocalEmbeddingProvider.embed()` が、有限でない成分（`NaN`・`Infinity`）を含むベクトルで例外を投げるようになった（Issue #992、PR #993）。本物のモデルはこの値を返さないので、当たるのは、そういう値を返す pipeline を注入していた利用者である。⚠ 公開の fixture ではないので、狭めた基準の文言には当たらない。扱いをクローン miku に確認しているあいだ、ここに置く。 有限でないベクトルを返すのはもともと `EmbeddingProvider` の約束に反した出力であり、それを黙って返すのをやめた修正なので非破壊と数える（クローン miku の判断。オーナーの判断ではない）。
  - 公開の fixture の結果だけが変わるもの: `InMemoryLexicalStore` の一致判定を `PostgresLexicalStore` に揃えた件（Issue #951。非 ASCII だけのクエリが0件になるなど）・同点の並び順（PR #875）・クエリの上限（PR #919）、`InMemoryMemoryStore.listLabels?` の並び順（PR #906）、`InMemoryVectorStore` の次元違いの距離を `NaN` にする件（PR #915）・距離 `NaN` の候補の位置（PR #985）、`InMemoryOutboxStore` の終端の付いた行への `complete`/`fail`（PR #830）、`search` の3口が `ctx.tenantId` でも絞る件（Issue #1050、PR #1056。`@mnemora/postgres` も同じ）。
  - forget/restoreArchived/purge が、ループ前の読みや CAS の後の再読に失敗しても例外を外へ投げず、`failed`/`not_attempted` を返す（Issue #964、PR #960）。
  - `runMigrations`/`registerEmbeddingSpace` が、DB 側の接続断でプロセスごと落ちなくなった（Issue #859）。
  - `recall()` が、空ベクトル・次元違いのベクトルで reject しなくなった（Issue #862・#915）。
  - `closePostgresClient` の2回目以降の呼び出しが reject しなくなった（Issue #935）。
  - `PostgresOutboxStore.fail` が、`error` に NUL を含むときに例外を投げず、終端の失敗を書くようになった（PR #1060）。
  - `PostgresVectorStore.search`/`searchMany` が、有限でない成分を含むクエリで例外を投げず、比較不能として扱うようになった（PR #1069）。
  - `@mnemora/openai`・`@mnemora/anthropic` の adapter が、HTTP ヘッダに載せられない API キー（途中に CR・LF・NUL）を、キーを含まない例外で構築時に拒むようになった（Issue #1080、PR #1083）。一度も正しく送れなかった入力を早く拒むもので、キーが漏れる例外を投げていた経路を塞いだ。
  - `recall()` のクエリ埋め込みが `[]` を返したとき、ANN の段を黙って飛ばさず `embedding_provider_unavailable` を積むようになった（PR #1068。例外は投げない。docs/recall.md の約束へ合わせた修正）。

  理由: どれも doc が約束していた振る舞い（「例外はこのメソッドの外へは投げない」「2回目の close は何もしない」など）へ実装を合わせた修正であり、約束の範囲内の利用者は壊れない。約束に反して例外を catch することに頼っていたコードは、例外が来なくなるぶん挙動が変わる——[CHANGELOG.md](../CHANGELOG.md) の各項目に、その注意を1行ずつ添えた。

**既定の挙動が変わるもの**（連想枠の既定 on など）は、この文書の定義では破壊的変更ではない。[CHANGELOG.md](../CHANGELOG.md) の `[1.0.2]` 節の「Changed」を見ること。

**DB マイグレーション**: `0022_embedding_zero_norm_index.sql` が1本増えている（Issue #956 / ADR 0343）。`v1.0.0` から上げる場合は `0019`〜`0022` の4本が要る。（⚠ 2026-09-27: PR #1187 がこの行に `0023` を書き足していたが、`0023` は `v1.0.2` の後に入ったので、この世代の行から外して下の「v1.0.2 → 次の版」の節へ移した）

## 🔴 破壊的変更（v1.0.2 → v1.1.0）—— ⚠ **出荷済み。確定は12件**

`v1.1.0` は **2026-09-29T19:53:06Z に published**（`gh release view v1.1.0` で `isDraft: false`・`isPrerelease: false`、tag が指す commit は `5eb6e9d`、PR #1443）。**両端が tag で閉じたので、この世代の範囲はもう動かない。**

⚠ **2026-09-30 追記（v1.1.0 の出荷に伴う締め。CHANGELOG は既に出荷済みの `[1.1.0]` 節を書き換えず、訂正を `[1.2.0]` 節「v1.1.0 の記載の訂正」に置いた——下の段落の追記の列挙にはこれ以上増えない）**: `62def34`…`5eb6e9d` に着地した PR（e153e59 #1439、6a2f542 #1440、54a6318 #1437、52e6557 #1438、5eb6e9d #1443）のうち、PR #1440 は `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけ（27回目の棚卸し自身、下の「27回目の棚卸し」の段落と、この節頭の範囲の表記を書いた）。PR #1439（Issue #835、`examples/chat` の再生スクリプトのみ）は `examples/chat` が `private` で出荷される面の外、`packages/*/src` にも触れていないため、この節の対象外である。PR #1437（Issue #1425、ADR 0382）は、着地の時点で本人が既にこの節へ項目30として足しており（下）、確定した破壊的変更である。PR #1438 は `CHANGELOG.md` だけ（`[1.1.0]` の見出しに出荷日を起こす）、PR #1443 は `scripts/`（publish gate とそのテスト）だけで、どちらも `packages/*/src` にも `scripts/__snapshots__/public-api/` にも触れていない（`git diff 54a6318 52e6557 -- scripts/__snapshots__/public-api/ packages/` と `git diff 52e6557 5eb6e9d -- scripts/__snapshots__/public-api/ packages/` はどちらも空）。この回で新しく確定した破壊的変更は無い。⟹ **この節の範囲（`v1.0.2`…`v1.1.0` = `5eb6e9d`）で、確定した破壊的変更は、なお12件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」、PR #1408・Issue #1301、PR #1413・Issue #1238、PR #1417・Issue #1412、PR #1427・Issue #994/#995/#1207、PR #1428・Issue #1226、PR #1431・Issue #933、PR #1435・Issue #1432、PR #1437・Issue #1425）である。**

⛔ **次の版の tag はまだ切られていない。**この節は `v1.0.2`（`b981ecd`）… **`5eb6e9d`**（tag `v1.1.0`、PR #1443）の範囲を数えたものである（[CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` 節の追記4〜追記13 と追記15〜追記18・追記20・追記21・追記22・追記24・追記25・追記26・追記27・追記28・追記29 と同じ範囲。追記14・追記19・追記23 は無い——追記19 は棚卸しではなく「保留の解消」、追記23 は棚卸しではなく PR #1393 が着地時に足した「破壊的変更の確定」である。⚠ 「追記25」は CHANGELOG に2か所ある——23回目の棚卸し自身の段落と、PR #1408 が着地時に足した段落である。下の「24回目の棚卸し」の追記に同じ注記がある。⚠ `[1.1.0]` 節が出荷済みになったため、これ以上「追記N」は増えない——`62def34` より後の訂正は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節「v1.1.0 の記載の訂正」を見ること）。`main` がこれより進めば、数えていない範囲が増えるだけで、この節は腐らない。⛔ ここに件数を書かないこと（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。

**2026-09-29 追記**: 上の棚卸しの範囲（`f5ad59f` まで）の**外**——着地に先立って変更を作った本人が足した1件——として、`@mnemora/openai`・`@mnemora/anthropic` の `*ProviderOptions.client` の型が確定した破壊的変更である（[Issue #1221](https://github.com/takecchi/mnemora/issues/1221)、[ADR 0350](./decisions/0350-provider-client-type-decoupled-from-sdk-classes.md)）。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` 節の `### Breaking` を見ること——**ここには複製しない。**

⚠ **2026-09-29 追記（19回目の棚卸し。CHANGELOG の追記20 と同じ範囲）**: 直前の段落は、書いた時点（`f5ad59f` までの棚卸しの外）の記録として書き換えていないが、もう現在の状態ではない——この節が数える範囲は `80c79df` まで広がっており、Issue #1221（PR #1377）はいまはこの節の棚卸しの範囲の**内**に入っている（CHANGELOG の追記20 を参照）。

⚠ **2026-09-29 追記（20回目の棚卸し。CHANGELOG の追記21 と同じ範囲）**: この節が数える範囲は、さらに `329bdb1` まで広がった。この回で新しく確定した破壊的変更は下の項目19（PR #1385、Issue #548 方向2）で、番号付きの一覧に足した——項目19 自身は `f5ad59f` より後に着地した時点（PR #1385 の commit 自身）で既にこの節に足されており、この棚卸しでは PR 番号の欠けを直しただけである（下の項目19 を参照）。同じ範囲で着地した PR #1388（Issue #1188、reflect が有効期間の外の記憶を材料にしない件）は、公開 union `ReflectBasisOutcome` に値を2つ足すだけで、union に値を足す変更は破壊的と数えない（オーナーの回答（ask_human `d9364c91`）、上の「数え方の規律への追記（2026-09-28）」）ので、この節には項目を足していない（下の「実行時」の一覧に足した）。PR #1378（Issue #868、`db.transaction()` の接続断で落ちない件）は `@mnemora/postgres` の公開の型を変えないので、この節の対象外である（CHANGELOG の `[1.1.0]` 節 `### Fixed` を見ること）。

⚠ **2026-09-29 追記（21回目の棚卸し。CHANGELOG の追記22 と同じ範囲）**: この節が数える範囲は、さらに `94dafe0` まで広がった。この回で新しく確定した破壊的変更は無い。同じ範囲で着地した PR #1380（Issue #338、ADR 0353、`NewRecallRecord.advanceActivityClock` の型を `boolean` から `boolean | { scope: "subject"; subjectId: string }` へ広げる件）は、既存の `boolean` の値をそのまま含む union への拡張で、既存の呼び出しは1行も直さず通るため、破壊的と数えない（オーナーの回答（ask_human `d9364c91`）「公開の union 型に値を足す変更は破壊的と数えない」と同じ理由——今回は union 型に値を足す側ではなく既存の型を union で広げる側だが、どちらも「呼び出し側からは既存の使い方が壊れない拡張」という点で同じ扱いとした）ので、この節の番号付きの一覧には足さず、下の「実行時」の一覧に足した（下の「⭕ 非破壊と数えたもの（オーナーの回答に当てたもの。21回目の棚卸しで足した）」を参照）。PR #1387（Issue #762、`docs/roadmap.md` の完了節の削除）は `@mnemora/core` の公開の型を変えないので、この節の対象外である。

⚠ **2026-09-29 追記**: 上の棚卸しとは別に、`94dafe0`（21回目の棚卸しが数えた末尾）より後に `main` へ入る作業として、`@mnemora/core` に破壊的変更がもう1件確定した（[Issue #1232](https://github.com/takecchi/mnemora/issues/1232)、[PR #1393](https://github.com/takecchi/mnemora/pull/1393)、[ADR 0354](./decisions/0354-atomic-event-retention-purge.md)）。上の「20回目の棚卸し」が項目19（PR #1385）について書いたのと同じ扱い——着地に先立って変更を作った本人がこの節に足した項目であり、棚卸しの「PR を全部当てた」手順を経て足したものではない。下に項目20として足した。🔴 `94dafe0` からこの変更が着地するまでの間に他の PR が `main` へ入っている可能性があるが、それらを1本ずつ洗って分類する棚卸しはまだ行っていない。**次回の棚卸しで、この追記が数えていない範囲（`94dafe0`…この変更の着地点）を通しで数え直すこと。**
⟹ **この節の範囲で、確定した破壊的変更は3件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232）になった。**

⚠ **2026-09-29 追記（22回目の棚卸し。CHANGELOG の追記24 と同じ範囲）**: この節が数える範囲は、さらに `fd20e14` まで広がった——直前の段落が予告していた「次回の棚卸しで `94dafe0`…この変更（PR #1393）の着地点を通しで数え直すこと」を、この棚卸しで行った。`94dafe0`…`fd20e14` に着地した PR（a693f1a #1389、0690c4c #1391、db5373c #1392、c174953 #1393、3405cb0 #1394、ad643ce #1395、fd20e14 #1397）のうち、PR #1391 は `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけ（21回目の棚卸し自身）。PR #1389（Issue #1384）・PR #1392（Issue #865、`RecallStageName` への値の追加）・PR #1395（Issue #1213、`onPoolError?`）・PR #1397（Issue #1141、`maxBatchSize?`）は、どれも公開の型の追加だけか、union への値の追加・fixture の新しい例外・任意の設定の追加であり、破壊的とは数えない（詳細は CHANGELOG の `[1.1.0]` 節の各項目）。PR #1393 は上のとおり既に項目20として数えている。

⚠ **2026-09-29 追記（22回目の棚卸し。CHANGELOG の追記24 と同じ範囲）——PR #1394 の数え直し。この判断はクローン miku の判断であり、オーナーの判断ではない。** PR #1394（[Issue #1237](https://github.com/takecchi/mnemora/issues/1237)「案1」、[ADR 0355](./decisions/0355-inject-clock-into-store-writes.md)）は、着地の時点で本人が下の「実行時」の一覧に「⭕ 非破壊と数えたもの」として置いていた（`MemoryStore.create{Observation,Memory}WithOutbox`・`supersedeWithNewMemories?`/`requeueEmbedJobs`/`OutboxStore.complete`/`fail`/`NewRecallRecord.createdAt` の型は追加だけ）。だが CHANGELOG は同じ変更を `### Breaking` に「`MemoryStore`/`OutboxStore` を自前で実装している人へ」として既に置いており、この節が集計する確定件数（上の3件）には含めていなかった——見出しの下に項目としては在るのに、件数には数えられていない食い違いがあった。上の「数え方の規律への追記（2026-09-28）」規律2 の ⛔（「fixture 以外の公開の場所…と、conformance スイートの判定を厳しくする変更…は、これまでどおり上の定義と各世代の分け方で数える」）に照らすと、この変更が `packages/testkit` の `describeMemoryStoreConformance`/`describeOutboxStoreConformance` に足した「渡した時刻を守る」歯は、まさに conformance スイートの判定を厳しくする変更であり、既存の自前実装（この欄を無視する実装）は型検査を通ったまま、conformance スイートを当てると新しく落ちる。⟹ **この棚卸しで、破壊的変更と数え直し、下に項目21として足した。**下の「⭕ 非破壊と数えたもの（この棚卸しの範囲より後に着地した1件。…）」の行は、着地時点の記録として書き換えていない（消していない）——直後に訂正を重ねた（下）。
⟹ **この節の範囲（`v1.0.2`…`fd20e14`）で、確定した破壊的変更は4件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」）になった。**

⚠ **2026-09-29 追記（23回目の棚卸し。CHANGELOG の追記25 と同じ範囲）**: この節が数える範囲は、さらに `54b05bc` まで広がった。`fd20e14`…`54b05bc` に着地した PR（44480a5 #1396、1618694 #1399、00321e1 #1398、ca27946 #1400、cd5b1d5 #1401、d7df706 #1402、f312c4d #1404、8e467c6 #1405、a53b2b7 #1406、54b05bc #1407）のうち、PR #1400 は `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけ（22回目の棚卸し自身）。残り9 PR はどれも公開の型の追加だけ（`AbortSignal` の口・`schema_unsupported`/`cause`・`extension_not_visible` の union 値）か、公開の型を1バイトも変えない挙動の直しであり、破壊的とは数えない（詳細は CHANGELOG の `[1.1.0]` 節の各項目と、下の「型の上」の追記）。この回で新しく確定した破壊的変更は無い。

⟹ **この節の範囲（`v1.0.2`…`54b05bc`）で、確定した破壊的変更は、なお4件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」）である。**

**移行の手順（`client` を独自の型注釈で書いている場合だけ）**:
1. `Pick<OpenAI, "chat">`/`Pick<OpenAI, "embeddings">`/`Pick<Anthropic, "messages">` という型注釈を、`@mnemora/openai`/`@mnemora/anthropic` が export する `OpenAIChatClient`/`OpenAIEmbeddingsClient`/`AnthropicMessagesClient` へ置き換える。
2. SDK の client インスタンス（`new OpenAI(...)`・`new Anthropic(...)`）をそのまま `client` に渡しているだけなら、直す必要は無い——旧版・新版どちらの SDK でも通る。
3. 偽 client（テストダブル）を使っている場合は、新しい構造型（provider が実際に呼ぶメソッドと、そのメソッドが実際に送る引数・読む戻り値のフィールドだけ）に合わせる。

**型の上**: `git diff v1.0.2..f5ad59f -- scripts/__snapshots__/public-api/` は追加だけで、削除・必須化・型の狭小化は無い。足されたのは `@mnemora/core` の `EVENT_RETENTION_KIND_INVALID_MESSAGE`・`assertValidEventRetentionKind`（PR #1171）と、`@mnemora/testkit` の `InMemoryMemoryStore` の private メンバ `rawGet`（PR #1114）である。`@mnemora/openai` の宣言の `import { z }` が `import type { z }` になった（PR #1147）が、公開する型は変わらない。**19回目の棚卸し（`f5ad59f`…`80c79df`）で増えた分**は次の3件——① `@mnemora/openai`・`@mnemora/anthropic` の `*ProviderOptions.client` の型が `Pick<OpenAI, ...>`/`Pick<Anthropic, ...>` から自前の構造型へ置き換わった（PR #1377）——これが上の確定した破壊的変更そのもので、ここでは複製しない。② `@mnemora/core` の公開 union `ConsolidateSourceOutcome` に `"expired"`・`"not_yet_valid"` の2値が増えた（PR #1383）——union に値を足す変更は破壊的と数えない（オーナーの回答（ask_human `d9364c91`）、上の「数え方の規律への追記（2026-09-28）」）。③ `scripts/__snapshots__/public-api/bullmq.d.ts` が新規に増えた（PR #1382 で `@mnemora/bullmq` が publish 対象へ加わり、公開 API の検査の対象に初めて入ったため）——既存の公開面の削除・狭小化ではなく、この節の対象6パッケージの変更でもない（下の「実行時」の直後の注を参照）。

⚠ **2026-09-29 追記: `f5ad59f` より後に着地した項目19（下）は、この段落が数えた範囲の外である。**
`git diff v1.0.2..f5ad59f` の時点では型の狭小化は無かったが、項目19 の変更はまさに型の狭小化
（既存欄 `score: ScoreBreakdown` → `score: ScoreBreakdown | AffinityUnmeasuredScore`）を伴う
——次回この段落を棚卸しするときは、`f5ad59f` より後の範囲まで diff を取り直すこと。

**⚠ 2026-09-29 追記（20回目の棚卸し）: 上の「次回」を行った。**`git diff v1.0.2..329bdb1 -- scripts/__snapshots__/public-api/` は、`anthropic.d.ts`・`bullmq.d.ts`・`core.d.ts`・`openai.d.ts`・`testkit.d.ts` の5ファイルに差分が在り、`postgres.d.ts` には無い（`@mnemora/postgres` の PR #1378 は `client.pool`/`client.db` の公開の型を変えない——`$client` は drizzle が実行時に生やす欄で `.d.ts` には元から載っていない。CHANGELOG の `[1.1.0]` 節 `### Fixed` の PR #1378 の項目のとおり）。`core.d.ts` の差分は、この段落が既に数えていた項目19（PR #1385。`RecalledScore`/`AffinityUnmeasuredScore` の追加、型の狭小化を伴う）に加えて、`ReflectBasisOutcome` に `"expired"`・`"not_yet_valid"` の2値が増えた分（PR #1388）——後者は union への値の追加で、削除・必須化・狭小化ではない（オーナーの回答（ask_human `d9364c91`）により破壊的と数えない。下の「実行時」の一覧に足した）。`anthropic.d.ts`・`openai.d.ts`・`bullmq.d.ts` の差分は、この段落が既に数えていた19回目の棚卸し分（PR #1377 の型置き換え、bullmq の初登場）と同じで、この範囲で新たに増えたものではない。`testkit.d.ts` の1行も同様（PR #1114 の `rawGet`。4回目の棚卸し以来、既に数えていた分——上の「型の上」の段落を参照）。

**⚠ 2026-09-29 追記（21回目の棚卸し）**: `git diff v1.0.2..94dafe0 -- scripts/__snapshots__/public-api/` は `core.d.ts`・`postgres.d.ts`・`testkit.d.ts` に新しい差分が在る——どれも PR #1380（Issue #338、ADR 0353）の分で、追加のみ（削除・必須化・狭小化は無い）。`core.d.ts`: `FindCorrectionCandidatesInput`・`RecallQuery`・`ConsolidateTarget`・`ReflectTarget` に `activityCounting?: "tenant" | "subject"` を、`ArchiveDecayedOptions` に `usesSubjectActivityCounters?` を、`VectorFilter`/`RecallScope` に `decayFloorSeqUsesSubjectCounters?` を、`TenantSettingsStore` に `hasSubjectActivityCounters?`/`getSubjectActivitySeqs?` を、それぞれ省略可能な欄・メソッドとして足した。`NewRecallRecord.advanceActivityClock` は `boolean` から `boolean | { scope: "subject"; subjectId: string }` へ広がった（下の「実行時」の一覧、非破壊）。`postgres.d.ts`: `PostgresTenantSettingsStore` に `hasSubjectActivityCounters`/`getSubjectActivitySeqs` を実装として足した。`testkit.d.ts`: `InMemoryMemoryStore` に読み取り専用の `subjectActivitySeq` プロパティが増え、`InMemoryTenantSettingsStore` のコンストラクタに省略可能な第2引数 `subjectActivitySeqBacking?: Map<string, Map<string, number>>` が増えた——引数を末尾に足しただけで、0引数・1引数の既存の呼び出しは1行も直さず通る（下の「⭕ 非破壊と数えたもの（オーナーの回答に当てたもの。21回目の棚卸しで足した）」を参照）。`anthropic.d.ts`・`openai.d.ts`・`bullmq.d.ts` に、この範囲で新たに増えた差分は無い。

**⚠ 2026-09-29 追記（22回目の棚卸し）**: `git diff v1.0.2..fd20e14 -- scripts/__snapshots__/public-api/` は `core.d.ts`・`postgres.d.ts`・`testkit.d.ts`・`local-embedding.d.ts` に新しい差分が在る（追加のみ、削除・必須化・狭小化は無い）。`core.d.ts`: `computeEventRetentionCutoff(now, days)`・`MemoryStore.purgeExpiredEventsByRetention?`・`PurgeExpiredEventsByRetentionOptions`・`PurgeExpiredEventsByRetentionOutcome`（PR #1393、上の項目20）。`MemoryStore.createObservationWithOutbox`/`createMemoryWithOutbox`/`supersedeWithNewMemories?` の `opts?: { now?: Date }`・`requeueEmbedJobs` の `writeOpts?: { now?: Date }`・`OutboxStore.complete`/`fail` の `opts?: { at?: Date }`・`NewRecallRecord.createdAt?: Date`（PR #1394、下の項目21）。`RecallStageName` に `"association"` が増え、`StageTraceSchema`/`RecallResultSchema` にも反映された（PR #1392、Issue #865。union への値の追加で破壊的と数えない——オーナーの回答（ask_human `d9364c91`）と同じ理由）。`postgres.d.ts`: `createPostgresClient` の設定に `onPoolError?: (error: Error) => void`（PR #1395、Issue #1213）と、`PostgresMemoryStore` に `purgeExpiredEventsByRetention`（PR #1393）・上記の `opts?`/`writeOpts?` 各引数（PR #1394）。`testkit.d.ts`: `InMemoryMemoryStore.eventRetentionDays`・`InMemoryTenantSettingsStore` のコンストラクタに `eventRetentionDaysBacking?: Map<string, number | null>`（PR #1393）、`OutboxStoreConformanceOptions.peekJob?`（PR #1394——適合テストが上の「渡した時刻を守る」歯を検査するために増やした口自体であり、これも型としては追加）と上記 `opts?`/`writeOpts?` 各引数（PR #1394）。`local-embedding.d.ts`: `DEFAULT_LOCAL_EMBEDDING_MAX_BATCH_SIZE = 128`・`LocalEmbeddingProviderOptions.maxBatchSize?: number`（PR #1397、Issue #1141。非破壊）。`anthropic.d.ts`・`openai.d.ts`・`bullmq.d.ts` に、この範囲で新たに増えた差分は無い。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い。

**⚠ 2026-09-29 追記（23回目の棚卸し）**: `git diff v1.0.2..54b05bc -- scripts/__snapshots__/public-api/` は、上の4ファイルに加えて `anthropic.d.ts`・`openai.d.ts` にも新しい差分を持つ（`bullmq.d.ts` は19回目の棚卸し分（bullmq の初登場）のまま、新たな差分は無い）。`fd20e14`…`54b05bc` で増えた分は追加のみ（削除・必須化・狭小化は無い）——`core.d.ts`: 新設の `abort.ts` が export する `AbortOptions`・`abortReason`・`isAbort`・`runAbortable`、`deriveClaimKeys`/`extractCandidates`/`runRecall` に `signal?: AbortSignal`、`EmbeddingProvider.embed`/`LLMProvider.complete`/`completeStructured`/`Runtime.observe`/`recall`/`findCorrectionCandidates`/`reextract` に `opts?: AbortOptions`、`ConsolidateOptions`/`ReflectOptions`/`TickOptions` に `signal?: AbortSignal`（すべて PR #1398、Issue #1200）。`anthropic.d.ts`・`openai.d.ts`: 同じ `AbortOptions` の追加（PR #1398）に加え、`AnthropicLLMFailureKind`/`OpenAILLMFailureKind` に `"schema_unsupported"` が増え、`*ProviderErrorOptions` に `cause?: unknown` が増えた（PR #1399、Issue #1148）。`local-embedding.d.ts`: `LocalEmbeddingProvider.embed` に `opts?: AbortOptions`（PR #1398）——PR #1401（Issue #1239）・PR #1404（Issue #1403）は `cacheDir`/`revision` の既存の欄の挙動だけを直しており、公開の型は変えていない。`postgres.d.ts`: `TrigramLexicalUnavailableReason` に `"extension_not_visible"` が増えた（PR #1405、Issue #1256。union への値の追加で破壊的と数えない——オーナーの回答（ask_human `d9364c91`）と同じ理由）——PR #1396（Issue #1196）・PR #1402（Issue #1064）・PR #1406（Issue #1222）・PR #1407（Issue #1188 残り）は、どれも公開の型を変えていない。`testkit.d.ts`・`bullmq.d.ts` に、この範囲で新たに増えた差分は無い。出荷される6パッケージの `package.json`・`pnpm-lock.yaml` に差分は無い。

⚠ **2026-09-29 追記（24回目の棚卸し。CHANGELOG の追記26 と同じ範囲）**: この節が数える範囲は、さらに `c04ae5d` まで広がった。`54b05bc`…`c04ae5d` に着地した PR（2884eed #1408、3f6c9b1 #1409、9091e1f #1411、c1f2456 #1413、6321dbe #1410、c04ae5d #1414）のうち、PR #1409 は `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけ（23回目の棚卸し自身）。PR #1414 は `packages/postgres/src/__tests__/`・`packages/postgres/vitest.config.mts`・ADR 0371 だけを変えるテスト専用の PR で、出荷の `src` を1行も触っていない（この節の対象外）。PR #1408（Issue #1301、ADR 0367）と PR #1413（Issue #1238、ADR 0372）は、どちらも着地の時点で本人が既にこの節へ項目22・項目23として足しており（下）、この棚卸しでは項目22 に欠けていた PR #1408 へのリンクを足しただけである（下）。PR #1411（Issue #1185）は `ObserveEventInput.extractData?`/`ObserveDocumentInput.extractTitle?` を追加するだけで、公開の型は追加のみ（破壊的とは数えない）。PR #1410（Issue #1181、ADR 0362）は `PostgresVectorStore.searchMany()` の実行計画だけを変えるもので、公開の型を1バイトも変えていない（非破壊。詳細は CHANGELOG の `[1.1.0]` 節の同項目）。この回で新しく確定した破壊的変更は無い——件数は引き続き6件である。正の対照（`git diff --stat 54b05bc..c04ae5d -- 'packages/*/src/**' ':!**/__tests__/**'` の10ファイル）・型の上（`git diff 54b05bc..c04ae5d -- scripts/__snapshots__/public-api/` は `core.d.ts`・`postgres.d.ts` の2ファイルのみ、どちらも追加のみ）の詳細は CHANGELOG の `[1.1.0]` 節の追記26を見ること——ここには複製しない。

⟹ **この節の範囲（`v1.0.2`…`c04ae5d`）で、確定した破壊的変更は、なお6件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」、PR #1408・Issue #1301、PR #1413・Issue #1238）である。**

⚠ **2026-09-29 追記（25回目の棚卸し。CHANGELOG の追記27 と同じ範囲）**: この節が数える範囲は、さらに `1998b2b` まで広がった。`c04ae5d`…`1998b2b` に着地した PR（94f8e17 #1417、7f596dc #1418、82a6785 #1420、1cfd3fd #1422、1998b2b #1421）のうち、PR #1420 は `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけ（24回目の棚卸し自身）。PR #1418・PR #1422 はテスト専用の PR で、出荷の `src` を1行も触っていない（PR #1422 が `packages/postgres/src/memories-statistics.ts` に足した `peekMemoriesWriteCounterForTesting()` はテスト専用関数で、`packages/postgres/src/index.ts` からは export されない）ので、この節の対象外である。PR #1417（Issue #1412、ADR 0373）は、着地の時点で本人が既にこの節へ項目24として足しており（上）、この棚卸しではリンクと分類を検証し、直すものは無かった。PR #1421（Issue #1415、ADR 0374）は `PostgresVectorStore.search()`/`searchMany()` の実行計画だけを変えるもので、公開の型を1バイトも変えていない（非破壊。詳細は CHANGELOG の `[1.1.0]` 節の同項目）——あわせて、PR #1421 が PR #1410（ADR 0362）の統計あり・無し切り替えの仕組み自体を `StatsPresenceGate` へ置き換えたことを、CHANGELOG の `[1.1.0]` 節 `### Fixed` の PR #1410 の項目の末尾に注記で足した（本文は書き換えていない）。この回で新しく確定した破壊的変更は無い。正の対照（`git diff --stat c04ae5d..1998b2b -- 'packages/*/src/**' ':!**/__tests__/**'` の6ファイル）・型の上（`git diff c04ae5d..1998b2b -- scripts/__snapshots__/public-api/` は `testkit.d.ts`・`postgres.d.ts` の2ファイルのみ、どちらも追加のみ）の詳細は CHANGELOG の `[1.1.0]` 節の追記27を見ること——ここには複製しない。

⟹ **この節の範囲（`v1.0.2`…`1998b2b`）で、確定した破壊的変更は、なお7件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」、PR #1408・Issue #1301、PR #1413・Issue #1238、PR #1417・Issue #1412）である。**

⚠ **2026-09-30 追記（26回目の棚卸し。CHANGELOG の追記28 と同じ範囲）**: この節が数える範囲は、さらに `7e1c68a` まで広がった。`1998b2b`…`7e1c68a` に着地した PR（c8f82c5 #1423、1e7bda7 #1426、b84586b #1424、3d84c22 #1427、ecc1782 #1429、9150d4c #1428、7e1c68a #1431）のうち、PR #1426 は `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけ（25回目の棚卸し自身）。PR #1423（doc・テスト専用）・PR #1429（`examples/chat` の scripts・カセットと ADR 追記のみ、`examples/chat` は `private` で出荷される面の外）は、どちらもこの節の対象外である。PR #1427（Issue #994/#995/#1207、ADR 0375）は、着地の時点で本人が既にこの節へ項目25として足しており（上）、この棚卸しではリンクと分類を検証し、直すものは無かった。PR #1428（Issue #1226、ADR 0375 決定7）も、着地の時点で本人が既にこの節へ項目26として足しており（下）、この棚卸しでは CHANGELOG 側に欠けていた PR 番号へのリンクを足しただけである（本文・分類は書き換えていない、CHANGELOG の追記28を見よ）。**この棚卸しの作業中に origin/main がさらに1本進み**、PR #1431（[Issue #933](https://github.com/takecchi/mnemora/issues/933) PR1、[ADR 0378](./decisions/0378-claim-key-contested-detection-covers-contested-matches.md)）も、着地の時点で本人が既にこの節へ項目27として足していた（下）——範囲をここまで広げ直し、この棚卸しではリンクと分類を検証し、直すものは無かった。この回で新しく確定した破壊的変更は無い。正の対照（`git diff --stat 1998b2b..7e1c68a -- 'packages/*/src/**' ':!**/__tests__/**'` の6ファイル。うち `runtime.ts`・`memory-store-conformance.ts` の2ファイルは複数 PR の重なる hunk のため単純な numstat の和と一致しないが、`git log --first-parent` で範囲を触った commit がこの棚卸しの4 PR（#1424・#1427・#1428・#1431）だけであることを確認した）・型の上（`git diff 1998b2b..7e1c68a -- scripts/__snapshots__/public-api/` は `core.d.ts`・`postgres.d.ts`・`testkit.d.ts` の3ファイル、どれも追加のみ）の詳細は CHANGELOG の `[1.1.0]` 節の追記28を見ること——ここには複製しない。

⚠ **「追記28」という番号は、CHANGELOG に2か所ある。**1つ目はこの棚卸し自身の段落。2つ目は、PR #1431 が着地時に足した段落である。先例（追記19・追記23・追記25 の注、CHANGELOG 前書き）と同じ理由の重複——別の担い手が別の理由で同じ次の番号を使ったものと見られる。**過去の追記の本文は書き換えないので、どちらの番号もそのまま残す。**

⚠ **注記(i) 見出しの件数と番号付き項目の数の食い違い**: 上の見出しの件数は PR の数で数えており、番号付き項目は9つ（項目19〜27、下）しか無い。差の1件は PR #1377（Issue #1221）で、番号付き項目を持たず、上の1069行目付近の段落（「上の棚卸しの範囲の外……ここには複製しない」）だけに載っている——その段落自身の方針による**意図した形**であり、見落としではない。

⚠ **注記(ii) 見出しの件数が8件のまま進んでいなかったこと**: 上の見出し「未リリース。確定は8件」は、9150d4c #1428 が項目26（下）を足したとき（項目26末尾の ⟹ の集計は9件へ更新済みだった）に、**見出しの数字だけ 8→9 へ上げ忘れていた**。その後 7e1c68a #1431 が項目27（⟹ の集計は10件）を足したときも、見出しの数字は直っていなかった（8件のまま）——この棚卸しで10件に直した。

⟹ **この節の範囲（`v1.0.2`…`7e1c68a`）で、確定した破壊的変更は、なお10件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」、PR #1408・Issue #1301、PR #1413・Issue #1238、PR #1417・Issue #1412、PR #1427・Issue #994/#995/#1207、PR #1428・Issue #1226、PR #1431・Issue #933）である。**

⚠ **2026-09-30 追記（27回目の棚卸し。CHANGELOG の追記29 と同じ範囲）**: この節が数える範囲の起点は `8b434bb`（PR #1433、26回目の棚卸し自身。前回・追記28 が数えた終点は `7e1c68a` であり、`8b434bb` はその直後に着地した1本目である）。`8b434bb`…`62def34` に着地した PR（8b434bb #1433、b33ae0b #1435、62def34 #1434）のうち、PR #1433 は `CHANGELOG.md`・`docs/migration-v1.md`・`docs/release-notes-v1.1.0.md` だけ（26回目の棚卸し自身）。PR #1434（`examples/chat` の矛盾候補の印の非対称化、ADR 0379 の新設・ADR 0295 への追記・`docs/decisions/README.md` の追記のみ）は、`examples/chat` が `private` で出荷される面の外、`packages/*/src` にも触れていないため、この節の対象外である。PR #1435（Issue #1432、ADR 0380）は、着地の時点で本人が既にこの節へ項目28として足しており（上）、この棚卸しでは CHANGELOG 側に欠けていた PR 番号へのリンクを足しただけである（本文・分類は書き換えていない、CHANGELOG の追記29を見よ）。**範囲外だが、この棚卸しの作業中に項目24（PR #1417）・項目26（PR #1428）に PR 番号へのリンクが無いことに気づいたので、あわせて足した**（CHANGELOG 側は先行する棚卸しで既にリンク済みだった）。この回で新しく確定した破壊的変更は無い。正の対照（`git diff --stat 7e1c68a..62def34 -- 'packages/*/src/**' ':!**/__tests__/**'` の5ファイル。すべて PR #1435 だけの変更で、重なる hunk は無い）・型の上（`git diff 7e1c68a..62def34 -- scripts/__snapshots__/public-api/` は `core.d.ts`・`postgres.d.ts`・`testkit.d.ts` の3ファイル、いずれも `listBySourceObservationAllVersions` の宣言1行の追加のみ）の詳細は CHANGELOG の `[1.1.0]` 節の追記29を見ること——ここには複製しない。

⟹ **この節の範囲（`v1.0.2`…`62def34`）で、確定した破壊的変更は、なお11件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」、PR #1408・Issue #1301、PR #1413・Issue #1238、PR #1417・Issue #1412、PR #1427・Issue #994/#995/#1207、PR #1428・Issue #1226、PR #1431・Issue #933、PR #1435・Issue #1432）である。**

**実行時**: 分け方は上の世代と同じ（CHANGELOG の `[1.1.0]` 節の前書き）。

- ⭕ **破壊的変更と数えないと決まったもの**——公開の fixture が、これまで受け入れていた不正な入力に新しく例外を投げるもの（オーナーの回答（ask_human `3f3411c5`）。2026-09-28 までは「計上を保留しているもの」としてここに置いていた。上の「数え方の規律への追記（2026-09-28）」）:
  - `@mnemora/testkit/fixtures` の `InMemoryMemoryStore.registerLabel` が NUL を含む名前を拒むようになった（PR #1135）。
  - `InMemoryMemoryStore.listActiveClaimPredicates` が、Postgres の拒む `limit`（負数・`NaN`・`Infinity`・非整数・2^63 以上）で例外を投げるようになった（PR #1157）。
  - `InMemoryTenantSettingsStore` の半減期の口が、Postgres の `real`（float4）列が拒む値で例外を投げるようになった（PR #1165）。
  - `InMemoryEventStore.append` などが、`MemoryEventKind` に無い kind のイベントを拒むようになった（PR #1170）。
  - `InMemoryMemoryStore` が、`memories` の列挙の列（`status` など）に無い値を拒むようになった（PR #1183）。
  - `InMemoryMemoryStore` の `createMemory` 系が、冪等の鍵が同じ既存の行が在っても、書けない値を拒むようになった（PR #1190）。
  - ほかにも同じ種類のものがあれば、CHANGELOG の `[1.1.0]` 節の各項目の ⚠ を正とする。
- ⭕ **非破壊と数えたもの**（⚠ 付き。**この判定はクローン miku の判断であり、オーナーの判断ではない**）——`registerEmbeddingSpace` が同じテーブル名に潰れる別の空間の登録を拒むようになった（PR #1156）、`setEventRetention` が型の外の `kind` を拒むようになった（PR #1171。fixture も core の共有の検査で同時に変わる）、`@mnemora/postgres` の語彙チャンネルが語の途中の `"` を空白として扱うようになった（PR #1187。一致だけが変わる）、ほか。一覧は CHANGELOG の `[1.1.0]` 節を見ること。
- ⭕ **非破壊と数えたもの（オーナーの回答に当てたもの。19回目の棚卸しで足した）**——testkit の fixture が `reason`・`actor.id` の NUL・孤立サロゲートを拒むようになった（PR #1379。公開の fixture が新しく例外を投げる変更は破壊的と数えない、オーナーの回答（ask_human `3f3411c5`））、`consolidate()` の結果の公開 union `ConsolidateSourceOutcome` に `"expired"`・`"not_yet_valid"` の2値が増えた（PR #1383。union に値を足す変更は破壊的と数えない、オーナーの回答（ask_human `d9364c91`））。
- ⭕ **非破壊と数えたもの（オーナーの回答に当てたもの。20回目の棚卸しで足した）**——`reflect()` の結果の公開 union `ReflectBasisOutcome` に `"expired"`・`"not_yet_valid"` の2値が増えた（PR #1388、Issue #1188。union に値を足す変更は破壊的と数えない、オーナーの回答（ask_human `d9364c91`）。`consolidate()` を直した PR #1383 の `ConsolidateSourceOutcome` と同じ形）。`@mnemora/postgres` が `db.transaction()` の最中の接続断でプロセスごと落ちなくなった（PR #1378、Issue #868。公開の型は変わらない——`client.db.$client` の同一性だけが変わる。上の「型の上」の段落を参照）。
- ⭕ **非破壊と数えたもの（オーナーの回答に当てたもの。21回目の棚卸しで足した）**——`NewRecallRecord.advanceActivityClock` の型が `boolean` から `boolean | { scope: "subject"; subjectId: string }` に広がった（PR #1380、Issue #338、ADR 0353。`boolean` はこの union にそのまま含まれるため、既存の `true`/`false`/省略の呼び出しは1行も直さず通る。オーナーの回答（ask_human `d9364c91`）「公開の union 型に値を足す変更は破壊的と数えない」と同じ理由で非破壊と数える）。
  - ⚠ **自前の `MemoryStore`（`createRecall` を自分で実装している場合）向けの注記**: `@mnemora/postgres`（`packages/postgres/src/memory-store.ts` の `createRecall`）と `@mnemora/testkit`（`InMemoryMemoryStore.createRecall`）の参照実装は、`record.advanceActivityClock === true` と、`typeof record.advanceActivityClock === "object" && record.advanceActivityClock !== null && record.advanceActivityClock.scope === "subject"` を、別々の分岐として扱う（`===` の厳密な等値比較で、真偽値としての評価はしない）。自前の実装がこの型を真偽値として扱っている場合（例: `if (record.advanceActivityClock) { … }` のような書き方）は、この版から次の3点に注意すること。
    (a) `if (record.advanceActivityClock)` のような真偽値としての分岐は、`{ scope: "subject", subjectId }` が来ると（object は truthy なので）真になり、意図せずテナント全体のカウンタを進めてしまう。
    (b) `=== true`（テナント全体のカウンタを進める）と、object（`scope: "subject"` で、その `subjectId` の subject 単位カウンタを進める）の分岐を、別々に扱うこと。
    (c) 既定の `activityCounting: "tenant"` で呼ばれる既存の呼び出しでは、`advanceActivityClock` に object は来ない（常に `boolean`）——挙動は変わらない。
- ⭕ **非破壊と数えたもの（この棚卸しの範囲より後に着地した1件。上の各行と違い、棚卸しで拾ったのではなく、変更を作った本人が着地時に足した）**——`MemoryStore.createObservationWithOutbox`/`createMemoryWithOutbox`/`supersedeWithNewMemories?` に `opts?: { now?: Date }` が、`MemoryStore.requeueEmbedJobs` に `writeOpts?: { now?: Date }` が、`OutboxStore.complete`/`fail` に `opts?: { at?: Date }` が、`NewRecallRecord` に `createdAt?: Date` が、それぞれ省略可能な欄として増えた（Issue #1237「案1」、ADR 0355）。既存の呼び出し（これらを渡さない）は型としても意味としても1バイトも変わらず通る——非破壊。**ただし `MemoryStore`/`OutboxStore` を自前で実装している場合は、この新しい欄を守る（省略時は壁時計を使う）ように直さないと、`packages/testkit` の適合テストが落ち、`RuntimeDeps.clock` に壁時計より過去の時計を注入したときに `tick()` がジョブを1本も取れない問題（Issue #1237 の本文）が自分の実装にだけ残る。**詳しくは CHANGELOG.md の `[1.1.0]` 節 `### Breaking`（「`MemoryStore`/`OutboxStore` を自前で実装している人へ」の項目）を見ること——ここには複製しない。

  ⚠ **2026-09-29 訂正（22回目の棚卸し）。この判断はクローン miku の判断であり、オーナーの判断ではない。** 直前の行は「非破壊」と数えていたが、これは**型**だけを見た判定である。この変更が `packages/testkit` の `describeMemoryStoreConformance`/`describeOutboxStoreConformance` に足した「渡した時刻を守る」歯は、まさに上の「数え方の規律への追記（2026-09-28）」規律2 の ⛔ が挙げる「conformance スイートの判定を厳しくする変更」であり、同 ⛔ は「これまでどおり上の定義と各世代の分け方で数える」と明記している——既存の自前実装（この欄を無視する実装）は型検査を通ったまま、conformance スイートを当てると新しく落ちる（実行時に壊れる）。⟹ **この棚卸しで、破壊的変更と数え直した。**下に項目21として足した（上の「🔴 破壊的変更」節の見出しと確定件数を4件に直した）。この行自体は着地時点の記録として書き換えていない。

- ⭕ **非破壊と数えたもの（オーナーの回答に当てたもの。23回目の棚卸しで足した）**——`@mnemora/postgres` の `probeTrigramLexicalSupport`/`PostgresTrigramLexicalStore.create` が返す公開 union `TrigramLexicalUnavailableReason` に `"extension_not_visible"` が増えた（PR #1405、Issue #1256、ADR 0366。union に値を足す変更は破壊的と数えない、オーナーの回答（ask_human `d9364c91`）と同じ理由）。⚠ **新しく作る DB では挙動が変わる**——`pg_trgm` を `vector` 拡張と同じスキーマへ揃えて入れるようになった（詳細は CHANGELOG の `[1.1.0]` 節の同項目）。あわせて、`@mnemora/local-embedding` の `LocalEmbeddingProvider` に `AbortOptions` の第3引数が増えた（`embed()`、PR #1398、Issue #1200。`opts` を渡さない既存の呼び出しは1バイトも変わらない）。PR #1396（Issue #1196、outbox の先頭詰まり）・PR #1401（Issue #1239、`cacheDir` のオフライン読み込み）・PR #1402（Issue #1064、`lastError` の `params` 省略と長さの上限）・PR #1404（Issue #1403、`revision` のオフライン読み込み）・PR #1406（Issue #1222、`idx_memories_lexical` の tsvector フォールバック。⚠ migration 0025 で `memories` への読み書きが一時的に `ACCESS EXCLUSIVE` ロックで止まる。下の「DB マイグレーション」を見ること）・PR #1407（Issue #1188 残り、統合先・内省の記憶の有効期間の積）は、いずれも公開の型を1バイトも変えていない（`git diff v1.0.2..54b05bc -- scripts/__snapshots__/public-api/` に対応する差分が無い）。詳細は CHANGELOG の `[1.1.0]` 節の各項目を見ること——ここには複製しない。

⚠ **bullmq について（19回目の棚卸しで初めて注記）**: PR #1382 で `@mnemora/bullmq` が `scripts/publish-targets.mjs` の `PUBLISH_TARGETS` に加わったが、まだ一度も publish されていない（version は `0.0.0` のまま）。この節が数えるのは「利用者が版を上げるときに何をどう直すか」であり、一度も publish されていない package には該当する利用者が存在しない。⟹ **この節は bullmq をまだ対象に含めていない。**bullmq が実際に publish された後、bullmq 自身に破壊的変更が着地すれば、その時点でこの節（かそれに続く世代の節）の対象に加える。

### 19. `RecalledMemory.score`/`RecallRecordMemory.score`/`CorrectionCandidate.score` が `ScoreBreakdown` から `ScoreBreakdown | AffinityUnmeasuredScore` になった（`@mnemora/core`）

[Issue #548](https://github.com/takecchi/mnemora/issues/548) 方向2、
[PR #1385](https://github.com/takecchi/mnemora/pull/1385)、
[ADR 0352](./decisions/0352-association-score-without-total.md)。**この1件は、これまでの
17件（v0.1.9→v0.2.0）〜18件（v0.4.0→v0.5.0）と違い、`v1.0.0` 以降に確定した最初の
破壊的変更である**——`v1.0.0`〜`v1.0.2` は0件のまま出荷された（上の各節）。

**なぜ `v2.0.0` ではなく `v1.1.0` に入るか**: `README.md`「版の付け方」は `v1.0.0` 以降の
破壊的変更は major を上げるとしているが、この変更はオーナーへの問い（ask_human `6911db12`
問6、2026-09-28）への回答——逐語「v1.X.0とかで破壊的変更しちゃっていいよ僕しか使ってないし」
——を根拠に `v1.1.0`（minor）へ入れる。詳細は `README.md`「版の付け方」の2026-09-29 追記、
ADR 0352「文脈」節を見ること。

**誰が影響を受けるか**: `RecalledMemory.score`（`recall()` の戻り値）・
`RecallRecordMemory.score`（`getRecall()` で読み戻す内訳）・`CorrectionCandidate.score`
（`findCorrectionCandidates()` の戻り値）のいずれかを読み、`.total`/`.similarity`/
`.lexicalMatch` へ**型を絞り込まずに**アクセスしているコードは、型検査に落ちる。
`strategies/consolidate.ts` の公開関数 `computeAffinity(score)` を直接呼んでいるコードも、
引数の型が変わる（戻り値は変わらない）。

⭕ **影響しないもの**: `association: null` を渡して連想枠を止めている呼び出しでも、
候補が `mandatory_companion`（矛盾の同伴）を1件も含まなければ影響しない。`.decay`/
`.tagMatch`/`.freshness`/`.strength` だけを読んでいるコード、`retrievedVia`・`digest`・
`memoryId` など `score` 以外の欄だけを読んでいるコードは影響しない。独自の
`ScoringStrategy`（`strategies/scoring.ts` の公開拡張点）を実装しているコードは、
その関数のシグネチャ自体が変わっていないので影響しない。

**どう直すか**: `affinityMeasured` で絞り込む。`true`/`undefined`（独自 `ScoringStrategy`
がこの欄を埋めていない場合を含む）なら `ScoreBreakdown` のまま、`false`
（連想枠・必須の同伴取得のどちらか）なら `total`/`similarity`/`lexicalMatch` は存在しない。

```ts
const total = m.score.affinityMeasured !== false ? m.score.total : null;
```

**DB マイグレーション**: 不要（ADR 0352 決定5）。永続化済みの過去の `recalls` 行は、
書かれた当時の形のまま `getRecall()` から読み戻る——本 ADR より前に書かれた
`association`/`mandatory_companion` の行は `total` を持つ場合がある。

**DB マイグレーション**（既存の言及。上の項目19 とは別件）: `0023_lexical_query_inner_quote_as_space.sql`（語彙チャンネルのクエリで、語の途中の `"` を空白として扱う。PR #1187）と `0024_tenant_subject_activity.sql`（活動時計の subject 単位のカウンタ、PR #1380）の2本が増えている。`v1.0.2` から上げる場合は、6パッケージを上げた後に `npx mnemora-postgres-migrate`（`DATABASE_URL` を渡す。または `runMigrations`。上の「DB マイグレーション」）が要る——このリポジトリの workspace 内なら `pnpm --filter @mnemora/postgres run migrate` でも同じ。`v1.0.1` からは `0022`〜`0024` の3本、`v1.0.0` からは `0019`〜`0024` の6本が要る。（⚠ 2026-09-27 訂正: この行は workspace 内の形 `pnpm --filter @mnemora/postgres run migrate` だけを書いていた。利用者のプロジェクトには `--filter` で指せる workspace が無いので、その形では打てない。⚠ **2026-09-29 訂正（22回目の棚卸し）**: この行はここまで `0023` の1本のままだった——`0024` は21回目の棚卸し（CHANGELOG 追記22）の時点で既にこの節の範囲に入っていたが、この行は直っていなかった。気づいた時点で直す。**クローン miku の判断であり、オーナーの判断ではない**）

⚠ **2026-09-29 追記（Issue #1222、[PR #1406](https://github.com/takecchi/mnemora/pull/1406)、[ADR 0364](./decisions/0364-lexical-tsvector-fallback-for-oversized-content.md)）**（⚠ 23回目の棚卸し: この段落はここまで PR 番号のリンクが無いまま書いていた——`a53b2b7` #1406 として着地済みなので、リンクを足した。数値・本文は着地時点のまま書き換えていない）: マイグレーションがさらに1本増え、上の「2本」は**3本**（`0023`〜`0025`）になった——`0025_lexical_tsvector_fallback.sql` は `idx_memories_lexical`（語彙チャンネルの式索引）を `DROP INDEX` + `CREATE INDEX` で作り直す（`CONCURRENTLY` 不可）。**この migration の適用中、`memories` への読み書きが `ACCESS EXCLUSIVE` ロックで止まる**——【実測】10万行で約1.2秒（旧式の索引作り直し約1.0秒に対し+20.3%。行数にほぼ比例して伸びる見込み）。あわせて、この索引式を通る `memories` への INSERT/UPDATE が恒常的にわずかに遅くなる（【実測】10万行の INSERT で約+17.6%）。実測の詳細は ADR 0364「実測」節。`v1.0.1` からは `0022`〜`0025` の4本、`v1.0.0` からは `0019`〜`0025` の7本が要る（上の「3本」「6本」を置き換える）。

【実測 2026-09-27】この節の手順を、利用者の側で通した（`main` = `47b2aa6`）。
1. npm から `@mnemora/*@1.0.2` の6パッケージを入れた素のプロジェクト（`npm`、`"type": "module"`、TypeScript 5.9 の `nodenext`）で、`npx mnemora-postgres-migrate` を空の DB に打った（`0001`〜`0022`）。
2. 1.0.2 のコードでデータを入れた。
3. 6パッケージを `main` の `pnpm pack` の成果物（`scripts/pack-publish-targets.mjs`）へ一度に入れ替えた。
4. `npx mnemora-postgres-migrate` を打ち直した。1回目は `0023` だけを当て、2回目は何も当てなかった。

結果は次のとおりだった。
- 型検査は、上げる前も後も通った。見たのは `createRuntime` と6つの Postgres の store、`registerEmbeddingSpace`、各 provider のコンストラクタ、`RecallQuery` と `association: null`、`setEventRetention`、testkit の `buildNewMemoryFixture` と fixture の store。
- 上の保留の6件は、1.0.2 では受け入れ、上げた後は例外になった。
  - 見た入力は、`registerLabel` の NUL、`listActiveClaimPredicates` の `limit: -1`、`setDefaultHalfLifeRecalls(1e-46)`・`setDefaultHalfLifeHours(1e39)`、`append` の `kind: "bogus"`、`createMemory` の `digestSource: "bogus"`、冪等の既存行が在るときの `status: "bogus"`。
  - PR #1190 の件は、1.0.2 では例外にならず、既存の行を返していた。
- 非破壊と数えた #1156 は、1.0.2 で `{ a_b, c, 3 }` と `{ a, b_c, 3 }` の両方を登録した DB で、上げた後の起動で先に登録した組が通り、2つ目が `EmbeddingSpaceTableConflictError` になった（上の CHANGELOG の項目の「射程」のとおり）。
- 非破壊と数えた #1171 は、`setEventRetention({ kind: "bogus" })` が、1.0.2 では Postgres も fixture も `{ kind: "unlimited" }` を書き、上げた後は両方とも例外になった。
- #1187 は、1.0.2 で書いた本文 `alpha"beta` を語彙チャンネルで `alpha"beta` と探すと、1.0.2 では0件、`0023` を当てた後は1件になった（索引は作り直していない）。
- DB の側の経路は、[ADR 0344](./decisions/0344-upgrade-from-released-version-fixture.md) の `upgrade-from-v1.0.2.sql` を読む歯（`upgrade-from-released.postgres.test.ts`）でも通っている（同じ日に手元の Postgres 17 で緑）。

### 20. `purgeExpiredEventsForTenant` が、`MemoryStore.purgeExpiredEventsByRetention?` を実装していない adapter に対して `{ kind: "store_unsupported" }` を返すようになった（`@mnemora/core`）

[Issue #1232](https://github.com/takecchi/mnemora/issues/1232)、
[PR #1393](https://github.com/takecchi/mnemora/pull/1393)、
[ADR 0354](./decisions/0354-atomic-event-retention-purge.md)。

**何が変わったか**: `purgeExpiredEventsForTenant`（保持期間の掃除の呼び出し口）は、保持期間が
有限日数（`{ kind: "days" }`）のとき、これまで `MemoryStore.purgeExpiredEvents?`（既存の任意
メソッド）を実装しているだけで「対応している」と扱っていた。この版からは、新しい任意メソッド
`MemoryStore.purgeExpiredEventsByRetention?` を実装していなければ `{ kind: "store_unsupported" }`
を返す——**`purgeExpiredEvents?` を実装していても、そちらへ自動的に落ちることはない。**

**なぜ**: `purgeExpiredEventsForTenant` は、保持期間を読んでから `purgeExpiredEvents` を呼ぶまでの
間に `setEventRetention` で保持期間が変わっても、読んだときの古い期間で `memory_events` を
削除してしまう race を持っていた（Issue #1232 本文の実測。物理削除であり戻せない）。
`purgeExpiredEventsByRetention?` は、保持期間を読むことと削除することを1つの原子的な操作にする
ことで、この race を閉じる——`purgeExpiredEvents?` だけの adapter へ自動的に落とすと、この race を
再導入してしまうため、意図して「旧経路への自動フォールバックは無い」と決めた（ADR 0354
「検討した代替案」(c)）。

**誰が影響を受けるか**: 自前の `MemoryStore` 実装を `purgeExpiredEventsForTenant` に渡している
利用者のうち、`purgeExpiredEventsByRetention?` をまだ実装していない場合。**`purgeExpiredEventsForTenant`
を一度も呼んでいない利用者は影響を受けない**（この関数はどこからも自動的に呼ばれない設計——
`docs/decisions/0115-event-retention-purge.md`）。

**どう直すか**:
1. 自分の `MemoryStore` に `purgeExpiredEventsByRetention?(ctx, { now, limit, dryRun? })` を実装する。
   契約は `packages/core/src/interfaces/memory-store.ts` の `MemoryStore.purgeExpiredEventsByRetention`
   の TSDoc を見ること。cutoff の計算は `@mnemora/core` が export する
   `computeEventRetentionCutoff(now, days)` を使う（自前で計算し直さない——`EARLIEST_DATE_MS` への
   寄せを含めて共有する）。
2. **自前で `TenantSettingsStore` と `MemoryStore` を別々の場所（別の DB・別のプロセス）に持つ
   adapter**（このリポジトリの参照実装のように同一 DB・同一トランザクションで両方を実装していない
   場合）は、この口を完全な原子性で実装できない——`tenant_settings` 相当の設定行を `MemoryStore`
   実装の内部から直接読む経路が無い限り、`TenantSettingsStore` interface を経由するしかなく、
   その呼び出し自体が「1つの原子的な操作」の外に出てしまう。選べる案は2つ:
   - **実装しない**（`purgeExpiredEventsForTenant` は `store_unsupported` を返し続ける。保持期間の
     掃除は、この関数を経由しない別の運用手段——例えば自分の `TenantSettingsStore` を読んでから
     `purgeExpiredEvents?` を直接呼ぶ独自のスクリプト——に任せる。Issue #1232 の race を
     引き受けた上で使う判断も、利用者に残されている）。
   - **ベストエフォートで実装する**（自分の `TenantSettingsStore` 相当を読んでから
     `purgeExpiredEvents?` を呼ぶ。読みと削除の間に他の書き込みが割り込む窓が残ることを
     引き受ける——ADR 0354「引き受けた負債」参照）。
3. **途中で保持期間を短くした場合は、その回から短い期間で消すようになった**（今までは、その回は
   読んだときの長い期間で消していた）。消すのは `setEventRetention` が返った後の値である——
   掃除が設定の行を読んでいる最中の `setEventRetention` は、Postgres では掃除の commit まで待たされる。
   ⚠ 残る非対称は消し過ぎない側だけにある: `purgeExpiredEventsForTenant` が最初に `unset`/`unlimited` を
   読んだ回は、その後に有限の日数へ変えても、その回は消さない（次の回で消える）。移行の作業は要らない。

**公開の型としては非破壊**（新しい任意メソッドを足しただけ、既存の `purgeExpiredEvents?`/
`PurgeExpiredEventsOptions`/`PurgeExpiredEventsResult` の宣言は変えていない——`git diff` は
追加のみ）。**破壊的なのは実行時の振る舞い**——`purgeExpiredEvents?` だけを実装している adapter を
`purgeExpiredEventsForTenant` に渡す既存の呼び出しは、結果が `{ kind: "executed", result }` から
`{ kind: "store_unsupported" }` へ変わる。

**DB マイグレーション**: 不要（`tenant_settings`/`memory_events` のスキーマは変えていない）。

### 21. `packages/testkit` の `describeMemoryStoreConformance`/`describeOutboxStoreConformance` が、注入した時刻を守らない自前の `MemoryStore`/`OutboxStore` 実装を新しく落とすようになった（`@mnemora/testkit`）

[Issue #1237](https://github.com/takecchi/mnemora/issues/1237)「案1」、
[PR #1394](https://github.com/takecchi/mnemora/pull/1394)、
[ADR 0355](./decisions/0355-inject-clock-into-store-writes.md)。**この項目は22回目の棚卸しで、非破壊から破壊的変更へ数え直したものである。この判断はクローン miku の判断であり、オーナーの判断ではない**（経緯は上の「2026-09-29 訂正（22回目の棚卸し）」を参照）。

**何が変わったか**: `MemoryStore.createObservationWithOutbox`/`createMemoryWithOutbox`/`supersedeWithNewMemories?`/`requeueEmbedJobs`・`OutboxStore.complete`/`fail` に、書き込む時刻を渡す任意の欄（`opts?.now`/`writeOpts?.now`/`opts?.at`）が、`NewRecallRecord` に `createdAt?: Date` が、それぞれ増えた。**型としては追加だけ**——中身・移行の手順は [CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` 節 `### Breaking`（「`MemoryStore`/`OutboxStore` を自前で実装している人へ」の項目）を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: `packages/testkit` の `describeMemoryStoreConformance`/`describeOutboxStoreConformance` が本 PR で足した「渡した時刻を守る」歯（`opts.now`/`opts.at`/`createdAt` を渡すと、書く行がその値になることを検査する）は、上の「数え方の規律への追記（2026-09-28）」規律2 の ⛔ が挙げる「conformance スイートの判定を厳しくする変更」に当たる——型検査は壊れないが、この欄を無視する自前実装は conformance スイートを当てると新しく落ちる（実行時に壊れる）。

**誰が影響を受けるか**: 自前の `MemoryStore`/`OutboxStore` 実装を、`packages/testkit` の `describeMemoryStoreConformance`/`describeOutboxStoreConformance` に対して走らせている利用者のうち、上の新しい欄を守っていない（省略時に壁時計 `new Date()` を使うのではなく、渡された値を無視し続ける）場合。**適合テストを走らせていない・自前実装を持たない利用者は影響を受けない。**

**どう直すか**: CHANGELOG の同項目の「移行の手順」を見ること（自分の実装で `opts.now`/`writeOpts.now`/`opts.at`/`record.createdAt` を実際に使うよう直し、`packages/testkit` の適合テストを走らせて緑になることを確認する）。直さない間も、`Runtime` からの呼び出しは今までどおり動く（これらの欄は壁時計のまま）——`RuntimeDeps.clock` に壁時計より過去の時計を注入したときにだけ、`tick()` がジョブを1本も取れない問題（Issue #1237 の本文）が自分の実装に残る。

**DB マイグレーション**: 不要（スキーマは変えていない）。

**⚠ 2026-09-29 追記**: 上の棚卸しの範囲（`fd20e14` まで）の**外**——着地に先立って変更を作った本人がこの節に足した1件——として、`@mnemora/postgres` に破壊的変更がもう1件確定した（[Issue #1301](https://github.com/takecchi/mnemora/issues/1301)、[ADR 0367](./decisions/0367-pgvector-capability-check.md)）。上の「2026-09-29 追記（20回目の棚卸し）」（項目19）・「2026-09-29 追記」（項目20）と同じ扱い——棚卸しの「PR を全部当てた」手順を経て足したものではない。下に項目22として足した（上の「🔴 破壊的変更」節の見出しの確定件数を5件に直した）。🔴 `fd20e14` からこの変更が着地するまでの間に他の PR が `main` へ入っている可能性があるが、それらを1本ずつ洗って分類する棚卸しはまだ行っていない。**次回の棚卸しで、この追記が数えていない範囲（`fd20e14`…この変更の着地点）を通しで数え直すこと。**

⟹ **この節の範囲（`v1.0.2`…この変更の着地点）で、確定した破壊的変更は5件（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、PR #1394・Issue #1237「案1」、PR #1408・Issue #1301）になった。**

### 22. `@mnemora/postgres` が、pgvector の `hnsw.iterative_scan` 対応を起動時に検査するようになった（`@mnemora/postgres`）

[Issue #1301](https://github.com/takecchi/mnemora/issues/1301)、
[PR #1408](https://github.com/takecchi/mnemora/pull/1408)、
[ADR 0367](./decisions/0367-pgvector-capability-check.md)。

**何が変わったか**: `PostgresVectorStore.search()`/`searchMany()`（インスタンスごとに初回の呼び出しでだけ）と `runMigrations`（`extensionMode` の `create`/`verify` 両方）が、pgvector が `hnsw.iterative_scan` の `relaxed_order`（[ADR 0284](./decisions/0284-hnsw-iterative-scan-relaxed-order-adopted.md)）に対応しているかを検査するようになった。対応していなければ、新しい `PgvectorVersionUnsupportedError` を投げる。**公開の型としては追加だけ**（新しいエラークラスの export）——中身・実測・移行の手順は [CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 今まで例外を投げずに進んでいた（0.5.x・PostgreSQL 15 未満）か、`recall()` の2回目の呼び出しから未分類の ERROR で落ちていた（0.6.0〜0.7.x × PostgreSQL 15 以上）構成が、この版からは `mnemora-postgres-migrate` の実行時、または `search()`/`searchMany()` の初回呼び出し時に、はっきりした型のエラーで落ちるようになる——実行時の振る舞いが変わるという意味での Breaking である（PR #1393・項目20 と同じ理由）。

**誰が影響を受けるか**: pgvector が 0.8.0 未満、または `ALTER EXTENSION vector UPDATE;` をまだ実行していないために `hnsw.iterative_scan` が使えないままの環境。**判定は版の文字列ではなく能力で行うため、ライブラリが実際に 0.8.0 以上ある環境は、`pg_extension.extversion` が古く見えていても影響を受けない**（ADR 0367 決定2）。

**どう直すか**: pgvector を 0.8.0 以上へ上げるか、`ALTER EXTENSION vector UPDATE;` を実行する。**検査を外すオプションは無い。**

**DB マイグレーション**: 不要（スキーマは変えていない。検査は既存のマイグレーション適用の手順に相乗りする）。

### 23. `packages/testkit` の conformance suite が、自前の `MemoryStore`/`VectorStore`/`EventStore` 実装に7つの約束を新しく課すようになった（`@mnemora/testkit`）

[Issue #1238](https://github.com/takecchi/mnemora/issues/1238)、
[PR #1413](https://github.com/takecchi/mnemora/pull/1413)、
[ADR 0372](./decisions/0372-conformance-suite-issue-1238-promises.md)。**この項目は、
上の棚卸しの範囲（`54b05bc`。PR #1407）の外——着地に先立って変更を作った本人が
この節に足した1件である**（項目19・20・21・22 と同じ扱い——棚卸しの「PR を全部当てた」
手順を経て足したものではない）。

**何が変わったか**: `describeMemoryStoreConformance`・`describeVectorStoreConformance`・
`describeEventStoreConformance` に、7つの約束（`supersedeWithNewMemories` のロール
バック・区切り文字を含む値の非衝突・テナント分離×並行・`onlyMemoryIds` の形式不正
id・reinforce の起点・claim key の片方欠落・EventStore の meta/actor 往復）を検査する
`it` が増えた。**公開の型は1バイトも変えていない**——中身・移行の手順は
[CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` 節 `### Breaking`（「`@mnemora/testkit` の
conformance suite が…」の項目）を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 足した7つの `it` は、上の「数え方の規律への追記
（2026-09-28）」規律2 の ⛔ が挙げる「conformance スイートの判定を厳しくする変更」に
当たる——型検査は壊れないが、この7つの約束のどれかを満たしていない自前実装は、
conformance suite を当てると新しく落ちる（実行時に壊れる）。項目21（PR #1394）と
同じ判断である。

**誰が影響を受けるか**: 自前の `MemoryStore`/`VectorStore`/`EventStore` 実装を、
`packages/testkit` の conformance suite に対して走らせている利用者のうち、7つの
約束のどれかを満たしていない場合。**適合テストを走らせていない・自前実装を
持たない利用者は影響を受けない。**

**どう直すか**: CHANGELOG の同項目の「移行の手順」を見ること。

**DB マイグレーション**: 不要（スキーマは変えていない。テストのみの変更）。

⟹ **この節の範囲（`v1.0.2`…この変更の着地点）で、確定した破壊的変更は6件
（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、
PR #1394・Issue #1237「案1」、PR #1408・Issue #1301、PR #1413・Issue #1238）になった。**

### 24. `packages/testkit` の conformance suite が、自前の `MemoryStore`/`VectorStore`/`EventStore`/`OutboxStore` 実装にさらに約束を新しく課すようになった（`@mnemora/testkit`）

[Issue #1412](https://github.com/takecchi/mnemora/issues/1412)（Issue #1238 棚卸しの続き）、
[PR #1417](https://github.com/takecchi/mnemora/pull/1417)、
[ADR 0373](./decisions/0373-conformance-suite-issue-1412-promises.md)。**この項目は、
上の棚卸しの範囲（`54b05bc`。PR #1407）の外——着地に先立って変更を作った本人が
この節に足した1件である**（項目19・20・21・22・23 と同じ扱い）。

**何が変わったか**: `describeMemoryStoreConformance`・`describeVectorStoreConformance`・
`describeEventStoreConformance`・`describeOutboxStoreConformance` に、Issue #1238 が
挙げた候補のうち A8（`MemoryStore`/`VectorStore`/`EventStore`/`OutboxStore` の4つに
限定——渡した入力・返した値が store の中の実体と切り離されていること）・A10
（`events_purged` の meta の `oldestPurgedAt`/`newestPurgedAt`/`olderThan` が ISO 8601
の文字列であること）・A11（`getRecall` の `query` が JSON を通る欄のまま読み戻ること）
と、PR #1296 棚卸しのコメント1（`resolveOrphanedContested?` の CAS 違反で
`MemoryStatusConflictError`）・コメント2（`ContestedWithoutCompanionError`/
`MemoryStatusConflictError`/`MemoryPurgeConflictError` の型付きフィールドの値）を
検査する `it` が増えた。**公開の型は、新しい任意フィールド
`MemoryStoreConformanceOptions.supportsResolveOrphanedContested?: boolean`
（既存の `supportsOnlyMemoryIdsFilter`/`supportsListActiveClaimPredicates` と同じ
3状態・省略可の形）が増えた以外は変わっていない**——中身・移行の手順は
[CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` 節 `### Breaking`（「`@mnemora/testkit`
の conformance suite が…」の項目）を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 足した `it` は、上の「数え方の規律への追記
（2026-09-28）」規律2 の ⛔ が挙げる「conformance スイートの判定を厳しくする変更」に
当たる——型検査は壊れないが、この約束のどれかを満たしていない自前実装は、
conformance suite を当てると新しく落ちる（実行時に壊れる）。項目21（PR #1394）・
項目23（PR #1413）と同じ判断である。

**誰が影響を受けるか**: 自前の `MemoryStore`/`VectorStore`/`EventStore`/`OutboxStore`
実装を、`packages/testkit` の conformance suite に対して走らせている利用者のうち、
この PR が足した約束のどれかを満たしていない場合。**適合テストを走らせていない・
自前実装を持たない利用者は影響を受けない。**
**`packages/testkit/README.md` の最小の例（`MyEventStore`）のとおりに書いた `EventStore`
も落ちる**——その例は `append` で受け取った入力をそのまま保存して返し、`get` も
保存した行をそのまま返していたので、A8 の「渡した入力・返した値を呼び手が書き換えても、
store の中は変わらない」を満たしていなかった（この変更で、例のほうを
`structuredClone` で写す形に直した）。

**どう直すか**: CHANGELOG の同項目の「移行の手順」を見ること。

**DB マイグレーション**: 不要（スキーマは変えていない。テストのみの変更）。

### 25. `MemoryStore.purgeMemory?` が消す範囲が広がった——`tags`/`attributes`/claim key・label の紐付け・`recalls.index_band` の digest 帯（`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）

[Issue #994](https://github.com/takecchi/mnemora/issues/994)・
[Issue #995](https://github.com/takecchi/mnemora/issues/995)・
[Issue #1207](https://github.com/takecchi/mnemora/issues/1207)、
[PR #1427](https://github.com/takecchi/mnemora/pull/1427)、
[ADR 0375](./decisions/0375-purge-scope-widened.md)。**この項目は、上の棚卸しの範囲の
外——purge の法的な射程を広げる作業として、この節に足す1件である。**

**何が変わったか**: `MemoryStore.purgeMemory?`（任意メソッド）の契約が広がった。
これまで `content`/`digest`/`purgedAt` だけを書いていたのが、同じ書き込みで
`tags` を `[]` へ、`attributes` を `{}` へ、claim key の2列（`claimKey`）を `null`
へ上書きし、同じトランザクションでこの Memory に紐づく label の紐付け
（`memory_labels` 相当）を外して `proposedCount` を減らし、このテナントの
`recalls` の `IndexBand.digestBand` からこの `memoryId` のエントリを見つけて
`digest` をトゥームストーンへ書き換えるようになった。**型は変えていない**
（`purgeMemory?` のシグネチャ自体は同じ）。公開 API の型の差分
（`scripts/__snapshots__/public-api/testkit.d.ts`）は、`@mnemora/testkit` の
`InMemoryMemoryStore` に private メンバ `memoryLabels`・`memoryLabelKey` が増えたこと
だけである——`private` なので利用者のコードからは参照できず、このクラスは以前から
private メンバを持つので型の互換の性質も変わらない（PR #1114 の `rawGet` と同じ扱い）。
破壊的と数える理由は型ではなく、下の conformance と実行時の振る舞いである。中身・移行の手順は
[CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` 節 `### Breaking`（「`MemoryStore.purgeMemory?`
が消す範囲を広げた」の項目）を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: `packages/testkit` の conformance suite
（`describeMemoryStoreConformance`）に、この広げた範囲を縛る `it` を3本足した
——上の「数え方の規律への追記（2026-09-28）」規律2 の ⛔ が挙げる「conformance
スイートの判定を厳しくする変更」に当たる。加えて、`purgeMemory?` を自前実装
している第三者 adapter が「purge は `content`/`digest`/`purgedAt` 以外を変えない」
という前提でテストを書いていた場合、この PR のあとに揃えた conformance を
当てると新しく落ちうる（実行時に壊れる）。項目21（PR #1394）・項目23（PR #1413）・
項目24（Issue #1412）と同じ判断である。

**誰が影響を受けるか**: 自前の `MemoryStore` 実装（`purgeMemory?` を持つもの）を、
`packages/testkit` の conformance suite に対して走らせている利用者のうち、この
PR が足した約束のどれかを満たしていない場合。**`purgeMemory?` を実装していない
adapter（`Runtime.purge` が `supported: false` を返す構成）は影響を受けない。**
**適合テストを走らせていない利用者は、型検査には現れないまま、`@mnemora/postgres`・
`@mnemora/testkit` を使っている場合は実行時の振る舞いが変わる**——purge の後、
これまで残っていた `tags`/`attributes`/claim key・label の紐付け・`recalls.index_band`
の元の digest が消える／伏せられる。

**どう直すか**: CHANGELOG の同項目の「移行の手順」を見ること。

**DB マイグレーション**: 不要（新しい列・表は追加していない。既存列への書き込み範囲が
広がっただけ）。

⟹ **この節の範囲（`v1.0.2`…この変更の着地点）で、確定した破壊的変更は8件
（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、
PR #1394・Issue #1237「案1」、Issue #1301、Issue #1238、Issue #1412、
PR #1427・Issue #994・#995・#1207（ADR 0375））になった。**

### 26. `MemoryStore.createMemoryWithOutbox`/`supersedeWithNewMemories?` の `opts.abortIfForgotten`（`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）

[Issue #1226](https://github.com/takecchi/mnemora/issues/1226)、
[PR #1428](https://github.com/takecchi/mnemora/pull/1428)、
[ADR 0375](./decisions/0375-purge-scope-widened.md) 決定7・2026-09-30 追記。
**PR1（[PR #1427](https://github.com/takecchi/mnemora/pull/1427)、項目25）の後に
着地した、この節の2件目である。**

**何が変わったか**: `consolidate`/`reflect` が LLM を待つ間に、材料（統合元・内省の
材料）が `forget`（さらに `purge`）されても、その本文から作った新しい Memory が
`active` で書かれてしまう競合（Issue #1226 本文）を閉じた。`runtime.consolidate`/
`runtime.reflect` は、LLM が返った直後・書き込みの直前に eligible を読み直し、1件でも
`forgotten` なら新しい `outcome: 'aborted_source_forgotten'` で打ち切る（統合先・
内省の Memory を一切作らない）。**型としては次の3つを追加しただけ**（削除・必須化・
型の狭小化は無い）:

- `MemoryStore.createMemoryWithOutbox`/`supersedeWithNewMemories?` の `opts` に
  `abortIfForgotten?: ReadonlyArray<MemoryId>` を追加。
- `ConsolidateOutcome`/`ReflectOutcome` の union に `"aborted_source_forgotten"` を追加、
  `ConsolidateSourceOutcome`/`ReflectBasisOutcome` の union に
  `{ kind: "forgotten_before_write" }` を追加。
- 新しい公開クラス `SourceMemoryForgottenError`（`@mnemora/core`）を追加。

これらはいずれも「数え方の規律への追記（2026-09-28）」により非破壊（union への追加・
opts への省略可能フィールドの追加）。**破壊的と数える理由はこれらの型ではなく、下の
conformance の判定を厳しくする変更である。**中身・移行の手順は
[CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` 節 `### Breaking`（「`consolidate`/`reflect`
が forget/purge された材料から新しい記憶を書かなくなった」の項目）を見ること。
**ここには複製しない。**

**なぜ破壊的と数えるか**: `packages/testkit` の conformance suite
（`describeMemoryStoreConformance`）に、任意フラグ `supportsAbortIfForgotten?`
（3状態、`supportsOnlyMemoryIdsFilter?`/`supportsLabels?` と同じ形）を新設し、
`true` を宣言した adapter に対して `opts.abortIfForgotten` の契約の歯（forgotten な
id を含めると `SourceMemoryForgottenError` を投げて何も書かない、forgotten でなければ
今日どおり書く）を実行するようにした——上の「数え方の規律への追記（2026-09-28）」
規律2 の ⛔ が挙げる「conformance スイートの判定を厳しくする変更」に当たる。項目21・
23・24・25 と同じ判断である。**`supportsAbortIfForgotten` は任意（`?: boolean`）
であり、渡さない・`false` を渡す既存の呼び出し元はこの新しい歯を1本も実行しない**
——PR #524/PR #526（ADR 0237）の前例に倣い、新しい独立した能力のフラグを必須には
しなかった。

**誰が影響を受けるか**: `opts.abortIfForgotten` を自分で渡している呼び出し側（Postgres
以外の `MemoryStore` 実装を使っていて、かつこの欄を明示的に使っている場合）だけ、
実行時の振る舞いが変わりうる。**`runtime.consolidate`/`runtime.reflect` を直接呼ぶ
だけの利用者は、`ConsolidateOutcome`/`ReflectOutcome` を網羅的に分岐している場合
だけ型検査で気づく**（union に値が増えたため。exhaustive switch は `never` の分岐で
落ちる）——今日どおりの分岐（`default`/未網羅の分岐）ならコンパイルは壊れない。

⚠ **実例（本 PR 自身で起きた）**: `examples/chat/src/consolidation-cost.ts` は
`outcomes[result.outcome] += 1` という形で `ConsolidateOutcome` を **index** に使って
おり（`Record` に似た「全値に対応する欄を持つ型」を経由）、`"aborted_source_forgotten"`
を足したことで CI の typecheck が `TS7053`（index の型に無い値がある）で落ちた
——exhaustive `switch` の `never` 検査だけでなく、この種の「全値に対応する欄を持つ
`Record` 型を index する」形も同じ理由で型検査に引っかかる。**「union に値を足す
変更は破壊的と数えない」という判定はこの実例でも変えていない**——影響の一言として
記録する（対応: `ConsolidationOutcomeCountsJson`/`emptyOutcomeCounts` に同名の欄を足した）。
`packages/testkit` の conformance suite を自分の `MemoryStore` 実装に対して走らせて
いる利用者は、`supportsAbortIfForgotten` を渡さなければ影響を受けない。

**どう直すか**: CHANGELOG の同項目の「移行の手順」を見ること。

**DB マイグレーション**: 不要（新しい列・表は追加していない。`@mnemora/postgres` の
`createMemoryWithOutbox`/`supersedeWithNewMemories` が、`opts.abortIfForgotten` を
渡されたときだけ追加の `SELECT … FOR UPDATE` を発行する）。

### 27. `packages/testkit` の conformance suite が、自前の `MemoryStore` 実装に約束を新しく課すようになった（`@mnemora/core`・`@mnemora/testkit`）

[Issue #933](https://github.com/takecchi/mnemora/issues/933)（claim key の自動 contested
検出が、同じ鍵の主張が1件ずつ届く経路で3件目以降を検出できない）の PR1、
[PR #1431](https://github.com/takecchi/mnemora/pull/1431)、
[ADR 0378](./decisions/0378-claim-key-contested-detection-covers-contested-matches.md)。

**何が変わったか**: `@mnemora/core` の `MemoryStore` に、新しい任意メソッド
`findContestedByClaimKey?`（`findActiveByClaimKey?` と同じ絞り込みで、`status = 'active'`
の代わりに `status = 'contested'` の行を返す）が増えた。`packages/testkit` の
`describeMemoryStoreConformance` に、これを検査する `it` と、新しい任意フラグ
`MemoryStoreConformanceOptions.supportsFindContestedByClaimKey?: boolean`
（`supportsFindActiveByClaimKey?` と同じ3状態）が増えた。**公開の型は、この2つの
任意の追加以外は変わっていない**——中身・移行の手順は [CHANGELOG.md](../CHANGELOG.md) の
`[1.1.0]` 節 `### Breaking`（「`@mnemora/core` の `MemoryStore` に…」の項目）を見ること。
**ここには複製しない。**

**なぜ破壊的と数えるか**: 上の「数え方の規律への追記（2026-09-28）」規律2 の ⛔ が挙げる
「conformance スイートの判定を厳しくする変更」に当たる——型検査は壊れないが、
`supportsFindContestedByClaimKey: true` を渡して `findContestedByClaimKey` を実装して
いない自前実装は、conformance suite を当てると新しく落ちる。項目23・24・25・26 と同じ
判断である。

**誰が影響を受けるか**: 自前の `MemoryStore` 実装を、`packages/testkit` の conformance
suite に対して走らせている利用者のうち、`supportsFindContestedByClaimKey: true` を
渡しているが `findContestedByClaimKey` を実装していない場合。**`findContestedByClaimKey?`
を実装しない・`supportsFindContestedByClaimKey` を渡さない利用者は影響を受けない**
——後方互換。`Runtime.detectClaimKeyContested` 自体も、この口が無い adapter に対しては
今まで通り `findActiveByClaimKey?`（`active` のみ）の一致だけで判定する。

**どう直すか**: CHANGELOG の同項目の「移行の手順」を見ること。

**DB マイグレーション**: 不要——既存の索引 `idx_memories_claim_key`
（`(tenant_id, subject_id, claim_key_subject, claim_key_predicate)`、`status` を条件に
含めない汎用索引）がそのまま使える。新しい migration は追加していない。

⟹ **この節の範囲（`v1.0.2`…この変更の着地点）で、確定した破壊的変更は10件
（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、
PR #1394・Issue #1237「案1」、Issue #1301、Issue #1238、Issue #1412、
PR #1427・Issue #994・#995・#1207（ADR 0375）、Issue #1226（ADR 0375 決定7・
2026-09-30 追記）、PR #1431・Issue #933）になった。**

### 28. `MemoryStore` に必須メソッド `listBySourceObservationAllVersions` が増えた（`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）

[Issue #1432](https://github.com/takecchi/mnemora/issues/1432)、
[PR #1435](https://github.com/takecchi/mnemora/pull/1435)、
[ADR 0380](./decisions/0380-reextract-withdrawn-across-extractor-versions.md)。

**何が変わったか**: `extractorVersion` を上げた runtime インスタンスで `reextract()` を
呼ぶと、前の版で `forget`（purge を含む）・`contested` にした記憶を見落とし、退けた
はずの内容と同じ意味の Memory が印の無い新しい `active` として書き直されうる欠陥
（Issue #1432 本文）を閉じた。`Runtime.reextract` の「退けた記憶」の判定は、いまは
`extractorVersion` を問わず同じ Observation 由来の Memory を見る。

- **`MemoryStore` に必須メソッド
  `listBySourceObservationAllVersions(ctx, observationId): Promise<Memory[]>` を追加した**
  （既存の `listBySourceObservation` は1行も変えていない。SELECT のみ、マイグレーション・
  索引は追加しない）。
- 版を跨いでも、1件でも退けたものがあれば、その Observation の抽出全体を打ち切る
  （同じ版のときと同じ規律。同じ Observation の他の、退けていない `active` な事実も
  作り直さない）。**帰結**: 運用側が旧い版の記憶を forget すると、その Observation の
  ほかの事実も、以後の reextract では想起から作られなくなる。`skipped` に
  `status_not_active` が出た Observation では、旧い版の記憶を残すことが運用側の
  手がかりになる（詳細は CHANGELOG・ADR 0380）。
- **版を跨いだ `active` の扱い（項目「Issue #873」の「運用側の責務」）は変えていない**
  ——supersede 対象の判定は今どおり今の `extractorVersion` 限定のまま。

中身・移行の手順は [CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` 節 `### Breaking`
（「`MemoryStore` に `listBySourceObservationAllVersions` が増えた」の項目）を見ること
——**ここには複製しない。**

**なぜ破壊的と数えるか**: `MemoryStore` は公開 interface であり、既存メソッドと同じ並びに
**必須**メソッドを追加した——自前で `MemoryStore` を実装している第三者は、このメソッドを
実装しないとその実装が interface を満たさなくなる（項目12「`Runtime` に必須メソッド
`restoreSuperseded` が増えた」等と同じ扱い）。任意メソッド（`?`）にしなかった理由は
ADR 0380「検討した代替案」を見ること。

**誰が影響を受けるか**: `@mnemora/postgres`・`@mnemora/testkit` の `InMemoryMemoryStore`
以外で自前の `MemoryStore` 実装を持っている利用者だけ、型検査が落ちる。`runtime.reextract`
を直接呼ぶだけの利用者（`@mnemora/postgres`・`@mnemora/testkit` を使う場合を含む）は、
型的な変更を受けない——挙動だけが変わる（版を跨いで退けた記憶がある Observation では、
今まで作られていた新しい `active` が作られなくなる）。

**どう直すか**: 自前の `MemoryStore` 実装に
`listBySourceObservationAllVersions(ctx, observationId)` を実装する——
`tenant_id`・`source_observation_id` が一致する行を、`extractor_version`・`status` の
どちらでも絞らずに返すだけでよい（`listBySourceObservation` の実装から
`extractor_version` の絞り込みを外した形）。

**DB マイグレーション**: 不要（新しい列・表は追加していない。既存の一意索引
`uq_memories_extraction (tenant_id, source_observation_id, extractor_version,
content_hash)` が `(tenant_id, source_observation_id)` の前方一致でも Index Scan に
使える。ADR 0380 の EXPLAIN 実測を参照）。

⟹ **この節の範囲（`v1.0.2`…この変更の着地点）で、確定した破壊的変更は11件
（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、
PR #1394・Issue #1237「案1」、Issue #1301、Issue #1238、Issue #1412、
PR #1427・Issue #994・#995・#1207（ADR 0375）、Issue #1226（ADR 0375 決定7・
2026-09-30 追記）、PR #1431・Issue #933、Issue #1432（ADR 0380））になった。**

⚠ **項目29 は、[Issue #933](https://github.com/takecchi/mnemora/issues/933) PR2（多者間の
グループを `contested` として束ねる書き込み、まだ OPEN）が使う予定の欠番である。**
本項目（30）はそれより先に着地する可能性があるため、番号だけ先に確定して欠番のまま
残す——着地順が入れ替わった場合はマージ側が並びを確認し、必要なら番号を付け替える
（[ADR 0179](./decisions/0179-adr-number-assigned-at-merge.md) と同じ「マージ直前に
確定させる」規律。付け替える場合は [ADR 0200](./decisions/0200-adr-renumber-warns-when-titles-need-fixing.md)
の道具に従うこと）。

### 30. `VectorStore` に必須メソッド `deleteAcrossSpaces` が増えた（`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）

[Issue #1425](https://github.com/takecchi/mnemora/issues/1425)、
[PR #1437](https://github.com/takecchi/mnemora/pull/1437)、
[ADR 0382](./decisions/0382-vector-store-delete-across-spaces.md)。**この項目は、上の
棚卸しの範囲の外——ADR 0375 決定5が切り出した未決事項に対する、この節に足す1件である。**

**何が変わったか**: `@mnemora/core` の `VectorStore` interface に、新しい**必須**メソッド
`deleteAcrossSpaces(ctx: Ctx, memoryIds: readonly MemoryId[]): Promise<void>` が増えた。
`ctx.tenantId` に属する `memoryIds` の行を、その adapter が持つ**全 space**（`upsert`/
`search`/`delete` が `space` 引数で区切る単位のすべて）から消す——`delete` と違い
`space` 引数を受け取らない。`Runtime.purge` は、`purgeMemory` 成功後・および
`already_purged`（`dryRun` を除く）のベストエフォートの埋め込み削除を、
`deps.vectorStore.delete(ctx, deps.embeddingProvider.space, id)`（今の1つの space だけ）
から `deps.vectorStore.deleteAcrossSpaces(ctx, [id])`（全 space）へ置き換えた。
`PostgresVectorStore`・`@mnemora/testkit` の `InMemoryVectorStore`・
`@mnemora/core` のテスト用 `FakeVectorStore` は、いずれもこの新しいメソッドを実装する。
中身・移行の手順は [CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` 節 `### Breaking`
（「`VectorStore` に `deleteAcrossSpaces` を足した」の項目）を見ること。
**ここには複製しない。**

**なぜ破壊的と数えるか**: `VectorStore` interface に必須メソッドが増えたため、
自前で `VectorStore` を実装している第三者 adapter は、この新しいメソッドを実装
しなければ型検査に落ちる——項目1・5・12・14・16 と同じ「interface に必須メソッドが
増えた」族（このファイル冒頭の「破壊的変更の数え方」参照）。`packages/testkit` の
`describeVectorStoreConformance` にも、`deleteAcrossSpaces` の契約（複数 space から
消える・他テナントの行は消えない・存在しない/形式不正な id・空配列は no-op）を
検査する歯を足した——省略可能なオプションにしていない（`VectorStoreConformanceOptions`
自体は1つも増やしていない。upsert したベクトルが実際に使う `space`/`spaceB` を
そのまま流用できたため——`prepareEmbeddingSpace` フックは ADR 0065 から既に在る）。

**誰が影響を受けるか**: 自前の `VectorStore` 実装（第三者 adapter）を持つ利用者は、
`deleteAcrossSpaces` を実装しない限り型検査に落ちる——**必ず対応が要る**（任意
メソッドの追加とは異なる）。`packages/testkit` の conformance suite を自分の
`VectorStore` 実装に対して走らせている利用者は、この新しいメソッドの契約を満たさな
ければ conformance suite が新しく落ちる。`@mnemora/postgres`・`@mnemora/testkit`の
`InMemoryVectorStore`・`Runtime.purge` をそのまま使っているだけの利用者は、型・
実行時のどちらも変える必要はない（参照実装が既に対応済み）——purge の埋め込み削除の
対象が「今の space だけ」から「全 space」に広がるという**実行時の振る舞いの変化**
だけを受ける。

**どう直すか**: 自前の `VectorStore` 実装に `deleteAcrossSpaces` を足す。`upsert`/
`search`/`delete` が管理している「space ごとの区切り」を、adapter 自身の内部データ
構造から辿れる形（例えば `packages/postgres` はカタログを読んでテーブルを列挙する、
`packages/testkit`/core の Fake は保持している全エントリを tenantId/memoryId だけで
フィルタする）で実装すること。`packages/postgres/src/vector-store.ts` の
`deleteAcrossSpaces` の doc コメント（列挙の3条件とその理由）を実装の参考にできる。

**DB マイグレーション**: 不要（新しい列・表は追加していない。`PostgresVectorStore`
の実装はカタログ（`pg_class`/`pg_constraint`/`pg_attribute`）を読むだけで、
`registerEmbeddingSpace` が作るテーブルの形（外部キー付き）は変えていない）。

⟹ **この節の範囲（`v1.0.2`…この変更の着地点）で、確定した破壊的変更は12件
（PR #1377・Issue #1221、PR #1385・Issue #548 方向2、PR #1393・Issue #1232、
PR #1394・Issue #1237「案1」、Issue #1301、Issue #1238、Issue #1412、
PR #1427・Issue #994・#995・#1207（ADR 0375）、Issue #1226（ADR 0375 決定7・
2026-09-30 追記）、PR #1431・Issue #933、Issue #1432（ADR 0380）、
PR #1437・Issue #1425（ADR 0382）) になった。**

## 🔴 破壊的変更（v1.1.0 → 次の版）—— **未リリース**

この節は、`v1.1.0`（tag が指す `5eb6e9d`）より後に `main` へ入った変更を数える。まだ棚卸しはしておらず、
下の項目は、着地に先立って変更を作った本人が足したものである。⛔ ここに件数を書かないこと
（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。

⚠ **項目の番号について**: 番号は `v1.0.2 → v1.1.0` の節から通しで振っている。項目29 は、
上の節の項目30 の後ろの注記が「[Issue #933](https://github.com/takecchi/mnemora/issues/933) PR2 が使う予定の欠番」として
取っておいた番号である。その変更（[PR #1442](https://github.com/takecchi/mnemora/pull/1442)）は
`v1.1.0` に間に合わなかったので、この節で項目29 を使う——そのため、文書の上から読むと番号が
30 → 29 と前後する。出荷済みの上の節は書き換えないので、上の節の項目29 は欠番のまま残る。

### 29. `packages/testkit` の conformance suite が、自前の `MemoryStore` 実装に約束を新しく課すようになった。新しい interface `RelationStore` と、それを検査する新設の conformance suite も増えた（`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）

[Issue #207](https://github.com/takecchi/mnemora/issues/207)・
[Issue #933](https://github.com/takecchi/mnemora/issues/933) PR2、
[PR #1442](https://github.com/takecchi/mnemora/pull/1442)、
[ADR 0381](./decisions/0381-contested-group-write-path-implementation.md)。

⚠ **非破壊に数え直した（番号の参照を崩さないため、ここに残す）**: 下の「破壊的変更として数えない」の
とおり 2026-10-01 に非破壊へ数え直した。置き場所は 🔴 の節のままで、項目を動かしていない
（[ADR 0441](./decisions/0441-changelog-migration-refs-consumer-smoke-names.md)）。

**何が変わったか**:

- `@mnemora/core` に新しい interface `RelationStore`（`link`/`unlink`/`listRelated`と、任意の
  `listRelatedMany?`）を足した。`@mnemora/postgres`（`PostgresRelationStore`）・`@mnemora/testkit`
  （`InMemoryRelationStore`）が実装する。`packages/testkit` に新設の conformance suite
  `describeRelationStoreConformance` ができた——`packages/testkit`
  （`in-memory-fixtures.conformance.test.ts`）・`@mnemora/postgres`
  （`conformance.postgres.test.ts`）の両方が当てている。
- `@mnemora/core` の `MemoryStore` に、新しい任意メソッド `markContestedGroup?`/
  `resolveContestedGroup?`（3件以上専用、`markContestedPair?`/`resolveContestedPair?` の
  N者版）が増えた。`packages/testkit` の `describeMemoryStoreConformance` に、これを検査する
  `it` と、新しい任意フラグ `MemoryStoreConformanceOptions.supportsMarkContestedGroup?`/
  `supportsResolveContestedGroup?: boolean`（既存の3状態フラグと同じ形）が増えた——群の
  一部だけを渡した `resolveContestedGroup?` を専用のエラー
  （`ContestedGroupMembershipMismatchError`、新設）で拒む約束、有効期間の重なりの境目
  （半開区間・マイクロ秒精度）の約束も検査する。
- 中身・移行の手順は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Added`
  を見ること。**ここには複製しない。**

**破壊的変更として数えない**（2026-10-01 に数え直した。書いた当初は、上の「数え方の規律への追記
（2026-09-28）」規律2 の ⛔「conformance スイートの判定を厳しくする変更」に当たるとして数えていた）。
足した `it` は、この変更で新しくできた任意フラグ `supportsMarkContestedGroup?`/`supportsResolveContestedGroup?`
の内側にだけある。口（`markContestedGroup?`/`resolveContestedGroup?`）もフラグも持たない adapter には、
新しい約束を課さない。`describeRelationStoreConformance` も、新しくできた interface の新設の suite である。
[PR #1516](https://github.com/takecchi/mnemora/pull/1516) が #1507 の適合テストで採った判定
（任意フラグの内側で、口もフラグも持たない adapter に新しい約束を課さないものは数えない）と、
同じ版の任意フラグの追加（CHANGELOG `[1.2.0]` の `### Added` の `implementsListRelatedMany?`・
`supportsPurgeExpiredRecalls?` など）に揃えた。既存のフラグの枝に `it` を足した項目39 とは形が違う。
番号は、CHANGELOG と上の節の欠番の注記から指されているので残す。

**誰が影響を受けるか**: 自前の `MemoryStore` 実装を `packages/testkit` の conformance
suite に対して走らせている利用者のうち、上の2つの任意フラグを `true` で渡しているが
実装していない場合だけ。**`markContestedGroup?`/`resolveContestedGroup?` を実装しない・
上の2つのフラグを渡さない利用者は影響を受けない**——後方互換。`RelationStore` を
`RuntimeDeps.relationStore?` へ配線するかどうかも任意——配線しなくても
`recall()` は今日どおり動く。

⚠ **非破壊の注記（オーナー回答 ask_human `d9364c91` の規律）**: `ContestedDetectionOutcome.
result`（`@mnemora/core`）の判別可能 union に増えた `"contested_group"`、`Omission` の
`over_limit`/`stage_skipped` の `stage` 列挙に増えた `"relation"` は、**この文書の定義では
破壊的変更に数えない**——`RecallStageName` への `"association"` の追加（ADR 0151 追記）・
`ConsolidateOutcome`/`ReflectOutcome` への `"aborted_source_forgotten"` の追加
（CHANGELOG `[1.1.0]` 節 `### Breaking` の実例）と同じ「union に値を足す変更」である。
網羅的な `switch`/`Record` でこれらの型を扱っている利用者は型検査が落ちうるが、それは
union 拡張一般の影響であり、この文書が破壊的変更として数える基準（interface への必須
メンバ追加・署名そのものの変更・conformance suite の要件強化）には当たらない。

**どう直すか**: 自前の `MemoryStore` 実装に `markContestedGroup?`/`resolveContestedGroup?`
を実装する場合は、conformance suite に `supportsMarkContestedGroup: true`/
`supportsResolveContestedGroup: true` を渡す。実装しない場合は何もしなくてよい（省略時は
「未検査」のまま、後方互換の振る舞いが保たれる）。`RelationStore` を自前実装する場合は
`describeRelationStoreConformance` を当てる。

**DB マイグレーション**: 新しい migration `0026_memory_relations.sql` が1本増える
（`memory_relations` テーブルを新設するだけ）。利用者は `mnemora-postgres-migrate`
（または `runMigrations`）を打つこと。

⟹ **この項目（PR #1442・Issue #207・#933 PR2（ADR 0381））は、この節が数える破壊的変更に入れない。**移行の手順と DB マイグレーションの案内として残す。

### 31. テナント単位で全表から行を消す `eraseTenant` が増え、conformance suite に省略できない `supportsEraseTenant` が増えた（`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）

[Issue #1207](https://github.com/takecchi/mnemora/issues/1207)、
[PR #1444](https://github.com/takecchi/mnemora/pull/1444)、
[ADR 0383](./decisions/0383-erase-tenant.md)。

**何が変わったか**: `@mnemora/core` に独立関数 `eraseTenant(ctx, deps, opts)` が増え、
`MemoryStore`・`VectorStore`・`OutboxStore`・`TenantSettingsStore` に任意メソッド
`eraseTenant?` が増えた。`packages/testkit` の4つの conformance suite の options に
`supportsEraseTenant: boolean` が**省略できない**形で増えた。`@mnemora/postgres` に
DB マイグレーション `0027_erase_tenant_fk_indexes.sql` が増えた。中身・移行の手順は
[CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。
**ここには複製しない。**

**なぜ破壊的と数えるか**: conformance suite を呼んでいるコードは、`supportsEraseTenant`
を渡すまで型検査が通らない。項目27（任意のフラグが増えた）より一段強く、型の上で壊れる。
port に足したメソッドは任意（`?`）なので、自前の store の実装そのものは壊れない。

**誰が影響を受けるか**: `packages/testkit` の `describeMemoryStoreConformance`・
`describeVectorStoreConformance`・`describeOutboxStoreConformance`・
`describeTenantSettingsStoreConformance` を呼んでいる利用者。`@mnemora/postgres` を
使っている利用者は、migration の適用（下）が要る。

**どう直すか**: CHANGELOG の同項目の「移行の手順」を見ること。
移行ガイドの既存の例（項目6 の `describeTenantSettingsStoreConformance` の片）も、
今の型で通るよう `supportsEraseTenant: false` を足して合わせて直した。

**DB マイグレーション**: 要る——`0027_erase_tenant_fk_indexes.sql`。外部キー検査のための
単一列の索引8本（`memory_events(memory_id)`・`recall_usages(memory_id)`・
`recall_usages(recall_id)`・`memory_labels(memory_id)`・
`memories(source_observation_id)`・`memories(superseded_by_id)`・
`memory_relations(from_memory_id)`・`memory_relations(to_memory_id)`）を足し、既存の埋め込み
空間の表（`memory_embeddings_<space>`）にも `(memory_id)` の索引を遡って足す。

⚠ **運用の注意——索引を作るあいだ、書き込みが止まる。**この migration の `CREATE INDEX`
は `CONCURRENTLY` を使わない（`0004` などと同じ前例、ADR 0059・ADR 0062）。
`CREATE INDEX` は対象の表に `ShareLock` を取る——読み取りは止めないが、`INSERT`/
`UPDATE`/`DELETE` は索引ができるまで待たされる。止まる時間の目安は、ADR 0059・ADR 0062
（[#1423](https://github.com/takecchi/mnemora/issues/1423) で訂正済み）が `memories`
への同じ種類の索引で実測した「100万行で約2.1秒」の形である。この PR 自身は 100万行規模で
測り直していない。書き込みの多い時間帯を避けて当てること。

⚠ **2026-10-01 追記（[ADR 0442](./decisions/0442-migrate-deadlock-subject-injection-ddl-lock-wait-docs.md)）: 止まるだけでなく、deadlock しうる。この migration は、アプリの書き込みを止めてから当てること。**
0027 は1つのトランザクションの中で、`memory_events`・`recall_usages`・`memory_labels`・`memories` などに `CREATE INDEX` を続けて撃ち、
それぞれの表の `ShareLock` をコミットまで持つ。一方 `observe()` のトランザクションは、`memories` に書いて `RowExclusiveLock` を持ったまま
`memory_events` へ書く。2つが互い違いに表を取り合うので、止めずに当てると deadlock（SQLSTATE `40P01`）になりうる。
【実測】2026-10-01、PostgreSQL 17・ローカル、memories 10万件・recalls 3万件の DB で、observe・recall・tick を4本のループで回しながら
0025・0027〜0032 を当てた。5回のうち4回で deadlock になり、犠牲はどちらの側にもなった:
- migrate 側が犠牲のとき（2回）: `migration 0027_erase_tenant_fk_indexes.sql failed: deadlock detected` で失敗する。ロールバックされ、台帳は進まない。
  もう一度 `runMigrations` を当てれば適用される。
- アプリ側が犠牲のとき（計4件）: `observe()` が `40P01` の例外で落ちる。その observation は保存されたまま、memory は作られない。
  extract のジョブは claim されたまま残り、リースが切れた後に `tick` が拾い直して抽出する（同期抽出が途中で失敗したときと同じ扱い）。

**未測定**: 0027 以外で複数の表を1トランザクションで触る migration（`0020`・`0032` など）が同じ形で deadlock するかは、測っていない。
同じ形の migration も、書き込みを止めてから当てるのが安全である。

なぜ索引が要るか（実測、[ADR 0383](./decisions/0383-erase-tenant.md)）: PG 17.11、消す
テナント 10万 memories・ほかのテナント計20万 memories で、子の表を先に消してから
`memories` を消すと、索引なしでは2000行で 90.0 秒（`memory_events` の外部キー検査が
ほかのテナントの行も含めて表全体を走査する）、索引ありでは 0.50 秒だった。INSERT の遅れは
約4〜5%（`memory_events` へ5万行、3回ずつ。測り方は ADR 0383）。

⟹ **この項目（PR #1444・Issue #1207（ADR 0383））も、この節が数える破壊的変更である。**

⚠ **非破壊の追記（2026-09-30、[PR #1455](https://github.com/takecchi/mnemora/pull/1455)、
[ADR 0384](./decisions/0384-digest-band-index-and-scope-aggregate-skip.md)）**:
`aggregateScope` の目次帯（digestBand）まわりの性能改善で、新しい migration
`0028_digest_band_index.sql` が1本増えた（部分索引 `idx_memories_digest_band` の
追加のみ。列・型・SQL 文・返り値はどれも変えていない）。**この文書の定義では
破壊的変更に数えない**——ここに書くのは、DB を更新する利用者向けの実務上の
案内である。`RecallQuery.scopeAggregate?: "exact" | "skip"`（同 PR、既定 `"exact"`
で1バイトも変わらない）は新しい任意の欄1つの追加のみで、DB マイグレーションは
伴わない。

**DB マイグレーション**: 新しい migration `0028_digest_band_index.sql` が1本増える
（部分索引の追加のみ）。`v1.1.0` から上げる場合は `0026`〜`0028` の3本（`0027` は PR #1444 の
`0027_erase_tenant_fk_indexes.sql`）、`v1.0.2` からは `0023`〜`0028` の6本が要る。索引の構築は素の `CREATE INDEX`
（`CONCURRENTLY` 不可、`packages/postgres/src/migrate.ts` が各 migration ファイルを
1トランザクションで包むため）——対象テーブル（`memories`）に `SHARE` ロックを取る
（**書き込みは構築が終わるまで止まり、読み取りは通る**。`ACCESS EXCLUSIVE` ではない）。
本番適用時は書き込みが止まる時間を見込むこと（構築時間は ADR 0384「測ったこと」を見ること）。

⚠ **追記（`0029`・`0030` の2本、上の本数の訂正）**: 上の段落は `0028` の時点で書かれ、その後に増えた
migration を数えていない。**この節（`v1.1.0` より後）で足された migration は `0026`〜`0030` の5本、
`v1.0.2` からは `0023`〜`0030` の8本である**（上の「3本」「6本」は、それぞれ5本・8本と読み替えること）。
`0029`・`0030` はどちらも索引の追加のみで、列・型・SQL 文・返り値は変えず、公開 API も変えない。
**この文書の定義では破壊的変更に数えない**（実務上の案内としてここに書く）。

- **`0029_memories_claim_predicates_index.sql`**（[PR #1457](https://github.com/takecchi/mnemora/pull/1457)、
  [ADR 0329](./decisions/0329-claim-key-known-predicates-from-store.md) の 2026-09-30 追記）:
  `listActiveClaimPredicates` 用の部分索引 `idx_memories_claim_predicates`
  （`(tenant_id, subject_id, claim_key_predicate, created_at)`、`WHERE status = 'active' AND
  claim_key_subject IS NOT NULL AND claim_key_predicate IS NOT NULL`）を `memories` に足す。
  適用中は **`memories` への書き込みが止まる**（読み取りは通る）。
- **`0030_recalls_digest_band_index.sql`**（[ADR 0389](./decisions/0389-recalls-digest-band-index.md)）:
  `purge()` が `recalls.index_band` の目次帯を書き換える `UPDATE` 用に、式の GIN 索引
  `idx_recalls_digest_band`（`(index_band->'digestBand') jsonb_path_ops`）を `recalls` に足す。
  適用中は **`recalls` への書き込みが止まる**（読み取りは通る）。

どちらも素の `CREATE INDEX` である。`CONCURRENTLY` を使わない理由は `0027`・`0028` と同じで
（migration ファイルは1トランザクションで包まれ、`CONCURRENTLY` はその中で実行できない）、
`0029` は [Issue #760](https://github.com/takecchi/mnemora/issues/760) の決定（手で
`CONCURRENTLY` を流せる経路を作らない）にも従う。`ShareLock` の意味は上の `0028` の段落と同じで、
止まる時間は表の行数で決まる——書き込みの多い時間帯を避けて当てること。作成時間・索引サイズ・
書き込みへの上乗せの実測は、`0029` は ADR 0329 の追記、`0030` は ADR 0389 を見ること
（この PR は測り直していない）。

⚠ **2026-09-30 追記（`0030` の止まる時間）**: ADR 0389 本文の実測（10万行で `CREATE INDEX` 約5秒）は、1行あたりの目次帯が**5エントリ**の値である。`recall()` の既定の目次帯は `DEFAULT_DIGEST_BAND_LIMIT = 50` 件なので、**既定で使ってきた利用者の `recalls` では、10万行でおよそ25秒・索引は約381MB になる**（ADR 0389 末尾の追記。10万行・50エントリを、別の担当が約24秒・約381MB、この PR で 25.9秒・24.4秒・381MB と測った。100万行は測っていない）。止まるのは `recalls` への書き込み（`recall()` の記録の INSERT）で、行数に比例する。**`recalls` が大きい運用では、書き込みの少ない時間帯に当てること。**`CONCURRENTLY` にしないのは [Issue #760](https://github.com/takecchi/mnemora/issues/760) の決定のままで、この追記は変えていない。

⚠ **非破壊の追記（`0031` の1本、[ADR 0400](./decisions/0400-general-fk-index-tooth.md)）**:
新しい migration `0031_memory_labels_label_id_index.sql` が1本増えた（`memory_labels (label_id)`
の索引の追加のみ。列・型・SQL 文・返り値は変えず、公開 API も変えない）。**この文書の定義では
破壊的変更に数えない**。上の2つの段落の本数は、それぞれの時点のものである（**書き換えない**）。
いま数えるなら、`v1.1.0` から上げる場合は `0026`〜`0031` の6本、`v1.0.2` からは `0023`〜`0031` の
9本が要る。`0031` の索引の構築も素の `CREATE INDEX`（`CONCURRENTLY` を使わない理由は上と同じ）で、
適用中は **`memory_labels` への書き込みが止まる**（読み取りは通る）。

⚠ **非破壊の追記（`0032` の1本、[ADR 0412](./decisions/0412-purge-target-select-indexes.md)）**:
新しい migration `0032_purge_indexes.sql` が1本増えた（`recalls (tenant_id, created_at, id)` の索引
`idx_recalls_by_created` と、`outbox (tenant_id, completed_at, id) WHERE completed_at IS NOT NULL` の部分索引
`idx_outbox_completed` の追加のみ。列・型・SQL 文・返り値は変えず、公開 API も変えない）。**この文書の定義では
破壊的変更に数えない**。上の段落の本数は、それぞれの時点のものである（**書き換えない**）。
いま数えるなら、`v1.1.0` から上げる場合は `0026`〜`0032` の7本、`v1.0.2` からは `0023`〜`0032` の
10本が要る。`0032` の索引の構築も素の `CREATE INDEX`（`CONCURRENTLY` を使わない理由は上と同じ）で、
適用中は **`recalls` と `outbox` への書き込みが止まる**（読み取りは通る）。全 recall の INSERT と全 outbox の
`complete` に、purge を呼ばない場合も索引の分の上乗せが乗る（実測は ADR 0412）。

### 32. `OpenAIEmbeddingProvider.embed()` が、応答の件数・`index`・次元・成分の有限性が崩れていると例外を投げるようになった（`@mnemora/openai`）

[Issue #860](https://github.com/takecchi/mnemora/issues/860)、
[ADR 0305](./decisions/0305-embedding-provider-input-limit-contract.md) の 2026-09-30 追記。

⚠ **未リリース**（この節は `v1.1.0` より後の変更を数える。番号は項目31 の続き）。

**何が変わったか**: `OpenAIEmbeddingProvider.embed()` は、これまで応答を検査せず、`response.data` を `index` で
並べ替えて返すだけだった。今は、件数が入力と等しい・`index` が 0..n-1 をちょうど1回ずつ・各ベクトルの長さが
`dimensions` と等しい・成分がすべて有限、のどれかが崩れていれば、素の `Error`（メッセージは
`OpenAIEmbeddingProvider:` で始まる）を投げる。型・シグネチャは変わらない。中身は
[CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 型検査は壊れないが、**以前は例外にならなかった入力（食い違った応答）が、新しく例外に
なる**。このリポジトリは、既存の「conformance suite が新しく落とすようになる」変更（項目21・23・24・27）と
同じく、以前は通っていたものが通らなくなる変更を破壊的と数える。

**誰が影響を受けるか**: OpenAI（または `client` に注入した自前の偽物）が、`texts` と食い違う応答を返す場合だけ。
正常な応答を返す限り、何も変わらない。`Runtime.tick` の embed ジョブでは、この例外はジョブの失敗として扱われる。

**どう直すか**: 通常は何もしなくてよい。`client` に注入した偽物が、件数・次元が宣言と合わない（または `index` が
0..n-1 でない）応答を返しているなら、偽物を直すこと。`instanceof` で捕まえたい場合、専用のエラー型・`kind` は
無い（素の `Error`、メッセージは `OpenAIEmbeddingProvider:` で始まる）。

### 33. core が provider の埋め込みの長さと有限性を検査するようになり、次元違い・有限でない成分を含む embed ジョブは失敗に、同じ問い合わせベクトルは `embedding_provider_unavailable` になった（`@mnemora/core`）

[Issue #860](https://github.com/takecchi/mnemora/issues/860)、
[ADR 0393](./decisions/0393-core-checks-embedding-dimension.md)。

⚠ **未リリース**（この節は `v1.1.0` より後の変更を数える）。**番号は 33 である**——項目32 は
[PR #1462](https://github.com/takecchi/mnemora/pull/1462)（`OpenAIEmbeddingProvider.embed()` の応答検査）が使っている。

**何が変わったか**: `Runtime.tick` の embed ジョブは `VectorStore.upsert` の前に、`recall()` は provider が返した問い合わせベクトルを
使う前に、ベクトルの長さが `embeddingProvider.space.dimensions` と等しいこと、成分がすべて有限であることを確かめる。型・シグネチャは変わらない。
中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 型検査は壊れないが、**以前は通っていた入力が、通らなくなる／記録が変わる**。次の2点である。
既存の項目21・23・24・27 と同じく、以前は通っていたものが通らなくなる変更を破壊的と数える。

1. InMemory・Fake の経路で `'ready'` だったものが `failed` になる（provider が次元違い、または `NaN`/`Infinity` を含むベクトルを返したとき）。
2. recall の `omitted` の理由が、provider が次元違い・有限でない成分を含む問い合わせベクトルを返したとき `score_not_comparable` から
   `embedding_provider_unavailable` に変わる。

**誰が影響を受けるか**: provider が宣言（`space.dimensions`）と違う長さ、または `NaN`/`Infinity` を含むベクトルを返す場合だけ。正常な provider では何も変わらない。
`RecallQuery.vector` を直接渡す呼び出しと `VectorStore` の直接呼び出しは変わらない。

**どう直すか**: 自前の偽の provider が宣言と違う長さ、または有限でない成分を返しているなら、`space.dimensions` か返すベクトルを直すこと。
`omitted` の `score_not_comparable` の有無で「次元違い」を検出していた呼び出し側は、`embedding_provider_unavailable`
（`stage_skipped`、`stage: 'candidate_generation'`）も見ること。

**DB マイグレーション**: 要らない。

⟹ **この項目（Issue #860）も、この節が数える破壊的変更である。**
⛔ ここに件数を書かない（[ADR 0234](./decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。

### 34. `RelationStore.link` が、両端の記憶が `ctx` のテナントに属さない（または実在しない）ときに例外を投げるようになった（`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）

[ADR 0398](./decisions/0398-relation-store-link-checks-both-ends-belong-to-ctx-tenant.md)。

⚠ **未リリース**（この節は `v1.1.0` より後の変更を数える）。**番号は 34 である**——項目33 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: `RelationStore.link(ctx, kind, fromId, toId)` は、これまで両端が `ctx.tenantId` の記憶かどうかを確かめなかった。
今は書く前に確かめ、どちらかが実在しない（uuid の形でない id も同じ）、または別のテナントの記憶なら、行を書かずに
`memory not found for tenant: <id>` を含むメッセージの `Error` を投げる。型・シグネチャは変わらない。
中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 型検査は壊れないが、**以前は通っていた入力が、新しく例外になる**。項目21・23・24・27 と同じ扱い。

**誰が影響を受けるか**: `RelationStore.link` を直接呼び、実在しない id・別のテナントの id を渡している呼び出し側。
`Runtime` は `link`/`unlink` を呼ばないので、`recall()`・`tick()` は変わらない。
自前の `RelationStore` を `describeRelationStoreConformance` に当てている場合は、新しい `it` が落ちうる。

**どう直すか**:
- `link` に渡す id は、同じ `ctx` で `MemoryStore.get` などで取れた記憶のものにする。
- `instanceof` で捕まえたい場合、専用のエラー型・`kind` は無い（素の `Error`、メッセージは `PostgresRelationStore:`/`InMemoryRelationStore:` で始まり、`memory not found for tenant` を含む）。
- 自前の `RelationStore` 実装は、`link` の入口で同じ確かめを足す。適合テストの `prepareMemoryId` は、`createStore()` の store から見える、渡した `ctx` のテナントの記憶を返すこと。

**DB マイグレーション**: 要らない。修正前に書かれた、食い違う行が在るかを調べる SQL は ADR 0398 に在る（読み取りだけ）。

### 35. `AnthropicLLMProvider.completeStructured` が、`z.record` を含むスキーマを、送る前に `kind: "schema_unsupported"` で落とすようになった（`@mnemora/anthropic`）

[ADR 0360](./decisions/0360-schema-unsupported-thrown-before-send.md) の 2026-09-30 の追記（負債3）。

⚠ **未リリース**（この節は `v1.1.0` より後の変更を数える）。**番号は 35 である**——項目34 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: Anthropic 側は `z.record` を翻訳して送っていた（送る形は、空の object しか許さないもの——record の欄が例外なしで常に空になる）。
今は `z.record` を含むスキーマ（深さを問わない）を、`messages.create` の前に `AnthropicLLMProviderError`（`kind: "schema_unsupported"`、`cause` に理由）で落とす。
型・シグネチャは変わらない。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 型検査は壊れないが、**以前は通っていた入力が、新しく例外になる**。項目34 と同じ扱い。

**誰が影響を受けるか**: `AnthropicLLMProvider.completeStructured` に `z.record` を含む zod スキーマを渡している呼び出し側。
以前は例外が出なかったが、record の欄は常に空で返っていたので、意味のある値は元から得られていない。
`@mnemora/openai` は元から同じ形を落とすので、そちらの利用者は変わらない。core が渡す4つのスキーマに `z.record` は無く、`recall()`・`tick()`・`observe()` は変わらない。

**どう直すか**:
- record を `{ key, value }` の配列に置き換える。例: `z.record(z.string(), z.number())` → `z.array(z.object({ key: z.string(), value: z.number() }))`。受け取った後にコードで `Object.fromEntries(items.map((i) => [i.key, i.value]))` へ戻せる。
- `instanceof AnthropicLLMProviderError` かつ `kind === "schema_unsupported"` で捕まえられる（`@mnemora/openai` と同じ形）。`cause` の `Error` の文面に `z.record` が入る。
- `z.lazy`・`default`・根が union は今までどおり送る。`z.record` を含まなければ何も変わらない。

**DB マイグレーション**: 要らない。

### 36. `packages/testkit` の conformance suite が、別テナントの ctx からの呼び出しがそのテナントの行に触れない・見えないことを、より多くの口で検査するようになった（`@mnemora/testkit`）

[PR #1498](https://github.com/takecchi/mnemora/pull/1498)。

⚠ **未リリース**（この節は `v1.1.0` より後の変更を数える）。**番号は 36 である**——項目35 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: `describeRelationStoreConformance`・`describeOutboxStoreConformance`・`describeTenantSettingsStoreConformance` に、テナントの条件を検査する `it` が増えた。対象の口は、`RelationStore` の `unlink` と kind を指定した `listRelated`、`OutboxStore` の `complete`・`fail`・`eraseTenant?`（`dryRun` を含む）・`purgeCompletedJobs?`、`TenantSettingsStore` の `getDefaultHalfLifeHours`・`hasSubjectActivityCounters?`・`eraseTenant?` の `dryRun`。suite の引数（適合フラグ・フック）と公開 API の型は変わらない。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 上の「数え方の規律への追記（2026-09-28）」規律2 の ⛔ が挙げる「conformance スイートの判定を厳しくする変更」に当たる。型検査は壊れないが、テナントの条件を持たない自前の実装は、suite を当てると新しく実行時に落ちる（[Issue #1412](https://github.com/takecchi/mnemora/issues/1412) の規律。オーナーの回答 `6911db12` により、`v1.X.0` で出してよい）。項目23・24・27 と同じ判断である。

**誰が影響を受けるか**: 自前の `RelationStore`・`OutboxStore`・`TenantSettingsStore` を上の suite に当てている利用者のうち、別テナントの行に触れる実装。`@mnemora/postgres` とインメモリの実装は通る。
新しい `it` のうち、`RelationStore` の `unlink` と kind 付きの `listRelated`、`OutboxStore` の `complete`・`fail`、`TenantSettingsStore` の `getDefaultHalfLifeHours` の分は**フラグ無しで走る**ので、フラグでは避けられない。
`OutboxStore`・`TenantSettingsStore` の `eraseTenant?`（`dryRun`）の分は `supportsEraseTenant: true` の枝の内側、`OutboxStore.purgeCompletedJobs?` の分は `supportsPurgeCompletedJobs: true` の枝の内側、`hasSubjectActivityCounters?` の分は任意のフック `advanceSubjectActivitySeq` を渡したときの枝の内側にあり、その口を持たない（フラグを渡していない）実装には当たらない（ADR 0463 の照合）。

**どう直すか**: 落ちた `it` の名前が指す口（`unlink`・`listRelated`・`complete`・`fail` など）に、`ctx.tenantId` の条件を足す。

**DB マイグレーション**: 要らない。

### 37. `describeMemoryStoreConformance` が、`reinforce`/`reinforceMany?` が `memory_events` を書かないことを、フラグ無しで検査するようになった（`@mnemora/testkit`）

[Issue #871](https://github.com/takecchi/mnemora/issues/871)、[PR #1452](https://github.com/takecchi/mnemora/pull/1452)。

⚠ **未リリース**。**番号は 37 である**——項目36 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: `reinforce` の後で `memory_events` が1行も増えていないこと、`reinforceMany?` を実装していればそれも同じであることを検査する `it` が増えた（`docs/memory-model.md` §11 行4 が約束していた振る舞い）。型・フラグは変わらない。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 項目36 と同じ。規律2 の ⛔ の「conformance スイートの判定を厳しくする変更」に当たる。CHANGELOG では `### Added` に載せていたが、`it` がフラグ無しで走るので、数え直した。

**誰が影響を受けるか**: 自前の `MemoryStore` 実装を suite に当てている利用者のうち、`reinforce`/`reinforceMany?` が強化のたびにイベントを書く実装。`reinforceMany` の `it` は、実装しない adapter では何も検査しない。

**どう直すか**: 強化でイベントを積まないようにする。積みたい事情があるなら、`docs/memory-model.md` §11 行4 の約束と食い違うので、先にそちらを見ること。

**DB マイグレーション**: 要らない。

### 38. `describeMemoryStoreConformance` が、`aggregateScope` が `scopeAggregate: "skip"` を守ることを、フラグ無しで検査するようになった（`@mnemora/testkit`）

[PR #1455](https://github.com/takecchi/mnemora/pull/1455)、[ADR 0384](./decisions/0384-digest-band-index-and-scope-aggregate-skip.md)。

⚠ **未リリース**。**番号は 38 である**——項目37 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: `aggregateScope(ctx, scope, { scopeAggregate: "skip" })` の結果が、`groups` 空・`totalInScope` `0`・`countKind: "unknown"`（`filtered*`・`notIndexed.*` も `{ count: 0, countKind: "unknown" }`）であること、`digestBand` を指定したときは `digestEligible` が `unknown`・省略したときは `{ count: 0, countKind: "exact" }` であること、`scopeAggregate` の省略と `"exact"` の結果が同じであることを検査する `it` が増えた。`RecallQuery.scopeAggregate?`（任意の欄の追加）自体は非破壊と数える。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 項目36 と同じ。フラグ無しの `it` が、自前の `MemoryStore.aggregateScope` に新しい約束を課す。

**誰が影響を受けるか**: 自前の `MemoryStore` 実装を suite に当てている利用者のうち、`aggregateScope` が `opts.scopeAggregate` を読まない実装（`"skip"` を頼まれても集計して `"exact"` を返す）。⚠ CHANGELOG の以前の文面（`### Added`）は「実装しない adapter は常に `countKind: 'exact'` を返し続ける契約」と書いていたが、suite の実際の振る舞いは逆で、その形の実装は落ちる。なお、`packages/core/src/recall.ts` の `RecallQuery.scopeAggregate` の TSDoc と `docs/recall.md` に残っていた同じ古い文面は、後続の docs PR（枝 `docs/scope-aggregate-tsdoc`）で直した。

**どう直すか**: `aggregateScope` が `opts.scopeAggregate === "skip"` を読み、件数集計を行わずに、上の値を返すようにする。集計クエリを実際に発行していないことまで suite に検査させたい場合は、`countScopeAggregateQueries` フックを渡す（任意）。

**DB マイグレーション**: 要らない（`0028` の索引は別の話で、上の節の追記を見ること）。

### 39. `describeMemoryStoreConformance` の `supportsListActiveClaimPredicates: true` の枝に、同着の並びの `it` が3本増えた（`@mnemora/testkit`）

[Issue #1412](https://github.com/takecchi/mnemora/issues/1412) の続き、[PR #1484](https://github.com/takecchi/mnemora/pull/1484)。

⚠ **未リリース**。**番号は 39 である**——項目38 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: `listActiveClaimPredicates?` が、代表行の `created_at` が同じ predicate を、predicate のコードポイント順の昇順で返すこと、`limit` で切っても同じ先頭が残ること、照合順序（collation）に依らないことを検査する `it` が増えた。`@mnemora/postgres` は副キーに `claim_key_predicate COLLATE "C" ASC` を足した。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Changed` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 項目36 と同じ。CHANGELOG では `### Changed` に「非破壊（契約を締めただけ）」と書いていたが、判定を厳しくする変更なので、数え直した。

**誰が影響を受けるか**: `listActiveClaimPredicates?` を実装し、`supportsListActiveClaimPredicates: true` を渡している利用者のうち、同着の並びが上の規則と違う実装。**フラグを渡していない・実装していない利用者は影響を受けない**（この項目は、項目37・38・40 と違い、フラグで避けられる）。

**どう直すか**: 同着の副キーを predicate のコードポイント順の昇順にする。直せない間は `supportsListActiveClaimPredicates` を渡さない。

**DB マイグレーション**: 要らない。

### 40. `describeMemoryStoreConformance` が、`createObservationWithOutbox` が `opts.claimedBy` を守ることを、フラグ無しで検査するようになった（`@mnemora/testkit`）

[ADR 0407](./decisions/0407-sync-observe-extract-job-lease.md)、[PR #1492](https://github.com/takecchi/mnemora/pull/1492)。

⚠ **未リリース**。**番号は 40 である**——項目39 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: `createObservationWithOutbox` に `opts.claimedBy` を渡すと outbox 行が claim 済み（`claimedBy`・`attempts: 1`）で作られること、省略すると未 claim・`attempts: 0` であることを検査する `it` が2本増えた。`opts.claimedBy?` 自体は任意の欄の追加である。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 項目36 と同じ。CHANGELOG では `### Fixed` に「非破壊（追加の任意欄のみ）」と書いていたが、`it` がフラグ無しで走るので、数え直した。

**誰が影響を受けるか**: 自前の `MemoryStore` 実装を suite に当てている利用者のうち、`claimedBy` を無視する実装。実行時の `observe({ extract: "sync" })` の穴が塞がらないのも同じ実装である。

**どう直すか**: `claimedBy` が渡されたら、`claimed_at` = `opts.now`・`claimed_by`・`attempts: 1` で行を作る。

**DB マイグレーション**: 要らない。

### 41. 孤立サロゲートか NUL を含む識別子が、入口で `MalformedIdentifierError` になった。conformance suite に、それを検査する `it` が増えた（`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）

[ADR 0423](./decisions/0423-identifier-well-formed-and-error-message-without-params.md)。

⚠ **未リリース**（この節は `v1.1.0` より後の変更を数える）。**番号は 41 である**——項目40 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: 識別子（`tenantId`・`subjectId`・`observe` の `externalId`）に、孤立サロゲート（対をなさない UTF-16 のサロゲートコードユニット）か NUL（U+0000）が含まれていると、
`Runtime` の全メソッドの入口と、`@mnemora/postgres`・`@mnemora/testkit` のインメモリ実装の store の入口が、書く前に `MalformedIdentifierError`（`kind: "malformed_identifier"`）を投げる。
これまでは実装によって扱いが違った（Postgres は U+FFFD に置き換えて保存する、または DB の生の例外。インメモリ実装は通る）。**正規化はしない**（書き換えて通さない）。
型・シグネチャは変わらない。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 型検査は壊れないが、**以前は通っていた入力が、新しく例外になる**。あわせて、conformance suite に足した `it` は、入口で断らない自前の store を新しく落とす。項目21・23・24・27・34 と同じ扱い。

**誰が影響を受けるか**:
- 識別子に外部の入力（ユーザー名・外部の ID など）をそのまま渡していて、その値が孤立サロゲートか NUL を含みうる呼び出し側。対をなすサロゲート（絵文字など）は、これまでどおり通る。
- 自前の store を `describeMemoryStoreConformance`・`describeOutboxStoreConformance`・`describeVectorStoreConformance`・`describeLexicalStoreConformance`・`describeEventStoreConformance`・`describeRelationStoreConformance`・`describeTenantSettingsStoreConformance` に当てている人。足した `it` が落ちうる。
- 本文（`text` など）は変わらない。`tags` の要素・`claimKey` の主語と述語・ラベル名も今回は変わらない。

**どう直すか**:
- 呼び出し側: 識別子を渡す前に、自分で扱いを決める（孤立サロゲートを除く、別の文字に置き換える、ハッシュにするなど）。mnemora は値を書き換えない。
  すでに U+FFFD に置き換わって保存された識別子は、そのまま残る（この変更は既存の行を直さない）。
- 自前の store: 各メソッドの入口で、core が公開する `assertWellFormedCtx(ctx)` を呼ぶ。識別子を入力に持つ口（Observation・Memory の書き込みの `subjectId`・`externalId`、検索条件の `filter` など）は `assertWellFormedIdentifier(value, "<欄の名前>")`・`assertWellFormedFilter(filter)` も呼ぶ。
- `isMalformedIdentifierError(error)` で捕まえられる（`instanceof` ではなく `kind` を見る。ADR 0418）。例外の message に入力値は入らない。

**あわせて変わること（破壊的とは数えない）**: `Runtime` が投げ直す例外の message から、SQL に付けた値（`params:` 以降）が落ちる。SQL の文・`kind`・`cause` は残る。詳しくは CHANGELOG の `### Changed`。

### 42. `consolidate`・`reflect` が、材料が superseded になったときと、統合元がすべて CAS に弾かれたときに、統合先・内省を書かずに打ち切るようになった（`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）

[ADR 0420](./decisions/0420-consolidate-reflect-abort-on-superseded-and-all-conflicted.md)、[PR #1523](https://github.com/takecchi/mnemora/pull/1523)。

⚠ **未リリース**。**番号は 42 である**——項目41 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**:
- **`runtime.consolidate`：**次のどちらかのとき、統合先を書かずに `outcome: 'aborted_source_status_changed'` を返す。
  - LLM を待つ間に、eligible の1件でも `superseded` になっていたとき
  - eligible の**すべて**が `active` でなくなっていたとき（同じ ids の `consolidate` が同時に走って先に commit した、など）

  このとき、動いていた要素は `status_changed_concurrently`（`observedStatus` 付き）、残りは `not_attempted` になる。`atomicity` は `not_attempted` になる。
- **`runtime.reflect`：**材料の1件でも `superseded` になっていたとき、内省を書かずに `outcome: 'aborted_source_status_changed'` を返す。動いていた材料は、新しい `ReflectBasisOutcome` の `"status_changed_before_write"`（`observedStatus` 付き）になる。
- **増えた型の値：**`ConsolidateOutcome`・`ReflectOutcome` に `"aborted_source_status_changed"` が、`ReflectBasisOutcome` に `"status_changed_before_write"` が増えた。
- **`MemoryStore` の欄と例外：**
  - `createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents?`・`supersedeWithNewMemories?` に、任意の `opts.abortIfSuperseded` が増えた。
  - `supersedeWithNewMemories?` に、任意の `opts.abortIfAllConflicted` が増えた。
  - 投げる例外は、新しい `SourceMemoryStatusChangedError`（判定関数は `isSourceMemoryStatusChangedError`）である。

**なぜ破壊的と数えるか**: 今まで `"consolidated"`/`"reflected"` で返り、統合先・内省が書かれていた入力が、書かれずに `"aborted_source_status_changed"` で返るからである。実行時の振る舞いが変わる。
- この振る舞いは依頼元が決めた。v1.X.0 で出してよい、というオーナーの回答（ask_human `6911db12`）がある。
- ⚠ union に値を足したことだけなら、規律1により数えない。ここで数えるのは、振る舞いが変わることである。

**誰が影響を受けるか**:
- `consolidate`/`reflect` の `outcome` で分岐している利用者。新しい値を知らない分岐は、それを「成功ではない何か」として扱う。
- 同じ ids の `consolidate` を並行に走らせる運用（tick の consolidate ジョブを複数のワーカーで回す、など）。これまで重複して作られていた統合記憶が、作られなくなる。
- 自前の `MemoryStore` を書いている adapter 実装者。新しい欄は任意なので、実装しなくても型は壊れない（無視されるだけ）。ただしその場合、書き込みの直前の窓は残る。

**どう直すか**:
- **利用者：**`outcome` の網羅的な分岐に `"aborted_source_status_changed"` を足す。扱いは `"aborted_source_forgotten"` と同じでよい。何も書かれていないので、材料を読み直して、呼び直すかどうかを決める。
- **adapter 実装者（同じ保護が欲しい場合）：**
  - 書き込みのトランザクションの中で、`abortIfSuperseded` の id の `status` を行ロックの下で見直す。1件でも `superseded` なら、何も書かずに `SourceMemoryStatusChangedError` を投げる。
  - `abortIfAllConflicted: true` のときは、`supersede` の CAS がすべて破れたら、トランザクションごと巻き戻して同じ例外を投げる。

**DB マイグレーション**: 要らない。

### 43. `describeOutboxStoreConformance`・`describeRelationStoreConformance`（`@mnemora/testkit`）が、adapter 間の食い違い4点を検査するようになった（`@mnemora/testkit`・`@mnemora/postgres`）

⚠ **未リリース**（この節は `v1.1.0` より後の変更を数える）。**番号は 43 である**——項目42 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: 次の `it` が足された（`OutboxStore` が4件、`RelationStore` が2件）。型・シグネチャは変わらない。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

- `OutboxStore.complete`/`fail` は、`opts.at` が Invalid Date なら例外を投げる（Postgres は `timestamptz` への変換で `22007` になる）。
- `complete`/`fail` に渡した `opts.at` を、呼び手が後から書き換えても、`completedAt`/`failedAt` は変わらない（`peekJob` を渡した adapter だけ）。
- `fail` の `error` に NUL（U+0000）が含まれていても落とさず、6文字の `\u0000` に置き換えて `lastError` に残す（`peekJob` を渡した adapter だけ）。
- `RelationStore.link` は、列挙の外の `kind` を、`relation kind` を含む例外で拒み、行を書かない。
- `RelationStore.listRelated` が返した `createdAt` を書き換えても、store の行は変わらない。

**なぜ破壊的と数えるか**: 型検査は壊れないが、**conformance suite の判定が厳しくなり、上を満たさない自前の実装は、新しく実行時に落ちる**（このファイルの規律の、conformance の判定を厳しくする変更）。項目36 と同じ扱い。

⚠ **数えなかったもの（判断の記録）**:
- `@mnemora/postgres` の `PostgresRelationStore.link` が、列挙外の `kind` を DB の CHECK 違反（生のエラー）ではなく `PostgresRelationStore: unknown relation kind: <kind>` の `Error` で、INSERT の前に断るようになった。**以前も例外になった入力が、今も例外になる**——「以前は通っていた入力が新しく例外になる」に当たらないので、adapter の変更としては数えない。上の conformance の `it` としては数える。DB の生のエラーコード（`23514`）を読んでいた呼び出し側は、その読み方が効かなくなる。
- `@mnemora/testkit/fixtures` の `InMemoryOutboxStore`・`InMemoryRelationStore` が新しく例外を投げる（規律2）。fixture が `error` の NUL を置き換える・`Date` を複製する変更、`real` 列の値を Postgres が読み戻す値で持つ変更は、例外を増やさない・conformance に足していないので、数えない。

**誰が影響を受けるか**: 自前の `OutboxStore`・`RelationStore` を上の suite に当てている利用者。`@mnemora/postgres` とインメモリの実装は、足した `it` に通る。

**どう直すか**:
- `complete`/`fail` の入口で `opts.at` の `getTime()` が `NaN` なら投げる。保存するときは `new Date(opts.at)` で複製する。
- `fail` は保存する前に `error.replaceAll("\u0000", "\\u0000")` をかける。
- `link` は、`kind` が `RelationKind` の値のどれでもないなら、両端の検査・書き込みの前に `unknown relation kind: <kind>` を含む `Error` を投げる。`listRelated` は保存している `Date` を複製して返す。

**DB マイグレーション**: 要らない。

### 44. 半減期が float4 に収まらない入力と、uuid の形でない id の関係操作が、DB の生の例外でなく明示の扱いになった。conformance suite に `it` が増えた（`@mnemora/postgres`・`@mnemora/testkit`）

[CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking`（「DB の生の例外で失敗していた3つの入力」）。**ここには複製しない。**

⚠ **未リリース**。**番号は 44 である**——項目43 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**:
- `PostgresMemoryStore` の `NewMemory` を受ける口と `PostgresTenantSettingsStore.setDefaultHalfLifeRecalls` が、float4（`real` 列）に収まらない `halfLifeHours`・`halfLifeRecalls` を、メッセージに `does not fit in a Postgres "real" (float4) column` を含む素の `Error` で断る。以前は DB の生の例外（`out of range for type real`）だった。
- `PostgresRelationStore.unlink` は uuid の形でない id で何もせず返し、`listRelated` は空配列を返す。以前は DB の型変換エラーで reject した。
- `describeMemoryStoreConformance`・`describeTenantSettingsStoreConformance`（`setDefaultHalfLifeRecalls` を渡した場合）・`describeRelationStoreConformance` に `it` が増えた。フラグ無しで走る。型・シグネチャは変わらない。

**なぜ破壊的と数えるか**: conformance suite が新しく落とすようになる変更（項目21・23・24・27・36〜40 と同じ扱い）。加えて、実 adapter（`@mnemora/postgres`）の振る舞い（失敗の種類、例外になっていた入力が例外でなくなる）が変わる。

**誰が影響を受けるか**: 自前の `MemoryStore`/`TenantSettingsStore`/`RelationStore` を conformance に当てている利用者（DB の生の例外を投げる実装、uuid の形でない id で投げる実装は新しい `it` が落ちる）。`@mnemora/postgres` の例外を DB の文言で捕まえていた呼び出し側。

**どう直すか**: 自前の実装は、DB へ渡す前に `Math.fround(x)` が `Infinity` か 0 になる半減期を、`float4` を含むメッセージの `Error` で断る。uuid の形でない id は、存在しない id と同じに扱う。`@mnemora/postgres` の利用者は、`unlink`/`listRelated` の呼び出しで例外を握っていたなら不要になる。

**DB マイグレーション**: 要らない。

### 45. `OpenAIEmbeddingProvider.embed()`・`LocalEmbeddingProvider.embed()` が、abort 済みの signal なら空配列でも reject するようになった（`@mnemora/openai`・`@mnemora/local-embedding`）

[CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking`（項目44 と同じ箇条）。**ここには複製しない。**

⚠ **未リリース**。**番号は 45 である**——項目44 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: `embed(ctx, [], { signal })` は、`signal` が abort 済みでも `[]` を返していた。今は `signal.reason` で reject する。空でない `texts` の挙動は変わらない。型・シグネチャは変わらない。

**なぜ破壊的と数えるか**: 以前は例外にならなかった入力が、新しく例外になる（項目32 と同じ扱い）。

**誰が影響を受けるか**: 空配列と abort 済みの signal を同時に渡していた呼び出し側だけ。

**どう直すか**: abort 済みの signal を渡さない、または reject を握る。

**DB マイグレーション**: 要らない。

### 46. `runtime.observe()` の contested 検出が、NFC + trim で同じ `content` の行を一致に数えなくなった（`@mnemora/core`）

[ADR 0424](./decisions/0424-normalized-content-comparison-and-boundary-conformance.md)、[PR #1527](https://github.com/takecchi/mnemora/pull/1527)。

⚠ **未リリース**。**番号は 46 である**——項目45 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: `Runtime.detectClaimKeyContested` が、store から返った行（`findActiveByClaimKey?`・`findContestedByClaimKey?`）のうち、`content` を NFC にして `trim()` した値が、検出中の memory と等しいものを、件数を数える前に除くようになった。以前は生の `content_hash` の違いだけで一致に数え、NFC と NFD の違いや末尾の空白1つだけの同じ文を `contested`（または `unresolved_conflict`）にしていた。`content_hash` の値・保存する `content`・store の口の引数は変わらない。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 型・シグネチャは変わらないが、同じ入力（`claimKey: { enabled: true, detectContested: true }` の `observe()`）に対する `contestedDetection` と、`contested` になる Memory の集合が変わる。実 adapter を使う利用者ではなく core の振る舞いの変更なので、上の数え方の規律（実際の振る舞いの変更は数える）に従った。

**誰が影響を受けるか**: `claimKey.detectContested` を使い、NFC/NFD や前後の空白だけが違う同じ文を `contested` として読んでいたコード（`contestedDetection[].result.kind === "contested"` に依存する分岐、`status: "contested"` の Memory の一覧）。自前の `MemoryStore` 実装は変える必要が無い（core が除く）。

**どう直すか**: 何もしなくてよい（誤検出が減る側にしか変わらない）。以前の振る舞いに依存していた場合は、`content` を書く前に自前で正規化していなかったことを見直す。

**DB マイグレーション**: 要らない。

### 47. `packDigestBand`（`@mnemora/core`）が、1件の digest を書記素の境界で切り詰めるようになった

[ADR 0424](./decisions/0424-normalized-content-comparison-and-boundary-conformance.md)、[PR #1527](https://github.com/takecchi/mnemora/pull/1527)。

⚠ **未リリース**。**番号は 47 である**——項目46 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: `packDigestBand` の `maxEntryChars` を超える digest の切り詰めが、UTF-16 コードユニットで切る（サロゲートペアの内側だけ避ける）代わりに、`Intl.Segmenter` の書記素の境界で切るようになった。`maxEntryChars` の単位（UTF-16 コードユニット）は変わらない。以前は NFD の「が」（`か` + 結合濁点）が「か」に、ZWJ で繋いだ絵文字が ZWJ だけに切れていた。書記素の途中に当たると、以前より短く（最大で書記素1つぶん）切れる。最初の書記素だけで上限を超える digest は空文字列になる。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 型は変わらないが、`recall()` の `digestBand` の `digest`（と `DIGEST_BAND_ENTRY_FIXED_OVERHEAD_CHARS` を含む文字数の予算の消費）が、上の入力では以前と違う値になる。

**誰が影響を受けるか**: `digestBand` の `digest` の文字列や文字数を、切り詰めが起きる長さで固定していた利用者（テスト・snapshot）。`maxEntryChars` 以下の digest は変わらない。

**どう直すか**: 期待値を書記素の境界で切った値に更新する。

**DB マイグレーション**: 要らない。

### 48. `describeMemoryStoreConformance`・`describeVectorStoreConformance`・`describeLexicalStoreConformance` に、入力の境界の `it` が増えた。`@mnemora/postgres` は DB の生の例外の代わりに明示の例外を投げるようになった（`@mnemora/testkit`・`@mnemora/postgres`）

[ADR 0424](./decisions/0424-normalized-content-comparison-and-boundary-conformance.md)、[PR #1527](https://github.com/takecchi/mnemora/pull/1527)。

⚠ **未リリース**。**番号は 48 である**——項目47 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: フラグ無しで走る `it` が3つの suite に増えた。
  1. **`describeLexicalStoreConformance`**: `search` の検索語に NUL (U+0000) を含めると、`query` と NUL を名指しする例外で断る（0件を返さない）。
  2. **`describeVectorStoreConformance`**: `upsert` が float4 に収まらない成分（`1e308`・`-1e308`）の vector を `float4` を名指しする例外で断り、何も保存しない。`search` は同じ成分のクエリでも投げず、距離が比較の通らない値（`NaN`）になる。
  3. **`describeMemoryStoreConformance`**: `contentHash` に NUL を含む `createMemory`・`createMemoryWithOutbox` が、`contentHash` と NUL を名指しする例外で断り、何も保存しない。

`@mnemora/postgres` の振る舞いも変わった: 上の 1・3 と 2 の `upsert` は、以前は DB の生の例外（`DrizzleQueryError`、原因は `invalid byte sequence for encoding "UTF8": 0x00`／`"1e+308" is out of range for type vector`）だったが、DB に触れる前の明示の例外（NUL は `Error`、float4 は `RangeError`）になった。2 の `search`・`searchMany` は、以前は `1e308` のクエリで生の例外だったが、`NaN`・`Infinity` と同じ「比較不能」（投げず、`recall()` は `score_not_comparable` に数える）になった。`createMemoriesWithOutboxAndEvents` では、`contentHash` に NUL を含む候補だけが落ちる（`dropped`）。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 項目36 と同じ（conformance スイートの判定を厳しくする変更）。加えて `@mnemora/postgres` は fixture ではなく本物の adapter なので、投げる例外が変わる変更は上の数え方の規律 2 の ⛔ に当たる。`InMemory*` の fixture が新しく例外を投げること自体は、同じ規律 2 により数えない。

**誰が影響を受けるか**: (a) 自前の `LexicalStore`・`VectorStore`・`MemoryStore` 実装を suite に当てている利用者のうち、NUL の検索語・`contentHash` の NUL・float4 に収まらない `upsert` を受け入れる実装。(b) `@mnemora/postgres` の例外を、生の DB の例外（`cause.code === "22021"`・`"22003"`）として捕まえていたコード。

**どう直すか**: (a) 同じ入力を、DB に触れる前に例外で断る。検索のクエリの float4 は、有限でない成分と同じ「比較不能」として扱う。(b) 生の DB の例外の代わりに、`Error`（メッセージに `NUL`）／`RangeError`（メッセージに `float4`）を捕まえる。

**DB マイグレーション**: 要らない。

### 49. `EventStore.append`・`VectorStore.upsert` が、記憶が `ctx` のテナントに属さない（または実在しない）ときに例外を投げるようになった（`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）

[ADR 0436](./decisions/0436-event-vector-write-checks-memory-belongs-to-ctx-tenant.md)（クローン miku の決定。[ADR 0398](./decisions/0398-relation-store-link-checks-both-ends-belong-to-ctx-tenant.md) と同じ作法）。

⚠ **未リリース**。**番号は 49 である**——項目48 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: `EventStore.append(ctx, event)` は `event.memoryId` が、`VectorStore.upsert(ctx, space, memoryId, vector)` は `memoryId` が、
これまで `ctx.tenantId` の記憶かどうかを確かめなかった（`@mnemora/postgres`）。今は書く前に確かめ、実在しない（uuid の形でない id も同じ）、または別のテナントの記憶なら、
行を書かずに `memory not found for tenant: <id>` を含むメッセージの `Error` を投げる。`append` で `memoryId` が `null` のイベント（`events_purged`）は検査しない。
型・シグネチャは変わらない。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 型検査は壊れないが、**以前は通っていた入力が、新しく例外になる**。項目21・23・24・27・34 と同じ扱い。加えて、conformance スイートの判定を厳しくする変更（項目36 と同じ）でもある。

**誰が影響を受けるか**: `EventStore.append`・`VectorStore.upsert` を直接呼び、別のテナントの記憶 id を渡している呼び出し側。
`Runtime` は同じ `ctx` で確かめた id しか渡さないので、`observe()`・`recall()`・`tick()` は変わらない。
自前の `EventStore`・`VectorStore` を `describeEventStoreConformance`・`describeVectorStoreConformance` に当てている場合は、新しい `it` が落ちうる。
実在しない uuid・uuid でない id を渡していた呼び出し側は、以前も落ちていたが、外部キー違反・`Failed query` の生の DB エラーから、上の明示の例外に変わる。

**どう直すか**:
- `append`・`upsert` に渡す id は、同じ `ctx` で `MemoryStore.get` などで取れた記憶のものにする。
- 専用のエラー型・`kind` は無い（素の `Error`、メッセージは `PostgresEventStore:`/`PostgresVectorStore:`/`InMemoryEventStore:`/`InMemoryVectorStore:` で始まり、`memory not found for tenant` を含む）。
- 自前の `EventStore`・`VectorStore` 実装は、入口で同じ確かめを足す。適合テストの `prepareMemoryId(ctx)` は、`createStore()` の store から見える、渡した `ctx` のテナントの記憶を返すこと。

**DB マイグレーション**: 要らない。修正前に書かれた、食い違う行（別テナントの記憶を指す `memory_events`・`memory_embeddings_<space>` の行）が在るかを調べる SQL は ADR 0436 に在る（読み取りだけ）。
**既存の行は消さない。**行が出た場合の扱いはオーナーの判断が要る（消す・残す・付け替える、のどれもデータの書き換えである）。そのような行が在ると、指された記憶のテナントの `eraseTenant` は `blocked_by_foreign_reference` で止まる。

### 50. `getSubjectActivitySeqs` の `subjectIds` と `createRecall` の `advanceActivityClock.subjectId` が、孤立サロゲート・NUL を断るようになった。v1.1.0 より前に purge した行は、purge をかけ直すと消える（`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）

[ADR 0437](./decisions/0437-helpers-params-subject-ids-repurge.md)。

⚠ **未リリース**。**番号は 50 である**——項目49 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**:
  1. **(破壊的)** 次の2つの欄に孤立サロゲートか NUL（U+0000）を含む値を渡すと、`MalformedIdentifierError`（`kind: "malformed_identifier"`）で、書く・読む前に断る。
     - `TenantSettingsStore.getSubjectActivitySeqs(ctx, subjectIds)` の `subjectIds` の各要素（`field` は `subjectIds[i]`）。
     - `MemoryStore.createRecall` の `record.advanceActivityClock`（`{ scope: "subject", subjectId }`）の `subjectId`（`field` は `record.advanceActivityClock.subjectId`）。
     以前は、NUL は Postgres で生の DB の例外（message に値が載る）、孤立サロゲートは通り、インメモリ実装は断らなかった。対をなすサロゲート（絵文字など）は、これまでどおり通る。`describeTenantSettingsStoreConformance`・`describeMemoryStoreConformance` に、これを検査する `it` が増えた（フラグ無しで走る）。項目41 の続き（ADR 0423 決定4(b) の一覧の漏れ）。
  2. **(後方互換)** `@mnemora/core` の公開ヘルパー9本（`readDecayClock`・`readActivitySeq`・`readDefaultHalfLifeRecalls`・`readHasSubjectActivityCounters`・`readSubjectActivitySeqs`・`readSubjectActivitySeq`・`writeDecayClock`・`readTaxonomyMode`・`writeTaxonomyMode`）が投げる例外の message から、drizzle の `params:` より後ろが落ちる。
  3. **(後方互換)** `MemoryStore` に任意メソッド `scrubPurged?` が増え、`runtime.purge` は `already_purged`（`dryRun` でないとき）にこれを呼ぶ。**v1.1.0 より前に purge した行は、purge をかけ直すと消える。かけ直すまでは残る。**

**なぜ 1 を破壊的と数えるか**: 項目41 と同じ（通っていた入力が throw する。conformance suite の判定が厳しくなる）。2・3 は任意の追加と、例外の message の params を落とす変更だけで、数えない。

**誰が影響を受けるか**: (a) `subjectIds`・`advanceActivityClock.subjectId` に外部の入力をそのまま渡している呼び出し側のうち、孤立サロゲートか NUL を含みうるもの（`Runtime.recall` は `ctx.subjectId` から渡す。`Runtime` の入口は ADR 0423 で既に断っている）。(b) 自前の `TenantSettingsStore`・`MemoryStore` を、`describeTenantSettingsStoreConformance`・`describeMemoryStoreConformance` に当てている利用者。(c) v1.0.0〜v1.0.2 で purge した行を持つ DB。

**どう直すか**: (a) 識別子に外部の入力を渡す前に、孤立サロゲートと NUL を取り除くか、呼び出しを断る（`assertWellFormedIdentifier` を使える）。(b) この2つの欄に `assertWellFormedIdentifier` を掛け、書く・読む前に断る。(c) 下の SQL で、残っている行を探し、その `tenant_id` の `ctx` で `runtime.purge(ctx, { memoryIds })` をかけ直す（`scrubPurged` が、`tags`・`attributes`・claim key・`memory_labels` を消し、`labels.proposed_count` を外した本数だけ減らす。べき等）。

```sql
-- v1.1.0 より前に purge した行のうち、残骸が残っているもの（現行の schema に移行したあとで流す）
SELECT id, tenant_id FROM memories
WHERE purged_at IS NOT NULL
  AND (
    cardinality(tags) > 0
    OR attributes <> '{}'::jsonb
    OR claim_key_subject IS NOT NULL
    OR claim_key_predicate IS NOT NULL
    OR EXISTS (SELECT 1 FROM memory_labels ml WHERE ml.memory_id = memories.id)
  );
```

**migration で遡って一括で消すことは、していない**（オーナーの領分）。`recalls.index_band` の digest（Issue #994 の系統）は、v1.0.x の purge が残したものが今も残っているかを**確かめていない**（範囲外）。

**DB マイグレーション**: 要らない。

### 51. `MemoryStore` の書き込み口が、別の行を指す参照の参照先が `ctx` のテナントの行でないときに例外を投げるようになった（`@mnemora/core`・`@mnemora/postgres`・`@mnemora/testkit`）

[ADR 0439](./decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md)（クローン miku の委譲先の担い手が書いた。決めたのはクローンで、オーナーの判断ではない。[ADR 0436](./decisions/0436-event-vector-write-checks-memory-belongs-to-ctx-tenant.md) の続き）。

⚠ **未リリース**。**番号は 51 である**——項目50 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: 次の欄は、これまで参照先が `ctx.tenantId` の行かを確かめなかった（`@mnemora/postgres`）。今は書く前に確かめ、実在しない・別のテナントの行・uuid の形でない id は、何も書かずに `… not found for tenant: <id>` を含むメッセージの `Error` を投げる。

| 口                                                                                                                             | 欄                                  | 主語（message）                                              |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------ |
| `recordUsage`・`recordUsageAndReinforce?`                                                                                      | `recallId`                          | `recall not found for tenant`                                |
| 同上                                                                                                                           | `memoryIds`                         | `memory not found for tenant`（1件でも違えば全体を書かない） |
| `createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents?`・`supersedeWithNewMemories?`（`news[i].input`） | `sourceObservationId`               | `observation not found for tenant`                           |
| 同上                                                                                                                           | `contestedWithId`・`supersededById` | `memory not found for tenant`                                |
| `updateStatus`・`updateStatusWithEvent`                                                                                        | `opts.supersededById`               | `memory not found for tenant`                                |
| `resolveContestedPair?`・`resolveContestedGroup?`                                                                              | `supersededById`                    | `memory not found for tenant`                                |

型・シグネチャは変わらない。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Breaking` を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 型検査は壊れないが、**以前は通っていた入力が、新しく例外になる**。項目21・23・24・27・34・49 と同じ扱い。加えて、conformance スイートの判定を厳しくする変更（項目36・49 と同じ）でもある。

**誰が影響を受けるか**: 上の口を直接呼び、別のテナントの id を渡している呼び出し側。`Runtime` は同じ `ctx` で確かめた id しか渡さないので、`observe()`・`recall()`・`tick()` などは変わらない。
自前の `MemoryStore` を `describeMemoryStoreConformance` に当てている場合は、新しい `it`（9本。任意メソッドの分は `supportsXxx` のフラグの下）が落ちうる。
実在しない uuid・uuid でない id を渡していた呼び出し側は、以前も落ちていたが、外部キー違反・`Failed query` の生の DB エラーから、上の明示の例外に変わる。
冪等の衝突で既存の行を返していた `createMemory*` も、参照が壊れていれば拒むようになる。

**どう直すか**:

- 参照に渡す id は、同じ `ctx` で `MemoryStore.get`・`getObservation`・`getRecall` などで取れた行のものにする。
- 専用のエラー型・`kind` は無い（素の `Error`、メッセージは `PostgresMemoryStore:`/`InMemoryMemoryStore:`/`FakeMemoryStore:` で始まる）。
- 自前の `MemoryStore` 実装は、上の口の入口で同じ確かめを足す。適合テストの `prepareRecallId(ctx)` は、渡した `ctx` のテナントの recall を、`createStore()` の store から見える形で返すこと。
- 適合テストの `restoreSupersededBy は別テナントの行を巻き込まない`・`previewRestoreSupersededBy は別テナントの行を巻き込まない` は、B の行の仕込みを、B 自身の anchor を指す形に変えた（別テナントの anchor を指す行は、API で書けなくなったため）。自前の adapter で、その形を別の方法で作っている場合は、仕込みを見直すこと。

**DB マイグレーション**: 要らない。修正前に書かれた、別テナントを指す行が在るかを調べる SQL（4本。`recall_usages`・`memories.source_observation_id`・`contested_with_id`・`superseded_by_id`）は ADR 0439 に在る（読み取りだけ）。
**既存の行は消さない。**行が出た場合の扱いはオーナーの判断が要る（消す・残す・付け替える、のどれもデータの書き換えである）。そのような行が在ると、指された側のテナントの `eraseTenant` は `blocked_by_foreign_reference` で止まり、`recall_usages` が別テナントの recall を指す行は、指された側の `purgeExpiredRecalls` を外部キー違反で落とす。

### 52. `MemoryStore` の書き込み口が受ける `NewMemoryEvent.memoryId` が、`ctx` のテナントの記憶でないときに例外を投げるようになった（`@mnemora/postgres`）

[ADR 0456](./decisions/0456-llm-returned-values-malformed-read-filter-nul-named.md) の H4（[PR #1562](https://github.com/takecchi/mnemora/pull/1562)。クローン miku の委譲先の担い手が書いた。決めたのはクローンで、オーナーではない。[ADR 0436](./decisions/0436-event-vector-write-checks-memory-belongs-to-ctx-tenant.md)・[ADR 0439](./decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md) と同じ作法）。

⚠ **未リリース**。**番号は 52 である**——項目51 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。
⚠ **この項目は 2026-10-01 の点検（[ADR 0461](./decisions/0461-v1-2-0-release-prep-inspection.md)）で足した。**ADR 0456 の PR は、この変更を CHANGELOG の `### Fixed` に書いたが、この文書の一覧には載せておらず、[ADR 0459](./decisions/0459-round32-doc-drift-after-1550-1563.md) の PR は 🟡 に置いていた。項目34・49・51 と同じ「本物の adapter が、以前は通っていた入力を新しく断る」変更なので、同じ規律で 🔴 に数える。

**何が変わったか**: `updateStatusWithEvent`・`supersedeWithNewMemories?`（`supersede[i].event`）・`purgeMemory?`・`markContestedPair?`・`resolveContestedPair?`・`resolveOrphanedContested?`・`markContestedGroup?`・`resolveContestedGroup?`・
`createMemoriesWithOutboxAndEvents?`（`buildCreatedEvent` が返すイベント）は、引数のイベントの `memoryId` をそのまま `memory_events` に書き、これまで `ctx.tenantId` の記憶かを確かめなかった（`@mnemora/postgres`）。
今は書く前に、同じトランザクションの中で確かめ、実在しない・別のテナントの記憶なら、行を書かずに `PostgresMemoryStore: memory not found for tenant: <id>` の `Error` を投げる（status の更新ごと戻る）。
その呼び出しが今更新・作成した行の id と同じなら問い合わせない。`memoryId` が `null`・`undefined`（記憶を指さないイベント）は確かめない。同じテナントの別の記憶を指すイベントは、境界の穴ではないので断らない。
型・シグネチャは変わらない。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Fixed` の「`NewMemoryEvent.memoryId` が別テナントの記憶でも、イベントが書けた穴」の箇条を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 型検査は壊れないが、**以前は通っていた入力が、新しく例外になる**。項目21・23・24・27・34・49・51 と同じ扱い（本物の adapter が新しく断る変更。公開の fixture が断る変更は数えない、という上の規律の「当たらないもの」の側）。
conformance スイートは変えていない（ADR 0456 は testkit に1行も手を入れていない）ので、適合テストの判定が厳しくなる側面は無い。

**誰が影響を受けるか**: 上の口を `PostgresMemoryStore` に直接呼び、別のテナントの記憶 id をイベントに入れている呼び出し側。`Runtime` は常に自分の行を指すので、`observe()`・`recall()`・`tick()` などは変わらない。
uuid の形でない `event.memoryId` は、以前も生の `DrizzleQueryError` で落ちていたので、断る入力は増えない（例外の形が変わるだけ）。

**どう直すか**:
- イベントの `memoryId` は、同じ `ctx` で `MemoryStore.get` などで取れた記憶のものにする。
- 専用のエラー型・`kind` は無い（素の `Error`、メッセージは `PostgresMemoryStore:` で始まり、`memory not found for tenant` を含む）。
- 自前の `MemoryStore` 実装は、イベントを書く口の入口で同じ確かめを足す（適合テストは検査しない）。

**確かめたこと**: testkit のインメモリ実装 `InMemoryMemoryStore` は、以前は同じ入力（別テナントの記憶を指す `event.memoryId`）を断らなかった（[ADR 0463](./decisions/0463-migration-v1-red-items-checked-against-code.md) の実測。ADR 0456 の M7 の答え）。[ADR 0466](./decisions/0466-inmemory-event-target-belongs-to-ctx-tenant.md) で揃え、いまは同じ口で同じように断る（例外は素の `Error`、message は `InMemoryMemoryStore: memory not found for tenant: <id>`——接頭辞だけが違う）。fixture が新しく例外を投げる変更は破壊的と数えないので、🟡 の節に載せた（そちらの「`InMemoryMemoryStore`」の項目と相互に指す。大文字の uuid の扱いは [ADR 0469](./decisions/0469-fake-event-target-and-uuid-case.md) で `@mnemora/postgres` に揃えた）。2実装の一致は `packages/postgres/src/__tests__/event-target-parity.postgres.test.ts` が縛る。

**DB マイグレーション**: 要らない。修正前に書かれた、別テナントの記憶を指す `memory_events` の行が在れば、指された記憶のテナントの後始末（`purge`・`eraseTenant`）を止めうる形である（項目49 と同じ。ADR 0456 の S2 では、止まることまでは測っていない）。**既存の行は消さない**（データの書き換えはオーナーの判断が要る）。調べる SQL は項目49 の ADR 0436 に在る（`memory_events` の `tenant_id` と、指された記憶の `tenant_id` の食い違いを数える、読み取りだけ）。

### 53. `@mnemora/openai` の `completeStructured` が、応答の `"__proto__"` の欄の中身を継承された値として読まなくなり、それで通っていた応答が例外になるようになった

[ADR 0468](./decisions/0468-openai-null-strip-copies-own-proto-key-as-own-property.md)（[PR #1576](https://github.com/takecchi/mnemora/pull/1576)。クローン miku の委譲先の担い手が書いた。決めたのはクローンで、オーナーではない。[ADR 0434](./decisions/0434-testkit-fixtures-align-nul-int4-invalid-date-purged-at.md)・[ADR 0466](./decisions/0466-inmemory-event-target-belongs-to-ctx-tenant.md)（testkit の InMemory が別テナントを指すイベントを Postgres と同じく断る直し）と同じ「同じ port の緩いほうの実装を、もう一方に揃える」直し）。

⚠ **未リリース**。**番号は 53 である**——項目52 の続き。別の PR が同じ番号を使っていたら、merge のときに振り直すこと。

**何が変わったか**: `OpenAILLMProvider.completeStructured` は、応答の JSON を `null` を省略へ戻す写し（`stripNulls`・`keepSchemaNulls`）に通してから zod で検査する。この写しが `JSON.parse` の作った `"__proto__"` の欄を代入で写していたため、欄ではなく**プロトタイプの差し替え**になり、zod の `object` がその中身を**継承された値**として読んでいた。今は自分自身の欄として写すので、`"__proto__"` の欄は、ほかの余分な欄と同じく無視される（`@mnemora/anthropic` は `JSON.parse` の結果をそのまま検査するので、以前からこの扱いだった）。
型・シグネチャ・送る JSON Schema・既定のプロンプトは変わらない。中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` 節 `### Fixed` の「`completeStructured` が、応答の余分な `"__proto__"` の欄を」の箇条を見ること。**ここには複製しない。**

**なぜ破壊的と数えるか**: 型検査は壊れないが、**以前は通っていた応答が、新しく `ZodError` になる**（【実測】ADR 0468、擬似の client で直す前と後を比べた）。項目21・23・24・27・34・49・51・52 と同じ扱い。
- 必須の欄が `"__proto__"` の中にしか無い応答（例: `{"memories":[{"provenanceKind":"stated","__proto__":{"content":"x"}}]}`。根の必須の欄でも同じ）。以前は継承された値で埋まって通っていた。
- 利用者が `z.strictObject(...)` を渡し、応答に `"__proto__"` の欄がある応答（中身が object でも文字列でも）。以前は欄として見えず通っていた。今は `unrecognized_keys` になる。
- 上の2つ以外（`"__proto__"` が文字列・配列・`null`・空の object で、ほかの必須の欄が揃っている応答、`"__proto__"` の無い応答）は、直す前と結果が変わらない。core の4つのスキーマは strict ではないので、余分な `"__proto__"` は無視される。

**誰が影響を受けるか**: strict モードを守らない OpenAI 互換サーバを `client` に差している利用者だけ。本物の OpenAI の strict モードでは、スキーマの外の欄（`"__proto__"`）は応答に出ない。スキーマ自体に `__proto__` という名前の欄がある場合は、送る前に `schema_unsupported` で落ちるので、この変更は届かない（ADR 0468 の材料8）。

**どう直すか**:
- サーバ側で strict モード（`response_format` の `json_schema` の `strict: true`）を守る。
- 守れないサーバなら、`client` に渡す前の層で、応答の JSON から `"__proto__"` の欄を除く（必須の欄は、`"__proto__"` の中ではなく応答の欄として返させる）。

**DB マイグレーション**: 要らない。保存済みの記憶は変わらない（以前に継承された値で作られた記憶が在っても、書き換えない）。

## 🟡 後方互換だが挙動が変わりうるもの（v0.1.9 → v0.2.0）

（⚠ 2026-09-27: この見出しは PR #1192 が「v1.0.1 → 次の版」の節を書き換えたときに一緒に消えており、下の3項目が「v1.0.2 → 次の版」の節の中に在るように読めていた。見出しを戻した。下の3項目は v0.1.9 → v0.2.0 の話である）

### `RecallQuery.validAt` ゲートが既定で有効になった

**影響を受ける条件を明示する**: 次の**両方**に該当する場合だけ、recall の結果が
黙って変わる可能性がある。

1. v0.1.9 の時点で `MemoryStore.createMemory` を**直接**呼び出し、
   `validFrom`/`validUntil` に non-null の値を書いていた。
2. その `Memory` を `recall()` で取得している。

**該当しない場合は何も変わらない**——`Runtime.observe()` 経由では v0.1.9 の時点で
`validFrom`/`validUntil` に値を書く経路が存在しなかった（v0.2.0 で初めて
`ObserveUtteranceInput`/`ObserveEventInput`/`ObserveDocumentInput` に追加された）ため、
通常の利用者（`Runtime.observe()` だけで記憶を作っている場合）は影響を受けない。

**該当する場合、何をすればよいか**: 従来どおり `validFrom`/`validUntil` を無視して
recall したいなら、`RecallQuery.includeOutsideValidity: true` を渡す。

根拠: [ADR 0164](./decisions/0164-valid-from-until-recall.md)。

### `TICK_SUPPORTED_JOB_KINDS` が2値から4値になった

`["extract", "embed"]` → `["extract", "embed", "consolidate", "reflect"]`。

**影響を受ける条件**: この定数、または `OutboxJob.kind`/`TickResult` 関連の型を
`switch`+`never` などで網羅的に分岐しているコード。

**何をすればよいか**: `"consolidate"`/`"reflect"` のケースを追加する。**それ以外の
コード（値を消費するだけ）には影響しない**——既定では `tick()` がこれらの kind を
自動で積むことは無い（`RuntimeConfig.autoQueueConsolidateReflectOnExtract` が既定
`false` の opt-in、詳細は [CHANGELOG.md](../CHANGELOG.md) を参照）。

根拠: [ADR 0157](./decisions/0157-tick-drives-consolidate-and-reflect.md)。

### `PostgresVectorStore.search` の `ORDER BY` に `memory_id` の tie-break が追加された

**影響を受ける条件**: 通常は無し。距離が完全に一致する候補が複数あるとき、以前は
順序が未定義だったが、v0.2.0 では `memory_id` の順に決定的になる。**この変更で
recall の結果が意味的に変わることは無い**——同点だった候補の並び順が固定されるだけ。

根拠: [ADR 0167](./decisions/0167-association-getvectors-order-nondeterminism.md)。

---

## 🟡 v0.2.0 → v0.3.0 で、挙動が変わるが手順は要らないもの —— ⚠ **3件とも出荷済み**

⭐ **`v0.2.0` → `v0.3.0` には、`🟡` に相当する変更が3件ある**（`ann_unreached` の発火条件・
`sweepArchive` が従う時計・語彙チャンネルの tie-break）**が、いずれも利用者側の手順を要さない。**
⟹ **この文書には節を置かない。**中身と根拠 ADR は [CHANGELOG.md](../CHANGELOG.md) の
`[0.3.0]` の `### Changed（後方互換だが挙動が変わりうる）` を見ること——**ここには複製しない。**

⚠ **3件とも `v0.3.0` で出荷済みである**（PR #399 / #379 / #390）。
⟹ **`v0.3.0` を使っているなら、3件とも既に効いている。**
⭐ **`CHANGELOG.md` は 2026-09-18 に `[0.3.0]` 節を起こし、この3件をそちらへ移した**
（[Issue #536](https://github.com/takecchi/mnemora/issues/536)）。⟹ ⛔ **「`v1.0.0` で初めて効く」と
読まないこと**——**3件とも `v0.3.0` で既に効いている。**

⚠ **DB マイグレーションは別である**——**`v0.3.0` から `v0.4.0` 以降へ上げるなら `0018` の適用が要る**
（`0016`/`0017` は `v0.3.0` で出荷済みなので、`v0.3.0` を使っているなら適用済みのはずである）。
上の「DB マイグレーション」節を見ること。

---

---

## 🟡 v0.4.0 → v0.5.0 で、挙動が変わるが手順は要らないもの —— ⚠ **出荷済み**

⭐ **`v0.4.0` → `v0.5.0` には、`🟡` に相当する変更が1件ある**（連想枠（段3.5）の席が
**減衰を含む順位**で埋まるようになった。[ADR 0246](./decisions/0246-association-rank-includes-decay.md) /
[#402](https://github.com/takecchi/mnemora/issues/402)、PR #549）**が、利用者側の手順を要さない。**
⟹ **この文書には節を置かない。**中身は [CHANGELOG.md](../CHANGELOG.md) の
`[0.5.0]` の `### Changed（後方互換だが挙動が変わりうるもの）` を見ること——**ここには複製しない。**

⭕ **既定 off なので、`RecallQuery.association` を渡していない呼び手は1バイトも影響を受けない**
（ADR 0246「誰が壊れうるか」の逐語）。⟹ **`observe`/`recall`/`reflect`/`consolidate`/`forget` の
5つの動詞だけを使っているなら、何もしなくてよい。**

⚠ **2026-09-26 追記: 上の「既定 off」は `v0.5.0` 時点の記述である。**`v1.1.0` では連想枠の既定が
on に変わる（[ADR 0337](./decisions/0337-recall-association-default-on.md)、PR #838）——
`RecallQuery.association` を省略した呼び出しでも連想が走り、止めるには `association: null` を渡す。
⟹ **`v1.1.0` 以降へ上げるなら、「渡していない呼び手は影響を受けない」は成り立たない。**
中身は [CHANGELOG.md](../CHANGELOG.md) の `[1.1.0]` を見ること——**ここには複製しない。**

⚠ **`v0.5.0` で出荷済みである。**⟹ ⛔ **「`v1.0.0` で初めて効く」と読まないこと。**

## 🟡 v1.1.0 → 次の版で、挙動が変わるが手順は要らないもの —— **未リリース**

この節は、2026-10-01 に着地した変更（[PR #1550](https://github.com/takecchi/mnemora/pull/1550)〜[#1565](https://github.com/takecchi/mnemora/pull/1565)）のうち、
**利用者が気づいておくとよい振る舞いの変更**を載せる（[ADR 0459](./decisions/0459-round32-doc-drift-after-1550-1563.md)）。**いずれも利用者側の手順は要らない**（型・DB は変わらない）。
⚠ **それより前に `main` へ入った `[1.2.0]` の変更を、この節はまだ棚卸ししていない**（⛔ ここに件数を書かない）。中身と根拠 ADR は
[CHANGELOG.md](../CHANGELOG.md) の `[1.2.0]` の `### Changed`・`### Fixed` を見ること——**ここには複製しない。**
**落ちる入力が増える変更は🔴（番号付きの一覧）に載せる**——この節は、直したあとに「例外の形・場所が変わる」「以前は落ちていた入力が通る」「以前は静かに通っていた入力が落ちる」ものを短く挙げる。

- **`@mnemora/postgres`: トランザクションの `rollback` が失敗したとき、投げられるのが元のエラー（`code` 付き）になった**（[PR #1555](https://github.com/takecchi/mnemora/pull/1555)、[ADR 0444](./decisions/0444-pool-begin-release-rollback-error-preserved.md)）。
  以前は `Failed query: rollback` が投げられ、元のエラーが消えていた（接続ごと切れたときに起きる）。`rollback` の失敗は元のエラーの `cause`（空いていれば）か `rollbackError` に残る。
  `Failed query: rollback` の文面や、`err.cause` がその失敗であることに頼っていた呼び出し側は見直すこと。あわせて、`begin` が失敗した接続は pool へ戻らず捨てられるようになり（以前は借りたまま戻らず、Postgres の再起動を数回挟むと pool が枯れた）、
  `closePostgresClient` は `client.pool.end()` が既に直接呼ばれていても reject しない。
- **`@mnemora/postgres`: `observe` の抽出の候補ごとの savepoint の `rollback to savepoint` が失敗したときも、元のエラーが投げられる**（[PR #1561](https://github.com/takecchi/mnemora/pull/1561)、[ADR 0451](./decisions/0451-savepoint-rollback-failure-keeps-original-error.md)）。
  以前は、候補が落ちた理由が「rollback の失敗」にすり替わり、全候補が落ちたときは `Failed query: rollback to savepoint …`（または 25P02）が投げられ、一部が成功したときは `created` の `meta.droppedCandidates` にそのすり替わった理由が載って正常終了した。
  いまは巻き戻しの失敗を信用できない状態と見て、続けず、元のエラーを投げる（記憶も `created` も残らない）。巻き戻しが成功する悪い候補は、従来どおり落として他を書く。
- **`@mnemora/postgres`: `runMigrations` に読めない `migrationsDir`（存在しない・ディレクトリでない）を渡すと、DB に触れる前に `migrationsDir を読めない（<パス>）` で落ちる。`.sql` が1本も無いときは警告を出す**
  （[PR #1556](https://github.com/takecchi/mnemora/pull/1556)、[ADR 0448](./decisions/0448-migrate-cli-pool-error-unreadable-dir-session-settings.md)）。以前は、ロック・`CREATE SCHEMA`・`CREATE EXTENSION`・台帳の作成が済んだあとに生の `ENOENT` で落ち、副作用が残った。
  落ちる入力は増えない（以前も同じ入力で落ちていた）。⚠ **`mnemora-postgres-migrate`（CLI）は同梱の既定のディレクトリしか使えないので、この変更は CLI の利用者には届かない。**CLI の側の変更は、接続プールに `error` のリスナーを付けたこと
  （待機中の接続が DB 側から切られても、プロセスは落ちず、警告を出して続行する）。
- **`observe`・`reextract`・`consolidate`・`reflect`: LLM が返した保存できない値（NUL）は、その欄だけを落として記憶を作る**（[PR #1552](https://github.com/takecchi/mnemora/pull/1552)・[#1562](https://github.com/takecchi/mnemora/pull/1562)、[ADR 0443](./decisions/0443-aux-field-drop-bind-limit-association-fetch.md)・[ADR 0456](./decisions/0456-llm-returned-values-malformed-read-filter-nul-named.md)）。
  以前は、本文が正しくても `digest`・`tags` の要素・claim key に NUL が1つあるだけで、抽出ではその候補が丸ごと落ち、統合・内省は例外で終わった。落とした欄は `created` の `meta.droppedFields` に残る（[docs/memory-model.md](./memory-model.md) §11）。本文の NUL は従来どおり。
- **`@mnemora/postgres`: 読み取りの絞り（`labels`・`attributes` の key・value）・claim key・`extractorVersion` に NUL を渡すと、DB の生の例外（`Failed query: …`）ではなく、DB に触れる前の名指しの例外で断る**（[PR #1562](https://github.com/takecchi/mnemora/pull/1562)、ADR 0456）。
  落ちる入力は増えない（以前も落ちていた）。例外の文面に頼っていた呼び出し側は見直すこと。
- **`@mnemora/postgres`: 別テナントの記憶を指す `NewMemoryEvent.memoryId` を断る**（PR #1562、ADR 0456 の H4）は、本物の adapter が新しく断る変更なので、この節ではなく 🔴 の **項目52** に載せた（[ADR 0461](./decisions/0461-v1-2-0-release-prep-inspection.md)）。
- **`@mnemora/postgres`: `reinforceMany`（`observe({ kind: "memory_usage" })` の強化を含む）と `searchMany` が、件数が多くても PG のバインドパラメータの上限で落ちなくなった**（[PR #1552](https://github.com/takecchi/mnemora/pull/1552)、ADR 0443 決定2）。
  以前は `reinforceMany` が 13107 件、`searchMany` が 32767 件で、message が数 MB の例外で落ちた。
- **`runtime.applyCorrection`: `supersede` の `winnerId` を取り違えたとき、書き込む前に `RangeError` で落ちる**（[PR #1554](https://github.com/takecchi/mnemora/pull/1554)、[ADR 0446](./decisions/0446-apply-correction-no-write-before-winner-check-case-insensitive-candidate-reason-winner.md)）。
  例外の型・文言は同じ。以前は `markContested` が書いたあとに落ち、両側が `contested` のまま残った。`@mnemora/postgres` で候補の id を大文字にした `correctedId` は、store が同じ記憶と言えば候補として扱う。
- **`@mnemora/local-embedding`: 件数が `maxBatchSize`（既定 128）を超えて分割されたとき、チャンクの合間で `signal` の abort を見る**（[PR #1553](https://github.com/takecchi/mnemora/pull/1553)、[ADR 0445](./decisions/0445-local-embedding-chunk-abort-chat-drain-provider-docs.md)）。
  以前は abort の後も残りのチャンクをすべて推論してから reject していた（動いている1チャンクは今も止まらない）。128 件以下の呼び出しは変わらない。

- **`runtime.reextract`: 置き換えた側（`supersededById`）が、今回の抽出で `active` になる行になる**（[PR #1564](https://github.com/takecchi/mnemora/pull/1564)、[ADR 0454](./decisions/0454-reextract-anchor-observe-consolidate-state-matrix-round30.md)）。
  以前は候補列の先頭を置き換えた側にしたので、先頭が同じ Observation・同じ版の `superseded`／`archived` な既存行にぶつかると、置き換えた側が非 active の行になり、循環や active 0件ができた。
  いまは非 active の既存行にぶつからない先頭を選び、全候補がぶつかるときは何も supersede しない（`supersededMemoryIds: []`。ぶつかった行は `skipped` の `status_not_active`）。
  返り値が変わるのは、直す前の結果が壊れていた入力だけ（`supersededMemoryIds` が `[]` になる、`supersededById` が先頭の非 active な行から後ろの候補に変わる）。例外は増えていない。
- **`runtime.observe`: 冪等な再送（`extraction: "skipped"`・`memoryIds: []`）の戻り値にも、渡していれば `rejectedSubjectIds: []`・`claimKeyFailure: null`・`contestedDetection: []` が付く**（PR #1564、ADR 0454 決定4）。
  以前は欄が無く、TSDoc の「渡したら常に値／配列」と食い違っていた。再送かどうかを `contestedDetection === undefined` で見分けていた呼び出し側は、`extraction: "skipped"` と `memoryIds: []` で見分けること。
- **`recall()`: provider が `Float32Array` などの数値の型付き配列をクエリ埋め込みとして返しても受ける**（[PR #1565](https://github.com/takecchi/mnemora/pull/1565)、[ADR 0452](./decisions/0452-testkit-provider-fakes-align-with-contract.md) の「決めたこと」8番）。
  以前は embed ジョブ（ingest）は型付き配列を保存できるのに、recall だけが `embedding_provider_unavailable` になっていた。次元違い・有限でない成分・配列でないものは、今までどおり `embedding_provider_unavailable`。落ちる入力が減るだけの変更。
- **`@mnemora/testkit` の provider の fake・カセットが、約束に反する入力を新しく断る**（PR #1565、ADR 0452）。公開の fixture が新しく例外を投げる変更は破壊的と数えない（上の「数え方の規律への追記（2026-09-28）」の2）ので、🔴 ではなくここに載せる。
  自前のテストでこれらを組み立てている人は、次を見直すこと。
  - `SeededEmbeddingProvider`: 種の空間と `delegate.space` が違えば、構築で落ちる。
  - `CassetteRecorder`: 2回目以降の記録で、埋め込み空間・モデル名が最初と違えば落ちる（以前は後勝ちで上書きし、混ざったカセットができた）。
  - `assertCassette`: 成分が有限でない・`embedding.space.dimensions` が正の整数でない・埋め込みの鍵が `text` の SHA-256 と、LLM の鍵が `prompt` から導いた値と一致しないカセットを、読んだ時点で落とす。`RecordedEmbeddingProvider.embed` は有限でない記録を返さずに落ちる。
  - `RecordingEmbeddingProvider`: delegate の壊れた戻り（次元違い・有限でない成分・配列でない）を、記録せずに落ちる。
  - `DeterministicEmbeddingProvider`: `dimensions` が正の整数でなければ、構築で落ちる（`0` を含む。以前は `embed` で `RangeError` になるか、`0` は空のベクトルを返した）。
  振る舞いが変わるもの: Seeded\*・Recording\* は `opts`（AbortOptions）を delegate へ渡す。Recording\* は同じ入力の並列の呼びでも delegate を1回だけ呼び、見た値と記録が一致する。返すベクトルと `space` は、記録・構築時の引数と参照を共有しない。
  触っていない: カセットの鍵の導出（孤立サロゲート・`system` の空文字）と conformance suite。
  ⚠ **これらを 🔴 ではなくここに置いたのは、「公開の fixture が新しく例外を投げる変更は破壊的と数えない」というオーナーの回答（ask_human `3f3411c5`）の延長として読んだ判断で、覆す余地がある**（回答が直接名指したのは `@mnemora/testkit/fixtures` の InMemory 一式で、provider の fake・カセットまで含むかは確かめていない。[ADR 0461](./decisions/0461-v1-2-0-release-prep-inspection.md)）。

- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore`: 書き込み口に渡した `NewMemoryEvent.memoryId` が別テナントの記憶（実在しない id も同じ）のとき、`memory not found for tenant` で断る**（ADR 0466。[ADR 0456](./decisions/0456-llm-returned-values-malformed-read-filter-nul-named.md) の H4 の InMemory 版。🔴 の項目52 と相互に指す）。
  対象の口は `@mnemora/postgres` の H4 と同じ集合: `updateStatusWithEvent`・`supersedeWithNewMemories?`（`supersede[i].event` と `buildCreatedEvent`）・`purgeMemory?`・`markContestedPair?`・`resolveContestedPair?`・`resolveOrphanedContested?`・`markContestedGroup?`・`resolveContestedGroup?`・`createMemoriesWithOutboxAndEvents?`。
  以前は、別テナントの記憶を指すイベントが `ctx` のテナントの行として積まれた。いまは書く前に断り、何も書かない（status の更新も news も先に積んだイベントも）。`null` のイベント、今更新・作成した行や同じ呼び出しの別のメンバーを指すイベント、CAS に弾かれる対象や状態が変わらないメンバーのイベント（積まれない）は、`@mnemora/postgres` と同じく検査しない。
  例外は素の `Error`（`kind`・`code` は無い）で、message は `InMemoryMemoryStore: memory not found for tenant: <id>`。公開の fixture が新しく例外を投げる変更は破壊的と数えない（上の「数え方の規律への追記（2026-09-28）」の2）ので、🔴 には数えない。conformance suite は変えていない（`MemoryStore` を自前実装して suite に当てている利用者に、新しい約束は課さない）。自前のテストで `InMemoryMemoryStore` に別テナントの id を指すイベントを渡していた人だけが落ちる。
- **`@mnemora/testkit/fixtures` の `InMemoryMemoryStore`: `NewMemoryEvent.memoryId` が大文字の uuid でも、小文字にそろえて受ける**（[ADR 0469](./decisions/0469-fake-event-target-and-uuid-case.md)。上の項目（ADR 0466）と 🔴 の項目52 の続き）。
  `@mnemora/postgres` は uuid を小文字にそろえて比べるので、大文字の uuid を自テナントの記憶として受ける。`InMemoryMemoryStore` は、ADR 0466 の時点では完全一致で引き、自テナントの記憶の id を大文字にしたものも断っていた。いまは `@mnemora/postgres` と同じく小文字にそろえて受け、積むイベントの `memoryId` も小文字の正規形にする。別テナントの記憶は、大文字でも断る。
  **落ちる入力が減る変更**（新しく断る入力は無い）。操作の対象の `id`（`updateStatusWithEvent(ctx, id, …)` の `id` など）の大文字小文字は変えていない（fixture は完全一致のまま。ADR 0438・0446 の範囲）。`InMemoryEventStore.append` の `memoryId` の大文字は、まだ断る（`PostgresEventStore.append` は通す。ADR 0469 の「引き受けた負債」）。

### この節に載せなかったもの（理由つき）

- **[PR #1550](https://github.com/takecchi/mnemora/pull/1550)（ADR 0441）**: CHANGELOG・この文書の参照の食い違いと、consumer-install の検査の名前の修正。`@mnemora/core`・`@mnemora/postgres` の README に「TypeScript の `lib`・`target` は ES2022 以上」を書いたのは**既存の要件を文書に書いただけ**で、振る舞いは変わらない。
- **[PR #1551](https://github.com/takecchi/mnemora/pull/1551)（ADR 0442）**: 文書だけ（migration `0027` の deadlock は項目31の追記に書いてある）。
- **[PR #1557](https://github.com/takecchi/mnemora/pull/1557)・[#1559](https://github.com/takecchi/mnemora/pull/1559)・[#1560](https://github.com/takecchi/mnemora/pull/1560)（ADR 0447・0450・0453）**: 穴探しの確認（操作×状態の行列）の記録。直す線の穴は0件で、振る舞いは変えていない。
- **[PR #1564](https://github.com/takecchi/mnemora/pull/1564) の残り（ADR 0454）**: 穴探し30巡目の操作×状態の行列の記録と、`Runtime.observe` の TSDoc の訂正（abort した sync の observe の extract ジョブは、observe が claim したまま残る。文書だけ）。上の2件以外の探り棒は歯にしておらず、振る舞いは変えていない。
- **[PR #1558](https://github.com/takecchi/mnemora/pull/1558)（ADR 0449）**: bullmq の README・TSDoc を実 Redis で測り直した。コードの振る舞いは変えていない。
- **[PR #1563](https://github.com/takecchi/mnemora/pull/1563)（ADR 0457）**: README の `ANALYZE` の説明の実測による訂正。振る舞いは変えていない。

---

## この文書が確かめていないこと

- **DB マイグレーション（`0013`/`0014`/`0015`）を実際に Postgres へ適用した結果**
  ——この作業環境には `DATABASE_URL` が無く、SQL ファイルの内容を読んだ確認に留まる。
- **ここに挙げた「誰が影響を受けるか」の判定が、実際の外部 adapter 実装者にとって
  過不足ないか**——この repo の中からは検証できない。
- 🔴 **【2026-09-18 追記】`v0.2.0`..`4b92134` の 36 commit について、型に現れない
  「実行時だけの意味変更」が無いことは確かめていない。** 11〜15 を足したときの総ざらいは
  **公開 API の実 diff**を母集合にしており、`4b92134` より後の commit については
  `packages/*/src` を触った 15 commit を全部読んだが、**その前の 36 commit は
  CHANGELOG の既存の棚卸しに乗っただけである。**
  ⚠ **この「読んだ」は、その追記を書いた時点の範囲（当時 76 commit）に対するものである。**
  **【実測 2026-09-18、`main` = `93a083eb41eb480121ff897f8bbbd80d10631b12`】** **`git rev-list --count 4b92134..HEAD` は 83 である**
  ——⟹ 🔴 **その後に着地した分は掃けていない。**⛔ **ここに件数を写して追いかけないこと**
  （`main` が動けば必ずずれる）。**当日その場で引き直すこと。**
- 🔴 **【2026-09-18 追記】12〜15 を「破壊的」と数える前提**——`Runtime` や
  `MemoryStoreConformanceOptions` を**外部の誰かが自前実装しているか**——は、この repo の
  中からは検証できない。⟹ **プロジェクト自身が 1・5・6 で既に採った基準を、そのまま当てている。**
- 🔴 **【2026-09-21 追記】`v0.4.0`..`v0.5.0` に、型に現れない「実行時だけの意味変更」が
  **18** の他に無いことは、機械では確かめていない。**この世代で掃いたのは
  **①公開 API の型スナップショットの差分（差分なし）②`packages/postgres/migrations/` の差分（差分なし）
  ③出荷される面のソースで差分の在るファイルの一覧（2ファイル）**の3つで、
  **③を人が読んで分類した**（`AGENTS.md`「⚠ 機械には『検出』まで — 確定と書き込みは人に残す」）。
  ⭐ **この世代は差分が2ファイルしか無いので全部読めた。**⛔ **同じやり方が、差分の大きい世代でも
  成り立つとは言っていない。**
