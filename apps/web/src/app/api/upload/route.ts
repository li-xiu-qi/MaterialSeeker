import { NextResponse } from 'next/server'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { PATHS } from '@/lib/paths'
import { ingestImage } from '@/lib/ingest'
import { normalizeCollectionId } from '@/lib/collections'
import { extOf, isAudioExt, isImageExt, isVideoExt } from '@/lib/mediaKind'

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

/**
 * 扩展名白名单集中到 lib/mediaKind，入库面板、上传路由、素材类型判断共用一份。
 *
 * 早先这里与 UploadPanel 各写一份（共三处），加音频时三处都要改，漏一处的表现
 * 是「前端选得进、服务端 400」，或者反过来「服务端收得下、前端根本不让你选」。
 */
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

  const ext = extOf(file.name)
  const isImage = isImageExt(file.name)
  const isVideo = isVideoExt(file.name)
  const isAudio = isAudioExt(file.name)
  if (!isImage && !isVideo && !isAudio) {
    // 不把扩展名清单回给用户：那是给开发者看的错误码，而用户需要知道的是
    // 「这个文件放不进去」。要排查时扩展名已经写在错误里（只报他传的那个）。
    return NextResponse.json(
      { error: `这个文件格式不支持（${ext || '无扩展名'}），请换常见的图片、视频或音频文件` },
      { status: 400 },
    )
  }

  const dir = isImage ? PATHS.imagesDir : isVideo ? PATHS.videosDir : PATHS.audiosDir
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

  if (isAudio) {
    // **音频与视频一样只落地**：转写是分钟级，不能堵在 HTTP 请求里。落库与
    // 分块由 /api/ingest/audio 交给后台队列，与视频那条路同构。
    // 不在这里调 ingestAudio，理由同下面视频那段注释。
    return NextResponse.json({
      ok: true,
      kind: 'audio',
      path: target,
      indexed: false,
      collectionId,
      next: 'POST /api/ingest/audio  { "audioPath": "' + target + '", "collectionId": ' + collectionId + ' }',
    })
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
