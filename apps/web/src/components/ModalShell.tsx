'use client'

import { useEffect, useRef, type ReactNode, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'video[controls]',
  'audio[controls]',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * 共用模态外壳：手机底部 sheet、桌面居中对话框，以及完整的键盘行为。
 * 只在模态打开时挂载，关闭即卸载，焦点归还与滚动恢复都在 cleanup 里完成。
 */
export function ModalShell({
  children,
  onClose,
  label,
  returnFocusTo,
  returnFocusRef,
  initialFocusRef,
  className = 'max-w-md',
}: {
  children: ReactNode
  onClose: () => void
  label: string
  returnFocusTo?: HTMLElement | null
  returnFocusRef?: RefObject<HTMLElement | null>
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ onClose, returnFocusTo, returnFocusRef })
  useEffect(() => {
    latest.current = { onClose, returnFocusTo, returnFocusRef }
  })

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const main = document.querySelector('main')
    const previousBodyOverflow = document.body.style.overflow
    const previousMainOverflow = main instanceof HTMLElement ? main.style.overflow : ''
    document.body.style.overflow = 'hidden'
    if (main instanceof HTMLElement) main.style.overflow = 'hidden'

    // effect 运行时面板与字段已挂载，无需 rAF；后台标签页也不该丢掉初始焦点。
    const target = initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)
    ;(target ?? panelRef.current)?.focus()

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        latest.current.onClose()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.getClientRects().length > 0,
      )
      if (focusable.length === 0) {
        event.preventDefault()
        panelRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousBodyOverflow
      if (main instanceof HTMLElement) main.style.overflow = previousMainOverflow
      ;(latest.current.returnFocusRef?.current ?? latest.current.returnFocusTo ?? previousFocus)?.focus()
    }
  }, [initialFocusRef])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 sm:items-center sm:p-6"
      onClick={() => latest.current.onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`max-h-[92dvh] w-full overflow-y-auto rounded-t-xl border border-neutral-700 bg-neutral-950 p-4 shadow-2xl sm:max-h-[85vh] sm:rounded-xl sm:p-5 ${className}`}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
