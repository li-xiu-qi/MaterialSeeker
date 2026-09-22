import { fmtMs } from '@/lib/format'

/**
 * 逐字稿命中卡片。核心是定位播放：给出封面、命中区间与命中句。
 *
 * **定位播放跳到视频详情页，不是裸 mp4。** 早先 href 直接指向
 * `/api/media/xxx.mp4#t=18`，点过去是浏览器自带播放器，侧边栏、逐字稿、
 * 关键帧全部丢掉，看完那一句就回不来了。现在跳到 /library/video/<id>?t=18，
 * 落在同一个播放器里，逐字稿还在右手边，那一句还高亮着。
 *
 * **服务端组件。** 原先这里是客户端组件，「定位播放」是个按钮，点了才用
 * state 渲染 <video>。后来发现客户端 JS 一旦不生效，整张卡片的文字都渲染
 * 不出来，代价太大。现在它就是个普通 <a href="...#t=18">，不需要 JS，
 * 浏览器原生处理 #t 定位，media 路由支持 Range，所以进度条照样能拖。
 * 代价是三十条结果会有三十个 <video> 元素同时存在（不预加载就不会同时拉流），
 * 换来的是不依赖 hydration。
 *
 * 本文件不能 import 任何含 node 内置模块的文件（ Turbopack 会 panic）。
 * 视频与封面的 URL 由服务端算好后当 prop 传进来。
 */

export interface SentenceHit {
  start_ms: number
  end_ms: number
  text: string
  /** 跳到这一句的地址，由服务端算好（页面组件持有 assetId 与作用域） */
  seekHref: string
}

interface Props {
  assetTitle: string
  /** 裸 mp4 地址，仅作视频确实存在的判据；跳转一律走 seekHref */
  videoUrl: string | null
  coverUrl: string | null
  chunkText: string
  startMs: number
  endMs: number
  /** 定位播放的落点：视频详情页加秒数，不是裸 mp4 */
  seekHref: string | null
  sentences: SentenceHit[]
}

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
    <div className="mt-2">
      <div className="flex gap-3">
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            className="h-20 w-36 flex-none rounded border border-neutral-800 object-cover"
            loading="lazy"
          />
        ) : (
          <div className="h-20 w-36 flex-none rounded border border-neutral-800 bg-neutral-800" />
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-neutral-200">{assetTitle}</p>
          <p className="mt-1 text-sm text-neutral-300">{chunkText}</p>

          <div className="mt-2 flex items-center gap-2">
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[11px] tabular-nums text-neutral-300">
              {fmtMs(startMs)} - {fmtMs(endMs)}
            </span>
            <span className="text-[11px] text-neutral-600">{sentences.length} 句</span>
            {seekHref && (
              <a
                href={seekHref}
                className="ml-auto rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-500"
              >
                定位播放
              </a>
            )}
          </div>
        </div>
      </div>

      {/* 句级展开：每一句都可单独定位 */}
      {sentences.length > 1 && (
        <ul className="mt-2 space-y-0.5 border-t border-neutral-800 pt-2">
          {sentences.map((s, i) => (
            <li key={i} className="flex gap-2 text-[11px] text-neutral-500">
              <span className="tabular-nums">{fmtMs(s.start_ms)}</span>
              <span className="min-w-0 flex-1">{s.text}</span>
              <a
                href={s.seekHref}
                className="flex-none text-neutral-700 hover:text-neutral-300"
              >
                播放
              </a>
            </li>
          ))}
        </ul>
      )}

      {!videoUrl && (
        <p className="mt-2 text-[11px] text-neutral-600">文本笔记，无对应视频文件</p>
      )}
    </div>
  )
}
