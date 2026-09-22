import { NextResponse } from 'next/server'
import { normalizeCollectionId } from '@/lib/collections'

/**
 * 入库入口。
 *
 * POST /api/ingest  body: { kind, title, content?, path?, caption?, collectionId? }
 *
 * collectionId 决定素材归到哪个库，不给就是默认库。库是检索的作用域，
 * 入库时不归库，检索时就只能全表扫。
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const b = body as {
    kind?: string
    title?: string
    content?: string
    path?: string
    caption?: string
    collectionId?: number
  }
  if (!b.kind || !b.title) {
    return NextResponse.json({ error: 'need kind and title' }, { status: 400 })
  }
  const collectionId = normalizeCollectionId(b.collectionId)

  try {
    if (b.kind === 'text') {
      if (!b.content) {
        return NextResponse.json({ error: 'text ingest needs content' }, { status: 400 })
      }
      const { ingestText } = await import('@/lib/ingest')
      const id = await ingestText(b.title, b.content, collectionId)
      return NextResponse.json({ ok: true, assetId: id, collectionId })
    }

    if (b.kind === 'image') {
      const { ingestImage } = await import('@/lib/ingest')
      if (!b.path) {
        return NextResponse.json(
          { error: 'image ingest needs path (server-side absolute path)' },
          { status: 400 },
        )
      }
      const id = await ingestImage(b.title, b.path, b.caption, collectionId)
      return NextResponse.json({ ok: true, assetId: id, collectionId })
    }

    return NextResponse.json(
      { error: `支持 kind=text 与 kind=image，收到 ${b.kind}` },
      { status: 400 },
    )
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    )
  }
}
