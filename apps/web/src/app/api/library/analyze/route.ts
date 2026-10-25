import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { analyzeImage, applyAnalysis } from '@/lib/analyze'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * POST /api/library/analyze  body: { id }  单张标注
 *
 * 给上传完成那一行旁边的「AI 标注」按钮用。批量走 /analyze/batch，两条路共用
 * analyzeImage 与 applyAnalysis，规则只有一份。
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  const id = (body as { id?: unknown }).id
  if (!Number.isInteger(id) || (id as number) <= 0) {
    return NextResponse.json({ error: 'id 不合法' }, { status: 400 })
  }
  const assetId = id as number

  try {
    const db = getDb()
    const row = db
      .prepare('SELECT kind, source_path FROM assets WHERE id = ?')
      .get(assetId) as { kind: string; source_path: string | null } | undefined
    if (!row) throw new Error('素材不存在')
    // 视频与音频不给标：它们没有「整片一个描述」这个字段，描述是逐帧逐句的，
    // 让视觉模型看一张封面代替整片是在造一段假描述。
    if (row.kind !== 'image') throw new Error('只有图片能标注画面')
    if (!row.source_path) throw new Error('图片记录缺失')

    const a = await analyzeImage(row.source_path)
    const applied = await applyAnalysis(assetId, a)
    return NextResponse.json({ ok: true, analysis: a, applied })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 「只有图片能标注」与「图片记录缺失」是用户操作问题，不是服务端故障，
    // 返回 400 让前端原样显示这句话，而不是显示一句「服务出错」。
    const status = /只有图片|记录缺失|不存在|不合法/.test(msg) ? 400 : 503
    return NextResponse.json({ error: msg }, { status })
  }
}
