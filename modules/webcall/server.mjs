// Web 视频通话服务：把「浏览器摄像头 + AI 场景画面 + 语音对话」拼成一个网页通话渠道。
// 端口 3300。依赖本地已有服务：
//   3211 call-chat-server（AI 文本对话，复用 DSH）
//   3210 音色编辑器（Breeze TTS，/api/preview）
//   faster-whisper（qqtools/asr_one.py 做语音转写）
//   场景页面 + dsh-pet 鲸鱼动画（直接读现有文件，不复制）
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 3300;
const HTTPS_PORT = 3443;
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SCENE_DIR = 'C:/Users/<YOU>/WorkBuddy/2026-11-10-call-scene';
const WALL_DIR = 'C:/Users/<YOU>/WorkBuddy/2026-11-08-13-22-59/fish-bedroom-wallpaper';
const PET_WEBM = 'C:/Users/<YOU>/.dsh/profiles/desktop/node_modules/dsh-pet/assets/webm/待机呼吸休闲.webm';
const NODE = 'C:/Users/<YOU>/.dsh/qq-bridge/node.exe';
const PY = 'C:/Users/<YOU>/.dsh/QQ/voice-clone/venv/Scripts/python.exe';
const ASR_ONE = 'C:/Users/<YOU>/Documents/deepseek-harness/default-workspace/.runtime/qqtools/asr_one.py';
const ASR_TMP = path.join(HERE, 'tmp');
const FFMPEG = 'C:/Users/<YOU>/.dsh/QQ/voice-editor/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe';
fs.mkdirSync(ASR_TMP, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.webm': 'video/webm', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.json': 'application/json; charset=utf-8' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function serveFile(res, file, mime) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not file');
    res.writeHead(200, { 'content-type': mime || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch {
    send(res, 404, { ok: false, error: 'not found: ' + path.basename(file) });
  }
}
function jsonPost(url, obj, timeoutMs = 60000) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
    signal: AbortSignal.timeout(timeoutMs)
  });
}
// 千问（DashScope 兼容接口，免费额度）
const QWEN_FILE = path.join(HERE, 'qwen.json');
const QWEN_SYSTEM = '你是 DeepSeek 的小鲸鱼形象，语气傲娇、嘴硬心软、简洁口语化（每句尽量短）。被叫大肥鱼会嘴硬否认。回答要准确、别长篇大论，数学题要给步骤。';
async function qwenChat(text, system = QWEN_SYSTEM) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(QWEN_FILE, 'utf8')); } catch { throw new Error('qwen.json 不存在或无效'); }
  const models = Array.isArray(cfg.models) && cfg.models.length ? cfg.models : ['qwen-flash'];
  let lastErr = null;
  for (const model of models) {
    try {
      const r = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: text }],
          temperature: 0.7
        }),
        signal: AbortSignal.timeout(60000)
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        lastErr = new Error((j.error && j.error.message) || ('HTTP ' + r.status));
        continue;
      }
      const reply = String(j?.choices?.[0]?.message?.content || '').trim();
      if (reply) return { reply, model };
      lastErr = new Error('千问返回为空');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('千问调用失败');
}

function run(cmd, args, timeoutMs = 120000) {  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('timeout: ' + path.basename(cmd))); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error((err || out || 'exit ' + code).slice(0, 500))); });
  });
}

const ASR_SERVER_PY = path.join(HERE, 'asr-server.py');
let asrProc = null;
let asrReady = null;
let asrSeq = 0;
const asrWaiters = new Map();

function ensureAsrWorker() {
  if (asrReady) return asrReady;
  asrReady = new Promise((resolve) => {
    try {
      asrProc = spawn(PY, [ASR_SERVER_PY], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = '';
      asrProc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.ready !== undefined) resolve(Boolean(msg.ready));
          if (msg.id != null && asrWaiters.has(msg.id)) {
            const w = asrWaiters.get(msg.id);
            asrWaiters.delete(msg.id);
            msg.ok ? w.resolve(msg.text) : w.reject(new Error(msg.error || 'asr failed'));
          }
        }
      });
      asrProc.stderr.on('data', (d) => console.log('[asr]', String(d).slice(0, 200)));
      asrProc.on('exit', (code) => { console.log('[asr] worker exited', code); asrProc = null; asrReady = null; });
      setTimeout(() => resolve(false), 120000);
    } catch (e) {
      console.log('[asr] spawn failed', e.message);
      resolve(false);
    }
  });
  return asrReady;
}

function asrWorker(wavPath, timeoutMs = 120000) {
  return ensureAsrWorker().then((ok) => {
    if (!ok || !asrProc) throw new Error('ASR worker 未就绪');
    const id = ++asrSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { asrWaiters.delete(id); reject(new Error('ASR 超时')); }, timeoutMs);
      asrWaiters.set(id, { resolve: (t) => { clearTimeout(timer); resolve(t); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      asrProc.stdin.write(JSON.stringify({ id, wav: wavPath }) + '\n');
    });
  });
}

async function transcribe(webmBuf) {
  const stamp = Date.now();
  const webm = path.join(ASR_TMP, `in-${stamp}.webm`);
  const wav = path.join(ASR_TMP, `in-${stamp}.wav`);
  const outJson = path.join(ASR_TMP, `in-${stamp}.json`);
  fs.writeFileSync(webm, webmBuf);
  try {
    await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', webm, '-vn', '-ac', '1', '-ar', '16000', wav]);
    try {
      return String(await asrWorker(wav)).trim();
    } catch (e) {
      console.log('[asr] worker 失败，回退冷启动：', e?.message);
      await run(PY, [ASR_ONE, wav, outJson]);
      const data = JSON.parse(fs.readFileSync(outJson, 'utf8'));
      return String(data.text || '').trim();
    }
  } finally {
    for (const f of [webm, wav, outJson]) { try { fs.unlinkSync(f); } catch {} }
  }
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(HERE, 'index.html'));
    if (req.method === 'GET' && p === '/api/status') {
      const services = {};
      for (const [name, u] of Object.entries({ chat: 'http://127.0.0.1:3211/status', tts: 'http://127.0.0.1:3210/api/meta' })) {
        try { const r = await fetch(u, { signal: AbortSignal.timeout(2000) }); services[name] = r.ok; } catch { services[name] = false; }
      }
      return send(res, 200, { ok: true, services });
    }
    if (req.method === 'GET' && p === '/ca.crt') {
      return serveFile(res, path.join(HERE, 'tls', 'ca.crt'), 'application/x-x509-ca-cert');
    }
    if (req.method === 'GET' && p === '/scene') return serveFile(res, path.join(SCENE_DIR, 'scene.html'));
    if (req.method === 'GET' && p.startsWith('/wall/')) {
      return serveFile(res, path.join(WALL_DIR, decodeURIComponent(p.slice('/wall/'.length))));
    }
    if (req.method === 'GET' && p === '/pet.webm') return serveFile(res, PET_WEBM, 'video/webm');
    if (req.method === 'GET' && p === '/scene-bg') {
      // 给网页用：返回一张场景静态图（兜底封面）
      return serveFile(res, path.join(SCENE_DIR, 'preview.png'), 'image/png');
    }
    if (req.method === 'POST' && p === '/api/asr') {
      const buf = await readBody(req);
      if (!buf.length) return send(res, 400, { ok: false, error: '空音频' });
      const text = await transcribe(buf);
      return send(res, 200, { ok: true, text });
    }
    if (req.method === 'POST' && p === '/api/chat') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { ok: false, error: 'text 不能为空' });
      if (body.engine === 'qwen') {
        try {
          const q = await qwenChat(text);
          return send(res, 200, { ok: true, reply: q.reply, engine: 'qwen', model: q.model });
        } catch (e) {
          return send(res, 502, { ok: false, error: '千问调用失败：' + (e?.message ?? e) });
        }
      }
      const r = await jsonPost('http://127.0.0.1:3211/chat', { text }, 120000);
      const j = await r.json().catch(() => ({}));
      return send(res, r.ok ? 200 : 502, { ok: r.ok && j.ok !== false, reply: j.reply || '', error: j.error || null, engine: 'deepseek' });
    }
    if (req.method === 'POST' && p === '/api/qwen/chat') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { ok: false, error: 'text 不能为空' });
      try {
        const q = await qwenChat(text, body.system ? String(body.system) : undefined);
        return send(res, 200, { ok: true, reply: q.reply, model: q.model });
      } catch (e) {
        return send(res, 502, { ok: false, error: String(e?.message ?? e) });
      }
    }
    if (req.method === 'POST' && p === '/api/tts') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { ok: false, error: 'text 不能为空' });
      const r = await jsonPost('http://127.0.0.1:3210/api/preview', { text, voice: body.voice || 'breeze' }, 120000);
      if (!r.ok) return send(res, 502, { ok: false, error: 'TTS 失败：' + r.status });
      const buf = Buffer.from(await r.arrayBuffer());
      return send(res, 200, buf, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
    }
    if (req.method === 'POST' && p === '/api/call/start') {
      try { await jsonPost('http://127.0.0.1:3211/start', {}, 30000); } catch {}
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/call/end') {
      try { await jsonPost('http://127.0.0.1:3211/end', {}, 30000); } catch {}
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    return send(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
};

const server = http.createServer(handler);

// 局域网 HTTPS（自签本地 CA，SAN 里带 LAN IP）：
// 手机/其他电脑装一次 ca.crt 后，https://172.19.214.246:3443 就能拿到摄像头/麦克风权限。
const tlsDir = path.join(HERE, 'tls');
const tlsKey = path.join(tlsDir, 'server.key');
const tlsCert = path.join(tlsDir, 'server.crt');
if (fs.existsSync(tlsKey) && fs.existsSync(tlsCert)) {
  const tlsServer = https.createServer({ key: fs.readFileSync(tlsKey), cert: fs.readFileSync(tlsCert) }, handler);
  tlsServer.listen(HTTPS_PORT, '0.0.0.0', () => console.log(`HTTPS: https://172.19.214.246:${HTTPS_PORT}`));
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web 视频通话：http://127.0.0.1:${PORT}（局域网/隧道可访问）`);
  ensureAsrWorker().then((ok) => console.log('[asr] worker ready:', ok)).catch(() => {});
});
