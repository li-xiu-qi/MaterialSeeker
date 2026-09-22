import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export const runtime = 'nodejs'

/**
 * GET /api/library  素材库总览。
 *
 * 按类型分三组返回，每条带各自的统计指标：视频是帧数与句数，图片只有
 * 有无说明，文本是字数。删除文件本身不在这里做，源素材由用户自己管，
 * 删除只摘掉索引。
 *
 * 图片行同时给两个路径：source_path 记的是来源（可能来自库外的临时目录），
 * media_path 才是浏览器能渲染的那一份。外部路径入库时文件会被复制进
 * dataDir，那时两个值不同；直接用 source_path 渲染会得到一堆占位块。
 */

export async function GET() {
  const db = getDb()

  const videos = db
    .prepare(
      `SELECT a.id, a.title, a.source_path, a.created_at,
              (SELECT count(*) FROM frames f WHERE f.asset_id = a.id) AS frames,
              (SELECT count(*) FROM chunks c JOIN transcripts t ON t.id = c.transcript_id
                WHERE t.asset_id = a.id) AS chunks,
              (SELECT count(*) FROM transcript_sentences s JOIN transcripts t ON t.id = s.transcript_id
                WHERE t.asset_id = a.id) AS sentences,
              (SELECT f2.thumb_path FROM frames f2 WHERE f2.asset_id = a.id
                ORDER BY f2.timestamp_ms LIMIT 1) AS cover
       FROM assets a WHERE a.kind = 'video' ORDER BY a.id DESC`,
    )
    .all()

  const images = db
    .prepare(
      `SELECT a.id, a.title, a.source_path, a.created_at,
              im.caption,
              COALESCE(im.file_path, a.source_path) AS media_path,
              (im.embedding IS NOT NULL) AS has_vec,
              (im.caption_embedding IS NOT NULL) AS has_caption_vec
       FROM assets a JOIN images im ON im.asset_id = a.id
       WHERE a.kind = 'image' ORDER BY a.id DESC`,
    )
    .all()

  const texts = db
    .prepare(
      `SELECT a.id, a.title, a.created_at,
              length(n.content) AS chars,
              (n.embedding IS NOT NULL) AS has_vec
       FROM assets a JOIN text_notes n ON n.asset_id = a.id
       WHERE a.kind = 'text' ORDER BY a.id DESC`,
    )
    .all()

  return NextResponse.json({
    counts: {
      video: (videos as unknown[]).length,
      image: (images as unknown[]).length,
      text: (texts as unknown[]).length,
    },
    video: videos,
    image: images,
    text: texts,
  })
}
