import { getDb } from '@/lib/db'
import { copyAssets, getCollection } from '@/lib/collections'
import { redirectBack } from '@/lib/redirect'

export const runtime = 'nodejs'

/**
 * POST /api/library/copy  表单编码，字段 video/image/text 可重复，to 与 redirect 可选。
 *
 * 把选中的素材复制到另一个库。**主文件真的复制一份**，两份记录各指向自己的文件
 * （用户明确选的真复制，不用共用同一文件：共用在改文件时会两边一起变）。
 * 帧缩略图是派生数据，两份记录共用，见 copyAssets 的说明。
 *
 * 复制是逐行重建：assets 及其全部子表（transcripts、chunks、sentences、
 * transcript_sentences、frames、images、text_notes）都复制，主键重新生成。
 * chunks_fts 由 AFTER INSERT 触发器自动同步，不用手动插。
 *
 * 整个批次放一个事务里：复制到一半失败会留下半个素材，比整体失败更难查。
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const raw = [...form.getAll('video'), ...form.getAll('image'), ...form.getAll('text')]
  const ids = [...new Set(raw.map(Number))].filter((n) => Number.isInteger(n) && n > 0)
  const redirect = String(form.get('redirect') ?? '/library')
  const back = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/library'
  const fail = (msg: string) => {
    return redirectBack(back, { 'cerr': msg })
  }

  if (ids.length === 0) return fail('没有选中任何素材')

  // 目标必须是具体库：0 是「全部库」的哨兵值，复制到「全部」没有意义
  const to = Number(form.get('to'))
  if (!Number.isInteger(to) || to <= 0) return fail('请先选择目标素材库')
  if (!getCollection(to)) return fail('目标素材库不存在')

  const copied = copyAssets(getDb(), ids, to)

  if (copied === 0) return fail('没有素材被复制，选中的素材可能已不存在')

return redirectBack(back, { 'copied': String(copied) })
}
