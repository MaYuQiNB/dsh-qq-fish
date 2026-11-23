/**
 * lib/discover.mjs —— 从本机已有程序里「发现」连接参数（只读、容错、绝不抛）。
 *
 * ① QQ 桥接：`$DSH_HOME/qq-bridge/config.json` 的 `snowluma.httpUrl` / `snowluma.accessToken`；
 * ② 抖音插件：数据目录 `$DSH_HOME/douyin-duty/memory/dm-*.json`（聊过的人，含 sec_uid/nick），
 *    用于 `/peers` 在抖音面板的慢接口失败时兜底。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { douyinHome, qqBridgeDir } from './paths.mjs'

/** 读文本（去 BOM，失败返回空串）。 */
function readText(file) {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return ''
  }
}

/** 读 JSON（失败返回 null）。 */
function readJson(file) {
  const text = readText(file)
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 读 QQ 桥接的配置（只读；文件不存在时给安全默认值）。
 * 注意：返回对象里有 accessToken，**调用方不得把它写进日志或状态文件**。
 * @returns {{
 *   exists: boolean, dir: string, httpUrl: string, wsUrl: string, accessToken: string,
 *   consolePort: number, consoleToken: string, allow: { private?: string[], groups?: string[] },
 *   sessions: Record<string, string>,
 * }}
 */
export function readQqBridgeConfig() {
  const dir = qqBridgeDir()
  const cfg = readJson(join(dir, 'config.json')) || {}
  const snow = cfg.snowluma !== null && typeof cfg.snowluma === 'object' ? cfg.snowluma : {}
  const consoleTokenFromFile = readText(join(dir, 'state', 'console-token')).trim()
  const sessionsRaw = readJson(join(dir, 'state', 'sessions.json')) || {}
  const allow = cfg.allow !== null && typeof cfg.allow === 'object' ? cfg.allow : {}
  return {
    exists: Object.keys(cfg).length > 0,
    dir,
    httpUrl: String(snow.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    wsUrl: String(snow.wsUrl || 'ws://127.0.0.1:3001').replace(/\/+$/, ''),
    accessToken: String(snow.accessToken || ''),
    consolePort: Number(cfg.consolePort) || 3100,
    consoleToken: String(cfg.consoleToken || consoleTokenFromFile || '').trim(),
    allow: {
      private: Array.isArray(allow.private) ? allow.private.map(String) : [],
      groups: Array.isArray(allow.groups) ? allow.groups.map(String) : [],
    },
    sessions: sessionsRaw && typeof sessionsRaw.sessions === 'object' && sessionsRaw.sessions !== null
      ? sessionsRaw.sessions
      : {},
  }
}

/**
 * 绑定的 QQ 会话是否同时被 QQ 桥接接给了 AI（私聊/群在白名单里，或已有 DSH 会话）。
 * 这不是错误，只是给用户的提醒：AI 也会看到这些消息，建议用「只转引用回复」模式。
 * @param {'private'|'group'} kind
 * @param {string} id
 * @returns {boolean}
 */
export function aiOverlapOf(kind, id) {
  const cfg = readQqBridgeConfig()
  const key = `${kind === 'group' ? 'group' : 'private'}:${String(id)}`
  if (Object.prototype.hasOwnProperty.call(cfg.sessions, key)) return true
  const list = kind === 'group' ? cfg.allow.groups : cfg.allow.private
  return list.includes(String(id))
}

/**
 * 抖音插件记忆目录里「聊过的人」：`memory/dm-<sec_uid>.json` 的 `who`。
 * 只读、快速（不启浏览器），用于 `/peers` 兜底。
 * @returns {Array<{ nick: string, sec_uid: string, has_id: boolean, is_group: boolean, duplicate: boolean }>}
 */
export function listDouyinMemoryPeers() {
  const dir = join(douyinHome(), 'memory')
  if (!existsSync(dir)) return []
  const out = []
  let files = []
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  for (const file of files) {
    if (!/^dm-.*\.json$/.test(file)) continue
    const memory = readJson(join(dir, file))
    if (memory === null || typeof memory !== 'object') continue
    const who = memory.who && typeof memory.who === 'object' ? memory.who : {}
    const secUid = String(who.sec_uid || '').trim()
    const nick = String(who.nick || '').trim()
    if (secUid === '') continue
    out.push({
      nick: nick || secUid.slice(0, 10),
      sec_uid: secUid,
      has_id: true,
      is_group: false,
      duplicate: false,
    })
  }
  return out.slice(0, 50)
}
