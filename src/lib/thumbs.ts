import path from 'node:path'
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { PATHS } from './paths'

/**
 * 缩略图预生成。**把 sharp 的开销从浏览路径移到入库路径。**
 *
 * ## 为什么需要它
 *
 * 缩略图原来是按需生成：第一次有人用某个宽度看某张图，那一次请求付 sharp resize
 * 的代价。实测同一张图的差距是**命中 4-8ms，未命中 107ms，差 15 倍**。而「未命中」
 * 在真实使用里不是少数情况：素材库有 145 张图、三种栏数各对应一个宽度（192/640/384），
 * 组合数 435，命中率天然低。一次刷 24 张卡片就是二十来个未命中并发打到 dev server，
 * 单线程逐个 resize，累积延迟就是用户说的「加载有点卡」。
 *
 * 更糟的是这个代价落在最不该落的地方：用户已经等着看内容了，却还要替服务器的
 * 图片处理买单。入库时本来就要读原图做编码，顺手多产出几档缩略图总耗时增加有限；
 * 浏览时则变成纯磁盘读。
 *
 * ## 缓存键与路由那一侧必须一致
 *
 * 键的算法（宽度 + 绝对路径 + mtime + size 的 sha1）在 `api/media/[...path]/route.ts`
 * 里也有一份，**两处必须逐字相同**。改一处不改另一处，预生成的文件路由永远认不出，
 * 于是照旧走 resize，白做。那份重复是刻意的：路由要能独立服务「没预生成过的旧
 * 素材」，而预生成器守在写入侧，两侧靠同一个键对齐。
 */

/** 预生成的档位。取素材库三种栏数实际会请求的宽度，多一档都不生成 */
export const THUMB_WIDTHS = [192, 384, 640] as const

/**
 * 缓存键。**与 media 路由里那一份保持一致。**
 *
 * 带上源文件的 mtime 与 size，是为了素材被同名覆盖后缩略图跟着变：响应头是
 * immutable 长缓存，不换键就会一直供旧图。绝对路径进哈希还能顺带避开路径里的
 * 特殊字符与中文名。
 */
export function thumbKey(abs: string, width: number, mtimeMs: number, size: number): string {
  return createHash('sha1').update(`${width}:${abs}:${mtimeMs}:${size}`).digest('hex')
}

function statOrNull(abs: string) {
  try {
    return statSync(abs)
  } catch {
    return null
  }
}

function thumbsDir(): string {
  const dir = path.join(PATHS.dataDir, 'thumbs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** 某个源文件在某个宽度下的缓存文件路径。文件不存在就表示该档未生成 */
export function thumbFile(abs: string, width: number): string {
  const st = statOrNull(abs)
  if (!st) return ''
  return path.join(thumbsDir(), `${thumbKey(abs, width, st.mtimeMs, st.size)}.jpg`)
}

/**
 * 为一张图预生成全部档位。**任何一档失败都不抛，只跳过。**
 *
 * 抛出去会让整个入库流程失败，而缩略图是优化项不是必要条件：路由那一侧仍有按需
 * 生成的兜底，少一档只是那一档首次访问慢一点。入库失败才是真损失。
 *
 * 返回实际就位的档位数，供调用方记日志。调用方不该因为返回值小于档位数就重试——
 * 重复调用命中已存在的文件后是廉价的无操作。
 */
export async function generateThumbs(abs: string): Promise<number> {
  let made = 0
  const st = statOrNull(abs)
  if (!st) return 0

  const sharp = (await import('sharp')).default
  for (const width of THUMB_WIDTHS) {
    const file = path.join(
      thumbsDir(),
      `${thumbKey(abs, width, st.mtimeMs, st.size)}.jpg`,
    )
    if (existsSync(file)) {
      made++
      continue
    }
    try {
      // 先写临时文件再 rename：并发下另一个进程可能正在写同一个键，直接写目标
      // 文件会让它读到写一半的 jpg
      const tmp = `${file}.${process.pid}.tmp`
      await sharp(abs)
        .resize({ width, withoutEnlargement: true, fit: 'inside' })
        .jpeg({ quality: 78, mozjpeg: true })
        .toFile(tmp)
      renameSync(tmp, file)
      made++
    } catch {
      // 单档失败（sharp 不支持该格式、文件损坏）不影响其他档，也不影响入库
    }
  }
  return made
}
