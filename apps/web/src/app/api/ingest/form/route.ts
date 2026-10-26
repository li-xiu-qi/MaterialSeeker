import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { PATHS } from '@/lib/paths'
import { ingestImage } from '@/lib/ingest'
import { redirectBack } from '@/lib/redirect'
import { ingestVideo } from '@/lib/ingestVideo'
import { normalizeCollectionId } from '@/lib/collections'
import { KINDS_BY_EXT } from '@/lib/mediaKind'
import { ingestAudio } from '@/lib/ingestAudio'

export const runtime = 'nodejs'
export const maxDuration = 1800

/**
 * POST /api/ingest/form  multipart/form-data，字段 file 可重复，collectionId 单个。
 *
 * **这条路不依赖 JS，是原生表单提交的退路。** 客户端 JS 一旦不执行，原来那个
 * 「点虚线框选文件」的入口整个瘫掉（onClick 调 input.click() 是纯 JS），上传
 * 面板一点反应都没有。原生表单提交没有这个问题：选完文件点提交，浏览器自己把
 * multipart 发过来，服务端入库后重定向回本页并带上结果。
 *
 * **必须支持多文件。** 一次只收一个的话，用户选十张图要提交十次，每次都是整页
 * 刷新；拖放更是只能拿到第一个文件，剩下的静默丢掉。原实现就是这样，注释里却
 * 写着多文件，属于没对上。
 *
 * 视频是分钟级且阻塞在请求里：原生表单没有进度条，浏览器只会转圈，这是它相对
 * JS 版本的代价，换来的是不依赖 hydration。所以批量里有视频时，页面要先说清
 * 「会等很久」，别让用户以为页面卡死了。
 */

/**
 * 扩展名判断走 lib/mediaKind 的唯一一份映射，本路由不再自己抄一份 Set。
 *
 * 抄一份的代价已经付过：加音频时这里不认 mp3/wav/flac，而面板与 /api/upload
 * 都认，于是无 JS 那条路上用户选个 mp3 会得到一句「不支持的格式」，而开了 JS
 * 的同一个文件能进去。同一条链路两种结果，是最难查的那类不一致。
 */
const { IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS } = KINDS_BY_EXT

/** 结果通过 query 带回，页面按参数渲染，同样不需要 JS */
function back(lib: number, params: Record<string, string>) {
  const q = new URLSearchParams({ lib: String(lib), ...params })
  return redirectBack(`/ingest?${q.toString()}`)
}

/** 汇总参数：多文件时只带计数与少量文件名，避免 query 过长。
 *  failDetail 只带前两条错误的原因，多了截断，用户需要知道哪个没进去。 */
function summary(
  lib: number,
  imgs: number,
  vids: number,
  auds: number,
  failed: number,
  names: string[],
  errs: string[],
) {
  const shown = names.slice(0, 3).join('、')
  const more = names.length > 3 ? ` 等 ${names.length} 个` : ''
  return back(lib, {
    count: String(imgs + vids + auds),
    imgs: String(imgs),
    vids: String(vids),
    auds: String(auds),
    fail: String(failed),
    name: shown + more,
    // URL 长度有限，错误原因只留两条
    failDetail: errs.slice(0, 2).join('；').slice(0, 120),
  })
}

/** 落盘到 <dataDir>/<kind>/，重名自动加序号。返回服务端绝对路径。 */
async function stageFile(file: File, kind: 'image' | 'video' | 'audio'): Promise<string> {
  const dir = kind === 'image' ? PATHS.imagesDir : kind === 'video' ? PATHS.videosDir : PATHS.audiosDir
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
  await writeFile(target, Buffer.from(await file.arrayBuffer()))
  return target
}

export async function POST(req: Request) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return redirectBack('/ingest?err=需要表单提交')
  }

  // getAll 而不是 get：一次收多个。过滤掉空项与同名占位。
  const files = form.getAll('file').filter((f): f is File => f instanceof File && f.size > 0)
  if (files.length === 0) {
    return redirectBack('/ingest?err=没有选择文件')
  }

  const collectionId = normalizeCollectionId(form.get('collectionId') as string | null)
  const subtitlePath = (form.get('subtitlePath') as string | null)?.trim() || undefined
  let imgs = 0
  let vids = 0
  let auds = 0
  let failed = 0
  const names: string[] = []
  const errs: string[] = []

  for (const file of files) {
    const ext = path.extname(file.name).toLowerCase()
    const kind: 'image' | 'video' | 'audio' | null = IMAGE_EXTS.has(ext)
      ? 'image'
      : VIDEO_EXTS.has(ext)
        ? 'video'
        : AUDIO_EXTS.has(ext)
          ? 'audio'
          : null
    if (!kind) {
      failed += 1
      errs.push(`${file.name}: 不支持的格式 ${ext || '(无)'}`)
      continue
    }

    const safeName = file.name.replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]/g, '_')
    let target: string
    try {
      target = await stageFile(file, kind)
    } catch {
      failed += 1
      errs.push(`${file.name}: 落盘失败`)
      continue
    }

    try {
      if (kind === 'image') {
        await ingestImage(safeName, target, undefined, collectionId)
        imgs += 1
      } else if (kind === 'video') {
        await ingestVideo({ videoPath: target, title: safeName, collectionId, subtitlePath })
        vids += 1
      } else {
        await ingestAudio({ audioPath: target, title: safeName, collectionId })
        auds += 1
      }
      names.push(safeName)
    } catch (e) {
      // 落盘成功了但入库失败：文件已留在素材目录，说清这一点，别让用户以为
      // 什么都没发生又找不到文件。
      failed += 1
      errs.push(`${safeName}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 全失败才当错误回；部分成功要如实报数，一句「失败」会把成功的也吞掉
  if (imgs + vids + auds === 0) return back(collectionId, { err: errs[0] || '入库失败' })
  return summary(collectionId, imgs, vids, auds, failed, names, errs)
}
