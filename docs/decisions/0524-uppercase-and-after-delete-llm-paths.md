# ADR 0524: 穴探し — ADR 0522「測っていないこと」の実測。`observe`・`reextract`・`consolidate`・`reflect` の「大文字の id」と「消した後の参照」（小文字では3者一致。大文字は既知の形に加えて、Postgres の `created` イベントの `meta.sources` に呼び出し側の綴りが残る形を1つ見つけた）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-2c9f30d0 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・Fake・InMemory を Postgres に揃える）の中だけを直す方針だったが、**直す割れは見つからなかった**。大文字の id の割れは ADR 0446・0469 の既知の形で、揃える直しは ADR 0521 の担当なので、ここでは記録だけにした。新しい形（下の「見つけた新しい形」）は、直さずに材料として分けて書く。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果（Node.js v22、PostgreSQL 17 + pgvector を自分専用のポート `54871` で）、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: ADR 0522 の「測っていないこと」2点: (1) 大文字の id での `observe`・`reextract`・`consolidate`・`reflect`、(2) `consolidate`・`reflect`・`reextract` の消した後の参照（forgotten・archived・superseded・purge 済みの記憶や、消えた observation を対象にしたとき）。LLM は実 API を使わず、決め打ちの応答を返す fake（`req.schema.parse({ outcome: "reflected", content, digest, tags, memories })` のように、reflect・consolidate・extract のどの schema にも通る1つのオブジェクト。前例は `consolidate.test.ts` の `llmConsolidatingTo`・`reflect.test.ts` の `llmReflectingTo`・`runtime.test.ts` の `llmReturning`）で回した。

## 先に確かめたこと

**`reflect` は決め打ちの応答で最後まで通せる**【実測】。Fake・InMemory・Postgres の3者で、`{ memoryIds }`・`{ seedMemoryId }`・`{ query }` のどの形でも `reflected`（新しい記憶が1件できる）まで進む。`consolidate`・`reextract` も同じ。

## 結果

### (2) 消した後の参照 — 小文字の id では3者が一致した（割れなし）【実測】

記憶の状態 `active`・`forgotten`・`archived`・`superseded`・`purged`（墓石）× 操作、47 項目で3者を比べた:

- `consolidate`・`reflect` の `{ memoryIds: [a, a2, m(状態)] }`・`{ seedMemoryId }`（種が active で近傍がその状態／種がその状態で近傍が active）・`{ query }`（その状態の記憶が1件混ざる）。結果の `outcome`・`nothingReason`・`basis` の種類・操作後の各記憶の status・積まれたイベントの種類が、3者で同じ。
  - 例: `reflect` は forgotten・archived・superseded・purge 済みの記憶を `basis` に `status_not_active` で載せ、残りで `reflected` になる。`consolidate` は非 active の記憶を材料から外し、残りが2件以上なら `consolidated`、1件以下なら `nothing_to_consolidate`。種が非 active のときはどちらも「何もしない」（`nothing_to_*`）。
- `reextract`: 1回目で作った記憶を状態にしてから、別の応答でもう1度 `reextract` した結果（作った件数・置き換えた件数・`skipped` の種類・status・イベント）が3者で同じ。forgotten・purge 済みの記憶が在ると、抽出をやり直さず（作る件数 0）`skipped` に `status_not_active` が入る（ADR 0380 の約束どおり）。
- 消えた observation: `eraseTenant` の後の `reextract`、実在しない observation id への `reextract` は、3者とも `runtime.reextract: observation not found`。
- purge 済みの記憶の元の observation を同じ `externalId` で `observe` し直すと、3者とも冪等で `extraction: "skipped"`、墓石の本文は戻らない。purge 済みの記憶を `observe({ kind: "memory_usage" })` で使ったと言っても、3者とも落ちない。
- 見かけの割れ（実装の差ではない）: 同点の候補の並び（`mem-N` と uuid で `memoryId` 昇順が逆）、返り値の id の形。測定用の組み立ての誤り（`InMemoryTenantSettingsStore` に `InMemoryMemoryStore` の `activitySeq`・`subjectActivitySeq`・`eventRetentionDays` を渡さないと設定が読めない）は ADR 0522 と同じ。

### (1) 大文字の uuid の id — 全て既知の形（操作の対象の id は store に従う。ADR 0446・0469。揃える直しは ADR 0521）【実測】

操作の対象の id を大文字にして渡すと、Postgres は同じ行として処理し、Fake・InMemory は不在扱いにする。測った口（Postgres → Fake・InMemory）:

- `consolidate`・`reflect` の `{ memoryIds }`・`{ seedMemoryId }`: `consolidated`／`reflected` → `nothing_to_consolidate`／`nothing_to_reflect`（`basis` は全件 `not_found`）。消した後の状態の記憶が混ざる組み合わせも同じ形（Postgres は状態に応じた `status_not_active` などを返す）。`{ query }` の形は id を渡さないので影響しない。
- `reextract` の observation id: `ok` → `observation not found`。
- `observe({ kind: "memory_usage" })` の `recallId`: `ok`（強化される）→ `recall not found`（Fake の例外）。
- `getRecall` の `recallId`: 記録 → `null`。
- 同じ呼び出しに、同じ記憶の小文字と大文字を混ぜた `memoryIds`（`[a, A, n]`）: 3者一致（Runtime が小文字にそろえて重複を除く。ADR 0446・consolidate-duplicate-ids）。

### 見つけた新しい形（直していない。材料）【実測】

**`consolidate`・`reflect` に大文字の `memoryIds` を渡すと、Postgres の `created` イベントの `meta.sources` に、呼び出し側が渡した大文字の綴りがそのまま残る。**
- 同じ呼び出しで、新しい記憶の `provenance.sources`（`consolidate` は元の記憶の `supersededById` も）は、store が返した行の id（小文字の正規形）になる。`created` の `meta.sources` だけが、渡された綴りのまま。
- 他の口（`forget`・`purge`・`restoreArchived`・`restoreSuperseded`・`markContested`・`resolveContested`）が積むイベントの `meta`（`supersededById`・`contestedWithId` ほか）と `memoryId` は、大文字で渡しても小文字の正規形で残る【実測】。`meta.sources` の綴りだけが割れる。
- Fake・InMemory は大文字の id を不在扱いにして何も書かないので、この形は Postgres にだけ出る。ADR 0521 が Fake・InMemory を揃えたあとは、3者とも呼び出し側の綴りを残す（揃う）ことになる。
- 原因は【判断】: Runtime（`packages/core/src/runtime.ts`）が `created` イベントの `meta.sources` を、store が返した行の id ではなく、渡された `memoryIds` から組んでいる。
- **直さなかった理由**: 直すなら Runtime が `meta.sources` を正規形にする（または、書く前に小文字にそろえる）ことになり、(a) 既に書かれた行（遡ってのデータ書き換え。直す前に書かれた行の綴りは直さない）と、(b) 大文字の id を渡す利用者の `meta.sources` の見え方（Postgres の返りを変える向き）に触れる。どちらもオーナーの領分。ADR 0521 の担当が、Fake・InMemory の大文字の扱いを決めるときに、あわせて決めるのが自然。

## 決定したこと

1. 割れが無かった（小文字）か、既知の形だった（大文字）ので、実装・公開 API・既定値・CHANGELOG・`docs/migration-v1.md` は変えていない。
2. **一致している今の振る舞いを歯で縛った**（conformance suite には足さない）:
   - `packages/core/src/__tests__/fake-runtime-llm-paths-after-delete-parity.test.ts`（Fake）
   - `packages/postgres/src/__tests__/runtime-llm-paths-after-delete-parity.postgres.test.ts`（InMemory と実 Postgres）
   - 2つは同じ操作列と同じ `EXPECTED`（47 項目）を持つ。大文字の id は入れていない。
3. 大文字の id の割れと、`meta.sources` の綴りは、直さず記録だけにした（材料。上のとおり）。

## 変異試験【実測】

歯が噛むことを、実装を1つずつ曲げて確かめた。戻した後は `git status` に歯の2ファイル以外が無い。すべて赤になった。
- Fake の `eraseTenant` が observation を消さない（Fake の歯）。
- Fake の `purgeMemory` が本文を墓石にしない（Fake の歯）。
- InMemory の `purgeMemory` が本文を墓石にしない（InMemory・Postgres の歯）。
- Fake の `updateStatus("forgotten")` が `archived` にする（Fake の歯）。

## 検討した代替案

1. **大文字の id を Fake・InMemory で揃える。** 採らなかった。ADR 0521 の担当で、Fake・InMemory の id の扱いに触る。
2. **`meta.sources` を Runtime で正規形にする。** 採らなかった（上のとおり。遡ってのデータ書き換えと Postgres の返りを変える向きに触れる）。
3. **歯を足さず、結果だけ書く。** 採らなかった。一致している3者が将来割れたときに気づける歯が無い。

## これが覆るとしたら

- ADR 0521 が大文字の id を fixture でも揃えたとき（このADRの大文字の記録を更新し、歯に大文字の組み合わせを足す）。
- オーナーが `meta.sources` を正規形にすると決めたとき（上の材料。Postgres の `created` イベントの綴りが変わる）。

## 測っていないこと

- `consolidate`・`reflect` の `{ query }`・`{ seedMemoryId }` で、**複数の近傍が大文字小文字だけ違う id で返る**ような store（Postgres の uuid は常に小文字なので起きない）。
- `tick` 経由（outbox の `consolidate`・`reflect` ジョブ）の消した後の参照（ADR 0415・0420 などが当てた面）。
- 実 API（LLM・埋め込み）。
- `reextract` の「`contested` や訂正の解決で負けた `superseded`」を作った後の参照（測定では、`supersededById` を直接書いた `superseded` を使った。訂正の解決で負けた形は ADR 0380・0454 の面）。
