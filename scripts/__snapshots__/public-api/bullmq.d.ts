// ===== dist/index.d.ts =====
export { createBullmqTickDriver, resolveConcurrency } from "./tick-driver.js";
export type { CreateBullmqTickDriverOptions, BullmqTickDriver } from "./tick-driver.js";

// ===== dist/tick-driver.d.ts =====
import type { ConnectionOptions } from "bullmq";
import type { Ctx, Runtime, TickOptions, TickResult } from "@mnemora/core";
export interface CreateBullmqTickDriverOptions {
    connection: ConnectionOptions;
    queueName: string;
    runtime: Pick<Runtime, "tick">;
    ctx: Ctx;
    tick: TickOptions;
    everyMs: number;
    concurrency?: number | undefined;
    lockDuration?: number | undefined;
    completedJobsToKeep?: number | undefined;
    jobName?: string | undefined;
    onTickResult?: ((result: TickResult) => void) | undefined;
    onTickError?: ((error: unknown) => void) | undefined;
}
export interface BullmqTickDriver {
    start(): Promise<void>;
    stop(): Promise<void>;
}
export declare function resolveConcurrency(concurrency?: number): number;
export declare function createBullmqTickDriver(opts: CreateBullmqTickDriverOptions): BullmqTickDriver;
