import { NextResponse } from 'next/server'
import {
  listCollections,
  createCollection,
  renameCollection,
  deleteCollection,
  DEFAULT_COLLECTION_ID,
} from '@/lib/collections'

export const runtime = 'nodejs'

/**
 * 素材库（collection）管理。
 *
 * GET    /api/collections              列表，带各库三类素材的计数
 * POST   /api/collections  { name }     新建
 * PATCH  /api/collections  { id, name } 改名
 * DELETE /api/collections?id=<n>        删除（只允许删空库）
 *
 * 库是检索的作用域，也是入库时的归属。删空库才允许是为了避免素材的
 * collection_id 指向不存在的库：那种素材在按库过滤时会凭空消失，且查不到原因。
 */
export async function GET() {
  return NextResponse.json({ collections: listCollections(), defaultId: DEFAULT_COLLECTION_ID })
}

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  const name = (body as { name?: string }).name
  if (!name || !name.trim()) {
    return NextResponse.json({ error: '需要素材库名称' }, { status: 400 })
  }
  try {
    const id = createCollection(name)
    return NextResponse.json({ ok: true, id })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}

export async function PATCH(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  const b = body as { id?: number; name?: string }
  if (!b.id || !b.name) {
    return NextResponse.json({ error: '需要 id 与 name' }, { status: 400 })
  }
  try {
    renameCollection(b.id, b.name)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: '需要合法 id' }, { status: 400 })
  }
  try {
    deleteCollection(id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}
