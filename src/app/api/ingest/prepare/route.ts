import { NextResponse } from 'next/server'
import { createJobs } from '@/lib/jobs'
import { normalizeCollectionId } from '@/lib/collections'

export const runtime = 'nodejs'

/**
 * POST /api/ingest/prepare  { batchId, collectionId, items: [{name, size, kind}] }
 *   → { jobIds: number[] }（与 items 同序）
 *
 * **在上传之前先把任务建好。** 上传是整条链路最长的一段（1.91 GB 走局域网
 * 两分钟以上），若等上传完再建行，侧边栏的队列在那几分钟里是空的，用户看到
 * 的仍是「没有任务在跑」，挂起就等于没挂。
 *
 * 建行时状态为 uploading，字节进度由前端通过 POST /api/ingest/progress 上报。
 * 上传完成后视频转交 /api/ingest/video（带 jobId 复用这一行），图片由前端
 * 直接标记完成。
 *
 * 这一步不写库、不起队列，只插行，所以它是即时的。
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const b = body as {
    batchId?: string
    collectionId?: number
    items?: Array<{ name?: string; kind?: string }>
  }
  const items = (b.items ?? []).filter((i) => i && typeof i.name === 'string' && i.name)
  if (items.length === 0) {
    return NextResponse.json({ error: 'items 为空' }, { status: 400 })
  }

  const collectionId = normalizeCollectionId(b.collectionId)
  const batchId = b.batchId?.trim() || `b-${Date.now()}`

  const jobIds = createJobs(
    items.map((i) => ({
      batchId,
      kind: (i.kind === 'image' ? 'image' : 'video') as 'image' | 'video',
      title: i.name as string,
      collectionId,
    })),
  )

  return NextResponse.json({ ok: true, batchId, jobIds })
}
