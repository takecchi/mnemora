# ADR 0300: 既定スコアの時間二重減衰を分ける — `occurredAt` が無い記憶には `freshness` を掛けない明示的 opt-in を `RecallQuery` に足す（Issue #690）

- **状態**: 提案 (2026-09)
- **日付**: 2026-09-25

**出自**: オーナーの依頼を受けたマネージャーのセッションから切り出され、それを受けたエージェントの
セッションが Issue #690 に対して書いた。**この ADR はオーナー本人の決定ではない**——
[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) と同じ理由で、
署名からは区別が付かない。**既定を変えるかどうかはオーナー判断として開いたまま残す**（§7）。

**⚠ 各主張の出所を分ける。**

- **【実測】** — この書き手が自分の手で `vitest`/`tsc`/`eslint`/`prettier` 等を走らせて確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — Issue 本文・過去の ADR からの引用で、この書き手が再導出していない。

---

## 0. 依頼の要旨

[Issue #690](https://github.com/takecchi/mnemora/issues/690)（逐語の要旨）:

> `packages/core/src/strategies/scoring.ts` の `scoreWithDefaultStrategy` は
> `decay × freshness` を掛け、同じ半減期を使う。起点が同じなら半減期1回で時間係数は 0.25 になる。
> `reinforce` しても `freshness` は回復しない。出来事の新しさと、好みなどの現在も有効な記憶の
> 有用性を混同する懸念がある。式の実装不良ではなく設計評価である。
>
> 範囲と完了条件: 過去の仕様・ADR を確認し、時間減衰と鮮度の責任を分ける案を ADR で比較する。
> 同一内容・同一関連度で、作成時刻・出来事時刻・最終利用・wall/activity 時計だけを変えた
> ケースを先に定義する。恒常的な事実を再利用した場合と、期限切れの予定を区別する。
> validity gate を弱めない。既定変更または明示的な方針選択の API を実装し、旧挙動との
> 順位・回答品質・量の比較を残す。狙った変異で赤、復元で緑を確認。基準値を都合よく変更しない。
> 未評価なら Draft PR。関連: #338。北極星の忘却方針そのものは変更しない。

マネージャーからの追加方針（本セッションへの指示、逐語の要旨）:

> 既定の挙動は1ビットも変えない。時間の重み付けの方針を明示的に選ぶ任意の API を足し、
> 省略時は旧挙動にする。既定を新方針へ倒すかどうかは、ADR と PR 本文で
> 「オーナー判断（v2.0.0 側の候補）」と名指しするにとどめる。

## 1. 文脈 — 何が「二重に」減衰しているか

【現物】`packages/core/src/strategies/scoring.ts` の `scoreWithDefaultStrategy`:

```ts
total = affinity × decay × tagMatch × freshness × strength
```

- `decay` は `lastReinforcedAt ?? recordedAt` を起点にした「**使われてからどれだけ経ったか**」
  （[ADR 0004](./0004-decay-at-query-time.md)、`defaultDecayStrategy.strengthAt`）。
  `reinforce` を呼ぶたびに起点が前へ進む（ただし後退はしない。
  [ADR 0048](./0048-reinforce-does-not-move-decay-origin-backwards.md)）。
- `freshness` は `occurredAt ?? recordedAt` を起点にした**同じ**減衰式で、1 で頭打ち
  （[ADR 0036](./0036-clamp-freshness-at-one.md)）。**`reinforce` はこの起点を一切動かさない**
  ——`freshness` の doc コメントは `lastReinforcedAt: null` を明示的に渡している。

**`occurredAt` が無い Memory**（`docs/memory-model.md` §3 の定義上、「恒常的な事実・好み」は
特定の出来事時刻を持たないため `occurredAt` を持たないことが多い）では、
`freshness` の起点が `recordedAt`（記録した時刻）に**フォールバックする**。
⟹ **「古く記録して、最近まで使われ続けている恒常的な事実」は、`decay` は高く保たれるのに
`freshness` が `recordedAt` の古さだけで沈み続け、`total` を引きずり下ろす。**

**同じ半減期を使うため**（[ADR 0010](./0010-decay-parameters.md) が固定した式・
`RecallQuery`/`ScoringInput` の `halfLifeHours` は1つしかない）、**半減期1回分の時間が経つと
`freshness` だけで係数が 0.25 まで落ちる**（`decay` も同時に 0.25 落ちるなら、`reinforce` 無しの
場合は正しい——だが `reinforce` されていれば `decay` は 1 に近いのに `freshness` はそのまま
落ち続ける、という非対称が Issue の指摘そのものである）。

**これは実装不良ではなく設計評価である**（Issue 本文の逐語どおり）。`docs/recall.md` §7 も
`ScoreBreakdown.freshness` の doc コメントも、「`occurredAt` が無いときは `freshness` を
どう扱うべきか」を一度も規定していない——[ADR 0036](./0036-clamp-freshness-at-one.md) が
塞いだのは「起点が未来になったときの上限」だけであり、「起点がそもそも存在しない（＝
出来事ではない）ときにどう振る舞うか」は今回初めて問われている。

### 関連 ADR の要旨（【受】、本 ADR は再導出していない）

- **ADR 0004**: 忘却をクエリ時に算出する構造そのもの。`decay`/`freshness` は共にこの構造の上に載る。
- **ADR 0010**: 減衰式とパラメータの固定。`floorAt` は `strengthAt` の解析解——**式そのものは
  動かさない**という制約は本 ADR にも及ぶ（§4 参照）。
- **ADR 0036**: `freshness` を 1 で頭打ちにした。「まだ起きていない出来事は最も古びていない」。
  **本 ADR はこの決定を覆さない**——`occurredAt` が在るときの `freshness` の式・上限は
  1バイトも変えない。
- **ADR 0048**: `reinforce` は `decay` の起点（`last_reinforced_at`）を前へしか進めない。
  `freshness` の起点はそもそも `reinforce` の対象にならない、という非対称の一方の当事者。
- **ADR 0153**: 忘却ゲート（`decay_floor_at`）を既定 on にした。**本 ADR はこのゲートに
  触れない**——`decay_floor_at` の計算式（`floorAt`）は `strength`/`halfLifeHours`/起点から
  決まり、`freshness` とは別の経路である。
- **ADR 0165**: 減衰の時計を2本（壁時計・活動時計）にした。**本 ADR はどちらの時計でも
  同じ形で効く**——`freshness` の起点は `occurredAt ?? recordedAt` であり時計の選択とは
  独立な軸である（§6 のケース E で実測）。
- **ADR 0172**: 連想枠（段3.5）にも忘却ゲートと `validAt` ゲートを通した。**本 ADR は
  この2ゲートを一切変えない**——validity ゲートは `validFrom`/`validUntil` の別軸であり、
  時間重み付けの方針（スコアの相対順位）とは独立である（§6 ケース D、§8「⛔ 弱めていないこと」）。
- **ADR 0246**: 連想枠の席を `decay × tagMatch × freshness × strength` を含む順位で埋めた。
  **本 ADR の新方針は、この順位式にもそのまま伝播する**（§5 決定4）——`defaultScoringStrategy`
  を経由する3箇所すべてが同じ `ScoringInput.timeWeighting` を受け取るため。
- **ADR 0290**: Issue #338（活動時計の上限）の段0。**本 ADR とは別の軸**——あちらは
  「テナントの `recall()` 頻度が高いと活動時計が翌日を待たずに沈む」という**忘却ゲート**の話で、
  本 ADR が触るのは段2の**順位付け**（`freshness`）である。**Issue #338 自体には触れない。**

## 2. ケース表（先に定義する。実装前に赤くする歯として使う）

**「同一内容・同一関連度」を保つため、全ケースで `tags=[]`・`queryTags=[]`・`strength=1`・
`similarity`/`lexicalMatch` は渡さない（`affinity` は中立の 1 に退化する）。**
差はケースごとに列挙する変数（`recordedAt`・`occurredAt`・`lastReinforcedAt`・時計・
`decayClock`/`nowSeq`/`decayBaseSeq`/`halfLifeRecalls`）だけに閉じる。
`now = 2026-06-01T00:00:00.000Z`・`halfLifeHours = 720`（30日、`docs`既定）。

| #   | ケース                                                                             | `recordedAt` | `occurredAt` | `lastReinforcedAt`             | 時計     | 旧方針(`legacy`)の期待                                                    | 新方針(`eventAwareFreshness`)の期待                                                |
| --- | ---------------------------------------------------------------------------------- | ------------ | ------------ | ------------------------------ | -------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A   | 恒常的な好み。古く記録し、最近使った（reinforce）                                  | now−400d     | `null`       | now−1h                         | wall     | `decay≈0.999`・`freshness≈9.7e-5`（recordedAt起点で沈む）・`total≈9.7e-5` | `freshness=1`・`total≈0.999`（`decay`のみで決まる）                                |
| B   | 過去の出来事。400日前に起きた、reinforce 無し                                      | now−400d     | now−400d     | `null`                         | wall     | `decay≈9.7e-5`・`freshness≈9.7e-5`・`total≈9.4e-9`                        | **legacy と同一**（`occurredAt` が在るので式は変わらない）                         |
| C   | 最近の出来事。1時間前                                                              | now−1h       | now−1h       | `null`                         | wall     | `decay≈0.999`・`freshness≈0.999`・`total≈0.998`                           | **legacy と同一**                                                                  |
| D   | 期限切れの予定。`validUntil` が過去（`occurredAt` は予定時刻）                     | now−45d      | now−45d      | `null`                         | wall     | **`recall()` から除外**（`validAt`ゲート、ADR 0164）                      | **同じく除外**（本 ADR はゲートに触れない）                                        |
| E   | 恒常的な好み・活動時計テナント（`nowSeq=100, decayBaseSeq=0, halfLifeRecalls=50`） | now−400d     | `null`       | `null`（`decayBaseSeq`が起点） | activity | `decay=0.25`（活動軸）・`freshness≈9.7e-5`・`total≈2.4e-5`                | `freshness=1`・`total=0.25`（`decay`は**不変**——活動時計の値は方針に影響されない） |

**A〜C・E は `packages/core/src/__tests__/scoring-time-weighting-policy.test.ts` の
純関数テストとして実装する（`defaultScoringStrategy` を直接呼ぶ）。D は
`packages/core/src/__tests__/recall-time-weighting-policy.test.ts` の `runtime.recall()`
テストとして実装する（validity ゲートは段1・後置フィルタの話であり、`defaultScoringStrategy`
単体では検査できないため）。**

**⭐ B・C が「legacy と新方針で完全に同一」であることは、新方針が事件（`occurredAt` が在る
記憶）の順位付けを一切変えないことの陽性対照である。** 差が出るのは A・E（`occurredAt` が
無い記憶）だけであるべきで、B・C で差が出れば新方針の実装が事件側にも漏れて広がっている
（§8 変異(a)相当の逆——今回は「広がりすぎ」の対照）。

## 3. 北極星の問いに当てる

| 問い                                                | 当てた結果                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1（毎回渡す量を減らす方向か）                       | 直接は動かさない。ただし恒常的な事実が誤って早期に沈んで再取得されない、という取りこぼしを直す方向であり、「使うべき記憶を隠す」側の誤りを減らす。                          |
| 2（無効にしても Memory Framework として成立するか） | **既定 off**（`timeWeighting` 省略 = `legacy`）。この機能を一切使わない呼び出しは1バイトも変わらない。                                                                      |
| 3（理由を後から説明できるか）                       | `ScoreBreakdown.freshness` は今までどおり内訳に出る。`occurredAt` の有無と選んだ方針から、なぜ `freshness=1` になったかを機械的に再構成できる（新しい隠れた項を足さない）。 |
| 4（AI の推論とユーザーの事実を区別しているか）      | 触れない。`provenanceKind` とは独立の軸。                                                                                                                                   |
| 5（LLM を呼ばずに済ませられるか）                   | 述語は `occurredAt == null` という、既に読める列の比較のみ。LLM は要らない。                                                                                                |

## 4. 検討した案

### 4.1 API の形（どこに knob を置くか）

| 案                                                                | 内容                                                                                                                                                                                        | 採否         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **(A) `RecallQuery` の任意欄**（採用）                            | `RecallQuery.timeWeighting?: TimeWeightingPolicy` を足し、`recall()` 呼び出しごとに明示的に選ぶ。`includeFullyDecayed`/`validAt`/`includeOutsideValidity` と同じ「1呼び出し = 1決定」の形。 | **採用**     |
| (B) `TenantSettingsStore` の設定（`decayClock` と同型）           | `getTimeWeightingPolicy`/`setTimeWeightingPolicy` をテナント単位で持つ。                                                                                                                    | 却下（下記） |
| (C) `Memory` 側に明示フラグを足す（`kind: 'fact' \| 'event'` 等） | 書き込み時に「この記憶は恒常的か出来事か」を明示させる。                                                                                                                                    | 却下（下記） |

**(A) を採る理由**:

- **公開 API の破壊的変更にならない。** 任意欄を1つ足すだけで、`RecallQuery` を渡さない・
  この欄を渡さない既存の呼び出しは1バイトも変わらない（[ADR 0178](./0178-public-api-surface-gate.md)
  のスナップショット比較で確認する。§6）。
- **既存の同型の前例に倣う。** `includeFullyDecayed`（ADR 0153）・`validAt`/`includeOutsideValidity`
  （ADR 0164）はどれも「既定は現状維持・明示的に呼び出し側が選ぶ」という同じ形であり、
  読み手にとって新しい語彙を増やさない。
- **可逆性が高い。** 呼び出しごとに選べるので、一部のクエリだけ新方針を試す・A/B する、
  ということが呼び出し側のコードだけで完結する。テナント設定に置くと「一部のクエリだけ」が
  やりにくくなる。

**(B) を却下する理由**: `decayClock`（ADR 0165）は「そのテナントの記憶がどの時計で沈むか」という
**書き込み時に固定される**性質（`decay_base_seq` を書き込み時に1回計算する）を持つのに対し、
`timeWeighting` は**読み取り時（recall のたび）に選べる**べき性質のものである——
同じ記憶を「今日は恒常的な事実として引く」「別のクエリでは出来事として引く」という使い分けを
妨げない。テナント単位の固定は、この柔軟性を落とす。また、実装コストも重い
（`TenantSettingsStore` interface・`packages/postgres` 実装・`packages/testkit` 適合テスト
一式が要る——ADR 0165 決めたこと13 と同じ量の footprint）。**「オーナー判断待ちの提案」という
本 ADR の位置づけに対して、これは覆すコストが高すぎる。**

**(C) を却下する理由**: `occurredAt` の有無が、`docs/memory-model.md` §3 の定義上**既に**
「この記憶が特定の出来事時刻を持つか」を表している。新しいフラグを足すと、既存の
`occurredAt` という情報源と**同じ区別を二重に持つ**ことになり、両者が食い違う状態
（`kind: 'event'` なのに `occurredAt: null`）を新設の型で許してしまう。**既存の欄が既に
答えを持っている問いに、新しい欄で答え直させない。**

### 4.2 新方針の中身（`freshness` を何と入れ替えるか）

| 案                                                                                                    | 内容                                                                                                                    | 採否     |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| **(1) `occurredAt` が無いときは `freshness = 1`**（採用、`eventAwareFreshness`）                      | `occurredAt == null` のとき `freshness` の計算そのものをスキップし `MAX_FRESHNESS`（1）を返す。在るときは今までどおり。 | **採用** |
| (2) `freshness` の半減期を `decay` と分ける（`freshnessHalfLifeHours`）                               | 新しい任意パラメータを足し、`freshness` だけ長い半減期で緩やかに沈める。                                                | 却下     |
| (3) `reinforce` 時に `freshness` の起点も前進させる（`lastReinforcedAt ?? occurredAt ?? recordedAt`） | `freshness` の起点定義を変え、使われるたびに若返らせる。                                                                | 却下     |
| (4) `freshness` に床（floor）を設ける（例: 0.05 未満にしない）                                        | 減衰しきった `freshness` を小さい定数で下支えする。                                                                     | 却下     |

**(1) を採る理由**:

- **問題の根を直接絶つ。** 二重減衰が起きるのは「出来事ではないのに、出来事の式で沈める」
  ことそのものである。`occurredAt` の不在は「古びる出来事時刻を持たない」ことを意味する
  （`docs/memory-model.md` §3）ので、`freshness`（**古び**を測る項、`MAX_FRESHNESS` の doc）は
  測る対象そのものが無い——であれば中立の 1 を返すのが最も素直である。
- **新しい自由係数を増やさない。** [ADR 0166](./0166-recall-footprint-association-term.md) が
  「新しい自由係数は増やさず、構造から導く」と繰り返し置いている規律にそのまま従う。
- **`occurredAt` が在るときの式・上限（ADR 0036）を1文字も変えない。** 影響範囲を
  「`occurredAt` が無い記憶」だけに絞り込める——ケース表の B・C が legacy と完全一致する
  ことがそれを裏づける（§2 の陽性対照）。

**(2) を却下する理由**: 新しい任意パラメータ（`freshnessHalfLifeHours`）を足すと、
`ScoringInput`/`RecallQuery` の面が広がり、「`decay` と `freshness` のどちらの半減期を
指しているか」を呼び出し側が毎回判断する負担が増える。また、半減期を伸ばすだけでは
「出来事ではない」ことを表現できておらず、**十分に長い時間が経てば同じ問題が再発する**
——根を絶っていない。[ADR 0166](./0166-recall-footprint-association-term.md) の規律にも反する。

**(3) を却下する理由**: これは `freshness` の定義を `decay` に近づける方向であり、
**むしろ二重"非"減衰**（今度は出来事についても `reinforce` で若返ってしまう）を生む。
「来月の出張」を今日 `reinforce`（＝この記憶を使った）しても、出張の日付そのものは
動いていない——`freshness` が「いつの出来事か」ではなく「いつ触られたか」を測るように
なると、`ScoreBreakdown.freshness` の doc コメント・`docs/recall.md` §7 の契約
（「鮮度は `occurredAt ?? recorded_at` を使う」）を破る。**`decay`（使用の新しさ）と
`freshness`（内容の新しさ）を分けるという Issue の要求そのものに反する**——
起点を共有させたら分離になっていない。

**(4) を却下する理由**: 症状を緩和するだけで、恒常的な事実と出来事を区別していない。
「古い出来事」も同じ床で下支えされてしまい、`freshness` の意味（古びを測る）が
薄まる。マジックナンバー（床の値）の根拠も無い。

## 5. 決定

1. **`packages/core/src/strategies/scoring.ts` に `TimeWeightingPolicy` 型を足す。**

   ```ts
   export type TimeWeightingPolicy = "legacy" | "eventAwareFreshness";
   export const DEFAULT_TIME_WEIGHTING_POLICY: TimeWeightingPolicy = "legacy";
   ```

   `ScoringInput.timeWeighting?: TimeWeightingPolicy` を足す。**省略時は `"legacy"`**
   ——`scoreWithDefaultStrategy` は今までの式をそのまま計算する。

2. **`"eventAwareFreshness"` のとき、`occurredAt == null` なら `freshness = MAX_FRESHNESS`
   （1）を返す。`occurredAt` が在るときは `"legacy"` と完全に同じ式を使う。**
   `decay`/`tagMatch`/`strength`/`affinity` の計算は方針に関係なく1文字も変えない。

3. **`RecallQuery.timeWeighting?: TimeWeightingPolicy` を足し、`recall-runtime.ts` の
   3箇所すべての `defaultScoringStrategy(...)` 呼び出し**（段2の本スコア・段3の
   `mandatory_companion`・段3.5 連想枠の順位キー）**に同じ値を渡す。**
   省略時は `undefined` のまま渡り、`scoring.ts` 側で `"legacy"` に解決される
   （2箇所で既定値を定義しない——[ADR 0082](./0082-tick-names-unsupported-job-kinds.md)
   と同じ「唯一の出所」の規律）。

4. **連想枠（ADR 0246）の順位キーにも同じ方針が伝わる。**
   `rankKey = hit.similarity × score.total` の `score` が `defaultScoringStrategy` を
   経由するため、新しい分岐を連想枠側に足す必要が無い——**3箇所が同じ関数を呼ぶ構造
   （ADR 0246 決定1「新しい順位の定義を作らない」）が、そのまま本 ADR の伝播もタダで
   引き受ける。**

5. **忘却ゲート（`decay_floor_at`/`decay_floor_seq`、ADR 0153/0165）・`validAt` ゲート
   （ADR 0164/0172）は一切変えない。** `timeWeighting` は段2（再スコア）だけの入力であり、
   段1（候補生成の押し下げ）・後置フィルタの述語には登場しない。**期限切れの予定
   （ケース D）は、方針に関係なく引き続き除外される**（§8 変異(c)で実測する）。

6. **既定を変えない。** `RecallQuery.timeWeighting` を渡さない呼び出しは
   `ScoringInput.timeWeighting` も `undefined` のまま渡り、`"legacy"` に解決される。
   ⟹ **既定の挙動は1ビットも変わらない**（§6 で `public-api` スナップショットと
   スコアの回帰実測により確認する）。

7. **公開 API の面を広げるが、破壊的変更ではない。** `RecallQuery`/`ScoringInput` に
   任意欄を1つずつ足すだけであり、`RecallQuerySchema`（zod）も `.optional()` で追随する。

## 6. 比較（旧方針 vs 新方針）

### 6.1 スコア・順位（ケース表、§2 の実測値）

| ケース                      | legacy `total`            | `eventAwareFreshness` `total` | 順位への影響                                                                                |
| --------------------------- | ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| A（恒常的な好み、最近使用） | **9.68e-5**（沈んでいる） | **0.999**（沈んでいない）     | 新方針で最上位付近まで浮上する                                                              |
| B（過去の出来事）           | 9.39e-9                   | **9.39e-9（同一）**           | 変化なし                                                                                    |
| C（最近の出来事）           | 0.998                     | **0.998（同一）**             | 変化なし                                                                                    |
| E（恒常的な好み、活動時計） | 2.42e-5                   | **0.25**                      | 新方針で浮上する（活動軸の `decay` はどちらの方針でも `0.25` のまま——不変であることも実測） |

**⟹ 新方針が動かすのはケース A・E（`occurredAt` が無い記憶）だけであり、B・C（実際の出来事）は
`total` が完全一致する。**これは §2 の陽性対照がそのまま実測結果になったものである。

### 6.2 `recall()` が返す件数（量）

`packages/core/src/__tests__/recall-time-weighting-policy.test.ts` で、
`scoreThreshold`（既定 `DEFAULT_SCORE_THRESHOLD = 0.1`）を挟むケース（ケース A 相当の
恒常的な好みを複数件・出来事を複数件、同じクエリで recall）を実測した:

| 方針                | `result.memories.length`（`limit=10`）                                           | `below_threshold` に落ちた件数 |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------ |
| legacy              | ケース A 相当の記憶は `total≈9.7e-5 < 0.1` のため **`below_threshold` へ落ちる** | 恒常的な好みの分だけ増える     |
| eventAwareFreshness | 同じ記憶が `total≈0.999 > 0.1` のため **`memories` に残る**                      | 恒常的な好みの分だけ減る       |

**⟹ 新方針は、忘却ゲート・件数上限（`limit`）そのものを動かさない。** 動くのは
「どちらの側（`memories` か `below_threshold` か）に落ちるか」という**閾値との位置関係**
だけであり、`recall()` が「何件見つかったか」という母数（`totalInScope` 等の
`ScopeAggregate`）は1件も変わらない（実測: 同じ歯の中で `omitted` の `filtered`/`decayed`/
`expired` の件数がどちらの方針でも同一であることを確認する）。

### 6.3 走らせなかったもの（実 embedding を要する既存ベンチ）

- **`examples/chat` の `retrieval-quality`/`compare`/`association-probes` ベンチは
  走らせていない。** これらは実 Postgres + pgvector・埋め込み（`local`/`recorded`）を要し
  （`AGENTS.md`「4層」表）、本 PR の変更が触るのは `packages/core` の純関数
  （スコアリング戦略）とその呼び出し配線だけであり、ANN/lexical チャンネルには一切触れて
  いない。⟹ **触れていない層のベンチを走らせても、本変更の効果は測れない**
  （変える対象が候補生成ではなく段2の再スコアであるため、`retrieval-quality` の
  `hit@1`/`MRR` は理論上動かないはずだが、**実測していない**——机上の推測にとどめる）。
- **🔴 LLM を経由した回答品質は、当初この節で「未評価」としていたが、その後マネージャーの
  追加指示により実 API で評価した（§6.4）。この段落は事実に合わせて訂正する**——
  [ADR 0233](./0233-answer-quality-measured-once-against-the-real-api.md) の
  `answer-bench` そのものは走らせていない（`answer-time-weighting` という専用のベンチを
  新設して測った、§6.4 参照）。

### 6.4 回答品質の実測（マネージャー追加指示、Issue #690 段2b/3a/3b）

**新設した `answer-time-weighting` ベンチ**（`examples/chat/src/time-weighting-bench.ts`）で、
記憶を抽出 LLM を通さず直接（明示の `recordedAt`/`occurredAt`/`validFrom`/`validUntil` で）
書き、`reinforce` し、壁時計を進めてから、同じ質問を `legacy`/`eventAwareFreshness` の両方で
`recall()` → 回答生成（`gpt-4o-mini`）→ `gradeAnswer`（文字列一致の一次判定）で比べた。
ケースは3類型（A: 恒常的な事実 vs 弱い競合記憶、B: 出来事は両方 `occurredAt` を持つ
regression guard、C: 期限切れの予定の regression guard）と、段2b で追加した2類型
（B'/C': 古い記憶が `occurredAt`/validity 列のいずれも持たない危険な場面）、
計16ケース（dev 6・eval 6・eval-undated 4）。詳細な生データは
`examples/chat/bench-results/` に commit してある（`STAGE3A-NOTES.txt`・
`STAGE3B-1-NOTES.txt`・各 `*.json`/`*.log`）。

#### 取り引き（トレードオフ）

- **類型A（`reinforced-fact-vs-fresh-weak`）**: `legacy` 0/5 → `eventAwareFreshness` 5/5
  （dev・eval の4ケースすべてで一貫、temperature 未指定・0 の両方）。恒常的な事実
  （`occurredAt` 無し、古く記録され直近 `reinforce`）が `legacy` では埋もれ、
  `eventAwareFreshness` で正しく想起される——本 ADR が狙った改善そのものである。
- **`eval-undated-c1-seat-floor-reinforced`（類型C'）**: 古い予定が `occurredAt`/
  `validFrom`/`validUntil` のいずれも持たず、直近に `reinforce` されている場面。
  段3a の切り分け（temperature=0・20回）では `eventAwareFreshness` の `gradeAnswer`
  正答数が **0/20**（`legacy` は 20/20）。段3b-1 の本評価の取り直し
  （temperature=0・同じケース定義・trials=5）では **5/5**（全問正解）——一見すると
  真逆の結果だが、**原因はプロンプトの中身の違いであって、LLM/temperature の非決定性
  ではない**（段3c で実 API を叩かずに特定した）。
  - `recall()` のスコアリングそのものは完全に一致している——`eventAwareFreshness` では
    古い予定が常に `rank=1`・文脈入り（`score.total=0.8031002918516041`、両実行で
    ビット単位まで同一）、`legacy` では常に `rank=2`・`below_threshold` で除外される。
    **ここは今も trade-off の根拠として成り立つ。**
  - **しかし段3a と段3b-1 の間に、この PR 自身が `origin/main` を取り込んでおり
    （Issue #691 / PR #698「回答プロンプトで記憶の由来・話者・主題・矛盾関係を保持する」）、
    `mnemora-path.ts` の `buildMnemoraPrompt` が変わっていた。** 段3a は取り込み前の
    素の書式（`- content` の箇条書きのみ、`inputChars=81`）、段3b-1/3b-2 は取り込み後の
    書式（`- [由来:...] [主題:...] [記録順:N] [出来事時刻:...] content`、
    `inputChars=185`）で走っている——**同じケースなのに、LLM に渡ったプロンプトの
    文字数からして違う。**
  - 記録済みカセット（`answer-time-weighting.json`）を実 API 無しで再生し、両方の
    実際のプロンプト・回答を突き合わせて確認した:
    - 旧書式（段3a 相当）: `- オフィスの座席は3階です。` / `- 先週、座席が5階に移動した。`
      だけを見せると、モデルは **「分かりません。」と回答**——`accept`（`5階`）も
      `reject`（`3階`）も含まないため `gradeAnswer` は `fail` になる（LLM が「答えない」
      ことを選んだのであって、古い方の答えを選んだわけではなかった）。
    - 新書式（段3b-1/3b-2 相当）: 各行に `[出来事時刻:不明]`（古い予定側）/
      `[出来事時刻:2026-07-26T09:00:00.000Z]`（現行の予定側）と `[記録順:1]`/`[記録順:2]`
      が付く。この同じケースを再生すると、モデルは **「5階です。」と正しく回答**——
      `pass`。
    - ⟹ **`[出来事時刻:不明]` という新しいタグが、`occurredAt` の有無という
      `eventAwareFreshness` の判断材料そのものを、回答生成モデルにも見える形で
      漏らしている。** モデルはこの手がかりを使って「時刻不明の記述より、日付の
      分かる直近の記述の方が信頼できる」と判断できたと考えられる（推測——モデルの
      内部推論を直接検査したわけではない）。
  - ⟹ **確定して言えるのは「検索順位が古い予定を持ち上げる」という検索側の事実
    （100%再現）だけである。** それが最終的な誤答に繋がるかどうかは、
    このケースでは**プロンプトの書式**（`occurredAt` の有無を回答生成モデルにも
    見せるかどうか）に依存することが分かった——LLM/temperature の非決定性という
    当初の説明は、プロンプトの同一性を確かめずに立てた仮説であり、誤りだった。
    この節を段3c で訂正する。
- **他のケース**（類型B/C の残り4ケース、類型B'/C' の残り3ケース）は、`legacy`/
  `eventAwareFreshness` のどちらでも一貫して同じ結果になった（差なし）——設計どおり
  regression guard として機能している。

#### 既定判断への含意

**既定を新方針へ倒すかどうかは、引き続き §7 のとおり v2.0.0 側のオーナー判断に委ねる。**
本節の実測が示したのは「動くこと」に加えて「どちらの向きにも取り引きがあること」
（恒常的な事実の埋没を直す代わりに、未構造化の古い情報を持ち上げるリスクを引き受ける）
までであり、**「どちらの取り引きを製品として選ぶか」はここでは判断しない。**

呼び出し回数・費用の累計、実行した trial・temperature の設定は PR 本文を参照
（`main` が動いても腐らないよう、この ADR 本文には焼き込まない——ADR 0223 決定9）。

## 7. これがオーナー判断であるとする点 — 既定を新方針へ倒すかどうか

**本 ADR は既定を変えない。** 「`occurredAt` が無い恒常的な記憶に `freshness` を掛けない」
ことを既定にするかどうかは、次の理由で**オーナー判断**として残す:

- **製品の性格を決める判断である**（`docs/autonomy.md` §3.1 の見分け方——「どちらを選んでも
  技術的には成立するが、選び方が製品の性格を決める」。ADR 0165「これが覆るとしたら」1 が
  同じ理由で活動時計の意味論をオーナー判断に残したのと同型）。
- **`v1.0.0` は出荷済みである**（tag `c27ca95`）。既定を変えると `RecallQuery.timeWeighting`
  を渡していない既存の呼び出しの `recall()` 結果が変わりうる——これは
  [docs/migration-v1.md](../migration-v1.md) の「🟡 後方互換だが挙動が変わりうるもの」に
  相当する。**`v2.0.0` 側で検討する変更の候補として名指しする**（マネージャー指示のとおり）。
- **本 ADR が実測したのは「動くこと」であって「良くなること」ではない。** ケース A・E で
  `total` が浮上することは示したが、**それが北極星の物差し（会話ログを全部積むのを
  やめられたか）を実際に前進させるかは、実 embedding・実運用のクエリ分布に依存する**
  ——机上のケース表だけでは決められない。

## 8. 変異試験（狙って赤、復元して緑）

**手順**: `Edit` ツールで `packages/core/src/strategies/scoring.ts` を一時的に書き換え→
対象の歯が赤くなることを確認→同じ `Edit` で元に戻し、同じ歯が緑に戻ることを確認する
（`git checkout` は使わない）。実測結果は本 PR の説明・報告に残す。

| #   | 変異                                                                                                                                     | 狙って赤くする歯                                           | 見立て                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| (a) | `"eventAwareFreshness"` でも `freshness` を legacy と同じ式で計算する（**不足**——分岐を殺す）                                            | ケース A・E の「新方針で `freshness=1`」assert             | `occurredAt` が無い記憶が新方針でも浮上しない    |
| (b) | `"eventAwareFreshness"` のとき `decay` も `1` に強制する（**やりすぎ**——分離の境界を越える）                                             | 「`decay` は方針に依存しない」assert（ケース E、活動時計） | 使用実績（reinforce/活動時計）まで無視してしまう |
| (c) | `recall-runtime.ts` の `survivesValidityGate` 呼び出しを `timeWeighting !== "legacy"` のとき skip する（**やりすぎ**——ゲートまで緩める） | ケース D（期限切れの予定）の除外 assert                    | 新方針が validity ゲートまで弱める               |
| (d) | `ScoringInput.timeWeighting` の既定解決を `input.timeWeighting ?? "eventAwareFreshness"` にする（**既定を倒す**）                        | 「省略時は legacy と同一」assert                           | 呼び出し側が何も指定しなくても挙動が変わる       |

**実測結果は本 PR 本文・報告に転記する（この節では表の形だけを固定し、実測値そのものは
`main` が動いても腐らないよう、コミットのハッシュ・PR 番号と共に報告側に置く）。**

## 9. 引き受けた負債・確かめていないこと

- **`TenantSettingsStore` 側の恒久設定（案 4.1(B)）は実装していない。** 呼び出しごとに
  `RecallQuery.timeWeighting` を渡す必要があり、全クエリに一律で適用したい呼び出し側は
  自分でラップする必要がある。
- **`occurredAt` の有無を「恒常的か出来事か」の代理指標として使うことの妥当性は、
  この ADR では検証していない。** `docs/memory-model.md` §3 の定義に基づく解釈であり、
  実データでの分布は見ていない。
- **実 embedding・実 LLM での効果は、その後マネージャー追加指示により16件の手作りケースで
  評価した（§6.4）。** ただし **実運用のクエリ分布・記憶分布での効果は未評価のまま**——
  この16件は「危ない場面」を狙って手で設計したものであり、実際のテナントで
  `occurredAt`/validity 列を欠く記憶がどれだけの割合を占めるか、`eventAwareFreshness` を
  有効にしたテナント全体での回答品質がどう動くかは、別途 `retrieval-quality`/`compare` 相当の
  実運用規模のベンチが要る（§6.3 が走らせていないと明記した理由と同じ）。
- **`decayClock: 'either'` の経路は、本 ADR のケース表に含めていない。** ADR 0165/0246 が
  `'either'` を「両方の `Math.max`」として扱っており、`freshness` の方針とは独立な軸なので
  理論上は `'wall'`/`'activity'` の実測から自明に従うはずだが、**個別には測っていない。**

## これが覆るとしたら

- **§7 のオーナー判断が「既定を新方針にする」と決まったとき。** その場合は
  `DEFAULT_TIME_WEIGHTING_POLICY` を変える PR が `docs/migration-v1.md` の
  🟡 節（後方互換だが挙動が変わりうるもの）に新しい項目を足すことになる。
- **`occurredAt` の運用実態が「恒常的な事実でも `occurredAt` を埋める」方向に変わったとき。**
  そのときは本 ADR の代理指標（`occurredAt == null`）が実態と食い違い始める——
  §4.1 案(C)（明示フラグ）を採り直す理由になる。
