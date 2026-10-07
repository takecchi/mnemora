[
  {
    "name": "reinforce の addOwnSubjectSeq は、nowSeq + S_x（と床）が bigint を溢れるなら断る > S_x = %i: 例外で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-reinforce-seq-overflow.test.ts",
    "location": {
      "line": 29,
      "column": 33
    }
  },
  {
    "name": "reinforce の addOwnSubjectSeq は、nowSeq + S_x（と床）が bigint を溢れるなら断る > reinforceMany も同じ（1件目で落ちる）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-reinforce-seq-overflow.test.ts",
    "location": {
      "line": 40,
      "column": 3
    }
  },
  {
    "name": "reinforce の addOwnSubjectSeq は、nowSeq + S_x（と床）が bigint を溢れるなら断る > やりすぎ: 溢れない境界（S_x = 374）は通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-reinforce-seq-overflow.test.ts",
    "location": {
      "line": 47,
      "column": 3
    }
  },
  {
    "name": "reinforce の addOwnSubjectSeq は、nowSeq + S_x（と床）が bigint を溢れるなら断る > やりすぎ: S_x が 0（カウンタ無し）・nowSeq が小さいときは通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-reinforce-seq-overflow.test.ts",
    "location": {
      "line": 53,
      "column": 3
    }
  },
  {
    "name": "reinforce の addOwnSubjectSeq は、nowSeq + S_x（と床）が bigint を溢れるなら断る > やりすぎ: addOwnSubjectSeq でなければ S_x を足さないので通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-reinforce-seq-overflow.test.ts",
    "location": {
      "line": 64,
      "column": 3
    }
  },
  {
    "name": "reinforce の addOwnSubjectSeq は、nowSeq + S_x（と床）が bigint を溢れるなら断る > やりすぎ: 何も書かない呼び出し（起点より古い at）は、溢れる組み合わせでも断らない（Postgres の SET は評価されない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-reinforce-seq-overflow.test.ts",
    "location": {
      "line": 71,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.requeueEmbedJobs: limit のガードは非整数を先に見る > limit=-1.5 は「must be an integer」で断り、何も積み直さない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-requeue-embed-jobs-limit-order.test.ts",
    "location": {
      "line": 11,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.requeueEmbedJobs: limit のガードは非整数を先に見る > limit=-1 は「must not be negative」で断る（整数の負数）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-requeue-embed-jobs-limit-order.test.ts",
    "location": {
      "line": 31,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.requeueEmbedJobs: 壊れた limit を渡すと Postgres と同じく例外を投げ、1件も積み直さない > limit=${limit} は例外を投げ、embeddingStatus も outbox も変えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-requeue-embed-jobs-limit.test.ts",
    "location": {
      "line": 26,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore.requeueEmbedJobs: 壊れた limit を渡すと Postgres と同じく例外を投げ、1件も積み直さない > limit=${limit} は ${expected} 件を積み直す（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-requeue-embed-jobs-limit.test.ts",
    "location": {
      "line": 49,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore.resolveOrphanedContested（Issue #825） > CAS を満たせば生存側を active に戻し、contestedWithId を null にする。対向（forgotten）には触れない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-resolve-orphaned-contested.test.ts",
    "location": {
      "line": 40,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.resolveOrphanedContested（Issue #825） > id が存在しなければ「memory not found」を投げ、何も書き込まない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-resolve-orphaned-contested.test.ts",
    "location": {
      "line": 63,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.resolveOrphanedContested（Issue #825） > CAS 破れ（status が contested でない）: MemoryStatusConflictError を投げ、行は無傷",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-resolve-orphaned-contested.test.ts",
    "location": {
      "line": 76,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.resolveOrphanedContested（Issue #825） > CAS 破れ（contestedWithId が一致しない）: MemoryStatusConflictError を投げ、行は無傷",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-resolve-orphaned-contested.test.ts",
    "location": {
      "line": 99,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.resolveOrphanedContested（Issue #825） > 渡された event の kind・actor・digestSnapshot・meta をそのまま積む",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-resolve-orphaned-contested.test.ts",
    "location": {
      "line": 120,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore — restore/resolve 系の付随データ保全（Issue #809） > resolveContestedPair(supersede) は付随データを、status/contestedWithId/supersededById/updatedAt 以外そのまま保つ（勝者・敗者とも）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-restore-carryover.test.ts",
    "location": {
      "line": 101,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore — restore/resolve 系の付随データ保全（Issue #809） > updateStatusWithEvent の kind='restored' は付随データを、status/updatedAt 以外そのまま保つ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-restore-carryover.test.ts",
    "location": {
      "line": 141,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore — restore/resolve 系の付随データ保全（Issue #809） > restoreSupersededBy は付随データを、status/supersededById/updatedAt 以外そのまま保つ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-restore-carryover.test.ts",
    "location": {
      "line": 166,
      "column": 3
    }
  },
  {
    "name": "%s: nowSeq + S_x が bigint を溢れるなら断る > S_x = %i: 例外",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 83,
      "column": 23
    }
  },
  {
    "name": "%s: nowSeq + S_x が bigint を溢れるなら断る > S_x = 807（溢れない境界）・0 は通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 87,
      "column": 3
    }
  },
  {
    "name": "%s: nowSeq + S_x が bigint を溢れるなら断る > usesSubjectCounters が false なら、S_x がいくつでも通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 91,
      "column": 3
    }
  },
  {
    "name": "%s: nowSeq + S_x が bigint を溢れるなら断る > subject を持たない記憶は S_x を引かないので通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 94,
      "column": 3
    }
  },
  {
    "name": "%s: nowSeq + S_x が bigint を溢れるなら断る > decay_floor_seq が NULL の行は式が評価されないので通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 97,
      "column": 3
    }
  },
  {
    "name": "式が評価される行が無ければ、溢れても通る > archiveDecayed: 壁時計の clock は nowSeq を見ない。archived の行は対象の絞りで落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 105,
      "column": 3
    }
  },
  {
    "name": "式が評価される行が無ければ、溢れても通る > archiveDecayed clock: either は、壁時計が沈んでいない行で活動時計の式を評価しない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 112,
      "column": 3
    }
  },
  {
    "name": "式が評価される行が無ければ、溢れても通る > aggregateScope: スコープ内でない行（archived）では評価しない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 125,
      "column": 3
    }
  },
  {
    "name": "式が評価される行が無ければ、溢れても通る > VectorStore.search: ほかの絞りで落ちる行では評価しない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 131,
      "column": 3
    }
  },
  {
    "name": "式が評価される行が無ければ、溢れても通る > VectorStore.search: ほかの絞りを通る行は、活動時計の条件で落ちる行でも評価される",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 137,
      "column": 3
    }
  },
  {
    "name": "壁時計と活動時計の2軸: 式の左（壁時計）で決まれば、右は評価されない > aggregateScope 既定: 壁時計が生きている=%s → 断る=%s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 147,
      "column": 5
    }
  },
  {
    "name": "壁時計と活動時計の2軸: 式の左（壁時計）で決まれば、右は評価されない > aggregateScope anyAxis: 壁時計が生きている=%s → 断る=%s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 155,
      "column": 5
    }
  },
  {
    "name": "壁時計と活動時計の2軸: 式の左（壁時計）で決まれば、右は評価されない > search 既定: 壁時計が生きている=%s → 断る=%s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 166,
      "column": 5
    }
  },
  {
    "name": "壁時計と活動時計の2軸: 式の左（壁時計）で決まれば、右は評価されない > search anyAxis: 壁時計が生きている=%s → 断る=%s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 174,
      "column": 5
    }
  },
  {
    "name": "nowSeq（decayFloorSeqAfter）そのものが bigint に収まらないなら、行が無くても断る > archiveDecayed clock: activity・either。壁時計の clock は nowSeq を見ないので通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 189,
      "column": 3
    }
  },
  {
    "name": "nowSeq（decayFloorSeqAfter）そのものが bigint に収まらないなら、行が無くても断る > aggregateScope・VectorStore.search",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-seq-sum-overflow.test.ts",
    "location": {
      "line": 196,
      "column": 3
    }
  },
  {
    "name": "(A) 後の操作で、受け取った値が遡って変わらない > createObservationWithOutbox の jobs: 後の claimBatch / complete で書き換わらない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 75,
      "column": 3
    }
  },
  {
    "name": "(B) 受け取った値を書き換えても、store の中身が変わらない > createObservation / getObservation の payload・attributes・Date",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 95,
      "column": 3
    }
  },
  {
    "name": "(B) 受け取った値を書き換えても、store の中身が変わらない > createObservationWithOutbox の observation と jobs の payload",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 111,
      "column": 3
    }
  },
  {
    "name": "(B) 受け取った値を書き換えても、store の中身が変わらない > getRecall の入れ子（query・omitted・returnedMemories・explain）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 134,
      "column": 3
    }
  },
  {
    "name": "(B) 受け取った値を書き換えても、store の中身が変わらない > listLabels / registerLabel の要素と registeredAt",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 149,
      "column": 3
    }
  },
  {
    "name": "(B) 受け取った値を書き換えても、store の中身が変わらない > archiveDecayed の decayFloorAt",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 164,
      "column": 3
    }
  },
  {
    "name": "(B) 受け取った値を書き換えても、store の中身が変わらない > purgeExpiredEvents（dryRun）の oldestPurgedAt・newestPurgedAt",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 178,
      "column": 3
    }
  },
  {
    "name": "(B) 受け取った値を書き換えても、store の中身が変わらない > EventStore の append / get / list の meta・at",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 204,
      "column": 3
    }
  },
  {
    "name": "(B) 受け取った値を書き換えても、store の中身が変わらない > MemoryStore の *WithEvent が返すイベント",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 230,
      "column": 3
    }
  },
  {
    "name": "(B) 受け取った値を書き換えても、store の中身が変わらない > VectorStore.getVectors の vector",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 252,
      "column": 3
    }
  },
  {
    "name": "(B) 受け取った値を書き換えても、store の中身が変わらない > OutboxStore.claimBatch の payload・Date",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 263,
      "column": 3
    }
  },
  {
    "name": "(C) 書き込みに渡した入力を後から書き換えても、store の中身が変わらない > createObservation の payload・attributes・occurredAt",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 298,
      "column": 3
    }
  },
  {
    "name": "(C) 書き込みに渡した入力を後から書き換えても、store の中身が変わらない > createRecall の入れ子",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 311,
      "column": 3
    }
  },
  {
    "name": "(C) 書き込みに渡した入力を後から書き換えても、store の中身が変わらない > createRecall に渡した createdAt（Issue #1731）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 325,
      "column": 3
    }
  },
  {
    "name": "(C) 書き込みに渡した入力を後から書き換えても、store の中身が変わらない > purgeMemory に渡した event.at は purgedAt に写り、後から書き換えても動かない（Issue #1731）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 336,
      "column": 3
    }
  },
  {
    "name": "(C) 書き込みに渡した入力を後から書き換えても、store の中身が変わらない > EventStore.append の meta・at",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 365,
      "column": 3
    }
  },
  {
    "name": "(C) 書き込みに渡した入力を後から書き換えても、store の中身が変わらない > MemoryStore の *WithEvent に渡したイベントの meta・at",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 384,
      "column": 3
    }
  },
  {
    "name": "(C) 書き込みに渡した入力を後から書き換えても、store の中身が変わらない > VectorStore.upsert の vector",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 403,
      "column": 3
    }
  },
  {
    "name": "(C) 書き込みに渡した入力を後から書き換えても、store の中身が変わらない > MemoryStore.reinforce の at",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 414,
      "column": 3
    }
  },
  {
    "name": "(C) 書き込みに渡した入力を後から書き換えても、store の中身が変わらない > OutboxStore.claimBatch の now（claimedAt に写る）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 426,
      "column": 3
    }
  },
  {
    "name": "(C) 書き込みに渡した入力を後から書き換えても、store の中身が変わらない > OutboxStore.claimBatch の now（取り直しのとき availableAt に写る）（#1120）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-snapshots.test.ts",
    "location": {
      "line": 450,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.supersedeWithNewMemories: CAS に弾かれた対象のイベントは確かめない > %s でも、CAS に弾かれた対象は conflicted に積み、イベントを書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-supersede-cas-skipped-event.test.ts",
    "location": {
      "line": 36,
      "column": 22
    }
  },
  {
    "name": "InMemoryMemoryStore.supersedeWithNewMemories: CAS に弾かれた対象のイベントは確かめない > %s なら、CAS を通る対象は投げ、何も書かない（対照）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-supersede-cas-skipped-event.test.ts",
    "location": {
      "line": 52,
      "column": 22
    }
  },
  {
    "name": "InMemoryMemoryStore.supersedeWithNewMemories: CAS に弾かれた対象のイベントは確かめない > 1つ目が CAS に弾かれ（悪いイベント）、2つ目が通る（正しいイベント）なら、書くのは2つ目のイベントだけ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-supersede-cas-skipped-event.test.ts",
    "location": {
      "line": 66,
      "column": 3
    }
  },
  {
    "name": "ADR 0547: 読みの口は、下限より前の日時を断らない（Postgres は下限へ寄せてから比べる） > %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-timestamptz-floor.test.ts",
    "location": {
      "line": 143,
      "column": 19
    }
  },
  {
    "name": "ADR 0547: 読みの口は、下限より前の日時を断らない（Postgres は下限へ寄せてから比べる） > since 系は全件を返し、until 系は0件を返す（EventStore.list）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-timestamptz-floor.test.ts",
    "location": {
      "line": 153,
      "column": 3
    }
  },
  {
    "name": "下限より前の日時を、Postgres と同じ書く口で断る > %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-timestamptz-floor.test.ts",
    "location": {
      "line": 174,
      "column": 21
    }
  },
  {
    "name": "下限より前の日時を、Postgres と同じ書く口で断る > 断る入力は、何も書かない（行を作る口は、前の呼び出しの行を増やさない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-timestamptz-floor.test.ts",
    "location": {
      "line": 179,
      "column": 3
    }
  },
  {
    "name": "やりすぎ: 下限ちょうど・断らない口は通る > 下限ちょうど（4714-11-24 BC 00:00:00.000 UTC）は通る: %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-timestamptz-floor.test.ts",
    "location": {
      "line": 197,
      "column": 85
    }
  },
  {
    "name": "やりすぎ: 下限ちょうど・断らない口は通る > 下限ちょうどの now で outbox の行を書く口も通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-timestamptz-floor.test.ts",
    "location": {
      "line": 208,
      "column": 3
    }
  },
  {
    "name": "やりすぎ: 下限ちょうど・断らない口は通る > jobKinds が空なら now を見ない（Postgres は outbox へ INSERT しない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-timestamptz-floor.test.ts",
    "location": {
      "line": 222,
      "column": 3
    }
  },
  {
    "name": "やりすぎ: 下限ちょうど・断らない口は通る > purgeExpiredEvents・purgeExpiredRecalls・purgeCompletedJobs の olderThan は、下限より前でも0件で返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-timestamptz-floor.test.ts",
    "location": {
      "line": 234,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 作成後の書き込みは validFrom/validUntil を動かさない > updateStatus",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-validity-survives-writes.test.ts",
    "location": {
      "line": 30,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 作成後の書き込みは validFrom/validUntil を動かさない > updateStatusWithEvent（archived から active への復帰を含む）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-validity-survives-writes.test.ts",
    "location": {
      "line": 38,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 作成後の書き込みは validFrom/validUntil を動かさない > reinforce",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-validity-survives-writes.test.ts",
    "location": {
      "line": 60,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 作成後の書き込みは validFrom/validUntil を動かさない > purgeMemory（forgotten にしたあとの墓石化）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-validity-survives-writes.test.ts",
    "location": {
      "line": 70,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore: ベクトルは float4 に丸めて持つ > getVectors は保存したベクトルを float4 に丸めた値で返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-vector-float4.test.ts",
    "location": {
      "line": 26,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore: ベクトルは float4 に丸めて持つ > クエリも float4 に丸めて比べる（丸めると同じになるクエリは、同じ距離を返す）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-vector-float4.test.ts",
    "location": {
      "line": 34,
      "column": 3
    }
  },
  {
    "name": "行に日時を書く口: 下限（4714-11-24 BC 00:00:00 UTC）より前は、書く前に RangeError で断り、何も書かない（ADR 0640） > %s: 下限の1ms前・紀元前9001年は断る。何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-written-timestamptz-floor.test.ts",
    "location": {
      "line": 471,
      "column": 50
    }
  },
  {
    "name": "行に日時を書く口: 下限（4714-11-24 BC 00:00:00 UTC）より前は、書く前に RangeError で断り、何も書かない（ADR 0640） > %s: 下限ちょうど・1ms 後は通る（Postgres も下限ちょうどは通る。実測）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-written-timestamptz-floor.test.ts",
    "location": {
      "line": 489,
      "column": 50
    }
  },
  {
    "name": "行に日時を書く口: 下限（4714-11-24 BC 00:00:00 UTC）より前は、書く前に RangeError で断り、何も書かない（ADR 0640） > 例外は RangeError で、Invalid Date の例外（Error。文面は口ごと）とは別。Invalid Date の文面は変わらない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-written-timestamptz-floor.test.ts",
    "location": {
      "line": 504,
      "column": 3
    }
  },
  {
    "name": "Postgres が日時を見ない分岐は、下限より前でも断らない（やりすぎの歯。ADR 0640） > supersedeWithNewMemories: CAS に弾かれる対象のイベントの at は見ない（Postgres はイベントを書かない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-written-timestamptz-floor.test.ts",
    "location": {
      "line": 527,
      "column": 3
    }
  },
  {
    "name": "Postgres が日時を見ない分岐は、下限より前でも断らない（やりすぎの歯。ADR 0640） > supersedeWithNewMemories: 1つ目が CAS に弾かれて・2つ目が通るとき、書くのは2つ目のイベントだけ（1つ目の at は見ない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-written-timestamptz-floor.test.ts",
    "location": {
      "line": 546,
      "column": 3
    }
  },
  {
    "name": "Postgres が日時を見ない分岐は、下限より前でも断らない（やりすぎの歯。ADR 0640） > updateStatusWithEvent: CAS に弾かれたら at を見ず、MemoryStatusConflictError を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-written-timestamptz-floor.test.ts",
    "location": {
      "line": 567,
      "column": 3
    }
  },
  {
    "name": "Postgres が日時を見ない分岐は、下限より前でも断らない（やりすぎの歯。ADR 0640） > 冪等の既存行: created でない行には created イベントを作らないので、その at は見ない（2つの口）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-written-timestamptz-floor.test.ts",
    "location": {
      "line": 581,
      "column": 3
    }
  },
  {
    "name": "Postgres が日時を見ない分岐は、下限より前でも断らない（やりすぎの歯。ADR 0640） > createMemoriesWithOutboxAndEvents: 下限より前の欄を持つ候補だけが dropped になり、残りは書く（Postgres と同じ。実測）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-written-timestamptz-floor.test.ts",
    "location": {
      "line": 603,
      "column": 3
    }
  },
  {
    "name": "Postgres が日時を見ない分岐は、下限より前でも断らない（やりすぎの歯。ADR 0640） > recordUsageAndReinforce: 何も強化しない呼び出し（ids が空・記録済み）は at を見ない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-written-timestamptz-floor.test.ts",
    "location": {
      "line": 621,
      "column": 3
    }
  },
  {
    "name": "Postgres が日時を見ない分岐は、下限より前でも断らない（やりすぎの歯。ADR 0640） > claimBatch の now・purgeExpiredEventsByRetention の now は、Postgres が下限へ寄せるので断らない（ADR 0547）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-written-timestamptz-floor.test.ts",
    "location": {
      "line": 635,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: restoreSupersededBy・previewRestoreSupersededBy の onlyMemoryIds > preview: 大文字の id と形の崩れた id が混ざっても、小文字の同じ id の記憶だけが候補になる（#1195 T1）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-id-list-spelling-and-malformed.test.ts",
    "location": {
      "line": 35,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: restoreSupersededBy・previewRestoreSupersededBy の onlyMemoryIds > 実行: 大文字の id と形の崩れた id が混ざっても、小文字の同じ id の記憶だけが戻る（#1195 T1）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-id-list-spelling-and-malformed.test.ts",
    "location": {
      "line": 45,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: aggregateScope の digestBand.excludeMemoryIds > ${mode}: 大文字の id は同じ記憶として除外される（#1289 T1）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-id-list-spelling-and-malformed.test.ts",
    "location": {
      "line": 80,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: aggregateScope の digestBand.excludeMemoryIds > ${mode}: 形の崩れた id が混ざっても投げず、有効な2件の除外は両方とも効く（#1289 T2'）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-id-list-spelling-and-malformed.test.ts",
    "location": {
      "line": 90,
      "column": 5
    }
  },
  {
    "name": "D1: InMemoryMemoryStore.createMemory の decayFloorAt・lastReinforcedAt の Invalid Date > decayFloorAt が Invalid Date なら断り、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-input-checks-adr0493.test.ts",
    "location": {
      "line": 12,
      "column": 3
    }
  },
  {
    "name": "D1: InMemoryMemoryStore.createMemory の decayFloorAt・lastReinforcedAt の Invalid Date > lastReinforcedAt が Invalid Date なら断る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-input-checks-adr0493.test.ts",
    "location": {
      "line": 19,
      "column": 3
    }
  },
  {
    "name": "D1: InMemoryMemoryStore.createMemory の decayFloorAt・lastReinforcedAt の Invalid Date > 対照: 妥当な Date と null は通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-input-checks-adr0493.test.ts",
    "location": {
      "line": 28,
      "column": 3
    }
  },
  {
    "name": "D2: createObservationWithOutbox の opts.claimedBy の NUL > claimedBy に NUL があれば断り、観測も outbox の行も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-input-checks-adr0493.test.ts",
    "location": {
      "line": 52,
      "column": 3
    }
  },
  {
    "name": "D2: createObservationWithOutbox の opts.claimedBy の NUL > 対照: 行を書かないとき（jobKinds が空・冪等の既存の行）は claimedBy を見ない（Postgres は INSERT しない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-input-checks-adr0493.test.ts",
    "location": {
      "line": 65,
      "column": 3
    }
  },
  {
    "name": "D3: eraseTenant の limit（InMemoryMemoryStore・InMemoryVectorStore・InMemoryOutboxStore） > limit が ${limit} なら断る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-input-checks-adr0493.test.ts",
    "location": {
      "line": 85,
      "column": 5
    }
  },
  {
    "name": "D3: eraseTenant の limit（InMemoryMemoryStore・InMemoryVectorStore・InMemoryOutboxStore） > 対照: 0 と正の整数は通り、断ったときは何も消さない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-input-checks-adr0493.test.ts",
    "location": {
      "line": 100,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — filter.attributes は複数キーで AND（ADR 0312 決定5） > 複数キーの条件は、全キーが一致する記憶だけを返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-attributes-and.test.ts",
    "location": {
      "line": 31,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — filter.attributes は複数キーで AND（ADR 0312 決定5） > 属性が {} の記憶は、条件が1キーでもあれば返らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-attributes-and.test.ts",
    "location": {
      "line": 51,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — 非 ASCII の連なりの境目（Postgres に実測で揃える） > クエリ側: 非 ASCII の連なりは空白に落ちて前後の語を分ける（foo と bar の2語。つなげて foobar にしない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-non-ascii-run-boundary.test.ts",
    "location": {
      "line": 29,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — 非 ASCII の連なりの境目（Postgres に実測で揃える） > 本文側: ASCII でない Latin-1 の文字（ï）の前後で割れる（naïve は na・ï・ve。クエリ ve が当たる）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-non-ascii-run-boundary.test.ts",
    "location": {
      "line": 42,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — 非 ASCII の連なりの境目（Postgres に実測で揃える） > クエリ側: ASCII でない Latin-1 の文字（ï）も落として2語にする（na ve に当たる。na・ï・ve のフレーズにしない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-non-ascii-run-boundary.test.ts",
    "location": {
      "line": 57,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — 非ASCIIだけのクエリ・ASCII境界の分割を PostgresLexicalStore に揃える（Issue #951） > ギリシャ語（語末までギリシャ文字）を書いて、同じ語・小文字化した語のどちらで探しても0件（実測: 本物の Postgres は両方とも0件）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-postgres-alignment.test.ts",
    "location": {
      "line": 17,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — 非ASCIIだけのクエリ・ASCII境界の分割を PostgresLexicalStore に揃える（Issue #951） > 本文が「100」+ ケルビン記号(U+212A)のとき、クエリ「100k」は一致しない（実測: 本物の Postgres は両 regime とも0件）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-postgres-alignment.test.ts",
    "location": {
      "line": 37,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — 非ASCIIだけのクエリ・ASCII境界の分割を PostgresLexicalStore に揃える（Issue #951） > 同じ本文で、クエリ「100」（ASCII の連なりだけ）は一致する（実測: 本物の Postgres は両 regime とも1件）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-postgres-alignment.test.ts",
    "location": {
      "line": 56,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — 非ASCIIだけのクエリ・ASCII境界の分割を PostgresLexicalStore に揃える（Issue #951） > 同じ本文で、クエリ「k」単独は一致する（実測: UTF8 + en_US.UTF-8 regime。SQL_ASCII + C は0件——regime 依存、確かめていないことの節参照）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-postgres-alignment.test.ts",
    "location": {
      "line": 78,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — 非ASCIIだけのクエリ・ASCII境界の分割を PostgresLexicalStore に揃える（Issue #951） > 非ASCIIだけのクエリ（日本語）は0件を返す（実測: 本物の Postgres は両 regime とも0件）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-postgres-alignment.test.ts",
    "location": {
      "line": 98,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — Unicode正規化・全角半角は一致に効かない（Issue #952、docs/recall.md §3 の表） > café（NFC）を書き、café（NFD）で引くと一致しない（表1行目）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-postgres-alignment.test.ts",
    "location": {
      "line": 122,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — Unicode正規化・全角半角は一致に効かない（Issue #952、docs/recall.md §3 の表） > 全角ＡＢＣを書き、半角ABCで引くと一致しない（表2行目）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-postgres-alignment.test.ts",
    "location": {
      "line": 137,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — Unicode正規化・全角半角は一致に効かない（Issue #952、docs/recall.md §3 の表） > café（NFD、結合文字）を書き、cafe（無アクセントASCII）で引くと一致する（表3行目）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-postgres-alignment.test.ts",
    "location": {
      "line": 156,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — Unicode正規化・全角半角は一致に効かない（Issue #952、docs/recall.md §3 の表） > café（NFC）を書き、cafe（無アクセントASCII）で引くと一致しない（表4行目）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-postgres-alignment.test.ts",
    "location": {
      "line": 172,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — 回帰しないこと（Issue #951 の修正が既存の約束を壊していないか） > PROJ-1234 は大文字小文字を区別せず引ける（実測: 本物の Postgres は両 regime とも1件）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-postgres-alignment.test.ts",
    "location": {
      "line": 193,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — 回帰しないこと（Issue #951 の修正が既存の約束を壊していないか） > 日本語文中の ASCII 識別子（PROJ-1234の納期、間に空白なし）が引ける（実測: 本物の Postgres は1件）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-postgres-alignment.test.ts",
    "location": {
      "line": 219,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search: クエリの上限の境界（#919） > 全体の文字数: ちょうど上限の文字数のクエリの最後の語は、1文字も欠けずに使われる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-query-cap-boundary.test.ts",
    "location": {
      "line": 27,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search: クエリの上限の境界（#919） > 全体の文字数: 上限を1文字超えた分（601 文字目）は使われない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-query-cap-boundary.test.ts",
    "location": {
      "line": 39,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search: クエリの上限の境界（#919） > 語数: 重複（大文字小文字だけが違う語を含む）は上限の語数に数えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-query-cap-boundary.test.ts",
    "location": {
      "line": 51,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search: クエリの1語あたりの文字数の上限（Issue #878） > 上限（${LEXICAL_QUERY_MAX_WORD_CHARS}文字）を超えた語は、先頭からその文字数だけに切り詰められた形で使われる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-query-char-cap.test.ts",
    "location": {
      "line": 13,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search: クエリ全体の上限の境目にある書記素は、割らずに丸ごと落とす > 境目をまたぐ `e` + 結合記号は基底の `e` ごと落ち、手前の語幹だけが語になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-query-total-cap-grapheme.test.ts",
    "location": {
      "line": 33,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search: クエリ全体の上限の境目にある書記素は、割らずに丸ごと落とす > 境目をまたぐ書記素の基底の `e` だけを残した語は作らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-query-total-cap-grapheme.test.ts",
    "location": {
      "line": 39,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search: クエリ全体の上限の境目にある書記素は、割らずに丸ごと落とす > 境目の内側で終わる `e` + 結合記号は、そのまま語に残る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-query-total-cap-grapheme.test.ts",
    "location": {
      "line": 44,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search: クエリ全体の文字数の上限（Issue #878） > 上限（${TOTAL_CHARS_CAP}文字）を超えた後ろの部分は使われない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-query-total-chars-cap.test.ts",
    "location": {
      "line": 13,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search: クエリ全体の文字数の上限（Issue #878） > 上限に触れないクエリは1バイトも変わらない（通常のクエリの挙動は変わらない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-query-total-chars-cap.test.ts",
    "location": {
      "line": 40,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search: クエリの異なる語数の上限（Issue #878） > 上限（${WORD_COUNT_AT_CAP}）を超える語は使われない——上限より後ろにしかない語は一致に効かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-query-word-cap.test.ts",
    "location": {
      "line": 17,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search: クエリの異なる語数の上限（Issue #878） > 上限ちょうどの語数まではすべて使われる——上限内の語だけで一致する記憶は候補に残る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-query-word-cap.test.ts",
    "location": {
      "line": 43,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search: クエリの異なる語数の上限（Issue #878） > 重複する語をいくら増やしても結果は変わらない（異なる語の数だけが上限に効く）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-query-word-cap.test.ts",
    "location": {
      "line": 69,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search の並び: coverage・rank・recordedAt が同点なら memoryId の文字列順 > 作った順ではなく、memoryId の昇順（文字列順）で返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-tiebreak-order.test.ts",
    "location": {
      "line": 18,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search の並び: recordedAt は coverage・rank が同じときだけ効く > 新しくても rank が低い行は、古くて rank が高い行より後",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-tiebreak-order.test.ts",
    "location": {
      "line": 49,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search の並び: recordedAt は coverage・rank が同じときだけ効く > 新しくても coverage が低い行は、古くて coverage が高い行より後",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-tiebreak-order.test.ts",
    "location": {
      "line": 80,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — coverage/rank が完全一致したときの tie-break（LexicalStore.search doc / ADR 0175） > recorded_at が新しい方を先に返す（PostgresLexicalStore.search と同じ契約）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-tiebreak.test.ts",
    "location": {
      "line": 12,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — coverage/rank が完全一致したときの tie-break（LexicalStore.search doc / ADR 0175） > recorded_at まで完全一致したら memory_id 昇順にフォールバックする（欠落・重複が無い）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-tiebreak.test.ts",
    "location": {
      "line": 48,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search — query の単位は空白区切りの語で、語の中の token は隣接を要る（ADR 0513、Postgres に実測で揃える） > content ${JSON.stringify(content)} × query ${JSON.stringify(query)} → ${expected === null ? \"0件\" : `coverage ${expected}`}",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-lexical-store-token-match.test.ts",
    "location": {
      "line": 33,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore.listActiveClaimPredicates — 片方が欠けた claim key を数えない > 主語だけ・述語だけの claim key を持つ Memory は数えず、両方そろったものだけを返す（null を混ぜない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-list-claim-predicates-incomplete-key.test.ts",
    "location": {
      "line": 29,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.listActiveClaimPredicates: limit を Postgres と同じく検査する > limit=${limit} のとき例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-list-claim-predicates-limit.test.ts",
    "location": {
      "line": 25,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore.listActiveClaimPredicates: limit を Postgres と同じく検査する > limit が負数のとき例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-list-claim-predicates-limit.test.ts",
    "location": {
      "line": 33,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.listActiveClaimPredicates: limit を Postgres と同じく検査する > limit=${limit}（負かつ整数でない）は、先頭の検査＝整数の文面で拒む（#1157）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-list-claim-predicates-limit.test.ts",
    "location": {
      "line": 41,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore.listActiveClaimPredicates: limit を Postgres と同じく検査する > limit=2^53 は通り、全件を返す（#1157）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-list-claim-predicates-limit.test.ts",
    "location": {
      "line": 49,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.listActiveClaimPredicates: limit を Postgres と同じく検査する > limit が 2^63 以上のとき例外を投げ、2^63 未満で最大の double では投げない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-list-claim-predicates-limit.test.ts",
    "location": {
      "line": 56,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.listActiveClaimPredicates: limit を Postgres と同じく検査する > limit=0 は空配列、正の整数は今どおり先頭からその件数（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-list-claim-predicates-limit.test.ts",
    "location": {
      "line": 66,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.listLabels は name のコードポイント順で返す（Issue #881） > 🔴 大文字小文字・空白・記号が混在する名前でも、コードポイント順で返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-list-labels-codepoint-order.test.ts",
    "location": {
      "line": 7,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.listLabels は name のコードポイント順で返す（Issue #881） > 🔴 サロゲートペア（U+10000 以上）を含む名前でも、コードポイント順で返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-list-labels-codepoint-order.test.ts",
    "location": {
      "line": 23,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.listLabels は name のコードポイント順で返す（Issue #881） > 別の名前の接頭辞になっている名前は、短い方が先に返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-list-labels-codepoint-order.test.ts",
    "location": {
      "line": 40,
      "column": 6
    }
  },
  {
    "name": "InMemoryMemoryStore.listLabels は name のコードポイント順で返す（Issue #881） > 同じサロゲートペアで始まる名前は、その後ろの文字の順で返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-list-labels-codepoint-order.test.ts",
    "location": {
      "line": 53,
      "column": 6
    }
  },
  {
    "name": "InMemoryMemoryStore.listLabels は name のコードポイント順で返す（Issue #881） > U+FFFF（BMP の最後の1文字）で始まる名前は、1コード単位として読まれ、後ろの文字の順で返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-list-labels-codepoint-order.test.ts",
    "location": {
      "line": 66,
      "column": 6
    }
  },
  {
    "name": "testkit の fixture は memories の列挙の列に無い値を拒む > createMemory・createMemoryWithOutbox は列挙に無い ${field} を拒み、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-memory-enum-check.test.ts",
    "location": {
      "line": 53,
      "column": 5
    }
  },
  {
    "name": "testkit の fixture は memories の列挙の列に無い値を拒む > updateStatus・updateStatusWithEvent は拒み、状態もイベントも変えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-memory-enum-check.test.ts",
    "location": {
      "line": 78,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は memories の列挙の列に無い値を拒む > 見つからない id・CAS の食い違いは、列挙の検査より先に決まる（Postgres は更新する行が無ければ CHECK に届かない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-memory-enum-check.test.ts",
    "location": {
      "line": 96,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は memories の列挙の列に無い値を拒む > setEmbeddingStatus は拒み、状態を変えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-memory-enum-check.test.ts",
    "location": {
      "line": 114,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は memories の列挙の列に無い値を拒む > resolveContestedPair は拒み、2件とも contested のまま残し、イベントも書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-memory-enum-check.test.ts",
    "location": {
      "line": 128,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は memories の列挙の列に無い値を拒む > updateStatusWithEvent でも、見つからない id・CAS の食い違いは、列挙の検査より先に決まる（#1183）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-memory-enum-check.test.ts",
    "location": {
      "line": 158,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は memories の列挙の列に無い値を拒む > supersedeWithNewMemories の news[i] の列挙の外の値を拒み、何も書かない（#1183） > %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-memory-enum-check.test.ts",
    "location": {
      "line": 194,
      "column": 19
    }
  },
  {
    "name": "assertStorableMemoryColumn は、列ごとに列挙のすべての値を通し、近い綴りを拒む（#1183） > ${column}: 列挙のすべての値（${options.join(\", \")}）は通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-memory-enum-check.test.ts",
    "location": {
      "line": 253,
      "column": 5
    }
  },
  {
    "name": "assertStorableMemoryColumn は、列ごとに列挙のすべての値を通し、近い綴りを拒む（#1183） > ${column}: 近い綴り・ほかの列の値・列挙に無い値は、値の集合を名指しして拒む",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-memory-enum-check.test.ts",
    "location": {
      "line": 259,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 拒むとき、Memory・outbox・イベント・ラベルのどれも進めない（ADR 0630） > createMemoryWithOutbox: 冪等の既存の行が在っても拒み、outbox を積まない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-new-memory-rejects.test.ts",
    "location": {
      "line": 33,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 拒むとき、Memory・outbox・イベント・ラベルのどれも進めない（ADR 0630） > supersedeWithNewMemories: 壊れた news があれば、supersede の対象も動かさず、イベントも積まない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-new-memory-rejects.test.ts",
    "location": {
      "line": 43,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 拒むとき、Memory・outbox・イベント・ラベルのどれも進めない（ADR 0630） > createMemoriesWithOutboxAndEvents（3口の外。同じ入口を共有する）: 壊れた候補は dropped に積み、ほかは書く",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-new-memory-rejects.test.ts",
    "location": {
      "line": 77,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 範囲外は拒まない（ADR 0630） > createObservation は、attributes の値が文字列でなくても、この検査では拒まない（Observation は範囲外）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-new-memory-rejects.test.ts",
    "location": {
      "line": 101,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 範囲外は拒まない（ADR 0630） > createObservationWithOutbox も、attributes の値が文字列でなくても、この検査では拒まない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-new-memory-rejects.test.ts",
    "location": {
      "line": 111,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 範囲外は拒まない（ADR 0630） > tags の値・validFrom > validUntil は、この検査の対象ではない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-new-memory-rejects.test.ts",
    "location": {
      "line": 122,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 以前から拒む入力の例外の種類は、3口で揃う（ADR 0630） > %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-new-memory-rejects.test.ts",
    "location": {
      "line": 147,
      "column": 5
    }
  },
  {
    "name": "${kitName}: NUL・数値・日時・purgedAt の入力（Postgres と同じ入力で断る／通す） > ${c.expect === \"reject\" ? \"拒む\" : \"通る\"}: ${c.name}",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-nul-numeric-purged-at-postgres-alignment.test.ts",
    "location": {
      "line": 979,
      "column": 9
    }
  },
  {
    "name": "${kitName}: NUL・数値・日時・purgedAt の入力（Postgres と同じ入力で断る／通す） > createMemory に purgedAt を渡しても保存せず、null で読み戻る（断らない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-nul-numeric-purged-at-postgres-alignment.test.ts",
    "location": {
      "line": 994,
      "column": 7
    }
  },
  {
    "name": "${kitName}: NUL・数値・日時・purgedAt の入力（Postgres と同じ入力で断る／通す） > createMemoryWithOutbox に purgedAt を渡しても保存しない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-nul-numeric-purged-at-postgres-alignment.test.ts",
    "location": {
      "line": 1000,
      "column": 7
    }
  },
  {
    "name": "${kitName}: NUL・数値・日時・purgedAt の入力（Postgres と同じ入力で断る／通す） > purgedAt を渡して作った forgotten の Memory は、purgeMemory の対象になる（purged 済みの扱いにならない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-nul-numeric-purged-at-postgres-alignment.test.ts",
    "location": {
      "line": 1009,
      "column": 7
    }
  },
  {
    "name": "testkit の fixture は createObservation 系の Invalid Date を拒む > ${field}: 新しい行も、externalId が同じ既存の行も拒み、outbox にも積まない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-observation-invalid-date.test.ts",
    "location": {
      "line": 10,
      "column": 5
    }
  },
  {
    "name": "testkit の fixture は createObservation 系の Invalid Date を拒む > ${field}: 1970年より前の有効な日付は通り、同じ値で読み戻る（#1243。拒むのは Invalid Date だけ）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-observation-invalid-date.test.ts",
    "location": {
      "line": 38,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 壊れた候補を含む抽出結果（ADR 0630） > 壊れた候補だけを落として残りを書き、observe は投げない。落とした候補は created の meta に残る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-observe-new-memory-malformed-candidate.test.ts",
    "location": {
      "line": 72,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 壊れた候補を含む抽出結果（ADR 0630） > 全件が壊れていれば、observe は最初の例外のまま投げ、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-observe-new-memory-malformed-candidate.test.ts",
    "location": {
      "line": 95,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 壊れた候補を含む抽出結果（ADR 0630） > RuntimeConfig.extractorVersion が空文字なら、createRuntime が組み立ての時点で投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-observe-new-memory-malformed-candidate.test.ts",
    "location": {
      "line": 105,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — CAS で弾いたとき・通したときに、触れる行と列 > ${how}: expectedAttempts が行の attempts より${label}と OutboxLeaseConflictError を投げ、行は1列も変わらない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-complete-fail-cas-row.test.ts",
    "location": {
      "line": 39,
      "column": 7
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — CAS で弾いたとき・通したときに、触れる行と列 > ${how}: 同じテナントの、同じ attempts の別のジョブには終端を付けない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-complete-fail-cas-row.test.ts",
    "location": {
      "line": 52,
      "column": 5
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 先勝ち（ADR 0440） > complete → complete: completedAt は1回目のまま、戻り値は undefined",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-first-terminal-wins.test.ts",
    "location": {
      "line": 29,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 先勝ち（ADR 0440） > fail → fail: failedAt と lastError は1回目のまま、戻り値は undefined",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-first-terminal-wins.test.ts",
    "location": {
      "line": 39,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 先勝ち（ADR 0440） > complete → fail: completed のまま（値は1回目）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-first-terminal-wins.test.ts",
    "location": {
      "line": 49,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 先勝ち（ADR 0440） > fail → complete: failed のまま（値は1回目）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-first-terminal-wins.test.ts",
    "location": {
      "line": 59,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 先勝ち（ADR 0440） > purgeCompletedJobs の境界は1回目の completedAt で決まる（T1 < olderThan < T2）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-first-terminal-wins.test.ts",
    "location": {
      "line": 69,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 先勝ち（ADR 0440） > 終端後の claimBatch は0件（直す前と同じ）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-first-terminal-wins.test.ts",
    "location": {
      "line": 88,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 先勝ち（ADR 0440） > 例外は直す前と同じ: attempts 不一致は終端後でも OutboxLeaseConflictError、行が無ければ no-op",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-first-terminal-wins.test.ts",
    "location": {
      "line": 102,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 先勝ち（ADR 0440） > 最初の終端は今までどおり付く（at 省略で壁時計、NUL は置換）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-first-terminal-wins.test.ts",
    "location": {
      "line": 117,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 相手側の終端が既に付いていたら、後から来た呼び出しは行を変えない（Issue #826） > 逐次: complete → fail（同じ attempts）— completed のまま、failedAt/lastError は null",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-terminal-exclusive.test.ts",
    "location": {
      "line": 27,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 相手側の終端が既に付いていたら、後から来た呼び出しは行を変えない（Issue #826） > 逐次: fail → complete（同じ attempts）— failed のまま、completedAt は null",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-terminal-exclusive.test.ts",
    "location": {
      "line": 41,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 相手側の終端が既に付いていたら、後から来た呼び出しは行を変えない（Issue #826） > 同種の再呼び出し（complete → complete）は例外にならず、completedAt は1回目のまま（先勝ち、ADR 0440）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-terminal-exclusive.test.ts",
    "location": {
      "line": 53,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 相手側の終端が既に付いていたら、後から来た呼び出しは行を変えない（Issue #826） > 同種の再呼び出し（fail → fail）は例外にならず、failedAt と lastError は1回目のまま（先勝ち、ADR 0440）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-terminal-exclusive.test.ts",
    "location": {
      "line": 67,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 相手側の終端が既に付いていたら、後から来た呼び出しは行を変えない（Issue #826） > 取り直した後（attempts が2以上）の正当な complete・fail は、終端を付ける（黙って返さない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-terminal-exclusive.test.ts",
    "location": {
      "line": 84,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 相手側の終端が既に付いていたら、後から来た呼び出しは行を変えない（Issue #826） > attempts が不一致なら、相手側の終端の有無に関わらず OutboxLeaseConflictError を投げる（既存契約）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-terminal-exclusive.test.ts",
    "location": {
      "line": 100,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.complete/fail — 相手側の終端が既に付いていたら、後から来た呼び出しは行を変えない（Issue #826） > 行が無いジョブ id は no-op のまま（既存契約）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-outbox-terminal-exclusive.test.ts",
    "location": {
      "line": 113,
      "column": 3
    }
  },
  {
    "name": "ADR 0486: プレーンでない値は structuredClone に任せる（潰さない） > Map・Set・型付き配列は、種類を保って読み戻る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-payload-nonplain-adr0486.test.ts",
    "location": {
      "line": 22,
      "column": 3
    }
  },
  {
    "name": "ADR 0486: プレーンでない値は structuredClone に任せる（潰さない） > data そのものが Map のときも潰れない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-payload-nonplain-adr0486.test.ts",
    "location": {
      "line": 39,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.purgeMemory が本文の派生物に触れる範囲 > registered の label は、proposedCount も status も動かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-purge-memory-derived-scope.test.ts",
    "location": {
      "line": 25,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.purgeMemory が本文の派生物に触れる範囲 > 目次帯のエントリが truncated: true だったとき、墓石へ書き換えたあとの形は { memoryId, digest } だけ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-purge-memory-derived-scope.test.ts",
    "location": {
      "line": 46,
      "column": 3
    }
  },
  {
    "name": "archiveDecayed の nowSeq は wall では見ない（Issue #1731、Postgres は wall では nowSeq を SQL に入れない） > wall（既定を含む）は整数でない nowSeq も通し、activity・either は今までどおり断る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-query-invalid-values.test.ts",
    "location": {
      "line": 23,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は読みの口の条件の Invalid Date・整数でない通し番号を拒む > %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-query-invalid-values.test.ts",
    "location": {
      "line": 121,
      "column": 17
    }
  },
  {
    "name": "testkit の fixture は読みの口の条件の Invalid Date・整数でない通し番号を拒む > 省略（undefined）は条件が無いのであって、拒まない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-query-invalid-values.test.ts",
    "location": {
      "line": 125,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は createRecall で Postgres が書けない記録を拒む > %s は拒み、記録も活動時計も進めない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-recall-claim-storable.test.ts",
    "location": {
      "line": 68,
      "column": 17
    }
  },
  {
    "name": "testkit の fixture は createRecall で Postgres が書けない記録を拒む > 文字どおりの \\\\u0000（バックスラッシュ + u0000）と、budget の省略は受け付ける（陽性対照）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-recall-claim-storable.test.ts",
    "location": {
      "line": 76,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は claimBatch で NUL を含む claimedBy を拒む > 拒み、ジョブを claim しない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-recall-claim-storable.test.ts",
    "location": {
      "line": 87,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は claimBatch で NUL を含む claimedBy を拒む > ジョブを1件も積んでいない store でも、NUL を含む claimedBy を拒む（#1280）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-recall-claim-storable.test.ts",
    "location": {
      "line": 103,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は createRecall で Invalid Date の createdAt を拒む（ADR 0480） > 拒み、記録も活動時計も進めない。有効な日付は受ける（陽性対照）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-recall-claim-storable.test.ts",
    "location": {
      "line": 118,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は #1183 の外側の CHECK 制約を写す > createMemory: %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-remaining-check-constraints.test.ts",
    "location": {
      "line": 71,
      "column": 17
    }
  },
  {
    "name": "testkit の fixture は #1183 の外側の CHECK 制約を写す > 活動時計の欄を省略（null）するのは「この軸を使わない」であり、拒まない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-remaining-check-constraints.test.ts",
    "location": {
      "line": 82,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は #1183 の外側の CHECK 制約を写す > halfLifeRecalls が 1 未満の正の値（%s）は、float4 に収まるので受け付ける（#1250）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-remaining-check-constraints.test.ts",
    "location": {
      "line": 97,
      "column": 24
    }
  },
  {
    "name": "testkit の fixture は #1183 の外側の CHECK 制約を写す > EventStore.append: memoryId を持つ events_purged を拒み、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-remaining-check-constraints.test.ts",
    "location": {
      "line": 115,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.purgeExpiredEventsByRetention の同期区間 > 呼び出しを await する前に、削除と events_purged の追記まで終わっている",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-retention-purge-sync-section.test.ts",
    "location": {
      "line": 11,
      "column": 3
    }
  },
  {
    "name": "applyCorrection の返り値が、後から書き換わらない（Issue #1108） > resolved の markResult の Memory は、印を付けた時点の contested のまま",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-return-snapshots.test.ts",
    "location": {
      "line": 39,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore の Memory を返す口は、返した時点の複製を返す（Issue #1108） > %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-return-snapshots.test.ts",
    "location": {
      "line": 399,
      "column": 21
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory は、呼び手の入力と切り離して保存する（Issue #1108） > 作成の後に呼び手が入力（入れ子の配列・オブジェクト）を書き換えても、保存した値は変わらない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-return-snapshots.test.ts",
    "location": {
      "line": 419,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.scrubPurged: digest が既にトゥームストーンのエントリも truncated を落とす（ADR 0512） > { digest: '[purged]', truncated: true } は { digest: '[purged]' } になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-scrub-purged-index-band-truncated.test.ts",
    "location": {
      "line": 7,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.scrubPurged — recalls.indexBand の digest（ADR 0512） > purge 済みの行のエントリだけ伏せる。未 purge の forgotten・生きている記憶・他テナントの帯は触らない。べき等",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-scrub-purged-index-band.test.ts",
    "location": {
      "line": 35,
      "column": 3
    }
  },
  {
    "name": "InMemory の search は ctx.tenantId の境界も掛ける（Issue #1050 / ADR 0007） > InMemoryVectorStore.search: ctx と filter.tenantId が食い違えば空、一致すればそのテナントだけ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-search-ctx-tenant-boundary.test.ts",
    "location": {
      "line": 36,
      "column": 3
    }
  },
  {
    "name": "InMemory の search は ctx.tenantId の境界も掛ける（Issue #1050 / ADR 0007） > InMemoryLexicalStore.search: ctx と filter.tenantId が食い違えば空、一致すればそのテナントだけ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-search-ctx-tenant-boundary.test.ts",
    "location": {
      "line": 52,
      "column": 3
    }
  },
  {
    "name": "InMemory の search は ctx.tenantId の境界も掛ける（Issue #1050 / ADR 0007） > 食い違っていても limit の検査は先に効く（Postgres が SQL の LIMIT で例外を投げるのと揃える）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-search-ctx-tenant-boundary.test.ts",
    "location": {
      "line": 68,
      "column": 3
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.getSubjectActivitySeqs: Object.prototype のキー名 > ⭐ '%s' の行の値をそのまま返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-subject-activity-seqs-prototype-keys.test.ts",
    "location": {
      "line": 9,
      "column": 16
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.getSubjectActivitySeqs: Object.prototype のキー名 > 陽性対照: plain の行は返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-subject-activity-seqs-prototype-keys.test.ts",
    "location": {
      "line": 18,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.supersedeWithNewMemories: 壊れた news は、どの位置でも、存在しない対象の not found より先に断られる > 壊れた news が %s 番目",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-supersede-malformed-news-position-before-missing-target.test.ts",
    "location": {
      "line": 11,
      "column": 21
    }
  },
  {
    "name": "InMemoryMemoryStore.supersedeWithNewMemories: 古い記憶の updatedAt は壁時計（ADR 0566 A） > opts.now を過去に固定しても、置き換えられた記憶の updatedAt は壁時計（opts.now ではない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-supersede-updated-at.test.ts",
    "location": {
      "line": 15,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.supersedeWithNewMemories: 古い記憶の createdAt は変わらない（core の Fake と同じ不変条件） > 置き換えで updatedAt は壁時計へ進むが、createdAt は作ったときのまま（後から書き換わらない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-supersede-updated-at.test.ts",
    "location": {
      "line": 52,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.supersedeWithNewMemories: CAS で弾かれた行は updatedAt も createdAt も書き換わらない（ADR 0592。クローンの判断） > expectedStatus が合わず conflicted に積まれた古い記憶は、置き換えの前後で updatedAt・createdAt が同じ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-supersede-updated-at.test.ts",
    "location": {
      "line": 94,
      "column": 3
    }
  },
  {
    "name": "${kitName}: resolveContestedPair の supersededById（ADR 0503） > status: superseded に supersededById が無い（first・second どちらも）は RangeError で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 102,
      "column": 5
    }
  },
  {
    "name": "${kitName}: resolveContestedPair の supersededById（ADR 0503） > 自己置換（自分自身を supersededById に）は RangeError で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 116,
      "column": 5
    }
  },
  {
    "name": "${kitName}: resolveContestedPair の supersededById（ADR 0503） > 互いを指す循環は RangeError で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 127,
      "column": 5
    }
  },
  {
    "name": "${kitName}: resolveContestedPair の supersededById（ADR 0503） > status: active に supersededById を付けるのは RangeError で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 135,
      "column": 5
    }
  },
  {
    "name": "${kitName}: resolveContestedPair の supersededById（ADR 0503） > 対の外の forgotten な記憶を supersededById に指すのは RangeError で、何も書かない（ADR 0515）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 143,
      "column": 5
    }
  },
  {
    "name": "${kitName}: resolveContestedPair の supersededById（ADR 0503） > 陽性対照: 対の外の archived な記憶を指す superseded は通る（forgotten だけを断る。ADR 0515）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 162,
      "column": 5
    }
  },
  {
    "name": "${kitName}: resolveContestedPair の supersededById（ADR 0503） > 陽性対照: 勝者を指す superseded・both_active・群の外の active を指す superseded は通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 177,
      "column": 5
    }
  },
  {
    "name": "${kitName}: resolveContestedGroup の supersededById（ADR 0503） > status: superseded に supersededById が無いメンバーは RangeError で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 220,
      "column": 5
    }
  },
  {
    "name": "${kitName}: resolveContestedGroup の supersededById（ADR 0503） > 自己置換は RangeError で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 233,
      "column": 5
    }
  },
  {
    "name": "${kitName}: resolveContestedGroup の supersededById（ADR 0503） > メンバー同士で輪になる supersededById（2者・3者）は RangeError で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 249,
      "column": 5
    }
  },
  {
    "name": "${kitName}: resolveContestedGroup の supersededById（ADR 0503） > 群の外の forgotten な記憶を supersededById に指すのは RangeError で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 269,
      "column": 5
    }
  },
  {
    "name": "${kitName}: resolveContestedGroup の supersededById（ADR 0503） > status: active のメンバーに supersededById を付けるのは RangeError で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 287,
      "column": 5
    }
  },
  {
    "name": "${kitName}: resolveContestedGroup の supersededById（ADR 0503） > 陽性対照: 勝者を指す superseded・群の外の active を指す superseded・both_active は通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 303,
      "column": 5
    }
  },
  {
    "name": "${kitName}: updateStatus / updateStatusWithEvent の supersededById（ADR 0503） > ${name}: superseded に supersededById が無い（省略・opts 無し・expectedStatus だけ）は RangeError で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 352,
      "column": 7
    }
  },
  {
    "name": "${kitName}: updateStatus / updateStatusWithEvent の supersededById（ADR 0503） > ${name}: 自己置換は RangeError で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 365,
      "column": 7
    }
  },
  {
    "name": "${kitName}: updateStatus / updateStatusWithEvent の supersededById（ADR 0503） > ${name}: 自己置換（${label}）は RangeError で、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 377,
      "column": 9
    }
  },
  {
    "name": "${kitName}: updateStatus / updateStatusWithEvent の supersededById（ADR 0503） > ${name}: 陽性対照 — 別の記憶を大文字で supersededById に渡すと通り、小文字に畳まれて保存される",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 389,
      "column": 7
    }
  },
  {
    "name": "${kitName}: updateStatus / updateStatusWithEvent の supersededById（ADR 0503） > ${name}: superseded 以外の status に自分自身（大文字でも）を supersededById に付けても、文面は「superseded 以外に付けない」のまま",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 397,
      "column": 7
    }
  },
  {
    "name": "${kitName}: updateStatus / updateStatusWithEvent の supersededById（ADR 0503） > ${name}: superseded 以外の status に supersededById を付けるのは RangeError で、何も書かない（ADR 0515）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 423,
      "column": 7
    }
  },
  {
    "name": "${kitName}: updateStatus / updateStatusWithEvent の supersededById（ADR 0503） > ${name}: 陽性対照 — 別の記憶を指す superseded、superseded 以外の status（supersededById 無し）は通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-checks.test.ts",
    "location": {
      "line": 443,
      "column": 7
    }
  },
  {
    "name": "testkit の InMemory: id が部分文字列の関係にある別の記憶を supersededById に渡すと通る（ADR 0558） > updateStatus・updateStatusWithEvent: id が前方一致の関係にある別の記憶（mem-10 → mem-1、mem-1 → mem-10）は、小文字でも大文字でも通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-superseded-by-substring-ids.test.ts",
    "location": {
      "line": 40,
      "column": 5
    }
  },
  {
    "name": "綴りだけが違う tenant は別の tenant（InMemoryMemoryStore） > get・getMany: 相手の綴りの tenant からは null・空配列。自分の tenant からは見える",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-tenant-case-distinct.test.ts",
    "location": {
      "line": 23,
      "column": 3
    }
  },
  {
    "name": "綴りだけが違う tenant は別の tenant（InMemoryMemoryStore） > getObservation: 相手の綴りの tenant からは null。自分の tenant からは見える",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-tenant-case-distinct.test.ts",
    "location": {
      "line": 40,
      "column": 3
    }
  },
  {
    "name": "綴りだけが違う tenant は別の tenant（InMemoryMemoryStore） > aggregateScope: 綴りの違う tenant の件数を数えない（それぞれ1件）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-tenant-case-distinct.test.ts",
    "location": {
      "line": 50,
      "column": 3
    }
  },
  {
    "name": "綴りだけが違う tenant は別の tenant（InMemoryMemoryStore） > listLabels: 登録したラベルは、登録した tenant の綴りでだけ見える",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-tenant-case-distinct.test.ts",
    "location": {
      "line": 56,
      "column": 3
    }
  },
  {
    "name": "綴りだけが違う tenant は別の tenant（InMemoryMemoryStore） > eraseTenant: 片方の綴りを消しても、もう片方の行は残る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-tenant-case-distinct.test.ts",
    "location": {
      "line": 63,
      "column": 3
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls: float4 で 0 に丸まる値を拒む > 1e-46 は例外を投げ、値を書き換えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-tenant-settings-float4-range.test.ts",
    "location": {
      "line": 10,
      "column": 3
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls: float4 で 0 に丸まる値を拒む > float4 の非正規数に収まる値（1e-40）は、Postgres と同じく受け付ける",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-tenant-settings-float4-range.test.ts",
    "location": {
      "line": 16,
      "column": 3
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeHours: float4 に収まらない値を拒む > %s は例外を投げ、値を書き換えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-tenant-settings-float4-range.test.ts",
    "location": {
      "line": 28,
      "column": 5
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeHours: float4 に収まらない値を拒む > %s は、Postgres と同じく受け付ける",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-tenant-settings-float4-range.test.ts",
    "location": {
      "line": 39,
      "column": 5
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeHours: float4 に収まらない値を拒む > 値域 (0, ∞) の外（0・負・NaN・Infinity）は、今までどおり値域の文面で拒む",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-tenant-settings-float4-range.test.ts",
    "location": {
      "line": 45,
      "column": 3
    }
  },
  {
    "name": "ContestedWithoutCompanionError: method と memoryId > updateStatus は method='updateStatus'、memoryId に対象の id",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 41,
      "column": 3
    }
  },
  {
    "name": "ContestedWithoutCompanionError: method と memoryId > updateStatusWithEvent は method='updateStatusWithEvent'、memoryId に対象の id",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 48,
      "column": 3
    }
  },
  {
    "name": "ContestedWithoutCompanionError: method と memoryId > createMemory は method='createMemory'、memoryId は null（作成時）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 57,
      "column": 3
    }
  },
  {
    "name": "ContestedWithoutCompanionError: method と memoryId > createMemoryWithOutbox は method='createMemoryWithOutbox'、memoryId は null",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 64,
      "column": 3
    }
  },
  {
    "name": "ContestedWithoutCompanionError: method と memoryId > supersedeWithNewMemories は method='supersedeWithNewMemories'、memoryId は null",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 73,
      "column": 3
    }
  },
  {
    "name": "MemoryStatusConflictError: memoryId・expectedStatus・observedStatus > updateStatus（expectedStatus の食い違い）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 95,
      "column": 3
    }
  },
  {
    "name": "MemoryStatusConflictError: memoryId・expectedStatus・observedStatus > updateStatusWithEvent（expectedStatus の食い違い）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 108,
      "column": 3
    }
  },
  {
    "name": "MemoryStatusConflictError: memoryId・expectedStatus・observedStatus > markContestedPair（既に contested）は expectedStatus='active'",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 127,
      "column": 3
    }
  },
  {
    "name": "MemoryStatusConflictError: memoryId・expectedStatus・observedStatus > resolveContestedPair（contested でない）は expectedStatus='contested'",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 145,
      "column": 3
    }
  },
  {
    "name": "MemoryStatusConflictError: memoryId・expectedStatus・observedStatus > resolveOrphanedContested（生存側が contested でない）は expectedStatus='contested'",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 162,
      "column": 3
    }
  },
  {
    "name": "MemoryStatusConflictError: memoryId・expectedStatus・observedStatus > resolveOrphanedContested（contestedWithId の食い違い）は observedStatus も 'contested'",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 175,
      "column": 3
    }
  },
  {
    "name": "MemoryPurgeConflictError: memoryId・observedStatus・observedPurgedAt > forgotten でない行は observedPurgedAt=null",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 203,
      "column": 3
    }
  },
  {
    "name": "MemoryPurgeConflictError: memoryId・observedStatus・observedPurgedAt > purge 済みの行は observedStatus='forgotten'、observedPurgedAt に purge した時刻",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 214,
      "column": 3
    }
  },
  {
    "name": "OutboxLeaseConflictError: jobId・expectedAttempts・observedAttempts > complete（claim 済み、attempts 違い）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 250,
      "column": 3
    }
  },
  {
    "name": "OutboxLeaseConflictError: jobId・expectedAttempts・observedAttempts > fail（claim 済み、attempts 違い）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 257,
      "column": 3
    }
  },
  {
    "name": "OutboxLeaseConflictError: jobId・expectedAttempts・observedAttempts > complete（fail で終端済み、attempts 違い）も投げる（#1292）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 264,
      "column": 3
    }
  },
  {
    "name": "OutboxLeaseConflictError: jobId・expectedAttempts・observedAttempts > fail（complete で終端済み、attempts 違い）も投げる（#1292）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-typed-error-fields.test.ts",
    "location": {
      "line": 272,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > forget・purge: 状態が変わり、積まれるイベントの memoryId は小文字",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 95,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > restoreArchived: archived を大文字の id で戻せる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 110,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > markContested・resolveContested: 対の相互参照・supersededById は小文字で持つ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 121,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > markContestedGroup・resolveContestedGroup",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 135,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > consolidate・restoreSuperseded",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 150,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > 使用報告（memory_usage）: 例外にならず、使用の行は小文字の id で一度だけ入る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 164,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > MemoryStore の口: get・getMany（綴り違いの重複は1件）・updateStatus・reinforce・setEmbeddingStatus",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 176,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > VectorStore・RelationStore・EventStore の口",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 190,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > 同じ記憶を綴り違いで2回渡した markContested は、同じ記憶どうしとして断る（Postgres と同じ）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 217,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > EventStore.get: 大文字のイベント id でも同じイベントが当たる（ADR 0556。Postgres は uuid 型の列で比べる）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 224,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > EventStore.get: 別のイベント id は、前方一致・部分一致では当たらず null（ADR 0580。Postgres は id の等しさで比べる）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 241,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > abortIfSuperseded: 大文字の id でも superseded を見落とさず、何も書かない。changed[].id は Postgres と同じ小文字（ADR 0556）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 264,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 大文字の対象 id を同じ記憶として受ける（ADR 0521） > abortIfSuperseded: 綴り違いの同じ id は1件、changed は id の昇順（ADR 0568）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-uppercase-target-id.test.ts",
    "location": {
      "line": 348,
      "column": 3
    }
  },
  {
    "name": "testkit の InMemoryVectorStore は、空間の3欄を完全一致で比べる > %s空間のベクトルを、検索が返さない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-space-exact-match.test.ts",
    "location": {
      "line": 15,
      "column": 5
    }
  },
  {
    "name": "InMemoryVectorStore: VectorStore の TSDoc の端 > filter.status: [] なら1件も通らない（status を省略すれば同じ行が返る）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-contract-edges.test.ts",
    "location": {
      "line": 22,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore: VectorStore の TSDoc の端 > distance: 逆向きのベクトルでは約 2（0〜1 に収めない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-contract-edges.test.ts",
    "location": {
      "line": 40,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore: VectorStore の TSDoc の端 > query に %s を含んでも投げず、候補を落とさず、距離は比較が通らない値になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-contract-edges.test.ts",
    "location": {
      "line": 56,
      "column": 5
    }
  },
  {
    "name": "InMemoryVectorStore.deleteAcrossSpaces の id の綴り > 大文字の memoryId でも、全 space の同じ行が消え、渡していない記憶の行は残る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-delete-across-spaces-spelling.test.ts",
    "location": {
      "line": 12,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.search — 長さが違うクエリベクトルは比較不能（Issue #867 / 案B） > 短いクエリ（[1,2]）は候補を落とさず distance が NaN になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-dimension-mismatch.test.ts",
    "location": {
      "line": 24,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.search — 長さが違うクエリベクトルは比較不能（Issue #867 / 案B） > 長いクエリ（[1,2,3,4]）も候補を落とさず distance が NaN になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-dimension-mismatch.test.ts",
    "location": {
      "line": 36,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.search — 長さが違うクエリベクトルは比較不能（Issue #867 / 案B） > ⚠ 鳴ってはいけない側: 長さが一致するクエリは普通に実数の distance を返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-dimension-mismatch.test.ts",
    "location": {
      "line": 47,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.search — 距離 NaN の候補は常に最後尾（Issue #983、PostgresVectorStore と同じ） > ゼロベクトルを %i 番目に入れても、最後尾に返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-nan-order.test.ts",
    "location": {
      "line": 46,
      "column": 27
    }
  },
  {
    "name": "InMemoryVectorStore.search — 距離 NaN の候補は常に最後尾（Issue #983、PostgresVectorStore と同じ） > ゼロベクトルを %i 番目に入れても、limit が有限の候補の数ちょうどなら有限の候補だけが返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-nan-order.test.ts",
    "location": {
      "line": 55,
      "column": 27
    }
  },
  {
    "name": "InMemoryVectorStore.search — 距離 NaN の候補は常に最後尾（Issue #983、PostgresVectorStore と同じ） > 距離 NaN どうしは同点で、その中は recordedAt の新しい順に並ぶ（挿入順にならない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-nan-order.test.ts",
    "location": {
      "line": 63,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.search — 距離が完全一致したときの tie-break（Issue #339 / ADR 0170 の追随） > recorded_at が新しい方を先に返す（PostgresVectorStore.search と同じ契約）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-tiebreak.test.ts",
    "location": {
      "line": 13,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.search — 距離が完全一致したときの tie-break（Issue #339 / ADR 0170 の追随） > recorded_at まで完全一致したら memory_id 昇順にフォールバックする（欠落・重複が無い）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-tiebreak.test.ts",
    "location": {
      "line": 49,
      "column": 3
    }
  },
  {
    "name": "search の tie-break の追加の歯（ADR 0170 の契約。Issue #1775 の #828） > memory_id の段: upsert を id の降順に打っても、memory_id 昇順で返る（挿入順に依らない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-tiebreak.test.ts",
    "location": {
      "line": 85,
      "column": 3
    }
  },
  {
    "name": "search の tie-break の追加の歯（ADR 0170 の契約。Issue #1775 の #828） > 近いが違う距離は同点として扱わない: 距離が先で、recordedAt は同点のときだけ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-tiebreak.test.ts",
    "location": {
      "line": 107,
      "column": 3
    }
  },
  {
    "name": "search の tie-break の追加の歯（ADR 0170 の契約。Issue #1775 の #828） > 同点の日時は recordedAt である（occurredAt の順と recordedAt の順が逆の2件）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-tiebreak.test.ts",
    "location": {
      "line": 134,
      "column": 3
    }
  },
  {
    "name": "search の tie-break の追加の歯（ADR 0170 の契約。Issue #1775 の #828） > 返す形は { memoryId, distance } だけ（tie-break のための recordedAt などが漏れない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-vector-store-tiebreak.test.ts",
    "location": {
      "line": 166,
      "column": 3
    }
  },
  {
    "name": "下限の検査は Invalid Date を RangeError にしない（Invalid Date の検査が後に在る口） > purgeMemory の event.at が Invalid Date: 従来の Error（valid Date の文面）で、RangeError ではない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-written-floor-leaves-invalid-date-alone.test.ts",
    "location": {
      "line": 10,
      "column": 3
    }
  },
  {
    "name": "状態遷移の表（testkit の fixture）: 出発状態 × 操作 > %s × %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/lifecycle-transition-table.fixtures.test.ts",
    "location": {
      "line": 50,
      "column": 17
    }
  },
  {
    "name": "状態遷移の表（testkit の fixture）: 2手・3手の組 > %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/lifecycle-transition-table.fixtures.test.ts",
    "location": {
      "line": 56,
      "column": 62
    }
  },
  {
    "name": "状態遷移の表（testkit の fixture）: reextract と、元の Observation 由来の古い Memory > 古い Memory が %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/lifecycle-transition-table.fixtures.test.ts",
    "location": {
      "line": 65,
      "column": 63
    }
  },
  {
    "name": "適合テストの前提（RecordedLLMProvider）: 足場が歯を空回りさせていない > complete 用の記録値は、ちょうど { content } の形をしている（歯1が検査する形そのもの）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/llm-provider-conformance.test.ts",
    "location": {
      "line": 64,
      "column": 3
    }
  },
  {
    "name": "適合テストの前提（RecordedLLMProvider）: 足場が歯を空回りさせていない > completeStructured 用の記録値は、schema に無い欄を実際に持つ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/llm-provider-conformance.test.ts",
    "location": {
      "line": 69,
      "column": 3
    }
  },
  {
    "name": "supportsLabels/supportsFindActiveByClaimKey を省略した呼び出し（v1.0.0 の呼び出し形）は型検査を通り、該当する適合項目を実行しない > 陽性対照: 両方とも true では listLabels/registerLabel/findActiveByClaimKey が実際に呼ばれている",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/memory-store-conformance.supports-labels-and-claim-key-optional.test.ts",
    "location": {
      "line": 184,
      "column": 3
    }
  },
  {
    "name": "supportsLabels/supportsFindActiveByClaimKey を省略した呼び出し（v1.0.0 の呼び出し形）は型検査を通り、該当する適合項目を実行しない > 両方を省略すると、listLabels/registerLabel/findActiveByClaimKey は一度も呼ばれない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/memory-store-conformance.supports-labels-and-claim-key-optional.test.ts",
    "location": {
      "line": 191,
      "column": 3
    }
  },
  {
    "name": "supportsLabels/supportsFindActiveByClaimKey を省略した呼び出し（v1.0.0 の呼び出し形）は型検査を通り、該当する適合項目を実行しない > false: listLabels/registerLabel/findActiveByClaimKey は一度も呼ばれず、「実装していない」ことの assert がそれぞれの有無を読みに行く",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/memory-store-conformance.supports-labels-and-claim-key-optional.test.ts",
    "location": {
      "line": 198,
      "column": 3
    }
  },
  {
    "name": "${label}: 冪等な再送の内訳 resend（ADR 0639） > 新しく作った呼び出しには resend が無い（sync・deferred とも）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-resend-breakdown.test.ts",
    "location": {
      "line": 83,
      "column": 5
    }
  },
  {
    "name": "${label}: 冪等な再送の内訳 resend（ADR 0639） > 正常な再送には active の記憶が載り、既存の欄は変わらない（ADR 0454 決定4 の3欄も）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-resend-breakdown.test.ts",
    "location": {
      "line": 92,
      "column": 5
    }
  },
  {
    "name": "${label}: 冪等な再送の内訳 resend（ADR 0639） > forget の後の再送は forgotten・purged: false",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-resend-breakdown.test.ts",
    "location": {
      "line": 118,
      "column": 5
    }
  },
  {
    "name": "${label}: 冪等な再送の内訳 resend（ADR 0639） > purge の後の再送は purged: true（status は forgotten のまま）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-resend-breakdown.test.ts",
    "location": {
      "line": 131,
      "column": 5
    }
  },
  {
    "name": "${label}: 冪等な再送の内訳 resend（ADR 0639） > deferred で tick の前に再送すると memories: []、tick の後は載る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-resend-breakdown.test.ts",
    "location": {
      "line": 144,
      "column": 5
    }
  },
  {
    "name": "${label}: 冪等な再送の内訳 resend（ADR 0639） > sync の observe が abort された後の再送も memories: []",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-resend-breakdown.test.ts",
    "location": {
      "line": 159,
      "column": 5
    }
  },
  {
    "name": "${label}: 冪等な再送の内訳 resend（ADR 0639） > extractorVersion を上げた記憶（版違い）も載る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-resend-breakdown.test.ts",
    "location": {
      "line": 187,
      "column": 5
    }
  },
  {
    "name": "${label}: 冪等な再送の内訳 resend（ADR 0639） > 別テナントの記憶は載らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-resend-breakdown.test.ts",
    "location": {
      "line": 204,
      "column": 5
    }
  },
  {
    "name": "${label}: 冪等な再送の内訳 resend（ADR 0639） > 順序は memoryId の昇順",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-resend-breakdown.test.ts",
    "location": {
      "line": 220,
      "column": 5
    }
  },
  {
    "name": "${label}: 冪等な再送の内訳 resend（ADR 0639） > 再送は LLM を呼ばず、記憶を書き換えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-resend-breakdown.test.ts",
    "location": {
      "line": 234,
      "column": 5
    }
  },
  {
    "name": "InMemory: sync observe が積んだ extract のジョブは、observe が持っている間 claim されない（ADR 0407） > LLM を待つ間に tick が走っても、LLM は1回・active は1件・observe は memoryIds を返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-sync-extract-job-lease.test.ts",
    "location": {
      "line": 97,
      "column": 3
    }
  },
  {
    "name": "InMemory: sync observe が積んだ extract のジョブは、observe が持っている間 claim されない（ADR 0407） > observe が LLM の途中で死んだ（戻らない）とき、リースが切れた後は tick が拾う",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-sync-extract-job-lease.test.ts",
    "location": {
      "line": 123,
      "column": 3
    }
  },
  {
    "name": "InMemory: sync observe が積んだ extract のジョブは、observe が持っている間 claim されない（ADR 0407） > LLM がリースより長くかかり tick に取り直されても、書き込み済みの observe は例外を投げず memoryIds を返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/observe-sync-extract-job-lease.test.ts",
    "location": {
      "line": 142,
      "column": 3
    }
  },
  {
    "name": "ADR 0206: 並行 claim の歯の、testkit の側の歯（Issue #1812 G5） > フラグを省略/false にすると並行の it は skip、true なら走る（ADR 0206）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/outbox-concurrent-claim-conformance-recheck-0917.test.ts",
    "location": {
      "line": 146,
      "column": 3
    }
  },
  {
    "name": "ADR 0206: 並行 claim の歯の、testkit の側の歯（Issue #1812 G5） > in-memory の設定は supportsRealConcurrency を渡さない（逐次化されるので、渡すと何も測らず緑になる。ADR 0206）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/outbox-concurrent-claim-conformance-recheck-0917.test.ts",
    "location": {
      "line": 155,
      "column": 3
    }
  },
  {
    "name": "ADR 0206: 並行 claim の歯の、testkit の側の歯（Issue #1812 G5） > claimBatch が返すジョブは、渡した claimedBy を名乗る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/outbox-concurrent-claim-conformance-recheck-0917.test.ts",
    "location": {
      "line": 159,
      "column": 3
    }
  },
  {
    "name": "埋め込み空間は provider の名前だけが違っても断る > SeededEmbeddingProvider: delegate の provider だけが種と違うと、構築で落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align-edges.test.ts",
    "location": {
      "line": 19,
      "column": 3
    }
  },
  {
    "name": "埋め込み空間は provider の名前だけが違っても断る > CassetteRecorder: 2回目以降の記録で provider だけが違うと、落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align-edges.test.ts",
    "location": {
      "line": 30,
      "column": 3
    }
  },
  {
    "name": "RecordingEmbeddingProvider: 返すベクトルは、呼び出しごと・記録・delegate の配列と別 > 同じテキストを並列に呼んだ一方が返り値を書き換えても、他方・記録・delegate の配列に漏れない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align-edges.test.ts",
    "location": {
      "line": 41,
      "column": 3
    }
  },
  {
    "name": "成分が %s のベクトル > assertCassette は読んだ時点で落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align-edges.test.ts",
    "location": {
      "line": 65,
      "column": 5
    }
  },
  {
    "name": "成分が %s のベクトル > RecordedEmbeddingProvider.embed は返さずに落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align-edges.test.ts",
    "location": {
      "line": 72,
      "column": 5
    }
  },
  {
    "name": "成分が %s のベクトル > RecordingEmbeddingProvider は記録せずに落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align-edges.test.ts",
    "location": {
      "line": 82,
      "column": 5
    }
  },
  {
    "name": "A-1: SeededEmbeddingProvider は種と delegate の空間の食い違いを構築時に断る > delegate の model が種と違うと構築で落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 72,
      "column": 3
    }
  },
  {
    "name": "A-1: SeededEmbeddingProvider は種と delegate の空間の食い違いを構築時に断る > delegate の次元が種と違うと構築で落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 79,
      "column": 3
    }
  },
  {
    "name": "A-1: SeededEmbeddingProvider は種と delegate の空間の食い違いを構築時に断る > やりすぎ: 同じ空間なら構築でき、種から返し、無い入力は delegate へ流す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 86,
      "column": 3
    }
  },
  {
    "name": "A-2: Seeded*・Recording* は opts をそのまま delegate へ渡す > SeededEmbedding.embed",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 102,
      "column": 3
    }
  },
  {
    "name": "A-2: Seeded*・Recording* は opts をそのまま delegate へ渡す > SeededLLM.complete / completeStructured",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 111,
      "column": 3
    }
  },
  {
    "name": "A-2: Seeded*・Recording* は opts をそのまま delegate へ渡す > RecordingEmbedding.embed",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 125,
      "column": 3
    }
  },
  {
    "name": "A-2: Seeded*・Recording* は opts をそのまま delegate へ渡す > RecordingLLM.complete / completeStructured",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 135,
      "column": 3
    }
  },
  {
    "name": "A-3: Recording* は進行中の呼び出しも memo する > RecordingLLM.complete: 同じプロンプトを並列に呼んでも delegate は1回で、見た値と記録の値が一致する",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 151,
      "column": 3
    }
  },
  {
    "name": "A-3: Recording* は進行中の呼び出しも memo する > RecordingLLM.completeStructured: 並列でも1回。待つ側も自分の schema で検証し直す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 160,
      "column": 3
    }
  },
  {
    "name": "A-3: Recording* は進行中の呼び出しも memo する > RecordingEmbedding.embed: 同じテキストを並列に呼んでも delegate は1回で、見たベクトルと記録が一致する",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 183,
      "column": 3
    }
  },
  {
    "name": "A-3: Recording* は進行中の呼び出しも memo する > 失敗した Promise は memo に残さない（次の呼び出しは delegate を呼び直す）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 192,
      "column": 3
    }
  },
  {
    "name": "A-3: Recording* は進行中の呼び出しも memo する > やりすぎ: 逐次の繰り返しは今までどおり記録済みを返し、違うプロンプトは別々に delegate を呼ぶ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 232,
      "column": 3
    }
  },
  {
    "name": "A-4: CassetteRecorder は違う空間・モデルの2回目以降を断る > 埋め込み: 違う model・次元は落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 243,
      "column": 3
    }
  },
  {
    "name": "A-4: CassetteRecorder は違う空間・モデルの2回目以降を断る > LLM: 違うモデル名は落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 253,
      "column": 3
    }
  },
  {
    "name": "A-4: CassetteRecorder は違う空間・モデルの2回目以降を断る > やりすぎ: 同じ空間・モデルの2回目以降は記録できる（同じキーの上書きも）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 260,
      "column": 3
    }
  },
  {
    "name": "A-5: カセットと再生は、成分が有限・dimensions が正の整数・鍵が入力と一致、を確かめる > やりすぎ: 有限の正しいカセットは読める",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 276,
      "column": 3
    }
  },
  {
    "name": "A-5: カセットと再生は、成分が有限・dimensions が正の整数・鍵が入力と一致、を確かめる > 成分が %s のカセットは読んだ時点で落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 279,
      "column": 35
    }
  },
  {
    "name": "A-5: カセットと再生は、成分が有限・dimensions が正の整数・鍵が入力と一致、を確かめる > dimensions が %s のカセットは落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 285,
      "column": 24
    }
  },
  {
    "name": "A-5: カセットと再生は、成分が有限・dimensions が正の整数・鍵が入力と一致、を確かめる > embedding の鍵が text の SHA-256 と違うカセットは落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 290,
      "column": 3
    }
  },
  {
    "name": "A-5: カセットと再生は、成分が有限・dimensions が正の整数・鍵が入力と一致、を確かめる > llm の鍵が prompt から導いた値と違うカセットは落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 296,
      "column": 3
    }
  },
  {
    "name": "A-5: カセットと再生は、成分が有限・dimensions が正の整数・鍵が入力と一致、を確かめる > RecordedEmbeddingProvider.embed は、成分が有限でない記録を返さずに落ちる（assertCassette を通っていない section でも）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 302,
      "column": 3
    }
  },
  {
    "name": "A-5: カセットと再生は、成分が有限・dimensions が正の整数・鍵が入力と一致、を確かめる > やりすぎ: RecordedEmbeddingProvider は有限の記録を返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 311,
      "column": 3
    }
  },
  {
    "name": "A-5: カセットと再生は、成分が有限・dimensions が正の整数・鍵が入力と一致、を確かめる > RecordingEmbedding は delegate の壊れた戻り（NaN・次元違い）を記録せずに落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 320,
      "column": 3
    }
  },
  {
    "name": "A-5: カセットと再生は、成分が有限・dimensions が正の整数・鍵が入力と一致、を確かめる > やりすぎ: RecordingEmbedding は有限で次元の合う戻りを記録して返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 336,
      "column": 3
    }
  },
  {
    "name": "A-6: 返すベクトルと space は、記録・構築時の引数と参照を共有しない > Recorded: 返ったベクトルを書き換えても、次の再生に漏れない。space はカセットのオブジェクトではなく、凍結されている",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 350,
      "column": 3
    }
  },
  {
    "name": "A-6: 返すベクトルと space は、記録・構築時の引数と参照を共有しない > Recording: 返ったベクトルを書き換えても、記録に漏れない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 363,
      "column": 3
    }
  },
  {
    "name": "A-6: 返すベクトルと space は、記録・構築時の引数と参照を共有しない > Seeded: 種から返したベクトルを書き換えても、種に漏れない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 373,
      "column": 3
    }
  },
  {
    "name": "A-6: 返すベクトルと space は、記録・構築時の引数と参照を共有しない > Deterministic: 構築後に渡した space を書き換えても、space は動かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 383,
      "column": 3
    }
  },
  {
    "name": "A-8: DeterministicEmbeddingProvider は dimensions が正の整数でなければ構築時に断る > dimensions=%s は構築で落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 394,
      "column": 62
    }
  },
  {
    "name": "A-8: DeterministicEmbeddingProvider は dimensions が正の整数でなければ構築時に断る > やりすぎ: dimensions=%s は構築でき、その次元で返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 402,
      "column": 27
    }
  },
  {
    "name": "A-8: DeterministicEmbeddingProvider は dimensions が正の整数でなければ構築時に断る > 既定は8次元",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 409,
      "column": 3
    }
  },
  {
    "name": "A-8: DeterministicEmbeddingProvider は dimensions が正の整数でなければ構築時に断る > ⭐ ADR 0525: dimensions=%s（数でない）は TypeError",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 419,
      "column": 38
    }
  },
  {
    "name": "A-8: DeterministicEmbeddingProvider は dimensions が正の整数でなければ構築時に断る > ⭐ ADR 0525: dimensions=%s（数だが正の整数でない）は RangeError",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 423,
      "column": 62
    }
  },
  {
    "name": "A-8: DeterministicEmbeddingProvider は dimensions が正の整数でなければ構築時に断る > ⭐ ADR 0525: 型を変えても message は変わらない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-align.test.ts",
    "location": {
      "line": 430,
      "column": 3
    }
  },
  {
    "name": "返した応答を書き換えても、次の再生に漏れない > $name: complete",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-llm-response-isolation.test.ts",
    "location": {
      "line": 65,
      "column": 20
    }
  },
  {
    "name": "返した応答を書き換えても、次の再生に漏れない > $name: completeStructured（作り直されない欄）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-llm-response-isolation.test.ts",
    "location": {
      "line": 72,
      "column": 20
    }
  },
  {
    "name": "返した応答を書き換えても、次の再生に漏れない > Recorded: 同じ呼び出しの2つの戻りは、別のオブジェクト",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-llm-response-isolation.test.ts",
    "location": {
      "line": 81,
      "column": 3
    }
  },
  {
    "name": "Recording: delegate の応答を、記録とも呼び出し側とも別のオブジェクトにする > 初回の戻りを書き換えても、記録（カセット）にも次の再生にも漏れない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-llm-response-isolation.test.ts",
    "location": {
      "line": 95,
      "column": 3
    }
  },
  {
    "name": "Recording: delegate の応答を、記録とも呼び出し側とも別のオブジェクトにする > 並列に待った側の戻りも、別のオブジェクト",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-llm-response-isolation.test.ts",
    "location": {
      "line": 110,
      "column": 3
    }
  },
  {
    "name": "Recording: delegate の応答を、記録とも呼び出し側とも別のオブジェクトにする > 先に着いた側が、受け取った直後に書き換えても、待っていた側に漏れない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-llm-response-isolation.test.ts",
    "location": {
      "line": 121,
      "column": 3
    }
  },
  {
    "name": "Recording: delegate の応答を、記録とも呼び出し側とも別のオブジェクトにする > やりすぎ: 値は等しい（複製しても中身は変わらない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/provider-fakes-llm-response-isolation.test.ts",
    "location": {
      "line": 132,
      "column": 3
    }
  },
  {
    "name": "README「インストール」: vitest は peerDependencies である > vitest は peerDependencies に在り、dependencies には無い（同梱しない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/readme-unbound-promises.test.ts",
    "location": {
      "line": 22,
      "column": 3
    }
  },
  {
    "name": "README「決定的な擬似 provider」: DeterministicEmbeddingProvider は既定で8次元 > 引数を省くと space.dimensions は 8 で、embed はその次元のベクトルを返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/readme-unbound-promises.test.ts",
    "location": {
      "line": 30,
      "column": 3
    }
  },
  {
    "name": "README「@mnemora/testkit/fixtures」: インメモリの store は別の入口からだけ出す > README が挙げる6つは /fixtures の入口から export されている",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/readme-unbound-promises.test.ts",
    "location": {
      "line": 49,
      "column": 3
    }
  },
  {
    "name": "README「@mnemora/testkit/fixtures」: インメモリの store は別の入口からだけ出す > 入口 `.` からは InMemory* を1つも export していない（describe*Conformance に渡せないようにするため）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/readme-unbound-promises.test.ts",
    "location": {
      "line": 56,
      "column": 3
    }
  },
  {
    "name": "README「テストデータのひな型」: buildNewMemoryFixture の既定値のまま実時計で recall すると0件になる > 既定の減衰の床は 2026-05-10T15:47Z（TSDoc の値）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/readme-unbound-promises.test.ts",
    "location": {
      "line": 93,
      "column": 3
    }
  },
  {
    "name": "README「テストデータのひな型」: buildNewMemoryFixture の既定値のまま実時計で recall すると0件になる > 既定値のままでは0件、recordedAt を明示すれば1件（陽性対照）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/readme-unbound-promises.test.ts",
    "location": {
      "line": 98,
      "column": 3
    }
  },
  {
    "name": "RecordingEmbeddingProvider: テキストとベクトルの対応（Issue #1000） > 複数件を一度に渡すと、各テキストに包まれる側のそのテキストのベクトルが返り、同じ対応で記録される",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/recording-embedding-provider-mapping.test.ts",
    "location": {
      "line": 16,
      "column": 3
    }
  },
  {
    "name": "RecordingEmbeddingProvider: テキストとベクトルの対応（Issue #1000） > 一部が記録済み・重複を含む入力でも、取り逃したテキストそれぞれに正しいベクトルが対応する",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/recording-embedding-provider-mapping.test.ts",
    "location": {
      "line": 30,
      "column": 3
    }
  },
  {
    "name": "RecordingLLMProvider: 並列に待った側が複数でも、全員が別の写しを受け取る（ADR 0500） > complete: 3つ並列",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/recording-llm-parallel-waiters-isolation.test.ts",
    "location": {
      "line": 16,
      "column": 3
    }
  },
  {
    "name": "RecordingLLMProvider: 並列に待った側が複数でも、全員が別の写しを受け取る（ADR 0500） > completeStructured（作り直されない欄）: 3つ並列",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/recording-llm-parallel-waiters-isolation.test.ts",
    "location": {
      "line": 29,
      "column": 3
    }
  },
  {
    "name": "RecordingLLMProvider: 並列に待った側が複数でも、全員が別の写しを受け取る（ADR 0500） > 対照: 値は等しい",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/recording-llm-parallel-waiters-isolation.test.ts",
    "location": {
      "line": 45,
      "column": 3
    }
  },
  {
    "name": "SeededLLMProvider > 種にある入力では delegate を呼ばない（completeStructured）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 99,
      "column": 3
    }
  },
  {
    "name": "SeededLLMProvider > 種にある入力では delegate を呼ばない（complete）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 112,
      "column": 3
    }
  },
  {
    "name": "SeededLLMProvider > 種に無い入力では delegate を呼ぶ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 125,
      "column": 3
    }
  },
  {
    "name": "SeededLLMProvider > 種の記録がいまのスキーマを満たさなければ completeStructured は例外を投げ、seeded を増やさない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 141,
      "column": 3
    }
  },
  {
    "name": "SeededLLMProvider > モデル名が種と食い違えば構築時に例外",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 155,
      "column": 3
    }
  },
  {
    "name": "SeededLLMProvider > 種から返した分・実 API から返した分の両方が、新しいカセットに記録される（自己完結）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 163,
      "column": 3
    }
  },
  {
    "name": "SeededEmbeddingProvider > 種にある入力では delegate を呼ばない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 185,
      "column": 3
    }
  },
  {
    "name": "SeededEmbeddingProvider > 種に無い入力では delegate を呼ぶ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 197,
      "column": 3
    }
  },
  {
    "name": "SeededEmbeddingProvider > 種にある入力・無い入力が混在すれば、無い分だけ delegate へ渡る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 209,
      "column": 3
    }
  },
  {
    "name": "SeededEmbeddingProvider > 埋め込み空間が種と食い違えば構築時に例外",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 224,
      "column": 3
    }
  },
  {
    "name": "SeededEmbeddingProvider > 種・委譲先と同じ3次元で expectedSpace だけ次元が違えば、構築時に例外",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 234,
      "column": 3
    }
  },
  {
    "name": "SeededEmbeddingProvider > 委譲先が欠けた入力の件数と違う件数を返したら例外",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 243,
      "column": 3
    }
  },
  {
    "name": "SeededEmbeddingProvider > 種と欠けを交互に混ぜた入力で、戻りが入力の順になる（欠けが2件以上）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 256,
      "column": 3
    }
  },
  {
    "name": "SeededEmbeddingProvider > 種から返した分・実 API から返した分の両方が、新しいカセットに記録される（自己完結）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/seeded-provider.test.ts",
    "location": {
      "line": 276,
      "column": 3
    }
  },
  {
    "name": "supportsTaxonomyMode を省略した呼び出し（v1.0.0 の呼び出し形）は型検査を通り、taxonomy 系の適合項目を実行しない > 陽性対照: supportsTaxonomyMode: true では getTaxonomyMode/setTaxonomyMode が実際に呼ばれている",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/tenant-settings-store-conformance.supports-taxonomy-mode-optional.test.ts",
    "location": {
      "line": 60,
      "column": 3
    }
  },
  {
    "name": "supportsTaxonomyMode を省略した呼び出し（v1.0.0 の呼び出し形）は型検査を通り、taxonomy 系の適合項目を実行しない > supportsTaxonomyMode を省略すると、getTaxonomyMode/setTaxonomyMode は一度も呼ばれない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/tenant-settings-store-conformance.supports-taxonomy-mode-optional.test.ts",
    "location": {
      "line": 66,
      "column": 3
    }
  },
  {
    "name": "@mnemora/testkit の package.json: zod は peerDependencies に在り、core と同じ範囲である（Issue #1734 / PR #1491 のすり抜け） > peerDependencies に zod が在る（dependencies には無い。同梱しない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/zod-peer-dependency.test.ts",
    "location": {
      "line": 18,
      "column": 3
    }
  },
  {
    "name": "@mnemora/testkit の package.json: zod は peerDependencies に在り、core と同じ範囲である（Issue #1734 / PR #1491 のすり抜け） > その範囲は core の dependencies.zod と同じ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/zod-peer-dependency.test.ts",
    "location": {
      "line": 23,
      "column": 3
    }
  }
]