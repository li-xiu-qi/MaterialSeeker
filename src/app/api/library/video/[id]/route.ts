import { getVideoDetail } from '@/lib/library'

export const runtime = 'nodejs'

/**
 * GET /api/library/video/<assetId>
 *
 * 单个视频的完整内容：逐字稿全句流、检索块、抽出的帧。一次拿全，
 * 避免前端为逐句、逐帧各发一次请求。
 *
 * 取数实现在 lib/library.ts，素材详情页与这里共用一份。
 */

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: 'bad id' }, { status: 400 })
  }

  const detail = getVideoDetail(id)
  if (!detail) {
    return Response.json({ error: '视频素材不存在' }, { status: 404 })
  }

  return Response.json(detail)
}
