'use client'

import { usePathname } from 'next/navigation'

/**
 * 素材库管理菜单。**一个 ⋯ 按钮，点开是下拉，只作用于当前库。**
 *
 * 为什么从通栏折叠区改成按钮：原先是一条通栏 <details>，写着「管理素材库
 * （重命名 / 删除）」，视觉分量跟下面的素材列表一个量级。但它是个低频操作，
 * 不该占那么宽一块。它和「当前库」「+ 新建」同属库级操作，聚成一行不额外占
 * 垂直空间，用户找的时候也在同一处看到。
 *
 * **只管当前库，不列其他库。** 切库用旁边那个下拉一步就能做，菜单里再列一遍
 * 所有库是重复信息，还会诱导用户在目标库不在眼前时改名或删除，看不到自己要改
 * 的是哪个。要管别的库，先切过去。
 *
 * 全部原生表单，无 JS 可用：菜单本身是 details，重命名与删除都是表单 POST。
 * 删除保留独立确认，用复选框承载而不是 window.confirm（后者依赖 JS，而删库
 * 不可逆）。**复选框由服务端校验**：没勾就拒绝并回跳报错。客户端勾没勾不算
 * 数，绕开它的唯一办法是手动构造请求，那已经不是误点了。
 */

/**
 * 「全部库」的哨兵值，与 lib/collections 的 ALL_COLLECTIONS 同值。
 * **不能 import 那个常量**：lib/collections → lib/db → better-sqlite3 → node:fs，
 * 客户端 bundle 装不进去，整页 500。判例见 CollectionScope 的同款注释。
 */
const ALL = 0

const menuBox =
  'absolute right-0 top-8 z-10 w-64 space-y-3 rounded-md border border-neutral-700 bg-neutral-950 p-3 shadow-lg'
const fieldBtn =
  'w-full rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:border-neutral-500 hover:text-neutral-100'
const inputCls =
  'w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 outline-none focus:border-neutral-500'

export function CollectionMenu({
  collectionId,
  collectionName,
  isDefault,
}: {
  collectionId: number
  collectionName: string | null
  isDefault: boolean
}) {
  const pathname = usePathname()

  return (
    <details className="relative">
      <summary
        className="cursor-pointer list-none rounded border border-neutral-700 px-2 py-1 text-[11px] leading-4 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
        title="重命名或删除当前素材库"
      >
        ⋯
      </summary>

      {/* 全部库态没有单一「当前库」可管，说清为什么不给操作 */}
      {collectionId === ALL || !collectionName ? (
        <div className={menuBox}>
          <p className="text-[11px] leading-4 text-neutral-400">
            当前是全部库。先切到某一个库，才能改名或删除。
          </p>
        </div>
      ) : (
        <div className={menuBox}>
          <p className="truncate text-[11px] text-neutral-500" title={collectionName}>
            {collectionName}
          </p>

          {/* 重命名：直接给预填的表单，不用再展开一层 */}
          <form action="/api/collections/form" method="post" className="space-y-1.5">
            <input type="hidden" name="next" value={pathname} />
            <input type="hidden" name="id" value={collectionId} />
            <label className="block text-[11px] text-neutral-500" htmlFor="menu-rename">
              新名称
            </label>
            <input
              id="menu-rename"
              name="name"
              defaultValue={collectionName}
              maxLength={40}
              className={inputCls}
            />
            <button type="submit" className={fieldBtn}>
              保存新名称
            </button>
          </form>

          {/* 删除：复选框即确认，服务端校验，没勾不让删 */}
          <form action="/api/collections/delete" method="post" className="space-y-1.5">
            <input type="hidden" name="next" value={pathname} />
            <input type="hidden" name="id" value={collectionId} />
            {isDefault ? (
              <p className="text-[11px] leading-4 text-neutral-500">
                默认库不可删除，它是兜底的那个。
              </p>
            ) : (
              <>
                <label className="flex items-start gap-1.5 text-[11px] leading-4 text-neutral-400">
                  <input type="checkbox" name="confirm" value="1" className="mt-0.5" />
                  <span>
                    删除库会一并删掉库内素材的检索记录，素材文件仍保留在素材目录，可以重新入库。
                  </span>
                </label>
                <button
                  type="submit"
                  className="w-full rounded border border-red-800 px-2 py-1 text-[11px] text-red-300 hover:bg-red-950/50"
                >
                  删除这个库
                </button>
              </>
            )}
          </form>
        </div>
      )}
    </details>
  )
}
