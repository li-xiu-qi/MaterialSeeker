import Link from 'next/link'
import { fmtScore, typeLabel, sourceLabel } from '@/lib/format'
import { ChunkResultCard, type SentenceHit } from './ChunkResultCard'

export interface ResultItem {
  key: string
  type: string
  source: string
  score: number
  text: string
  title: string
  meta: string
  mediaUrl: string | null
  fullUrl?: string | null
  coverUrl: string | null
  /** 音频内容命中用的播放地址；图片与视频帧为 undefined */
  audioUrl?: string | null
  /** 音频内容命中「查看详情」的落点；其他类型不需要 */
  detailHref?: string | null
  isVideo: boolean
  chunk: {
    chunkText: string
    startMs: number
    endMs: number
    sentences: SentenceHit[]
    videoUrl: string | null
    seekHref: string | null
  } | null
}

/** 服务端结果流：缩略图与文字在窄屏保留双栏，操作区自行折行。 */
export function ResultList({ items }: { items: ResultItem[] }) {
  if (items.length === 0) {
    return <p className="mt-6 text-sm text-neutral-400">没有命中</p>
  }

  return (
    <ul className="mt-5 space-y-4">
      {items.map((it) => (
        <li key={it.key} className="panel p-4 sm:p-5">
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <span className="rounded-full bg-neutral-800 px-2.5 py-1 text-neutral-200">
              {it.chunk && !it.chunk.videoUrl ? '文本' : typeLabel(it.type)}
            </span>
            <span>{sourceLabel(it.source)}</span>
            {it.source !== 'keyword' && (
              <span className="ml-auto tabular-nums text-neutral-300">{fmtScore(it.score)}</span>
            )}
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
            <div className="mt-3 flex items-start gap-3 sm:gap-4">
              {it.audioUrl ? (
                <div className="min-w-0 flex-1 space-y-3">
                  {/* preload=none：结果页可能一次列出多条音频，不预载避免一次拉起
                      一堆音频请求；用户点播放再加载。 */}
                  <audio controls preload="none" src={it.audioUrl} className="w-full" />
                  {it.detailHref && (
                    <Link
                      href={it.detailHref}
                      className="btn-secondary inline-flex px-3 py-1 text-xs"
                      title="查看音频详情与逐字稿"
                    >
                      查看音频详情
                    </Link>
                  )}
                </div>
              ) : it.mediaUrl ? (
                <a
                  href={(it.fullUrl ?? it.mediaUrl) as string}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-none overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 transition hover:border-neutral-500"
                  title="点击查看原图"
                  aria-label={`查看 ${it.title} 原图`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={it.mediaUrl}
                    alt={it.text || `${it.title} 的画面预览`}
                    loading="lazy"
                    className={
                      it.type === 'frame'
                        ? 'h-24 w-28 object-cover sm:h-32 sm:w-48'
                        : 'h-28 w-28 object-contain sm:h-40 sm:w-56'
                    }
                  />
                </a>
              ) : it.type === 'frame' ? (
                <div className="h-24 w-28 flex-none rounded-lg border border-neutral-800 bg-neutral-950 sm:h-32 sm:w-48" />
              ) : null}

              <div className="min-w-0 flex-1">
                <p className="text-sm leading-6 text-neutral-200">{it.text || '（无描述）'}</p>
                <p className="mt-2 break-words text-xs leading-5 text-neutral-400">{it.meta}</p>
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
