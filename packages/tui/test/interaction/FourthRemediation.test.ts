import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfigBatchUpdateRequest } from '@portable-devshell/shared';
import { round6Tui } from '../support/Round6Harness.ts';
import { TuiKeyDispatcher } from '../../src/interaction/Input.ts';
import { createDefaultControlConfig, normalizeConfigInstanceDraft, toConfigView, normalizeConfigDraft } from '../../../shared/src/index.ts';

async function setup(command: string) {
 const updates:ConfigBatchUpdateRequest[]=[];
 const h=round6Tui({onValidateConfigDraft:async draft=>{normalizeConfigDraft(draft);},onConfigUpdate:async request=>{updates.push(request);return {};}});
 const config=createDefaultControlConfig(); config.instances=[normalizeConfigInstanceDraft({name:'alpha',provider:'ssh',ssh:{command}})];
 h.domains.setConfig(toConfigView(config)); h.store.setSelectedPage('config'); h.store.setMainFocusId('provider');
 const box=h.model().boxes.find(b=>b.id==='provider')!; assert.ok(box);
 h.store.toggleExpanded(box.expandedKey);
 await h.dispatcher.dispatch({type:'editor.open',kind:'config',key:'config:alpha'});
 h.store.setSelectedDetailLine(box.expandedKey,'provider:field:ssh.command');
 async function key(input:string,key: Parameters<TuiKeyDispatcher["dispatch"]>[1]["key"]={}){await h.dispatcher.dispatchMany(new TuiKeyDispatcher().dispatch(h.store.getState().interaction.focusScope,{input,key}));}
 await key('',{return:true}); assert.equal(h.store.getState().interaction.editor?.editing,true);
 return {h,updates,key};
}
test('C-T1 regression: one Backspace removes a complete Unicode glyph and saved SSH command remains valid UTF-16',async()=>{
 const {h,key,updates}=await setup('ssh -F /fixture/配置😀');
 await key('',{backspace:true});
 // Continue through real editor validation and save before asserting; the service boundary records the payload.
 assert.equal(await h.dispatcher.dispatch({type:'editor.save'}),true);
 assert.equal(updates.length,1);
 const sent=updates[0]!.instance!.patch.ssh!.command;

 assert.equal(sent,'ssh -F /fixture/配置');
});
test('C-T1 regression: Left followed by insertion never splits a surrogate pair',async()=>{
 const {h,key}=await setup('ssh -F /fixture/配置😀');
 await key('',{leftArrow:true}); await key('X');
 const draft=h.store.getState().ui.formDrafts['config:alpha'] as {ssh:{command:string}};

 assert.equal(draft.ssh.command,'ssh -F /fixture/配置X😀');
});
test('C-T1 negative: BMP text backspace and save are correct',async()=>{
 const {h,key,updates}=await setup('ssh -F /fixture/配置界'); await key('',{backspace:true});
 assert.equal(await h.dispatcher.dispatch({type:'editor.save'}),true);
 assert.equal(updates[0]!.instance!.patch.ssh!.command,'ssh -F /fixture/配置');
});
test('C-T1 negative: revised Context composer deletes an emoji as one grapheme',async()=>{
 const queued:unknown[][]=[]; const h=round6Tui({onContextMessage:async(...args)=>{queued.push(args);}});
 const now=new Date().toISOString();
 h.domains.setContexts([{ctxId:'ctx-c',createdAt:now,lastAccessedAt:now,environments:[{instance:'alpha',workspace:'/fixture'}],status:'active'} as never]);
 h.store.setSelectedPage('messages'); h.store.pushRoute({page:'messages',view:'thread',instance:'alpha',ctxId:'ctx-c'});
 await h.dispatcher.dispatch({type:'contextMessage.edit'});
 await h.dispatcher.dispatch({type:'contextMessage.append',text:'hello😀'});
 await h.dispatcher.dispatch({type:'contextMessage.backspace'});
 await h.dispatcher.dispatch({type:'contextMessage.submit'});
 assert.deepEqual(queued,[['alpha','ctx-c','hello']]);
});

for (const glyph of ['😀', 'e\u0301', '👩🏽‍💻', '🇨🇳']) {
 test(`C-T1 config movement/deletion treats ${glyph} as one grapheme`,async()=>{
  const {h,key}=await setup('ssh '+glyph+'Z');
  await key('',{leftArrow:true}); await key('',{leftArrow:true});
  assert.equal(h.store.getState().interaction.editor?.cursor,4);
  await key('',{rightArrow:true}); await key('',{backspace:true});
  assert.equal((h.store.getState().ui.formDrafts['config:alpha'] as {ssh:{command:string}}).ssh.command,'ssh Z');
 });
 test(`C-T1 wizard movement/insertion/deletion treats ${glyph} as one grapheme`,async()=>{
  const h=round6Tui();
  await h.dispatcher.dispatch({type:'editor.open',kind:'create',key:'create'});
  h.store.setFormDraft('create',{name:'A'+glyph},true);
  h.store.setMainFocusId('create-wizard');
  const box=h.model().boxes.find(b=>b.id==='create-wizard')!;
  h.store.setSelectedDetailLine(box.expandedKey,'create-wizard:field:name');
  h.store.setEditor({...h.store.getState().interaction.editor!,editing:true,cursor:1+glyph.length});
  const input=new TuiKeyDispatcher();
  const key=async(text:string,keys: Parameters<TuiKeyDispatcher["dispatch"]>[1]["key"]={})=>{await h.dispatcher.dispatchMany(input.dispatch('form',{input:text,key:keys}));};
  await key('',{leftArrow:true}); await key('X');
  assert.equal((h.store.getState().ui.formDrafts.create as {name:string}).name,'AX'+glyph);
  await key('',{rightArrow:true}); await key('',{backspace:true});
  assert.equal((h.store.getState().ui.formDrafts.create as {name:string}).name,'AX');
 });
}

import { changedTuiConfigFields, parseTuiWebPatch, parseTuiMcpPatch } from '../../src/state/editor/Config.ts';

test('C-T3 patches only changed nested fields and keeps auth as one credential unit', () => {
 const base={name:'alpha',mcp:{enabled:true,contextMode:'openai-session',auth:'token',token:'secret'},workspace:{enabled:true,inlineToolCalls:false}};
 assert.deepEqual(changedTuiConfigFields(base,{...base,mcp:{...base.mcp,enabled:false}},'instance'),{mcp:{enabled:false}});
 assert.deepEqual(changedTuiConfigFields(base,{...base,mcp:{...base.mcp,token:'new-secret'}},'instance'),{mcp:{auth:'token',token:'new-secret'}});
 assert.deepEqual(changedTuiConfigFields(base,base,'instance'),{});
 assert.deepEqual(changedTuiConfigFields({auth:'token',token:'old'},{auth:'none'},'web'),{auth:'none'});
 assert.equal(parseTuiWebPatch(changedTuiConfigFields({auth:'token',token:'old'},{auth:'none'},'web')).auth,'none');
 const web={enabled:true,listenHost:'127.0.0.1',listenPort:3211,auth:'none'};
 assert.deepEqual(changedTuiConfigFields(web,{...web,listenPort:'3212'},'web'),{listenPort:3212});
 const mcp={enabled:true,listenPort:3210,oauth2:{approval:'token',token:'old'}};
 assert.deepEqual(changedTuiConfigFields(mcp,{...mcp,oauth2:{...mcp.oauth2,token:'new'}},'mcp'),{oauth2:{token:'new'}});
 assert.equal(parseTuiMcpPatch(changedTuiConfigFields(mcp,{...mcp,oauth2:{approval:'tui'}},'mcp')).oauth2?.approval,'tui');
});

test('C-T3 edit then revert stays clean after a concurrent unrelated update', async () => {
 const {h,key,updates}=await setup('ssh host');
 await key('X');
 const config=createDefaultControlConfig();
 config.instances=[normalizeConfigInstanceDraft({name:'alpha',provider:'ssh',ssh:{command:'ssh host'},mcp:{contextMode:'explicit'}})];
 h.domains.setConfig(toConfigView(config));
 await key('',{backspace:true});
 assert.equal(h.store.getState().ui.dirtyForms['config:alpha'],false);
 assert.equal(await h.dispatcher.dispatch({type:'editor.save'}),true);
 assert.equal(updates.length,0);
});
