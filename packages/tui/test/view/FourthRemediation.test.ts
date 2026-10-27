import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { TuiRuntime } from "../../src/app/Runtime.ts";
import { TuiTerminalSession } from "../../src/terminal/emulation/Session.ts";
import { currentTuiRoute, selectMainScreenModel } from "../../src/testing.ts";
import { readContextMessageDraft } from "../../src/state/editor/MessageDraft.ts";
import { TuiDomainHarness } from "../support/DomainHarness.ts";
import type { ConfigBatchUpdateRequest } from "@portable-devshell/shared";

const pause = (ms = 60) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, "TUI state timed out");
        await pause(5);
    }
}

async function launch(columns: number, rows: number, options: { messages?: MessageViewModel; configUpdate?: (request: ConfigBatchUpdateRequest) => unknown } = {}) {
    // Ink uses a shared Chalk instance; enable terminal styles for this in-memory TTY.
    const requireInk = createRequire(createRequire(new URL("../../package.json", import.meta.url)).resolve("ink"));
    const chalk = (await import(requireInk.resolve("chalk"))).default;
    const colorLevel = chalk.level;
    chalk.level = 1;
    class Input extends PassThrough {
        isTTY = true;
        setRawMode() { return this; }
        ref() { return this; }
        unref() { return this; }
    }
    const stdin = new Input();
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows });
    stdout.resume();
    const now = new Date().toISOString();
    const fixture = new TuiDomainHarness({ configUpdate: (request) => options.configUpdate?.(request as ConfigBatchUpdateRequest),
        instanceList: [
            { name: "alpha", enabled: true, mcpEnabled: true, homeDirectory: "/review/home" },
            { name: "beta", enabled: false, mcpEnabled: false, homeDirectory: "/review/beta" },
        ],
        configView: {...toConfigView({ ...createDefaultControlConfig(), instances: [
            normalizeConfigInstanceDraft({ name: "alpha", provider: "local" }),
            normalizeConfigInstanceDraft({ name: "beta", provider: "local" }),
        ] })},
        contextRecords: [{ ctxId: "old", createdAt: now, lastAccessedAt: now,
            environments: [{ instance: "alpha", workspace: "/review/work" }], status: "active" }] as never,
    });
    const domains = fixture.value;
    const historySource = domains.messageHistory as unknown as {
        patch: (state: { context?: unknown }) => void;
    };
    domains.messageHistory.loadContext = async (instance: string, ctxId: string) => {
        historySource.patch({ context: { instance, ctxId, loading: false, historyExhausted: true,
            entries: [{ id: "history", ctxId, kind: "report", createdAt: now,
                text: Array.from({ length: 30 }, (_, index) => `history-${index}`).join("\n") }] } });
    };
    domains.messageHistory.clearContext = () => historySource.patch({ context: undefined });
    const queued: unknown[][] = [];
    const messages = domains.messages as unknown as {
        queue: (...args: unknown[]) => Promise<unknown>;
    };
    messages.queue = async (...args: unknown[]) => { queued.push(args); return {}; };
    const terminal = new TuiTerminalSession({ ptyFactory: () => ({
        kill() {}, resize() {}, write() {},
        onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; },
    }) });
    if (options.messages !== undefined) Object.assign(domains, { messages: options.messages });
    const runtime = new TuiRuntime({ stdin: stdin as never, stdout: stdout as never }, { domains, terminal });
    const running = runtime.run();
    await until(() => runtime.store.getState().connection.status === "connected");
    await pause();
    return {
        runtime, fixture, queued, stdin, stdout,
        async key(raw: string) { stdin.write(raw); await pause(); },
        async close() { await runtime.stop(); await running; stdin.destroy(); stdout.destroy(); chalk.level = colorLevel; },
    };
}


import { Endpoint, Rpc, StreamChannel, MessageViewModel, createMessageTransport, createDefaultControlConfig, normalizeConfigInstanceDraft, applyConfigInstancePatch, toConfigView } from '../../../shared/src/index.ts';
function memoryMessagePeer() {
 const server=new Endpoint({host:'C-virtual-control'}), outbound=new PassThrough(), inbound=new PassThrough();
 const accepting=server.accept(new StreamChannel(outbound,inbound));
 const endpoint=new Endpoint({connectChannel:async()=>new StreamChannel(inbound,outbound)});
 let release!:()=>void, fail!:(error:Error)=>void, entered=false, calls=0;
 const gate=new Promise<void>((resolve,reject)=>{release=resolve;fail=reject;});
 const rpc=new Rpc(server.bind('message','alpha'),{
  queueContextMessage:async(raw: unknown)=>{const input=raw as {ctxId:string; text:string};entered=true;calls++;await gate;return {id:'C-message',instance:'alpha',ctxId:input.ctxId,text:input.text,status:'pending',createdAt:new Date().toISOString()};},
  listContextMessages:()=>({messages:[],lastSeq:0}),
 });
 const model=new MessageViewModel({transport:createMessageTransport(endpoint)});
 return {model,entered:()=>entered,calls:()=>calls,release,fail,async ready(){await endpoint.connect('alpha','message');await accepting;},close(){model.close();rpc.close();endpoint.close();server.close();inbound.destroy();outbound.destroy();}};
}
async function openThread(h:Awaited<ReturnType<typeof launch>>) {
 h.runtime.store.setSelectedInstance('alpha'); await h.key('4');
 for(let i=0;i<5;i++) await h.key('\x1b[B'); await h.key('\r');
 await until(()=>h.runtime.store.getState().interaction.focusScope==='contextMessage');
 assert.equal(currentTuiRoute(h.runtime.store.getState()).view,'thread');
}

test('C-T2 negative: completed Message RPC permits normal Escape, route and Ctrl-D',async()=>{
 const peer=memoryMessagePeer();await peer.ready();peer.release();const h=await launch(80,20,{messages:peer.model});
 try {
  await openThread(h);await h.key('hello');await h.key('\r');await until(peer.entered);
  await until(()=>readContextMessageDraft(h.runtime.store.getState(),'alpha','old')==='');
  await h.key('\x1b');await h.key('0');assert.equal(currentTuiRoute(h.runtime.store.getState()).page,'overview');
  await h.key('\x04');await until(()=>h.fixture.closed()>0);assert.equal(h.fixture.closed(),1);
 }finally{await h.close();peer.close();}
});
test('C-T3 regression: TUI edit of SSH command preserves remote update of unrelated MCP contextMode',async()=>{
 const authoritative=createDefaultControlConfig();authoritative.instances=[normalizeConfigInstanceDraft({name:'alpha',provider:'ssh',ssh:{command:'ssh C-fixture-host'}})];
 const updates:ConfigBatchUpdateRequest[]=[];
 const h=await launch(80,20,{configUpdate:(request)=>{
  updates.push(request);authoritative.instances[0]=normalizeConfigInstanceDraft(applyConfigInstancePatch(authoritative.instances[0]!,request.instance!.patch));return toConfigView(authoritative);
 }});
 try {
  const instance={name:'alpha',provider:'ssh',enabled:true,mcpEnabled:true,homeDirectory:'/fixture',snapshot:{daemonState:'stopped',ready:false}};
  h.fixture.setControlState([instance],{...toConfigView(authoritative)});h.runtime.store.setSelectedInstance('alpha');await h.key('2');
  h.runtime.store.setMainFocusId('provider');const box=selectMainScreenModel(h.runtime.store.getState(),h.runtime.reader).boxes.find(b=>b.id==='provider')!;
  h.runtime.store.toggleExpanded(box.expandedKey);h.runtime.store.setSelectedDetailLine(box.expandedKey,'provider:field:ssh.command');h.runtime.store.setFocusScope('boxDetail');
  await h.key('\r');await h.key('\r');await h.key('X');
  authoritative.instances[0]=normalizeConfigInstanceDraft(applyConfigInstancePatch(authoritative.instances[0]!,{mcp:{contextMode:'explicit'}}));
  h.fixture.setControlState([instance],{...toConfigView(authoritative)});await pause();
  assert.equal(h.runtime.reader.config.view?.instances[0]?.mcp.contextMode,'explicit');
  await h.key('\x13');await until(()=>updates.length>0);
  assert.equal(updates[0]!.instance!.patch.mcp, undefined);
  assert.deepEqual(updates[0]!.instance!.patch.ssh, {command:'ssh C-fixture-hostX'});
  assert.equal(authoritative.instances[0]!.ssh?.command,'ssh C-fixture-hostX');
  assert.equal(authoritative.instances[0]!.mcp.contextMode,'explicit');
 }finally{await h.close();}
});
test('C-T3 negative: editing starts from the updated MCP contextMode and preserves it on save',async()=>{
 const authoritative=createDefaultControlConfig();authoritative.instances=[normalizeConfigInstanceDraft({name:'alpha',provider:'ssh',ssh:{command:'ssh C-fixture-host'},mcp:{contextMode:'explicit'}})];
 const updates:ConfigBatchUpdateRequest[]=[];const h=await launch(80,20,{configUpdate:(request)=>{updates.push(request);authoritative.instances[0]=normalizeConfigInstanceDraft(applyConfigInstancePatch(authoritative.instances[0]!,request.instance!.patch));return toConfigView(authoritative);}});
 try{
  h.fixture.setControlState([{name:'alpha',provider:'ssh',enabled:true,mcpEnabled:true,homeDirectory:'/fixture',snapshot:{daemonState:'stopped',ready:false}}],{...toConfigView(authoritative)});
  h.runtime.store.setSelectedInstance('alpha');await h.key('2');h.runtime.store.setMainFocusId('provider');
  const box=selectMainScreenModel(h.runtime.store.getState(),h.runtime.reader).boxes.find(b=>b.id==='provider')!;
  h.runtime.store.toggleExpanded(box.expandedKey);h.runtime.store.setSelectedDetailLine(box.expandedKey,'provider:field:ssh.command');h.runtime.store.setFocusScope('boxDetail');
  await h.key('\r');await h.key('\r');await h.key('X');await h.key('\x13');await until(()=>updates.length>0);
  assert.equal(authoritative.instances[0]!.ssh?.command,'ssh C-fixture-hostX');assert.equal(authoritative.instances[0]!.mcp.contextMode,'explicit');
 }finally{await h.close();}
});

test('C-T1 real Ink key-to-service regression: SSH editor Backspace must remove one whole non-BMP character',async()=>{
 const h=await launch(80,20);
 try {
  const config=createDefaultControlConfig();config.instances=[normalizeConfigInstanceDraft({name:'alpha',provider:'ssh',ssh:{command:'ssh -F /fixture/配置😀'}})];
  h.fixture.setControlState([{name:'alpha',provider:'ssh',enabled:true,mcpEnabled:true,homeDirectory:'/fixture',snapshot:{daemonState:'stopped',ready:false}}],{...toConfigView(config)});
  h.runtime.store.setSelectedInstance('alpha');await h.key('2');
  h.runtime.store.setMainFocusId('provider');const box=selectMainScreenModel(h.runtime.store.getState(),h.runtime.reader).boxes.find(b=>b.id==='provider')!;
  h.runtime.store.toggleExpanded(box.expandedKey);h.runtime.store.setSelectedDetailLine(box.expandedKey,'provider:field:ssh.command');h.runtime.store.setFocusScope('boxDetail');
  await h.key('\r');await h.key('\r');assert.equal(h.runtime.store.getState().interaction.editor?.editing,true);
  await h.key('\x7f');await h.key('\x13');await until(()=>h.fixture.configUpdates().length>0);
  const request=h.fixture.configUpdates()[0] as ConfigBatchUpdateRequest;
  assert.equal(request.instance!.patch.ssh!.command,'ssh -F /fixture/配置');
 }finally{await h.close();}
});

test('C-T2 pending RPC leaves Escape/navigation/quit usable and repeated Enter sends once', async () => {
 const peer=memoryMessagePeer(); await peer.ready(); const h=await launch(80,20,{messages:peer.model});
 try {
  await openThread(h); await h.key('hello'); await h.key('\r'); await until(peer.entered);
  await h.key('\r'); await h.key('\r'); assert.equal(peer.calls(),1);
  await h.key('\x1b'); await h.key('0');
  assert.equal(currentTuiRoute(h.runtime.store.getState()).page,'overview');
  peer.release(); await until(()=>readContextMessageDraft(h.runtime.store.getState(),'alpha','old')==='');
  assert.equal(currentTuiRoute(h.runtime.store.getState()).page,'overview');
  assert.notEqual(h.runtime.store.getState().interaction.focusScope,'contextMessage');
  assert.equal(peer.calls(),1);
 } finally {peer.release(); await h.close(); peer.close();}
});
test('C-T2 Ctrl-D closes Runtime before pending RPC is released', async () => {
 const peer=memoryMessagePeer(); await peer.ready(); const h=await launch(80,20,{messages:peer.model});
 try {
  await openThread(h); await h.key('hello'); await h.key('\r'); await until(peer.entered);
  await h.key('\x04'); await until(()=>h.fixture.closed()>0);
  assert.equal(h.fixture.closed(),1); assert.equal(peer.calls(),1);
 } finally {peer.release(); await h.close(); peer.close();}
});

test('C-T2 late success preserves text typed while the previous comment is pending', async () => {
 const peer=memoryMessagePeer(); await peer.ready(); const h=await launch(80,20,{messages:peer.model});
 try {
  await openThread(h); await h.key('hello'); await h.key('\r'); await until(peer.entered);
  await h.key(' new draft');
  peer.release(); await until(()=>h.runtime.store.getState().interaction.screenStatusByPage.messages==='Comment queued.');
  assert.equal(readContextMessageDraft(h.runtime.store.getState(),'alpha','old'),'hello new draft');
  assert.equal(peer.calls(),1);
 } finally {peer.release(); await h.close(); peer.close();}
});
test('C-T2 remote failure keeps the draft and reports the error without blocking navigation', async () => {
 const peer=memoryMessagePeer(); await peer.ready(); const h=await launch(80,20,{messages:peer.model});
 try {
  await openThread(h); await h.key('hello'); await h.key('\r'); await until(peer.entered);
  await h.key('\x1b'); await h.key('0'); peer.fail(new Error('fixture queue rejected'));
  await until(()=>h.runtime.store.getState().interaction.screenStatusByPage.messages?.startsWith('Comment failed:')===true);
  assert.equal(readContextMessageDraft(h.runtime.store.getState(),'alpha','old'),'hello');
  assert.equal(currentTuiRoute(h.runtime.store.getState()).page,'overview');
  assert.equal(peer.calls(),1);
 } finally {peer.release(); await h.close(); peer.close();}
});
