import { getDb } from '@/lib/db'
import { toMediaUrl } from '@/lib/media'
import { fmtMs } from '@/lib/format'

export const runtime = 'nodejs'

/**
 * GET /api/library/image/<assetId>
 *
 * 单张图的完整信息：文件、说明、向量是否就绪，以及它在库里的相似邻居
 * （同一个空间里的最近邻，用来回答「还有哪些图和它像」）。
 */

const DIM = 1024

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: 'bad id' }, { status: 400 })
  }

  const db = getDb()
  const row = db
    .prepare(
      `SELECT a.id, a.title, a.created_at, im.file_path, im.caption, im.embedding, im.caption_embedding
       FROM assets a JOIN images im ON im.asset_id = a.id WHERE a.id = ?`,
    )
    .get(id) as
    | {
        id: number
        title: string
        created_at: string
        file_path: string
        caption: string | null
        embedding: Buffer | null
        caption_embedding: Buffer | null
      }
    | undefined

  if (!row) {
    return Response.json({ error: '图片素材不存在' }, { status: 404 })
  }

  const url = toMediaUrl(row.file_path)
  const vec = row.embedding ? blobToVec(row.embedding) : null

  let neighbours: Array<{ id: number; title: string; url: string | null; score: number }> = []
  if (vec) {
    const others = db
      .prepare(
        `SELECT a.id, a.title, im.file_path, im.embedding
         FROM assets a JOIN images im ON im.asset_id = a.id
         WHERE a.id != ? AND im.embedding IS NOT NULL`,
      )
      .all(row.id) as Array<{ id: number; title: string; file_path: string; embedding: Buffer }>

    neighbours = others
      .map((o) => ({ o, score: cosine(vec, blobToVec(o.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ o, score }) => ({
        id: o.id,
        title: o.title,
        url: toMediaUrl(o.file_path),
        score,
      }))
  }

  return Response.json({
    asset: {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      filePath: row.file_path,
      caption: row.caption,
      hasVector: Boolean(row.embedding),
      hasCaptionVector: Boolean(row.caption_embedding),
    },
    url,
    videoUrl: null,
    fmtSamples: [],
    neighbours,
    dim: DIM,
  })
}

function blobToVec(b: Buffer): Float32Array {
  const out = new Float32Array(b.byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4)
  return out
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
