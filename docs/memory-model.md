# Memory Model

本書は mnemora の記憶データモデルを定義する。対象は
**「6. DB schema 案」**と**「7. Memory lifecycle」**であり、そこへ到達するために必要な
Observation / Provenance / Digest / 矛盾 / 強化 / 忘却 / taxonomy / 監査ログの各決定を先に固める。

全体を貫く原則「文脈を剥がして提示しない」(Qualified Presentation) は `docs/architecture.md` 冒頭で
定義される。本書はその原則の適用先の一つであり、以降で「原則」と呼ぶときはそれを指す。

DDL は PostgreSQL を対象とする。各テーブル・各列に、どの Phase で導入されるかを明記する
（Phase 1 = 初期実装、Phase 2 = 後続）。Phase の指定が無い列は、そのテーブルが導入される
Phase と同じである。

---

## 1. Memory とは何か / Observation との違い

- **Observation** — 外から入ってきた出来事の生の記録。**不変。解釈しない。**
  発話・イベント・使用報告・投入文書など、mnemora の外側で起きたことをそのまま保持する。
  Observation は一度書かれたら内容を書き換えない。訂正は新しい Observation として追加される。
- **Memory** — Observation から抽出された、再利用可能な単位の記憶。**解釈済み。**
  誰が・何を・いつ言ったかではなく、「何が真だとみなせるか」を表す。

この二つを同一テーブルにしない理由は一つに絞れる。**抽出器のバージョンが上がったとき、
生記録が残っていなければやり直せない。** 抽出は決定的でも完全でもない。プロンプトを直す・
モデルを差し替える・抽出ロジックのバグを直す、といったことは実運用で必ず起きる。そのたびに
「もう一度、最初から抽出できる」ことが必要で、それを保証できるのは Observation が
Memory の作成後も無傷で残っている場合だけである。Memory だけを保存して Observation を
捨てる設計は、抽出器を一度でも間違えた瞬間に取り返しがつかなくなる。

この分離は冪等性の設計とも直結する。抽出は `(source_observation_id, extractor_version)` の組で
冪等にする。同じ Observation に同じバージョンの抽出器をもう一度かけても、Memory が重複しない。
これは Observation が変更されないことが前提であり、両者を混ぜると成立しない。

Observation の中には、Memory を生まないものもある。`observe(ctx, { kind: 'memory_usage', ... })`
（後述 §6）は「どの Memory が実際に使われたか」の報告であり、これは抽出器を通らず
`recall_usages` へ直接反映される。Observation は「mnemora の外で起きたことの記録」という
共通の型を持つが、そこから先の処理は `kind` によって分岐する。

---

## 2. Provenance（判別可能ユニオン）

Memory がどこから来たかは、後から付け足すフラグではなく、Memory の型そのものである。

```ts
type Provenance =
  | { kind: 'stated';       sourceObservationId: string; speaker?: string; at: string }
  | { kind: 'inferred';     model: string; promptVersion: string;
      basis: { memoryIds: string[]; observationIds: string[] }; confidence: number }
  | { kind: 'consolidated'; sources: string[] /* memoryIds */ }
  | { kind: 'reflected';    sources?: string[] /* memoryIds, 省略可 */ }
  | { kind: 'imported';     batchId: string }
```

DB では `provenance_kind` を**列**にし、`stated | inferred | consolidated | reflected | imported`
以外の値を受け付けない。判別に使うキーだけを列に上げ、残りのペイロード（`model` や `basis` など
kind ごとに形が違う部分）は `provenance` jsonb 列にまとめる。列にする理由は二つしかない。
**フィルタと索引。** recall がデフォルトで `stated` と `inferred` を区別して返す、あるいは
呼び出し側が推論を除外するオプションを使う、といった操作は SQL の `WHERE provenance_kind = ...`
で済ませたい。jsonb の中の値でしか判別できない設計だと、この頻出条件のたびに式インデックスを
別途用意することになり、それは列を持つのと手間が変わらないまま柔軟性だけ失う。

**ここが本書で最も明確にしておきたい対応関係:** オーナーの原則7「AI の推論とユーザーが言った事実を
区別する」は、実装上は別のフラグや別のテーブルとして現れるのではない。**`provenance.kind` の
値そのもの**がその区別である。`stated` と `inferred` の間に追加の「これは AI 由来か」という
フラグを設ける必要はない。判別可能ユニオンのタグが、そのままオーナーの要求している区別になっている。

**規律: 推論は根拠なしに提示しない。** `inferred` の Memory は `basis`（どの Memory / Observation
から導いたか）を持つ。しかし `basis` が指す先が消えている場合がある——参照先が `forgotten` に
なった、あるいは `purge()` で本文が失われた（§9・§11）。この状態を隠さない。`basis` が解決
できない `inferred` は、提示時に「根拠を失った推論」として印を付けて返す（削除はしない。
推論という事実自体は消えていないため）。これは原則の第2の現れそのものである——
「推論は、その根拠と必ず同時に提示する」という規律を、根拠が失われた場合にも一貫させるなら、
「根拠が失われたという事実」を提示するのが唯一の整合的な振る舞いになる。

**実装済み（[Issue #883](https://github.com/takecchi/mnemora/issues/883)、
[ADR 0342](./decisions/0342-recalled-memory-basis-lost.md)）。**
`RecalledMemory`（`packages/core/src/recall.ts`）に任意欄 `basisLost?: true` を足した。
`provenanceKind === 'inferred'` で、かつ `basis.memoryIds` の少なくとも1件が失われている
（`MemoryStore.getMany` の結果に無い・`status === 'forgotten'`・`purgedAt` が非 `null`の
いずれか）ときだけ `true` を書き、それ以外はキー自体を出さない——`basis` そのもの
（`memoryIds`/`observationIds`）は今回も返さない（`provenanceKind` の doc コメントが
説明する設計原理をそのまま保つ）。`archived`/`superseded`/`contested` は本文が残り
復帰経路があるため、失われていない扱い（§11）。

🔴 **`basis.observationIds` は確かめない。**Observation は追記専用で forget/purge/削除の
経路がコードに無く（§11 行1）、一括取得口も存在しないため——「探したが無かった」ではなく
「そもそも探していない」（[ADR 0257](./decisions/0257-searched-and-found-nothing-versus-did-not-search.md)
の区別）。また、本番で `inferred` を作る唯一の経路（`extraction.ts`）は
`basis.memoryIds` を常に空配列で書くため、今日の抽出パイプラインが作った記憶にはこの印は
今のところ立たない——`basis.memoryIds` を持つ `inferred` を書く経路（`createMemory` を
直接叩く等）が在ってはじめて効く。詳細は ADR 0342「引き受けた負債」。

**抽出が `inferred` に付ける `confidence` の既定は `0.5` である。**抽出の LLM が返す候補
（`ExtractedMemoryCandidate`）の `confidence` は省略できる（`0`〜`1`）。`provenanceKind: 'inferred'` の候補が
`confidence` を省略した場合、抽出（`packages/core/src/extraction.ts`）は `confidence: 0.5` を
書く。`stated` の候補の `confidence` は無視される（`Provenance` の `stated` に `confidence` は無い）。
この値は `Provenance` の一部として保存されるだけで、recall は返り値にも順位づけにも使わない
（ADR 0035 が `confidence` を返り値に載せない決定をしている）。

**⚠ 2026-09-30 追記（[ADR 0383](./decisions/0383-erase-tenant.md)）: 「Observation は
追記専用で forget/purge/削除の経路がコードに無く」に、1つだけ例外ができた。**
`eraseTenant`（`packages/core/src/erase-tenant.ts`、独立関数、明示呼び出し専用）は
**1つの Observation ではなく、テナントに属する `observations` 全行**を物理削除する
——`forget`/`purge`（1つの Memory・1つの Observation を対象にした既存の口）には
引き続きこの経路が無い。この上の段落・ADR 0257 が言う「探していない」という設計は、
`Runtime.forget`/`Runtime.purge` の射程についての記述としては変わっていない。

**⚠ 2026-10 追記（[ADR 0439](./decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md)）: Memory の `sourceObservationId` は、同じテナントの Observation を指す。**
`createMemory` 系は、`sourceObservationId` が `ctx.tenantId` の observation でなければ、行を書かずに `observation not found for tenant: <id>` で投げる
（以前は外部キーが `observations(id)` だけでテナントを見ず、別テナントの Observation を指す Memory が書けた。その行は指された側の `eraseTenant` を止めた）。

---

## 3. 三つ（四つ）の時計

Memory は目的の異なる複数の時刻を持つ。これを一つの「時刻」に丸めると、後から分解できなくなる。

| 列 | 意味 | NULL 許容 | Phase |
|---|---|---|---|
| `occurred_at` | その出来事・事実がいつのものか | 可（不明なら NULL） | 1 |
| `recorded_at` | mnemora がいつ知ったか | 不可 | 1 |
| `last_reinforced_at` | 最後に実際に使われたのはいつか | 可（未強化なら NULL） | 1 |
| `valid_from` / `valid_until` | その事実がいつからいつまで真か | 可 | 2 |

**鮮度スコアは `occurred_at ?? recorded_at` を使う。減衰は `last_reinforced_at` を使う。**
**⚠ 鮮度は 1 で頭打ちにする**（[ADR 0036](./decisions/0036-clamp-freshness-at-one.md)）——`occurred_at` は
この表の定義上ふつうに未来になり（「来月、京都へ出張する」）、減衰式は経過時間が負のとき 1 を超えて
上限を持たないためである。**「まだ起きていない出来事は、最も古びていない」と決めた。**

**`occurred_at` は呼び出し側の申告をそのまま受け入れ、未来の値も拒まない**
（[ADR 0037](./decisions/0037-callers-pass-occurred-at.md) 決定3）。**未来の `occurred_at` が
「まだ起きていない予定」なのか「呼び出し側の時計がずれている」なのかは区別しない**
（Issue #767）。極端に未来の値を検証・警告する機構は無く、信頼度や出所を示す別欄も無い——
2026-09-26 にクローン miku が、この区別をしないことを仕様として記録すると決めた
（ADR 0037 追記）。

この二つを同じ列に混ぜない理由は具体的である。「これはいつのことか」（鮮度）と
「最後に役に立ったのはいつか」（減衰）は、値が乖離するケースが普通にある。5年前に起きた
出来事（`occurred_at` は古い）を昨日思い出して使った（`last_reinforced_at` は新しい）Memory は、
鮮度としては古いが減衰としては強い。逆に、昨日聞いた話（`occurred_at` は新しい）を一度も
再利用していない Memory は、鮮度は高いが強化された実績が無い。この二つを一本の
「freshness」に潰すと、どちらの意味で計算したスコアなのかがコードを読まないと分からなくなり、
後から「実は鮮度と減衰は別の目的で使い分けたかった」と気づいても、過去に書き込まれた値が
どちらの意味だったのか復元できない。列を分けておけば、スコアリング式は自由に変更でき、
どちらの時計を使ったかは常に明示的である。

**⚠ 2026-09 訂正（Issue #202、[ADR 0145](./decisions/0145-valid-from-until-storage.md)）:
上の表の `valid_from` / `valid_until` の Phase 欄は、`Memory` 型と `packages/postgres` の
読み書きに限っては前倒しで実装済みである。** ADR 0073 が digest 帯について書いた形と
同じで、この2つは同じ行に並記されているが機構としては独立している——**前倒しされたのは
「型に載って読み書きされる」ところまでであり、`recall()` がこの区間を使ってフィルタ・
スコアリングすること、段1（ANN）への索引の押し下げ、`valid_until` を過ぎた記憶を
`omitted` で名指しすることは、いずれもまだ Phase 2 のままである**（ADR 0145「射程外」参照）。

**⚠ 2026-09-27 追記（後の ADR との照合）: 上の訂正の「`recall()` がこの区間を使ってフィルタすること、段1への
押し下げ、`valid_until` を過ぎた記憶を `omitted` で名指しすることは、いずれもまだ Phase 2 のまま」は、もう
成り立たない。**[ADR 0164](./decisions/0164-valid-from-until-recall.md)（2026-09-16）が3つとも実装した——`recall()` は
`RecallQuery.validAt`（省略時は `now`）の時点で真でない記憶を段1（ANN・語彙の SQL の `WHERE`）で落とし、
`omitted` の `filtered(expired)`/`filtered(not_yet_valid)` として名指しする。`includeOutsideValidity: true` で
ゲートを外せる。区間はスコアの計算には使わない。`observe()` の入力からも `validFrom`/`validUntil` を渡せる
（ADR 0164 決定4）。`@mnemora/postgres` と `@mnemora/testkit` の fixture で、期限切れの記憶が既定では
`filtered(expired)` で落ち、`validAt` を区間の中にするか `includeOutsideValidity: true` にすると返ることを
当て直した。上の表の Phase 欄（`valid_from` / `valid_until` は Phase 2）は、ADR 0164 が「射程外」6 で書き換えない
と決めたので、そのままにしてある——**表の Phase 欄は設計時の区分であり、実装状況はこの追記のとおりである。**

**⚠ 2026-09-27 追記（[Issue #1041](https://github.com/takecchi/mnemora/issues/1041)）: 表せる日時の範囲は adapter によって違う。**
core の schema は `Date` であることしか検査しない（JS の `Date` は ±275760年まで）。`@mnemora/postgres` の
`timestamptz` は `new Date("-004713-11-24T00:00:00.000Z")`（先発グレゴリオ暦の紀元前4714年11月24日、UTC）より
前を表せず、`occurred_at`・`valid_from`・`valid_until` にそれより前の日時を渡すと、書き込みが例外
（`timestamp out of range`）になり `observe()` は reject する。上側は Postgres のほうが広い（西暦294276年まで）
ので分かれない。`@mnemora/testkit` の fixture は JS の `Date` をそのまま受け入れ、同じ値で返す。保証するのは、
上の日時以降の値だけである。クローン miku の判断で、範囲を契約にして拒む案・端に丸める案は採らず、
今の振る舞いを記録した（選び直す余地は Issue に残してある）。書き分けは `Observation.occurredAt` の TSDoc。

**⚠ 2026-09-27 追記（[Issue #1042](https://github.com/takecchi/mnemora/issues/1042)）: 逆転した区間（`valid_from > valid_until`）も拒まない。**
`observe()` の schema も `MemoryStore` も、2つの端の順序を検査しない。そうした Memory は `recall()` の
`validAt` ゲート（[ADR 0164](./decisions/0164-valid-from-until-recall.md)）をどの時点でも通らず、`validAt` が2つの端の間
（`valid_until <= validAt < valid_from`）なら `omitted` の `filtered(expired)` と `filtered(not_yet_valid)` の
両方に1件ずつ数えられる（それ以外の時点ではどちらか一方）。`@mnemora/postgres` と `@mnemora/testkit` の
fixture で同じである。`filtered` の件数は「その条件に当たる記憶の件数」であり、条件どうしが排他である約束は
無い（[ADR 0203](./decisions/0203-memories-omitted-exclusivity.md) 追記9）ので、二重計上ではない。クローン miku の判断で、
入力の段で拒む案（入力を狭める）は採らず、今の振る舞いを記録した（選び直す余地は Issue に残してある）。
書き分けは `Observation.validFrom` の TSDoc。

---

## 4. Digest（要旨）

`memories.digest` は **NOT NULL。抽出時に生成する。**

alteroid との対比が設計理由をよく示す。alteroid の要旨は、書き手が Markdown の frontmatter に
literal に書いた `description` を 200 文字で切るだけの処理であり、`description` が無ければ
「（要旨なし）」という固定文言が入る（先頭 N 文字を自動で切り出すフォールバックすら無い）。
これは「要旨は人間が書く」という前提に立っている。

mnemora はこの前提を採らない。**digest は抽出時に LLM が生成し、NOT NULL にする。** 理由は二つ。
(a) mnemora の Memory は人間が Markdown を手で編集する運用を前提にしない。抽出パイプラインが
自動生成した Memory に、人手で要旨を書き足す工程を挟むと、Phase 1 で想定する自動抽出の
スループットと矛盾する。(b) 目次帯（recall.md 参照）の質は digest の質に直接依存する。
100万件規模で「（要旨なし）」が並ぶ目次は、目次としての役割を果たさない。

**ただし alteroid の安全弁は採る。** alteroid では frontmatter が壊れている・未知の値である
場合、分類は必ず `premise`（全文を残す側）に倒れる設計になっている。**曖昧なら厚い側に倒す**
という思想である。mnemora でも digest 生成が失敗した場合に、Memory を「digest だけの薄い状態」
に落とすことはしない。NOT NULL 制約を満たしつつこの思想を反映するため、`digest_source` 列を
持たせる。

```sql
digest         text NOT NULL,
digest_source  text NOT NULL DEFAULT 'llm' CHECK (digest_source IN ('llm', 'fallback')),
content        text NOT NULL   -- 全文。digest 生成の成否に関わらず常に保持する
```

LLM による digest 生成が失敗した場合、パイプラインは機械的な先頭文字列切り出しへ
フォールバックし `digest_source = 'fallback'` を記録する。**content（全文）は生成の成否に
関係なく常に書き込まれる。** 「薄い側にしか情報が無い」状態を作らないのが安全弁の核心であり、
digest の生成方式がどちらであったかを隠さないのは同じ原則の適用でもある。

### ⚠ 安全弁は、作動したことが見えなければならない（2026-09 追記）

上の安全弁には**二段**ある。両者を混ぜないこと。

1. **LLM は候補を返したが digest が空・欠落だった** → 機械的な先頭切り出しへ倒し、
   `digest_source = 'fallback'` を記録する（上記）。
2. **LLM 呼び出し自体が失敗した** → Observation の全文を1件の `stated` Memory として残す。

**⚠ 2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1222](https://github.com/takecchi/mnemora/issues/1222)）**: 2 は、`@mnemora/postgres` では本文の大きさで働かないことがある。`memories.content` は語彙の索引（`to_tsvector` の GIN）に入り、tsvector は 1MB（1048575 バイト）を超えられない。語の多い本文ではフォールバックの Memory の INSERT が失敗し、`observe()` は DB の例外を投げる。Observation と extract ジョブは残り、Memory は1件も残らない（ランダムな16進の語では約0.9MB で落ちた）。`tick()` での再試行も同じ所で失敗する。`@mnemora/testkit` の fixture は1件残す。どう直すか（切り詰める・索引に入れない・入力に上限を置く）は決まっていない。

**⚠ 2026-09-29 追記（上の追記を反転させる、[migrations/0025](../packages/postgres/migrations/0025_lexical_tsvector_fallback.sql)、[ADR 0364](./decisions/0364-lexical-tsvector-fallback-for-oversized-content.md)）**: 上の「`@mnemora/postgres` では働かないことがある」は直った。`idx_memories_lexical` の式に `mnemora_lexical_tsvector(content)`（新しい plpgsql 関数）を挟み、tsvector が1MBを超える本文だけ、本文の先頭150,000文字（`server_encoding` が `UTF8` の DB の場合。`SQL_ASCII` の DB では `left` がバイトで切るので、先頭150,000**バイト**——UTF-8 の日本語なら約50,000文字。ADR 0364 の 2026-09-30 の追記）で作り直すようにした——**`@mnemora/postgres` も `@mnemora/testkit` の fixture と同じく、1MBを超える本文でも1件の Memory を残す。**`memories.content` には全文が無傷で残る（縮退するのは語彙**索引**だけ）。⚠ ただし、先頭150,000文字より後ろにしか現れない語は、この語彙チャンネル（`LexicalStore`）からは引けない——ベクトル検索等、他の recall チャンネルには影響しない。N=150,000 の安全性の根拠（理論上限・実測）は ADR 0364「N の実測」。

**2 で残る Memory は「抽出されたもの」ではない。未処理の生テキストである。**
当初の実装はこれを 1 と同じ顔で記録していた——`ObserveResult` は `extracted: true` を返し、
`memory_events` の `created` イベントは `meta.reason = 'extracted'` を記録していた。
⟹ **監査ログが、起きなかったこと（抽出）を起きたと主張していた。**

安全弁そのものは正しい（記憶を失うくらいなら受け取る）。**間違っていたのは、
安全弁が作動したことを記録しなかった点である。** 一過性の LLM 障害が、
気づかれないまま生テキストを「抽出済みの記憶」として残す。

⟹ [ADR 0013](./decisions/0013-extraction-outcome-taxonomy.md) で、
`ObserveResult.extraction: ExtractionOutcome`（`ok` / `llm_failed_whole_observation` /
`skipped`）と、`memory_events.meta.reason` の区別
（`extracted` / `extraction_failed_whole_observation_fallback`）を決めた。

**曖昧なら厚い側に倒す。ただし、倒したことを黙っていない。**
これは [ADR 0008](./decisions/0008-absence-taxonomy.md) が `recall()` に対して定めた原則を、
取り込み側にも一貫させたものである。

ADR 0013 は「検知できるようになっただけで、やり直す操作は無い」という負債を残していた。
**`runtime.reextract(ctx, observationId)`（ADR 0028、2026-09 追記）**がこれを埋める。
同じ Observation に対して抽出をもう一度走らせ、成功すれば、2 で残った生テキストの Memory
（および**同じ `extractorVersion` を持つ**古い抽出結果）を `status: 'superseded'` にする
——`forgotten`（利用者が意図して忘れさせた、という**製品の振る舞い**）ではなく
`superseded`（より良い抽出に置き換えられた、という**機構の都合**）にするのはオーナー決定
である。詳細・却下した案・引き受けた負債は
[ADR 0028](./decisions/0028-reextract-superseded-cleanup.md) を参照。
supersede しなかった理由（`contested`/`forgotten` だったので飛ばした・変わっていなかった・
そもそも既存を見ていない）は `ReextractResult.skipped` に出る
（[ADR 0029](./decisions/0029-reextract-skip-visibility.md)）。

⚠ **2026-09-28 追記（[Issue #1079](https://github.com/takecchi/mnemora/issues/1079)・
[Issue #1149](https://github.com/takecchi/mnemora/issues/1149)）: 利用者の意思で退けた記憶を持つ Observation では、
`reextract` は抽出をやり直さない。** 同じ Observation（今の `extractorVersion`）の記憶に、`forgotten`（purge を含む）・
`contested`・訂正の解決で負けた `superseded` が1件でも在れば、LLM を呼ばず何も書かずに `extraction: "skipped"` を返す
（退けた記憶ごとに `skipped` に `status_not_active`）。機構で置き換えた `superseded`・`archived`・理由を読めない
`superseded` は数えない。observe の再送の規律（#897）と同じである。詳細は `Runtime.reextract` の doc と
[ADR 0028](./decisions/0028-reextract-superseded-cleanup.md) の 2026-09-28 追記。

⚠ **2026-10 記録（[ADR 0432](./decisions/0432-recall-status-recheck-and-archive-docs.md) AL-5。今の振る舞いを書くだけ）: `archived` の記憶を持つ Observation を `reextract` したときの帰結。** 上のとおり `archived` は退けた記憶に数えない（ADR 0028）ので、抽出は走る。**抽出結果が今の記憶と同じ内容なら何も起きない**——新しい記憶は作られず（`memoryIds` は既存の記憶そのもの）、記憶は `archived` のまま、`skipped` に `status_not_active`（`status: "archived"`）が入る。`reextract` は `archived` を戻さない（戻すには `restoreArchived`）。**内容が違えば新しい版が `active` で作られ**、古い `archived` は `superseded` にならず `archived` のまま残る——その古い版を `restoreArchived` で戻すと、新旧の2件が `active` で並ぶ。【確かめた】両 adapter（testkit の InMemory と Postgres）で走らせた。歯は `packages/postgres/src/__tests__/reextract-archived-memory.postgres.test.ts`。

⚠ **2026-09-30 追記（[ADR 0406](./decisions/0406-reextract-aborts-if-source-forgotten-while-waiting-for-llm.md)。[Issue #1226](https://github.com/takecchi/mnemora/issues/1226) と同じ穴）: LLM を待つ間に、その Observation から出た記憶が `forget`（`purge` を含む）されたときも、`reextract` は何も書かずに打ち切る。** 判定は LLM の前だけでなく、LLM が返った直後（書く前）にも行い、書き込み自身にも `abortIfForgotten` を渡す（`consolidate`/`reflect` と同じ2段）。戻り値は上の早期 return と同じ形（`status_not_active`、公開の型は増やしていない）。`abortIfForgotten` を実装しない adapter では読み直しだけが保護になり、読み直しと書き込みの間の窓は残る。待つ間の `contested` は見直さない。

⚠ **2026-09-26 追記（Issue #873）: `extractorVersion` を跨いだ旧い版の Memory は見ない。**
「同じ Observation に対して抽出をもう一度走らせ」の判定対象は
`MemoryStore.listBySourceObservation(ctx, observationId, extractorVersion)` が返す
——ここでの `extractorVersion` は**この `reextract()` を呼んだ runtime インスタンスが
生成時に固定した値**であり、呼び出しの引数ではない。⟹ `extractorVersion` を上げた
別の runtime インスタンスで同じ Observation を reextract すると、旧い版の Memory は
`toSupersede`/`skipped` のどちらにも現れず、supersede されずに `active` のまま残る
——同じ Observation に由来する新旧2件の Memory が同時に `active` になり、`recall()`
の候補集合に両方出続ける（実測、Fake）。**旧い版の Memory を退役させるのは運用側
（呼び出し側）の責務であり、`reextract()` はその経路を持たない。**版の並行比較
（`docs/roadmap.md` §4 技術上のリスク表）はこの性質の上に成り立っている。詳細は
[ADR 0028](./decisions/0028-reextract-superseded-cleanup.md) の 2026-09-26 追記。

⚠ **2026-09-30 追記（[Issue #1432](https://github.com/takecchi/mnemora/issues/1432)、
[ADR 0380](./decisions/0380-reextract-withdrawn-across-extractor-versions.md)）: 上の
2026-09-28 追記（「利用者の意思で退けた記憶を持つ Observation では、reextract は抽出を
やり直さない」）の判定は、`extractorVersion` を**問わなくなった**。** 2026-09-28 時点の
判定は「同じ Observation・**今の** `extractorVersion` の記憶」だけを見ており、
`extractorVersion` を上げた別の runtime インスタンスで reextract すると、前の版で
forget・contest した記憶を見落とし、退けたはずの内容と同じ意味の Memory が印の無い
新しい `active` として書き直されていた（Issue #1432 本文、実測——Fake・Postgres 双方）。
いまは `MemoryStore.listBySourceObservationAllVersions`（ADR 0380 で新設した必須メソッド）
を使い、版を問わず `forgotten`・`contested`・訂正の解決で負けた `superseded` を数える。

- **帰結**: 版を上げても、退けたものを含む Observation は新しい版の記憶を1件も作らない。
  ⟹ 運用側が旧い版の記憶を forget すると、その Observation のほかの（退けていない）事実も、
  以後の reextract では想起から作られなくなる。
- **運用側が見分ける手がかり**: `ReextractResult.skipped` に `status_not_active` が出た
  Observation では、旧い版の記憶を残すこと（forget を早まらないこと）。
- **変えていないもの**: 直上の2026-09-26 追記（Issue #873「版を跨いだ旧い版は退役させない・
  運用側の責務」）は、そのまま有効である。supersede 対象の判定は今どおり
  `listBySourceObservation(ctx, observationId, extractorVersion)`（**今の**
  `extractorVersion` 限定）のままで、退けたものが無い Observation では、今どおり新しい版で
  抽出され、旧い版の `active` は supersede されない。

詳細・却下した案・EXPLAIN の実測は [ADR 0380](./decisions/0380-reextract-withdrawn-across-extractor-versions.md)。

---

## 5. 矛盾の扱い

### 渡された問題設定

訂正を末尾に積むと、古い方が先に読まれる。ログは追記型なので「その場で置換」という手段が
そもそも使えない。

### ここで一度立ち止まって正直に書く

この因果——「訂正の積み上げによって実害が出た。だから mnemora は置換方針を採る」——は、
**alteroid のコードにもドキュメントにも記録が見つかっていない。** 現物（github.com/takecchi/alteroid）
で確認できたのは次の3点だけである。

- 全文置換ツール `memory_write` と末尾追記ツール `memory_append` が**両方**存在する。
- どちらを使うかは書き手（クローン）に委ねられており、システムとして強制していない。
- supersede（旧記憶を新記憶で置き換えたと機械的に記録する仕組み）や失効マークの機構は
  **存在しない。**

クローン自身がこの問題を実際に経験した可能性を否定するものではない——経験はリポジトリに
残らない性質のものである。しかし、**「alteroid で検証された結論」として今回の設計の根拠に
据えることはできない。** 以下の決定は alteroid の実地検証結果ではなく、問題設定から演繹した
mnemora 独自の設計判断として書く。

### mnemora の決定: 順序では解かない

「新しい方を上に出す」という順位付けの発想そのものを採らない。理由は単純で、**順位付けは
負荷が上がると崩れるが、フィルタは崩れない。** スコアリングにパラメータを足すたびに、
「新しさ」が他の要因（類似度・強度）に埋もれて後退する余地が生まれる。フィルタ（出す/出さない）
は二値であり、他の要因と競合しない。三つの機構すべてがこの原則——**順序ではなく状態と
隣接性で解く**——の具体化である。

**機構1: `status` を列で持つ。** `active | superseded | contested | archived | forgotten` の
5値。既定の recall は `status = 'active'`（および後述の `contested` の一部）で絞り、
`superseded` を**返さない。** 「下に出す」のではなく「出さない」。

**機構2: 判定できないときは `contested` に落とす。** どちらが正しいか、あるいはどちらが
新しいかを機械的に決められない場合、両者を `superseded` にはしない。`contested` な Memory は
**単独で返してはならない。** 対向する Memory を**スコアに関係なく必ず一緒に取得する**
（mandatory companion retrieval）。予算（文字数・トークン）の都合で対向を載せられない場合は、
その Memory 自体に「争われている」という印を付けて返すか、丸ごと落とす。**争われている主張を、
争われていない顔で出さない。**

**機構3: 隣接を不変条件にする。** 訂正の積み上げで実害が出たのだとしても、その正体は
「古い方が上に出ていた」ことではなく、**「古い方と新しい方が離れていた」**ことである。順位が
入れ替わっていても、両方が隣り合って提示されていれば読み手は矛盾に気づける。⟹ 対向関係にある
Memory は、recall の提示順を通じて**必ず隣接させる**。並び順のどこにも「新しい方だけが単独で
出てくる」状態を作らない。

⚠ **2026-09-30 追記（Issue #207/#933 PR2、[ADR 0292](./decisions/0292-relation-graph-table-depth-omitted-design.md) 決定2・3、[ADR 0381](./decisions/0381-contested-group-write-path-implementation.md)）**:
機構2・機構3が想定していた「対向」は2者間の対だけだったが、多者間（3件以上）の
`contested` 群（`memory_relations`）にも同じ機構を広げた——群は「対」ではなく「単位
（Unit）」として隣接させる（3件以上が連続して提示される）。`RuntimeDeps.relationStore`
が配線されていない場合、群のメンバーはこれまでどおり単独で返らず候補ごと落ちる
（機構2を破るくらいなら出さない、という判断をそのまま踏襲する）。詳細は `docs/recall.md`
§2 段3・§8。

### スキーマ上の帰結

```sql
status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','superseded','contested','archived','forgotten')),
superseded_by_id   uuid NULL REFERENCES memories(id),
contested_with_id  uuid NULL REFERENCES memories(id),
```

`superseded_by_id` を列として持つ理由は、**グラフ探索ではなく索引で引けるようにするため。**
「この Memory を置き換えたのはどれか」は recall のたびに評価される頻出クエリであり、
関係グラフ（`memory_relations`、Phase 2）を毎回辿るのは高負荷帯では避けたい。列にしておけば
`WHERE superseded_by_id IS NOT NULL` の単純な索引アクセスで済む。

`contested_with_id` は同じ理由で `status` 列・`superseded_by_id` 列の決定を
一対一の対向関係に限って Phase 1 で成立させるための補助列である。関係グラフ本体（多対多の
`contradicts` / `supersedes` 等、`memory_relations` テーブル）は Phase 2 だが、
**`status`・`superseded_by_id`・`contested_with_id` の3列は Phase 1 のスキーマに入れる。**
これは [roadmap.md](./roadmap.md) の Phase 1 範囲の決定（「後付けのマイグレーションにしない」）をそのまま反映している。一対一の
関係で表現できないケース（一つの Memory が複数の Memory と同時に争われている等）は Phase 2 の
`memory_relations` を必要とし、Phase 1 では `contested_with_id` が指す1件を必須の道連れとして
scoping する設計に留める。

### ⚠ 2026-09-26 追記（Issue #854）: `superseded_by_id`/`contested_with_id` はテナント一致を検査しない

上の `REFERENCES memories(id)` は**単純な FK であり、`tenant_id` を見ない**。
`superseded_by_id`/`contested_with_id` は、書き手が同じテナントの id を渡す前提で書かれた欄だが、
Postgres 側の唯一の検査はこの FK（「`memories` のどこかに存在する id か」）であり、
アプリ側の唯一の検査（`isContestedWithoutCompanion`、
`packages/core/src/interfaces/memory-store.ts`）も「`status === 'contested'` なのに
`contestedWithId` が無い」ことしか見ない。`packages/testkit` の Fake（in-memory）は
FK すら持たないため、存在しない id を渡しても素通る。

**それでも読み取り漏洩・書き込み漏洩には繋がらない**（クローン miku の判断による記録、
[ADR 0220](./decisions/0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)。
実測済み——Issue #854）。`MemoryStore` の他の全ての口が `tenant_id = ctx.tenantId` で
読み書きを絞っているため、他テナントの id を指すダングリング参照が行き先テナント自身の
行に残るだけで、`get`/`getMany` はテナントが違えば `null`/`[]` を返す。`recall()` の段3
（必須同伴取得）も同じ口を経由するため、同伴が別テナントなら単に「対向が見つからない」
扱い（`unit_assembly_dropped`）に落ちる。`Runtime` を経由する呼び出し
（`markContested`/`resolveContested`/`consolidate`/`reflect`/`reextract`）は、いずれも
同じ `ctx` で存在を確かめた id からしか `contestedWithId`/`supersededById` を組み立てない
——到達するのは `MemoryStore`（`@mnemora/core` の公開 interface）を直接呼ぶ経路だけである。

⚠ **2026-10 追記（[ADR 0439](./decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md)）: 上の節（#854）は、もう今の振る舞いではない。**
`superseded_by_id`/`contested_with_id` に書く口は、参照先が `ctx.tenantId` の記憶でなければ、何も書かずに `memory not found for tenant: <id>` で投げる
（`createMemory`・`createMemoryWithOutbox`・`createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories` の入力、`updateStatus`・`updateStatusWithEvent`・
`resolveContestedPair`・`resolveContestedGroup` の `supersededById`。`@mnemora/postgres`・`@mnemora/testkit` の fixture とも）。
上の「それでも読み取り漏洩・書き込み漏洩には繋がらない」は、`eraseTenant` と `purgeExpiredRecalls` を見落としていた——別テナントの id を指す行が1本在ると、
指された側の `eraseTenant` が `blocked_by_foreign_reference` で止まる（ADR 0439 の「文脈」）。読みの漏洩が無いことは今も変わらない。
上の本文は、当時の記録として書き換えていない。

### ⚠ 2026-09-27 追記（Issue #1051）: ほかの書き込みの口も、参照の id のテナント一致を検査しない

上の #854 の節と同じ形が、`superseded_by_id`/`contested_with_id` のほかにも在る。次の口は、ほかの
テナントの id を参照として渡されても検査しない（クローン miku の判断により、今の振る舞いを記録する。
入力を狭める・adapter を揃える案は採らなかったが、選び直す余地は [Issue #1051](https://github.com/takecchi/mnemora/issues/1051) に残してある）。

| 口 | ほかのテナントの id を渡す欄 | `@mnemora/postgres` | `@mnemora/testkit` の fixture |
|---|---|---|---|
| `MemoryStore.createMemory` | `sourceObservationId` | 受け付ける | 受け付ける |
| `MemoryStore.recordUsage` | `recallId`・`memoryIds` | 受け付ける（`insertedMemoryIds` に入る） | 受け付ける |
| `EventStore.append` | `memoryId` | 受け付ける | 拒む（`memory not found`） |
| `VectorStore.upsert` | `memoryId` | 受け付ける | 拒む（`memory not found`） |

Postgres の外部キー（`observations(id)`/`recalls(id)`/`memories(id)`）は `tenant_id` を含まないので、DB も
止めない。**それでも読み取り漏洩・書き込み漏洩には繋がらない**——ほかのテナントの行は変わらず、
読みの口はすべて `ctx.tenantId` で絞る。`VectorStore.upsert` で書いた行も、`search` が `memories` と
テナントで突き合わせるので検索に出ない。`Runtime` は同じ `ctx` で確かめた id しか渡さず、
`observe({ kind: "memory_usage" })` は `recordUsageAndReinforce` が在れば強化の段で
「memory not found」になって記録ごと巻き戻る。⟹ この形になるのは、`MemoryStore`/`EventStore`/
`VectorStore`（公開の interface）を直接呼ぶ経路だけである。各口の TSDoc にも同じことを書いた。

⚠ **2026-10 追記（[ADR 0436](./decisions/0436-event-vector-write-checks-memory-belongs-to-ctx-tenant.md)）: 上の表の `EventStore.append` と `VectorStore.upsert` の2行は、もう成り立たない。**
両方とも、記憶が `ctx.tenantId` のものでなければ、行を書かずに `memory not found for tenant: <id>` で投げる（`@mnemora/postgres` も、fixture と同じ）。
上の「読み取り漏洩・書き込み漏洩には繋がらない」は、`eraseTenant` を見落としていた——別テナントの記憶 id を指すイベント・埋め込みの行が1本在ると、
指された記憶のテナントの `eraseTenant` が `blocked_by_foreign_reference` で止まる（ADR 0436 の「文脈」）。
`MemoryStore.createMemory`・`recordUsage` の2行は変わらない。上の本文は、当時の記録として書き換えていない。

⚠ **2026-10 追記（[ADR 0439](./decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md)）: 上の表の残り2行（`MemoryStore.createMemory` の `sourceObservationId`、`MemoryStore.recordUsage` の `recallId`・`memoryIds`）も、もう成り立たない。**
`sourceObservationId` が `ctx.tenantId` の observation でなければ `observation not found for tenant: <id>`、`recallId` が `ctx.tenantId` の recall でなければ
`recall not found for tenant: <id>`、`memoryIds` のどれかが `ctx.tenantId` の記憶でなければ `memory not found for tenant: <id>` で、行を書かずに投げる
（`@mnemora/postgres` も fixture と同じ。1件でも違えば `recordUsage` は全体を書かない）。上の「2026-10 追記（ADR 0436）」の「変わらない」は、この追記が覆した。
これで、表の4行はすべて「拒む」になった。既に書かれてしまった行は遡って消していない（見つける SQL は ADR 0439 の「引き受けた負債」）。

### ⚠ 2026-09 追記（Issue #371、(B) 第1段。[ADR 0185](./decisions/0185-contradiction-detection-path.md)/[ADR 0315](./decisions/0315-claim-key-does-not-touch-extraction-cassettes.md)）: `claimKey`（主張キー）を足した——**検出はまだ無い**

`memories.claim_key_subject`/`claim_key_predicate`（`Memory.claimKey: {subject, predicate} | null`）
を足した。**この節（矛盾の扱い）に書くのは、これが将来「判定できない対向を検出する」
（機構2）の土台になることを意図しているからである。**⛔ **この2列は「何についての主張か」を
持たせるだけで、同じ鍵を持つ2件を見つけて `contested` を立てる処理は今日まだ無い**
（その検出は [Issue #372](https://github.com/takecchi/mnemora/issues/372) の範囲）。

**なぜ `provenance` と別の欄か（北極星 問い4「AI の推論と、ユーザーが言った事実を区別する」）**:
`claimKey` は LLM が作る ⟹ **推論である。**`provenance.kind`（`stated`/`inferred`）とは
**別の軸**——`stated` な Memory にも `claimKey` は付く。「ユーザーが『好きな食べ物はラーメン』
と言った」という事実そのものは stated でも、「これは "好きな食べ物" という属性についての
主張だ」という分類は LLM の推論である。**この区別を型・列名の両方で表す**——`claimKey` を
`provenance` のバリアントに混ぜず、独立した nullable な欄として持つ。

**LLM の呼び出し回数は増えない既定を守る**（北極星 問い1・問い5）: `claimKey` は既定では
一切埋まらない（`packages/core/src/claim-key.ts` の `deriveClaimKeys` は opt-in——
`runtime.observe()` に `claimKey: { enabled: true }` を渡したときだけ、既存の抽出候補群へ
候補群ぶん**1回（バッチ）**の別の構造化呼び出しを行う）。**既存の抽出プロンプト
（`extraction.ts` の `buildExtractionPrompt`）は1バイトも変えていない**——カセットの
照合鍵（`llmCassetteKey`）が変わらないことは `extraction.test.ts` の
「subjectCandidates 省略時の鍵（llmCassetteKey 相当）は固定値のまま動かない」がそのまま
固定している（この歯は claim key opt-in の追加でも1バイトも変わっていない）。

```sql
claim_key_subject    text NULL,
claim_key_predicate  text NULL,
```

索引 `idx_memories_claim_key`（`(tenant_id, subject_id, claim_key_subject, claim_key_predicate)`、
`WHERE claim_key_subject IS NOT NULL` の部分索引）を Phase 1 スキーマに足し、
`#372` の検出クエリ（「同じテナント・同じ subject_id・同じ claim key を持つ他の `active` な
Memory を探す」）が索引アクセスで済む形にしてある——`superseded_by_id`/`contested_with_id`
と同じ「グラフ探索ではなく索引で引けるようにする」理由付けを踏襲した。

**⚠ 2026-09-27 追記（[Issue #1109](https://github.com/takecchi/mnemora/issues/1109)）: 片方だけの `claimKey` は書き込みで拒まず、鍵なしとして扱われうる。**
型（`ClaimKey`）は2欄とも必須だが、TypeScript を通さない呼び出しやキャストで主語か述語の片方だけの
オブジェクトを `MemoryStore.createMemory`・`createMemoryWithOutbox` に渡しても、どちらの adapter も拒まない。
`@mnemora/postgres` は片方の列だけを入れた行を書き、読み出しでは鍵なし（`null`）として返す（`mapping.ts` の
`rowToClaimKey`。上の2列に CHECK 制約は無い）。`@mnemora/testkit` の fixture は片方だけのオブジェクトを
そのまま持って返す。どちらでも、その Memory は `findActiveByClaimKey` に一致せず `listActiveClaimPredicates`
にも数えられない（PR #1106 で fixture を Postgres に揃えた）ので、検出（下の #372）からは鍵なしと同じに見える。
クローン miku の判断で、書き込みで拒む案（入力を狭める。[Issue #809](https://github.com/takecchi/mnemora/issues/809) と同じ論点）・
書き込み時に `null` へ正規化する案は採らず、今の振る舞いを記録した（選び直す余地は Issue に残してある）。
書き分けは `Memory.claimKey` の TSDoc。

**#372（検出）が実装されても、進める先は `contested` までである。**[ADR 0185](./decisions/0185-contradiction-detection-path.md)
決定4: `claimKey` は推論から導かれる ⟹ 推論を根拠に `active → superseded`
（ユーザーが言った事実を消す側）へ進めてはならない。機構2が「判定できないときは
`contested` に落とす」と既に定めている先の、まさにその一例として扱う。

### ⚠ 2026-09 追記（Issue #372、(B) 第2段。[ADR 0324](./decisions/0324-claim-key-contested-detection.md)）: 検出を実装した——**列と索引だけで発火する。既定 off**

上の追記が「今日まだ無い」と書いていた検出処理を実装した。`runtime.observe()` に
`claimKey: { enabled: true, detectContested: true }` を渡したときだけ、新しく `active` に
なった Memory ごとに、同じ `tenant_id`・同じ `subject_id`（`null` 同士も一致として扱う）・
同じ claim key・有効期間（`validFrom`/`validUntil`）が重なる・`content_hash` が違う、
他の `active` な Memory を `MemoryStore.findActiveByClaimKey?`（新設の任意メソッド、
`idx_memories_claim_key` を使う）で探す。**LLM を一度も呼ばない。**

- **相手がちょうど1件** ⟹ `Runtime.markContested` を呼ぶ（機構2そのもの）。根拠
  （鍵・重なった有効期間・両側の `content_hash`）を `meta.note` に構造として載せる。⚠ **「構造として」は、`meta.note` の値が
  オブジェクトだという意味ではない。**入っているのは `JSON.stringify` した**文字列**で、読む側は
  `JSON.parse` が要る（§9「`meta.reason` の意味は、経路で2通りに割れている」の `meta.note` の型）。
- **相手が0件** ⟹ 何もしない。
- **相手が2件以上** ⟹ **`markContested` を呼ばない。**[#207](https://github.com/takecchi/mnemora/issues/207)
  （`memory_relations`、多対多）が無いと1対1の `contested_with_id` では表現できないため
  ——`memory_events` へ根拠（鍵・関係する各 `id`/`content_hash`/有効期間・件数）を
  `kind: 'updated'`・`meta.reason: 'claim_key_conflict_unresolved'`（`'contested'` とは
  別のタグ）で1件だけ残し、件数を数えられるようにする。

  ⚠ **2026-09-28 追記（今の振る舞い。[Issue #933](https://github.com/takecchi/mnemora/issues/933)）: 同じ鍵の主張が
  1件ずつ届く経路では、この「2件以上」の分岐には届かない。**毎回 `detectContested: true` を渡して1件ずつ
  `observe()` すると、2件目で1件目と対になって両方 `contested` になり、`findActiveByClaimKey?` の一致
  （`active` だけ）から外れる。⟹ 3件目は一致が0件で `no_conflict`・`active` のまま、`contestedWithId` も
  `claim_key_conflict_unresolved` のイベントも持たずに残り、4件目は3件目と新しい対になる。
  「同じ鍵に3件以上が並んだ件数を数えられる」は、この経路では成り立たない（1件目・2件目を検出なしで
  作ったなど、`active` のまま2件以上が並んだときだけ上の分岐に入る）。経緯と、直すときに要るもの
  （`contested` の行を一致に数える口）は [ADR 0324](./decisions/0324-claim-key-contested-detection.md) の
  2026-09-27 の追記にある。**直していない**（方針は Issue #933 で決まっていない）。

  ⚠ **2026-09-29 追記（別の経路。[Issue #835](https://github.com/takecchi/mnemora/issues/835)、
  [ADR 0377](./decisions/0377-claim-key-contested-detection-excludes-same-observation-siblings.md)）:
  上の追記が扱うのは「同じ鍵の主張が1件ずつ届く」経路だが、**1回の `observe()` が同じ鍵の
  複数候補を一度に生む**経路には別の問題があった——PR #1318（ADR 0347）が抽出の書き込みを
  「全件書く→全件について検出」の2ループへ分けた副作用で、同じ observation から抽出された
  兄弟どうしが互いの検出時点で既に `active` になり、`findActiveByClaimKey?` の一致に誤って
  混入していた。ADR 0377 は、検出中の Memory と同じ `sourceObservationId` を持つ一致を
  件数を数える前に除くようにして、これを直した——同じ observation の兄弟は、今は互いに
  `contested` にならない（1つの発話内の言い直しが2件に分かれる場合を除き、失うものは無い。
  詳細は ADR 0377）。**この追記が扱う経路（1件ずつ届く場合）は、直っていない。**

  ⚠ **2026-09-30 追記（Issue #933 の PR1。[ADR 0378](./decisions/0378-claim-key-contested-detection-covers-contested-matches.md)）:
  上の2つの追記（2026-09-28・2026-09-29）が「直っていない」としていた、1件ずつ届く経路の
  症状は直った。**新しい任意メソッド `MemoryStore.findContestedByClaimKey?`
  （`findActiveByClaimKey?` と同じ絞り込みで `status = 'active'` の代わりに
  `status = 'contested'` を見る）を実装している store では、検出が `findActiveByClaimKey?`
  の一致に `findContestedByClaimKey?` の一致を合わせて数える——ADR 0377 の兄弟除外も、
  合わせた一致に同じ形でかける。⟹ 3件目は「1件目・2件目（どちらも `contested`）を合わせて
  一致2件」で「2件以上」の分岐（決定6）に入り、`claim_key_conflict_unresolved` の
  イベントが積まれる。4件目は「3件目（`active`）+ 1件目・2件目（`contested`）」で一致3件
  ⟹ 同じ分岐。1件目・2件目の対は、3件目・4件目が届いても壊れない。
  **`findContestedByClaimKey?` を実装していない adapter では、今まで通り**
  （後方互換）。**ただし「3件以上のグループを実際に `contested` として recall に載せる」
  ようにはなっていない**——決定6が引き受けていた負債（状態を動かさない）はそのまま
  残る。多者間グループを表（`memory_relations`）へ束ねる書き込み経路は、
  [ADR 0327](./decisions/0327-relation-graph-contested-write-path-design.md) の設計に
  ADR 0378 が決定を与えたが、実装はまだ無い（Issue #933 の PR2）。詳細は ADR 0378。

  ⚠ **同日追記（穴埋め）: 下の「相手がちょうど1件 ⟹ `markContested` を呼ぶ」は、
  `findContestedByClaimKey?` を実装している store では不正確になった。**一致が
  ちょうど1件でも、その1件が既に `contested`（＝`findContestedByClaimKey?` 由来）
  だと、直した直後の版では `markContested` へ進んで CAS が `ineligible` を返し
  （相手が `active` でないため）、検出中の Memory は `active` のまま・痕跡も残らなかった
  ——3件目の有効期間が、既に対になった1件目・2件目のうち片方とだけ重なる場合に起きる。
  **今は、一致の `status` を見てから分岐する**——`active` な1件だけが `markContested`
  の対象になり、`contested` な1件は（相手が2件以上のときと同じ形で）evidence だけを
  積む（`unresolved_conflict`）。詳細は ADR 0378 追記。

  ⚠ **2026-09-30 追記（Issue #933 の PR2 段階B、[ADR 0381](./decisions/0381-contested-group-write-path-implementation.md)）:
  「3件以上のグループを実際に `contested` として recall に載せる」を実装した。**
  `runtime.observe()` に `claimKey: { enabled: true, detectContested: true }` を渡し、かつ
  `RuntimeDeps.relationStore` が配線されている呼び出しに限り、一致が2件以上・または
  ちょうど1件でも既に `contested` な場合に、evidence-only（`unresolved_conflict`）の代わりに
  `Runtime.markContestedGroup`（新設の任意メソッド、`markContested` の N者版）を実際に呼んで
  群として `memory_relations`（migration 0026）へ束ねる——群のメンバーは、既存の2者間の対の
  相方（穴A）・既存の3件以上の群（合併）も含めて組み立てる。**`relationStore` を配線しない
  呼び出しの挙動は1バイトも変わらない**（Issue #933 PR1〔ADR 0378〕の evidence-only の
  挙動を期待する既存の歯を1つも書き換えていない理由。当初は専用の opt-in フラグ
  `ClaimKeyOptions.formContestedGroups` を新設していたが、オーナー側クローンの判断で
  廃止し、`relationStore` の配線そのものを条件にした——[ADR 0381](./decisions/0381-contested-group-write-path-implementation.md) §4）。

  ⚠ **同日のさらなる追記: `recall()` 側（機構3の必須の同伴取得、下記 §5・§8）もこの群に
  対応した。** `contestedWithId` を持たない `contested`（3件以上の群のメンバー）は、
  `RuntimeDeps.relationStore` が配線されていれば `RelationStore.listRelated` を
  **幅優先で、関係の行でつながった全員に達するまで**辿って仲間を同伴取得する
  （さらに同日の直しで「1段だけ」から変わった——`resolveContestedGroup?` の CAS
  〔`WITH RECURSIVE`〕と同じ範囲を「群」として扱う。探索自体には安全弁がある、
  `docs/recall.md` 参照）——2者間の対（`contestedWithId` の直接参照）の既存規則は
  1バイトも変えていない。上限（`DEFAULT_RECALL_ASSOCIATION.maxCount`、既定10）・並び順
  （`validFrom` の新しい順→`id` の順）・`relationStore` 未配線時の扱い（`stage_skipped
  { stage: "relation" }`、候補が実際に無ければ積まない）の詳細は `docs/recall.md`
  §2 段3・§8、ADR 0381 §5 を見ること。

**`superseded` へ進む経路は依然として無い**——検出が書けるのは `active → contested`
（行6）までであり、`contested → active | superseded`（行7）は今日どおり
`resolveContested` の明示呼び出しのみ。

**既定は off のまま**（`detectContested` を渡さない・`enabled: false` の呼び出しは、
`findActiveByClaimKey` を一度も呼ばない）。**既定を on にするかどうかは、この PR でも
決めていない**（ADR 0185 決定7 が「#372 が着地して初めて意味を持つ」とした判断が、
まさにこの PR の着地である——決定そのものはオーナー専権のまま）。

---

## 6. 強化 (Reinforcement)

**実際に使われたものだけを強化する。検索に出ただけでは強化しない。** 候補に出たが LLM に
選ばれなかった Memory まで強化してしまうと、「よく検索に出るから強い」→「強いからさらに
検索に出やすい」という自己強化ループが生まれ、実際の有用性と無関係にスコアが積み上がる。
強化のトリガーは「候補になったこと」ではなく「使われたと報告されたこと」でなければならない。

**⚠ 2026-09-27 追記（[Issue #977](https://github.com/takecchi/mnemora/issues/977)）: 報告の中身は突き合わせない。**
mnemora は `usedMemoryIds` を、その recall（`recallId`）が返した集合とも、呼んだ `ctx.subjectId` とも
突き合わせない。その recall が返していない記憶や、別の subject の記憶（subject なしの記憶を含む）を
報告しても、同じテナントに在れば記録されて強化される（`@mnemora/postgres` と `@mnemora/testkit` の
fixture の両方で確かめた）。ほかのテナントの id は「not found for tenant」になる（Issue #1051。2026-10 の [ADR 0439](./decisions/0439-memory-store-reference-writes-check-target-belongs-to-ctx-tenant.md) 以降は、強化の段ではなく記録の段で拒まれ、何も書かれない）。
⟹ 上の「実際に使われたものだけを強化する」を守るのは**呼び出し側の報告**であり、
`usedMemoryIds` を `recall()` の `memories` から選ぶのは呼び出し側の責務である。この約束は、強化の
きっかけを「報告されたこと」に置いた上の文と食い違わない（報告を検証するとは書いていない）。
クローン miku の判断で、返した集合や subject で絞る案（受け付けている入力を拒むことになる）は採らず、
今の振る舞いを記録した。選び直す余地は Issue #977 に残してある。詳細は `ObserveMemoryUsageInput.usedMemoryIds`
の TSDoc。

**ここも正直に書く。** alteroid には reinforcement の実装が存在しない。使用回数・最終使用時刻・
スコア更新のいずれも見つからなかった。したがって上記の結論は**運用で検証された結論ではなく、
設計上の判断**である。「alteroid で効果が確認された」とは書けない。

### 冪等な強化

使用報告は `observe(ctx, { kind: 'memory_usage', recallId, usedMemoryIds })` で受ける
（§4 API 表面）。これは at-least-once（同じ報告が複数回届き得る）を前提にする必要がある。
カウンタを直接インクリメントする実装は、再送のたびに二重計上する。そのため mnemora は
インクリメントではなく**挿入の成否**で冪等性を作る。

```sql
CREATE TABLE recall_usages (
  tenant_id  text        NOT NULL,
  recall_id  uuid        NOT NULL REFERENCES recalls(id),
  memory_id  uuid        NOT NULL REFERENCES memories(id),
  used_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, recall_id, memory_id)
);
```

`(recall_id, memory_id)` の組が主キーであり、`tenant_id` を先頭に足しているのは
「全ての一意制約は tenant_id を先頭に置く」（[ADR 0007](./decisions/0007-tenant-scoping.md)）を一貫させるためである（`recall_id` は既に
特定の `recalls` 行に属し、その行は特定のテナントに属するため意味的な重複ではあるが、
索引・制約の形を全テーブルで統一する）。

同じ `(recall_id, memory_id)` の組が二度目に届いた場合、`INSERT ... ON CONFLICT DO NOTHING`
で**挿入自体が弾かれる。** アプリケーション層は「実際に新しい行が挿入されたかどうか」
（`INSERT` の返り行数、または `RETURNING`）を見て、**挿入が実際に起きたときだけ**
`memories.last_reinforced_at` を更新する（**`memories.strength` は動かさない**——
[ADR 0041](./decisions/0041-reinforce-does-not-change-strength.md)）。再送では何も変化しない。
これにより二重計上が構造的に起きない。

強化が起きると `decay_floor_at` を再計算する（§7）。これは「強化された時点で減衰の起点が
動く」というイベント駆動更新の唯一の発生源であり、cron による全件更新を不要にする設計
（§7）の前提そのものである。

---

## 7. 忘却と減衰 (Decay)

### 問題

pgvector の HNSW / IVFFlat 索引は、`ORDER BY` が距離演算子（`<=>` 等）の結果**そのまま**で
昇順のときにしか効かない。`ORDER BY similarity * decay` のように式にした瞬間、その ORDER BY は
索引を使えなくなる。一方で、テーブル全件に対して毎晩 `UPDATE` を回して減衰値を更新するような
cron ジョブは禁じられている（大量データ規模で破綻するため）。

### 決定: 「減衰した値」を保存せず、「閾値を割る時刻」を保存する

- 減衰は純関数 `decay(now, lastReinforcedAt, strength, halfLife)`。**この計算結果はどこにも
  保存しない。**
- 代わりに `decay_floor_at`（この Memory が閾値を下回る時刻）を**書き込み時（作成時・強化時）に
  一度だけ**計算して列に持つ。この値は時間の経過そのものでは変化しない——**単調**である。
  変わるのは強化が起きたときだけであり、これはイベント駆動の更新点であって、定期実行の
  全件走査を必要としない。

```sql
strength         real        NOT NULL DEFAULT 1.0,
half_life_hours  real        NOT NULL,          -- Memory 単位。テナント設定は既定値としてのみ使う
decay_floor_at   timestamptz NOT NULL,           -- 書き込み時に一度だけ計算
```

**⚠ 2026-09-27 追記（[Issue #1094](https://github.com/takecchi/mnemora/issues/1094)）: `strength`・`half_life_hours` は float4（`real`）で保存される。**
`@mnemora/postgres` はこの2つを float4 の精度に丸めて保存する（`@mnemora/testkit` の fixture は float64 のまま）。
`decay_floor_at` は、作成時は呼び出し側が float64 で計算した値をどちらの実装もそのまま保存するが、強化の後は
store が保存済みの値で計算し直すので、**強化後の `decay_floor_at` は実装によってずれうる。**ずれは半減期が長いほど
大きく、向きも一定しない。【実測】（自分専用の PostgreSQL 17 + pgvector と testkit の fixture、1日後の強化の後の
床の差 Postgres − testkit）: 720 時間 0ms、123456.789 時間 +15.6秒、約100万時間 −約6分、約1000万時間 −約32分。
クローン miku の判断で、列を `double precision` にする案（migration）・書く前に丸める案（結果を変える）は採らず、
今の振る舞いを記録した。値域の外を丸めて通さないこと（ADR 0125 決定7「黙って丸めない」）とは別の話であり、
値域の内側の値が float4 の精度になるのは今日の保存の形である（ADR 0125 の追記）。

### 二段検索とデータモデル側の帰結

具体的な二段検索の SQL の形（over-fetch と段2の再スコアリング）は `docs/recall.md` に譲る。
ここではデータモデル側の帰結——**どの列が必要で、いつ書き換わるか**——だけを述べる。

- 段1（索引が効く段）が要求するのは、**等値または単調な範囲比較で表現できるフィルタ**である。
  `tenant_id`・`status`・`decay_floor_at > now()` はすべてこの形に収まる。ベクトルの
  `ORDER BY` はそのまま距離演算子で書ける。
- 段2（索引が要らない段）が要求するのは、段1で絞り込んだ少数件（k × over-fetch 係数）に
  対して減衰・鮮度・強度を掛けて再スコアするための素材である。`decay()` の入力となる
  `last_reinforced_at`・`strength`・`half_life_hours` はこの段でのみ参照される。

### ⚠ 区別を潰さないこと: iterative scan はスコア問題を解かない

pgvector 0.8.0 で導入された iterative index scan（`hnsw.iterative_scan = strict_order |
relaxed_order`）は、**「WHERE フィルタ下での recall（再現率）改善」であって、
「ORDER BY のスコア式が索引を殺す」問題の解決策ではない。** 両者は別の問題であり、
対処も別である。

| 問題 | 対処 |
|---|---|
| フィルタ問題（`tenant_id` / `status` / `decay_floor_at > now()` の下で十分な件数を ANN が返せるか） | iterative scan (`hnsw.iterative_scan`) + `hnsw.ef_search` の調整 |
| スコア問題（減衰・タグ一致・鮮度を掛けた式で並べたい） | over-fetch + 段2の再スコア（索引に頼らない） |

この二つを混同して「iterative scan を有効にすれば `ORDER BY (similarity * decay)` が書ける」
と考えるのは誤りである。

### partial index についての注意

partial index は**離散値・低カーディナリティ**のフィルタに向く（PostgreSQL 公式の推奨）。

> ⚠ **2026-09-17 訂正。**「PostgreSQL 公式の推奨」の主体・出典は未検証。
> 逐語・判定・他文書との突き合わせは [ADR 0004](./decisions/0004-decay-at-query-time.md) の
> 同日の追記が正規の置き場である。そちらを見ること。
`decay_floor_at > now()` のような連続値・高カーディナリティの範囲条件を partial index の
**述語**に使うのは向かない（`now()` は immutable ではなく、固定した時刻を述語にしても
すぐ陳腐化する）。実際に使うのは次の形——**離散値（`status`）を partial 述語にし、
連続値（`decay_floor_at`）は索引の末尾に通常の列として持たせて範囲スキャンする**——である。

```sql
CREATE INDEX idx_memories_recall_gate
  ON memories (tenant_id, status, decay_floor_at)
  WHERE status IN ('active', 'contested');
```

`status IN ('active', 'contested')` が partial 述語（離散・低カーディナリティ、正しい
使い方）であり、`decay_floor_at` は述語ではなく索引の3列目として範囲スキャンに使われる。
この違いを取り違えると「partial index で忘却を解決しようとして効かない」という失敗を
なぞることになる。（述語が `'active'` 単独ではなく `'contested'` も含む理由は §10・
docs/decisions/0011-no-window-count-in-ann-stage.md を参照。）

### リスクと対処

**half_life をテナントごとに後から変えたくなった瞬間、`decay_floor_at` の全件再計算が必要に
なる**——これは [roadmap.md](./roadmap.md) のリスク表で名指ししているリスクである。対処は、`half_life_hours` を
**Memory 単位の列**として持つこと（既に上記 DDL の通り）。`tenant_settings` に持つ
既定値（§9・§10）はあくまで**新規作成時の初期値**として使うだけであり、テナント設定を
変更しても既存の Memory の `half_life_hours` を書き換えない。全件再計算はテナントが
明示的に「既存の記憶にも新しい half-life を適用したい」と要求した場合のみ、低頻度のバッチとして
実行する（Phase 1 の必須機能ではない）。

### 活動時計の読み口 — `getActivitySeq` と、そこから測れること（2026-09-24 追記、Issue #338 案2 の段0）

上の節は壁時計（`decay_floor_at`）だけを扱っている。**[ADR 0165](./decisions/0165-decay-activity-clock.md)
はもう1本、活動時計（`decay_floor_seq`）を足しており、その「いま」は `tenant_activity`
（テナントごとに1行、列は `tenant_id` / `activity_seq` / `updated_at` の3つだけ——DDL は
`packages/postgres/migrations/0015_decay_activity_clock.sql` 参照）が持つ。** `activity_seq` は `decay_clock` を `'wall'` 以外に設定した
テナントで、`recall()` が1回起きるたびに `MemoryStore.createRecall` と同一トランザクションで
+1 される単調増加のカウンタである（`observe()` は数えない）。

**この値を読む公開の口は、この追記より前から既に在る。** 新しい実装はしていない——ここは
[Issue #338](https://github.com/takecchi/mnemora/issues/338) 案2（「`activity_seq` の進みから
実際の recall 頻度を測る」）のための、**既存の読み口の使い方と限界を文書化するだけの追記**である。

- `TenantSettingsStore.getActivitySeq?(ctx): Promise<number>`
  （`packages/core/src/interfaces/tenant-settings-store.ts`、ADR 0165 決めたこと13）。
  **読み出し専用**——書き込む口はこの interface には無い。
- `packages/postgres` に実装済み（`PostgresTenantSettingsStore.getActivitySeq`、
  `tenant_activity` を `SELECT` するだけ）。`packages/testkit` の in-memory fixture、
  および両方の適合テスト（`describeTenantSettingsStoreConformance` の
  `supportsDecayClock` 配下）にも揃っている。
- 省略可能（`?` 付き）な理由は `getDecayClock`/`setDecayClock`/`getDefaultHalfLifeRecalls`
  と同じ——`@mnemora/core` は npm 公開済みであり、必須メソッドにすると外部の
  `TenantSettingsStore` 実装が軒並みコンパイルできなくなる（ADR 0165 決めたこと13）。
  未実装の adapter では `readActivitySeq()`（同ファイル）が `0` へ倒す。

**測り方（案2 そのもの）**: `getActivitySeq(ctx)` を2つの時点でサンプルし、差分を
「その間に起きた `recall()` の回数」として読む。

```
n0 = await tenantSettingsStore.getActivitySeq(ctx)   // t0 の時点
// ... 時間が経つ ...
n1 = await tenantSettingsStore.getActivitySeq(ctx)   // t1 の時点
// [t0, t1) の間に起きた recall() の回数 ≒ n1 - n0
```

サンプル間隔（1時間ごと・1日ごと等）・保存・閾値判定・アラートは、**すべて呼び出し側の
責務である**。mnemora 自身はスケジューラも保存先も持たない——`writeDecayClock` のような
「省略時の既定動作」を1箇所に閉じ込める規律（ADR 0165 決めたこと13）は、**読み出し専用の
`getActivitySeq` には最初から無い。**

**⚠ 限界（正直に書く）**:

1. **累積カウンタなので、過去の日ごとの回数は後から読めない。** `tenant_activity` は
   「いまの値」しか持たない——1テナント1行で、それ以前の値の履歴は保存されない
   （上の DDL のとおり）。⟹ **この読み口で測れるのは、自分がサンプルを取り始めた
   時点より後の頻度だけである。** 「先週の recall 頻度」を遡って知る手段はない。
   これを可能にするには日次の履歴テーブルのような新しいスキーマが要り、それは
   マイグレーションを伴う——本追記の段0では行わない（ADR 0290「検討した代替案」参照）。
2. **テナント全体のカウンタであり、`subject` 単位でも Memory 単位でもない。**
   別の `subject`・別のクエリの `recall()` でも同じカウンタが進む（ADR 0165 本文が
   確認している実測）。⟹ 「そのテナントに何人の利用者がいて、それぞれ何回
   `recall()` したか」は、この値だけからは分からない。分かるのは
   「そのテナント全体で `recall()` が何回起きたか」だけである。
   `subject` 単位のカウンタにする変種は、ADR 0165「これが覆るとしたら」1 が
   「オーナーの判断を要する種類の分岐」と明記しており、本追記では踏み込まない。
3. **`decay_clock` を一度も `'wall'` 以外に設定していないテナントでは、`activity_seq`
   は常に `0` のままである**（ADR 0165 決めたこと5）。⟹ この読み口で頻度を測れるのは
   `'activity'`/`'either'` を選んだテナントだけであり、既定（`'wall'`）のテナントに
   対してこの方法で recall 頻度を測ることはできない。
4. **`getActivitySeq` を持たない adapter（`readActivitySeq()` が `0` へ倒す）では、
   差分が常に `0` になる。** 「頻度がゼロだった」のか「そもそも測れていない」のかを、
   呼び出し側は `store.getActivitySeq !== undefined` を自分で見て区別する必要がある
   ——`readActivitySeq()` はこの区別を潰す（未実装も `0` として返す）ので、
   頻度測定の用途ではヘルパを経由せず `store.getActivitySeq` を直接呼ぶこと。

⟹ 案2 が答えるのは「[ADR 0165](./decisions/0165-decay-activity-clock.md) の逆算どおり、
1日3112回を超えて `recall()` するテナントが実在するか」という Issue #338 の問いに対して、
**採用者ごとに、いま以降を自分で観測する手段**である。**この repo 自身が全採用者の頻度を
集約して見張る機構ではない**（そのような機構は本追記の範囲外——ADR 0290 参照）。
既定 `720`（Issue #338 案3）や `subject` 単位カウンタへの変種は、依然としてオーナー判断の
範囲であり、この追記も踏み込まない。

**境界の実測（2026-09-25 追記、[ADR 0311](./decisions/0311-activity-clock-boundary-measured-soft-and-hard.md)）**:
上の「3112回」は、硬いゲートの境界として実測で確かめてある（`scoreThreshold: 0` のとき、
3112回目まで返り、3113回目で消える）。**`scoreThreshold` を省略した既定の呼び方では、
段2の足切り（`0.1`）が先に効く。既定 `720` で最大 2392回、問いの近さが 1 未満ならさらに手前で
返らなくなる。** また、`recall()` だけでは強化されない（強化は使用報告でだけ起きる）。
回数はテナント合計で数える（別 subject に絞った recall でも進む）。

**⚠ 2026-09-29 追記（[ADR 0353](./decisions/0353-activity-counting-per-call.md)、
[Issue #338](https://github.com/takecchi/mnemora/issues/338)）: 上の「限界」2 は、もう実態ではない。**
「`subject` 単位のカウンタにする変種は、ADR 0165『これが覆るとしたら』1 が『オーナーの判断を要する
種類の分岐』と明記しており、本追記では踏み込まない」と書いていたが、**オーナーが答えた
（ask_human 61355570「呼び出す際の引数で指定できるようにはできない？」）ことを受け、
`RecallQuery.activityCounting: "tenant" | "subject"`（既定 `"tenant"`）として実装した。**

- `activityCounting: "subject"` を選び、かつ `ctx.subjectId` を指定した recall は、テナント全体の
  `T`（`tenant_activity.activity_seq`）ではなく、その subject 専用のカウンタ `S_x`
  （新テーブル `tenant_subject_activity`、`tenant_id`/`subject_id`/`activity_seq`/`updated_at`）を進める。
- `getActivitySeq(ctx)` が返す `T` は、`activityCounting: "subject"` を使う呼び出しがあっても
  **変わらない**——`S_x` は別の口（`TenantSettingsStore.getSubjectActivitySeqs?(ctx, subjectIds):
  Promise<Record<string, number>>`）で読む。
- ある Memory（subject `x`）の忘却ゲート・段2の再スコア・掃引が実際に使う「有効ないま」は、
  `activityCounting` の値に関わらず常に `T + S_x`（`x` が無い記憶は `T` のみ）——本追記が「限界」として
  書いていた「そのテナント全体で何回起きたか」しか分からない、という制約は、`activityCounting: "subject"`
  を選んだ呼び出しに限って解消されている。既定 `"tenant"` の呼び出ししかしていないテナントには、
  この追記より前と1バイトも変わらない挙動が残る（`TenantSettingsStore.hasSubjectActivityCounters?` が
  `false` のまま）。
- 詳細・保守操作への配線・引き受けた負債は ADR 0353 を見ること。

---

## 8. taxonomy の strict / open

**決定: 二つのモードを二つの経路にしない。「ラベルの状態」一つで表す。**

書き込みは常に自由（open）である。未登録のラベルが付いていても書き込みを失敗させない。
記憶を失うくらいなら受け取る、という判断を taxonomy にもそのまま適用する。ラベルは
`registered | proposed` の状態を持ち、テナントが語彙として登録すると `registered` になる。

**`strict` モードが変えるのは「`proposed` なラベルが検索のフィルタ・加点に参加できるか」
だけである。** strict でも書き込みは通り、`proposed` として記録され、件数が数えられ、
将来 `registered` へ昇格する候補として表に出る。strict と open は同じ機構・同じ経路を通り、
違うのは検索側の真偽値ひとつだけである。

このモデルには専用の「不在の章」を recall.md に立てる必要が無い。strict モードで
`proposed` ラベルがフィルタから外れて記憶が返らなかった場合、それは recall の
`Omission.kind = 'filtered'`（どの条件で落ちたか、を持つ既存の分類）にそのまま乗る——
「taxonomy 用の特別な不在の種類」を新設しなくても、既存の filtered の一種として表現できる。
strict/open を「ラベルの状態」ひとつに単純化した設計上の判断が、recall 側の説明可能性の
語彙を増やさずに済むという形で噛み合っている。

```sql
-- Phase 2
tags text[] NOT NULL DEFAULT '{}'   -- Phase 1: memories 列。open のみ、strict 判定なし
```

```sql
-- Phase 2: labels テーブルが登場して初めて strict/open の区別が意味を持つ
CREATE TABLE labels (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text        NOT NULL,
  name           text        NOT NULL,
  status         text        NOT NULL DEFAULT 'proposed' CHECK (status IN ('registered','proposed')),
  proposed_count integer     NOT NULL DEFAULT 0,
  registered_at  timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE memory_labels (
  tenant_id text NOT NULL,
  memory_id uuid NOT NULL REFERENCES memories(id),
  label_id  uuid NOT NULL REFERENCES labels(id),
  PRIMARY KEY (tenant_id, memory_id, label_id)
);
```

Phase 1 は `memories.tags`（`text[]`、常に open な自由記述）のみを持つ。
`labels` / `memory_labels` は Phase 2 で導入し、`tenant_settings.taxonomy_mode`
（後述 §10）が `strict` のテナントでのみ `proposed` 状態が検索へ影響する。既存の `tags` は
`labels` 導入時に `proposed` として移行できる形にしておく。

**⚠ 2026-09 訂正（roadmap.md 段階4/5 の実装 PR）: 「フィルタ・加点に参加しない」という
記述は誤りだった。** この文は「taxonomy の strict/open（`labels` の registered/proposed）
という*ラベル語彙の登録制度*には `tags` はまだ参加しない」ことを言おうとしたものだが、
文面が「`tags` はスコアリングにも一切参加しない」とまで読める形になっており、
実装（`packages/core` の `defaultScoringStrategy`、[./recall.md](./recall.md) §7）および
[./roadmap.md](./roadmap.md) 段階4の完了条件（「vector + tag + freshness のスコアリング」）と
正面から食い違っていた。正しくは次の通りである。
（⚠ 2026-09-29 追記: この段落と下の「段階3 の完了条件」が指す `docs/roadmap.md` §2 は削除した（#762）。当時の本文は
[`635c93d` の版](https://github.com/takecchi/mnemora/blob/635c93dcda148f44cf6b51ac2407b28596fccb32/docs/roadmap.md?plain=1#L62-L131) にある。）

- **`tags` は段2の再スコア（[./recall.md](./recall.md) §2・§7）の加点要素として参加する。**
  クエリタグとの一致数に応じて `ScoreBreakdown.tagMatch` を押し上げるが、
  一致しないことで `total` を 0 に落とすことはない（加点であって除外条件ではない）。
- **`tags` は段1のフィルタには参加しない。** `tags` が無い・一致しないことを理由に
  Memory を候補集合から除外する経路は無い（recall.md §2 のスコープ確定・候補生成の
  いずれにも `tags` によるゲートは無い）。
- **taxonomy の strict/open（`labels` の registered/proposed）という語彙登録制度への参加は
  引き続き Phase 2 である。** `tags` が Phase 1 のスコアリングに参加することと、
  `labels` テーブルによる語彙管理が Phase 2 であることは別の軸であり、混同しない。

**⚠ 2026-09 追記（Issue #152/#153、[ADR 0312](./decisions/0312-observe-recall-caller-attributes.md)）:
`memories.attributes`（呼び手が申告する任意属性）を足した。`tags`/`labels` と役割が
重なって見えるが、3本は「誰が値を決めるか」で分かれている——統合するとむしろ
北極星の問い4（AI の推論とユーザーが言った事実を区別する）に反する。**

| 軸 | 何を入れるか | 誰が値を決めるか | Phase |
|---|---|---|---|
| `tags`（本節・上） | 話題・内容の要約 | **100% LLM の推論**（`buildExtractionPrompt` は語彙・粒度を指示しない） | Phase 1（段2の加点のみ、上記訂正） |
| `attributes`（新設） | 公開範囲・区分などの**宣言された属性** | **100% 呼び手の申告**（抽出器は一度も読み書きしない） | Phase 1（段1の絞り込みに参加、[recall.md](./recall.md) §2 段0） |
| `labels` / `memory_labels`（上記 SQL） | **統制語彙**（テナントが登録した語彙） | **repo（スキーマ）が決める語彙に、呼び手が当てる** | Phase 2（未着地） |

**`attributes` は `tags` と違って段1（候補生成）に参加する**——ここが `tags` との
決定的な違いである。`tags` を段1に混ぜない（本節の訂正）のは「LLM の推論で母集合を
削ると北極星の問い4に反する」ためだが、`attributes` は呼び手が申告した事実そのもの
なので、同じ懸念が当たらない。

**⚠ Phase 2 の `labels` が着地したとき、`attributes` はその代わりにならない。**
`labels` は「テナントが統制する語彙にどれだけ従っているか」を問うものであり、
`attributes` は「呼び手が何を宣言したか」を問うものである——前者は repo 側が語彙を
決め、後者は呼び手が値そのものを決める。この違いは `labels` が実装された後も残る。

**⚠ 2026-09-25 追記（Issue #201 PR-A、[ADR 0318](./decisions/0318-taxonomy-labels.md)）:
上の表の `labels`/`memory_labels` の Phase は「Phase 2（未着地）」と書いてあるが、
本追記の時点で古い。** `labels`/`memory_labels` を任意の追加として前倒しで実装した
（`migrations/0020_taxonomy_labels.sql`、既存 `memories.tags` からの backfill を含む）。
`MemoryStore.listLabels?`/`registerLabel?`（任意メソッド）で語彙の一覧・`registered`
への昇格ができ、`TenantSettingsStore.getTaxonomyMode?`/`setTaxonomyMode?`（任意メソッド）
で `taxonomy_mode` を読み書きできる。**前倒ししたのは保存・語彙の口だけであり、
`labels` を使った recall の絞り込みは PR-B（下記追記）で実装した。**

**さらに、本節の冒頭が書いている「`strict` モードが変えるのは『`proposed` なラベルが
検索の*フィルタ・加点*に参加できるか』だけである」のうち、*加点*の側は実装しない
方針に変わった。** ADR 0318「決定5」参照——**上の「2026-09 訂正」段落が確立した既存の
`tagMatch`（`tags` の生の一致数による加点、`recall.md` §7）は、`taxonomy_mode` の値に
関わらず今日と同じ計算をし続ける。** 変えると、`strict` なテナントの既存スコアが
この PR によって動いてしまう（呼び出し側の挙動を1バイトも変えないという制約に反する）。
`strict` が実際に効くのは、`labels` を使った**新しい**絞り込みに対してだけである
（下記追記のとおり実装済み）。

**⚠ 2026-09-25 追記（Issue #201 PR-B、[ADR 0323](./decisions/0323-taxonomy-recall-filter.md)）:
上の「PR-B、まだ実装していない」は、本追記の時点で古い。** `RecallQuery.labels?`/
`taxonomyGroups?` を実装した——recall の段1（ANN・語彙）・段3.5（連想枠）・
`aggregateScope` への絞り込みの伝播、`taxonomy_mode` の参加資格（open: registered/proposed
両方、strict: registered のみ）、`FilteredOmission.condition: 'taxonomy'` の報告、
`GroupCount.axis: 'taxonomy'`（呼び手が明示したときだけ）のいずれも着地している。
**`tagMatch`（上）は引き続き変えていない**——`docs/recall.md`「taxonomy によるラベルの
絞り込みと群カウント」節、ADR 0323 を参照。

**⚠ 2026-09-27 追記（[Issue #953](https://github.com/takecchi/mnemora/issues/953)、今の振る舞いを書くだけ）:
`tags` と `labels` の名前は、文字列の完全一致で比べる。正規化はしない。**
大文字小文字・全角半角（NFKC）・Unicode の正規化形（NFC/NFD）・前後の空白のどれも、同じものとして
扱わない。⟹ `Foo`・`foo`・` foo `・`ｆｏｏ` を `tags` に書くと、`labels` には4つの別々の語彙として
残る。`registerLabel('foo')` が `registered` にするのは `foo` だけである。`RecallQuery.labels: ['project']` は
`tags: ['Project']` の記憶に当たらない。段2の `tagMatch` も完全一致で数える。
`@mnemora/postgres`・testkit の `InMemoryMemoryStore`・core の Fake の3つは、どれもこのとおりに動く
（Issue #953 の実測）。

- 例外は1つだけ: LLM が返した tags のうち、空文字・空白だけの要素は Memory に書く前に捨てる（PR #1122）。
  空白でない要素の前後の空白は削らない。
- `tags` はほとんどが LLM の出力なので、実運用では表記ゆれが起こりうる。ただし、どのくらい起こるかは
  測っていない。
- 同一視する範囲を決めて正規化するのは、新しい方針になる。保存済みの `tags`・`labels` の意味も変わる
  （既に分かれて残っている行をどう統合するか）。**決めていない。**比較のために書くと、claim key は
  書き込み側で `normalizeClaimKeyPart`（NFKC → trim → 小文字化 → 空白を `_`）を通す約束がある
  （[ADR 0320](./decisions/0320-claim-key-field-implementation.md)、`packages/core/src/claim-key.ts`）。
  tags・labels にはその約束が無い。

**⚠ 2026-09-27 追記（ラベルの一生、今の振る舞いを書くだけ）: ラベルの行は作られるだけで、消えない。
状態は `proposed` → `registered` の一方向だけである。**`@mnemora/postgres` と testkit の
`InMemoryMemoryStore` の両方で、次のとおり動く（2026-09-27 に同じ筋書きを両方へ当てて一致した）。

| 出来事 | ラベル |
|---|---|
| `tags` を持つ Memory が新しく作られる（抽出・統合・省察・再抽出の新しい行を含む） | その名前の行が無ければ `proposed`・`proposedCount: 1` で作る。`proposed` なら `proposedCount` を1進める。`registered` なら何も変えない |
| `registerLabel?` | 行が無ければ `registered`・`proposedCount: 0` で作る。`proposed` なら `registered` にする。`registered` なら何もしない（冪等） |
| Memory が `forgotten`・`archived`・`superseded` になる | **何も変わらない**（行も `proposedCount` も残る） |
| Memory を purge する | **その Memory の紐付け（`memory_labels`）を外し、`status: 'proposed'` の行の `proposedCount` を1減らす（床は0。`registered` な行は減らさない）。行そのもの（`labels` の名前）は消えない**（[ADR 0375](./decisions/0375-purge-scope-widened.md) 決定1・決定2、2026-09-29。[Issue #995](https://github.com/takecchi/mnemora/issues/995) が起票した「何も言っていない」を埋めた） |
| `registered` を `proposed` に戻す・ラベルを却下する・消す | **口が無い** |

⟹ 利用者から見ると、次の2つが起こる。
- **誰も使わなくなった `proposed` のラベルも、`listLabels?` に出続ける。**例: タグ `m` の記憶を1件作って
  archive すると、`m` は `proposed`・`proposedCount: 1` のまま残る。
- **`proposedCount` は、いま生きている記憶の数と大きく離れうる。**例: タグ `k` の記憶を2件作って forget と
  archive にし、さらに2件作ってから `supersedeWithNewMemories` で1件へ統合すると、生きている `k` の記憶は
  1件なのに、`proposedCount` は 5 になる（作成4件 + 統合先1件）。ADR 0318「引き受けた負債」1 のとおりの
  近似値である。

`listLabels?` はテナントの全ラベルを1回で返し、ページングは無い。**使われなくなったラベルを消すか、
却下の状態を足すか、`proposedCount` を生きた記憶の数に直すかは、新しい方針になる。決めていない。**

---

## 9. 監査ログ

**Phase 1 に入れる。** 理由は単純で、追加費用は1テーブルと1 INSERT 程度である一方、
後から入れると「入れる前に消えたもの」が永久に見えなくなる。監査ログはその性質上、
「無かった期間」を後から埋め合わせられない唯一の機能である。

### alteroid から採る担保の作り方

ここは現物で確認できた設計であり、そのまま真似る価値がある。alteroid の `JournalStore`
インターフェース（`packages/core/src/store.ts:368`）は次の3メソッドしか持たない。

```ts
interface JournalStore {
  append(entry: JournalEntryInput): Promise<JournalEntry>;
  list(query?: JournalQuery): Promise<JournalEntry[]>;
  get(id: string): Promise<JournalEntry | null>;
}
```

**`update` も `delete` も型に存在しない。** 型に無ければ、実装がうっかり間違って消す経路が
生えない。削除経路自体は alteroid 内に2箇所（ツール経由・HTTP 経由）あるが、どちらも
「対象を消す処理」と「journal への `append`」を同一処理内で呼んでおり、削除だけが
単独で起きて記録が残らない、という状態を作れない構造になっている。

mnemora の `EventStore` interface（`packages/core` が定義し `packages/postgres` が実装する）も
同じ形にする。**`append` / `list` / `get` のみを持ち、`update` / `delete` を持たせない。**

### スキーマ

```sql
CREATE TABLE memory_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text        NOT NULL,
  memory_id         uuid        NULL REFERENCES memories(id),  -- kind='events_purged' の場合のみ NULL
  kind              text        NOT NULL CHECK (kind IN
                       ('created','updated','superseded','archived','forgotten','purged',
                        'events_purged','restored','unsuperseded')),
                    -- 実物の制約は packages/postgres/migrations/（最新は 0018_memory_events_kind_unsuperseded.sql）
  at                timestamptz NOT NULL DEFAULT now(),
  actor             jsonb       NOT NULL,   -- { type: 'human'|'system'|'clone', id?: string }
  digest_snapshot   text        NULL,       -- 記録時点の digest。本文(content)は写さない
  size_before_bytes integer     NULL,       -- 削除・置換の直前サイズ
  meta              jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- kind 固有の付帯情報
  CHECK (kind <> 'events_purged' OR memory_id IS NULL)
);

CREATE INDEX idx_memory_events_by_memory ON memory_events (tenant_id, memory_id, at);
CREATE INDEX idx_memory_events_by_kind   ON memory_events (tenant_id, kind, at);
```

記録項目は tenant_id / memory_id / kind / at / actor / digest のスナップショット / 直前の
サイズに限る。**本文（`content`）は残さない。** 監査ログ自体が情報漏洩の経路にならないための
制約である。`kind` の値（`created / updated / superseded / archived / forgotten / purged /
events_purged / restored / unsuperseded`）はこの列挙をそのまま使い、`contested` のような細分は独立した `kind` を
増やさず `kind = 'updated'` の `meta`（例: `{"reason": "contested"}`）で
表現する。`kind` の値を増やしすぎると監査ログの分岐がアプリケーションコード側に漏れ出すため、
「状態が実際に変わった大分類」だけを `kind` にし、理由の粒度は `meta` に落とす。

**⚠ 2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1234](https://github.com/takecchi/mnemora/issues/1234)）**: ある Memory のイベントを `at` の順に読んでも、状態が変わった順とは限らない。`observe()` は候補を「書く → `created` を積む」の順で書き、1つのトランザクションではない（2026-09-28 から、候補を全件書いてから `created` を積む。[ADR 0347](./decisions/0347-extract-write-path-redelivery-and-unsaveable-candidates.md)）。その間にその1件が `forget` → `purge` されると、`created` は `forgotten`・`purged` の後に積まれ、`at` もその順になる（`created` の `digestSnapshot` は purge 前の digest）。「消した後に作られた」と読める並びは、作成の記録が遅れて積まれたものである。`@mnemora/postgres` と `@mnemora/testkit` の fixture で同じ。

**⚠ 2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1211](https://github.com/takecchi/mnemora/issues/1211)）**: `actor` と `meta` は JSON として保存される前提の欄で、値の中身は検査しない。`@mnemora/postgres` は `JSON.stringify` して `jsonb` に書くので、`Date` は文字列に、`NaN`・`Infinity` は `null` に、`-0` は `0` になり、`undefined` の欄は消える。BigInt は例外になる（**2026-09-29 から `@mnemora/testkit` の fixture も同じ例外を投げる——下の追記参照**）。
2026-09-28 追補: 欄の値が関数か Symbol のときは向きが逆になる——`@mnemora/postgres` はその欄を落として（配列の要素なら `null` にして）残りを書いて成功し、fixture は `DataCloneError` を投げる（状態もイベントも書く前に投げる、PR #1231）。これも揃える約束はしていない。
**2026-09-29 追記（[Issue #1211](https://github.com/takecchi/mnemora/issues/1211) の残り、オーナーの回答 ask_human `3f3411c5` を受けて）**: NUL（U+0000）か孤立サロゲートを含む文字列は、`@mnemora/postgres` と `@mnemora/testkit` の fixture の両方が拒むようになった。`Runtime` の口に渡す `reason`（`meta.reason`/`meta.note` に入る）・`actor.id` にも当たる——呼び出し側の文字列がそのまま `actor`/`meta` に入るため。Postgres では状態の書き換えとイベントの追記が同じトランザクションにあるので、拒んだときは両方とも取り消される（`forget` は `{ kind: "failed" }` を返し、`markContested` は例外を投げる）。fixture も、状態を書き換える前に同じ入力を拒む（`assertStorableMemoryEvent`）ので、`Runtime` から見える形は揃う。
**2026-09-29 追記（[Issue #1384](https://github.com/takecchi/mnemora/issues/1384)、オーナーの回答 ask_human `3f3411c5` を受けて）**: `actor`・`meta` の中身（入れ子・配列の要素も）に BigInt があるときも、`@mnemora/testkit` の fixture が `@mnemora/postgres` と同じ `TypeError`（`Do not know how to serialize a BigInt`）を、状態を書き換える前に投げるようになった（`assertStorableMemoryEvent` に検査を足した）。**この検査は他のどの検査よりも先に働く**——`@mnemora/postgres` は `INSERT` の引数を全部 JS 側で評価してから問い合わせを送るため、BigInt があると `kind`・`memoryId`・`at`・NUL/孤立サロゲートの検査を Postgres 自身が行う機会が無いまま `TypeError` になる（実測。`kind` 不正・`at` Invalid Date・`memoryId` 実在しない、のそれぞれと BigInt を同時に渡し、いずれも同じ `TypeError` になることを確認した）。fixture 側もこの優先順位に合わせている。

**⚠ 2026-09-26 改訂: `kind` の値の正は、この段落と上の DDL ではなく実装の型である。**
`packages/core/src/event.ts` の `MemoryEventKind`（union）と `MemoryEventKindSchema`（zod enum）、
DB 側は `packages/postgres/migrations/` の `memory_events` の `kind` の CHECK 制約
（`0011_memory_events_kind_restored.sql`・`0018_memory_events_kind_unsuperseded.sql` が値を足した）。
上の2つの列挙はそこから写したもので、値が増えたときに追いつかないことがある。
この段落は以前「`kind` の6値」として `created`〜`purged` だけを挙げ、上の DDL も `events_purged` までの
列挙だったが、実装には `events_purged`（本書の追加、次項）・`restored`（§11 行14、
[ADR 0122](./decisions/0122-restore-archived-memory.md)）・`unsuperseded`（§11 行15、
[ADR 0230](./decisions/0230-restore-superseded-recovery-path.md)）も在る。文書を実装に合わせた
（クローン miku の判断。オーナー本人の決定ではない）。

**⚠ 2026-09-26 改訂（[Issue #871](https://github.com/takecchi/mnemora/issues/871)）: 使用報告による強化（§11 行4）は `memory_events` に書かない。**
この段落は以前、細分の例に `reinforced` を挙げ、`{"reason": "reinforced", "recallId": "..."}` を
例示していた。しかし実装（`packages/core` の `Runtime` の使用報告の処理、`@mnemora/postgres` と
擬似実装の `MemoryStore.reinforce`/`recordUsage`）は、どれも `memory_events` に1行も積まない。
**「使われたか」の記録は `recall_usages` の行の存在で表す**（§6、`docs/architecture.md` の使用報告の表
「使われたかどうかは行の存在で表現する」）——監査ログに同じ事実を二重には持たない。
実装を文書に合わせる案は、使用報告のたびに対象 Memory 1件につき1行ずつ監査ログが
増える（書き込みと保持容量が、他のどの操作よりも高い頻度で増える）ため採らなかった。
この判断はクローン miku のものである（オーナー本人の決定ではない。
[ADR 0220](./decisions/0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。経緯は
[ADR 0009](./decisions/0009-usage-feedback-via-observe.md) の追記に在る。

`events_purged` は本書での追加である（理由は次項）。

**「必ず」の強制**: `forget()` は `EventStore` への追記と同一トランザクションで行う。
リポジトリ層を経由しない削除経路（例えば `packages/postgres` から直接 `memories` を
UPDATE するようなショートカット）を作らない。

**⚠ 2026-09-30 追記（文書だけ。実行時の振る舞いは変えていない）: `meta.reason` の意味は、経路で2通りに割れている。**
利用者が渡した `reason`（`forget`・`purge`・`consolidate` などの `opts.reason`）は、経路によって
`meta.reason` に入るか `meta.note` に入るかが違う。**`meta.reason` だけを読んで「利用者の文」と決めつけないこと。**
`packages/core/src/runtime.ts` を読んで、経路ごとに並べた（`@mnemora/postgres` の `memory-store.ts` と
`@mnemora/testkit` の fixture も、restoreSuperseded と archived は突き合わせた。それ以外の経路の2実装の一致は確かめていない）。

| 経路（`kind`） | `meta.reason` | 利用者の `opts.reason` |
|---|---|---|
| `forget`（`forgotten`）・`purge`（`purged`）・`restoreArchived`（`restored`） | 利用者の文。**省略すると `reason` キー自体が無い**（`meta` は `{}`） | `meta.reason` に入る |
| `restoreSuperseded`（`unsuperseded`） | 利用者の文。**省略すると固定タグ `'unsuperseded'`**（`@mnemora/postgres` は `event.reason ?? "unsuperseded"`、`@mnemora/testkit` の fixture も同じ）。`meta.supersededById` も付く | `meta.reason` に入る |
| `observe()` の抽出（`created`） | 固定タグ `'extracted'`、または全件失敗の代替経路の `'extraction_failed_whole_observation_fallback'` | 受け口が無い |
| `reextract`（旧い行の `superseded`） | 固定タグ `'reextract_superseded'` | 受け口が無い |
| `markContested`・`markContestedGroup`（`updated`） | 固定タグ `'contested'` | `meta.note` に入る |
| `resolveContested`・`resolveContestedGroup`・`resolveOrphanedContested`（`updated`・`superseded`） | 固定タグ `'contested_resolved'`（`meta.resolution` に決着の種類） | `meta.note` に入る |
| `consolidate`（統合先の `created`・統合元の `superseded`） | 固定タグ `'consolidated'` | `meta.note` に入る |
| `reflect`（`created`） | 固定タグ `'reflected'` | `meta.note` に入る |
| `applyCorrection`（中で呼ぶ `markContested`・`resolveContested` のイベント） | 上の2行と同じ（`'contested'`・`'contested_resolved'`） | 渡した `reason` をそのまま `markContested`・`resolveContested` の `reason` に渡すので、`meta.note` に入る（平文） |
| `observe()` の claim key の検出（`claimKey: { detectContested: true }`） | `'contested'`（相手が1件で `active`、または3件以上の群を `markContestedGroup` で結んだとき）、`'claim_key_conflict_unresolved'`（それ以外） | 受け口が無い。**`meta.note` には根拠の JSON 文字列が入る**（下） |
| `archived`（`sweepArchive`）・`events_purged` | `reason` キーが無い（`archived` の `meta` は `{}`、`events_purged` は件数と期間） | 受け口が無い |

**`meta.note` の型**: 上の表の「利用者の文」が入る `note` は、**呼び出し側が渡した文字列そのまま（平文）**である。
**例外は、`observe()` の claim key の検出が積む3種類だけ**——`meta.note` に、オブジェクトではなく
**JSON 文字列**（`JSON.stringify` の結果）が入る。`kind` の値は、相手が1件のとき `"claim_key_conflict"`、
3件以上の群のとき `"claim_key_conflict_group"`（⚠ この `note` の `memberIds`・`matches` は **id の昇順で先頭10件だけ**。全体の件数は `memberCount`・`matchCount`、切ったかどうかは `memberIdsTruncated`・`matchesTruncated`。**`memberIdsTruncated` が `true` なら、`note` の `memberIds` は先頭の10件だけ**で、群の全メンバーではない。**群の全メンバーは `note` からは辿れない**——`contested` の間は `RelationStore.listRelated(ctx, memoryId, "contradicts")`（下の「群の相手は」の段落）、検出した `observe()` の戻り値なら `contestedDetection[].result.memberIds` で辿る。[ADR 0431](./decisions/0431-contested-group-event-growth-and-recall-cut.md)）、`claim_key_conflict_unresolved` のとき
`"claim_key_conflict_unresolved"`（⚠ この `note` の `matches` も **id の昇順で先頭10件だけ**。全体の件数は `matchCount`、切ったかどうかは `matchesTruncated`。全員の id は `observe()` の戻り値の `matchMemoryIds` にある。ADR 0431）（書いているのは `packages/core/src/runtime.ts` の
`detectClaimKeyContested` 付近）。**読む側は `JSON.parse(meta.note)` が要る**——`meta.note` は
`Record<string, unknown>` の中の文字列であり、ネストしたオブジェクトではない。⚠ `applyCorrection` は
この例外ではない（`reason` をそのまま渡すだけで、JSON にはしない）。ほかの経路の `note` を
`JSON.parse` すると、利用者の文によっては例外になる。`note` が JSON 文字列かどうかは、
同じイベントの `meta.reason` と `JSON.parse` の成否で見分けること（JSON 文字列を積む経路の `reason` は
上の表の3値に限られるが、利用者が `markContested` の `reason` に JSON を渡しても `'contested'` になるので、
`reason` だけでは見分けられない。⚠ その区別を機械的に付ける手段は、確かめていない）。

### 保持方針（alteroid に無く、mnemora に要るもの）

alteroid の日誌は無期限に積む設計であり、保持期間・ローテーション・上限を持たない。
single-tenant・小規模データを前提にすれば成立するが、multi-tenant で桁違いの量を扱う
mnemora ではこの前提が成立しない。

⟹ テナント単位で保持期間を設定可能にする。既定は無期限（`NULL`）。期限切れの
`memory_events` 行を削除する処理そのものが、**`events_purged` イベントとして記録に残る**
（件数と期間のみ。削除された個々のイベントの詳細は残らない）。「消えたことが見える」という
性質を、ログの掃除に対しても一貫させる。この削除処理は `EventStore` interface（アプリケーション
コードが通常使う経路）を経由しない、独立した保守ジョブとして実装する——通常の書き込み経路に
「まとめて削除する」機能を持たせないという、alteroid から採った「型に無ければ生えない」の
考え方を、削除操作自体にも及ぼす。

**実装済み（2026-09-15、Issue #210 / [ADR 0115](./decisions/0115-event-retention-purge.md)）**:
`setEventRetention`（ADR 0050）で保持期間を設定できても、実際に古い行を消すコードが
長らく存在しなかった（Issue #210。「設定できる」と「効く」は別だった）。いま埋まっている口は
`MemoryStore.purgeExpiredEvents?`（任意メソッド。`@mnemora/core` は npm 公開済みのため、
必須にすると第三者 adapter を壊す）——`limit` 必須・`dryRun` 対応・`kind = 'events_purged'`
自身は対象から除外（無限後退を避ける）。`packages/core` の `purgeExpiredEventsForTenant` が
`TenantSettingsStore.getEventRetention` の3状態を読み、有限日数のときだけこれを呼ぶ。
**`tick()`/`observe()` には配線していない**——呼び出すのは運用側のスクリプト・cron の責務であり、
このリポジトリは「呼ぶための部品」だけを提供する。

**⚠ 2026-09-30 追記（文書だけ。実行時の振る舞いは変えていない）: `events_purged` の行の `at` は、`Runtime` に渡した `clock` の時刻ではない。**
どちらの実装も `clock` ではなく、adapter を動かすプロセスの壁時計（ミリ秒）で積む。`@mnemora/postgres` は
`purgeExpiredEvents` の `INSERT` 文の `at` 列に `new Date()` を `toPgTimestamp` で渡し、`@mnemora/testkit` のインメモリ実装は `at` を渡さず、
`buildStoredMemoryEvent` が `event.at ?? new Date()`（JS の壁時計）で埋める。⟹ テストで `clock` を固定しても、
この `at` は固定されない。（`@mnemora/postgres` は 2026-09-30 まで SQL の `now()`（DB の時計・マイクロ秒）で積んでいたが、
読み戻した `at` を `until` に渡すとその行自身が返らなかったため、[ADR 0427](./decisions/0427-events-purged-at-millisecond.md) でプロセスの時計に替えた。）
`meta` の `olderThan` は別で、`purgeExpiredEventsForTenant` が `opts.now ?? new Date()` から保持期間で
引いた値である（これも `Runtime` の `clock` ではない）。

```sql
CREATE TABLE tenant_settings (
  tenant_id                text        PRIMARY KEY,
  default_half_life_hours  real        NOT NULL DEFAULT 720,   -- 30日。Memory 作成時の既定値
  event_retention_days     integer     NULL,                    -- NULL = 無期限
  taxonomy_mode            text        NOT NULL DEFAULT 'open' CHECK (taxonomy_mode IN ('open','strict')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
```

**⚠ 2026-09-26 追記（[Issue #821](https://github.com/takecchi/mnemora/issues/821)）:
この削除は `kind: 'superseded'` の行を特別扱いしない。** `restoreSuperseded` の
下見（`MemoryStore.previewRestoreSupersededBy?`、下記「矛盾の扱い」・
[ADR 0237](./decisions/0237-restore-superseded-dry-run-preview.md)/
[ADR 0258](./decisions/0258-restore-superseded-operation-scope.md)）は、この
`superseded` 行の `meta.reason` を読んで「別々の敗者を1回の操作としてまとめて戻して
よいか」を判定する唯一の情報源であり、保持期間の掃除が走った後は由来が
「分からない」に劣化する——最初から由来が無かった候補と区別が付かない。
詳細は [ADR 0115](./decisions/0115-event-retention-purge.md) の同日付追記を参照。

**`tenant_settings` は [ADR 0007](./decisions/0007-tenant-scoping.md) が禁じる「テナントの台帳」ではない。** mnemora はテナントの識別・
認証・存在確認を行わない——`tenant_id` は呼び出し側が渡す不透明な文字列のままである。
`tenant_settings` に行が無いテナントは、コード中の定数による既定値で動作する。この表は
「その `tenant_id` というテナントが存在する」という真実を保持するものではなく、
既に呼び出し側から渡されている `tenant_id` に対する**任意の運用パラメータ**（保持期間・
既定 half-life・taxonomy モード）を保持するだけであり、無くても mnemora は動く。

### forget() と purge() を分ける

削除には二種類ある。`forget()` = 論理削除（`status` を変える。復元可能）。`purge()` = 物理削除
（法的要求。内容を消す。イベントは残る）。**Phase 1 は `forget()` のみを実装する。`purge()` は
Phase 2 以降だが、`memory_events.kind` の `'purged'` は Phase 1 のスキーマに含める**
（後からマイグレーションで `kind` の CHECK 制約を広げるのは、既存行との整合を壊すリスクが
あるため避ける）。

**⚠ 2026-09 訂正（Issue #289、[ADR 0124](./decisions/0124-purge-physical-delete.md)）:
上の「`purge()` は Phase 2 以降」は Phase 1 計画時点の記録であり、値そのものは書き換えない。
`purge()` は Issue #198 / ADR 0124 で実装済みである**——`Runtime.purge`
（`packages/core/src/runtime.ts` の interface 宣言・実体）、`MemoryStore.purgeMemory?` の
postgres 実装（`packages/postgres/src/memory-store.ts`）とも揃っている。`forgotten` から
のみ遷移でき、`tick()`/`observe()` には配線しない（ADR 0124 決定1・決定3）。下のトゥーム
ストーンの説明は実装とそのまま一致する。

`purge()` が実行された場合、`memories` 行自体は残す（`memory_events` からの外部キー参照
整合性のため、また `superseded_by_id` / `contested_with_id` の参照先としても残す必要が
あるため）。ただし `content` と `digest` を固定のトゥームストーン文字列で上書きする
（`digest` の NOT NULL 制約は §4 の決定でありここでも維持する。「NULL にする」ではなく
「消えたことを示す値で上書きする」ことで、NOT NULL と物理削除の両立を図る）。

```sql
purged_at timestamptz NULL   -- 非NULLなら content/digest はトゥームストーン済み（実装済み。Issue #198 / ADR 0124）
```

**⚠ 2026-09-27 追記（文書と実装の照合、main 16976ea）**: `purge()` が書き換えるのは、いまは `memories` の `content`・`digest`・`purged_at` だけであり、あわせて今の `embeddingProvider.space` の埋め込み行をベストエフォートで消す（ADR 0124 決定4・決定5）。それ以外の次のものは元の値のまま残る——`tags`・`attributes`・claimKey の2列・`content_hash`、`labels`/`memory_labels` の行、別の空間の埋め込み行、元の Observation の `payload`、`memory_events.digest_snapshot`、そして purge より前の recall の記録（`recalls.index_band` の digest 帯、および `consolidate`/`reflect` が種の digest を `text` にして撃った recall の `recalls.query`）。ここでは現状を記録するだけで、どこまで消すかは決まっていない（[Issue #994](https://github.com/takecchi/mnemora/issues/994)・[Issue #995](https://github.com/takecchi/mnemora/issues/995)、オーナーの判断待ち）。

**⚠ 2026-09-29 追記（[ADR 0375](./decisions/0375-purge-scope-widened.md)）: 上の段落は、もう今の振る舞いではない。** `purge()` の射程を広げた。いま `purge()` が書き換えるのは `memories` の `content`・`digest`・`purged_at` に加えて **`tags`（`[]` へ）・`attributes`（`{}` へ）・claimKey の2列（`NULL` へ）**であり、あわせて **その Memory の `memory_labels` の紐付けをすべて外し、`status: 'proposed'` の `labels.proposedCount` を外した本数だけ減らし**、**このテナントの `recalls.index_band` の digest 帯（`digestBand`）からその `memoryId` のエントリを見つけて `digest` をトゥームストーンへ書き換える**。上の段落が「残る」と書いていたもののうち、`tags`・`attributes`・claimKey・`labels`/`memory_labels`・`index_band` の digest 帯はこれで消える側になった——`content_hash`・別の空間の埋め込み行・元の Observation の `payload`・`memory_events.digest_snapshot`・`recalls.query` は、引き続き残る（ADR 0375「(b) 残る」表）。どこまで消すかは、この範囲について**決まった**（Issue #994・#995 は解消。#1207 の残りは下の表を見ること）。

**⚠ 2026-09-30 訂正（[Issue #1226](https://github.com/takecchi/mnemora/issues/1226)、[ADR 0375](./decisions/0375-purge-scope-widened.md) 決定7・2026-09-30 追記、クローン miku の判断）**: 直前の2026-09-27 の段落（`consolidate`/`reflect` が forget/purge を見直さずに書く、という記述）は、もう成り立たない。**今は、`consolidate`/`reflect` は LLM が返った直後・書き込みの直前に材料（統合元・内省の材料）を読み直し、1件でも `forgotten`（`forget()` のみ・`purge()` 済みのどちらも含む）なら、統合先・内省の Memory を一切作らずに打ち切る**（`outcome: 'aborted_source_forgotten'`）。

- `@mnemora/postgres` の `supersedeWithNewMemories`/`createMemoryWithOutbox` は、`opts.abortIfForgotten` を渡されると、書き込みと**同一トランザクションの中**で `SELECT … FOR UPDATE` によりもう一度見直す（`embed` ジョブの同種のレースを閉じた [Issue #1035](https://github.com/takecchi/mnemora/issues/1035) と同じ「書く前に見直す」形。あちらは「書いた後に読み直して消す」形だった）——runtime の読み直し（この段落冒頭）とこの見直しの間の窓を閉じる。実際に窓が閉じることは、書き込みの入口（読み直しの直後・書き込み直前）で止め、その間に forget/purge を割り込ませる変異試験で `consolidate`（`supersedeWithNewMemories`）・`reflect`（`createMemoryWithOutbox`）の両方で確かめた——新実装はどちらも10/10緑、対応する `SELECT … FOR UPDATE` の見直しを外すとどちらも10/10赤（`packages/postgres/src/__tests__/consolidate-reflect-source-forgotten-for-update-race.postgres.test.ts`）。
- `@mnemora/testkit` の `InMemoryMemoryStore` と `@mnemora/core` の テスト用 `FakeMemoryStore` は `opts.abortIfForgotten` を実装しない（`MemoryStore.createMemoryWithOutbox`/`supersedeWithNewMemories?` の `opts.abortIfForgotten` の doc コメント参照）——これらの adapter では、runtime 自身の読み直しだけが保護になり、**読み直しと書き込みの間に小さな窓が残る**（実測: `packages/postgres/src/__tests__/consolidate-reflect-forget-race.postgres.test.ts` の8ケースは、この窓では捕まえられない別のレース——LLM 呼び出しの間に forget/purge が完了する形——を検査しており、その形では全adapterで確実に打ち切られる。書き込みの直前の一瞬だけを狙う、より狭いレースの陽性対照は上の変異試験を参照）。
- 第三者の `MemoryStore` 実装で `supersedeWithNewMemories?`/`createMemoryWithOutbox` を自前で持つものは、`opts.abortIfForgotten` を実装しなくても型は壊れない（無視されるだけ）——実装するかどうかは任意（`packages/testkit` の conformance suite `supportsAbortIfForgotten?` で検査できる）。

**⚠ 2026-09-29 追記（[ADR 0375](./decisions/0375-purge-scope-widened.md) 決定7）**: 上の「見直して打ち切るかどうかは決まっていない」は、**方向は決まった**——forget でも purge でも打ち切る。`@mnemora/postgres` の `store_supported` 経路（`purgeMemory?` を持つ adapter）は同一トランザクション内で材料行を `SELECT … FOR UPDATE` で見直してから書き、それ以外の経路は書く直前に読み直すだけで小さな窓が残る。**実装・実測は本 PR（PR2、Issue #1226）で行った**——上の2026-09-30 訂正を参照。

**⚠ 2026-09-27 追記（[Issue #1207](https://github.com/takecchi/mnemora/issues/1207)、今の振る舞いを書くだけ）: 1つのテナントを消去した後に、表ごとに何が残るか。**
テナント単位で消去する口は無い。ここでは「そのテナントの全記憶を `forget` → `purge` し、`setEventRetention({ kind: "days", days: 1 })` の後に
`purgeExpiredEventsForTenant` で保持期間の掃除をした後」を消去とみなし、`@mnemora/postgres` の全表を当てた（【実測】自分専用の PostgreSQL 17 + pgvector。
別テナントの行は変わらない）。上の追記と重なるものは「上の追記」とだけ書く。

**⚠ 2026-09-29 追記（[ADR 0375](./decisions/0375-purge-scope-widened.md)）: 下の表は ADR 0375 の実装に合わせて書き直した。** 「決まっていない」だったもののうち、`tags`・`memory_labels`（紐付け）・`recalls.index_band` の digest 帯は、この版で**消える側に決まった**——(a) として `purgeMemory` の契約に入った。それ以外（`provenance.speaker`・`subject_id`・`content_hash`・`recalls.query`・`recall_usages`・`outbox`・`tenant_settings` 等）は、purge の約束の対象外のまま (b) として明記した——「決まっていない」ではなく「残ると決めた」。

**⚠ 2026-09-30 追記（[Issue #1425](https://github.com/takecchi/mnemora/issues/1425)、[ADR 0382](./decisions/0382-vector-store-delete-across-spaces.md)）: 下の表の「別の space の embedding」行は、もう「残る」ではない。** `VectorStore` に `deleteAcrossSpaces`（必須メソッド）を足し、`Runtime.purge` が `space` を指定しない全 space 削除の口を呼ぶようになった——**(a)** として、別 space の embedding も消える側に決まった。`already_purged` の再実行でも同じ口をベストエフォートで呼ぶ（埋め込みモデルを移した後に purge を再実行すると、旧 space に残った行を後始末できる）。

| 表 | 消去の後 | 約束 |
|---|---|---|
| `memories` | 行は残る（purged）。**(a)** `content`・`digest`・`tags`・`attributes`・claimKey は消える | **(b)** `content_hash`・`provenance.speaker`・`subject_id` は残る。ADR 0375「(b) 残る」表（`provenance`/識別子は `basisLost` の解決・呼び手の識別子の性質上、消す対象にしない） |
| `observations` | 行は残る。`payload`・`attributes`・`subject_id`・`external_id` は元のまま | **(b)** Observation は追記専用（forget/purge の経路が無い）。Observation を消せるようにするかは既存原則を覆すかどうかの別判断（#1207 コメントでオーナーへ問いを残した） |
| `memory_embeddings_<space>`（**全空間**） | 消える | ADR 0124 決定5（今の space）・**(a)** ADR 0382（別 space。[Issue #1425](https://github.com/takecchi/mnemora/issues/1425)） |
| `labels` | 行は残る（消す口が無い、ADR 0318）が、**(a)** `proposed` の `proposedCount` はこのテナントで purge した分だけ減る | 近似値のまま（ADR 0318「引き受けた負債」1・ADR 0375 決定1「引き受けた負債」2） |
| `memory_labels` | **(a)** purge した Memory の紐付けは消える | ADR 0375 決定1・決定2 |
| `recalls` | **行は全部残る**（保持方針は未決）。`query`（問いの本文・種の digest）・`explain`（scope の `subjectId`）・`returned_memories` は元のまま。**(a)** `index_band.digestBand` のうち該当 `memoryId` の `digest` は伏せられる | `query` は `memoryId` で特定できないため対象外（決定4）。行の保持期間は決まっていない（#1207。ADR 0290 が「recalls の保持方針」を先の話としている） |
| `recall_usages` | 残る（id だけ） | **(b)** 決まっていない（#1207） |
| `outbox` | 完了した行は残る（`payload` は id だけ） | **(b)** 完了した行を消す経路も保持期間も無い（#1207）。`last_error` は #1064 |
| `memory_events` | 保持期間の掃除で消える。**`events_purged` の行は残る** | ADR 0115 決定4（`events_purged` は掃除の対象外）。`digest_snapshot` 自体は監査ログの目的上、意図的に残す |
| `tenant_settings`・`tenant_activity` | 設定の行は残る | **(b)** 決まっていない（#1207） |

⟹ **この版でも「1つのテナントを跡形なく消す」手段は無い。**purge は法的な要求（`purge()` の doc）に応える口だが、(b) に挙げたものは今回も残る。
テナント単位の消去の口を新設する判断は #1207「考えられる方向」1 のまま、引き続き決まっていない。
今の振る舞いは `packages/postgres/src/__tests__/tenant-erasure-residue.postgres.test.ts` が縛っている——**(a) の部分は ADR 0375 の約束として、(b) の部分はこれまでどおり「今の振る舞いの記録」として。**

**⚠ 2026-09-30 追記（[ADR 0383](./decisions/0383-erase-tenant.md)）: 「テナント単位の消去の口を新設する判断」はもう決まった——上の「⟹」段落と直前の1文は、もう今の振る舞いではない。** `forget` → `purge` → 保持期間の掃除という組み合わせ（上の表が縛る、(b) の残存を含む「今の振る舞い」）とは**別に**、独立関数 `eraseTenant`（`packages/core/src/erase-tenant.ts`、`Runtime` のメソッドではない。明示呼び出し専用で `tick()`/`observe()` には配線しない）を新設した。`eraseTenant` は、上の表が挙げた表を**すべて**含め、テナントに属する行を跡形なく物理削除する——`memories`・`observations`・`memory_events`・`recalls`・`recall_usages`・`labels`・`memory_labels`・`tenant_activity`・`tenant_subject_activity`・`outbox`・`tenant_settings`・全空間の `memory_embeddings_*`。DB に消去の記録は一切残らない（`events_purged` 相当の行も積まない）。呼び出し側は4つの port（`MemoryStore`/`VectorStore`/`OutboxStore`/`TenantSettingsStore`）すべてが任意メソッド `eraseTenant?` を実装している必要があり、1つでも欠けていれば何も消さずに `store_unsupported` を返す。詳細・契約・実測は ADR 0383 を参照。

**この追記が上書きしないもの**: `recalls` の保持方針（生きているテナントの分。ADR 0290 が未決のまま）——`eraseTenant` は「丸ごと消す」操作であり、「どれだけの期間保持するか」という問いには答えていない。`forget`/`purge`（1つの Memory を対象にした既存の口）自体の契約も変わっていない——上の表・ADR 0375 の約束は「1つの Memory を purge したとき」の話として、引き続きそのまま成り立つ。

**⚠ 2026-09-30 追記（[ADR 0383](./decisions/0383-erase-tenant.md) 末尾の追記。同日、続きの追記で `limit` で止まった回の振る舞いを直した）: `eraseTenant` の戻り値の `deleted` の各欄は「その port 自身が、この呼び出しで消した行数」であり、とくに `deleted.vectorStore` は、`dryRun` では実数（例: `26`）、本番では `0` になりうる。行は正しく消えている。**`memoryStore` を先に消す（順序は ADR 0383 決定5の不変条件）と、`memories` の削除で `memory_embeddings_<space>.memory_id` の `ON DELETE CASCADE` が埋め込みを一緒に消すため、その後に呼ばれる `VectorStore.eraseTenant?` には数えるものが残らない。`dryRun` は何も消さないので、消える予定の埋め込みをそのまま数える。**`limit` で `memoryStore`（または `vectorStore`・`outboxStore`）が途中で止まった回は、後ろの port を呼ばない**（`reachedLimit: true` で返り、呼ばなかった port の `deleted` は `0`。`dryRun` も同じ）——設定・outbox・埋め込みは、`memories` などを消し切る呼び直しの回まで残る（「設定は最後」の約束。ADR 0383 の追記）。`deleted.memoryStore` は `memories` だけの行数ではなく、`memoryStore` が消す10表の行数の合計である。消去の完了は戻り値の件数ではなく、消去後に表を数えて確かめること。

**⚠ 2026-09-30 追記（文書だけ。[ADR 0383](./decisions/0383-erase-tenant.md) の追記2）: `eraseTenant` は、そのテナントへの書き込みを止めてから呼ぶ。終わりは `deleted` が全部 `0` になった回である。**
同じテナントへ `observe()`・`tick()` などで書き込みながら呼ぶと、行が残りうる——消している途中に書かれた行は、その回では消えない。
`reachedLimit === false` で返った回も、書き込みが止まっていなければ「空になった」の証明ではない。⟹ **書き込みを止めたうえで、
`deleted` の4欄が全部 `0` で返る回が出るまで、同じ `opts` で呼び直す。**「消えたか」は、その後に表を数えて確かめる
（上の `deleted.vectorStore` の追記と同じ。4欄が全部 `0` は「この回は何も見つからなかった」だけを言う）。
残りうる表は、`@mnemora/postgres` の実装を読んで次のように考えた（⚠ **書き込みを割り込ませて起こしてはいない——コードからの推論**）:
`memoryStore` 側は、表ごとの削除が「対象の id を先に選んでその id だけを消す」文なので、その文が始まった後にコミットされた
`memories`・`observations`・`memory_events`・`recalls`・`recall_usages`・`labels`・`memory_labels`・`memory_relations` の行は残り、
`tenant_activity`・`tenant_subject_activity` は書き込みのたびに作り直されうる。`outbox` は `memoryStore` の後に消すので、その後に積まれた
ジョブ（`embed`・`extract` など）が残る。埋め込みは `memories` の削除で CASCADE により消えるが、消えた後の `embed` の書き込みがどうなるかは
確かめていない（外部キーで失敗するはず）。`tenant_settings` は最後に消すので、その後の `setEventRetention` などで行が作り直される。
契約は `packages/core/src/erase-tenant.ts` の doc コメントにも同じ内容を書いた。

**⚠ 2026-09-30 追記（[ADR 0389](./decisions/0389-recalls-digest-band-index.md)）: `purge()` が `recalls.index_band` の digest 帯を書き換えるときの走査の費用は、索引を足して解消した。** ADR 0375 決定6 は、この書き換えがテナントの `recalls` 全体を走査し、索引を足すかどうかは「決めていない」として残していた。`migrations/0030_recalls_digest_band_index.sql` の式 GIN 索引 `idx_recalls_digest_band`（`(index_band->'digestBand') jsonb_path_ops`）を足し、走査は対象行だけを引く形になった（振る舞いは変えていない）。代わりに `recalls` への INSERT の費用が増える（実測は ADR 0389）。`recalls` の**保持方針**（生きているテナントの分）は、引き続き決まっていない（ADR 0290）。

**⚠ 2026-09-30 追記（[ADR 0404](./decisions/0404-purge-expired-recalls-and-completed-outbox-jobs.md)）: 生きているテナントの `recalls` と完了した `outbox` の行を消す口を足した。上の表の「行は全部残る」「完了した行を消す経路も保持期間も無い」は、口が無いという意味ではもう今の姿ではない。** `MemoryStore.purgeExpiredRecalls?`（`created_at < olderThan` の `recalls` を、その `recall_usages` ごと同一トランザクションで消す）と `OutboxStore.purgeCompletedJobs?`（`completed_at IS NOT NULL AND completed_at < olderThan` の行だけを消す。claim 中・未処理・`failed_at` の行は消さない）。どちらも任意メソッドで、`olderThan` は呼び出し側が必ず渡す。**保持期間の既定値・`failed` 行の扱い・`recalls.query` を約束の範囲に入れるか・監査行を積むかは、決まっていない**（オーナーに聞く事柄。ADR 0404）。消した `recallId` への `recordUsage` は例外になり、`memory_events.meta` に載った `recallId` の文字列は残る。

---

## 10. DB schema 案

以降が本書の中心である。テーブルごとに導入 Phase を明記する。**`tenant_id` は全テーブルで
NOT NULL とし、全ての一意制約・索引の先頭列に置く**（[ADR 0007](./decisions/0007-tenant-scoping.md)）。これは mnemora の隔離境界が
アプリケーションコードの慎重さではなく、スキーマの形そのものによって保証されることを
意味する。


**⚠ 2026-09-27 追記（文書と実装の照合、main 16976ea）**: この節の `CREATE TABLE` は、後から migration で足した列・表をすべては写していない。実物（`packages/postgres/migrations/`）にあって、この節の DDL に無いものは次のとおり。
- `memories`: `decay_base_seq`・`decay_floor_seq`・`half_life_recalls`（0015、ADR 0165）、`attributes`（0019、ADR 0312）、`claim_key_subject`・`claim_key_predicate`（0021、ADR 0320）。
- `observations`: `valid_from`・`valid_until`（0014）、`attributes`（0019）。
- `tenant_settings`: `decay_clock`・`default_half_life_recalls`（0015）。
- 表 `tenant_activity`（0015。列は `tenant_id`・`activity_seq`・`updated_at`）。
- 埋め込み空間の表のゼロノルムの部分索引（0022。下の「埋め込み空間」の例の後の追記）。
また `memories` の DDL の `valid_from`/`valid_until` に付いている「Phase 2」は、[ADR 0164](./decisions/0164-valid-from-until-recall.md) の `validAt` ゲートで読まれるようになっている。列の型・既定値・制約の正本は migration である。
### 前提: pgvector のバージョン

- **`>= 0.8.0` を必須**とする。iterative index scan（`hnsw.iterative_scan`）が §7 の
  フィルタ問題対処に必要なため。
  > ⚠ **2026-09-28 追記（今の振る舞い。[Issue #1301](https://github.com/takecchi/mnemora/issues/1301)。上の行は書き換えていない）:
  > 実装はこの版を検査しない。**`runMigrations` の `extensionMode: "verify"` が見るのは `vector` の拡張が在るか
  > （`pg_extension.extname`）だけで、版（`extversion`）は読まない。起動時・`registerEmbeddingSpace`・store の生成時にも
  > 版を確かめる処理は無い。⟹ 0.8.0 未満の pgvector でも、ここでは名乗らずに進む。0.8 に頼っているのは
  > `packages/postgres/src/vector-store.ts` の `SET LOCAL hnsw.iterative_scan` で、0.8.0 未満では版と PostgreSQL の版の
  > 組み合わせによって、そこで ERROR になるか、黙って効かない（Issue #1301 の表。上流のソースからの推論を含み、
  > 0.8.0 未満の実物では測っていない）。「必須」は、利用者が満たすべき前提として残してある。検査を足す・警告を出す・
  > 書き方を変えるかは Issue #1301 で決まっていない。
  >
  > **⚠ 2026-09-29 追記（実装した。Issue #1301、[ADR 0367](./decisions/0367-pgvector-capability-check.md)。
  > 上の行と直前の追記は、当時の記録として書き換えていない——もう今の振る舞いではない）:**
  > **`@mnemora/postgres` は今、2箇所で検査する**——(a) `PostgresVectorStore` の
  > `search()`/`searchMany()`（インスタンスごとに初回の呼び出しでだけ。`SET LOCAL
  > hnsw.iterative_scan` を発行する前に決着する）、(b) `runMigrations`
  > （`extensionMode` の `create`/`verify` 両方。`create` は新規インストールでは
  > マイグレーション適用後、`verify` は拡張の存在確認の直後・advisory lock 取得前）。
  > 対応していなければ `PgvectorVersionUnsupportedError`（`installed`/`required`/
  > `missingCapability` を持つ）を投げる。
  >
  > **判定は `extversion` の文字列比較ではなく、能力で行う**——同じ接続で `vector` 型を
  > 使ってから `pg_settings` の `hnsw.iterative_scan` 行の `vartype`/`enumvals` を読み、
  > `enumvals` に `relaxed_order` を含むかで決める。`current_setting()` は使わない
  > （`postgresql.conf`／`ALTER DATABASE`／`ALTER ROLE`／同一接続の過去の `SET` が作る
  > placeholder の値をそのまま返してしまい、0.8 未満でも誤って「対応している」と
  > 判定しうることを実測した——ADR 0367 決定2）。⟹ **ライブラリが実際に 0.8.0 以上なら、
  > `extversion` が何らかの理由で古い値のままでも落ちない**（`ALTER EXTENSION vector
  > UPDATE;` の実行漏れを誤って弾かない）。落ちるのは実際に iterative scan が効かない
  > 構成だけである。
  >
  > **検査を外す opt-out は無い**（意図的な決定、ADR 0367 決定1）。0.5.x・0.6〜0.7.x の
  > 実物での実測はまだ無く、代理実測（予約されない接頭辞の下での架空の名前）に留まる
  > ——詳細は ADR 0367「確かめていないこと」。
- **`>= 0.8.2` を推奨**とする（2026-02-26 リリース。CVE-2026-3172 のバッファオーバーフロー
  修正を含む）。
  > **⚠ 2026-09-17 追記（名乗りの復元。上の行は書き換えていない）。**
  > 上の1行は **同一文言が3箇所に在る**（この節 / [ADR 0002](./decisions/0002-embedding-space-tables.md) /
  > [`docs/roadmap.md`](./roadmap.md) §4 の技術リスク表）が、**どこにも一次情報への出典が無かった。**
  > **【実測 2026-09-17、`gh api repos/pgvector/pgvector/...` で上流を引いた】**:
  > - ⭐ **「0.8.2 がバッファオーバーフローを直した」は裏が取れた。** 上流の `CHANGELOG.md` に
  >   `## 0.8.2 (2026-02-25)` / **`Fixed buffer overflow with parallel HNSW index build`**
  >   （[pgvector#959](https://github.com/pgvector/pgvector/issues/959)）と在る。
  > - ⭐ **日付のずれは矛盾ではない。** tag `v0.8.2` は commit `cab9da72`、`2026-02-25T18:46:57Z`
  >   ＝ **JST では 2026-02-26 03:46** なので、本文の「2026-02-26」は JST 読みと整合する。
  > - ⛔ **`CVE-2026-3172` という番号だけは裏が取れていない。** 上流の `CHANGELOG.md` は CVE 番号を
  >   1つも書いておらず、GitHub の advisory database をこの CVE ID で引いても該当0件だった。
  >   ⚠ **「存在しない」とは言えない**（CVE データベースを直接当てていない）。**未確認である、と読むこと。**
  > - ⚠ **`>= 0.8.2` という推奨の下限は、2026-09-17 時点では古い。** 上流の最新 tag は `v0.8.6` で、
  >   `0.8.3 (2026-06-17)` が **`Fixed possible index corruption with HNSW vacuuming`** を直している。
  >   ⛔ **この追記では下限の数字を書き換えない**（数字を直してもまた腐る）。**引くときに上流の
  >   `CHANGELOG.md` を見ること。**
  >
  > **⭐ 2026-09-17 追記2（一次情報を当て直した。本文も上の追記1も書き換えていない）。**
  > ⭐ **`CVE-2026-3172` は実在し、内容も本文の記述と一致する。** 追記1 の「未確認」は**解消した。**
  > **【実測 2026-09-17】当てた先と、返ってきたもの:**
  >
  > | 当てた先 | 返ってきたもの |
  > |---|---|
  > | MITRE CVE Services `https://cveawg.mitre.org/api/cve/CVE-2026-3172` | **HTTP 200 / `state: PUBLISHED`**。採番者は **PostgreSQL**（`assignerShortName`）。`datePublished` `2026-02-25T20:59:10Z` |
  > | NVD `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-3172` | **HTTP 200 / `totalResults: 1`**。`vulnStatus: Deferred`、CVSS v3.1 **8.1 HIGH**（`AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:H`）、CWE-191 / CWE-787 |
  > | GitHub advisory database `gh api "/advisories?cve_id=CVE-2026-3172"` | **該当1件** — [`GHSA-789c-mgqf-5hwx`](https://github.com/advisories/GHSA-789c-mgqf-5hwx) |
  > | 上流 issue | [pgvector#959](https://github.com/pgvector/pgvector/issues/959) *"Buffer overflow with parallel HNSW index build"*（closed、`2026-02-25T18:58:14Z`） |
  >
  > - ⭐ **表題も影響範囲も本文と一致する。** MITRE の `title` は
  >   **"pgvector buffer overflow in parallel HNSW index build"**、`affected` は
  >   **`0.6.0` 以上 `0.8.2` 未満**（`lessThan: "0.8.2"`）。NVD の説明文は逐語で
  >   *"Buffer overflow in parallel HNSW index build in pgvector 0.6.0 through 0.8.1 allows a database
  >   user to leak sensitive data from other relations or crash the database server."*
  >   ⟹ ⭐ **「0.8.2 が `CVE-2026-3172` を直した」も「だから `>= 0.8.2`」も、この CVE に関する限り正しい。**
  > - ⚠ **追記1 が「該当0件」になったのは、番号が無いからではなく引き方である。**
  >   `GHSA-789c-mgqf-5hwx` は **`type: unreviewed` かつ `vulnerabilities: []`**
  >   （＝ ecosystem / package への対応付けを持たない）。⟹ **`affects=` や `ecosystem=` で絞る引き方では
  >   届かない。`cve_id=` で引けば出る。**
  >   ⭐ **「引けなかった」を「存在しない」と書かなかった追記1 の線は、正しかった。**
  >
  > **⚠ 下限 `>= 0.8.2` を動かすかどうかの判断材料**（⛔ **この追記でも数字は書き換えていない**。ADR 0217 決定3）。
  > **【実測 2026-09-17、上流 `CHANGELOG.md` と NVD `keywordSearch=pgvector`（`totalResults: 6`、うち pgvector 本体は2件）】**
  >
  > | 版 | 直したもの | セキュリティ採番 |
  > |---|---|---|
  > | `0.8.2` (2026-02-25) | buffer overflow with parallel HNSW index build（[#959](https://github.com/pgvector/pgvector/issues/959)） | **`CVE-2026-3172`** CVSS 8.1 HIGH。**システムを問わない** |
  > | `0.8.3` (2026-06-17) | possible index corruption with HNSW vacuuming ／ PG18 での Hamming・Jaccard 距離の性能退行 | **無し**（＝正しさの修正であって、採番された脆弱性ではない） |
  > | `0.8.4` (2026-06-30) | `hnsw graph not repaired` ／ vacuuming 中の insert ／ IVFFlat 構築の `maintenance_work_mem` 超過 | **無し** |
  > | `0.8.5` (2026-07-08) | 小さいテーブルの IVFFlat 構築のメモリ使用量 | **無し** |
  > | `0.8.6` (2026-07-29) | buffer overflow with IVFFlat index build on 32-bit systems（[#1006](https://github.com/pgvector/pgvector/issues/1006)）ほか2件 | **`CVE-2026-18022`** CVSS 8.8 HIGH。⚠ **32bit システムのみ** |
  >
  > - 🔴 **`>= 0.8.2` は「既知の CVE が1つも残らない下限」ではない。** `CVE-2026-18022` の
  >   MITRE `affected` は **`lessThan: "0.8.6"` / `version: "0"`** ＝ **`0.8.6` 未満のすべて**である。
  > - ⭐ **ただし `CVE-2026-18022` は 32bit システムにしか効かない。** MITRE 逐語:
  >   *"Integer wraparound in IVFFlat index build in pgvector before 0.8.6 allows a database user to
  >   write data out-of-bounds, which could lead to arbitrary code execution. **Only 32-bit systems are
  >   affected.**"* ⟹ **64bit だけを対象に置くなら、`>= 0.8.2` のままでも既知の CVE は残らない。**
  > - ⛔ **mnemora が 32bit を対象に含めるかは製品判断であり、ここでは決めない。**
  >   ⭐ **決めるのに要る材料を並べただけである。**
  > - ⚠ **`0.8.3` が直した index corruption は、脆弱性としては採番されていない**（＝追記1 が
  >   「下限が古い」の根拠に挙げた項目は、**セキュリティ上の根拠ではない**）。下限を動かす理由になるとすれば
  >   正しさの側である。
  > - ⚠ **上流の最新リリースは `v0.8.6`**（`CHANGELOG.md` 上 `0.8.7` は unreleased）。
  > - ⭐ **この表が腐ったかは、上流の `CHANGELOG.md` と
  >   `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=pgvector` で引き直せる。**
- **確かめていないこと**: マネージド Postgres 各社（RDS / Cloud SQL / Supabase 等）が
  実際に提供している pgvector のバージョンは確認していない。導入環境ごとに
  `SELECT * FROM pg_available_extensions WHERE name = 'vector';` で確認すること。
- 同様に、PostgreSQL 本体側の下限バージョンと pgvector 0.8 系の組み合わせについても
  網羅的な検証はしていない。`gen_random_uuid()` を拡張なしで使う前提を置いているが
  （PostgreSQL 13 以降で標準搭載）、それより前のバージョンでは `pgcrypto` 拡張が要る。
  （⚠ 2026-09-28 訂正: 以前は「16 以降」と書いていた。`gen_random_uuid()` の追加は
  PostgreSQL 13.0 のリリースノート（<https://www.postgresql.org/docs/release/13.0/>）に載っている。）

### `observations`（Phase 1）

```sql
CREATE TABLE observations (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text        NOT NULL,
  subject_id   text        NULL,
  external_id  text        NULL,        -- 呼び出し側の冪等キー（テナント内一意）
  kind         text        NOT NULL,    -- 'utterance' | 'event' | 'usage' | 'document' | ...
                                          -- 開いた判別可能ユニオンのため CHECK を付けない
  payload      jsonb       NOT NULL,
  occurred_at  timestamptz NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

-- observe() の再送は同じ Observation を返す（冪等性）
CREATE UNIQUE INDEX uq_observations_external_id
  ON observations (tenant_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX idx_observations_by_subject ON observations (tenant_id, subject_id, recorded_at);
```

`kind` はあえて `CHECK` 制約を付けない。observe() の入力ユニオンは `...` で開かれており
（§4）、新しい Observation の種類を追加するたびにマイグレーションを要求しない設計にする。
これは `memories.status` や `provenance_kind`（閉じたユニオン、CHECK 制約あり）とは
意図的に扱いを変えている——**開いているものは開いていると分かる形にし、閉じているものは
閉じていると分かる形にする。**

`kind = 'usage'` の Observation（`observe(ctx, { kind: 'memory_usage', ... })`）は抽出器を
通らない。payload の `{ recallId, usedMemoryIds }` を直接読み、`recall_usages` への挿入に
使われる（§6）。他の `kind` は抽出パイプラインを経て `memories` 行を生む。

**⚠ 2026-09-26 追記（クローン miku の判断、[Issue #897](https://github.com/takecchi/mnemora/issues/897)）:
`uq_observations_external_id` による冪等性は、その Observation から生まれた Memory がその後
どうなったかを一切問わない。** `forget()`（status を `forgotten` にする、§9）や `purge()`
（content/digest をトゥームストーンで上書きする、§9）を経たあとでも、同じ `externalId` で
`observe()` を呼び直せば `createObservationWithOutbox` は既存の Observation を
`created: false` で返し、抽出はやり直さない——`{ memoryIds: [], extraction: 'skipped' }` が
返るだけで、Memory は forgotten/purged のまま変わらない。この振る舞いは `forgotten`
（`purge` 前）の段階でも同じである——`createObservationWithOutbox` は Observation どうしの
一致だけを見ており、対応する Memory の `status` を一度も読まない。

理由: 抽出をやり直すと、`purge()` で消した内容が `externalId` の再送だけで蘇りうる。
それは「忘れさせる」という約束と正面から食い違う。

⚠ 呼び出し側は、この返り値だけでは「正常な冪等の再送」と「forgotten/purged が原因で無視
された」を区別できない（`Runtime.observe` の doc コメント、`packages/core/src/runtime.ts`
参照）。

**⚠ 2026-09-27 追記（[Issue #1074](https://github.com/takecchi/mnemora/issues/1074)）: 識別子の長さに上限は約束しない。**
`tenant_id`・`subject_id`・`external_id` と `memories.tags` の要素は、上の索引（と `memories` の索引）に
入る。索引の1行が**圧縮後に** btree 2704 バイト・GIN 2712 バイトを超えると、Postgres は書き込みを
例外にする。圧縮後の大きさで決まるので、上限は文字数でもバイト数でも一意に言えない（同じ文字の
繰り返しは1万字でも通り、ランダムな値は約2.7KBで落ちる）。`@mnemora/testkit` の fixture はどの長さも
受け入れる。クローン miku の判断で、上限の新設（入力を狭める）は採らず、今の振る舞いを記録した
（選び直す余地は Issue に残してある）。長い外部の ID は、呼び出し側でハッシュなどに縮めてから渡すこと。
詳細は `Ctx`（`packages/core/src/ctx.ts`）の TSDoc。

**⚠ 2026-09-27 追記（[Issue #1076](https://github.com/takecchi/mnemora/issues/1076)）: `payload` は JSON として保存される。**
`@mnemora/postgres` は `payload` を `JSON.stringify` して `jsonb` に入れるので、`observe({ kind: "event", data })` の
`data` に JSON で往復しない値を渡すと、形が変わって読み戻る（`NaN`・`±Infinity` は `null`、`-0` は `0`、
`Date` は ISO 8601 の文字列、値が `undefined` の欄は消える）。`@mnemora/testkit` の fixture は JS の値を
そのまま保持する。保証するのは、JSON の値が同じ値で読み戻ることだけである。クローン miku の判断で、
入力を JSON の値に限る案・fixture を揃える案は採らず、今の振る舞いを記録した（選び直す余地は Issue に
残してある）。書き分けは `ObserveEventInput.data` の TSDoc。

### `memories`（Phase 1。一部列は Phase 2）

```sql
CREATE TABLE memories (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             text        NOT NULL,
  subject_id            text        NULL,

  -- 抽出の起点。stated/inferred は必須、consolidated/reflected/imported は
  -- provenance.sources 側で複数ソースを表すため NULL を許す。
  source_observation_id uuid        NULL REFERENCES observations(id),
  extractor_version     text        NULL,

  content               text        NOT NULL,
  content_hash          text        NOT NULL,
  digest                text        NOT NULL,
  digest_source         text        NOT NULL DEFAULT 'llm' CHECK (digest_source IN ('llm','fallback')),

  provenance_kind        text        NOT NULL
                            CHECK (provenance_kind IN ('stated','inferred','consolidated','reflected','imported')),
  provenance              jsonb       NOT NULL,
  CHECK (provenance_kind NOT IN ('stated','inferred') OR source_observation_id IS NOT NULL),

  status                text        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','superseded','contested','archived','forgotten')),
  superseded_by_id      uuid        NULL REFERENCES memories(id),
  contested_with_id     uuid        NULL REFERENCES memories(id),

  tags                  text[]      NOT NULL DEFAULT '{}',

  occurred_at           timestamptz NULL,
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  last_reinforced_at    timestamptz NULL,
  valid_from            timestamptz NULL,   -- Phase 2
  valid_until           timestamptz NULL,   -- Phase 2

  strength              real        NOT NULL DEFAULT 1.0,
  half_life_hours       real        NOT NULL,
  decay_floor_at        timestamptz NOT NULL,

  embedding_status       text        NOT NULL DEFAULT 'pending'
                            CHECK (embedding_status IN ('pending','ready','failed','skipped')),

  purged_at              timestamptz NULL,   -- 実装済み（2026-09 訂正。Issue #198 / ADR 0124）

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
```

**索引**（各索引がどのクエリのためかを併記する）:

```sql
-- 抽出の冪等性: 同じ Observation に同じ版の抽出器を再実行しても重複を作らない
-- NULLS NOT DISTINCT は必須（下の「⚠ NULLS NOT DISTINCT が要る理由」を参照）
CREATE UNIQUE INDEX uq_memories_extraction
  ON memories (tenant_id, source_observation_id, extractor_version, content_hash)
  NULLS NOT DISTINCT
  WHERE source_observation_id IS NOT NULL;

-- recall 段1のゲート（§7）: tenant + (active|contested) + decay_floor_at の範囲スキャン
--
-- ⚠ 2026-09 訂正（PR #2、docs/decisions/0011-no-window-count-in-ann-stage.md）:
-- 当初案の述語は WHERE status = 'active' だった。これでは contested な Memory が
-- 段1の候補集合にそもそも入らず、「争われている主張を、争われていない顔で出さない」
-- （mandatory companion retrieval、§5・docs/recall.md §8）が実装として成立しなかった。
-- 述語を 'active' 単独から ('active', 'contested') に広げて修正する。
CREATE INDEX idx_memories_recall_gate
  ON memories (tenant_id, status, decay_floor_at)
  WHERE status IN ('active', 'contested');

-- 置換の解決（§5）: 「この Memory は何に置き換わったか」の単純な索引アクセス
CREATE INDEX idx_memories_superseded_by
  ON memories (tenant_id, superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;

-- 係争中の Memory の一括検出・companion 取得（§5）
CREATE INDEX idx_memories_contested
  ON memories (tenant_id, status)
  WHERE status = 'contested';

-- 第3階の群カウント（recall.md の目次帯）: subject 単位の件数集計
CREATE INDEX idx_memories_by_subject
  ON memories (tenant_id, subject_id, status);

-- provenance によるフィルタ（推論を除外する recall オプション）
CREATE INDEX idx_memories_provenance_kind
  ON memories (tenant_id, provenance_kind);

-- Phase 1: open タグの絞り込み。tenant_id を先頭に含めるため btree_gin を要求する。
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE INDEX idx_memories_tags
  ON memories USING gin (tenant_id, tags);
```

### ⚠ `NULLS NOT DISTINCT` が要る理由（2026-09 追記。実測で判明した）

本書の原案は `uq_memories_extraction` に `NULLS NOT DISTINCT` を付けていなかった。
**これは誤りである。** Postgres は既定で一意索引の NULL 同士を「異なる値」として扱う。
`extractor_version` は NULL 許容なので、既定のままだと `extractor_version = NULL` の行に対して
**この一意制約が発火しない。**

実測（PostgreSQL 18.6）: 同じ `(tenant_id, source_observation_id, NULL, content_hash)` を
2回挿入すると、`ON CONFLICT ... DO NOTHING` を付けていても**2行できた**
（`extractor_version` に値が入っている場合は正しく1行に収まる）。

⟹ [roadmap.md](./roadmap.md) 段階3 の完了条件「同じ Observation を二重に送っても
Memory が重複して作られない」が、**この経路だけ静かに崩れる。**
（⚠ 2026-09-29 追記: 参照先の roadmap §2 は削除した（#762）。当時の本文は
[`635c93d` の版](https://github.com/takecchi/mnemora/blob/635c93dcda148f44cf6b51ac2407b28596fccb32/docs/roadmap.md?plain=1#L84-L92) にある。）
`NULLS NOT DISTINCT`（PostgreSQL 15 以降）は NULL を1つの値として扱い、この穴を塞ぐ。

**この誤りが見つからなかった理由も記録しておく。** `packages/testkit` の適合テストは
`extractorVersion` に値が在る場合と `source_observation_id` が NULL の場合は検査していたが、
**「`source_observation_id` は在るが `extractor_version` が NULL」という組み合わせを
検査していなかった。** さらに、インメモリのプレースホルダ実装は JS の文字列キーで
NULL を空文字に潰すため**偶然に**冪等であり、Postgres 実装との食い違いが
適合テストからは見えなかった。**分岐を数えて一本ずつ歯を通す**という規律が、
この種の食い違いを見つける唯一の手段である。

`idx_memories_recall_gate` について: `status IN ('active', 'contested')` は離散・
低カーディナリティの partial 述語として使う（正しい使い方。2値になったが離散性は変わらない）。
`decay_floor_at` は述語ではなく索引の3列目に置き、`WHERE decay_floor_at > now()` を
通常の範囲スキャンとして解決する（§7 で述べた partial index の取り違えを避けるための形）。
**ただし roadmap.md の Phase 1 範囲の整理により、この `decay_floor_at > now()` という
読み取りフィルタ自体は Phase 2 から有効にする。Phase 1 は `decay_floor_at` を書き込む
だけで、段1の読み取りフィルタには使わない。** 索引の3列目としては最初から持たせておく
ことで、Phase 2 で読み取りに使い始める際に索引を作り直す必要が無いようにする
（docs/decisions/0011-no-window-count-in-ann-stage.md に整理を記録）。

### `memory_embeddings_<space>`（Phase 1。テーブルは空間ごとに作る）

**埋め込みは空間（モデル, 次元の組）ごとに別テーブルにする。** 理由は pgvector の仕様上の
制約であり、確認済みの事実である——**pgvector は次元を指定しない `vector` 列を作れるが、
その列には索引を張れない。** 次元を固定した `vector(N)` 列でなければ HNSW / IVFFlat の
索引宣言が通らない。したがって「1つの `memory_embeddings` テーブルに次元の異なる
埋め込みを共存させる」設計は選べない。

⟹ **決定: 埋め込み空間を登録する操作の一部として `memory_embeddings_<space>` テーブルを
作る。** `core` パッケージは次元を知らない（次元はテーブルの DDL に閉じ込められる）。
`<space>` は `(provider, model, dimensions)` から導出したスラグを使う。

```sql
-- 例: OpenAI text-embedding-3-small, 1536次元
CREATE TABLE memory_embeddings_openai_text_embedding_3_small_1536 (
  tenant_id   text        NOT NULL,
  memory_id   uuid        NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  embedding   vector(1536) NOT NULL,
  model       text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_id)
);

-- HNSW 索引。operator class を明示する（cosine 距離を採用する場合）
CREATE INDEX idx_memory_embeddings_openai_1536_hnsw
  ON memory_embeddings_openai_text_embedding_3_small_1536
  USING hnsw (embedding vector_cosine_ops);
```

**⚠ 2026-09-27 追記（文書と実装の照合、main 16976ea）**: 実物の索引名は `idx_memory_embeddings_hnsw_<space>` の形である（上の例の `idx_memory_embeddings_openai_1536_hnsw` は説明用の名前）。さらに、ノルムが0のベクトルを引くための部分索引 `idx_memory_embeddings_zero_norm_<space>`（`(tenant_id, memory_id) WHERE vector_norm(embedding) = 0`）がある。pgvector の cosine の HNSW 索引はゼロベクトルを索引に入れないためで、新しい空間は `registerEmbeddingSpace` が、既存の空間は migration `0022_embedding_zero_norm_index.sql` が作る（[ADR 0343](./decisions/0343-vector-store-search-returns-zero-norm-candidates.md)）。名前の作り方は `packages/postgres/README.md` の同じ節を見ること。

**⚠ 2026-09-27 追記（[Issue #1151](https://github.com/takecchi/mnemora/issues/1151)）: 正規化の後に同じ綴りになる空間どうしは、同じテーブルに潰れる。`registerEmbeddingSpace` は、別の空間の組による2つ目の登録を拒む。**
スラグ（`embeddingSpaceTableName`）は、provider・model を小文字にし、英数字以外の並びを `_` に置き換え、前後の `_` を落としてから、
dimensions と `_` で繋いで作る。この導出は単射ではない（変えていない——変えると既存のデプロイのテーブル名が変わる）。
【実測】次の組は、どれも同じテーブルになる。
- `{a_b, c, 3}` と `{a, b_c, 3}`（区切りの位置が違う）
- `{openai, text-embedding-3-small, 3}` と `{OpenAI, text_embedding_3_small, 3}`（大文字小文字と記号が違う）
- `{ollama, nomic-embed-text:latest, 3}` と `{ollama, nomic-embed-text-latest, 3}`
- `{x, 日本語モデル, 3}` と `{x, 中文模型, 3}`（ASCII 以外の文字は全部落ちるので、model が空になる）

以前は、`CREATE TABLE IF NOT EXISTS` のため2つ目の登録が黙って成功し、検索が `model` 列で絞らないので、2つの空間のベクトルが混ざった。
いまは `registerEmbeddingSpace` が、テーブルのコメントに空間の組（provider・model・dimensions の元の値）を
`mnemora:embedding-space:{…}` の形で記録し、登録のたびに突き合わせる（advisory lock の内側で読んで書く）。

| テーブルのコメント | 登録の結果 |
|---|---|
| 無い（新しく作った・Issue #1151 より前に作られた） | この登録の組を記録して成功 |
| mnemora の記録で、組が同じ | 成功（何も書かない） |
| mnemora の記録で、組が違う | 何も書かずに、`name` が `"EmbeddingSpaceTableConflictError"` の `Error` で拒む |
| mnemora の形ではないコメント（利用者が付けたもの） | 上書きせずに成功（このテーブルは見張れない） |

⚠ **射程**: Issue #1151 より前に作られたテーブルにはコメントが無いので、この変更の後で**最初に登録した組**がそのテーブルの持ち主として
記録される。既に2つの空間が1つのテーブルを使っていた場合、混ざった行は分けられない（provider はどこにも残っていない。行ごとの
`model` 列だけが手がかりになる）。見張るのは登録の口だけで、`VectorStore` の `upsert`・`search` はコメントを見ない——登録せずに
別の空間の組で書き込む経路は防がない。
⟹ 1つの DB で複数の空間を使う（切り替えで旧空間のテーブルが残る場合を含む）なら、正規化の後にも区別が残る provider・model を選ぶこと。

Phase 1 は**稼働中の空間を1つに限る**。2つ目の空間（例えばモデル移行後の新しい埋め込み）を
追加する操作は、既存テーブルの行を書き換えるマイグレーションにはならない——**新しい
`memory_embeddings_<space2>` テーブルを追加するだけ**で済む形にしておく。移行期間中は
両テーブルが並存し、`memories.embedding_status` がどちらの空間で `ready` かを個別に
追う設計は Phase 2 の課題として残す（Phase 1 は単一空間なのでこの複雑さは出ない）。

**⚠ 2026-09-27 追記（[Issue #1015](https://github.com/takecchi/mnemora/issues/1015)）: Phase 1 は空間の切り替えを支えない。切り替えたときに起きること。**
`embeddingProvider` を別の空間のものに替えても、`memories.embedding_status` は空間を区別しないので、古い空間で
`ready` の記憶は `ready` のままで、今の空間の `memory_embeddings_<space>` には行が無い。その結果:
- `recall()` の `memories` にそれらの記憶は出ない。`omitted` は `ann_unreached`（`severity: 'warning'`）で名乗り、
  本当の原因（今の空間に行が無い）とは違う理由に見える（`./recall.md` §4 の `ann_unreached` の節）。`index` の
  `totalInScope`・群カウント・目次帯には残る。
- `Runtime.reembed` は `statuses` に `NotIndexedReason`（`pending`/`failed`/`skipped`）しか受け付けないので、`ready` の
  記憶を新しい空間へ積み直す口は無い（[ADR 0079](./decisions/0079-requeue-embed-jobs.md)）。

`@mnemora/postgres` と `@mnemora/testkit` の fixture で同じである。空間を切り替えるなら、新しい空間で記憶を作り直す
必要があり、その手順は Phase 1 では用意していない。クローン miku の判断で、新しい `Omission` の種類を足す案・
`reembed` で `ready` を受け付ける案・空間ごとに `ready` を追う設計の前倒しは採らず、今の振る舞いを記録した
（選び直す余地は Issue に残してある）。

**確かめていないこと**: 可変次元の埋め込み列を Drizzle でどう型付けるかは一次情報が
見つからなかった。空間ごとのテーブル分割で回避しているため mnemora の設計には影響しないが、
確認できなかった事実として明記する。

### `memory_relations`（`migrations/0026_memory_relations.sql`）

```sql
CREATE TABLE memory_relations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text        NOT NULL,
  from_memory_id  uuid        NOT NULL REFERENCES memories(id),
  to_memory_id    uuid        NOT NULL REFERENCES memories(id),
  kind            text        NOT NULL CHECK (kind IN ('contradicts')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, from_memory_id, to_memory_id, kind)
);

CREATE INDEX idx_memory_relations_from ON memory_relations (tenant_id, from_memory_id, kind);
CREATE INDEX idx_memory_relations_to   ON memory_relations (tenant_id, to_memory_id, kind);
```

3件以上が互いに `contested` になった群だけを、この表で持つ（`kind` は今は `'contradicts'` の
1値だけ）。2者の対は今までどおり `contested_with_id` の列で持ち、この表には書かない。対に
3件目が来たときは、対の列を空にしてこの表へ移す。行は有効期間が重なる組の間にだけ、1組につき
向きを変えて2行張る（[ADR 0378](./decisions/0378-claim-key-contested-detection-covers-contested-matches.md)
決定1・[ADR 0381](./decisions/0381-contested-group-write-path-implementation.md) 決定1・決定5・決定11）。
2026-09-30 より前のこの節は、`kind` に4値を持つ Phase 2 の下書きだった——実物に合わせて書き直した。

### `memory_events`（Phase 1）

§9 に記載。

### `recalls`（Phase 1）

```sql
CREATE TABLE recalls (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            text        NOT NULL,
  subject_id           text        NULL,
  query                jsonb       NOT NULL,             -- 発行された recall クエリ/オプション
  budget               jsonb       NULL,                 -- 申告された予算（§10 の量の計測）
  omitted              jsonb       NOT NULL DEFAULT '[]', -- Omission[] のスナップショット
  usage                jsonb       NOT NULL,              -- RecallUsage のスナップショット
  index_band           jsonb       NOT NULL,              -- 第3階の群カウント（目次帯）
  explain              jsonb       NOT NULL DEFAULT '{}', -- 各段の実行/未実行トレース
  returned_memories    jsonb       NOT NULL,              -- { breakdownCaptured, memories } — 内訳つき（[ADR 0155](./decisions/0155-recall-score-breakdown-persisted.md)）
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recalls_by_subject ON recalls (tenant_id, subject_id, created_at);
```

`recalls` は recall 一回ごとに1行を持つ。これが必要な理由は二つの要求が同じ機構を求めて
いるからである——(a) 「候補に出たが LLM が使わなかった」を後から判定するには recall 自体が
`recallId` を持ち帰れる必要がある（explainability）。(b) 強化（§6）は `recall_usages` を
通じて `recall_id` を参照する。**一つの機構（recall を記録すること）が二つの要求を満たす。**

`returned_memories` は当初 `returned_memory_ids uuid[]`（memoryId だけ）だったが、
[ADR 0155](./decisions/0155-recall-score-breakdown-persisted.md) で「後から再現できないもの」
（`score`/`retrievedVia`/`companionOf`/`associationOf`）を含む jsonb 1列へ置き換えた
（列を足すのではなく置き換えている——理由は ADR 0155 参照）。`MemoryStore.getRecall(ctx,
recallId)` がこの行を読み戻す口である。

**⚠ 2026-09-27 追記（今の振る舞いを書いたもの、[Issue #1206](https://github.com/takecchi/mnemora/issues/1206)）**: `query` には `recall()` が検証した後のクエリがそのまま入る。そのうち JSON で往復しない値は、`getRecall` で読み戻すと adapter によって違う。`occurredAfter`・`occurredBefore`・`validAt` は、`@mnemora/postgres` では ISO 8601 の文字列で、`@mnemora/testkit` の fixture では `Date` のまま返る。`vector` の要素の `-0` は、Postgres だけで `0` になる。どちらかに揃える約束はしていない（`observations.payload` の [Issue #1076](https://github.com/takecchi/mnemora/issues/1076) と同じ扱い。詳細は `RecallRecord.query` の TSDoc）。`omitted`・`usage`・`index_band`・`explain`・`returned_memories` が `recall()` の返り値と一致することは、`recall-explain-accounting.postgres.test.ts` が2実装で縛っている（`budget` は `recall-record-query-roundtrip.postgres.test.ts`）。

### `recall_usages`（Phase 1）

§6 に記載。

### `labels` / `memory_labels`（Phase 2）

§8 に記載。

**⚠ 2026-09-27 追記（後の ADR との照合）**: 見出しの「Phase 2」は、もう実装状況を表していない。2つの表は
`migrations/0020_taxonomy_labels.sql` で Phase 1 のスキーマに入り（[ADR 0318](./decisions/0318-taxonomy-labels.md)、既存の
`memories.tags` からの backfill を含む）、`RecallQuery.labels` による絞り込みも実装された
（[ADR 0323](./decisions/0323-taxonomy-recall-filter.md)）。migrate の後に2つの表が在ること、`@mnemora/postgres` と
`@mnemora/testkit` の fixture の両方が `MemoryStore.listLabels?`/`registerLabel?` と
`TenantSettingsStore.getTaxonomyMode?` を持つことを当て直した。詳細は §8 の 2026-09-25 追記。

### `outbox`（Phase 1）

```sql
CREATE TABLE outbox (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text        NOT NULL,
  kind          text        NOT NULL,      -- 'extract' | 'embed' | 'consolidate' | 'reflect' | ...
  payload       jsonb       NOT NULL,
  available_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz NULL,
  claimed_by    text        NULL,
  attempts      integer     NOT NULL DEFAULT 0,
  completed_at  timestamptz NULL,
  failed_at     timestamptz NULL,
  last_error    text        NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ワーカーの claim クエリ: 未着手・未完了のジョブを available_at 昇順で取得
CREATE INDEX idx_outbox_pending
  ON outbox (tenant_id, kind, available_at)
  WHERE completed_at IS NULL AND claimed_at IS NULL;
```

`observe()` のコミットと「抽出ジョブを積む」を同一トランザクションで行うための
transactional outbox（[architecture.md](./architecture.md) §3.4）。DB トランザクションの中から Redis / BullMQ へ直接書くと
at-least-once が壊れるため、まず同じトランザクションで `outbox` へ書き、別の運搬役
（BullMQ ワーカー、または `pg-boss` を使う場合はそのポーリング）が `outbox` を読んで
実際のキューへ渡す。

### `tenant_settings`（Phase 1）

§9 に記載。§9（監査ログの保持方針）と
§7（half-life のテナント既定値）が要求する「テナント設定」を格納する場所として、
本書の裁量で追加した。[ADR 0007](./decisions/0007-tenant-scoping.md) が禁じる「テナントの台帳」（識別・認証の真実源）とは役割が
異なることを §9 で明記した通りである。

### 規約（drizzle-kit と ORDER BY について）

- **ベクトル索引の DDL は手書きのマイグレーションで管理し、`drizzle-kit push` に任せない。**
  drizzle-kit が生成する HNSW の DDL に operator class が欠落する不具合報告があるため
  （drizzle-orm #5792）。`packages/postgres` はマイグレーション実行の口を1つ持つ。
- **`ORDER BY` には距離演算子の結果をそのまま昇順で書く。** `1 - cosineDistance(...)` の
  ような式にしない。Drizzle 公式ガイドの例がこの形（`1 - cosineDistance` を降順）を
  示しているが、これでは HNSW 索引が効かない可能性が指摘されている
  （drizzle-orm-docs #436）。この規約は `testkit` の適合テストで
  `EXPLAIN` を見て索引が実際に使われることを検査する対象にする。

---

## 11. Memory lifecycle

```
                 ┌────────────────────────── (reinforced: last_reinforced_at 更新) ─┐
                 │                                                                  │
observed → extracted → active ─────────────────────────────────────────────────────┘
                          │
                          ├──(置換が機械的に決定できる)──▶ superseded
                          │                                  │
                          │                                  └──(restoreSuperseded() 呼び出し・明示的な復帰)──▶ active（行15）
                          │
                          ├──(判定できない対向を検出)────▶ contested ──(後で解決)──▶ active | superseded
                          │
                          ▼
                       archived  ──(forget() 呼び出し)──▶ forgotten ──(purge() 呼び出し)──▶ purged(*)
                          │
                          └──(restoreArchived() 呼び出し・明示的な復帰)──▶ active（行14）

(なし) ──consolidate() 呼び出し──▶ active   ※ Observation を経ない。統合元は同時に superseded へ（行5・行12）
(なし) ──reflect() 呼び出し──────▶ active   ※ Observation を経ない。既存の行は一切書き換えない（行13）
```

`(*)` `purged` は `memories.status` の値ではなく、`memory_events.kind = 'purged'` と
`memories.purged_at IS NOT NULL` で表される（§9）。`observed` と `extracted` も
`memories.status` の値ではない——これらはパイプラインの段階を指す名前であり、
`status` 列は Memory が最初に行として存在する時点（`active`）から始まる。

**⚠ 上の図・この注記は、2026-09 追記まで `consolidate()`/`reflect()` の入口を欠いていた**
（Issue #138。ADR 0089・ADR 0091 が現物からそれぞれ確かめて負債として記録していたが、
どちらも「ついでに直さない」（`docs/autonomy.md` §2）を守って表自体は直さなかった）。
`consolidate()`（行12）と `reflect()`（行13）が作る Memory には、**`observed`/`extracted` の
段階自体が無い**——`observe()` を1回も経由せず、最初から `status='active'` の行として
作られる。`source_observation_id`/`extractor_version` は常に `NULL` である（§2・§10 の
`CHECK (provenance_kind NOT IN ('stated','inferred') OR source_observation_id IS NOT NULL)` が、
`consolidated`/`reflected`/`imported` にはこの制約を課していないことに対応する）。**一度 `active`
へ入ってしまえば、それがどの入口（行2・行12・行13）から来たかによらず、行3・行4・行6〜11の
遷移はすべて同じに適用される**——`superseded`/`contested`/`archived`/`forgotten` の判定・
埋め込みジョブ・強化のどれも、由来を区別する分岐を持たない。

**⚠ 2026-09 訂正（Issue #289、[ADR 0124](./decisions/0124-purge-physical-delete.md)）:
上の図・行10は「`purge()` 呼び出し・Phase 2」と書いていたが、`purge()` は
Issue #198 / ADR 0124 で実装済みである。**図そのもの（遷移の形・`(*)` の脚注）は
実装と一致しており、直したのは「Phase 2」という古い注記だけである。

| # | 遷移 | トリガー | 同期/非同期 | 書き換わる列 | 残るイベント (`memory_events.kind`) |
|---|---|---|---|---|---|
| 1 | (なし) → observed | `observe()` 呼び出し | 同期 | `observations` へ INSERT | なし（`observations` 自体が追記専用の記録） |
| 2 | observed → extracted → active | 抽出パイプライン実行。`extract: 'sync'` なら `observe()` 内、`'deferred'` なら `outbox` 経由のワーカー | `sync`: 同期 / `deferred`: 非同期（`outbox` 行は `observe()` と同一トランザクションで先に書かれる） | `memories` へ INSERT（`status='active'`、`digest`、`provenance`、`decay_floor_at` を初期計算） | `created` |
| 3 | active → active（embedding 反映） | 埋め込み計算ジョブ。行2・行12・行13のいずれで Memory が作られても同じ `embed` ジョブが積まれる | 非同期（`outbox` 経由。外部 embedding provider 呼び出しをトランザクション内に置かない） | `memory_embeddings_<space>` へ INSERT、`memories.embedding_status` 更新 | なし（列単位の状態変化はログしない。監査ログ量リスクへの対処） |
| 4 | active → active（reinforced） | `observe({kind:'memory_usage', ...})` により `recall_usages` へ新規行が実際に挿入されたとき | 同期（`observe()` と同一トランザクション）。⚠ **2026-09-27 明記（[Issue #961](https://github.com/takecchi/mnemora/issues/961)）: 記録と強化が1トランザクションになるのは、`MemoryStore.recordUsageAndReinforce?` を持つ adapter だけ**——持たない adapter は2段のままで、強化の前で落ちると再送でも強化されない（[ADR 0009](./decisions/0009-usage-feedback-via-observe.md) の同日付追記） | `recall_usages` へ INSERT（新規のみ）、`memories.last_reinforced_at` / `decay_floor_at` 更新（`strength` は動かさない。ADR 0041） | なし（使用の記録は `recall_usages` の行の存在で表す。⚠ **2026-09-26 改訂（[Issue #871](https://github.com/takecchi/mnemora/issues/871)）: この欄は以前 `updated`（`meta.reason='reinforced'`）と書いていたが、実装はどの adapter でも `memory_events` に書かない。**文書を実装に合わせた。理由と採らなかった案は §9 の改訂注記と [ADR 0009](./decisions/0009-usage-feedback-via-observe.md) の追記） |
| 5 | active → superseded | 抽出・統合パイプラインが置換を機械的に決定 | 判定ロジック自体は非同期でよいが、書き込み（旧行の `status`/`superseded_by_id` 更新と新 Memory の作成）は1トランザクションで完結させる | `status='superseded'`、`superseded_by_id` | `superseded` |
| 6 | active → contested | 判定できない対向を検出。実装は `Runtime.markContested(ctx, firstId, secondId)`（Issue #197、[ADR 0134](./decisions/0134-mark-contested-explicit-operation.md)）——**この口は矛盾かどうかを自分で判定しない。**判定は呼び出し側が持つ | 同上（`MemoryStore.markContestedPair` が1トランザクションで両側を書く） | 両側の `status='contested'`、`contested_with_id` を相互に設定 | `updated`（`meta.reason='contested'`） |
| 7 | contested → active \| superseded | 新しい証拠・人手の訂正により解決。実装は `Runtime.resolveContested(ctx, firstId, secondId, resolution)`（Issue #197、[ADR 0150](./decisions/0150-resolve-contested-explicit-operation.md)）。`resolution` は `{kind:'supersede', winnerId}`（負けた側が出る）か `{kind:'both_active'}`（**対向ではなかったと分かった決着。負けた側が居ない**——この行の「（負けた側は）」という括弧書きに対応する）の2つ。⚠ **「統合により解決」だけは今日も実装が無い**（ADR 0150 負債3） | 判定は非同期でよいが書き込みは1トランザクション（`MemoryStore.resolveContestedPair`）。**適格性は両側 `status='contested'` かつ `contested_with_id` が相互に成立していること**——片方向の対は解決させない（ADR 0046 の対不変条件を、解決側から壊さないため） | `status` を確定、`contested_with_id` をクリア、（負けた側は）`superseded_by_id` を設定 | 勝った側 `updated` / 負けた側 `superseded`（`both_active` なら両側 `updated`）。どちらも `meta.reason='contested_resolved'`、`meta.resolution` に決着の種類 |
| 8 | active → archived | `decay_floor_at <= now()`（境界を含む。実装は `<=`）を検出する低頻度の掃引（`Runtime.sweepArchive` → `MemoryStore.archiveDecayed`）。**対象は `active` だけである**（[ADR 0114](./decisions/0114-archive-sweep-for-decayed-memories.md) **決定2**、逐語「対象は `status = 'active'` のみ。`superseded`/`contested` はこの口では触らない」）。🔴 **⚠ 2026-09-24 改訂（[Issue #465](https://github.com/takecchi/mnemora/issues/465)）: この行は以前 `active/superseded/contested → archived` と書いていた。**2026-09-17 の注記は「この行を実装に合わせるか、実装をこの行に合わせるかは、文書を直す作業ではなく新しい判断である」として縮めずに置いていた。その判断は 2026-09-20 に Issue #465 で下された（クローンの判定。⚠ オーナー本人の判断ではない）——**実装が正しく、この行が広すぎた。**理由: 北極星「使われない記憶が、静かに遠ざかる」の対象は**生きている**記憶であり、`superseded` は既に別の記憶に置き換えられている（倒すと「間違いに気づいたとき、直せる」の復元経路を塞ぎうる）、`contested` は対向と組で意味を持つ（個別の行の条件で倒すと、片方だけが `archived` になりうる）。⚠ **同 ADR の引き受けた負債1（逐語「`superseded`/`contested` な Memory は `decay_floor_at` を過ぎても掃かれない」）は残っている。**それらの行をいつか片付けるべきかは掃引の問いではなく別の問いであり、[Issue #567](https://github.com/takecchi/mnemora/issues/567) が持っている | 非同期（定期ジョブ。全件走査ではなく `decay_floor_at` の範囲走査） | `status='archived'` | `archived` |
| 9 | 任意 → forgotten | `forget(ctx, target)` 呼び出し | 同期（`EventStore` への追記と同一トランザクション） | `status='forgotten'` | `forgotten` |
| 10 | forgotten → purged（実装済み。Issue #198 / ADR 0124） | `purge(ctx, target)` 呼び出し（法的要求） | 同期 | `content`/`digest` をトゥームストーンで上書き、`purged_at` 設定 | `purged` |
| 11 | (memory_events の掃除) | `MemoryStore.purgeExpiredEvents?` の明示呼び出し（任意メソッド。Issue #210 / [ADR 0115](./decisions/0115-event-retention-purge.md)）。定期実行そのものは呼び出し側（運用のスクリプト・cron）の責務——`tick()`/`observe()` には配線しない | 非同期（保守ジョブ。`EventStore` interface は経由しない） | `memory_events` から古い行を DELETE | `events_purged`（件数・期間のみ。削除対象の詳細は残さない） |
| 12 | (なし) → active（統合先の新規作成。Observation を経ない） | `Runtime.consolidate()` 呼び出し（Issue #103、ADR 0089）。統合元 2件以上が確定した後、LLM 呼び出しが成功した場合のみ | 同期（`consolidate()` の呼び出し1回の中で完結し、`tick()` はこの操作を駆動しない）。統合元の supersede（行5）と同一トランザクションで書けるかは adapter 依存——口（`MemoryStore.supersedeWithNewMemories`）が在れば1トランザクション、無ければ2段（ADR 0100） | `memories` へ INSERT（`status='active'`、`provenance.kind='consolidated'`・`sources=<統合元の memoryId>`、`decay_floor_at` を初期計算、`strength=1`）。`source_observation_id`/`extractor_version` は常に `NULL`。⚠ **2026-09-26 明記（[Issue #882](https://github.com/takecchi/mnemora/issues/882)）: ここでの「統合元」は、統合の対象として選ばれた（eligible の）memoryId である**——LLM を呼ぶ前に確定し、後から書き直さない。⟹ CAS の破れ（`status_changed_concurrently`）や途中の失敗（`not_attempted`）で実際には `superseded` にならなかった id も含みうる。実際に置き換えたかどうかは、各 id の `status`/`superseded_by_id`（または `consolidate()` の返り値の `sources[].kind`）で確かめる（[ADR 0089](./decisions/0089-runtime-consolidate-shape.md) の追記） | `created`（`meta.reason='consolidated'`、`meta.sources=<統合元の memoryId>`。`meta.sources` も同じく eligible の memoryId） |
| 13 | (なし) → active（内省による新規作成。Observation を経ない） | `Runtime.reflect()` 呼び出し（Issue #104、ADR 0091）。土台 1件以上に対し LLM が `outcome:'reflected'` を返した場合のみ | 同期（`reflect()` の呼び出し1回の中で完結し、`tick()` はこの操作を駆動しない） | `memories` へ INSERT（`status='active'`、`provenance.kind='reflected'`・`sources=<土台の memoryId>`、`decay_floor_at` を初期計算、`strength=1`）。`source_observation_id`/`extractor_version` は常に `NULL`。**既存の行へは一切書き込まない**——行5〜7のどれも発生しない | `created`（`meta.reason='reflected'`、`meta.sources=<土台の memoryId>`） |
| 14 | archived → active | `Runtime.restoreArchived(ctx, target)` 呼び出し（Issue #195、[ADR 0122](./decisions/0122-restore-archived-memory.md)）。行8（掃引）の片道を、明示的な呼び出しで開く | 同期（`MemoryStore.updateStatusWithEvent` の呼び出し1回・1トランザクションで完結。行9〔`forget`〕と同じ扱い） | `status='active'`。⚠ **2026-09 訂正（マネージャー決定、Issue #196、[ADR 0153](./decisions/0153-recall-decay-floor-gate.md)）: `decay_floor_at` も動かす。**この行は以前「`decay_floor_at` は動かさない——復帰と強化（行4）は別の操作であり、居着かせたい呼び出し側は `reinforce`（行4）を別途呼ぶ」と書いていたが、ADR 0153 が `recall()` に既定 ON の忘却ゲート（`decayFloorAt <= now` の Memory を候補から除外する）を導入したことで、`decay_floor_at` を動かさないままだと `sweepArchive` の選定条件（`decayFloorAt <= now`）を満たしていた対象が復帰後も recall に二度と現れない黙った no-op になるため、この決定を上書きした。**`status` の復帰に成功した対象へ続けて `reinforce`（行4）を呼ぶ**（既存の `MemoryStore.reinforce` をそのまま使い、新しい interface・adapter は増やしていない。`reinforce` が失敗しても `status` の復帰は握り潰さない——`Runtime.restoreArchived` の doc コメント参照）。⚠ **2026-10 記録（[ADR 0432](./decisions/0432-recall-status-recheck-and-archive-docs.md) AL-2）: `status` の復帰と `reinforce` は別々の書き込みで、そのあいだは `decay_floor_at` が過去を指している。この窓に同じ Memory への `sweepArchive`（行8）が入ると、`restored` と返っても `status` は `archived` のまま残ることがある**（`reinforce` は `decay_floor_at` を延ばすだけで `status` を戻さない。イベントは `archived → restored → archived`、outcome は `restored` のまま `reinforceError` も付かない。両 adapter で割り込みを入れて再現した）。この版では直していない——結果に欄を足す案と、復帰と強化を store の1操作にする案はオーナーの判断に回してある | `restored` |
| 15 | superseded → active | `Runtime.restoreSuperseded(ctx, target)` 呼び出し（Issue #369、[ADR 0230](./decisions/0230-restore-superseded-recovery-path.md)）。行5・行7・行12（`active → superseded` を作る3つの経路）の片道を、明示的な呼び出しで開く。**粒度は「群」**——`target: { supersededById }` は置き換えた側の id であり、個別の統合元 id を指定する形は無い（`superseded` な Memory は `recall()` に出てこないため）。🔴 **⚠ 2026-09-17 注記: 戻るのは「1回の操作の分」ではなく、その `superseded_by_id` に紐づく全部である。**行7（`resolveContested`）の勝者は**新規作成された Memory ではなく前から在る Memory** なので、同じ id の下に別々の操作の敗者が積み上がりうる（【実測】両 adapter で再現。[Issue #515](https://github.com/takecchi/mnemora/issues/515) / [ADR 0230](./decisions/0230-restore-superseded-recovery-path.md) の冒頭の訂正）。🔴 **⚠ 2026-09-18 追記: 戻す前に、この群に何が戻るかを確かめる読み取り専用の口が有る**——`Runtime.restoreSuperseded(ctx, target, { dryRun: true })`（`MemoryStore.previewRestoreSupersededBy?` へ委譲し、書き込みは一切起きない）。既定（省略・`false`）は変えていない——呼べば今日どおり実際に戻る。対象ごとの `memory_events` の直近の `kind: 'superseded'` イベントから `meta.reason` を運ぶため、「なぜその群に入っているか」（`reextract`/`consolidate`/`resolveContested` のどれが `superseded` にしたか）も分かる——一致するイベントが無い場合は `null`（[ADR 0237](./decisions/0237-restore-superseded-dry-run-preview.md)、Issue #515）。🔴 **⚠ 2026-09-21 追記（Issue #515 方向①、[ADR 0258](./decisions/0258-restore-superseded-operation-scope.md)）: 群を「1回の操作」単位に絞る任意の絞り込みが入った**——`Runtime.restoreSuperseded(ctx, { supersededById, onlyMemoryIds })`（`MemoryStore.restoreSupersededBy?`/`previewRestoreSupersededBy?` の `filter.onlyMemoryIds` へ委譲）。**新しい鍵は作っていない**——`memories.id`（既存の PK）と、上記の `supersededReason` を組み合わせ、呼び出し側が「どの id が同じ操作に属するか」を判断してから渡す形。この判断は経路によって非対称である: `consolidated` は reason が同じなら群全体で1操作（統合先の `sourceObservationId` が常に `null` であるため、`createMemory` の冪等衝突〔`WHERE source_observation_id IS NOT NULL`〕の対象に入らず、統合先は必ず新規作成されるという構造的な保証による）。`contested_resolved` は1件が1操作（`resolveContested` は呼び出し1回につきちょうど1件の敗者しか作らないという不変条件を歯で固定している）。🔴 **`reextract_superseded` は、既存の情報だけでは操作単位に分割できないことがある**——`reextract` のアンカー選定（候補列のうち、非 `active` の既存行にぶつからない先頭。ぶつかる候補が無ければ `memoryIds[0]`。[ADR 0454](./decisions/0454-reextract-anchor-observe-consolidate-state-matrix-round30.md)）が、`createMemoryWithOutbox` の冪等な `ON CONFLICT ... DO NOTHING` 経由で既存の Memory に解決されると、複数回の別々の `reextract` 呼び出しが同じアンカーを共有し、`meta.reason`/`sourceObservationId`/`extractorVersion` が完全に一致しうる（両 adapter で再現。[ADR 0230](./decisions/0230-restore-superseded-recovery-path.md) 訂正4）。⟹ **`reextract_superseded` の候補は「割れる」と名乗らない**——`groupSupersededCandidatesByOperation`（`@mnemora/core`）はこれを `boundaryConfidence: "unknown"` として、まとめた配列のまま返す（1件ずつに分割すると「別操作である」という偽の構造を与えてしまうため）。既定（`onlyMemoryIds` 省略）は変えていない——群全体が対象になる、この PR 以前と同じ振る舞いのままである。🔴 **⚠ 2026-09-26 追記（Issue #515 クローズ）: 上の非対称は今の契約として確定した。**群は「同じ `superseded_by_id` を指す `superseded` の行すべて」であり、1回の操作の単位とは限らない——バグではなく確定した仕様である。呼び出し側は `dryRun: true` で群の中身と `supersededReason` を確かめ、`onlyMemoryIds` で絞ってから戻すこと。詳細・採らなかった案は [ADR 0230](./decisions/0230-restore-superseded-recovery-path.md) 末尾の同日付追記を参照 | 同期（`MemoryStore.restoreSupersededBy?` の呼び出し1回・1トランザクションで対象行（`superseded_by_id` が一致し `status='superseded'` の全行、`onlyMemoryIds` が在ればその積集合）を選んで更新する。任意メソッド——口が無い adapter では `supported: false` を返し、書き込みは一切起きない） | 対象行の `status='active'`・`superseded_by_id=NULL`。続けて `reinforce`（行4）も呼ぶ——ADR 0153 の忘却ゲートを再び通すため、行14（`restoreArchived`）と同じく `decay_floor_at` も動かす。⚠ **2026-09 訂正: 「行14とは異なり `decay_floor_at` も動かす」は誤りだった。**行14自体が ADR 0153 により `decay_floor_at` を動かす側へ訂正された（行14の訂正参照）ため、両者とも `decay_floor_at` を動かす点は同じである——違うのは前提のほうである。行14の対象（`sweepArchive` が `archived` にした行）は掃引の選定条件そのものにより床が必ず過去であるのに対し、`superseded` な Memory の床は過去とは限らない（`consolidate`/`reextract` は活発に使われている Memory も統合・置換しうるため、統合直後の `decayFloorAt` が先の未来を指すことがある）。それでも無条件に `reinforce` を呼んで安全である理由（ADR 0048「reinforce は減衰の起点を巻き戻さない」）は `Runtime.restoreSuperseded` の doc コメント「⚠ reinforce する理由」参照。**置き換えた側（`supersededById` が指す Memory）には一切触れない** | `unsuperseded` |

**⚠ 2026-09-27 追記（[Issue #1160](https://github.com/takecchi/mnemora/issues/1160)）: 行6・行7（と `resolveOrphanedContested`）のイベントの `meta` は、対向の id を `contestedWithId` に持つ。**
行7の解決は `contested_with_id` をクリアするので、以前は `both_active` で解いた対が、状態からも監査ログからも「誰と対だったか」を
失っていた。いまは次のとおり、対にまつわるイベントはどれも、役割（勝者・敗者）にも決着の種類にもよらず `contestedWithId` を持つ。

| 操作 | イベント | `meta` |
|---|---|---|
| `markContested(A, B)`（行6） | A・B の `updated` | `{ reason: "contested", contestedWithId: <相手> }` |
| `resolveContested`、`both_active`（行7） | A・B の `updated` | `{ reason: "contested_resolved", resolution: "both_active", contestedWithId: <相手> }` |
| `resolveContested`、`supersede`（行7） | 勝者の `updated` | `{ reason: "contested_resolved", resolution: "supersede", contestedWithId: <敗者> }` |
| 〃 | 敗者の `superseded` | 上と同じ形に `supersededById: <勝者>` も（値は `contestedWithId` と同じ。ADR 0150 の 2026-09-27 追記） |
| `resolveOrphanedContested(生き残った側)` | 生き残った側の `updated` | `{ reason: "contested_resolved", resolution: "orphan_reclaimed", contestedWithId: <forget された相手> }` |

`opts.reason` を渡したときは、どれも `note` が加わる。⚠ **射程**: この版より前に積まれたイベントには `contestedWithId` が無く、
後から足すこともできない（`EventStore` は追記専用で、`update` を持たない。§9）。古い `both_active` の対は、引き続き監査ログからは辿れない。

**⚠ 2026-09-30 追記（文書だけ。今の振る舞いを書いたもの）: 上の表は2者版の話である。群版（3件以上。`markContestedGroup`・`resolveContestedGroup`）の `updated` の `meta` には、`contestedWithId` が無い。**
`markContestedGroup` の各メンバーの `updated` は `{ reason: "contested" }`（`opts.reason` があれば `note` が加わる。⚠ **2026-10-01 から、呼び出し時点で既に `contested` で `contestedWithId` も無いメンバー〔既存の群の一員〕には積まない**。`active` から入るメンバーと、2者の対から吸収されて `contestedWithId` が外れるメンバーには積む。[ADR 0431](./decisions/0431-contested-group-event-growth-and-recall-cut.md)）、
`resolveContestedGroup` の勝者・`both_active` の各メンバーの `updated` は `{ reason: "contested_resolved", resolution }`
（同じく `note`）で、相手の id は載らない。群は1対1の列 `contested_with_id` に収まらないので、相手は
`memory_relations` の行（`kind: 'contradicts'`、メンバー全員の間の双方向の完全グラフ）で持つ設計である（[ADR 0378](./decisions/0378-claim-key-contested-detection-covers-contested-matches.md) 決定1・決定2）。
⟹ **群の相手は、`RelationStore.listRelated(ctx, memoryId, "contradicts")` で辿る。**⚠ **辿れるのは `contested` の間だけ**——
`resolveContestedGroup` は決着の種類に関わらずメンバー間の `contradicts` の行を消す（[ADR 0381](./decisions/0381-contested-group-write-path-implementation.md) 決定3）ので、
解消した後の群は、`updated` の `meta` からも表からも「誰と群だったか」を辿れない（`observe()` の claim key の検出が結んだ群なら、
結んだときの `meta.note`〔JSON 文字列〕の `memberIds` に、id の昇順で先頭10件が残る——⚠ **11件以上の群では全員は残らない**〔`memberCount` が全体の件数、`memberIdsTruncated` が切ったかどうか。2026-10-01 まで全員を入れていた。[ADR 0431](./decisions/0431-contested-group-event-growth-and-recall-cut.md)〕。それ以外で辿る手段は、確かめていない）。

**同期/非同期の要点**: `observe()` は常に同期でリターンする（呼び出し側は待たされない）。
「重い処理」——抽出・埋め込み・アーカイブ掃引・監査ログの保持期間掃除——はすべて非同期に
逃がされるが、逃がし方は一様ではない。抽出と埋め込みは `outbox` を経由する
transactional outbox パターン（同一トランザクションでジョブを積んでから、別の運搬役が
実キューへ渡す）。アーカイブ掃引と監査ログ掃除は、`outbox` すら経由しない定期実行の
保守ジョブであり、範囲走査（`decay_floor_at` の範囲、または保持期限）だけを行い全件走査を
しない。`forget()` と `purge()` は例外的に同期処理として扱う——これらは「消えたことが
確実に記録される」という保証が呼び出し側の応答を待ってでも必要な操作だからである。
`consolidate()` と `reflect()`（行12・行13）も呼び出し自体は常に同期でリターンする——
LLM 呼び出しを含め、呼び出し側の1回の `await` の中で完結する。**`tick()` はこの2つを
駆動しない**——Background Cognition の実運用（スケジューラによる自動起動）は Phase 1 の
範囲外であり（`docs/roadmap.md` §1.3）、呼び出し側が明示的に呼んだときだけ動く。

**⚠ 2026-09-27 追記（後の ADR・実物との照合）**:
- 上の段落と表の行12・行13の「`tick()` はこの2つを駆動しない」は、もう成り立たない。
  [ADR 0157](./decisions/0157-tick-drives-consolidate-and-reflect.md) で、`tick()` は `consolidate`/`reflect` の
  outbox ジョブが在ればそれを駆動する（ジョブの `payload.memoryId` を種にして `consolidate()`/`reflect()` を呼ぶ）。
  ジョブを**自動で積む**のは `RuntimeConfig.autoQueueConsolidateReflectOnExtract: true` のときだけで、既定では
  積まない——既定の構成では、上の段落のとおり呼び出し側が明示的に呼んだときだけ動く。自動ジョブの経路で積まれる
  `memory_events` は、直接呼んだときと同じ形である（統合元の `superseded`・統合先の `created`、内省の `created`。
  `@mnemora/postgres` と `@mnemora/testkit` の fixture で、直接の呼び出しと `tick()` 経由を並べて当て直した）。
  内省は冪等性を買わない（ADR 0091 決定11）ので、同じ種の近くの記憶それぞれにジョブが積まれると、内省の Memory が
  ジョブの数だけできうる。
- 行7の `meta.resolution` は `'supersede'`/`'both_active'` のほかに、`Runtime.resolveOrphanedContested`（対向が
  消えた `contested` を1件だけ戻す口）が書く `'orphan_reclaimed'` を持つ（[ADR 0150](./decisions/0150-resolve-contested-explicit-operation.md) の
  追記。`meta.reason` は同じく `'contested_resolved'`、`kind` は `updated`）。
- 行12の `created` イベントは、`consolidate()` の `opts.actor`・`opts.reason`（`meta.note`）を統合元の `superseded` と
  同じく持つ（2026-09-27 に、`actor` が `{ type: "system" }` に決め打ちで `note` も無かった食い違いを直した）。
- 行7の `supersede` で負けた側の `superseded` は、`meta.supersededById` に勝った側の id を持つ（行5・行12・reextract の
  `superseded` と同じ形。2026-09-27 に足した。[ADR 0150](./decisions/0150-resolve-contested-explicit-operation.md) の追記）。
  群版の `resolveContestedGroup` で負けた側の `superseded` も同じく `meta.supersededById` を持つ（2026-09-30 に揃えた。
  [ADR 0421](./decisions/0421-concurrent-write-and-audit-event-holes.md)）。
- 行11の `events_purged` の meta の日時（`oldestPurgedAt`・`newestPurgedAt`・`olderThan`）は ISO 8601 の文字列である。
  `@mnemora/postgres` は meta を JSON で保存するので文字列で読み戻り、`@mnemora/testkit` の fixture も 2026-09-27 から
  同じく文字列で持つ（それまでは `Date` のまま持っていた）。

**⚠ 2026-09-27 追記2（今日入った変更の後に、表の各行を Runtime で起こして当て直した）**: `@mnemora/postgres` と
`@mnemora/testkit` の fixture の両方で、各行の操作が積むイベントの `kind`・`meta` の欄・状態の遷移を並べた。
表の遷移と `kind` はどの行も今の実装と一致した（2実装の違いは `meta` の鍵の順と id の形だけ）。表に書いていなかった
ことを次に足す。
- 行2・行5の `meta`: 行2の `created` は `{ reason: 'extracted', sourceObservationId, extractorVersion }`。行5
  （`Runtime.reextract`）の旧い行の `superseded` は `{ reason: 'reextract_superseded', sourceObservationId,
  extractorVersion, supersededById }`、作り直した行は行2と同じ `created`。`active → superseded` の `meta.reason` は、
  入口ごとに `'reextract_superseded'`（行5）・`'consolidated'`（行12）・`'contested_resolved'`（行7）の3つで、行15の
  `dryRun` が運ぶ `supersededReason` はこの値である。
- 行2の `created` の `meta.droppedCandidates`（2026-09-28 から。[Issue #1063](https://github.com/takecchi/mnemora/issues/1063)、
  [ADR 0347](./decisions/0347-extract-write-path-redelivery-and-unsaveable-candidates.md)）: 同じ抽出で、store が保存できずに落とした
  候補があったときだけ付く。要素は `{ index, contentHash, code, message }`（`index` は LLM が返した順の 0 起点。候補の本文は写さない）。
  残った候補の `created` のすべてに同じ配列が付く。落とした候補が無ければ、このキーは無い（`meta` の形は変わらない）。
  全件が落ちた抽出は例外になり、`created` は1件も積まれない。
- 行2（`reextract` が作り直す行を含む）・行12・行13の `created` の `meta.droppedFields`（2026-10-01 から。[ADR 0443](./decisions/0443-aux-field-drop-bind-limit-association-fetch.md)（抽出）・
  [ADR 0456](./decisions/0456-llm-returned-values-malformed-read-filter-nul-named.md)（統合・内省）。`droppedCandidates` が「候補ごと落とした」記録なのに対し、これは
  「候補は残し、保存できない補助の欄だけ落とした」記録）: LLM が返した `digest`・`tags` の要素・claim key が NUL（U+0000）を含んだときだけ付く。要素は
  `{ index, contentHash, field, reason: 'nul_character', count?, tagIndexes? }`（`field` は `'digest'`（本文の先頭を切り出したフォールバックの digest になる）・
  `'tags'`（NUL を含む要素だけを捨てる。`count` と、捨てた要素の添字 `tagIndexes`（先頭から20個まで））・`'claimKey'`（`null` になる）。値そのものは写さない）。
  `index` は抽出では `droppedCandidates` と同じ数え方。統合・内省は1件しか作らないので、`index` は 0 で、その1件の記憶の `created` に付く。落とした欄が無ければ、このキーは無い（`meta` の形は変わらない）。
  本文（`content`）の NUL は落とせないので、従来どおり候補ごと落ちる（抽出）か例外（統合・内省）になる。
- 行4・行14・行15の強化は、`at` が起点（`last_reinforced_at ?? recorded_at`）より狭義に新しいときだけ書く。そうで
  なければ、活動時計の欄も含めて何も書かない（Issue #1093、[ADR 0048](./decisions/0048-reinforce-does-not-move-decay-origin-backwards.md)
  の追記）。
- 行6には、`Runtime.markContested` の直接の呼び出しのほかに、`observe()` の claim key の検出（`claimKey: { enabled:
  true, detectContested: true }`、既定 off。§5 の 2026-09 追記・[ADR 0324](./decisions/0324-claim-key-contested-detection.md)）
  からも入る。相手がちょうど1件、かつその1件が `active` なら `markContested` と同じイベント（`meta.note` に根拠の
  JSON）。相手が2件以上、または相手がちょうど1件でも既に `contested`（Issue #933 案2・ADR 0378 の
  `findContestedByClaimKey?` 由来。2026-09-30 の直し、ADR 0378 追記）なら、
  新しい行に `updated`（`meta.reason: 'claim_key_conflict_unresolved'`）を1件だけ積み、**状態は変えない**（表の
  どの行の遷移でもない）。
- 行12・行13の `opts.reason` は `meta.note` に入る（`meta.reason` は固定値 `'consolidated'`・`'reflected'`）。行6・行7と
  同じ形で、行9・行14（`meta.reason` に入り、省略すると `reason` キー自体が無い）とも、行15（`meta.reason` に入り、
  省略すると `'unsuperseded'`）とも違う。
- 行13（`tick()` の `'reflect'` ジョブ）は、同じジョブの再配達でも内省の Memory が2件になる——`reflect()` が書いた後、
  `complete` の前にワーカーが止まると、リースが切れた後の `tick()` がもう一度処理する（`created` と `embed` ジョブも
  2つずつ。`Runtime.reflect` の TSDoc の同日付追記。`'consolidate'` のジョブは status で弾くので1回分と同じ状態になる）。


### ⚠ `superseded` / `contested` の行は溜まる —— 容量の見積もり（2026-09-24 追記、[Issue #567](https://github.com/takecchi/mnemora/issues/567)）

**`superseded` と `contested` の行は、製品の口では一度も減らない。**上の表の遷移のうち、これらの行を片付けるものは無い。

- **掃引（行8）は `active` だけを対象にする。**`MemoryStore.archiveDecayed` の SQL は `AND status = 'active'` で絞っている。
- **`purge`（行10）は行を消さない。**本文をトゥームストーンで上書きするだけである。`forget` → `purge` をすべて通しても、行数は1行も減らない。
- **`memories` から `DELETE` する SQL は、公開 API にもマイグレーションにも無い。**
- **`superseded` の行を一覧する公開 API も無い**（`recall()` に出てこないため）。

**溜まる速さと、効いてくる場所**（⚠ **どちらも 2026-09-17 に別の担い手が取った観測の【受】であり、再測定していない**。当時の `main` は今と違う。出所は [Issue #465](https://github.com/takecchi/mnemora/issues/465) のコメントで、[Issue #567](https://github.com/takecchi/mnemora/issues/567) に移してある）:

| 観測 | 値 | 限定 |
|---|---|---|
| `consolidate` を3ラウンド回したあとの行数 | `active` 74 → 15、`superseded` 0 → 75（`active` の**約5倍**） | haystack 60〜74件の小標本 |
| `aggregateScope`（`recall()` の段5。毎回走る）の計画。`active` 1,000件で固定し、`superseded` の件数だけを変えた | 0件: Index Only Scan・2.007 ms／5,000件: Index Only Scan・1.960 ms／**50,000件: Seq Scan・13.881 ms** | 3点だけ。**計画が倒れる閾値は測っていない**。逐語の SQL ではなく、形を写したクエリ |

⟹ **容量の見積もりの目安**: `consolidate` や `reextract` を定期的に回す運用では、`superseded` の行が `active` の数倍に積み上がると見ておくこと。

**どこに効き、どこに効かないか**:

- **段1（候補の生成）には効かない。**`idx_memories_recall_gate`（活動時計側の `idx_memories_recall_gate_seq` も同じ）は `WHERE status IN ('active', 'contested')` の部分索引なので、`superseded` の行は索引の実体に載らない。⟹ **recall の結果は汚れない。**
- **段5（`aggregateScope`）には効く。**この集計は `superseded` / `archived` / `forgotten` の件数も数える（`count(*) FILTER (WHERE status = 'superseded')`）ので、テナントの全状態の行を読む。⟹ 行数が増えるほど重くなり、ある点で計画が Seq Scan へ倒れる。
- ⚠ **`contested` は事情が違う。**部分索引に載るので、段1 の候補に入り続ける。解消の口は `resolveContested`（行7）だけで、対の id を呼び出し側が知っている必要がある。

⛔ **消す手順（生 SQL）は、ここに書かない。**`memories` の行を SQL で直接消すと、次の2つを迂回する。
- `memory_events` に跡が残らない（§9 の監査ログの担保を外れる）。
- `restoreSuperseded`（行15）で戻せる窓が、黙って閉じる。

⟹ 回収の経路を入れるか、入れるならどの形にするかは、[Issue #567](https://github.com/takecchi/mnemora/issues/567) が持っている（復旧口と一緒に設計する必要がある）。⚠ **この追記はクローン（miku）の判断で、オーナー本人の決定ではない**（[ADR 0220](./decisions/0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。この節の前提（掃引の絞り、部分索引、段5 の数え方、`DELETE` が無いこと）は、`scripts/__tests__/memory-model-superseded-accumulation-premises.test.mjs` が現物に当てて縛っている。

**⟹ 上の問い（回収の経路を入れるか）は [ADR 0303](./decisions/0303-superseded-contested-decay-floor-owner.md) が決着させた——`superseded`/`contested` それぞれの `decay_floor_at` の持ち主を現物で洗い出したうえで、v1.x では入れないと判断している（Issue #567 は開いたまま）。**

---

## 確かめていないこと（本書内で参照した範囲の一覧）

- npm org `mnemo` の取得可否（本書の範囲外だが横断的に未確認のまま）。
  - **2026-09 追記**: `mnemora` への改名により、この論点は消えた。npm の org `@mnemora` は
    オーナーが作成し、使用できることを確認している（確認したのはオーナーである）。
    [ADR 0014](./decisions/0014-package-name-mnemora.md) を参照。
- マネージド Postgres 各社が実際に提供する pgvector のバージョン。
- 可変次元の埋め込み列を Drizzle でどう型付けるか（空間ごとのテーブル分割で回避）。
- 「訂正の積み上げによる実害 → 置換方針」という因果自体の alteroid での検証（§5）。
  alteroid のコード・ドキュメントに記録は無く、確認できたのは `memory_write` /
  `memory_append` が両方存在し選択が書き手任せであること、supersede 機構が無いことのみ。
- alteroid の reinforcement・decay の実装状況（§6・§7）。いずれも未実装であることは確認したが、
  「実装すれば効く」かどうかは alteroid からは分からない。
