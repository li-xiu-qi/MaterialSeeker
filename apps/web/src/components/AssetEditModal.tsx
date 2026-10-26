'use client'

import { useRef, useState } from 'react'
import { MAX_TAGS } from '@/lib/tags'
import { ModalShell } from './ModalShell'

/**
 * 素材编辑的模态框。**改标题、描述、标签三样。**
 *
 * 为什么是模态而不是就地展开：就地展开会把这一行撑高，把下面几行顶出视野，而人
 * 只是改几个字。模态浮在内容之上，开关都不改变背后元素的位置。
 *
 * 为什么放在上传面板里也能用：刚入库那一刻是改标注的黄金时间，人还记得这张图
 * 是什么。等他想起来去素材库翻，通常已经忘了。所以入库完成的行旁边直接给编辑
 * 入口，与「预览」并排。
 *
 * **三种模态可改的字段不一样**，这是数据模型决定的，不是懒得做：
 * - 图片：标题 + 画面描述 + 标签。描述在 images.caption，改了要重编码向量。
 * - 视频 / 音频：标题 + 标签。没有「整片一个描述」这个字段，描述是逐帧的，
 *   改一个不影响其他帧。
 * - 文本：标题 + 正文，那个走详情页的表单，不在这里。
 *
 * 标签输入用逗号分隔的纯文本而不是 chip：chip 交互（点 × 删一个、回车确认一个）
 * 要做对很麻烦，而逗号分隔人人都会，服务端的 parseTags 也吃这个格式。
 */
export function AssetEditModal({
  open,
  onClose,
  assetId,
  kind,
  title,
  caption,
  tags,
  returnFocusTo,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  assetId: number
  kind: 'image' | 'video' | 'audio'
  title: string
  /** 现有的画面描述。视频与音频没有，传空串 */
  caption: string
  tags: string[]
  returnFocusTo?: HTMLElement | null
  onSaved?: () => void
}) {
  const [t, setT] = useState(title)
  const [c, setC] = useState(caption)
  const [g, setG] = useState(tags.join('，'))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const firstField = useRef<HTMLInputElement>(null)

  if (!open) return null

  async function save() {
    setSaving(true)
    setErr('')
    try {
      const body: { title?: string; caption?: string; tags?: string[] } = {}
      const nt = t.trim()
      // 标题只在非空且真的变了时才发。空标题是非法的，服务端会挡，但在这里就
      // 挡掉能少一次往返，也不用让用户看一句服务端措辞的错误。
      if (nt && nt !== title) body.title = nt
      // 描述：空串是合法的清空意图，所以按「与现值不同」判断而不是按「非空」。
      if (c !== caption) body.caption = c
      // 标签同样：清空是合法操作。
      const ng = g
        .split(/[,，;；]/)
        .map((x) => x.trim())
        .filter(Boolean)
      if (ng.join('，') !== tags.join('，')) body.tags = ng
      if (Object.keys(body).length === 0) {
        onClose()
        return
      }
      // **路径必须带 /patch 后缀。** PATCH 定义在 app/api/library/[id]/patch/route.ts，
      // 不在 [id]/route.ts（那个只有 GET 与 DELETE）。少这一段不会 404 到正确路由，
      // 而是落到 [id] 上返回 405 Method Not Allowed，响应体是空的，
      // r.json() 于是抛 "Unexpected end of JSON input"——一句跟真正原因无关的报错。
      const r = await fetch(`/api/library/${assetId}/patch`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = (await r.json()) as { ok?: boolean; error?: string }
      if (!d.ok) throw new Error(d.error ?? '保存失败')
      onSaved?.()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const canEditCaption = kind === 'image'

  return (
    <ModalShell
      onClose={onClose}
      label="编辑素材信息"
      returnFocusTo={returnFocusTo}
      initialFocusRef={firstField}
    >
      <div className="space-y-3">
        <p className="text-sm font-medium text-neutral-200">编辑素材信息</p>

        <div>
          <label htmlFor="edit-title" className="block text-xs text-neutral-400">
            标题
          </label>
          <input
            id="edit-title"
            ref={firstField}
            value={t}
            onChange={(e) => setT(e.target.value)}
            maxLength={120}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
          />
        </div>

        {canEditCaption && (
          <div>
            <label htmlFor="edit-caption" className="block text-xs text-neutral-400">
              画面描述
            </label>
            <textarea
              id="edit-caption"
              value={c}
              onChange={(e) => setC(e.target.value)}
              rows={4}
              placeholder="例如：穿白色运动服的运动员在草地网球场，手持球拍高举手臂准备发球"
              className="mt-1 w-full resize-y rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm leading-6 text-neutral-200 outline-none focus:border-neutral-500"
            />
            <p className="mt-1 text-xs text-neutral-400">
              这段话是检索的主要依据，写清楚画面里有什么
            </p>
          </div>
        )}

        {!canEditCaption && (
          <p className="rounded border border-neutral-800 bg-neutral-900/50 px-2 py-1.5 text-xs leading-5 text-neutral-400">
            {kind === 'video' ? '视频' : '音频'}没有整段描述可填，它的内容在逐字稿里，
            改标题与标签即可
          </p>
        )}

        <div>
          <label htmlFor="edit-tags" className="block text-xs text-neutral-400">
            标签
          </label>
          <input
            id="edit-tags"
            value={g}
            onChange={(e) => setG(e.target.value)}
            placeholder="用逗号分开，例如：访谈，开场白"
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
          />
          <p className="mt-1 text-xs text-neutral-400">
            最多 {MAX_TAGS} 个。标签用于整理素材；图片与视频还可按标签关键词检索
          </p>
        </div>

        {err && <p className="text-xs text-red-400">{err}</p>}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="btn-primary px-4 py-1.5 text-sm disabled:opacity-40"
          >
            {saving ? '保存中' : '保存'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-neutral-400 hover:text-neutral-300"
          >
            取消
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
