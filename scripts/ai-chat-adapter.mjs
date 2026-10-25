import { aiRequestPolicy, resolveAiCapabilities } from './ai-model-options.mjs';

// A single deadline covers connection, headers and all response bytes. No retries here.
export function awaitAiSignal(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(
      value=>{signal.removeEventListener('abort',abort);resolve(value);},
      error=>{signal.removeEventListener('abort',abort);reject(error);},
    );
  });
}

export function buildAiChatRequest(connection,messages,kind,capabilities=resolveAiCapabilities(connection)) {
  const policy=aiRequestPolicy(capabilities,kind);
  return {
    url:connection.baseUrl.replace(/\/+$/,'').replace(/\/chat\/completions$/,'')+'/chat/completions',
    body:{model:connection.model,...capabilities.options,stream:capabilities.stream,
      [capabilities.outputField]:policy.tokens,messages},
    policy,
  };
}

function finalText(content,capabilities) {
  if(content==null)return '';
  if(typeof content==='string')return content;
  if(!Array.isArray(content))throw new Error('Invalid completion content');
  return content.map(part=>{
    if(part?.type==='text'&&typeof part.text==='string')return part.text;
    if(capabilities.contentBlocks&&['thinking','redacted_thinking'].includes(part?.type))return '';
    throw new Error('Unsupported completion content block');
  }).join('');
}
function stripDocumentedThinkingPrefix(content,capabilities) {
  // Only MiniMax's documented leading wrapper, never tags inside the JSON response.
  if(!capabilities.thinkingPrefix||!/^\s*<think>/.test(content))return content;
  const end=content.indexOf('</think>');
  if(end<0)throw new Error('Incomplete thinking prefix');
  return content.slice(end+'</think>'.length).trimStart();
}
function unwrapJsonCodeBlock(content) {
  // Accept one complete outer JSON (or unlabeled) fence, never extract JSON from
  // prose or repair its contents. The existing JSON and semantic checks still run.
  const match=/^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/i.exec(content);
  return match ? match[1] : content;
}
function normalizeChoice(choice,usage,capabilities) {
  const message=choice?.message;
  let finishReason=choice?.finish_reason;
  if(message?.refusal)finishReason='refusal';
  if(message?.tool_calls?.length||message?.function_call)finishReason='tool_calls';
  // Do not try to parse an incomplete JSON/text block before reporting explicit truncation.
  let content=finishReason==='stop'?finalText(message?.content,capabilities):
    typeof message?.content==='string'?message.content:'';
  if(finishReason==='stop')content=unwrapJsonCodeBlock(stripDocumentedThinkingPrefix(content,capabilities));
  return {content,finishReason,usage};
}
function parseSse(text,capabilities) {
  let content='',finishReason,usage,refusal=false,toolCalls=false,done=false,sawChoice=false;
  // Bytes are decoded only after bounded collection, so split UTF-8 sequences are intact.
  for(const event of text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n\n')) {
    const lines=event.split('\n').filter(line=>line.startsWith('data:'));
    if(!lines.length)continue; // comments/heartbeats do not extend the request deadline
    const data=lines.map(line=>line.slice(5).replace(/^ /,'')).join('\n').trim();
    if(!data)continue;
    if(done)throw new Error('Data after stream terminator');
    if(data==='[DONE]'){done=true;continue;}
    const payload=JSON.parse(data);
    if(payload.error)throw new Error('Provider stream error');
    if(payload.usage)usage=payload.usage;
    if(!Array.isArray(payload.choices))throw new Error('Invalid stream choices');
    for(const choice of payload.choices) {
      if(choice.index!==0)throw new Error('Unexpected stream choice');
      sawChoice=true;
      const delta=choice.delta??{};
      if(finishReason!=null&&(delta.content||delta.tool_calls?.length||delta.refusal||choice.finish_reason!=null))throw new Error('Data after completion');
      content+=finalText(delta.content,capabilities);
      refusal ||= Boolean(delta.refusal);
      toolCalls ||= Boolean(delta.tool_calls?.length||delta.function_call);
      if(choice.finish_reason!=null)finishReason=choice.finish_reason;
    }
  }
  // [DONE] alone or EOF alone is not evidence of a complete answer or token truncation.
  if(!sawChoice)throw new Error('Missing stream choice');
  return normalizeChoice({finish_reason:finishReason,message:{content,refusal,tool_calls:toolCalls?[{}]:undefined}},usage,capabilities);
}

export async function requestAiChat({connection,messages,kind,signal,fetchImpl=fetch,capabilities=resolveAiCapabilities(connection)}) {
  const request=buildAiChatRequest(connection,messages,kind,capabilities);
  const response=await awaitAiSignal(fetchImpl(request.url,{
    method:'POST',redirect:'error',signal,
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${connection.apiKey}`},
    body:JSON.stringify(request.body),
  }),signal);
  signal.throwIfAborted();
  if(!response.ok) {
    void response.body?.cancel().catch(()=>{});
    throw new Error(kind==='connection'?`连接测试失败（HTTP ${response.status}），请检查地址、密钥、模型和额度。`:
      `AI 请求失败（HTTP ${response.status}），请检查连接、模型、权限或额度`);
  }
  const limit=kind==='connection'?65536:2000000;
  const tooLarge=()=>new Error(kind==='connection'?'模型测试响应过大':'AI 响应超过上限');
  if(Number(response.headers.get('content-length'))>limit){void response.body?.cancel().catch(()=>{});throw tooLarge();}
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try {
    for(;;){
      const {value,done}=await awaitAiSignal(reader.read(),signal);
      signal.throwIfAborted();
      if(done)break;
      bytes+=value.byteLength;if(bytes>limit)throw tooLarge();
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(()=>{}); }
  signal.throwIfAborted();
  const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  const contentType=(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
  if(contentType==='text/event-stream'||(capabilities.stream&&!contentType))return parseSse(text,capabilities);
  const envelope=JSON.parse(text);
  if(envelope.error)throw new Error('Provider completion error');
  const choices=envelope.choices;
  if(Array.isArray(choices)&&choices.length>1)throw new Error('Unexpected completion choices');
  return normalizeChoice(choices?.[0],envelope.usage,capabilities);
}
