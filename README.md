# VideoSeeker

多模态内容检索工作台。把视频、图片、文本笔记变成一个可统一检索的库：视频转逐字稿按块检索并支持句级秒级跳转，图片与帧做多模态相似检索，文本做相似加关键词双路检索。

## 能力

- **视频检索**：视频入库转逐字稿，块级向量召回，命中后展开句级毫秒时间戳用于展示与跳转
- **图片检索**：图片带向量与描述文本双重表示，支持以图搜图、以文搜图、图加文组合查询
- **文本检索**：向量相似检索与关键词检索（FTS5）双路并行，加权合并

## 架构

```
浏览器 → Next.js（App Router，前端 + API）
           ├── SQLite：素材元数据、逐字稿、块、句、帧、图片
           │     ├── FTS5 虚拟表  → 关键词检索
           │     └── 向量 BLOB    → KNN（个人库规模走暴力余弦）
           └── Python 推理服务（本地 GPU，独立仓 VideoSeeker-inference）
                 └── 多模态编码器：文本 / 图片 / 视频 / 音频 → 768 维统一向量空间
```

向量维度固定 768（EmbeddingGemma 2 原生维度，MRL 可截 512/256/128，默认全量）。
个人库规模下向量查询走全表扫描加余弦计算，不引入 ANN 扩展。

四个组件都部署在同一台机器（dgx-spark），本机通过浏览器访问。
推理侧代码在独立仓 `../VideoSeeker-inference/`，部署路径 `~/videoseeker-inference`。

## 目录

| 路径 | 内容 |
|---|---|
| `src/app/` | Next.js 页面与 API 路由 |
| `src/lib/db.ts` | SQLite 单例、schema、向量编解码与余弦 |
| `src/lib/chunking.ts` | 三种分块策略：场景对齐 / 固定窗口重叠 / 贪心字符 |
| `src/lib/embed.ts` | 推理服务客户端，instruction 常量集中在此 |
| `src/lib/search.ts` | 四路加权检索合并 |
| `src/lib/ingest.ts` | 文本入库（M1 首条入库路径） |

推理服务已拆为独立仓 `../VideoSeeker-inference/`（embedding :8280 与视频处理 :8281
两个 Python 服务），本仓只保留 HTTP 客户端，经 `VIDEOSEEKER_INFERENCE_URL` 与
`VIDEOSEEKER_VIDEO_URL` 指向它。

## 运行

```bash
# 1. 推理服务（独立仓 ../VideoSeeker-inference，需 GPU 环境，跑在 dgx-spark）
#    bash start.sh 起 embedding(:8280) 与视频处理(:8281) 两个服务，
#    环境准备与配置见该仓 README

# 2. Web 应用
npm install
npm run dev        # 端口 9280
```

推理服务地址默认 `http://127.0.0.1:8280` / `http://127.0.0.1:8281`，
用 `VIDEOSEEKER_INFERENCE_URL` / `VIDEOSEEKER_VIDEO_URL` 覆盖（本机开发时
指向 dgx-spark 的 192.168.1.170）。

数据根目录默认 `<repo 上级>/app_datas/`，可用 `VIDEOSEEKER_DATA_DIR` 覆盖。

## 当前进度

M1 骨架可跑阶段：端到端只打通文本入库一路（`POST /api/ingest`），用来验证编码、写库、检索、展示四步串联。视频入库在 M2，图片与帧在 M3。

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。

## 致谢

能力来源两个已有项目的复用与参考：视频音频侧的 HearSight 与图片侧的 SmartImager，分块与索引链路的实现方式沿用自前者。
