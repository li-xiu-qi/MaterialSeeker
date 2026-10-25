'use client'

import { useEffect } from 'react'

/**
 * 素材预览的模态框。
 *
 * **为什么必须是模态而不是就地展开**：视频展开要一个 16:9 的容器，就地展开会
 * 把它下面的所有内容往下推。待命区推一下还只是「内容跳了一下」，进度列表里
 * 点预览会把这一行撑高、把后面几行顶出视野，而人只是想确认「我选的是这个
 * 文件」，看一眼就要关。模态浮在内容之上，打开与关闭都不改变背后任何元素的
 * 位置，这才是看一眼的语义。
 *
 * 三件事各自负责：
 * - Esc 关闭，点遮罩关闭。模态不给别处留只能靠左上角那个 × 才能出去的路径。
 * - body 加 overflow-hidden，否则背后那页在模态开着的时候还能滚，滚的是
 *   看不见的内容，回到页面时位置已经变了。
 * - 打开时聚焦模态本身，关掉后把焦点还给触发它的那个按钮。键盘用户 Tab 到
 *   按钮、回车打开、看完 Esc 关闭，焦点若丢到页面开头就得从头 Tab 一遍。
 */
export function MediaPreviewModal({
  open,
  onClose,
  kind,
  url,
  name,
  returnFocusTo,
}: {
  open: boolean
  onClose: () => void
  kind: 'image' | 'video' | 'audio' | null
  /** blob: 地址或服务端素材地址 */
  url: string
  name: string
  /** 关闭后焦点回到这个元素，一般是打开模态的那个按钮 */
  returnFocusTo?: HTMLElement | null
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
      returnFocusTo?.focus()
    }
  }, [open, onClose, returnFocusTo])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${name}`}
    >
      {/*
        点击内容不关，只有点外面才关。stopPropagation 不加在按钮上而是加在
        这一层：内容区里没有需要冒泡到遮罩的交互，统一拦更省心。
      */}
      <div
        className="relative max-h-full w-full max-w-4xl overflow-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm text-neutral-300" title={name}>
            {name}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="flex-none rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
          >
            关闭
          </button>
        </div>

        {kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={name} className="mx-auto max-h-[75vh] w-auto rounded" />
        ) : kind === 'video' ? (
          <video
            src={url}
            controls
            autoPlay
            preload="metadata"
            playsInline
            className="mx-auto max-h-[75vh] w-full rounded bg-black"
          />
        ) : (
          <audio src={url} controls className="w-full" />
        )}
      </div>
    </div>
  )
}
