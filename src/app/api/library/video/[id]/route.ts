import { getDb } from '@/lib/db'
import { toMediaUrl } from '@/lib/media'
import { fmtMs } from '@/lib/format'

export const runtime = 'nodejs'

/**
 * GET /api/library/video/<assetId>
 *
 * 单个视频的完整内容：逐字稿全句流 + 抽出的帧。给素材详情面板用，
 * 一次拿全，避免前端为逐句和逐帧各发一次请求。
 */

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: 'bad id' }, { status: 400 })
  }

  const db = getDb()
  const asset = db
    .prepare('SELECT id, kind, title, source_path, created_at, meta_json FROM assets WHERE id = ?')
    .get(id) as
    | { id: number; kind: string; title: string; source_path: string | null; created_at: string; meta_json: string | null }
    | undefined

  if (!asset || asset.kind !== 'video') {
    return Response.json({ error: '视频素材不存在' }, { status: 404 })
  }

  const transcript = db
    .prepare('SELECT id, full_text, language, asr_engine FROM transcripts WHERE asset_id = ?')
    .get(id) as { id: number; full_text: string; language: string | null; asr_engine: string | null } | undefined

  const sentences = transcript
    ? (db
        .prepare(
          'SELECT start_ms, end_ms, text FROM transcript_sentences WHERE transcript_id = ? ORDER BY start_ms',
        )
        .all(transcript.id) as Array<{ start_ms: number; end_ms: number; text: string }>)
    : []

  const chunks = transcript
    ? (db
        .prepare(
          `SELECT c.id, c.start_ms, c.end_ms, c.chunk_strategy,
                  (SELECT count(*) FROM sentences s WHERE s.chunk_id = c.id) AS sent_count
           FROM chunks c WHERE c.transcript_id = ? ORDER BY c.start_ms`,
        )
        .all(transcript.id) as Array<{
        id: number
        start_ms: number
        end_ms: number
        chunk_strategy: string
        sent_count: number
      }>)
    : []

  const frames = db
    .prepare(
      'SELECT id, timestamp_ms, thumb_path, caption, scene_index FROM frames WHERE asset_id = ? ORDER BY timestamp_ms',
    )
    .all(id) as Array<{
    id: number
    timestamp_ms: number
    thumb_path: string | null
    caption: string | null
    scene_index: number | null
  }>

  return Response.json({
    asset: {
      ...asset,
      meta: asset.meta_json ? JSON.parse(asset.meta_json) : {},
    },
    videoUrl: toMediaUrl(asset.source_path),
    transcript: transcript
      ? { ...transcript, sentences, chunks }
      : null,
    frames: frames.map((f) => ({ ...f, url: toMediaUrl(f.thumb_path) })),
    fmtSamples: frames.slice(0, 3).map((f) => fmtMs(f.timestamp_ms)),
  })
}
