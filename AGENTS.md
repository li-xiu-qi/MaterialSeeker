# MaterialSeeker 开发须知

跨仓拓扑、运行目标机（dgx-spark）、部署与同步纪律以套件根 `../AGENTS.md` 为权威，本文件只写本仓开发细节。

设计文档在平级仓 `MaterialSeeker-product-design/`（私有），产品需求、交互设计、已定决策都在那里，动手前先读 `01_PRD/产品需求文档.md`。

## 本地校验

```bash
npm run typecheck   # tsc --noEmit
```

改动 `src/lib/db.ts`（schema）之后必须重启 dev server，schema 是启动时建的，不会热更新。

## 服务拓扑（dgx-spark）

推理侧已拆为独立仓 `../MaterialSeeker-inference/`，部署路径 `~/materialseeker-inference`，
用它的 `bash start.sh` 起停两个推理服务。

| 端口 | 进程 | 环境 / 位置 | 职责 |
|---|---|---|---|
| 9280 | next dev | 本仓 node_modules | 前端 + API |
| 8280 | embedding_server.py | eg2-env，推理仓 | EmbeddingGemma 2 全模态 embedding 编码（768 维） |
| 8281 | video_server.py | ~/hearsight-env，推理仓 | 抽音轨、ASR、场景检测、抽帧 |

两个 Python 服务分环境：embedding 用 eg2-env（模型卡硬性要求 st>=6.1 + tf>=5.19 + torch 2.14），视频处理用 hearsight-env（funasr）。别试图合成一个环境。

启动（推理服务部分见推理仓 README 与 start.sh）：

```bash
cd ~/materialseeker-inference && bash start.sh   # 8280 + 8281
cd ~/materialseeker && ./node_modules/.bin/next dev --port 9280
```

重启时三个坑：按进程名批量匹配（模式串里出现 `next`、`python` 这类字样）会把 ssh 自身的命令行一并匹配上，命令自杀返回 255，且端口可能已释放、服务没起；要拿 PID 就从端口反查（`ss -ltnp | grep ':9280' | grep -oP 'pid=\K[0-9]+'），这条命令自身不含进程名，不会自匹配；脱离会话的环境下 npx 解析不到本地 node_modules，会临时下载并跑错目录，改用 node_modules 内的 next 二进制绝对路径；8281 用 `~/hearsight-env`，8280 用 `~/xinfer-env`，别混。

## 视频素材相关的坑

视频素材链路的坑（AV1 转码触发条件、yt-dlp 的 ffmpeg-location 必须指向二进制文件、ffprobe 双流校验、抽帧服务 logging 配置）全部发生在推理侧，实测记录在推理仓 `../MaterialSeeker-inference/AGENTS.md`，本仓不重复。

入库调用方要知道的边界：触发条件不是「B 站来的要转码」而是「试读一帧失败就跑 ffmpeg 转 H.264 副本」，副本交给 detect_scenes 时走 already_checked 分支（推理仓处理）；下载来的素材入库前必须有 ffprobe 双流确认这一步（推理仓的 video_server 已带，调用方传 ffmpeg 环境即可）。

## 几条硬约束

向量维度固定 1024，改维度要同时改 `db.ts` 的 `VECTOR_DIM`、`embed.ts` 的校验、推理仓（`../MaterialSeeker-inference/.env`）的 `MATERIALSEEKER_DIM` 三处。改一处不改另两处的结果是请求在边界上才炸。

instruction 不能省。索引端与查询端必须分别带 passage 与 query 指令，`embed.ts` 里两个常量集中管理，不要在各处散着写字符串。这两个常量与推理仓服务端的缺省值必须一致。

FTS5 用 external content 模式，靠触发器与主表同步。**触发器里调自定义函数 `seg_zh` 做索引侧中文分词**（`src/lib/segment.ts`，查询侧同一把刀）：unicode61 不给中文分词，不切的话中文查询恒零命中。改写入逻辑不要绕开触发器直接插 FTS，external content 没有一致性检查，漏一行索引静默缺数据。

句级时间戳有两张表，别混用：`transcript_sentences` 是全片句子流（时间轴），`sentences` 挂在 chunk 下（检索命中后展开）。检索路径不该为拿时间戳再 join 一次全文表。

图片编码一次前向只能发一类，混在文本批里会退化成逐张往返，所以 `ingestVideo` 里文本与帧分两轮编码。

## 待补

- ~~中文关键词检索仍失效~~（v0.10 已修：索引侧分词，见 AGENTS「FTS5」条与 PRD 第七节 1）
- 帧描述的 VLM 生成路径未接，当前帧只有向量一路，PRD 开放问题 2 遗留的视频帧那半路
- 视频入库是同步 HTTP 请求（上限 1800 秒），长视频应拆异步任务加进度查询
- 图搜图与组合查询的输入入口未做
- captions_fts 表建了但从无写入与查询，图片 caption 的关键词路整条没接（PRD 未列，v0.10 发现）
- 本机 node_modules 半装状态：npmmirror 的 @rolldown/binding packument 畸形触发 npm 11.12.1 的 semver bug，完整 npm install 失败；typescript 与相关 @types 只能手动解压（scripts/restore-manual-pkgs.sh），FTS 测试走 scripts/test-fts-segment.sh（node:test 不经 vitest）

