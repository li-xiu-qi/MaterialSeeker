import { NextResponse } from 'next/server'
import { updateAssetMeta } from '@/lib/collections'
import { parseTags } from '@/lib/tags'

export const runtime = 'nodejs'

/**
 * POST /api/library/bulk-edit  body: { ids, title?, caption?, tags? }
 *
 * 批量改素材的标题、标注与标签。**给两个场景用**：入库结果栏里的批量编辑，
 * 以及素材库多选态的批量编辑。两者都是「选中一批，一次改完」。
 *
 * 复用 updateAssetMeta，所以逐条的重编码、空值校验、报错口径与单条编辑完全
 * 一致。批量只是它的循环，不另写一套规则。
 *
 * **逐条 try，一条失败不影响其他条**，最后汇总成功数与第一条错误。整个批次
 * 一起失败的结果是 30 张图里 1 张的字段不合法就让另外 29 张也保存不了，而人
 * 看到的 29 条明明都对。
 *
 * 视频只接受标题与标签（整片没有描述字段，帧描述是逐帧的），不支持的原因由
 * updateAssetMeta 逐条报出来，汇总里能看到。
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const b = body as { ids?: unknown; title?: unknown; caption?: unknown; tags?: unknown }
  if (!Array.isArray(b.ids) || b.ids.length === 0) {
    return NextResponse.json({ error: '需要 ids 数组' }, { status: 400 })
  }
  const ids = [...new Set(b.ids.map(Number))].filter((n) => Number.isInteger(n) && n > 0)
  if (ids.length === 0) {
    return NextResponse.json({ error: '没有合法 id' }, { status: 400 })
  }

  const title = typeof b.title === 'string' && b.title.trim() ? b.title : undefined
  const caption = typeof b.caption === 'string' ? b.caption : undefined
  const tags =
    Array.isArray(b.tags) || typeof b.tags === 'string' ? parseTags(b.tags as string[] | string) : undefined
  if (title === undefined && caption === undefined && tags === undefined) {
    return NextResponse.json({ error: '没有要改的字段' }, { status: 400 })
  }

  let ok = 0
  let changed = 0
  let firstError = ''
  for (const id of ids) {
    try {
      const r = await updateAssetMeta(id, { title, caption, tags })
      ok += 1
      if (r.title || r.caption || r.tags) changed += 1
    } catch (e) {
      if (!firstError) firstError = e instanceof Error ? e.message : String(e)
    }
  }

  return NextResponse.json({
    ok,
    changed,
    failed: ids.length - ok,
    error: firstError || undefined,
  })
}
