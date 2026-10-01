import { describe, expect, it } from "vitest";
import {
  createIndexIfNotExistsAbsorbingRace,
  isOwnIndexNameCollision,
} from "../create-index-race.js";

/** ADR 0464: 吸収する範囲の線（DB を使わない）。 */

function collision(name: string, constraint = "pg_class_relname_nsp_index", code = "23505") {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code,
    constraint,
    detail: `Key (relname, relnamespace)=(${name}, 2200) already exists.`,
  });
}

function fakeDb(outcomes: Array<Error | "ok">) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      query: async (text: string) => {
        calls.push(text);
        const next = outcomes[calls.length - 1] ?? "ok";
        if (next !== "ok") throw next;
        return {} as never;
      },
    } as unknown as Parameters<typeof createIndexIfNotExistsAbsorbingRace>[0],
  };
}

describe("createIndexIfNotExistsAbsorbingRace（ADR 0464）", () => {
  it("自分の索引名の 23505 は、1回だけ打ち直して通す", async () => {
    const { db, calls } = fakeDb([collision("idx_mine"), "ok"]);
    await createIndexIfNotExistsAbsorbingRace(
      db,
      "CREATE INDEX IF NOT EXISTS idx_mine ON t (a)",
      "idx_mine",
    );
    expect(calls).toHaveLength(2);
  });

  it("別の名前の 23505 は吸収せず、そのまま投げる（打ち直さない）", async () => {
    const error = collision("idx_other");
    const { db, calls } = fakeDb([error, "ok"]);
    await expect(
      createIndexIfNotExistsAbsorbingRace(
        db,
        "CREATE INDEX IF NOT EXISTS idx_mine ON t (a)",
        "idx_mine",
      ),
    ).rejects.toBe(error);
    expect(calls).toHaveLength(1);
  });

  it("名前が前方一致するだけの別の索引（idx_mine_2）も吸収しない", async () => {
    const error = collision("idx_mine_2");
    const { db, calls } = fakeDb([error, "ok"]);
    await expect(
      createIndexIfNotExistsAbsorbingRace(
        db,
        "CREATE INDEX IF NOT EXISTS idx_mine ON t (a)",
        "idx_mine",
      ),
    ).rejects.toBe(error);
    expect(calls).toHaveLength(1);
  });

  it("別の一意制約の 23505・別の SQLSTATE は吸収しない", async () => {
    for (const error of [
      collision("idx_mine", "uq_something"),
      collision("idx_mine", undefined, "42P07"),
    ]) {
      const { db, calls } = fakeDb([error, "ok"]);
      await expect(
        createIndexIfNotExistsAbsorbingRace(
          db,
          "CREATE INDEX IF NOT EXISTS idx_mine ON t (a)",
          "idx_mine",
        ),
      ).rejects.toBe(error);
      expect(calls).toHaveLength(1);
    }
  });

  it("打ち直しても落ちたら、2回目の 23505 をそのまま投げる（打ち直しは1回だけ）", async () => {
    const second = collision("idx_mine");
    const { db, calls } = fakeDb([collision("idx_mine"), second, "ok", "ok"]);
    await expect(
      createIndexIfNotExistsAbsorbingRace(
        db,
        "CREATE INDEX IF NOT EXISTS idx_mine ON t (a)",
        "idx_mine",
      ),
    ).rejects.toBe(second);
    expect(calls).toHaveLength(2);
  });

  it("isOwnIndexNameCollision: detail が無い・文字列でない・null は false", () => {
    expect(isOwnIndexNameCollision(null, "x")).toBe(false);
    expect(
      isOwnIndexNameCollision({ code: "23505", constraint: "pg_class_relname_nsp_index" }, "x"),
    ).toBe(false);
    expect(isOwnIndexNameCollision(new Error("boom"), "x")).toBe(false);
  });
});
