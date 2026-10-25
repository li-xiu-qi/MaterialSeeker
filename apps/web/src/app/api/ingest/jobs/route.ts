import { NextResponse } from 'next/server'
import { getJob, updateJob, listQueue, type JobRow } from '@/lib/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 任务状态的读与写。
 *
 * GET  /api/ingest/jobs?queue=1          侧边栏队列：全部进行中 + 最近几条已结束
 * PATCH /api/ingest/jobs  { id, percent?, stage? }   前端上报上传字节进度
 *
 * ## 为什么侧边栏要单独一个入口
 *
 * 队列是全局信息，不该依赖用户正停在哪个页面。按 batchId 查（旧的那个 GET）
 * 只有入库页自己用得上，刷新页面靠它把进度找回来；侧边栏要知道的是「现在有
 * 没有任务在跑」，那是另一件事，所以分成两个参数走同一条路由。
 *
 * ## 为什么上传进度要能由前端写入
 *
 * 上传是整条链路最长的一段，而服务端在那期间什么都不知道（`req.formData()`
 * 要等请求体读完才返回，中途连文件都还没落盘）。字节进度只存在于前端的
 * XMLHttpRequest 上，所以必须由前端回传，否则侧边栏在上传那几分钟里只能显示
 * 「上传中」而给不出百分比。
 */
export async function GET(req: Request) {
  const queue = new URL(req.url).searchParams.get('queue')
  if (!queue) {
    return NextResponse.json({ error: '需要 queue=1 或指定 batch' }, { status: 400 })
  }
  const jobs = listQueue()
  return NextResponse.json({ ok: true, jobs: jobs.map(publicJob) })
}

/**
 * 前端上报上传进度。只允许改 percent 与 stage，且只对 uploading 状态的行生效：
 * 任务一旦进了队列（queued/running），进度归 ingestRunner 管，前端这时候报上来
 * 的数字是过时的，让它覆盖会把进度条拽回去。
 */
export async function PATCH(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const b = body as { id?: number; percent?: number; finish?: boolean }
  if (!Number.isInteger(b.id)) {
    return NextResponse.json({ error: '需要整数 id' }, { status: 400 })
  }
  const job = getJob(b.id as number)
  if (!job) {
    return NextResponse.json({ error: '任务不存在' }, { status: 404 })
  }
  if (job.status !== 'uploading') {
    // 不是错误：上传完成与任务入队几乎同时发生，前端那一拍常常晚一步。
    // 静默忽略即可，报错只会让调用方多打一行无用日志。
    return NextResponse.json({ ok: true, ignored: true, status: job.status })
  }

  // finish=true 用于图片：图片的上传与编码在同一个请求里完成，不经过视频
  // 队列，所以由前端在这一步把行推到终态。不推进的话，图片那一行会永远停在
  // 「上传中」，侧边栏里看着像卡死。
  if (b.finish) {
    updateJob(job.id, {
      status: 'done',
      stage: '完成',
      percent: 100,
      message: '已入库，可被检索',
      finished: true,
    })
    return NextResponse.json({ ok: true, status: 'done' })
  }

  const percent = Math.max(0, Math.min(100, Math.round(Number(b.percent) || 0)))
  updateJob(job.id, { percent, message: `上传中 ${percent}%` })
  return NextResponse.json({ ok: true, percent })
}

/** 只吐前端要的字段，别把 file_path 这类内部路径暴露出去。 */
function publicJob(j: JobRow) {
  return {
    id: j.id,
    kind: j.kind,
    title: j.title,
    status: j.status,
    stage: j.stage,
    percent: j.percent,
    message: j.message,
    error: j.error,
    // 入库成功后落地的素材 id。**透出来是为了让上传面板那一行能直接编辑**：
    // 标签、标题、描述要在刚入库时改最顺，等用户想起去素材库翻，那一早忘了。
    // 三种模态的 result_json 里都有它（见 ingestRunner 的三个分支）。
    assetId: readAssetId(j),
  }
}

/** 从 result_json 里取 assetId。坏 JSON 与缺字段都给 undefined，不影响其余字段。 */
function readAssetId(j: JobRow): number | undefined {
  if (!j.result_json) return undefined
  try {
    const r = JSON.parse(j.result_json) as { assetId?: unknown }
    return typeof r.assetId === 'number' ? r.assetId : undefined
  } catch {
    return undefined
  }
}
