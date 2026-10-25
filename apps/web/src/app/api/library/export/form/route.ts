import { redirectBack } from '@/lib/redirect'

export const runtime = 'nodejs'

/**
 * POST /api/library/export/form  表单编码，字段 video/image/text 可重复。
 *
 * 导出 zip 的表单入口，存在只是为了**把多组同名字段转成 ids 查询串**：
 * 页面上的复选框按类型分成 video / image / text 三个 name，而导出路由读的是
 * ?ids=1,2,3。直接让表单 GET 提交的话，查询串长这样 video=149&image=147，
 * 路由一个都读不到。之前就是漏了这层转换，导出按钮点了下得到一个空包或报错，
 * 而接口本身是对的。
 *
 * 303 跳到 GET /api/library/export?ids=...，浏览器接着发起下载。
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const raw = [...form.getAll('video'), ...form.getAll('image'), ...form.getAll('text')]
  const ids = [...new Set(raw.map(Number))].filter((n) => Number.isInteger(n) && n > 0)

  if (ids.length === 0) {
    return redirectBack('/library', { cerr: '没有选中任何素材' })
  }

  return redirectBack('/api/library/export', { ids: ids.join(',') })
}
