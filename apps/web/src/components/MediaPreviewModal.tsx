'use client'

import { ModalShell } from './ModalShell'

/** 素材预览：手机上从底部升起，桌面居中；关闭后焦点回到触发按钮。 */
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
  returnFocusTo?: HTMLElement | null
}) {
  if (!open) return null

  return (
    <ModalShell
      onClose={onClose}
      label={`预览 ${name}`}
      returnFocusTo={returnFocusTo}
      className="max-w-4xl p-3 sm:p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm text-neutral-200" title={name}>
          {name}
        </p>
        <button
          type="button"
          onClick={onClose}
          title="关闭预览"
          className="flex-none rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500"
        >
          关闭
        </button>
      </div>

      {kind === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={name} className="mx-auto max-h-[72dvh] w-auto rounded-lg" />
      ) : kind === 'video' ? (
        <video
          src={url}
          controls
          tabIndex={0}
          autoPlay
          preload="metadata"
          playsInline
          className="mx-auto max-h-[72dvh] w-full rounded-lg bg-black"
        />
      ) : (
        <audio src={url} controls tabIndex={0} className="w-full" />
      )}
    </ModalShell>
  )
}
