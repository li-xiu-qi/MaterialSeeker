import { NextResponse } from 'next/server'
import { deleteCollection } from '@/lib/collections'

export const runtime = 'nodejs'

/**
 * POST /api/collections/delete  表单编码，字段 id、next 与 confirm。
 *
 * 原生表单删除入口，**不依赖 JS**。删库不可逆，交互上的确认是菜单里的一个
 * 复选框：勾选才提交。**这里强制校验那个框**，没勾直接拒绝并回跳报错。
 *
 * 为什么不用 window.confirm：它依赖 JS，而删库不可逆，JS 失效时不能连同确认
 * 一起失效。复选框是原生控件，勾选状态随表单一起提交，服务端拿得到。客户端
 * 勾没勾不算数，绕开校验的唯一办法是手动构造请求，那已经不是误点。
 *
 * 服务的护栏：默认库永远不可删；id 不存在要报错，不能静默成功（否则界面显示
 * 「已删除 X」而 X 从未存在，用户分不清真删了和根本没这个库）。
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const id = Number(form.get('id'))
  const next = String(form.get('next') ?? '/')
  const back = next.startsWith('/') && !next.startsWith('//') ? next : '/'
  const fail = (msg: string) => {
    const url = new URL(back, 'http://local')
    url.searchParams.set('cerr', msg)
    return NextResponse.redirect(url, 303)
  }

  // 确认框没勾：不是「删失败」，是这一步不该发生，报错说清要做什么
  if (form.get('confirm') !== '1') return fail('删除前请先勾选确认')

  try {
    deleteCollection(id)
    const url = new URL(back, 'http://local')
    url.searchParams.set('deleted', String(id))
    return NextResponse.redirect(url, 303)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}
