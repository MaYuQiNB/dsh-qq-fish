#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/extract_media.py —— 从 mp4 里抽「多帧画面 + 原声音频」，给 QQ×抖音桥的 watch 动作用。

为什么单独写：本机没有系统 ffmpeg，但「刷抖音」的 venv 里已经装了 imageio-ffmpeg
（自带一个静态 ffmpeg），所以直接用它，不额外往系统里装东西。

用法:
  python tools/extract_media.py <video.mp4> <outdir> [frames=6]

输出（stdout 一行 JSON）：
  { ok, duration_s, frames: [jpg 绝对路径...], audio: mp3 绝对路径|"" , error? }
只读视频文件、只写 outdir；不联网。
"""
import glob
import json
import os
import re
import subprocess
import sys

try:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
except Exception as exc:  # pragma: no cover - 环境缺依赖时如实报
    print(json.dumps({"ok": False, "error": "缺 imageio-ffmpeg：%s" % exc}, ensure_ascii=False))
    sys.exit(1)


def run(args, timeout=180):
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def main():
    video = sys.argv[1] if len(sys.argv) > 1 else ""
    outdir = sys.argv[2] if len(sys.argv) > 2 else ""
    try:
        want = int(sys.argv[3]) if len(sys.argv) > 3 else 6
    except Exception:
        want = 6
    want = max(3, min(want, 12))
    if not os.path.isfile(video):
        print(json.dumps({"ok": False, "error": "视频文件不存在：%s" % video}, ensure_ascii=False))
        return 1
    os.makedirs(outdir, exist_ok=True)

    # 时长：ffmpeg -i 会把 Duration 打到 stderr
    duration = 0.0
    try:
        probe = run([FFMPEG, "-hide_banner", "-i", video])
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", probe.stderr or "")
        if m:
            duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    except Exception:
        duration = 0.0

    fps = (want / duration) if duration > 0.5 else 0.2
    pattern = os.path.join(outdir, "frame-%02d.jpg")
    frames_cmd = [
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-i", video,
        "-vf", "fps=%.4f,scale='min(720,iw)':-2" % fps,
        "-frames:v", str(want),
        pattern,
    ]
    result = run(frames_cmd)
    frames = sorted(glob.glob(os.path.join(outdir, "frame-*.jpg")))
    if not frames:
        # 兜底：至少抽第 0 秒一帧
        run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", video,
             "-vf", "scale='min(720,iw)':-2", "-frames:v", "1",
             os.path.join(outdir, "frame-01.jpg")])
        frames = sorted(glob.glob(os.path.join(outdir, "frame-*.jpg")))

    audio = os.path.join(outdir, "audio.mp3")
    audio_result = run([
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-i", video, "-vn", "-acodec", "libmp3lame", "-b:a", "96k", audio,
    ])
    if not os.path.isfile(audio) or os.path.getsize(audio) == 0:
        audio = ""

    out = {
        "ok": bool(frames),
        "duration_s": round(duration, 2),
        "frames": frames,
        "audio": audio,
        "error": "" if frames else ((result.stderr or "")[-300:] or "抽帧失败"),
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
