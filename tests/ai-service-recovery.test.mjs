import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { aiModelOptions } from '../scripts/ai-model-options.mjs';
import { createAiAnalysisService, planAiBatches } from '../scripts/ai-analysis-service.mjs';
import { createAiConnectionService } from '../scripts/ai-connection-service.mjs';
import { validateSavedAiAnalysis } from '../lib/ai-result-validation.ts';

const ark = {baseUrl:'https://ark.cn-beijing.volces.com/api/v3',model:'deepseek-v4-1-flash-261017',apiKey:'test-secret-not-a-real-key'};
const cues = (count, text='这是观点内容') => Array.from({length:count},(_,i)=>({id:`c${i+1}`,text,start:i*2,end:i*2+1}));
const plain = owned => ({protocolVersion:5,decisions:owned.map(c=>({cueId:c.id,decision:'plain',reason:'普通字幕'})),focus:[],cards:[],sections:[],outlines:[]});
const response = (output, finish='stop') => Response.json({choices:[{finish_reason:finish,message:{content:JSON.stringify(output)}}]});
const requestInput = options => JSON.parse(JSON.parse(options.body).messages[1].content);
async function until(service,id,predicate=job=>!['preparing','analyzing'].includes(job.stage)) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){const job=service.get(id);if(predicate(job))return job;await delay(5);}
  throw new Error('Mock AI job did not reach expected state');
}
function serviceFor(t, handler, options={}) {
  const calls=[];
  const service=createAiAnalysisService({store:{get:async()=>ark},fetchImpl:async(url,options)=>{
    const input=requestInput(options);calls.push({url,options,input});return handler(input,calls.length,options);
  },...options});
  t.after(()=>service.close());
  return {service,calls};
}
const run=(service,input)=>{const job=service.start(input);return until(service,job.id);};

test('provider options are restricted to documented host/model pairs',()=>{
  for(const model of ['deepseek-flash','deepseek-v4-pro'])assert.deepEqual(aiModelOptions({baseUrl:'https://api.deepseek.com/v1',model}),{thinking:{type:'disabled'}});
  for(const model of ['deepseek-v4-1-flash-261017','deepseek-v4-1-flash-260910','deepseek-v4-flash-ga-260731'])assert.deepEqual(aiModelOptions({...ark,model}),{thinking:{type:'disabled'}});
  for(const connection of [
    {...ark,model:'ep-opaque-id'}, {...ark,model:'unrecognized-model'},
    {...ark,model:'deepseek-flash'}, {...ark,baseUrl:'https://gateway.example/v1'},
    {...ark,baseUrl:'https://ark.cn-beijing.volces.com.example/v3'},
    {baseUrl:'https://gateway.example/v1',model:'deepseek-flash'},
    {baseUrl:'https://api.deepseek.com',model:'deepseek-reasoner'},
  ])assert.deepEqual(aiModelOptions(connection),{});
});

test('short connection test and full analysis share options with the approved adaptive test budget and unchanged sample',async t=>{
  for(const connection of [ark,{...ark,model:'ep-opaque-id'},{...ark,baseUrl:'https://gateway.example/v1'}]){
    const bodies=[];
    const connectionService=createAiConnectionService({store:{save:async()=>({storage:'session'})},fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body);bodies.push(body);
      const sample=JSON.parse(body.messages[1].content);
      assert.deepEqual(sample,{id:'sample-1',text:'先说清楚问题'});
      return response({protocolVersion:5,decisions:[{cueId:'sample-1',decision:'focus',reason:'重点'}],focus:[{ranges:[{cueId:'sample-1',text:'问题',role:'topic',priority:1,granularity:'word'}],relations:['emphasis'],reason:'重点'}],cards:[],sections:[],outlines:[]});
    }});
    t.after(()=>connectionService.close());
    assert.equal((await connectionService.testAndSave(connection)).connected,true);
    const {service,calls}=serviceFor(t,input=>response(plain(input.owned)),{store:{get:async()=>connection}});
    assert.equal((await run(service,cues(2))).stage,'complete');
    const analysis=JSON.parse(calls[0].options.body);
    assert.deepEqual(bodies[0].thinking,analysis.thinking);
    assert.deepEqual(analysis.thinking,aiModelOptions(connection).thinking);
    assert.equal(bodies[0].max_tokens,connection.model===ark.model&&connection.baseUrl===ark.baseUrl?512:2048);assert.equal(analysis.max_tokens,8000);
    assert.equal(analysis.stream,false);assert.equal(calls.length,1);
  }
});

test('default planner retains 40 cues / 6000 UTF-16 units and neighboring context',()=>{
  const source=cues(81);const batches=planAiBatches(source);
  assert.deepEqual(batches.map(b=>b.owned.length),[40,40,1]);
  assert.deepEqual(batches[1].context.map(c=>c.id),['c39','c40','c81']);
  assert.deepEqual(planAiBatches(cues(3,'😀'.repeat(1500))).map(b=>b.owned.length),[2,1]);
});

test('default parent and recovery requests each retain the 90000 ms timeout',async t=>{
  const durations=[],original=AbortSignal.timeout;
  t.mock.method(AbortSignal,'timeout',ms=>{durations.push(ms);return original(ms);});
  const {service}=serviceFor(t,(input,n)=>n===1?response({},'length'):response(plain(input.owned)));
  assert.equal((await run(service,cues(40))).stage,'complete');
  assert.deepEqual(durations,[90000,90000,90000]);
});

test('unknown model retains default parameters and still receives one-level recovery',async t=>{
  const {service,calls}=serviceFor(t,(input,n)=>n===1?response({},'length'):response(plain(input.owned)),{store:{get:async()=>({...ark,model:'ep-opaque-id'})}});
  assert.equal((await run(service,cues(40))).stage,'complete');
  assert.deepEqual(calls.map(c=>c.input.owned.length),[40,20,20]);
  for(const call of calls)assert.equal(JSON.parse(call.options.body).thinking,undefined);
});

test('successful analysis makes only the original requests and remains cacheable',async t=>{
  const source=cues(81),before=structuredClone(source);
  const {service,calls}=serviceFor(t,input=>response(plain(input.owned)));
  const job=await run(service,source);
  assert.equal(job.stage,'complete');assert.equal(job.completedBatches,3);assert.equal(job.totalBatches,3);
  assert.deepEqual(source,before);assert.deepEqual(calls.map(c=>c.input.owned.length),[40,40,1]);
  assert.equal((await run(service,source)).cached,true);assert.equal(calls.length,3);
});

test('only the third of five batches splits on length; results stay private until all batches finish',async t=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const {service,calls}=serviceFor(t,async(input,n)=>{
    if(n===3)return response({},'length');
    if(n===7)await gate;
    return response(plain(input.owned));
  });
  const source=cues(200),started=service.start(source);
  const pending=await until(service,started.id,job=>job.completedBatches===5);
  assert.equal(pending.stage,'analyzing');assert.equal(pending.result,undefined);assert.equal(pending.totalBatches,6);
  release();const job=await until(service,started.id);
  assert.equal(job.stage,'complete');assert.equal(job.completedBatches,6);
  assert.deepEqual(calls.map(c=>c.input.owned.length),[40,40,40,20,20,40,40]);
  assert.deepEqual(calls[3].input.context.map(c=>c.id),['c79','c80','c101','c102']);
  assert.deepEqual(calls[4].input.context.map(c=>c.id),['c99','c100','c121','c122']);
  assert.deepEqual(calls[2].input.globalAnchors,calls[3].input.globalAnchors);
  assert.equal(job.review.decisions.length,200);assert.deepEqual(job.review.unreviewedCueIds,[]);
});

test('a real request timeout splits once and every child receives a new timeout signal',async t=>{
  const {service,calls}=serviceFor(t,(input,n,options)=>{
    if(n===1)return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
    assert.equal(options.signal.aborted,false);return response(plain(input.owned));
  },{timeoutMs:50});
  assert.equal((await run(service,cues(40))).stage,'complete');
  assert.deepEqual(calls.map(c=>c.input.owned.length),[40,20,20]);
  assert.equal(calls[0].options.signal.aborted,true);assert.notEqual(calls[0].options.signal,calls[1].options.signal);
});

test('timeout while reading response body also splits once',async t=>{
  const {service,calls}=serviceFor(t,(input,n)=>n===1?new Response(new ReadableStream({start(){},cancel(){}})):response(plain(input.owned)),{timeoutMs:50});
  assert.equal((await run(service,cues(40))).stage,'complete');assert.equal(calls.length,3);
});

test('recovery respects the 3000-unit cap before the 20-cue cap',async t=>{
  const {service,calls}=serviceFor(t,(input,n)=>n===1?response({},'length'):response(plain(input.owned)));
  assert.equal((await run(service,cues(15,'字'.repeat(400)))).stage,'complete');
  assert.deepEqual(calls.map(c=>c.input.owned.length),[15,7,7,1]);
  assert.ok(calls.slice(1).every(c=>c.input.owned.reduce((n,v)=>n+v.text.length,0)<=3000));
});

for(const kind of ['length','timeout'])test(`child ${kind} does not trigger a second split or process later children`,async t=>{
  const {service,calls}=serviceFor(t,(_input,n,options)=>{
    if(n===1||kind==='length')return response({},'length');
    return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  },{timeoutMs:50});
  const job=await run(service,cues(40));
  assert.equal(job.stage,'failed');assert.equal(job.result,undefined);assert.equal(calls.length,2);
  assert.equal(job.error,kind==='timeout'?'AI 分析超时，工程未改变':'AI 响应未完整结束，未应用任何批次');
});

const terminalFailures = [
  ...[400,401,402,403,404,429,500,504].map(status=>[`HTTP ${status}`,()=>Response.json({error:'provider error'},{status})]),
  ['invalid JSON envelope',()=>new Response('{')],
  ['invalid JSON content',()=>Response.json({choices:[{finish_reason:'stop',message:{content:'not JSON'}}]})],
  ['invalid semantic protocol',()=>response({protocolVersion:999})],
  ['content filter',()=>response({},'content_filter')],
  ['tool call',()=>response({},'tool_calls')],
  ['missing finish reason',()=>Response.json({choices:[]})],
  ['network error',()=>{throw new TypeError('fetch failed');}],
  ['response size limit',()=>new Response('{}',{headers:{'content-length':'2000001'}})],
];
for(const [name,fail] of terminalFailures)test(`${name} does not split or retry`,async t=>{
  const {service,calls}=serviceFor(t,fail);
  const job=await run(service,cues(40));assert.equal(job.stage,'failed');assert.equal(job.result,undefined);assert.equal(calls.length,1);
});

test('a batch already within recovery limits is not retried unchanged',async t=>{
  const {service,calls}=serviceFor(t,()=>response({},'length'));
  assert.equal((await run(service,cues(20))).stage,'failed');assert.equal(calls.length,1);
});

test('an oversized individual subtitle is never cut, rewritten or retried unchanged',async t=>{
  const source=cues(1,'字'.repeat(4000)),before=structuredClone(source);
  const {service,calls}=serviceFor(t,()=>response({},'length'));
  assert.equal((await run(service,source)).stage,'failed');assert.equal(calls.length,1);assert.deepEqual(source,before);
});

test('user cancellation does not split a pending parent request',async t=>{
  const {service,calls}=serviceFor(t,()=>new Promise(()=>{}));
  const started=service.start(cues(40));await until(service,started.id,()=>calls.length===1);
  service.cancel(started.id);await delay(10);
  assert.equal(service.get(started.id).stage,'cancelled');assert.equal(calls.length,1);assert.equal(calls[0].options.signal.aborted,true);
});

test('cancellation after one child success prevents subsequent requests and partial results',async t=>{
  const {service,calls}=serviceFor(t,(input,n)=>n===1?response({},'length'):n===2?response(plain(input.owned)):new Promise(()=>{}));
  const started=service.start(cues(40));await until(service,started.id,()=>calls.length===3);
  service.cancel(started.id);await delay(10);
  const job=service.get(started.id);assert.equal(job.stage,'cancelled');assert.equal(job.result,undefined);assert.equal(calls.length,3);
});

for(const disk of [false,true])test(`resume reuses successful children and skips failed parent (${disk?'disk restart':'memory'})`,async t=>{
  const directory=disk?await mkdtemp(join(tmpdir(),'sc-ai-recovery-')):undefined;
  if(directory)t.after(()=>rm(directory,{recursive:true,force:true}));
  let failChild=true;
  const handler=(input)=>{
    if(input.owned.length===40)return response({},'length');
    if(input.owned[0].id==='c21'&&failChild)return response({},'length');
    return response(plain(input.owned));
  };
  let current=serviceFor(t,handler,{checkpointDirectory:directory});
  const source=cues(40);
  const first=await run(current.service,source);assert.equal(first.stage,'failed');assert.equal(first.completedBatches,1);
  assert.equal(current.calls.length,3);
  if(disk){current.service.close();current=serviceFor(t,handler,{checkpointDirectory:directory});}
  const previous=current.calls.length;failChild=false;
  const second=await run(current.service,source);
  assert.equal(second.stage,'complete');assert.equal(second.review.decisions.length,40);
  assert.equal(current.calls.length-previous,1);assert.equal(current.calls.at(-1).input.owned[0].id,'c21');
  if(directory)assert.ok((await readdir(directory)).length>0);
  // Explicit fresh analysis after completion clears the split plan too.
  const beforeFresh=current.calls.length,started=current.service.start(source,undefined,true);
  assert.equal((await until(current.service,started.id)).stage,'complete');
  assert.equal(current.calls.length-beforeFresh,3);assert.equal(current.calls[beforeFresh].input.owned.length,40);
});

test('split children retain cross-boundary focus, card sources and prior context',async t=>{
  const source=cues(40),ranges=['c20','c21'].map(cueId=>({cueId,text:'观点',role:'topic',priority:1,granularity:'word'}));
  const {service,calls}=serviceFor(t,(input,n)=>{
    if(n===1)return response({},'length');
    const output=plain(input.owned);
    output.decisions=output.decisions.map(d=>['c20','c21'].includes(d.cueId)?{...d,decision:'focus'}:d);
    output.focus=[{groupId:'c20',ranges,relations:['contrast'],reason:'跨句对比'}];
    output.cards=[{sourceCueIds:['c20','c21'],type:'link-quote',reason:'跨句引用'}];
    return response(output);
  });
  const job=await run(service,source);assert.equal(job.stage,'complete');
  assert.equal(job.result.focus.length,1);assert.deepEqual(job.result.focus[0].ranges.map(r=>r.cueId),['c20','c21']);
  assert.deepEqual(job.result.focus[0].relations,['contrast']);assert.equal(job.result.cards.length,1);
  assert.equal(calls[2].input.priorFocus.length,1);assert.deepEqual(job.review.unreviewedCueIds,[]);
  validateSavedAiAnalysis({sources:source,result:job.result,review:job.review},source);
});

test('changed subtitles or connection cannot reuse an earlier split plan or results',async t=>{
  let connection=ark;
  const {service,calls}=serviceFor(t,(input)=>input.owned.length===40?response({},'length'):response(plain(input.owned)),{store:{get:async()=>connection}});
  const source=cues(40);
  assert.equal((await run(service,source)).stage,'complete');assert.equal(calls.length,3);
  source[0].text='改过的字幕';
  assert.equal((await run(service,source)).stage,'complete');assert.equal(calls.length,6);
  connection={...ark,model:'ep-other-model'};
  assert.equal((await run(service,source)).stage,'complete');assert.equal(calls.length,9);
  connection={...connection,baseUrl:'https://gateway.example/v1'};
  assert.equal((await run(service,source)).stage,'complete');assert.equal(calls.length,12);
});
