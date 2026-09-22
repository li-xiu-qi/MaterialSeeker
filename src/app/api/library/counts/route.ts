import { getLibraryList } from '@/lib/library'

export const runtime = 'nodejs'

/**
 * GET /api/library/counts  三类素材各有多少。
 *
 * 侧边导航要显示这几个数，用单独的小端点而不是 /api/library：后者返回的是
 * 完整列表（含每条元数据），为了三个数字拉全量不值得。
 */

export async function GET() {
  const list = getLibraryList()
  return Response.json(list.counts)
}
