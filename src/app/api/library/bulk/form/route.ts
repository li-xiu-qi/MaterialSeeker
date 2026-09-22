import { getDb } from '@/lib/db'
import { removeAssetRecords } from '@/lib/collections'
import { redirectBack } from '@/lib/redirect'

export const runtime = 'nodejs'

/**
 * POST /api/library/bulk/form  表单编码，字段 video/image/text 可重复，redirect 可选。
 *
 * 批量删除的原生表单入口，**不依赖 JS**。复选框的 name 按类型分开
 * （video / image / text），同一份 form 收集多组勾选，页面上的「删除所选」
 * 按钮用 formaction 指向这里。复选框必须真的包在这个 form 里：用 form 属性
 * 远程关联按钮是不行的，那样复选框不属于任何表单，提交时勾选的 id 全丢
 * （这个错犯过，表现就是按钮点了回跳「没有选中任何素材」）。
 *
 * **只删索引记录，不动磁盘文件**，理由同单条删除：视频可能是用户自己拍的，
 * 误删不可逆。删完按 redirect 回跳，缺失 redirect 时回 /library。
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const raw = [...form.getAll('video'), ...form.getAll('image'), ...form.getAll('text')]
  const clean = [...new Set(raw.map(Number))].filter((n) => Number.isInteger(n) && n > 0)

  const redirect = String(form.get('redirect') ?? '/library')
  const back = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/library'

  if (clean.length === 0) {
    return redirectBack(back, { 'cerr': '没有选中任何素材' })
  }

  const db = getDb()
  const q = `SELECT id, kind FROM assets WHERE id IN (${clean.map(() => '?').join(',')})`
  const rows = db.prepare(q).all(...clean) as Array<{ id: number; kind: string }>

  const tx = db.transaction(() => {
    for (const r of rows) removeAssetRecords(db, r.id, r.kind)
  })
  tx()

return redirectBack(back, { 'bulkRemoved': String(rows.length) })
}
