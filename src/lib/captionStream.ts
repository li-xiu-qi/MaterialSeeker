/**
 * 批量 AI 标注的流式响应解析。**纯函数，不碰 DOM 也不碰网络。**
 *
 * 抽出来是为了能测：NDJSON 的难点全在「一次 read 拿到的字节不保证整行结尾」和
 * 「一行有四种语义（progress / done / fatal / 表头）」，这两处写错的表现分别是
 * 第一行就抛错、和进度永远不动。写在组件里只能靠真跑一遍才能发现，而真跑要
 * 连视觉模型，测的就不是解析而是网络了。
 *
 * 服务端 `/api/library/analyze/batch` 的事件格式（一行一个 JSON）：
 * - `{type:'progress', done, total, current}`  每标完一张推一次，失败的也推
 * - `{type:'progress', done, total, current, note}`  退避等待中，同一张会推多次
 * - `{type:'done', ok, failed:[{assetId,error}]}`  全部结束
 * - `{type:'fatal', error}`  整批没跑起来
 */

export interface CaptionProgress {
  done: number
  total: number
  /** 当前这一张的标题（或「#id 失败」），给人一个「它在动」的感知 */
  current: string
  /**
   * 这一张正在退避等待时的说明，形如「模型繁忙，3 秒后重试」。
   *
   * **没有它就是 undefined，不是空串以外的默认值**：调用方要靠「有没有值」决定
   * 显示还是不显示，而进度事件每次都会带上这个字段，用空串会让上一张的等待提示
   * 在下一张成功时留下不消失。
   */
  note?: string
}

export interface CaptionFailure {
  assetId: number
  error: string
}

/** 一次 feed 之后解析出的东西。`rest` 是还没凑齐整行的残余，下次要接着拼。 */
export interface FeedResult {
  events: CaptionEvent[]
  rest: string
}

export type CaptionEvent =
  | { kind: 'progress'; value: CaptionProgress }
  | { kind: 'done'; ok: number; failed: CaptionFailure[] }
  | { kind: 'fatal'; error: string }
  /** 解析不了的行。服务端Bug或代理插了非 JSON 内容，不当异常抛，交给调用方决定 */
  | { kind: 'garbage'; raw: string }

/**
 * 喂一段新字节进来，返回这段时间里凑齐的所有事件。
 *
 * **必须由调用方维护 buffer 并把 rest 传回**：流的分块与行号无关，一行被切成
 * 两半是常态。直接 JSON.parse 每个分块的结果是第一行就抛 SyntaxError，而组件
 * 会把它当成「标注失败」报给用户——真实原因是解析方式错了。
 */
export function feedCaptionStream(buffer: string, chunk: string): FeedResult {
  const buf = buffer + chunk
  const lines = buf.split('\n')
  // 最后一段可能只是半行，留到下次
  const rest = lines.pop() ?? ''
  const events: CaptionEvent[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      events.push({ kind: 'garbage', raw: line.slice(0, 200) })
      continue
    }
    const type = typeof msg.type === 'string' ? msg.type : ''
    if (type === 'progress') {
      const value: CaptionProgress = {
        done: Number(msg.done ?? 0),
        total: Number(msg.total ?? 0),
        current: typeof msg.current === 'string' ? msg.current : '',
      }
      // 没有 note 就整个不加这个键，不是设成 undefined：加了的键在展开、序列化、
      // Object.keys 里都会显形，而「这一条没有等待提示」和「有一条空提示」是两件事。
      if (typeof msg.note === 'string') value.note = msg.note
      events.push({ kind: 'progress', value })
    } else if (type === 'done') {
      const raw = Array.isArray(msg.failed) ? msg.failed : []
      events.push({
        kind: 'done',
        ok: Number(msg.ok ?? 0),
        failed: raw.map((f) => ({
          assetId: Number((f as { assetId?: unknown }).assetId ?? 0),
          error: String((f as { error?: unknown }).error ?? '未知原因'),
        })),
      })
    } else if (type === 'fatal') {
      events.push({ kind: 'fatal', error: String(msg.error ?? '标注服务出错') })
    } else {
      events.push({ kind: 'garbage', raw: line.slice(0, 200) })
    }
  }
  return { events, rest }
}

/**
 * 把结束状态拼成一句话。**失败原因另给，不塞进这句话**：这句话是绿色的事实
 * 陈述，混进错误文案会让人读不出到底成没成。
 */
export function summarizeCaptionRun(ok: number, failed: CaptionFailure[]): string {
  if (ok === 0 && failed.length === 0) return '没有可标注的图片'
  const parts = [`已标 ${ok} 张`]
  if (failed.length) parts.push(`失败 ${failed.length} 张`)
  return parts.join('，')
}

/**
 * 跑完之后要不要清掉勾选。
 *
 * **至少成功一张就清**：活干完了，勾选留着是纯风险——工具条上「删除所选」对
 * 这个过期勾选依然有效，再点一次「AI 标注」会把同一批重跑一遍，白烧配额。
 *
 * **全失败时留着**：那时候用户想做的就是重试，留着勾选是一键重来；清了反而要
 * 他再把同样的图勾一遍。
 */
export function shouldClearSelectionAfterRun(ok: number, failed: CaptionFailure[]): boolean {
  return ok > 0
}
