# Changelog

このファイルは [Keep a Changelog](https://keepachangelog.com/) の形式に倣う。
**手で書く**（tag や commit ログからの自動生成ではない）。理由と、版の権威が
Release の tag にあるという既存の決定（[ADR 0070](./docs/decisions/0070-version-comes-from-the-release-tag.md)）
との関係は [ADR 0169](./docs/decisions/0169-changelog-hand-curated.md) を見ること。

## 過去のバージョンについて

**v0.1.0 〜 v0.1.9 の変更は、このファイルには書き起こしていない。**
[GitHub Releases](https://github.com/takecchi/mnemora/releases) の各 tag を参照すること
（理由: [ADR 0169](./docs/decisions/0169-changelog-hand-curated.md) 決定4）。

⚠ **このファイルの初版と ADR 0169 決定4 は「v1.0.0 以降を対象とする」と書いていた。**
そう書いた時点では、次に出る Release が `v1.0.0` になる見込みだった。**実際に出たのは
2026-09-16 の `v0.2.0` である**（tag が指すのは `c52be47`）。⟹ **このファイルが実際に
対象としているのは `0.2.0` 以降である。**書き起こさない範囲（v0.1.0 〜 v0.1.9）は
決定4 のまま変えていない。⛔ **ADR 0169 の本文は当時の記録なので書き換えていない**
（`AGENTS.md`）。

## 何を載せるか

**利用者に見える変更だけを載せる。** docs のみの PR・内部スクリプトの修正・ADR 索引の
再生成・テスト追加のみの PR は載せない——GitHub が自動生成する Release notes（全 PR を
無差別に列挙する）との意図的な違いである。各項目は1〜2行の要約と ADR/Issue へのリンクに
留め、詳細は複製しない（`AGENTS.md` の反重複規律）。

⭐ **`[0.3.0]` 以降は、publish 対象のパッケージの変更だけを載せる。**出所は
`scripts/publish-targets.mjs` の `PUBLISH_TARGETS` である（⛔ **本数も名前もここに写さない**
——`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。⟹ **`examples/chat` は `private` であり、
出荷される面の外なので載せない。**

⚠ **これは途中で変わった形である。**【現物】`[0.2.0]` 節は `### Added` に `examples/chat` の
項目を2つ持っている（`memory_usage` 報告の実践 / 想起経路が連想枠を既定で使うようになった）。
⛔ **その2項目は書き換えていない**——当時の記録である（`AGENTS.md`）。
⟹ ⭐ **`[0.3.0]` 以降で `examples/chat` の変更が載っていないのは、書き漏れではなく方針である。**
理由・採らなかった案・引き受けた負債は
[ADR 0243](./docs/decisions/0243-changelog-lists-publish-targets-only.md)。

---

## [1.0.0] - 未リリース

⛔ **`v1.0.0` の tag はまだ切られていない。**

**この節は `v0.4.0` からの差分を対象とする。**⭐ **`v0.3.0` → `v0.4.0` の分は、下の `[0.4.0]` 節に在る**
——⛔ **この節へ混ぜない。**⟹ **この節に並ぶものは、1件も出荷されていない。**

⭐ **数えた基準を明記する。**この節は `v0.4.0` … **`420e0f4`** の範囲を数えたものである。
⭐ **この sha が名乗るのは「この節がどこまで数えたか」であって、「ここで打ち切った」ではない。**
⟹ ⭕ **`origin/main` がこれより進んでいても、この節は腐っていない**——**まだ数えていない範囲が
増えただけである。**読む人は `git log --oneline 420e0f4..origin/main` で、その増分を自分で見られる。
🔴 **この性質が成り立つのは、この節が件数を持たないからである。**
⛔ **ここに件数を書かないこと**——書いた瞬間、次の1件が着地した時点で腐る
（[#433](https://github.com/takecchi/mnemora/issues/433) /
[ADR 0234](./docs/decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。
**数えるなら、下の項目そのものを数えること。**
⚠ **この pin は `scripts/release-candidates.mjs` の入力でもある**
（[ADR 0214](./docs/decisions/0214-release-candidates-lists-not-judges.md) 決定5。⛔ 道具は書き換えない）。

### ⭐ この pin の時点で、載せる変更は見つかっていない

**【実測 2026-09-19、`origin/main` = `420e0f4`】**

```
$ git rev-list --count v0.4.0..420e0f4                                  → 1
$ git diff --stat v0.4.0..420e0f4 -- scripts/__snapshots__/public-api/  → （差分なし）
$ git diff --stat v0.4.0..420e0f4 -- packages/postgres/migrations/      → （差分なし）
```

範囲内の1件は `test(scripts)`（PR #546）であり、**このファイルが載せると決めている
「利用者に見える変更」に当たらない**（上の「何を載せるか」／
[ADR 0243](./docs/decisions/0243-changelog-lists-publish-targets-only.md)）。

⛔ **これを「`v1.0.0` には何も載らない」と読まないこと。**⭐ **pin より後は、まだ数えていない。**
⟹ `v1.0.0` を切る側は、**切る直前にこの pin から数え直すこと**
（道具は `node scripts/release-candidates.mjs --since v0.4.0`。
⚠ **`--since` を省くと最新リリースの tag が入るので、この pin と一致するとは限らない**）。

⭐ **「`v1.0.0` へ上げるときに何が壊れるか」の正本は
[docs/migration-v1.md](./docs/migration-v1.md) である**——**あちらは世代ごとに分けてある。**
🔴 **`v0.3.0` からの利用者が受ける破壊的変更は、この節ではなく下の `[0.4.0]` 節に在る**
——**`v0.4.0` で出荷済みだからである。**

⚠ **`v1.0.0` をいつ切るかは、この節を書いた時点で決まっていない。**7項目の現在地は
[docs/roadmap.md](./docs/roadmap.md) **§7.15** に在る（⚠ **§7.13 ではない**——§7.15 が、
§7.13 の本文を書き換えずに後から決まったことを積んでいる）。
**Release 本文の草稿は [docs/release-notes-v1.0.0.md](./docs/release-notes-v1.0.0.md) に在る。**
⛔ **どちらも件数をここへ写さない**——正は各文書である。

---

## [0.4.0] - 2026-09-19

**Release**: [v0.4.0](https://github.com/takecchi/mnemora/releases/tag/v0.4.0)（pre-release ではない）。
**tag が指すのは `3cf2663`**、**前の版は `v0.3.0`**（`6851629`）。⟹ **この節は
`v0.3.0` → `v0.4.0` の差分である**（【実測】`git rev-list --count v0.3.0..v0.4.0` = 27）。
⚠ **published は `2026-09-18T20:36:04Z`（UTC）である**——**見出しの日付は JST**（この repo の
commit の日付と同じ `+0900`）。⟹ **UTC で読むと1日ずれる。**

⚠ **GitHub の Release `v0.4.0` の本文は自動生成であり、27 commit を無差別に1行ずつ
並べたものである**【実測】（`gh release view v0.4.0 --json body -q .body | grep -c '^\* '` = 27）。
⟹ ⭐ **分類も、docs のみ・テストのみの除外も、この節が初めて与える。**

🔴 **この節は、出荷に遅れて起こしたものである。**`v0.4.0` が published された時点では、
中身は `[1.0.0]`（未リリース）の節に置かれたままで、同節は逐語で「**この節に並ぶものは、
1件も出荷されていない**」と名乗っていた。⚠ **同じ形の遅れは `v0.3.0` でも起きている**
（[Issue #536](https://github.com/takecchi/mnemora/issues/536) /
[ADR 0243](./docs/decisions/0243-changelog-lists-publish-targets-only.md)）⟹ **2回目である。**
経緯と、3回目を防ぐ手の検討は
[ADR 0248](./docs/decisions/0248-changelog-and-migration-guide-follow-the-release.md)。

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更は `@mnemora/core` / `@mnemora/testkit` の2本に在る**
（`@mnemora/postgres` / `@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding` に
破壊的変更は無い）。

**postgres 利用者へ**: 新しいマイグレーション（`0018`）が増えている。
⟹ **`v0.3.0` から上げるなら `pnpm --filter @mnemora/postgres run migrate` が要る。**
🔴 **「新機能を使うときだけ要る」ものではない**——理由と適用手順は
[docs/migration-v1.md](./docs/migration-v1.md) を見ること。このファイルには複製しない。

### Breaking

⭐ **6件である。**⭕ **`v0.3.0` と `v0.4.0` の両端が tag で閉じているので、`main` が動いてもこの数は変わらない。**
⚠ **正本は [docs/migration-v1.md](./docs/migration-v1.md) の番号付き一覧の 12〜17 であり、
下の表はその写しである**——**`#` 欄はあちらの通し番号で、この表の中での連番ではない。**

⚠ **壊れ方は2つの形に分かれる。**

**1つ目は「`interface` に必須メンバが増えた」形**（項目 **12**〜**16**）。
⟹ ⭕ **`createRuntime()` が返すものを使っているだけなら、何もしなくてよい。**
壊れるのは、**自分で `Runtime` を実装している側**と、**`@mnemora/testkit` の適合テストを
呼んでいる側**だけである。⚠ これは新しい判定基準ではない——`[0.2.0]` の Breaking 表
**1**・**5**・**6** が同じ理由で破壊的と数えられている。

🔴 **2つ目は「union に値が増えた」形**（項目 **17**）。⟹ **壊れるのは実装する側ではなく、消費する側である。**
⭕ **値を読むだけ・比較するだけなら非破壊**——`never` で網羅性を検査しているコードだけが壊れる。
⚠ これも新しい判定基準ではない——`[0.2.0]` の Breaking 表 **4** が同じ形で数えられている。

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 12 | `Runtime` に必須メソッド `restoreSuperseded` が増えた（`@mnemora/core`） | `Runtime` を自分で実装している側だけ。`createRuntime()` が返すものを使っているなら影響なし | [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md) / [#369](https://github.com/takecchi/mnemora/issues/369)（PR #464）。⚠ **ADR 0230 の本文だけを読むと、これが破壊的であることに気づけない**——2026-09-18 に冒頭への追記で名指しされた |
| 13 | `MemoryStoreConformanceOptions.supportsRestoreSupersededBy` が必須フィールドになった（`@mnemora/testkit`）。**12 と同じ PR #464 で入っている** | `describeMemoryStoreConformance` を呼んでいる側だけ | [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md)（PR #464）。🔴 **この項目は 2026-09-18 まで、CHANGELOG にも ADR にも一度も書かれていなかった** |
| 14 | `Runtime` に必須メソッド `findCorrectionCandidates` が増えた（`@mnemora/core`） | **12 と同じ** | [ADR 0232](./docs/decisions/0232-correction-candidates-returned-not-chosen.md) / [#369](https://github.com/takecchi/mnemora/issues/369)（PR #517） |
| 15 | `MemoryStoreConformanceOptions.supportsPreviewRestoreSupersededBy` が必須フィールドになった（`@mnemora/testkit`） | **13 と同じ** | [ADR 0237](./docs/decisions/0237-restore-superseded-dry-run-preview.md) / [#515](https://github.com/takecchi/mnemora/issues/515)（PR #524） |
| 16 | `Runtime` に必須メソッド `applyCorrection` が増えた（`@mnemora/core`）。`findCorrectionCandidates` が返した候補の中から**人が選んだ1件**を受け取り、`markContested` → `resolveContested` の書き込みまでを1つの口にまとめる | **12 と同じ** | [ADR 0242](./docs/decisions/0242-runtime-apply-correction.md) / [#369](https://github.com/takecchi/mnemora/issues/369)（PR #537） |
| 17 | 🔴 `MemoryEventKind` の union に `"unsuperseded"` が増えた（`@mnemora/core`）。**12・13 と同じ PR #464 で入っている** | ⚠ **届く経路は `EventStore` である**——`MemoryEvent.kind` は必須フィールドで、`EventStore.append`/`.get`/`.list` が返す。⟹ ⭕ **`Runtime` の口からは届かない**ので、**5つの動詞だけを使う利用者には影響しない。**⚠ **同じ形に対する扱いがこの repo に2つ在り、線は引かれていない**——[#541](https://github.com/takecchi/mnemora/issues/541) を見ること | [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md)（PR #464） |

⚠ **移行手順は複製しない**——直し方は
[docs/migration-v1.md](./docs/migration-v1.md) の同じ番号の項目を見ること。

### Added

- **`Runtime.restoreSuperseded`**（および `MemoryStore.restoreSupersededBy` — **任意**メソッド）。
  `superseded` になった Memory を `active` へ戻す**復旧口**。粒度は群単位で、
  `target: { supersededById }`（置き換えた側の id）で指定する
  （[#369](https://github.com/takecchi/mnemora/issues/369) /
  [ADR 0230](./docs/decisions/0230-restore-superseded-recovery-path.md)、PR #464）。
  ⚠ **これは北極星 項目5（間違いを正すと、古いほうが先に出てこなくなる）を満たすものではない**——
  訂正の口そのものは入っていない
- **`restoreSuperseded` の dry-run**（および `MemoryStore.previewRestoreSupersededBy` — **任意**メソッド）。
  **戻す前に、何が戻るかを返す**（[#515](https://github.com/takecchi/mnemora/issues/515) /
  [ADR 0237](./docs/decisions/0237-restore-superseded-dry-run-preview.md)、PR #524）
- **`Runtime.findCorrectionCandidates`** — 訂正の相手の**候補を返す**口。
  ⛔ **mnemora は選ばない。書き込みを1件もせず、LLM を1回も呼ばない**
  （[ADR 0232](./docs/decisions/0232-correction-candidates-returned-not-chosen.md)、PR #517）
- **`Runtime.applyCorrection`** — 訂正の**選択**の段を、出荷される面へ持ち上げた口。
  ⭐ **選ぶのは人である**——候補を返す `findCorrectionCandidates` と、書き込む
  `markContested`/`resolveContested` のあいだを繋ぐ
  （[ADR 0242](./docs/decisions/0242-runtime-apply-correction.md)、PR #537）
- **`CassetteRecorder.lookupLLM` / `lookupEmbedding`**（`@mnemora/testkit`）— 記録した
  カセットを照会する口。⭕ **追加のみで後方互換**
  （[ADR 0233](./docs/decisions/0233-answer-quality-measured-once-against-the-real-api.md)、PR #514）

---

## [0.3.0] - 2026-09-17

**Release**: [v0.3.0](https://github.com/takecchi/mnemora/releases/tag/v0.3.0)（pre-release ではない）。
**tag が指すのは `6851629`**、**前の版は `v0.2.0`**（`c52be47`）。⟹ **この節は
`v0.2.0` → `v0.3.0` の差分である**（【実測】`git rev-list --count v0.2.0..v0.3.0` = 101）。

⚠ **GitHub の Release `v0.3.0` の本文は自動生成であり、101 commit を無差別に1行ずつ
並べたものである**【実測】（`gh release view v0.3.0 --json body -q .body | grep -c '^\* '` = 101）。
⟹ ⭐ **分類も、docs のみ・テストのみの除外も、この節が初めて与える。**

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更は `@mnemora/core` / `@mnemora/testkit` / `@mnemora/local-embedding` の3本に在る**
（`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/postgres` に破壊的変更は無い）。
🔴 **⚠ `@mnemora/local-embedding` を落とさないこと**——この repo は 2026-09-18 まで
「`@mnemora/local-embedding` に破壊的変更は無い」と書いており、**それは誤りだった**
（[Issue #532](https://github.com/takecchi/mnemora/issues/532)）。

**postgres 利用者へ**: 新しいマイグレーション（`0016`/`0017`）が増えている。
⟹ **`v0.2.0` から上げるなら `pnpm --filter @mnemora/postgres run migrate` が要る。**
適用手順・破壊的変更ごとの対応方法は [docs/migration-v1.md](./docs/migration-v1.md) を見ること
——このファイルには詳細を複製しない。

### Breaking

⭐ **4件である。**⭕ **`v0.2.0` と `v0.3.0` の両端が tag で閉じているので、`main` が動いてもこの数は変わらない。**
⚠ **正本は [docs/migration-v1.md](./docs/migration-v1.md) の番号付き一覧の 8〜11 であり、
下の表はその写しである**——**`#` 欄はあちらの通し番号で、この表の中での連番ではない。**

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 8 | `InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls`（`@mnemora/testkit`）の署名が `(tenantId: string, recalls: number): void` → `(ctx: Ctx, recalls: number): Promise<void>` へ変わった。ADR 0197 が `TenantSettingsStore` に同名の**本番**メソッドを足して名前が衝突したため、テスト専用フックのほうを消した | 🔴 **旧署名で呼んでいた側。⛔ 引数を直すだけでは足りない**——同期から `Promise` へ変わったので `await` が要る。構築して渡すだけなら影響なし | [ADR 0197](./docs/decisions/0197-set-default-half-life-recalls.md)（PR #416） |
| 9 | `FilteredOmission` に必須フィールド `scopeRelation` が増えた（`@mnemora/core`）。`decayed` だけが `totalInScope` の**内側**を数えるという非対称を、契約として明示するもの | **返り値の型なので、読むだけの利用者には非破壊。** `FilteredOmission` を自分で組み立てている側（独自 adapter の `aggregateScope` 実装・テストダブル）だけ | [ADR 0174](./docs/decisions/0174-filtered-omission-scope-relation.md) / [#352](https://github.com/takecchi/mnemora/issues/352)（PR #376） |
| 10 | `Omission` の `over_limit` に必須フィールド `stage` が増えた（`@mnemora/core`）。連想枠（段3.5）の `maxCount` 切り捨てを段1 の打ち切りと区別して名乗るため | **9 と同じ形**——`omission.count` を読むだけなら非破壊。`OverLimitOmission` を自分で組み立てている側だけ | [ADR 0188](./docs/decisions/0188-association-over-limit-omission.md) / [#375](https://github.com/takecchi/mnemora/issues/375)（PR #391） |
| 11 | 🔴 `LocalEmbeddingPipeline`（`@mnemora/local-embedding`）が呼び出し可能な関数型から、`countTokens` / `embed` / `maxInputTokens` を要求する必須 `interface` になった | 🔴 **呼んでいる側と、自前で渡していた側の両方**——この4件で唯一「呼ぶだけの側も壊れる」形である。⛔ **渡すものの形そのものが変わっている** | [ADR 0205](./docs/decisions/0205-local-embedding-pipeline-required-interface.md) / [#137](https://github.com/takecchi/mnemora/issues/137)（PR #446） |

⚠ **`@mnemora/core` だけを見て数えると、8 と 11 が落ちる**——`@mnemora/testkit` と
`@mnemora/local-embedding` も publish 対象である。
⚠ **移行手順は複製しない**——直し方は [docs/migration-v1.md](./docs/migration-v1.md) の
同じ番号の項目を見ること。

### Changed（後方互換だが挙動が変わりうる）

- **`ann_unreached` が「窓が満杯のときにも」鳴るようになった。**従来は
  `annHits.length < kPrime` のときだけ鳴っていたため、**近似索引が取りこぼしたのに窓は満杯**
  という場合に沈黙していた（[ADR 0193](./docs/decisions/0193-ann-unreached-covers-full-window.md)、PR #399）。
  ⟹ 北極星「知らないことを、知らないと言える」の穴を1つ塞いだ
- **`sweepArchive` が `opts.clock` 省略時に `tenant_settings.decay_clock` へ従うようになった。**
  従来は掃引だけが常に壁時計で動いていたため、`decay_clock = activity`/`either` を選んだ
  テナントで「想起では生きている記憶が archive される」ことがあった
  （[#364](https://github.com/takecchi/mnemora/issues/364) /
  [ADR 0186](./docs/decisions/0186-sweep-archive-follows-decay-clock.md)、PR #379）
- **語彙チャンネルの `search()` に決定的な最終キーが入った。**同点の候補の順序が
  呼び出しごとに変わりうる状態を解消（[#345](https://github.com/takecchi/mnemora/issues/345) /
  [ADR 0175](./docs/decisions/0175-lexical-search-tiebreak-nondeterminism.md)、PR #390）
- **`PostgresVectorStore.upsert` が、閾値を越えたときだけ埋め込み表を `ANALYZE` するようになった。**
  新しい埋め込み空間へ大量投入した直後は統計が無く、**HNSW 索引が選ばれない窓**が在った
  （[#360](https://github.com/takecchi/mnemora/issues/360) /
  [ADR 0194](./docs/decisions/0194-embedding-space-analyze-threshold.md)、PR #406）。
  ⭕ **公開 API は変わっていない**——変わるのは実行計画である
- **`memories` への書き込み経路にも、同じ閾値つき `ANALYZE` のフックが入った**
  （[#269](https://github.com/takecchi/mnemora/issues/269) /
  [ADR 0221](./docs/decisions/0221-memories-analyze-on-write.md)、PR #492）。
  ⚠ **`supersedeWithNewMemories` だけが取り残されていたので、後から塞いだ**
  （[ADR 0225](./docs/decisions/0225-supersede-with-new-memories-analyze-hook.md)、PR #502）

### Added

- **`TenantSettingsStore.setDefaultHalfLifeRecalls`**（**任意**メソッド）。テナント既定の
  半減期を「recall 回数」で設定する本番の経路
  （[ADR 0197](./docs/decisions/0197-set-default-half-life-recalls.md)、PR #416）。
  ⭕ **任意メソッドなので、この追加そのものは後方互換**——実装していない adapter は従来どおり動く。
  ⚠ **ただし同じ PR #416 は破壊的変更も1件持っている**（上の表の **8**）。
  ⟹ **「任意メソッドだから丸ごと後方互換」と読まないこと。**
- **`OutboxStoreConformanceOptions.supportsRealConcurrency`**（`@mnemora/testkit`、**任意**フィールド）。
  adapter 作者が「同時 `claimBatch` を本物の並行で検査してよいか」を自己申告できる
  （[ADR 0206](./docs/decisions/0206-outbox-concurrent-claim-conformance.md)、PR #450）

### Fixed

- **`recall()` の返り値で `memories` と `omitted` が排他であることを、契約として明示して直した。**
  同じ Memory が両方に現れうる状態を塞いだ（[#421](https://github.com/takecchi/mnemora/issues/421) /
  [ADR 0203](./docs/decisions/0203-memories-omitted-exclusivity.md)、PR #435）。
  ⭕ **公開型は変えていない**——変わったのは返る中身である

---

## [0.2.0] - 2026-09-16

**Release**: [v0.2.0](https://github.com/takecchi/mnemora/releases/tag/v0.2.0)（pre-release ではない）。
**tag が指すのは `c52be47`**、**前の版は `v0.1.9`**（`6c9d101`）。⟹ **この節は
`v0.1.9` → `v0.2.0` の差分である**（【実測】`git rev-list --count v0.1.9..v0.2.0` = 30）。

対象パッケージの公開範囲: `@mnemora/core` / `@mnemora/testkit` / `@mnemora/postgres` /
`@mnemora/openai` / `@mnemora/anthropic` / `@mnemora/local-embedding`。
**破壊的変更はすべて `@mnemora/core` と `@mnemora/testkit` に限られる**
（`openai`/`anthropic`/`local-embedding` の `src` に v0.1.9 からの差分は無い。【実測】
`git diff --stat v0.1.9..v0.2.0 -- packages/openai/src packages/anthropic/src packages/local-embedding/src`
が空を返す）。

**postgres 利用者へ**: 新しいマイグレーション（`0013`/`0014`/`0015`）が増えている。
適用手順・破壊的変更ごとの対応方法は [docs/migration-v1.md](./docs/migration-v1.md) を見ること
——このファイルには詳細を複製しない。

### Breaking

| # | 変更 | 誰が影響を受けるか | 根拠 |
|---|---|---|---|
| 1 | `MemoryStore.getRecall` が必須メソッドとして追加された。 | `MemoryStore` を自前実装している adapter 作者 | [ADR 0155](./docs/decisions/0155-recall-score-breakdown-persisted.md) |
| 2 | `NewRecallRecord.returnedMemoryIds: MemoryId[]` を削除し、`returnedMemories: RecallRecordMemory[]` に置き換えた。 | `createRecall` を呼ぶ側・実装する側の両方 | [ADR 0155](./docs/decisions/0155-recall-score-breakdown-persisted.md) |
| 3 | `ScopeAggregate` に必須フィールド `filteredExpired`/`filteredNotYetValid` が増えた。 | `aggregateScope` を自前実装している adapter 作者 | [ADR 0164](./docs/decisions/0164-valid-from-until-recall.md) |
| 4 | `FilteredOmission.condition` の union に `"expired"`/`"not_yet_valid"` が増えた。 | 消費するだけなら非破壊。**`never` で網羅性を検査しているコードは壊れる** | [ADR 0164](./docs/decisions/0164-valid-from-until-recall.md) |
| 5 | `Runtime.getRecall` が必須メソッドとして追加された。 | `Runtime` を自前実装している側。⚠ 根拠 ADR に破壊性の言及が無い——[移行ガイド](./docs/migration-v1.md)を必ず見ること | [ADR 0161](./docs/decisions/0161-runtime-get-recall.md) |
| 6 | `TenantSettingsStoreConformanceOptions.supportsDecayClock`（`@mnemora/testkit`）が必須フィールドとして追加された。 | `describeTenantSettingsStoreConformance(...)` を呼んでいる adapter 作者。⚠ 根拠 ADR は当初「非破壊」と誤記載していたが訂正済み | [ADR 0165](./docs/decisions/0165-decay-activity-clock.md) |
| 7 | `RecallFootprintEstimate.associationCount`（`@mnemora/core`）が必須フィールドとして追加された。 | **返り値の型なので、読むだけ・呼ぶだけの利用者には非破壊。** `RecallFootprintEstimate` を自前で構築している側だけが影響を受ける。入力側（`estimateRecallFootprint`）は省略可能フィールドとして追加されており非破壊（省略時は `?? 0`）。（【実測】`packages/core/src/recall-footprint.ts:392` が必須、入力側の `RecallFootprintShape.associationCount` は `:368` で省略可能、既定は `:463` の `?? 0`） | ADR 0166 |

### Changed（後方互換だが挙動が変わりうる）

- **`RecallQuery.validAt` ゲートが既定で有効になった**（opt-out は `includeOutsideValidity: true`）。
  **影響を受けるのは、v0.1.9 で `MemoryStore.createMemory` を直接呼んで `validFrom`/`validUntil`
  に non-null を書いていた利用者だけ**——`Runtime.observe` 経由ではこれらの列に値を
  書く経路が v0.1.9 には無かったため、通常の利用者には影響しない。
  ([ADR 0164](./docs/decisions/0164-valid-from-until-recall.md))
- **`TICK_SUPPORTED_JOB_KINDS` が2値から4値へ増えた**（`consolidate`/`reflect` を追加）。
  値を消費するだけなら非破壊だが、**網羅性検査（`never`）をしているコードは壊れる。**
  ([ADR 0157](./docs/decisions/0157-tick-drives-consolidate-and-reflect.md))
- **`PostgresVectorStore.search` の `ORDER BY` に `memory_id` の tie-break が追加された。**
  距離が完全一致した候補の順序が決定的になった（以前は未定義）。
  ([ADR 0167](./docs/decisions/0167-association-getvectors-order-nondeterminism.md))
- **連想枠の非決定性は、上の修正だけでは消えていなかった（第2段）。** `search()` が返す
  候補に距離の完全一致タイが在ると、`memory_id` による tie-break が取り込みのたびに
  揺れていた。段1と段2の両方で順序を決定的にして直した（Issue #339）。
  ([ADR 0170](./docs/decisions/0170-association-search-tiebreak-nondeterminism.md))

### Added

- **`Runtime.getRecall(ctx, recallId)`** — `recall()` を離れた後でも、`recallId` から
  スコア内訳・`retrievedVia`・`companionOf`/`associationOf` を読み戻せる。
  ([ADR 0161](./docs/decisions/0161-runtime-get-recall.md))
- **`memory_usage` 報告の実践**（`examples/chat`）— プロンプトへ積んだ Memory を
  `observe({ kind: 'memory_usage' })` で伝え返し、`reinforce` を実アプリで発火させる。
  ([ADR 0163](./docs/decisions/0163-memory-usage-reporting-example-chat.md))
- **`validAt` ゲート** — 「この時刻において真だった記憶」を問える。`expired`/`not_yet_valid`
  を `omitted` で名指しする。([ADR 0164](./docs/decisions/0164-valid-from-until-recall.md))
- **減衰の時計を2本持てる（`decay_clock`）** — 壁時計（`wall`、既定）に加え、活動時計
  （`activity`）・両方（`either`）をテナントごとに選べる。低頻度利用のテナントが
  一律に沈むのを避けられる。([ADR 0165](./docs/decisions/0165-decay-activity-clock.md))
- **`estimateRecallFootprint` が連想枠の分も見積もれる** — 入力
  `RecallFootprintShape.associationCount?`（**省略可能**）を渡すと、返り値に
  `associationCount` が出る。**渡さなければ従来と同じ値が返る**（`?? 0`）。
  ([ADR 0166](./docs/decisions/0166-recall-footprint-association-term.md))
- **`examples/chat` の想起経路が連想枠を既定で使うようになった**（`maxCount=10`）。
  ⚠ **`@mnemora/core` の `recall()` の既定は off のままである**——連想枠は
  `query.association` を渡したときだけ走る（`packages/core/src/recall.ts:1132`
  「省略時は連想を一切走らせない」）。**変わったのは採用側が明示して使うようになったこと**であって、
  ライブラリの既定ではない。
  ([ADR 0168](./docs/decisions/0168-examples-chat-uses-association.md))
- **`tick()` が `consolidate()`/`reflect()` を駆動できる**（既定 off の opt-in、
  `RuntimeConfig.autoQueueConsolidateReflectOnExtract`）。
  ([ADR 0157](./docs/decisions/0157-tick-drives-consolidate-and-reflect.md))

### Fixed

- **連想枠（段3.5）の結果が、同一データに対して実行のたびに変わることがあった。**
  原因は `VectorStore.getVectors()` の返却順（adapter が保証しない順序）にそのまま
  依存していたことで、HNSW の近似性とは無関係だった。アンカーの処理順をランク順に
  固定して直した（Issue #316）。
  ([ADR 0167](./docs/decisions/0167-association-getvectors-order-nondeterminism.md))
