# MaterialSeeker 推理服务

本目录是 MaterialSeeker monorepo 的推理与媒体处理服务。Web 应用只通过 HTTP 调用，不 import 本目录代码，也不共享数据库。

## 两种部署档位

| 档位 | 8280 `/encode` | 8281 视频处理 | 本地模型依赖 |
|---|---|---|---|
| `light` | 默认不启动 | 保留场景检测、抽帧、云端 ASR、云端画面描述 | 无 |
| `standard` | EmbeddingGemma 2，768 维 | 同左，支持本地 FunASR 兜底 | EmbeddingGemma 2 必需，FunASR 可选 |

轻量版保留的是「ASR + 画面描述 + 关键词检索」所需的生产能力。向量只是语义检索增强，不是入库的前提。

密钥获取方式、必填条件与安全说明见 [API 密钥与运行配置](../../docs/configuration.md)。

## 轻量版

```bash
python3 -m venv ~/materialseeker-light-env
~/materialseeker-light-env/bin/pip install -r requirements-light.txt
cp .env.example .env
# MATERIALSEEKER_PROFILE=light
# 配置 ASR_PROVIDER=siliconflow、ASR_CLOUD_KEY、GLM_API_KEY
# 配置 FFMPEG_BIN
bash start.sh
```

轻量启动脚本会停止旧的 8280，只启动 8281。`requirements-light.txt` 只包含 HTTP、云端 provider、场景检测和抽帧依赖，不包含 torch、FunASR、sentence-transformers 或模型权重。

### Windows PowerShell

在 `services/inference` 目录执行，环境变量直接写在当前 PowerShell 进程里：

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-light.txt
$env:MATERIALSEEKER_PROFILE = "light"
$env:ASR_PROVIDER = "siliconflow"
$env:ASR_CLOUD_KEY = "your-asr-key"
$env:GLM_API_KEY = "your-glm-key"
$env:FFMPEG_BIN = "C:/path/to/ffmpeg.exe"
.venv\Scripts\python.exe video_server.py --port 8281
```

轻量模式下：

- `MATERIALSEEKER_PROFILE=light` 会传给两个服务。
- `ASR_PROVIDER` 必须使用 `siliconflow`。云端不可用时返回 503，不尝试加载 FunASR。
- 业务仓不请求 8280，因此默认不需要启动 `embedding_server.py`。
- 若单独启动 `embedding_server.py`，`/health` 会报告 `embedding_enabled:false`，`/encode` 返回 503，`/caption` 仍可使用。

## 标准版

```bash
cp .env.example .env
# MATERIALSEEKER_PROFILE=standard，按文件内说明配置模型与密钥
bash start.sh
```

标准版使用两个独立环境：

| 服务 | 环境 | 职责 |
|---|---|---|
| 8280 `embedding_server.py` | `~/eg2-env` | EmbeddingGemma 2，多模态统一编码，768 维 |
| 8281 `video_server.py` | `~/hearsight-env` | 场景检测、抽帧、云端 ASR 与 FunASR 兜底、画面描述 |

两个环境不能合并。标准版启动时会加载 EmbeddingGemma 2；轻量版不会导入 torch 或读取模型权重。

### 边缘 / Intel NPU 后端（LiteRT-LM）

`MATERIALSEEKER_EMBEDDING_ENGINE=litert` 时，8280 不改 HTTP 接口，只把底层
前向从 sentence-transformers 换成 LiteRT-LM 的 `EmbeddingEngine`，用于 Intel
NPU 等边缘设备。视觉与音频编码器默认回退 CPU，文本主干走 NPU。

```bash
python3 -m venv ~/materialseeker-litert-env
~/materialseeker-litert-env/bin/pip install -r requirements-litert.txt
# 默认用通用 .litertlm 变体，CPU 可直接跑
export MATERIALSEEKER_PROFILE=standard
export MATERIALSEEKER_EMBEDDING_ENGINE=litert
export MATERIALSEEKER_EMBEDDING_PYTHON=$HOME/materialseeker-litert-env/bin/python
# Intel NPU 需要把模型换成与设备驱动 ABI 兼容的 AOT 变体
export MATERIALSEEKER_LITERT_MODEL=$HOME/.litert-lm/cache/huggingface/litert-community/embeddinggemma-2-740m-litert-lm/embeddinggemma-2-740m_Intel_PTL.litertlm
# 可选：文本 / 视觉 / 音频后端，默认 npu / cpu / cpu
export MATERIALSEEKER_LITERT_BACKEND=npu
export MATERIALSEEKER_LITERT_VISION_BACKEND=cpu
export MATERIALSEEKER_LITERT_AUDIO_BACKEND=cpu
bash start.sh
```

`/health` 会报告 `engine`、`backends` 与 `raw_dim`；文本仍按原有 task-prefix
口径拼接，业务仓不用区分跑在 GPU 还是 NPU。

**NPU 模型与驱动 ABI 必须匹配。** 预编译的 `Intel_PTL` 变体面向 Panther Lake，
 Meteor Lake 等设备若报 `ELF_ABI_VERSION is NOT compatible`，说明该 AOT 二进制
比当前 NPU 驱动新；此时改用通用 `.litertlm` 变体，服务会自动回退 CPU。代码保留
NPU 入口，不影响业务接口。

## 接口

### 8280

- `GET /health`：返回部署档位、向量开关、模型与维度。
- `POST /encode`：文本、图片、图加文、音频向量编码；轻量模式返回 503。
- `POST /caption`：云端视觉模型生成标题、描述和标签。

### 8281

- `GET /health`：返回部署档位、本地 ASR 开关、ffmpeg、场景检测与模型加载状态。
- `POST /process`：视频转写、场景检测与抽帧。可选 `subtitle_path` 直接复用现成 SRT，不再重复跑 ASR。
- `POST /transcribe`：音频转写，句级毫秒时间戳。
- `POST /analyze`：图片或帧描述。
- `GET /jobs/{job_id}/progress`：处理进度。

## 依赖文件

| 文件 | 用途 |
|---|---|
| `requirements-core.txt` | HTTP 与云端 provider 公共依赖，不含本地模型 |
| `requirements-light.txt` | 轻量版完整依赖，增加场景检测与抽帧 |
| `requirements-embedding.txt` | 标准版 8280 的模型依赖 |
| `requirements-litert.txt` | LiteRT-LM / Intel NPU 后端的 8280 依赖 |
| `requirements-video.txt` | 标准版 8281 的媒体处理与 FunASR 依赖 |

ffmpeg 不在 Python 依赖内，需单独安装并用 `FFMPEG_BIN` 指向二进制文件。

## 验证

```bash
python -m unittest discover -s tests -v
bash -n start.sh
```

测试覆盖轻量健康状态、禁用向量端点、标准开关、云端 ASR 保留，以及轻量模式下不错误回退本地 FunASR。
