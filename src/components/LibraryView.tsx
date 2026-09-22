'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { fmtMs } from '@/lib/format'

/**
 * 素材库页面。三个分组：视频、图片、文本。
 *
 * 删条目只摘索引，不动源文件（源素材在用户的素材目录里，库不替用户决定
 * 删文件），删除前要确认，删完把源路径告诉用户，方便他自己清理。
 */

type VideoRow = {
  id: number
  title: string
  source_path: string | null
  created_at: string
  frames: number
  chunks: number
  sentences: number
  cover: string | null
}
type ImageRow = {
  id: number
  title: string
  source_path: string | null
  media_path: string | null
  created_at: string
  caption: string | null
  has_vec: number
  has_caption_vec: number
}
type TextRow = {
  id: number
  title: string
  created_at: string
  chars: number
  has_vec: number
}

interface Library {
  counts: { video: number; image: number; text: number }
  video: VideoRow[]
  image: ImageRow[]
  text: TextRow[]
}

const MEDIA_BASE = '/api/media/'

/**
 * 服务端绝对路径 → 浏览器 URL。带 w 时取缩略图（列表只显示一百多像素，
 * 原图每张上百 KB，几百张就是几十 MB 白下）。
 *
 * 只在路径落在 /app_datas/ 下时给 URL，否则返回 null，调用方降级成占位块。
 * 早期入库记录的路径在库外，那种条目本来就渲染不出来。
 */
function toUrl(abs: string | null, thumbWidth?: number): string | null {
  if (!abs) return null
  const marker = '/app_datas/'
  const i = abs.indexOf(marker)
  if (i < 0) return null
  const rel = abs
    .slice(i + marker.length)
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  return MEDIA_BASE + rel + (thumbWidth ? `?w=${thumbWidth}` : '')
}

/** 一次渲染多少条图片，剩下的按「显示更多」逐段加载 */
const PAGE = 24

export function LibraryView() {
  const [data, setData] = useState<Library | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<number | null>(null)
  const [shown, setShown] = useState(PAGE)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/library', { cache: 'no-store' })
      const d = await r.json()
      if (d.error) throw new Error(d.error)
      setData(d)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function remove(id: number, title: string) {
    if (!window.confirm(`删除「${title}」的索引？源文件不会被删除。`)) return
    setRemoving(id)
    setBusy(true)
    try {
      const r = await fetch(`/api/library/${id}`, { method: 'DELETE' })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error ?? '删除失败')
      await load()
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoving(null)
      setBusy(false)
    }
  }

  if (error) {
    return <p className="mt-6 text-sm text-red-400">读取素材库失败：{error}</p>
  }
  if (!data) {
    return <p className="mt-6 text-sm text-neutral-500">加载中…</p>
  }

  return (
    <div className="space-y-10">
      <div className="flex gap-4 text-xs text-neutral-500">
        <span>视频 {data.counts.video}</span>
        <span>图片 {data.counts.image}</span>
        <span>文本 {data.counts.text}</span>
      </div>

      <Section title="视频" empty="还没有视频素材">
        {data.video.map((v) => {
          const cover = toUrl(v.cover, 320)
          return (
            <li key={v.id} className="rounded-md border border-neutral-800 bg-neutral-900/60 p-4">
              <div className="flex gap-3">
                {cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={cover}
                    alt=""
                    className="h-20 w-36 flex-none rounded border border-neutral-800 object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="h-20 w-36 flex-none rounded border border-neutral-800 bg-neutral-800" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-neutral-200">{v.title}</p>
                  <p className="mt-1 text-[11px] text-neutral-600">
                    {v.sentences} 句 · {v.chunks} 块 · {v.frames} 帧
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-neutral-700">{v.source_path}</p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => remove(v.id, v.title)}
                  className="h-fit rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-red-700 hover:text-red-300 disabled:opacity-40"
                >
                  {removing === v.id ? '删除中' : '删除索引'}
                </button>
              </div>
            </li>
          )
        })}
      </Section>

      <Section title="图片" empty="还没有图片素材">
        {data.image.slice(0, shown).map((im) => {
          const url = toUrl(im.media_path, 192)
          return (
            <li key={im.id} className="rounded-md border border-neutral-800 bg-neutral-900/60 p-4">
              <div className="flex gap-3">
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={url}
                    alt={im.caption ?? ''}
                    className="h-24 w-32 flex-none rounded border border-neutral-800 object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="h-24 w-32 flex-none rounded border border-neutral-800 bg-neutral-800" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-neutral-200">{im.title}</p>
                  <p className="mt-1 text-[11px] text-neutral-400">
                    {im.caption ?? '（无说明）'}
                  </p>
                  <p className="mt-1 text-[11px] text-neutral-600">
                    向量 {im.has_vec ? '就绪' : '缺失'}
                    {im.has_caption_vec ? ' · 说明向量就绪' : ''}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => remove(im.id, im.title)}
                  className="h-fit rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-red-700 hover:text-red-300 disabled:opacity-40"
                >
                  {removing === im.id ? '删除中' : '删除索引'}
                </button>
              </div>
            </li>
          )
        })}
        {shown < data.image.length && (
          <li>
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
              className="w-full rounded-md border border-neutral-800 px-3 py-2 text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
            >
              显示更多（还有 {data.image.length - shown} 张）
            </button>
          </li>
        )}
      </Section>

      <Section title="文本" empty="还没有文本笔记">
        {data.text.map((t) => (
          <li key={t.id} className="rounded-md border border-neutral-800 bg-neutral-900/60 p-4">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-neutral-200">{t.title}</p>
                <p className="mt-1 text-[11px] text-neutral-600">
                  {t.chars} 字 · 向量 {t.has_vec ? '就绪' : '缺失'}
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => remove(t.id, t.title)}
                className="h-fit rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-red-700 hover:text-red-300 disabled:opacity-40"
              >
                {removing === t.id ? '删除中' : '删除索引'}
              </button>
            </div>
          </li>
        ))}
      </Section>

      <p className="text-[11px] leading-5 text-neutral-700">
        删除只摘掉检索索引，源文件保留在素材目录，需要清理请自行处理。
        {' '}
        <Link href="/" className="text-neutral-500 underline hover:text-neutral-300">
          返回检索
        </Link>
      </p>
      <span className="hidden">{fmtMs(0)}</span>
    </div>
  )
}

function Section({
  title,
  empty,
  children,
}: {
  title: string
  empty: string
  children: React.ReactNode
}) {
  const has = Array.isArray(children) ? children.length > 0 : Boolean(children)
  return (
    <section>
      <h2 className="text-sm font-medium text-neutral-300">{title}</h2>
      {has ? (
        <ul className="mt-3 space-y-3">{children}</ul>
      ) : (
        <p className="mt-3 text-xs text-neutral-700">{empty}</p>
      )}
    </section>
  )
}
