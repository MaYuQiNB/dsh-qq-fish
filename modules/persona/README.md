# persona · DSH agent 预设与角色

| 文件 | 作用 |
| --- | --- |
| `qq-chat-v2/agent.cordis.yml` | 二代仿真预设：人格、工具协议、等待/潜水规则（工具面） |
| `qq-chat-v2/preset.yml` | 预设元信息 |
| `qq-chat-v2/qq-tool-restrict.mjs` | 工具白名单守卫（注册期隐藏 + 执行期兜底） |
| `roles/傲娇助手.md` | 角色卡示例（可换自己的） |

## 使用

把 `qq-chat-v2/` 放到 `qq-bridge/dsh/agent-presets/`，并在 `config.json` 里设：

```json
{ "agentPreset": "qq-chat-v2" }
```

然后运行 `node scripts/build-agent-preset-patches.mjs` 生成 DSH 预设补丁，重启 DSH 生效。

## 自定义

- 角色：改 `roles/*.md`（每轮注入，立即生效）
- 工具开关：`qq-tool-restrict.mjs` 的 `SAFE_EXACT`（放行）与 `KNOWN_DANGEROUS_GLOBAL_TOOLS`（禁止）
- 人格：改 `agent.cordis.yml` 的 `prefix`，改完要重启 DSH
