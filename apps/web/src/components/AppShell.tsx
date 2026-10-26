'use client'

import { type MouseEvent, type ReactNode, useCallback, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { CircleHelp, LibraryBig, Search, Upload } from 'lucide-react'
import { BrandMark } from './BrandMark'
import { OnboardingTour } from './OnboardingTour'

const NAV = [
  { href: '/', label: '搜索', hint: '按内容找素材', icon: Search },
  { href: '/ingest', label: '入库', hint: '添加图片、视频、音频、文本', icon: Upload },
  { href: '/library', label: '素材库', hint: '浏览与管理', icon: LibraryBig },
]

/** hydration 前的首点也保留范围：以点击当下的 URL 为准，不依赖 effect 已跑完。 */
function preserveScopeOnClick(event: MouseEvent<HTMLAnchorElement>) {
  const scope = new URLSearchParams(window.location.search).get('lib')
  if (!scope) return
  const target = new URL(event.currentTarget.href)
  target.searchParams.set('lib', scope)
  event.currentTarget.href = `${target.pathname}${target.search}`
}

function NavLinks({
  pathname,
  collectionScope,
  mobile = false,
}: {
  pathname: string
  collectionScope: string | null
  mobile?: boolean
}) {
  return NAV.map((item) => {
    const active = item.href === '/'
      ? pathname === '/'
      : pathname === item.href || pathname.startsWith(`${item.href}/`)
    const href = collectionScope
      ? `${item.href}?lib=${encodeURIComponent(collectionScope)}`
      : item.href
    const Icon = item.icon

    if (mobile) {
      return (
        <a
          key={item.href}
          href={href}
          aria-current={active ? 'page' : undefined}
          title={`前往${item.label}`}
          onClick={preserveScopeOnClick}
          className={`flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-lg px-1 text-[11px] transition ${
            active ? 'bg-neutral-900 text-neutral-100' : 'text-neutral-400 hover:text-neutral-100'
          }`}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
          <span>{item.label}</span>
        </a>
      )
    }

    return (
      <a
        key={item.href}
        href={href}
        aria-current={active ? 'page' : undefined}
        title={`前往${item.label}`}
        onClick={preserveScopeOnClick}
        className={`flex min-h-[60px] items-center gap-3 rounded-xl border px-3 py-2.5 transition ${
          active
            ? 'border-neutral-800 bg-neutral-900 text-neutral-100'
            : 'border-transparent text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100'
        }`}
      >
        <Icon
          className={`h-5 w-5 flex-none ${active ? 'text-neutral-100' : 'text-neutral-400'}`}
          aria-hidden="true"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{item.label}</span>
          <span className="mt-0.5 block truncate text-[11px] text-neutral-400">{item.hint}</span>
        </span>
      </a>
    )
  })
}

/** 桌面常驻侧栏，手机底部三入口；页面级素材范围仍由 URL 原样保留。 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const collectionScope = useSearchParams().get('lib')
  const [guideOpen, setGuideOpen] = useState(false)
  const closeGuide = useCallback(() => setGuideOpen(false), [])

  return (
    <div className="min-h-screen md:flex">
      <a href="#main-content" className="skip-link">跳到主要内容</a>

      <aside className="hidden md:fixed md:inset-y-0 md:left-0 md:flex md:w-56 md:flex-none md:flex-col md:border-r md:border-neutral-800 md:bg-neutral-950 md:px-4 md:py-7">
        <div className="flex items-center gap-2.5 px-2">
          <BrandMark size={32} />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-neutral-100">素材搜索</p>
            <p className="mt-0.5 truncate text-[11px] text-neutral-400">MaterialSeeker</p>
          </div>
        </div>
        <nav className="mt-8 space-y-1.5" aria-label="主导航">
          <NavLinks pathname={pathname} collectionScope={collectionScope} />
        </nav>
        <button
          type="button"
          onClick={() => setGuideOpen(true)}
          title="打开分步使用引导"
          data-tour="open-onboarding"
          className="mt-4 flex min-h-11 items-center gap-2 rounded-lg px-3 text-left text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
        >
          <CircleHelp className="h-4 w-4" aria-hidden="true" />
          使用引导
        </button>
        <p className="mt-auto px-3 text-[11px] text-neutral-500">本地素材，持续复用</p>
      </aside>

      <main
        id="main-content"
        tabIndex={-1}
        className="h-screen min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-24 pt-4 sm:px-6 md:ml-56 md:px-8 md:py-8 lg:px-10"
      >
        <div className="mb-5 flex items-center justify-between gap-3 md:hidden">
          <div className="flex min-w-0 items-center gap-2.5">
            <BrandMark size={28} />
            <div>
              <p className="text-sm font-semibold text-neutral-100">素材搜索</p>
              <p className="text-[10px] text-neutral-400">MaterialSeeker</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setGuideOpen(true)}
            title="打开分步使用引导"
            data-tour="open-onboarding"
            className="inline-flex min-h-11 flex-none items-center gap-1.5 rounded-lg border border-neutral-800 px-3 text-xs text-neutral-300 hover:border-neutral-600 hover:text-neutral-100"
          >
            <CircleHelp className="h-4 w-4" aria-hidden="true" />
            使用引导
          </button>
        </div>
        {children}
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-3 border-t border-neutral-800 bg-neutral-950/95 p-2 backdrop-blur md:hidden"
        aria-label="移动端主导航"
        style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        <NavLinks pathname={pathname} collectionScope={collectionScope} mobile />
      </nav>
      {guideOpen && <OnboardingTour onClose={closeGuide} />}
    </div>
  )
}
