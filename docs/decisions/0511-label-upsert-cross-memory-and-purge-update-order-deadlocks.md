# ADR 0511: 記憶をまたぐ `upsertProposedLabels` の順と、purge/scrub の `UPDATE labels … FROM counted` の更新順が、並行する書き込みと 40P01 になる（ADR 0476 の負債1・2）。再現と直し方の草案

- **状態**: 未決 (2026-10)（草案。再現の歯までを置いた。`packages/postgres/src/memory-store.ts` の直しは、同じファイルを触る #1625 のマージ後に入れ、そのとき状態を「採用」にする）
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-44ffeb19 の指示による）が書いた。オーナーではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: [ADR 0476](./0476-label-upsert-lock-order-and-taxonomy-probes.md) は、1つの記憶の中のラベルの並びを名前順に固定した（#1583）。「引き受けた負債」の1・2は「走らせていない【未確認】」で残った。本 ADR はそれを走らせた。

- **穴（直す前）**【実測】:
  - 歯: `packages/postgres/src/__tests__/label-lock-order-cross-memory.postgres.test.ts`。確実に起こすため、`labels` に `BEFORE UPDATE … FOR EACH ROW` で 0.2 秒眠るトリガを、テストの間だけ付ける（行ロックは眠る間も掴んだまま。`ON CONFLICT DO UPDATE` は行ロックの後に BEFORE トリガが走る。AFTER トリガは文の終わりまで遅れるので使えない——最初に AFTER で作ったら purge/scrub が再現しなかった）。実装の SQL は変えず、外から呼ぶだけ。
  - **負債1: 再現した**。2つの呼び出しが、`news` の語彙を逆の並びで持つ（呼び出し1が `[{tags:["a"]},{tags:["b"]}]`、呼び出し2が `[{tags:["b"]},{tags:["a"]}]`）。
    - `supersedeWithNewMemories`: 片方が `40P01`（`INSERT INTO labels … ON CONFLICT` の Failed query）で落ちる。
    - `createMemoriesWithOutboxAndEvents`: **例外にならない**。候補ごとの SAVEPOINT が失敗を `dropped` に積むので、**deadlock の被害者の候補が黙って落ちる**（`written` が 3 件、`dropped` に 40P01）。呼び手は `dropped` を見なければ気づかない。ADR 0476 の負債1の「緊急度 低」を、この点で見直す材料になる【判断】。
  - **負債2: 再現した**（条件つき）。`purgeMemory`／`scrubPurged` の `UPDATE labels … FROM counted` の更新順は名前順ではない。
    - 条件: テナントの `labels` が多い（3000 行 + `ANALYZE`）。そのとき計画は Hash Join で、更新順はハッシュ順（実測の例: `z01000,z00010,z02500,z00200,z02999,z02000`）。**`labels` が小さい（6 行）と索引順（名前順）で更新され、作成の名前順とそろって起きない**【実測】（プローブ。歯は 3000 行を入れて条件を作る）。
    - 起こし方: purge/scrub が先に行を掴んで眠っている間に、隣り合う2語 `[n_k, n_{k+1}]` を持つ記憶の作成を 5 本入れる。更新順が昇順でない限り（1/720 で昇順になれば起きない）、どこかの組で逆順になる。
  - 歯の結果（直す前、`label-lock-order-cross-memory.postgres.test.ts`）: 5 本中、対照 1 本が緑、残り 4 本（supersede・createMany・purge・scrub）が赤（40P01）。7 回実行して、4 本とも赤が 6 回、scrub が緑に抜けたのが 1 回（purge と scrub の更新順は id 次第で、まれに噛まない【実測】）。
  - **対照**: 眠るトリガだけでは落ちない。同じ順 `[a, b]` の2つの `createMemoriesWithOutboxAndEvents` は、トリガ入りで両方成功し `dropped` も空（緑）。つまり赤の原因はトリガではなく、逆の順である。陽性対照（わざと逆順にすると落ちる）は赤の4本そのもの。

- **直し方の案**（まだ決めていない。#1625 のマージ後に決める）:
  1. **負債1: 全記憶の語彙を集めて名前順に先に upsert する。** `news` 全体の `tags` を集め、重複を潰し `sort()` して、`labels` を1回で（名前順に）upsert する。記憶ごとの `memory_labels` の結び付けは、その後。`proposedCount` は「記憶 1 件につき +1」を保つため、記憶をまたぐ数え方を設計し直す必要がある（1 記憶 1 回の `+1`〔`createMemoriesWithOutboxAndEvents` の SAVEPOINT で落ちた候補の分は数えない〕を守る）。**SAVEPOINT で候補が落ちる口（`createMemoriesWithOutboxAndEvents`）では、候補ごとの upsert の前に語彙を先取りすると、落ちた候補の語彙まで `proposed` で作ってしまう**。この口は、先に `SELECT … FOR UPDATE`（名前順）で既存行のロックだけを先に取る、が現実的【判断】。
  2. **負債2: `counted` を `label_id` 順に並べ、先に `FOR UPDATE` で取る。** `SELECT … FROM labels WHERE id IN (…) ORDER BY id FOR UPDATE` を挟んでから `UPDATE`。ただし **作成側は名前順、purge 側が id 順では、二つの順がそろわない**。順を揃える相手は作成側（名前順）なので、purge/scrub のロックも **名前順**（`ORDER BY name`）で取るのが正しい【判断】。`labels` に `(tenant_id, name)` の一意制約があるので、`ORDER BY name` は決まった順になる（コードポイント順にするかは ADR 0316 系の `listLabels` の並びと照らす。照合順序に依存しない比較にそろえること）。
  3. **1つに決まるもの【判断】**: 負債1・2とも「`labels` の行ロックは、どの経路でも **名前順** で取る」に揃える。負債1は(1)の先取り（または SAVEPOINT のある口は `FOR UPDATE` の先取り）、負債2は名前順の `FOR UPDATE` の先取り。どちらも `Memory.tags`・`proposedCount`・`memory_labels` の中身は変えず、落ちる入力が減るだけ。マイグレーションは無い。
  4. 採らない案: deadlock を捕まえて再試行する（ADR 0476 と同じ理由——方針が `MemoryStore` 全体になる。ただし `createMemoriesWithOutboxAndEvents` の `dropped` に 40P01 が混ざる点は、再試行ではなく原因を消すほうで直す）。

- **歯の置き方**: 直す前は赤（上の実測）。直しを入れた PR で緑にする。`it.fails` は使わない。WIP の間は Draft PR の CI が赤になる（Draft なので可と指示された）。

- **引き受けた負債（材料）**:

  | # | 負債 | 結果 | 緊急度 | 覆る条件 |
  |---|---|---|---|---|
  | 1 | 歯は眠るトリガ（0.2 秒）で順序を固定している。本番の並行の起きやすさ（頻度）は測っていない | 再現はしたが、「実運用でどれだけ起きるか」は言えない | 中（`createMemoriesWithOutboxAndEvents` は黙って候補が落ちる） | 運用で `dropped` に 40P01 が出たと報告されたとき |
  | 2 | 負債2は labels が多いテナントの計画（Hash Join）に依存する。計画が変わる Postgres の版・統計では起きない／別の順で起きる | 歯は `ANALYZE` 後の 3000 行で条件を作る | 低〜中 | 計画が変わって歯が偽陰性になったとき（対照の緑が崩れたら気づける作りではない） |
  | 3 | `labels` 以外の表（`memory_labels`・`tenant_activity` など）の行ロックの順は、本 ADR でも見ていない | 未確認 | 不明 | — |

- **これが覆るとしたら**: ADR 0476 と同じく、呼び手が語彙を 1 回の呼び出しにまとめる設計（バッチの作成口）になったとき。

- **測っていないこと**: 上の頻度。`registerLabel` どうし・`registerLabel` と purge の同時実行。接続数がプールの上限を超えるときの待ち。`resolveContestedPair` など他の経路の `labels` の触り方。
