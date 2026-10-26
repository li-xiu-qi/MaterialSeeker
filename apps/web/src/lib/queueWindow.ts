/**
 * 后台任务队列的可见时间窗。**从 jobs.ts 抽出来，只为可测。**
 *
 * jobs.ts 顶层 import better-sqlite3（经 db.ts），那是 native module，在没编译过的
 * 环境里装不上也加载不了。而这个模块要守的几条规则恰好都是纯字符串运算，值得
 * 被断言：时间窗丢了、修饰符写错、NULL 没挡，三种都只在真实运行一段时间后
 * 才现形，且前两种在界面上表现为「任务不消失」，很难往 SQL 上想。
 *
 * 搬过来的只有 SQL 片段与常数，不碰 db。
 */

/**
 * 终态任务在队列里停留的秒数。**完成不是罪，挂着的已完成任务才是。**
 *
 * 这个窗口要同时满足两个方向，所以它存在：
 *
 * 一，**不能瞬间消失**。视频入库要好几分钟，用户等完最想确认的就是「成功了没」。
 *   进度条一归零那一行就没了，人反而要跑去素材库翻，不确定刚才那一下到底进没进。
 *
 * 二，**不能一直挂着**。队列是「现在有什么事」的告示，不是历史记录。已完成条目
 *   留在里面会让下一次上传时用户分不清哪条是新的，也会让这个小面板长期占着一块
 *   与当前无关的内容。用户明确指出过「后台任务完成之后应该给他清掉」。
 *
 * 120 秒是这两个方向的折中：长 enough 让人看见成功反馈，短 enough 不会变成
 * 常驻噪音。它不是调度执行，不影响任务本身跑多久。
 */
export const FINISHED_TTL_SECONDS = 120

/**
 * 终态任务的时间窗条件。**拼在已有 WHERE 之后，以 AND 开头。**
 *
 * 三个部分各有理由，少一个都会坏：
 *
 * 1. `finished_at IS NOT NULL`：终态行理论上都由 updateJob({finished:true}) 补了
 *    结束时间，但老数据与异常路径不保证。NULL 参与任何比较都得 NULL，等于把这行
 *    永久滤掉——用户看到的是「任务凭空消失」，比挂着更难排查。
 *
 * 2. `datetime('now','localtime', ?)` 而不是在前端比时间戳：finished_at 是服务端
 *    用 `datetime('now','localtime')` 写的本地时间字符串（无时区标记）。交给 JS
 *    解析这种「YYYY-MM-DD HH:MM:SS」空格分隔的形式，不同引擎的取值不一致，算出来
 *    的剩余时间可能差几个小时，任务要么秒删要么永不消。在 SQL 里比，两边同源，
 *    且字符串字典序与时间序一致。
 *
 * 3. 参数是 `-N seconds` 修饰符，不是秒数。SQLite 的 modifier 语法只认这个形式，
 *    传数字 120 会被当成非法修饰符而 silently 忽略，窗口变成「永远可见」——
 *    那种失效不报错，只是功能没了。
 */
export function finishedWindowSql(): string {
  return `AND finished_at IS NOT NULL AND finished_at > datetime('now','localtime', ?)`
}

/** 给上面那个 ? 的绑定值。单独导出，是为了调用方不必知道 modifier 的拼法 */
export function finishedWindowArg(ttlSeconds: number = FINISHED_TTL_SECONDS): string {
  return `-${Math.max(1, Math.trunc(ttlSeconds))} seconds`
}
