# ADR 0309: Issue #579 の頻度を測った — subject をまたぐ統合は近傍を種の subject に絞れば 0%、絞らなければ使い方しだいで 0〜100%。案 B は採らない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-25

> **⚠ この ADR は、クローンの委譲で動くマネージャーのセッション（mgr-4bf05114）が書いた。
> ⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> 本 ADR が決めたのは「案 B を採らない」ことと、測定の記録だけである。自動経路の挙動を変える案
> （下記「オーナーへ返すもの」）は既存の機能の挙動を変えるため、**決めていない**。

**⚠ 各主張の出所を分ける**（ADR 0290 / 0302 の体裁を踏む）。

- **【実測】** — この作業で、作業者が自分専用の Postgres（`initdb`）と `@mnemora/local-embedding`
  （実 ONNX 推論）を使い、`runtime.consolidate(..., { dryRun: true })` を実際に呼んで確かめた。
  測定対象は `main` = `52113a8`。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【算出】** — 実測値や式から導いただけ。走らせていない。

---

## 結論（先に）

1. **subject をまたぐ統合が起きうるのは、mnemora 自身が近傍を集める `{ seedMemoryId }` 形だけである。**
   `{ memoryIds }` 形では、混ぜるかどうかを呼び手が決める【現物】。
2. **近傍探索を種の subject に絞れば（`ctx.subjectId` = 種の `subjectId`）、混在は構造的に 0% である。**
   【実測】189 セル（S×N×話題の重なり×minAffinity）の全てで 0%。`deterministic` 埋め込みでも 0% で、
   埋め込みの質には依らない。
3. **絞らなければ（`ctx.subjectId` 無し）、混在の割合は使い方しだいで 0〜100% になる。**
   【実測】話題が subject 間で重なる使い方（1キャラクターが多くの相手と同じ話題で話す。Issue #579 の用途）では、
   **N（subject あたりの記憶件数）に関わらず 100%**。話題が重ならない使い方では、N が小さいうちは高い。
   N が `recall()` の既定の `limit`（10）を超えるあたりから急に減る。
4. **`ctx.subjectId` を付けても、種が別の subject だと、ほぼ 100% 混在する。**
   【実測】`tick()` はジョブを subject で絞って claim できない（Issue #579 のコメント）。
   そのため、自動経路（`autoQueueConsolidateReflectOnExtract: true`）で subject を付けて `tick()` を回すと、
   この形になる。
5. ⟹ **案 B（`subjectId` を集合にする。migration 要）は採らない。** 頻度は高くなりうるが、
   schema を変えずに 0% にできる経路がある（2）。しかも、subject をまたいで統合しないことは、
   Issue #579 が守りたい「帰属」に沿う（「A が言った X」と「B が言った X」は帰属の上で別の記憶である）。

## 文脈

[Issue #579](https://github.com/takecchi/mnemora/issues/579) の困りごと1は、`consolidate` が subject を
またぐと、統合後の `subjectId` が `null` に畳まれることである（`packages/core/src/strategies/consolidate.ts`）。
案 D は着地済み（PR #684、ADR 0289）、案 A は不採用、案 C は「今回は出さない」と決まっている。
残る案 B は「mixed-subject の統合がどれだけ起きるかを誰も測っていない」ために保留されていた。
オーナーの回答（2026-09-24）により、本番のサーバーは無く、N は不明である。
⟹ 本 ADR は、N を振った曲線で頻度を示す。

## 測ったこと【実測】

- **経路**: 記憶は抽出 LLM を通さずに直接書いた（`buildNewMemoryFixture` +
  `createMemoryWithOutbox` + `drainEmbedTicks`。`time-weighting-bench.ts` と同じ配線）。
  各記憶を種として、`consolidate(ctx, { target: { seedMemoryId }, dryRun: true, minAffinity })` を呼んだ。
  dryRun は LLM を呼ばない。
- **dryRun の忠実性**: 1件で dryRun → 実行を続けて呼び、eligible の集合と実際に `superseded` になった集合が
  順序まで一致することを確かめた。混在したときに、統合後の行の `subject_id` が DB 上で `NULL` になることも
  `psql` で確かめた。
- **埋め込み**: `@mnemora/local-embedding`（`ruri-v3-30m/sym`、256次元）。
- **コーパス**: 日本語の話題を10領域、テンプレートから合成した。極を2つ置いた。
  - **disjoint**: subject k は領域 `k mod 10` だけを話す（話題が重ならない）
  - **shared**: 全ての subject が同じ領域の列を話す（同じ話題を複数の相手と話す）

  実運用はこの2極の間にある、と境界として読むこと。
- **格子**: S ∈ {2, 5, 10}、N ∈ {1, 2, 5, 10, 20, 50, 100}、`ctx.subjectId` ∈ {無し, 種と同じ, 種と別}、
  minAffinity ∈ {0.7, 0.8（既定）, 0.9}。dryRun 26,028 回。種は `min(S·N, 150)` 件を決定的に抜いた。
- **指標**: eligible（種を含む）が2件以上あった試行のうち、eligible の `subjectId` が2種以上だった割合。
- スクリプトと全表: `examples/chat/src/subject-crossing-measure.ts`（集計は `subject-crossing-summary.ts`）、
  [`examples/chat/bench-results/subject-crossing-local.md`](../../examples/chat/bench-results/subject-crossing-local.md)。CI には載せない（一回きりの判断材料で、
  「正しい値」を持つ回帰検査ではないため）。

### 表: `ctx.subjectId` 無し、minAffinity = 0.8 の混在率

| N（subject あたり） | disjoint S=2 | S=5 | S=10 | shared S=2 | S=5 | S=10 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 100% | 100% | 100% | 100% | 100% | 100% |
| 2 | 75% | 100% | 100% | 100% | 100% | 100% |
| 5 | 70% | 100% | 100% | 100% | 100% | 100% |
| 10 | 35% | 72% | 82% | 100% | 100% | 100% |
| 20 | 0% | 5% | 31% | 100% | 100% | 100% |
| 50 | 0% | 0% | 1% | 100% | 100% | 100% |
| 100 | 0% | 0% | 0% | 100% | 100% | 100% |

- `ctx.subjectId` = 種と同じ: **全セル 0%**。
- `ctx.subjectId` = 種と別: eligible が2件以上なら**全セルほぼ 100%**。
  自動経路で subject を付けた `tick()` が種と別の subject を引く確率は、ジョブが subject 間で一様なら
  `(S−1)/S`【算出】（S=2 で 50%、S=10 で 90%）。
- minAffinity 0.7 と 0.8 では、ほぼ同じ数字になった。0.9 では eligible が2件に届かない試行が増える。

### 読み方の注意

- **このモデルは類似度が詰まっている**【実測】: 話題がまったく違う文どうしでも 0.79、同じ領域なら 0.85〜0.89 になる。
  既定の 0.8 は、その境目のすぐ上にある。⟹ disjoint 極の数字は、このモデルの詰まりで押し上げられている
  可能性がある（別のモデルでは測っていない）。
- **shared 極は、主語だけを変えたテンプレート文で作った**。言い換えに近いので、shared 極の 100% は上限として読むこと。
- 構造にあたる3つの事実（同じ subject に絞れば 0%、別の subject に絞るとほぼ 100%、絞らなければ規模と話題の重なりしだい）は、
  `deterministic` の対照でも再現した。埋め込みのモデルには依らない。

## 決めたこと

1. **案 B は採らない。** 理由は「結論」5。B を採り直すのは、「subject をまたいで統合し、
   しかも両方の帰属を1つの記憶に持たせたい」用途が実名で来たときである（「これが覆るとしたら」）。
2. **`{ seedMemoryId }` を明示的に呼ぶ採用者向けの回避を、文書に書く。**
   `ctx.subjectId` に種の `subjectId` を渡せば、混在は起きない（コードの変更は要らない）。
   `packages/core/src/runtime.ts` の `ConsolidateTarget` の doc に、その一文を足す。
3. **既定値・公開 API・スキーマは変えない。**
4. **Issue #579 は閉じない。** 自動経路（`processConsolidateJob`）だけは、呼び手が塞げない。
   その扱いをオーナーへ返す。

## オーナーへ返すもの（決めていない）

自動経路は `consolidate(ctx, { target: { seedMemoryId } })` を、`tick()` に渡された `ctx` のまま呼ぶ。
そのため、上の「無し」または「種と別」の行に落ちる。

| 案 | 中身 | 混在率 | 代償 |
|---|---|---|---|
| **S（推奨）** | `processConsolidateJob` は、種の `subjectId` を `ctx.subjectId` に置いてから consolidate を呼ぶ（種が `null` なら今日どおり） | **0%**（構造的） | `autoQueueConsolidateReflectOnExtract: true` の利用者から見て、挙動が変わる（subject をまたぐ統合が起きなくなる）。ADR 0152 却下案4（「似ている」に同一 `subjectId` を含める案）と緊張する。ただし S は「似ている」の定義を変えない。recall の subject scope を使うだけである |
| T | 現状維持。文書で「自動経路は subject をまたいで統合しうる」と知らせる | 上表どおり（shared では 100%） | Issue #579 の用途では、自動経路を有効にすると帰属が消える |
| B | `subjectId` を集合にする | 帰属は消えない（統合は起きる） | migration、ADR 0023 の索引の再設計、`memory-store-conformance` の不変式の再設計 |

**S を推す理由**: 既定（フラグ `false`）の利用者には何も起きない。migration も要らない。帰属を守るという
Issue #579 の要求を、自動経路でも構造的に満たせる。⚠ ただし、有効にしている利用者から見ると挙動の変更である。
⟹ 版の扱い（1.x の minor か）も含めて、オーナーの判断に返す。

## 検討した代替案

1. **B を今やる。** ⛔ 落とした（「決めたこと」1）。
2. **測定を CI に常設する。** ⛔ 落とした。混在率に「正しい値」は無く、使われ方の分布しだいである。
   固定する価値があるのは構造の事実（種と同じ subject に絞れば 0%）のほうである。S を採るなら、
   その歯は S の PR で足す。

## 引き受けた負債

- 実運用の話題の重なり具合は分からない（本番が無い）。表は2つの極で挟んだだけである。
- 埋め込みは1モデルしか測っていない（OpenAI 系は鍵が無く未測定）。

## これが覆るとしたら

- 「subject をまたいで統合し、両方の帰属を持たせたい」用途が実名で来たとき（B を採り直す）。
- オーナーが S/T/B のどれかを選んだとき。

## 確かめていないこと

- 近傍探索のうち、語彙チャンネル（lexical）がどれだけ寄与したかは切り分けていない。
- `reflect()` の `{ seedMemoryId }` 形（ADR 0154）の混在。土台の選び方は同じなので、同じ形になると推測しているが、測っていない。
- 測定で踏んだこと（本体の欠陥ではない）: `buildNewMemoryFixture` の既定の `recordedAt`（2026-01-01 固定）は、
  既定の `halfLifeHours`（720）と組むと、いまの壁時計では床を過ぎている。そのため `recall()` が候補を0件返す。
  測定では `recordedAt` を「いま」にして避けた。
