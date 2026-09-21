"""VideoSeeker 视频处理服务。

负责把视频文件变成可入库的结构化产物：抽音轨、转写（句级时间戳）、
场景检测、按场景中点抽帧。不负责编码与写库，那两个动作在 Node 侧
（src/lib/ingest.ts + src/lib/embed.ts）完成，编码统一走 embedding 服务。

转写链路与句合并逻辑沿用 HearSight 已验证的实现，模型为中文 Paraformer
系（含 VAD、标点、说话人）。场景检测与抽帧的参数与 RAG-Anything 一致：
ContentDetector 阈值 27.0、最短场景 5 秒、单视频场景上限 50，每场景取
中点单帧。

时间戳单位统一为毫秒（FunASR sentence_info 原生单位），对外只吐毫秒。
"""

import os
import subprocess
import sys
import tempfile
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="VideoSeeker Video Ingest")

# ---------------------------------------------------------------- ffmpeg 定位

FFMPEG_CANDIDATES = [
    os.environ.get("FFMPEG_BIN", ""),
    os.path.expanduser("~/ffmpeg-env/bin/ffmpeg"),
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
]


def ffmpeg_bin() -> str:
    for c in FFMPEG_CANDIDATES:
        if c and os.path.isfile(c):
            return c
    found = subprocess.run(
        ["which", "ffmpeg"], capture_output=True, text=True
    ).stdout.strip()
    if found:
        return found
    raise HTTPException(500, "ffmpeg not found；设 FFMPEG_BIN 指定路径")


# ---------------------------------------------------------------- 句合并（搬自 HearSight）

MERGE_PUNCTUATIONS = ["，", "；", "：", "、", ",", ";", ":"]


def normalize_segments(segments: list[dict]) -> list[dict]:
    """按标点与短句合并 ASR 分段，合并后统一从 1 编号。

    规则：以合并标点结尾且同说话人则直接拼接；不足 4 字的短句带空格
    并入下一句。搬自 HearSight 的 segment_normalizer，去掉了开关参数。
    """
    if not segments:
        return []

    def ends_with_punctuation(text: str) -> bool:
        return any(text.endswith(p) for p in MERGE_PUNCTUATIONS)

    def can_merge_with_next(cur: dict, nxt: dict) -> bool:
        return cur.get("spk_id") == nxt.get("spk_id") and nxt.get("sentence", "").strip()

    merged: list[dict] = []
    i = 0
    while i < len(segments):
        current = segments[i].copy()
        did = False

        if ends_with_punctuation(current.get("sentence", "")) and i + 1 < len(segments):
            nxt = segments[i + 1]
            if can_merge_with_next(current, nxt):
                current["sentence"] += nxt["sentence"]
                current["end_time"] = nxt.get("end_time", current.get("end_time"))
                merged.append(current)
                i += 2
                did = True

        if (
            not did
            and i + 1 < len(segments)
            and len(current.get("sentence", "").strip()) < 4
        ):
            nxt = segments[i + 1]
            if can_merge_with_next(current, nxt):
                current["sentence"] += " " + nxt["sentence"]
                current["end_time"] = nxt.get("end_time", current.get("end_time"))
                merged.append(current)
                i += 2
                did = True

        if not did:
            merged.append(current)
            i += 1

    for idx, item in enumerate(merged, start=1):
        item["index"] = idx
    return merged


# ---------------------------------------------------------------- ASR（搬自 HearSight）

_asr_model = None


def get_asr_model():
    """单例加载 FunASR 四件套：语音识别 + VAD + 标点 + 说话人。"""
    global _asr_model
    if _asr_model is None:
        from funasr import AutoModel

        _asr_model = AutoModel(
            model="paraformer-zh",
            model_revision="v2.0.4",
            vad_model="fsmn-vad",
            vad_model_revision="v2.0.4",
            punc_model="ct-punc-c",
            punc_model_revision="v2.0.4",
            spk_model="cam++",
        )
    return _asr_model


def transcribe(audio_path: str, hotword: str = "") -> list[dict]:
    """转写为句级分段。返回 [{index, spk_id, sentence, start_ms, end_ms}]。

    单位说明：FunASR 的 sentence_info 时间戳原生是毫秒，这里显式转 int
    并改名成 *_ms，避免下游再猜单位。
    """
    model = get_asr_model()
    kwargs: dict[str, Any] = {"input": audio_path, "batch_size_s": 300}
    if hotword:
        kwargs["hotword"] = hotword

    res = model.generate(**kwargs)
    if not res:
        return []

    item = res[0]
    sentence_info = item.get("sentence_info")
    if sentence_info is None:
        return []

    spk_default = None
    if item.get("spk_id") is not None:
        spk_default = str(item["spk_id"])

    raw: list[dict] = []
    for s in sentence_info:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        try:
            st = float(s.get("start", 0.0))
        except (TypeError, ValueError):
            st = 0.0
        try:
            ed = float(s.get("end", st))
        except (TypeError, ValueError):
            ed = st
        spk = s.get("spk_id", s.get("spk"))
        raw.append(
            {
                "spk_id": str(spk) if spk is not None else spk_default,
                "sentence": text,
                "start_ms": int(st),
                "end_ms": int(ed),
            }
        )

    return [
        {**seg, "start_ms": int(seg["start_ms"]), "end_ms": int(seg["end_ms"])}
        for seg in normalize_segments(raw)
    ]


# ---------------------------------------------------------------- 场景检测与抽帧（参数同 RAG-Anything）


def detect_scenes(
    video_path: str,
    threshold: float = 27.0,
    min_scene_duration: float = 5.0,
    max_scenes: int = 50,
) -> list[dict]:
    """ContentDetector 检测场景边界，返回 [{start_ms, end_ms}]。

    零场景时退化为单场景（覆盖全片），避免抽不到帧。场景数超上限时
    按顺序等分合并，保证不丢片段也不爆炸。
    """
    from scenedetect import ContentDetector, SceneManager, open_video

    video = open_video(video_path)
    sm = SceneManager()
    sm.add_detector(ContentDetector(threshold=threshold))
    sm.detect_scenes(video)
    scenes = sm.get_scene_list()

    duration_ms = int(video.duration.get_seconds() * 1000) if video.duration else 0

    bounds = [(int(s.get_seconds() * 1000), int(e.get_seconds() * 1000)) for s, e in scenes]
    bounds = [(a, b) for a, b in bounds if b - a >= min_scene_duration * 1000]

    if not bounds:
        bounds = [(0, duration_ms)] if duration_ms else []
        if not bounds:
            raise HTTPException(400, "无法读取视频时长，场景检测失败")

    if len(bounds) > max_scenes:
        groups = max_scenes
        size = -(-len(bounds) // groups)
        folded: list[tuple[int, int]] = []
        for i in range(0, len(bounds), size):
            chunk = bounds[i : i + size]
            folded.append((chunk[0][0], chunk[-1][1]))
        bounds = folded

    return [{"start_ms": a, "end_ms": b} for a, b in bounds]


def extract_frame_at(video_path: str, timestamp_ms: int, out_path: str) -> str:
    """按时间戳抽单帧存 jpg。定位到最近关键帧（cv2 seek 的固有近似）。"""
    import cv2

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise HTTPException(400, f"cv2 打不开视频: {video_path}")
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(timestamp_ms / 1000.0 * fps))
        ok, frame = cap.read()
        if not ok:
            raise HTTPException(500, f"抽帧失败 at {timestamp_ms}ms")
        cv2.imwrite(out_path, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        return out_path
    finally:
        cap.release()


# ---------------------------------------------------------------- 音轨抽取


def extract_audio(video_path: str, out_wav: str) -> str | None:
    """抽音轨并转成 16k 单声道 PCM wav（ASR 要求的输入）。

    输出后缀必须与 pcm_s16le 匹配，换成 .ogg 之类的容器会被 FunASR 拒收。
    无音轨时返回 None，不算失败（静音视频仍可做画面检索）。
    """
    cmd = [
        ffmpeg_bin(),
        "-nostdin",
        "-i",
        video_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-y",
        out_wav,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        # 无音轨与容器异常都走这里，靠文件是否生成区分
        if os.path.isfile(out_wav) and os.path.getsize(out_wav) > 1024:
            return out_wav
        return None
    if not os.path.isfile(out_wav) or os.path.getsize(out_wav) < 1024:
        return None
    return out_wav


# ---------------------------------------------------------------- 编排


class ProcessRequest(BaseModel):
    video_path: str
    scene_threshold: float = 27.0
    min_scene_duration: float = 5.0
    max_scenes: int = 50
    hotword: str = ""
    frames_out_dir: str | None = None


@app.get("/health")
def health():
    return {
        "ok": True,
        "ffmpeg": ffmpeg_bin(),
        "scenedetect": _module_version("scenedetect"),
        # opencv 的发行包名是 opencv-python-headless，不是 cv2，按 cv2 查会得 null
        "opencv": _module_version("opencv-python-headless") or _module_version("opencv-python"),
        "asr_loaded": _asr_model is not None,
    }


def _module_version(name: str) -> str | None:
    try:
        import importlib.metadata

        return importlib.metadata.version(name)
    except Exception:
        return None


@app.post("/process")
def process(req: ProcessRequest):
    """视频 → 结构化产物。返回逐字稿、场景边界、帧文件路径。

    帧的向量编码不在这里做，由 Node 侧拿到帧路径后调 embedding 服务，
    保证编码入口只有一处。
    """
    if not os.path.isfile(req.video_path):
        raise HTTPException(404, f"video not found: {req.video_path}")

    out_dir = req.frames_out_dir or tempfile.mkdtemp(prefix="videoseeker-frames-")
    os.makedirs(out_dir, exist_ok=True)

    scenes = detect_scenes(
        req.video_path,
        threshold=req.scene_threshold,
        min_scene_duration=req.min_scene_duration,
        max_scenes=req.max_scenes,
    )

    frames: list[dict] = []
    for i, sc in enumerate(scenes):
        mid_ms = (sc["start_ms"] + sc["end_ms"]) // 2
        out_path = os.path.join(out_dir, f"scene_{i:04d}_{mid_ms}.jpg")
        try:
            extract_frame_at(req.video_path, mid_ms, out_path)
            frames.append({"scene_index": i, "timestamp_ms": mid_ms, "path": out_path})
        except HTTPException:
            continue

    sentences: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="videoseeker-audio-") as td:
        wav = os.path.join(td, "audio.wav")
        if extract_audio(req.video_path, wav):
            sentences = transcribe(wav, hotword=req.hotword)

    return {
        "video_path": req.video_path,
        "scenes": scenes,
        "frames": frames,
        "sentences": sentences,
        "sentence_count": len(sentences),
    }


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8281"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
