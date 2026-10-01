# ADR 0479: 穴探し50巡目 — `TenantSettingsStore` の書き込み口。core の `FakeTenantSettingsStore` だけが、他の2実装が拒む値を受けていたので揃える

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-86b4be97 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・文書の直し・フィクスチャの揃え）の中だけを直し、新しく断る入力や既定値の変更に当たるものは「材料」に回した。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 50巡目は `TenantSettingsStore` の書き込み・読み出し口（`setEventRetention`・`setDecayClock`・`setDefaultHalfLifeRecalls`・`getEventRetention`・`getDecayClock`・`getDefaultHalfLifeHours`・`getDefaultHalfLifeRecalls`）を、postgres・testkit の InMemory・core の Fake の3実装で突き合わせた。subject の活動カウンタ・taxonomy・既存の歯と既存 ADR の決定（float4 範囲、保持期間 kind の検査、読むタイミング）は数えない。

- **見つけたこと**【現物】:
  1. `FakeTenantSettingsStore.setEventRetention`（`packages/core/src/__tests__/runtime-fakes.ts`）は `kind` を検査しない。`{ kind: "bogus" }` は `retention.kind === "days" ? … : null` で `null`、つまり**無期限として書かれる**。InMemory と Postgres は `assertValidEventRetentionKind` で拒む（Issue #1168 で直した穴が Fake にだけ残っていた）。
  2. 同じ Fake は `days` の int4 上限を見ない。InMemory は `2^31 - 1` を超えると拒み、Postgres は `integer` 列が `22003` で拒む。
  3. `FakeTenantSettingsStore.setDefaultHalfLifeRecalls` は `Math.fround(x)` が有限かどうかだけを見て、0 に丸まる値（`1e-46`）を受ける。InMemory と Postgres（`assertFitsFloat4`）は拒む。

- **確かめ方**【実測】: 先に歯 `packages/core/src/__tests__/fake-tenant-settings-write-validation.test.ts`（新規、4 件）を書いてコミットし、直す前に走らせて 3 件が落ちることを確かめた（出力は `.mgr-notes/red-before-0479-fake.txt`）。Postgres・InMemory 側の挙動は【現物】（コードと既存の歯）で読んだ。この巡では Postgres を起動していない。

- **決めたこと**【判断】:
  1. Fake の `setEventRetention` に `assertValidEventRetentionKind` と、InMemory と同じ文言の int4 上限（`2^31 - 1` ちょうどは受ける）を足す。
  2. Fake の `setDefaultHalfLifeRecalls` を「`Math.fround` が非有限、または 0」で拒む形にする（InMemory と同じ式）。
  3. 本番コードは変えない。変えたのはテスト用 Fake だけで、公開 API・CHANGELOG・migration-v1 に影響しない。ADR 0434・0466 と同じ、フィクスチャだけの揃えである。

- **歯の確かめ**【実測】: 突然変異 6 本（`.mgr-notes/mutations-0479.txt`）。kind 検査の削除・int4 検査の削除・float4 の 0 判定の削除（足りなすぎ）と、int4 の境界を `>=` にする・上限を 365 にする・0 判定を `< 1` にする（やりすぎ）の全てを歯が落とした。

- **材料（直していない。決めるのはクローンまたはオーナー）**:
  - Fake の `setDefaultHalfLifeRecalls` は値を読み戻しの形（`toFloat4Readback`）にしない。`720.1` を書くと Fake は `720.1`、InMemory も `720.1`（最短表記）、Postgres も `720.1` を返すので今は食い違わない。ただし `toFloat4Readback` は testkit にあり core から使えない。float4 の丸めで値が変わる入力（例: `16777217`）では Fake が元の値、他の2実装が `16777216` を返す。
  - Fake は全メソッドで `assertWellFormedCtx` を呼ばない（空の `tenantId` を受ける）。Fake 全体の方針なので、この巡では触らない。
  - Postgres の `setEventRetention` の `days > 2^31 - 1` は DB の生の例外で、InMemory の明示の文言とは違う。どちらも拒むので受け入れる値は食い違わない。文言を揃えるかは決めていない（ADR 0050 は上限を約束していない）。
  - `getDefaultHalfLifeHours` に対応する書き込み口は無い（ADR 0197）。Fake はコンストラクタ引数、InMemory はテスト用フック、Postgres は直接 SQL でしか変えられない。
