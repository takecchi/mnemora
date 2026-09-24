# ADR 0288: `AnnUnreachedOmission` に `severity?: AnnUnreachedSeverity` を追加のみで足す（Issue #361、ADR 0193 §7-1 の再検討）

- **状態**: 採用 (2026-09-24)
- **日付**: 2026-09-24

> **⚠ この ADR は、自動化された担い手（マネージャーのセッションからさらに切り出された
> worker セッション）が書いた。**投稿者名・コミット署名が `takecchi` になっていても、
> それはオーナー本人を意味しない
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR に書かれた設計判断は、この担い手が Issue 本文・repo の規約・下記の
> 承認を読んで下したものであり、オーナー本人がこの文面を承認したものではない。**

**⚠ 各主張の出所を分ける**（ADR 0271/0282/0286 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【実測】** — 実際に `vitest`/`tsc`/`node` を走らせて確かめた。
- **【推論】** — 読解・設計判断から導いたが、実測ではない。
- **【受】** — 報告として受け取り、この担い手が再導出していない（出所を明記する）。

断りの無い【現物】【実測】は `origin/main` = `63fbbce`（本作業の分岐点）の木で、2026-09-24 に行った。

---

## 出自 —— この判断は誰のものか

**この選択は、[ADR 0193](./0193-ann-unreached-covers-full-window.md) §7 案2
（`eligible > kPrime` のときだけ `ann_unreached` を別の重み・別のフィールドで表す案）が
明示的に「この PR の範囲では却下——どう表すべきかの設計判断はオーナー判断を要する」
として**オーナー判断に予約していたもの**である。同 ADR「これが覆るとしたら」1(a) も
名指しで「オーナーが『常時鳴る札は情報量が乏しい』という批判を優先すると判断したとき、
案の候補は（a）`ann_unreached` に severity/certainty を足して呼び手が濾せるようにする」
と書いている——**この ADR は、その (a) を実装するものである。**

**【受】** オーナー（takecchi）が 2026-09-24T07:02Z に、承認キュー経由（この repo の外）で
「あなたの推奨案で良いのであなたが決められるものはあなたの判断で進めちゃってください」
と述べた。これを受けたオーナーのクローン（価値観の写し）が、推奨案——**「札に severity
を足し、呼び手が濾せるようにする。既定の kPrime/ef_search は上げない。札を要約から
間引かない」**——に決めた。この担い手（マネージャーからさらに切り出された worker
セッション）は、その決定を実装する立場でこの ADR を書いている。

**この経緯は、この担い手が独立に検証できるものではない**（承認キューは repo の外にあり、
`gh` 等では見えない）。⟹ **【受】であることを明記し、この ADR の「決めた主体」の欄は
オーナー本人ではなく、上記の経緯（オーナー本人 → クローン → 担い手）で構成されている
ことを正直に書く。** repo 上の投稿者欄が `takecchi` になっても、それがオーナー本人か
クローンか担い手かは区別できない（ADR 0220）。

---

## ADR 0193 §7-1（`certainty` 拒否）に正面から答える

**ADR 0193 §7-1 は、`ann_unreached` に `certainty`（窓の満杯/未満を区別する欄）を足す案を
却下している**——逐語:

> `ann_unreached` の主張（scope にまだ見られていない候補が残っている）は窓の満杯/未満に
> よって変わらない。区別を増やすと、呼び手の次の一手（厳密検索へのフォールバック、
> subject を絞り直す）も変わらないのに union だけが太る。ADR 0173 / ADR 0188 が採った
> 「次の一手が変わらない区別は増やさない」という基準に合わせた。

**この ADR が足す `severity` の中身は、実質この却下された区別に近い**——`"warning"` は
「ANN 窓が到達可能な下限に届かなかった」、`"info"` は「窓は満杯」であり、窓の満杯/未満を
下敷きにしている（ただし ADR 0285 追記の忘却ゲート補正込みの下限であり、§7-1 が想定した
単純な `annHits.length < kPrime` とは式が違う——下記「決めたこと」参照）。

**それでも覆す根拠は3つある。**

1. **却下したのは担い手であって、オーナーではない。** ADR 0193 §7 の却下は同 ADR の
   担い手が「この PR の範囲では」下した判断であり、ADR 0193 自身が§7 案2で「オーナー判断を
   要する」、「これが覆るとしたら」1(a) で「オーナーが優先すると判断したとき」の道筋を
   名指ししている。**§7-1 の却下自体は、後から来る `severity` 提案の可否を拘束する
   ものではない**——§7-1 が却下したのは「この PR（ADR 0193）の範囲でこの担い手が
   実装するかどうか」であり、「future work としてオーナーが選び得るか」ではない。
2. **上の「出自」節のとおり、オーナー本人がこの選択を承認している**（【受】、
   承認キュー経由）。ADR 0193 が「オーナー判断に委ねる」と書いた道を、実際にオーナーが
   選んだ、という関係である。
3. **[Issue #361](https://github.com/takecchi/mnemora/issues/361) の実測が、
   「次の一手が変わらない」という §7-1 の前提そのものを崩している。** 下の「本 ADR の
   引き金になった実測」参照——**「常時鳴る」ことで呼び手が信号として扱えなくなり、
   結果として「無視する」という一手に収束してしまう**なら、「次の一手が変わらない」
   のではなく「次の一手が失われる」。これは §7-1 が想定していなかった帰結である。

**⟹ この ADR は ADR 0193 §7-1 の判断を「間違いだった」として書き換えるのではなく、
その判断の射程外（オーナー判断待ちの領域）にあった選択を、実際にオーナー判断が
下りたので実装する、という位置づけである。**

---

## 本 ADR の引き金になった実測 —— issuecomment-5807237678

**【受・引用】** Issue #361 の 2026-09-16 の追記コメント群（クラスタ 200×50・1万行・
256次元、`hnsw.ef_search` 既定40、`kPrime`=40 の合成コーパスでの実測）と、続報コメント
[issuecomment-5807237678](https://github.com/takecchi/mnemora/issues/361#issuecomment-5807237678)
（2026-09-24、`f08a2e7`/`754cc61` の A/B 再測定）が、この ADR の判断材料である。
この担い手はこれらのコメント本文を `gh api` で取得して読んだが、**元になった実測環境
（使い捨て PostgreSQL クラスタ・合成コーパス生成スクリプト）を自分の手で再実行してはいない**
——以下は【受】としての引用である。

要点（コーパス1、σ=0.01、seed 固定・1テナント・1万行）:

- **12 probe 中12回、`ann_unreached` が発火した。** `eligible`（約1万件）が `kPrime`（40）を
  常に超えるため、ADR 0193 §8-1 が予告したとおり「構造上いつも鳴る札」になっている。
- **12 probe 中4回（probe 3, 9, 10, 11）で、実際に自己一致点（距離0の正解）が
  `search()`/`recall()` の窓から取りこぼされた。** 残り8回は正しく返った。
- **この4/12と8/12を、`ann_unreached` は一切区別しなかった。** `annReturnedFewerThanReachable`
  （ADR 0285 追記の stage detail キー）も一度も現れなかった——**窓は常に満杯
  （`hits=40=kPrime`）のままだったため**（ADR 0284 の `iterative_scan=relaxed_order`
  は別の障害モード（他テナント near-duplicate による全滅）を改善したが、この4 probe には
  無力だった）。

**⟹ 「常時鳴る」という状態は、単に「情報量が乏しい」だけでなく、実際に呼び手が
`omitted` を見て「今回は疑いが強いのか、いつも付いているだけなのか」を区別できない
という具体的な実害を伴う——これが ADR 0193 §7-1「次の一手が変わらない」という前提を
崩す実測である。**

**この ADR が足す `severity` は、上記4/12を `"warning"` として識別できない**——
下の「射程」節で正直に書く。

---

## 決めたこと

### 1. `AnnUnreachedOmission` に `severity?: AnnUnreachedSeverity` を**任意フィールドとして**足す

```ts
export type AnnUnreachedSeverity = "info" | "warning";

export interface AnnUnreachedOmission {
  kind: "ann_unreached";
  countKind: "unknown";
  severity?: AnnUnreachedSeverity; // 新設
}
```

`AnnUnreachedOmissionSchema`（zod）にも `severity: AnnUnreachedSeveritySchema.optional()`
として同じ形で足す。**既存の欄（`kind`/`countKind`）の型・名前・必須性は1バイトも
変えていない。**

### 2. 値は `runtime.recall()` が常に埋める。式は ADR 0285 追記の `annReturnedFewerThanReachable`
と**同じ式を1箇所から引く**

`packages/core/src/recall-runtime.ts` の `ann_unreached` 判定（`annHits.length < eligible`）
の直前に、ADR 0285 追記が定義した `lowerBoundUsable`/`reachableLowerBound` の計算を
引き上げ、真偽値 `annWindowUnderfilled` を1箇所で確定させる:

```ts
const lowerBoundUsable =
  validatedQuery.excludeProvenanceKinds === undefined ||
  validatedQuery.excludeProvenanceKinds.length === 0;
const reachableLowerBound = Math.max(0, eligible - aggregate.filteredDecayed.count);
const annWindowUnderfilled =
  candidateGenerationExecuted &&
  kPrime > 0 &&
  lowerBoundUsable &&
  reachableLowerBound > 0 &&
  annHits.length < Math.min(kPrime, reachableLowerBound);
```

`ann_unreached` の push はこれを参照するだけになる:

```ts
omitted.push({
  kind: "ann_unreached",
  countKind: "unknown",
  severity: annWindowUnderfilled ? "warning" : "info",
});
```

ADR 0285 追記が `annStageTrace.detail.annReturnedFewerThanReachable` を書き込んでいた
箇所も、同じ `annWindowUnderfilled` を参照するように直した（`annStageTrace !== undefined`
という「detail を書き込める先が実在するか」の条件だけを重ねる）。

**⟹ 式は `recall-runtime.ts` に1箇所しか存在しない。** `severity` と
`annReturnedFewerThanReachable` が将来別々に手直しされて食い違う、という事故の芽を
最初から絶つ（ADR 0011 が「同じ意味の件数を複数経路から出すと食い違う」を避けたのと
同じ理由）。

**値の意味**:

- **`"warning"`**: 同じ recall で、ANN 窓が実際に到達可能な下限
  （`reachableLowerBound`、ADR 0285 追記の忘却ゲート補正込み）に届かなかった。
- **`"info"`**: それ以外——窓は満杯で、`eligible > kPrime` という構造だけで鳴っている
  （ADR 0193 §8-1 の「常時オン」状態そのもの）。

**🔴 私（担い手）の当初の読み——「warning は annReturnedFewerThanReachable が立つ条件と
同じ」——は、コードを読んだ結果そのとおりだった。** 依頼元から渡された読みと実装の
式に食い違いは無い。

### 3. 発火条件そのものは1バイトも変えない

`ann_unreached` が**鳴るか鳴らないか**の条件（`candidateGenerationExecuted && kPrime > 0 &&
annHits.length < eligible`）は変更していない。`severity` はその内側で追加の情報を
足すだけであり、ADR 0193 が決めた「窓の満杯/未満を問わず判定する」という発火条件自体には
一切手を入れていない。

### 4. 既定の `kPrime`（`DEFAULT_OVER_FETCH_FACTOR`）・`hnsw.ef_search` は変えない

ADR 0193 §7-4・オーナー承認の推奨案（「既定の kPrime/ef_search は上げない」）のとおり。
本番の探索パラメータの見直しは、この ADR の範囲外——ADR 0111 の測定を伴う別の判断。

### 5. `omitted`/`recall-footprint`/`examples/chat` からこの札を間引かない

オーナー承認の推奨案（「札を要約から間引かない」）のとおり。`recall-footprint.ts` は
`ann_unreached` を元々参照していない（ADR 0193 §8-4 の実測どおり不変）。`examples/chat`
の `formatOmittedSummary`（`compare.ts`）は `case "ann_unreached": return "ann_unreached";`
のまま変更していない——`severity` を表示に含めるかどうかは呼び手側の判断に委ね、
この ADR は「間引かない」という最低限の約束だけを守る。

---

## 任意（`?`）にする理由 —— 非破壊であることの根拠

`docs/migration-v1.md` の既存項目のうち、項目9（`FilteredOmission.scopeRelation`）・
項目10（`Omission.over_limit.stage`）はどちらも「返り値型への**必須**フィールドの追加」を
破壊的変更に数えている。[ADR 0178](./0178-public-api-surface-gate.md)「引き受けた負債」1も
「新しい任意プロパティの追加……は semver 的に安全（＝非破壊）」と明記している。
v1.0.0 は 2026-09-22T23:54:08Z に published 済み（README.md「版の付け方」）なので、
この ADR は破壊的変更を出さない。

**先例は [ADR 0282](./0282-score-breakdown-affinity-measured.md)**
（`ScoreBreakdown.affinityMeasured?: boolean`）——**型は任意だが runtime は必ず値を入れる**
という同じ形にこの ADR も揃えた。

### 【実測】API スナップショットの差分（`pnpm api:write` 後、追加のみ）

```diff
 export interface AnnUnreachedOmission {
     kind: "ann_unreached";
     countKind: "unknown";
+    severity?: AnnUnreachedSeverity;
 }
+export type AnnUnreachedSeverity = "info" | "warning";
```

（`OmissionSchema`/`RecallResultSchema` 内の zod 型表現にも同じ形の追加のみが現れる。
`git diff --stat scripts/__snapshots__/public-api/` は `core.d.ts | 14 ++++++++++++++`
——**追加14行、削除0行**。他5パッケージの snapshot は差分なし。）

**⟹ 既存の行は1行も変わっていない。** これは「複製した写しの数え直し」ではなく、
`pnpm api:check`（ADR 0178 の門）自身が対象の .d.ts から出した実測である。

---

## 変異試験

`docs/autonomy.md`「⛔ 変異を戻すのに `git checkout` を使わない」に従い、各変異は `cp` で
退避してから変異を入れ、`pnpm --filter @mnemora/core exec vitest run
src/__tests__/recall-pipeline.test.ts`（および該当時は `recall.test.ts`）を走らせ、
`cp` で復元した。復元後は `diff` で該当ファイルの差分が無いことを都度確認した。

| # | 変異 | 結果 |
|---|---|---|
| (a) | `severity` を常に `"info"` に固定 | 🔴 赤: 3本（歯A「warning」・歯F「warning」・陽性1「warning」） |
| (b) | `severity` を常に `"warning"` に固定 | 🔴 赤: 2本（歯C「info」・歯E「info」） |
| (c) | 条件を反転（`annWindowUnderfilled ? "info" : "warning"`） | 🔴 赤: 5本（歯A・歯C・歯E・歯F・陽性1すべて） |
| (d) | やりすぎた実装: `severity === "info"` のとき `ann_unreached` 自体を push しない（間引き） | 🔴 赤: 2本（歯C・歯E——「info でも鳴ること」自体を検査する歯） |
| (e) | やりすぎた実装: `severity` を必須フィールドにする（型・zod 両方） | 🔴 赤: vitest 1本（`accepts 'ann_unreached' without severity（後方互換）`）。**`tsc` は緑のまま**（runtime が常に値を入れるため）。`pnpm api:check` は **✗ 差分あり**として検出し、「破壊的変更かどうかを人が判断すること」という ADR 0178 の手順を要求した——機械は検出止まりで確定しない、という repo の規律どおりに動いた |
| (f) | severity を入れ忘れる（push から丸ごと外す） | 🔴 赤: 5本（歯A・歯C・歯E・歯F・陽性1すべて。`toContainEqual` が `severity` の不在を検出） |

**緑のまま残った変異は無かった。** 全6変異とも、少なくとも1本の既存/新設の歯が捕まえた。

---

## 測ったこと

### 赤（実装前・抜粋、`pnpm --filter @mnemora/core exec vitest run
src/__tests__/recall-pipeline.test.ts src/__tests__/recall.test.ts`）

```
FAIL  src/__tests__/recall-pipeline.test.ts > ... 歯A ...
FAIL  src/__tests__/recall-pipeline.test.ts > ... 歯C ...
FAIL  src/__tests__/recall-pipeline.test.ts > ... 歯E（severity: 'info'）...
FAIL  src/__tests__/recall-pipeline.test.ts > ... 歯F（severity: 'warning'）...
FAIL  src/__tests__/recall-pipeline.test.ts > ... 陽性1 ...
FAIL  src/__tests__/recall.test.ts > ... rejects 'ann_unreached' の severity が未知の値
 Test Files  2 failed (2)
      Tests  6 failed | 147 passed (153)
```

### 緑（実装後）

```
pnpm --filter @mnemora/core exec vitest run \
  src/__tests__/recall-pipeline.test.ts src/__tests__/recall.test.ts \
  src/__tests__/omission-kind-generation.test.ts src/__tests__/schema-type-equals-parity.test.ts
 Test Files  4 passed (4)
      Tests  174 passed (174)
```

`pnpm --filter @mnemora/core run typecheck`・`pnpm run typecheck`（全7パッケージ）・
`pnpm run build`・`pnpm api:check` はいずれも緑（差分なし）。

---

## 射程 —— 確かめていないこと／引き受けた負債

1. 🔴 **窓の中の取りこぼしは、この変更後もすべて `"info"` になり、どの診断も名乗れない。**
   issuecomment-5807237678 のコーパス1（1テナント・σ=0.01・1万行）で実際に自己一致点を
   取りこぼした4/12（probe 3, 9, 10, 11）は、窓が常に満杯（`hits=40=kPrime`）だったため
   `annWindowUnderfilled` が常に偽——`severity` は**残り8/12と同じ `"info"`**になる。
   **⟹ この ADR は、この4/12を識別する診断を何も追加していない。** `severity` が
   区別できるのは「窓が埋まらなかった（`annReturnedFewerThanReachable` の対象）」場合
   だけであり、「窓は埋まったが中身が真の近傍からズレている」場合（`ann-truncation.ts`
   の doc コメントが名指しする事象）は、この ADR の変更の外に居続ける。
   **これは確かめていないことではなく、実測で確認済みの既知の限界である。**
2. **`severity` の値そのものを本物の Postgres + pgvector に対して実測していない。**
   この ADR の担い手は `packages/core` の歯（`FakeVectorStore`/`CappedVectorStore`）
   だけで検証しており、issuecomment-5807237678 の実測環境（使い捨て PostgreSQL
   クラスタ）を自分の手で再実行していない。「`"warning"` が本物の HNSW でも同じ頻度で
   現実的に発火するか」は未検証。
3. **`"info"` を「損が無い」の保証として読まれるリスク**は、`AnnUnreachedSeverity` の
   doc コメントに明記したが、**呼び出し側のコード・ドキュメントを横断して「`"info"` は
   無視してよい」という誤読が広まらないかは検査していない。**
4. **`examples/chat`/`compare.ts` の出力に `severity` を実際に反映するかどうかは、
   この ADR では決めていない**（オーナー承認の推奨案は「間引かない」までで、
   「表示に severity を使うか」までは指示していない）。`formatOmittedSummary` は
   1バイトも変えていない——`severity` を読みたい呼び手は `Omission` を直接見ることになる。
5. **ADR 0193 §5.3 の「見た目の矛盾」**（`ann_truncated` が不在でも `ann_unreached` が
   単独で立つ組み合わせ）に対して、この ADR は何もしていない。`severity` は
   `ann_truncated` との関係を一切変えない。

---

## ADR 0193 への追記

[ADR 0193](./0193-ann-unreached-covers-full-window.md) 本文は書き換えない
（`docs/decisions/README.md`「⛔ 採用済み ADR の本文は書き換えない」）。同 ADR の末尾に、
本 ADR を指す追記を積む。

---

## 参照

- [Issue #361](https://github.com/takecchi/mnemora/issues/361)
- [ADR 0193](./0193-ann-unreached-covers-full-window.md) §7-1・§7-2・§8-1・
  「これが覆るとしたら」1(a)
- [ADR 0285](./0285-ann-window-empty-of-in-scope-candidates-stage-detail.md)
  （`annReturnedFewerThanReachable`/`reachableLowerBound` の定義元）
- [ADR 0282](./0282-score-breakdown-affinity-measured.md)（「任意で足し、runtime は常に
  値を入れる」の先例）
- [ADR 0178](./0178-public-api-surface-gate.md)（公開 API 表面の門）
- [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)
- `docs/migration-v1.md` 項目9・10
