import { NextResponse } from 'next/server'
import { search } from '@/lib/search'

/** GET /api/search?q=&m=all|video|image|text */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const q = url.searchParams.get('q')?.trim()
  const m = url.searchParams.get('m') ?? 'all'

  if (!q) {
    return NextResponse.json({ error: 'missing q' }, { status: 400 })
  }

  try {
    const hits = await search(q, {
      modality: m === 'video' || m === 'image' || m === 'text' ? m : 'all',
    })
    return NextResponse.json({ query: q, count: hits.length, hits })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    )
  }
}
