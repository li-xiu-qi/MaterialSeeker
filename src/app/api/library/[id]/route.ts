import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { loadTags } from '@/lib/tags'

export const runtime = 'nodejs'

/**
 * GET /api/library/[id]  body: 无
 *
 * 取一条素材的可编辑字段：标题、标注、标签。**给编辑模态预填用。**
 *
 * 为什么要单独一个读口：上传面板那一行只有本次会话的本地状态，刷新后从服务端
 * 恢复的行没有 caption 与 tags；而视频音频入库后隔一会儿再改是常事。从库里现读
 * 只有一处口径，比把这两个字段顺着任务队列一路带过来可靠。
 *
 * 三类素材的标注落在不同表，这里统一成 caption 一个名字返回，调用方不必分辨：
 * - 图片 → images.caption（画面描述）
 * - 文本 → text_notes.content（正文）
 * - 视频与音频 → 没有整片描述，返回空串。它们的「内容」是逐字稿，不在这一个
 *   字段里，编辑模态据此只显示标题与标签。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'bad id' }, { status: 400 })
  }

  const db = getDb()
  const asset = db
    .prepare('SELECT id, kind, title, tags_json FROM assets WHERE id = ?')
    .get(id) as { id: number; kind: string; title: string; tags_json: string | null } | undefined
  if (!asset) {
    return NextResponse.json({ error: '素材不存在' }, { status: 404 })
  }

  let caption = ''
  if (asset.kind === 'image') {
    const r = db.prepare('SELECT caption FROM images WHERE asset_id = ?').get(id) as
      | { caption: string | null }
      | undefined
    caption = r?.caption ?? ''
  } else if (asset.kind === 'text') {
    const r = db.prepare('SELECT content FROM text_notes WHERE asset_id = ?').get(id) as
      | { content: string }
      | undefined
    caption = r?.content ?? ''
  }

  return NextResponse.json({
    ok: true,
    asset: {
      id: asset.id,
      kind: asset.kind,
      title: asset.title,
      caption,
      tags: loadTags(asset.tags_json),
    },
  })
}

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
