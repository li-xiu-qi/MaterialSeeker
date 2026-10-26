"""
MaterialSeeker 推理服务（embedding）。

本地 GPU 上的多模态编码服务，Node 侧（Next.js）只发 HTTP 请求。
模型为 EmbeddingGemma 2（google/embeddinggemma-2，Apache 2.0）：文本、代码、
图片、视频、音频进同一个 768 维向量空间。740M 参数（文本主干 270M + 视觉
170M + 音频 300M，可按需裁剪加载），支持 Matryoshka 截断
（768/512/256/128，经 MATERIALSEEKER_DIM 控制，默认 768 全量）。

接口：
  GET  /health                      模型与维度自检
  POST /encode  {inputs: [...]}     批量编码（文本 / 图片 / 图加文组合 / 音频）
  POST /caption                     一张图生成标题/描述/标签

**/caption 与 /encode 是两套完全不同的能力，不要试图合并。** /encode 出向量，
本地模型就够；/caption 要的是「这张图是什么」的自然语言，需要会看图会说话的视觉
语言模型，为偶发操作常驻它不划算，所以走在线的 GLM：按次计费、不占本地显存。
密钥与模型名从环境变量读。

instruction 是必需项：索引端与查询端必须带不同 instruction（业务仓 embed.ts
两个常量集中管理），调用方负责传，服务端缺省用通用检索指令。EmbeddingGemma 2
是 task-prefix 模型，两侧前缀口径与业务仓常量保持一致。

**运行环境是 ~/eg2-env，不是 xinfer-env。** 模型卡硬性要求
sentence-transformers >=6.1.0（多模态 dict 输入顺序）、transformers >=5.19
（embedding_gemma2 架构注册）、huggingface_hub >=2.x；xinfer-env 的 st 6.0.1
满足不了，别改回去。**dtype 必须 bfloat16**：激活值超 float16 动态范围，
fp16 下返回 NaN 或静默掉分且不报错。
"""

import argparse
import base64
import binascii
import logging
import os
import tempfile
from typing import Literal

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("videoseeker-inference")

# 服务端缺省 instruction。与业务仓 embed.ts 的两个常量保持一致：
# EmbeddingGemma 2 是 task-prefix 模型，索引侧与查询侧必须带不同前缀。
DEFAULT_PASSAGE_INSTRUCTION = "title: none | text: "
DEFAULT_QUERY_INSTRUCTION = "task: search result | query: "

MODEL_DIR = os.environ.get(
    "MATERIALSEEKER_MODEL",
    os.path.expanduser("~/models/embeddinggemma-2"),
)

# 推理引擎开关。默认沿用 sentence-transformers（GPU/CUDA 路径）；litert 走
# LiteRT-LM 的 EmbeddingEngine，用于 Intel NPU 等边缘设备。两条路径共用同一
# HTTP 接口与 instruction 口径，业务侧无感。
ENGINE_SENTENCE_TRANSFORMERS = "sentence-transformers"
ENGINE_LITERT = "litert"

# LiteRT-LM 的 .litertlm 模型包路径。默认用通用变体：它不绑定某一代 NPU 的
# AOT 二进制，能在 CPU 上直接跑；Intel NPU 需要把路径换成与设备驱动 ABI 兼容
# 的 AOT 变体（例如 embeddinggemma-2-740m_Intel_PTL.litertlm）。
LITERT_MODEL = os.environ.get(
    "MATERIALSEEKER_LITERT_MODEL",
    os.path.expanduser(
        "~/.litert-lm/cache/huggingface/litert-community/"
        "embeddinggemma-2-740m-litert-lm/"
        "embeddinggemma-2-740m.litertlm"
    ),
)


def embedding_engine() -> str:
    raw = os.environ.get("MATERIALSEEKER_EMBEDDING_ENGINE", ENGINE_SENTENCE_TRANSFORMERS)
    raw = raw.strip().lower()
    if raw not in (ENGINE_SENTENCE_TRANSFORMERS, ENGINE_LITERT):
        raise RuntimeError(
            "unknown MATERIALSEEKER_EMBEDDING_ENGINE: "
            f"{raw}; expected {ENGINE_SENTENCE_TRANSFORMERS} or {ENGINE_LITERT}"
        )
    return raw


def _litert_backend_name(env_name: str, default: str) -> str:
    raw = os.environ.get(env_name, default).strip().lower()
    if raw not in ("cpu", "gpu", "npu"):
        raise RuntimeError(f"unknown {env_name}: {raw}; expected cpu, gpu or npu")
    return raw


def litert_backend() -> str:
    return _litert_backend_name("MATERIALSEEKER_LITERT_BACKEND", "npu")


def litert_vision_backend() -> str:
    # 视觉/音频编码器当前不在 Intel NPU 上跑：LiteRT-LM 的 NPU 后端只覆盖文本
    # 签名，视觉与音频仍回退 CPU。可用环境变量显式覆盖，但默认按实测边界走。
    return _litert_backend_name("MATERIALSEEKER_LITERT_VISION_BACKEND", "cpu")


def litert_audio_backend() -> str:
    return _litert_backend_name("MATERIALSEEKER_LITERT_AUDIO_BACKEND", "cpu")


def litert_text_prefix_mode() -> str:
    raw = os.environ.get("MATERIALSEEKER_LITERT_TEXT_PREFIX_MODE", "prepend")
    raw = raw.strip().lower()
    if raw not in ("prepend", "none"):
        raise RuntimeError(
            "unknown MATERIALSEEKER_LITERT_TEXT_PREFIX_MODE: "
            f"{raw}; expected prepend or none"
        )
    return raw


def deployment_profile() -> str:
    raw = os.environ.get("MATERIALSEEKER_PROFILE", "standard").strip().lower()
    if raw not in ("light", "standard"):
        raise RuntimeError(
            f"unknown MATERIALSEEKER_PROFILE: {raw}; expected light or standard"
        )
    return raw


def embedding_enabled() -> bool:
    return deployment_profile() == "standard"


class LiteRTEmbeddingModel:
    """把 LiteRT-LM EmbeddingEngine 包成 sentence-transformers 的 encode 形态。

    这样 /encode 的分组逻辑不用分叉：文本、图片、图加文、音频仍按原有批次
    进入，只是底层前向从 torch 换成 LiteRT。返回 list[list[float]]，由 to_out
    统一截断与归一化。
    """

    def __init__(self):
        try:
            from litert_lm import Content
            from litert_lm import EmbeddingEngine
            from litert_lm import EmbeddingOptions
            from litert_lm import interfaces
        except ImportError as e:
            raise RuntimeError(
                "MATERIALSEEKER_EMBEDDING_ENGINE=litert 需要安装 litert-lm；"
                "请先 `pip install litert-lm`（Intel NPU 还需 openvino）"
            ) from e

        self._Content = Content
        self._EmbeddingOptions = EmbeddingOptions
        self._interfaces = interfaces
        self._raw_dim: int | None = None

        def make_backend(name: str):
            if name == "cpu":
                threads = os.environ.get("MATERIALSEEKER_LITERT_THREADS")
                return interfaces.CPU(
                    thread_count=int(threads) if threads else None
                )
            if name == "gpu":
                return interfaces.GPU()
            dispatch_dir = os.environ.get("MATERIALSEEKER_LITERT_DISPATCH_LIB_DIR")
            return interfaces.NPU(
                litert_dispatch_lib_dir=dispatch_dir
                if dispatch_dir is not None
                else None
            )

        backend = make_backend(litert_backend())
        vision_backend = make_backend(litert_vision_backend())
        audio_backend = make_backend(litert_audio_backend())
        requested = (litert_backend(), litert_vision_backend(), litert_audio_backend())

        log.info(
            "loading LiteRT model %s (backend=%s vision=%s audio=%s)",
            LITERT_MODEL,
            requested[0],
            requested[1],
            requested[2],
        )

        def create_engine(text_backend, vision, audio):
            engine = EmbeddingEngine(
                model_path=LITERT_MODEL,
                backend=text_backend,
                vision_backend=vision,
                audio_backend=audio,
            )
            # 先挂到 self 再探测：_embed_one 走 self._engine。探测失败要清掉，
            # 避免把半初始化的引擎留给回退分支。
            self._engine = engine
            try:
                raw_dim = len(self._embed_one(self._Content.Text("dimension probe")).embedding)
            except Exception:
                self._engine = None
                raise
            return engine, raw_dim

        try:
            self._engine, self._raw_dim = create_engine(backend, vision_backend, audio_backend)
            actual = requested
        except Exception as accelerated_error:
            # NPU/GPU 不可用或模型与驱动 ABI 不兼容时，回退 CPU。通用 .litertlm
            # 变体在 CPU 上可直接跑；AOT NPU 变体回退后仍可能失败，那就让错误冒出去。
            if all(name == "cpu" for name in requested):
                raise RuntimeError(
                    f"LiteRT EmbeddingEngine 初始化失败（backend={'/'.join(requested)}）: "
                    f"{accelerated_error}"
                ) from accelerated_error
            log.warning(
                "LiteRT backend %s unavailable, falling back to cpu: %s",
                "/".join(requested),
                accelerated_error,
            )
            try:
                self._engine, self._raw_dim = create_engine(
                    self._interfaces.CPU(), self._interfaces.CPU(), self._interfaces.CPU()
                )
            except Exception as cpu_error:
                raise RuntimeError(
                    "LiteRT EmbeddingEngine 初始化失败，且 CPU 回退也失败: "
                    f"{cpu_error}"
                ) from cpu_error
            actual = ("cpu", "cpu", "cpu")

        if actual == requested:
            self._backend_name = f"litert:{actual[0]}/{actual[1]}/{actual[2]}"
        else:
            self._backend_name = (
                f"litert:{actual[0]}/{actual[1]}/{actual[2]} "
                f"(requested {requested[0]}/{requested[1]}/{requested[2]})"
            )
        log.info("LiteRT model loaded (%s, raw_dim=%s)", self._backend_name, self._raw_dim)

    @property
    def device(self) -> str:
        return self._backend_name

    def get_sentence_embedding_dimension(self) -> int:
        if self._raw_dim is None:
            self._raw_dim = len(self._embed_one(self._Content.Text("dimension probe")).embedding)
        return self._raw_dim

    def _embed_one(self, content):
        return self._engine.compute_embedding(
            content, options=self._EmbeddingOptions(normalize=True)
        )

    def _embed_batch(self, requests: list) -> list[list[float]]:
        if not requests:
            return []
        responses = self._engine.compute_embedding_batch(
            requests, options=self._EmbeddingOptions(normalize=True)
        )
        if len(responses) != len(requests):
            raise RuntimeError(
                f"LiteRT returned {len(responses)} embeddings for {len(requests)} inputs"
            )
        return [list(resp.embedding) for resp in responses]

    @staticmethod
    def _pil_to_bytes(image) -> bytes:
        import io

        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()

    def encode(
        self,
        inputs,
        prompt: str | None = None,
        batch_size: int | None = None,
        convert_to_numpy: bool | None = None,
        normalize_embeddings: bool | None = None,
        show_progress_bar: bool | None = None,
        **_: object,
    ) -> list[list[float]]:
        """兼容 sentence-transformers 的 encode 调用签名。

        prompt 只对文本生效：EG2 是 task-prefix 模型，索引/查询两侧前缀由业务
        侧传入；LiteRT 侧按 prepend 模式拼到文本前。图片、图加文、音频沿用
        模型卡范式，不传 prompt。
        """
        del batch_size, convert_to_numpy, normalize_embeddings, show_progress_bar

        if not inputs:
            return []

        first = inputs[0]
        if isinstance(first, str):
            prefix_mode = litert_text_prefix_mode()
            requests = []
            for text in inputs:
                content_text = f"{prompt}{text}" if prompt and prefix_mode == "prepend" else text
                requests.append(self._Content.Text(content_text))
            return self._embed_batch(requests)

        if isinstance(first, dict) and "audio" in first:
            requests = [self._Content.AudioFile(str(item["audio"])) for item in inputs]
            return self._embed_batch(requests)

        if isinstance(first, dict) and "image" in first:
            # 图加文组合是一个 request 内的多内容序列；纯图每张一个 request。
            if "text" in first and first["text"]:
                requests = [
                    [
                        self._Content.ImageBytes(self._pil_to_bytes(item["image"])),
                        self._Content.Text(str(item["text"])),
                    ]
                    for item in inputs
                ]
            else:
                requests = [
                    self._Content.ImageBytes(self._pil_to_bytes(item["image"]))
                    for item in inputs
                ]
            return self._embed_batch(requests)

        raise RuntimeError(f"unsupported LiteRT encode input: {type(first)!r}")


app = FastAPI(title="MaterialSeeker Inference")

_model = None
_dim = None


class TextInput(BaseModel):
    modality: Literal["text"]
    text: str
    instruction: str | None = None


class ImageInput(BaseModel):
    modality: Literal["image"]
    # 文件路径或 base64（data URL 亦可）
    path: str | None = None
    b64: str | None = None
    text: str | None = None
    instruction: str | None = None


class AudioInput(BaseModel):
    modality: Literal["audio"]
    # 只认服务端可读的本地文件路径或 base64（data URL 亦可）。**不做远程
    # 下载**：推理服务不替业务侧决定网络边界，URL 由调用方自己落地成文件。
    path: str | None = None
    b64: str | None = None
    # 音频向量不走 task-prefix：EG2 模型卡的音频范式是 {"audio": path}，
    # 不传 prompt。字段保留只为请求结构一致，服务端忽略。
    instruction: str | None = None


class EncodeRequest(BaseModel):
    inputs: list[TextInput | ImageInput | AudioInput]


class EmbeddingOut(BaseModel):
    vector: list[float]
    dim: int


def get_model():
    global _model
    if not embedding_enabled():
        raise HTTPException(503, "embedding is disabled in light mode")
    if _model is None:
        if embedding_engine() == ENGINE_LITERT:
            _model = LiteRTEmbeddingModel()
            return _model

        import torch
        from sentence_transformers import SentenceTransformer

        # bfloat16 是模型卡的硬性要求（激活值超 fp16 范围，fp16 下 NaN 或
        # 静默掉分且不报错）。不支持 bf16 的硬件回退 float32，不要回退 fp16。
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float32
        log.info("loading model %s (dtype=%s)", MODEL_DIR, dtype)
        # 不需要 trust_remote_code：sentence-transformers 原生格式
        # （modules.json + config_sentence_transformers.json 随权重分发）
        _model = SentenceTransformer(
            MODEL_DIR, model_kwargs={"torch_dtype": dtype}, device="cuda"
        )
        log.info("model loaded on %s", _model.device)
    return _model


def embed_dim() -> int:
    """目标维度。EmbeddingGemma 2 原生 768，MRL 可截 512/256/128（256 实测
    基本不掉分；128 多模态掉大分，只用于纯文本）。默认 768 全量。
    改维度必须三处同步：业务仓 db.ts 的 VECTOR_DIM、embed.ts 的校验、这里。"""
    return int(os.environ.get("MATERIALSEEKER_DIM", "768"))


def _resolve_audio_path(im: AudioInput, temp_paths: list[str]) -> str:
    """把音频输入解析成服务端本地路径。b64 落临时文件，路径交给调用方清理。"""
    if im.path:
        if not os.path.isfile(im.path):
            raise HTTPException(400, f"audio not found: {im.path}")
        return im.path
    if im.b64:
        data = im.b64.split(",", 1)[-1] if im.b64.startswith("data:") else im.b64
        try:
            raw = base64.b64decode(data)
        except (binascii.Error, ValueError):
            raise HTTPException(400, "audio b64 is not valid base64")
        if not raw:
            raise HTTPException(400, "audio b64 is empty")
        # 后缀不参与解码，只留给排查问题时认得出这是临时音频。
        fd, tmp = tempfile.mkstemp(prefix="materialseeker-audio-", suffix=".audio")
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        temp_paths.append(tmp)
        return tmp
    raise HTTPException(400, "audio input needs path or b64")


@app.get("/health")
def health():
    profile = deployment_profile()
    if not embedding_enabled():
        return {
            "ok": True,
            "profile": profile,
            "embedding_enabled": False,
            "model": None,
        }
    if _model is None:
        return {"ok": False, "profile": profile, "embedding_enabled": True, "detail": "model not loaded yet"}
    engine = embedding_engine()
    payload = {
        "ok": True,
        "profile": profile,
        "embedding_enabled": True,
        "engine": engine,
        "raw_dim": _model.get_sentence_embedding_dimension(),
        "truncated_dim": embed_dim(),
        "device": str(_model.device),
    }
    if engine == ENGINE_LITERT:
        payload["model"] = LITERT_MODEL
        payload["backends"] = {
            "text": litert_backend(),
            "vision": litert_vision_backend(),
            "audio": litert_audio_backend(),
        }
    else:
        payload["model"] = MODEL_DIR
    return payload


@app.post("/encode")
def encode(req: EncodeRequest) -> dict:
    if not embedding_enabled():
        raise HTTPException(503, "embedding is disabled in light mode")
    if not req.inputs:
        raise HTTPException(400, "empty inputs")

    model = get_model()
    dim = embed_dim()

    # 按 (instruction, 形态) 分组，每组一次前向。bench 验证过的调用范式：
    #   instruction 走单个 prompt 字符串（不接受 list）
    #   纯图片直接传 PIL 对象，不传 prompt
    #   图加文组合走 [{"image": PIL, "text": str}]，不传 prompt
    result: list[EmbeddingOut | None] = [None] * len(req.inputs)

    # --- 文本：按 instruction 分组 ---
    text_groups: dict[str, list[int]] = {}
    for idx, item in enumerate(req.inputs):
        if isinstance(item, TextInput):
            inst = item.instruction or DEFAULT_PASSAGE_INSTRUCTION
            text_groups.setdefault(inst, []).append(idx)

    for inst, idxs in text_groups.items():
        vecs = model.encode(
            [req.inputs[i].text for i in idxs],  # type: ignore[union-attr]
            prompt=inst,
            batch_size=32,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        for i, idx in enumerate(idxs):
            result[idx] = to_out(vecs[i], dim)

    # --- 图片：纯图 与 图加文组合 分两批 ---
    from PIL import Image

    def _load_pil(im: ImageInput) -> Image.Image:
        if im.b64:
            import io

            data = im.b64.split(",", 1)[-1] if im.b64.startswith("data:") else im.b64
            return Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB")
        if im.path:
            if not os.path.isfile(im.path):
                raise HTTPException(400, f"image not found: {im.path}")
            return Image.open(im.path).convert("RGB")
        raise HTTPException(400, "image input needs path or b64")

    pure_img: list[int] = []
    combo: list[tuple[int, Image.Image, str]] = []
    for idx, item in enumerate(req.inputs):
        if isinstance(item, ImageInput):
            if item.text:
                combo.append((idx, _load_pil(item), item.text))
            else:
                pure_img.append(idx)

    if pure_img:
        # st 6.1 的 dict 输入范式（EmbeddingGemma 2 模型卡示例）：纯图走
        # {"image": PIL}。不直接传 PIL list——EG2 的多模态 processor 只认
        # dict 形态，PIL list 会按旧 CLIP 路径解析或报错。
        pils = [_load_pil(req.inputs[i]) for i in pure_img]  # type: ignore[union-attr]
        vecs = model.encode(
            [{"image": im} for im in pils],
            batch_size=16,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        for i, idx in enumerate(pure_img):
            result[idx] = to_out(vecs[i], dim)

    if combo:
        # 图加文组合：[{"image": PIL, "text": str}]，EG2 的占位符交错由
        # processor 内部处理，一次前向出一个混合向量。不传 prompt。
        vecs = model.encode(
            [{"image": im, "text": t} for _, im, t in combo],
            batch_size=4,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        for i, (idx, _, _) in enumerate(combo):
            result[idx] = to_out(vecs[i], dim)

    # --- 音频：纯音频一批 ---
    # st 6.1 的 dict 输入范式：{"audio": 本地路径}。不传 prompt，也不要
    # 把音频塞进图加文组合——音频没有画面，组合出来的向量没有业务含义。
    audio_idx = [i for i, item in enumerate(req.inputs) if isinstance(item, AudioInput)]
    if audio_idx:
        audio_paths: list[str] = []
        temp_paths: list[str] = []
        try:
            for idx in audio_idx:
                path = _resolve_audio_path(req.inputs[idx], temp_paths)  # type: ignore[arg-type]
                audio_paths.append(path)
            vecs = model.encode(
                [{"audio": p} for p in audio_paths],
                batch_size=4,
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            for i, idx in enumerate(audio_idx):
                result[idx] = to_out(vecs[i], dim)
        finally:
            # b64 落的是临时文件，无论前向成功失败都要清掉，不能把音频留在
            # 临时目录里等操作系统某天清理。
            for p in temp_paths:
                try:
                    os.unlink(p)
                except OSError:
                    pass

    if any(r is None for r in result):
        raise HTTPException(500, "some inputs were not encoded")

    return {"embeddings": [r.model_dump() for r in result]}  # type: ignore[union-attr]


class CaptionRequest(BaseModel):
    """一张图生成标题、描述、标签。"""

    image_path: str | None = None
    image_b64: str | None = None


# 生成用的提示词。**要求 JSON 而不是自由文本**，因为下游要把它拆成三个字段分别
# 存（title/caption/tags），自由文本还得再让模型格式化一遍，多一次出错机会。
#
# 长度上限是刻意给的：标题 10 字是为了在列表卡片里不折行，描述 60 字是为了在
# 详情页一行放得下，标签 5 个是为了不超过 MAX_TAGS 且每个都言之有物。
# 不给上限的话模型会写成一段散文，塞不进界面，用户还得自己删。
CAPTION_PROMPT = (
    "请分析这张图片，只返回 JSON，不要任何解释或代码块标记："
    '{"title": "简短标题，10字以内", '
    '"description": "画面描述，60字以内，说清画面里有什么", '
    '"tags": ["标签1", "标签2", "标签3"]}'
    "标签用名词或短词，3到5个，不要句子。"
)

# 视觉模型与接口地址。**缺省值不是拍脑袋，是同一台机器上 SmartImager 已跑通的那套**，
# 换模型或换供应商时改这两个环境变量即可，不必动代码。
GLM_BASE_URL = os.environ.get("OPENAI_API_BASE", "https://open.bigmodel.cn/api/paas/v4")
GLM_VISION_MODEL = os.environ.get("VISION_MODEL", "glm-4v-flash")


@app.post("/caption")
def caption(req: CaptionRequest) -> dict:
    """用视觉语言模型给一张图生成标题、描述与标签。

    图片三种来路都认：服务端路径、裸 base64、data URL。入库面板传 base64（本地
    待命区的图还没落盘），素材库传路径（图已经在库里）。

    **max_tokens 给 512。** 智谱现行 API 的合法范围是 [1,1024]，早先给的 2000
    会被整体拒绝（400 max_tokens参数非法）。glm-4v-flash 不是 thinking 模型，
    推理不占额度，512 对三字段 JSON 绰绰有余。若换成 thinking 型视觉模型，
    要先确认它是否把推理算进 completion_tokens，再决定是否顶到 1024 上限。

    **返回结构固定三字段**，解析失败也不抛 500：title 空、description 放模型原文
    截断、tags 空。调用方据此判断「这次没成」，而不是让一次解析失败把整批标注
    中断。
    """
    if not req.image_path and not req.image_b64:
        raise HTTPException(404, "需要 image_path 或 image_b64")

    b64 = req.image_b64
    if not b64:
        if not os.path.isfile(req.image_path):  # type: ignore[arg-type]
            raise HTTPException(404, f"图片不存在: {req.image_path}")
        with open(req.image_path, "rb") as f:  # type: ignore[arg-type]
            b64 = base64.b64encode(f.read()).decode()

    # data URL 只取逗号后面那段，否则 base64 解码会失败
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[1] if "," in b64 else ""

    # 按扩展名猜 MIME，猜不出用 jpeg。GLM 侧对这两种都认，猜错不会失败。
    mime = "image/jpeg"
    if req.image_path:
        low = req.image_path.lower()
        if low.endswith(".png"):
            mime = "image/png"
        elif low.endswith(".webp"):
            mime = "image/webp"
        elif low.endswith(".gif"):
            mime = "image/gif"

    try:
        from openai import OpenAI
    except ImportError:
        # 装 openai 包是部署步骤，不该在请求里才暴露成一堆 import 栈
        raise HTTPException(503, "推理服务缺少 openai 依赖，无法调用视觉模型")

    api_key = os.environ.get("DASHSCOPE_API_KEY") or os.environ.get("GLM_API_KEY", "")
    if not api_key:
        raise HTTPException(503, "未配置视觉模型 API Key，无法生成标注")

    client = OpenAI(api_key=api_key, base_url=GLM_BASE_URL)
    try:
        resp = client.chat.completions.create(
            model=GLM_VISION_MODEL,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": CAPTION_PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                    ],
                }
            ],
            max_tokens=512,
            temperature=0.3,
        )
    except Exception as e:
        # 上游限流、超时、鉴权失败都在这里。原文带给调用方，用户看到的是
        # 「这次为什么没生成」，不是一句「生成失败」。
        log.error("视觉模型调用失败: %s", e)
        raise HTTPException(502, f"视觉模型调用失败: {e}")

    msg = resp.choices[0].message
    # thinking 模型可能把正文放在 reasoning_content 里（content 为空时）。
    # 两处都兜，别在一种模型行为上赌。
    raw = (msg.content or "").strip()
    if not raw:
        raw = (getattr(msg, "reasoning_content", None) or "").strip()
    if not raw:
        return {"title": "", "description": "", "tags": []}

    return parse_caption(raw)


def parse_caption(raw: str) -> dict:
    """从模型输出里抠出 title/description/tags。

    **不要求模型一定守规矩。** 它有时会套 ```json 代码块，有时前后带解释文字，
    有时 JSON 是坏的。所以按「第一个 { 到最后一个 }」切，切出来再 json.loads，
    失败了退化成「description 放原文」。这样坏输出只是描述质量差，不会让调用链断。
    """
    import json
    import re

    # 去掉代码块围栏。**不能只去首尾**：模型有时输出 ```json\n{...}\n```，
    # 围栏在 JSON 两侧，正则一次清掉比切片稳妥。
    cleaned = re.sub(r"```(?:json)?\s*", "", raw)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
        try:
            obj = json.loads(cleaned[start : end + 1])
            if isinstance(obj, dict):
                return {
                    "title": str(obj.get("title") or "")[:120],
                    "description": str(obj.get("description") or "")[:600],
                    # tags 可能是字符串（模型偶尔把数组写成逗号串），两种都接
                    "tags": normalize_tags(obj.get("tags")),
                }
        except (json.JSONDecodeError, ValueError, TypeError):
            pass
    return {"title": "", "description": raw[:600], "tags": []}


def normalize_tags(v) -> list[str]:
    """标签归一。模型给的可能是 list、逗号串、或干脆是 None。"""
    if isinstance(v, list):
        items = [str(x) for x in v]
    elif isinstance(v, str):
        import re

        items = re.split(r"[,，;；]", v)
    else:
        return []
    out: list[str] = []
    for t in items:
        t = t.strip()
        if t and t not in out:
            out.append(t)
        if len(out) >= 12:
            break
    return out


def to_out(vec, dim: int) -> EmbeddingOut:
    """MRL 截断到目标维度，并重新归一化（截断后余弦口径一致）。"""
    # LiteRT 返回 list[float]，sentence-transformers 返回 numpy；两条路径都走
    # 同一套 Python 运算，避免在 to_out 里依赖某一端的数组协议。
    values = [float(x) for x in vec[:dim]]
    norm = sum(x * x for x in values) ** 0.5
    if norm > 0:
        values = [x / norm for x in values]
    return EmbeddingOut(vector=values, dim=dim)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8280)
    args = parser.parse_args()

    # 标准版启动即加载；轻量版不导入 torch，也不读取模型权重。
    if embedding_enabled():
        get_model()
    else:
        log.info("light mode: embedding model disabled; caption endpoint remains available")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
