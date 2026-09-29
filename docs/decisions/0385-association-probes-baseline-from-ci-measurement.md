# ADR 0385: association-probes の基準値を CI 実測（6回）から置き、基準値より悪化した arm を警告する節を足す — 許容幅は0、ADR 0158 が挙げた #316/#317 の前提は CI でも成立した（Issue #291）

- **状態**: 採用 (2026-09-30)
- **日付**: 2026-09-30

> **⚠ この ADR を書いているのは、マネージャー（クローンのセッション）から切り出された
> 作業者である。⛔ オーナー本人の決定ではない。**投稿者欄・commit の著者欄が誰であっても、
> それだけでは人間かクローンかを区別しない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> **ここに書く判断（許容幅を0にしたこと・悪化 arm の警告を門にしないこと）はすべて
> 「作業者の判断（オーナーではない）」であり、オーナーの確認・承認を得たものではない。**

**⚠ 各主張の出所を分ける**（ADR 0158 / ADR 0167 / ADR 0313 の体裁を踏む）。

- **【実測】** — この ADR の担当者が、GitHub Actions（`ubuntu-latest`）上で実際に
  `association-probes` ジョブを走らせ、`gh run download` で artifact を取得して確かめた。
- **【現物】** — この repo のコード・文書を、担当者が自分で読んで確かめた。
- **【受】** — ADR 0158 / ADR 0167 に記録された前任者の実測を報告として受け取り、
  この ADR の担当者は §3 で独立に再検証した箇所を除き再導出していない。

---

## 0. 引き継ぎの経緯

[ADR 0158](./0158-association-probes-bench.md) は `association-probes` ベンチを新設したが、
「引き受けた負債」3番で**基準値ファイル（`association-baseline.json`）を置いていない**と
明記した。理由は2つの前提——**Issue #316**（同一 commit の CI 再実行で連想枠の構成員が
一致しない）と **Issue #317**（`off` arm の公正性が破れ、gold が 0/12 のはずが 2/12 返って
いた）——が両方解決するまで、意味のある基準値を置けないためである。

その後 [ADR 0167](./0167-association-getvectors-order-nondeterminism.md) が Issue #316 の
原因（`recall-runtime.ts` の段3.5 が `getVectors()` の返却順をそのままアンカー処理順に
使っていたバグ）を特定して修正し、**ローカル環境（自分専用 `initdb` インスタンス）で
3回の再実行**により構成員がビット単位で一致することを確認した。Issue #317 も
ADR 0158 の2026-09-16追記で既に修正済みと記録されている。

**本 ADR は、マネージャーからの指示に基づき次を行った記録である**:

1. **CI（`ubuntu-latest`）で association-probes を実際に複数回（最低5回）実行し、
   ADR 0167 の修正がローカルだけでなく CI でも効いているかを裏取りする。**
2. **その実測から基準値ファイル `examples/chat/association-baseline.json` を作る
   （でっち上げない）。**
3. **基準値より悪化した arm（gold/hit1/hit10/MRR のいずれか）を Summary の上のほうに
   警告する節を、テストを先に赤くしてから実装する（門にはしない）。**
4. **`ci.yml` の summary ステップに `--baseline` を配線する。**

---

## 1. 【実測】CI（`ubuntu-latest`）で6回実行し、揺れは0だった

### 1.1 やったこと

- ブランチ `bench/association-probes-baseline` を push し、Draft PR
  [#1451](https://github.com/takecchi/mnemora/pull/1451) を作成した。
- そのブランチの CI run
  [`36630107141`](https://github.com/takecchi/mnemora/actions/runs/36630107141) の
  `association-probes` ジョブ（初回実行）に加え、**`gh run rerun <run-id> --job <job-id>`
  で同じジョブを5回追加実行**した（計6回）。job id は次の6つ:

  | #         | job id         | 結果    |
  | --------- | -------------- | ------- |
  | 1（初回） | `109616879647` | success |
  | 2         | `109622855210` | success |
  | 3         | `109623328638` | success |
  | 4         | `109623827681` | success |
  | 5         | `109624281085` | success |
  | 6         | `109624737731` | success |

- 各回 `gh run download <run-id> -n association-probe` で `association-probe.json`
  artifact を取得した（PR の GitHub Actions artifact は再実行のたびに同名で上書きされるため、
  次のジョブを起動する**前**に毎回ダウンロードした）。
- 6本の JSON から `measuredAt`（実行時刻）と `commit`（`pull_request` イベントの
  マージコミット sha。実行のたびに base が動けば変わりうる）を除いた残り全体
  （4 arm × 12 probe の `associationFrame` の構成員・`goldRank`・
  `repeatFrameIdenticalCount`/`repeatGoldRankSameCount` を含む）を `node` で
  1本目と突き合わせた。

### 1.2 分かったこと — 6回ともビット単位で完全一致した

**`measuredAt`/`commit` を除く JSON 全体が、6回すべてで完全に一致した
（`diff` の出力が空、6/6）。**

arm 別の値（6回とも同一。揺れの幅は最小=最大=下表の値、幅0）:

| arm             | gold(N/12) | hit@1(N/12) | hit@10(N/12) | MRR      | memoryCharsTotal | associationCharsTotal | repeatFrameIdenticalCount | repeatGoldRankSameCount |
| --------------- | ---------- | ----------- | ------------ | -------- | ---------------- | --------------------- | ------------------------- | ----------------------- |
| off             | 0          | 0           | 0            | 0.000000 | 52006            | 0                     | 12/12                     | 12/12                   |
| on(maxCount=3)  | 9          | 0           | 0            | 0.065220 | 52757            | 755                   | 12/12                     | 12/12                   |
| on(maxCount=5)  | 10         | 0           | 0            | 0.071172 | 53163            | 1176                  | 12/12                     | 12/12                   |
| on(maxCount=10) | 12         | 0           | 0            | 0.081282 | 54255            | 2270                  | 12/12                     | 12/12                   |

（`mrr` の生値: off=0、on3=0.06521950271950273、on5=0.07117188367188368、
on10=0.08128217778953074。以上は `examples/chat/association-baseline.json` の
`arms[].mrr` と同じ精度で確認できる——ここには写さない。）

**`hit1Count`/`hit10Count` は全 arm で構造的に 0 のままである**——連想枠経由の gold は
`recall()` の `limit=10` の後ろ（11位以降）にしか現れないため（ADR 0151/0158 の設計、
`buildSummaryMarkdown` の hit@10 caveat 参照）。この bench で hit@1/hit@10 が意味を持つ
場面は無く、悪化検出の実質的な対象は `gold`(goldReturnedCount)/`MRR` の2指標である
（詳細は §4）。

### 1.3 ローカル実行は行っていない（参考情報の不足として明記）

マネージャーの依頼書は「ローカルでの実行は参考にとどめる」としていた。本 ADR の担当者は
この環境に本物の Postgres + pgvector を用意する時間を CI 実測に割り当てる判断をし、
**ローカルでの `association-probes` 実行は行っていない。** CI（ubuntu-latest、
services.postgres）での6回の実測こそが基準値の唯一の出所であり、ローカル実行との
突き合わせが無いことは §9「確かめていないこと」に明記する。

---

## 2. 許容幅（`WORSENED_TOLERANCE`）は0にした

`scripts/association-summary-lib.mjs` の `WORSENED_TOLERANCE` は、`goldReturnedCount`/
`hit1Count`/`hit10Count`/`mrr` の4指標すべてで **0** にした——**1件でも基準値を下回れば
警告する。**

**理由**: §1 の実測で、同一 commit・同一ジョブ定義（services.postgres を毎回作り直す
使い捨てコンテナ、ADR 0158 §5）での6回の再実行が**揺れ0（完全一致）**だったため。
揺れが無いと実測できた対象に、あらかじめ緩めた許容幅を持たせる理由が無い——**許容幅は
実測されていない揺れを先回りして許すものではなく、実測された揺れを表すものであるべき
である**（AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」の精神に近い判断: 数字を
決め打ちで足すのではなく、実測が示した値をそのまま使う）。

**この判断が覆る条件は §8 に書く**（CI ランナー・pgvector のマイナーバージョンが
変わって揺れが生じたとき等）。

---

## 3. 【実測】ADR 0158 が挙げた #316/#317 の前提は、CI 上でも成立した

- **Issue #316（非決定性）**: ADR 0167 はローカル（自分専用 `initdb` インスタンス）での
  3回の実行で、連想枠の構成員（`associationFrame` の externalId 列）が一致することを
  確認した。**本 ADR は、GitHub Actions の使い捨て `services.postgres` コンテナ
  （ADR 0158 §5 が明記する「ジョブのたびに新しく作られ、終了後に破棄される」環境）の上で、
  6回の独立したジョブ実行によって同じ一致を確認した。** ローカルの3回よりも条件が
  厳しい（コンテナ自体を毎回作り直している）状況での裏取りである。
- **Issue #317（`off` arm の公正性）**: `off` arm の `goldReturnedCount` は6回とも
  `0/12` だった——ADR 0158 の2026-09-16追記（`ASSOCIATION_HAYSTACK` に filler 2文を
  足した修正）の効果が、CI 環境でも保たれていることを確認した。

**⟹ ADR 0158「引き受けた負債」3番が基準値を置く条件として挙げた2つの前提
（#316 と #317 の両方が解決していること）は、本 ADR の実測によって満たされたと判断する。**

---

## 4. ADR 0151「これが覆るとしたら」3番との関係（事実の記録に留める）

[ADR 0151](./0151-recall-association-unprompted.md)「これが覆るとしたら」3番は
次のように書いている:

> **`retrieval` ベンチで、連想枠が想起の質を動かさないと実測されたとき**
> ——**落とす。**`docs/autonomy.md` §1.2 の3番（動かなかったらどうするか）への答えである。

**実測した事実(§1)**: `off` arm は gold 0/12・MRR 0.000。`on`(maxCount=3/5/10) は
gold 9/10/12・MRR 0.065/0.071/0.081 と、`off` から明確に増加している。

**⛔ 本 ADR はこれを「連想枠は想起の質を上げた」という確定判断として書かない。**理由:

1. **標本が12件**であり、[ADR 0033](./0033-what-decided-the-rank-in-the-retrieval-bench.md)
   §3 の規律（標本7件からは失敗率も成功率も統計的に主張しない）に照らして、
   統計的な主張に足りる母数ではない——ADR 0158 自身がこの理由で required 化を見送っている。
2. **「動いたかどうか」を判定し、required 化するかどうかはオーナー領分である**
   （`AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」、ADR 0158 決定4）。
   本 ADR が変えるのは基準値ファイルと Job Summary の警告節だけであり、required の
   一覧・branch protection には一切触れていない。

**本 ADR が書けるのは、「`on`/`off` の差は事実としてこうだった」という記録までである。**
ただし §3 のとおり #316/#317 の前提が CI 実測で満たされたため、**「連想枠が想起の質を
動かしたかどうかを判定する ADR」を書く土壌が整った**、とだけ記す——これは
ADR 0158「これが覆るとしたら」3番（「#316 と #317 の両方が解決し、複数回の CI 再実行で
連想枠の構成員が安定して一致するようになったとき、そこで初めて『連想枠が想起の質を
動かしたか』を書く ADR が書ける」）に対する答えの前段である。**その ADR 自体は、
本 ADR の範囲外であり、オーナー・次の担当者が判断すること。**

---

## 5. 基準値より悪化した arm を警告する節（TDD: 赤→緑）

### 5.1 対象指標と表示

`gold`(goldReturnedCount)/`hit@1`(hit1Count)/`hit@10`(hit10Count)/`MRR`(mrr) のいずれかが
基準値を `WORSENED_TOLERANCE` を超えて下回った arm を、`buildSummaryMarkdown` が
Markdown の一番上のほう（`## arm 別まとめ` の表より前）に
`## ⚠ 基準値より悪い値がある（門ではない）` として列挙する
（`scripts/association-summary-lib.mjs` の `findWorsenedArms`/`buildWorsenedArmsSection`）。
`## arm 別まとめ` の表の「基準値との差」セルにも、悪化していれば ⚠ を先頭に付ける
（`formatArmBaselineDiff`）。**悪化した arm が無ければ節ごと出さない**——常に同じ節を
出すと定型文として読み飛ばされる、という `identifier-probe-summary-lib.mjs` の判断
（「一致なら1行、違うときだけ展開する」）を踏襲した。

**⛔ exit code には一切触れない。**`association-summary.mjs` は元々「入力そのものが
壊れている」ときだけ非0で終わる（ADR 0158 決定4、このベンチは required にしない）。
この節は検出するだけで、確定・判断は人に残す（AGENTS.md「⚠ 機械には『検出』まで」）。

### 5.2 赤の証拠

歯（`scripts/__tests__/association-summary-lib.test.mjs` に9件、
`scripts/__tests__/association-summary.test.mjs` に1件、計10件）だけを入れた
commit（`ceeb86c`）を push した後、作業ツリーとは別の worktree
`/tmp/mgr-91402725-red`（`git worktree add /tmp/mgr-91402725-red ceeb86c`）で実行:

```
npx vitest run scripts/__tests__/association-summary-lib.test.mjs \
  scripts/__tests__/association-summary.test.mjs
```

結果: **2 test files failed, 9 failed | 61 passed (70)**。失敗したテスト名:

- `⚠ 基準値より悪い arm を目立つ節で警告する(門ではない) > 🔴 gold(goldReturnedCount)が基準値より低い arm があれば、警告節が出て arm名と差を含む`
- 同 `> 🔴 hit1Count が基準値より低い arm があれば、警告節に含まれる`
- 同 `> 🔴 hit10Count が基準値より低い arm があれば、警告節に含まれる(hit@10注記とは別の話)`
- 同 `> 🔴 mrr が基準値より低い arm があれば、警告節に含まれる`
- 同 `> 🔴 悪化した arm が複数あれば、両方とも警告節に列挙される`
- 同 `> ⭐ 警告節は「## arm 別まとめ」より前(上)に出る(目立つ位置、Summary の上のほう)`
- 同 `> 🔴 arm 別まとめの表でも、悪化した arm の「基準値との差」セルに ⚠ が付く`
- 同 `> 非0の許容幅の中に収まる悪化は警告しない(WORSENED_TOLERANCE を直接読んで検査する)`
- `association-summary.mjs（子プロセスで起動） > 🔴 基準値より悪い arm があっても exit 0 のまま、警告節が Markdown に出る(門ではない)`

既存の61件（validateMeasured/validateBaseline/buildSummaryMarkdown の既存挙動）は
影響を受けず合格のままだった。

### 5.3 緑にした

commit `659ba29` で `findWorsenedArms`/`buildWorsenedArmsSection`/`WORSENED_METRICS`/
`WORSENED_TOLERANCE` を実装し、`formatArmBaselineDiff`/`buildArmSummaryTable` に ⚠ の
付与を足した。上記10件を含む3ファイル・**89テスト全て合格**
（`npx vitest run scripts/__tests__/association-summary-lib.test.mjs
scripts/__tests__/association-summary.test.mjs scripts/__tests__/ci-yml-association-wiring.test.mjs`）。

### 5.4 実際の基準値ファイルとの整合を確認した

§1 の実測（run1 の JSON）と、それをそのまま写した基準値ファイルを
`association-summary.mjs` に通し、`validateBaseline`/`buildSummaryMarkdown` が
正しく動くこと・両者が一致するため悪化警告節が出ないことを確認した
（`node scripts/association-summary.mjs --measured <run1> --baseline
examples/chat/association-baseline.json` → exit 0、`## ⚠ 基準値より悪い値がある` 節なし）。

---

## 6. `ci.yml` の配線

`association-probes` ジョブの summary ステップに `--baseline
examples/chat/association-baseline.json` を足した。**ジョブ名・`needs`・required の
一覧・exit code の扱いには一切触れていない**——変更は summary ステップの引数と
直上のコメントだけである。`scripts/__tests__/ci-yml-association-wiring.test.mjs` に、
`identifier-probes` ジョブの歯と同じ形で「`--baseline` がコミット済みの基準値ファイルを
指しているか」「そのファイルが `validateBaseline` を通るか」の2件を追加した
（従来の「`--baseline` を渡していない」ことを固定していた1件を置き換えた）。

「まだ基準値ファイルが無い」と書いていた docstring・コメントは、
`scripts/association-summary.mjs`・`scripts/association-summary-lib.mjs`・
`scripts/__tests__/ci-yml-association-wiring.test.mjs` の3箇所で更新した。
**ADR 0158・ADR 0168 の本文・既存の追記は書き換えていない**（`docs/decisions/README.md`
の規律）。

---

## 7. 副産物として見つけたバグ（この ADR・この PR の範囲外）

**`examples/chat/src/association-arm.ts:401` の `associationEnabled: association !==
undefined` は、`off` arm でも `true` になる。** [ADR 0337](./0337-recall-association-default-on.md)
（`packages/core` の `RecallQuery.association` の既定を on にした変更）を受けて、
`association-arm.ts` は「`off` arm でも `recall()` へ `association: null` を明示的に渡す」
よう直された（同ファイルのコメント参照。既定が on になった後、`association` キー自体を
渡さないと `off` arm が黙って on になってしまうため）。**しかし
`associationEnabled: association !== undefined` の判定は `!== null` に更新されておらず、
`null` も「defined」と判定されるため、`off` arm でも `associationEnabled: true` になる。**

**影響**: `armShortKey`/`buildArmSummaryTable` の「連想枠」列は `associationEnabled` を
見て `off`/`on(maxCount=N)` を出し分けるため、CI の Job Summary では `off` arm の
「連想枠」列が **`on(maxCount=null)`** と表示される（実際に `examples/chat/
association-baseline.json` を使って `association-summary.mjs` を実行し、現物で確認した
——2026-09-29）。**`associationMaxCount`（null/3/5/10）は正しいままなので、arm の識別
（`armShortKey`）自体は破綻していない**——`goldReturnedCount`/`hit1Count`/`mrr` 等の
実測値そのものには一切影響しない。

**この ADR・この PR では直していない**——`association-arm.ts` はベンチ本体（測定器）
であり、ADR 0168 が「⛔ 意図して触れない」としてきた対象である。修正には独立した
検討・歯（`associationEnabled` を検査する既存テストが無かったこと自体も含む）が要ると
判断し、**マネージャーへ別途報告する**（この ADR の §「確かめていないこと」にも記録する）。

---

## 8. 検討して採らなかった案

| 採らなかった案                                                                                             | なぜ落ちるか                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **揺れに備えてあらかじめ非0の許容幅を持たせる**                                                            | §1 の実測で揺れが0だった。実測されていない揺れを先回りして許す理由が無い(§2)                                                                                            |
| **`hit1Count`/`hit10Count` を悪化検出の対象から外す(常に0だから)**                                         | タスク仕様が明示的に名指しした4指標であり、将来 probe 集合が変わって hit@1/hit@10 が0でなくなる可能性を今から閉じる理由が無い。実質的に発火しないことは§1で注記に留めた |
| **`association-arm.ts` の `associationEnabled` バグ(§7)をこの PR で直す**                                  | 測定器本体への変更であり、ADR 0168 の「意図して触れない」方針・本 PR の依頼範囲(summary/baseline/ci.yml の配線)の外。独立した検討・歯が要る                             |
| **ADR 0151「これが覆るとしたら」3番に決着を付ける(「連想枠は効いた」と断定する)ADR をこの ADR 自身で書く** | ADR 0033 §3 の標本数規律・required 化がオーナー領分であることの2点から、本 ADR の担当者が判断できる範囲を超える(§4)                                                     |

---

## 9. 引き受けた負債・確かめていないこと

1. **6回の実測はすべて同一 PR・同一の測定対象コード（`association-arm.ts` 等は本 PR で
   変更していない）に対するものである。** 将来 `main` が進んで association-probes 側の
   コードが変わったとき、揺れが再び0であり続けるかは確かめていない。
2. **ローカル環境（`docs/autonomy.md` の `initdb` 手順）での実行は行っていない**（§1.3）。
   CI と手元の結果を突き合わせる ADR 0167 の作業とは異なり、本 ADR は CI のみを
   出所にしている。
3. **§7 のバグ（`associationEnabled` が `off` arm で `true` になる）は、この ADR の
   担当者が見つけたが直していない。** 次にこの領域へ着手する人（あるいはオーナー）が
   判断すること。
4. **§4 で触れた「連想枠が想起の質を動かしたか」を確定する ADR は、本 ADR の範囲外**
   のまま残っている。

---

## 10. これが覆るとしたら

1. **CI ランナー（`ubuntu-latest` のイメージ）・`services.postgres` の pgvector の
   マイナーバージョンが変わり、揺れが実際に観測されたとき**——`WORSENED_TOLERANCE`
   を、観測された揺れの幅に基づいて開き直すこと（0のままにしない）。
2. **`association-arm.ts`・`association-probe-set.ts` 等、測定対象のコードが変わり、
   基準値が古くなったとき**——`identifier-probe-baseline.json` 等と同じ方針で、
   CI 実測から手作業で更新すること（この ADR で置いた値を焼き込みとして扱わない。
   `AGENTS.md`「⛔ 対象外——実測して repo にコミットした基準値」参照）。
3. **§7 のバグが直されたとき**——`off` arm の「連想枠」列表示が `off` に戻る。
   基準値ファイルの `associationEnabled` フィールドも `false` に更新する必要がある
   （`armShortKey` は `associationMaxCount` も見るため、識別自体は壊れない）。
4. **誰かが「連想枠が想起の質を動かしたか」を判定する ADR を書くとき**——本 ADR §1/§3/§4
   の実測をそのまま引用できる（ADR 0158「これが覆るとしたら」3番への答えの前段として）。

---

Refs #291, ADR 0151, ADR 0158, ADR 0167
