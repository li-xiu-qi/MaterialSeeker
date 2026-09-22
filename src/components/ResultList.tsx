'use client'

import { useState } from 'react'

import { fmtMs, fmtScore, typeLabel, sourceLabel } from '@/lib/format'
import { ChunkResultCard, type SentenceHit } from './ChunkResultCard'
import { MediaPreview, type PreviewItem } from './MediaPreview'

/**
 * 结果列表。这一层是客户端组件，唯一的原因是它要管「哪张图正在预览」
 * 这个交互状态。渲染数据全部由服务端组件算好后传进来（含 media URL），
 * 本文件不做任何路径计算。
 *
 * 界面上不出现内部字段名与原始分数：类型与来源走中文名，相似度走百分数。
 */

export interface ResultItem {
  key: string
  type: string
  source: string
  score: number
  /** 词命中后的原始文本 */
  text: string
  title: string
  meta: string
  /** 列表里显示的地址，缩略图；没有则为 null */
  mediaUrl: string | null
  /** 放大预览用的原图地址，缺省时退回 mediaUrl */
  fullUrl?: string | null
  coverUrl: string | null
  isVideo: boolean
  chunk: {
    chunkText: string
    startMs: number
    endMs: number
    sentences: SentenceHit[]
    videoUrl: string | null
  } | null
}

interface Props {
  items: ResultItem[]
}

export function ResultList({ items }: Props) {
  const [preview, setPreview] = useState<PreviewItem | null>(null)

  if (items.length === 0) {
    return <p className="mt-6 text-sm text-neutral-400">没有命中</p>
  }

  return (
    <>
      <p className="mt-6 text-sm text-neutral-400">命中 {items.length} 条</p>

      <ul className="mt-4 space-y-3">
        {items.map((it) => (
          <li
            key={it.key}
            className="rounded-md border border-neutral-800 bg-neutral-900/60 p-4"
          >
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <span className="rounded bg-neutral-800 px-1.5 py-0.5">{typeLabel(it.type)}</span>
              <span>{sourceLabel(it.source)}</span>
              <span className="ml-auto tabular-nums text-neutral-400">{fmtScore(it.score)}</span>
            </div>

            {it.chunk ? (
              <ChunkResultCard
                assetTitle={it.title}
                videoUrl={it.chunk.videoUrl}
                coverUrl={it.coverUrl}
                chunkText={it.chunk.chunkText}
                startMs={it.chunk.startMs}
                endMs={it.chunk.endMs}
                sentences={it.chunk.sentences}
              />
            ) : (
              <div className="mt-2 flex gap-3">
                {it.mediaUrl ? (
                  <button
                    type="button"
                    onClick={() =>
                      setPreview({
                        url: (it.fullUrl ?? it.mediaUrl) as string,
                        caption: it.text || null,
                        title: it.title,
                        meta: it.meta,
                      })
                    }
                    className="flex-none rounded border border-neutral-800 transition hover:border-neutral-500"
                    title="点击放大预览"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={it.mediaUrl}
                      alt={it.text || ''}
                      loading="lazy"
                      className={
                        it.type === 'frame'
                          ? 'h-24 w-40 rounded object-cover'
                          : 'h-32 max-w-[16rem] rounded object-cover'
                      }
                    />
                  </button>
                ) : (
                  <div
                    className={
                      it.type === 'frame'
                        ? 'h-24 w-40 flex-none rounded border border-neutral-800 bg-neutral-800'
                        : 'h-32 w-40 flex-none rounded border border-neutral-800 bg-neutral-800'
                    }
                  />
                )}

                <div className="min-w-0 flex-1">
                  <p className="text-sm text-neutral-300">{it.text || '（无描述）'}</p>
                  <p className="mt-1 text-xs text-neutral-500">{it.meta}</p>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      <MediaPreview item={preview} onClose={() => setPreview(null)} />
    </>
  )
}
