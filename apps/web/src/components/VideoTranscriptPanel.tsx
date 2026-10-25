'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { fmtMs } from '@/lib/format'

/**
 * 逐字稿面板。**客户端组件，但 href 是真实的，JS 失效也能用。**
 *
 * 视频与音频共用这一个组件：两者的内容都是「一条时间轴加一串句子」，交互都是
 * 点句子跳到那一秒。差别只在播放器是 <video> 还是 <audio>，而那正是 kind 这个
 * 参数唯一要做的事。为音频另写一份的结果是「点句跳转」的逻辑存在两处，改一处
 * 忘一处时音频那边静默失效（不报错，只是点了不跳）。
 *
 * 语义布局：视频在左（宽、主位），逐字稿在右（窄、辅位）。
 * 判据不是「列表都放左边」这种惯性，而是三件事：
 *
 * 一，两者必须同屏。点击句子要立刻在视频上看到跳转结果，这是这个面板存在的
 *    全部理由。放下面就会把逐字稿挤到首屏外，点一句得来回滚，等于废掉这个交互。
 * 二，视频是持续观看的主体，占约 60% 宽度；逐字稿是同步阅读的索引，占约 40%。
 *    不能把「辅位」理解成越窄越好：实测 808px / 320px 时句子频繁换行，
 *    两栏比例失衡；3fr / 2fr 让视频保持主位，也给时间戳与中文句子留足空间。
 * 三，YouTube 的逐字稿面板就在视频右侧，点一行跳一次视频，这是同一个交互的
 *    既有范式，没有理由为了一致性自创一套。双栏只在 xl 以上启用；窄屏上下排列，
 *    否则 900px 视口会把视频压到 242px，形式保留了，观看交互却坏掉了。
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
  kind = 'video',
  mediaUrl,
  sentences,
  currentMs,
  collectionId,
  durationMs = null,
}: {
  kind?: 'video' | 'audio'
  mediaUrl: string | null
  sentences: Sentence[]
  currentMs: number | null
  /** 视频流总时长；音频页与旧数据可以不传。 */
  durationMs?: number | null
  /** 检索要沿用当前素材库的作用域，不然点「检索」会跳到别的库 */
  collectionId: number
}) {
  // HTMLVideoElement 与 HTMLAudioElement 在这里用到的字段完全一致（currentTime、
  // play），用一个 ref 类型即可，不必为音频再引一个。
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const scrollRef = useRef<HTMLOListElement | null>(null)
  const [activeMs, setActiveMs] = useState<number | null>(currentMs)
  const [visibleCount, setVisibleCount] = useState(30)
  const visibleSentences = sentences.slice(0, visibleCount)
  const transcriptEndMs = sentences.length > 0 ? sentences[sentences.length - 1].endMs : null

  // 换素材时重置分批加载，避免上一篇的展开状态残留到下一篇。
  useEffect(() => {
    setVisibleCount(30)
  }, [sentences])

  // 地址栏带 t= 说明这次进入就带定位：若目标句在当前批次之外，先扩到那一批，
  // 再滚动过去。否则「全部懒加载」会把深链定位弄丢。
  useEffect(() => {
    if (currentMs === null) return
    const index = sentences.findIndex((s) => s.startMs === currentMs)
    if (index >= 0) setVisibleCount((v) => Math.max(v, index + 1))
    const timer = window.setTimeout(() => {
      const el = document.getElementById(`s-${currentMs}`)
      el?.scrollIntoView({ block: 'center' })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [currentMs, sentences])

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

  const seekSrc =
    mediaUrl && currentMs !== null ? `${mediaUrl}#t=${Math.floor(currentMs / 1000)}` : mediaUrl

  function onTranscriptScroll(e: React.UIEvent<HTMLOListElement>) {
    const el = e.currentTarget
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60 && visibleCount < sentences.length) {
      setVisibleCount((v) => Math.min(v + 30, sentences.length))
    }
  }

  const player =
    kind === 'audio' ? (
      <audio
        ref={videoRef}
        src={seekSrc ?? undefined}
        controls
        preload="metadata"
        className="w-full bg-neutral-950 p-4"
      />
    ) : (
      // 固定 16:9 容器，视频始终完整显示在里面；竖视频用两侧黑边，
      // 而不是把容器本身拉成竖长条。这样任何素材比例都不会把页面撑变形。
      <div className="relative aspect-video w-full overflow-hidden bg-black">
        <video
          ref={videoRef}
          src={seekSrc ?? undefined}
          controls
          preload="metadata"
          className="absolute inset-0 h-full w-full object-contain"
        />
      </div>
    )

  return (
    <div className="grid overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950 xl:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]">
      <div className="min-w-0 bg-black">
        {seekSrc ? (
          player
        ) : (
          <div className="flex h-40 items-center justify-center bg-neutral-950 text-xs text-neutral-400">
            {kind === 'audio' ? '音频文件不在库内，无法播放' : '源文件不在库内，无法播放'}
          </div>
        )}
      </div>

      <aside
        className={`min-w-0 border-t border-neutral-800 xl:border-l xl:border-t-0 ${
          kind === 'video' ? 'xl:relative' : ''
        }`}
      >
        <div
          className={`flex min-w-0 flex-col bg-neutral-950 ${
            kind === 'video' ? 'xl:absolute xl:inset-0' : ''
          }`}
        >
          <div className="flex flex-none items-start justify-between gap-3 border-b border-neutral-800 px-4 py-3">
            <div>
              <h2 className="text-sm font-medium text-neutral-200">逐字稿</h2>
              <p className="mt-1 text-xs text-neutral-400">
                {transcriptEndMs !== null ? `覆盖至 ${fmtMs(transcriptEndMs)} · ` : ''}
                点句子跳转
              </p>
            </div>
            <span className="flex-none text-xs tabular-nums text-neutral-400">
              {sentences.length} 句{durationMs !== null ? ` · ${fmtMs(durationMs)}` : ''}
            </span>
          </div>

          {/*
            默认显示前 30 句，接近底部再追加。桌面列表填满播放器留下的高度，
            窄屏限制列表高度，两种布局都不再由内容或视口把面板撑长。
          */}
          <ol
            ref={scrollRef}
            onScroll={onTranscriptScroll}
            className={`min-h-0 flex-1 max-h-80 space-y-1 overflow-y-auto p-2 ${
              kind === 'video' ? 'xl:max-h-none' : ''
            }`}
          >
            {visibleSentences.map((s, i) => {
              const active = activeMs === s.startMs
              return (
                <li key={`${s.startMs}-${i}`}>
                  <div
                    className={`group flex items-baseline gap-2 rounded-md px-2 py-1.5 transition ${
                      active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-900'
                    }`}
                  >
                    <a
                      id={`s-${s.startMs}`}
                      href={`?t=${Math.floor(s.startMs / 1000)}`}
                      onClick={(e) => seek(s.startMs, e)}
                      aria-current={active ? 'true' : undefined}
                      title={`跳转到 ${fmtMs(s.startMs)}`}
                      className="flex min-w-0 flex-1 items-baseline gap-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70"
                    >
                      <span
                        className={`w-12 flex-none whitespace-nowrap text-right text-xs tabular-nums ${
                          active ? 'text-amber-300' : 'text-neutral-400'
                        }`}
                      >
                        {fmtMs(s.startMs)}
                      </span>
                      <span className="min-w-0 flex-1 text-sm leading-6">{s.text}</span>
                    </a>
                    <Link
                      href={`/?q=${encodeURIComponent(s.text)}&lib=${collectionId}`}
                      title={`检索这句话：${s.text}`}
                      className="flex-none rounded-sm px-1 text-xs text-neutral-400 opacity-100 outline-none transition hover:text-neutral-200 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-amber-300/70 group-focus-within:opacity-100 xl:opacity-0 xl:group-hover:opacity-100 xl:group-focus-within:opacity-100 xl:focus-visible:opacity-100"
                    >
                      检索
                    </Link>
                  </div>
                </li>
              )
            })}
          </ol>
          <p className="flex-none border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-400">
            已显示 {visibleSentences.length} / {sentences.length} 句
            {visibleCount < sentences.length ? '，向下滚动继续加载' : '，已全部加载'}
          </p>
        </div>
      </aside>
    </div>
  )
}

