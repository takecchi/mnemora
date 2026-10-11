import { describe, expect, it } from "vitest";
import { OutboxJobRecordSchema } from "../outbox.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");

const queuedJob = {
  id: "job-1",
  tenantId: "t1",
  kind: "embed",
  payload: {},
  availableAt: NOW,
  attempts: 0,
  createdAt: NOW,
};

describe("OutboxJobRecordSchema は、OutboxJobRecord の doc が null と書く状態のジョブを通す", () => {
  it.each([
    [
      "一度も claim されていない（claimedAt・completedAt・failedAt が null）",
      { claimedAt: null, completedAt: null, failedAt: null },
    ],
    [
      "claim されたが未完了で失敗もしていない（completedAt・failedAt が null）",
      { claimedAt: NOW, claimedBy: "worker-1", attempts: 1, completedAt: null, failedAt: null },
    ],
    [
      "完了して失敗していない（failedAt が null）",
      { claimedAt: NOW, claimedBy: "worker-1", attempts: 1, completedAt: NOW, failedAt: null },
    ],
  ])("%s ジョブは通る", (_state, fields) => {
    expect(OutboxJobRecordSchema.safeParse({ ...queuedJob, ...fields }).success).toBe(true);
  });
});
