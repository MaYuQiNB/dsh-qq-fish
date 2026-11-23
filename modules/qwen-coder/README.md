# qwen-coder

把「敲代码」的活交给千问（OpenAI 兼容接口），拿到完整代码；主对话仍由你自己的 agent 负责。

## 安装

```bash
cp qwen.example.json qwen.json   # 填 apiKey
node qwen-coder.mjs "实现一个 xxx"
```

## 用法

```bash
node qwen-coder.mjs "实现一个日期工具函数" --files src/api.js,src/utils.js --model qwen3.7-max --out result.py
```

| 参数 | 说明 |
| --- | --- |
| 位置参数 | 要实现/修改的需求 |
| `--files` | 附带的上下文文件（≤60k 字符） |
| `--model` | 默认 `qwen3.7-max`，失败自动回退 `qwen3.7-plus` / `qwen4-max` |
| `--out` | 结果另存为文件 |

## 示例响应

```
### 文件: workdays.py
```python
...
```
```

## 注意

- 输出默认带 Markdown 代码块；落地前自己跑一遍测试
- 每次调用会打印 token 用量（stderr）

## License
MIT
