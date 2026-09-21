import { NextResponse } from 'next/server'

/**
 * 入库入口。M1 只打通「文本入库」一条路，用来验证端到端：
 * 编码 → 写库 → 检索。视频与图片入库在 M2 / M3 实现。
 *
 * POST /api/ingest  body: { kind: 'text', title, content }
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const b = body as { kind?: string; title?: string; content?: string }
  if (!b.kind || !b.title) {
    return NextResponse.json({ error: 'need kind and title' }, { status: 400 })
  }

  try {
    if (b.kind === 'text') {
      if (!b.content) {
        return NextResponse.json({ error: 'text ingest needs content' }, { status: 400 })
      }
      const { ingestText } = await import('@/lib/ingest')
      const id = await ingestText(b.title, b.content)
      return NextResponse.json({ ok: true, assetId: id })
    }

    if (b.kind === 'image') {
      const { ingestImage } = await import('@/lib/ingest')
      const path = (body as { path?: string }).path
      if (!path) {
        return NextResponse.json(
          { error: 'image ingest needs path (server-side absolute path)' },
          { status: 400 },
        )
      }
      const caption = (body as { caption?: string }).caption
      const id = await ingestImage(b.title, path, caption)
      return NextResponse.json({ ok: true, assetId: id })
    }

    return NextResponse.json(
      { error: `M1-M3 阶段支持 kind=text 与 kind=image，收到 ${b.kind}` },
      { status: 400 },
    )
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    )
  }
}
