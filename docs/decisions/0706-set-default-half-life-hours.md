# ADR 0706: テナントの既定の半減期（時間）を設定する口 `setDefaultHalfLifeHours` を足す

- **状態**: 採用 (2026-11)
- **日付**: 2026-11-10

出所は、対話セッションでの利用者（オーナーの `takecchi` のアカウントで作業を承認している本人）の依頼「残ってる課題に着手してください」。課題として挙げていたのは「`default_half_life_hours` を設定する公開の口が無い」である（[ADR 0699](./0699-long-horizon-recall-bench.md) の調査、[ADR 0700](./0700-default-time-weighting-event-aware-freshness.md) の「引き受けた負債」）。Issue [#2117](https://github.com/takecchi/mnemora/issues/2117)。オーナー本人かどうかは、セッションの中からは確かめていない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

**⚠ この ADR の番号は仮である。** マージの直前に `node scripts/adr-renumber.mjs` が確定する（[ADR 0179](./0179-adr-number-assigned-at-merge.md)）。

## 文脈【現物】

- `TenantSettingsStore` には `getDefaultHalfLifeHours` しか無かった。`setDecayClock`・`setDefaultHalfLifeRecalls` はある。半減期（時間）を変えるには、生 SQL で `tenant_settings` を書くしかなかった。この repo の適合テストの wiring（Postgres）も生 SQL だった。
- [ADR 0197](./0197-set-default-half-life-recalls.md) は、この setter を「壁時計側の既定値の与え方がオーナー判断で決まったら、`setDefaultHalfLifeRecalls` と同じ形で足す」として見送っていた（「これが覆るとしたら」2）。
- 半年の実測（ADR 0699・0700）で、一度も話題に出ない事実は既定の半減期（720時間）のもとで1〜3か月で返らなくなった。利用者が「このテナントは半減期を延ばす」と決めても、手段が無かった。

## 何を決めたか【判断】

1. **`TenantSettingsStore` に任意のメソッド `setDefaultHalfLifeHours?(ctx, hours): Promise<void>` を足す。**形は `setDefaultHalfLifeRecalls` と同じで、UPSERT で行が無ければ作る。
2. 値域は `isHalfLifeHoursInRange`（`(0, ∞)`、ADR 0125）である。外れた値は `HALF_LIFE_HOURS_INVALID_MESSAGE` を含む `Error` で拒む（新設の `assertValidHalfLifeHours`。両実装が呼ぶ）。float4 に収まらない値も、DB の生の例外ではなく明示の例外で拒む。
3. **効くのは呼び出し後に作られる記憶だけ**とする。既存の記憶の `halfLifeHours`・`decayFloorAt` は書き換えない（`setDefaultHalfLifeRecalls` と同じ。ADR 0165 決めたこと3）。
4. testkit の fixture `InMemoryTenantSettingsStore` には、同名の同期のテスト用フック `(tenantId: string, hours): void` があった。これを、`Ctx` を受けると interface の口として動き（不正な値は reject）、文字列を受けると従来どおり（不正な値は同期的に投げる）動く形にした。戻り値は `Promise<void>` だが、どちらの形でも返る前に書き終わっている。
5. 適合テストの wiring を、Postgres・fixture とも本番の口を呼ぶ形に替えた。既存の歯（往復・別テナント・値域の外の拒否）が、本番の検証ロジックを検査するようになった。

既定値 `DEFAULT_HALF_LIFE_HOURS = 720` は変えない。

## 互換性

- 任意のメソッドの追加なので、実装していない adapter はそのまま適合する。
- ⚠ 自前の `TenantSettingsStore` が**同じ名前で別の形のメソッド**を持っていると、型が合わなくなる（この repo のテスト用の最小の store が `void` を返していて、`async` に直した）。`docs/migration-v1.md` に書いた。
- DB マイグレーションは無い（列は 0001 から在る）。

## 採らなかった案

- **既存の記憶にも新しい半減期を当てる（再計算する）。**`decayFloorAt` の書き換えがテナント全体に及ぶ。ADR 0197 の「これが覆るとしたら」1 と同じく、必要が実測で出たときに別の口として足す。
- **fixture のテスト用フックの名前を変える。**利用者のテストが壊れる。両方の形を受ける形で済む。

## 確かめたこと【実測】

- Postgres `set-default-half-life-hours.postgres.test.ts`（7件）: 設定と上書き、既存の記憶を書き換えないこと、値域外の4値、float4 の外。
- 適合テストの TenantSettingsStore の歯（Postgres 45件・fixture 全体）が、本番の口を通して緑。
- 変異試験: Postgres 側の値域の検査を外すと4件が赤になり、戻すと緑に戻った。

## これが覆るとしたら

- 既存の記憶にも効かせる必要が実測で出たとき（上の「採らなかった案」1）。
