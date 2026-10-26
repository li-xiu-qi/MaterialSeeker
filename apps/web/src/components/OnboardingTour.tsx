'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react'

const STEPS = [
  {
    title: '搜索素材',
    description: '输入你记得的画面、原话或笔记大意，再按类型筛选。搜索结果会带你到对应素材或播放位置。',
    path: '/',
    targets: ['[data-tour="search-assets"]'],
  },
  {
    title: '添加素材',
    description: '选择视频、图片、音频或文本，按页面提示完成入库。处理完成后，素材就能被搜索和复用。',
    path: '/ingest',
    targets: ['[data-tour="ingest-dropzone"]', '[data-tour="ingest-text"]'],
  },
  {
    title: '浏览素材库',
    description: '在这里按素材库和类型浏览。点击素材卡进入详情，下一步会查看详情页里的预览与编辑入口。',
    path: '/library',
    targets: ['[data-tour="asset-detail"]', '[data-tour="library-empty"]'],
  },
  {
    title: '查看详情与编辑',
    description: '详情页用于预览内容、查看逐字稿或关键帧。展开编辑区可修改标题、描述或标签，不同素材的字段略有不同。',
    path: null,
    targets: ['[data-tour="asset-edit"]', '[data-tour="asset-detail"]', '[data-tour="library-empty"]'],
  },
] as const

function pathOf(href: string): string {
  return new URL(href, window.location.origin).pathname
}

/**
 * 主动打开的分步引导。它不是模态框：用户仍能看到并操作真实页面，
 * 每一步只高亮当前主任务，关闭后把焦点还给原入口。
 */
export function OnboardingTour({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const pathname = usePathname()
  const scope = useSearchParams().get('lib')
  const [stepIndex, setStepIndex] = useState(0)
  const [detailHref, setDetailHref] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const step = STEPS[stepIndex]
  const destination = stepIndex === STEPS.length - 1 ? (detailHref ?? '/library') : step.path

  const withScope = (href: string) => {
    if (!scope) return href
    const url = new URL(href, window.location.origin)
    if (!url.searchParams.has('lib')) url.searchParams.set('lib', scope)
    return `${url.pathname}${url.search}`
  }

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    nextRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [onClose])

  useEffect(() => {
    if (!destination || pathname === pathOf(destination)) return
    router.push(withScope(destination))
    // withScope 只依赖当前 URL 范围；目的地与路径变化才是导航信号。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, pathname, router])

  useEffect(() => {
    if (!destination || pathname !== pathOf(destination)) return
    let target: HTMLElement | null = null
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const panel = panelRef.current

    const positionPanel = () => {
      if (!panel || !target) return
      panel.style.top = 'auto'
      panel.style.bottom = ''
      panel.style.maxHeight = ''
      if (!window.matchMedia('(max-width: 639px)').matches) return

      const targetRect = target.getBoundingClientRect()
      const panelRect = panel.getBoundingClientRect()
      const overlaps = targetRect.left < panelRect.right && targetRect.right > panelRect.left &&
        targetRect.top < panelRect.bottom && targetRect.bottom > panelRect.top
      if (!overlaps) return

      const gap = 12
      const above = targetRect.top - panelRect.height - gap
      const below = targetRect.bottom + gap
      panel.style.bottom = 'auto'
      if (above >= gap) {
        panel.style.top = `${above}px`
      } else if (below + panelRect.height <= window.innerHeight - gap) {
        panel.style.top = `${below}px`
      } else {
        // 极小视口也没有整块遮挡目标的理由：选较大的一侧，卡片内部滚动。
        const spaceAbove = targetRect.top - gap * 2
        const spaceBelow = window.innerHeight - targetRect.bottom - gap * 2
        if (spaceAbove >= spaceBelow) {
          panel.style.top = `${gap}px`
          panel.style.maxHeight = `${Math.max(0, spaceAbove)}px`
        } else {
          panel.style.top = `${below}px`
          panel.style.maxHeight = `${Math.max(0, spaceBelow)}px`
        }
      }
    }

    const findTarget = () => {
      for (const selector of step.targets) {
        target = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
          (element) => element.getClientRects().length > 0,
        ) ?? null
        if (target) break
      }
      if (!target) {
        attempts += 1
        if (attempts < 30) timer = setTimeout(findTarget, 100)
        return
      }
      target.classList.add('tour-target')
      const mobile = window.matchMedia('(max-width: 639px)').matches
      target.scrollIntoView({ block: mobile ? 'start' : 'center', behavior: 'auto' })
      positionPanel()
    }

    // 等路由自身的滚动恢复结束后再定位，否则高亮已出现，页面却又回到顶部。
    timer = setTimeout(findTarget, 150)
    window.addEventListener('resize', positionPanel)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('resize', positionPanel)
      target?.classList.remove('tour-target')
      if (panel) {
        panel.style.top = 'auto'
        panel.style.bottom = ''
        panel.style.maxHeight = ''
      }
    }
  }, [destination, pathname, step.targets])

  const goTo = (nextIndex: number) => {
    if (stepIndex === 2 && nextIndex === 3) {
      const firstDetail = document.querySelector<HTMLAnchorElement>('[data-tour="asset-detail"]')
      setDetailHref(firstDetail?.getAttribute('href') ?? null)
    }
    setStepIndex(nextIndex)
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="onboarding-title"
      aria-describedby="onboarding-description"
      data-tour="onboarding-panel"
      className="fixed inset-x-3 bottom-[5.25rem] z-50 max-h-[calc(100dvh-7rem)] overflow-y-auto rounded-xl border border-neutral-700 bg-neutral-950 p-4 shadow-2xl shadow-black/50 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-[22rem] sm:p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-neutral-400" aria-live="polite">
          使用引导 · 第 {stepIndex + 1} / {STEPS.length} 步
        </p>
        <button
          type="button"
          onClick={onClose}
          title="关闭使用引导"
          aria-label="关闭使用引导"
          className="inline-flex h-11 w-11 flex-none items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-neutral-800" aria-hidden="true">
        <div
          className="h-full rounded-full bg-neutral-200 transition-[width]"
          style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
        />
      </div>
      <div className="mt-4" aria-live="polite">
        <h2 id="onboarding-title" className="text-lg font-semibold text-neutral-100">{step.title}</h2>
        <p id="onboarding-description" className="mt-2 text-sm leading-6 text-neutral-400">
          {stepIndex === STEPS.length - 1 && !detailHref
            ? '当前范围还没有可打开的素材。先完成入库，再点击素材卡进入详情，就能预览内容并编辑标题、描述或标签。'
            : step.description}
        </p>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => goTo(stepIndex - 1)}
          disabled={stepIndex === 0}
          title="返回上一步"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-neutral-700 px-3 text-sm text-neutral-300 hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          上一步
        </button>
        <div className="flex items-center gap-2">
          {stepIndex < STEPS.length - 1 && (
            <button
              type="button"
              onClick={onClose}
              title="跳过剩余步骤并关闭引导"
              className="min-h-11 rounded-lg px-3 text-sm text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
            >
              跳过
            </button>
          )}
          {stepIndex < STEPS.length - 1 ? (
            <button
              ref={nextRef}
              type="button"
              onClick={() => goTo(stepIndex + 1)}
              title="前往下一步"
              data-tour="onboarding-next"
              className="btn-primary inline-flex w-auto gap-1.5 px-4"
            >
              下一步
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : (
            <button
              ref={nextRef}
              type="button"
              onClick={onClose}
              title="完成使用引导"
              data-tour="onboarding-finish"
              className="btn-primary inline-flex w-auto gap-1.5 px-4"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
