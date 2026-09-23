# ADR 0269: `Runtime` 以外の port interface（`MemoryStore` など）も、`docs/architecture.md` §5 の写しが実体とずれている — どちらが正本かは決めない（Issue #604）

- **状態**: 提案 (2026-09-23)
- **日付**: 2026-09-23

> **⚠ この ADR は、自動化された担い手（マネージャーから切り出された worker セッション）のものである。**
> **⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。⟹ **この ADR を「オーナーが決めた」と読まないこと。**

**⚠ 各主張の出所を分ける**（ADR 0239 / 0244 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git` / `node` を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

**測定条件**: 断りの無い【実測】【現物】は `origin/main` = `3875a05`（2026-09-23、本 ADR の作業を始めた時点）の木で行った。

---

## 問い

[Issue #604](https://github.com/takecchi/mnemora/issues/604) は [Issue #518](https://github.com/takecchi/mnemora/issues/518)
から切り出された。#518 は `Runtime` interface のメソッドが3文書（README/vision/architecture）に
焼き込まれている問題を扱い、PR [#543](https://github.com/takecchi/mnemora/pull/543)（ADR 0244）で
歯 `scripts/__tests__/runtime-method-doc-correspondence.test.mjs` を入れて着地した。**だがその歯が
見ているのは `Runtime` だけである。**⟹ `MemoryStore` など他の interface に同じ形の焼き込みが
在るかは、#518 本文・その判定コメント・ADR 0244「引き受けた負債」の3箇所が揃って「掃いていない」と
書いていた。

本 ADR は、Issue #604 が引き受けた3つのこと——

1. `docs/architecture.md` §5 の interface 宣言が「定める側」か「写した側」かの切り分け（断定はしない）
2. `packages/core/src/` の公開 interface の機械的列挙と、生きた文書の焼き込み箇所の掃引
3. 当たった箇所を実体と突き合わせた表

——を実行した記録である。**⛔ 直すかどうかは、この ADR でも決めない**（Issue #604 自身が
「掃いて棚卸しするところまでが本 ISSUE の範囲」と明記している）。

---

## 決定1. 掃引の範囲を自分で決める

Issue #604 は「`packages/core/src/` 以外に公開 interface が在るかを見ていない」ことを
「確かめていないこと」に挙げ、「掃引の範囲は着手時に決め直すこと」と指示していた。

【実測】`grep -rl "^export interface " packages/*/src --include='*.ts'` を打つと、
`packages/core` 以外にも `packages/anthropic` / `packages/openai` / `packages/local-embedding` /
`packages/postgres` / `packages/testkit` に `export interface` が多数在る。

⟹ **本 ADR は掃引の範囲を `packages/core/src/` の port interface（17個、下記）に絞る。** 理由:

- **Issue #604 の出発点**（本文が `main = 7a2c0c3`〔【受】、Issue 本文からの引用で本 ADR は
  再導出していない〕時点の実測として書いていた表）**自体が、`docs/architecture.md` §5 が写している
  port interface（`MemoryStore` 等）を名指ししている。** 他パッケージの interface（例:
  `packages/postgres/src/client.ts` の内部型、`packages/anthropic/src/errors.ts` のエラー型）は、
  そもそも `docs/architecture.md` 等の生きた文書がメソッド名・件数を焼き込む対象になっていない
  ——実際に掃った結果（決定3）でも、当たったのは §5 が節を割り当てているこの系列だけだった。
  ⚠ **Issue #604 本文の表は12行だった**が、それは §5.7（`type` 宣言であり `^interface ` の
  grep パターンに当たらない）と §5.13（実体の無い Phase 3 placeholder）を含めずに数えた結果
  である。**本 ADR はその12行をそのまま引き写さず、§5 全体（§5.7・§5.13 を含む）を対象に
  数え直す**（下記）。
- **`Runtime` の先例（ADR 0244）も、対象を `packages/core/src/runtime.ts` の `Runtime` interface
  1個に絞っている。** 同じ形の粒度を踏襲する。

**⛔ 決めなかったこと（オーナーへ返す）**: `packages/postgres` / `packages/anthropic` /
`packages/openai` / `packages/local-embedding` / `packages/testkit` の公開 interface に、
各パッケージの README 等が同じ形の焼き込みをしているかは、**本 ADR では掃いていない**。
`packages/core/README.md` を含む各パッケージの README は決定3 の表に含めたが、あくまで
「core の port interface を焼き込んでいるか」という向きでの走査であり、
「各パッケージ自身の interface を焼き込んでいるか」という向きでは走査していない。

### 掃引対象 — `docs/architecture.md` §5 が名前を挙げる17個の named interface/type（15節）

**本 ADR における「掃引対象」の定義はこの1つだけである。決定3 の表を、この定義の唯一の正本とする。**

【実測】`packages/core/src/index.ts` が「外部から見えるべき名前をすべて名前付きで export する」
唯一の入口であり（ファイル冒頭のコメント）、そこから辿れる `export interface`/`export type` の
うち、`docs/architecture.md` §5（前文の `Ctx` 〜 §5.13）が名前を挙げているものを**機械的な
grep ではなく、§5 の見出しとコードブロックを読んで手で列挙した**（§5.7 が `type` 宣言、
§5.13 が実体の無い placeholder のため、単純な `^interface ` grep では両方とも取りこぼす
——上の注記と同じ理由）。**17個・15節**である:

| 節 | 名前 |
|---|---|
| §5 前文 | `Ctx` |
| §5.1 | `MemoryStore` |
| §5.2 | `VectorStore` |
| §5.2.1 | `LexicalStore` |
| §5.3 | `RelationStore`（実体無し、Phase 2） |
| §5.4 | `LLMProvider` |
| §5.5 | `EmbeddingProvider` |
| §5.6 | `Scheduler` |
| §5.7 | `ScoringStrategy`、`DecayStrategy`（2個） |
| §5.8 | `EventStore` |
| §5.9 | `TokenCounter` |
| §5.10 | `Clock` |
| §5.11 | `OutboxStore` |
| §5.12 | `TenantSettingsStore` |
| §5.13 | `Sensor`、`SpeechPolicy`（実体無し、Phase 3。2個） |

**`Runtime` はこの17個に含めない**——ADR 0244 の歯が既に見ている（決定1で述べた理由）。

---

## 決定2. `docs/architecture.md` §5 は「定める側」か「写した側」か — 🔴 断定しない。両方の読みを示す

**これはオーナー領分の論点である。** Issue #604 自身が「掃く側で断定せず、両方の読みで何が起きるかを
示して判断を仰ぐこと」と指示している。以下、文書自身の中に在る手がかりを逐語で引く。

### 読みA（写した側）を支持する手がかり

- **`docs/README.md`「文書の地図」**【現物】は `docs/architecture.md` を「全体アーキテクチャ /
  package 構成 / 主要 interface」と説明し、`docs/decisions/` を「重大な設計判断と、その理由」と
  分けている。
- **`docs/decisions/README.md`**【現物・逐語】:
  > `docs/architecture.md` や `docs/memory-model.md` 等の他の docs が「何がどう決まっているか」を
  > *記述する* のに対し、ここ（ADR）では検討した選択肢・却下した理由・引き受ける負債・覆る条件までを
  > 1ファイルにまとめる。**決定そのものをやり直す場ではなく、決定を記録する場である。**
  ⟹ ADR が「決定」を行い、`docs/architecture.md` はその決定を「記述」する側、という
  役割分担が明示されている。
- **`docs/architecture.md` §3.2（Runtime の節、ADR 0244 が直した箇所）**【現物・逐語】:
  > ⭐ **何が在るかの正本は `packages/core/src/runtime.ts` の `export interface Runtime` であり、
  > ⛔ ここに個数を写さない**（ADR 0234）。
  ⟹ 少なくともこの1箇所では、文書自身が「正本はコード、ここは写し」と明言している。
  **ただし、この明言は §3.2（Runtime）にしか付いていない。§5（port interface）には同じ宣言が無い**
  ——ADR 0244 が触ったのは §3.2 だけであり、§5 は一度もこの形の注記を受けていない
  （決定4の git 調査参照）。
- **決定3 が見つけた drift の形**: 各 port interface に新しいメソッドが増えた具体的な経緯
  （`getRecall` は PR #307、`requeueEmbedJobs` は PR #100、`archiveDecayed`/`purgeMemory`/
  `markContestedPair` 等は ADR 0100/0114/0134、`getDecayClock` 等4メソッドは ADR 0165 決定13、
  `setDefaultHalfLifeRecalls` は ADR 0197）は、**すべて先に ADR が決め、実装が追随し、
  §5 の写しだけが追随しなかった**という順序になっている。⟹ 「§5 が定めた通りに実装が動く」
  のではなく「ADR が定めた通りに実装が動き、§5 は取り残される」という向きの証拠である。

### 読みB（定める側）を支持する手がかり

- **§5.3 `RelationStore`**【現物・逐語、`docs/architecture.md:607`】は「Phase 2」と明記され、
  **`packages/core/src/` のどこにも実体が無い**（決定3で確認）。⟹ **存在しないものは「写せない」**
  ——この節は実装から写したのではなく、将来の契約を*先に*書いている。
- **§5.13 `Sensor`/`SpeechPolicy`**【現物・逐語、`docs/architecture.md:858-861`】:
  > 正直に書く: この2つは Phase 1〜2 の設計検討の対象外であり、**現時点では interface の形すら
  > 仮置きに過ぎない。**（中略）**ここでの掲載はオーナー要求の11項目網羅のためであり、
  > 設計が済んでいることを意味しない。**
  ⟹ **文書自身が「これは写しではなく仮置きの宣言である」と述べている。** 実装が無いものを
  「オーナー要求への網羅」のために書いているのだから、これは定義行為そのものである。
- **§5 冒頭**【現物・逐語、`docs/architecture.md:357-361`】:
  > 各 interface は「型シグネチャ」と「契約（振る舞いの約束）」の両方で構成される。
  > **型だけでなく振る舞いが契約である**——（中略）adapter は型を満たすだけでなく、testkit の
  > スイートを通ることで初めて「準拠」とみなす。
  ⟹ 「契約」という語を使っており、adapter 実装者に向けて「満たすべきもの」を述べる体裁を
  取っている。これは記述（写し）よりも規範（定める）に近い語り口である。

### 🔴 本 ADR の立場

**両方とも成立する部分が在り、単一の答えに絞れない。** 少なくとも次は言える:

- **§3.2（Runtime）だけは、ADR 0244 の作業により明示的に「写し」側へ倒された**（正本はコード、
  という宣言が付いている）。
- **§5.3・§5.13（実体の無い2節）は、構造的に「写し」ではありえない**（写す元が無い）。
- **§5.1・§5.2・§5.7・§5.12（実際に drift が見つかった4節）は、「本来は写しであるべきだが、
  実装に追随できていない」とも「定めた契約を実装がまだ拡張し続けている」とも、
  どちらの言葉でも説明できてしまう。** これを見分ける決定的な一次資料の記述は見つからなかった
  ——⟹ **オーナーの判断を仰ぐ。**

---

## 決定3. 掃引結果 — 表

【実測】各 interface について、`docs/architecture.md` §5 の該当節が示す `interface X { ... }`
コードブロックのメソッド名・フィールド名を、`packages/core/src/interfaces/*.ts`（および
`runtime.ts`・`strategies/*.ts`）の実体と、Node スクリプトで「開始行から括弧の対応を辿って
終端を求める」方式で機械的に数え直し、**一行ずつ突き合わせた**（`grep`/`sed` による手動確認も
主要3件で併用）。

| # | 名前・節（sha=`3875a05`） | 焼き込みの中身 | 実体（`packages/core/src/`） | 判定 |
|---|---|---|---|---|
| 1 | `Ctx`（§5前文、`docs/architecture.md:366-369`） | `tenantId: string` / `subjectId?: string` の2フィールド | `ctx.ts:12` の実体も同じ2フィールド | ⭕ **一致** |
| 2 | `MemoryStore`（§5.1、`docs/architecture.md:377-424`） | `interface MemoryStore { ... }` を丸ごと再掲、**15メソッド** | `interfaces/memory-store.ts:305` の実体は**必須17 + 任意8 = 25メソッド**。任意8つ（`supersedeWithNewMemories?` `purgeExpiredEvents?` `archiveDecayed?` `purgeMemory?` `markContestedPair?` `resolveContestedPair?` `restoreSupersededBy?` `previewRestoreSupersededBy?`）は**1つも文書に無い**。必須のうち `getRecall`（`:572`）・`requeueEmbedJobs`（`:613`）も無い。さらに `reinforce` は実体が4引数（`opts?: ReinforceOptions`、`:500`）なのに文書は3引数（`docs/architecture.md:412`） | 🔴 **ずれている**（10メソッド欠落＋1シグネチャ差） |
| 3 | `VectorStore`（§5.2、`docs/architecture.md:522-533`） | 3メソッド（`upsert`/`search`/`delete`） | `interfaces/vector-store.ts:187` の実体は**4メソッド**（+ 任意 `getVectors?`、`:249`） | 🔴 **ずれている**（1メソッド欠落） |
| 4 | `LexicalStore`（§5.2.1、`docs/architecture.md:575-580`） | 1メソッド（`search`、引数まで一致） | `interfaces/lexical-store.ts:105` の実体は**1メソッド**、シグネチャも同一 | ⭕ **一致** |
| 5 | `RelationStore`（§5.3、`docs/architecture.md:610-616`） | 3メソッド（`link`/`unlink`/`listRelated`） | 【実測】`grep -rn "interface RelationStore" packages/` は0件。**実体が存在しない**（Phase 2、doc 自身が明記） | ⚪ **比較不能**（写す元が無い。決定2 読みBの根拠） |
| 6 | `LLMProvider`（§5.4、`docs/architecture.md:629-632`） | 2メソッド（`complete`/`completeStructured`） | `interfaces/llm-provider.ts:38` の実体は**2メソッド**、名前一致 | ⭕ **一致** |
| 7 | `EmbeddingProvider`（§5.5、`docs/architecture.md:644-647`） | `readonly space` + `embed` の2口 | `interfaces/embedding-provider.ts:13` の実体は同じ2口 | ⭕ **一致** |
| 8 | `Scheduler`（§5.6、`docs/architecture.md:669-671`） | 1メソッド（`enqueue`） | `interfaces/scheduler.ts:36` の実体は**1メソッド**、名前一致 | ⭕ **一致** |
| 9 | `ScoringStrategy`（§5.7、`docs/architecture.md:685`） | 戻り値型名を `Score` と表記 | 【実測】`packages/core/src/` に `Score` という型は**存在しない**（実体は `ScoreBreakdown`、`strategies/scoring.ts:74` の `type ScoringStrategy = (input: ScoringInput) => ScoreBreakdown`） | 🔴 **型名がずれている**（`Score`→`ScoreBreakdown`。関数型なのでメソッド件数の概念は無い） |
| 10 | `DecayStrategy`（§5.7、`docs/architecture.md:687-692`） | 2メソッド（`strengthAt`/`floorAt`） | `strategies/decay.ts:16` の実体も2メソッドで名前・引数とも一致（`interface` 宣言 vs 文書の `type = {...}` は構文の書き分けのみ） | ⭕ **一致** |
| 11 | `EventStore`（§5.8、`docs/architecture.md:710-714`） | 3メソッド（`append`/`get`/`list`） | `interfaces/event-store.ts:12` の実体は**3メソッド**、名前一致 | ⭕ **一致** |
| 12 | `TokenCounter`（§5.9、`docs/architecture.md:737-739`） | 1メソッド（`count`） | `interfaces/token-counter.ts:8` の実体は**1メソッド**、シグネチャ一致（引用符の種類のみ違う） | ⭕ **一致** |
| 13 | `Clock`（§5.10、`docs/architecture.md:754-756`） | 1メソッド（`now`） | `interfaces/clock.ts:8` の実体は**1メソッド**、一致 | ⭕ **一致** |
| 14 | `OutboxStore`（§5.11、`docs/architecture.md:768-793`。+ `ClaimOutboxJobsOptions`・`OutboxLeaseConflictError`） | 3メソッド＋オプション5フィールド＋例外3引数 | `interfaces/outbox-store.ts` の実体も3メソッド・5フィールド・3引数、すべて一致 | ⭕ **一致** |
| 15 | `TenantSettingsStore`（§5.12、`docs/architecture.md:835-837`） | **1メソッド**（`getDefaultHalfLifeHours`のみ） | `interfaces/tenant-settings-store.ts:258` の実体は**必須3（`getDefaultHalfLifeHours`/`getEventRetention`/`setEventRetention`）+ 任意5（`getDecayClock?`/`setDecayClock?`/`getDefaultHalfLifeRecalls?`/`setDefaultHalfLifeRecalls?`/`getActivitySeq?`）＝8メソッド** | 🔴🔴 **大きくずれている**（7メソッド欠落。実体の8分の1しか写っていない） |
| 16 | `Sensor`（§5.13、`docs/architecture.md:849-851`） | 空の placeholder interface | 実体が存在しない（Phase 3）。文書自身が「仮置き」と明記（決定2 読みB） | ⚪ **比較不能**（同上） |
| 17 | `SpeechPolicy`（§5.13、`docs/architecture.md:853-855`） | 空の placeholder interface | 実体が存在しない（Phase 3）。文書自身が「仮置き」と明記（決定2 読みB） | ⚪ **比較不能**（同上） |

**内訳（17対象中）**【実測、上表の判定列を数えた】: ⭕ 一致 10（`Ctx`/`LexicalStore`/`LLMProvider`/
`EmbeddingProvider`/`Scheduler`/`DecayStrategy`/`EventStore`/`TokenCounter`/`Clock`/`OutboxStore`）、
🔴 ずれている 4（`MemoryStore`/`VectorStore`/`TenantSettingsStore`/`ScoringStrategy`）、
⚪ 比較不能 3（`RelationStore`/`Sensor`/`SpeechPolicy`）。10+4+3=17、対象数と一致する。

### 掃った過程で見つけた、17対象の枠外にある焼き込み（決定1の範囲外だが記録する）

| 文書・行 | 中身 | 判定 |
|---|---|---|
| `docs/architecture.md:233-257`（§3.8） | `LLMProvider`/`StructuredRequest` を §5.4 とは別に再掲。**文書自身が**「§5.4 と同じ1つの interface である」「2箇所に書いてあるが別物ではない」「契約を引くときは §5.4 を見ること」と明記し、さらに「2026-09-17 まで、この節の署名だけ `ctx` が落ちていた（Issue #389 / ADR 0198）」と過去に §3.8 側だけが実体からずれていた実例を記録している | **17対象には含めない**（§5.4 の写しが§3.8 にも複製されている、という「同じ interface が2箇所に焼き込まれている」の実例。いまは§5.4・§3.8・実体の3者とも一致しているが、過去に§3.8側だけがずれた実績がある） |
| `docs/recall.md:671-673` | `TokenCounter` を §5.9 とは別に再掲。1メソッド（`count`）、実体と一致 | **17対象には含めない**（上と同型。いまは§5.9・実体と一致） |
| `docs/memory-model.md:474-479` | alteroid（別repo）の `JournalStore` interface を「現物で確認できた設計」として再掲 | **スコープ外**——mnemora の `EventStore` ではない。設計の由来を示す比較参照であり、この repo の port interface の焼き込みではない |
| `docs/migration-v1.md:396-410` | `NewRecallRecord` の「旧（v0.1.9）」「新（v0.2.0）」を両方明示 | **スコープ外**——移行ガイドが意図的に新旧を併記する凍結記録（ADR 0239 が言う「凍結記録」の形）。かつ `NewRecallRecord` はメソッドを持たないデータ型であり、17対象（振る舞いを持つ port interface/type）に含めていない |
| `docs/README.md:40` | `Runtime` の非中核メソッド数を「**9個**」と明記 | **スコープ外だが実際にずれている**（下記「引き受けた負債」参照） |

---

## 決定4. §5 がいつから放置されているかの裏付け

【実測】`git log --oneline -- docs/architecture.md` を直近まで辿ると、直近2本の変更（PR #531・
PR #543、いずれも ADR 0244 = Issue #518 の作業）は §3.2（`Runtime` の分類節）しか触っておらず、
続く PR #607（ADR 0268、2026-09-23）も同じく §3.2 の2行（Issue番号の付け替え）しか触っていない
（決定3の表の計測前に確認済み）。⟹ **§5 のどの節も、直近3本の docs 更新では一度も触られていない。**

【実測】drift が見つかった3つの interface について、欠落しているメソッドが実装に入った時点を
`git log -S` で確認した:

- `MemoryStore.getRecall` — PR #307（`e8de871`）
- `MemoryStore.requeueEmbedJobs` — PR #100（`01d352d`）
- `TenantSettingsStore.getDecayClock` 等4メソッド — PR #335（ADR 0165、`1021a93`）

いずれも古い PR 番号であり、**「昨日入ったばかりで追いついていない」ではなく、長期間にわたって
追随されていない状態である**。

---

## 引き受けた負債

- 🔴 **決定3 の drift（`MemoryStore` 10口、`VectorStore` 1口、`TenantSettingsStore` 7口、
  `ScoringStrategy` の型名1件）は、直さない。** Issue #604 の範囲外であり、直すかどうかは
  別判断として残る。
- **決定1 で掃引範囲を `packages/core/src/` の port interface 17個（15節）に絞った。**
  他パッケージ（`packages/postgres` 等）の公開 interface が同じ形の焼き込みを受けているかは
  掃いていない。
- ⭐ **`docs/README.md:40` の「`Runtime` には他に9個のメソッドがあるが」は、いま実際にずれている。**
  【実測】`packages/core/src/runtime.ts` の `export interface Runtime` を機械的に数え直すと
  17メソッド・非中核12（ADR 0244 と同じ数え方・同じ結果）。`9` は PR #344（2026-09-16、
  当時 `Runtime` は14メソッド・非中核9で、その時点では正しかった）以来更新されておらず、
  その後 `restoreSuperseded`（PR #464）・`findCorrectionCandidates`（ADR 0232）・
  `applyCorrection`（ADR 0242）の3メソッドが増えた後も放置されている。**これは `Runtime` の
  話であり Issue #604 の対象外**（#604 は「`Runtime` 以外」の掃引である）だが、
  ADR 0244 の歯（`scripts/__tests__/runtime-method-doc-correspondence.test.mjs`）は
  `README.md`/`docs/vision.md`/`docs/architecture.md` の3文書しか見ておらず、**`docs/README.md`
  （ルート `README.md` とは別ファイル）は対象に入っていない。**⟹ 既存の歯が捕まえない
  第4のファイルで、まさに歯が防ごうとした形の腐りが実際に起きている。**この事実だけをここに
  記録し、対処（歯の対象を広げる／`docs/README.md` を直す／別 Issue を立てる）はオーナーへ返す。**
- **`docs/architecture.md` §3.8 が `LLMProvider` を、`docs/recall.md` が `TokenCounter` を、
  それぞれ §5 とは別の場所に独立して再掲している**（決定3・「17対象の枠外」表）。いまは両方とも
  一致しているが、§3.8 は過去に一度（Issue #389 / ADR 0198）実際にずれた実績がある。
  `TokenCounter` に手が入ったとき、`docs/recall.md:671` の2箇所目だけ直る余地も同様に残る。
  この重複自体を1箇所に統合するかどうかも、本 ADR では決めない。
- **決定2（定める側 vs 写した側）は、断定していない。** オーナーの判断が要る。

## これが覆るとしたら何が起きたときか

- **オーナーが決定2 の問いに答えたとき**——「§5 は写しである」と決まれば、drift は
  ADR 0244 と同じ形の歯（17対象それぞれに、あるいは共通化した1本の歯）を作る根拠になる。
  「§5 は契約を定める側である」と決まれば、逆に **実装側（不足しているメソッドを実装していない
  adapter や、契約と矛盾する実装）を疑う向きの調査になる**——ただし今回見つかった drift は
  すべて「文書に無いメソッドが実装済み」という形であり、「文書にあるのに実装が無い」という
  逆方向の drift は17個中0件だった（§5.3・§5.13 の3件〔`RelationStore`/`Sensor`/`SpeechPolicy`〕は
  実装が無いが、文書自身が「まだ実装しない」と明記しており矛盾ではない）。この非対称自体が、
  読みAをやや優勢にするようにも見えるが、**本 ADR はそれでも断定しない**——サンプルが4件
  （drift の在った interface: `MemoryStore`/`VectorStore`/`TenantSettingsStore`/`ScoringStrategy`）
  ＋3件（実体の無い interface: `RelationStore`/`Sensor`/`SpeechPolicy`）の計7件しかなく、
  決定2 の一次資料の読みほど強い根拠にはならない。
- **`docs/README.md:40` の「9個」が直されたとき、または ADR 0244 の歯の対象に含まれたとき**——
  上の「引き受けた負債」の該当項目が解消する。

## 採らなかった案

### 1. 17個すべてに ADR 0244 と同じ歯を機械的に複製する

⛔ **本 ADR の範囲外である**（Issue #604 が「歯を作ること・広げること」を明示的に「引き受けない
こと」に挙げている）。⚠ 仮に作るとしても、ADR 0244 決定3 が指摘した通り「正典値を literal で
持つ」型はそのまま複製できない——`MemoryStore` は中核5動詞に相当する固定集合を持たない
（全メソッドが実体から動く）ため、ADR 0244 の「中核5動詞だけ literal」という設計は
そのままでは適用できない。**次にこれをやる人は、まずここを詰める必要がある。**

### 2. 掃引範囲を全パッケージの公開 interface に広げる

⛔ Issue #604 の出発点（本文が【受】として書いていた実測表）が `packages/core/src/` の port
interface を名指ししており、実際に掃った結果もその系列にしか当たらなかった（決定3）。
**時間をかけて他パッケージまで広げる根拠が薄い**——ただしこれは「無いと確認した」のではなく
「見ていない」である（決定1・「引き受けた負債」参照）。

---

## 測ったこと / 確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

- 【実測】`packages/*/src` 配下の `export interface` の洗い出し（`grep -rl`）。
- 【実測】`packages/core/src/index.ts` が唯一の公開入口であることの確認（ファイル冒頭コメント）。
- 【実測】`docs/architecture.md` §5 前文（`Ctx`）〜§5.13 の15節・17個の named interface/type
  それぞれについて、コードブロックのメソッド名・フィールド名を Node スクリプト（開始行から
  括弧対応を辿って終端を求める）で機械的に数え、`packages/core/src/interfaces/*.ts`・
  `strategies/decay.ts`・`strategies/scoring.ts`・`ctx.ts` の実体と突き合わせた。
  `Ctx`/`MemoryStore`/`VectorStore`/`TenantSettingsStore` は `grep -n` による行番号確認も併用した。
  内訳（⭕一致10・🔴ずれ4・⚪比較不能3）の合計が17であることを確認した（決定3）。
- 【実測】`MemoryStore.reinforce` のシグネチャ差（文書3引数 vs 実体4引数）を `sed -n` で
  該当行を直接読んで確認した。
- 【実測】`RelationStore`・`Sensor`・`SpeechPolicy` が `packages/core/src/` に実体を持たないこと
  （`grep -rn` 0件）。
- 【実測】`docs/memory-model.md`・`docs/recall.md`・`docs/migration-v1.md`・`docs/README.md`・
  ルート `README.md`・`packages/core/README.md` 等、生きた文書（`docs/decisions/` を除く）
  一式を対象に、17個の interface/type 名と "`interface `"/"`export interface `" の行頭パターンで
  横断 grep した。`docs/architecture.md` 自体も同じパターンで全文横断し、§5 系列の外に
  §3.8 の `LLMProvider`/`StructuredRequest` 再掲を見つけた。
- 【実測】`docs/architecture.md` の直近3コミット（PR #531・#543・#607）の diff を確認し、
  §5 系列が触られていないことを確かめた。
- 【実測】`MemoryStore.getRecall`/`requeueEmbedJobs`、`TenantSettingsStore.getDecayClock` 等の
  導入 PR を `git log -S` で特定した。
- 【実測】`docs/README.md:40` の「9個」と、`Runtime` の現在のメソッド数（17・非中核12）の不一致。
  PR #344（`ea7b4e3`）の本文から、当時（14メソッド・非中核9）は正しかったことも確認した。
- 【実測】`node scripts/adr-renumber.mjs --next` → `0269`（本 ADR の仮番号。
  マージ直前にマネージャー側で確定し直される前提、ADR 0179）。

### 確かめていないこと

- ⛔ **決定2（定める側 vs 写した側）に断定的な答えは出していない。** オーナー領分として
  未決のまま返す。
- ⛔ **`packages/core/src/` 以外のパッケージの公開 interface が、各パッケージの README 等で
  同じ形の焼き込みを受けているか**は掃いていない（決定1で範囲外とした）。
- ⛔ **`docs/conformance.md`・`docs/roadmap.md`・`examples/chat/README.md`・
  `packages/{anthropic,openai,local-embedding,postgres,testkit}/README.md` に、17個の
  interface/type 名への言及は多数在ったが（横断 grep で件数を確認済み）、それらすべてが
  「単なる名前の言及」か「メソッド名・件数の焼き込み」かを1行ずつ読んだわけではない。**
  `docs/architecture.md` §3.8・`docs/memory-model.md`・`docs/recall.md`・`docs/migration-v1.md`・
  `docs/README.md` の5件（決定3・「17対象の枠外」表）は実際に読んで判定したが、**残りのファイルは
  「`interface X {` という行頭パターンでは当たらなかった」ことまでしか確認していない**——
  プローズ中の箇条書き（`Runtime` が3文書で踏んだのと同じ形）での焼き込みが無いことは、
  網羅的には確認していない。
- ⛔ **本 PR の変更（ADR 1ファイルの追加のみ）に対して、`pnpm run test` 等の CI 相当の
  検査は走らせていない**——ドキュメントのみの変更であり、コード・スクリプトは1バイトも
  変えていない。
- ⛔ **オーナー本人の確認は取っていない**（冒頭のバナーの通り）。
