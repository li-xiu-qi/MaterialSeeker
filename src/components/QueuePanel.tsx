'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * 入库页右侧栏的「后台任务」队列。
 *
 * **它属于入库页，不属于导航侧边栏。** 位置改过一次，记下两次的理由与翻车点：
 *
 * 第一版挂在全局导航侧边栏，理由是「任务进度只存在在发起它的那个页面，用户切走
 * 就看不见」。这个理由经不起推敲：真正的等待发生在入库页，人在那里等，左边上传
 * 面板就有实时进度；切去别的页面是少数情况。为少数情况把一块与导航无关的内容常驻
 * 在全局导航里，代价是每次打开应用都看见它，而它对检索页与素材库页毫无意义。
 * 层级上任务进度是入库页的上下文，不是导航项。用户明确指出过这一点。
 *
 * 它相对左栏上传面板仍有存在价值，**两者不是重复**：左栏 rows 是「本次会话选中
 * 的这一批」，带上传字节进度与本地预览，刷新页面即丢；这里是服务端视角的全量队列，
 * 刷新后还在，别的标签页发起的任务也在这里。所以刷新页面是个真实场景：左栏空了，
 * 右边还知道刚才那几个任务跑到哪了。
 *
 * **为什么轮询服务端而不是读组件 state**：服务端的 ingest_jobs 表是唯一真相。
 * 上传阶段也为每个文件先建了行（status=uploading），所以连最长的那段（上传本身）
 * 都看得见，不会出现「队列空着但文件还在传」的空窗。
 *
 * 空闲时不停止轮询但放慢到 8 秒一拍：任务可能由另一个标签页发起，本地没有任何
 * 事件能通知到这里，只能靠问。
 */

interface QueueItem {
  id: number
  kind: string
  title: string
  status: string
  stage: string
  percent: number
  message: string
  error: string | null
}

const ACTIVE = new Set(['uploading', 'queued', 'running'])

const STAGE_LABEL: Record<string, string> = {
  prepare: '检查与准备',
  scenes: '分析画面切换',
  frames: '抽取关键帧',
  audio: '抽取音轨',
  transcribe: '语音转文字',
  'text-encode': '文字向量化',
  db: '写入库',
  'frame-encode': '画面向量化',
}

export function QueuePanel() {
  const [items, setItems] = useState<QueueItem[]>([])
  const [loaded, setLoaded] = useState(false)

  const activeCount = items.filter((i) => ACTIVE.has(i.status)).length

  const tick = useCallback(async () => {
    try {
      const r = await fetch('/api/ingest/jobs?queue=1', { cache: 'no-store' })
      const d = (await r.json()) as { ok: boolean; jobs?: QueueItem[] }
      if (d.ok) setItems(d.jobs ?? [])
    } catch {
      // 查不到就沿用上一拍的数据。轮询失败不该把已有进度清空，那会让队列
      // 看起来像刚崩过。
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void tick()
  }, [tick])

  useEffect(() => {
    // 有任务时勤一点，空闲时懒一点。两个分支都在跑，不靠事件驱动：任务可能
    // 由另一个标签页发起，这里收不到通知。
    const ms = activeCount > 0 ? 1500 : 8000
    const timer = setInterval(tick, ms)
    return () => clearInterval(timer)
  }, [activeCount, tick])

  // 一次任务都没有过时不渲染。**不加「这里会显示任务」的占位**：等待期间人
  // 看的是左栏那一批，右栏空着比空着一个说明区块干净。
  if (!loaded || items.length === 0) return null

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
      <div className="flex items-center gap-1.5">
        <p className="text-[11px] font-medium text-neutral-400">后台任务</p>
        {activeCount > 0 && (
          <span className="rounded-full bg-neutral-100 px-1.5 text-[10px] font-medium text-neutral-900">
            {activeCount}
          </span>
        )}
      </div>

      {/*
        这一行是这个面板存在的全部理由：左栏只认这一批文件，这里认全量。
        **不说「可以离开这个页面」**——那是指向自己的废话，而且当初就是因为
        这句话才把它放错了地方。
      */}
      <p className="mt-1 text-[10px] leading-4 text-neutral-600">
        这里的任务与左边那批文件是同一个来源，刷新页面后仍能看到
      </p>

      <ul className="mt-3 space-y-2.5">
        {items.map((it) => (
          <li key={it.id}>
            <div className="flex items-center gap-1.5">
              <span className="flex-none rounded bg-neutral-800 px-1 text-[10px] text-neutral-400">
                {it.kind === 'image' ? '图' : '视频'}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-300" title={it.title}>
                {it.title}
              </span>
            </div>

            {/* 进度条。上传与处理用同一条，宽度统一由 percent 驱动 */}
            <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-neutral-800">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ${
                  it.status === 'error'
                    ? 'bg-red-500'
                    : it.status === 'done'
                      ? 'bg-emerald-500'
                      : 'bg-neutral-300'
                }`}
                style={{ width: `${it.percent}%` }}
              />
            </div>

            <p className="mt-0.5 truncate text-[10px] text-neutral-600">
              {it.status === 'error'
                ? (it.error ?? '处理失败')
                : it.status === 'done'
                  ? '已完成'
                  : it.status === 'uploading'
                    ? `上传中 ${it.percent}%`
                    : `${STAGE_LABEL[it.stage] ?? it.stage} ${it.percent}%`}
            </p>
          </li>
        ))}
      </ul>

      {activeCount > 0 && (
        <p className="mt-3 border-t border-neutral-800 pt-2 text-[10px] leading-4 text-neutral-700">
          任务在服务端排队执行，处理是逐个来的，同时跑多个不会更快
        </p>
      )}
    </div>
  )
}
