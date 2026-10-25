# MaterialSeeker

多模态内容检索工作台。把视频、图片、音频和文本笔记变成一个可统一检索的库：语音转写支持逐字稿与句级定位，图片和视频帧可生成描述，检索按部署档位使用关键词或向量语义增强。

## 界面预览

**统一搜索：课程画面与逐字稿一起命中**

![搜索「分镜」时，同时命中课程关键帧与逐字稿](docs/assets/demo/search-storyboard.png)

**视频详情：播放、逐字稿与句级时间定位同屏**

![课程视频的分镜画面、逐字稿与句级时间定位](docs/assets/demo/course-detail.png)

**关键帧：场景画面与自动生成的描述**

![Big Buck Bunny 的场景关键帧与画面描述](docs/assets/demo/keyframe-grid.png)

演示素材来自 B 站公开视频，视频文件不纳入仓库。素材来源与许可说明见 [docs/demo-media.md](docs/demo-media.md)。

## 两种部署档位

| 能力 | 轻量版 `light` | 标准版 `standard` |
|---|---|---|
| 语音转写与句级时间戳 | 保留，云端 ASR | 保留，云端优先、本地 FunASR 兜底 |
| 图片与视频帧描述 | 保留，云端视觉模型 | 保留 |
| 逐字稿 FTS 关键词检索 | 保留 | 保留 |
| 标题、标签、图片/帧描述关键词检索 | 保留 | 保留 |
| 向量语义检索 | 关闭 | 开启 |
| 以图搜图、相似图片推荐 | 不提供 | 提供 |
| 本地模型依赖 | 不安装 EmbeddingGemma 2，不启用 FunASR | EmbeddingGemma 2 必需，FunASR 可选 |
| 推理服务 | 只需 8281 | 8280 + 8281 |

轻量版的核心定义是「ASR + 画面描述 + 关键词检索」。标准版在同一套代码上增加向量能力，不是另一条产品分支。未配置时默认 `standard`，保持旧部署行为。

## 轻量版运行

### Windows 本地验证

```powershell
$env:MATERIALSEEKER_PROFILE = "light"
$env:MATERIALSEEKER_DATA_DIR = "C:/path/to/materialseeker-data"
npm run dev
```

只做文本、图片和素材管理时，不需要启动任何 Python 服务，也不需要 8280/8281。视频与音频入库默认仍需要 8281 和云端 ASR 配置；已有 SRT 字幕时可通过 `subtitlePath` 直接复用，无需云端 ASR。

### 无 GPU 的 Linux 服务器

在 `MaterialSeeker-inference` 目录：

```bash
python3 -m venv ~/materialseeker-light-env
~/materialseeker-light-env/bin/pip install -r requirements-light.txt
cp .env.example .env
# 编辑 .env：MATERIALSEEKER_PROFILE=light，并配置 ASR_CLOUD_KEY 与 GLM_API_KEY
bash start.sh
```

轻量启动脚本只启动 8281，并停止旧的 8280。`requirements-light.txt` 不包含 torch、FunASR、sentence-transformers 或模型权重；ffmpeg 仍需单独安装并用 `FFMPEG_BIN` 指定。

业务仓与推理仓使用同一个开关：

```bash
MATERIALSEEKER_PROFILE=light npm run dev
```

## 标准版运行

标准版沿用原来的两个独立 Python 环境：

```bash
# MaterialSeeker-inference
cp .env.example .env
# MATERIALSEEKER_PROFILE=standard，模型与密钥按文件内说明配置
bash start.sh

# MaterialSeeker
MATERIALSEEKER_PROFILE=standard npm run dev
```

- 8280：`embedding_server.py`，EmbeddingGemma 2，768 维统一向量空间。
- 8281：`video_server.py`，视频处理、云端/本地 ASR 与画面描述。
- 业务侧只通过 HTTP 访问推理仓，不直接加载模型。

## 切换边界

- 切到轻量版不会删除数据库里的既有向量，只是不再调用它们。
- 轻量版新入库素材的向量字段为 `NULL`。切回标准版后，既有向量仍可使用；轻量期间新增的素材用 `POST /api/maintenance/backfill-embeddings` 显式回填，不自动执行。
- 轻量版不启用本地 FunASR 兜底。云端 ASR 未配置或不可用时，视频与音频入库会明确失败，不会偷偷下载本地模型。
- `MATERIALSEEKER_FRAME_CAPTION=0` 可单独关闭视频帧描述，不影响 ASR 和关键词检索。

## 数据与配置

- 数据根目录默认 `<repo 上级>/app_datas/`，用 `MATERIALSEEKER_DATA_DIR` 覆盖。
- 推理地址用 `MATERIALSEEKER_INFERENCE_URL` 与 `MATERIALSEEKER_VIDEO_URL` 覆盖。
- 本地校验：`npm run check`。
- 轻量专项测试：`bash scripts/test-light-mode.sh`；中文 FTS 测试：`bash scripts/test-fts-segment.sh`。

## 目录

| 路径 | 内容 |
|---|---|
| `src/app/` | Next.js 页面与 API 路由 |
| `src/lib/db.ts` | SQLite、schema、向量编解码与余弦 |
| `src/lib/embed.ts` | 部署档位与推理服务客户端 |
| `src/lib/search.ts` | 标准向量检索与轻量关键词检索 |
| `src/lib/ingest.ts` | 文本与图片入库 |
| `src/lib/ingestVideo.ts` | 视频转写、抽帧、描述与入库 |
| `src/lib/ingestAudio.ts` | 音频转写与入库 |

## 致谢

视频音频处理与分块索引链路参考了 HearSight；图片检索与管理能力参考了 [SmartImager](https://github.com/li-xiu-qi/Smartlmager)。MaterialSeeker 在这些实践基础上独立演进，与上述项目无隶属关系。

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
