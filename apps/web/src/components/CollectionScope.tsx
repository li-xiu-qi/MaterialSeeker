'use client'

import { usePathname } from 'next/navigation'
import { ScrollSafeSelect } from './ScrollSafeSelect'

/**
 * 检索范围选择器。**放在具体页面里，不放侧边栏。**
 *
 * 侧边栏是全局导航（去哪），检索范围是页面级参数（在这个页面里看什么），
 * 两者不同级。放在侧边栏的后果是它和三个导航项抢注意力，而它只对检索与
 * 素材库两页有意义，对入库页完全没用。
 *
 * 两个控件都不依赖 JS：
 * 切换是原生 form + select + submit，action 显式取当前路径（不写空串，
 * 空 action 虽然合规但不值得依赖）；
 * 新建用 <details> 包原生表单提交，details 是浏览器自带的折叠组件，
 * 比「点按钮 setState 显示输入框」少一层 JS 依赖。
 *
 * 建完不自动跳去新库。原先那么做，理由是「新建就是为了往里面放东西」，
 * 但实际效果是把用户扔进一个空库：落地页的最近入库整块消失，只剩一句
 * 还没有素材，也不说明刚才发生了什么。现在留在原库并给反馈，切库与去入库
 * 都由用户自己点。
 */

/**
 * 「全部库」的哨兵值，与 lib/collections 的 ALL_COLLECTIONS 同值。
 *
 * **不能 import 那个常量**：lib/collections → lib/db → better-sqlite3 → node:fs，
 * 客户端 bundle 装不进去，Turbopack 会以 Module not found: Can't resolve 'fs'
 * 让整个页面 500。这个错在 pkm 侧已犯过三次（AppShell 一次、本轮一次），
 * 判例记在 AGENTS.md「客户端组件不得 import 碰 db 的模块」。
 */
const ALL = 0

export interface CollectionOption {
  id: number
  name: string
}

export function CollectionScope({
  collections,
  currentId,
  preserve = {},
  label = '搜索范围',
  /** 新建成功后被建的那个库 id，由页面从 URL 的 made 参数读入 */
  justMadeId,
  justMadeName,
}: {
  collections: CollectionOption[]
  currentId: number
  /** 换库时要一并带上的其他查询参数 */
  preserve?: Record<string, string>
  label?: string
  justMadeId?: number | null
  justMadeName?: string | null
}) {
  const pathname = usePathname()

  const hidden = Object.entries(preserve).filter(([, v]) => v !== '')
  // 换库时保留本页其他参数：检索页的 q 与 m，素材库页的 k 与 kw
  const switchParams = new URLSearchParams()
  for (const [k, v] of hidden) switchParams.set(k, v)

  const switchHref = (id: number) => {
    const p = new URLSearchParams(switchParams)
    p.set('lib', String(id))
    return `${pathname}?${p.toString()}`
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-neutral-400">{label}</span>

      <form action={pathname} method="get" className="flex items-center gap-1.5">
        {hidden.map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        {/*
          滚轮友好版下拉框。原生 select 会吞滚轮：鼠标停在它上面往下拨，选中的是
          另一个库、页面一步不动，看着就像滚轮坏了。而这个框就在页面顶部，用户
          从侧边栏点进来时鼠标往往正停在附近。理由与取舍见 ScrollSafeSelect。
        */}
        <ScrollSafeSelect
          name="lib"
          defaultValue={currentId === ALL ? 'all' : String(currentId)}
          aria-label={label}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 outline-none focus:border-neutral-500"
        >
          <option value="all">全部库</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </ScrollSafeSelect>
        <button
          type="submit"
          className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
        >
          切换
        </button>
      </form>

      {/* details 是原生折叠，展开与提交都不需要 JS */}
      <details className="relative">
        <summary className="cursor-pointer rounded border border-dashed border-neutral-700 px-2 py-1 text-xs text-neutral-400 marker:content-none hover:border-neutral-500 hover:text-neutral-200">
          + 新建
        </summary>
        <form
          action="/api/collections/form"
          method="post"
          className="absolute left-0 top-8 z-10 w-56 space-y-2 rounded-md border border-neutral-700 bg-neutral-950 p-3 shadow-lg"
        >
          <input type="hidden" name="next" value={pathname} />
          <label className="block text-xs text-neutral-400" htmlFor="new-collection-name">
            新素材库名称
          </label>
          <input
            id="new-collection-name"
            name="name"
            maxLength={40}
            placeholder="例如：访谈素材"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-500"
          />
          <button
            type="submit"
            className="w-full rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900"
          >
            创建
          </button>
        </form>
      </details>

      {/* 新建成功的反馈：说清建了什么，并把下一步的两个出口摆出来 */}
      {justMadeId && justMadeName && (
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-emerald-400">已创建「{justMadeName}」</span>
          <a href={switchHref(justMadeId)} className="text-neutral-400 underline hover:text-neutral-200">
            切到它
          </a>
          <a href="/ingest" className="text-neutral-400 underline hover:text-neutral-200">
            去入库
          </a>
        </span>
      )}
    </div>
  )
}
