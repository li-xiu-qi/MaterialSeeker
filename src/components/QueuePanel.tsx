'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * 侧边栏常驻的「后台任务」队列。
 *
 * **为什么它必须在侧边栏而不在入库页里**：入库面板的进度存在组件 state 里，
 * 用户一旦切去检索页或素材库就什么都看不见。而长任务的等待期间，用户去做点
 * 别的是正当需求（顺手搜一下、看看别的库），不是异常路径。进度只在发起它的
 * 那个页面可见，等于强迫人钉在原地等。
 *
 * **为什么轮询服务端而不是读组件 state**：服务端的 ingest_jobs 表是唯一真相。
 * 上传阶段也为每个文件先建了行（status=uploading），所以连最长的那段（上传
 * 本身）都看得见，不会出现「队列空着但文件还在传」的空窗。
 *
 * 空闲时不停止轮询但放慢到 8 秒一拍：任务可能由另一个标签页发起，本地没有
 * 任何事件能通知到这里，只能靠问。
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

  // 一次任务都没有过时不渲染，别让侧边栏常驻一个空区块。
  if (!loaded || items.length === 0) return null

  return (
    <div className="mt-6 border-t border-neutral-800 pt-4">
      <div className="flex items-center gap-1.5 px-2">
        <p className="text-[11px] font-medium text-neutral-400">后台任务</p>
        {activeCount > 0 && (
          <span className="rounded-full bg-neutral-100 px-1.5 text-[10px] font-medium text-neutral-900">
            {activeCount}
          </span>
        )}
      </div>

      <ul className="mt-2 space-y-2">
        {items.map((it) => (
          <li key={it.id} className="px-2">
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
        <p className="mt-2 px-2 text-[10px] leading-4 text-neutral-700">
          可以离开这个页面，任务在后台继续跑
        </p>
      )}
      <Link
        href="/ingest"
        className="mt-2 block px-2 text-[10px] text-neutral-600 hover:text-neutral-400"
      >
        去入库页看详情
      </Link>
    </div>
  )
}
