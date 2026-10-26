import { fmtMs } from '@/lib/format'

export interface SentenceHit {
  start_ms: number
  end_ms: number
  text: string
  seekHref: string
}

interface Props {
  assetTitle: string
  videoUrl: string | null
  coverUrl: string | null
  chunkText: string
  startMs: number
  endMs: number
  seekHref: string | null
  sentences: SentenceHit[]
}

/** 逐字稿命中卡片：时间码是主识别信息，句级链接直接落到详情页。 */
export function ChunkResultCard({
  assetTitle,
  videoUrl,
  coverUrl,
  chunkText,
  startMs,
  endMs,
  seekHref,
  sentences,
}: Props) {
  return (
    <div className="mt-3">
      <div className="flex items-start gap-3 sm:gap-4">
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            className="h-20 w-28 flex-none rounded-lg border border-neutral-800 object-cover sm:h-24 sm:w-36"
            loading="lazy"
          />
        ) : videoUrl ? (
          <div className="h-20 w-28 flex-none rounded-lg border border-neutral-800 bg-neutral-950 sm:h-24 sm:w-36" />
        ) : null}

        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium text-neutral-100">{assetTitle}</p>
          <p className="mt-1.5 text-sm leading-6 text-neutral-300">{chunkText}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="timecode px-2 py-1">
              {fmtMs(startMs)} – {fmtMs(endMs)}
            </span>
            <span className="text-xs text-neutral-400">{sentences.length} 句</span>
            {seekHref && (
              <a
                href={seekHref}
                title={videoUrl ? '在详情页从这段时间播放' : '查看这段笔记'}
                className="btn-secondary ml-auto px-3 py-1 text-xs"
              >
                {videoUrl ? '定位播放' : '查看笔记'}
              </a>
            )}
          </div>
        </div>
      </div>

      {sentences.length > 1 && (
        <ul className="mt-3 space-y-1 border-t border-neutral-800 pt-3">
          {sentences.map((s, i) => (
            <li
              key={i}
              className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-start gap-2 text-xs leading-5 text-neutral-400 sm:text-sm"
            >
              <span className="timecode px-1 py-0.5 text-center">{fmtMs(s.start_ms)}</span>
              <span className="min-w-0">{s.text}</span>
              <a
                href={s.seekHref}
                title={`从 ${fmtMs(s.start_ms)} 开始播放`}
                className="inline-flex min-h-11 items-center px-1 text-neutral-200 underline decoration-neutral-600 underline-offset-4 hover:text-white"
              >
                播放
              </a>
            </li>
          ))}
        </ul>
      )}

      {!videoUrl && <p className="mt-3 text-xs text-neutral-400">文本笔记，无对应视频文件</p>}
    </div>
  )
}
