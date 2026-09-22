import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { removeAssetRecords } from '@/lib/collections'

export const runtime = 'nodejs'

/**
 * POST /api/library/bulk  body: { ids: number[] }
 *
 * 批量删除素材的索引记录。单条删除的批量版，走的是同一个 removeAssetRecords，
 * 不另写一套级联逻辑（两处各写一遍，某边漏删一张子表不会报错，只会留下孤儿行）。
 *
 * **只删记录，不动磁盘文件**，理由同 DELETE /api/library/[id]：视频可能是
 * 用户自己拍的，误删不可逆。
 *
 * 整个批次放在一个事务里：删到一半失败会留下删了一半的状态，比全失败更难查。
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const ids = (body as { ids?: unknown }).ids
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: '需要 ids 数组' }, { status: 400 })
  }
  const clean = [...new Set(ids.map(Number))].filter(
    (n) => Number.isInteger(n) && n > 0,
  )
  if (clean.length === 0) {
    return NextResponse.json({ error: '没有合法 id' }, { status: 400 })
  }

  const db = getDb()
  const rows = db
    .prepare(`SELECT id, kind FROM assets WHERE id IN (${clean.map(() => '?').join(',')})`)
    .all(...clean) as Array<{ id: number; kind: string }>

  if (rows.length === 0) {
    return NextResponse.json({ error: '素材不存在' }, { status: 404 })
  }

  const tx = db.transaction(() => {
    for (const r of rows) removeAssetRecords(db, r.id, r.kind)
  })
  tx()

  return NextResponse.json({
    ok: true,
    removed: rows.length,
    note: '索引已删除，源文件未动',
  })
}
