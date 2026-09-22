import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export const runtime = 'nodejs'

/**
 * 素材删除。只摘索引，不动源文件：视频与图片文件在用户的素材目录里，
 * 库不该替用户决定删文件。真要清文件时用户自己管，这里给出提示。
 *
 * 级联删除靠 SQLite 外键（ON DELETE CASCADE），所以顺序不重要，
 * 但要在事务里做，避免删一半留下孤儿。
 */


export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: raw } = await params
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 })
  }

  const db = getDb()
  const asset = db
    .prepare('SELECT id, kind, title, source_path FROM assets WHERE id = ?')
    .get(id) as { id: number; kind: string; title: string; source_path: string | null } | undefined

  if (!asset) {
    return NextResponse.json({ error: '素材不存在' }, { status: 404 })
  }

  const tx = db.transaction(() => {
    if (asset.kind === 'video') {
      const tids = db
        .prepare('SELECT id FROM transcripts WHERE asset_id = ?')
        .all(id) as Array<{ id: number }>
      for (const t of tids) {
        db.prepare(
          'DELETE FROM sentences WHERE chunk_id IN (SELECT id FROM chunks WHERE transcript_id = ?)',
        ).run(t.id)
        db.prepare('DELETE FROM chunks WHERE transcript_id = ?').run(t.id)
        db.prepare('DELETE FROM transcript_sentences WHERE transcript_id = ?').run(t.id)
      }
      db.prepare('DELETE FROM transcripts WHERE asset_id = ?').run(id)
    }
    if (asset.kind === 'video' || asset.kind === 'image') {
      db.prepare('DELETE FROM frames WHERE asset_id = ?').run(id)
    }
    if (asset.kind === 'image') {
      db.prepare('DELETE FROM images WHERE asset_id = ?').run(id)
    }
    if (asset.kind === 'text') {
      db.prepare('DELETE FROM text_notes WHERE asset_id = ?').run(id)
    }
    db.prepare('DELETE FROM assets WHERE id = ?').run(id)
  })
  tx()

  return NextResponse.json({
    ok: true,
    removed: { id: asset.id, kind: asset.kind, title: asset.title },
    note: '索引已删除，源文件未动',
    sourcePath: asset.source_path,
  })
}
