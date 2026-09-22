/**
 * 视频处理服务（8281）的进度客户端。
 *
 * 拆出来的理由：IngestVideo 的进度有两处来源，服务端这边（抽帧计数、音频
 * 时长）只有它知道，而终态时清理条目是必须执行的动作。收在一个模块里，
 * 编排函数不必摊开 fetch 细节。
 */

const VIDEO_SERVICE = process.env.VIDEOSEEKER_VIDEO_URL || 'http://127.0.0.1:8281'

export interface ServiceProgress {
  stage: string
  /** 细分进度：抽帧 3/12 */
  done?: number
  total?: number
  /** 转写阶段：音频时长（毫秒），前端据此显示等待参照 */
  duration_ms?: number
}

export async function fetchServiceProgress(jobId: string): Promise<ServiceProgress | null> {
  try {
    const r = await fetch(`${VIDEO_SERVICE}/jobs/${encodeURIComponent(jobId)}/progress`)
    if (!r.ok) return null
    return (await r.json()) as ServiceProgress
  } catch {
    // 进度查询失败不可传染主流程，调用方按「这一拍没拿到」处理
    return null
  }
}

/** 清掉服务端进度条目。终态必须调，否则条目常驻内存。 */
export async function clearServiceProgress(jobId: string): Promise<void> {
  try {
    await fetch(`${VIDEO_SERVICE}/jobs/${encodeURIComponent(jobId)}/progress`, { method: 'DELETE' })
  } catch {
    /* 忽略：服务端有 128 条容量兜底 */
  }
}

/**
 * 一边等视频处理的主响应，一边按秒轮询它的细分进度。
 *
 * 为什么不改成按阶段分多次请求：`_ensure_decodable` 转码出来的副本要被场景
 * 检测和抽帧共用，拆开要么转码两遍，要么在服务端加缓存，都比轮询复杂。
 *
 * 返回 stop 供调用方在异常路径上也停掉轮询。
 */
export async function pollServiceProgress(
  jobId: string,
  mainPromise: Promise<Response>,
  onProgress: (p: ServiceProgress) => void,
): Promise<{ response: Response; stop: () => void }> {
  let closed = false
  let inFlight = false

  const timer = setInterval(() => {
    if (closed || inFlight) return
    inFlight = true
    void fetchServiceProgress(jobId)
      .then((p) => {
        if (p && !closed) onProgress(p)
      })
      .finally(() => {
        inFlight = false
      })
  }, 1000)

  let response: Response
  try {
    response = await mainPromise
  } finally {
    // 主请求结束了就不再轮询。finally 而不是成功路径后清：主请求抛错时
    // 定时器同样要停，否则它会在任务已失败后继续打服务。
    closed = true
    clearInterval(timer)
  }

  return {
    response,
    stop: () => {
      closed = true
      clearInterval(timer)
    },
  }
}
