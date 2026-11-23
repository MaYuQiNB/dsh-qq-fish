# 常驻 ASR 小服务：stdin/stdout 按行 JSON 交互，模型只加载一次（比每次冷启动快很多）。
# 请求： {"id": 1, "wav": "C:/.../in.wav"}
# 响应： {"id": 1, "ok": true, "text": "..."}
import sys, json, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

try:
    from faster_whisper import WhisperModel
    model = WhisperModel("small", device="cpu", compute_type="int8")
    print(json.dumps({"ready": True}), flush=True)
except Exception as e:
    print(json.dumps({"ready": False, "error": str(e)}), flush=True)
    sys.exit(1)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        continue
    rid = req.get("id")
    wav = req.get("wav")
    try:
        segments, info = model.transcribe(wav, language="zh", beam_size=5, vad_filter=False)
        text = "".join(s.text for s in segments).strip()
        print(json.dumps({"id": rid, "ok": True, "text": text}, ensure_ascii=False), flush=True)
    except Exception as e:
        print(json.dumps({"id": rid, "ok": False, "error": str(e), "text": ""}, ensure_ascii=False), flush=True)
