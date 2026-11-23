/**
 * lib/paths.mjs —— 插件自己的目录约定。
 *
 * 只依赖环境变量，不 import 任何 DSH 包：自检脚本可以脱离宿主直接跑。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 家目录：优先 `DSH_HOME`，否则 `~/.dsh`。 */
export function dshHome() {
  const fromEnv = String(process.env.DSH_HOME || '').trim()
  if (fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 本插件的运行数据目录（不写进插件包目录）。 */
export function bridgeHome() {
  return join(dshHome(), 'qq-douyin-bridge')
}

/** 状态文件。 */
export function stateFile() {
  return join(bridgeHome(), 'state.json')
}

/** QQ 桥接（另一套程序）的目录。 */
export function qqBridgeDir() {
  return join(dshHome(), 'qq-bridge')
}

/** 抖音插件（dsh-douyin-scroll）的运行数据目录。 */
export function douyinHome() {
  return join(dshHome(), 'douyin-duty')
}
