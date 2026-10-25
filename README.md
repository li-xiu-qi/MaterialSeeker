<div align="center">
  <img src="docs/assets/brand/logo.svg" alt="MaterialSeeker logo" width="96">
  <h1>MaterialSeeker</h1>
  <p>本地优先的多模态内容检索工作台</p>
  <p><a href="README.md">中文</a> · <a href="README_EN.md">English</a></p>
</div>

## MaterialSeeker 是什么

MaterialSeeker 把视频、图片、音频和文本笔记整理成一个可以统一检索的素材库。它不只记录文件名，还会把视频里的语音、场景画面、关键帧描述和正文变成可搜索的内容。

你不用再从头拖进度条，也不用记住素材放在哪个文件夹。记得一句话、一个概念或一种画面，就能找到对应素材和发生的时间位置。素材与索引保存在自己的机器上，模型和供应商可以按部署条件选择。

## 你能用它做什么

- **课程学习**：搜索「分镜」「渲染」等概念，直接跳到老师讲解的那一句，同时查看对应幻灯片或操作画面。
- **视频素材整理**：按场景抽取关键帧，用画面描述寻找人物、环境、物体和视觉风格。
- **会议与访谈**：从逐字稿里找到原句，回看上下文，而不是只得到一段孤立的文本。
- **图片与资料管理**：用标签、描述和关键词管理素材；标准版还可以用向量语义增强检索。

## 核心能力

| 能力 | 你能得到什么 |
| --- | --- |
| 多模态入库 | 视频、图片、音频和文本放进同一个素材库，按素材库分类管理 |
| 转写与时间定位 | 中文语音转写、句级时间戳、点击句子跳转播放 |
| 场景与画面理解 | 自动检测场景、抽取关键帧，并为画面生成描述 |
| 关键词与语义检索 | SQLite FTS5 关键词检索，标准版加入 EmbeddingGemma 2 向量语义增强 |
| 素材管理 | 标签与描述编辑、多选删除、复制或移动到其他素材库、导出 |
| 灵活部署 | 无 GPU 的轻量档与启用本地向量的标准档，Web 与推理服务通过 HTTP 解耦 |

## 界面预览

**统一搜索：课程画面与逐字稿一起命中**

![搜索「分镜」时，同时命中课程关键帧与逐字稿](docs/assets/demo/search-storyboard.png)

**视频详情：播放、逐字稿与句级时间定位同屏**

![课程视频的分镜画面、逐字稿与句级时间定位](docs/assets/demo/course-detail.png)

**关键帧：场景画面与自动生成的描述**

![Big Buck Bunny 的场景关键帧与画面描述](docs/assets/demo/keyframe-grid.png)

演示素材来自 B 站公开视频，视频文件不纳入仓库。来源与许可说明见 [演示素材来源](docs/demo-media.md)。

## 两种部署档位

| 能力 | 轻量版 `light` | 标准版 `standard` |
| --- | --- | --- |
| 语音转写与句级时间戳 | 支持，云端 ASR | 支持，云端优先、本地 FunASR 兜底 |
| 场景检测、关键帧与画面描述 | 支持 | 支持 |
| 关键词检索 | 支持 | 支持 |
| 向量语义检索 | 不提供 | 提供 |
| 本地模型依赖 | 不安装 EmbeddingGemma 2，不启用 FunASR | EmbeddingGemma 2 必需，FunASR 可选 |
| 推理服务 | 只需 8281 | 8280 + 8281 |

未配置时默认使用 `standard`。轻量期间新增的素材不生成向量，切回标准档后可通过显式回填补齐，不会自动重算整个素材库。

## 快速开始

需要 Node.js、Python 和 FFmpeg。先克隆仓库：

```bash
git clone https://github.com/li-xiu-qi/MaterialSeeker.git
cd MaterialSeeker
```

### 启动 Web 应用

在仓库根目录进入 `apps/web`，安装依赖后选择一种方式启动：

```bash
cd apps/web
npm install

# Linux / macOS
MATERIALSEEKER_PROFILE=light npm run dev
```

Windows PowerShell：

```powershell
$env:MATERIALSEEKER_PROFILE = "light"
$env:MATERIALSEEKER_DATA_DIR = "C:/path/to/materialseeker-data"
npm run dev
```

打开 `http://localhost:9280`。只做文本、图片和页面验收时，可以不启动 Python 服务。

### 视频与音频处理

视频和音频入库还需要 8281 服务。以下命令以 Linux / macOS 为例，Windows 的等价启动方式见 [推理服务说明](services/inference/README.md)。

```bash
# 另开一个终端，在仓库根目录执行
cd services/inference
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-light.txt
cp .env.example .env
# 编辑 .env：设置 light、FFMPEG_BIN、ASR_CLOUD_KEY 与 GLM_API_KEY
bash start.sh
```

需要向量语义检索时，改用 `standard`，并按同一文档配置模型与两个独立 Python 环境。

## 相关项目

- [HearSight](https://github.com/li-xiu-qi/HearSight)：视频音频处理、内容分析与分块索引链路的参考来源。
- [SmartImager](https://github.com/li-xiu-qi/Smartlmager)：图片检索与管理能力的参考来源。
- [推理服务说明](services/inference/README.md)：部署档位、接口、模型与启动配置。

MaterialSeeker 在这些实践基础上独立演进，与上述项目无隶属关系。

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。
