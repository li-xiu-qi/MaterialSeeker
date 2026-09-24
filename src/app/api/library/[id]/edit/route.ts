import { updateAssetMeta } from '@/lib/collections'
import { parseTags } from '@/lib/tags'
import { redirectBack } from '@/lib/redirect'

export const runtime = 'nodejs'

/**
 * POST /api/library/[id]/edit  表单编码，字段 title、caption、tags 与 redirect。
 *
 * 改标题、标注与标签的原生表单入口，**不依赖 JS**：详情页上的编辑区就是普通
 * 表单，提交完 redirect 回详情页。需要不刷新页面的场景走 PATCH /api/library/[id]，
 * 两端点共用 updateAssetMeta，校验与重编码只有一处。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const num = Number(id)
  if (!Number.isInteger(num) || num <= 0) {
    return redirectBack('/library?cerr=id 不合法')
  }

  const form = await req.formData()
  const title = String(form.get('title') ?? '')
  const caption = String(form.get('caption') ?? '')
  const tagsRaw = String(form.get('tags') ?? '')
  const redirect = String(form.get('redirect') ?? '/library')
  const back = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/library'
  const fail = (msg: string) => {
    return redirectBack(back, { 'cerr': msg })
  }

  // 空串等于「这个字段没提交」，不等于「清空」。表单 always 渲染 title 与
  // caption 两个输入框，文本详情页只填标题时 caption 是空串，若照传会被
  // updateAssetMeta 当成「把正文清空」而报「正文不能为空」，用户改个标题
  // 就被挡住。图片同理：只想改标题时会顺手把描述清成空。
  // 真要清空描述是另一种操作，由内联编辑小岛显式发空串（它会比对原值）。
  const body: { title?: string; caption?: string; tags?: string[] } = {}
  if (title.trim()) body.title = title
  if (caption !== '') body.caption = caption
  // 标签按「有没有出现这个字段」判断，不按空串：清空标签是合法操作，而表单
  // 里的标签框天生常是空的。
  if (tagsRaw.trim() || form.has('tags')) body.tags = parseTags(tagsRaw)
  if (!body.title && !body.caption && body.tags === undefined) return fail('没有要改的内容')

  try {
    await updateAssetMeta(num, body)
return redirectBack(back, { 'edited': String(num) })
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}
