/**
 * lib/share.mjs —— v0.3「数据互通」：把两边已有的记忆读成一小段共享上下文。
 *
 * 只读、容错、绝不抛：
 *   · QQ 侧：`$DSH_HOME/memory-brain.json` 里带 QQ 标签/来源的最新几条情节记忆摘要
 *     （memory-brain 插件自动捕获的 QQ 桥接会话记忆）。
 *   · 抖音侧：`$DSH_HOME/douyin-duty/memory/dm-<sec_uid>.json` 里关于这位好友的 `facts`
 *     （「刷抖音」插件记下的长期事实，例如对方在哪、养什么）。
 *
 * 目的：让「QQ 的鱼」和「抖音的鱼」都能在系统提示里看到同一份摘要，而不是互相当陌生人。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './paths.mjs'

/** 读 JSON（失败 null）。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** 抖音记忆文件名里的 sec_uid 安全化（与 lib/memory.mjs 的 safeKey 一致）。 */
function safeKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown'
}

/**
 * 从 memory-brain 的 state 里挑「QQ 桥接会话」的记忆摘要。
 * 判据：source 是 qq / tags 含 QQ / sessionTitle 含 QQ；跳过已遗忘的；按时间取最新。
 *
 * ⚠️ QQ 会话的 `userText` / `excerpt` 里往往是一大段注入的「【当前时间】【当前角色】…」系统提示，
 * 拿它当摘要毫无信息量。优先用 `assistantText`（模型对那一轮发生什么事的自然语言总结），
 * 实在没有再用 excerpt/text，并过滤掉明显的系统提示开头。
 * @param {any} json memory-brain.json 内容
 * @param {{ limit?: number }} [options]
 * @returns {Array<{ at: string, text: string }>}
 */
export function pickQqMemories(json, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 3, 6))
  const memories = json !== null && typeof json === 'object' && Array.isArray(json.memories) ? json.memories : []
  const looksLikePrompt = (value) => /^【当前时间】/.test(value) || /^【当前角色】/.test(value) || /【你的身份】/.test(value)
  const out = []
  for (const memory of memories) {
    if (memory === null || typeof memory !== 'object') continue
    if (memory.forgottenAt) continue
    const source = String(memory.source || '').toLowerCase()
    const tags = Array.isArray(memory.tags) ? memory.tags.map((tag) => String(tag)) : []
    const title = String(memory.sessionTitle || '')
    const isQq = source === 'qq' || tags.some((tag) => tag.toUpperCase() === 'QQ') || /QQ/i.test(title)
    if (!isQq) continue
    const assistant = String(memory.assistantText || '').replace(/\s+/g, ' ').trim()
    const excerpt = String(memory.excerpt || '').replace(/\s+/g, ' ').trim()
    const fullText = String(memory.text || '').replace(/\s+/g, ' ').trim()
    let text = ''
    if (assistant !== '' && !looksLikePrompt(assistant)) text = assistant
    if (text === '' && excerpt !== '' && !looksLikePrompt(excerpt)) text = excerpt
    if (text === '' && fullText !== '' && !looksLikePrompt(fullText)) text = fullText
    if (text === '') continue
    const at = memory.createdAt !== undefined && memory.createdAt !== null
      ? String(memory.createdAt)
      : ''
    out.push({ at, text: text.slice(0, 160), createdAt: Number(memory.createdAt) || 0 })
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out.slice(0, limit).map(({ at, text }) => ({ at, text }))
}

/**
 * 从抖音 dm 记忆里挑长期事实。
 * @param {any} json `dm-<sec_uid>.json` 内容
 * @param {{ limit?: number }} [options]
 * @returns {{ nick: string, facts: string[] }}
 */
export function pickDmFacts(json, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 5, 10))
  if (json === null || typeof json !== 'object') return { nick: '', facts: [] }
  const who = json.who !== null && typeof json.who === 'object' ? json.who : {}
  const facts = Array.isArray(json.facts)
    ? json.facts.map((fact) => String(fact).replace(/\s+/g, ' ').trim()).filter((fact) => fact !== '').slice(0, limit)
    : []
  return { nick: String(who.nick || '').trim(), facts }
}

/** 11 位毫秒时间戳 → HH:mm（展示用；不认识就给空）。 */
function clockOf(ms) {
  const num = Number(ms)
  if (!Number.isFinite(num) || num <= 0) return ''
  const date = new Date(num)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 读一份共享上下文（两个文件各最多读一次；调用方负责缓存）。
 * @param {{ home?: string, secUid?: string, limit?: number }} [options]
 * @returns {{ qqMemories: Array<{ at: string, text: string }>, dmNick: string, dmFacts: string[] }}
 */
export function readSharedContext(options = {}) {
  const home = options.home || dshHome()
  const qqMemories = pickQqMemories(readJson(join(home, 'memory-brain.json')), { limit: options.limit })
  const secUid = String(options.secUid || '').trim()
  let dmNick = ''
  let dmFacts = []
  if (secUid !== '') {
    const file = join(home, 'douyin-duty', 'memory', `dm-${safeKey(secUid)}.json`)
    if (existsSync(file)) {
      const picked = pickDmFacts(readJson(file), { limit: 5 })
      dmNick = picked.nick
      dmFacts = picked.facts
    }
  }
  return { qqMemories, dmNick, dmFacts }
}

/**
 * 共享上下文 → 几行紧凑的系统提示文本。
 * @param {{ qqMemories: Array<{ at: string, text: string }>, dmNick: string, dmFacts: string[] }} context
 * @param {{ privateSession?: boolean }} [options] privateSession=false 时跳过 QQ 记忆（避免群聊里泄露私聊内容）
 * @returns {string[]} 文本行（可能为空数组）
 */
export function formatSharedContext(context, options = {}) {
  const ctx = context !== null && typeof context === 'object' ? context : {}
  const lines = []
  const privateSession = options.privateSession !== false
  if (privateSession && Array.isArray(ctx.qqMemories) && ctx.qqMemories.length > 0) {
    lines.push('QQ 这边的鱼最近记得（QQ 桥接会话）：')
    for (const memory of ctx.qqMemories) {
      const clock = clockOf(memory && memory.at)
      const text = String((memory && memory.text) || '').trim()
      if (text === '') continue
      lines.push(`- ${clock ? `[${clock}] ` : ''}${text.slice(0, 120)}`)
    }
  }
  const nick = String(ctx.dmNick || '').trim()
  const facts = Array.isArray(ctx.dmFacts) ? ctx.dmFacts.filter((fact) => typeof fact === 'string' && fact !== '') : []
  if (facts.length > 0) {
    lines.push(`抖音好友「${nick || '对方'}」：${facts.slice(0, 5).map((fact) => fact.slice(0, 60)).join('；')}`)
  }
  return lines
}
