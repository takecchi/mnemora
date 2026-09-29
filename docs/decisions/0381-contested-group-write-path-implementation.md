# ADR 0381: 多者間 `contested`（`memory_relations`）の書き込み経路の実装 —— Issue #207/#933 PR2 段階B の直しと設計判断

- **状態**: 提案 (2026-09-30)
- **日付**: 2026-09-30
- **PR**: [#1442](https://github.com/takecchi/mnemora/pull/1442)（Draft）

> **⚠ この ADR は、マネージャー（クローン miku）から切り出された担い手が書いた。**
> 設計判断の一部（段階Aで確定した11個の決定）はマネージャー経由で渡された確定済みの
> 前提であり、この ADR の書き手が新たに選んだものではない（ADR 0220 と同じ、伝聞の
> 1段）。**段階Bで新たに必要になった直し（fix1・fix2）と、実装の中で下した詳細判断は、
> この担い手が決めた**——どちらであるかは各節に明記する。

---

## 出所の凡例

- **【伝】** — マネージャー経由で渡された、確定済みの前提。この ADR の書き手は検証していない。
- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分で読んで確かめた。
- **【実測】** — この手元の器で実際にコマンドを走らせて得た。
- **【判】** — この ADR の書き手（担い手）が、この PR の範囲内で下した設計判断。

---

## 0. この ADR が答える範囲

[ADR 0327](./0327-relation-graph-contested-write-path-design.md)（関係グラフ本体の書き込み
経路の設計、状態: 提案）・[ADR 0378](./0378-claim-key-contested-detection-covers-contested-matches.md)
（claim key 検出が3件目以降も一致に数える設計、状態: 採用）が決めた設計を、Issue #207/#933
PR2 として実装した。段階Aで `RelationStore`・`MemoryStore.markContestedGroup?`/
`resolveContestedGroup?`・migration 0026 の型と実装を作り、段階Bで次を行った:

1. 段階Aの2つの穴を直す（fix1・fix2、§1・§2）。
2. `Runtime.markContestedGroup?`/`Runtime.resolveContestedGroup?`（読み側の適格性の分類、
   `Runtime.markContested`/`resolveContested` と対称の層）を実装した（§3）。
3. `detectClaimKeyContested` の `contested_group` 分岐（穴Aの吸収・合併を含むメンバーの
   組み立て）を実装した（§4）。
4. **recall 段3（`contradiction_resolution`、必須の同伴取得）を多者間の群にも広げた**
   （§5）。当初、オーナー側クローンへ判断を仰ぐ必要のある食い違い（ADR 0292 が設計した
   別の opt-in チャンネルと、既存の必須取得の拡張のどちらを指すか）を見つけて実装を
   見送ったが、後の指示で「既存の必須取得を拡張する・新しい `RecallQuery` の欄は作らない」
   と決まったため、その方針で実装した（§5.3）。
5. `ClaimKeyOptions.formContestedGroups?` という専用の opt-in フラグを新設していたが、
   後の指示で廃止し、`RuntimeDeps.relationStore` の配線そのものを条件にした（§4.1）。
6. `resolveContestedGroup?` の部分解消チェック（fix2）が投げていた
   `MemoryStatusConflictError` の転用を、専用のエラー
   `ContestedGroupMembershipMismatchError` に切り出した（§2.4）。

**本 ADR が答えないこと**: `memory_relations` テーブルの形自体（ADR 0292 決定1）、
多者間 `contested` を書く口の契約自体（ADR 0327・段階A、`MemoryStore.markContestedGroup?`
の interface JSDoc）——これらは既に決着している。

---

## 1. fix1 — 重なりの判定を1か所に寄せる（Postgres, SQL 側へ統一）【判】

### 1.1 直した内容

段階Aの `PostgresMemoryStore.markContestedGroup` は、重なる組を JS の二重ループで判定して
から `tx.execute` を組ごとに呼んでいた——`findActiveByClaimKey`/`findContestedByClaimKey`
が使う半開区間の SQL 式と同じ式を JS 側にもう1つ持つ、二重管理だった。

直した後は、単一の `INSERT ... SELECT`（自己結合）に置き換えた:

```sql
INSERT INTO memory_relations (id, tenant_id, from_memory_id, to_memory_id, kind)
SELECT gen_random_uuid(), $tenantId, a.id, b.id, 'contradicts'
FROM memories a
JOIN memories b
  ON b.tenant_id = a.tenant_id
 AND b.id <> a.id
 AND b.id = ANY($ids::uuid[])
WHERE a.tenant_id = $tenantId
  AND a.id = ANY($ids::uuid[])
  AND (a.valid_from IS NULL OR b.valid_until IS NULL OR a.valid_from < b.valid_until)
  AND (b.valid_from IS NULL OR a.valid_until IS NULL OR b.valid_from < a.valid_until)
ON CONFLICT (tenant_id, from_memory_id, to_memory_id, kind) DO NOTHING
```

`WHERE` 節の左右対称性（`a`/`b` を入れ替えても同じ式になる）を利用し、`a`×`b` の自己結合
から両方向の行が自然に出る——逆方向専用の2本目の `INSERT` を足す必要が無い。JS 側の
`overlaps()` ヘルパーと二重ループは削除した。**Fake（`packages/core`）・InMemory
（`packages/testkit`）は JS のままでよい**（マネージャー指示どおり——これらは SQL を
持たないため、重なりの式を1か所に寄せる先が無い）。

### 1.2 境目の適合テスト（マイクロ秒精度）

`packages/testkit/src/memory-store-conformance.ts` に、`validUntil` と次の `validFrom` が
**ちょうど一致する**（重ならない、半開区間の境目）組には行を張らない適合テストを足した
——Postgres・InMemory の両方で同じ結果になることを縛る。

**JS の `Date` はミリ秒までしか精度を持たない。**アプリの書き込み経路（`createMemory` 等）は
すべて `toPgTimestamp(date: Date)` を通るため、実際に書かれる値は常にミリ秒精度に丸まる
——Postgres の `timestamptz`（マイクロ秒精度）との差は、公開 API のどの経路からも実際には
現れない。この差を**到達できないが Postgres 自身は正しく処理する**ことを示すため、
`packages/postgres/src/__tests__/mark-contested-group-microsecond-boundary.postgres.test.ts`
を新設した——`pool.query` で生の SQL を打ち、`valid_until` が `valid_from` よりちょうど
1マイクロ秒だけ後ろにずれた組（JS の `Date` では同じ値に潰れて区別できない差）が、
Postgres では正しく「1マイクロ秒だけ重なる」と判定され、関係の行が張られることを実測した
（陽性対照）。陰性対照として、境目がマイクロ秒まで完全に一致する組には行が張られないことも
同じテストで確認した。

**この差を fixture（InMemory・Fake）側で再現するテストは書いていない**——JS の `Date` の
精度そのものの限界であり、Postgres 側だけの歯として置く（「Postgres が正、fixture は
ミリ秒までしか追えない」という限界の記録）。

---

## 2. fix2 — resolve で群の一部だけを渡したら、store の CAS で弾く【判】

### 2.1 直した内容

`MemoryStore.resolveContestedGroup?` の CAS に、「渡された `members` が、`memory_relations`
でつながった『今も `contested` な』群の全員と一致すること」を追加した。一部だけを渡した
解消（部分解消）を拒み、何も書かない。

- **Postgres**: `WITH RECURSIVE` で `memory_relations`（`kind: 'contradicts'`）を辿って
  到達する id を求め、そのうち `memories.status = 'contested'` のものを、渡された id 集合と
  突き合わせる。欠けがあれば専用のエラー（§2.4）を投げ、何も書かない。
- **InMemory・Fake**: 同じ判定を BFS（`this.relations`/`this.backing.relations` を手で辿る）
  で行う——SQL の `WITH RECURSIVE` に相当するグラフ探索を JS で書いた。

### 2.2 「群の全員」から抜けたメンバーの扱い【判】

決定10（forget・supersede・purge・archive で群を離れたメンバーの `memory_relations` 行は
残す）と矛盾しない形にするため、「群の全員」は**行の有無ではなく `status === 'contested'`
で判定する**——到達集合のうち、まだ `contested` なものだけを「今の群」として数える。
forget 等で離脱したメンバー（関係の行は残るが `status` はもう `contested` ではない）は、
到達集合に入っても「欠けたメンバー」として数えない。この判断を採らなければ、一度でも
メンバーが forget されると、その群は二度と `resolveContestedGroup` で解消できなくなって
しまう（行が永遠に残る設計〔決定10〕である以上、この扱いを選ばないと機能そのものが壊れる）。

### 2.3 Runtime 側の確認【判】

`RuntimeDeps` に新しい任意の依存 `relationStore?: RelationStore` を足した
（`RuntimeDeps.lexicalStore?` と同じ「省略可能・省略しても mnemora は成立する」設計）。
`Runtime.resolveContestedGroup?` は、`deps.relationStore` が配線されていれば、store を呼ぶ
**前**に同じ確認を読み側でも行う——`memberIds` から `kind: 'contradicts'` を辿って到達する
`status === 'contested'` な id が `memberIds` の外にあれば、書き込みを一切試みず
`{ kind: "ineligible", sides, missingMembers }` を返す。**`relationStore` が配線されて
いなければ、この読み側の確認は行わず store 側の CAS だけに任せる**——store 側の CAS が
専用のエラー（§2.4）を投げれば、`relationStore` の配線有無に関わらず、Runtime はそれを
捕まえて同じ `{ kind: "ineligible", ... }` に写す（下記）。

適合テスト（`packages/testkit/src/memory-store-conformance.ts`）に、群の一部だけを渡す歯を
足した——4件の群を作り、3件だけを解消しようとして専用のエラー（§2.4）になり、
4件とも `status: 'contested'` のまま変わらないことを、Postgres・InMemory の両方で確認した。
`packages/core/src/__tests__/resolve-contested-group.test.ts`（Fake、Runtime 層）にも
同じ形の歯を足した。

### 2.4 専用のエラー `ContestedGroupMembershipMismatchError`【判、2026-09-30 のさらなる直し】

当初、fix2 の CAS 違反は `MemoryStatusConflictError(missingId, "contested", "contested")`
（`expectedStatus === observedStatus === 'contested'` という、通常の CAS 違反
〔`expectedStatus !== observedStatus`〕とは意味が異なる特別な使い方）で表していた。
オーナー側クローンの指示により、この転用をやめ、専用の型 `ContestedGroupMembershipMismatchError`
（`packages/core/src/interfaces/memory-store.ts`）を新設した——`MemoryPurgeConflictError`
が `MemoryStatusConflictError` を再利用しなかったのと同じ理由（`observedStatus` が
`expectedStatus` と同じ値になりうる場面では、「期待した値と違う値を観測した」という
`MemoryStatusConflictError` の前提そのものが成り立たない）。

Postgres・InMemory・Fake の `resolveContestedGroup` 実装すべてがこの専用エラーを投げる
よう変更した。`Runtime.resolveContestedGroup?` は、**`deps.relationStore` の配線の有無に
関わらず**この専用エラーを捕まえて `{ kind: "ineligible", sides, missingMembers:
[error.missingMemberId] }` に写す——旧版が持っていた「`relationStore` の配線有無で
`ineligible`/`conflict` のどちらに分類されるかが変わる」という負債（旧 §7 の1番目）は、
これで解消した。適合テスト・`packages/core` のテストも、投げられる例外の**型**まで
（`instanceof ContestedGroupMembershipMismatchError`）縛るよう更新した。

---

## 3. `Runtime.markContestedGroup?`/`Runtime.resolveContestedGroup?`【判】

`Runtime.markContested`/`resolveContested`（ADR 0134/ADR 0150）と対称に、読み側の適格性を
`getMany` で分類してから store の口を呼ぶ薄い層を追加した。

- **任意メソッドである**（`?`）。`@mnemora/core` は v1.0.0 として npm に公開済みであり、
  `Runtime` interface を自前で実装している利用者にとって、v1.0.0 の後に必須メソッドが
  増えることは破壊的変更になる——`resolveOrphanedContested?`（ADR 0150 追記、Issue #825）が
  確立した前例をそのまま踏襲した。`createRuntime()` の戻り値には必ず実装されている。
- **引数は `memberIds: readonly MemoryId[]` だけを取る**（`event`/`status`/`supersededById`
  は Runtime 自身が組み立てて `MemoryStore.markContestedGroup?`/`resolveContestedGroup?`
  へ渡す）——`markContested(ctx, firstId, secondId, opts?)`/`resolveContested(ctx, firstId,
  secondId, resolution, opts?)` と同じ「Runtime 層は id だけを受け取り、書き込みに必要な
  形は自分で組み立てる」分担にした。段階Aで確定した `MemoryStore` の口自体（`members[].event`
  を呼び出し側が組み立てて渡す形）とは非対称に見えるが、これは`markContestedPair`/
  `markContestedGroup?` という store 側の口と、それを呼ぶ `Runtime.markContested`/
  `markContestedGroup?` という2つの別の層の話であり、段階Aが決めた store 側の契約には
  一切触れていない。
- `resolveContestedGroup?` の `resolution.kind === "supersede"` で `winnerId` が大文字小文字
  だけ違う場合の救済（`resolveContested`（2者版）にある機能）は、群では実装しなかった
  ——2者なら「もう片方」の1択だが、3件以上では「どれとも大文字小文字だけ違う」場合に
  候補を一意に絞れないケースがずっと起きやすく、この PR の範囲を超える判断が要る
  （§7「引き受けた負債」）。

---

## 4. `detectClaimKeyContested` の `contested_group` 分岐【判】

### 4.1 群を作る条件は「`detectContested` が on かつ `RuntimeDeps.relationStore` が配線されていること」【判・伝、2026-09-30 のさらなる直し】

`detectContested: true` の「一致が2件以上、または一致がちょうど1件だがその1件が既に
`contested`」の分岐（ADR 0378 決定5が「evidence-only、状態を動かさない」と決めた分岐）で、
`deps.relationStore` と `deps.memoryStore.markContestedGroup` の両方が配線されていれば、
evidence だけに留めず実際に `Runtime.markContestedGroup` を呼んで群として書き込む。
**`deps.memoryStore.markContestedGroup` が配線されているだけでは群を作らない**——
`relationStore` も要る（穴Aの吸収・合併の判定〔§4.2〕に `listRelated` そのものが要るため）。

**当初は `ClaimKeyOptions.formContestedGroups?: boolean`（既定 `false`）という専用の
opt-in フラグを新設していた**が、オーナー側クローンの指示によりこのフラグを廃止し、
既存の `relationStore` の配線そのものを条件にした（この節の見出しの条件）。

**`relationStore` を配線しない呼び出しの挙動は1バイトも変わらない**——**Issue #933
PR1（ADR 0378）が確立した「evidence-only」の挙動を期待する既存の歯（
`claim-key-single-contested-match.test.ts` 等、PR1の歯）は、`packages/core/src/
__tests__/runtime-fakes.ts` の `FakeMemoryStore` が段階Aから `markContestedGroup`/
`resolveContestedGroup` を常に実装している一方、PR1 の歯はどれも `relationStore` を
一度も配線していない**ため、フラグを廃止して条件を `relationStore` の配線へ移しても、
PR1 の歯は影響を受けない——実測で確認した（全6ファイル、§8）。「PR1 の歯を書き換えない」
という制約と、「detectClaimKeyContested の contested_group 分岐を実装する」という要求は、
専用フラグを持たない今の形でも両立する。

### 4.2 メンバーの組み立て（穴A・合併）【判】

3件以上に広がった `matches`（`findActiveByClaimKey`/`findContestedByClaimKey` の合わせた
結果）から、群のメンバー集合を次の順で広げる:

1. **種** — 検出中の `memory` 自身と、`matches` の全員。
2. **穴A（既存の2者間の対の吸収）** — `matches` のうち `status === 'contested'` かつ
   `contestedWithId !== null` なものは、その相手（`contestedWithId` が指す id）も群に
   加える。**相方自身は claim key の一致条件（有効期間の重なり等）を満たさないことが
   ある**ため、`matches` に現れないことがある——`contestedWithId` は Memory 自身が既に
   持つフィールドなので、追加の store 呼び出し無しにこの欠けを埋められる。
3. **合併（複数の既存群の統合）** — `deps.relationStore` が配線されていれば、ここまでの
   メンバーのうち `status === 'contested'` かつ `contestedWithId === null`（＝既存の3件
   以上の群のメンバー）な id から `kind: 'contradicts'` を辿って到達できる id を候補に
   加える（BFS）。**候補は `getMany` で読み直し、`status === 'contested'` のものだけを
   実際に群へ加える**——fix2（§2.2）と同じ「行の有無ではなく `status` で今の群を判定する」
   規律。resolve 済みの群は関係の行を削除している（`resolveContestedGroup?` 契約）ので、
   ここで見つかるのは今も現存する群だけである。`matches` が2つの既存群それぞれの
   メンバーを1件ずつ含んでいた場合、両方の群の全メンバーがここで合流し、1つの群になる。

広げた結果が3件未満（`markContestedGroup` の最小人数を満たさない——例: `relationStore` が
配線されておらず、既存群の残りのメンバーを辿れない場合）のときは呼ばない。呼んで
`outcome.kind !== "contested_group"`（`ineligible`/`conflict`。TOCTOU 等）になった場合も
含め、どちらも今まで通りの evidence-only の `memory_events` 追記 + `unresolved_conflict`
へフォールバックする——状態が動かなかった呼び出しで、根拠だけは必ず残す（ADR 0378 決定5の
踏襲）。

`ContestedDetectionOutcome.result` に新しい判別子 `{ kind: "contested_group"; memberIds:
MemoryId[]; markContestedGroup: MarkContestedGroupResult }` を足した。

---

## 5. recall 段3（`contradiction_resolution`）への group 対応

**⚠ 2026-09-30 のさらなる直し: 実装した。**§5.1・§5.2 は最初にこの担い手が見つけた
食い違いと、その時点で実装を見送った判断の記録として残す（当時の記録、書き換えない）。
オーナー側クローンが (b) を選んだ経緯・実装した内容は §5.3 に書く。

### 5.1 コーディネータからの依頼と、見つけた食い違い【判】（当時の記録）

コーディネータの依頼は「recall 段3: 上限10（`DEFAULT_RECALL_ASSOCIATION.maxCount`）、
`validFrom` の新しい順→id の順で切り、切った件数を `explain` に、`"relation"` という
`stage` 値を `Omission.over_limit`/`stage_skipped` に追加する」というものだった。

この PR の調査で、[ADR 0292](./0292-relation-graph-table-depth-omitted-design.md)
決定2・決定3（状態: **提案**、2026-09-25）が、**既にほぼ同じ形を設計済みだった**ことが
分かった:

- `RecallQuery.relations?: RecallRelationQuery { maxCount: number }`——**既定 off、
  `RecallAssociationQuery`（連想枠、§9.5）と同じ形の、独立した opt-in の探索チャンネル**
  （決定2-b）。`maxCount` は**この chunk 専用の必須フィールド**であり、
  `DEFAULT_RECALL_ASSOCIATION.maxCount` を流用する設計にはなっていない。
- `over_limit` に `stage: "relation"`、`stage_skipped` に `stage: "relation"`
  （決定3-a・3-b）——ここはコーディネータの依頼と一致する。
- 1段より先（未探索の深さ）は `Omission` を増やさず `explain.stages[].detail.
  relationDepthCapped: true` という型無し診断キーに置く（決定3-c）。

**しかし ADR 0292 が設計したのは、既存の「必須の同伴取得」（段3、`contradiction_resolution`、
`docs/memory-model.md` §5 機構3「対向は必ず隣接させる」の実装）とは別の、呼び出し側が
`query.relations` を明示的に渡したときだけ動く探索チャンネル（連想枠 §9.5 に近い位置づけ）
である。**一方、コーディネータの依頼文言「recall 段3」は、歴史的に
`stage: "contradiction_resolution"`（`docs/recall.md` §2 段3）を指す——**この既存の段3
（無条件・必須）自体を、N者間の群にも対応させる**、という別の実装対象を指している
可能性がある。

この2つは実装の姿が大きく異なる:

- (a) ADR 0292 が設計した「独立した opt-in の探索チャンネル」——`RecallQuery.relations?` を
  渡した呼び出しだけが影響を受け、既定の recall は1バイトも変わらない。
- (b) 既存の段3（`contradiction_resolution`、無条件）自体を、`contestedWithId`（2者）だけ
  でなく `RelationStore`（N者の群）も見るように拡張する——**`docs/memory-model.md` §5
  機構3「対向は必ず隣接させる」を、N者の群にどう一般化するか**（「隣接」は2件の並びの話
  であり、3件以上の群を「隣接」させる意味自体が新しい設計判断を要る）という、
  ADR 0292 が明示的に範囲外とした問いに触れる。

### 5.2 この PR での当時の判断: 実装を見送り、判断をマネージャー/オーナーへ返す【判】（当時の記録）

**この食い違いを、この担い手の判断だけで一方に決めて実装することはしなかった。**理由:

1. **(b) を選ぶ場合、`docs/memory-model.md` §5 機構3・ADR 0043〜0046（単位組み立て・
   shortfall・対不変条件）という、この repo が最も厳密に守ってきた recall の不変条件群に
   新しい一般化（N者の「隣接」の定義）を持ち込むことになる。**この判断を、明示的な
   確認無しにこの担い手だけで下すのは、影響範囲に対して分不相応だと判断した。
2. **(a) を選ぶ場合は ADR 0292 の決定をそのまま実装すればよいが、ADR 0292 自体がまだ
   「状態: 提案」であり「採用」されていない。**この PR の中で提案中の別 ADR を無断で
   採用に格上げする形で実装を進めるのは、ADR の意思決定の順序を飛ばすことになる。
3. コーディネータの依頼文言（`DEFAULT_RECALL_ASSOCIATION.maxCount` を流用、「段3」という
   呼び方）は (b) 寄りに読めるが、`maxCount` を新しい必須フィールドにする設計（ADR 0292
   決定2-b）と食い違う——**言葉だけでは一意に決まらない。**

このため、recall 段3への group 対応は当時**この PR には含めず**、上の食い違いをマネージャーへの
報告に明記し、(a)/(b) のどちらを実装すべきかの判断を仰いだ。

### 5.3 オーナー側クローンが (b) を選び、実装した【伝・判】（当時の記録——探索の深さは §5.4 で「1段」から変わった）

マネージャー経由で、オーナー側クローンが (b)（既存の段3自体をN者の群に拡張する。
`RecallQuery.relations?` という新しい欄は作らない）を選んだと伝わった。実装した内容
（探索の深さ以外は §5.4 の後もそのまま有効）:

- **`RuntimeDeps.relationStore?`/`RecallRuntimeDeps.relationStore?` を通じて配線される
  `RelationStore` を使う。** `Runtime.recall()` が組み立てる `RecallRuntimeDeps` に
  `relationStore: deps.relationStore` をそのまま渡す。
- **`contestedWithId` を持たない `contested`（群のメンバー）ごとに、`RelationStore.
  listRelated(ctx, id, 'contradicts')` を1段だけ呼ぶ**（ADR 0292 決定2-a「深さは1段に
  固定する」の判断を、この既存の必須取得にもそのまま踏襲した——多段の探索は今回も
  作らない。理由も同じ: 測る手段が無い拡張を先取りしない）。複数の owner（群のメンバー
  のうち、この recall の候補〔`withinLimit`〕に既に居るもの）から辿った辺を1つの無向
  グラフとして束ね（`relationEdges`）、連結成分ごとに1つの単位（`Unit`。3件以上を
  持ちうる）にまとめる——2者間の対（`contestedWithId` の直接参照、`fetchMandatoryCompanions`）
  の既存の組み立ては1文字も変えていない。別の関数として並存させた。
- **上限は `DEFAULT_RECALL_ASSOCIATION.maxCount`（既定10）を流用する。** 連想枠専用の
  値を借りるだけで、これを直接動かす新しい `RecallQuery` の欄は作っていない——(a) が
  設計していた `RecallRelationQuery.maxCount`（専用の必須フィールド）は採らなかった。
  超えた分は `over_limit { stage: "relation", countKind: "exact" }` に積む。
- **並び順は `validFrom` の新しい順→`id` の順**（`validFrom` が無い候補は最も古い扱い）
  ——この回のマネージャー指示で決まった値をそのまま実装した。連想枠の `over_limit` が
  ランキングスコアで切るのとは異なる基準であることを `docs/recall.md` に明記した。
- **`RuntimeDeps.relationStore` が配線されていない場合**: 群のメンバーは今までどおり
  単独では返らず `unit_assembly_dropped` に落ちる。**この recall に実際に
  `contestedWithId` の無い `contested` 候補が現れたときだけ**
  `stage_skipped { stage: "relation", reason: "relation_store_unavailable" }` を積む
  （ADR 0292 決定3-b・`association` の `no_anchor` と同じ「実行する理由が無ければ
  積まない」区別を踏襲した）。
- **群を離れた（もう `contested` ではない）メンバーは、今の `status` の門で弾く**——
  fix2（§2.2）・`resolveContestedGroup?` の CAS と同じ「行の有無ではなく `status` で
  今の群を判定する」規律をここでも踏襲した。
- **`companionOf`（どの owner を起点に見つかったか）は、複数の owner から到達可能な
  companion の場合、最初に辺を記録した owner を指す**——`fetchMandatoryCompanions`
  （2者版）の「対向は必ず1つ」という前提が無いため、N者では本質的に一意に決まらない
  選択である。§7 の負債として記録する。
- **`RecalledMemory.contestedWith`（2者間専用、ADR 0335）は群のメンバーには付かない**
  ——`contestedWithId` 自体を持たない設計（ADR 0378 決定1 §3.3）のため、この欄の型
  （単一の `MemoryId`）が最初からN者に対応していない。群の一員であることを示す欄は
  `companionOf` だけである。

`docs/recall.md`（§2 段3、§8）・`docs/memory-model.md`（§5 機構3）・
`docs/architecture.md`（`RuntimeDeps.relationStore?` の節）を、実装した内容に合わせて
更新した。新しい歯（`packages/core/src/__tests__/recall-relation-group-companion.test.ts`
6件、`packages/postgres/src/__tests__/recall-relation-group-companion.postgres.test.ts`
3件）を追加し、赤（別 worktree）・変異試験（段3の上限）も確認した（§8）。

### 5.4 さらなる直し: 「1段だけ」から「関係の行でつながった全員」へ【伝・判、2026-09-30 のさらなる直し】

オーナー側クローンが、§5.3 の「1段だけ」を「群（関係の行でつながった全員）を辿る」形へ
改めるよう決定した。理由（伝聞）: `resolveContestedGroup?` の CAS（fix2、§2、
`WITH RECURSIVE`）は「群」を関係の行で連結した全員として扱っているのに、recall だけが
1段で止まると「群」が場所によって違う範囲を指すことになる。また、連れて来た companion
の側から見て相手（owner から2ホップ以上先のメンバー）が欠ける形は、「対立する記憶は
必ず並べて出す」という機構3の約束として弱い。

実装した内容（§5.3 の記述のうち、探索の深さに関わる部分だけを次に差し替える）:

- **`RelationStore.listRelated` を幅優先（BFS）で辿る。** `groupOwners`（`withinLimit`
  のうち `contestedWithId` を持たない `contested`）を始点にした多始点 BFS——訪れた id は
  `visited` に積み、二度と `listRelated` を呼ばない。
- **`status !== 'contested'` な id は、そこで打ち切る。** 辺は記録する（`relationEdges`
  ——単位組み立ての `collectGroupComponent` が同じグラフを再利用するため）が、その id
  からは `listRelated` を呼ばない・その先へは辿らない。decision10 で群を離れた
  メンバー（forget・supersede・purge・archive）を含む。
- **探索自体を止める安全弁**: 訪れた id の数（`visited.size`）が
  `DEFAULT_RECALL_ASSOCIATION.maxCount`（既定10）の**10倍**を超えたら、BFS を打ち切る
  （`EXPLORATION_VISIT_LIMIT`、`packages/core/src/recall-runtime.ts`）。**理由**:
  たどる回数に上限が無いと、大きな群で `listRelated` を呼び続けることになる——10倍
  という値は、「上限より遥かに多く辿れば、真の `validFrom` 最新 `maxCount` 件をほぼ
  確実に含む」という実務的な安全域であり、厳密な保証ではない（[ADR 0292](./0292-relation-graph-table-depth-omitted-design.md)
  決定2-a と同じ「測れない拡張を先取りしない」判断を、可変にはせず固定倍率で踏襲
  した）。安全弁で打ち切った場合、`over_limit(stage:'relation')` の `countKind` を
  `'lower_bound'` にする——探索が自然に尽きていれば `'exact'` のまま。
- **BFS の順序と「残す順」の関係**: BFS は**発見順**（訪れた順）で候補を集めるだけであり、
  並べる基準にはしない。BFS が終わった（または安全弁で打ち切った）**後**に、集まった
  候補全体を `validFrom` の新しい順→`id` の順で並べ替えてから `maxCount` 件に切る
  （§5.3 のとおり、変更していない）。**安全弁で打ち切った場合、BFS が発見順で先に
  見つけた候補が優先されるわけではない**——打ち切るまでに発見できた候補**全部**を
  対象に並べ替えてから切るため、真に最新の `validFrom` を持つ候補が後から見つかる
  順序で発見されていても、打ち切るまでに発見できていれば正しく上位に来る。安全弁が
  発動した場合にだけ、探索の外側にまだ存在するかもしれない候補を取りこぼす可能性が
  残る（`countKind: 'lower_bound'` で正直に言う、上記）。
- **10件の数え方（owner 自身を含めるかどうか）**: **含めない。** 2者間の段3
  （`fetchMandatoryCompanions`）には上限の概念自体が無い（`contestedWithId` は常に
  ちょうど1件の相手を指すため）ため直接の前例は無いが、`stages.push({stage:
  "contradiction_resolution", detail: {companionsAdded: allCompanions.length}})`
  （`packages/core/src/recall-runtime.ts`）が「同伴として**足した**件数」だけを数える
  既存の規約と揃え、`maxCount` も「新しく見つけて足す companion」だけを数える——
  owner（既に `withinLimit` に居る、足していない候補）は数えない。
- **`companionOf`**: BFS で実際に辿った経路上の1つ前の id（`discoveredVia`）を指す
  ——owner とは限らない（複数ホップ先の companion 経由で見つかることもある）。
  §5.3 が記録した負債（「最初に辺を記録した owner を指す」という単純化）を、より
  正確な形に置き換えた——ただし複数の親から同時に到達可能な場合にどちらを指すかが
  実装の内部順序に依存する曖昧さ自体は残る（§7 負債3）。

新しい歯を2本足した（Fake・Postgres 各1本）: A-B・A-C がつながり B-C はつながって
いない形で、B を引くと A・C まで並ぶこと——1段だけの実装ではこの歯は赤くなる
（`packages/core/src/__tests__/recall-relation-group-companion.test.ts`・
`packages/postgres/src/__tests__/recall-relation-group-companion.postgres.test.ts`、
それぞれ新しい `it` を1本追加。赤→緑は別 worktree〔§5.3 直前の commit を起点〕で
確認した）。§5.3 で足した「群が11件以上なら10件で切れる」歯は、この直しでも
（BFS が1段で自然に尽きるケースとして）緑のまま通ることを確認した。

---

## 6. 採らなかった案

- **`resolveContestedGroup?` の `winnerId` の大文字小文字救済を2者版と同じ形で実装する**:
  見送った（§3）。複数候補が同時にヒットする場合の振る舞いを新しく決める必要があり、
  この PR の範囲を超えると判断した——この判断は今回も変わっていない（§7）。
- **`formContestedGroups` という専用フラグを持たせたまま、既定を `true` にする**:
  見送った（§4.1、当時の記録）。「PR1 の歯を書き換えない」という制約と両立しない。
  最終的にはフラグ自体を廃止し、`relationStore` の配線を条件にする形に変わった。
- **recall 段3への group 対応を、ADR 0292 の設計 (a)（独立した opt-in チャンネル
  `RecallQuery.relations?`）で実装する**: 見送った（§5.3）。オーナー側クローンが (b)
  （既存の必須取得の拡張）を選んだため。
- **recall 段3の同伴取得の上限に、`association` と同じ専用のクエリ欄
  （`RecallRelationQuery.maxCount` 相当）を新設する**: 見送った（§5.3）。この回の
  マネージャー指示で「`RecallQuery.relations?` は作らない」と明示され、既存の
  `DEFAULT_RECALL_ASSOCIATION.maxCount` を流用する形に決まった。

---

## 7. 引き受けた負債

1. **`resolveContestedGroup?` の `winnerId` の大文字小文字救済が無い**（§6）。
2. **解消済み（§5.4）: recall 段3の多者間の同伴取得は、当初は深さ1段だけしか辿らな
   かった。** オーナー側クローンの決定で、幅優先で「関係の行でつながった全員」に達す
   るまで辿る形に変わった——`resolveContestedGroup?` の CAS（`WITH RECURSIVE`）と同じ
   範囲を「群」として扱うようになった。この探索を無条件に行うと大きな群で
   `listRelated` を呼び続けることになるため、代わりに次の負債を引き受けた（負債5）。
3. **`companionOf` は、複数の親から同時に到達可能な companion の場合、どちらを指すかが
   実装の内部順序（BFS が辿る順）に依存し、呼び出し側からは予測できない**
   （§5.3・§5.4）。2者版（`contestedWithId` が常に1つの相手を指す）には無かった
   曖昧さである。影響は説明可能性の欄（`RecalledMemory.companionOf`）だけであり、
   `memories`/`omitted` の中身・件数には影響しない。
4. **recall 段3の多者間の同伴取得の上限（`DEFAULT_RECALL_ASSOCIATION.maxCount` の流用）
   を、呼び出し側が個別に調整する手段が無い**（§5.3、§6）。`association` の `maxCount`
   のような専用のクエリ欄を持たないため、群が大きすぎる場合の唯一の対処は
   `resolveContestedGroup?` で群そのものを縮めることである。
5. **探索自体を止める安全弁（訪れた数が `maxCount` の10倍）を超える巨大な群では、
   真に `validFrom` が最新の `maxCount` 件と一致しない可能性がある**（§5.4）。
   `over_limit(stage:'relation')` の `countKind` を `'lower_bound'` に倒して「測って
   いない」と正直に言う設計にしたが、安全弁の倍率（10倍）自体は固定値であり、呼び
   出し側から調整する手段は無い（負債4と同じ理由）。この倍率を超える群が実際にどの
   程度の頻度で起こりうるかは測っていない（§8「確かめていないこと」）。

---

## 8. 確かめたこと・確かめていないこと

**確かめたこと（実測）**:
- fix1: Postgres で、`validUntil`/`validFrom` がちょうど1マイクロ秒だけ違う組が正しく
  重なると判定され、ちょうど一致する組（重ならない）には行が張られないこと
  （`mark-contested-group-microsecond-boundary.postgres.test.ts`）。
- fix2: Postgres・InMemory の両方で、群の一部だけを渡す `resolveContestedGroup` が
  専用のエラー（`ContestedGroupMembershipMismatchError`、§2.4）になり、何も書かれない
  こと（`memory-store-conformance.ts`）。Runtime 層は `relationStore` の配線有無に
  関わらずこれを `ineligible` に写すこと（`resolve-contested-group.test.ts`）。
- Runtime 層: `Runtime.markContestedGroup?`/`resolveContestedGroup?` の ineligible 分類・
  CAS・TOCTOU（`mark-contested-group.test.ts`・`resolve-contested-group.test.ts`）。
- 検出層: `relationStore` を配線しない呼び出しが PR1 の挙動を変えないこと（PR1 の
  全6ファイルを再実行し、1文字も変更せず緑のまま通ることを確認）。穴Aの吸収・合併
  （2つの既存群の統合）・`relationStore` 無しでのフォールバックが期待通り動くこと
  （`claim-key-contested-group-detection.test.ts`）。
- recall 段3: 群のうち1件だけが候補に上がると残りが同伴取得されること・隣接すること・
  群を離れたメンバーが含まれないこと・上限（`validFrom` 降順→`id` 順）で切られ
  `over_limit(stage:'relation')` に積まれること・`relationStore` 未配線時に
  `stage_skipped(stage:'relation')` が積まれ群が単独で出ないこと・候補が無ければ
  どちらの omission も積まれないこと（`recall-relation-group-companion.test.ts`
  6件・`recall-relation-group-companion.postgres.test.ts` 3件、Fake・本物の Postgres
  両方）。赤（別 worktree、bc239f9 を起点）・変異試験（段3の上限の
  `slice` を無効化し、狙った歯だけが赤くなることを確認）。
- **さらなる直し（§5.4）**: A-B・A-C がつながり B-C はつながっていない形で、B を引くと
  A・C まで幅優先で並ぶこと（owner から2ホップ先の companion が実際に見つかることを
  実測——`recall-relation-group-companion.test.ts`・`.postgres.test.ts` にそれぞれ新しい
  `it` を1本追加、7件・4件）。1段だけの実装（bc239f9）に対しては赤くなることを、別
  worktree（bc239f9 起点）で確認した。§5.3 で足した「群が11件以上なら10件で切れる」歯
  （星型トポロジ、BFS が1段で自然に尽きるケース）が、この直しでも緑のまま通ることを
  確認した——ただし `explorationTruncated`（安全弁で打ち切った場合）が `true` になる
  ケース（`countKind: 'lower_bound'`）の歯は書いていない（下記「確かめていないこと」）。

**確かめていないこと**:
- `@mnemora/openai`/`@mnemora/anthropic`/`@mnemora/bullmq` など、`packages/core`/
  `packages/postgres`/`packages/testkit` 以外のパッケージへの影響（この PR はこれらを
  変更していないため、影響は無いはずだが、実際に動かしては確認していない）。
- 大規模な `memory_relations` グラフ（数百〜数千件規模）での `markContestedGroup`/
  `resolveContestedGroup`/`detectClaimKeyContested`/recall 段3の合併ロジックの性能。
- **探索自体の安全弁（訪れた数が `maxCount` の10倍＝100件を超えたら打ち切る）が実際に
  発動するケース**（`over_limit(stage:'relation')` の `countKind` が `'lower_bound'` に
  なる歯）は書いていない——100件規模の群を作る歯のコストと、この回で明示された歯
  （A-B-C の多段・11件以上での上限）の範囲を優先した。§7 負債5として記録した。

---

## 9. 段階Aで確定した11個の決定【伝】

冒頭の注記が言う「段階Aで確定した11個の決定」を、ここに番号付きで残す。いずれも
オーナー側クローン（miku）が決め、マネージャー経由で渡された前提である（伝聞の1段）。
コードや歯の中の「ADR 0381 決定N」は、この節の番号を指す。

### 決定1: 関係の行は、有効期間が重なる組の間にだけ張る

群はひとまとまりに扱うが、`memory_relations` の行を張るのは互いに有効期間が重なる
組だけにする。[ADR 0378](./0378-claim-key-contested-detection-covers-contested-matches.md)
決定2（3件以上は完全グラフ）は、**「一致した全員を結ぶ」ではなく「互いに重なる者どうしは
全部結ぶ」と読み替えた**。

**理由**: [ADR 0324](./0324-claim-key-contested-detection.md) 決定4 は、有効期間の重なりを
矛盾の必要条件にしている。対 A-B に、A とだけ重なる C が来たとき、完全グラフのまま B と C を
結ぶと、根拠の無い組（例: 2020年は東京、2024年は大阪——両方とも正しいことがありうる）を
`contested` と記録してしまう。重なりの判定を Postgres では SQL の1か所に寄せたことは §1 を見ること。

### 決定2: C が別々の群や対の両方に一致したら、合併する

合併した群でも、行は決定1に従って張る（組み立ては §4.2）。

### 決定3: N者の解消は2者の意味を広げ、関係の行の扱いも2者に揃える

勝者を選べば勝者は `active`、ほかは `superseded`。`both_active` なら全員 `active`。
**どちらでも、メンバーを結んでいた関係の行を消す**——2者の `resolveContestedPair` が
決着の種類によらず `contested_with_id` を NULL にするのと揃える。「一度解消したら再び
争わせない」印は作らない。後から同じ鍵の新しい記憶が来て一致すれば、それは新しい矛盾で
あり、また群になる。

### 決定4: recall 段3は、`contestedWithId` の無い contested から群をたどる

上限は10件（`DEFAULT_RECALL_ASSOCIATION.maxCount`、ADR 0378 決定6）。`validFrom` の
新しい順、同じなら id の順で残し、切った件数を `over_limit`（`stage: "relation"`）に出す。
探索の深さは §5.4 を見ること（1段から、関係の行でつながった全員へ変わった）。

### 決定5: 穴A —— 対 A-B に C が来たら、A・B の列を空にして表へ移す

1トランザクションで、id 昇順に `FOR UPDATE` でロックし、CAS（A・B は `contested` で
互いを指す、C は `active`）を確かめてから、A・B の `contested_with_id` を NULL にし、
C を `contested` にし、関係の行と `memory_events` を書く。3件から2件に戻っても表のまま
（ADR 0378 決定4）。

### 決定6: `RelationStore` が配線されていない store では、記録だけを積む

状態を動かさず `claim_key_conflict_unresolved` を積む（ADR 0378 決定5）。この経路の
振る舞いは PR2 でも変えない。

### 決定7: port の形 —— 書き込みは `MemoryStore` の任意メソッド、読み取りは `RelationStore`

群の書き込み（作成・穴A の合流・合併）は `memories` の状態と関係の表を同じトランザクションで
書くので、`MemoryStore.markContestedGroup?`/`resolveContestedGroup?` に置く
（`createMemoryWithOutbox`・`markContestedPair` と同じ作法）。読み取りは新しい port
`RelationStore`（`stores.relations?` で任意に配線）に置く。

### 決定8: `ContestedDetectionOutcome.result` に `contested_group` を足す

起きる条件は、`RelationStore` があって「一致が2件以上」または「一致が `contested` の
1件だけ」のとき（§4.1）。union に値を足すだけなので、破壊的には数えない。

### 決定9: 群のメンバーに2者の `resolveContested` を呼ぶと `ineligible` になる

群のメンバーは `contestedWithId` を持たないので、今の CAS のままでそうなる。新しい処理は
足さず、歯で縛る。

### 決定10: 群から抜けたメンバーの関係の行は残す。purge は関係の表に触らない

forget・supersede・purge・archive で抜けたメンバーの行は消さない（今の `contestedWithId`
と同じ扱い）。recall 段3は、`contested` でない相手を status の門で弾く。関係の行は
memory の id しか持たず本文を持たないので、purge は触らない。そのかわり、purge の後に
残るものの一覧（[ADR 0375](./0375-purge-scope-widened.md) の (b)）に「`memory_relations`
の行」を足した（0375 は採用済みなので、末尾に日付付きの追記で足した）。

### 決定11: migration は ADR 0292 決定1 の形。既存の2者データは動かさない

`memory_relations`（`tenant_id`、from/to は `REFERENCES memories(id)`、`kind` は CHECK で
`'contradicts'` だけ、UNIQUE、from/to の索引2本、1組につき向きを変えて2行）。
backfill はしない（ADR 0378 決定1 の (ii)）。

---

## 10. CI で見つかった、表と port の一覧の追随（2026-09-30）【判】

migration 0026 と `RelationStore` の実体ができたことで、表・索引・port の一覧を縛る歯が
CI で赤くなった（run 36618996608）。どれも数を緩めず、一覧を実物に合わせた:

- `packages/postgres/README.md` の「この package が作るオブジェクト」（テーブル 11→12、
  索引 24→26）と、`scripts/__tests__/readme-postgres-objects-lib.test.mjs` の回帰止め。
- `packages/postgres/src/__tests__/migrate-concurrency.test.ts` の表の一覧に `memory_relations`。
- `docs/memory-model.md` の `memory_relations` の DDL は、`kind` に4値を持つ Phase 2 の
  下書きのままだった——実物（`'contradicts'` の1値）に書き直した。値が1つの `IN` は
  Postgres が `=` に畳んで返すので、`memory-model-doc-ddl-defaults.postgres.test.ts` の
  CHECK の読み取りをその形にも広げた。
- `RelationStore` は [ADR 0273](./0273-architecture-section5-is-a-copy.md) の「予告」から
  「写し」へ移し、§5 の port の写しを縛る歯の対象に入れた（0273 の末尾の追記）。
