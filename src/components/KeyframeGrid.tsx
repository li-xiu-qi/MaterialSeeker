'use client'

import { useEffect, useState } from 'react'
import { fmtMs } from '@/lib/format'

interface Keyframe {
  id: number
  timestampMs: number
  url: string | null
  caption: string | null
}

/** 首屏显示 4 个，用户每点一次「显示更多」再补 4 个。
 * 未显示的帧不进入 DOM，也不会发起对应的图片请求。
 */
export function KeyframeGrid({ frames }: { frames: Keyframe[] }) {
  const [count, setCount] = useState(4)

  useEffect(() => {
    setCount(4)
  }, [frames])

  const shown = Math.min(count, frames.length)
  const remaining = frames.length - shown

  return (
    <>
      <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {frames.slice(0, count).map((f) => (
          <li
            key={f.id}
            className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/40"
          >
            {f.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`${f.url}?w=320`}
                alt={f.caption ?? `视频 ${fmtMs(f.timestampMs)} 处的关键帧`}
                loading="lazy"
                className="aspect-[4/3] w-full object-contain bg-black"
              />
            ) : (
              <div className="flex aspect-[4/3] items-center justify-center bg-neutral-950 text-xs text-neutral-400">
                无预览
              </div>
            )}
            <div className="p-3">
              <p className="text-xs tabular-nums text-neutral-300">{fmtMs(f.timestampMs)}</p>
              {f.caption && <p className="mt-1 text-xs leading-5 text-neutral-400">{f.caption}</p>}
            </div>
          </li>
        ))}
      </ul>
      {remaining > 0 && (
        <button
          type="button"
          title={`再显示 ${Math.min(4, remaining)} 个关键帧`}
          onClick={() => setCount((current) => Math.min(current + 4, frames.length))}
          className="mt-4 flex min-h-11 w-full items-center justify-center rounded-lg border border-dashed border-neutral-700 px-3 py-2 text-center text-xs text-neutral-400 transition hover:border-neutral-500 hover:bg-neutral-900/40 hover:text-neutral-200"
        >
          显示更多（还有 {remaining} 个）
        </button>
      )}
      <p className="mt-2 text-[11px] text-neutral-400">
        已显示 {shown} / {frames.length} 个关键帧{remaining === 0 ? '，已全部加载' : ''}
      </p>
    </>
  )
}
