import { getDb } from './db'
import { PATHS } from './paths'
import { encodeBatch, PASSAGE_INSTRUCTION } from './embed'
import { embeddingToBlob } from './db'
import { parseTags, serializeTags, composeCaptionText } from './tags'

/**
 * 图片的 AI 标注。**上传之后做，不是上传之前。**
 *
 * 顺序反过来是这次改动的核心。早先 SmartImager 那一套是上传时顺手生成，好处是
 * 用户不用管，坏处是那一刻他还没确认图对不对：选错一张、传重复一张、传进一张根本
 * 不想入库的图，标注都已经算完并写进库了，回头还得删。现在是先入库、人看一眼预览、
 * 再决定给哪些图标注，单张或批量勾选都行。判断的时机对了，标注才是有效的。
 *
 * 标注走视觉对话模型（glm-4.6v-flash），不是 embedding 模型。embedding 只能说出
 * 两张图像不像，说不出图里是什么；标注要的是后者。
 *
 * **写库必须与重编码在同一个调用里**：改了 caption 却不重算 caption_embedding，
 * 这条素材会继续被旧描述命中，而新描述搜不到。这个故障没有任何提示，只会被当成
 * 「检索模型不行」，所以两条路（单个与批量）都必须走这一个函数。
 */

const VIDEO_SERVICE = process.env.VIDEOSEEKER_VIDEO_URL || 'http://127.0.0.1:8281'

export interface AnalyzeResult {
  title: string
  description: string
  tags: string[]
}

export interface ApplyResult {
  assetId: number
  title: boolean
  caption: boolean
  tags: boolean
}

/** 单张标注的上限。视觉模型对着一张图跑一次是秒级，但网络抖动时可能等更久。 */
const ANALYZE_TIMEOUT_MS = 60_000

/**
 * 限流重试的节奏。**参数来自 60 张连续压测，不是拍脑袋。**
 *
 * 2026-09-26 实测：60 张图连续打，总耗时 299 秒，43 成 17 败。429 成簇出现，
 * 全程 5 簇，簇长 1 到 9 次；单次 429 在 0.2 秒内就返回，所以一簇 9 次只跨越
 * 约 2 秒；但簇结束后要 3.5 到 10 秒才恢复（紧随的那次成功距最后一次失败
 * 3.46-9.75 秒）。
 *
 * 两个曾经搞错过的判断，写下来免得再犯：
 * 1. 拥塞窗口是「几秒」不是十几秒。早先从服务日志看到 429 持续 11 秒，那是 SDK
 *    内置重试的退避把时间拉长了，不是窗口本身那么久。
 * 2. 限流与我们的请求速率有关，不只是全局容量。60 张连续打会反复触发 5 次，
 *    不是打一批就过。所以退避重试是对症的，但想压吞吐不能只靠重试。
 *
 * 五次尝试、基数 2 秒、翻倍、上限 20 秒：重试落在约 2、6、14、30 秒处，第二
 * 三次就覆盖了实测的 3.5-10 秒恢复期，后两次是余量。
 *
 * **抖动是必须的**：批量里前后脚撞同一簇的几张，不带抖动会在同一秒一起重试，
 * 把刚刚散开的压力又攒成一个尖峰。
 */
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 20_000
const RETRY_MAX_ATTEMPTS = 5

/** 带状态码的标注错误。调用方要区分「限流，等等再来」和「这张真的坏了」。 */
class AnalyzeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AnalyzeHttpError'
  }
}

/** 重试全部用完之后仍被限流。给上层一个能识别的类型，不用去匹配错误文案。 */
export class AnalyzeRateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnalyzeRateLimitError'
  }
}

type Sleeper = (ms: number) => Promise<void>
const realSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export interface AnalyzeOptions {
  /** 每次退避之前回调，用来把「还要等多久」告诉用户。 */
  onRetry?: (attempt: number, waitMs: number) => void
  /**
   * 退避用的等待。**测试注入一个不等的真睡眠**：五次重试的退避合计约 30 秒，
   * 让单测真等就是把测试跑成半小时。生产环境不传，用真的。
   */
  sleep?: Sleeper
}

/** 跑一次标注，不重试。拆出来是为了让重试次数可数、可测。 */
async function analyzeImageOnce(filePath: string): Promise<AnalyzeResult> {
  const r = await fetch(`${VIDEO_SERVICE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_path: filePath }),
    signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new AnalyzeHttpError(r.status, `标注服务 ${r.status}: ${body.slice(0, 200)}`)
  }
  const d = (await r.json()) as Partial<AnalyzeResult>
  return {
    title: (d.title ?? '').trim(),
    description: (d.description ?? '').trim(),
    tags: parseTags(d.tags ?? []),
  }
}

/**
 * 调推理服务拿一段标注，**被限流时退避重试**。只负责拿，不写库：写库要重编码，
 * 那一步慢且可能失败，拆开之后「拿标注」可以被单独重试，也可以先给用户看再决定
 * 要不要采纳。
 *
 * **只重试 429**：那是模型侧容量拥塞，等一会儿就好。500 不重试，它可能是图片损坏
 * 或模型没返回内容，重试一遍还是同样坏，白等一倍时间；连接不上更不重试，服务没
 * 起来的时候等多久都起不来。
 */
export async function analyzeImage(
  filePath: string,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const sleep = opts.sleep ?? realSleep
  for (let attempt = 1; ; attempt++) {
    try {
      return await analyzeImageOnce(filePath)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      const rateLimited = err instanceof AnalyzeHttpError && err.status === 429
      // 不是限流，或者已经是最后一次：认了
      if (!rateLimited || attempt >= RETRY_MAX_ATTEMPTS) {
        if (rateLimited) {
          // 给人看的一句说清状况和下一步，不把上游那串 JSON 糊到界面上。
          // 技术细节留在推理服务日志里，报问题时那边有。
          throw new AnalyzeRateLimitError(
            `模型繁忙，重试 ${RETRY_MAX_ATTEMPTS} 次后仍未完成，请稍后再试`,
          )
        }
        throw err
      }
      const capped = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS)
      const waitMs = Math.round(capped * (0.75 + Math.random() * 0.5))
      opts.onRetry?.(attempt, waitMs)
      await sleep(waitMs)
    }
  }
}

/**
 * 把一段标注写进库，并重算这一路向量。
 *
 * **title 只在原值为空或用户明确允许时才覆盖**：入库时标题用的是文件名，那是
 * 一条信息；用户手写过的标题更是信息。AI 猜的标题没有用户的准，所以默认只填空缺。
 * 描述与标签没有这个问题——描述本来就是给人看的画面说明，标签为空时填上不覆盖
 * 任何东西，所以两者直接采纳。
 */
export async function applyAnalysis(
  assetId: number,
  a: AnalyzeResult,
  opts: { overwriteTitle?: boolean } = {},
): Promise<ApplyResult> {
  const db = getDb()
  const row = db.prepare('SELECT kind, title FROM assets WHERE id = ?').get(assetId) as
    | { kind: string; title: string }
    | undefined
  if (!row) throw new Error('素材不存在')
  if (row.kind !== 'image') throw new Error('只有图片能标注画面')

  let titleChanged = false
  let captionChanged = false
  let tagsChanged = false

  if (a.title && (opts.overwriteTitle || !row.title.trim())) {
    db.prepare('UPDATE assets SET title = ? WHERE id = ?').run(a.title, assetId)
    titleChanged = true
  }

  const cur = db.prepare('SELECT caption FROM images WHERE asset_id = ?').get(assetId) as
    | { caption: string | null }
    | undefined
  if (!cur) throw new Error('图片记录缺失')

  const tags = a.tags
  if (tags.length > 0) {
    db.prepare('UPDATE assets SET tags_json = ? WHERE id = ?').run(serializeTags(tags), assetId)
    tagsChanged = true
  }

  // **语料是描述加标签一起编码**，理由见 tags.ts。只编码描述的结果是标签词从语料
  // 里消失，而标签本来是填来被搜的。
  const nextCaption = a.description || (cur.caption ?? '')
  const text = composeCaptionText(nextCaption, tags)
  const vec = text
    ? (
        await encodeBatch({
          inputs: [{ modality: 'text', text, instruction: PASSAGE_INSTRUCTION }],
        })
      )[0]
    : null

  if ((cur.caption ?? '') !== nextCaption) {
    db.prepare('UPDATE images SET caption = ?, caption_embedding = ? WHERE asset_id = ?').run(
      nextCaption || null,
      vec ? embeddingToBlob(vec) : null,
      assetId,
    )
    captionChanged = true
  } else if (vec) {
    // 描述没变但标签变了，向量仍要重算，否则新标签进不了语料
    db.prepare('UPDATE images SET caption_embedding = ? WHERE asset_id = ?').run(
      embeddingToBlob(vec),
      assetId,
    )
  }

  return { assetId, title: titleChanged, caption: captionChanged, tags: tagsChanged }
}

/**
 * 批量标注。**逐个来，一个失败不影响其他**，最后汇总成功与失败。
 *
 * 不并发：视觉模型按调用计费，一次发十张过去既可能被限流，也不好定位是哪张失败。
 * 逐个来的另一个好处是能报进度，十张图的标注要一两分钟，期间界面完全不动比慢更难受。
 *
 * 失败的那一张会带错误原因回来，调用方把它显示出来，用户能看出是网络问题还是那一张
 * 图本身有问题（文件损坏时推理端会报读图失败）。
 *
 * `note` 是给限流重试用的：那一张正在退避等待，进度条会停住，不说明原因的话
 * 用户只会以为又卡死了。
 */
export async function analyzeBatch(
  assetIds: number[],
  onProgress?: (done: number, total: number, current: string, note?: string) => void,
  opts: AnalyzeOptions = {},
): Promise<{
  ok: ApplyResult[]
  failed: Array<{ assetId: number; error: string }>
}> {
  const db = getDb()
  const ok: ApplyResult[] = []
  const failed: Array<{ assetId: number; error: string }> = []

  for (let i = 0; i < assetIds.length; i++) {
    const id = assetIds[i]
    try {
      const row = db
        .prepare('SELECT source_path FROM assets WHERE id = ? AND kind = ?')
        .get(id, 'image') as { source_path: string | null } | undefined
      if (!row?.source_path) throw new Error('图片记录缺失')
      const a = await analyzeImage(row.source_path, {
        // 退避中：报「第几张、还要等几秒」。done 传 i 而不是 i+1，这一张还没完成。
        onRetry: (attempt, waitMs) =>
          onProgress?.(
            i,
            assetIds.length,
            `#${id}`,
            `模型繁忙，${Math.max(1, Math.ceil(waitMs / 1000))} 秒后重试`,
          ),
        sleep: opts.sleep,
      })
      ok.push(await applyAnalysis(id, a))
      onProgress?.(i + 1, assetIds.length, a.title || `#${id}`)
    } catch (e) {
      failed.push({ assetId: id, error: e instanceof Error ? e.message : String(e) })
      onProgress?.(i + 1, assetIds.length, `#${id} 失败`)
    }
  }

  return { ok, failed }
}

/** 供 API 路由拼错误文案用：数据根目录，用来判断文件是否还在。 */
export const dataRoot = PATHS.dataDir
