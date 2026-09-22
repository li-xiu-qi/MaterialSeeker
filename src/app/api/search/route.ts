import { NextResponse } from 'next/server'
import { search } from '@/lib/search'
import { normalizeCollectionId } from '@/lib/collections'

/**
 * GET /api/search?q=&m=all|video|image|text&lib=<素材库 id>
 *
 * lib 是检索作用域。不给就是默认库，不是全库——全库检索在素材多起来之后
 * 只剩变慢一条路，作用域应该是显式选择而不是默认行为。
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const q = url.searchParams.get('q')?.trim()
  const m = url.searchParams.get('m') ?? 'all'
  const lib = url.searchParams.get('lib')

  if (!q) {
    return NextResponse.json({ error: 'missing q' }, { status: 400 })
  }

  try {
    const hits = await search(q, {
      modality: m === 'video' || m === 'image' || m === 'text' ? m : 'all',
      collectionId: normalizeCollectionId(lib),
    })
    return NextResponse.json({ query: q, count: hits.length, hits })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    )
  }
}
