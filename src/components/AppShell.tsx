'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { QueuePanel } from '@/components/QueuePanel'

/**
 * 应用外壳：左侧常驻导航 + 右侧主区。
 *
 * 三个入口是平级功能（检索是「找」、入库是「放」、素材库是「管」），不是父子关系，
 * 所以放边栏而不是塞进某个页面的页首。选边栏的三个实际理由：
 * 一，回检索必须一步可达，素材库有一百多张图，返回链接埋在列表末尾等于没有；
 * 二，顶栏页签会把「去另一边」降级成次级操作；
 * 三，后面还会长第四个入口，边栏不用为此重构。
 *
 * **侧边栏只放用户主动发起的入口。** 检索范围（在哪个库里搜）不放这里：它是
 * 页面级参数，与「去哪个页面」不同级；而且它只对检索与素材库两页有意义，对
 * 入库页完全没用。放在边栏里它就和三个导航项抢注意力，用户还得先理解「这跟
 * 上面那三个不是一回事」。它现在由各页面自己的 CollectionScope 呈现。
 *
 * **例外是 QueuePanel（后台任务）。** 它不是入口，是「现在有事情在后台跑」的
 * 常驻状态，和上面的规则不同级。放这里的理由恰恰相反：任务进度只存在于发起
 * 它的那个页面，用户切走就看不见；而长任务等待期间去干点别的是正当需求，
 * 不是异常路径。任务数不为零时它才出现，空闲不占侧边栏空间。
 *
 * 本文件是客户端组件，唯一的原因是要用 usePathname 高亮当前项。
 */

const NAV = [
  { href: '/', label: '检索', hint: '按内容找素材' },
  { href: '/ingest', label: '入库', hint: '添加图片与视频' },
  { href: '/library', label: '素材库', hint: '浏览与管理' },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-none flex-col border-r border-neutral-800 bg-neutral-950 px-4 py-6">
        <div className="px-2">
          <p className="text-base font-semibold text-neutral-100">VideoSeeker</p>
          <p className="mt-0.5 text-[11px] text-neutral-600">多模态内容检索工作台</p>
        </div>

        <nav className="mt-6 space-y-1">
          {NAV.map((item) => {
            // 前缀匹配，/library 与 /ingest 下的子页也要高亮对应项
            const active =
              item.href === '/'
                ? pathname === '/'
                : pathname === item.href || pathname.startsWith(`${item.href}/`)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-md px-3 py-2 text-sm transition ${
                  active
                    ? 'bg-neutral-100 font-medium text-neutral-900'
                    : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100'
                }`}
              >
                {item.label}
                <span
                  className={`mt-0.5 block text-[11px] ${
                    active ? 'text-neutral-600' : 'text-neutral-700'
                  }`}
                >
                  {item.hint}
                </span>
              </Link>
            )
          })}
        </nav>

        <QueuePanel />
      </aside>

      <main className="ml-60 min-w-0 flex-1 px-8 py-10">{children}</main>
    </div>
  )
}
