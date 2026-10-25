import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {requestAiChat} from '../scripts/ai-chat-adapter.mjs';
import {createAiConnectionService,validateConnectionSample} from '../scripts/ai-connection-service.mjs';
import {createAiAnalysisService} from '../scripts/ai-analysis-service.mjs';
const record=JSON.parse(await readFile(new URL('./fixtures/kimi-connection-fenced-json.json',import.meta.url),'utf8'));
const original=record.response.slice('```json\n'.length,-'\n```'.length);
const connection={baseUrl:'https://api.moonshot.cn/v1',model:'kimi-k2.6',apiKey:'fake-regression-key'};
function response(content=record.response,finish=record.finishReason) {
  return Response.json({choices:[{finish_reason:finish,message:{content}}],usage:{prompt_tokens:record.usage.promptTokens,completion_tokens:record.usage.completionTokens}});
}
async function read(content,finish='stop') {
  return requestAiChat({connection,messages:[],kind:'analysis',signal:new AbortController().signal,fetchImpl:async()=>response(content,finish)});
}

test('supplied Kimi record reproduces old parser error, then passes unchanged semantic validation',async()=>{
  assert.throws(()=>validateConnectionSample(record.response),SyntaxError);
  const result=await read(record.response);
  assert.equal(result.content,original);assert.equal(result.finishReason,'stop');
  assert.deepEqual(validateConnectionSample(result.content),validateConnectionSample(original));
});

test('actual connection test accepts supplied record with exactly one request and one save',async t=>{
  let calls=0,saves=0;
  const service=createAiConnectionService({store:{save:async candidate=>{saves++;assert.deepEqual(candidate,connection);return {storage:'session'};}},fetchImpl:async(_url,options)=>{
    calls++;const body=JSON.parse(options.body);
    assert.equal(body.max_tokens,512);assert.deepEqual(body.thinking,{type:'disabled'});
    assert.deepEqual(JSON.parse(body.messages[1].content),{id:record.subtitles[0].id,text:record.subtitles[0].text});
    return response();
  }});t.after(()=>service.close());
  assert.equal((await service.testAndSave(connection)).connected,true);
  assert.equal(calls,1);assert.equal(saves,1);assert.equal(service.diagnostic(),null);
});

async function runAnalysis(t,content) {
  let calls=0;
  const service=createAiAnalysisService({store:{get:async()=>connection},fetchImpl:async(_url,options)=>{
    calls++;const body=JSON.parse(options.body);assert.equal(body.max_tokens,8000);
    assert.deepEqual(JSON.parse(body.messages[1].content).owned,record.subtitles);
    return response(content);
  }});t.after(()=>service.close());
  const started=service.start(record.subtitles);
  for(let n=0;n<200;n++){
    const job=service.get(started.id);
    if(!['preparing','analyzing'].includes(job.stage))return {job,calls};
    await delay(5);
  }
  throw new Error('Analysis did not finish');
}

test('actual analysis accepts the same real response and applies the same validated semantic result',async t=>{
  const {job,calls}=await runAnalysis(t,record.response);
  assert.equal(job.stage,'complete');assert.equal(job.completedBatches,1);assert.equal(calls,1);
  const plain=await runAnalysis(t,original);
  assert.equal(plain.job.stage,'complete');assert.equal(plain.calls,1);
  assert.deepEqual(job.result,plain.job.result);assert.deepEqual(job.review,plain.job.review);
});

test('one outer json or unlabeled code block supports CRLF and outer whitespace',async()=>{
  for(const content of ['```\n'+original+'\n```',' \n```JSON  \r\n'+original+'\r\n``` \n',record.response]) {
    assert.equal((await read(content)).content,original);
  }
});

test('plain JSON and literal backticks/tags inside JSON strings remain byte-for-byte intact',async()=>{
  const content=JSON.stringify({text:'原文 ```json\n示例\n``` <think>保留</think> 😀'});
  assert.equal((await read(content)).content,content);
  assert.equal((await read('```json\n'+content+'\n```')).content,content);
  assert.equal((await read(' \n'+original+' \n')).content,' \n'+original+' \n');
});

test('prose, multiple fences, wrong language and incomplete fences are not accepted as JSON',async()=>{
  for(const content of ['以下是结果：\n'+record.response,record.response+'\n说明',record.response+'\n'+record.response,
    '```javascript\n'+original+'\n```','```json\n'+original,original+'\n```','````json\n'+original+'\n````']) {
    const result=await read(content);
    assert.throws(()=>JSON.parse(result.content),SyntaxError);
  }
});

test('invalid inner JSON is not repaired, and semantically invalid JSON is still rejected without retries',async t=>{
  const broken='```json\n{"protocolVersion":5,}\n```';
  const normalized=await read(broken);
  assert.throws(()=>JSON.parse(normalized.content),SyntaxError);
  const {job,calls}=await runAnalysis(t,broken);
  assert.equal(job.stage,'failed');assert.equal(job.result,undefined);assert.equal(calls,1);
  const invalid=original.replace('"text":"问题"','"text":"模型改写的字幕"');
  assert.throws(()=>validateConnectionSample(invalid));
  let saved=false,requests=0;
  const service=createAiConnectionService({store:{save:async()=>{saved=true;return {};}},fetchImpl:async()=>{requests++;return response('```json\n'+invalid+'\n```');}});
  t.after(()=>service.close());
  await assert.rejects(()=>service.testAndSave(connection));assert.equal(saved,false);assert.equal(requests,1);
});

test('non-success finish reasons retain the unmodified response and cannot become successful',async()=>{
  for(const reason of ['length','content_filter','tool_calls',null]) {
    const result=await read(record.response,reason);
    assert.equal(result.finishReason,reason);assert.equal(result.content,record.response);
  }
});

test('streamed fenced JSON is normalized after collecting all chunks',async()=>{
  const event=(content,finish=null)=>'data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason:finish}]})+'\n\n';
  const wire=event('```j')+event(record.response.slice(4,-2))+event('``','stop')+'data: [DONE]\n\n';
  const result=await requestAiChat({connection,messages:[],kind:'analysis',signal:new AbortController().signal,
    fetchImpl:async()=>new Response(wire,{headers:{'content-type':'text/event-stream'}})});
  assert.equal(result.content,original);assert.equal(result.finishReason,'stop');
});
