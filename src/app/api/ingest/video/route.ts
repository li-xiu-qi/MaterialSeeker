import { NextResponse } from 'next/server'
import { ingestVideo } from '@/lib/ingestVideo'
import { normalizeCollectionId } from '@/lib/collections'

export const runtime = 'nodejs'
export const maxDuration = 1800

/**
 * POST /api/ingest/video  { videoPath, title?, strategy?, sceneThreshold?, ... }
 *
 * 分钟级任务。超时设 1800 秒是因为长视频转写加逐帧编码可能跑很久，
 * 但真正的解法是拆成异步任务加进度查询，那部分还没做（见 AGENTS.md）。
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const b = body as { videoPath?: string; title?: string; strategy?: string; collectionId?: number }
  if (!b.videoPath) {
    return NextResponse.json({ error: 'need videoPath（先用 /api/upload 落地）' }, { status: 400 })
  }

  const strategy = b.strategy === 'fixed' || b.strategy === 'greedy' ? b.strategy : 'scene'

  try {
    const result = await ingestVideo({
      videoPath: b.videoPath,
      title: b.title,
      strategy,
      collectionId: normalizeCollectionId(b.collectionId),
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    )
  }
}
