import { getLibraryList } from '@/lib/library'

export const runtime = 'nodejs'

/**
 * GET /api/library  素材库总览。
 *
 * 注意：/library 页面本身是服务端直出的，不走这个接口。这里保留是为了
 * 外部脚本与将来的客户端筛选用。取数实现两边共用一份。
 */

export async function GET() {
  return Response.json(getLibraryList())
}
