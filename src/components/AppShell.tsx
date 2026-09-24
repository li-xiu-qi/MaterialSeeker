'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * 应用外壳：左侧常驻导航 + 右侧主区。
 *
 * 三个入口是平级功能（搜索是「找」、入库是「放」、素材库是「管」），不是父子关系，
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
 * **后台任务队列也不放这里。** 它在导航侧边栏挂过一段时间，理由是「任务进度只
 * 存在在发起它的那个页面，用户切走就看不见」。这个理由不成立：真实的等待发生
 * 在入库页，人在那里等，进度左栏就有；切走页面是少数情况，为少数情况把一块
 * 与导航无关的内容常驻在全局导航里，代价是每一次打开这个应用都要看见它，而它
 * 对检索页与素材库页毫无意义。层级上任务进度属于入库页的上下文，不属于导航。
 * 现已移进入库页自己的右侧栏。
 *
 * 本文件是客户端组件，唯一的原因是要用 usePathname 高亮当前项。
 */

const NAV = [
  { href: '/', label: '搜索', hint: '按内容找素材' },
  { href: '/ingest', label: '入库', hint: '添加图片、视频、音频、文本' },
  { href: '/library', label: '素材库', hint: '浏览与管理' },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex min-h-screen">
      {/*
        **刻意不加 overflow-y-auto。**

        曾经加过，理由是「fixed inset-y-0 的高度被钉在视口上，队列条目多起来会
        被裁死且自身滚不动」。实测发现这一下有反效果，而且是更糟的那一种：
        `overflow: auto` 会让这个容器成为 scroll chain 的边界。内容不超高时它
        自己滚不了，于是鼠标停在它上面拨滚轮时，滚轮被消费在这里——页面也不滚，
        表现就是「拨滚轮完全不动」。而用户刚刚点过侧边栏导航，鼠标往往还停在
        这个区域，命中率很高。用户报过这个现象。

        两害相权取其轻：保持 overflow 默认值，让它不是滚动目标，滚轮正常冒泡到
        document；代价是队列条目极端多时靠下的部分看不到。那个代价有兜底——
        队列面板底部有「去入库页看详情」链接，入库页能看全部任务。
      */}
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-none flex-col border-r border-neutral-800 bg-neutral-950 px-4 py-6">
        <div className="px-2">
          <p className="text-base font-semibold text-neutral-100">VideoSeeker</p>
          <p className="mt-0.5 text-[11px] text-neutral-600">多模态内容搜索工作台</p>
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

      </aside>

      {/*
        **主内容区自己滚，侧边栏钉死不动。**

        原来是整页（document）滚、侧边栏靠 fixed 留在原处。那样在素材库这种长页面
        上出过反复修不好的问题：用户报「拨滚轮页面完全不动」，而自动化环境测同一条
        URL 文档高 5083px、可滚 4.8 屏——滚得到与滚不到取决于环境里说不清的若干
        因素（原生 select 吞滚轮、overflow 容器成为 scroll chain 边界等），逐个堵
        漏堵不干净。

        改成主区独立滚动后，能否滚只取决于这一层容器自己，不再依赖整页滚动是否
        通：h-screen 把高度钉在视口上，overflow-y-auto 由它承担滚动。侧边栏本来
        就是 fixed，两者的职责从此不重叠。工作台类应用（侧边栏常驻、内容区独立滚）
        也是更常见的形态。

        滚动条样式见 globals.css：暗色页面上 Chrome 默认的 overlay 滚动条很淡，
        几乎看不见，而它是「这里还有内容」的唯一提示。
      */}
      <main className="ml-60 h-screen min-w-0 flex-1 overflow-y-auto overscroll-contain px-8 py-10">
        {children}
      </main>
    </div>
  )
}
