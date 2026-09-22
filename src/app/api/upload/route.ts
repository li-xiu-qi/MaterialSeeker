import { NextResponse } from 'next/server'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { PATHS } from '@/lib/paths'
import { ingestImage } from '@/lib/ingest'
import { normalizeCollectionId } from '@/lib/collections'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * POST /api/upload  multipart/form-data，字段 file。
 *
 * 图片上传即入库（编码一张图是秒级，堵在请求里可接受）。
 * 视频上传只落地，返回 assetId，由 /api/ingest/video 单独驱动处理流程，
 * 因为视频转写加抽帧是分钟级，不能占着 HTTP 连接。
 *
 * collectionId 字段决定归到哪个库，不给就是默认库。
 */

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.ts'])

export async function POST(req: Request) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: '需要 multipart/form-data' }, { status: 400 })
  }

  const collectionId = normalizeCollectionId(form.get('collectionId') as string | null)

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: '缺少 file 字段' }, { status: 400 })
  }

  const ext = path.extname(file.name).toLowerCase()
  const isImage = IMAGE_EXTS.has(ext)
  const isVideo = VIDEO_EXTS.has(ext)
  if (!isImage && !isVideo) {
    return NextResponse.json(
      { error: `不支持的扩展名 ${ext || '(无)'}，图片 ${[...IMAGE_EXTS].join(' ')}，视频 ${[...VIDEO_EXTS].join(' ')}` },
      { status: 400 },
    )
  }

  const dir = isImage ? PATHS.imagesDir : PATHS.videosDir
  await mkdir(dir, { recursive: true })

  const safeName = file.name.replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]/g, '_')
  let target = path.join(dir, safeName)
  let n = 1
  while (existsSync(target)) {
    const stem = safeName.replace(ext, '')
    target = path.join(dir, `${stem}_${n}${ext}`)
    n += 1
  }

  try {
    await writeFile(target, Buffer.from(await file.arrayBuffer()))
  } catch (e) {
    return NextResponse.json(
      { error: `落盘失败: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }

  if (isImage) {
    const caption = (form.get('caption') as string | null)?.trim() || undefined
    try {
      const assetId = await ingestImage(safeName, target, caption, collectionId)
      return NextResponse.json({
        ok: true,
        kind: 'image',
        assetId,
        collectionId,
        path: target,
        indexed: true,
      })
    } catch (e) {
      return NextResponse.json(
        { error: `图片入库失败: ${e instanceof Error ? e.message : String(e)}` },
        { status: 503 },
      )
    }
  }

  // 视频：只落地，等后续处理
  return NextResponse.json({
    ok: true,
    kind: 'video',
    path: target,
    indexed: false,
    collectionId,
    next: 'POST /api/ingest/video  { "videoPath": "' + target + '", "collectionId": ' + collectionId + ' }',
  })
}
