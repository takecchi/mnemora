# ADR 0242: `Runtime.applyCorrection` — 北極星 項目5を「出荷される面」から駆動できるようにする（Issue #369）

- **状態**: 採用 (2026-09-18。[ADR 0283](./0283-adopt-merged-adrs-whose-decision-is-on-main.md) で担い手が「草案」から倒した——オーナー本人の判定ではない)
- **日付**: 2026-09-18
- **採番**: 元は `0241` として書いたが、`origin/main` に PR #535（ADR 0241「`docs/migration-v1.md` は ADR ではなく生きた文書である」）が先に着地したため、`0242` へ付け替えた（`scripts/adr-renumber.mjs`、ADR 0179）。

**⚠ 各主張の出所を分ける**（ADR 0232/0235/0238 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git`/`node`/`vitest`/`psql` 等を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。
- **【オーナー】** — オーナー（クローン）が事前に下した確定済みの方針。この ADR はそれを実装するものであり、方針自体を再検討しない。

---

## 問い

`docs/north-star.md`「目指す姿」項目5「間違いを正すと、古いほうが先に出てこなくなる」は、
**出荷される面**（`packages/core` の公開 API）からは今日まで一度も駆動できなかった。

【現物】公開 API には「発見」（`Runtime.findCorrectionCandidates`、ADR 0232）と「書き込み」
（`Runtime.markContested`/`resolveContested`、ADR 0134/ADR 0150）が在るが、**その間の
「選択」の段**（候補一覧から相手を指名し、指名が候補に居るかを照合し、居れば書き込みへ進む、
という3態の状態機械——`awaiting_choice`/`choice_not_in_candidates`/`resolved`）は
`examples/chat/src/correction-demo.ts`（`runCorrectionDemo`、L280前後の分岐と
`buildCorrectionReason`、ADR 0235/ADR 0238）に**しか**無かった。

【現物】`examples/chat` は `package.json` の `"private": true` により npm に出荷されない
（`docs/architecture.md`/`AGENTS.md` の package 一覧）。⟹ **項目5 は「出荷される面」からは
一度も駆動できなかった**——[Issue #284](https://github.com/takecchi/mnemora/issues/284) が
導入した規律（本番コードから呼ぶ経路が無ければ「在る」と数えない）を、`packages/core` という
出荷物自身に対して当てると、今日まで立っていなかった。

---

## 決定

### 決定1: 水準は「明示訂正の駆動まで」。自動検出（主張キー）は採らない【オーナー】

**この判断は確定済みであり、この ADR で再検討しない。** 採らなかった理由は「採らなかった案」
節に記録する（`(B)` 主張キー）。

### 決定2: 形は「`Runtime` のインタフェースにメソッドを足す」。独立関数にしない【オーナー】

**この判断も確定済み。** 採らなかった理由は「採らなかった案」節に記録する。

### 決定3: `Runtime.applyCorrection(ctx, input)` を新設する

```ts
export interface ApplyCorrectionInput {
  discovery: FindCorrectionCandidatesResult;
  correctedId?: MemoryId;
  correctingId: MemoryId;
  resolution?: ContestedResolution;
  reason?: string;
  actor?: EventActor;
}

export type ApplyCorrectionResult =
  | { kind: "awaiting_choice" }
  | { kind: "not_a_candidate"; correctedId: MemoryId }
  | {
      kind: "contested";
      correctedId: MemoryId;
      correctingId: MemoryId;
      chosenRecallRank: number;
      markResult: MarkContestedResult;
    }
  | {
      kind: "resolved";
      correctedId: MemoryId;
      correctingId: MemoryId;
      chosenRecallRank: number;
      markResult: MarkContestedResult;
      resolveResult: ResolveContestedResult;
    };

applyCorrection(ctx: Ctx, input: ApplyCorrectionInput): Promise<ApplyCorrectionResult>;
```

**手順（`packages/core/src/runtime.ts` の実装。全体を以下に写す——他に判定は無い）**:

1. `input.correctedId` が `undefined` なら、何も呼ばずに `{ kind: "awaiting_choice" }`。
2. `input.discovery.candidates` から `memoryId === input.correctedId` を探す。見つからなければ
   何も呼ばずに `{ kind: "not_a_candidate", correctedId }`。
3. 見つかれば `markContested(ctx, correctedId, input.correctingId, { actor, reason })` を呼ぶ。
4. `input.resolution` が `undefined` ならここで止まり `{ kind: "contested", ..., markResult }`。
   `resolveContested` は一度も呼ばない。
5. `input.resolution` があれば続けて
   `resolveContested(ctx, correctedId, input.correctingId, input.resolution, { actor, reason })`
   を呼び、`{ kind: "resolved", ..., markResult, resolveResult }`。

⛔ **相手を選ばない**: `discovery.candidates[0]` は一切参照しない。手順2は「指名が候補に
居るかどうかの照合」だけであり、居なければ書き込みは一切試みない——ADR 0134 決定2・
ADR 0232 の核心（機械は選ばない）をそのまま引き継ぐ。

⛔ **失敗を握り潰さない**: `markResult`/`resolveResult` は `markContested`/`resolveContested`
自身の `MarkContestedResult`/`ResolveContestedResult`（`ineligible`/`conflict`/`not_attempted`
を含む）をそのまま運ぶ。`kind: "resolved"` は「`resolveContested` まで呼んだ」ことだけを
意味し、成否は `resolveResult.outcome.kind` を見て判断する。

⛔ **監査理由を自動生成しない**: `input.reason` は呼び出し側が
`buildCorrectionReason()`（後述）で組んだ文字列、または任意の自由文をそのまま
`markContested`/`resolveContested` の両方へ渡すだけである——`applyCorrection` 自身が
`discovery`/`resolution` から「なぜ選んだか」を推測して書き込むと、この口が実質的に
「相手を選ぶ」判断を持つことに近づく。

⚠ **`tick()`/`observe()` からは一度も呼ばれない**（`markContested`/`resolveContested` と
同じ立場）。`packages/core/src/__tests__/apply-correction.test.ts` の
「tick()/observe() から呼ばれない」歯がこれを検査する。

⭐ **`markContested` だけを呼んだ後（`resolution` を渡さない呼び出し）、別の
`applyCorrection` 呼び出しで改めて `resolution` を渡す、という2段の使い方ができる。**
`applyCorrection` は呼び出しの間で状態を持たない——2回目の呼び出しでも手順3で
`markContested` は呼ばれるが、対象は既に `status: 'contested'` なので `MarkContestedResult`
は書き込み無しで `ineligible` を返すだけであり、続く `resolveContested` は正常に解決へ進む。
`examples/chat/src/correction-demo.ts` の `runCorrectionDemo` がこの2段呼び出しを使い、
`markContested` 相当の直後に `recall()` で対（mandatory companion）を見せてから解決へ進む、
という Issue #303 由来の実演を保っている（下の「設計で選んだこと」参照）。

### 決定4: `buildCorrectionReason` も `packages/core` の公開 export として持ち上げる

ADR 0238 が定めた監査理由の組み立て（`examples/chat/src/correction-demo.ts` の非公開関数
だった）を、`packages/core/src/apply-correction.ts` の公開関数にする:

```ts
export interface CorrectionReasonInput {
  discovery: FindCorrectionCandidatesResult;
  chosenRecallRank: number;
  correctedId: MemoryId;
  correctingId: MemoryId;
  resolution: ContestedResolution | null;
}

export function buildCorrectionReason(input: CorrectionReasonInput): string;
```

**形式（`key=value / ...` の1行、4要素、`score.total` は載せない）は ADR 0238 の決定を
変えていない。** 変えたのは `winner` の語彙だけである:

| | ADR 0238（`correction-demo.ts` 限定） | ADR 0242（`packages/core`、汎用） |
|---|---|---|
| 語彙 | `original` / `correction` | `corrected` / `correcting` / `both_active` / `pending` |
| 出所 | `correction-scenario.ts` のシナリオ概念 | `ApplyCorrectionInput.correctedId`/`correctingId`/`resolution` |

**なぜ変えたか**: `Runtime` レベルには「どちらが元の発話か」という概念が無い——持っているのは
`correctedId`（訂正される側）/`correctingId`（訂正する側）だけである。`original`/`correction`
という語彙をそのまま持ち上げると、`packages/core` が `examples/chat` のシナリオ語彙に
汚染される。⟹ 汎用語彙に置き換えた:

- `resolution === null` → `"pending"`——`markContested` だけを呼ぶ時点ではまだ勝者が無い
  （ADR 0238 には無い第4の状態。2段呼び出しをこの ADR で新たに許したことに対応する）。
- `resolution.kind === "both_active"` → `"both_active"`。
- `resolution.kind === "supersede"` かつ `winnerId === correctingId` → `"correcting"`。
- それ以外（`winnerId === correctedId`）→ `"corrected"`。

---

## `examples/chat/src/correction-demo.ts` の書き換え

**「選択」の段の実装（3態の状態機械・`buildCorrectionReason`）はもうこのファイルに無い。**
`runCorrectionDemo` は `Runtime.applyCorrection`/`buildCorrectionReason`（`@mnemora/core`）を
**呼ぶだけ**になった——実装を二重に持たない。

- `choice` が無ければ、今までどおり `applyCorrection` を一度も呼ばずに
  `outcome: "awaiting_choice"` で止まる（デモ自身が `discovery.candidates.find(...)` で
  指名の有無・候補在否を先に確かめてから呼ぶ——理由は次段落）。
- 指名が候補に無ければ、同じく `applyCorrection` を呼ばずに `outcome: "choice_not_in_candidates"`
  で止まる。
- 指名が候補に在れば、`buildCorrectionReason` で reason を1回組み立て（このシナリオは
  `contestedPair.winnerExternalId` から勝者をあらかじめ知っているので、`resolution` を
  渡す前から完全な reason を組める）、`applyCorrection` を**2回**呼ぶ:
  1回目は `resolution` を渡さず（`markContested` 相当のみ、`recall()` で対を確認）、
  2回目は `resolution` を渡す（`resolveContested` 相当まで進める）。**両方に同じ reason を
  渡す**（ADR 0238 決定2）。

**なぜデモが `applyCorrection` の前に自前で候補メンバーシップを確認するか**: `reason` の
組み立てに `chosenRecallRank`（指名した候補の順位）が要る。`applyCorrection` 自身も
同じ照合を内部でもう一度行う（`not_a_candidate` の防御は呼び出し側の事前確認の有無に
関係なく成立する）——二重にはなるが、デモが `reason` を「両方の呼び出しに同じ値」として
先に固定したいという要求から来る、意図した重複である。

**なぜ2回呼ぶか**: `applyCorrection` を `resolution` 込みで1回だけ呼ぶと、
`markContested` 相当と `resolveContested` 相当が1回の呼び出しの中に隠れ、
「`markContested` した直後、両方が隣接して recall に出る（`mandatory_companion`）」という
Issue #197/ADR 0134 の実演を、デモの `recall()` 呼び出しで挟めなくなる。2段呼び出しに
することで、既存のデモの構成（`beforeMark`/`afterMark`/`afterResolve` の3回の `recall()`）を
1つも失わずに保てる。

---

## 歯が噛むことを示した【実測】

**`packages/core` の新規歯**: `packages/core/src/__tests__/apply-correction.test.ts`
（13 tests、全緑）。

| 検査 | 歯 |
|---|---|
| `correctedId` 省略 ⟹ 書き込み0件で `awaiting_choice` | `awaiting_choice（correctedId 省略）` |
| 候補一覧に居ない ⟹ 書き込み0件で `not_a_candidate`（空リストの場合・非空で decoy だけの場合の2通り） | `not_a_candidate（指名が候補一覧に居ない）` |
| `resolution` 省略 ⟹ `markContested` のみ、`resolveContested` は一度も呼ばれない（イベント2件、`contested_resolved` 無し） | `resolution を省くと contested で止まる` |
| ⭐ `markContested`/`resolveContested` の失敗を握り潰さない（`not_attempted`・`ineligible`） | `markContested/resolveContested の失敗を握り潰さない` |
| `tick()`/`observe()` から呼ばれない | `tick()/observe() から呼ばれない` |
| `buildCorrectionReason` の winner ラベル4通り（`pending`/`both_active`/`corrected`/`correcting`）・`score.total` を載せない | `buildCorrectionReason — winner ラベル` |
| ⭐ 発見→選択→`markContested`→`resolveContested` の一巡。**敗者は `recall()` から実際に落ちる**（北極星 項目5 の本体）。2回の呼び出しに同じ監査理由が4件のイベント全てに載る | `発見→選択→markContested→resolveContested の一巡` |

**変異試験【実測】**（`packages/core/src/__tests__/apply-correction.test.ts` 全13本に対して、
`cp` で退避・復元。⛔ `git checkout` は使っていない。各変異は最終形の13本すべてに対して
個別に実行し直した——途中で歯を1本追加したため、番号がずれないよう最後にやり直した）:

| 変異 | 結果（13本中） | 赤くなった歯 |
|---|---|---|
| `input.resolution === undefined` の分岐を無効化し、常に `resolveContested` まで進める（既定の `resolution` をでっち上げる） | **3 failed, 10 passed** | 「`resolution` を省くと contested で止まる」・一巡テスト・「失敗を握り潰さない」の `not_attempted` テスト |
| `candidate = input.discovery.candidates.find(...)` を `candidate = input.discovery.candidates[0]` に変える（機械が1位を採る退行） | **1 failed, 12 passed** | 「候補一覧が空でなくても、指名が候補一覧に居なければ候補外」（**当初の空リストのテストだけでは通ってしまった**——非空リストのテストを追加して初めて捕まえた。下記参照） |
| `applyCorrection` の返り値の `markResult`/`resolveResult` を、実際の呼び出し結果を無視して常に成功固定値に差し替える（失敗の握り潰し） | **2 failed, 11 passed** | 「失敗を握り潰さない」の `not_attempted` テスト・一巡テストの ineligible 検査 |
| `tick()` の冒頭に、対象外の `memory_events` を1件追加で書き込む処理を挿入 | **1 failed, 12 passed** | 「tick()/observe() から呼ばれない」 |

**いずれも `cp` で復元後、同じ13本が緑に戻ることを実測した**（`diff` で復元前のファイルと
一致することも確認済み）。

**⭐ 1回目の「候補[0]を採る」変異は、当初の `not_a_candidate` テスト（候補一覧が空）では
捕まらなかった**——`candidates[0]` が `undefined` になるケースでは、`find` も `[0]` も
同じ結果を返すため。**候補一覧が非空（decoy だけ）で指名が候補に無いケースを追加して
初めて赤くなった。** これは、この ADR 自身が「歯が実際に噛むことを示す」作業の中で
見つけた盲点であり、追加した歯（`🔴🔴 候補一覧が空でなくても...`）がそれを塞いでいる。

**`examples/chat` 側の歯**（`correction-demo.test.ts` 21 tests・`correction-demo.postgres.test.ts`
3 tests、全緑。後者は本物の Postgres 17 + pgvector に対して実行した——`AGENTS.md`「手元で
Postgres を立てる」の手順、専用ポート・専用データディレクトリ）:

- `correction-demo.ts` の `applyCorrection` 呼び出し2回のうち、**両方**が指名(chosenId)に
  対して行われ、候補1位の decoy には一度も渡らないことを実測する
  「🔴🔴 採用者の指名が候補1位ではないケース」の歯を、`correctedId` を
  `discovery.candidates[0]?.memoryId` に差し替える変異で赤くしたことを確認した
  （`cp` で復元後、緑に戻ることも確認した）。

---

## 🔴 公開 API スナップショットへの影響【実測】

`pnpm run api:check`（`pnpm run build` 後）の差分は **`@mnemora/core` の1パッケージのみ**
（他5パッケージは差分なし）。差分は次の4箇所、すべて**追加のみ**（既存のシグネチャは
1文字も変わっていない）:

1. 新規ファイル `apply-correction.d.ts` の export（`ApplyCorrectionInput`/
   `ApplyCorrectionResult`/`CorrectionReasonInput`/`buildCorrectionReason`）。
2. `index.d.ts` に `export * from "./apply-correction.js"` が1行追加。
3. `runtime.d.ts` の import に `ApplyCorrectionInput`/`ApplyCorrectionResult` が1行追加。
4. **`Runtime` interface に `applyCorrection` メソッドが1つ追加。**

**破壊性の申告（ADR 0156 が要求する「ADR に書くことを免除しない」への応答）**: 4番目
（`Runtime` interface へのメソッド追加）は、**`Runtime` を自前で実装している側には
破壊的変更である**——直前の `Runtime.restoreSuperseded`（ADR 0230）・
`Runtime.getRecall`（ADR 0161）・`Runtime.markContested`（ADR 0134）・
`Runtime.resolveContested`（ADR 0150）・`Runtime.findCorrectionCandidates`（ADR 0232）が
同じ形で足した破壊的変更と、性質は同一である。1〜3番目（新規 export・新規 import 行）は
型としては追加のみで、それ自体は既存コードを壊さない。

【オーナー】`docs/autonomy.md` §3 が引く、オーナーが 2026-09-15 にクローンへ直接回答した
逐語「**破壊的変更であっても構わず実装してください**」（[ADR 0156](./0156-delegate-5-grade-judgment-and-breaking-changes.md)）に基づき、この破壊的変更は実装してよい。

⛔ **`CHANGELOG.md`/`docs/migration-v1.md` の「破壊的変更の件数」の記述は、この ADR では
一切変更していない**——別の担い手がその集計を作業中であるため（マネージャーの指示）。
この ADR が申告した破壊性が、その集計にいつ・どう反映されるかはこの ADR の範囲外である。

`pnpm run api:write` で snapshot を更新した。

---

## 北極星の問いに当てた結果

### 問1: 毎回渡す量を減らす方向に働くか

**本 PR 単体では変わらない。** `applyCorrection` は `markContested`/`resolveContested` の
orchestration であり、それら自身の recall 側の挙動（mandatory companion・削減）は
ADR 0134/ADR 0150 の時点で決まっている。

### 問2: 無効にしても Memory Framework として成立するか

**成立する。** `applyCorrection` は明示的な呼び出しでしか動かない。`tick()`/`observe()`
からは一度も駆動されない（`apply-correction.test.ts` で実測済み）。呼ばなければ今日と
全く同じ挙動が続く。

### 問3: この記憶が選ばれた理由を、後から説明できるか

**できる。** `buildCorrectionReason` が組む文字列（`chosenRecallRank`/`candidates`/
`recallId`/`winner`）を `reason` として渡せば、`markContested`/`resolveContested` の
既存の仕組み（`opts.reason` → `meta.note`）でそのまま `memory_events` に残る——ADR 0238 が
`examples/chat` に閉じて実演した形を、`packages/core` の公開関数として誰でも使える形に
した。

### 問4: AI の推論と、ユーザーが言った事実を区別しているか

**影響なし。** `applyCorrection` は `provenance.kind` を一切参照・変更しない——
`markContested`/`resolveContested` 自身がそうであるのと同じ理由。

### 問5: LLM を呼ばずに済ませられないか

**済ませられる。** `applyCorrection`・`buildCorrectionReason` はどちらも1箇所も LLM を
呼ばない。

---

## 設計で選んだこと

### 1. `ApplyCorrectionResult` は discriminated union のまま、`markResult`/`resolveResult` を
   そのまま埋め込む（別の「無い」語彙へ変換しない）

`markContested`/`resolveContested` はそれぞれ既に ADR 0008 の「無い」の分類を適用済みの
結果型を持つ（`ineligible`/`conflict`/`not_attempted`）。`applyCorrection` がこれを
`{ success: boolean }` のような薄い形に潰すと、呼び出し側が失敗の種類を見分けられなく
なる。⟹ **そのまま運ぶ**——`applyCorrection` 自身が追加するのは「候補に居たか」
（`awaiting_choice`/`not_a_candidate`）と「resolveContested まで進んだか」
（`contested`/`resolved`）という、それ自身が持つ2値の情報だけである。

### 2. `correctedId`/`correctingId` という名前（`firstId`/`secondId` ではない）

`markContested`/`resolveContested` は対称な操作なので `firstId`/`secondId` という
位置に意味を持たせない名前を使う（ADR 0134 決定2）。だが `applyCorrection` は
「採用側が指名した、訂正される側」と「訂正する側（新しい発話）」という**非対称な**
役割を持つ——この非対称性を型で表現するため、意味を持つ名前にした。
`markContested(ctx, correctedId, correctingId, ...)` という引数順で呼ぶため、内部的には
`correctedId` が `firstId`、`correctingId` が `secondId` に対応する。

### 3. `correctedId === correctingId` を `applyCorrection` 自身は特別扱いしない

手順2の候補照合を通り抜けた場合（呼び出し側が `excludeMemoryIds` で自己除外していない等）、
`markContested` 自身が `firstId === secondId` の `RangeError` を投げる——`applyCorrection`
はそれを捕まえない。`markContested`/`resolveContested` の「開く前に落とす」位置を
そのまま引き継ぐ、呼び手のバグとして扱う。

---

## 引き受けた負債

### 1. ADR 0232 が測った危険（B群: 棄権率 0/8・深い誤爆 6/8）は、この ADR でも1文字も
   下がっていない

`applyCorrection` は「候補に居るかどうかの照合」しかしない——ADR 0232 が実測した
「訂正してはいけない8件中6件で、守るべき事実が候補1位に来る」という危険は、
呼び出し側が `candidates[0]` を機械的に採る実装を書けば今日もそのまま再現する。
この ADR が買ったのは「口を出荷される面へ持ち上げたこと」であり、「呼び出し側の
実装が正しく選ぶこと」を保証するものではない——これは ADR 0232 の「引き受けた負債1」を
繰り返しているだけであり、この ADR が新しく作った負債ではない。

### 2. `applyCorrection` の2段呼び出し（mark のみ→resolution 付き）は、`packages/core` の
   歯では実測したが、実 API・実 Postgres の両方を同時に通した経路ではない

`apply-correction.test.ts` はインメモリの fake stores（`runtime-fakes.ts`）に対して
2段呼び出しを実測している。`examples/chat/src/correction-demo.postgres.test.ts` は
本物の Postgres に対して同じ2段呼び出しの経路（`correction-demo.ts` の書き換え後）を
実測しているが、**LLM/embedding は `deterministic`（`env: {}`）である**——実 API を通した
経路では確認していない。

### 3. `buildCorrectionReason` の `winner` 語彙変更（`original`/`correction` →
   `corrected`/`correcting`）により、`examples/chat` 側の2つのテストの期待文字列を
   `winner=correction` → `winner=correcting` に書き換えた

これは ADR 0238 が定めた文字列の**中身**を変えている（形式・4要素・スコア非掲載の
方針は変えていない）。ADR 0238 の本文は書き換えていない（`docs/decisions/README.md`
の規律どおり、正誤ではなく「後で変わった」という事実をこの ADR 側に記録する）。

---

## ⛔ 確かめられなかったこと

1. **`applyCorrection` を実 API（`OPENAI_API_KEY` あり）経路で実行したことは無い。**
   `examples/chat` のテストはすべて `deterministic` provider で走る。
2. **`applyCorrection` の2段呼び出しパターンを、`markContested`/`resolveContested` 以外の
   組み合わせ（例: 1回目と2回目で異なる `correctedId` を渡す等の誤用）でどう振る舞うかは
   意図的に検査していない。** 型上は同じ `correctedId`/`correctingId` を渡すことを
   強制していない——呼び出し側の責務として文書化したのみ。
3. **公開 API スナップショットの diff が、`@mnemora/core` に依存する第三者パッケージの
   ビルドを実際に壊すかどうかは、この repo の外では確認していない。**
4. **`docs/autonomy.md` §2.2 の品質評価と合格基準**（想起・抽出・統合・訂正・予算の
   振る舞いを変えた場合の確認）は、この PR が `recall()`/抽出/統合の挙動を1バイトも
   変えていないため対象外と判断した——`applyCorrection` は既存の `markContested`/
   `resolveContested`/`findCorrectionCandidates` を呼ぶだけで、それら自身のアルゴリズムは
   1行も変更していない。

⚠ **一般化しないこと**: この ADR が保証するのは「`Runtime.applyCorrection` という口が
`packages/core` に存在し、決定した契約どおりに動くこと」であり、「訂正の相手選びが
一般に安全になったこと」ではない——ADR 0232 の測定結果（B群の危険）はそのまま生きている。

---

## これが覆るとしたら

- **ADR 0232/ADR 0235 の「これが覆るとしたら」節と同じ条件**（実 API 抽出での再測定で
  B群の深い誤爆が大きく下がる、または「訂正である」宣言に加えて主語・期間を渡せる形が
  入る）が満たされたとき——このときも `applyCorrection` 自身の「相手を選ばない」という
  契約は変わらないが、呼び出し側（採用側）が安全に選べる範囲が広がる。
- **`winner` の語彙（`corrected`/`correcting`/`both_active`/`pending`）が、後から
  機械可読性の要求と衝突したとき**——`buildCorrectionReason` の自由文字列という形式
  そのものを見直す必要が生まれる（ADR 0238 の「これが覆るとしたら」節と同じ理由）。

---

## 採らなかった案

### 1. 独立関数にする（`Runtime` のメソッドにしない）【オーナー】

⛔ **採らない——オーナーの確定済み方針。** `applyCorrection(runtime, ctx, input)` のような
独立関数として `packages/core` から export する案も検討可能ではあった
（`findCorrectionCandidates`/`markContested`/`resolveContested` を内部で呼ぶラッパー関数と
して書ける）。**しかしオーナーは「`Runtime` のインタフェースにメソッドを足す」形を
明示的に指定しており**、この ADR はその指定を実装するものであって、独立関数案を
技術的に比較検討し直す場ではない。

参考として、`Runtime` メソッドにする形には次の一貫性がある: `findCorrectionCandidates`/
`markContested`/`resolveContested` の3つがすべて既に `Runtime` のメソッドであり、
その「間」を埋める `applyCorrection` だけを独立関数にすると、訂正の一連の操作
（発見・選択・書き込み）の一部だけが `runtime.xxx()` という形を外れることになり、
呼び出し側から見た口の形が不揃いになる。また ADR 0161（`getRecall`）・ADR 0230
（`restoreSuperseded`）の前例が示すとおり、**型としての破壊的変更を受け入れてでも
`Runtime` のメソッドにする**のはこの repo で繰り返し採られてきた形であり、独立関数化は
その一貫性を破る。

### 2. 自動検出 (B) 主張キーを入れる（`findCorrectionCandidates`/`applyCorrection` の
   どちらか、または新しい口に「主語」を持たせる）【オーナー】

⛔ **採らない——オーナーの確定済み方針。** [Issue #370](https://github.com/takecchi/mnemora/issues/370)/
[#371](https://github.com/takecchi/mnemora/issues/371) が指す (B)（主張キー: 「ユーザーの
好きな食べ物」のような属性・値のペアを Memory に持たせ、同じ主張キーを持つ既存の Memory を
機械的に探す）を、この PR の範囲に含める案も検討可能ではあった——ADR 0232 の
「これが覆るとしたら」節が「『何についての訂正か』を渡せる形が入ったとき、B群の別人・
別期間は主語や期間が渡れば落とせる可能性がある」と明記しており、技術的には無関係ではない。

**採らなかった理由（オーナーの判断としてここに記録する）**:

1. **抽出プロンプトの変更が要る。** 主張キー（属性・値のペア）を `Memory` へ持たせるには、
   抽出プロンプトに「これは何についての主張か」を構造化して出させる変更が要り、これは
   既存のカセット（`recorded` provider、ADR 0051）が記録した応答と一致しなくなる——
   【現物】`docs/roadmap.md`/`examples/chat/README.md` が指す既存カセットの規模
   （**compare 657回・retrieval 74回**の記録された実 API 応答）が**全滅する**。
2. **録り直しに `OPENAI_API_KEY` が要る。** この作業環境にはキーが無く、この担い手の
   範囲では録り直せない——実 API を叩ける環境・予算を持つ側の判断が要る。
3. **⭐ 門の基準値の動きが未予測である。** `docs/autonomy.md` §2.2 が定める品質評価と
   合格基準（⭐ 門）は、既存カセットの上に乗っている——抽出プロンプトを変えれば
   `compare`/`retrieval` の基準値が動きうるが、**どちらの向きにどれだけ動くかは
   録り直して測るまで分からない。**⭐ 門の基準値を動かす変更は、それ自体が独立した
   実測と ADR を要する重い判断であり、この PR（「選択」の段を持ち上げるだけ）に
   混ぜると「北極星 項目5 を出荷面から駆動できるようにする」という1つの主張に、
   性質の異なる別の主張（抽出プロンプトの拡張・カセットの全面録り直し・⭐ 門の再基準化）
   を混ぜることになる。

⟹ **これはオーナーの判断である**（上記3点の技術的な重さを理由に、水準を「明示訂正の
駆動まで」に留める、という決定そのもの）。この ADR はその判断を実装するものであり、
(B) の是非を再検討していない。

### 3. `ApplyCorrectionInput.reason` を `applyCorrection` 自身が自動生成する

⛔ **採らない。** `discovery`/`correctedId`/`correctingId`/`resolution` から「なぜこの
候補を選んだか」を `applyCorrection` 自身が推測して `meta.note` へ書き込む案も
検討したが、**この口が実質的に「相手を選ぶ」判断（あるいはその説明）を持つことに
近づいてしまう**——ADR 0134 決定2・ADR 0232 の核心（機械は選ばない/選んだ理由も
語らせない）に反する。`buildCorrectionReason` を別の公開関数として切り出し、
呼び出し側が明示的に呼んで `reason` へ渡す形にした。

### 4. 2段呼び出し（mark のみ→resolution 付き）を禁じ、`resolution` を必須にする

⛔ **採らない。** `resolution` を省略できないようにすれば `applyCorrection` は
「1回で完結する」単純な形になるが、`examples/chat/src/correction-demo.ts` が今日まで
見せてきた「`markContested` 直後、対が隣接して recall に出る」という実演
（Issue #197/ADR 0134 の核心の1つ）を、`applyCorrection` 経由では二度と見せられなくなる。
`resolution` を任意にし、2段呼び出しを明示的に許すことで、この実演を失わずに済ませた。

## 🔴 訂正の追記（2026-09-23）—— `:175` の「ADR 0238 決定2」は番号付き決定を指していない

> **⚠ この追記は、自動化された担い手（クローンのマネージャーから切り出された worker セッション）のものである。**
> **⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。⟹ **この追記を「オーナーが決めた」と読まないこと。**

⛔ **本節より上は1バイトも書き換えていない**（ADR 0223 決定1「採用済み ADR の本文は書き換えない」）。

**何が壊れているか**: 本文 `:175`「**両方に同じ reason を渡す**（ADR 0238 決定2）」は、
[ADR 0238](./0238-correction-choice-rationale-in-events.md) の「決定」節（`## 決定`、単一の
段落で番号付きの決定を持たない）ではなく、**別の見出し「## 設計で選んだこと」の
`### 2. \`markContested\` と \`resolveContested\` に同じ文字列を渡す` 節を指している**。
⟹ `ADR 0238 決定2` という書き方は、`ADR 0238` に実在しない番号付き決定を指しており、
機械的な検査（`scripts/adr-citation-lib.mjs` の `findAdrDecisionSectionNumbers`）では
「決定セクションに 決定2 が無い」と判定される。

**正しい指し先**: `ADR 0238「\`markContested\` と \`resolveContested\` に同じ文字列を渡す」`
（見出しの逐語を引用符で指す——`docs/release-v1.md` 等がすでに使っているアンカー引用の形。
[ADR 0213](./0213-live-docs-cite-adrs-by-anchor-not-line-number.md)）。

⛔ **本文 `:175` は書き換えない。** 検算のためにここへ書き残す。
