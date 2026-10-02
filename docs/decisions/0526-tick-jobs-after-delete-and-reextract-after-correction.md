# ADR 0526: 穴探し — ADR 0524「測っていないこと」の実測。`tick` 経由の `consolidate`・`reflect` ジョブの消した後の参照と、訂正の経路で負けた記憶がある状態での `reextract`（3者一致。割れは見つからなかった。歯を足した）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-2c9f30d0 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・Fake・InMemory を Postgres に揃える）の中だけを直す方針だったが、**直す割れは見つからなかった**。大文字の id の割れは記録だけにする方針（ADR 0521）で、この ADR の範囲には大文字の id を入れていない。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（Node.js v22、PostgreSQL 17 + pgvector を自分専用のポート `54871` で）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: ADR 0524 の「測っていないこと」2点: (1) `tick` 経由の `consolidate`・`reflect` ジョブ（ADR 0157。`RuntimeConfig.autoQueueConsolidateReflectOnExtract` の opt-in で積まれる）を、種・近傍の記憶を消した後や `eraseTenant` の後に回したとき。(2) 訂正の経路（`findCorrectionCandidates`＋`applyCorrection`）で負けて `superseded` になった記憶がある状態での `reextract`（ADR 0524 は `supersededById` を直接書いて `superseded` にしていた）。LLM は実 API を使わず、ADR 0524 と同じ決め打ちの応答を返す fake で回した。

## 結果

### (1) `tick` 経由の `consolidate`・`reflect` ジョブ — 3者一致【実測】

ジョブは、記憶を `createMemoryWithOutbox(ctx, memory, ["consolidate"|"reflect"])` で作って積んだ（payload は `{ memoryId }`。`observe` が opt-in で積む行と同じ形）。比べたのは `tick()` の戻り値（`processed`・`failed`・`unsupported`）、outbox の行（`attempts`・完了・失敗・`lastError`・claim 済みか）、積まれたイベントの種類、各記憶の status。

- **種が forgotten・archived・superseded・purge 済み**: ジョブは `processed: 1`・完了（`failed: 0`）・`attempts: 1` で、新しい記憶もイベントも作らない。`consolidate`・`reflect` 本体が種を `status_not_active` で弾く結末（ADR 0154 決定5）を、ジョブは「正規の結末」として完了させる。3者とも同じ。
- **近傍が forgotten・archived・superseded・purge 済み**（種は active）: 消えた近傍は材料から外れ、残りで決まる。`reflect` は `reflected`（`created` イベントと、新しい記憶の `embed` ジョブが1本増える）、`consolidate` は材料が足りず何もしない（イベントなし）。どの状態でも完了、3者一致。
- **`MemoryStore.eraseTenant` の後**: 記憶は消えるが、**outbox の行は `OutboxStore.eraseTenant` の担当なので残る**。残ったジョブは `tick` で `processed: 1`・完了（種が無いので何もしない）。3者一致。
- **`OutboxStore.eraseTenant` の後**: 行が無いので `tick` は `processed: 0`。3者一致。
- **完了したジョブの2回目の `tick`**: `processed: 0`（行は完了のまま）。3者一致。
- **LLM の障害**（`completeStructured` が例外）:
  - `reflect` ジョブは `failed: 1`・行は `failedAt` が付き、`attempts: 1`・`lastError` は `runtime.tick: reflect job failed because the llm call failed: simulated LLM outage`。同じ `tick` を続けても再試行されない（`processed: 0`・`failed: 0`）。
  - `consolidate` ジョブは、近傍が材料として足りるとき LLM を呼び、同じ形で `failed`。測定の組み立てでは、近傍の探索が半減期に依るため（Postgres 側の fixture の半減期 720h と、core の Fake のテストの半減期を揃えるまで、Fake だけが LLM を呼んで落ちた。**実装の差ではなく、記憶の fixture の差**）、歯では半減期を揃えた。
  - 3者とも同じ。
- 時計: `RuntimeDeps.clock` に過去の時計を注入すると、`tick` は outbox の `availableAt`（壁時計）より前としてジョブを取らない（`processed: 0`）。`RuntimeDeps.clock` の TSDoc の注意（Issue #1237）どおりで、3者とも同じ。歯は時計を注入しない。

### (2) 訂正の経路で負けた記憶がある `reextract` — 3者一致【実測】

`reextract` で記憶 M（`sourceObservationId` が元の observation）を作り、M に埋め込みを入れて、新しい記憶 C で訂正する（`findCorrectionCandidates` → `applyCorrection(correctedId: M, correctingId: C, resolution)`）。そのうえで、元の observation をもう1度 `reextract` する（応答は M と同じ内容と、別の内容の2通り）。

| 訂正の決着 | M の status | 2回目の `reextract`（M と同じ内容） | 2回目の `reextract`（別の内容） |
|---|---|---|---|
| `supersede`、勝者 = 訂正する側 C | `superseded` | 何もしない（`extraction: "skipped"`・`not_attempted`・`skipped: status_not_active(superseded)`） | 同じ |
| `supersede`、勝者 = 訂正される側 M | `active` | 変わらず（`unchanged`、作る 0・置き換える 0） | 新しい記憶ができ、M を置き換える |
| `both_active` | `active` | 同じ | 同じ |
| 決着なし（`contested` のまま） | `contested` | 何もしない（`skipped: status_not_active(contested)`） | 同じ |

- **現物の約束どおり**【現物】: `listWithdrawnAmong`（`runtime.ts` 5254 行付近）は、`forgotten`・`contested`、および**最新の `superseded` イベントの `meta.reason` が `"contested_resolved"`** の `superseded` を「退けた記憶」と数え、1件でも在ると抽出をやり直さない。ADR 0524 で `supersededById` を直接書いた `superseded`（イベントが無い）が数えられず、新しい記憶ができたのは、この理由による（食い違いではない）。
- **訂正の経路で負けた記憶の「理由」のイベントが保持期間の掃除（`purgeExpiredEvents`）で消えたとき**: TSDoc のとおり「理由を読めない `superseded`」は数えられないので、抽出がやり直され、別の内容なら新しい記憶ができる（`skipped` には `status_not_active` が載る）。3者とも同じ。
- 3者とも `reextract` の `atomicity`・イベントの種類・各記憶の status まで一致した。

## 決定したこと

1. 割れが無かったので、実装・公開 API・既定値・CHANGELOG・`docs/migration-v1.md` は変えていない。
2. **一致している今の振る舞いを歯で縛った**（conformance suite には足さない）:
   - `packages/core/src/__tests__/fake-runtime-tick-jobs-and-correction-reextract-parity.test.ts`（Fake）
   - `packages/postgres/src/__tests__/runtime-tick-jobs-and-correction-reextract-parity.postgres.test.ts`（InMemory と実 Postgres）
   - 2つは同じ操作列と同じ `EXPECTED`（37 項目）を持つ。大文字の id は入れていない。

## 変異試験【実測】

歯が噛むことを、実装を1つずつ曲げて確かめた。戻した後は `git status` に歯の2ファイル以外が無い。すべて赤になった。
- Fake の `OutboxStore.complete` が `completedAt` を付けない（Fake の歯が赤）。
- InMemory の `OutboxStore.complete` が同じ（InMemory・Postgres の歯が赤）。
- Fake の `OutboxStore.fail` が `lastError` を残さない（Fake の歯が赤）。
- Fake の `listBySourceObservationAllVersions` が `active` だけ返す（Fake の歯が赤。「退けた記憶」が見えなくなる）。

## 検討した代替案

1. **大文字の id を含める。** 採らなかった（ADR 0521 の担当）。
2. **ジョブの再試行の仕様（失敗が終端であること）を変える。** 採らなかった。`tick` の失敗が終端で再試行しないのは既存の仕様（ADR 0032 のリース意味論と outbox の `fail`）で、この ADR は測るだけ。
3. **歯を足さず、結果だけ書く。** 採らなかった。一致している3者が将来割れたときに気づける歯が無い。

## これが覆るとしたら

- ADR 0521 が大文字の id を揃えたとき（ジョブの payload の `memoryId` が大文字で積まれた場合の組み合わせを足す）。
- `reextract` の「退けた記憶」の定義（`listWithdrawnAmong`）を変えるとき（ADR 0380・0454 の決定が変わるとき）。

## 測っていないこと

- ジョブの payload の `memoryId` が大文字、または実在しない id のとき（大文字は ADR 0521 の面）。
- `tick` が `extract`・`embed` のジョブを同時に回すときの組み合わせ（ADR 0407・0410 などが当てた面）。
- 並行（複数の `tick`）・リースの期限切れによる別の担い手の再取得（ADR 0440・0142）。
- 実 API（LLM・埋め込み）。
