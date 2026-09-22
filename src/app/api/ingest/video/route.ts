import { NextResponse } from 'next/server'
import { promoteUploadedJobs, submitJobs } from '@/lib/ingestRunner'
import { getJob, updateJob } from '@/lib/jobs'
import { normalizeCollectionId } from '@/lib/collections'

export const runtime = 'nodejs'

/**
 * POST /api/ingest/video  { videoPath, title?, batchId?, jobId?, collectionId? }
 *   → { jobId, status: 'queued' }
 *
 * **提交即返回，不再等处理跑完。** 视频转写加抽帧加编码是分钟级，占着 HTTP
 * 连接的做法有两个后果：客户端只能显示一条假的等待提示（之前那条进度条宽度
 * 恒为三分之一，是个动画不是进度），而且浏览器一旦超时或断线就再也拿不到结果。
 *
 * 现在这条路由只负责把任务交进队列。执行由 ingestRunner 在后台逐个跑，进度写进
 * ingest_jobs 表，前端轮询拿。
 *
 * **jobId 给了就复用那一行**，不新建。上传前已由 /api/ingest/prepare 建好
 * status='uploading' 的行，上传完成时转 queued；若另建一行，侧边栏里同一个
 * 文件会先以「上传中」出现一遍、处理时又出现一遍，像是两个任务。
 *
 * batchId 由前端生成并传进来，为的是同一批文件的任务能一起查；缺省时按单个
 * 任务生成，刷新页面后仍能通过 id 单独看。
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const b = body as {
    videoPath?: string
    title?: string
    batchId?: string
    jobId?: number
    collectionId?: number
  }
  if (!b.videoPath) {
    return NextResponse.json({ error: 'need videoPath（先用 /api/upload 落地）' }, { status: 400 })
  }

  // 复用上传阶段建好的那一行
  if (Number.isInteger(b.jobId)) {
    const job = getJob(b.jobId as number)
    // file_path 是上传完成后才知道的（prepare 阶段服务端还没收到文件），所以
    // 在这里回填。不回填的后果是 runOne 拿空路径去调视频处理服务，报 404
    // 「video not found」，而文件其实已经落盘了——这类错很难往路径上想。
    if (job) updateJob(job.id, { filePath: b.videoPath })
    promoteUploadedJobs([b.jobId as number])
    return NextResponse.json({ ok: true, jobId: b.jobId, status: 'queued' })
  }

  const jobId = submitJobs([
    {
      batchId: b.batchId?.trim() || `single-${Date.now()}`,
      kind: 'video',
      title: b.title || b.videoPath.split(/[\\/]/).pop() || b.videoPath,
      filePath: b.videoPath,
      collectionId: normalizeCollectionId(b.collectionId),
    },
  ])[0]

  return NextResponse.json({ ok: true, jobId, batchId: b.batchId ?? null, status: 'queued' })
}
