'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ModalShell } from './ModalShell'

/**
 * 素材的编辑入口。**编辑走模态框，不是就地展开。**
 *
 * 就地展开的那个版本里，点「编辑」会在那一行下面撑出一块表单，把它下面的内容
 * 全部顶下去；多栏列表下行高一变，卡片瞬间错位，想改的那一条反而被挤到视野
 * 外。模态浮在内容之上，打开与关闭都不改变背后任何元素的位置——这是「改一个
 * 字段」该有的语义，与 MediaPreviewModal 同一套理由。
 *
 * 三种素材可改的字段不一样，这是数据模型决定的：
 * - 图片：标题 + 画面描述 + 标签
 * - 文本：标题 + 正文 + 标签
 * - 视频 / 音频：标题 + 标签。它们没有「整片一个描述」字段——视频的描述逐帧
 *   存在 frames.caption 上，音频连帧都没有。给这两种模态显示描述框，用户填完
 *   保存会被服务端拒掉，而拒绝理由对用户是不可操作的信息。
 *
 * JS 失效时按钮点不动，但删除另有不需要它的路径（详情页上的原生表单）。
 * 这是增强，不是页面的前提。
 */
export function LibraryEditButton({
  id,
  kind,
  title,
  annotation,
  annotationLabel,
  tags = [],
}: {
  id: number
  kind: 'image' | 'video' | 'audio' | 'text'
  title: string
  /** 现有的标注内容，图片是画面描述，文本是正文 */
  annotation: string
  annotationLabel: string
  /** 现有标签。四种模态都能改，所以这里不按 kind 分叉 */
  tags?: string[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [t, setT] = useState(title)
  const [a, setA] = useState(annotation)
  // 标签用逗号分隔的字符串编辑，保存时交给服务端 parseTags 收敛。
  // **不用 chip 输入**：那要处理退格删到一半、粘贴一串、以及「；」与「，」
  // 混用，而用户在这个场景下就是「把几个词填进去」，一个输入框更直接。
  const [g, setG] = useState(tags.join('，'))
  // 关闭后焦点回到打开它的按钮，否则键盘用户被丢回页面开头
  const triggerRef = useRef<HTMLButtonElement>(null)

  /** 描述字段这个模态给不给。视频与音频没有整片描述，给了也是白给。 */
  const canEditAnnotation = kind !== 'video' && kind !== 'audio'

  async function save() {
    setSaving(true)
    setErr('')
    try {
      const body: { title?: string; caption?: string; tags?: string[] } = {}
      if (t.trim() && t.trim() !== title) body.title = t.trim()
      if (canEditAnnotation && a !== annotation) body.caption = a
      // 标签只要模态开着就发，因为「清空标签」是合法操作：输入框空着不代表
      // 用户没改，很可能他就是要把标签删掉。按内容比对的后果是清空永远发不出去。
      const nextTags = g
        .split(/[,，;；]/)
        .map((x) => x.trim())
        .filter(Boolean)
      const tagsChanged =
        nextTags.length !== tags.length || nextTags.some((x, i) => x !== tags[i])
      if (tagsChanged) body.tags = nextTags
      if (Object.keys(body).length === 0) {
        setOpen(false)
        return
      }
      const r = await fetch(`/api/library/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error ?? '保存失败')
      setOpen(false)
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <span className="flex-none">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="h-fit rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
      >
        编辑
      </button>

      {/*
        点击遮罩关闭。**内容区 stopPropagation**，否则点「保存」会先触发遮罩的
        onClick，模态关了、保存请求也没发出去。
      */}
      {open && (
        <ModalShell
          onClose={() => setOpen(false)}
          label={`编辑 ${title}`}
          returnFocusRef={triggerRef}
        >
          <div className="space-y-2.5">
            <p className="text-sm font-medium text-neutral-200">编辑素材</p>

            <label className="block text-xs text-neutral-400" htmlFor={`edit-t-${id}`}>
              标题
            </label>
            <input
              id={`edit-t-${id}`}
              value={t}
              onChange={(e) => setT(e.target.value)}
              maxLength={120}
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-500"
            />

            {canEditAnnotation && (
              <>
                <label className="block text-xs text-neutral-400" htmlFor={`edit-a-${id}`}>
                  {annotationLabel}
                </label>
                <textarea
                  id={`edit-a-${id}`}
                  value={a}
                  onChange={(e) => setA(e.target.value)}
                  rows={kind === 'text' ? 6 : 3}
                  className="w-full resize-y rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs leading-5 text-neutral-200 outline-none focus:border-neutral-500"
                />
              </>
            )}

            <label className="block text-xs text-neutral-400" htmlFor={`edit-g-${id}`}>
              标签
            </label>
            <input
              id={`edit-g-${id}`}
              value={g}
              onChange={(e) => setG(e.target.value)}
              placeholder="用逗号分开，例如：访谈，户外"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-500"
            />
            <p className="text-xs leading-4 text-neutral-400">
              标签用于整理素材；图片与视频还可按标签关键词检索
            </p>

            {err && <p className="text-xs text-red-400">{err}</p>}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="btn-primary px-3 py-1 text-xs disabled:opacity-40"
              >
                {saving ? '保存中' : '保存'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  setErr('')
                }}
                className="min-h-11 px-2 text-xs text-neutral-400 hover:text-neutral-300"
              >
                取消
              </button>
              {canEditAnnotation && (
                <span className="ml-auto text-xs text-neutral-400">
                  保存后重新计算检索特征，要等一两秒
                </span>
              )}
            </div>
          </div>
        </ModalShell>
      )}
    </span>
  )
}
