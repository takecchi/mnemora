# ADR 0230: `superseded → active` の復旧口を作る — オーナーの判定のうち、⛔ **復旧口だけ**を着地させる（Issue #369 / PR #464）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-17

---

## 🔴 訂正（2026-09-17、着地当日）—— **「設計で選んだこと 1」の根拠の一部が偽だった**

⛔ **本文は1バイトも書き換えていない。**下に在るのは、この ADR を書いた時点の記録である
（`docs/decisions/README.md` の規律——**間違え方それ自体が記録だからである**）。**この追記が優先する。**

### 崩れた一文

本文「設計で選んだこと 1（粒度は「群」だけ）」は、群単位を選ぶ根拠にこう書いている:

> そして `superseded_by_id` が作る群は、**1回の `consolidate` / `reextract` / `resolveContested`**
> が作った単位とちょうど一致する

🔴 **`resolveContested` については偽である。**

### なぜ偽か —— **勝者は「新しく作られた Memory」ではない**

| 経路 | `superseded_by_id` に入るもの | 群は1回の操作で閉じるか |
|---|---|---|
| `reextract` | その場で**新規作成**した Memory | ⭕ 閉じる |
| `consolidate` | その場で**新規作成**した統合先 | ⭕ 閉じる |
| **`resolveContested`** | 🔴 **`resolution.winnerId` —— 前から在る普通の Memory** | ⛔ **閉じない** |

【実測】`markContested` の適格性は両側が `status === "active"` であることだけを見る
——`provenance.kind` も「過去に supersede の片側だったか」も見ない。
⟹ **統合先も、一度勝った勝者も、何度でも再び contested の一方になれる。**
⟹ **1つの `superseded_by_id` の下に、別々の操作の敗者が積み上がる。**

### 【実測】2026-09-17 —— **インメモリと本物の Postgres の両方で、同じ結果**

`main` = `ba9f9a1`（この ADR を運んだ PR #464 の squash）。
⚠ **走らせたのは、このマネージャーが立てた作業者である**（【受】ではない——依頼して結果を直接受け取った）。

1. `consolidate(A, B)` → 統合先 `C`（A・B が `superseded`、`superseded_by_id = C`）
2. `markContested(C, N)` → ⭕ **通った**
3. `resolveContested(C, N, { kind: "supersede", winnerId: C })` → N が `superseded`、`superseded_by_id = C`
4. `restoreSuperseded(ctx, { supersededById: C })` → 🔴 **A・B だけでなく N も `active` へ戻った**（`restored` 3件）

**別の形でも再現した**: 同じ `W` が2回続けて `resolveContested` の勝者になれ、
`restoreSuperseded({ supersededById: W })` が**2回分の敗者 `X`・`Y` を同時に戻した。**

### ⚠ 深刻度 —— **故障ではなく、射程が宣言より広いことである**

【実測】`markContested` / `resolveContested` を呼ぶ本番コードは `packages/` に **0件**であり、
唯一の呼び手 `examples/chat` は publish 対象6本に入っていない。
⟹ **この状態に到達するには、採用者が自分でその口を呼ぶ必要がある。**出荷される既定では起きない。
⛔ **だが `restoreSuperseded` は公開 API であり、`v1.0.0` で出る。**

### ⛔ この訂正が**しない**こと

- **実装は1行も変えていない。**群の絞り込み方を変えるか、記述のほうを正しく直すかは、
  **利用者から見える契約が変わる選択**である ⟹ **この追記は決めない。**
- ⟹ **[Issue #515](https://github.com/takecchi/mnemora/issues/515)** で追う（考えられる方向を4つ並べ、⛔ どれも採っていない）。

### ⭐ 本文のうち、崩れていない部分

- **「呼び出し側は戻したい Memory の id を知る手段をそもそも持たない」** —— 崩れていない。
  `superseded` は `recall()` に出てこない。⟹ **群を鍵にする動機自体は残る。崩れたのは「群＝1回の操作」のほうだけである。**
- **根拠1（`archived` だけが復旧口を持つ非対称）** —— 崩れていない。この ADR の存在理由は動かない。

---

## 🔴🔴 訂正2（2026-09-18）—— **この ADR は、自分が入れた破壊的変更に一度も触れていない**

⛔ **本文は1バイトも書き換えていない**（上の訂正1 と同じ規律）。**この追記が優先する。**

### 何が抜けていたか

この ADR が着地させた PR #464 は、**公開契約に必須メンバを2つ足している**:

| 契約 | package | 形 |
|---|---|---|
| **`Runtime.restoreSuperseded`** | `@mnemora/core` | `interface` の**必須メソッド**（`?` 無し） |
| **`MemoryStoreConformanceOptions.supportsRestoreSupersededBy: boolean`** | `@mnemora/testkit` | **必須フィールド**（`?` 無し） |

🔴 **どちらも、この ADR の本文には出てこない。**【実測 2026-09-18】この ADR に対する
`grep -c 破壊的` は **0** である。⟹ **この ADR を読んでも、破壊的変更が入ったことに気づけない。**

⚠ **`@mnemora/testkit` は出荷対象である**——`scripts/publish-targets.mjs` の `PUBLISH_TARGETS` 6本の1つで、
`package.json` に `private` が無く、【実測 2026-09-18】`npm view @mnemora/testkit dist-tags` は `latest: 0.3.0`。
⟹ **「repo の中だけで使う道具」ではない。**

🔴 **そして2件とも `v0.3.0` で既に出荷されている**（【実測】`npm view @mnemora/core dist-tags` = `latest: 0.3.0`）。

### ⛔ これは新しい判定基準ではない

**この repo は既に同じ形を破壊的と数えている。**【現物】`docs/migration-v1.md` の
「破壊的変更（v0.1.9 → v0.2.0）」節:

- **1.** `MemoryStore.getRecall` が必須メソッドになった
- **5.** ⭐ `Runtime.getRecall` が必須メソッドになった
- **6.** ⭐ `TenantSettingsStoreConformanceOptions.supportsDecayClock`（`@mnemora/testkit`）が必須フィールドになった

⟹ **6 は、この ADR が入れた `supportsRestoreSupersededBy` と同じ型の変更である。**
**基準は既に在った。この ADR が当てなかっただけである。**

### ⭐ ここがいちばん記録する価値のあるところ —— **非対称**

**同じ repo の、同じ種類の変更で、扱いが割れている:**

| ADR | 同じ形の変更 | 破壊的だと自分で書いたか |
|---|---|---|
| **この ADR（0230）** | `Runtime.restoreSuperseded` 必須化 / `supportsRestoreSupersededBy` 必須化 | ⛔ **一言も書いていない**（`grep -c 破壊的` = 0） |
| [ADR 0232](./0232-correction-candidates-returned-not-chosen.md) | `Runtime.findCorrectionCandidates` 必須化 | ✅ **自分で書いた**——【逐語】「⚠ **`Runtime` interface にメソッドを足すのは、interface を自分で実装している側には破壊的である。** 直前の `main` に入った `Runtime.restoreSuperseded`（ADR 0230）と同じ立場である。」 |
| [ADR 0237](./0237-restore-superseded-dry-run-preview.md) | `supportsPreviewRestoreSupersededBy` 必須化 | ⚠ **同じ節の中で自己矛盾していた**（結論行「追加のみで、破壊的変更ではない。」／4番目の箇条書き「これは…破壊的」）。2026-09-18 に訂正済み（PR #526） |

🔴 **ADR 0232 は、この ADR を「同じ立場である」と名指ししている。** ⟹ **後から書いた人は気づいていた。
気づいていなかったのは、先に書いたこの ADR のほうである。**

### ⟹ これは書き手の注意力の問題ではなく、規律の穴である

3本のうち**自分で正しく申告できたのは1本だけ**だった。⟹ ⛔ **「次からは気をつける」では塞がらない。**

⭐ **次に ADR を書く人へ**: **`interface` に必須メンバ（`?` の無いメソッド・フィールド）を足したら、
それは出荷対象パッケージにとって破壊的変更である。** ⟹ **ADR に「破壊的変更かどうか」の節を置き、
そこで名指しすること。** ⚠ **`@mnemora/testkit` も出荷対象である**——`packages/core` だけを見ると落ちる。

⚠ **数え方の注意**: ⛔ **`packages/*/src` の差分で数えないこと。** 【現物】`docs/release-v1.md` が逐語で
「⛔ **この確認を「`src` を触った commit を数える」に置き換えないこと。**」と警告している。
⟹ **公開 API の実 diff（`scripts/__snapshots__/public-api/*.d.ts`）から数えること。**

### この訂正が着地させないもの

- ⛔ **`interface` の必須メンバ追加を機械的に検出して ADR に書かせる門は、足していない。**
  `scripts/check-public-api-surface.mjs` は公開 API の差分を検出するが、**それを「ADR に破壊的だと書いたか」とは
  突き合わせていない。** ⟹ **この訂正が買ったのは記録であって、再発防止ではない。**
- ⛔ **外部に `Runtime` / `MemoryStoreConformanceOptions` を自前実装している利用者が実在するかは確かめていない**
  （この repo の中からは検証できない）。**プロジェクトが 1・5・6 で既に採った基準をそのまま当てている。**

---

## 🔴🔴 訂正3（2026-09-18）—— **訂正2 の「2件とも `v0.3.0` で既に出荷されている」は偽である**

⛔ **本文も、訂正1・訂正2 も1バイトも書き換えていない**（上の2つと同じ規律）。**この追記が優先する。**

### 崩れた一文

訂正2 の「**何が抜けていたか**」節の末尾は、逐語こう書いている:

> 🔴 **そして2件とも `v0.3.0` で既に出荷されている**（【実測】`npm view @mnemora/core dist-tags` = `latest: 0.3.0`）。

🔴 **偽である。2件とも `v0.3.0` に入っていない。**

### 【実測 2026-09-18、`main` = `93a083eb41eb480121ff897f8bbbd80d10631b12`】

| 見たもの | 結果 |
|---|---|
| `git merge-base --is-ancestor ba9f9a1 v0.3.0` | 🔴 **偽**（exit 非0）。`ba9f9a1` は本 ADR を運んだ PR #464 の squash であり、**`v0.3.0` の祖先ではない** |
| `@mnemora/core@0.3.0` の `dist/*.d.ts`（`npm pack` した現物） | `restoreSuperseded` が**無い** |
| `@mnemora/testkit@0.3.0` の `dist/*.d.ts`（同上） | `supportsRestoreSupersededBy` が**無い** |

⟹ **`Runtime.restoreSuperseded` の必須化も、`MemoryStoreConformanceOptions.supportsRestoreSupersededBy` の
必須化も、まだ出荷されていない。**どちらも `v0.3.0` より後に着地する。

### ⚠ なぜ間違えたか —— **`npm view dist-tags` は「その変更が入っているか」を答えない**

訂正2 が根拠に挙げたのは `npm view @mnemora/core dist-tags` = `latest: 0.3.0` **だけ**である。
⛔ **`dist-tags` が答えるのは「いま `latest` に付いている版はどれか」であって、
「*この変更が*その版に入っているか」ではない。**——**`latest` が `0.3.0` であることは、
`0.3.0` が何を含むかについて何も言っていない。**

⭐ **次に「出荷済みか」を書く人へ**: **版に入っているかは、次のどちらかで見ること。**

- **`git merge-base --is-ancestor <その変更を運んだ commit> v<version>`**（exit 0 なら入っている）
- **その版の現物**——`npm pack @mnemora/<pkg>@<version>` を展開して `dist/*.d.ts` を読む

### ⛔ この訂正が**しない**こと

- **実装は1行も変えていない。**⭐ **訂正2 の主要な指摘——「この ADR は自分が入れた破壊的変更に
  一度も触れていない」——は崩れていない。**崩れたのは「**既に出荷されている**」のほうだけである。
- ⛔ **`dist-tags` の誤用を機械的に止める門は足していない。**⟹ **この訂正が買ったのは記録であって、
  再発防止ではない**（訂正2 と同じ限界である）。

### この訂正の宛先（同じ日に直した）

- [`docs/migration-v1.md`](../migration-v1.md) の項目 **12**・**13**（どちらも「既に `v0.3.0` で
  出荷済み」と書いていた）と、冒頭の「⛔ 「出荷済みか」を `npm view dist-tags` で判定しないこと」節
- [`CHANGELOG.md`](../../CHANGELOG.md) の `[1.0.0]`「追加」節の `Runtime.restoreSuperseded` の項目

⚠ **これは [Issue #532](https://github.com/takecchi/mnemora/issues/532) の本体である。**

---

## 🔴🔴 訂正4（2026-09-21）—— **「設計で選んだこと 1」の根拠は、`reextract` についても偽だった**

⛔ **本文は1バイトも書き換えていない**（訂正1〜3 と同じ規律）。**この追記が優先する。**

### 何が誤っていたか

訂正1 は、本文「設計で選んだこと 1（粒度は「群」だけ）」の根拠
（「`superseded_by_id` が作る群は、1回の `consolidate`/`reextract`/`resolveContested`
が作った単位とちょうど一致する」）のうち、**`resolveContested` の行だけを偽と訂正した。**

🔴 **`reextract` の行も偽である。**[Issue #515](https://github.com/takecchi/mnemora/issues/515)
方向①（[ADR 0258](./0258-restore-superseded-operation-scope.md)）を設計・実装する過程で、
別の作業者が実測し、両 adapter（インメモリ・本物の Postgres）で再現した【受】。

### なぜ偽か —— **`resolveContested` とは違う機序で、同じ結論に落ちる**

⚠ **取り違えないこと**: `resolveContested` が壊す理由（勝者が前から在る Memory を
使い回す）と、`reextract` が壊す理由（下記）は**別の機序**である。たまたま同じ
「群が1回の操作と一致しない」という結論に落ちるだけで、原因は共有していない。

1. 【現物】`packages/postgres/src/memory-store.ts` の `createMemoryWithOutbox` の
   INSERT は `ON CONFLICT (tenant_id, source_observation_id, extractor_version,
   content_hash) WHERE source_observation_id IS NOT NULL DO NOTHING` を持ち
   （このチェックアウトでの行番号は :635 付近）、衝突時（`inserted.rows.length === 0`）は
   既存行を `SELECT` して `created: false` で返す——**新規作成ではなく、前から在る
   Memory への解決になる。**
2. 【現物】`packages/core/src/runtime.ts` の `reextract` は、`memoryIds.push(memory.id)`
   を**`created` の真偽に関わらず**行い（:2635 付近）、最後に
   `supersededById = memoryIds[0]!`（:2643 付近）でアンカーを取る——**位置で選ぶだけ**
   であり、`created === true`（今回新規作成した）かどうかを見ない。
3. ⟹ **今回の再抽出でも内容が変わらなかった候補が候補列の先頭に来ると、アンカーは
   「今回作った新しい Memory」ではなく「前から在った Memory」になる。**この Memory が
   別の（過去または将来の）`reextract` 呼び出しでも同じ理由でアンカーに選ばれると、
   複数回の別々の呼び出しが同じアンカーを共有し、それぞれの敗者が同じ
   `superseded_by_id` の下に積み上がる。

### 【受】実測（両 adapter で再現）

このチェックアウトを書いている作業者自身は再現していない——別の作業者からの報告として
受け取った。生の `memory_events` の一致（両方の呼び出しで `reason`・
`sourceObservationId`・`extractorVersion` の3つとも完全一致し、既存の情報からは
どちらの呼び出しの敗者かを区別できなかった）が根拠として示されている。

### ⚠ `consolidate` の行は崩れていない（構造的な理由つき、こちらは自分で確かめた）

【現物・自分で確認】`packages/core/src/strategies/consolidate.ts` は統合先の
`sourceObservationId: null` を設定する（:128 付近）。上記1の部分索引は
`WHERE source_observation_id IS NOT NULL` を述語に持つため、この述語を満たさない
新規行（`source_observation_id` が `null`）はそもそもこの索引の対象に入らない
——標準的な Postgres の部分索引の挙動として、`ON CONFLICT` はこの索引を仲裁者として
使えず、衝突判定自体が起こらない。⟹ **`consolidate` の統合先は常に新規作成され、
この訂正の対象ではない。**

### この訂正が着地させるもの・着地させないもの

- ⭐ **[Issue #515](https://github.com/takecchi/mnemora/issues/515) 方向①
  （[ADR 0258](./0258-restore-superseded-operation-scope.md)）は、この事実を織り込んで
  設計されている**——`reextract_superseded` を由来とする候補は、`consolidated`
  （構造的に1操作と一致することが保証される）とも `contested_resolved`
  （1件が必ず1操作であることを歯で固定している）とも扱いを分け、
  `boundaryConfidence: "unknown"`（既存の情報では操作単位に分割できるとは断言できない）
  として扱う。⛔ **割れるという顔をしない。**
- ⛔ **`reextract` のアンカー選定を変える案（`created === true` の候補を優先する等）は、
  この訂正では実装しない。**出荷済みの `reextract` の挙動を変えるうえ、
  「全候補が既存解決になる」縮退ケースが未検証であるため——ADR 0258 の
  「確かめていないこと」を見ること。
- ⛔ **実装は1行も変えていない。**訂正1〜3 と同じ規律。

---

## ⭐ 追記（2026-09-17）—— **(α)/(β) の出所を3段に分ける**

**本文「決定」節は「問いの本文が在る場所」として Issue #197 のコメントを挙げているが、
それは「選択肢の全文の初出」であって「(α)/(β) という表記の初出」ではない。**

【実測】`gh issue list --state all --limit 300` で取れた**全 ISSUE の本文とコメント**を `(α)` で掃いた結果（時刻順）:

| 時刻 | 場所 | 何が在るか |
|---|---|---|
| 2026-09-16T17:54:39Z | **#400** | **記号 `(α)/(β)` の初出。**⛔ **中身は無い**（「どちらで読むか」としか書いていない） |
| 2026-09-17T08:06:04Z | **#488** | 両方の読みの**一行の意味**の初出 |
| 2026-09-17T08:18:34Z | **#197** | ⭐ **選択肢の*全文*と「いつ出したか」の初出** |

🔴 **そして、そのどれもオーナーの言葉ではない。**#197 のコメントは自分で「⛔ **これは答えではない**」と名乗っている。
⟹ ⭐ **オーナーの言葉は `ask_human 1b53aa2b-4653-4736-bdf9-648b7f5d6cfc` への回答だけである。**
⛔ **「オーナーが (α)/(β) という言葉を使った」と読まないこと。**この定式化は担い手が作ったものである。

⚠ **掃いた範囲**: ISSUE のみ。⛔ **PR のコメントは掃いていない。**

---

**⚠ 各主張の出所を分ける**（ADR 0132 / 0137 / 0183 / 0192 / 0228 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git` / `gh` / `node` / `psql` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

---

## 問い

**機械が駆動して `superseded` になった Memory を、`active` へ戻す公開された口を作るか。**

## 決定 — ⭐ **作る。これはオーナー本人の判定である**

### 逐語と、その出所

> **αで復旧口を作るでお願いします**

| | |
|---|---|
| **決めた人** | ⭐ **オーナー本人**（担い手の提案でも、担い手による追認でもない） |
| **決めた日** | **2026-09-17** |
| **出所** | **`ask_human 1b53aa2b-4653-4736-bdf9-648b7f5d6cfc` への回答**（この repo の外に在る経路） |
| **問いの本文が在る場所** | [Issue #197 のコメント](https://github.com/takecchi/mnemora/issues/197#issuecomment-5711241667)（⛔ ここには再掲しない——同じ本文が2箇所に在ると、片方が腐ったときに気づけない） |

⛔ **出所をここに書いている理由**: [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) が、
OPEN な ISSUE のコメント投稿者名ではオーナーと担い手（エージェント）を見分けられず、
見分けられるのは本文中の逐語の名乗りだけである、と決めている。
⟹ **投稿者欄からは判定の重みが読み取れないため、本文で名乗るしかない。**
**この ADR の記述を「担い手がそう判断した」と読まないこと。**

### 問いは2つあり、どちらにも答えが出ている

| | 問い | 回答 |
|---|---|---|
| **問い1** | 正典（`docs/north-star.md`）の「**間違いを正すと、古いほうが先に出てこなくなる。**」を、**(α)「出てこなくなる」＝検索結果に返らなくなる**（`superseded` が要る）と読むか、**(β)「古いほうが*新しいほうより先に*出てこなくなる」＝相対的に早く沈む**と読むか | ⭐ **(α)** |
| **問い2** | **復旧口（`superseded → active` へ戻す口）を作るか** | ⭐ **作る** |

---

## 🔴 この ADR が着地させないもの —— **(α) 本体は入っていない**

⛔ **これを取り違えないこと。実際に取り違えが起きている。**

**この ADR が記録する PR（#464）が足すのは、問い2（復旧口）だけである。**
**問い1 の (α) を*満たす*実装——すなわち [Issue #369](https://github.com/takecchi/mnemora/issues/369) の
「訂正の口」（採用側が「これは訂正である」とだけ宣言し、相手は mnemora が recall で探し、
`superseded` まで到達する）——は、1行も入っていない。**

【実測】2026-09-17、`gh pr list --state open` の4本（#464 / #417 / #386 / #366）に、
**#369 を実装する PR は無い。**

⟹ ⭐ **この ADR が着地しても、北極星「目指す姿」項目5 は立たない。**
`docs/roadmap.md` §7.14 が記録するオーナーの決定（項目5 を埋めてから `v1.0.0` を出す）は、
**この ADR では満たされない。**

### なぜ分けたか

**#369 自身が「復旧口が*先に*要る」と書き、それが来るまで着手するなと書いていたからである。**
【現物】Issue #369 の 2026-09-16 のコメント（逐語）:

> **`superseded` への復旧口（`superseded → active`）が先に要る**——それが在れば、mnemora が
> 相手を選んで `supersede` する形を**取り消せる**ようになり、上の理由2・3 が外れる。
> ⛔ **無ければ、推論で選んだ相手を永久に recall から外すことになる。**

⟹ **この ADR は、その「先に要る」ほうである。**

---

## 根拠

### 1. ⭐ 復旧口には、(α) と**独立した**根拠がある —— 今日すでに開いている穴である

⛔ **「(α) を実装するために要る」だけではない。**

**機械が駆動する状態遷移のうち、`archived` だけが復旧口を持ち、`superseded` は持たない。**
【現物】`docs/memory-model.md` の lifecycle 表は、この PR の前まで **14行**だった:

| 閉じる方向（機械が駆動する） | 開く方向 |
|---|---|
| 掃引 → `archived`（表の行8） | ⭕ `restoreArchived` → `active`（行14、[ADR 0122](./0122-restore-archived-memory.md)） |
| `reextract` / `consolidate` / `resolveContested` → `superseded`（行5・行7・行12） | 🔴 **無い** |

🔴 **そして `reextract` と `consolidate` は、どちらも出荷済みであり、どちらも LLM を呼ぶ。**
⟹ **今日でも、機械が誤って supersede したものを `active` へ戻す公開経路が無い。**

⟹ ⭐ **この穴は (α) を採らなくても開いている。**(α) はそれを**重くした**だけである。

### 2. 迂回路は成立しない —— **`superseded` は掃引に拾われない**

「`superseded` →（掃引）→ `archived` →（`restoreArchived`）→ `active`」という
既存の公開経路で代替できるのではないか、という筋は**成り立たない。**

【現物】[ADR 0114](./0114-archive-sweep-for-decayed-memories.md) の決定2 は
逐語で「**対象は `status = 'active'` のみ。`superseded`/`contested` はこの口では触らない**」と決めており、
【実測】`packages/postgres/src/memory-store.ts` の掃引 SQL も `AND status = 'active'` だけを持つ。

【現物】`Runtime.resolveContested` の `{ kind: 'both_active' }` も代替にならない——
`runtime.ts` の doc コメントが「どちらも正しかった（**対向ではなかったと分かった**）」と定義しており、
**supersede の取り消しではない。**加えて `supersede` で決着すると `contestedWithId` が両側 `null` になるため、
**適用する対象が残らない。**

### 3. ⭐ この repo の実際の基準は「推論だから駄目」ではなく「**戻せないから駄目**」である

**`consolidate` は LLM を呼び、統合元を `superseded` にする。それは通っている。**
⟹ **「機械の推論が supersede してはいけない」という規律は、この repo には無い。**

🔴 **訂正で機械の supersede が使えなかった理由は「推論だから」ではなく「戻せないから」である。**
⟹ ⭐ **復旧口は、まさにその理由を消す。**

### 4. ⚠ 「戻せない」の正確な形 —— **公開された口が無い**のであって、SQL で不可能なのではない

【受】PR #464 本文の【実測】として受け取った（⛔ **この ADR の書き手は再現していない**）:
自分専用の Postgres に対し `UPDATE memories SET status='active', superseded_by_id=NULL …` は通る。
`memories` の CHECK は `status IN (…)` だけで、`status` と `superseded_by_id` を結ぶ制約もトリガも無い。

🔴 **同じ probe で、`status='active'` のまま `superseded_by_id` を残す不整合も通った**【受】。
そして手で直す経路は `memory_events` に何も積まない
⟹ **北極星「なぜそれを思い出したのかを、後から説明できる」が落ちる。**
⟹ ⭐ **これ自体が、公開口を作る側の根拠である**——口が無いことは「戻せない」ではなく
**「戻すと記録が残らない」**を意味していた。

---

## 設計で選んだこと

⛔ **`restoreArchived` と形だけ揃えて意味がずれるほうが危ない。**1つずつ理由を持たせた。

### 1. 粒度は「群」だけ —— `target: { supersededById }`

**個別の Memory id を渡す形は作らない。**決め手は使い勝手ではない:

🔴 **`superseded` な Memory は `recall()` に出てこない**（段1の status ゲートが `["active","contested"]` 固定）。
⟹ **呼び出し側は、戻したい Memory の id を知る手段をそもそも持たない。**
手元に残る唯一の取っ手は「置き換えた側（新しいほう）」である。

そして `superseded_by_id` が作る群は、**1回の `consolidate` / `reextract` / `resolveContested`**
が作った単位とちょうど一致する。既存の部分索引がそのまま効くため、**新しい索引は足さない。**

### 2. 🔴 戻すとき、supersede した側（新しいほう）には一切触らない

消さない・`forget` しない・`status` を変えない。

1. **`consolidate` の統合先は、supersede が誤りでも中身は正しいことがある。**黙って消すと作業を破壊する。
2. **`forget` が既に在る。**始末したいなら呼び出し側が明示的に選べる。
3. **北極星「後から説明できる」** — 操作1つにイベント1つのほうが辿れる。
4. **北極星「推論と事実を区別する」** — 統合先は `provenance.kind='consolidated'`（推論由来）、
   戻す側は `stated`（利用者が言った事実）のことが多い。**どちらを残すかを枠組みが勝手に決めない。**

### 3. `MemoryStore.restoreSupersededBy?` を**任意メソッド**として新設する

⛔ **[ADR 0122](./0122-restore-archived-memory.md) の決定1「`MemoryStore` に新しい任意メソッドを足さない」は、
ここには転用できない。**

【実測】その postgres 実装は `superseded_by_id = COALESCE(<引数>, superseded_by_id)` であり、
**`NULL` へ戻す経路が型にも SQL にも無い。**（`packages/postgres/src/memory-store.ts` に
この形の `COALESCE` が3箇所ある。）
加えて、群単位の範囲走査＋一括更新は [ADR 0114](./0114-archive-sweep-for-decayed-memories.md) が
`archiveDecayed?` を新設した形そのものである。
⟹ 口が無い adapter には `supported: false` を返す（`sweepArchive` と同じ規律）。

### 4. イベントの `kind` は `unsuperseded` を新設する（`restored` を再利用しない）

**監査を `kind` で引くとき、「archive から戻った」と「supersede を取り消した」が
同じ `kind` だと分けて引けない。**
[ADR 0122](./0122-restore-archived-memory.md) が `updated` の再利用を却下して `restored` を新設したのと同じ理由である。
⟹ migration `0018_memory_events_kind_unsuperseded.sql` が CHECK 制約を広げる。

### 5. 戻したあと `reinforce` も呼ぶ —— ⚠ **理由が同じだからであって、形が同じだからではない**

[ADR 0153](./0153-recall-decay-floor-gate.md) が recall の忘却ゲートを既定 ON にしたため、
`status` だけ戻しても `decayFloorAt` が過去なら **recall に出てこない＝復旧になっていない。**
[ADR 0048](./0048-reinforce-does-not-move-decay-origin-backwards.md) により無条件に呼んで安全。

⚠ **前提は `restoreArchived` と違う** —— archived は掃引の選定条件上、床が必ず過去である。
`superseded` の床は過去とは限らない。⟹ **行14 が `decay_floor_at` を動かさないのに対し、行15 は動かす。**

---

## 引き受けた負債

### 1. 🔴 戻した直後は、古いほうも新しいほうも `active` であり、`recall()` は**両方を返しうる**

⛔ **黙って通さないために、ここに逐語で書く。**

**これは決定2（新しいほうに触らない）の直接の代償である。**
答えは呼び出し側が選ぶ——`forget(ctx, supersedingMemoryId)` を別途呼ぶか、`markContested` で対にするか。
**その id は返り値 `RestoreSupersededResult.supersedingMemoryId` に載せて運ぶ。**
⟹ `opts` に「ついでに消す」分岐は足していない。

⭐ **新しい状態を作ってはいない** —— `docs/memory-model.md` の lifecycle 行7 が
`resolveContested({ kind: 'both_active' })` の決着として**同じ形**を既に定義している。

### 2. `docs/memory-model.md` の行8 が実装より広いことが分かったが、この PR では直さない

【現物】doc は起点を3つ（`active`/`superseded`/`contested`）書き、実装は `active` のみである。
`docs/autonomy.md` の「ついでに直さない」に従う。**別途 [Issue #465](https://github.com/takecchi/mnemora/issues/465) が扱う。**

---

## 🔴 この判定が**解決していない**こと —— 次に読む人が、解決済みと読まないために

**#369 の「二段構え」（確からしければ `supersede` まで一気に進む）は、独立検算によって
4つの理由で取り下げられている**【現物】。**オーナーのこの回答が外すのは、そのうち2つだけである。**

| # | 取り下げの理由 | この回答で外れるか |
|---|---|---|
| 1 | ADR 0185 草案（PR #366、未マージ）自身が (C) を `contested` で止めている | ⚠ **(α) の採択と競合する。ADR 0185 の側で扱うべきもので、この ADR は決めない** |
| 2 | **失敗の向きが逆転する**（「余分に1件出る」→「正しい記憶が消える」） | ⭕ **外れる**——戻せるなら「消える」は永続しない |
| 3 | **消えたら戻せない** | ⭕ **外れる。これがこの ADR そのものである** |
| 4 | **「勝者は人が決めた」とは言えなかった**——(C) で人が渡すのは「これは訂正である」だけで、**相手を選ぶのは推論**である | 🔴 **外れない** |
| — | **閾値で倒す先を分ける案**——「閾値が買えるのは頻度であって深刻さではない」 | 🔴 **外れない** |

⛔ **⟹ 理由4 と閾値の扱いは、この ADR では決めない。**
⚠ そして #369 は「**recall の1位が本当に『訂正された相手』である割合を、一度も測っていない。
低ければこの案の形が変わる**」と自分で書いている。
⟹ ⭐ **測る前に #369 を実装しない。**

---

## これが覆るとしたら

- **戻す粒度が「群」では足りない実例が出たとき。**1回の `consolidate` の統合元のうち
  1件だけを戻したい要求が実際に来たら、`recall()` から id を得る経路（`superseded` を
  明示的に含める問い合わせ）ごと設計し直すことになる。
- **理由4（相手を選ぶのは推論）が、復旧口が在っても許容できないと判断されたとき。**
  そのときも**この ADR は覆らない**——復旧口には (α) と独立した根拠（上の「根拠1」）が在るためである。
  覆るのは #369 のほうである。
- **`unsuperseded` イベントだけでは、誤った復旧を辿り直せないと分かったとき。**

## 測ったこと —— **#464 自身が「着地前に誰かが確かめる必要がある」と名指しした項目**

**【実測】2026-09-17。**PR #464 の本文は逐語で「**まっさらな `initdb` からの 0001〜0018 通し適用は
確認していない。0018 は既に 0001〜0017 が当たっている DB へ適用した**」と書き、
これを着地前に確かめる必要がある項目として挙げていた。⟹ **着地の前に測った。**

⚠ **走らせたのは、このセッションが立てた作業者である**（このマネージャー自身の手ではない）。
⛔ **「別の担い手からの伝聞」ではない**——このセッションが依頼し、結果を直接受け取った。

| 測ったこと | 結果 |
|---|---|
| まっさらな `initdb`（自分専用インスタンス、既定ポートを使わない）に 0001〜0018 を通しで適用 | ⭕ **18本すべて適用。エラー無し** |
| migration の本数 | **18本**（0019 以降は存在しない） |
| 0018 が効いていること | ⭕ `memory_events_kind_check` の定義に `unsuperseded` が入っていることを `pg_get_constraintdef` で確認。さらに `kind=unsuperseded` の INSERT が通り、存在しない `kind` の INSERT が同じ制約で拒まれることまで確認 |
| migration 台帳 `_mnemora_migrations` | 0001〜0018 の **18行**が過不足なく記録されている |
| `pnpm --filter @mnemora/postgres run test:db` | ⭕ **53ファイル / 580テスト すべて成功**（153.65s） |

⟹ ⭐ **0018 は「0017 まで当たった DB への追加適用」だけでなく、まっさらな DB からの通し適用でも通る。**

## 確かめていないこと

- ⛔ **オーナーの承認キューを直接見ていない。**逐語と `ask_human` の識別子は、
  **上位の担い手から受け取った**ものである【受】。⟹ **この ADR は、その一次資料ではない。**
- ⛔ **`reextract` 経由で supersede された群からの復旧は、テストを書いていない**【受】。
  `restoreSupersededBy` は `superseded_by_id`/`status` の列だけを見て経路を区別しないため
  `consolidate` 経由が通っていれば担保は薄いと判断した——**判断であって、実測ではない。**
- ⛔ **`RestoreSupersededOutcome` の `kind: "failed"` は、現在のコードパスからは生成されない**
  防御的な分類である【受】。
- ⛔ **この ADR の書き手（マネージャー）自身は、`packages/` のテストを1本も走らせていない。**
  上の「測ったこと」は、このセッションが立てた作業者が走らせた結果である。
  ⟹ **最終的な判定は CI に置く**（`docs/autonomy.md` §2.1 の5番——手元の緑は CI の緑の代わりにならない）。

## 追記（2026-09-26）: 「設計で選んだこと」5 の「行14 が `decay_floor_at` を動かさない」は、ADR 0153 以降の実装と食い違う

クローン miku の委譲先が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

**上の本文（「設計で選んだこと」5 の末尾、「⟹ 行14 が `decay_floor_at` を動かさないのに対し、行15 は動かす。」）は書き換えていない。**
当時の記録として残す。

- 本文のこの文は、`docs/memory-model.md` §11 行14（`restoreArchived`）が「`decay_floor_at` は動かさない」と書いていたことを前提にしていた。
- [ADR 0153](./0153-recall-decay-floor-gate.md) 以降、`Runtime.restoreArchived` は `archived → active` の直後に `reinforce` を呼び、`decay_floor_at` を先へ動かしている（`packages/core/src/runtime.ts` の `restoreArchived` の doc コメントにある 2026-09 訂正）。⟹ **この文の前半は、今日の実装と食い違う。**行14・行15はどちらも `decay_floor_at` を動かす。
- **【実測】2026-09-26。**`decayFloorAt` が過去の `archived` な Memory に `restoreArchived` を呼ぶと、戻った Memory の `decayFloorAt` が呼び出し時刻より先へ動いたことを、Fake と Postgres（Postgres 17 + pgvector）の両方で確かめた。走らせたのは、このセッションが立てた作業者である。
- 同じ前提に立っていた `docs/memory-model.md` §11 行14・行15の記述は、同じ 2026-09-26 に PR #872 で訂正した。
- 本文の直前の段落が挙げる違い（`archived` は掃引の選定条件上、床が必ず過去である。`superseded` の床は過去とは限らない）は、この訂正の後も成り立つ。

## 追記（2026-09-26、[Issue #515](https://github.com/takecchi/mnemora/issues/515) クローズ）: 群の範囲を今の契約として確定する

クローン miku の委譲先が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**上の本文・訂正1〜4は書き換えていない。**当時の記録として残す。
コード（`packages/*/src`）の挙動は変えていない——この追記は記録だけである。

訂正1・訂正4がそれぞれ確かめたとおり、本文「設計で選んだこと 1」の根拠にある
「`superseded_by_id` が作る群は、1回の `consolidate`/`reextract`/`resolveContested`
が作った単位と**ちょうど一致する**」は、`resolveContested`（訂正1）と `reextract`
（訂正4）については偽である。**クローン miku の判断（2026-09-26）**: この非一致を
直す（実装を変える）のではなく、**「群は同じ `superseded_by_id` を指す
`superseded` の行すべてであり、1回の操作の単位とは限らない」を今の契約として
確定する**——訂正1・訂正4が記録した事実を、以後も変えない仕様として扱う。

**理由**:

1. **出荷済みの公開 API の意味を変えることになる。** `Runtime.restoreSuperseded`
   は `v1.0.0` で出る公開 API であり、群の範囲を狭める（`resolveContested`/
   `reextract` の由来を機械的に切り分けて別々の群として扱う）ことは、
   既存の呼び出しが受け取る `outcomes` の集合を変える——[ADR 0237](./0237-restore-superseded-dry-run-preview.md)・
   [ADR 0258](./0258-restore-superseded-operation-scope.md) が繰り返し採ってきた
   「契約を狭めない」という基準と同じである。
2. **呼び出し側は、すでに確かめて絞る手段を持っている。** [ADR 0237](./0237-restore-superseded-dry-run-preview.md)
   の `dryRun: true`（群の中身と `supersededReason` を書き込み無しで確認できる）
   と、[ADR 0258](./0258-restore-superseded-operation-scope.md) の
   `onlyMemoryIds`（確認した上で絞って戻せる）が、既にこの2つを満たしている。
   群の広さそのものより「広いかどうかを呼び出し側が確かめられないこと」が
   危険の本体である、という [issue の判定コメント](https://github.com/takecchi/mnemora/issues/515#issuecomment-5716794941)
   の診断は、`dryRun`/`onlyMemoryIds` が着地した今日も変わらない。

**採らなかった案**:

1. **方向2（`memory_events` に操作 id を新設し、群をもっと細かい鍵で絞る）。**
   却下——[ADR 0258](./0258-restore-superseded-operation-scope.md) が立てた
   決定的な理由が今日も成り立つ: 鍵を新設しても、**過去に積み上がった
   `memory_events` の行は1件もバックフィルできない**（操作の境界は発生時に
   しか記録されておらず、後から再構成できない）。新しい鍵を持つのは、
   この変更より後に書かれる行だけである。加えて、鍵を使って群を細かく
   分割する形は利用者から見える契約が変わる選択であり、`docs/roadmap.md` §5 級に
   当たる。
2. **方向4（`resolveContested` 由来だけ別扱いにする）。** 却下——[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
   決定8「新しい種類・新しいフィールド・新しい `kind` を足す理由は『違うものだから』
   ではなく『その区別を受け取った側が、実行時に違う手を打てるか』である」に
   照らすと、`dryRun`/`onlyMemoryIds` があれば呼び出し側は由来を厳密に知らなくても
   正しく手を打てるため、区別を API の意味に持ち込む必要が無い。持ち込むと
   3経路の区別が公開契約に漏れ、経路が増えたときに契約が壊れる。
3. **[ADR 0258](./0258-restore-superseded-operation-scope.md) の R2
   （`reextract` のアンカー選定を、候補列の先頭ではなく `created === true` の
   候補優先に変える）。** 却下——[Issue #515 の 2026-09-24 のコメント](https://github.com/takecchi/mnemora/issues/515#issuecomment-5812778138)
   が `@mnemora/core` の in-memory fixture で実測したとおり、R2 は部分重複の
   ケースではアンカーを分けられるが、**出荷済みの `reextract` が返す
   `supersededById` を全呼び出しで変えてしまう**うえ、**「今回作られる候補が
   0件」の縮退ケースでは分かれない**（どちらの候補優先ルールでも同じ既存の
   Memory へ位置0として戻る）。バグ修正の副作用ではなく仕組みそのものの変更で
   あり、しかも縮退ケースは残るため、これだけでは本 issue の挙動を閉じられない。

反映先: `packages/core/src/runtime.ts` の `Runtime.restoreSuperseded`・
`RestoreSupersededTarget` の doc コメント、`docs/memory-model.md` §11 行15。
