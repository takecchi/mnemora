# 移行ガイド（v0.1.9 → v0.2.0 → v0.3.0 → v0.4.0 → v0.5.0 → v1.0.0）

**この文書は、利用者が版を上げるときに何をどう直すかだけを扱う。**⭐ **5世代を持つ**（⚠ 2026-09-18 に2→3世代、2026-09-19 に3→4世代、**2026-09-21 に4→5世代**へ訂正した。下記）**:**

| 世代 | 破壊的変更 | どこ |
|---|---|---|
| **v0.1.9 → v0.2.0**（出荷済み） | **7件** | 「🔴 破壊的変更（v0.1.9 → v0.2.0）」の **1〜7** |
| **v0.2.0 → v0.3.0**（🔴 **出荷済み**） | **4件** | **8**・**9**・**10**・**11** |
| **v0.3.0 → v0.4.0**（🔴 **出荷済み**） | **6件** | **12**〜**17** |
| **v0.4.0 → v0.5.0**（🔴 **出荷済み**） | **1件** | **18** |
| **v0.5.0 → v1.0.0**（🔴 **出荷済み**） | **0件** | 無し（この世代には最後まで何も着地しなかった） |

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
npm pack @mnemora/core@0.3.0 && tar -xzOf mnemora-core-0.3.0.tgz 'package/dist/*.d.ts' | grep restoreSuperseded
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
[docs/release-notes-v1.0.0.md](./release-notes-v1.0.0.md) が既に逐語で書いていた**
——「⛔ **`git rev-list --count v0.5.0..origin/main` を、この判定に使わないこと**——
**docs だけの commit でも増える**（実際に増えた）」。
⟹ ⭐⭐ **同じ判定を2つの文書が別々に持ち、片方だけが腐った形である。**
⛔ **これは「書き忘れ」ではなく、複製の帰結である**（`AGENTS.md` の反重複規律）。

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

⛔ **（この段落を書いた 2026-09-17 の時点では）`v1.0.0` はまだ切られていなかった。**経緯は [docs/roadmap.md](./roadmap.md) §7.12 に在る。
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

```ts
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

```ts
describeTenantSettingsStoreConformance({
  name: "my-tenant-settings-store",
  createStore: () => new MyTenantSettingsStore(),
  // v0.2.0 で必須になった:
  supportsDecayClock: false, // 自作 adapter が getDecayClock/setDecayClock/
                              // getDefaultHalfLifeRecalls/getActivitySeq を実装していないなら false
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

## 🟡 後方互換だが挙動が変わりうるもの（v0.1.9 → v0.2.0）

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
