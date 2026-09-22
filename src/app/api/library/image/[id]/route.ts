import { getImageDetail } from '@/lib/library'

export const runtime = 'nodejs'

/**
 * GET /api/library/image/<assetId>
 *
 * 单张图的完整信息：原图地址、说明、向量是否就绪，以及它在库里的相似邻居
 * （同一个向量空间里的最近邻，用来回答「还有哪些图和它像」）。
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

  const detail = getImageDetail(id)
  if (!detail) {
    return Response.json({ error: '图片素材不存在' }, { status: 404 })
  }

  return Response.json(detail)
}
