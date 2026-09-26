# ADR 0303: `superseded` / `contested` の `decay_floor_at` の持ち主を決める — 回収の経路（案C）は v1.x で入れない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-25

> ⚠ この ADR は takecchi/mnemora への PR として、クローンの委譲で動くセッション
> （mgr-51fc20b3）が書いた。**オーナー本人ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> 判断はこのセッションを起こしたマネージャーの判断である。

## 文脈

[Issue #567](https://github.com/takecchi/mnemora/issues/567) は「`superseded`/`contested` の
行は製品の口では一度も減らない」という観測から出発し、PR #670（squash `12764ea`）が
**B′**（溜まることと容量見積もりを `docs/memory-model.md` §11 に書く。消す手順は書かない）を
着地させた。PR #670 の着地報告（Issue #567 のコメント）は、次の2点を「残っているもの」として
明示的に持ち越していた:

1. **Issue #567 本体の問い**——「`superseded`/`contested` を回収する経路を v1.0.x 以降で
   入れるか」。案C（自動回収。掃引を広げる／`archived` へ逃がす）は、復旧窓との整合も
   対向の行を辿る方法も設計が無い。
2. **[ADR 0114](./0114-archive-sweep-for-decayed-memories.md) の「覆る条件」2つが
   鳴っているのに、拾われていない**——`contested` の解決規則（`resolveContested`、
   [ADR 0150](./0150-resolve-contested-explicit-operation.md)）と `archived` からの復元
   （`restoreArchived`、[ADR 0122](./0122-restore-archived-memory.md)）は、
   いずれも ADR 0114 が「そのとき掃引を広げる判断が要る」と書いていた条件そのものであり、
   両方とも既に実装済みである。

本 ADR はこの2点に決着を付ける。**decay_floor_at という1つの列を、`superseded`/`contested`
それぞれの状態で誰が読み・誰が動かすかを現物で洗い出し、その上で回収の経路を「入れない」
という判断を記録する。**

### 現物で洗い出した「誰が `decay_floor_at` に触るか」

【現物、`origin/main` = `52113a8`】

- **段1の候補生成**: `idx_memories_recall_gate`（壁時計）・`idx_memories_recall_gate_seq`
  （活動時計）はどちらも部分索引で、述語は `WHERE status IN ('active', 'contested')`
  （`packages/postgres/migrations/0001_init.sql`）。**`superseded` はこの索引の実体に
  載らない**——段1は `superseded` の `decay_floor_at` を一度も読まない。
- **段5の集計（`aggregateScope`）**: `decayed_filtered` は
  `count(*) FILTER (WHERE status IN ('active', 'contested') AND ... AND ${isDecayed})`
  （`packages/postgres/src/memory-store.ts`）。**`superseded` はここでも数えられない**
  ——`isDecayed` の分母に入らない。
- **掃引（`archiveDecayed`）**: 対象選択 SQL は `status = 'active'` のみ
  （ADR 0114 決定2）。`superseded`/`contested` の `decay_floor_at` を読んで書き込みへ
  倒す経路はここにも無い。
- **`supersedeWithNewMemories`**（`active → superseded` を作る本体、行5）: 旧行を更新する
  `UPDATE memories SET status = 'superseded', superseded_by_id = ..., updated_at = now()`
  に `decay_floor_at` は無い。**⟹ `superseded` になる瞬間、`decay_floor_at` は直前の値の
  まま凍結される。**`updateStatusWithEvent`（`forget`/汎用 CAS の実体）の `UPDATE` も同様に
  `decay_floor_at` を持たない。
- **戻る経路 `restoreSuperseded`**（行15、[ADR 0230](./0230-restore-superseded-recovery-path.md)）:
  `status='active'` へ戻したあと、**続けて `reinforce` を呼ぶ**——`decay_floor_at` を
  復帰の瞬間から引き直す（`packages/core/src/runtime.ts` の `restoreSuperseded` doc
  コメント「⚠ reinforce する理由」）。

⟹ **`superseded` である間、`decay_floor_at` を読む者は1つも無い。**凍結された値は、
段1にも段5にも影響しない——**正しさの上では無害である。**唯一これを動かす経路は、
凍結を解いて `active` へ戻す `restoreSuperseded` だけである。**⟹ 決定1: `superseded` の
`decay_floor_at` の持ち主は `restoreSuperseded` である。**

- **`contested` は事情が違う**: 索引にも段5の集計にも `active` と同格で載っている
  （上記の `IN ('active', 'contested')`）。recall の忘却ゲート（`survivesDecayGate`、
  [ADR 0153](./0153-recall-decay-floor-gate.md)）も `active` と区別せず適用される
  （`packages/core/src/recall-runtime.ts`、`status: ["active", "contested"]` で候補生成し、
  同じ `decayGateActive` の判定を通す）——**`decay_floor_at` を過ぎれば `active` と同じく
  見えなくなる。**出口は `resolveContested`（行7、ADR 0150）のみで、対向の id を
  呼び出し側が知っている必要がある（[Issue #465](https://github.com/takecchi/mnemora/issues/465)）。
  掃引は `contested` を一切持たない（ADR 0114 決定2）。**⟹ 決定2: `contested` の
  `decay_floor_at` の持ち主は「recall の忘却ゲート」と「出口としての `resolveContested`」の
  組であり、掃引は持たない。**

## 決めたこと

### 決定1: `superseded` の `decay_floor_at` の持ち主は `restoreSuperseded`

`superseded` である間、`decay_floor_at` を読む者は居ない（上記の現物調査）。
`supersedeWithNewMemories`/`updateStatusWithEvent` は値を動かさない——**凍結する。**
凍結された値は正しさに影響しない。戻る経路 `restoreSuperseded` が `reinforce` で
引き直す。**容量への影響（行が溜まり続けること自体）は別問題**であり、PR #670 が
`docs/memory-model.md` §11 に記録済みである——本 ADR はそれを繰り返さない。

### 決定2: `contested` の `decay_floor_at` の持ち主は「忘却ゲート」と `resolveContested`

`contested` は段1の候補に入り続け、忘却ゲートで `active` と同じく見かけ上消える。
`status` 自体は `contested` のまま動かない。掃引は対象にしない——`contestedWithId` の
一対一を片側だけ倒すと壊れるため（ADR 0114 決定2「検討して採らなかった案」1）。
解消は `resolveContested` のみで、対向の id を既に知っていることが適格性の条件
（[Issue #465](https://github.com/takecchi/mnemora/issues/465)）。

### 決定3: 回収の経路（案C: 掃引を広げる／`archived` へ逃がす）は v1.x で入れない

Issue #567 が残していた問いに対する答え。**入れない。**根拠は理屈ではなく、次の2点を
現物に当てて確認した結果である。

**(a) `archived` へ広げても、段5の走査行数（容量問題の実害）は減らない。**
`aggregateScope` の `scoped` CTE（`packages/postgres/src/memory-store.ts`）は

```sql
WITH scoped AS (
  SELECT id, subject_id, digest, occurred_at, recorded_at, embedding_status, status,
         valid_from, valid_until, decay_floor_at, decay_floor_seq
  FROM memories
  WHERE tenant_id = ${ctx.tenantId} ${subjectFilter}
)
```

**`status` で絞っていない。**`archived`/`superseded`/`forgotten` を含む、テナントの
全状態の行をこの CTE がスキャンする——個々の `count(*) FILTER (WHERE status = ...)` は
この CTE の**後**に載る集約であり、スキャンする行数そのものには効かない。⟹
`superseded`/`contested` を `archived` へ倒しても、`scoped` が読む行数は1行も減らない。
**Issue #567 が問題にした「段5が Seq Scan に倒れる」実害には、案C は効かない。**

**(b) `restoreArchived` は前状態を覚えず、無条件に `active` へ戻す。**
`packages/core/src/runtime.ts` の `restoreArchived` は

```ts
await deps.memoryStore.updateStatusWithEvent(
  ctx, id, "active",
  { expectedStatus: "archived" },
  { ... },
);
```

`supersededById` を渡していない。`updateStatusWithEvent` の `SET` 句は
`superseded_by_id = COALESCE(${opts.supersededById ?? null}, superseded_by_id)`
（`packages/postgres/src/memory-store.ts`）——`supersededById` を渡さない呼び出しでは
**既存の値をそのまま残す。**⟹ もし `superseded` な行を掃引の対象へ広げて `archived` に
できるようにすると、その後 `restoreArchived` で戻した行は
**`status='active'` なのに `superseded_by_id` が非 NULL** という、lifecycle 表のどの状態にも
無い壊れた行になる（`recall()` はこの行を `active` として扱うため実害は無いが、
`superseded_by_id` が「置き換えられた」という嘘の履歴を持ち続ける）。**復旧口
（`restoreArchived`）と回収の経路を同時に設計しない限り、案Cは新しい不整合を作る側になる。**
——PR #670 の着地報告が「復旧窓との整合……の設計が無い」と書いていたのは、
推論ではなく、これが具体的な形である。

**⟹ 効く手は残っているが、この PR の射程外に置く:**

- **物理削除**（`memories` から実際に `DELETE` する）は効くが、[ADR 0124](./0124-purge-physical-delete.md)
  の監査方針（`purge()` はトゥームストーン上書きで行を残す。理由は `memory_events` からの
  外部キー参照整合性）と正面から衝突する。**オーナー判断。**
- **段5の走査を索引で絞る**（`scoped` に `status` の絞り込みを足す、または別の集計経路を作る）
  は理屈のうえでは効くが、**Seq Scan に倒れる閾値を実測していない**（ADR 0114/PR #670 が
  引いた 2026-09-17 の観測は3点のみ）。効果を測らずに `packages/postgres` の本番 SQL を
  変えることは、この PR（doc + 歯）の射程を超える。**別の問いとして残す。**

### 決定4: ADR 0114 の「覆る条件」の見直しは、本文を書き換えず追記で記録する

ADR 0114「これが覆るとしたら」の2条件（`contested` の解決規則が入ったら／`archived` からの
復元が要求されたら、掃引を広げる判断が要る）は、字面のとおりには両方とも鳴っている
（`resolveContested`・`restoreArchived` は実装済み）。**しかし決定3が示すとおり、
鳴った条件は「掃引を広げるべきだ」という結論には繋がらなかった**——`resolveContested` は
`contested` を掃引ではなく専用の解決口で片付ける設計であり、`restoreArchived` の実装
（決定3(b)）はむしろ広げることの危険を具体的に示した。**⟹ ADR 0114 の本文は書き換えない
（採用済み ADR の本文は書き換えない、`docs/decisions/README.md`）。** ADR 0114 の末尾に、
本 ADR を指す追記節を足す。

`docs/memory-model.md` §11 の PR #670 が足した節（「⚠ `superseded`/`contested` の行は溜まる」）
は、既存の文を縮めずに、本 ADR への1行の参照を追加するだけに留める——Issue #567 の問い
そのものへの答え（決定3）は、節ではなくこの ADR が持つ。

## 検討して採らなかった案

1. **`archiveDecayed` の対象を `superseded`/`contested` へ広げる（案Cの一形態）。**
   却下。決定3(a)(b)。段5の実害に効かず、`restoreArchived` との組み合わせで新しい
   不整合（`active` かつ `superseded_by_id` 非NULL）を作る。
2. **`superseded`/`contested` を専用の新しい状態（例: `stale`）へ倒し、掃引の対象にする。**
   却下。`MemoryStatus` に値を足すこと自体が [ADR 0087](./0087-runtime-forget-shape.md)
   決定1が却下した理由（status ゲートを全部割ることになる。3か所——候補生成ゲート・
   postgres 集約 SQL・`ScopeAggregate` の該当欄——が独立にずれる新しい面を作る）と
   同じ形で落ちる。加えて schema 変更（`CHECK` 制約の拡張）を伴い、オーナー領分。
3. **生 SQL で片付ける手順を docs に書く（案B、PR #670 が既に却下）。**
   再検討したが結論は変わらない。`memory_events` に跡が残らず監査ログの担保
   （§9）を外れ、`restoreSuperseded` の復旧窓を黙って閉じる。
4. **段5の `scoped` CTE に `status` の絞り込みを、この PR の中で先に足す。**
   却下（決定3の「効く手」参照）。実測なしに `packages/postgres` の本番 SQL を変えると、
   「容量問題を実際にどれだけ解決するか」を確かめないまま変更を入れることになり、
   `docs/autonomy.md` の変異試験の規律（歯が実際に噛むことを示す）はともかく、
   **問題そのものの実測（Seq Scan の閾値）が無いまま手を打つ**ことになる。
   閾値を測ってから、別の PR で判断する。

## 引き受けた負債・覆えていない範囲

1. **`superseded`/`contested` の行は、この PR の後も一度も減らない。**Issue #567 は
   閉じない——決定3は「入れない」という判断であって、問題を消していない。
2. **ADR 0114 の負債1（`superseded`/`contested` は `decay_floor_at` を過ぎても掃かれない）は
   残る。**決定3が示すとおり、これは「まだ実装していない」のではなく「入れないと決めた」。
3. **段5が Seq Scan に倒れる閾値は、この PR でも測っていない。**決定3「効く手」の
   2番目（索引で絞る）を検討する前提として、いずれ誰かが測る必要がある。
4. **この ADR を書く過程で見つかった、本 ADR の決定とは別の3つの不整合・穴**
   （`docs/memory-model.md` 行14の記述と `restoreArchived` の実際の挙動の食い違い、
   ADR 0087 負債1が実際に発火しうる状態になっていること、`reinforce` に status ガードが
   無いこと）は、**この PR では直さない。**詳細は PR 本文「本 PR では扱わない発見」を参照。
   ⛔ 混ぜると、この ADR の決定（回収経路を入れない）と、別の3つの穴の修正が同じ PR に
   束ねられ、どちらの判断も読みにくくなる（`docs/autonomy.md` §2「ついでに直さない」）。

## これが覆るとしたら

- **段5が Seq Scan に倒れる閾値が実測され、実運用の行数がその閾値に近いと分かったら**、
  決定3「効く手」の2番目（索引で絞る／`scoped` を分ける）を独立の PR で検討する判断が
  要る。そのときも `restoreArchived` との整合（決定3(b)）は前提として潰す必要がある。
- **オーナーが物理削除（`DELETE FROM memories`）を監査方針の例外として明示的に許可したら**、
  決定3「効く手」の1番目が開く。ADR 0124 の監査方針の見直しはオーナー判断。
- **`contested` を作る主体が Phase 2 で増え、`markContestedPair` の呼び出しが実運用で
  頻発したら**、上の「引き受けた負債」4番の ADR 0087 負債1（forget が contested の対を
  破る）が理屈ではなく実際の障害として現れる可能性が上がる。そのときは本 ADR ではなく
  ADR 0087 の追記、または新しい ADR で扱う。

## 確かめていないこと

- **決定1・2・3(a)(b) の現物調査（索引の述語・`scoped` CTE・`supersedeWithNewMemories`/
  `updateStatusWithEvent` の `UPDATE` 文・`restoreArchived`/`restoreSuperseded` の実装）は
  すべて【現物】——`origin/main` = `52113a8` を読んで確認した。**溜まる速さ・Seq Scan の
  閾値のような実測の数字は、この ADR では測っていない（PR #670 からの【受】のまま）。
- **`scoped` CTE に status 述語が無いこと・`restoreArchived` が `supersededById` を渡さない
  ことは、`scripts/__tests__/decay-floor-owner-premises.test.mjs` の歯で縛った。**
  これが崩れたら、決定3の根拠が崩れているので、この ADR を読み直すこと。
- **`reinforce` が status を問わず呼べること**（引き受けた負債4番）は、コードを読んで
  確認した——**実際に `superseded` な Memory に対して `memory_usage` を送る呼び出しが
  実運用でどれだけ起きうるかは測っていない**（そもそも `recall()` が `superseded` を
  返さないため、正規の経路からは `usedMemoryIds` に混入しにくいが、呼び出し側が
  古い id を握っていれば起こりうる、という以上の実測はしていない）。

## 追記（2026-09-26、[Issue #840](https://github.com/takecchi/mnemora/issues/840)）: `reinforce` の status 未検査は `superseded` だけでなく `archived`/`forgotten` にも及ぶ——doc に明記し、挙動は変えない

クローン miku が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**上の本文（決定・検討して採らなかった案・引き受けた負債・確かめていないこと）は書き換えていない。**当時の記録として残す。
コード（`packages/*/src`）の挙動は変えていない——`MemoryStore.reinforce` の doc コメントに明記しただけである。

**この ADR が「確かめていないこと」に残していた負債4番、および PR #713 本文の
「本 PR では扱わない発見」3番は、`reinforce` が status を見ずに書くという同じ穴を
`superseded` についてだけ記録していた。** Issue #840 は、同じ穴が `archived` と
`forgotten` にも同様に及ぶことを新たに確かめた（`contested` は上の決定2どおりの正規経路
であり、この追記の対象ではない）。

- **`archived`**: `restoreArchived` が復帰の直後に `reinforce` を呼ぶ（決定1が
  `superseded`/`restoreSuperseded` について書いた形と同じ）ため、時計が前にしか進まない
  通常の順序では単調性ガードにより上書きされる。**ただし、これは時計が前にしか進まない
  ことに頼った結果であり、`reinforce` 自身が status を見て守っているわけではない**——
  注入した時計を逆行させた場合、不正な値が復帰後の行に残りうることを Issue #840 が
  確かめている。
- **`forgotten`**: 戻る経路が無いため、書かれた値は消えずに残る。忘却ゲート・段1の索引・
  段5の集計はいずれも `forgotten` の `decayFloorAt`/`decayBaseSeq` を読まないため、
  `recall()` の結果には影響しない——値が見えるのは `get()` で直接読んだときだけ
  （監査・エクスポート時のノイズ）。

**判断（2026-09-26、クローン miku）: 挙動は変えず、`MemoryStore.reinforce` の doc
コメント（`packages/core/src/interfaces/memory-store.ts`）に status ごとの帰結を明記した
うえで、Issue #840 を閉じる。**

**`reinforce` の対象を `active`/`contested` に絞る案は、今回は採らなかった。**
Issue #840 自身が挙げていた判断点（対象を絞るか、絞る場合に適合テストへ歯を足すか）を、
この追記の場で決めることはできる。しかし**どの status を `reinforce` の対象から外すかを
決めることは、「使用報告が届いたという事実をどこまで記録するか」の意味を変える判断**
であり、単なるバグ修正の範囲を超える——対象を絞れば、`archived`/`forgotten` な Memory に
対する使用報告は黙って無視されることになり、それが望ましいかどうかは製品判断である。
**今回は記録に留め、決定は持ち越す。**

**実測について**: 上の `archived`/`forgotten` の観測（時計逆行での不正な値の残存、
forgotten の値が消えずに残ること）は、**Issue #840 が Fake・Postgres の両方で実測した
結果を引いたものであり、この追記・この PR では手元で再現していない。**
