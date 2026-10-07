# ADR 0691: 09/16 にマージされた G3（core の validAt・減衰の時計・halfLifeRecalls）3本の確かめ直しで見つかった穴に歯を足す（Issue #1815）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1815](https://github.com/takecchi/mnemora/issues/1815) の G3。
これは試験だけの変更で、実装・`*-conformance.ts`・`__fixtures__/` は触らない。変異は一時的に当てただけで、控えを `cp` で取り、`cp` で戻して `cmp` で一致を確かめた。

## 経緯【実測】

2026-09-16（UTC）にマージされた #334（`validAt` ゲート、ADR 0164）・#335（減衰の時計を2本にする、ADR 0165）・#416（`setDefaultHalfLifeRecalls`、ADR 0197）に、変異を当てた。

| PR   | 変異                                            | 穴               |
| ---- | ----------------------------------------------- | ---------------- |
| #334 | 83（core 32・postgres 32・testkit fixture 19）  | 9                |
| #335 | 127（core 55・postgres 41・testkit fixture 31） | 6（等価4を除く） |
| #416 | 16（postgres 9・testkit fixture 7）             | 2                |

core は関係する試験を名指し（穴の候補は core 全体385ファイルでも緑を確かめた）、postgres・testkit は手元の PG17（`DATABASE_URL` あり。skip は基準と同数）で、`validFrom`・`decayClock` などを含む試験を名指しして走らせた。狭い集合で緑だったものは、広い集合で測り直した（#334 の `createObservation` の書き込み4本は広げると赤だったので穴ではない）。

## 今の約束に当てたもの（後の ADR での変化）

- #335: [ADR 0165](./0165-decay-activity-clock.md) の追記2（Issue #1014）が「`'wall'` の間に作られた記憶は、活動時計の3つ組が `NULL` で、後から `'activity'` に切り替えても活動時計では沈まない」を契約にした。決めたこと5の「`decay_base_seq` も 0 になる」より後は、この契約で読む。
- #335: [ADR 0353](./0353-activity-counting-per-call.md) が subject 単位のカウンタ `S_x` を足した。ゲート・集計・掃引・書き込みの起点は常に `T + S_x`（その記憶自身の subject。[ADR 0394](./0394-activity-clock-writes-use-memorys-own-subject.md)）。`'wall'` のテナントは `tenant_activity` を読まない（決めたこと16）は変わっていない。
- #335: [ADR 0395](./0395-create-recall-activity-clock-single-statement.md) が `createRecall` のカウンタ更新を1文にした（意味は同じ）。
- #334: [ADR 0172](./0172-association-passes-decay-and-validity-gates.md) が連想枠にも `validAt` を通し、[ADR 0173](./0173-decayed-omission-counted-by-aggregate-scope.md) が件数の集計を `aggregateScope` に集めた。[ADR 0203](./0203-memories-omitted-exclusivity.md) 以降、`filtered` の条件どうしが排他という約束は無い。逆転した区間（`validFrom > validUntil`）は `expired` と `not_yet_valid` の両方に1件ずつ数える（`Observation.validFrom` の TSDoc、[ADR 0473](./0473-validity-empty-inverted-interval-no-overlap.md)）。この約束を歯にした。
- #334: ADR 0473 の M2 が、`validAt` 既定（`now`）のゲートはいま実際に期限切れの記憶を落とすと書き直した。
- #416: ADR 0197 のとおり、`setDefaultHalfLifeRecalls` は新規作成時の初期値だけを書き、既存の記憶・別テナント・同じテナントの別の欄は動かさない。撤回・狭まった約束は見つからなかった。

## すり抜けと足した歯【実測】

穴は17本（#334 9・#335 6・#416 2。同じ原因の fixture 版を別に数えている）。

- #334（core）: `omitted` の `expired`・`not_yet_valid` の件数を、互いに足す・1に丸める変異が緑だった。`recall-validity-clock-recheck-0916.test.ts` が、期限切れ3・未発効2・有効1で件数をそのまま名乗ることを見る。
- #334（postgres・testkit fixture）: 語彙チャンネルの `valid_from <= validAt` の境界（`validFrom` がちょうど `validAt` なら返る）、`aggregateScope` の期限切れ・未発効の件数が `status` が有効な記憶だけを数えること、逆転した区間を両方に1件ずつ数えること。`validity-gate-recheck-0916.postgres.test.ts` が InMemory と Postgres の両方で見る。
- #335（core）: `'wall'` のテナントの `recall()` が `getActivitySeq` を読む変異、`'either'` のテナントで作った記憶に活動時計の3つ組が付かない変異。同じ core ファイルが見る。
- #335・#416（postgres・testkit fixture）: `setDecayClock` が同じテナントの `default_half_life_recalls` を戻す・別テナントの時計を書く変異、`setDefaultHalfLifeRecalls` が別テナントの値を書く変異。`tenant-clock-settings-recheck-0916.postgres.test.ts` が両実装で、別テナントと同じテナントの別の欄が動かないことを見る。

穴の変異はすべて、足した歯で赤・戻して緑・`cmp` 一致を確かめた。`TenantSettingsStore` の適合テストに「別テナントを書かない」が無いこと、語彙チャンネルの適合テストに左端の境界が無いことが根にあるが、`*-conformance.ts` は変えない（適合テストを足すかはオーナーの領分）。

## 等価と判断した根拠【判断】

- `'wall'` で `decayFloorSeqAfter` を渡す変異: `'wall'` のとき `nowSeq` が `undefined` なので、渡る値も `undefined`。
- `decayFloorAnyAxis` を `'activity'` でも立てる変異: `VectorFilter.decayFloorAnyAxis` の契約が「両軸が与えられたときだけ OR。片方だけなら無視」。
- 掃引の活動軸の `IS NOT NULL` を外す変異: `NULL <= n` は偽で、`WHERE` では同じ。
- testkit fixture の `reinforce` が `halfLifeRecalls` 無しでも3つ組を書く変異: `activityBaseSeq` が `halfLifeRecalls` 非 null のときだけ作られるので、同じ結果。
- `updated_at` を更新しない変異: interface から見えない。
- Postgres の `setDefaultHalfLifeRecalls` の値域検査（`assertValidHalfLifeRecalls`）を外す変異は緑のまま。float4 の検査と DB の CHECK が肩代わりすると読んだが、負数の経路は実測していない。

## 決定【判断】

1. 実装・`*-conformance.ts`・`__fixtures__/` は変えない。足すのは試験（core 1・postgres 2）と、この ADR だけである。
2. 歯は今の約束より強い縛りにしない。逆転した区間を両方に数えるのは TSDoc に書かれた今の約束で、排他にする変更は別の判断になる。
3. 実バグは見つからなかった。

## 確かめていないこと

- `examples/chat`（測定・デモの道具）には変異を当てていない。
- #416 の公開 API の snapshot（`scripts/__snapshots__/public-api`）と `api:check` への変異は当てていない。
- core の Fake（`runtime-fakes.ts`）への変異。
- 全テストは流していない。関係するファイルを名指しして走らせた。CI の結果はこの時点では見ていない。
