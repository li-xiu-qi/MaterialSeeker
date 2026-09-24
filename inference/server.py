"""
VideoSeeker 推理服务。

本地 GPU 上的 embedding 编码服务，Node 侧（Next.js）只发 HTTP 请求。
模型为 instruction aware 的多模态编码器：文本与图片进同一个向量空间，
图片输入支持 image+text 组合查询。

接口：
  GET  /health                      模型与维度自检
  POST /encode  {inputs: [...]}     批量编码
  POST /caption                     一张图生成标题/描述/标签

**/caption 与 /encode 是两套完全不同的能力，不要试图合并。** /encode 出向量，
本地模型就够；/caption 要的是「这张图是什么」的自然语言，需要会看图会说话的视觉
语言模型。本地那些 VL 模型虽然也能干，但要常驻几 GB 显存，而标注是偶发操作，为它
常驻一个模型不划算。所以走在线的 GLM：按次计费、不占本地显存、效果还更好。
密钥与模型名从环境变量读，缺省值对齐同一台机器上 SmartImager 已跑通的那套。

instruction 是必需项。索引端与查询端必须带不同 instruction，
调用方负责传，服务端不猜。缺省时用通用检索指令。
"""

import argparse
import base64
import logging
import os
from typing import Literal

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("videoseeker-inference")

DEFAULT_PASSAGE_INSTRUCTION = "Represent this text for retrieval."
DEFAULT_QUERY_INSTRUCTION = (
    "Given a search query, retrieve relevant passages that answer the query."
)

MODEL_DIR = os.environ.get(
    "VIDEOSEEKER_MODEL",
    "/home/ke/models/Qwen3-VL-Embedding-2B",
)

app = FastAPI(title="VideoSeeker Inference")

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


class EncodeRequest(BaseModel):
    inputs: list[TextInput | ImageInput]


class EmbeddingOut(BaseModel):
    vector: list[float]
    dim: int


def get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        log.info("loading model %s", MODEL_DIR)
        _model = SentenceTransformer(MODEL_DIR, trust_remote_code=True, device="cuda")
        log.info("model loaded on %s", _model.device)
    return _model


def embed_dim() -> int:
    """MRL 截断后的目标维度，截断损失实测约 0.1 个 R@10 点。"""
    return int(os.environ.get("VIDEOSEEKER_DIM", "1024"))


@app.get("/health")
def health():
    if _model is None:
        return {"ok": False, "detail": "model not loaded yet"}
    return {
        "ok": True,
        "model": MODEL_DIR,
        "raw_dim": _model.get_sentence_embedding_dimension(),
        "truncated_dim": embed_dim(),
        "device": str(_model.device),
    }


@app.post("/encode")
def encode(req: EncodeRequest) -> dict:
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
        pils = [_load_pil(req.inputs[i]) for i in pure_img]  # type: ignore[union-attr]
        vecs = model.encode(
            pils,
            batch_size=16,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        for i, idx in enumerate(pure_img):
            result[idx] = to_out(vecs[i], dim)

    if combo:
        vecs = model.encode(
            [{"image": im, "text": t} for _, im, t in combo],
            batch_size=4,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        for i, (idx, _, _) in enumerate(combo):
            result[idx] = to_out(vecs[i], dim)

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
GLM_VISION_MODEL = os.environ.get("VISION_MODEL", "glm-4.6v-flash")


@app.post("/caption")
def caption(req: CaptionRequest) -> dict:
    """用视觉语言模型给一张图生成标题、描述与标签。

    图片三种来路都认：服务端路径、裸 base64、data URL。入库面板传 base64（本地
    待命区的图还没落盘），素材库传路径（图已经在库里）。

    **max_tokens 必须给够（2000）。** glm-4.6v 是 thinking 模型，推理过程也占
    额度，给 10 个 token 时推理就把额度吃光，返回的 content 是空字符串，看起来
    像模型坏了。实测 2000 下推理与正文都有。

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

    api_key = os.environ.get("GLM_API_KEY", "")
    if not api_key:
        raise HTTPException(503, "未配置 GLM_API_KEY，无法生成标注")

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
            max_tokens=2000,
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
    """MRL 截断到目标维度，并重新归一化（与选型实验 bench 口径一致）。"""
    v = vec[:dim]
    n = float((v * v).sum() ** 0.5)
    if n > 0:
        v = v / n
    return EmbeddingOut(vector=[float(x) for x in v], dim=dim)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8280)
    args = parser.parse_args()

    get_model()  # 启动即加载，首请求不必等
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
