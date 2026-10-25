import { getDb } from './db'
import { finishedWindowSql, finishedWindowArg } from './queueWindow'

/**
 * 入库任务表。视频入库从「堵在 HTTP 请求里」改成「提交即返回、后台执行」后，
 * 进度需要一个能被轮询的落点。放在 SQLite 而不是内存里，为的是 dev server
 * 重启之后前端刷新页面还能看到这批任务最后停在哪（in-flight 的救不回来，
 * 但至少知道是中断而不是消失）。
 *
 * 阶段进度分两层：本表记粗粒度 stage/percent，视频处理服务那边的细分进度
 * （抽帧 3/12、音频时长）由 ingestRunner 轮询后折算进 percent。
 */

// 终态任务的可见时间窗，来源见 queueWindow。这里 re-export 是为了调用方
// 不需要为了一个常数去 import 第二个文件。
export { FINISHED_TTL_SECONDS } from './queueWindow'

export type JobStatus =
  | 'uploading'
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'canceled'

/** 还没终态的状态。轮询与「重启后标中断」都用这一组。 */
export const ACTIVE_STATUSES = ['uploading', 'queued', 'running'] as const

export interface JobRow {
  id: number
  batch_id: string
  kind: 'video' | 'image' | 'audio'
  title: string
  file_path: string | null
  collection_id: number
  status: JobStatus
  stage: string
  percent: number
  message: string
  error: string | null
  result_json: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

export interface CreateJobInput {
  batchId: string
  kind: 'video' | 'image' | 'audio'
  title: string
  filePath?: string | null
  collectionId: number
}

interface JobPatch {
  status?: JobStatus
  stage?: string
  percent?: number
  message?: string
  error?: string | null
  resultJson?: string | null
  /** 上传完成后才有的服务端路径，回填给上传阶段建好的那一行 */
  filePath?: string | null
  started?: boolean
  finished?: boolean
}

export function createJob(input: CreateJobInput): number {
  const db = getDb()
  const r = db
    .prepare(
      `INSERT INTO ingest_jobs (batch_id, kind, title, file_path, collection_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.batchId, input.kind, input.title, input.filePath ?? null, input.collectionId)
  return Number(r.lastInsertRowid)
}

/**
 * 批量建任务，返回按传入顺序排列的 id。**上传前先建，状态为 uploading。**

 * 之所以要为上传这一步也建行：上传是整条链路里最长的一段（1.91 GB 走局域网
 * 两分钟以上），若等上传完再建行，侧边栏的队列在这几分钟里是空的，用户看到
 * 的仍是「没有任务在跑」。上传期间的字节进度由前端轮番上报，见 updateJob。
 */
export function createJobs(inputs: CreateJobInput[]): number[] {
  const db = getDb()
  const ins = db.prepare(
    `INSERT INTO ingest_jobs (batch_id, kind, title, file_path, collection_id, status, stage, percent)
     VALUES (?, ?, ?, ?, ?, 'uploading', '上传中', 0)`,
  )
  const tx = db.transaction(() => inputs.map((i) => Number(ins.run(
    i.batchId,
    i.kind,
    i.title,
    i.filePath ?? null,
    i.collectionId,
  ).lastInsertRowid)))
  return tx()
}

export function getJob(id: number): JobRow | null {
  return (
    (getDb().prepare('SELECT * FROM ingest_jobs WHERE id = ?').get(id) as JobRow | undefined) ?? null
  )
}

/** 按批次取任务，按 id 升序（即提交顺序）。 */
export function listJobsByBatch(batchId: string): JobRow[] {
  return getDb()
    .prepare('SELECT * FROM ingest_jobs WHERE batch_id = ? ORDER BY id ASC')
    .all(batchId) as JobRow[]
}

export function updateJob(id: number, patch: JobPatch): void {
  const db = getDb()
  const sets: string[] = ["updated_at = datetime('now','localtime')"]
  const args: Array<string | number | null> = []

  if (patch.status !== undefined) {
    sets.push('status = ?')
    args.push(patch.status)
  }
  if (patch.stage !== undefined) {
    sets.push('stage = ?')
    args.push(patch.stage)
  }
  if (patch.percent !== undefined) {
    // 百分比只允许往前走。并发更新时后写的一方可能拿着旧值，退步比不动更糟。
    sets.push('percent = MAX(percent, ?)')
    args.push(Math.max(0, Math.min(100, Math.round(patch.percent))))
  }
  if (patch.message !== undefined) {
    sets.push('message = ?')
    args.push(patch.message)
  }
  if (patch.error !== undefined) {
    sets.push('error = ?')
    args.push(patch.error)
  }
  if (patch.resultJson !== undefined) {
    sets.push('result_json = ?')
    args.push(patch.resultJson)
  }
  if (patch.filePath !== undefined) {
    sets.push('file_path = ?')
    args.push(patch.filePath)
  }
  if (patch.started) {
    sets.push("started_at = COALESCE(started_at, datetime('now','localtime'))")
  }
  if (patch.finished) {
    sets.push("finished_at = datetime('now','localtime')")
  }

  args.push(id)
  db.prepare(`UPDATE ingest_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...args)
}

/**
 * 把上次进程留下的 running / queued 任务标记为中断。
 *
 * dev server 重启会让跑了一半的任务失去执行者，此时行里仍是 running。不修的
 * 后果是前端轮询到一条永远 running 的任务，而它背后没有任何人在干活。
 * 幂等，每次进程启动跑一次。
 */
export function markInterruptedJobs(): number {
  const r = getDb()
    .prepare(
      `UPDATE ingest_jobs
       SET status = 'error',
           error = '服务重启，任务被中断，请重新入库',
           message = '已中断',
           finished_at = datetime('now','localtime'),
           updated_at = datetime('now','localtime')
       WHERE status IN ('queued', 'running')`,
    )
    .run()
  return r.changes
}

/** 还没终态的任务 id。重启后这些必然是被中断的那批。 */
export function unfinishedJobIds(): number[] {
  const rows = getDb()
    .prepare("SELECT id FROM ingest_jobs WHERE status IN ('queued','running','uploading') ORDER BY id ASC")
    .all() as Array<{ id: number }>
  return rows.map((r) => r.id)
}

/**
 * 入库页右栏队列要的数据：全部进行中的任务，外加**刚结束不久**的几条。
 *
 * 「刚结束不久」由时间窗决定，见 queueWindow。这里曾写死「最近 5 条已结束」而
 * 没有任何时间约束，后果是完成的任务一直挂在那里：队列本该是「现在有什么事」的
 * 告示，不是历史记录，挂着的已完成条目会让下一次上传时用户分不清哪条是新的。
 *
 * 窗口是 SQL 条件而不是前端过滤，理由见 finishedWindowSql 的注释：finished_at 是
 * 服务端写的本地时间字符串，交给 JS 解析在不同引擎下取值不一致，会算出差几个小时的
 * 剩余时间，任务要么秒删要么永不消。
 *
 * 不按批次查：队列不知道当前批次是哪个，而「有没有任务在跑」不该依赖用户正停在
 * 哪个页面。批次视角由入库页左栏的上传面板承担。
 */
export function listQueue(activeLimit = 20, recentLimit = 5): JobRow[] {
  const db = getDb()
  const active = db
    .prepare(
      `SELECT * FROM ingest_jobs WHERE status IN ('uploading','queued','running')
       ORDER BY id ASC LIMIT ?`,
    )
    .all(activeLimit) as JobRow[]
  const windowSql = finishedWindowSql()
  const recent = db
    .prepare(
      `SELECT * FROM ingest_jobs WHERE status IN ('done','error','canceled')
       ${windowSql}
       ORDER BY id DESC LIMIT ?`,
    )
    .all(finishedWindowArg(), recentLimit) as JobRow[]
  // 进行中的在前（按提交顺序），已结束的在后（新的在前）
  return [...active, ...recent.reverse()]
}

/** 只留最近 200 条，任务表不是审计日志。 */
export function pruneJobs(): void {
  getDb()
    .prepare(
      `DELETE FROM ingest_jobs WHERE id NOT IN (
         SELECT id FROM ingest_jobs ORDER BY id DESC LIMIT 200
       )`,
    )
    .run()
}
