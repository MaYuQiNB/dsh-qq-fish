// 千问编程工人：把「敲代码」任务丢给千问AI平台（免费额度），拿回代码。
// 用法：
//   node qwen-coder.mjs "实现一个xxx函数" [--files a.js,b.js] [--model qwen3.7-max] [--out out.txt]
// 说明：--files 会把文件内容一起给千问（总长度有上限）；默认模型 qwen3.7-max（代码能力更好）。
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CFG_FILE = path.join(HERE, '..', 'webcall', 'qwen.json');
const MAX_CONTEXT_CHARS = 60000;

function parseArgs(argv) {
  const args = { files: [], model: '', out: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--files') { args.files = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--model') args.model = String(argv[++i] || '');
    else if (a === '--out') args.out = String(argv[++i] || '');
    else rest.push(a);
  }
  args.prompt = rest.join(' ').trim();
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.prompt) {
  console.error('用法: node qwen-coder.mjs "要实现的东西" [--files a,b] [--model qwen3.7-max] [--out file]');
  process.exit(2);
}

let cfg;
try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (e) {
  console.error('读取 qwen.json 失败: ' + e.message);
  process.exit(1);
}

let context = '';
for (const f of args.files) {
  try {
    const abs = path.resolve(f);
    const text = fs.readFileSync(abs, 'utf8');
    context += `\n--- 文件: ${abs} ---\n${text}\n`;
    if (context.length > MAX_CONTEXT_CHARS) { console.error('上下文超过上限，截断'); context = context.slice(0, MAX_CONTEXT_CHARS); break; }
  } catch (e) { console.error('读文件失败 ' + f + ': ' + e.message); }
}

const SYSTEM = [
  '你是一名资深软件工程师，负责替主工程师写代码。',
  '要求：',
  '1) 直接给可运行的代码；多个文件用「### 文件: 相对路径」分段。',
  '2) 代码要完整（不要省略号，不要 TODO），包含必要注释；需要测试时给出测试文件。',
  '3) 默认用项目现有语言/风格；没有上下文时优先 Python 或 Node.js。',
  '4) 不要长篇解释；可在末尾用不超过 5 行说明关键决策。',
  '5) 不要编造不存在的 API；不确定时给出稳妥实现。'
].join('\n');

const models = args.model ? [args.model] : ['qwen3.7-max', ...(Array.isArray(cfg.models) ? cfg.models : [])];
let lastErr = null;
for (const model of models) {
  try {
    const userMsg = context ? `${args.prompt}\n\n【参考代码/上下文】${context}` : args.prompt;
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }],
        temperature: 0.3
      }),
      signal: AbortSignal.timeout(240000)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { lastErr = new Error((json.error && json.error.message) || ('HTTP ' + res.status)); continue; }
    const text = String(json?.choices?.[0]?.message?.content || '').trim();
    if (!text) { lastErr = new Error('返回为空'); continue; }
    if (args.out) fs.writeFileSync(path.resolve(args.out), text, 'utf8');
    console.log(text);
    console.error(`[qwen-coder] model=${model} chars=${text.length} usage=${JSON.stringify(json.usage || {})}`);
    process.exit(0);
  } catch (e) { lastErr = e; }
}
console.error('千问调用失败：' + (lastErr?.message ?? lastErr));
process.exit(1);
