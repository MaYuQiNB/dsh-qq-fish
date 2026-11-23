// Discover the current DeepSeek Harness web URL (its port changes on every DSH start)
// and write it into qq-bridge's config.json. Prints one JSON line for the PS1 launcher.
//
// 改进（2026-11-22）：优先“跟着 DSH 进程走”——从正在运行的 DSH 进程的监听端口里找 401 探活，
// 避免旧 DSH 进程还没退出时误选过期端口，导致桥接一直重连 0 帧。
const fs = require('fs');
const { execSync } = require('child_process');

const CONFIG = 'C:/Users/<YOU>/.dsh/qq-bridge/config.json';

async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(800),
      redirect: 'manual',
    });
    const text = await res.text();
    return res.status === 401 && text.includes('dsh web authentication required');
  } catch {
    return false;
  }
}

function listeningLoopbackPorts() {
  const ports = new Set();
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m) ports.add(Number(m[1]));
    }
  } catch {}
  return [...ports];
}

function dshProcessPorts() {
  const ports = new Set();
  try {
    const ps = [
      "Get-CimInstance Win32_Process |",
      "Where-Object { $_.Name -match 'DeepSeek|dsh' -or ($_.CommandLine -and $_.CommandLine -match 'app\\.asar|dsh web|DeepSeek Harness') } |",
      "ForEach-Object { $_.ProcessId }"
    ].join(' ');
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const pids = new Set(out.split(/\s+/).filter((s) => /^\d+$/.test(s)));
    if (pids.size === 0) return [];
    const net = execSync('netstat -ano -p TCP', { encoding: 'utf8', windowsHide: true });
    for (const line of net.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && pids.has(m[2])) ports.add(Number(m[1]));
    }
  } catch {}
  return [...ports];
}

async function findDshUrl() {
  const env = process.env.DSH_WEB_URL;
  if (env) {
    try {
      const u = new URL(env);
      if (await probe(Number(u.port))) return `http://127.0.0.1:${u.port}`;
    } catch {}
  }
  // 1) 优先 DSH 进程自己监听的端口
  const ownPorts = dshProcessPorts();
  for (const port of ownPorts) {
    if (await probe(port)) return `http://127.0.0.1:${port}`;
  }
  // 2) 兜底：扫所有 loopback 监听端口
  const ports = listeningLoopbackPorts();
  for (let i = 0; i < ports.length; i += 12) {
    const chunk = ports.slice(i, i + 12);
    const hits = (await Promise.all(chunk.map(async (port) => ((await probe(port)) ? port : 0)))).filter(Boolean);
    if (hits.length) return `http://127.0.0.1:${hits[0]}`;
  }
  return null;
}

(async () => {
  const url = await findDshUrl();
  if (!url) {
    console.log(JSON.stringify({ ok: false, url: null }));
    return;
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, url, error: 'config read failed: ' + e.message }));
    return;
  }
  const previous = cfg.dsh && cfg.dsh.baseUrl;
  const changed = previous !== url;
  if (changed) {
    cfg.dsh = cfg.dsh || {};
    cfg.dsh.baseUrl = url;
    fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify({ ok: true, url, previous, changed }));
})();