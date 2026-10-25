# API 密钥与运行配置

MaterialSeeker 使用两类云端服务密钥：`ASR_CLOUD_KEY` 负责语音转写，`GLM_API_KEY` 负责图片和视频帧描述。本地向量模型与本地 FunASR 不需要这两类密钥。

本文只使用占位符。不要把真实密钥写进仓库、Issue、截图或公开日志。

## 1. 先准备配置文件

在 `services/inference` 目录复制模板：

```bash
cp .env.example .env
```

`.env` 已被 `.gitignore` 排除。`start.sh` 启动时会读取这个文件。

## 2. 两类密钥分别怎么取得

| 配置项 | 用途 | 官方入口 |
| --- | --- | --- |
| `ASR_CLOUD_KEY` | 调用硅基流动的云端 ASR，处理视频和音频转写 | [SiliconFlow 快速上手](https://docs.siliconflow.cn/cn/userguide/quickstart)，登录 [SiliconFlow 控制台](https://cloud.siliconflow.cn/) 创建 API Key |
| `GLM_API_KEY` | 调用智谱视觉模型，生成图片与视频帧描述 | [智谱 API Key 管理说明](https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management)，登录 [智谱开放平台](https://open.bigmodel.cn/) 创建 API Key |

建议为开发环境和正式环境使用不同的密钥，并只开通实际需要的权限。

## 3. 轻量版必须配置什么

轻量版不加载本地 EmbeddingGemma 2，也不回退到本地 FunASR，因此：

- 视频和音频转写必须配置 `ASR_CLOUD_KEY`。
- 图片或视频帧需要 AI 描述时，必须配置 `GLM_API_KEY`。
- 只做文本、基础图片管理和页面验收时，可以不启动 8281，也不需要这两类密钥。

一个最小配置示例：

```dotenv
MATERIALSEEKER_PROFILE=light
ASR_PROVIDER=siliconflow
ASR_CLOUD_KEY=your-siliconflow-api-key
GLM_API_KEY=your-bigmodel-api-key
FFMPEG_BIN=/path/to/ffmpeg
```

其他配置继续使用 `.env.example` 中的默认值：

| 配置项 | 默认值或作用 | 通常需要修改吗 |
| --- | --- | --- |
| `ASR_CLOUD_BASE_URL` | `https://api.siliconflow.cn` | 不需要 |
| `ASR_CLOUD_MODEL` | `XingChenAGI/XingChenASR-V3.2` | 只在更换 ASR 模型时修改 |
| `OPENAI_API_BASE` | `https://open.bigmodel.cn/api/paas/v4` | 不需要 |
| `VISION_MODEL`、`VS_ANALYZE_MODEL` | 图片与帧描述使用的视觉模型 | 按供应商当前可用模型调整，不把某个型号当成永久免费或永久可用 |
| `FFMPEG_BIN` | FFmpeg 可执行文件路径 | 指向文件本身，不是安装目录 |

### 不需要画面描述时

如果只想处理视频转写、场景检测和抽帧，可以关闭帧描述：

```dotenv
MATERIALSEEKER_FRAME_CAPTION=0
```

此时视频入库不调用视觉模型，`GLM_API_KEY` 可以为空。主动使用图片 AI 标注时仍需要该密钥。

## 4. 标准版什么时候需要密钥

标准版使用本地 EmbeddingGemma 2 生成向量，向量编码本身不调用云端 API：

```dotenv
MATERIALSEEKER_PROFILE=standard
MATERIALSEEKER_MODEL=/path/to/models/embeddinggemma-2
MATERIALSEEKER_DIM=768
```

标准版的转写可以二选一：

- `ASR_PROVIDER=siliconflow`：使用云端 ASR，需要 `ASR_CLOUD_KEY`。
- `ASR_PROVIDER=local`：使用本地 FunASR，不需要 ASR 云端密钥，但需要安装 `requirements-video.txt` 中的本地依赖。

画面描述仍按上节处理。模型更换后，既有向量不保证兼容，需要显式重建，不要混用不同模型或维度的向量。

## 5. 启动与验证

在 `services/inference` 目录启动：

```bash
bash start.sh
curl http://127.0.0.1:8281/health
```

Web 应用要使用相同的部署档位：

```bash
cd apps/web
MATERIALSEEKER_PROFILE=light npm run dev
```

需要远程调用推理服务时，再配置 Web 侧地址：

```dotenv
MATERIALSEEKER_INFERENCE_URL=http://127.0.0.1:8280
MATERIALSEEKER_VIDEO_URL=http://127.0.0.1:8281
```

远程地址按实际部署填写，不要把内网地址写进公开文档。

## 6. 常见报错怎么判断

| 现象 | 优先检查 |
| --- | --- |
| `ASR_CLOUD_KEY 未配置` | `.env` 是否位于 `services/inference`，启动脚本是否读取了该文件，密钥名是否写错 |
| 返回 401 或 403 | 密钥是否有效、是否过期、账号是否有对应模型权限 |
| 返回 429 | 是否触发限流或额度不足，稍后重试并检查账户额度 |
| 返回 503 | 云端服务是否不可用；轻量版没有本地 FunASR 兜底，不要把期待放在本地模型上 |
| `ffmpeg not found` | `FFMPEG_BIN` 是否指向可执行文件，而不是目录 |
| 有转写但没有画面描述 | `GLM_API_KEY` 是否配置，`MATERIALSEEKER_FRAME_CAPTION` 是否被设为 `0` |

## 7. 阿里云 DashScope 可选配置

阿里云也提供本项目所需的部分模型能力，但三类能力的接入方式不同，不能只替换一个 URL 就认为全部兼容。

### 图片与视频帧描述：可直接配置

当前代码已支持 `DASHSCOPE_API_KEY`，设置后优先于 `GLM_API_KEY`，两个密钥二选一：

```dotenv
OPENAI_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_API_KEY=your-dashscope-api-key
VISION_MODEL=qwen3-vl-plus
VS_ANALYZE_MODEL=qwen3-vl-plus
```

阿里云的 OpenAI 兼容接口支持当前使用的 `image_url` 和 Base64 Data URL。官方示例见[视觉理解文档](https://help.aliyun.com/zh/model-studio/vision)和 [API Key 获取说明](https://help.aliyun.com/zh/model-studio/get-api-key)。

北京地域也提供业务空间专属域名：`https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，把 `{WorkspaceId}` 换成真实业务空间 ID。旧的 `dashscope.aliyuncs.com` 域名仍可正常使用。

### Paraformer 转写：需要专用 provider

阿里云 Paraformer 非实时接口是 `POST /api/v1/services/audio/asr/transcription`，典型模型为 `paraformer-v2`。DashScope 本身是公网云服务，同时音频也必须能被 DashScope 通过公网 HTTP/HTTPS URL 下载：

- `localhost`、`127.0.0.1`、内网地址和本地 `file://` 路径不能用于这个接口。
- **OSS 不是必需的。** 任何能被公网访问的 HTTP/HTTPS 文件托管服务都可以，OSS 只是官方推荐的稳定存储方式。测试可用临时签名 URL，生产环境应使用稳定存储与长期可访问地址。
- 接口通过 `file_urls` 接收音频 URL，不接受当前使用的本地文件 multipart 上传；提交任务后还要轮询状态，再下载 `transcription_url` 对应的 JSON 结果。

因此不能把 `ASR_CLOUD_BASE_URL` 直接改成阿里云地址。接入需要专门实现文件托管、异步轮询和结果下载。若必须直接处理本地文件，官方另有实时 SDK / WebSocket 路线，但那也是另一套调用方式，不是当前 HTTP 上传接口的直接替换。官方说明见[非实时语音识别文档](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful-api)。

### 向量编码：有模型，但不能直接混用

`qwen3-vl-embedding` 支持文本、图片和视频，并可选 768 维，但它使用专用的 `/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding` 接口，不支持 OpenAI 兼容调用。

`qwen3.7-text-embedding` 和 `text-embedding-v4` 可以走 OpenAI 兼容接口，但只覆盖文本，不能替代当前文本、图片与视频帧的统一向量。

即使输出同为 768 维，新模型与 EmbeddingGemma 2 的向量空间也不保证兼容。切换时必须使用同一个模型全量重嵌入，不能把新向量直接写进旧库。官方规格见[向量化文档](https://help.aliyun.com/zh/model-studio/embedding)。

## 8. 密钥安全

- 不把 `.env` 提交到 Git，不把真实密钥写进 README、测试数据或截图。
- 不在公开日志、Issue、PR 讨论或聊天中粘贴完整密钥。
- 怀疑泄露时，先在供应商控制台吊销并重新创建，再更新本地配置。
- 定期检查云端额度和调用记录，避免把测试任务直接跑在正式密钥上。
