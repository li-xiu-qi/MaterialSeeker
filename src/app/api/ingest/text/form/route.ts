import { ingestText } from '@/lib/ingest'
import { normalizeCollectionId } from '@/lib/collections'
import { redirectBack } from '@/lib/redirect'

export const runtime = 'nodejs'

/**
 * POST /api/ingest/text/form  表单编码，字段 title、content 与 collectionId。
 *
 * 文本入库的原生表单入口，**不依赖 JS**。文本没有文件可传，图片视频那条
 * multipart 路用不上，所以单独开一个编码表单端点，跟入库页上其他控件一样
 * 提交完 redirect 回本页带结果。
 *
 * 文本入库本身早在 /api/ingest 就支持（ingestText），只是入库页没有入口，
 * 用户只能靠脚本灌数据。
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const title = String(form.get('title') ?? '').trim()
  const content = String(form.get('content') ?? '').trim()
  const collectionId = normalizeCollectionId(form.get('collectionId') as string | null)

  const back = (params: Record<string, string>) => {
    const q = new URLSearchParams({ lib: String(collectionId), ...params })
    return redirectBack(`/ingest?${q.toString()}`)
  }

  if (!title) return back({ err: '请填写标题' })
  if (!content) return back({ err: '请填写内容' })

  try {
    const id = await ingestText(title, content, collectionId)
    return back({ textOk: '1', textTitle: title, textId: String(id), chars: String(content.length) })
  } catch (e) {
    return back({ err: e instanceof Error ? e.message : String(e) })
  }
}
