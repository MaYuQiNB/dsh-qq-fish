#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/asr.py —— 音频 → 文字（完全本地，给 QQ×抖音桥的 watch 用）。

实现：
  1) 用「刷抖音」venv 里的 imageio-ffmpeg 把任意音频解成 16k 单声道 f32 裸流（绕开 PyAV 的版本坑）；
  2) 用 faster-whisper（默认 small、CPU int8）转写中文。
模型首次使用会从 HuggingFace 镜像下载（调用方会设 HF_ENDPOINT=https://hf-mirror.com）；
之后走本地缓存，不联网。可用环境变量 QQDY_ASR_MODEL 换成 base/tiny 等更小的模型。

用法: python tools/asr.py <audio.mp3>
输出（stdout 一行 JSON）: { ok, text, model, error? }
"""
import json
import os
import subprocess
import sys


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload.get("ok") else 1


def main():
    audio = sys.argv[1] if len(sys.argv) > 1 else ""
    if not audio or not os.path.isfile(audio):
        return emit({"ok": False, "error": "音频文件不存在：%s" % audio})
    try:
        import numpy as np
        import imageio_ffmpeg
        from faster_whisper import WhisperModel
    except Exception as exc:
        return emit({"ok": False, "error": "缺 ASR 依赖（numpy/imageio-ffmpeg/faster-whisper）：%s" % exc})

    model_name = os.environ.get("QQDY_ASR_MODEL") or "small"
    try:
        ff = imageio_ffmpeg.get_ffmpeg_exe()
        decoded = subprocess.run(
            [ff, "-v", "error", "-i", audio, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
            capture_output=True, timeout=300,
        )
        samples = np.frombuffer(decoded.stdout, dtype=np.float32)
    except Exception as exc:
        return emit({"ok": False, "error": "解码音频失败：%s" % exc})
    if samples.size == 0:
        return emit({"ok": False, "error": "音频解码出来是空的（可能是纯音乐/静音）"})

    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(
            samples,
            language="zh",
            beam_size=5,
            vad_filter=False,
            condition_on_previous_text=False,  # 防「今 今 今」这类重复幻觉
            compression_ratio_threshold=2.2,
            no_speech_threshold=0.6,
        )
        text = "".join(segment.text for segment in segments).strip()
    except Exception as exc:
        return emit({"ok": False, "error": "Whisper 转写失败：%s" % exc})

    return emit({"ok": True, "text": text, "model": model_name})


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # pragma: no cover
        sys.exit(emit({"ok": False, "error": str(exc)}))
