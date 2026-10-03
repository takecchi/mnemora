# ADR 0552: オーナーへの問い 374f6f88 の問7・問8・問16 の推奨（どれも「文書に書くだけ」）を、先行して TSDoc・README に書く（コードは変えない）

- **状態**: 採用 (2026-10)（⏸ Draft。期限の 2026-10-03 01:00Z〔JST 10:00〕までに止める番号が来なければ進める。それまでマージしない）
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-c6db44c8 の指示による）が書いた。**オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。オーナーへの問い 374f6f88 の問7・問8・問16 は、どれも推奨が「文書に書くだけ」なので、止める指示が来なければ進められるように先に用意した。**TSDoc のコメントと md だけを変えた。コードの振る舞いは変えていない。**
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

## 問いと推奨

| 問 | 何の問いか | 推奨 | 出どころの ADR |
|---|---|---|---|
| 7 | `@mnemora/anthropic` の `maxTokens` が大きいと、SDK が送信前に素の例外で落ちる。どう扱うか | (a) 文書に書く | [ADR 0445](./0445-local-embedding-chunk-abort-chat-drain-provider-docs.md) BJ-1 |
| 8 | `runMigrations` が `.sql` ゼロ件で成功すること、セッション設定が本体の DDL に効くこと | 両方 (A) 文書に書く | [ADR 0448](./0448-migrate-cli-pool-error-unreadable-dir-session-settings.md) -2・3 |
| 16 | DB エラーの `code` の在り処が3つの形に分かれること | (A) 文書に書く | [ADR 0444](./0444-pool-begin-release-rollback-error-preserved.md) 決定4・BG-3 |

## 問いの前提を、現物で正した記録【現物】

問いの要約と、現物が違った点が2つある。**そのまま残す。**

1. **問8**: 問いの要約は「timeout は本体 DDL にも効く」だった。**だが mnemora 自身は `statement_timeout` を設定していない**（CLI にも `runMigrations` にも無い。src の中ではコメントだけ）。**効くのは利用者側の設定**（ロール・DB・`PGOPTIONS`・接続文字列の `options`）であり、**runner は上書きしない**。runner が触るのは `lock_timeout` だけで、ロックを取った直後に `RESET` する（`migrate.ts` の `RESET lock_timeout` 2か所）。
2. **問7**: 問いの要約は「検査なし」だった。**だが `maxTokens` が正の安全な整数であることは検査している**（`llm-provider.ts` のコンストラクタ。[ADR 0498](./0498-constructor-config-checks.md)）。**見ていないのは上限**で、21334 以上でもコンストラクタは通る。

## 現物【現物】

### 問7（anthropic）
- `complete`・`completeStructured` は `messages.create(…, { signal })` を呼ぶだけで、例外を包まない。
- SDK `@anthropic-ai/sdk` 0.124.0: `client.js` の `calculateNonstreamingTimeout` が `3,600,000 × maxTokens / 128000 > 600,000`（境目は 128000/6 = 21333.33）なら `AnthropicError`（`Streaming is required for operations that may take longer than 10 minutes…`）を投げる。`resources/messages/messages.js` の `create` は、`options.timeout ?? this._client._options.timeout` が無いときだけこれを呼ぶ。
- `_options.timeout` は、コンストラクタに渡した値である（既定の 600000 は `client.timeout` に入るが、`_options.timeout` には入らない）。したがって `client` を省略した既定のクライアントは、この分岐に入る。
- SDK には、一部のモデル名（`claude-opus-4@20250514` など）に別の上限（8192）を持つ表もある（`internal/constants.js`）。【未確認】これは `timeout` が無いときだけ見に行く。実測していない。

### 問8（postgres）
- `listMigrationFiles` は `.sql` が無ければ空配列を返す。`describeLedgerDrift` が (c) として警告の文面を返し、`runMigrations` が `console.warn` して続行、`{ applied: [] }` を返す。止めるオプションは無い。
- CLI（`bin/migrate.ts`）は `runMigrations(pool, undefined, …)` を呼ぶので、同梱の `migrations/` しか使わない。CLI からは空のフォルダに届かない。
- `statement_timeout` を設定するコードは無い。README（「接続・ロール・DB の `statement_timeout` などは、migration の本体にも効く」）に、4通りの渡し方で効くことの実測が既にある（ADR 0448）。

### 問16（postgres）
- drizzle-orm 0.45.2: `node-postgres/session.js` の `transaction` は `this.client.connect()` を `try` の外で呼ぶ（借りる段の失敗は包まれない）。`pg-core/session.js` の `queryWithCache` は、文の実行の失敗を `DrizzleQueryError(query, params, e)` に包む（`cause` が元の例外）。
- `client.ts` の `connectWithErrorListener` は、`pool.connect` の失敗をそのまま reject する。

## 実測【実測】

- **問7**: `@anthropic-ai/sdk` 0.124.0、`fetch` を stub にして（送信の回数を数える）、`client` を省略した SDK のクライアントに `max_tokens` 21333 と 21334 を当てた。21333 は送信が1回（stub の例外が出た）。21334 は送信が0回で、素の `AnthropicError`（`Streaming is required…`）で落ちた。`_options.timeout` は未設定、`client.timeout` は 600000 だった。
- **問16**: 接続拒否（`127.0.0.1:1`）と、応答しない TCP サーバー（`max: 1`・`connectionTimeoutMillis: 300`）で、③ の例外の形を確かめた（接続拒否は `code` を持つ。応答しない TCP サーバーでは `Connection terminated due to connection timeout` で、`code` が無い）。この実測は、指示を受けた時点で担い手のマネージャーが行ったものを引いている。

## 確かめていないこと【未確認】

**手元に Postgres が無い**ので、次は再現していない。**ADR 0448・ADR 0444 と README の実測の記録に頼った。**
- 問8: 空のフォルダを渡したときの副作用（専用スキーマ・拡張が作られること）、`statement_timeout` による巻き戻り（`migration <file> failed: canceling statement due to statement timeout`、台帳に載らない）。
- 問16: `57P01`・`57P03` の形（再起動・接続の切断の最中）。
- 問7: **`timeout` を持たない `client` を自分で渡したときも同じ分岐に入る**ことは、SDK のコードを読んだだけで、実測していない（TSDoc・README にそう書いた）。

## 決定

1. **コードの振る舞いは変えない。** TSDoc のコメントと md だけを変えた。provider 側の `maxTokens` の上限の検査、`kind` の追加、`runMigrations` の strict オプション、DB エラーの形を揃える変更は、どれも足していない（どれも公開の約束が動く。オーナーの領分）。
2. **README はすでにおおむね書いてあった**。空いていたのは主に TSDoc だった。今回書いた場所:

| 問 | 場所 | 書いたこと |
|---|---|---|
| 7 | `packages/anthropic/src/llm-provider.ts` の `AnthropicLLMProviderOptions.maxTokens`・`client` | 検査は正の安全な整数のみ。21333 まで通り 21334 から落ちる。境目の式。避け方（`timeout` を持つ `client`）。実測と読みの区別 |
| 7 | 同 `complete`・`completeStructured` の TSDoc | 例外を包まず、素の `AnthropicError`（`kind`・`cause` なし）が伝わる |
| 7 | `packages/anthropic/src/errors.ts` 冒頭の「`kind` の外の例外」 | 並びに、この例外を1つ足した |
| 7 | `packages/anthropic/README.md`（`maxTokens` の注） | 「21333 まで通り、21334 から落ちる」。条件を【実測】【式からの導出】【読んだだけ】に分けた |
| 8 | `packages/postgres/src/migrate.ts` の `runMigrations`（`migrationsDir` の段、`lock_timeout` の段の後ろ） | ゼロ件は警告して `{ applied: [] }` で成功・strict は無い・CLI からは届かない。mnemora は `statement_timeout` を設定せず、利用者側の設定が本体の DDL に効く・runner は上書きしない・`options=-c statement_timeout=0` の案内 |
| 8 | 同 `listMigrationFiles` | ゼロ件なら空配列。読めないときは `readdirSync` の例外 |
| 8 | `packages/postgres/src/bin/migrate.ts` の CLI の TSDoc | `statement_timeout` を設定しない・`options=-c statement_timeout=0` の案内・README の節への参照 |
| 16 | `packages/postgres/src/client.ts` の `createPostgresClient` | 3つの形の要約と、判定 `err.code ?? err.cause?.code`。README の節への参照。実測と記録に頼ったものの区別 |
| 16 | `packages/postgres/README.md` の表の③ | 「出る場面」に、接続タイムアウトの文面と、実測であることを足した（表は手で整形し直した） |
| — | `CHANGELOG.md` の `[1.3.0]`「Changed」 | 項目を1つ。「⭕ 非破壊と数える（文書の追記のみ）」 |

3. **`packages/postgres/README.md` の問8の節は変えない**（どちらも既に書いてある）。
4. **期限まで Draft で止める。** 2026-10-03 01:00Z までに止める番号が来なければ進める。それまでマージしない。

## 検討した代替案

1. **問7 を provider 側で検査して、独自の `kind` で投げる**（問7 の (b) 以降）。採らなかった。上限は SDK の式で、SDK の版・モデルで変わりうる。mnemora が数を焼き込むと、SDK と食い違う窓ができる。オーナーの判断を待つ。
2. **問8 の `runMigrations` に strict を足す。** 採らなかった。公開 API の追加で、オーナーの判断を待つ。
3. **README に足さず TSDoc だけにする。** 問7 だけ README の既存の注を詳しくした（空いていたのは TSDoc が主だが、境目を詳しくする指示があった）（境目の式と、確かめた範囲）。問8・16 は README が既に書いてあるので変えていない（③ の行に文面を足しただけ）。

## 引き受けた負債

| # | 負債 | 緊急度 |
|---|---|---|
| 1 | 問7 の境目（21333・式）は SDK 0.124.0 のもの。SDK の版が上がれば変わりうる。文書は版を明記しているが、版が上がっても追って直す仕組みは無い | 低 |
| 2 | 問8・16 の Postgres の挙動は、今回再現していない（上の「確かめていないこと」） | 低 |
| 3 | `timeout` を持たない `client` を自分で渡したときの分岐は未実測 | 低 |

## これが覆るとしたら

- オーナーが、問7・8・16 のどれかで「文書だけ」ではなく、コードの側を直す（provider 側の検査・strict・例外の形を揃える）と決めたとき。
- SDK が非ストリーミングの扱いを変えたとき（境目の式・`timeout` の判定）。
