/**
 * 中文分词：FTS5 关键词路的「同一把刀」。
 *
 * 背景：SQLite FTS5 默认 unicode61 tokenizer 不给中文分词，连续中文被当成单个
 * 超长 token，索引侧切不开、查询侧也切不开，中文查询恒零命中（英文与数字
 * token 正常）。PRD 开放问题 1 的解法落地在这个文件。
 *
 * **索引侧与查询侧必须用同一个函数**，理由与 instruction 两侧一致：两处各写
 * 一把刀的结果是同义词进不了同一空间，检索表现为「明明有的词搜不到」，且没有
 * 任何报错。这里是唯一入口，触发器（索引侧）与 search.ts（查询侧）都调它。
 *
 * 选型对比（2026-10-08 实测，Spark 真实库 174 条语料）：
 * - trigram tokenizer：查询与索引都要求至少 3 字符，2 字中文词（最常用形态）
 *   全部查不了，20 个高频真实词只命中 1 个（唯一 3 字词）。否掉。
 * - 索引侧分词（本方案）：20/20 全命中，2 字词 8/8，连续中文整句 5/5，
 *   近似负样本 0 误报，英文数字 6/6 不回归，索引体积比现状只大 11%
 *   （trigram 是 2.4 倍）。
 * - Node 侧切分器用 segmentit（纯 JS 零原生依赖），与 Python jieba 的召回
 *   一致性实测：20 个高频查询两边全部命中，交集覆盖 segmentit 全量命中，
 *   jieba 仅多 3 条；单字 token 占比 36.3% 对 32.2%，可接受。
 */

import Database from 'better-sqlite3'

// segmentit 是 CJS 包（module.exports 对象，无 __esModule 标记、无 default）。
// **只用 namespace import 一种形态**：tsc 编 CJS 后它是 __importStar 包装的
// 属性集合，webpack（Next 构建）下它是 module.exports 的属性集合，两边都能从
// 上面取到 Segment 与 useDefault。曾经试过同时 import default，webpack 直接报
// 「Export default doesn't exist in target module」，而那是致命错误不是警告。
import * as segmentitNs from 'segmentit'

type SegModule = {
  Segment?: typeof import('segmentit').Segment
  useDefault?: typeof import('segmentit').useDefault
}

const resolved = (segmentitNs as unknown as SegModule) ?? {}
const Segment: SegModule['Segment'] = resolved.Segment
const createSegment: SegModule['useDefault'] = resolved.useDefault

type SegInstance = { doSegment: (text: string, opts?: { simple?: boolean }) => string[] }

let segInstance: SegInstance | null = null

function getSeg(): SegInstance {
  if (!segInstance) {
    if (!Segment || !createSegment) {
      throw new Error('segmentit 加载失败：Segment/useDefault 未导出，检查依赖版本')
    }
    segInstance = createSegment(new Segment()) as SegInstance
  }
  // 上面两条分支覆盖了 null 的两种来源（未初始化与初始化失败会抛），
  // 这里断言给 TS：函数内窄化在闭包里不保留，不做这个断言每个调用点都要判空。
  return segInstance
}

/**
 * 停用词。**索引侧过滤它们**，否则「的」「了」这类字会以极高频率进索引，靠
 * bm25 的 idf 压是压不住的：idf 只降权不消权，一个只含停用词的查询（或切分
 * 后只剩停用词的查法）会命中一堆低分结果，把 keyword 路的信噪比拉低。
 *
 * 表与查询侧共用：查询侧同样先过滤，过滤后为空表示这次查询没有可分的实词，
 * 直接跳过 FTS（见 search.ts 的关键词路），不拿空串去 MATCH 报错。
 */
const STOPWORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '上', '也',
  '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看好', '自己', '这', '那',
  '他', '她', '它', '们', '个', '之', '于', '其', '为', '以及', '并', '或', '但是',
  '因为', '所以', '如果', '什么', '怎么', '可以', '就是', '还是', '然后', '现在',
  '时候', '已经', '一些', '一下', '这样', '那样', '出来', '起来', '过去', '对着',
])

/** 索引侧：切分并过滤停用词，返回空格分隔文本（FTS5 unicode61 的输入形态）。 */
export function segForIndex(text: string): string {
  if (!text) return ''
  return getSeg()
    .doSegment(text, { simple: true })
    .filter((w) => w.trim() && !STOPWORDS.has(w))
    .join(' ')
}

/**
 * 查询侧：同一把刀出来 token 数组。调用方负责拼 MATCH 语法（OR 加双引号转义）。
 * **返回空数组表示查询里没有实词**，调用方据此跳过关键词路：空串 MATCH 会抛
 * OperationalError，而「用户只打了语气词」不是错误，是不该查。
 */
export function segForQuery(text: string): string[] {
  if (!text) return []
  return getSeg()
    .doSegment(text, { simple: true })
    .filter((w) => w.trim() && !STOPWORDS.has(w))
}

/** 把 token 数组转成 FTS5 MATCH 串。双引号转义防注入语法字符。 */
export function toFtsMatch(tokens: string[]): string {
  return tokens.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ')
}

/**
 * 在数据库上注册 seg_zh 自定义函数，供 FTS 触发器调用。
 *
 * **为什么要自定义函数而不是写入侧各处显式切分**：chunks_fts 是 external
 * content 模式，触发器是唯一同步点。若改成各写入路径显式调 segForIndex 再插
 * FTS，任何一个新写入路径漏掉就是索引静默缺行，而 external content 没有一致性
 * 检查，查询照常返回别的行，现象是「有的内容搜不到」且无从定位。
 * SQLite 触发器里可以调 application-defined function（已实测验证），
 * deterministic 标记让 SQLite 知道它无副作用，可以放心用在触发器与索引里。
 */
export function ensureSegFunction(db: Database.Database): void {
  db.function('seg_zh', { deterministic: true }, (t: unknown) =>
    t == null ? '' : segForIndex(String(t)),
  )
}
