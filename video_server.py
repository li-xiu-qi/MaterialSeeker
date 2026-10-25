"""MaterialSeeker 视频处理服务。

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
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("videoseeker-video")

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="MaterialSeeker Video Ingest")


def deployment_profile() -> str:
    raw = os.environ.get("MATERIALSEEKER_PROFILE", "standard").strip().lower()
    if raw not in ("light", "standard"):
        raise RuntimeError(
            f"unknown MATERIALSEEKER_PROFILE: {raw}; expected light or standard"
        )
    return raw


def local_asr_enabled() -> bool:
    return deployment_profile() == "standard"


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
    # 不用 Unix `which`：Git Bash 会返回 /c/...，Windows Python 不能把
    # 这个 MSYS 路径交给 CreateProcess。shutil.which 在各平台都返回本机可执行路径。
    found = shutil.which("ffmpeg")
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
    if not local_asr_enabled():
        raise HTTPException(503, "轻量模式未启用本地 ASR，请配置云端 ASR provider")
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


# ---------------------------------------------------------------- ASR provider 层

# 云端优先、本地兜底（2026-10-08 定）。选型的实测依据：
#   - 硅基免费档 XingChenASR-V3.2：60 连打零 429（约 53 次/分钟），
#     360.2 秒音频 24.18 秒完成（RTF 0.067），长音频无惩罚
#   - 本地 FunASR Paraformer：CPU RTF 0.16，1 小时音频约 9.6 分钟，
#     且懒加载首次要等模型进内存
# 切回本地只改 ASR_PROVIDER，端点契约（返回结构、毫秒单位）不变。


class CloudASRError(Exception):
    """云端 ASR 不可用，调用方应回退本地。

    与 429 是两回事：429 是限流，透出去让业务侧重试；这一类是「这次别用
    云端了」，包括网络失败、5xx、segments 静默缺失、超出上传限制。
    """


class CloudASRRateLimit(Exception):
    """云端 ASR 限流。原样透给业务侧重试，不在本层退避。"""


# 实际生效的提供方（单 worker 服务内共享）。初值 local：没转过写时不该报一个
# 云端名上去。回退本地时改写它，理由见 _asr_provider_name。
_LAST_ASR_PROVIDER = ["local"]


def _asr_cloud_config() -> tuple[str, str, str]:
    base = os.environ.get("ASR_CLOUD_BASE_URL", "https://api.siliconflow.cn")
    key = os.environ.get("ASR_CLOUD_KEY", "")
    model = os.environ.get("ASR_CLOUD_MODEL", "XingChenAGI/XingChenASR-V3.2")
    if not key:
        raise CloudASRError("ASR_CLOUD_KEY 未配置")
    return base.rstrip("/"), key, model


def _asr_cloud_limits() -> tuple[int, int]:
    """返回 (最大字节数, 最大毫秒数)。

    硅基文档上限是「时长 ≤1 小时、文件 ≤50MB」，但**更紧的是体积**：
    16k 单声道 pcm_s16le 是 32KB/s，50MB 只能装约 26 分钟。两个都判，
    字节数默认留 10% 余量（multipart 边界与头部也占额度）。
    """
    max_bytes = int(os.environ.get("ASR_CLOUD_MAX_BYTES", str(45 * 1024 * 1024)))
    max_ms = int(os.environ.get("ASR_CLOUD_MAX_MS", str(60 * 60 * 1000)))
    return max_bytes, max_ms


def _shrink_for_upload(wav_path: str, td: str) -> str:
    """wav 超限时转一份 mp3 再传。返回 mp3 路径（可能与入参同一个文件）。

    为什么不直接回落本地：长视频（会议录像、长录屏）是上云的主要收益场景，
    本地 RTF 0.16 下一个小时要等十分钟。mp3 体积约为同长 pcm wav 的 1/10，
    16k 单声道下对识别率的影响可忽略（源不是立体声高码率素材）。
    """
    mp3 = os.path.join(td, "audio.mp3")
    proc = subprocess.run(
        [ffmpeg_bin(), "-nostdin", "-i", wav_path, "-vn", "-ac", "1", "-ar", "16000",
         "-b:a", "48k", "-y", mp3],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0 or not os.path.isfile(mp3) or os.path.getsize(mp3) < 512:
        raise CloudASRError("wav 转 mp3 失败，无法上传")
    return mp3


def transcribe_cloud(audio_path: str) -> list[dict]:
    """硅基 XingChenASR 转写。返回结构与本地一致：毫秒、句子级列表。

    三处与本地不同的处理，都是实测踩过的：

    1. **必须传 `response_format=verbose_json`**，否则 segments 静默缺失，
       HTTP 200 且 text 正常，只是没有时间戳。不报错的字段缺失比报错更难查，
       所以 segments 键缺失判定为 CloudASRError 走回退，不返回无时间戳的结果
       （端点契约是对外只吐毫秒时间戳）。但 **segments 是空数组不算故障**：
       无声/纯音乐素材的空结果是正常的，判成故障会让它白等一轮本地模型加载。
    2. **秒转毫秒**。硅基 segments 的 start/end 是浮点秒，FunASR 的
       sentence_info 原生毫秒，入栈前统一。
    3. **不跑 normalize_segments**。本地原始是句级、短句多，合并后才是完整
       句；硅基的 segment 跟语音活动走（连续人声约 20 秒强切，遇长静音提前
       切），一个 segment 里常有多句话。再按标点合并会把段拼得更长，句级
       跳转的定位反而更糊。所以云端路径保留 segment 原样。
    """
    import requests as _rq

    base, key, model = _asr_cloud_config()
    max_bytes, max_ms = _asr_cloud_limits()

    size = os.path.getsize(audio_path)
    # wav 头能算时长，但抽出来的就是 16k 单声道 pcm_s16le，按码率算最稳
    dur_ms = probe_duration_ms(audio_path)
    if size > max_bytes or dur_ms > max_ms:
        with tempfile.TemporaryDirectory(prefix="asr-shrink-") as td:
            shrunk = _shrink_for_upload(audio_path, td)
            return _post_transcription(shrunk, base, key, model)
    return _post_transcription(audio_path, base, key, model)


def _post_transcription(audio_path: str, base: str, key: str, model: str) -> list[dict]:
    import requests as _rq

    url = f"{base}/v1/audio/transcriptions"
    t0 = time.time()
    try:
        with open(audio_path, "rb") as f:
            files = {"file": (os.path.basename(audio_path), f, "application/octet-stream")}
            data = {"model": model, "response_format": "verbose_json"}
            r = _rq.post(url, files=files, data=data, headers={"Authorization": f"Bearer {key}"},
                         timeout=1800)
    except _rq.RequestException as e:
        raise CloudASRError(f"云端 ASR 网络失败: {e}") from e

    if r.status_code == 429:
        raise CloudASRRateLimit(f"云端 ASR 限流: {r.text[:200]}")
    if r.status_code != 200:
        raise CloudASRError(f"云端 ASR HTTP {r.status_code}: {r.text[:200]}")

    try:
        payload = r.json()
    except ValueError as e:
        raise CloudASRError(f"云端 ASR 返回非 JSON: {r.text[:200]}") from e

    segs = payload.get("segments")
    # segments 缺失（键不在或不是数组）= 接口故障：可能 verbose_json 没生效或
    # 对端改版，回退本地。**segments 是空数组 = 正常业务结果**：这段音频没有
    # 可识别的语音（纯音乐、静音、纯噪音）。把后者也判成故障会让每次遇到无声
    # 素材都白等一轮本地模型加载（实测 105 秒），而本地跑同一段同样返回空。
    if not isinstance(segs, list):
        raise CloudASRError("云端 ASR 未返回 segments（可能未生效 verbose_json 或已改版）")
    out: list[dict] = []
    for s in segs:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        try:
            st = float(s.get("start", 0.0) or 0.0)
        except (TypeError, ValueError):
            st = 0.0
        try:
            ed = float(s.get("end", st) or st)
        except (TypeError, ValueError):
            ed = st
        out.append({
            "spk_id": None,
            "sentence": text,
            "start_ms": int(round(st * 1000)),
            "end_ms": int(round(ed * 1000)),
        })
    if not out:
        # segments 有条目但 text 全空。无声、纯音乐、纯噪音素材都是这个形态，
        # 本地 FunASR 跑同一段同样返回空列表，所以这是正常结果而非故障。
        # 判成故障会让它白等一轮本地模型加载（实测 105 秒）。
        log.info("云端 ASR 空转写（segments 有条目但无有效文本，按无声素材处理）")
        return []

    log.info("云端 ASR 完成: model=%s 段数=%d 耗时=%.1fs", model, len(out), time.time() - t0)
    return out


def transcribe_local(audio_path: str, hotword: str = "") -> list[dict]:
    """FunASR Paraformer 转写（本地兜底）。返回 [{spk_id, sentence, start_ms, end_ms}]。

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


def _asr_provider_name() -> str:
    """实际生效的 ASR 提供方，供响应体带回给业务仓记录。

    记在模块级变量而不是探测环境变量：云端失败回退本地时，环境变量仍是
    siliconflow，而真正产出结果的是本地。回退这件事要让调用方知道。
    """
    return _LAST_ASR_PROVIDER[0]


def transcribe(audio_path: str, hotword: str = "") -> list[dict]:
    """转写入口。按 ASR_PROVIDER 分派，两条路返回同一结构。

    这是全仓唯一的 ASR 调用点（/transcribe 与 /process 都走这里），所以
    换 provider 只需要改这一个函数与 .env，不会出现「改了一边、另一边还在
    用旧模型」而结果为空的那种静默不一致。

    **429 透出、其余回退本地。** 回退链上不会二次抛 CloudASRError：本地
    这条路自己失败时把异常原样抛给调用方，那已经是最后一道。
    """
    provider = os.environ.get("ASR_PROVIDER", "local").strip().lower()
    if provider in ("", "local", "funasr"):
        if not local_asr_enabled():
            raise HTTPException(503, "轻量模式要求 ASR_PROVIDER=siliconflow，未启用本地 FunASR")
        _LAST_ASR_PROVIDER[0] = "local"
        return transcribe_local(audio_path, hotword)

    if provider in ("siliconflow", "silicon", "cloud"):
        try:
            out = transcribe_cloud(audio_path)
            _LAST_ASR_PROVIDER[0] = "siliconflow"
            return out
        except CloudASRRateLimit:
            # 限流不兜底：兜底会让业务侧以为这次成功了，退避节奏被打乱
            raise
        except CloudASRError as e:
            if not local_asr_enabled():
                log.warning("云端 ASR 不可用，轻量模式无本地兜底: %s", e)
                raise HTTPException(503, f"云端 ASR 不可用，轻量模式未启用本地兜底: {e}") from e
            log.warning("云端 ASR 不可用，回退本地 FunASR: %s", e)
            _LAST_ASR_PROVIDER[0] = "local"
            return transcribe_local(audio_path, hotword)

    raise HTTPException(400, f"未知 ASR_PROVIDER: {provider}")


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
    """读音视频时长（毫秒）。只读容器头，读不到就返回 0，不报错。

    ffmpeg 不带输出文件时会在打印元数据后立即退出；不要加 ``-f null -``，
    那会把整部视频完整解码一遍，长素材仅为了读时长就耗时数分钟。
    """
    try:
        proc = subprocess.run(
            [ffmpeg_bin(), "-nostdin", "-i", path],
            capture_output=True,
            text=True,
            timeout=15,
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
    # 已有字幕时直接复用，不重复跑 ASR。字幕是内容资产，优先于重新转写。
    subtitle_path: str | None = None
    # 调用方的任务号。给了才会记录进度，调用方轮询 /jobs/{job_id}/progress 拿。
    job_id: str | None = None


@app.get("/health")
def health():
    return {
        "ok": True,
        "profile": deployment_profile(),
        "local_asr_enabled": local_asr_enabled(),
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
        # 与 /process 同源：业务仓据此写 transcripts.asr_engine
        "asr_provider": _asr_provider_name(),
    }


def parse_srt(path: str) -> list[dict]:
    """把现成 SRT 转成与 ASR 相同的句级结构，供 /process 直接复用。"""
    text = Path(path).read_text(encoding="utf-8-sig")
    time_re = re.compile(
        r"(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})"
    )

    def ms(value: str) -> int:
        hh, mm, rest = value.split(":")
        ss, milli = re.split(r"[,.]", rest)
        return (int(hh) * 3600 + int(mm) * 60 + int(ss)) * 1000 + int(milli)

    out: list[dict] = []
    for block in re.split(r"\r?\n\r?\n", text.strip()):
        match = time_re.search(block)
        if not match:
            continue
        content = [
            line.strip()
            for line in block.replace(match.group(0), "").strip().splitlines()
            if line.strip() and not line.strip().isdigit()
        ]
        sentence = " ".join(content).strip()
        if not sentence:
            continue
        out.append({
            "sentence": sentence,
            "start_ms": ms(match.group(1)),
            "end_ms": ms(match.group(2)),
            "spk_id": None,
        })
    return out


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
    # 时长必须来自视频流元数据，不能取末场景结束时间：短末场景会被
    # min_scene_duration 过滤，二者在这种素材上并不相等。
    duration_ms = probe_duration_ms(usable)
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
    if req.subtitle_path:
        if not os.path.isfile(req.subtitle_path):
            raise HTTPException(404, f"subtitle not found: {req.subtitle_path}")
        _setp(jid, "transcribe")
        sentences = parse_srt(req.subtitle_path)
    else:
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
        "duration_ms": duration_ms,
        "scenes": scenes,
        "frames": frames,
        "sentences": sentences,
        "sentence_count": len(sentences),
        # 实际走的那条路。业务仓把它写进 transcripts.asr_engine，否则换 provider
        # 之后库里记的还是 funasr-paraformer-zh，事后按引擎筛/统计全是错的。
        "asr_provider": "subtitle" if req.subtitle_path else _asr_provider_name(),
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

    走 glm-4v-flash 这类多模态对话模型，不是 embedding 模型：embedding 只能
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
            model=os.environ.get("VS_ANALYZE_MODEL", "glm-4v-flash"),
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": ANALYZE_PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}},
                    ],
                }
            ],
            max_tokens=512,
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
