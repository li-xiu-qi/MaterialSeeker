import { NextResponse } from 'next/server'
import { createCollection, renameCollection } from '@/lib/collections'

export const runtime = 'nodejs'

/**
 * POST /api/collections/form  表单编码，字段 name、next，可选 id。
 *
 * 管理素材库的原生表单入口，**不依赖 JS**。有 id 就是重命名，没有就是新建。
 * 低频操作没有理由依赖 hydration，所以两条路都走原生提交。
 *
 * next 是操作完要回的页面（由页面用 usePathname 渲染进隐藏域）。回跳时按操作
 * 带 made=<新 id> 或 renamed=<id>，失败带 cerr，页面据此给反馈。
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const name = String(form.get('name') ?? '')
  const next = String(form.get('next') ?? '/')
  const rawId = String(form.get('id') ?? '')
  const id = rawId ? Number(rawId) : null

  // next 只接受站内相对路径，挡住把它当开放重定向用
  const back = next.startsWith('/') && !next.startsWith('//') ? next : '/'

  try {
    if (id !== null) {
      if (!Number.isInteger(id) || id <= 0) throw new Error('非法 id')
      renameCollection(id, name)
      const url = new URL(back, 'http://local')
      url.searchParams.set('renamed', String(id))
      return NextResponse.redirect(url, 303)
    }
    const newId = createCollection(name)
    const url = new URL(back, 'http://local')
    url.searchParams.set('made', String(newId))
    return NextResponse.redirect(url, 303)
  } catch (e) {
    const url = new URL(back, 'http://local')
    url.searchParams.set('cerr', e instanceof Error ? e.message : String(e))
    return NextResponse.redirect(url, 303)
  }
}
