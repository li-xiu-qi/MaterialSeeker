import { NextResponse } from 'next/server'
import { createCollection } from '@/lib/collections'

export const runtime = 'nodejs'

/**
 * POST /api/collections/form  application/x-www-form-urlencoded，字段 name 与 next。
 *
 * 新建库的原生表单入口，**不依赖 JS**。客户端那个内联表单走 fetch，JS 不执行时
 * 整条路瘫掉，而新建库是低频操作，没有理由依赖 hydration。
 *
 * next 是建完要回的页面（由 CollectionScope 用 usePathname 渲染进隐藏域；
 * 客户端组件也会被服务端渲染，所以无 JS 时这个值照样正确）。回跳时带上
 * made=<新库 id>，页面据此显示成功反馈，并给出「切到这个库」与「去入库」两个
 * 出口，让用户自己决定下一步，而不是自动把人扔进一个空库。
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const name = String(form.get('name') ?? '')
  const next = String(form.get('next') ?? '/')

  // next 只接受站内相对路径，挡住把它当开放重定向用
  const back = next.startsWith('/') && !next.startsWith('//') ? next : '/'

  try {
    const id = createCollection(name)
    const url = new URL(back, 'http://local')
    url.searchParams.set('made', String(id))
    return NextResponse.redirect(url, 303)
  } catch (e) {
    const url = new URL(back, 'http://local')
    url.searchParams.set('cerr', e instanceof Error ? e.message : String(e))
    return NextResponse.redirect(url, 303)
  }
}
