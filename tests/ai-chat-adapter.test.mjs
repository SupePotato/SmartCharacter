import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {resolveAiCapabilities,aiRequestPolicy} from '../scripts/ai-model-options.mjs';
import {buildAiChatRequest,requestAiChat} from '../scripts/ai-chat-adapter.mjs';
import {normalizeConnection,createAiConnectionService} from '../scripts/ai-connection-service.mjs';
import {createAiAnalysisService} from '../scripts/ai-analysis-service.mjs';
const key='test-secret-never-real';
const conn=(baseUrl,model)=>({baseUrl,model,apiKey:key});
const kimi=conn('https://api.moonshot.cn/v1','kimi-k2.6');
const streamConnection=conn('https://dashscope.aliyuncs.com/compatible-mode/v1','qwen3.5-27b');
const minimax=conn('https://api.minimax.cn/v1','MiniMax-M2.5');
const unknown=conn('https://gateway.example/v1','kimi-k2.6');
const mistral=conn('https://api.mistral.ai/v1','zai-glm-5-3');
const messages=[{role:'system',content:'原有系统规则'},{role:'user',content:'原始字幕😀'}];
const disabled={thinking:{type:'disabled'}};
// Independent provider contracts: host/path, model, thinking state, exact optional fields, token field.
const contracts=[
  ['deepseek','https://api.deepseek.com/v1','deepseek-flash','switchable',disabled,'max_tokens'],
  ['ark','https://ark.cn-beijing.volces.com/api/v3','deepseek-v4-1-flash-261017','switchable',disabled,'max_tokens'],
  ['ark','https://ark.cn-beijing.volces.com/api/v3','glm-5-3-flash-260828','required',{},'max_tokens'],
  ['moonshot',kimi.baseUrl,kimi.model,'switchable',disabled,'max_tokens'],
  ['bailian',streamConnection.baseUrl,streamConnection.model,'switchable',{enable_thinking:false},'max_tokens'],
  ['bailian',streamConnection.baseUrl,'qwen3.7-max-preview','required',{},'max_tokens'],
  ['bigmodel','https://open.bigmodel.cn/api/paas/v4','glm-5.2','switchable',disabled,'max_tokens'],
  ['bigmodel','https://open.bigmodel.cn/api/paas/v4','glm-5.3','required',{reasoning_effort:'low'},'max_tokens'],
  ['minimax',minimax.baseUrl,'MiniMax-M3','switchable',{...disabled,reasoning_split:true},'max_completion_tokens'],
  ['minimax',minimax.baseUrl,'MiniMax-M2.5','required',{reasoning_split:true},'max_completion_tokens'],
  ['minimax',minimax.baseUrl,'MiniMax-M3.1-Flash','required',{reasoning_effort:'low',reasoning_split:true},'max_completion_tokens'],
  ['siliconflow','https://api.siliconflow.cn/v1','Qwen/Qwen3-8B','switchable',{enable_thinking:false},'max_tokens'],
  ['siliconflow','https://api.siliconflow.cn/v1','Qwen/Qwen3-8B-Thinking-NEW','unknown',{},'max_tokens'],
  ['tokenhub','https://tokenhub.tencentmaas.com/v1','hy3','switchable',disabled,'max_tokens'],
  ['tokenhub','https://tokenhub.tencentmaas.com/v1','kimi-k2.7-code','required',{},'max_tokens'],
  ['hunyuan','https://api.hunyuan.cloud.tencent.com/v1','hunyuan-unknown','unknown',{},'max_tokens'],
  ['qianfan','https://qianfan.baidubce.com/v2','ernie-unknown','unknown',{},'max_tokens'],
  ['openai','https://api.openai.com/v1','gpt-5.5','switchable',{reasoning_effort:'none'},'max_completion_tokens'],
  ['openai','https://api.openai.com/v1','gpt-6.1-sol','required',{reasoning_effort:'low'},'max_completion_tokens'],
  ['openai','https://api.openai.com/v1','gpt-4.1','absent',{},'max_completion_tokens'],
  ['gemini','https://generativelanguage.googleapis.com/v1beta/openai','gemini-2.5-flash','switchable',{reasoning_effort:'none'},'max_tokens'],
  ['gemini','https://generativelanguage.googleapis.com/v1beta/openai','gemini-2.5-pro','required',{reasoning_effort:'low'},'max_tokens'],
  ['anthropic','https://api.anthropic.com/v1','claude-sonnet-4-6','switchable',disabled,'max_tokens'],
  ['anthropic','https://api.anthropic.com/v1','claude-mythos-preview','required',{},'max_tokens'],
  ['openrouter','https://openrouter.ai/api/v1','moonshotai/kimi-k2.6','switchable',{reasoning:{enabled:false}},'max_tokens'],
  ['openrouter','https://openrouter.ai/api/v1','unlisted/alias','unknown',{},'max_tokens'],
  ['groq','https://api.groq.com/openai/v1','qwen/qwen3.8-27b','switchable',{reasoning_effort:'none'},'max_completion_tokens'],
  ['groq','https://api.groq.com/openai/v1','openai/gpt-oss-20b','required',{reasoning_effort:'low',include_reasoning:false},'max_completion_tokens'],
  ['mistral',mistral.baseUrl,mistral.model,'required',{reasoning_effort:'low'},'max_tokens'],
  ['mistral',mistral.baseUrl,'mistral-small-latest','required',{reasoning_effort:'none'},'max_tokens'],
];
for(const [provider,baseUrl,model,thinking,options,field] of contracts)test(`${provider}: ${model} request contract`,()=>{
  const c=conn(baseUrl,model),cap=resolveAiCapabilities(c),before=structuredClone(messages);
  assert.equal(cap.provider,provider);assert.equal(cap.thinking,thinking);assert.deepEqual(cap.options,options);
  for(const kind of ['connection','analysis']) {
    const request=buildAiChatRequest(c,messages,kind,cap);
    const fast=thinking==='switchable'||thinking==='absent';
    assert.deepEqual(request.body,{model,...options,stream:c.model==='qwen3.5-27b',
      [field]:kind==='analysis'?8000:fast?512:2048,messages});
    assert.equal(request.policy.timeoutMs,kind==='analysis'?90000:fast?15000:30000);
    assert.equal(request.url,baseUrl+'/chat/completions');
  }
  assert.deepEqual(messages,before);
  const future=resolveAiCapabilities({...c,model:'future-unrecognized-id'});
  assert.equal(future.thinking,'unknown');assert.deepEqual(future.options,{});
});

test('host/path identity never follows a model name, URL substring or opaque deployment',()=>{
  for(const baseUrl of ['https://api.moonshot.cn.example/v1','https://example.com/api.moonshot.cn/v1',
    'https://api.moonshot.cn/anthropic','https://api.moonshot.cn:8443/v1','https://gateway.example/v1','http://api.moonshot.cn/v1']) {
    assert.equal(resolveAiCapabilities({...kimi,baseUrl}).provider,'compatible');
    assert.deepEqual(resolveAiCapabilities({...kimi,baseUrl}).options,{});
  }
  for(const baseUrl of ['https://ark.cn-beijing.volces.com/api/v3','https://tokenhub.tencentmaas.com/v1']) {
    assert.deepEqual(resolveAiCapabilities(conn(baseUrl,'ep-secret-deployment')).options,{});
  }
  const full=normalizeConnection({...kimi,baseUrl:kimi.baseUrl+'/chat/completions/'});
  assert.equal(buildAiChatRequest(full,messages,'connection').url,kimi.baseUrl+'/chat/completions');
  assert.equal(resolveAiCapabilities(full).provider,'moonshot');
  for(const baseUrl of ['http://localhost:5000/v1','https://user:pass@example.com/v1','https://api.moonshot.cn/v1?apiKey=secret'])assert.throws(()=>normalizeConnection({...kimi,baseUrl}));
});

test('capability resolution does not expose keys, mutate shared options or exceed model limits',()=>{
  const cap=resolveAiCapabilities(kimi);assert.ok(!JSON.stringify(cap).includes(key));
  cap.options.thinking.type='enabled';assert.equal(resolveAiCapabilities(kimi).options.thinking.type,'disabled');
  assert.equal(aiRequestPolicy({...cap,maxOutputTokens:256},'analysis').tokens,256);
});

const envelope=(content,finish='stop',more={})=>Response.json({choices:[{finish_reason:finish,message:{content,...more}}],usage:{completion_tokens:12}});
async function call(response,connection=unknown,kind='analysis',signal=new AbortController().signal) {
  let calls=0;
  const result=await requestAiChat({connection,messages,kind,signal,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,connection.baseUrl+'/chat/completions');assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,`Bearer ${key}`);return response;
  }});
  assert.equal(calls,1);return result;
}
const event=payload=>`data: ${JSON.stringify(payload)}\n\n`;
const delta=(content,finish=null,extra={})=>({choices:[{index:0,delta:{content,...extra},finish_reason:finish}]});
function sse(text,splitBytes=false) {
  const bytes=Buffer.from(text);
  return new Response(splitBytes?new ReadableStream({start(controller){for(const byte of bytes)controller.enqueue(Uint8Array.of(byte));controller.close();}}):text,
    {headers:{'content-type':'text/event-stream; charset=utf-8'}});
}

test('final text ignores separate reasoning, preserves subtitle tags, supports standard text blocks',async()=>{
  const content='{"text":"字幕<think>原文</think>😀"}';
  assert.equal((await call(envelope(content,'stop',{reasoning_content:'not JSON'}))).content,content);
  assert.equal((await call(envelope([{type:'text',text:content}]))).content,content);
  const blocks=[{type:'thinking',thinking:[{type:'text',text:'not JSON'}]},{type:'text',text:content}];
  assert.equal((await call(envelope(blocks),mistral)).content,content);
  await assert.rejects(()=>call(envelope(blocks)),/Unsupported completion/);
  assert.equal((await call(envelope(' \n<think>private</think> '+content),minimax)).content,content);
  assert.equal((await call(envelope('<think>private</think>'+content))).content,'<think>private</think>'+content);
  await assert.rejects(()=>call(envelope('<think>unfinished'),minimax),/Incomplete thinking/);
});

test('refusal, tools, error envelope and ambiguous endings are never token truncation',async()=>{
  assert.equal((await call(envelope('{}','stop',{refusal:'declined'}))).finishReason,'refusal');
  assert.equal((await call(envelope('{}','length',{tool_calls:[{}]}))).finishReason,'tool_calls');
  assert.equal((await call(envelope(null,'length'))).finishReason,'length');
  assert.equal((await call(envelope(null,'stop',{reasoning_content:'only reasoning'}))).content,'');
  await assert.rejects(()=>call(Response.json({error:{message:key},choices:[{finish_reason:'length'}]})),/Provider completion error/);
  await assert.rejects(()=>call(envelope({unexpected:true})),/Invalid completion content/);
});

test('SSE handles fragmented UTF-8, CRLF, comments, usage and separate reasoning',async()=>{
  const content='{"text":"原文😀"}';
  const wire=': heartbeat\n\n'+event(delta(null,null,{reasoning_content:'秘密思考'}))+event(delta(content.slice(0,5)))+
    event(delta(content.slice(5),'stop'))+event({choices:[],usage:{completion_tokens:15}})+'data: [DONE]\n\n';
  const result=await call(sse(wire.replace(/\n/g,'\r\n'),true),streamConnection);
  assert.equal(result.content,content);assert.equal(result.finishReason,'stop');assert.equal(result.usage.completion_tokens,15);
});

test('SSE only explicit length qualifies as truncation; EOF and DONE are insufficient',async()=>{
  for(const end of ['', 'data: [DONE]\n\n'])assert.equal((await call(sse(event(delta('{'))+end),streamConnection)).finishReason,undefined);
  assert.equal((await call(sse(event(delta(null,'length'))+'data: [DONE]\n\n'),streamConnection)).finishReason,'length');
  await assert.rejects(()=>call(sse(event({error:{message:'no'}})),streamConnection),/Provider stream error/);
  await assert.rejects(()=>call(sse('data: broken\n\n'),streamConnection));
  await assert.rejects(()=>call(sse(event(delta('{}','stop'))+event(delta('extra'))),streamConnection),/Data after completion/);
});

test('body byte limits include reasoning and stream framing, with or without content-length',async()=>{
  for(const kind of ['connection','analysis']) {
    const limit=kind==='connection'?65536:2000000;
    for(const response of [new Response('x',{headers:{'content-length':String(limit+1)}}),new Response('x'.repeat(limit+1))]) {
      await assert.rejects(()=>call(response,unknown,kind),kind==='connection'?/模型测试响应过大/:/AI 响应超过上限/);
    }
  }
});

test('one deadline includes a stream that keeps sending heartbeats; cancel releases the reader',async()=>{
  let cancelled=false,interval;
  const controller=new AbortController();
  const body=new ReadableStream({start(c){interval=setInterval(()=>c.enqueue(Buffer.from(': heartbeat\n\n')),5);},cancel(){cancelled=true;clearInterval(interval);}});
  const timer=setTimeout(()=>controller.abort(new Error('deadline')),40);
  try {await assert.rejects(()=>call(new Response(body,{headers:{'content-type':'text/event-stream'}}),streamConnection,'analysis',controller.signal),/deadline/);}
  finally {clearTimeout(timer);clearInterval(interval);}
  assert.equal(cancelled,true);
});

const sample={protocolVersion:5,decisions:[{cueId:'sample-1',decision:'focus',reason:'重点'}],
  focus:[{ranges:[{cueId:'sample-1',text:'问题',role:'topic',priority:1,granularity:'word'}],relations:['emphasis'],reason:'重点'}],cards:[],sections:[],outlines:[]};
const cues=Array.from({length:40},(_,i)=>({id:`c${i}`,text:'这是原文内容',start:i*2,end:i*2+1}));
const plain=owned=>({protocolVersion:5,decisions:owned.map(c=>({cueId:c.id,decision:'plain',reason:'普通字幕'})),focus:[],cards:[],sections:[],outlines:[]});
async function jobResult(service) {
  const started=service.start(cues);
  for(let n=0;n<200;n++){const job=service.get(started.id);if(!['preparing','analyzing'].includes(job.stage))return job;await delay(5);}
  throw new Error('job did not finish');
}

test('actual connection service chooses 15/30 second deadlines, saves only after validation, never probes',async t=>{
  const timeouts=[];const original=AbortSignal.timeout;
  t.mock.method(AbortSignal,'timeout',ms=>{timeouts.push(ms);return original(ms);});
  for(const [connection,tokens] of [[kimi,512],[unknown,2048],[minimax,2048]]) {
    let calls=0,saved;
    const service=createAiConnectionService({store:{save:async value=>{saved=value;return {storage:'session'};}},fetchImpl:async(_url,options)=>{
      calls++;const body=JSON.parse(options.body);
      assert.equal(body.max_tokens??body.max_completion_tokens,tokens);
      assert.deepEqual(JSON.parse(body.messages[1].content),{id:'sample-1',text:'先说清楚问题'});
      return envelope(JSON.stringify(sample));
    }});t.after(()=>service.close());
    assert.equal((await service.testAndSave(connection)).connected,true);
    assert.deepEqual(saved,connection);assert.equal(calls,1);
  }
  assert.deepEqual(timeouts,[15000,30000,30000]);
});

test('failed and timed-out tests do not save a connection or expose provider bodies',async t=>{
  let saves=0,requests=0;
  const service=createAiConnectionService({store:{save:async()=>{saves++;return {};}},fetchImpl:async()=>{
    requests++;return Response.json({error:{message:key}},{status:400});
  }});t.after(()=>service.close());
  await assert.rejects(()=>service.testAndSave(kimi),error=>!error.message.includes(key)&&error.message.startsWith('连接测试失败'));
  assert.equal(saves,0);assert.equal(requests,1);
  const pending=createAiConnectionService({store:{save:async()=>{saves++;return {};}},timeoutMs:20,fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});
  t.after(()=>pending.close());
  const keepAlive=setTimeout(()=>{},100);
  try {await assert.rejects(()=>pending.testAndSave(kimi),/连接测试超时/);}finally{clearTimeout(keepAlive);}
  assert.equal(saves,0);
});

test('real service path shares capabilities for test and analysis across every provider contract',async t=>{
  for(const [,baseUrl,model,,options,field] of contracts) {
    const connection=conn(baseUrl,model),bodies=[];
    const fetchImpl=async(_url,request)=>{
      const body=JSON.parse(request.body);bodies.push(body);
      const input=JSON.parse(body.messages[1].content);
      const output=input.id==='sample-1'?sample:plain(input.owned);
      return body.stream?sse(event(delta(JSON.stringify(output),'stop'))+'data: [DONE]\n\n'):envelope(JSON.stringify(output));
    };
    const cs=createAiConnectionService({store:{save:async()=>({storage:'session'})},fetchImpl});
    const as=createAiAnalysisService({store:{get:async()=>connection},fetchImpl});
    t.after(()=>{cs.close();as.close();});
    await cs.testAndSave(connection);assert.equal((await jobResult(as)).stage,'complete');
    assert.equal(bodies.length,2);assert.equal(bodies[1][field],8000);
    for(const [name,value] of Object.entries(options)){assert.deepEqual(bodies[0][name],value);assert.deepEqual(bodies[1][name],value);}
  }
});

for(const ending of ['length','missing','error','refusal','tool'])test(`stream analysis ${ending} preserves one-level recovery rules`,async t=>{
  let calls=0;
  const service=createAiAnalysisService({store:{get:async()=>streamConnection},fetchImpl:async(_url,request)=>{
    const owned=JSON.parse(JSON.parse(request.body).messages[1].content).owned;calls++;
    if(calls>1)return sse(event(delta(JSON.stringify(plain(owned)),'stop'))+'data: [DONE]\n\n');
    const payload=ending==='error'?{error:{message:'bad'}}:delta('',ending==='length'?'length':ending==='missing'?null:'stop',
      ending==='refusal'?{refusal:'declined'}:ending==='tool'?{tool_calls:[{}]}:{});
    return sse(event(payload)+'data: [DONE]\n\n');
  }});t.after(()=>service.close());
  const job=await jobResult(service);
  assert.equal(job.stage,ending==='length'?'complete':'failed');assert.equal(calls,ending==='length'?3:1);
});
