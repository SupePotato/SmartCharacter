// Serving API capabilities, checked 2026-10-25. No paid probes or runtime discovery.
// Exact exceptions precede documented families; unlisted versions stay unknown.
export const AI_ADAPTER_VERSION = '2026-10-25.1';
const disabled = {thinking:{type:'disabled'}};
const enableThinkingOff = {enable_thinking:false};
const effortNone = {reasoning_effort:'none'};
const effortLow = {reasoning_effort:'low'};
const rule = (models,thinking,options={},extra={}) => ({models,thinking,options,...extra});
const providers = [
  {
    id:'deepseek',hosts:['api.deepseek.com'],paths:['','/v1'],
    source:'https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/',
    rules:[rule(['deepseek-flash','deepseek-v4-pro'],'switchable',disabled)],
  },
  {
    id:'ark',hostPattern:/^ark\.[a-z0-9-]+\.volces\.com$/,paths:['/api/v3'],
    source:'https://console.volcengine.com/ark/region:cn-beijing/docs/deep-thinking',
    rules:[
      rule(['glm-5-3-flash-260828'],'required'),
      rule([
        'deepseek-v4-1-flash-261017','deepseek-v4-1-flash-260910','deepseek-v4-1-flash-economy-261017',
        'deepseek-v4-flash-ga-260731','deepseek-v4-pro-ga-260813','deepseek-v4-pro-260425',
        'doubao-seed-evolving','doubao-seed-2-1-pro-260915','doubao-seed-2-1-lite-260915',
        'doubao-seed-2-1-pro-260628','doubao-seed-2-1-turbo-260628','doubao-seed-2-0-lite-260428',
        'doubao-seed-2-0-mini-260428','doubao-seed-2-0-pro-260215','doubao-seed-2-0-lite-260215',
        'doubao-seed-2-0-mini-260215','doubao-seed-2-0-code-preview-260215','doubao-seed-character-260628','glm-5-2-260617',
      ],'switchable',disabled),
    ],
  },
  {
    id:'moonshot',hosts:['api.moonshot.cn','api.moonshot.ai'],paths:['/v1'],
    source:'https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart',
    rules:[rule(['kimi-k2.6'],'switchable',disabled)],
  },
  {
    id:'bailian',hosts:['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','dashscope-us.aliyuncs.com','cn-beijing.maas.aliyuncs.com'],paths:['/compatible-mode/v1'],
    source:'https://help.aliyun.com/zh/model-studio/deep-thinking',
    rules:[
      rule(['qwen3.7-max-preview','qwen3.7-max-2026-05-17','qwen3.8-2.4t-a95b','glm-5.3',
        'kimi-k3','kimi-k2.7-code','kimi/kimi-k3','kimi/kimi-k2.7-code','kimi/kimi-k2.7-code-highspeed'],'required'),
      rule(['qwen3.5-122b-a10b','qwen3.5-27b'],'switchable',enableThinkingOff,{stream:true}),
      rule([
        'qwen3.8-max','qwen3.8-max-0902','qwen3.8-flash','qwen3.8-27b',
        'qwen3.7-max','qwen3.7-max-2026-05-20','qwen3.7-max-2026-06-08',
        'qwen3.7-plus','qwen3.7-plus-2026-05-26','qwen3.7-flash','qwen3.7-flash-2026-07-15',
        'qwen3.6-plus','qwen3.6-plus-2026-04-02','qwen3.6-flash','qwen3.6-flash-2026-04-16','qwen3.6-35b-a3b',
        'qwen3.5-plus','qwen3.5-plus-2026-02-15','qwen3.5-flash','qwen3.5-flash-2026-02-23',
        'qwen3.5-397b-a17b','qwen3.5-35b-a3b','qwen-plus','qwen-plus-latest','qwen-flash',
      ],'switchable',enableThinkingOff),
    ],
  },
  {
    id:'bigmodel',hosts:['open.bigmodel.cn'],paths:['/api/paas/v4'],
    source:'https://docs.bigmodel.cn/cn/guide/capabilities/thinking',
    rules:[
      rule(['glm-5.3','glm-5.3-flash','glm-5.3-flashx'],'required',effortLow),
      rule(['glm-5.2','glm-5.1','glm-5','glm-5-turbo','glm-5v-turbo','glm-4.7','glm-4.6','glm-4.6v','glm-4.5','glm-4.5v'],'switchable',disabled),
    ],
  },
  {
    id:'minimax',hosts:['api.minimax.cn','api.minimax.io','api.minimaxi.com'],paths:['/v1'],
    source:'https://platform.minimax.io/docs/api-reference/text-openai-api',
    outputField:'max_completion_tokens',thinkingPrefix:true,
    rules:[
      rule(['MiniMax-M3'],'switchable',{...disabled,reasoning_split:true}),
      rule(['MiniMax-M3.1-Flash'],'required',{...effortLow,reasoning_split:true}),
      rule(['MiniMax-M2.7','MiniMax-M2.7-highspeed','MiniMax-M2.5','MiniMax-M2.5-highspeed','MiniMax-M2.1','MiniMax-M2.1-highspeed','MiniMax-M2'],'required',{reasoning_split:true}),
    ],
  },
  {
    id:'siliconflow',hosts:['api.siliconflow.cn','api.siliconflow.com'],paths:['/v1'],
    source:'https://docs.siliconflow.cn/docs/api/chat-completions-post',
    budgetMeaning:'visible-output; thinking may have a separate provider budget',
    rules:[
      // Only the documented original hybrid Qwen3 sizes, not future or Thinking variants.
      {pattern:/^(?:Pro\/)?Qwen\/Qwen3-(?:0\.6B|1\.7B|4B|8B|14B|32B|30B-A3B|235B-A22B)$/,thinking:'switchable',options:enableThinkingOff},
    ],
  },
  {
    id:'tokenhub',hosts:['tokenhub.tencentmaas.com'],paths:['/v1'],
    source:'https://cloud.tencent.com/document/product/1823/131208',
    rules:[
      rule(['glm-5.3','glm-5.3-flash','glm-5.3-flashx','kimi-k3'],'required',effortLow),
      rule(['kimi-k2.7-code','kimi-k2.7-code-highspeed','minimax-m2.7','minimax-m2.5'],'required'),
      rule(['hy4-preview','hy3','deepseek-v4-flash','deepseek-v4-flash-202605','deepseek-v4-pro','deepseek-v4-pro-202606',
        'glm-5.2','glm-5v-turbo','kimi-k2.6','kimi-k2.5','minimax-m3','qwen3.5-plus','qwen3.5-flash'],'switchable',disabled),
    ],
  },
  {
    id:'hunyuan',hosts:['api.hunyuan.cloud.tencent.com'],paths:['/v1'],
    source:'https://cloud.tencent.com/document/product/1729/111007',rules:[],
  },
  {
    id:'qianfan',hosts:['qianfan.baidubce.com'],paths:['/v2'],
    source:'https://cloud.baidu.com/doc/RTC/s/0m9qgqj7h',rules:[],
  },
  {
    id:'openai',hosts:['api.openai.com'],paths:['/v1'],outputField:'max_completion_tokens',
    source:'https://developers.openai.com/api/docs/guides/reasoning?api-mode=chat',
    rules:[
      rule(['gpt-6-astra','gpt-6.1-sol'],'required',effortLow),
      rule(['gpt-6-sol','gpt-6-luna','gpt-5.6','gpt-5.5','gpt-5.4','gpt-5.2','gpt-5.1'],'switchable',effortNone),
      rule(['gpt-5','gpt-5-mini','gpt-5-nano','o3','o3-mini','o4-mini','o1'],'required',effortLow),
      rule(['gpt-4.1','gpt-4.1-mini','gpt-4.1-nano','gpt-4o','gpt-4o-mini'],'absent'),
    ],
  },
  {
    id:'gemini',hosts:['generativelanguage.googleapis.com'],paths:['/v1beta/openai'],
    source:'https://ai.google.dev/gemini-api/docs/openai',
    rules:[
      rule(['gemini-2.5-flash','gemini-2.5-flash-lite'],'switchable',effortNone),
      rule(['gemini-2.5-pro','gemini-3-pro-preview','gemini-3-flash-preview','gemini-3.1-pro-preview','gemini-3.1-flash-lite-preview'],'required',effortLow),
    ],
  },
  {
    id:'anthropic',hosts:['api.anthropic.com'],paths:['/v1'],
    source:'https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting',
    rules:[
      rule(['claude-opus-5-5','claude-mythos-5','claude-mythos-5-1','claude-fable-5','claude-fable-5-1','claude-mythos-preview'],'required'),
      rule(['claude-sonnet-4-6','claude-opus-4-6','claude-opus-4-7','claude-opus-4-8','claude-sonnet-5'],'switchable',disabled),
    ],
  },
  {
    id:'openrouter',hosts:['openrouter.ai'],paths:['/api/v1'],
    source:'https://openrouter.ai/api/v1/models',
    // Public metadata checked 2026-10-25: reasoning supported, mandatory=false.
    // Local snapshot only; application runtime never fetches this catalogue.
    rules:[rule(['moonshotai/kimi-k2.6','moonshotai/kimi-k2.5','openai/gpt-5.5','google/gemini-2.5-flash',
      'deepseek/deepseek-v3.2','anthropic/claude-sonnet-4.6'],'switchable',{reasoning:{enabled:false}})],
  },
  {
    id:'groq',hosts:['api.groq.com'],paths:['/openai/v1'],outputField:'max_completion_tokens',
    source:'https://console.groq.com/docs/reasoning',
    rules:[
      rule(['qwen/qwen3.8-27b'],'switchable',effortNone),
      rule(['openai/gpt-oss-20b','openai/gpt-oss-120b','meta-models/muse-spark-open'],'required',{...effortLow,include_reasoning:false}),
    ],
  },
  {
    id:'mistral',hosts:['api.mistral.ai'],paths:['/v1'],contentBlocks:true,
    source:'https://docs.mistral.ai/studio/conversations/reasoning',
    rules:[
      // Here none means minimal thinking, not a guaranteed off switch.
      rule(['mistral-small-latest','mistral-medium-3-5','mistral-large-4-0'],'required',effortNone),
      rule(['zai-glm-5-3'],'required',effortLow),
    ],
  },
];

export function resolveAiCapabilities({baseUrl,model}) {
  const url=new URL(baseUrl);
  const path=url.pathname.replace(/\/+$/,'').replace(/\/chat\/completions$/,'');
  const provider=(!url.port && url.protocol==='https:') ? providers.find(p=>
    (p.hosts?.includes(url.hostname)||p.hostPattern?.test(url.hostname))&&p.paths.includes(path)) : undefined;
  const matched=provider?.rules.find(r=>r.models?.includes(model)||r.pattern?.test(model));
  return {
    version:AI_ADAPTER_VERSION,provider:provider?.id??'compatible',verifiedAt:provider?'2026-10-25':undefined,
    source:provider?.source,thinking:matched?.thinking??'unknown',options:structuredClone(matched?.options??{}),
    outputField:matched?.outputField??provider?.outputField??'max_tokens',
    budgetMeaning:provider?.budgetMeaning??'provider-defined completion budget',
    maxOutputTokens:matched?.maxOutputTokens??8000,stream:matched?.stream??false,
    contentBlocks:provider?.contentBlocks??false,thinkingPrefix:Boolean(provider?.thinkingPrefix&&matched),
  };
}
export function aiModelOptions(connection) { return resolveAiCapabilities(connection).options; }
export function aiRequestPolicy(capabilities,kind) {
  const fast=['absent','switchable'].includes(capabilities.thinking);
  return {
    tokens:Math.min(capabilities.maxOutputTokens,kind==='connection'?(fast?512:2048):8000),
    timeoutMs:kind==='connection'?(fast?15000:30000):90000,
  };
}
