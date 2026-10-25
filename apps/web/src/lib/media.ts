import path from 'node:path'
import { PATHS } from './paths'

/**
 * 素材文件 → 浏览器可访问 URL。
 *
 * 素材存在 dataDir 下，浏览器不能直接读服务端绝对路径，统一走
 * /api/media/<相对路径> 那层（见 src/app/api/media/[...path]/route.ts）。
 *
 * 这个文件只能被服务端代码引用（要路径校验）。客户端组件要用 URL 的话，
 * 由服务端组件算好后当 prop 传进去，不要在客户端 import 本文件：
 * node:path 进客户端 bundle 会让 Turbopack panic。
 *
 * 返回 null 表示这个路径不在 dataDir 内（比如早期入库的记录指向库外），
 * 调用方应降级为占位块，不要直接把绝对路径塞给 <img>。
 */
export function toMediaUrl(absolutePath: string | null | undefined): string | null {
  if (!absolutePath) return null
  const root = path.resolve(PATHS.dataDir)
  const abs = path.resolve(absolutePath)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  const rel = path.relative(root, abs).split(path.sep).join('/')
  return `/api/media/${rel}`
}

/**
 * 列表用缩略图 URL。卡片只显示一两百像素宽，原图每张 100KB 以上，
 * 一次刷出上百条结果就是十几 MB 白下。缩略图由媒体路由按 源文件+宽度
 * 生成并缓存，首次请求付一次 resize 的代价，之后直接命中。
 *
 * 放大预览仍要原图，别把这里的结果当预览地址用。
 */
export function toThumbUrl(
  absolutePath: string | null | undefined,
  width = 320,
): string | null {
  const url = toMediaUrl(absolutePath)
  return url ? `${url}?w=${width}` : null
}
