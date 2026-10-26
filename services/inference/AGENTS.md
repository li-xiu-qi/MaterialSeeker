# MaterialSeeker 推理服务开发须知

monorepo 结构与部署纪律以仓库根 `AGENTS.md` 为权威，本文件只写推理服务细节。

本目录是推理层，与 `apps/web` 的 Next.js 应用通过 HTTP 通信。
改接口先看业务侧调用方：`apps/web/src/lib/embed.ts`（embedding）与
`apps/web/src/lib/ingestVideo.ts` / `ingestAudio.ts`（视频处理）。

## 本仓的核心架构：provider 层

**本仓管理「能力」，不绑定「服务商」。** 每种能力（embedding、caption、ASR）
在仓内有两类实现：本地模型推理与云端 API。业务侧只认 HTTP 端点
（`/encode`、`/caption`、`/transcribe`），不关心背后是 Spark 上的 EG2 还是
硅基的 API。切换服务商只改 `.env`，不动业务仓一行代码。

三类能力的现状：

| 能力 | 本地实现 | 云端实现 | 当前选择 |
|---|---|---|---|
| embedding（`/encode`） | EmbeddingGemma 2（`~/eg2-env`，GPU） | 无（768 维空间必须自持，换供应商等于换库） | 本地 |
| caption（`/caption`、`/analyze`） | 本地 VLM（未落地） | 智谱 glm-4v-flash（默认值）：已从价格表退役但接口实测 5/5 可用、平均 0.9s、JSON 干净，零成本；失效时切 GLM-5.3-Flash（付费档 ¥0.8/M in、¥2.8/M out）| 云端。图片标注（入库后批量触发）与视频帧描述（入库链路自动触发）均已接入，后者可用 `MATERIALSEEKER_FRAME_CAPTION=0` 关 |
| ASR（`/transcribe`） | FunASR Paraformer（`~/hearsight-env`，CPU RTF 0.16） | 硅基 XingChenASR-V3.2（60 连打零 429，长音频 RTF 0.067） | **云端优先，本地兜底**（`ASR_PROVIDER=siliconflow`，2026-10-08 落地） |

三条设计约束：

1. **新增服务商是加一个 provider 文件，不是改端点。** 端点契约（请求字段、
   响应结构、instruction 口径）变了业务侧就要跟着改，那是最后手段。
2. **provider 只做一件事：把上游的返回规整成端点契约。** 限流、重试、超时、
   key 切换都在 provider 内部消化，不把上游的错误形态透传给业务侧。
3. **任何能力都可以降级到本地。** 云端断了有本地实现的（ASR）自动回退；
   没有本地实现的（caption 的本地 VLM）明确返回 503 与原因，不假装成功。

## 部署档位与依赖分层

`MATERIALSEEKER_PROFILE` 是两个服务与业务仓共用的开关：

- `light`：ASR、图片/帧描述、场景检测、抽帧与关键词检索保留；8280 默认不启动，业务侧不请求向量服务。ASR 必须走云端，禁止回退加载 FunASR。
- `standard`：启用 8280 与 EmbeddingGemma 2，保留轻量版全部能力；未配置时默认此档，保持旧行为。

```
requirements-core.txt       HTTP 与云端 provider 公共依赖，不含本地模型
requirements-light.txt      core + scenedetect / opencv / numpy，轻量版完整依赖
requirements-embedding.txt  标准版 8280 的 torch / sentence-transformers / pillow
requirements-video.txt      标准版 8281 的媒体处理与 FunASR
```

轻量启动脚本只起 8281，并停止旧 8280；标准启动脚本仍用 `eg2-env` 与 `hearsight-env`。`embedding_server.py` 的 torch import 必须在 `get_model()` 内，轻量启动与 `/health` 不得读取模型权重。轻量新素材的向量字段为 NULL；切回标准后用 `POST /api/maintenance/backfill-embeddings` 显式回填，不自动执行。

## 同步红线

**向量维度改一处必炸。** 目标维度有三处：`apps/web/src/lib/db.ts` 的 `VECTOR_DIM`
（当前 768）、`apps/web/src/lib/embed.ts` 的校验、本目录 `.env` 的 `MATERIALSEEKER_DIM`
（默认 768，EG2 原生维度）。三处必须同时改。只改一两处的结果是请求在
边界值上才失败（截断后维度不匹配的请求才炸），平时不报，联调时很难定位。
**换维度或换模型后，库里所有已存向量全部作废，必须全量重算**（业务仓
没有自动迁移，换模型的重算记录见 PRD v0.8）。

**instruction 不能省。** 索引端与查询端分别带 passage 与 query 指令，
这两个常量集中在业务仓 `embed.ts`，本仓只做透传和缺省兜底。不要在本仓
各处写死 instruction 字符串。

## 部署机（dgx-spark）

| 端口 | 进程 | 环境 | 职责 |
|---|---|---|---|
| 8280 | embedding_server.py | `~/eg2-env` | EmbeddingGemma 2 多模态 embedding 编码（GPU） |
| 8281 | video_server.py | `~/hearsight-env` | 抽音轨、ASR、场景检测、抽帧 |

**embedding 的环境是 `~/eg2-env`，不是 xinfer-env。** 版本链是模型卡硬性
要求（缺一不跑）：sentence-transformers >=6.1.0、transformers >=5.19.0、
huggingface_hub >=2.x、torch 2.14.0+cu130（torch 栈从 xinfer-env 复制八个
目录）。dtype 必须是 bfloat16（服务端自动选，勿改 fp16：NaN 或静默掉分）。
环境重建时按上述版本链逐项核对，不在其他环境之间混用 torch 与 transformers。

ARM64 + GB10 统一内存。部署目录：`~/materialseeker/services/inference`（代码）+
模型权重 `~/models/embeddinggemma-2`（1.5G）+ ffmpeg `~/ffmpeg-env/bin/ffmpeg`。

启动用本仓 `bash start.sh`（端口反查停旧、起新、日志落 logs/）。
不要用进程名匹配停服务，模式串里出现 `python` 字样会把 ssh 自身命令行
匹配上，命令自杀返回 255，端口可能已释放但服务没起。

## 实测过的坑

ASR 模型是懒加载的（`_asr_model` 首次转写请求时才加载），`/health` 的
`asr_loaded: false` 是正常状态，不是故障。

opencv-python-headless 不带 AV1 解码器，B 站高画质档默认下发 AV1，
`cv2.VideoCapture` 会失败。触发条件是「试读一帧失败就跑 ffmpeg 转 H.264
副本」，不按视频来源判断；副本交给 `detect_scenes` 时走 `already_checked`
分支，否则同一文件会被转码两遍。

**max_tokens 上限 1024**（2026-10-08 实测，超过即 400 `max_tokens参数非法`）。代码钉 512：
glm-4v-flash 不是 thinking 模型，推理不占额度，三字段 JSON 远用不满。换 thinking
型视觉模型时要先确认它是否把推理算进 completion_tokens，再决定是否顶到上限。
**云端 provider 的限流分工是刻意设计，不要「优化」成推理侧重试。** 现状：
provider 内 SDK `max_retries=0`（默认那两次退避合计 1.5 秒，扛不住容量窗口），
429 原样透出；业务仓 `analyze.ts` 按 2s/6s/14s/30s 五次重试（参数来自 60 张连打
实测：43 成 17 败，429 成簇，簇后 3.5-10 秒恢复），退避期间进度条显示
「模型繁忙，X 秒后重试」。推理侧重试是静默的，用户只会看到进度卡住。
**新增云端 provider 沿用同一分工**：不重试、429 透出、detail 写清是限流还是
上游故障。ASR 是第一个按这套落地的 provider（`video_server.py` 的
`transcribe_cloud`），它的判错方式可以照抄：

- `CloudASRRateLimit`（429）→ 原样抛给业务侧重试，**不兜底**。兜底会让业务侧
  以为这次成功了，退避节奏被打乱。
- `CloudASRError`（网络失败、5xx、字段静默缺失、超上传限制）→ 记 warning 后
  回退本地。这一类是「这次别用云端了」，不是「等一会再来」。
- 回退要留痕：`_LAST_ASR_PROVIDER` 记实际生效的那条，经响应体 `asr_provider`
  交给业务仓写进 `transcripts.asr_engine`。照配置写会在回退时记成云端，事后
  按引擎统计对不上真实耗时。

**caption 走付费档，别去翻免费替代品。** 智谱视觉免费档（GLM-4.6V-Flash 系）
已于 2026-10-08 从价格表退役，现存免费档只剩三款文本模型（GLM-4.7-Flash、
GLM-4-Flash-250414、GLM-Z1-Flash），没有视觉能力。接棒的 GLM-5.3-Flash 是付费档
（¥0.8/M in、¥2.8/M out，2026-10-08 用户已核实，无需再验）。单张图标注成本在
厘级，批量 178 张的量级是小额，但它是**花钱的**，选型与换模型时先看价格表再动。
免费模型是否仍可用，以供应商当前价格表和接口实测为准；caption 不按免费模型口径选型。

下载来的视频材料入库前用 ffprobe 确认「有视频流且有音频流」再进链路，
只看退出码会漏掉合并失败的文件。

## 本地校验

先跑单元测试：`python -m unittest discover -s tests -v`。音频向量至少覆盖「dict 输入且不传 prompt」与「路径缺失明确 400」，不要在单元测试里拉真实模型。改动部署机代码后按 spark 上 `bash start.sh` 重启两个服务，`curl http://127.0.0.1:8280/health` 应返回 `ok: true`，视频服务 `/health` 返回 `asr_loaded` 字段即可。
