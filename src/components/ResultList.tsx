import { fmtMs, fmtScore, typeLabel, sourceLabel } from '@/lib/format'
import { ChunkResultCard, type SentenceHit } from './ChunkResultCard'

/**
 * 结果列表。**服务端组件，不再需要 'use client'。**
 *
 * 原先这里是客户端组件，为了管「哪张图正在预览」。后来发现客户端 JS 一旦
 * 没生效，整个结果列表连文字都渲染不出来，代价太大。现在缩略图就是一个
 * 指向原图的 <a target="_blank">，点击在新标签页看大图，完全不依赖 JS。
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
    /** 定位播放落点（视频详情页加秒数） */
    seekHref: string | null
  } | null
}

interface Props {
  items: ResultItem[]
}

export function ResultList({ items }: Props) {
  if (items.length === 0) {
    return <p className="mt-6 text-sm text-neutral-400">没有命中</p>
  }

  return (
    <div>
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
                seekHref={it.chunk.seekHref}
              />
            ) : (
              <div className="mt-2 flex gap-3">
                {it.mediaUrl ? (
                  <a
                    href={(it.fullUrl ?? it.mediaUrl) as string}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-none rounded border border-neutral-800 transition hover:border-neutral-500"
                    title="点击查看原图"
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
                  </a>
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
    </div>
  )
}
