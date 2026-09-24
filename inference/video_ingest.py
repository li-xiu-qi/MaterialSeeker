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

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from typing import Any, Optional

import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("videoseeker-video")

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


# ---------------------------------------------------------------- 进度上报
#
# /process 是分钟级任务，调用方（Node 侧）需要知道卡在哪一步。做法不是把任务
# 改成异步轮询，而是在原有流程里每个阶段开始时更新一次进度字典，调用方按
# job_id 轮询 GET /jobs/{job_id}/progress。进程退出即清零，任务本来也活不过
# 进程退出，语义一致。
#
# 用锁是因为 uvicorn 默认线程池，两个 /process 并发时会同时写这个字典。

_PROGRESS: dict[str, dict[str, Any]] = {}
_PROGRESS_LOCK = threading.Lock()

# 阶段顺序与权重。前端按权重把各阶段映射成一条百分比进度条，所以这里的顺序
# 就是用户看到的顺序，不要为了省事把顺序打乱。
PROGRESS_STAGES = [
    "prepare",
    "scenes",
    "frames",
    "audio",
    "transcribe",
]


def _setp(job_id: str | None, stage: str, **extra: Any) -> None:
    if not job_id:
        return
    with _PROGRESS_LOCK:
        _PROGRESS[job_id] = {"stage": stage, **extra}
        # 兜底防漏：调用方异常退出没来删条目时，字典不能无限长
        if len(_PROGRESS) > 128:
            for k in list(_PROGRESS)[: len(_PROGRESS) - 128]:
                _PROGRESS.pop(k, None)


def _clearp(job_id: str | None) -> None:
    """清掉一个任务的进度。**由调用方在任务终态时调**，这里不自己清：
    done 阶段要能被轮询到一次，否则调用方看到的最后一帧停在上一阶段。"""
    if not job_id:
        return
    with _PROGRESS_LOCK:
        _PROGRESS.pop(job_id, None)


def _pstage(job_id: str | None) -> str | None:
    if not job_id:
        return None
    with _PROGRESS_LOCK:
        return _PROGRESS.get(job_id, {}).get("stage")


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
    already_checked: bool = False,
) -> list[dict]:
    """ContentDetector 检测场景边界，返回 [{start_ms, end_ms}]。

    零场景时退化为单场景（覆盖全片），避免抽不到帧。场景数超上限时
    按顺序等分合并，保证不丢片段也不爆炸。

    cv2 解不了的编码（AV1 等本机 opencv 无解码器的情况）先转码成
    H.264 再检测，转码产物用完即删。调用方若已备好可解码副本
    （process 里会备），传 already_checked=True 避免重复转码。
    """
    from scenedetect import ContentDetector, SceneManager, open_video

    if already_checked:
        usable, tmp = video_path, None
    else:
        usable, tmp = _ensure_decodable(video_path)
    try:
        video = open_video(usable)
        sm = SceneManager()
        sm.add_detector(ContentDetector(threshold=threshold))
        sm.detect_scenes(video)
        scenes = sm.get_scene_list()

        duration_ms = int(video.duration.get_seconds() * 1000) if video.duration else 0
    finally:
        if tmp:
            os.unlink(tmp)

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


def _ensure_decodable(video_path: str) -> tuple[str, str | None]:
    """确认 cv2 能解码这个文件，不能则转码成 H.264 的临时副本。

    返回 (可用路径, 需清理的临时路径或 None)。只试读一帧，成本可忽略。
    转码用 libx264 + crf 28：检索只要画面内容，不需要保真度。
    """
    import cv2

    cap = cv2.VideoCapture(video_path)
    ok = False
    if cap.isOpened():
        ok, _ = cap.read()
    cap.release()
    if ok:
        return video_path, None

    log.warning("cv2 解不了 %s，先转码成 H.264", video_path)
    fd, tmp = tempfile.mkstemp(suffix=".mp4", prefix="videoseeker-transcode-")
    os.close(fd)
    proc = subprocess.run(
        [
            ffmpeg_bin(),
            "-nostdin",
            "-i",
            video_path,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "28",
            "-c:a",
            "copy",
            "-y",
            tmp,
        ],
        capture_output=True,
        text=True,
        timeout=3600,
    )
    if proc.returncode != 0 or not os.path.isfile(tmp):
        if os.path.isfile(tmp):
            os.unlink(tmp)
        raise HTTPException(500, f"转码失败: {proc.stderr[-300:]}")
    return tmp, tmp


def probe_duration_ms(path: str) -> int:
    """读音视频时长（毫秒）。只为进度条提供参照，读不到就返回 0，不报错。"""
    try:
        proc = subprocess.run(
            [ffmpeg_bin(), "-nostdin", "-i", path, "-f", "null", "-"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        # ffmpeg 不给 json，时长在 stderr 的 Duration: HH:MM:SS.ss 里
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", proc.stderr or "")
        if not m:
            return 0
        h, mi, s = (float(x) for x in m.groups())
        return int(((h * 60 + mi) * 60 + s) * 1000)
    except Exception:
        return 0


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


class TranscribeRequest(BaseModel):
    """/transcribe 的入参。**只要音频路径**，不要 scene/frames 那一套。"""

    audio_path: str
    hotword: str = ""
    job_id: str | None = None


class ProcessRequest(BaseModel):
    video_path: str
    scene_threshold: float = 27.0
    min_scene_duration: float = 5.0
    max_scenes: int = 50
    hotword: str = ""
    frames_out_dir: str | None = None
    # 调用方的任务号。给了才会记录进度，调用方轮询 /jobs/{job_id}/progress 拿。
    job_id: str | None = None


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


@app.get("/jobs/{job_id}/progress")
def job_progress(job_id: str):
    """查一个 /process 的进度。没有这个 job_id 返回 404，调用方据此判断任务
    是否已经结束（结束后进度会被清掉）。"""
    with _PROGRESS_LOCK:
        p = _PROGRESS.get(job_id)
    if p is None:
        raise HTTPException(404, f"no progress for {job_id}")
    return p


@app.delete("/jobs/{job_id}/progress")
def job_progress_clear(job_id: str):
    """任务终态时由调用方删掉进度条目。成功路径也会留一个 done 在这里，
    不删就是常驻内存。"""
    _clearp(job_id)
    return {"ok": True}


def _module_version(name: str) -> str | None:
    try:
        import importlib.metadata

        return importlib.metadata.version(name)
    except Exception:
        return None


@app.post("/transcribe")
def transcribe_only(req: TranscribeRequest):
    """音频 → 句级转写。**不抽帧、不检场景**，那是视频才有的事。

    音频文件直接调 /process 会失败：/process 的第二步是 detect_scenes，它拿
    opencv 打开文件读视频流，纯音频没有视频流，抽帧零产物。音频模态要的是
    「抽音轨 + 转写」这一半，所以单独开一个端点，复用同一批函数
    （extract_audio、transcribe），不另写一套 ASR 调用——两处各写一遍的结果
    是换模型时只改一边，而错了的那边不会报错，只是转写结果为空。

    -vn 让 ffmpeg 丢掉视频流，对 mp4（只有音轨要抽）与 mp3/flac/m4a（本来
    就没有视频流）是同一个参数，不需要按扩展名分支。
    """
    if not os.path.isfile(req.audio_path):
        raise HTTPException(404, f"audio not found: {req.audio_path}")

    jid = req.job_id
    _setp(jid, "prepare")

    sentences: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="videoseeker-audio-") as td:
        wav = os.path.join(td, "audio.wav")
        audio = extract_audio(req.audio_path, wav)
        if audio:
            # 转写是全程最长的一段，内部拿不到细分进度（FunASR 一次 generate
            # 跑完才返回）。报音频时长，前端据此显示「音频 X 分 X 秒，已等待 Y」。
            _setp(jid, "transcribe", duration_ms=probe_duration_ms(audio))
            sentences = transcribe(wav, hotword=req.hotword)

    _setp(jid, "done")
    return {
        "audio_path": req.audio_path,
        "sentences": sentences,
        "sentence_count": len(sentences),
    }


@app.post("/process")
def process(req: ProcessRequest):
    """视频 → 结构化产物。返回逐字稿、场景边界、帧文件路径。

    帧的向量编码不在这里做，由 Node 侧拿到帧路径后调 embedding 服务，
    保证编码入口只有一处。

    进度：给了 job_id 就在每个阶段开始时记一次，调用方轮询
    GET /jobs/{job_id}/progress。转写那一步内部再细分（秒/句），因为它是
    全程最长的一段，不给细分的话进度条会长时间不动。
    """
    if not os.path.isfile(req.video_path):
        raise HTTPException(404, f"video not found: {req.video_path}")

    out_dir = req.frames_out_dir or tempfile.mkdtemp(prefix="videoseeker-frames-")
    os.makedirs(out_dir, exist_ok=True)

    jid = req.job_id
    _setp(jid, "prepare")

    # 抽帧与场景检测要用同一份可解码副本：AV1 等编码会转码一次，
    # 两处各转一遍等于双倍耗时。副本在 finally 里清。
    usable, tmp = _ensure_decodable(req.video_path)
    try:
        _setp(jid, "scenes")
        scenes = detect_scenes(
            usable,
            threshold=req.scene_threshold,
            min_scene_duration=req.min_scene_duration,
            max_scenes=req.max_scenes,
            already_checked=True,
        )

        frames: list[dict] = []
        for i, sc in enumerate(scenes):
            # 每帧一次太频繁，按约 5% 粒度报，最后一帧必报
            step = max(1, len(scenes) // 20)
            if i == 0 or (i + 1) % step == 0 or i == len(scenes) - 1:
                _setp(jid, "frames", done=i + 1, total=len(scenes))
            mid_ms = (sc["start_ms"] + sc["end_ms"]) // 2
            out_path = os.path.join(out_dir, f"scene_{i:04d}_{mid_ms}.jpg")
            try:
                extract_frame_at(usable, mid_ms, out_path)
                frames.append({"scene_index": i, "timestamp_ms": mid_ms, "path": out_path})
            except HTTPException:
                continue
    finally:
        if tmp and os.path.isfile(tmp):
            os.unlink(tmp)

    sentences: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="videoseeker-audio-") as td:
        wav = os.path.join(td, "audio.wav")
        audio = extract_audio(req.video_path, wav)
        if audio:
            # 转写是全程最长的一段，且内部拿不到细分进度（FunASR 一次 generate
            # 跑完才返回）。把音频时长报出去，前端据此显示「音频 X 分 X 秒，
            # 已等待 Y」——等待时间是真实流逝的，比一条不动的进度条可信。
            _setp(jid, "transcribe", duration_ms=probe_duration_ms(audio))
            sentences = transcribe(wav, hotword=req.hotword)

    result = {
        "video_path": req.video_path,
        "scenes": scenes,
        "frames": frames,
        "sentences": sentences,
        "sentence_count": len(sentences),
    }
    # 结果本身由 /process 的响应体返回，进度里不放，免得轮询接口把整份逐字稿
    # 反复拉一遍。
    _setp(jid, "done")
    return result


# ---------------------------------------------------------------- 图片 AI 标注

# 视觉模型的提示词。**要求返回 JSON 而不是自然语言**，因为调用方要直接落库：
# 三段自由文本回来还得再解析一次，而解析失败的代价是这一张的标注全丢。
#
# temperature 压到 0.3：标注要的是稳定可复现的描述，不是文采。同一张图两次标注
# 差太多的话，用户没法判断该信哪次。
ANALYZE_PROMPT = (
    "请分析这张图片，只返回 JSON，不要有任何其他文字。"
    '格式：{"title": "简短标题，15字以内", '
    '"description": "详细描述画面内容，80字以内，说清画面里有什么、在做什么", '
    '"tags": ["标签1", "标签2", "标签3", "标签4", "标签5"]}。'
    "标签要填用户之后可能用来搜这个词，比如场景、主体、颜色、情绪。"
)


class AnalyzeRequest(BaseModel):
    image_path: Optional[str] = None
    image_base64: Optional[str] = None


@app.post("/analyze")
def analyze(req: AnalyzeRequest):
    """图片 -> 标题 / 描述 / 标签。**给上传后的批量标注用。**

    走 glm-4.6v-flash 这类多模态对话模型，不是 embedding 模型：embedding 只能
    告诉我们两张图像不像，说不出图像里是什么。标注要的是后者。

    实现照搬 SmartImager 那一套，三处兼容都是撞过的：
    1. 传 base64 而不是路径。推理服务与文件不一定同机，路径不可靠。
    2. 模型可能把 JSON 包在 markdown 代码块里，要先剥掉再找首尾花括号。
    3. thinking 模型的正文可能在 reasoning_content 里而 content 是空的，
       两个都读，否则拿到空串还以为模型坏了。

    失败不返回半成品：抛 5xx，让调用方把这一条标记成失败并继续下一张。
    一张的失败不该让整批标注停下来。限流是例外，透出 429 而不是 5xx，理由见下面。
    """
    import base64 as _b64

    if req.image_base64:
        img_b64 = req.image_base64
    elif req.image_path and os.path.isfile(req.image_path):
        with open(req.image_path, "rb") as f:
            img_b64 = _b64.b64encode(f.read()).decode()
    else:
        raise HTTPException(status_code=404, detail="图片文件不存在")

    try:
        from openai import OpenAI, RateLimitError

        # max_retries=0：SDK 默认那两次重试的退避合计只有 1.5 秒左右，扛不住一次容量
        # 窗口（2026-09-26 17:57 实测 429 连续持续 11 秒以上）。重试交给调用方按同样
        # 的节奏做，那边能一边等一边给用户报进度，藏在这里重试是静默的，用户只会
        # 看到进度卡住不动。
        client = OpenAI(
            api_key=os.environ.get("GLM_API_KEY", ""),
            base_url=os.environ.get("OPENAI_API_BASE", "https://open.bigmodel.cn/api/paas/v4"),
            max_retries=0,
        )
        if img_b64.startswith("data:"):
            img_b64 = img_b64.split(",", 1)[1]

        resp = client.chat.completions.create(
            model=os.environ.get("VS_ANALYZE_MODEL", "glm-4.6v-flash"),
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": ANALYZE_PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}},
                    ],
                }
            ],
            max_tokens=2000,
            temperature=0.3,
        )

        msg = resp.choices[0].message
        raw = msg.content or ""
        if not raw:
            raw = getattr(msg, "reasoning_content", "") or ""
        if not raw:
            # 模型确实回了但两个字段都空。这不是解析问题，是这一次调用没产出，
            # 按失败处理，让调用方重试或跳过，不要把空标注写进库。
            raise HTTPException(status_code=502, detail="模型未返回内容")

        raw_clean = re.sub(r"```json\s*|```\s*", "", raw)
        start = raw_clean.find("{")
        end = raw_clean.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                result = json.loads(raw_clean[start:end])
                tags = result.get("tags") or []
                if not isinstance(tags, list):
                    tags = []
                return {
                    "title": str(result.get("title") or "")[:120],
                    "description": str(result.get("description") or "")[:500],
                    "tags": [str(t)[:20] for t in tags if str(t).strip()][:12],
                }
            except json.JSONDecodeError:
                pass
        # JSON 都没找着：把原文当前 200 字当描述返回，至少不白跑一次。
        # 调用方会照常入库，用户看到一段能读的文字，比一条空标注好。
        return {"title": "", "description": raw[:200], "tags": []}
    except HTTPException:
        raise
    except RateLimitError as e:
        # 限流必须原样透出 429，不能压成 500：调用方靠状态码区分「模型忙，等等再来」
        # 和「这一张真的坏了」。压成 500 的后果是批量标注从第 9 张起全部永久失败，
        # 用户看到一片红色，而真正要做的只是等十几秒。
        log.warning(f"标注被限流: {e}")
        raise HTTPException(status_code=429, detail=str(e))
    except Exception as e:
        log.error(f"图片标注失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8281"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
