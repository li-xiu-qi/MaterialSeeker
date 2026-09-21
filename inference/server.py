"""
VideoSeeker 推理服务。

本地 GPU 上的 embedding 编码服务，Node 侧（Next.js）只发 HTTP 请求。
模型为 instruction aware 的多模态编码器：文本与图片进同一个向量空间，
图片输入支持 image+text 组合查询。

接口：
  GET  /health                      模型与维度自检
  POST /encode  {inputs: [...]}     批量编码

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
