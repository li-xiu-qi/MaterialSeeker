import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { moveAssets, getCollection } from '@/lib/collections'

export const runtime = 'nodejs'

/**
 * POST /api/library/move  表单编码，字段 video/image/text 可重复，to 与 redirect 可选。
 *
 * 把选中的素材移到另一个库。**只改 collection_id，不搬磁盘文件**：文件按类型放在
 * dataDir/<kind>/ 下，不按库分目录，换库不影响任何 file_path 的有效性，所以敢做成
 * 纯 SQL，没有搬一半失败的状态。
 *
 * 复选框的 name 按类型分开，页面上的批量按钮靠 formaction 指向不同端点，复选框
 * 本身包在同一个真实 form 里。**必须有祖先 form**：只用 form 属性远程绑定按钮是
 * 不行的，那样复选框不属于任何表单，提交时勾选的 id 全丢。这个错犯过，表现是批量
 * 按钮点了只回跳「没有选中任何素材」，而接口本身是对的。
 */
export async function POST(req: Request) {
  const form = await req.formData()
  const raw = [...form.getAll('video'), ...form.getAll('image'), ...form.getAll('text')]
  const ids = [...new Set(raw.map(Number))].filter((n) => Number.isInteger(n) && n > 0)
  const redirect = String(form.get('redirect') ?? '/library')
  const back = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/library'
  const fail = (msg: string) => {
    const u = new URL(back, 'http://local')
    u.searchParams.set('cerr', msg)
    return NextResponse.redirect(u, 303)
  }

  if (ids.length === 0) return fail('没有选中任何素材')

  // 目标必须是具体库：0 是「全部库」的哨兵值，拿它当目标等于把素材移出所有库
  const to = Number(form.get('to'))
  if (!Number.isInteger(to) || to <= 0) return fail('请先选择目标素材库')
  if (!getCollection(to)) return fail('目标素材库不存在')

  const moved = moveAssets(getDb(), ids, to)

  // 搬了 0 条要说清原因，不能显示成功：最常见是选中的素材本来就在目标库里
  if (moved === 0) return fail('没有素材被移动，它们可能已经在目标素材库里了')

  const u = new URL(back, 'http://local')
  u.searchParams.set('moved', String(moved))
  return NextResponse.redirect(u, 303)
}
