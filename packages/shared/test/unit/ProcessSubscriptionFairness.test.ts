import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { StreamChannel } from "../../src/transport/endpoint/channel/Channel.ts";
import { FrameProtocol } from "../../src/transport/frame/Protocol.ts";
import { FrameStreamChannel, FrameStreamState } from "../../src/transport/frame/Stream.ts";
import { EnvelopeCodec } from "../../src/transport/envelope/Codec.ts";
import { Route } from "../../src/transport/endpoint/route/Route.ts";
import { MessageStream } from "../../src/transport/packet/Stream.ts";
import { ProcessSubscriptionManager } from "../../src/execution/process/Subscription.ts";
import { asInstanceName } from "../../src/types/Instance.ts";
import type { ControlPortContext } from "../../src/control/server/Route.ts";
import type { InstanceEventRecord } from "../../src/client/Stream.ts";

async function subscriber(id: string, consume: boolean) {
    const up = new PassThrough(), down = new PassThrough();
    const opener = new FrameProtocol(new StreamChannel(down, up), { role: "opener" });
    const acceptor = new FrameProtocol(new StreamChannel(up, down), { role: "acceptor" });
    const opening = opener.open("envelope");
    const request = await acceptor.nextOpen();
    assert.ok(request);
    const receiver = await request.accept();
    const sender = await opening;
    assert.ok(sender instanceof FrameStreamState);
    const channel = new FrameStreamChannel(sender);
    const codec = new EnvelopeCodec(channel);
    const route = new Route();
    const port = route.bind("alpha", "instance");
    const stream = new MessageStream(id, port.connectVia(id, "instance", codec, channel), () => {});
    const seen: number[] = [];
    const resume = () => {
        const receiverCodec = new EnvelopeCodec(new FrameStreamChannel(receiver));
        receiverCodec.onEnvelope((envelope) => {
            const packet = envelope.packet as { message?: { name: string; payload: { seq: number } } };
            if (packet.message?.name === "event") seen.push(packet.message.payload.seq);
        });
    };
    if (consume) resume();
    return { stream, sender, seen, resume, close() {
        stream.dispose(); port.close(); opener.close(); acceptor.close(); up.destroy(); down.destroy();
    } };
}

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, "Timed out waiting for subscription progress");
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
}

for (const stop of ["resume", "unsubscribe", "close"] as const)
    test(`healthy same-Instance subscriber progresses at zero foreign Channel credit; ${stop}`, async (t) => {
        const manager = new ProcessSubscriptionManager(2);
        const slow = await subscriber("slow", false);
        const fast = await subscriber("fast", true);
        t.after(() => { manager.close(); slow.close(); fast.close(); });
        const events: InstanceEventRecord[] = [];
        let reads = 0;
        const source = { subscribe(fromSeq = 1) {
            reads++;
            return { kind: "events" as const, lastSeq: events.length,
                events: events.filter((event) => event.seq >= fromSeq) };
        } };
        const context = (id: string) => ({ connectionId: id, requestId: id }) as ControlPortContext;
        let slowReads = 0;
        const slowSource = { subscribe(fromSeq = 1) {
            slowReads++;
            return source.subscribe(fromSeq);
        } };
        await manager.subscribe(slow.stream, context("slow"), "alpha", slowSource, 1);
        await manager.subscribe(fast.stream, context("fast"), "alpha", source, 1);
        for (let i = 1; i <= 800; i++) events.push({
            at: "", instanceName: asInstanceName("alpha"), seq: i, type: "log.appended",
            data: { ctxId: "viewed", stdout: "x".repeat(1000) },
        });
        await until(() => slow.sender.sendCredit === 0);
        await until(() => fast.seen.length === 800);
        const expected = Array.from({ length: 800 }, (_, i) => i + 1);
        assert.deepEqual(fast.seen, expected);
        // Multiple subsequent polls must progress without another send to slow.
        events.push({ at: "", instanceName: asInstanceName("alpha"), seq: 801, type: "instance.started" });
        await until(() => fast.seen.length === 801);
        assert.deepEqual(fast.seen, [...expected, 801]);
        assert.equal(slowReads, 2, "A blocked drain retains one slice instead of buffering each poll");
        if (stop === "resume") {
            slow.resume();
            await until(() => slow.seen.length === 801);
            assert.deepEqual(slow.seen, fast.seen);
        } else {
            if (stop === "unsubscribe") {
                manager.unsubscribeConnection("slow");
                manager.unsubscribeConnection("fast");
            } else manager.close();
            const stoppedReads = reads;
            slow.resume();
            await new Promise<void>((resolve) => setTimeout(resolve, 30));
            assert.equal(reads, stoppedReads);
            assert.ok(slow.seen.length < 800, "Removal must stop the pending slice before its remaining sends");
            assert.equal(fast.seen.length, 801);
        }
    });


test("Manager close releases a seed blocked by real Frame credit before registration completes", async (t) => {
    const manager = new ProcessSubscriptionManager(2);
    const slow = await subscriber("seed-slow", false);
    t.after(() => { manager.close(); slow.close(); });
    let reads = 0;
    const source = { subscribe() {
        reads++;
        return { kind: "events" as const, lastSeq: 1, events: [{
            at: "", instanceName: asInstanceName("alpha"), seq: 1, type: "log.appended",
            data: { stdout: "x".repeat(400_000) },
        }] };
    } };
    const pending = manager.subscribe(slow.stream,
        { connectionId: "seed", requestId: "seed" } as ControlPortContext,
        "alpha", source, 1);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await until(() => slow.sender.sendCredit === 0);
    manager.close();
    await rejected;
    slow.resume();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(reads, 1, "Seed completion after shutdown must not restart polling");
    assert.deepEqual(slow.seen, []);
});
