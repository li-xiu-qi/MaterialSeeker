'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  feedCaptionStream,
  shouldClearSelectionAfterRun,
  summarizeCaptionRun,
  type CaptionFailure,
} from '@/lib/captionStream'

/**
 * 结果留多久自动消失。**不能不清**：它是这一次操作的回执，不是页面状态，
 * 挂一整天的「成功 2」只会变成视觉噪音，还会让人分不清它说的是哪一批。
 * 8 秒是「读完一句话还有余量」的量级，不够可以再调，但不能没有。
 */
const RESULT_TTL_MS = 8000

/**
 * 素材库多选态的「AI 标注」按钮。
 *
 * **为什么单独一个组件而不是并进 BulkBar 里的其它表单按钮**：移动、复制、删除、
 * 导出都是原生表单提交，页面整出一次就完；标注要跑几分钟，还得一边跑一边报进度。
 * 硬把它塞进同一个 form 只会让那四个按钮也变成 JS 依赖，而无 JS 时它们本该照常
 * 能用的。所以这里是「读同一个 form 的勾选，但走自己的 fetch」。
 *
 * 生成逻辑不在这里：走 `/api/library/analyze/batch`，与入库面板那套批量标注共用
 * 同一个 analyzeBatch。两条路各写一份的结果是提示词、写库规则、重编码逻辑慢慢漂移，
 * 而「标注完搜不到」这类故障没有任何提示，只会被当成检索模型不行。
 */
export function BulkCaptionButton({ formId }: { formId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [current, setCurrent] = useState('')
  const [note, setNote] = useState('')
  const [summary, setSummary] = useState('')
  const [err, setErr] = useState('')
  // 消失计时器的句柄。**必须能在卸载时清掉**：否则用户点完标注立刻跳去检索页，
  // 8 秒后回调对着一个已卸载的组件 setState，React 报一次无谓的告警。
  const dismissRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (dismissRef.current) clearTimeout(dismissRef.current)
    },
    [],
  )

  /** 到点自动清掉结果。反复设会重置计时，避免上一批的文案提前掀掉这一批的。 */
  function scheduleDismiss() {
    if (dismissRef.current) clearTimeout(dismissRef.current)
    dismissRef.current = setTimeout(() => {
      setSummary('')
      setErr('')
    }, RESULT_TTL_MS)
  }

  /** 读出表单里勾选的素材 id。复选框分散在列表各行，靠 form 属性挂在同一个 form 上。 */
  function pickedIds(): number[] {
    const form = document.getElementById(formId) as HTMLFormElement | null
    if (!form) return []
    return [...form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')]
      .map((el) => Number(el.value))
      .filter((n) => Number.isInteger(n) && n > 0)
  }

  /**
   * 清掉这一组的勾选。
   *
   * **必须逐个取消勾选并派 change 事件**：这些复选框是服务端直出的原生 input，
   * `router.refresh()` 之后 React 不会重置它们的 DOM 状态（没有 checked 属性可
   * 比对），所以刷新解决不了勾选残留。而残留的后果不只是难看——工具条上
   * 「删除所选」对它依然有效，再点「AI 标注」会把同一批重跑一遍。
   */
  function clearPicked() {
    const form = document.getElementById(formId) as HTMLFormElement | null
    if (!form) return
    for (const cb of form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      if (!cb.checked) continue
      cb.checked = false
      cb.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  async function run() {
    const ids = pickedIds()
    if (ids.length === 0) {
      setErr('先勾选要标注的图片')
      scheduleDismiss()
      return
    }
    setBusy(true)
    setErr('')
    setSummary('')
    setDone(0)
    setTotal(ids.length)
    setCurrent('')
    setNote('')
    try {
      const res = await fetch('/api/library/analyze/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(d.error ?? `请求失败（${res.status}）`)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('浏览器不支持流式响应')

      const decoder = new TextDecoder()
      // rest 只放还没凑齐整行的残余，不累积全文：每次都拿全文重切的话，
      // 三十张图就是三十次的平方级字符串操作，而切的内容绝大多数是已处理过的行。
      let rest = ''
      let okCount = 0
      let failed: CaptionFailure[] = []
      const apply = (events: ReturnType<typeof feedCaptionStream>['events']) => {
        for (const ev of events) {
          if (ev.kind === 'progress') {
            setDone(ev.value.done)
            if (ev.value.total) setTotal(ev.value.total)
            setCurrent(ev.value.current)
            // 每一次进度事件都重置：退避提示只在该显示的时候显示，这一张跑完了
            // 下一个事件没有 note，就得跟着消失
            setNote(ev.value.note ?? '')
          } else if (ev.kind === 'done') {
            okCount = ev.ok
            failed = ev.failed
          } else if (ev.kind === 'fatal') {
            throw new Error(ev.error)
          }
        }
      }

      for (;;) {
        const { value, done: finished } = await reader.read()
        if (finished) break
        // stream:true 是必须的：多字节字符可能被切在两个分块之间，不带这个参数
        // 会把半个 UTF-8 序列解成替换字符，中文标题就成了乱码。
        const fed = feedCaptionStream(rest, decoder.decode(value, { stream: true }))
        rest = fed.rest
        apply(fed.events)
      }
      // 流结束后 rest 里可能还剩最后一行（服务端收尾没带换行），补一个换行把它冲出来
      apply(feedCaptionStream(rest, '\n').events)

      setSummary(summarizeCaptionRun(okCount, failed))
      if (failed.length) setErr(failed.slice(0, 3).map((f) => `#${f.assetId} ${f.error}`).join('；'))
      if (shouldClearSelectionAfterRun(okCount, failed)) clearPicked()

      // 刷新让列表里的标题/标签变成新生成的。不刷新的话卡片还是文件名，
      // 而用户刚看完生成结果，会以为没写进去。
      router.refresh()
      scheduleDismiss()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setNote('')
      scheduleDismiss()
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="flex flex-none items-center gap-1.5">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200 disabled:opacity-40"
      >
        {busy ? `标注中 ${done}/${total}` : 'AI 标注'}
      </button>
      {busy && total > 0 && (
        <span className="h-1 w-16 overflow-hidden rounded-full bg-neutral-800">
          <span
            className="block h-full bg-emerald-500 transition-all"
            style={{ width: `${Math.round((done / total) * 100)}%` }}
          />
        </span>
      )}
      {/* 结果与错误就地显示，不弹窗：批量标注是后台事，弹窗会打断人同时去干别的。
          失败原因看一眼文字就知道该重试还是该配置。 */}
      {summary && <span className="text-[11px] text-emerald-400">{summary}</span>}
      {err && <span className="text-[11px] text-red-400">{err}</span>}
      {busy && current && <span className="text-[11px] text-neutral-600">{current}</span>}
      {/* 限流退避中。琥珀色而不是红色：这不是错误，是在等，等完会自己接着跑。
          没有这行的话进度条会停住几十秒，用户只会以为又卡死了。 */}
      {note && <span className="text-[11px] text-amber-400">{note}</span>}
    </span>
  )
}
