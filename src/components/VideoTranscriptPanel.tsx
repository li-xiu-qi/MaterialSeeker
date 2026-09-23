'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { fmtMs } from '@/lib/format'

/**
 * 视频 + 逐字稿面板。**客户端组件，但 href 是真实的，JS 失效也能用。**
 *
 * 语义布局：视频在左（宽、主位），逐字稿在右（窄、辅位）。
 * 判据不是「列表都放左边」这种惯性，而是三件事：
 *
 * 一，两者必须同屏。点击句子要立刻在视频上看到跳转结果，这是这个面板存在的
 *    全部理由。放下面就会把逐字稿挤到首屏外，点一句得来回滚，等于废掉这个交互。
 * 二，视频是持续观看的主体，占主位与更宽的栏；逐字稿是被间歇查阅的索引，
 *    占辅位与更窄的栏。16:9 的视频本来就需要宽度，而每行只是「时间戳 + 一句话」，
 *    窄栏不会影響阅读。
 * 三，YouTube 的逐字稿面板就在视频右侧，点一行跳一次视频，这是同一个交互的
 *    既有范式，没有理由为了一致性自创一套。
 *
 * 点击句子跳转用 `?t=<秒>`：服务端据此在 video src 上加 #t=，浏览器原生定位，
 * 完全不依赖 JS。JS 只做增强（原地 seek 而不刷新页面、高亮当前句、自动滚动
 * 到视野内）。渐进增强，两者不会互相打架。
 */

interface Sentence {
  startMs: number
  endMs: number
  text: string
}

export function VideoTranscriptPanel({
  videoUrl,
  sentences,
  currentMs,
  collectionId,
}: {
  videoUrl: string | null
  sentences: Sentence[]
  currentMs: number | null
  /** 检索要沿用当前素材库的作用域，不然点「检索」会跳到别的库 */
  collectionId: number
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [activeMs, setActiveMs] = useState<number | null>(currentMs)

  // 地址栏带 t= 说明这次进入就带定位，滚动到那一句并让它可见
  useEffect(() => {
    if (currentMs === null) return
    const el = document.getElementById(`s-${currentMs}`)
    el?.scrollIntoView({ block: 'center' })
  }, [currentMs])

  /**
   * 拦截点击：改地址栏 + 原地 seek，不刷新页面。
   * 拦截失败（没有 video 元素）就放任默认行为，让浏览器按 href 走服务端渲染，
   * 结果一样能跳，只是多一次刷新。
   */
  function seek(ms: number, e: React.MouseEvent) {
    const v = videoRef.current
    if (!v) return
    e.preventDefault()
    v.currentTime = ms / 1000
    v.play().catch(() => {
      /* 自动播放被浏览器拦下时静默，用户手动点播放即可 */
    })
    setActiveMs(ms)
    window.history.replaceState(null, '', `?t=${Math.floor(ms / 1000)}`)
  }

  const seekSrc = videoUrl && currentMs !== null ? `${videoUrl}#t=${Math.floor(currentMs / 1000)}` : videoUrl

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        {seekSrc ? (
          <video
            ref={videoRef}
            src={seekSrc}
            controls
            preload="metadata"
            className="w-full rounded-md border border-neutral-800 bg-black"
          />
        ) : (
          <div className="flex h-40 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-xs text-neutral-600">
            源文件不在库内，无法播放
          </div>
        )}
      </div>

      <aside className="min-w-0">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-neutral-300">逐字稿</h2>
          <span className="text-[11px] text-neutral-600">{sentences.length} 句</span>
        </div>
        <p className="mt-1 text-[11px] text-neutral-700">点句子跳到对应位置</p>

        {/*
          **不设内部滚动，列表自然增高，滚动统一交给页面。**

          原来这里是 `max-h-[26rem] overflow-y-auto`，理由是「长逐字稿不该把下面的
          关键帧顶出首屏」。实测它制造了一个更严重的问题：这个容器成了 scroll
          chain 的边界。鼠标停在它上面拨滚轮时，滚轮被消费在这个容器里；而逐字稿
          句数不多时（实测主力素材 13 句、2 句）容器根本不高，于是它滚不了、页面
          也不滚，表现就是「拨滚轮页面完全不动」。用户报过这个现象。

          逐字稿的用途是点句子跳转，浏览时由页面统一滚更符合直觉，也不该有两个
          滚动目标抢控制权。真遇到几百句的长视频，页面变长是可接受的代价。
        */}
        <ol className="mt-2 space-y-0.5 rounded-md border border-neutral-800 p-1.5">
          {sentences.map((s, i) => {
            const active = activeMs === s.startMs
            return (
              <li key={`${s.startMs}-${i}`}>
                <a
                  id={`s-${s.startMs}`}
                  href={`?t=${Math.floor(s.startMs / 1000)}`}
                  onClick={(e) => seek(s.startMs, e)}
                  className={`flex items-baseline gap-2 rounded px-1.5 py-1 transition ${
                    active ? 'bg-neutral-100 text-neutral-900' : 'hover:bg-neutral-900'
                  }`}
                >
                  <span
                    className={`flex-none text-[11px] tabular-nums ${
                      active ? 'text-neutral-600' : 'text-neutral-600'
                    }`}
                  >
                    {fmtMs(s.startMs)}
                  </span>
                  <span className="min-w-0 flex-1 text-xs leading-5">{s.text}</span>
                  <Link
                    href={`/?q=${encodeURIComponent(s.text)}&lib=${collectionId}`}
                    onClick={(e) => e.stopPropagation()}
                    className={`flex-none text-[11px] ${
                      active ? 'text-neutral-600' : 'text-neutral-700'
                    } hover:text-neutral-400`}
                  >
                    检索
                  </Link>
                </a>
              </li>
            )
          })}
        </ol>
      </aside>
    </div>
  )
}

