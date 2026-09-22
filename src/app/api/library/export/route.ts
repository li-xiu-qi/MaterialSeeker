import { NextResponse } from 'next/server'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getDb } from '@/lib/db'

export const runtime = 'nodejs'

/**
 * GET /api/library/export?ids=1,2,3
 *
 * 把选中的素材打成 zip 下载。图片与视频都取磁盘上的原文件（帧图除外，
 * 那是检索用的中间产物，导出原图与原视频才有意义）。
 *
 * zip 用系统命令压，不引 node 压缩库：服务器上 zip 与 unzip 是标配，
 * 少一个依赖少一处版本问题。压完即删临时目录，不占盘。
 *
 * 失败时返回 JSON 而不是半个 zip：下载到一半坏包比明确报错更难处理。
 */

const ZIP_TIMEOUT_MS = 120_000

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('ids') ?? ''
  const ids = [...new Set(raw.split(',').map(Number))].filter(
    (n) => Number.isInteger(n) && n > 0,
  )
  if (ids.length === 0) {
    return NextResponse.json({ error: '需要 ids 参数' }, { status: 400 })
  }

  const db = getDb()
  // 图片取库内副本（images.file_path），不是 assets.source_path。后者记的是
  // 来源，外部路径入库后文件被复制进库，source_path 常常已经不存在，照它打包
  // 会静默少文件（zip 对不存在的文件只警告不中断）。视频的 source_path 就是
  // 库内那份，两者用 COALESCE 统一。
  const rows = db
    .prepare(
      `SELECT a.id, a.kind, a.title,
              CASE WHEN a.kind = 'image'
                   THEN COALESCE(im.file_path, a.source_path)
                   ELSE a.source_path END AS file_path
         FROM assets a LEFT JOIN images im ON im.asset_id = a.id
        WHERE a.id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as Array<{
    id: number
    kind: string
    title: string
    file_path: string | null
  }>

  const files = rows.map((r) => r.file_path).filter((p): p is string => Boolean(p))

  const dir = await mkdtemp(path.join(tmpdir(), 'vs-export-'))

  // 文本素材没有磁盘文件，但勾了它就不能静默丢掉：把内容落成 .txt 一起压。
  // 少了这一步，用户在三种类型里勾了文本，zip 里就是少的，且没有任何提示。
  const notes = db
    .prepare(
      `SELECT a.id, a.title, n.content
         FROM assets a JOIN text_notes n ON n.asset_id = a.id
        WHERE a.id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as Array<{ id: number; title: string; content: string }>

  const used = new Set<string>()
  for (const n of notes) {
    const safe = (n.title || `note-${n.id}`).replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]/g, '_')
    let name = `${safe}.txt`
    let k = 1
    while (used.has(name)) {
      name = `${safe}_${k}.txt`
      k += 1
    }
    used.add(name)
    await writeFile(path.join(dir, name), n.content, 'utf8')
    files.push(path.join(dir, name))
  }

  if (files.length === 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    return NextResponse.json({ error: '选中的素材没有可导出的文件' }, { status: 400 })
  }
  const zipPath = path.join(dir, 'videoseeker-export.zip')

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'zip',
        ['-q', '-j', zipPath, ...files],
        { timeout: ZIP_TIMEOUT_MS },
        (err) => (err ? reject(err) : resolve()),
      )
    })
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: `打包失败：${msg}（服务器上需要 zip 命令）` },
      { status: 503 },
    )
  }

  const { readFile } = await import('node:fs/promises')
  const buf = await readFile(zipPath)
  await rm(dir, { recursive: true, force: true }).catch(() => {})

  const stamp = new Date().toISOString().slice(0, 10)
  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="videoseeker-${stamp}.zip"`,
      'Cache-Control': 'no-store',
    },
  })
}
