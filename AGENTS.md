# MaterialSeeker 开发须知

## Monorepo 结构

- `apps/web/`：Next.js 应用，负责页面、API、SQLite 与检索。
- `services/inference/`：Python 推理与媒体处理服务，负责向量编码、转写、场景检测和画面描述。
- `docs/`：公开文档、界面截图与演示素材来源。

Web 应用只通过 HTTP 调用推理服务，不 import 推理代码，也不共享 Python 环境。

## 本地校验

```bash
cd apps/web
npm run check

cd ../../services/inference
python -m unittest discover -s tests -v
bash -n start.sh
```

提交前至少跑与自己改动相关的检查。修改 schema、检索、入库或部署档位时，不要只跑页面截图。

## 部署档位

`MATERIALSEEKER_PROFILE` 由 Web 与推理服务共同使用：

- `light`：保留转写、画面描述、场景检测和关键词检索，不请求 8280。
- `standard`：在轻量能力上增加 8280 与向量语义检索，未配置时默认此档。

轻量期间新增的向量字段为 `NULL`。切回标准档后，通过 `POST /api/maintenance/backfill-embeddings` 显式回填，不自动执行。

## 同步约束

向量维度固定 768。修改时必须同时更新：

- `apps/web/src/lib/db.ts` 的 `VECTOR_DIM`
- `apps/web/src/lib/embed.ts` 的维度校验
- `services/inference/.env` 的 `MATERIALSEEKER_DIM`

索引侧与查询侧的 instruction 也必须保持一致。常量集中在 `apps/web/src/lib/embed.ts`，不要分散硬编码。

FTS5 使用 external content 模式，写入靠触发器同步。索引侧中文分词在 `apps/web/src/lib/segment.ts`，不要绕过触发器直接写 FTS 表。

句级时间戳分属两张表：`transcript_sentences` 保存全片时间轴，`sentences` 挂在检索块下。不要在检索路径重复 join 全片句子表。

## 数据与配置

数据根目录默认是 `<monorepo 上级>/app_datas/`，可用 `MATERIALSEEKER_DATA_DIR` 覆盖。推理地址用 `MATERIALSEEKER_INFERENCE_URL` 与 `MATERIALSEEKER_VIDEO_URL` 覆盖。

局域网访问 dev server 时，可用逗号分隔的 `MATERIALSEEKER_DEV_ORIGINS` 指定允许的来源；默认只包含 `localhost` 与 `127.0.0.1`。真实地址、密钥和个人路径不要写入公开配置或文档。

## 修改 schema 后

修改 `apps/web/src/lib/db.ts` 后必须重启 dev server，schema 在启动时建立，不会热更新。
