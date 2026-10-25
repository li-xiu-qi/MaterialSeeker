import { getLibraryCounts } from '@/lib/library'

export const runtime = 'nodejs'

/**
 * GET /api/library/counts  三类素材各有多少。
 *
 * 侧边导航要显示这几个数，用单独的小端点而不是 /api/library：后者返回的是
 * 完整列表（含每条元数据），为了三个数字拉全量不值得。
 *
 * 用 count 查询而不是 getLibraryList().counts：后者虽然也算 count，但那一条路
 * 上还会把全库素材整批取回来。调用方要三个整数，代价不该是几百行元数据加一次
 * 全量 map。
 */

export async function GET() {
  return Response.json(getLibraryCounts())
}
