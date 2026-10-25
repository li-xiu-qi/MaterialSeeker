import { NextResponse } from 'next/server'
import { backfillEmbeddings } from '@/lib/backfill'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 显式回填轻量期间新增素材的向量。只在标准档允许调用；
 * batchSize 可选，默认 16，最大 50，避免把推理服务一次打满。
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { batchSize?: number }
    const stats = await backfillEmbeddings({ batchSize: body.batchSize })
    return NextResponse.json({ ok: true, ...stats })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes('requires MATERIALSEEKER_PROFILE=standard') ? 409 : 500
    return NextResponse.json({ ok: false, error: message }, { status })
  }
}
