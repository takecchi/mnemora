# ADR 0356: `createPostgresClient` の `pool` に既定の `error` リスナーを付け、名乗って続行する

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-29

**⚠ 各主張の出所を分ける。**

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `vitest`/`psql`/`pg_terminate_backend` 等を走らせて確かめた。

---

## 問い

[Issue #1213](https://github.com/takecchi/mnemora/issues/1213) が記録したとおり、
`createPostgresClient` が作る `Pool` には、直前の PR #1215（[ADR 0349](./0349-drizzle-pool-proxy-checkout-error-listener.md)
決定4）の時点まで `error` リスナーが一切付いていなかった。pool の中で**待機中**の接続が
DB 側から切られると（Postgres の再起動・フェイルオーバー・運用者による手動切断など）、
`Pool` が `error` を emit し、リスナーが無いので Node のプロセスごと落ちる
（`Unhandled 'error' event`）。PR #1215 はこれを「利用者が `client.pool.on("error", …)` を
付ける」という**今の振る舞いの固定**として README・テストに書き、Issue #1213 自体は
「どれを採るか決めない」まま残した。

Issue #1213 が事実として並べた4案のうち、本 ADR は**案4**（`createPostgresClient` の設定で
付ける・付けないを選べるようにする）を土台に、オーナー承認済みの具体的な設計
（委譲元からこの作業に渡された指示）を実装する。

## 決めたこと

1. **`createPostgresClient` の設定に任意の欄 `onPoolError?: (error: Error) => void` を足す。**
   型は既存の `PoolConfig & SchemaNamespaceOptions` に `& { onPoolError?: ... }` を足す形。
   `schema`/`extensionSchema` と同じく分割代入で明示的に取り除いてから、残りを `Pool` へ渡す
   （`onPoolError` は pg の `PoolConfig` が知らないキーなので、`Pool` には渡さない）。

2. **`createPostgresClient` は、いつでも `pool.on("error", handler)` を付ける。** 以前のように
   「利用者が付けるまでリスナーが無い」という状態を作らない。

3. **`onPoolError` を渡した場合は、それだけを呼ぶ。既定の警告は出さない。**

4. **渡していない場合（既定）は、`console.warn` で名乗る。** 文言は固定の接頭辞
   `[@mnemora/postgres]`（内部定数 `POOL_ERROR_WARNING_PREFIX`、`src/pool-error-warning.ts`）+
   「pool の待機中の接続が失われた。捨てて続行する」の趣旨 + `error.message`。第2引数として
   `error` オブジェクト自体（`code` を含む）も渡す——文字列に潰さない。

5. **二重の警告を抑える。** 既定の警告は、`error` が emit された時点で
   `pool.listenerCount("error") === 1`（自分しか聞いていない）ときだけ出す。利用者が自分で
   `client.pool.on("error", …)` を付けていれば、`onPoolError` を渡していなくても既定の警告は
   出ない。**判定は emit の時点で行うので、`createPostgresClient` の呼び出しと利用者の
   `pool.on` のどちらが先かには依らない**——Node の `EventEmitter` は登録された全リスナーを
   同じ `emit` 呼び出しの中で呼ぶため、後から登録されたリスナーも、先に登録された自分自身の
   ハンドラの中で `listenerCount()` を読む時点では既に数に入っている。

6. **黙って捨てる形（空のリスナー）にはしない。** [ADR 0339](./0339-checked-out-client-error-listener.md)・
   [ADR 0020](./0020-temp-database-drain-before-drop.md) が却下したのは「症状だけを黙らせる」形
   （`pool.on('error', () => {})`）であり、本 ADR の既定の振る舞い（`console.warn` で名乗る）は
   その却下理由に当たらない——下の「ADR 0339・ADR 0020 との区別」を見ること。

7. **接頭辞の定数は、意図してこの package の公開 API（`src/index.ts` の `export *`）に含めない。**
   `src/pool-error-warning.ts` という別モジュールに置き、`client.ts` はそこから import するだけで
   re-export しない。同じ package 内のテスト・setupFile は相対 import で参照できる
   （「引き受けた負債」節に、この設計が生む複製を書く）。

## ADR 0339・ADR 0020 との区別

ADR 0339・ADR 0020 がどちらも却下したのは「**黙って**捨てる」形であり、却下の理由は
「症状（uncaught exception）だけが消え、本当の不具合（ADR 0020 では閉じ切れていない自分の
接続、ADR 0339 は checked-out client の接続断そのもの）を検出できなくなる」ことだった。

本 ADR の既定の振る舞いは、次の点でその却下理由に当たらない。

| | ADR 0339・ADR 0020 が却下した形 | 本 ADR の既定の形 |
|---|---|---|
| 何をするか | `pool.on('error', () => {})`——何もしない | `console.warn(prefix + 趣旨 + message, error)`——**名乗る** |
| 呼び出し元から見える形跡 | 無い（標準出力・標準エラーのどちらにも何も出ない） | `console.warn` の出力として残る（error オブジェクトも渡すので `code` 等も読める） |
| 「本当の不具合」を隠すか | 隠す（ADR 0020 の事例では「自分の接続が閉じ切れていない」ことが分からなくなる） | 隠さない——**そもそも本 ADR が扱う場面（外部要因による接続断）に「隠すべき本当の不具合」は無い**。ADR 0339 が扱ったのは *checked-out*（借りている最中の）接続の断であり、本 ADR は *idle*（待機中の）接続の断——構造が異なる場所である（ADR 0339「⚠ ADR 0020 が却下した案とは別の話である」の表と同じ区別を、ここでも踏襲する） |
| テスト側の見え方 | ADR 0020 はこの区別を「歯」だけでは守れず、`scripts/__tests__/no-unhandled-errors.test.mjs` という別の歯を足した（下の「テストの側の守り」参照） | 本 ADR も同じ形の「握り潰す設定が形を変えて戻ってくる」リスクを持つため、同種の守り（`setup-pool-error-warning-guard.ts`）を`packages/postgres`・`examples/chat` 双方の vitest に足した |

⟹ **本 ADR は ADR 0339・ADR 0020 の判断を覆さない。** 両 ADR が禁じた「空のリスナーで黙らせる」
という*形*を、依然として採らない——ただし「常にリスナーを1つ付ける」という*構造*は Issue #1213
が求めていたものであり、ADR 0339 が同じ構造（`pool.connect()` が返す checked-out client に
共有の no-op リスナーを付ける）を idle 接続の場所ではなく checked-out の場所に採用したのと
対をなす。

## テストの側の守り（ADR 0020 の自傷の事例が、テストで見えなくならないように）

ADR 0020 は「`dangerouslyIgnoreUnhandledErrors` を将来どこかへ足せば、同じ穴が形を変えて
戻ってくる」ことを懸念し、`scripts/__tests__/no-unhandled-errors.test.mjs` という独立の歯を
足した。本 ADR が足す既定の `console.warn` にも、対称的なリスクがある——**この既定の警告が
テストの中で実際に出たら、それは「本来 `onPoolError`/`pool.on("error", …)` を持つべき
テストが持っていない」ことの徴候であり、`console.warn` は vitest の合否に影響しないので、
見えない形で通り過ぎる。**

そこで、`packages/postgres`・`examples/chat` 双方の vitest の `setupFiles` に
`setup-pool-error-warning-guard.ts` を足した。この setupFile は `console.warn` を上書きし、
固定の接頭辞で始まるメッセージが来たら、そのまま `throw` する。この呼び出しは pool の
`'error'` イベントリスナーの中（同期のイベント発火の最中）で起きるため、投げた例外は
どの `try`/`catch` にも拾われず Node の `uncaughtException` になり、vitest はこれを
「unhandled error」として報告して exit code を非0にする——ADR 0020 の動的な歯と同じ仕組みで、
**このパッケージの DB テストの中でこの既定の警告を素通りさせない。**

意図して接続を切るテスト（`readme-unbound-promises.postgres.test.ts` の A〜C・
`pool-idle-connection-loss.test.ts`・`pool-error-warning-guard.postgres.test.ts` 自身の
フィクスチャなど）は、`onPoolError` か `pool.on("error", …)` を自分で持つので、この既定の
警告そのものが出ない——当たらない。子プロセス（`readme-unbound-promises.postgres.test.ts` が
`tsx` で起動するフィクスチャ、`pool-error-warning-guard.postgres.test.ts` が
`pnpm exec vitest` で起動する子）は、この setupFile が効く vitest プロセスの外なので、
守りは効かない——これは意図した振る舞いである（子プロセス自身の中で「落ちるかどうか」を
直接アサーションしている）。

**この守りを縛る歯**（`pool-error-warning-guard.postgres.test.ts`）を、`packages/postgres` の
DB テストとして新設した。守りの setupFile を効かせた使い捨ての vitest 設定 + フィクスチャを
`.tmp/` に生成し、フィクスチャが `onPoolError` を渡さずに `createPostgresClient` を作って
`pg_terminate_backend` で待機中の接続を切る——本物の `pnpm exec vitest run` を子プロセスで
走らせ、**exit code が非0**になり、出力に unhandled error の報告が含まれることを実測する。

## 【実測】赤→緑（`readme-unbound-promises.postgres.test.ts`）

実装前の `main`（この作業の起点）の `client.ts` に対して、新しい歯（A〜C・陽性対照）を
走らせた:

- A（何も付けなくても落ちない）・B（`onPoolError` だけが呼ばれる）は**実際に赤**
  （子プロセスが `Unhandled 'error' event` で落ち、`exitCode !== 0`）になった。
- C-1・C-2（利用者が自分で `pool.on("error", …)` を付けていれば既定の警告は出ない）は、
  実装前の時点でも**見かけ上は green だった**——実装前は「既定の警告」という機構自体が
  存在しないため、「既定の警告が出ない」という assertion は空虚に真になる。これは
  実装後の**変異試験**（下）で初めて意味のある赤になることを別途確かめた。

実装後は、同じ歯（10件）がすべて green になった。

## 【実測】変異試験

1. **`pool.listenerCount("error") === 1` の判定を外す**（既定の警告を無条件に出す変更）:
   `readme-unbound-promises.postgres.test.ts` の C-1・C-2 が実際に赤くなった
   （`toContain`/`not.toContain` の否定側で失敗）。変異を戻すと green に戻ることを確認した。
   このため、上の「C は実装前は見かけ上 green」という観察は、この機構が実在することの
   証拠にはならない——変異試験こそがその証拠である。
2. **`setup-pool-error-warning-guard.ts` の setupFile 参照を外す**
   （`pool-error-warning-guard.postgres.test.ts` が生成する使い捨て vitest 設定の
   `setupFiles` を空にする）: 同歯が実際に赤くなった（子の vitest が exit 0 で終わり、
   `expect(result.status).not.toBe(0)` が失敗）。変異を戻すと green に戻ることを確認した。

いずれも `cp` での退避・変異・確認・復元（`AGENTS.md` の作法）で行い、`git checkout` は
使っていない。

## 検討した代替案

- **案2（README に「付けること」を書くだけ）**: 実装を変えない。Issue #1213 が「実装は
  変わらない」と明記しており、既定でプロセスが落ちるリスクは解消しない。オーナー承認済みの
  設計が案4（設定で選べる）を土台にしているため、この作業では選ばなかった。
- **既定を「黙って捨てる」にする**: 5.節「黙って捨てる形にはしない」で却下——ADR 0339・
  ADR 0020 の却下理由（本当の不具合の隠蔽）には当たらないとはいえ、**運用上の可視性**
  （pool が接続を失っていることに誰も気づけない）を新しく失う。「名乗る」形なら、
  ログを見る運用者に気づく機会が残る。
- **既定の警告を `onPoolError` の有無に関わらず常に出す**（二重抑制をしない）:
  利用者が自分で `pool.on("error", …)` を付けているケースで、mnemora 自身の警告と利用者の
  ログが二重に出る。ノイズになるうえ、「利用者が既に処理している」ことを mnemora が知る
  唯一の手掛かり（`listenerCount`）を使わない理由が無いため採らなかった。

## 引き受けた負債

- **`POOL_ERROR_WARNING_PREFIX` の値が、2箇所に存在する。** 正本は
  `packages/postgres/src/pool-error-warning.ts`。`examples/chat` はこの package の外であり、
  「`@mnemora/postgres` の入口（`src/index.ts`）以外を import しない」という既存の
  パッケージ境界の作法（`examples/chat` のどのファイルも `@mnemora/postgres` の入口からしか
  import していない、という現状の一貫性）を崩さないために、`examples/chat` 側の
  `setup-pool-error-warning-guard.ts` はこの文字列をリテラルとして複製している。
  **正本の文字列を変えたら、複製側も手で直す必要がある**——自動では追随しない。複製元・
  複製先の双方に、どちらが正本かを doc コメントで明記した。
- **`pool.listenerCount("error")` による二重抑制は、`error` イベント特有の Node の
  `EventEmitter` の意味論（同じ `emit` 呼び出しの中で登録済みの全リスナーを呼ぶ）に依存する。**
  将来 `pg`/`pg-pool` が `error` の emit 方法を変える（例: 各リスナーを別の microtask で
  呼ぶ）と、この判定が成り立たなくなる可能性がある——検証していない。
- **`onPoolError` を渡した場合、`listenerCount` を一切見ない**（常にそれだけを呼ぶ）。
  利用者が `onPoolError` と `pool.on("error", …)` を両方使った場合、両方が呼ばれる
  （`onPoolError` は mnemora 既定の警告だけを抑える対象であり、利用者自身の重複は
  関知しない）。これは意図した設計であり、負債ではないが、利用者に「両方使うと2回処理が
  走る」ことの周知は README のコード例の中でしか行っていない。

## 確かめていないこと

- **本番相当の負荷・多重度の下で、`pool.on("error", …)` を常に1つ追加することの性能影響**
  は測っていない——ADR 0339 の同種の判断（「`() => {}` を1つ `on` するだけであり実測の必要は
  薄い」）を踏襲したが、この既定リスナーは `console.warn` を呼びうる分だけ ADR 0339 の
  no-op より重い。実測はしていない。
- **`pg` の将来のバージョンで `Pool` の `'error'` イベントの発火条件・タイミング・
  リスナー呼び出し順序が変わった場合**に、この対策（特に `listenerCount` による二重抑制）が
  今と同じ形で有効かは検証していない（`pg@8.23.0` での実測）。
- **`onPoolError` に渡した関数自身が例外を投げた場合**の振る舞い——`pool.on("error", ...)`
  の中で呼ぶだけなので、その例外は Node の `EventEmitter` の既定動作（他のリスナーへは
  伝播せず、そのハンドラの外へ同期的に投げられる。今回のケースでは `pg-pool` の
  `idleListener` の呼び出し元から見て uncaught exception になりうる）に従う。これは
  `onPoolError` を渡す利用者の責任と位置づけ、mnemora 側で握り潰す・ラップするといった
  追加の処理はしていない——検証もしていない。
