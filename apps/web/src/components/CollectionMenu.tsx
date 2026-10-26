"use client";

import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import { ModalShell } from "./ModalShell";

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
 * 删除有两道确认：**有 JS 时弹模态框**（看得见库名、素材数、后果，
 * 误点成本低），**无 JS 时退回复选框**（勾选才提交，服务端同样校验）。
 * 之所以不用 window.confirm：它样式改不动，在深色界面里是个刺眼的白框，
 * 而且长文案会被截断。模态框是本项目自己的组件，两处代码量差别不大。
 *
 * **两道确认都由服务端兜底校验**：模态框只是体验，复选框才是门槛。没勾
 * confirm=1 一律拒绝并回跳报错。客户端勾没勾不算数，绕开它的唯一办法是
 * 手动构造请求，那已经不是误点了。
 */

/**
 * 「全部库」的哨兵值，与 lib/collections 的 ALL_COLLECTIONS 同值。
 * **不能 import 那个常量**：lib/collections → lib/db → better-sqlite3 → node:fs，
 * 客户端 bundle 装不进去，整页 500。判例见 CollectionScope 的同款注释。
 */
const ALL = 0;

const menuBox =
  "absolute right-0 top-8 z-10 w-64 space-y-3 rounded-md border border-neutral-700 bg-neutral-950 p-3 shadow-lg";
const fieldBtn =
  "w-full rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100";
const inputCls =
  "w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-500";

export function CollectionMenu({
  collectionId,
  collectionName,
  isDefault,
  assetCount,
}: {
  collectionId: number;
  collectionName: string | null;
  isDefault: boolean;
  /** 库内素材条数，删除确认框里要显示出来 */
  assetCount: number;
}) {
  const pathname = usePathname();
  // 删除确认框。null = 关着，非 null = 对着某个库开着
  const [confirming, setConfirming] = useState<number | null>(null);
  // 无 JS 兜底的那个复选框。模态框确认时由这里勾上再提交表单
  const confirmRef = useRef<HTMLInputElement>(null);
  // 「用户已在模态框里确认过」的标记。onSubmit 靠它区分两种来源：直接点
  // 「删除这个库」要先弹模态框，从模态框确认过来的要放行真提交。不靠
  // 「临时摘掉 onSubmit」来区分：那个处理器是 JS 路径唯一的入口。
  const confirmedRef = useRef(false);

  return (
    <>
      <details className="relative">
        <summary
          className="cursor-pointer list-none rounded border border-neutral-700 px-2 py-1 text-xs leading-4 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
          title="重命名或删除当前素材库"
        >
          ⋯
        </summary>

        {/* 全部库态没有单一「当前库」可管，说清为什么不给操作 */}
        {collectionId === ALL || !collectionName ? (
          <div className={menuBox}>
            <p className="text-xs leading-4 text-neutral-400">
              当前是全部库。先切到某一个库，才能改名或删除。
            </p>
          </div>
        ) : (
          <div className={menuBox}>
            <p
              className="truncate text-xs text-neutral-400"
              title={collectionName}
            >
              {collectionName}
            </p>

            {/* 重命名：直接给预填的表单，不用再展开一层 */}
            <form
              action="/api/collections/form"
              method="post"
              className="space-y-1.5"
            >
              <input type="hidden" name="next" value={pathname} />
              <input type="hidden" name="id" value={collectionId} />
              <label
                className="block text-xs text-neutral-400"
                htmlFor="menu-rename"
              >
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

            {/* 删除：两道确认。有 JS 弹模态框，无 JS 退回复选框，
              两者最终都提交同一个表单，服务端一律校验 confirm=1。 */}
            <form
              id={`del-collection-${collectionId}`}
              action="/api/collections/delete"
              method="post"
              className="space-y-1.5"
              onSubmit={(e) => {
                if (!confirmedRef.current) {
                  // 直接点的：先弹确认框，不提交
                  e.preventDefault();
                  setConfirming(collectionId);
                  return;
                }
                // 从模态框确认过来的：放行，让表单原生提交。**立刻复位**，
                // 否则万一提交被浏览器拦下，下次点删除会跳过模态框直接删。
                confirmedRef.current = false;
              }}
            >
              <input type="hidden" name="next" value={pathname} />
              <input type="hidden" name="id" value={collectionId} />
              {isDefault ? (
                /* 默认库是兜底的那个，删了存量素材的 collection_id 全部悬空 */
                <p className="text-xs leading-4 text-neutral-400">
                  默认库不可删除，它是兜底的那个。
                </p>
              ) : (
                <>
                  {/* 无 JS 时的确认门槛。这个框必须真的在页面上：JS 失效时
                    onSubmit 不存在，原生提交照常发生，它就是唯一的确认。
                    藏起来等于无 JS 的用户没有任何确认就删了库。 */}
                  <label className="flex items-start gap-1.5 text-xs leading-4 text-neutral-400">
                    <input
                      ref={confirmRef}
                      type="checkbox"
                      name="confirm"
                      value="1"
                      className="mt-0.5 h-3.5 w-3.5 flex-none accent-neutral-400"
                    />
                    <span>我确认删除这个素材库</span>
                  </label>
                  <button
                    type="submit"
                    className="w-full rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950/50"
                  >
                    删除这个库
                  </button>
                </>
              )}
            </form>
          </div>
        )}
      </details>

      {/*
      删除确认模态框。**只在有 JS 时出现**：onSubmit 被 preventDefault 才走得到
      这里，JS 失效时整个分支不存在，用户看到的是上面那个复选框表单。

      为什么值得单写一个而不用 window.confirm：后者样式改不动，在深色界面里
      是个刺眼的白框，长文案还会被截断；而这里要说清库名、素材条数、以及
      「文件还在、只是之后搜不到」这个后果，句子不短。
    */}
      {confirming !== null && collectionName && (
        <ModalShell onClose={() => setConfirming(null)} label="删除素材库确认">
          <div>
            <h3 className="text-sm font-medium text-neutral-100">
              删除素材库「{collectionName}」？
            </h3>
            <p className="mt-2 text-xs leading-5 text-neutral-400">
              库内 {assetCount}{" "}
              条素材的检索记录会一并删除，之后按内容搜不到它们。
              素材文件仍保留在素材目录，重新入库即可恢复可检索状态。
            </p>
            <p className="mt-1.5 text-xs leading-5 text-neutral-400">
              这个操作不能撤销。
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  // 勾上服务端要的那个复选框，再提交同一个表单。这样两条路（模态框
                  // 与复选框）最终都走 confirm=1，服务端只认这一个。
                  if (confirmRef.current) confirmRef.current.checked = true;
                  confirmedRef.current = true;
                  // requestSubmit 而不是 dispatchEvent('submit')：两者都触发
                  // submit 事件，都会被上面那个 onSubmit 接到，靠 confirmedRef
                  // 区分放行与否。只派发裸事件的问题是它同样会走一遍
                  // onSubmit，而此时那里又 preventDefault 并重开模态框，
                  // 结果什么都没发生（实测过：复选框勾上了、库没删）。
                  (
                    document.getElementById(`del-collection-${confirming}`) as HTMLFormElement | null
                  )?.requestSubmit();
                }}
                className="rounded border border-red-700 bg-red-950/60 px-3 py-1.5 text-xs text-red-200 hover:bg-red-900/60"
              >
                确认删除
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  );
}
