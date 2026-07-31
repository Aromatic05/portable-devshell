import { describe, expect, it, vi } from "vitest";

import type { WebClients, WebRuntimeStream } from "../src/client/WebClients.js";
import { InstanceStreamSupervisor } from "../src/state/InstanceStreamSupervisor.js";

function clients(subscribe: WebClients["runtime"]["subscribe"]): WebClients {
    return { runtime: { subscribe } } as unknown as WebClients;
}

function callbacks(
    onGap: () => Promise<number> = async () => 0,
    currentSequence = 0,
) {
    return {
        currentSequence: () => currentSequence,
        isCurrent: () => true,
        onEvent: vi.fn(),
        onFailure: vi.fn(),
        onGap,
        onRecovered: vi.fn(),
    };
}

function closedStream(close = vi.fn()): WebRuntimeStream {
    return {
        close,
        next: async () => ({ kind: "closed" }),
    } as unknown as WebRuntimeStream;
}

describe("InstanceStreamSupervisor", () => {
    it("retains exponential backoff when a subscription closes immediately", async () => {
        vi.useFakeTimers();
        let subscriptions = 0;
        const supervisor = new InstanceStreamSupervisor(
            clients(async () => {
                subscriptions += 1;
                return closedStream();
            }),
            callbacks(),
            { random: () => 0, retryBaseMs: 10, stableAfterMs: 100 },
        );

        await supervisor.start("demo", 0, 1);
        await Promise.resolve();
        expect(subscriptions).toBe(1);
        await vi.advanceTimersByTimeAsync(10);
        expect(subscriptions).toBe(2);
        await vi.advanceTimersByTimeAsync(10);
        expect(subscriptions).toBe(2);
        await vi.advanceTimersByTimeAsync(10);
        expect(subscriptions).toBe(3);
        supervisor.closeAll();
        vi.useRealTimers();
    });

    it("backs off when a gap refresh does not advance the sequence", async () => {
        vi.useFakeTimers();
        let subscriptions = 0;
        const supervisor = new InstanceStreamSupervisor(
            clients(async () => {
                subscriptions += 1;
                return {
                    close() {},
                    next: async () => ({ kind: "gap" }),
                } as unknown as WebRuntimeStream;
            }),
            callbacks(async () => 5, 5),
            { random: () => 0, retryBaseMs: 10, stableAfterMs: 100 },
        );

        await supervisor.start("demo", 5, 1);
        await Promise.resolve();
        expect(subscriptions).toBe(1);
        await vi.advanceTimersByTimeAsync(9);
        expect(subscriptions).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(subscriptions).toBe(2);
        supervisor.closeAll();
        vi.useRealTimers();
    });

    it("closes a failed stream before scheduling its replacement", async () => {
        vi.useFakeTimers();
        const close = vi.fn();
        const supervisor = new InstanceStreamSupervisor(
            clients(async () => ({
                close,
                next: async () => { throw new Error("invalid event"); },
            } as unknown as WebRuntimeStream)),
            callbacks(),
            { random: () => 0, retryBaseMs: 10, stableAfterMs: 100 },
        );

        await supervisor.start("demo", 0, 1);
        await Promise.resolve();

        expect(close).toHaveBeenCalledOnce();
        supervisor.closeAll();
        vi.useRealTimers();
    });
});

it("backs off after consecutive gaps even when each resync advances", async () => {
    vi.useFakeTimers();
    let subscriptions = 0;
    let sequence = 5;
    const supervisor = new InstanceStreamSupervisor(
        clients(async () => {
            subscriptions += 1;
            return {
                close() {},
                next: async () => ({ kind: "gap" }),
            } as unknown as WebRuntimeStream;
        }),
        callbacks(async () => ++sequence, sequence),
        { random: () => 0, retryBaseMs: 10, stableAfterMs: 100 },
    );

    await supervisor.start("demo", sequence, 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(subscriptions).toBe(2);
    await vi.advanceTimersByTimeAsync(9);
    expect(subscriptions).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(subscriptions).toBe(3);
    supervisor.closeAll();
    vi.useRealTimers();
});
