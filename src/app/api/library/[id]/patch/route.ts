import { NextResponse } from 'next/server'
import { updateAssetMeta } from '@/lib/collections'

export const runtime = 'nodejs'

/**
 * PATCH /api/library/[id]  body: { title?, caption? }
 *
 * 改素材的标题与标注。**给客户端小岛用**（列表里的编辑按钮、详情页的内联编辑），
 * 因为那两处都要改完不刷新页面。不需要 JS 的场景走同目录的 form 端点，
 * 提交后 redirect 回详情页。
 *
 * 两个端点共用 updateAssetMeta，校验与重编码只有一处。分成两处写的结果是
 * 某一边忘了重编码，而忘了重编码不报错，只表现为「改了描述却搜不到」。
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const num = Number(id)
  if (!Number.isInteger(num) || num <= 0) {
    return NextResponse.json({ error: 'id 不合法' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  const b = body as { title?: unknown; caption?: unknown }
  const title = typeof b.title === 'string' ? b.title : undefined
  const caption = typeof b.caption === 'string' ? b.caption : undefined
  if (title === undefined && caption === undefined) {
    return NextResponse.json({ error: '没有要改的字段' }, { status: 400 })
  }

  // 与 form 端点同一条规则：**空串等于没提交，不等于清空**。小岛只在字段
  // 真的变了时才发它（见 LibraryEditButton），所以到这里空串就是清空意图；
  // 但标题为空串仍要挡掉，标题不能为空。
  const body2: { title?: string; caption?: string } = {}
  if (title !== undefined && title.trim()) body2.title = title
  if (caption !== undefined) body2.caption = caption
  if (!body2.title && body2.caption === undefined) {
    return NextResponse.json({ error: '没有要改的字段' }, { status: 400 })
  }

  try {
    const changed = await updateAssetMeta(num, body2)
    return NextResponse.json({ ok: true, ...changed })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 「素材不存在」与「视频没有整片描述」都是用户操作问题，不是服务端故障
    const status = /不存在|没有整片描述|记录缺失|不能为空/.test(msg) ? 400 : 503
    return NextResponse.json({ error: msg }, { status })
  }
}
