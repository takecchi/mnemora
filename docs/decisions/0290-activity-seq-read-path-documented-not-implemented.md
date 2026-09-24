# ADR 0290: Issue #338 案2（`activity_seq` の進みから recall 頻度を測る）の段0 — 読み口は既に在ったので、実装はせず文書化だけを足す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-24

**⚠ 各主張の出所を分ける**（ADR 0111 / 0188 / 0193 / 0197 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が自分の手で `tsc`/`eslint`/`prettier`/`vitest`/`initdb` 等を
  走らせて確かめた。
- **【受】** — マネージャーから、別の器で測られたものとして受け取った実測。この書き手は
  その実測自体を再現していない。

---

## 文脈

[Issue #338](https://github.com/takecchi/mnemora/issues/338) は、`decay_clock: 'activity'`
を選んだテナントで1日3112回を超えて `recall()` すると「次の日も覚えている」が破れること
（[ADR 0165](./0165-decay-activity-clock.md)「引き受けた負債」7 の逆算、本物の Postgres での
実測で確認済み）に対する4案のうち、**案2（`activity_seq` の進みから実際の recall 頻度を測る）**
を主題とする。

Issue のコメント（2026-09-16頃）は、対処の順番をこう並べ直している（逐語の要旨）:

> 先に要るのは「口を与えること」——`setDefaultHalfLifeRecalls` を本番の経路として足す
> （[ADR 0197](./0197-set-default-half-life-recalls.md) / PR #416 で着地済み）。
> **案2（`activity_seq` の進みから実際の recall 頻度を測る）は、その次。列は既に在る。**
> 🔴 案3（既定 720 の与え方）とカウンタを `subject` 単位にする変種はオーナー判断——
> ⛔ ここでは決めない。

本 ADR はこの「その次」を段0 として着手した記録である。**射程は、マイグレーション無し・
公開 API は追加のみ、という制約の下で何ができるかを確かめ、できる分だけを実装（または
文書化）することに限る。** 案3・`subject` 単位のカウンタには踏み込まない
（ADR 0165「これが覆るとしたら」1 がオーナー判断の分岐だと明記している）。

## 調べたこと（【現物】）

**「列は既に在る」だけでなく、読む公開の口も既に在った。** ADR 0165 決めたこと13 は
`TenantSettingsStore` に `getDecayClock`/`setDecayClock`/`getDefaultHalfLifeRecalls` と並べて
`getActivitySeq?(ctx): Promise<number>`（**読み出し専用**）を足すと決めており、実際に着地
している:

- `packages/core/src/interfaces/tenant-settings-store.ts:326` —
  `getActivitySeq?(ctx: Ctx): Promise<number>`。**省略可能**（`@mnemora/core` が npm
  公開済みのため、既存の第三者 `TenantSettingsStore` 実装を壊さない設計——ADR 0165 と
  同じ理由）。
- `packages/core/src/interfaces/tenant-settings-store.ts:360-365` —
  `readActivitySeq(store, ctx)` ヘルパ。`getActivitySeq` を持たない adapter では `0` へ倒す
  （`readDecayClock` と同じ規律）。
- `packages/postgres/src/tenant-settings-store.ts:154-163` —
  `PostgresTenantSettingsStore.getActivitySeq` の実装。`tenant_activity` を `SELECT` する
  だけ（`bigint` は文字列で返るため `Number()` で変換——`Number.MAX_SAFE_INTEGER` を
  超える運用は想定していない、と doc コメントに明記済み）。
- `packages/testkit/src/__fixtures__/in-memory-tenant-settings-store.ts:171` — in-memory
  実装。
- `packages/testkit/src/tenant-settings-store-conformance.ts:314-340` — 適合テスト3本
  （行が無いテナントに `0`／`advanceActivitySeq` を呼ぶたびに1ずつ進む／テナントごとに
  独立している）。`supportsDecayClock` フラグの配下で走る。

⟹ **Issue #338 の 1 と 2 のどちらの意味でも、「読み口が無い」状態ではなかった。**
ADR 0197 が塞いだのは書き込み側（`setDefaultHalfLifeRecalls`）の欠落であり、読み出し側
（`getActivitySeq`）は ADR 0165 の実装時点（PR #335、2026-09-16）で既に本番の口として
入っていた。**この段0 で新しく実装すべきコードは無い。**

`tenant_activity` 自体の形（`packages/postgres/migrations/0015_decay_activity_clock.sql:62-67`）
も確認した——列は `tenant_id` / `activity_seq bigint` / `updated_at` の3つだけ、1テナント1行。
**過去の値の履歴は保存されない構造である**（累積カウンタ）。この限界は下の「決めたこと」で
扱う。

## 決めたこと

1. **新しいコードは足さない。** 読み口（`getActivitySeq`／`readActivitySeq`）は既に公開
   API として存在し、postgres 実装・testkit fixture・適合テストの3点が揃っている。
   段0 のタスクである「案2 のための読み口を、マイグレーション無し・公開 API は追加だけで
   足す」を、**「既に足された状態だった」と確認することで満たす。**

2. **案2（`activity_seq` の進みから実際の recall 頻度を測る）を、既存の読み口を使う
   運用手順として文書化する。** [docs/memory-model.md](../memory-model.md) §7
   「忘却と減衰」に新しい節「活動時計の読み口 — `getActivitySeq` と、そこから測れること」
   を追記した。内容:
   - `getActivitySeq` を2時点でサンプルし、差分を「その間の `recall()` 回数」として読む
     手順そのもの。
   - サンプル間隔・保存・アラートは呼び出し側の責務であり、mnemora はスケジューラも
     保存先も持たない（`writeDecayClock` のような「省略時の倒し方を1箇所に閉じ込める」
     規律は、読み出し専用の `getActivitySeq` には元から無い）。
   - 下の「限界」節がそのまま文書にも入っている。

3. **限界を、実装ではなく文書で引き受ける。** `tenant_activity` は1テナント1行の
   累積カウンタである以上、次の4点はコードを足しても解決しない種類の限界であり、
   曖昧にせずそのまま書く:
   - **過去の日ごとの回数は後から読めない。** サンプルを取り始めた時点より前には
     遡れない。
   - **テナント全体のカウンタであり、`subject` 単位でも Memory 単位でもない。**
     ADR 0165 が実測済みの「別 subject の `recall()` でも進む」という性質がそのまま効く。
   - **既定（`'wall'`）のテナントでは常に `0`。** この方法で頻度を測れるのは
     `'activity'`/`'either'` を選んだテナントだけ。
   - **`getActivitySeq` を持たない adapter では `readActivitySeq()` が `0` へ倒すため、
     「頻度ゼロ」と「未実装」が区別できなくなる。** 頻度測定の用途では
     `readActivitySeq()` を経由せず、`store.getActivitySeq !== undefined` を呼び出し側が
     自分で見ること。

4. **日次の履歴テーブル（例: `tenant_activity_daily`、過去に遡って読める形）は、
   この段0 では作らない。** 理由は、それがマイグレーション（新しいテーブル）を要求する
   ためであり、本 ADR の射程（マイグレーション無し）の外にある。要るかどうかの判断は
   「これが覆るとしたら」に送る。

5. **案3（既定 `720` の与え方）と `subject` 単位のカウンタには踏み込まない。**
   ADR 0165「これが覆るとしたら」1 と ADR 0197「決めたこと」4 が既に
   「オーナーの判断を要する種類の分岐である」と明記しており、本 ADR もその判断を
   そのまま引き継ぐ。

## 検討した代替案（落とした案）

1. **`recalls` テーブル（`tenant_id`・`subject_id`・`created_at`、索引
   `idx_recalls_by_subject (tenant_id, subject_id, created_at)`）を `COUNT` して頻度を
   出す。**
   ⛔ **この段0 では採らなかった（ただし将来の選択肢として記録する）。**
   `recalls` は recall 1回ごとに1行・`created_at` を持つため、原理上は
   `activity_seq` より強い——**過去に遡って日ごとの回数を数えられる**（`tenant_activity`
   に無い性質）。しかも `'wall'` のテナントでも `recalls` 行は作られるため、
   `decay_clock` の値によらず頻度を測れる。**理由は2つで落とした**: (a) これを公開の
   読み口にするには、`MemoryStore` に新しい集計メソッド（例: `countRecalls`）を足す
   実装が要る——「読み口は既に在るかを先に見る」という段0 の入口の問いに対して、
   `getActivitySeq` は「在った」と即答できたが、`recalls` の集計は「無い」ので実装が
   要り、段0 の範囲（案2＝`activity_seq` の進みを読む）から外れる。(b) `recalls` の
   保持期間は `event_retention_days`（`memory_events` 用）の対象に**含まれていない**
   （`packages/postgres/src/memory-store.ts` の `purgeExpiredEvents` は `memory_events`
   のみを対象にしている——【現物】確認済み）ため無期限に積み上がる可能性があり、
   それを頻度測定の用途で正式に使うなら保持方針も合わせて決める必要がある。
   **これは案2 とは別の設計（案2 が名指ししているのは `activity_seq` であって
   `recalls` の集計ではない）であり、混ぜると段0 の主張が読めなくなる**
   （`docs/autonomy.md` §2「ついでに直さない」と同じ理由）。⟹ 別 Issue の候補として
   「これが覆るとしたら」に残す。

2. **`tenant_activity` に `last_sampled_seq`/`last_sampled_at` のような列を足し、
   `getActivitySeq` の呼び出し自体が自動で差分を返す形にする。**
   ⛔ **落とした。** 2つの理由がある。(a) 新しい列 = マイグレーションであり、本 ADR の
   射程外。(b) 「前回いつ読んだか」はグローバルな1つの値では表せない——複数の監視系
   （例: 日次バッチと週次レポートが同時に存在する）が同じテナントを見たとき、一方が
   読むと他方の基準がリセットされてしまう。**「前回値」はサンプルを取る側（呼び出し側）
   が持つべき状態であり、DB 側の1行に押し込めるものではない。**

3. **`tenant_activity` に列を足さず、`recall()` の呼び出し時に構造化ログとして
   タイムスタンプを吐く形にする。**
   ⛔ **検討はしたが、この repo の既存の観測経路と重複するため見送った。**
   `recalls` テーブル（上記代替案1）が既に「recall 1回ごとに `created_at` 付きの1行」
   という、ログと同等の情報をより強い形（構造化・クエリ可能）で持っている。
   別のログ経路を足すのは二重化であり、採るなら代替案1（`recalls` の集計 API）を
   先に検討すべきである。

## 引き受けた負債

1. **段0 の成果は「頻度をアラートする機構」ではなく「頻度を自分で測るための手順の
   文書化」でしかない。** 採用者が実際にサンプルを取り、閾値と照らして
   `setDefaultHalfLifeRecalls` を呼ぶところまでは、依然として採用者自身の運用に
   委ねられている。**mnemora 自身が「あなたのテナントは3112回/日に近づいています」と
   能動的に警告する機構は無い**——これは本 ADR の範囲外であり、ADR 0165「これが覆る
   としたら」4（既定を見直す条件）とも独立した、別の判断（オーナー判断か設計判断か
   自体、まだ切り分けていない）である。
2. **`activity_seq` の累積性そのものは解消していない。** 日次の履歴を遡って読みたい
   採用者は、この ADR の後もマイグレーションを伴う別の実装を待つ必要がある
   （「検討した代替案」4、「これが覆るとしたら」1）。
3. **`readActivitySeq()` ヘルパを頻度測定に使うと「頻度ゼロ」と「未実装」を区別できない
   落とし穴が、コードの型では防がれていない。** 文書で注意を書いただけであり、
   呼び出し側が読み飛ばせば同じ間違いを踏む。型で強制する案（例: `readActivitySeq`
   の戻り値を `{ value: number; supported: boolean }` にする）は検討していない
   ——このヘルパは `readDecayClock` 等と規律を揃えるためのものであり、他の3つの
   `read*` ヘルパの形を1つだけ変えると一貫性が崩れる。今回はその判断まで踏み込まず、
   文書での注意に留めた。

## これが覆るとしたら

1. **採用者が実際に案2 の手順を使い、「過去に遡って読みたい」という要求が具体的に
   出たとき。** ⟹ 日次の履歴テーブル、または「検討した代替案」1 の `recalls`
   集計 API のどちらかを、マイグレーションを伴う別 ADR として設計する。
2. **「検討した代替案」1（`recalls` の集計）を実装する具体的な必要が生まれたとき。**
   ⟹ `MemoryStore` に集計メソッドを足す ADR を別途書く。**`recalls` の保持方針
   （負債2 の裏返し）も同じ ADR で決めること。**
3. **既定 `720`（Issue #338 案3）または `subject` 単位カウンタについて、オーナーが
   判断したとき。** ⟹ 本 ADR は関与しない——ADR 0165 / 0197 の同じ節が指す先に従う。

## 測ったこと

【実測】このブランチの器（`initdb` で立てた自分専用の Postgres 17 + pgvector、
`AGENTS.md`「手元で Postgres を立てる」の手順どおり。データ・socket は
`/tmp/mgr-9d1407fa/pg/` 配下、ポートは 5432 ではなく専用ポートを使用）で確認した:

```
$ pnpm --filter @mnemora/core run build      → 成功
$ pnpm --filter @mnemora/postgres run build  → 成功
$ pnpm --filter @mnemora/postgres run migrate
  → 適用したマイグレーション: 0001〜0018（0015_decay_activity_clock.sql を含む）
$ pnpm --filter @mnemora/postgres exec vitest run \
    src/__tests__/conformance.postgres.test.ts -t "getActivitySeq"
  → 3 passed | 309 skipped (312)
```

**変異試験**（`docs/autonomy.md` §2 必須項目。`cp` での退避・復元。`git checkout` は
使っていない）:

1. `PostgresTenantSettingsStore.getActivitySeq` の本体を `return 0;`（常に0を返す）へ
   書き換え、`cp` で退避したオリジナルと差し替えて `pnpm --filter @mnemora/postgres
   run build` → 同じ `-t "getActivitySeq"` を再実行。
   **結果: 3本中2本が赤くなった**（「`advanceActivitySeq` を呼ぶたびに1ずつ進む」
   `expected +0 to be 1`／「テナントごとに独立している」`expected +0 to be 2`）。
   1本目（「行が無いテナントには `0` を返す」）はこの変異の下でも成り立つ値なので
   緑のまま——期待どおり（変異は「0を返す」なので、期待値が0の歯は動かせない）。
2. `cp` でオリジナルへ復元 → `git status --porcelain` が空であることを確認 → 再ビルド
   → 同じコマンドで **3 passed (再び緑に戻ったことを確認)**。

⟹ **この段0 が「既に在る」と主張している読み口（`getActivitySeq`）は、実際に
歯が噛んでいる**——実装を壊せば、宣言どおり赤くなり、直せば緑に戻る。**新しい歯は
足していない**（新しいコードが無いため）——既存の3本がこの主張を守っている。

## 確かめていないこと

- **Issue #338 が実測した「3112回で消える／3113回目で消える」を、この書き手自身は
  再現していない。** ADR 0197 が引用した実測をそのまま前提としている。
- **`recalls` テーブルの実際の行数が、無期限に積んだときどこまで実用的かは測っていない**
  （「検討した代替案」1 (b) で指摘した保持方針の欠落そのものが未測定）。
- **`getActivitySeq` を実際に2点サンプルして頻度を測る運用を、この書き手は一度も
  走らせていない。** 文書化した手順が動くことは、既存の適合テスト（1点の値の読み出し
  が正しいこと）から**推論した**のであって、2点サンプルの差分計算そのものを走らせて
  確かめたわけではない（ただし単純な引き算であり、`getActivitySeq` 自体が正しく
  読めることは上の変異試験で確認済み）。
- **npm から `@mnemora/core`/`@mnemora/postgres` を使っている repo 外の利用者が、
  この読み口を既に別の方法で自作していないか**は確認していない（確認する手段が無い）。
