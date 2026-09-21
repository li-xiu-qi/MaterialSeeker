# VideoSeeker 开发须知

设计文档在平级仓 `VideoSeeker-product-design/`（私有），产品需求、交互设计、已定决策都在那里，动手前先读 `01_PRD/产品需求文档.md`。

## 本地校验

```bash
npm run typecheck   # tsc --noEmit
```

改动 `src/lib/db.ts`（schema）之后必须重启 dev server，schema 是启动时建的，不会热更新。

## 服务拓扑（dgx-spark）

| 端口 | 进程 | 环境 | 职责 |
|---|---|---|---|
| 9280 | next dev | node_modules | 前端 + API |
| 8280 | inference/server.py | xinfer-env | 多模态 embedding 编码 |
| 8281 | inference/video_ingest.py | hearsight-env | 抽音轨、ASR、场景检测、抽帧 |

两个 Python 服务分环境是因为 embedding 用 xinfer-env（torch 2.14），视频处理用 hearsight-env（funasr）。别试图合成一个环境。

启动：

```bash
~/xinfer-env/bin/python inference/server.py --port 8280
~/hearsight-env/bin/python inference/video_ingest.py --port 8281
npx next dev --port 9280
```

## 几条硬约束

向量维度固定 1024，改维度要同时改 `db.ts` 的 `VECTOR_DIM`、`embed.ts` 的校验、推理服务的 `VIDEOSEEKER_DIM` 三处。改一处不改另两处的结果是请求在边界上才炸。

instruction 不能省。索引端与查询端必须分别带 passage 与 query 指令，`embed.ts` 里两个常量集中管理，不要在各处散着写字符串。

FTS5 用 external content 模式，靠触发器与主表同步。

句级时间戳有两张表，别混用：`transcript_sentences` 是全片句子流（时间轴），`sentences` 挂在 chunk 下（检索命中后展开）。检索路径不该为拿时间戳再 join 一次全文表。

图片编码一次前向只能发一类，混在文本批里会退化成逐张往返，所以 `ingestVideo` 里文本与帧分两轮编码。

## 待补

- 帧描述的 VLM 生成路径未接，当前帧只有向量一路，PRD 开放问题 2
- 视频入库是同步 HTTP 请求（上限 1800 秒），长视频应拆异步任务加进度查询
- 中文关键词检索仍失效（默认 tokenizer 不分词），PRD 开放问题 6
- 图搜图与组合查询的输入入口未做

