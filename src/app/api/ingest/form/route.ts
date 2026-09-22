import { NextResponse } from 'next/server'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { PATHS } from '@/lib/paths'
import { ingestImage } from '@/lib/ingest'
import { ingestVideo } from '@/lib/ingestVideo'
import { normalizeCollectionId } from '@/lib/collections'

export const runtime = 'nodejs'
export const maxDuration = 1800

/**
 * POST /api/ingest/form  multipart/form-data，字段 file 与 collectionId。
 *
 * **这条路不依赖 JS，是原生表单提交的退路。** 客户端 JS 一旦不执行，原来那个
 * 「点虚线框选文件」的入口整个瘫掉（onClick 调 input.click() 是纯 JS），
 * 上传面板一点反应都没有。原生表单提交没有这个问题：选完文件点提交，
 * 浏览器自己把 multipart 发过来，服务端入库后重定向回本页并带上结果。
 *
 * 图片入库是秒级，直接在请求里做完。视频是分钟级，同样阻塞在这里——
 * 原生表单没有进度条，浏览器只会转圈，这是它相对 JS 版本的代价，
 * 换来的是不依赖 hydration。真需要进度感知时走 /api/upload +
 * /api/ingest/video 那条异步路（UploadPanel 仍在用）。
 */

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.ts'])

/** 结果通过 query 带回，页面按参数渲染，同样不需要 JS */
function back(lib: number, params: Record<string, string>) {
  const q = new URLSearchParams({ lib: String(lib), ...params })
  return NextResponse.redirect(new URL(`/ingest?${q.toString()}`, 'http://local'))
}

export async function POST(req: Request) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.redirect(new URL('/ingest?err=需要表单提交', 'http://local'), 303)
  }

  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.redirect(new URL('/ingest?err=没有选择文件', 'http://local'), 303)
  }

  const collectionId = normalizeCollectionId(form.get('collectionId') as string | null)
  const ext = path.extname(file.name).toLowerCase()
  const isImage = IMAGE_EXTS.has(ext)
  const isVideo = VIDEO_EXTS.has(ext)
  if (!isImage && !isVideo) {
    return back(collectionId, { err: `不支持的格式 ${ext || '(无)'}` })
  }

  const dir = isImage ? PATHS.imagesDir : PATHS.videosDir
  await mkdir(dir, { recursive: true })
  const safeName = file.name.replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]/g, '_')
  let target = path.join(dir, safeName)
  let n = 1
  while (existsSync(target)) {
    const dot = safeName.lastIndexOf('.')
    const stem = dot > 0 ? safeName.slice(0, dot) : safeName
    const suffix = dot > 0 ? safeName.slice(dot) : ''
    target = path.join(dir, `${stem}_${n}${suffix}`)
    n += 1
  }

  try {
    await writeFile(target, Buffer.from(await file.arrayBuffer()))
  } catch (e) {
    return back(collectionId, { err: `落盘失败: ${e instanceof Error ? e.message : String(e)}` })
  }

  try {
    if (isImage) {
      const id = await ingestImage(safeName, target, undefined, collectionId)
      return back(collectionId, { ok: 'image', name: safeName, id: String(id) })
    }
    const r = await ingestVideo({ videoPath: target, title: safeName, collectionId })
    return back(collectionId, {
      ok: 'video',
      name: safeName,
      id: String(r.assetId),
      detail: `${r.frameCount} 帧 · ${r.sentenceCount} 句 · ${r.chunkCount} 块`,
    })
  } catch (e) {
    return back(collectionId, { err: e instanceof Error ? e.message : String(e) })
  }
}
