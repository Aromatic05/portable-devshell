import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { ControlPortContext, ControlPortDefinition } from '@portable-devshell/shared';
import type { ControlAcceptedChannel } from '../../../../src/server/transport/channel/Listener.ts';
import { ChannelBase } from '../../../../../../packages/shared/src/transport/endpoint/channel/Channel.ts';
import { Endpoint } from '../../../../../../packages/shared/src/transport/endpoint/Endpoint.ts';
import { Rpc } from '../../../../../../packages/shared/src/transport/packet/Rpc.ts';
import { Stream } from '../../../../../../packages/shared/src/transport/packet/Stream.ts';
import { ControlTransportServer } from '../../../../../../packages/control/src/server/transport/endpoint/Server.ts';
import { CONTROL_PROTOCOL_RANGE } from '../../../../../../packages/shared/src/control/server/Model.ts';
import { routeModule } from '../../../../../../packages/shared/src/control/server/Route.ts';
import { createToolTransport } from '../../../../../../packages/shared/src/execution/toolcall/Transport.ts';
import { createProcessTransport } from '../../../../../../packages/shared/src/execution/process/Transport.ts';
import { receiveToolCallResult, ToolCallCallbackServer } from '../../../../../../packages/shared/src/execution/toolcall/TargetTransport.ts';
import { WorkerToolInvoker } from '../../../../../../packages/core/src/toolcall/worker/Invoker.ts';
import { WorkerToolCatalog } from '../../../../../../packages/core/src/toolcall/worker/Catalog.ts';
import { ControlExtensionRouteService } from '../../../../../../packages/control/src/extension/api/point/control/Dispatch.ts';

class MemoryChannel extends ChannelBase {
    peer!: MemoryChannel;
    async write(data: Uint8Array) {
        assert.equal(this.closed, false);
        assert.equal(this.peer.closed, false);
        const copy = Uint8Array.from(data);
        queueMicrotask(() => this.peer.emitData(copy));
    }
    close(error?: Error) {
        if (this.closed) return;
        this.finish(error);
        this.peer.close(error);
    }
}
function pair() {
    const a = new MemoryChannel();
    const b = new MemoryChannel();
    a.peer = b; b.peer = a;
    return [a, b] as const;
}
const drain = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(r => setImmediate(r)); };
function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}
async function attach(server: Endpoint, host: string) {
    const [local, remote] = pair();
    const accepting = server.accept(remote);
    const endpoint = new Endpoint({host, connectChannel: async () => local});
    const connection = await endpoint.connect(server.host, 'probe');
    await accepting;
    return {endpoint, connection, local, remote};
}

test('BUG-A1: same Host/id RPC cancellation must stay on original Channel', async t => {
    const server = new Endpoint({host: 'server'});
    const held = deferred();
    const signals: AbortSignal[] = [];
    const rpc = new Rpc(server.bind('probe'), {wait: async (_message, ctx) => {
        signals.push(ctx.signal); await held.promise; return {};
    }});
    const a = await attach(server, 'shared-host');
    const b = await attach(server, 'shared-host');
    t.after(() => { held.resolve(); a.endpoint.close(); b.endpoint.close(); rpc.close(); server.close(); });
    await a.connection.send({protocol:'rpc', type:'request', id:'collision', method:'wait'});
    await drain();
    await b.connection.send({protocol:'rpc', type:'request', id:'collision', method:'wait'});
    await drain();
    await a.connection.send({protocol:'rpc', type:'cancel', id:'collision'});
    await drain();
    const observed = signals.map(s => s.aborted);
    assert.deepEqual(observed, [true, false]);
});

test('CONTROL: different RPC ids cancel A only, and replies retain Channel', async t => {
    const server = new Endpoint({host:'server'});
    const held = deferred();
    const signals: AbortSignal[] = [];
    const rpc = new Rpc(server.bind('probe'), {wait: async (message, ctx) => {
        signals.push(ctx.signal); await held.promise; return message;
    }});
    const a = await attach(server, 'shared-host');
    const b = await attach(server, 'shared-host');
    t.after(() => { held.resolve(); a.endpoint.close(); b.endpoint.close(); rpc.close(); server.close(); });
    const packetsA: unknown[] = [], packetsB: unknown[] = [];
    a.connection.onPacket(p => { packetsA.push(p); });
    b.connection.onPacket(p => { packetsB.push(p); });
    await a.connection.send({protocol:'rpc', type:'request', id:'A', method:'wait', message:'A'});
    await drain();
    await b.connection.send({protocol:'rpc', type:'request', id:'B', method:'wait', message:'B'});
    await drain();
    await a.connection.send({protocol:'rpc', type:'cancel', id:'A'});
    await drain();
    assert.deepEqual(signals.map(s => s.aborted), [true, false]);
    held.resolve(); await drain();
    assert.deepEqual(packetsA, [{protocol:'rpc',type:'reply',id:'A',message:'A'}]);
    assert.deepEqual(packetsB, [{protocol:'rpc',type:'reply',id:'B',message:'B'}]);
});

async function controlFixture(t: TestContext, extraPorts: ControlPortDefinition[] = []) {
    let accept!: (input: ControlAcceptedChannel) => void;
    const disconnected: string[] = [];
    const held = deferred();
    let signal!: AbortSignal;
    const signals: AbortSignal[] = [];
    const server = new ControlTransportServer({
        listeners: [{start: async cb => { accept = cb; }, close: async () => {}}],
        routes: {onChange: () => () => {}, hosts: () => [{host:'@control', ports:[
            routeModule('server', {hello: () => ({})}),
            routeModule('probe', {wait: async (_request, context) => {
                signal = context.signal; signals.push(signal); await held.promise; return {};
            }}), ...extraPorts
        ]}]},
        onConnectionDetached: id => { disconnected.push(id); },
    });
    await server.start();
    const [local, remote] = pair();
    accept({channel: remote, admission:{allowedPeers:['cli'], subject:{kind:'local-owner',id:'audit-fixture'}}});
    const endpoint = new Endpoint({host:'audit-caller',connectChannel:async () => local});
    const hello = new Rpc(await endpoint.connect('@control','server'));
    await hello.request('hello',{clientKind:'cli',protocolRange:CONTROL_PROTOCOL_RANGE});
    hello.close();
    const rpc = new Rpc(await endpoint.connect('@control','probe'));
    t.after(async () => { held.resolve(); rpc.close(); endpoint.close(); await server.close(); await drain(); });
    return {server,endpoint,rpc,remote,disconnected, held, signals, accept, signal:() => signal};
}

test('BUG-A2: physical caller close must abort Control RPC context', async t => {
    const f = await controlFixture(t);
    const outcome = f.rpc.request('wait').then(() => 'reply', (e: { code?: string }) => e.code);
    await drain();
    f.remote.close(new Error('caller departed'));
    await drain();
    assert.equal(await outcome, 'rpc.resultUncertain');
    assert.equal(f.disconnected.length, 1);
    assert.equal(f.signal().aborted, true);
});

test('CONTROL: explicit RPC cancellation reaches Control RPC context', async t => {
    const f = await controlFixture(t);
    const controller = new AbortController();
    const outcome = f.rpc.request('wait',undefined,controller.signal).then(() => 'reply', e => e.message);
    await drain(); controller.abort(new Error('cancelled')); await drain();
    assert.equal(await outcome, 'cancelled');
    assert.equal(f.signal().aborted, true);
});

test('BUG-A3: successful gateway replacement must release old outgoing RPC and Stream', async t => {
    const server = new Endpoint({host:'worker',preserveAcceptedPeers:true,authorizePeerPromotion:() => true});
    const held = deferred();
    const rpcServer = new Rpc(server.bind('probe'), {ping: () => ({}), wait: async () => {await held.promise; return 'old-result';}});
    const streamServer = new Stream(server.bind('stream'));
    streamServer.onOpen(() => {});
    const channels: MemoryChannel[] = [];
    const client = new Endpoint({host:'control',connectChannel:async () => {
        const [a,b] = pair(); channels.push(a); void server.accept(b); return a;
    }});
    const rpc = new Rpc(await client.connect('worker','probe'));
    const streams = new Stream(await client.connect('worker','stream'));
    t.after(() => {held.resolve(); rpc.close(); streams.close(); client.close(); rpcServer.close(); streamServer.close(); server.close();});
    let rpcResult = 'pending', streamResult = 'pending';
    const result = rpc.request('wait').then(() => {rpcResult='reply';}, () => {rpcResult='rejected';});
    const stream = await streams.open('wait');
    void stream.readMessage().then(() => {streamResult='terminal';}, () => {streamResult='rejected';});
    await drain();
    await client.reconnect({preserveExisting:true,verify:async connect => {
        const check = new Rpc(connect('worker','probe'));
        try {await check.request('ping');} finally {check.close();}
    }});
    held.resolve(); await drain();
    assert.equal(channels[0].closed,true);
    assert.deepEqual({rpcResult,streamResult},{rpcResult:'rejected',streamResult:'rejected'});
    await result;
});

test('BUG-A5: published ToolTransport streaming cancellation must settle caller', async t => {
    const server = new Endpoint({host:'instance-a'});
    const streams = new Stream(server.bind('tool'));
    let cancelled = false;
    streams.onOpen(stream => {stream.onCancel(() => {cancelled = true;});});
    const client = await attach(server,'audit-client');
    t.after(() => {client.endpoint.close(); streams.close(); server.close();});
    const tool = createToolTransport(client.endpoint,'instance-a');
    const controller = new AbortController();
    let outcome = 'pending';
    void tool.callStreaming('bash',{command:'long-running'},'/virtual/workspace',{signal:controller.signal})
        .then(() => {outcome='resolved';}, () => {outcome='rejected';});
    await drain(); controller.abort(new Error('user cancelled')); await drain();
    assert.equal(cancelled,true);
    assert.equal(outcome,'rejected');
});

test('CONTROL: published ToolTransport rejects remote cancel', async t => {
    const server = new Endpoint({host:'instance-a'});
    const streams = new Stream(server.bind('tool'));
    streams.onOpen(async (stream,_name,message) => {
        assert.equal((message as { workspace: string }).workspace,'/virtual/workspace');
        await stream.cancel({message:'remote cancellation'});
    });
    const client = await attach(server,'audit-client');
    t.after(() => {client.endpoint.close(); streams.close(); server.close();});
    const tool = createToolTransport(client.endpoint,'instance-a');
    await assert.rejects(tool.callStreaming('bash',{},'/virtual/workspace'), /remote cancellation/);
});

test('BUG-A1-Control: authenticated Control sessions with reused Host/id isolate cancellation', async t => {
    const f = await controlFixture(t);
    const [local,remote] = pair();
    f.accept({channel:remote,admission:{allowedPeers:['cli'],subject:{kind:'local-owner',id:'audit-fixture'}}});
    const b = new Endpoint({host:f.endpoint.host,connectChannel:async () => local});
    t.after(() => b.close());
    const hello = new Rpc(await b.connect('@control','server'));
    await hello.request('hello',{clientKind:'cli',protocolRange:CONTROL_PROTOCOL_RANGE}); hello.close();
    const aConnection = await f.endpoint.connect('@control','probe');
    const bConnection = await b.connect('@control','probe');
    await aConnection.send({protocol:'rpc',type:'request',id:'collision',method:'wait'}); await drain();
    await bConnection.send({protocol:'rpc',type:'request',id:'collision',method:'wait'}); await drain();
    assert.equal(f.signals.length,2);
    await aConnection.send({protocol:'rpc',type:'cancel',id:'collision'}); await drain();
    assert.deepEqual(f.signals.map(s => s.aborted),[true,false]);
});

test('BUG-A1-cleanup: completion of A must not erase active cancellation entry B', async t => {
    const server = new Endpoint({host:'server'});
    const first = deferred(), second = deferred();
    const signals: AbortSignal[] = [];
    const rpc = new Rpc(server.bind('probe'), {A:async (_value,ctx) => {
        signals.push(ctx.signal); await first.promise; return {};
    }, B:async (_value,ctx) => {
        signals.push(ctx.signal); await second.promise; return {};
    }});
    const a = await attach(server,'shared-host'), b = await attach(server,'shared-host');
    t.after(() => {first.resolve(); second.resolve(); a.endpoint.close(); b.endpoint.close(); rpc.close(); server.close();});
    await a.connection.send({protocol:'rpc',type:'request',id:'collision',method:'A'}); await drain();
    await b.connection.send({protocol:'rpc',type:'request',id:'collision',method:'B'}); await drain();
    first.resolve(); await drain();
    await b.connection.send({protocol:'rpc',type:'cancel',id:'collision'}); await drain();
    assert.equal(signals[1].aborted,true);
});

test('CONTROL: physical disconnect without replacement releases outgoing RPC and Stream', async t => {
    const server = new Endpoint({host:'server'});
    const held = deferred();
    const rpcServer = new Rpc(server.bind('probe'),{wait:async () => {await held.promise; return {};}});
    const streamServer = new Stream(server.bind('stream'));
    const a = await attach(server,'caller');
    const rpc = new Rpc(a.connection);
    const streams = new Stream(await a.endpoint.connect('server','stream'));
    t.after(() => {held.resolve(); rpc.close(); streams.close(); a.endpoint.close(); rpcServer.close(); streamServer.close(); server.close();});
    const result = assert.rejects(rpc.request('wait'),{code:'rpc.resultUncertain',retryable:false});
    const stream = await streams.open('wait');
    const read = assert.rejects(stream.readMessage(),/ordinary disconnect/);
    await drain(); a.remote.close(new Error('ordinary disconnect')); await drain();
    await result; await read;
});

test('CONTROL: candidate validation failure keeps accepted outgoing calls usable', async t => {
    const server = new Endpoint({host:'worker'});
    const held = deferred();
    const rpcServer = new Rpc(server.bind('probe'),{wait:async () => {await held.promise; return 'kept';}});
    const channels: MemoryChannel[] = [];
    const client = new Endpoint({host:'control',connectChannel:async () => {
        const [a,b]=pair(); channels.push(a); void server.accept(b); return a;
    }});
    const rpc = new Rpc(await client.connect('worker','probe'));
    t.after(() => {held.resolve(); rpc.close(); client.close(); rpcServer.close(); server.close();});
    const result = rpc.request('wait'); await drain();
    await assert.rejects(client.reconnect({preserveExisting:true,verify:async () => {throw new Error('candidate invalid');}}),/candidate invalid/);
    assert.equal(channels[0].closed,false);
    held.resolve(); assert.equal(await result,'kept');
});

test('BUG-A3-Invoker: real WorkerToolInvoker must settle after successful handoff', async t => {
    const worker = new Endpoint({host:'worker',preserveAcceptedPeers:true,authorizePeerPromotion:() => true});
    const held = deferred();
    const core = new Rpc(worker.bind('core'),{ping:() => ({})});
    const tools = new Rpc(worker.bind('tool'),{audit_probe:async () => {await held.promise; return {ok:true};}});
    const controller = new Endpoint({host:'control',connectChannel:async () => {
        const [a,b]=pair(); void worker.accept(b); return a;
    }});
    const catalog = new WorkerToolCatalog();
    catalog.refresh([{name:'audit_probe',group:'audit',description:'Virtual audit tool',inputSchema:{type:'object',properties:{}},outputSchema:{type:'object'},requiredCapabilities:[]}]);
    const invoker = new WorkerToolInvoker(controller,'worker',catalog);
    t.after(() => {held.resolve(); controller.close(); core.close(); tools.close(); worker.close();});
    let outcome='pending';
    void invoker.invoke('audit_probe',{}).then(() => {outcome='resolved';}, () => {outcome='rejected';});
    await drain();
    await controller.reconnect({preserveExisting:true,verify:async connect => {
        const check=new Rpc(connect('worker','core')); try {await check.request('ping');} finally {check.close();}
    }});
    held.resolve(); await drain();
    assert.equal(outcome,'rejected');
});

test('BUG-A5-Process: published ProcessTransport cancellation must settle snapshot', async t => {
    const server=new Endpoint({host:'instance-a'});
    const streams=new Stream(server.bind('process'));
    let cancelled=false;
    streams.onOpen(stream => {stream.onCancel(() => {cancelled=true;});});
    const client=await attach(server,'audit-client');
    t.after(() => {client.endpoint.close(); streams.close(); server.close();});
    const process=createProcessTransport(client.endpoint,'instance-a');
    const handle=await process.start();
    let outcome='pending';
    void handle.snapshot.then(() => {outcome='resolved';},() => {outcome='rejected';});
    await drain(); handle.cancel(); await drain();
    assert.equal(cancelled,true);
    assert.equal(outcome,'rejected');
});

test('CONTROL: ToolCall callback abort message keeps stream until Instance terminal', async t => {
    const server=new Endpoint({host:'instance-a'});
    const streams=new Stream(server.bind('tool'));
    let aborted=false;
    streams.onOpen(async stream => {
        const callbacks=new ToolCallCallbackServer(stream);
        await new Promise<void>(resolve => callbacks.signal.addEventListener('abort',() => {aborted=true; resolve();},{once:true}));
        await stream.close({ok:true,result:{cancelled:true}});
        callbacks.close();
    });
    const client=await attach(server,'audit-client');
    const outgoing=new Stream(await client.endpoint.connect('instance-a','tool'));
    t.after(() => {client.endpoint.close(); outgoing.close(); streams.close(); server.close();});
    const stream=await outgoing.open('ingress');
    const controller=new AbortController();
    const result=receiveToolCallResult(stream,{signal:controller.signal});
    await drain(); controller.abort(new Error('cancel tool')); await drain();
    assert.equal(aborted,true);
    assert.deepEqual(await result,{cancelled:true});
});

test('CONTROL: malformed Frame header physically closes Channel', async t => {
    const server=new Endpoint({host:'server'});
    const rpc=new Rpc(server.bind('probe'));
    const client=await attach(server,'caller');
    t.after(() => {client.endpoint.close(); rpc.close(); server.close();});
    await client.local.write(new Uint8Array(32)); await drain();
    assert.equal(client.remote.closed,true);
    assert.equal(client.local.closed,true);
});

async function extensionFixture(t: TestContext) {
    const finish=deferred();
    let signal!:AbortSignal;
    let leases=0;
    const declaration={id:'audit-wait',module:'audit',operation:'wait',scope:'control'};
    const service=new ControlExtensionRouteService({
        listDeclarations:(point:string) => point==='control.routes' ? [{id:declaration.id,declaration,extensionId:'audit',generation:'isolated',pointId:point}] : [],
        onChange:() => () => {},
        acquireRegistration:async () => {
            leases++;
            return {extensionId:'audit',registration:{id:declaration.id,declaration,pointId:'control.routes',binding:async (_request: unknown,context: ControlPortContext) => {
                signal=context.signal;
                await Promise.race([finish.promise,new Promise<void>(resolve => signal.addEventListener('abort',() => resolve(),{once:true}))]);
                return {};
            }},lease:{generation:'isolated',manifest:{} as never,retirementSignal:new AbortController().signal,release:() => {leases--;}}};
        }
    } as unknown as ConstructorParameters<typeof ControlExtensionRouteService>[0]);
    const f=await controlFixture(t,[...service.modules('control')]);
    const rpc=new Rpc(await f.endpoint.connect('@control','audit'));
    t.after(async () => {finish.resolve(); rpc.close(); await drain();});
    return {...f, rpc, leases:() => leases, extensionSignal:() => signal};
}

test('BUG-A2-Extension: disconnect must release signal-aware real Extension route lease', async t => {
    const f=await extensionFixture(t);
    const outcome=f.rpc.request('wait').then(() => 'reply',(e: { code?: string }) => e.code);
    await drain(); assert.equal(f.leases(),1);
    f.remote.close(new Error('caller disconnect')); await drain();
    assert.equal(await outcome,'rpc.resultUncertain');
    assert.equal(f.leases(),0);
});

test('CONTROL: explicit cancel releases signal-aware real Extension route lease', async t => {
    const f=await extensionFixture(t);
    const controller=new AbortController();
    const result=f.rpc.request('wait',undefined,controller.signal).then(() => 'reply',e => e.message);
    await drain(); assert.equal(f.leases(),1);
    controller.abort(new Error('explicit cancel')); await drain();
    assert.equal(await result,'explicit cancel');
    assert.equal(f.leases(),0);
});

test('CONTROL: closing obsolete peer preserves newer same-Host route', async t => {
    const server=new Endpoint({host:'server'});
    const port=server.bind('probe');
    const a=await attach(server,'shared-host'), b=await attach(server,'shared-host');
    t.after(() => {a.endpoint.close(); b.endpoint.close(); server.close();});
    await a.connection.send({protocol:'event',name:'announce-A'}); await drain();
    await b.connection.send({protocol:'event',name:'announce-B'}); await drain();
    a.remote.close(); await drain();
    const messages:unknown[]=[];
    b.connection.onPacket(packet => {messages.push(packet);});
    await port.connect('shared-host','probe').send({protocol:'event',name:'new-owner'}); await drain();
    assert.deepEqual(messages,[{protocol:'event',name:'new-owner'}]);
});

test('BUG-A5-resources: repeated local cancel must unsubscribe each real Port protocol', async t => {
    const server=new Endpoint({host:'instance-a'});
    const streams=new Stream(server.bind('tool'));
    streams.onOpen(() => {});
    const client=await attach(server,'audit-client');
    t.after(() => {client.endpoint.close(); streams.close(); server.close();});
    const port=client.endpoint.bind('tool');
    const original=port.onPacket.bind(port);
    const active=new Set<symbol>();
    port.onPacket=listener => {
        const key=Symbol('observed real subscription'); active.add(key);
        const off=original(listener);
        return () => {active.delete(key); off();};
    };
    const tool=createToolTransport(client.endpoint,'instance-a');
    for (let index=0;index<16;index++) {
        const controller=new AbortController();
        void tool.callStreaming('audit_probe',{},'/virtual/workspace',{signal:controller.signal}).then(() => {},() => {});
        await drain(); controller.abort(); await drain();
    }
    assert.equal(active.size,0);
});

test('CONTROL: remote terminal unsubscribes real client Port protocol', async t => {
    const server=new Endpoint({host:'instance-a'});
    const streams=new Stream(server.bind('tool'));
    streams.onOpen(async stream => {await stream.close({result:'complete'});});
    const client=await attach(server,'audit-client');
    t.after(() => {client.endpoint.close(); streams.close(); server.close();});
    const port=client.endpoint.bind('tool');
    const original=port.onPacket.bind(port);
    const active=new Set<symbol>();
    port.onPacket=listener => {
        const key=Symbol('observed real subscription'); active.add(key);
        const off=original(listener);
        return () => {active.delete(key); off();};
    };
    const tool=createToolTransport(client.endpoint,'instance-a');
    assert.deepEqual(await tool.callStreaming('audit_probe',{},'/virtual/workspace'),{result:'complete'});
    assert.equal(active.size,0);
});

for (const terminal of ['close', 'cancel'] as const) {
    test(`A5 local ${terminal} settles readers and reentrant callbacks exactly once`, async t => {
        const server = new Endpoint({host:'server'});
        const serving = new Stream(server.bind('probe'));
        serving.onOpen(() => {});
        const client = await attach(server, 'caller');
        const streams = new Stream(client.connection);
        t.after(() => {streams.close(); serving.close(); client.endpoint.close(); server.close();});
        const stream = await streams.open('wait');
        const read = stream.readMessage();
        const result = terminal === 'cancel' ? assert.rejects(read, /local terminal/) : read;
        let notifications = 0;
        const callback = () => {
            notifications++;
            void stream.close();
            void stream.cancel();
            streams.close();
        };
        stream.onClose(callback);
        stream.onCancel(callback);
        await (terminal === 'close' ? stream.close('done') : stream.cancel({message:'local terminal'}));
        assert.equal(notifications, 1);
        assert.deepEqual(await result, terminal === 'close' ? {type:'close', message:'done'} : undefined);
        let late = 0;
        (terminal === 'close' ? stream.onClose.bind(stream) : stream.onCancel.bind(stream))(() => {late++;});
        await drain();
        assert.equal(late, 1);
        assert.equal(notifications, 1);
    });
}

test('A3 retained outgoing RPC and Stream reject other Channel input and keep original traffic', async t => {
    const caller = new Endpoint({host:'caller'});
    caller.bind('probe');
    const a = await attach(caller, 'shared-host');
    await a.connection.send({protocol:'event', name:'announce'});
    await drain();
    const peerPort = a.endpoint.bind('peer');
    const serverRpc = new Rpc(peerPort);
    const serverStreams = new Stream(peerPort);
    const held = deferred();
    let requestId = '';
    serverRpc.handle('wait', async (_message, context) => {
        requestId = context.requestId;
        await held.promise;
        return 'original';
    });
    const cancellationSignals: AbortSignal[] = [];
    serverRpc.handle('cancel-me', async (_message, context) => {
        cancellationSignals.push(context.signal);
        await held.promise;
        return {};
    });
    const received: string[] = [];
    serverStreams.onOpen(stream => {stream.onData(message => {received.push(String(message));});});
    const connection = caller.bind('outgoing').connect('shared-host', 'peer');
    const rpc = new Rpc(connection);
    const streams = new Stream(connection);
    t.after(() => {held.resolve(); rpc.close(); streams.close(); serverRpc.close(); serverStreams.close(); a.endpoint.close(); caller.close();});
    let outcome = 'pending';
    const result = rpc.request('wait').then(value => {outcome = String(value);});
    const stream = await streams.open('held');
    const incomingData: unknown[] = [];
    stream.onData(message => {incomingData.push(message);});
    const cancellation = new AbortController();
    const cancelled = assert.rejects(rpc.request('cancel-me', undefined, cancellation.signal), /cancel original/);
    await drain();
    const b = await attach(caller, 'shared-host');
    await b.connection.send({protocol:'event', name:'announce'});
    await drain();
    t.after(() => b.endpoint.close());
    const replacement = await b.endpoint.connect('caller', connection.local.port);
    const packets: unknown[] = [];
    replacement.onPacket(packet => {packets.push(packet);});
    await replacement.send({protocol:'rpc', type:'reply', id:requestId, message:'wrong-channel'});
    await replacement.send({protocol:'stream', type:'data', id:stream.id, seq:1, message:'wrong-channel'});
    await drain();
    assert.equal(outcome, 'pending');
    assert.deepEqual(incomingData, []);
    cancellation.abort(new Error('cancel original'));
    await cancelled;
    await drain();
    assert.equal(cancellationSignals[0]!.aborted, true);
    await stream.send('original-channel');
    await stream.close();
    await drain();
    assert.deepEqual(received, ['original-channel']);
    assert.deepEqual(packets, []);
    held.resolve();
    await result;
    assert.equal(outcome, 'original');
    await b.connection.send({protocol:'event', name:'announce'});
    await drain();
    const freshServer = new Rpc(b.endpoint.bind('peer'), {fresh: () => 'replacement'});
    t.after(() => freshServer.close());
    assert.equal(await rpc.request('fresh'), 'replacement');
});

test('A1/A2 disconnect removes only original Channel request and preserves same-id cancellation', async t => {
    const server = new Endpoint({host:'server'});
    const held = deferred();
    const signals: AbortSignal[] = [];
    const rpc = new Rpc(server.bind('probe'), {wait: async (_message, context) => {
        signals.push(context.signal);
        await held.promise;
        return {};
    }});
    const a = await attach(server, 'shared-host');
    const b = await attach(server, 'shared-host');
    t.after(() => {held.resolve(); a.endpoint.close(); b.endpoint.close(); rpc.close(); server.close();});
    await a.connection.send({protocol:'rpc', type:'request', id:'same', method:'wait'});
    await drain();
    await b.connection.send({protocol:'rpc', type:'request', id:'same', method:'wait'});
    await drain();
    a.remote.close(new Error('A disconnect'));
    await drain();
    assert.deepEqual(signals.map(signal => signal.aborted), [true, false]);
    await b.connection.send({protocol:'rpc', type:'cancel', id:'same'});
    await drain();
    assert.deepEqual(signals.map(signal => signal.aborted), [true, true]);
});
