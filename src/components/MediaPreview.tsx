'use client'

import { useEffect, useState } from 'react'

/**
 * 右侧抽屉式大图预览。点结果卡片里的图片打开，Esc 或点遮罩关闭。
 *
 * 抽屉而不是弹窗，是为了让用户在「浏览列表」与「细看一张」之间切换时
 * 不丢失列表滚动位置。
 */

export interface PreviewItem {
  url: string
  caption: string | null
  title: string
  meta: string
}

interface Props {
  item: PreviewItem | null
  onClose: () => void
}

export function MediaPreview({ item, onClose }: Props) {
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setLoaded(false)
    if (!item) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, onClose])

  if (!item) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-label="关闭预览"
      />
      <aside className="relative flex h-full w-full max-w-2xl flex-col border-l border-neutral-800 bg-neutral-950">
        <header className="flex items-center gap-3 border-b border-neutral-800 px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-neutral-200">{item.title}</p>
            <p className="mt-0.5 text-[11px] text-neutral-500">{item.meta}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:border-neutral-500"
          >
            关闭
          </button>
        </header>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.url}
            alt={item.caption ?? ''}
            onLoad={() => setLoaded(true)}
            className={`max-h-full max-w-full rounded object-contain transition-opacity ${
              loaded ? 'opacity-100' : 'opacity-0'
            }`}
          />
        </div>

        {item.caption && (
          <footer className="border-t border-neutral-800 px-5 py-3">
            <p className="text-xs leading-5 text-neutral-400">{item.caption}</p>
          </footer>
        )}
      </aside>
    </div>
  )
}
