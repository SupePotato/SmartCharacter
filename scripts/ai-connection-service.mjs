import { resolveAiAnalysis } from "../lib/ai-fragment-protocol.ts";
import { failureDiagnostic } from "./ai-failure-diagnostics.mjs";
import { resolveAiCapabilities, aiRequestPolicy } from "./ai-model-options.mjs";
import { requestAiChat } from "./ai-chat-adapter.mjs";
/** Only a user-initiated short sample is sent here; no full-project analysis. */
export function normalizeConnection(input, { allowLoopback = false } = {}) {
  if (!input || typeof input !== "object" || Object.keys(input).some(k => !["baseUrl", "apiKey", "model"].includes(k))) throw new Error("连接字段无效");
  for (const name of ["baseUrl", "apiKey", "model"]) if (typeof input[name] !== "string" || !input[name].trim() || input[name].length > 4096) throw new Error("请填写服务地址、API 密钥和模型名称");
  const url = new URL(input.baseUrl.trim());
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(allowLoopback && local && url.protocol === "http:"))) throw new Error("服务地址须为 HTTPS，且不能包含账号、查询参数或片段");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return { baseUrl: url.href.replace(/\/$/, ""), apiKey: input.apiKey.trim(), model: input.model.trim() };
}
function connectionInfo(value, warning) {
  warning ||= value?.storage === "session" ? "连接仅在本次本地服务运行期间保留；关闭服务后需重新填写。" : undefined;
  return value ? { connected: true, baseUrl: value.baseUrl, model: value.model, storage: value.storage, ...(warning ? { warning } : {}) } : { connected: false };
}
const SAMPLE = "先说清楚问题";
export function validateConnectionSample(value) {
  const result = JSON.parse(value);
  if (!result || !Array.isArray(result.focus) || !result.focus.length || !Array.isArray(result.cards) || result.cards.length) throw new Error("模型未返回兼容的语义建议格式");
  const checked=resolveAiAnalysis(result,[{id:"sample-1",text:SAMPLE,start:0,end:2}]);
  if(checked.review.skippedFocus.length||checked.review.unreviewedCueIds.length||!checked.result.focus.length)throw new Error("模型未返回兼容的语义建议格式");
  return checked.result;
}
export function createAiConnectionService({ store, fetchImpl = fetch, timeoutMs, allowLoopback = false }) {
  let revision = 0, active, diagnostic;
  return {
    async info() { return connectionInfo(await store.get()); },
    diagnostic() { return diagnostic ? structuredClone(diagnostic) : null; },
    close() { revision++; active?.abort(); diagnostic=undefined; },
    async testAndSave(input, signal) {
      const candidate = normalizeConnection(input, { allowLoopback });
      const capabilities = resolveAiCapabilities(candidate);
      const current = ++revision;
      diagnostic=undefined;
      active?.abort(); active = new AbortController();
      const abort = AbortSignal.any([active.signal, signal || new AbortController().signal, AbortSignal.timeout(timeoutMs ?? aiRequestPolicy(capabilities, "connection").timeoutMs)]);
      let context;
      try {
        const envelope = await requestAiChat({ connection: candidate, capabilities, kind: "connection", signal: abort, fetchImpl, messages: [
            { role: "system", content: '只返回 JSON，不改写原文。格式：{"protocolVersion":5,"decisions":[{"cueId":"sample-1","decision":"focus","reason":"观点重点"}],"focus":[{"ranges":[{"cueId":"sample-1","text":"问题","role":"topic","priority":1,"granularity":"word"}],"relations":["emphasis"],"reason":"简短理由"}],"sections":[],"outlines":[],"cards":[]}。重点必须逐字等于原文中的连续片段；重复出现时可增加 occurrence 整数，从1开始指定第几处。不要输出 originalText、start、end 或 indexUnit；位置由本机计算，不添加其他字段。' },
            { role: "user", content: JSON.stringify({ id: "sample-1", text: SAMPLE }) },
          ] });
        const choice = { finish_reason: envelope.finishReason, message: { content: envelope.content } };
        context={kind:"connection",cues:[{id:"sample-1",text:SAMPLE,start:0,end:2}],content:envelope.content,finishReason:envelope.finishReason,usage:envelope.usage};
        if(choice?.finish_reason!=="stop")throw new Error("模型测试响应未完整结束");
        if(typeof choice.message.content==="string"&&choice.message.content.includes(candidate.apiKey))throw new Error("模型测试响应包含敏感连接信息");
        validateConnectionSample(envelope.content);
        abort.throwIfAborted();
        if (current !== revision) throw new Error("连接测试已过期，请重新测试");
        const saved = await store.save(candidate, abort);
        return connectionInfo({ ...candidate, storage: saved.storage }, saved.warning);
      } catch (error) {
        if(current===revision&&!abort.aborted&&context)diagnostic=failureDiagnostic(context,error.message,candidate.apiKey);
        if (abort.aborted) throw new Error(current !== revision ? "连接测试已过期，原连接已保留" : signal?.aborted ? "连接测试已取消，原连接已保留" : "连接测试超时，原连接已保留");
        // Never echo a provider response, URL credentials or the candidate key.
        const safe = ["连接测试失败", "模型测试响应", "模型未返回", "语义建议结构无效", "模型建议范围", "连接测试已过期", "AI 重点", "AI 片段", "AI 范围", "AI 建议", "AI 语义"];
        throw new Error(safe.some(prefix => error.message?.startsWith(prefix)) ? error.message : "连接测试未完成，请检查网络或服务的分析格式；原连接已保留。");
      }
    },
  };
}
