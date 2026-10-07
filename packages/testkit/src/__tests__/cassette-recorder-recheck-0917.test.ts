[
  {
    "name": "RecordingLLMProvider: 同じプロンプトを二度叩かない > 同じプロンプトの2回目以降は、1回目に録った応答をそのまま返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette-recorder.test.ts",
    "location": {
      "line": 56,
      "column": 3
    }
  },
  {
    "name": "RecordingLLMProvider: 同じプロンプトを二度叩かない > 違うプロンプトは別の鍵として、それぞれ1回ずつ録る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette-recorder.test.ts",
    "location": {
      "line": 72,
      "column": 3
    }
  },
  {
    "name": "RecordingLLMProvider: 同じプロンプトを二度叩かない > completeStructured も同じ鍵では二度叩かず、記録済みの値を schema で検証し直す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette-recorder.test.ts",
    "location": {
      "line": 87,
      "column": 3
    }
  },
  {
    "name": "RecordingLLMProvider: 同じプロンプトを二度叩かない > 🔴 記録は、記録を作った実行そのものを再生できる（後勝ちで先の値が消えない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette-recorder.test.ts",
    "location": {
      "line": 101,
      "column": 3
    }
  },
  {
    "name": "RecordingEmbeddingProvider: 同じ入力テキストを二度叩かない > 同じテキストの2回目以降は、1回目に録ったベクトルを返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette-recorder.test.ts",
    "location": {
      "line": 122,
      "column": 3
    }
  },
  {
    "name": "RecordingEmbeddingProvider: 同じ入力テキストを二度叩かない > 未記録のテキストだけを委譲先へ渡す（既に録ったものは混ぜない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette-recorder.test.ts",
    "location": {
      "line": 135,
      "column": 3
    }
  },
  {
    "name": "RecordingEmbeddingProvider: 同じ入力テキストを二度叩かない > 同じ呼び出しの中に同じテキストが重複していても、委譲先へは1回だけ渡す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette-recorder.test.ts",
    "location": {
      "line": 146,
      "column": 3
    }
  },
  {
    "name": "CassetteRecorder（ADR 0051） > 録ったものを再生すると、記録元と同じベクトルが返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 55,
      "column": 3
    }
  },
  {
    "name": "CassetteRecorder（ADR 0051） > 録ったものを再生すると、記録元と同じ構造化応答が返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 62,
      "column": 3
    }
  },
  {
    "name": "CassetteRecorder（ADR 0051） > 埋め込みが1件も記録されていなければ、書き出す前に落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 70,
      "column": 3
    }
  },
  {
    "name": "CassetteRecorder（ADR 0051） > LLM 応答が1件も記録されていなければ、書き出す前に落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 76,
      "column": 3
    }
  },
  {
    "name": "CassetteRecorder（ADR 0051） > 同じ入力を2回記録しても、entry は1つにまとまる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 82,
      "column": 3
    }
  },
  {
    "name": "RecordedEmbeddingProvider（ADR 0051） > 記録に無い入力は、擬似ベクトルへ倒れず例外になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 92,
      "column": 3
    }
  },
  {
    "name": "RecordedEmbeddingProvider（ADR 0051） > 期待する空間と記録元が食い違えば、構築時に落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 98,
      "column": 3
    }
  },
  {
    "name": "RecordedEmbeddingProvider（ADR 0051） > 期待する空間と記録元が一致すれば、構築できる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 109,
      "column": 3
    }
  },
  {
    "name": "RecordedEmbeddingProvider（ADR 0051） > 記録されたベクトルの次元が空間と食い違えば、「記録に無い」とは別の理由で落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 116,
      "column": 3
    }
  },
  {
    "name": "RecordedLLMProvider（ADR 0051） > 記録に無いプロンプトは、擬似応答へ倒れず例外になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 127,
      "column": 3
    }
  },
  {
    "name": "RecordedLLMProvider（ADR 0051） > 記録以降にスキーマが変わっていたら、「記録に無い」とは別の理由で落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 138,
      "column": 3
    }
  },
  {
    "name": "RecordedLLMProvider（ADR 0051） > 期待するモデルと記録元が食い違えば、構築時に落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 149,
      "column": 3
    }
  },
  {
    "name": "鍵の導出（ADR 0051） > スキーマを鍵に含めない——同じプロンプトなら同じ鍵になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 158,
      "column": 3
    }
  },
  {
    "name": "鍵の導出（ADR 0051） > system が違えば別の鍵になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 162,
      "column": 3
    }
  },
  {
    "name": "assertCassette（ADR 0051） > 形式版が違うカセットは読まずに落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 168,
      "column": 3
    }
  },
  {
    "name": "assertCassette（ADR 0051） > 正しいカセットは通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 174,
      "column": 3
    }
  },
  {
    "name": "assertCassette（ADR 0051） > embedding 節が欠けていれば落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/cassette.test.ts",
    "location": {
      "line": 179,
      "column": 3
    }
  },
  {
    "name": "file",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 189,
      "column": 17
    }
  },
  {
    "name": "(t) => t",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 190,
      "column": 17
    }
  },
  {
    "name": "(t) => !t.name.includes(\"未検査\")",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 191,
      "column": 19
    }
  },
  {
    "name": "(t) => t.name === unchecked[0]",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 199,
      "column": 14
    }
  },
  {
    "name": "docs/conformance.md §9: 任意フラグを省略したときに登録される it > MemoryStore: 省略した任意フラグのそれぞれに「⚠ 未検査」の named it が1本ずつ登録される",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 205,
      "column": 3
    }
  },
  {
    "name": "docs/conformance.md §9: 任意フラグを省略したときに登録される it > task.file",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 208,
      "column": 19
    }
  },
  {
    "name": "docs/conformance.md §9: 任意フラグを省略したときに登録される it > (t) => t",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 209,
      "column": 19
    }
  },
  {
    "name": "docs/conformance.md §9: 任意フラグを省略したときに登録される it > (t) => !t.name.includes(\"未検査\")",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 210,
      "column": 21
    }
  },
  {
    "name": "docs/conformance.md §9: 任意フラグを省略したときに登録される it > (t) => t.name === unchecked[0]",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 235,
      "column": 16
    }
  },
  {
    "name": "docs/conformance.md §9: 任意フラグを省略したときに登録される it > VectorStore: supportsSearchMany を省略すると「⚠ 未検査」の named it が1本登録される",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 240,
      "column": 3
    }
  },
  {
    "name": "docs/conformance.md §9: 任意フラグを省略したときに登録される it > OutboxStore: supportsPurgeCompletedJobs を省略すると「⚠ 未検査」の named it が1本登録される",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 246,
      "column": 3
    }
  },
  {
    "name": "docs/conformance.md §9: 任意フラグを省略したときに登録される it > MemoryStore: 関数フックの countScopeAggregateQueries を省略しても「⚠ 未検査」の named it が1本登録される（2状態）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 252,
      "column": 3
    }
  },
  {
    "name": "docs/conformance.md §9: 任意フラグを省略したときに登録される it > TenantSettingsStore: supportsTaxonomyMode を省略すると、taxonomy mode の歯も「未検査」の it も登録されない（今の振る舞い）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 258,
      "column": 3
    }
  },
  {
    "name": "docs/conformance.md §9: 任意フラグを省略したときに登録される it > task.file",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/conformance-omitted-flags-named-it.test.ts",
    "location": {
      "line": 261,
      "column": 19
    }
  },
  {
    "name": "expectStoreError（Issue #1734 / PR #1514 のすり抜け） > 判定関数を通る値は、そのまま返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/error-guards.test.ts",
    "location": {
      "line": 14,
      "column": 3
    }
  },
  {
    "name": "expectStoreError（Issue #1734 / PR #1514 のすり抜け） > 判定関数を通らない値（%s）では落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/error-guards.test.ts",
    "location": {
      "line": 24,
      "column": 5
    }
  },
  {
    "name": "expectRejectsWithStoreError > 判定関数を通る理由で reject すれば、その理由を返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/error-guards.test.ts",
    "location": {
      "line": 30,
      "column": 3
    }
  },
  {
    "name": "expectRejectsWithStoreError > 別の理由で reject したら落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/error-guards.test.ts",
    "location": {
      "line": 37,
      "column": 3
    }
  },
  {
    "name": "expectRejectsWithStoreError > reject しなければ落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/error-guards.test.ts",
    "location": {
      "line": 43,
      "column": 3
    }
  },
  {
    "name": "expectRejectsWithoutStoreError > 判定関数を通らない理由で reject すれば通る（別の失敗であることの確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/error-guards.test.ts",
    "location": {
      "line": 51,
      "column": 3
    }
  },
  {
    "name": "expectRejectsWithoutStoreError > 判定関数を通る理由で reject したら落ちる（別の失敗のはずが、その例外だった）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/error-guards.test.ts",
    "location": {
      "line": 57,
      "column": 3
    }
  },
  {
    "name": "expectRejectsWithoutStoreError > reject しなければ落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/error-guards.test.ts",
    "location": {
      "line": 63,
      "column": 3
    }
  },
  {
    "name": "testkit/fixtures 入口の公開型 > StoredRelation[] を明示して InMemoryRelationStore に渡せる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/fixtures-entry-public-types.test.ts",
    "location": {
      "line": 7,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.claimBatch: 不正な limit は claim の前に拒み、ジョブに触れない > limit: %j で拒んだあと、ジョブは claimedAt 未設定・attempts 0 のまま",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-claim-batch-invalid-limit-no-claim.test.ts",
    "location": {
      "line": 27,
      "column": 21
    }
  },
  {
    "name": "InMemoryOutboxStore.claimBatch: 取り直しで書く availableAt は opts.now の写し > claim したあとで呼び手が now を書き換えても、保存した availableAt は動かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-claim-batch-reclaim-available-at-copy.test.ts",
    "location": {
      "line": 10,
      "column": 3
    }
  },
  {
    "name": "群の監査イベントは N に対して線形にしか増えない（testkit InMemory） > N=10/20/40: イベントの件数・note の長さ・meta の合計バイト数",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-contested-group-event-growth.test.ts",
    "location": {
      "line": 39,
      "column": 3
    }
  },
  {
    "name": "群の監査イベントは N に対して線形にしか増えない（testkit InMemory） > note は件数と先頭の一部だけを持ち、切ったことを印で示す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-contested-group-event-growth.test.ts",
    "location": {
      "line": 44,
      "column": 3
    }
  },
  {
    "name": "markContestedGroup: 状態の変わらないメンバーには updated を積まない（%s） > 既に群の一員は積まない。active と、対の片割れ（contestedWithId あり）は積む",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-contested-group-unchanged-members.test.ts",
    "location": {
      "line": 28,
      "column": 5
    }
  },
  {
    "name": "testkit の fixture は、冪等の既存の行が在っても書けない値を拒む > %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-create-idempotent-rejects.test.ts",
    "location": {
      "line": 21,
      "column": 17
    }
  },
  {
    "name": "InMemoryMemoryStore — 別テナントの行を対象にした失敗は、何も書かない > setEmbeddingStatus: 別テナントの呼び出しが失敗しても、持ち主の行は updatedAt を含めて丸ごと変わらない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-cross-tenant-failure-no-side-effects.test.ts",
    "location": {
      "line": 21,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore — 別テナントの行を対象にした失敗は、何も書かない > updateStatusWithEvent: 別テナントの呼び出しが失敗しても、呼んだ側（B）のテナントの履歴にもイベントが積まれない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-cross-tenant-failure-no-side-effects.test.ts",
    "location": {
      "line": 38,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore — 別テナントの行を対象にした失敗は、何も書かない > supersedeWithNewMemories: 別テナントの行を対象にして失敗しても、B 側にもイベントが積まれない。expectedStatus 付きでも conflicted にならず例外",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-cross-tenant-failure-no-side-effects.test.ts",
    "location": {
      "line": 64,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.registerLabel — 冪等（registeredAt を上書きしない。ADR 0318 約束4。Issue #1775 の #717 の変異15） > 2回目の registerLabel は、時計が進んでいても registeredAt を1回目のまま返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-cross-tenant-failure-no-side-effects.test.ts",
    "location": {
      "line": 114,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: decayFloorAt が Date でない新しい Memory は、TypeError で、書く前に断る（PR #1772） > createMemory・createMemoryWithOutbox・supersedeWithNewMemories: %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-decay-floor-at-must-be-a-date.test.ts",
    "location": {
      "line": 58,
      "column": 20
    }
  },
  {
    "name": "InMemoryMemoryStore: decayFloorAt が Date でない新しい Memory は、TypeError で、書く前に断る（PR #1772） > 冪等の既存の行が在っても断る（createMemory・createMemoryWithOutbox）: %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-decay-floor-at-must-be-a-date.test.ts",
    "location": {
      "line": 99,
      "column": 20
    }
  },
  {
    "name": "InMemoryMemoryStore: decayFloorAt が Date でない新しい Memory は、TypeError で、書く前に断る（PR #1772） > 陽性対照: Date なら、同じ入力が既存の行に解決される（冪等）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-decay-floor-at-must-be-a-date.test.ts",
    "location": {
      "line": 113,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は空文字の参照・冪等の鍵を「値が在る」として扱う > createMemory: 空文字の %s を拒み、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-empty-string-references.test.ts",
    "location": {
      "line": 25,
      "column": 5
    }
  },
  {
    "name": "testkit の fixture は空文字の参照・冪等の鍵を「値が在る」として扱う > createObservation: externalId が空文字なら、2回目は既存の行を返し、ジョブを積まない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-empty-string-references.test.ts",
    "location": {
      "line": 41,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.eraseTenant（ADR 0426）の確かめ直し > subject の行をすべて消したら、テナントのエントリも残さない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-erase-tenant-gaps.test.ts",
    "location": {
      "line": 10,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.eraseTenant（ADR 0426）の確かめ直し > dryRun は冪等キーを消さない（同じ入力の再書き込みは、dryRun の後も created: false）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-erase-tenant-gaps.test.ts",
    "location": {
      "line": 20,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.eraseTenant（ADR 0426）の確かめ直し > InMemoryVectorStore を2つ載せても、どちらの埋め込みも memories と一緒に消える",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-erase-tenant-gaps.test.ts",
    "location": {
      "line": 40,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.eraseTenant — tenant_subject_activity を subject ごとの行で数える > subject が3つなら、recalls 3行 + tenant_subject_activity 3行 = 6 を返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-erase-tenant-postgres-alignment.test.ts",
    "location": {
      "line": 34,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.eraseTenant — tenant_subject_activity を subject ごとの行で数える > limit が subject の行の途中で尽きたら、budget ぶんだけ消して残りを次の呼び出しへ回す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-erase-tenant-postgres-alignment.test.ts",
    "location": {
      "line": 49,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.eraseTenant — memories を消すと埋め込みも消える（ON DELETE CASCADE） > 消した memories の埋め込みだけが消え、他テナント・消さなかった memories の埋め込みは残る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-erase-tenant-postgres-alignment.test.ts",
    "location": {
      "line": 67,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.eraseTenant — memories を消すと埋め込みも消える（ON DELETE CASCADE） > dryRun では何も消さず、埋め込みも残る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-erase-tenant-postgres-alignment.test.ts",
    "location": {
      "line": 102,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.eraseTenant — memories を消すと埋め込みも消える（ON DELETE CASCADE） > core の eraseTenant を通すと、本番の deleted.vectorStore は 0（Postgres と同じ）、dryRun は実数",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-erase-tenant-postgres-alignment.test.ts",
    "location": {
      "line": 116,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.eraseTenant — recall_usages はテナントの完全一致で消す（ADR 0604） > acme を消しても、acme:eu の recall_usages は残る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-erase-tenant-postgres-alignment.test.ts",
    "location": {
      "line": 145,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は MemoryEventKind に無い kind を拒む > InMemoryEventStore.append は拒み、何も書かない（文面は at の検査と同じ形）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-kind-check.test.ts",
    "location": {
      "line": 21,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は MemoryEventKind に無い kind を拒む > updateStatusWithEvent・markContestedPair は拒み、状態を変えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-kind-check.test.ts",
    "location": {
      "line": 35,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は、イベントを書く残りの口でも MemoryEventKind に無い kind を拒む > purgeMemory は拒み、墓石を書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-kind-check.test.ts",
    "location": {
      "line": 90,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は、イベントを書く残りの口でも MemoryEventKind に無い kind を拒む > resolveContestedPair は拒み、2件とも contested のまま、イベントも増えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-kind-check.test.ts",
    "location": {
      "line": 107,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は、イベントを書く残りの口でも MemoryEventKind に無い kind を拒む > resolveOrphanedContested は拒み、contested のまま、イベントも増えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-kind-check.test.ts",
    "location": {
      "line": 128,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は、イベントを書く残りの口でも MemoryEventKind に無い kind を拒む > supersedeWithNewMemories は拒み、新しい行も outbox も書かず、supersede される側も変えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-kind-check.test.ts",
    "location": {
      "line": 143,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は、イベントを書く残りの口でも MemoryEventKind に無い kind を拒む > markContestedPair は、1件目のイベントが不正な kind でも拒み、状態を変えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-kind-check.test.ts",
    "location": {
      "line": 171,
      "column": 3
    }
  },
  {
    "name": "testkit の fixture は、イベントを書く残りの口でも MemoryEventKind に無い kind を拒む > 不正な kind が、見つからない id・CAS の食い違いと重なったときは、そちらが先に決まる（Postgres は更新する行が無ければ CHECK に届かない） > updateStatusWithEvent",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-kind-check.test.ts",
    "location": {
      "line": 188,
      "column": 5
    }
  },
  {
    "name": "testkit の fixture は、イベントを書く残りの口でも MemoryEventKind に無い kind を拒む > 不正な kind が、見つからない id・CAS の食い違いと重なったときは、そちらが先に決まる（Postgres は更新する行が無ければ CHECK に届かない） > purgeMemory",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-kind-check.test.ts",
    "location": {
      "line": 211,
      "column": 5
    }
  },
  {
    "name": "testkit の fixture は、イベントを書く残りの口でも MemoryEventKind に無い kind を拒む > 不正な kind が、見つからない id・CAS の食い違いと重なったときは、そちらが先に決まる（Postgres は更新する行が無ければ CHECK に届かない） > markContestedPair",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-kind-check.test.ts",
    "location": {
      "line": 223,
      "column": 5
    }
  },
  {
    "name": "testkit の fixture は、イベントを書く残りの口でも MemoryEventKind に無い kind を拒む > 不正な kind が、見つからない id・CAS の食い違いと重なったときは、そちらが先に決まる（Postgres は更新する行が無ければ CHECK に届かない） > resolveContestedPair（status は列挙の中。status の検査が先に来る入力は使わない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-kind-check.test.ts",
    "location": {
      "line": 244,
      "column": 5
    }
  },
  {
    "name": "testkit の fixture は、イベントを書く残りの口でも MemoryEventKind に無い kind を拒む > 不正な kind が、見つからない id・CAS の食い違いと重なったときは、そちらが先に決まる（Postgres は更新する行が無ければ CHECK に届かない） > resolveOrphanedContested",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-kind-check.test.ts",
    "location": {
      "line": 274,
      "column": 5
    }
  },
  {
    "name": "%s の検査の境目 > 断る: %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-lone-surrogate-boundaries.test.ts",
    "location": {
      "line": 55,
      "column": 21
    }
  },
  {
    "name": "%s の検査の境目 > 通す: %s",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-lone-surrogate-boundaries.test.ts",
    "location": {
      "line": 61,
      "column": 21
    }
  },
  {
    "name": "InMemoryEventStore.append も同じ境目で断る・通す > 末尾の孤立した上位サロゲート・U+DFFF は何も書かずに断り、SOH は書く",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-lone-surrogate-boundaries.test.ts",
    "location": {
      "line": 67,
      "column": 6
    }
  },
  {
    "name": "testkit の fixture は int4 に収まらない保持日数を拒む > days = %d は拒み、前の設定を変えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-retention-days-range.test.ts",
    "location": {
      "line": 8,
      "column": 30
    }
  },
  {
    "name": "testkit の fixture は int4 に収まらない保持日数を拒む > int4 の上限ちょうど（2^31 - 1）は受け付ける",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-retention-days-range.test.ts",
    "location": {
      "line": 19,
      "column": 3
    }
  },
  {
    "name": "event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore） > updateStatusWithEvent: status の更新ごと書かない。自分の id・同じテナントの別の記憶・null は通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts",
    "location": {
      "line": 42,
      "column": 3
    }
  },
  {
    "name": "event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore） > 実在しない id・形式のおかしい id も、別テナントと同じ例外で断る（Postgres の uuid でない id と同じ）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts",
    "location": {
      "line": 61,
      "column": 3
    }
  },
  {
    "name": "event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore） > 大文字小文字は区別しない（Postgres は uuid を小文字にそろえる）。小文字の正規形で積む。別テナントは大文字でも断る。操作の対象の id も同じ（ADR 0521）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts",
    "location": {
      "line": 77,
      "column": 3
    }
  },
  {
    "name": "event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore） > purgeMemory: 墓石も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts",
    "location": {
      "line": 100,
      "column": 3
    }
  },
  {
    "name": "event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore） > markContestedPair・resolveContestedPair",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts",
    "location": {
      "line": 119,
      "column": 3
    }
  },
  {
    "name": "event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore） > resolveOrphanedContested",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts",
    "location": {
      "line": 158,
      "column": 3
    }
  },
  {
    "name": "event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore） > markContestedGroup・resolveContestedGroup（群）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts",
    "location": {
      "line": 183,
      "column": 3
    }
  },
  {
    "name": "event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore） > markContestedGroup: 状態が変わらないメンバー（既に contested で相手なし）のイベントは書かないので、検査もしない（Postgres と同じ）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts",
    "location": {
      "line": 209,
      "column": 3
    }
  },
  {
    "name": "event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore） > supersedeWithNewMemories: supersede の event と buildCreatedEvent。news も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts",
    "location": {
      "line": 224,
      "column": 3
    }
  },
  {
    "name": "event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore） > supersedeWithNewMemories: CAS に弾かれる対象のイベントは書かないので、検査もしない（Postgres と同じ）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts",
    "location": {
      "line": 269,
      "column": 3
    }
  },
  {
    "name": "event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore） > createMemoriesWithOutboxAndEvents: 全体を戻す。作った記憶自身を指す created は通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts",
    "location": {
      "line": 292,
      "column": 3
    }
  },
  {
    "name": "event.memoryId が別テナントの記憶なら、書かずに断る（InMemoryMemoryStore） > InMemoryEventStore.append: 大文字の自テナントの記憶は通り（小文字で積む）、大文字の別テナントは断る。null は検査しない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-belongs-to-ctx-tenant.test.ts",
    "location": {
      "line": 326,
      "column": 3
    }
  },
  {
    "name": "別テナントを指すイベントは、先頭以外のものでも書かずに断る（InMemoryMemoryStore） > resolveContestedPair: 2つ目のイベントが別テナントを指しても断る。何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-every-event.test.ts",
    "location": {
      "line": 38,
      "column": 3
    }
  },
  {
    "name": "別テナントを指すイベントは、先頭以外のものでも書かずに断る（InMemoryMemoryStore） > markContestedGroup: %i 番目（先頭でない）のメンバーのイベントが別テナントを指しても断る。何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-every-event.test.ts",
    "location": {
      "line": 63,
      "column": 18
    }
  },
  {
    "name": "別テナントを指すイベントは、先頭以外のものでも書かずに断る（InMemoryMemoryStore） > resolveContestedGroup: %i 番目（先頭でない）のメンバーのイベントが別テナントを指しても断る。何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-event-target-every-event.test.ts",
    "location": {
      "line": 80,
      "column": 18
    }
  },
  {
    "name": "InMemoryMemoryStore.purgeExpiredEvents — events_purged の at はプロセスの時計の値そのまま > 時計を固定して消すと、events_purged の at はその固定した時刻になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-events-purged-at-clock.test.ts",
    "location": {
      "line": 20,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.purgeExpiredEvents — events_purged の at は since/until の両端に当たる > 読み戻した at をそのまま until・since に渡すと、どちらでも行自身が返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-events-purged-at-until-boundary.test.ts",
    "location": {
      "line": 8,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.purgeExpiredEvents の events_purged の meta > oldestPurgedAt・newestPurgedAt・olderThan は ISO 8601 の文字列（戻り値は Date のまま）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-events-purged-meta.test.ts",
    "location": {
      "line": 9,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.aggregateScope: excludedProvenanceIndexedCount は totalInScope と同じ絞りの内側だけを数える（Issue #1734 / PR #1458 のすり抜け） > archived・別 subject・期間の外・labels に合わない行は、除外 kind でも数えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-aggregate-scope-exclude-provenance-scope.test.ts",
    "location": {
      "line": 47,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.aggregateScope: options.excludeProvenanceKinds（ADR 0390） > 除外 kind で索引済みの行の数を excludedProvenanceIndexedCount に返す（未索引は数えない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-aggregate-scope-exclude-provenance.test.ts",
    "location": {
      "line": 32,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.aggregateScope: options.excludeProvenanceKinds（ADR 0390） > 空配列は no-op: 欄は返らず、返り値全体が指定なしと同じ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-aggregate-scope-exclude-provenance.test.ts",
    "location": {
      "line": 45,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.aggregateScope: options.excludeProvenanceKinds（ADR 0390） > scopeAggregate: 'skip' は excludeProvenanceKinds を渡しても欄を足さない（対照: 'exact' では欄が在る）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-aggregate-scope-exclude-provenance.test.ts",
    "location": {
      "line": 55,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.aggregateScope: scopeAggregate 'skip' と taxonomyGroupCandidates > 対照: 'exact' なら taxonomy の群（alpha・beta・残差）が出る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-aggregate-scope-skip-taxonomy.test.ts",
    "location": {
      "line": 22,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.aggregateScope: scopeAggregate 'skip' と taxonomyGroupCandidates > 'skip' なら、taxonomyGroupCandidates を渡しても groups は空で、件数は unknown / 0 のまま",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-aggregate-scope-skip-taxonomy.test.ts",
    "location": {
      "line": 38,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.archiveDecayed: limit が 0 のとき reachedLimit は false（ADR 0432 AL-4） > limit=0 は対象が在っても何も掃かず、reachedLimit: false を返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-archive-decayed-limit-zero.test.ts",
    "location": {
      "line": 10,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.archiveDecayed: limit が 0 のとき reachedLimit は false（ADR 0432 AL-4） > limit=0 で対象が0件でも reachedLimit: false",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-archive-decayed-limit-zero.test.ts",
    "location": {
      "line": 23,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.archiveDecayed: limit が 0 のとき reachedLimit は false（ADR 0432 AL-4） > 対照: limit=1 で1件掃いたら reachedLimit: true（正の limit の意味は変わらない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-archive-decayed-limit-zero.test.ts",
    "location": {
      "line": 29,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.archiveDecayed: 壊れた limit を渡すと Postgres と同じく例外を投げ、1件も archived にしない > limit=${limit} は例外を投げ、対象の Memory を archived にしない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-archive-decayed-limit.test.ts",
    "location": {
      "line": 15,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore.archiveDecayed: 壊れた limit を渡すと Postgres と同じく例外を投げ、1件も archived にしない > limit=2（正整数）は引き続き成功する（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-archive-decayed-limit.test.ts",
    "location": {
      "line": 28,
      "column": 3
    }
  },
  {
    "name": "InMemoryOutboxStore.claimBatch: リースの境界時刻が Date にならない入力は、Postgres と同じく例外を投げ、1件も claim しない > ${label} は例外を投げ、claimedAt も attempts も変えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-claim-batch-lease-ms.test.ts",
    "location": {
      "line": 35,
      "column": 5
    }
  },
  {
    "name": "InMemoryOutboxStore.claimBatch: リースの境界時刻が Date にならない入力は、Postgres と同じく例外を投げ、1件も claim しない > leaseMs=${leaseMs} は例外を投げず、未 claim のジョブを claim する（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-claim-batch-lease-ms.test.ts",
    "location": {
      "line": 47,
      "column": 5
    }
  },
  {
    "name": "InMemoryOutboxStore.claimBatch: claimedAt を省いた記録の初回の claim > claimedAt が undefined の job は未 claim として扱い、availableAt を変えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-claim-batch-reclaim-claimed-at-omitted.test.ts",
    "location": {
      "line": 12,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: halfLifeHours は float4 の最大値まで受ける > 境目の前提（Math.fround の丸め方）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-create-memory-float4-max-and-literal-nul.test.ts",
    "location": {
      "line": 14,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: halfLifeHours は float4 の最大値まで受ける > float4 の最大値と、Infinity に丸まる直前の値は受ける",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-create-memory-float4-max-and-literal-nul.test.ts",
    "location": {
      "line": 20,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: halfLifeHours は float4 の最大値まで受ける > Infinity に丸まる値は断り、Memory を作らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-create-memory-float4-max-and-literal-nul.test.ts",
    "location": {
      "line": 42,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: content の NUL > \\\\u0000 という文字列（NUL ではない）は受け、そのまま読み戻せる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-create-memory-float4-max-and-literal-nul.test.ts",
    "location": {
      "line": 58,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: content の NUL > 先頭・末尾の NUL も断る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-create-memory-float4-max-and-literal-nul.test.ts",
    "location": {
      "line": 68,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: createdAt は archive・purge の後も作成時のまま（ADR 0596） > archiveDecayed の後も、createdAt は作成時の値（updatedAt は進む）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-created-at-after-archive-purge.test.ts",
    "location": {
      "line": 13,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: createdAt は archive・purge の後も作成時のまま（ADR 0596） > purgeMemory の後も、createdAt は作成時の値（purgedAt は event.at、updatedAt は壁時計）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-created-at-after-archive-purge.test.ts",
    "location": {
      "line": 39,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.aggregateScope: labels で落ちた記憶は decayed に数えない > ラベルに合う減衰しきった記憶だけが decayed、合わない減衰しきった記憶は taxonomy に数える",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-decayed-count-label-mismatch.test.ts",
    "location": {
      "line": 12,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore の supportsAddOwnSubjectSeq > true を宣言している",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-declares-add-own-subject-seq.test.ts",
    "location": {
      "line": 5,
      "column": 3
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeHours は (0, ∞) の有限の値を通し、外を拒む > %s は書けて、そのまま読める",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-default-half-life-hours-range.test.ts",
    "location": {
      "line": 12,
      "column": 5
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeHours は (0, ∞) の有限の値を通し、外を拒む > %s は拒まれ、既定のまま変わらない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-default-half-life-hours-range.test.ts",
    "location": {
      "line": 26,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore.aggregateScope の digestBand: subjectId × includeSubjectless（ADR 0286） > subjectId だけを指定すると、digests と digestEligible はその subject の内側だけを数える",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-digest-band-subject.test.ts",
    "location": {
      "line": 23,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.aggregateScope の digestBand: subjectId × includeSubjectless（ADR 0286） > includeSubjectless: true では subjectless も digests と digestEligible に入り、別 subject は入らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-digest-band-subject.test.ts",
    "location": {
      "line": 35,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.aggregateScope の digestBand: subjectId × includeSubjectless（ADR 0286） > 除外に別 subject の id を混ぜても、digestEligible は絞りの内側からしか引かれない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-digest-band-subject.test.ts",
    "location": {
      "line": 47,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: float4 の列は Postgres が読み戻す値で返す > halfLifeHours=%s は createMemory の返り値も get も %s になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-float4-readback.test.ts",
    "location": {
      "line": 21,
      "column": 33
    }
  },
  {
    "name": "InMemoryMemoryStore: float4 の列は Postgres が読み戻す値で返す > strength=%s は createMemory の返り値も、reinforce の返り値も %s になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-float4-readback.test.ts",
    "location": {
      "line": 42,
      "column": 65
    }
  },
  {
    "name": "InMemoryMemoryStore: float4 の列は Postgres が読み戻す値で返す > createMemoryWithOutbox の返り値も同じ値になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-float4-readback.test.ts",
    "location": {
      "line": 56,
      "column": 3
    }
  },
  {
    "name": "InMemoryTenantSettingsStore: float4 の既定 half-life は Postgres が読み戻す値で返す > 既定 half-life（%s）は、時間側・想起側とも %s になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-float4-readback.test.ts",
    "location": {
      "line": 76,
      "column": 33
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: float4 で 0 に丸まる値（アンダーフロー）を Postgres と同じく拒む > halfLifeHours: 1e-300 は例外を投げ、Memory を作らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-float4-underflow.test.ts",
    "location": {
      "line": 10,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: float4 で 0 に丸まる値（アンダーフロー）を Postgres と同じく拒む > strength: 1e-300 と 1e-46 は例外を投げる（値域 (0, 1] の中でも float4 では 0 になる）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-float4-underflow.test.ts",
    "location": {
      "line": 21,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: float4 で 0 に丸まる値（アンダーフロー）を Postgres と同じく拒む > createMemoryWithOutbox も同じ入口で拒む",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-float4-underflow.test.ts",
    "location": {
      "line": 33,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: float4 で 0 に丸まる値（アンダーフロー）を Postgres と同じく拒む > float4 の非正規数に収まる値（1e-45）と通常の値は引き続き成功する（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-float4-underflow.test.ts",
    "location": {
      "line": 44,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: float4 で 0 に丸まる値（アンダーフロー）を Postgres と同じく拒む > 境界の両側: 7.0e-46（0 に丸まる）は拒み、7.1e-46（最小の非正規数に丸まる）は通す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-float4-underflow.test.ts",
    "location": {
      "line": 61,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.getVectors: 渡した id の分だけを返す > 同じテナントに別の embedding があっても、渡した id のものしか返さない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-get-vectors-only-requested.test.ts",
    "location": {
      "line": 30,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.getVectors: 渡した id の分だけを返す > 形式の合わない id は、無い id と同じく静かに落ちる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-get-vectors-only-requested.test.ts",
    "location": {
      "line": 40,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.getMany: ids に重複があっても一意な id の集合しか返さない > 同じ id が複数回含まれていても、その id は1回だけ結果に現れる（重複させない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-getmany-dedupe.test.ts",
    "location": {
      "line": 9,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.reinforce: 他テナントの Memory を対象にしない > 他テナントの id を渡すと memory not found を投げ、対象の行は無傷のまま",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-getmany-dedupe.test.ts",
    "location": {
      "line": 29,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.getVectors: memoryIds に重複があっても一意な id の集合しか返さない > 同じ id が複数回含まれていても、その id は1回だけ結果に現れる（重複させない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-getvectors-dedupe.test.ts",
    "location": {
      "line": 11,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.getVectors: memoryIds に重複があっても一意な id の集合しか返さない > 複数の異なる id を混ぜても、それぞれ1回だけ結果に現れる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-getvectors-dedupe.test.ts",
    "location": {
      "line": 26,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: halfLifeHours が float4 (Postgres real 列) に収まらない値を拒む > 1e300（float4 の範囲を大きく超える）は例外を投げ、Memory を作らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-half-life-hours-float4-overflow.test.ts",
    "location": {
      "line": 9,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: halfLifeHours が float4 (Postgres real 列) に収まらない値を拒む > Number.MAX_VALUE（float64 の最大値）は例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-half-life-hours-float4-overflow.test.ts",
    "location": {
      "line": 19,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: halfLifeHours が float4 (Postgres real 列) に収まらない値を拒む > strength=1e300 は（別の理由=値域外で）引き続き例外を投げる（回帰確認、float4 検査は不要）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-half-life-hours-float4-overflow.test.ts",
    "location": {
      "line": 33,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: halfLifeHours が float4 (Postgres real 列) に収まらない値を拒む > 3e38（float4 の範囲に収まる）と既定の720はどちらも引き続き成功する（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-half-life-hours-float4-overflow.test.ts",
    "location": {
      "line": 43,
      "column": 3
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls: float4 (Postgres real 列) に収まらない値を拒む > 1e300（float4 の範囲を大きく超える）は例外を投げ、値を書き換えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-half-life-recalls-float4-overflow.test.ts",
    "location": {
      "line": 8,
      "column": 3
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls: float4 (Postgres real 列) に収まらない値を拒む > Number.MAX_VALUE（float64 の最大値）は例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-half-life-recalls-float4-overflow.test.ts",
    "location": {
      "line": 17,
      "column": 3
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls: float4 (Postgres real 列) に収まらない値を拒む > 3e38（float4 の範囲に収まる、実測で Postgres も受け入れる値）は成功する",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-half-life-recalls-float4-overflow.test.ts",
    "location": {
      "line": 24,
      "column": 3
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls: float4 (Postgres real 列) に収まらない値を拒む > 実測の境界: 3.4028235677973362e38 は通り、3.4028235677973366e38 は拒まれる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-half-life-recalls-float4-overflow.test.ts",
    "location": {
      "line": 31,
      "column": 3
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls: float4 (Postgres real 列) に収まらない値を拒む > float4 の最大値のすぐ外側の %j は拒まれる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-half-life-recalls-float4-overflow.test.ts",
    "location": {
      "line": 41,
      "column": 32
    }
  },
  {
    "name": "InMemoryTenantSettingsStore.setDefaultHalfLifeRecalls: float4 (Postgres real 列) に収まらない値を拒む > 既定の720は引き続き成功する（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-half-life-recalls-float4-overflow.test.ts",
    "location": {
      "line": 48,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: subjectId を入力に持つ書き込みの口は、孤立サロゲート・NUL を入口で断る（ADR 0423 決定2、Issue #1734 / PR #1520 のすり抜け） > $name > %s は MalformedIdentifierError で断り、message に入力値を入れず、何も書かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-identifier-well-formed-write-entries.test.ts",
    "location": {
      "line": 61,
      "column": 7
    }
  },
  {
    "name": "InMemoryMemoryStore: subjectId を入力に持つ書き込みの口は、孤立サロゲート・NUL を入口で断る（ADR 0423 決定2、Issue #1734 / PR #1520 のすり抜け） > $name > 陽性対照: 対をなすサロゲート（絵文字）は断らない（探り棒が生きている）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-identifier-well-formed-write-entries.test.ts",
    "location": {
      "line": 78,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore.reinforce: Invalid Date を渡すと Postgres と同じく例外を投げ、状態を書き換えない > Invalid Date は例外を投げ、lastReinforcedAt/decayFloorAt を変えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-invalid-date.test.ts",
    "location": {
      "line": 11,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.reinforce: Invalid Date を渡すと Postgres と同じく例外を投げ、状態を書き換えない > 妥当な Date は引き続き成功する（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-invalid-date.test.ts",
    "location": {
      "line": 25,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: Date フィールドに Invalid Date を渡すと例外を投げ、Memory を作らない > ${field}=Invalid Date は例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-invalid-date.test.ts",
    "location": {
      "line": 39,
      "column": 5
    }
  },
  {
    "name": "InMemoryEventStore.append: at に Invalid Date を渡すと例外を投げ、イベントを積まない > Invalid Date は例外を投げ、events に積まれない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-invalid-date.test.ts",
    "location": {
      "line": 56,
      "column": 3
    }
  },
  {
    "name": "in-memory Fake: bigint に収まらない limit（2^63 以上）を渡すと Postgres と同じく例外を投げる > ${name} は limit=${limit} のとき例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-limit-bigint-range.test.ts",
    "location": {
      "line": 69,
      "column": 7
    }
  },
  {
    "name": "in-memory Fake: bigint に収まらない limit（2^63 以上）を渡すと Postgres と同じく例外を投げる > ${name} は limit=2^63-1024（2^63 未満で最大の double）では例外を投げない（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-limit-bigint-range.test.ts",
    "location": {
      "line": 73,
      "column": 5
    }
  },
  {
    "name": "in-memory Fake: bigint に収まらない limit（2^63 以上）を渡すと Postgres と同じく例外を投げる > InMemoryOutboxStore.claimBatch は limit=2^63 のとき、ジョブを claim しない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-limit-bigint-range.test.ts",
    "location": {
      "line": 78,
      "column": 3
    }
  },
  {
    "name": "in-memory Fake: bigint に収まらない limit（2^63 以上）を渡すと Postgres と同じく例外を投げる > InMemoryMemoryStore.archiveDecayed は limit=2^63 のとき、対象を archived にしない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-limit-bigint-range.test.ts",
    "location": {
      "line": 97,
      "column": 3
    }
  },
  {
    "name": "in-memory Fake: NaN/Infinity/非整数の limit を渡すと Postgres と同じく例外を投げる > InMemoryOutboxStore.claimBatch は limit=${limit} のとき、ジョブを claim せずに例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-limit-not-integer.test.ts",
    "location": {
      "line": 13,
      "column": 5
    }
  },
  {
    "name": "in-memory Fake: NaN/Infinity/非整数の limit を渡すと Postgres と同じく例外を投げる > InMemoryVectorStore.search は limit=${limit} のとき例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-limit-not-integer.test.ts",
    "location": {
      "line": 25,
      "column": 5
    }
  },
  {
    "name": "in-memory Fake: NaN/Infinity/非整数の limit を渡すと Postgres と同じく例外を投げる > InMemoryLexicalStore.search は limit=${limit} のとき例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-limit-not-integer.test.ts",
    "location": {
      "line": 36,
      "column": 5
    }
  },
  {
    "name": "in-memory Fake: NaN/Infinity/非整数の limit を渡すと Postgres と同じく例外を投げる > InMemoryEventStore.list は filter.limit=${limit} のとき例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-limit-not-integer.test.ts",
    "location": {
      "line": 47,
      "column": 5
    }
  },
  {
    "name": "in-memory Fake: NaN/Infinity/非整数の limit を渡すと Postgres と同じく例外を投げる > InMemoryMemoryStore.purgeExpiredEvents は limit=${limit} のとき例外を投げ、1行も消さない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-limit-not-integer.test.ts",
    "location": {
      "line": 53,
      "column": 5
    }
  },
  {
    "name": "in-memory Fake: NaN/Infinity/非整数の limit を渡すと Postgres と同じく例外を投げる > InMemoryMemoryStore.aggregateScope の digestBand: limit=${limit} のとき例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-limit-not-integer.test.ts",
    "location": {
      "line": 63,
      "column": 5
    }
  },
  {
    "name": "${IMPL}.markContestedPair: CAS が破れたときの MemoryStatusConflictError の欄 > expectedStatus は 'active'、memoryId と observedStatus は active でなかった側",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 91,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.resolveContestedPair: 両側 contested でも相互参照が成り立っていなければ CAS 破れ > 別々の対の片側どうしを渡すと MemoryStatusConflictError（expectedStatus 'contested'）で、4件とも書き換えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 115,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.purgeMemory: 変えない欄と、形の崩れた id > contentHash と digestSource は変えない（返り値も、読み直した行も）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 154,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.purgeMemory: 変えない欄と、形の崩れた id > id の形が崩れていても「memory not found」を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 182,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.restoreSupersededBy / previewRestoreSupersededBy: イベントの欄と、形の崩れた id > unsuperseded イベントの digestSnapshot は、その Memory の（変えていない）今の digest",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 197,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.restoreSupersededBy / previewRestoreSupersededBy: イベントの欄と、形の崩れた id > event.actor を省けば { type: 'system' }、渡せばその値がイベントに入る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 214,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.restoreSupersededBy / previewRestoreSupersededBy: イベントの欄と、形の崩れた id > supersededById の形が崩れていても投げず、restored も candidates も空",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 244,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.restoreSupersededBy / previewRestoreSupersededBy: イベントの欄と、形の崩れた id > supersededReason は、at が最も新しい superseded イベントの meta.reason（積んだ順ではない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 254,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.archiveDecayed: clock が 'activity'/'either' なら nowSeq は必須 > clock: '%s' で nowSeq を省くと投げ、沈んだ行も archived にしない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 286,
      "column": 43
    }
  },
  {
    "name": "${IMPL}.aggregateScope: 返す countKind はすべて 'exact'（ScopeAggregate.countKind「Phase 1 は常に 'exact'」） > どの filtered* 欄も 0 でない入力で、countKind・groups・notIndexed・filtered*・digestEligible がすべて 'exact'",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 308,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.aggregateScope の目次帯（digests / digestEligible）: スコープ内なら載る > contested な Memory も載る（段1と同じ status ゲート）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 410,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.aggregateScope の目次帯（digests / digestEligible）: スコープ内なら載る > validAt のゲートの外（期限切れ・まだ有効でない）は載らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 427,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.aggregateScope の目次帯（digests / digestEligible）: スコープ内なら載る > 減衰しきった Memory（filteredDecayed に数えたもの）も、群カウントにも帯にも載る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round2.test.ts",
    "location": {
      "line": 454,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.findActiveByClaimKey: 一致の条件の細部 > claim key の subject だけが違っても返さない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 65,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.findActiveByClaimKey: 一致の条件の細部 > 有効期間は半開区間——接するだけの区間は重ならない（両方の向き）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 77,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.findActiveByClaimKey: 一致の条件の細部 > subjectId の NULL と非 NULL は一致しない（どちらの向きでも）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 115,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.findActiveByClaimKey: 一致の条件の細部 > claim key を正規化しない——大文字小文字だけが違う値は一致しない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 129,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.findActiveByClaimKey: 一致の条件の細部 > status が %s の行は返さない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 145,
      "column": 61
    }
  },
  {
    "name": "${IMPL}.findActiveByClaimKey: 一致の条件の細部 > excludeMemoryId の形が崩れていても投げず、どの行も除かない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 155,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.listActiveClaimPredicates: limit・status・subjectId の細部 > limit: 0 なら空配列",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 172,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.listActiveClaimPredicates: limit・status・subjectId の細部 > status が %s の行は対象にしない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 179,
      "column": 61
    }
  },
  {
    "name": "${IMPL}.listActiveClaimPredicates: limit・status・subjectId の細部 > subjectId の NULL と非 NULL は一致しない（どちらの向きでも）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 191,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.listLabels / registerLabel: 行は消えず、名前は検査しない > tags にその名前を持つ Memory が forgotten・archived・superseded になっても、行は残り proposedCount も減らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 210,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.listLabels / registerLabel: 行は消えず、名前は検査しない > 空白だけの名前もそのまま registered の行になる（正規化しない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 232,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.aggregateScope の axis: 'taxonomy': 0件の群は載せず、空配列は「残差だけ」 > 候補に在っても0件のラベルは群を作らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 245,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.aggregateScope の axis: 'taxonomy': 0件の群は載せず、空配列は「残差だけ」 > 残差が0件なら key: null の群を載せない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 258,
      "column": 3
    }
  },
  {
    "name": "${IMPL}.aggregateScope の axis: 'taxonomy': 0件の群は載せず、空配列は「残差だけ」 > 空配列は残差（key: null）だけ、undefined は taxonomy の群を1つも作らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges-round3.test.ts",
    "location": {
      "line": 275,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.listBySourceObservation: extractorVersion: null > null を渡すと、その Observation の extractorVersion が null の行だけを返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges.test.ts",
    "location": {
      "line": 24,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.requeueEmbedJobs: 選び方と、古い outbox 行 > updatedAt の古い順・同着は id の昇順で選び、繰り返すと一巡する",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges.test.ts",
    "location": {
      "line": 62,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.requeueEmbedJobs: 選び方と、古い outbox 行 > 失敗済みの古い embed 行には触らず、新しい行を attempts 0 で積む",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges.test.ts",
    "location": {
      "line": 82,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.supersedeWithNewMemories: event.meta.supersededById > 呼び出し側が渡した meta.supersededById は、解決したアンカーの id で上書きし、meta の他の欄は変えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-memory-store-tsdoc-edges.test.ts",
    "location": {
      "line": 134,
      "column": 3
    }
  },
  {
    "name": "in-memory Fake: 負数の limit を渡すと Postgres と同じく例外を投げる > InMemoryOutboxStore.claimBatch は limit が負数のとき、ジョブを claim せずに例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-negative-limit.test.ts",
    "location": {
      "line": 12,
      "column": 3
    }
  },
  {
    "name": "in-memory Fake: 負数の limit を渡すと Postgres と同じく例外を投げる > InMemoryVectorStore.search は limit が負数のとき例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-negative-limit.test.ts",
    "location": {
      "line": 24,
      "column": 3
    }
  },
  {
    "name": "in-memory Fake: 負数の limit を渡すと Postgres と同じく例外を投げる > InMemoryLexicalStore.search は limit が負数のとき例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-negative-limit.test.ts",
    "location": {
      "line": 35,
      "column": 3
    }
  },
  {
    "name": "in-memory Fake: 負数の limit を渡すと Postgres と同じく例外を投げる > InMemoryEventStore.list は filter.limit が負数のとき例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-negative-limit.test.ts",
    "location": {
      "line": 46,
      "column": 3
    }
  },
  {
    "name": "in-memory Fake: 負数の limit を渡すと Postgres と同じく例外を投げる > InMemoryMemoryStore.purgeExpiredEvents は limit が負数（-2）のとき例外を投げ、1行も消さない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-negative-limit.test.ts",
    "location": {
      "line": 52,
      "column": 3
    }
  },
  {
    "name": "in-memory Fake: 負数の limit を渡すと Postgres と同じく例外を投げる > InMemoryMemoryStore.aggregateScope の digestBand: limit が負数のとき例外を投げる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-negative-limit.test.ts",
    "location": {
      "line": 63,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > supersedeWithNewMemories: news の2件目が書けないとき、1件目の Memory・outbox・ラベルも残さない > label",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 54,
      "column": 7
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > supersedeWithNewMemories: news の2件目が書けないとき、1件目の Memory・outbox・ラベルも残さない > ラベルの紐付け（memoryLabels）も残らない（#1231）: eraseTenant の dryRun が数える件数が、呼ぶ前と同じ",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 91,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > supersedeWithNewMemories: news の2件目が書けないとき、1件目の Memory・outbox・ラベルも残さない > 陽性対照: 2件とも書けるなら、両方と outbox・ラベル・イベントが書かれる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 130,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta が structuredClone できないとき、状態を書き換えない > updateStatusWithEvent",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 166,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta が structuredClone できないとき、状態を書き換えない > supersedeWithNewMemories（supersede 側のイベント）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 182,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta が structuredClone できないとき、状態を書き換えない > 投げる入力は増やさない: CAS に弾かれてイベントを書かない対象なら、meta が写せなくても今までどおり conflicted で返る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 208,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta が structuredClone できないとき、状態を書き換えない > markContestedPair（2件目のイベント）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 232,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta が structuredClone できないとき、状態を書き換えない > resolveContestedPair（2件目のイベント）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 247,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta が structuredClone できないとき、状態を書き換えない > resolveOrphanedContested",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 272,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta が structuredClone できないとき、状態を書き換えない > purgeMemory",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 292,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > restoreSupersededBy: イベントが書けないとき、1件目も戻さない > label",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 317,
      "column": 7
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > restoreSupersededBy: イベントが書けないとき、1件目も戻さない > 群が1件だけでも、イベントが書けなければ戻さず、イベントも残らない（at が Invalid Date）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 330,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > restoreSupersededBy: イベントが書けないとき、1件目も戻さない > 投げる入力は増やさない: 戻す対象が無ければ、at が Invalid Date でも今までどおり空で返る（Postgres も、対象が無ければ空で返す）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 344,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > restoreSupersededBy: イベントが書けないとき、1件目も戻さない > 陽性対照: イベントが書けるなら、2件とも戻す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 354,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta・actor に BigInt があるとき、状態を書き換えない（Issue #1384） > EventStore.append",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 371,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta・actor に BigInt があるとき、状態を書き換えない（Issue #1384） > updateStatusWithEvent",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 382,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta・actor に BigInt があるとき、状態を書き換えない（Issue #1384） > supersedeWithNewMemories（supersede 側のイベント）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 398,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta・actor に BigInt があるとき、状態を書き換えない（Issue #1384） > markContestedPair（2件目のイベント）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 424,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta・actor に BigInt があるとき、状態を書き換えない（Issue #1384） > resolveContestedPair（2件目のイベント）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 439,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta・actor に BigInt があるとき、状態を書き換えない（Issue #1384） > resolveOrphanedContested",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 464,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta・actor に BigInt があるとき、状態を書き換えない（Issue #1384） > purgeMemory",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 484,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta・actor に BigInt があるとき、状態を書き換えない（Issue #1384） > restoreSupersededBy",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 500,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta・actor に BigInt があるとき、状態を書き換えない（Issue #1384） > 入れ子・配列の要素・actor の中でも同じく拒む",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 518,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta・actor に BigInt があるとき、状態を書き換えない（Issue #1384） > 配列の要素が入れ子（オブジェクト・配列）で、その奥に BigInt があっても拒む",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 537,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: 途中で投げても、書いた分を残さない（Postgres の1トランザクションと同じ） > イベントの meta・actor に BigInt があるとき、状態を書き換えない（Issue #1384） > 陽性対照: number（123）・数字に見える文字列（\\\"123n\\\"）は引き続き通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-no-partial-write.test.ts",
    "location": {
      "line": 550,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: content に NUL 文字を含むと Postgres と同じく例外を投げる > content の途中に NUL を含むと例外を投げ、Memory を作らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-nul-content.test.ts",
    "location": {
      "line": 11,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: content に NUL 文字を含むと Postgres と同じく例外を投げる > NUL を含まない content は引き続き成功する（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-nul-content.test.ts",
    "location": {
      "line": 27,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: subjectId に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り） > subjectId の途中に NUL を含むと例外を投げ、Memory を作らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-nul-content.test.ts",
    "location": {
      "line": 38,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: subjectId に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り） > subjectId が null は引き続き成功する（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-nul-content.test.ts",
    "location": {
      "line": 53,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: tags の要素に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り） > tags[0] の途中に NUL を含むと例外を投げ、Memory を作らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-nul-content.test.ts",
    "location": {
      "line": 68,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: tags の要素に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り） > NUL を含まない tags は引き続き成功する（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-nul-content.test.ts",
    "location": {
      "line": 83,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: digest に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り） > digest の途中に NUL を含むと例外を投げ、Memory を作らない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-nul-content.test.ts",
    "location": {
      "line": 94,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: digest に NUL 文字を含むと Postgres と同じく例外を投げる（Issue #816 の残り） > NUL を含まない digest は引き続き成功する（回帰確認）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-nul-content.test.ts",
    "location": {
      "line": 109,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: NUL の検査の形（#928） > tags の ${position} 番目の要素に NUL があれば、3要素のうちどこでも断る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-nul-fields-teeth.test.ts",
    "location": {
      "line": 10,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: NUL の検査の形（#928） > content・digest の例外の文言は、それぞれの欄名を名乗る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-nul-fields-teeth.test.ts",
    "location": {
      "line": 23,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: NUL の検査の形（#928） > 文字どおりの \\\\u0000（6文字）や U+2400 は NUL ではないので、content・tags・digest のどれでも断らず、そのまま保存する",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-nul-fields-teeth.test.ts",
    "location": {
      "line": 39,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: Observation の口は、NUL を含む値を Postgres と同じく拒み、何も書かない > createObservationWithOutbox: ${label} に NUL → 例外、Observation も extract ジョブも増えない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-observation-nul.test.ts",
    "location": {
      "line": 37,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: Observation の口は、NUL を含む値を Postgres と同じく拒み、何も書かない > createObservation: ${label} に NUL → 例外",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-observation-nul.test.ts",
    "location": {
      "line": 45,
      "column": 5
    }
  },
  {
    "name": "InMemoryMemoryStore: Observation の口は、NUL を含む値を Postgres と同じく拒み、何も書かない > 同じ externalId の Observation が既に在っても、NUL を含む再送は例外になる（Postgres はクエリの時点で拒む）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-observation-nul.test.ts",
    "location": {
      "line": 53,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: Observation の口は、NUL を含む値を Postgres と同じく拒み、何も書かない > NUL でない値は、これまでどおり受け入れる（回帰確認: 結合文字・ZWJ・RTL・異体字セレクタ・文字どおりの \\\\u0000）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-observation-nul.test.ts",
    "location": {
      "line": 64,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore: Observation の口は、NUL を含む値を Postgres と同じく拒み、何も書かない > toJSON が NUL を返す値は拒む（元の値には NUL が無くても、Postgres が受け取る JSON に NUL がある）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-observation-nul.test.ts",
    "location": {
      "line": 77,
      "column": 6
    }
  },
  {
    "name": "InMemoryMemoryStore: Observation の口は、NUL を含む値を Postgres と同じく拒み、何も書かない > 元の値に NUL があっても、toJSON が消すなら通す（Postgres が受け取る JSON に NUL が無い）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-observation-nul.test.ts",
    "location": {
      "line": 93,
      "column": 6
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: jsonb 列（attributes・provenance）の NUL を Postgres と同じく拒む > attributes の値に NUL → 例外",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-observation-nul.test.ts",
    "location": {
      "line": 104,
      "column": 6
    }
  },
  {
    "name": "InMemoryMemoryStore.createMemory: jsonb 列（attributes・provenance）の NUL を Postgres と同じく拒む > provenance の値に NUL → 例外",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-observation-nul.test.ts",
    "location": {
      "line": 114,
      "column": 6
    }
  },
  {
    "name": "InMemoryMemoryStore.purgeMemory は対象の1件だけを書き換える > 同じテナントの forgotten な別の記憶は、本文・要旨・purgedAt のどれも変わらない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-purge-memory-writes-only-target.test.ts",
    "location": {
      "line": 21,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.purgeMemory は対象の1件だけを書き換える > 別のテナントの forgotten な記憶には、同じ id 空間でも触れない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-purge-memory-writes-only-target.test.ts",
    "location": {
      "line": 49,
      "column": 3
    }
  },
  {
    "name": "findContestedByClaimKey は claimKey の NUL を断る（findActiveByClaimKey と同じ） > subject・predicate の NUL は、名指しの例外になる",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-read-filter-nul.test.ts",
    "location": {
      "line": 23,
      "column": 3
    }
  },
  {
    "name": "findContestedByClaimKey は claimKey の NUL を断る（findActiveByClaimKey と同じ） > やりすぎ: NUL を含まない値（文字どおりの \\\\u0000・日本語）は通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-read-filter-nul.test.ts",
    "location": {
      "line": 33,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search は filter.labels の NUL を断る > labels の要素の NUL は、名指しの例外になる（他の要素が NUL でなくても）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-read-filter-nul.test.ts",
    "location": {
      "line": 46,
      "column": 3
    }
  },
  {
    "name": "InMemoryLexicalStore.search は filter.labels の NUL を断る > やりすぎ: NUL を含まない labels（空配列・文字どおりの \\\\u0000・日本語）は通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-read-filter-nul.test.ts",
    "location": {
      "line": 51,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.search・searchMany は filter.labels・filter.attributes の NUL を断る > labels の要素の NUL",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-read-filter-nul.test.ts",
    "location": {
      "line": 70,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.search・searchMany は filter.labels・filter.attributes の NUL を断る > attributes の key・value の NUL",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-read-filter-nul.test.ts",
    "location": {
      "line": 77,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.search・searchMany は filter.labels・filter.attributes の NUL を断る > searchMany は queries が空でも断る（Postgres は往復の前に絞りを検査する）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-read-filter-nul.test.ts",
    "location": {
      "line": 85,
      "column": 3
    }
  },
  {
    "name": "InMemoryVectorStore.search・searchMany は filter.labels・filter.attributes の NUL を断る > やりすぎ: NUL を含まない絞りは通る",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-read-filter-nul.test.ts",
    "location": {
      "line": 89,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.getRecall は、createRecall に渡した欄をそれぞれ読み戻す > subjectId・budget・omitted・usage・indexBand・explain・query を渡した値のまま返す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-recall-read-back.test.ts",
    "location": {
      "line": 32,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.getRecall は、createRecall に渡した欄をそれぞれ読み戻す > subjectId と budget を省いた記録は、どちらも null で読み戻す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-recall-read-back.test.ts",
    "location": {
      "line": 52,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.getRecall は、createRecall に渡した欄をそれぞれ読み戻す > 返した記憶の内訳は、記憶ごと・並びのまま・欠かさず読み戻す",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-recall-read-back.test.ts",
    "location": {
      "line": 65,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.getRecall は、createRecall に渡した欄をそれぞれ読み戻す > record.tenantId が ctx と違っても、ctx のテナントの記録として書き、別のテナントからは読めない",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-recall-read-back.test.ts",
    "location": {
      "line": 95,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.recordUsageAndReinforce: 挿入した id だけを返して強化する（#980） > at・opts は強化に届く。再送は空配列を返して強化しない。一部だけ新しければ新しい id だけを返して強化する",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-record-usage-and-reinforce-contract.test.ts",
    "location": {
      "line": 55,
      "column": 3
    }
  },
  {
    "name": "InMemoryMemoryStore.recordUsageAndReinforce: 挿入した id だけを返して強化する（#980） > 強化が失敗したとき取り消すのは、この呼び出しで挿入した行だけ（以前に記録済みの行は残り、次の呼び出しで強化し直されない）",
    "file": "/tmp/mgr-7e99c76a/repo/packages/testkit/src/__tests__/in-memory-fixtures-record-usage-and-reinforce-contract.test.ts",
    "location": {
      "line": 78,
      "column": 3
    }
  }
]