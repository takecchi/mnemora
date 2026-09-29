# @mnemora/testkit

adapter（`MemoryStore` / `VectorStore` / `EventStore` / `OutboxStore` /
`TenantSettingsStore` の実装）が満たすべき適合テスト一式（conformance suite）と、
決定的な擬似 `LLMProvider` / `EmbeddingProvider`。

## インストール

```bash
pnpm add -D @mnemora/testkit @mnemora/core vitest
# または
npm i -D @mnemora/testkit @mnemora/core vitest
```

`@mnemora/testkit` は `vitest` に依存している（`describe`/`it`/`expect` を内部で呼ぶ）ため、
**vitest から実行するコード**として使う。テスト対象の adapter を書く側の devDependency として入れる。

**`vitest` は `peerDependencies` である**（ADR 0066）——このパッケージは vitest を同梱せず、
**使う側が入れた vitest をそのまま使う。**そうしないと、使う側の vitest と
このパッケージが引き込む vitest の2つが `node_modules` に並び、`describe` の実体が
食い違って「テストが1本も見つからない」形の壊れ方をしうる。

## 前提

- Node.js >= 22
- **ESM のみ**（`"type": "module"`）。CommonJS からは Node 22.12 以降の
  `require(esm)` で読み込める（TypeScript は `module`/`moduleResolution` を `nodenext` にし、TypeScript 5.8 以降を使うこと。
  5.7 以前の `nodenext` と、どの版の `node16` も `TS1479` になる。`node10` は TypeScript 5.x なら
  パッケージの入口の型を解決できるが、`exports` を読まないので `@mnemora/testkit/fixtures` のような
  subpath は解決できず、TypeScript 6 で非推奨・7 で廃止された。2026-09-27 に TypeScript 5.0〜7.0 で実測）
- 呼び出し側が [vitest](https://vitest.dev/) を使っていること（`describeXxxConformance` は
  内部で `describe`/`it`/`expect` を呼ぶ）

## 動く最小の例（実際に vitest で実行して確認済み）

**adapter 作者は、自分の実装を conformance suite に食わせるだけで、テナント分離・
append-only・並び順・外部キー相当の契約などを検査できる。**以下は `EventStore` を
自作した場合の例（`describeEventStoreConformance` を使う。他に
`describeMemoryStoreConformance` / `describeVectorStoreConformance` /
`describeLexicalStoreConformance` / `describeOutboxStoreConformance` /
`describeTenantSettingsStoreConformance` / `describeEmbeddingProviderConformance` / `describeLLMProviderConformance` がある)。

```ts check
// my-event-store.test.ts
import { randomUUID } from "node:crypto";
import type { Ctx, EventFilter, EventId, EventStore, MemoryEvent, NewMemoryEvent } from "@mnemora/core";
import { describeEventStoreConformance } from "@mnemora/testkit";

// 適合テストは「memoryId が実在の Memory を指しているか」（外部キー相当）も検査する。
// ここでは実際の MemoryStore を持たない最小の例なので、prepareMemoryId が登録した id
// だけを「実在する」ことにする素朴な実装にしてある。
const knownMemoryIds = new Set<string>();

class MyEventStore implements EventStore {
  private rows: MemoryEvent[] = [];

  async append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent> {
    if (event.memoryId !== null && !knownMemoryIds.has(event.memoryId)) {
      throw new Error(`append: unknown memoryId: ${event.memoryId}`);
    }
    // structuredClone で複製して持つ——受け取った入力（meta の配列・オブジェクト）を
    // 呼び手が後から書き換えても、store の中身は変わらない（適合テストが検査する約束）。
    const row: MemoryEvent = structuredClone({
      id: randomUUID(),
      at: event.at ?? new Date(),
      ...event,
    });
    this.rows.push(row);
    return structuredClone(row);
  }

  async get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null> {
    const row = this.rows.find((row) => row.tenantId === ctx.tenantId && row.id === id);
    // 返す値も複製する——呼び手が受け取った値を書き換えても、次の get は影響を受けない。
    return row ? structuredClone(row) : null;
  }

  async list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]> {
    return this.rows
      .filter((row) => row.tenantId === ctx.tenantId)
      .filter((row) => filter.kind === undefined || row.kind === filter.kind)
      .filter((row) => filter.memoryId === undefined || row.memoryId === filter.memoryId)
      .filter((row) => filter.since === undefined || row.at >= filter.since)
      .filter((row) => filter.until === undefined || row.at <= filter.until)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .slice(0, filter.limit);
  }
}

describeEventStoreConformance({
  name: "my-event-store",
  createStore: () => new MyEventStore(),
  prepareMemoryId: async () => {
    const id = randomUUID();
    knownMemoryIds.add(id);
    return id;
  },
});
```

```bash
npx vitest run my-event-store.test.ts
```

## 決定的な擬似 provider

`LLMProvider` / `EmbeddingProvider` の本物（[`@mnemora/openai`](../openai/README.md)）を
CI で叩けない（API キーが無い）場合に備えて、決定的な擬似実装を export している。

```ts check
import { DeterministicLLMProvider, DeterministicEmbeddingProvider } from "@mnemora/testkit";

const llmProvider = new DeterministicLLMProvider();
const embeddingProvider = new DeterministicEmbeddingProvider(); // 既定で 8次元
```

**⚠ これは本物の LLM・埋め込みモデルを模したものではない。**文字コードや文字列長から
機械的に出力を作るだけで、意味的な類似度・言語理解は一切表現しない。**配線・契約・
適合テストのための stub**であり、想起の質を測る物差しにはならない
（`recorded` 層・`openai` 層との違いは [ADR 0051](../../docs/decisions/0051-recorded-provider-cassette.md) を参照）。

## ほかに export しているもの（約束は各 TSDoc）

- **記録を再生する provider**（[ADR 0051](../../docs/decisions/0051-recorded-provider-cassette.md)）:
  `RecordedLLMProvider`・`RecordedEmbeddingProvider` はカセット（`Cassette`）に記録した実 API の応答を再生する。
  **記録に無い入力は例外にする。**録る側は `CassetteRecorder` と、実 provider を包む
  `RecordingLLMProvider`・`RecordingEmbeddingProvider`。カセットの形の検査は `assertCassette`
  （`CASSETTE_FORMAT_VERSION`）、鍵は `llmCassetteKey`・`embeddingCassetteKey`。
- **種カセットから返す provider**: `SeededLLMProvider`・`SeededEmbeddingProvider`。種に在る入力は種から返し、
  **種に無い入力だけ実 provider（`delegate`）へ流す**（`Recorded*` とは逆の規律）。種のモデル名・埋め込み空間が
  `expectedModel`・`expectedSpace`（必須）と食い違えば構築時に落ちる。
- **テストデータのひな型**: `buildNewMemoryFixture`・`buildNewObservationFixture`・`buildNewMemoryEventFixture`・
  `buildProvenanceFixture`。⚠ 実時計で `recall()` を通すなら、`recordedAt`（必要なら `decayFloorAt`）を明示して
  渡すこと（既定値のままだと減衰の床を越えて0件になる。`buildNewMemoryFixture` の TSDoc）。
- **適合スイートの各 options の型**（`MemoryStoreConformanceOptions` など）は、対応する `describe*Conformance` の引数。

## `@mnemora/testkit/fixtures`（インメモリの store。適合スイートの入力にしない）

`@mnemora/testkit/fixtures` は、`InMemoryMemoryStore`・`InMemoryVectorStore`・`InMemoryLexicalStore`・
`InMemoryEventStore`・`InMemoryOutboxStore`・`InMemoryTenantSettingsStore` を export する別の入口である。
DB 無しで `createRuntime` を組み立てて、本物の provider を通しで動かすためにある。

**⛔ これを `describe*Conformance` の `createStore` に渡してはいけない**——自分の adapter を1文字も測らないまま
緑になる（そのため `@mnemora/testkit` の入口からは export していない）。Postgres が拒む入力を同じく拒むが、
例外の顔は違う（`packages/postgres/README.md`「例外の見分け方」）。揃えてあるものと揃えていないものの一覧は
`src/fixtures.ts` の冒頭にある。

## もっと詳しく

- [docs/architecture.md](../../docs/architecture.md) §5 — 各 interface の契約
- [ADR 0051](../../docs/decisions/0051-recorded-provider-cassette.md) — provider の3層
  （`deterministic` / `recorded` / `openai`）の使い分け
- [ADR 0047](../../docs/decisions/0047-fake-referential-integrity-existence-only.md) — 擬似実装の外部キー相当の扱い
- リポジトリ: https://github.com/takecchi/mnemora
