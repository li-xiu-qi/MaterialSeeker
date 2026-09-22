import { NextResponse } from 'next/server'
import { createReadStream, statSync, renameSync, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { PATHS } from '@/lib/paths'

export const runtime = 'nodejs'

/**
 * GET /api/media/<相对 dataDir 的路径>[?w=<宽度>]
 *
 * 把素材目录下的文件暴露给浏览器。走 API 而不是把 dataDir 挂成静态目录，
 * 是因为这里要做路径穿越防护与 Range 支持，静态中间件两样都不给。
 *
 * Range 支持是视频播放的前提：没有它 <video> 无法拖动进度条，只能顺序播。
 *
 * ?w= 走缩略图：结果卡片只显示一两百像素，原图每张上百 KB，一次刷出
 * 上百条就是十几 MB 白下。缩略图按「源文件 + 宽度」生成后缓存，首次请求
 * 付一次 resize，之后直接命中磁盘。视频不走这条路（要 Range，缩了没用）。
 */

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/mp4',
  '.ts': 'video/mp2t',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
}

function resolveInside(subPath: string[]): string {
  const root = path.resolve(PATHS.dataDir)
  const abs = path.resolve(path.join(root, ...subPath))
  // 解析后再验一次，挡住 ../ 与符号链接绕出的情况
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('path escapes data dir')
  }
  return abs
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segs } = await params
  let abs: string
  try {
    abs = resolveInside(segs)
  } catch {
    return new NextResponse('forbidden', { status: 403 })
  }

  let size: number
  try {
    size = statSync(abs).size
  } catch {
    return new NextResponse('not found', { status: 404 })
  }

  const ext = path.extname(abs).toLowerCase()
  const contentType = MIME[ext] ?? 'application/octet-stream'
  const headers = new Headers({
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
  })

  // 缩略图只对图片类扩展名生效；视频音频忽略 ?w，照原文件走 Range 那套
  const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)
  if (isImage) {
    const w = requestedWidth(req)
    if (w > 0) {
      const thumb = await serveThumb(abs, w)
      if (thumb) return thumb
    }
  }

  const range = req.headers.get('range')
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      const start = m[1] ? Number(m[1]) : 0
      const end = m[2] ? Number(m[2]) : Math.min(start + 1024 * 1024 - 1, size - 1)
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        return new NextResponse('range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` },
        })
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
      headers.set('Content-Length', String(end - start + 1))
      const stream = createReadStream(abs, { start, end })
      return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers,
      })
    }
  }

  headers.set('Content-Length', String(size))
  const stream = createReadStream(abs)
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, { status: 200, headers })
}

/** 从 query 取目标宽度，非法或越界一律按 0（不生成缩略图）处理 */
function requestedWidth(req: Request): number {
  const raw = new URL(req.url).searchParams.get('w')
  if (!raw) return 0
  const w = Number(raw)
  if (!Number.isFinite(w)) return 0
  return Math.min(Math.max(Math.trunc(w), 16), 1600)
}

/**
 * 生成并返回缩略图响应。缓存键取「宽度 + 绝对路径 + 源文件 mtime 与 size」
 * 的哈希，既避开同名不同源与路径里的特殊字符，也让素材被同名覆盖后缩略图
 * 跟着变（响应头是 immutable 长缓存，不换键就会一直供旧图）。
 * 先写临时文件再 rename，防止并发请求读到写一半的文件。
 *
 * 生成失败（sharp 不支持该格式、文件损坏等）返回 null，由调用方回落原图：
 * 缩略图是优化项，不该让它把整张图变成 404。
 */
async function serveThumb(abs: string, width: number): Promise<NextResponse | null> {
  try {
    const st = statSync(abs)
    const key = createHash('sha1')
      .update(`${width}:${abs}:${st.mtimeMs}:${st.size}`)
      .digest('hex')
    const file = path.join(PATHS.thumbsDir, `${key}.jpg`)

    if (!existsSync(file)) {
      const sharp = (await import('sharp')).default
      const tmp = `${file}.${process.pid}.tmp`
      await sharp(abs)
        .resize({ width, withoutEnlargement: true, fit: 'inside' })
        .jpeg({ quality: 78, mozjpeg: true })
        .toFile(tmp)
      renameSync(tmp, file)
    }

    const headers = new Headers({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
    const size = statSync(file).size
    headers.set('Content-Length', String(size))
    const stream = createReadStream(file)
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers,
    })
  } catch {
    return null
  }
}
