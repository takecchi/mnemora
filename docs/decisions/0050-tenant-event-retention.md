# ADR 0050: `TenantSettingsStore` に event retention の読み書きを足す

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-07

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

---

## 文脈

`docs/roadmap.md` §5.4 にオーナー回答が既に記録されている（2026-09-06、マネージャー経由）:

> 監査ログの既定保持期間は無期限。テナント単位で短縮できる口は「必須」である
> （オーナーが「必須」と明示した）。

**出所: 受け取った前提。** この決定自体は本 ADR より前に、`docs/roadmap.md` の記述として
既に確定していた。本 ADR はその決定を実装で満たす設計判断を記録する。

**出所: 私が読んで確かめた。**

- `packages/postgres/migrations/0001_init.sql` の `tenant_settings` は
  `event_retention_days integer NULL -- NULL = 無期限` を既に持つ（列は在る）。
- `packages/core/src/interfaces/tenant-settings-store.ts`（変更前）は
  `getDefaultHalfLifeHours` しか公開しておらず、自身の doc コメントに
  「テナント設定の完全な CRUD（`event_retention_days`・`taxonomy_mode` の読み書き等）は
  本 PR の範囲外であり、必要になった段階でこのインターフェースを拡張する」と明記していた。
  ⟹ 「拡張する」という宣言そのものが、この口の未実装を認めていた。
- `packages/postgres/migrations/*.sql` を全件確認したが、TRIGGER/RULE/FUNCTION は0件——
  DB 側に `event_retention_days` を書く隠れた経路は無い。
- `tenant_settings` へ書き込む箇所を `event_retention_days`/`eventRetentionDays` で
  全文検索したが、変更前の時点で書き込み経路は**アプリ側にもゼロ**だった
  （`packages/postgres/src/__tests__/conformance.postgres.test.ts` の
  `setDefaultHalfLifeHours` テスト用フックは `default_half_life_hours` だけを書く生 SQL で、
  `event_retention_days` には触れていない）。⟹ マネージャーの見立て「DB 側は0件」は
  正しく、かつアプリ側も0件だった（見立てより広い意味で正しかった）。

## 決定

1. **`TenantSettingsStore` に `getEventRetention`/`setEventRetention` を追加する。**
   `EventRetention` 型で3状態（`unset`/`unlimited`/`days`）を区別して返す——
   `event_retention_days` は「行が無い」「行は在るが `NULL`」「数値」の3状態を持ち、
   前者2つを同じ値に潰すと「まだ設定していないテナント」と「明示的に無期限を選んだ
   テナント」が区別できなくなる（`ADR 0029` が `reextract` の `skipped` で
   `not_examined`/`unchanged` を分けたのと同じ形の失敗を避ける）。

2. **メソッド名を `getEventRetentionDays`/`setEventRetentionDays`（roadmap.md 本文の表記）
   から `getEventRetention`/`setEventRetention` に変える（マネージャー判断）。** 理由:
   返り値は `EventRetention`（`unset`/`unlimited`/`days` のいずれか）であり、常に日数を
   返すわけではない。`...Days` という名前は「常に日数を返す」ことを含意し、**名乗れる
   以上のことを名乗る**——`ADR 0011`/`0025`/`0027`/`0028`/`0034`/`0029` が繰り返し
   問題にしてきた族と同じ形になる。⚠ この改名はオーナーの原文からの逸脱であり、
   オーナーが差し戻す可能性がある。

3. **両メソッドを必須（`?` を付けない）にする。** 理由は2つ:
   - オーナーの決定が「短縮できる口は必須」だから。
   - 任意にすると、「この adapter は短縮できない」（未実装、`?` により型が許す）と
     「短縮に失敗した」（実行時エラー）が呼び出し側から同じ顔になる——interface の
     レベルで両者を区別できなくなる。

4. **`InMemoryTenantSettingsStore`（`packages/testkit`）を「行」を持つ形に作り直す。**
   `overrides = Map<tenantId, number>`（half-life だけの値）のままだと、Postgres の
   実際の振る舞い——`default_half_life_hours` を設定して行ができたテナントは
   `event_retention_days` が `NULL` ⟹ `unlimited`——と食い違う。half-life 用と
   retention 用を別々の Map に分けたままだと、half-life だけ設定したテナントの
   retention が「行が無い」（`unset`）のままになる。⟹
   `rows = Map<tenantId, { defaultHalfLifeHours, eventRetentionDays }>` という単一の
   Map にし、`setDefaultHalfLifeHours`（既存のテスト用フック）も
   `setEventRetention` も同じ「行」を作る側に倒した。`getDefaultHalfLifeHours` の
   振る舞い（行が無ければ `DEFAULT_HALF_LIFE_HOURS`）は変更していない。

5. **`PostgresTenantSettingsStore.setEventRetention` は UPSERT にする。**
   `INSERT ... ON CONFLICT (tenant_id) DO UPDATE SET event_retention_days = ...,
   updated_at = now()`。行が無ければ作るが、`default_half_life_hours`/`taxonomy_mode`
   は指定せず DB 側の `DEFAULT`（720 / `'open'`）に任せる。**マイグレーションは
   足していない**——列は既に在る。

6. **`days` の検査（正の整数のみ）を `assertValidEventRetentionDays` として `packages/core`
   に1箇所だけ持たせ、両実装がそれを呼ぶ。** メッセージは
   `EVENT_RETENTION_DAYS_INVALID_MESSAGE`（`"event retention days must be a positive
   integer"`）に固定し、適合スイートがこれを正規表現で検査する
   （`memory-store-conformance.ts` の `NOT_FOUND_ERROR_MESSAGE` と同じ形）。検査を
   実装ごとに書き直すと、境界（`>= 1` か `>= 0` か）が実装間でずれる余地を作るため、
   1箇所にまとめた。

7. **延長（いまより長い日数への変更）は禁止しない。** オーナーが決めたのは
   「短縮できる口は必須」であり、延長を禁じたとは言っていない。禁止を勝手に作らない
   側に倒した——適合スイートに、短い日数→長い日数の変更が成功することを見る歯を置いた
   （`tenant-settings-store-conformance.ts` の検査テスト末尾）。

8. **削除処理（期限切れの `memory_events` 行を実際に消す処理）は入れない。**
   `docs/memory-model.md` §9「保持方針」が既に置き場所を決めている:

   > この削除処理は `EventStore` interface（アプリケーションコードが通常使う経路）を
   > 経由しない、独立した保守ジョブとして実装する

   本 ADR・本 PR は「保持期間を決められる」口だけを作る。「消す」ジョブ本体は別の PR の
   範囲であり、本 ADR はそれを先取りしない。

9. **歯は適合スイート（`packages/testkit/src/tenant-settings-store-conformance.ts`）に
   置いた。** 個別実装（`packages/postgres`・`packages/testkit`）の spec に置くと、
   片方だけ直せてしまう。`setDefaultHalfLifeHours` フックは既存のまま変更していない
   （half-life 側の形を動かさない）。

## 読み取り専用 adapter を許す含みを、意図して外した

`TenantSettingsStore`（変更前）の `setDefaultHalfLifeHours` は適合テストの
オプションフック（`options.setDefaultHalfLifeHours?`）であり、「将来 setter を持たない
読み取り専用 adapter が来た場合にも壊れないように」という含みを持っていた。
**`getEventRetention`/`setEventRetention` にはこの含みを持ち込まなかった。**
`?` を付けず、両方とも必須メソッドにした——理由は決定3に書いた通り、オーナーが
「短縮できる口は必須」と明示したためである。⟹ 次にこの interface を読む人が
「うっかり必須にした」と読まないよう、ここに明記する。**将来 `TenantSettingsStore` に
読み取り専用の adapter（例えば集計専用のレプリカ）を許す判断が下されたら、それは
本 ADR とは別の新しい判断として扱うこと。**

## 代償: 同じテーブルに2つの作法が並ぶ

`default_half_life_hours` の書き込みは、今日も適合スイートのテスト用フック
（`setDefaultHalfLifeHours`）を経由する生 SQL のままであり、公開 interface のメソッドに
なっていない。一方 `event_retention_days` の書き込みは、本 ADR で公開 interface の
`setEventRetention` になった。**⟹ 同じ `tenant_settings` テーブルの2つの列が、
一方は「テストだけが書ける」・もう一方は「本番のアプリケーションコードが書ける」という
2つの異なる作法で扱われることになる。**

理由: オーナーが「必須」と明示的に決めたのは event retention の短縮口だけである。
`default_half_life_hours` の書き込み口を同時に公開 interface へ昇格させる根拠を、
本 ADR の文脈（roadmap.md §5.4）は持っていない——`taxonomy_mode` も同様に見送った
理由と同じである（決定2の「`taxonomy_mode` を動かす根拠が無い」）。

**⚠ これが最善だとは書かない。** これは「オーナーが明示的に決めた範囲だけを実装し、
決めていない範囲を先取りしない」という制約の下で選んだ道であり、**制約が外れて
`default_half_life_hours` の書き込みも公開 interface で必要だと判断されたら、
そのときは2つの作法を揃える（`setDefaultHalfLifeHours` も interface のメソッドに
昇格させる）ほうが正しい。**

## 歯（適合スイート、`packages/testkit/src/tenant-settings-store-conformance.ts`）

3状態が返り値で区別できることを非対称に測る歯を置いた:

- 行が無いテナント → `{ kind: "unset" }`
- **⭐ `setDefaultHalfLifeHours` だけした（行はできたが retention は未設定の）テナント →
  `{ kind: "unlimited" }`**（3状態が潰れていないことの芯。`unset` と区別できるかを見る）
- `setEventRetention({ kind: "days", days: 30 })` → 読み直しても `{ kind: "days", days:
  30 }`
- `setEventRetention({ kind: "unlimited" })` → `{ kind: "unlimited" }`
  （明示的に無期限へ戻せる）
- 値の検査: `days` が 0 / 負 / 非整数なら `EVENT_RETENTION_DAYS_INVALID_MESSAGE` を含む
  例外。同じ歯の中で、正しい値（短い日数→長い日数、延長）では成功することも見る
  （非対称——「常に失敗する」実装を緑にしないため）。

## 変異（実装ごとに分けて記録）

**基準線**（本 PR 着手前、`main` = `62a48cf` を手元で実測。`set -o pipefail` で
`typecheck && lint && format:check && test && build`）: `EXIT=0`。`root` 7 passed・
`core` 288 passed・`openai` 18 passed + 2 skipped・`testkit` 119 passed。
`DATABASE_URL` 未設定のため DB テストは実行していない。

実装後（変異試験の直前、`typecheck && lint && format:check && test && build` で
`EXIT=0`）: `testkit` は 119 → **124 passed**（新設5本）、他パッケージの件数は変化なし。

### `InMemoryTenantSettingsStore`（`packages/testkit`、対象は `in-memory-fixtures.conformance.test.ts` 経由の適合スイート）

| # | 変異 | 走った歯（testkit） | 結果 |
|---|---|---|---|
| M1 | `getEventRetention` で `unset` と `unlimited` を同じ値（`unlimited`）に潰す | 124件 | **死亡**（1件だけ赤: 「設定行が無いテナントの event retention は unset」。⭐ の歯は元々 `unlimited` を期待しているため無傷） |
| M2 | `setDefaultHalfLifeHours` が「行」を作らないようにする（half-life を別の legacy Map に戻し、`rows` には触れないようにした） | 124件 | **死亡**（1件だけ赤: ⭐「half-life だけを設定した…テナントは unlimited」。`getDefaultHalfLifeHours` 自体は legacy Map から読むようにしたため、既存の「設定済みのテナントにはその値を返す」テストは無傷） |
| M3 | `assertValidEventRetentionDays`（`packages/core`）の境界を `days < 1` から `days < 0` に変える | 124件 | **死亡**（1件だけ赤: 境界の歯「setEventRetention の days は正の整数のみを受け付ける」。`days: 0` が通ってしまうことで検出） |
| M4 | `setEventRetention` が `retention.kind === "days"` のとき検査だけ通して実際には永続化せず、成功したふりをする（`return` で抜ける） | 124件 | **死亡（2件赤）**——「読み直しても同じ日数を返す」の歯と、検査の歯の末尾にある成功パスの読み直し assertion の両方 |

**M4 が1本ではなく2本を赤くした経緯（狭めて撃ち直した記録）**:
最初に「`setEventRetention` を丸ごと no-op にする」変異を撃ったところ3本
（読み直しの歯・`unlimited` へ戻す歯・検査の歯）が赤くなった。`kind === "unlimited"`
の分岐は正しく動いたままにする形に狭めたところ、`unlimited` へ戻す歯（`days` →
`unlimited` の遷移）は偶然どちらの呼び出しも最終的に `unlimited` を書く経路になるため
無傷になり、2本まで絞れた。**残った2本（読み直しの歯・検査の歯の成功パス assertion）は
これ以上狭められない**——検査の歯は設計上「正しい値では成功することを同じ検査の中で見る」
（本 ADR 決定7・非対称の要求）ため、`days` の永続化を壊す変異は必然的にこの2箇所を
同時に踏む。これは歯が弱いのではなく、2つの歯が同じ性質（`days` の書き込みが読み直せる
こと）を意図的に別の文脈（単体の読み直し／検査と同じ歯の中の読み直し）で重複して
測っている結果であり、**壊しすぎではなく設計上の重複**と判断した。

**生存した変異は無い。**

### `FakeTenantSettingsStore`（`packages/core/src/__tests__/runtime-fakes.ts`）

型を満たすためだけに追加した最小実装であり、これを呼ぶ既存テストは無い
（`grep` で確認済み）。`ADR 0047` が明記した構造と同じ理由——`packages/core` 専用の
`Fake*` は `packages/testkit` の適合スイートの対象外——により、ここに変異を撃っても
`packages/core` の既存テストは1本も赤くならないと予想する。**予想であり実測していない**
（実測しても無意味であることが構造から分かるため、実測する歯を新設しなかった。
`ADR 0049` が `fake-reinforce-monotonicity.test.ts` を新設したのとは異なり、
`getEventRetention`/`setEventRetention` を実際に呼ぶ本番経路が `packages/core` に
まだ無いため、専用の歯を新設する動機が今は無いと判断した）。

### `PostgresTenantSettingsStore`（撃てない）

この器に PostgreSQL も Docker も `DATABASE_URL` も無い。**撃っていない。**
`InMemoryTenantSettingsStore` と同じロジック形状（3状態の分岐・UPSERT・共有の
`assertValidEventRetentionDays`）を実装したため、CI の `postgres` ジョブで
`describeTenantSettingsStoreConformance` が同じ歯を通せば同様に検出されるはずである
——**ただしこれは予測であり実測ではない。**

## 採らなかった案

| 案 | 採らない理由 |
|---|---|
| `getEventRetentionDays`/`setEventRetentionDays`（roadmap.md 本文の表記のまま） | 返り値が常に日数とは限らない（`unset`/`unlimited` もありうる）ため、名乗れる以上のことを名乗る。マネージャー判断で改名した（本文参照。オーナーの差し戻しの可能性あり） |
| `getEventRetention`/`setEventRetention` を任意（`?` 付き）にする | オーナーが「必須」と決めた口を任意にすると、「未実装」と「実行時エラー」が同じ顔になる（決定3参照） |
| `event_retention_days` の削除処理（期限切れ行の物理削除）も本 PR に含める | `docs/memory-model.md` §9 が既に「独立した保守ジョブ」という別の置き場所を決めている。本 PR は「決められる」口だけを作る |
| 短縮のみ許可し、延長を拒む | オーナーは「短縮できる口は必須」と言っただけで延長を禁じていない。禁止を勝手に作らない |
| `InMemoryTenantSettingsStore` の half-life 用 Map と retention 用 Map を別々のまま残す | Postgres の実際の振る舞い（1つの行に両方の列がある）と食い違う。`M2` が示す通り、この分離自体が3状態を潰すバグの温床になる |
| `default_half_life_hours` の書き込みも同時に公開 interface のメソッドに昇格させる | オーナーが「必須」と決めたのは event retention の短縮口だけであり、half-life 側を動かす根拠が本 ADR の文脈に無い（「代償」節参照） |

## 引き受けた負債

- **同じ `tenant_settings` テーブルに2つの書き込み作法が並ぶ**
  （`default_half_life_hours` はテスト用フック経由の生 SQLのみ、`event_retention_days`
  は公開 interface）。「代償」節参照。制約が外れれば揃えるほうが正しい。
- **`FakeTenantSettingsStore` の新メソッドを検査する専用の歯が無い。** 本番経路が
  まだこれを呼ばないため今は動機が薄いが、`runtime.ts` が将来 event retention を
  読み書きする経路を持ったら、`ADR 0047`/`0049` と同じ形で専用テストを新設する必要が
  ある。
- **Postgres 側は実測していない。** CI の `postgres` ジョブが唯一の実行環境。

## これが覆るとしたら

- オーナーが `getEventRetentionDays`/`setEventRetentionDays` という名前に戻すよう
  指示したら、決定2のメソッド名を戻す。
- `default_half_life_hours` の書き込みを公開 interface のメソッドに昇格させる判断が
  下されたら、「代償」節に書いた非対称は解消できる。
- `taxonomy_mode` の読み書きが必要になったら、この interface をさらに拡張することに
  なる（当初の doc コメントが予告していた通りの形）。
- `docs/memory-model.md` §9 の削除ジョブ（独立した保守ジョブ）が実装される PR が、
  `getEventRetention` をどう呼ぶか（テナント一覧を回すのか、`unset` のテナントを
  どう扱うか）によって、`EventRetention` 型の設計を見直す必要が出るかもしれない。
