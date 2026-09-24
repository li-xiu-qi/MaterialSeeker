import { NextResponse } from 'next/server'
import { updateAssetMeta } from '@/lib/collections'
import { parseTags } from '@/lib/tags'

export const runtime = 'nodejs'

/**
 * PATCH /api/library/[id]  body: { title?, caption?, tags? }
 *
 * 改素材的标题、标注与标签。**给客户端小岛用**（列表里的编辑按钮、详情页的内联
 * 编辑、入库结果栏的编辑模态框），因为那几处都要改完不刷新页面。不需要 JS 的
 * 场景走同目录的 form 端点，提交后 redirect 回详情页。
 *
 * tags 三种素材都能改，视频也可以整片打标签（标签在 assets 上，不占帧描述）。
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
  const b = body as { title?: unknown; caption?: unknown; tags?: unknown }
  const title = typeof b.title === 'string' ? b.title : undefined
  const caption = typeof b.caption === 'string' ? b.caption : undefined
  // 标签是数组（模态框）或逗号串（表单两种都吃得下，见 tags.parseTags）。
  // 空数组是合法意图：清空标签，不能当成「没提交」挡掉。
  const tags = Array.isArray(b.tags) || typeof b.tags === 'string' ? (b.tags as string[] | string) : undefined
  if (title === undefined && caption === undefined && tags === undefined) {
    return NextResponse.json({ error: '没有要改的字段' }, { status: 400 })
  }

  // 与 form 端点同一条规则：**空串等于没提交，不等于清空**。小岛只在字段
  // 真的变了时才发它（见 LibraryEditButton），所以到这里空串就是清空意图；
  // 但标题为空串仍要挡掉，标题不能为空。
  const body2: { title?: string; caption?: string; tags?: string[] } = {}
  if (title !== undefined && title.trim()) body2.title = title
  if (caption !== undefined) body2.caption = caption
  if (tags !== undefined) body2.tags = parseTags(tags)
  if (!body2.title && body2.caption === undefined && body2.tags === undefined) {
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
