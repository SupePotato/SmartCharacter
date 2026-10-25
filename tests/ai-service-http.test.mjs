// Run after npm run build. Uses the built local service and mocked AI only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalWebServer } from '../dist-local-service/local-web-service.mjs';

test('built HTTP service: connection, one split, no partial results, cache and unchanged failure response',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sc-ai-http-'));
  const calls=[];let rejectAnalysis=false;
  const envelope=(output,finish_reason='stop')=>Response.json({choices:[{finish_reason,message:{content:JSON.stringify(output)}}]});
  const fakeAI=async(_url,options)=>{
    const body=JSON.parse(options.body),input=JSON.parse(body.messages[1].content);
    assert.deepEqual(body.thinking,{type:'disabled'});
    if(!input.owned){
      assert.equal(body.max_tokens,512);
      return envelope({protocolVersion:5,decisions:[{cueId:'sample-1',decision:'focus',reason:'重点'}],focus:[{ranges:[{cueId:'sample-1',text:'问题',role:'topic',priority:1,granularity:'word'}],relations:['emphasis'],reason:'重点'}],cards:[],sections:[],outlines:[]});
    }
    calls.push(input);assert.equal(body.max_tokens,8000);
    if(rejectAnalysis)return Response.json({error:'no quota'},{status:429});
    if(input.owned.length===40&&input.owned[0].id==='c81')return envelope({},'length');
    await delay(10);
    return envelope({protocolVersion:5,decisions:input.owned.map(c=>({cueId:c.id,decision:'plain',reason:'普通字幕'})),focus:[],cards:[],sections:[],outlines:[]});
  };
  const server=createLocalWebServer({root:resolve(import.meta.dirname,'..'),runtime:{directories:{userData:directory,exports:join(directory,'exports'),memory:join(directory,'memory'),notes:join(directory,'notes.json'),cache:join(directory,'cache')},issues:['isolated AI-only test']},connectionOptions:{fetchImpl:fakeAI},analysisOptions:{fetchImpl:fakeAI}});
  try{
    await new Promise((ready,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',ready);});
    const {origin,token}=server.localEnvironment();
    const request=async(path,body)=>{
      const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{'X-SC-Access':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      assert.ok(r.ok,`HTTP ${r.status}`);return r.json();
    };
    assert.equal((await fetch(origin+'/')).status,200);
    assert.equal((await request('/ai/connection/test',{baseUrl:'https://ark.cn-beijing.volces.com/api/v3',model:'deepseek-v4-1-flash-261017',apiKey:'fake-test-key'})).connected,true);
    const cues=Array.from({length:200},(_,i)=>({id:`c${i+1}`,text:'测试字幕',start:i*2,end:i*2+1}));
    const wait=async(job)=>{
      const deadline=Date.now()+5000;
      while(['preparing','analyzing'].includes(job.stage)){
        // Existing service may expose the fully merged result while saving its
        // final checkpoint. The UI applies only stage=complete; never a subset.
        if(job.result)assert.equal(job.review.decisions.length,cues.length);
        assert.ok(Date.now()<deadline,'Job timed out');await delay(5);
        job=await request(`/ai/tasks/${job.id}`);
      }
      return job;
    };
    const job=await wait(await request('/ai/tasks',{cues}));
    assert.equal(job.stage,'complete');assert.equal(job.completedBatches,6);assert.equal(job.totalBatches,6);
    assert.equal(job.review.decisions.length,200);assert.deepEqual(calls.map(c=>c.owned.length),[40,40,40,20,20,40,40]);
    assert.equal((await wait(await request('/ai/tasks',{cues}))).cached,true);assert.equal(calls.length,7);
    rejectAnalysis=true;
    const failed=await wait(await request('/ai/tasks',{cues,fresh:true}));
    assert.equal(failed.stage,'failed');assert.equal(failed.result,undefined);
    assert.equal(failed.error,'AI 请求失败（HTTP 429），请检查连接、模型、权限或额度');assert.equal(calls.length,8);
  }finally{
    server.closeAllConnections();await new Promise(done=>server.close(done));await server.whenIdle();
    await rm(directory,{recursive:true,force:true});
  }
});
