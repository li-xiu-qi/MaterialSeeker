import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  analyzeBatch,
  analyzeImage,
  applyAnalysis,
  AnalyzeRateLimitError,
  type AnalyzeResult,
} from './analyze'

/**
 * 图片 AI 标注。**db 与 embedding 全部 mock 掉**：这个文件要断言的是写库规则
 * （标题只填空缺、语料必须含标签、描述没变也要重算向量、一张失败不连坐），
 * 它们全在分支里，而真实走一遍要连视觉模型又要连 embedding 服务，
 * 测的就不是规则而是网络了。
 */

type Row = Record<string, unknown> | undefined

const encodeBatch = vi.fn(
  async (_req: { inputs: Array<{ modality: string; text: string; instruction?: string }> }) => [
    new Float32Array([0.1, 0.2, 0.3]),
  ],
)

vi.mock('./embed', () => ({
  PASSAGE_INSTRUCTION: ' Represent this text for retrieval.',
  embeddingEnabled: () => true,
  encodeBatch: (req: unknown) => encodeBatch(req as never),
}))

const getDb = vi.fn()
const embeddingToBlob = vi.fn((v: Float32Array) => Buffer.from(v.buffer))

vi.mock('./db', () => ({
  getDb: () => getDb(),
  embeddingToBlob: (v: Float32Array) => embeddingToBlob(v),
}))

interface FakeDb {
  prepare: (sql: string) => {
    get: (...a: unknown[]) => Row
    run: (...a: unknown[]) => { changes: number }
  }
  runLog: Array<{ sql: string; args: unknown[] }>
}

/**
 * 造一个按 SQL 内容分发的假 db。
 *
 * 按 `includes` 匹配而不是按调用序号：applyAnalysis 里查 assets、查 images、
 * UPDATE 三步的次序是实现细节，测试跟着序号走的话，实现里加一句无关查询就全红。
 * 按 SQL 内容认，改次序不影响断言。
 */
function fakeDb(rows: { asset?: Row; image?: Row; byPath?: Record<number, string> }): FakeDb {
  const runLog: FakeDb['runLog'] = []
  return {
    runLog,
    prepare(sql: string) {
      const get = (...a: unknown[]) => {
        // analyzeBatch 按 id 查 source_path，id 是第一个参数
        if (sql.includes('source_path')) return { source_path: rows.byPath?.[Number(a[0])] }
        if (sql.includes('FROM assets')) return rows.asset
        if (sql.includes('FROM images')) return rows.image
        return undefined
      }
      return {
        get,
        run: (...args: unknown[]) => {
          runLog.push({ sql, args })
          return { changes: 1 }
        },
      }
    },
  }
}

function cap(over: Partial<AnalyzeResult> = {}): AnalyzeResult {
  return { title: '新标题', description: '一只猫在窗台上', tags: ['猫', '窗台'], ...over }
}

/** 取最近一次 encodeBatch 实际编码的文本。 */
function lastEncodedText(): string {
  const req = encodeBatch.mock.calls.at(-1)?.[0]
  return req?.inputs[0]?.text ?? ''
}

beforeEach(() => {
  encodeBatch.mockClear()
  embeddingToBlob.mockClear()
})

describe('applyAnalysis', () => {
  it('原标题是文件名时不动它，只补描述与标签', async () => {
    const db = fakeDb({ asset: { kind: 'image', title: 'IMG_20260101.png' }, image: { caption: null } })
    getDb.mockReturnValue(db)

    await applyAnalysis(7, cap())

    // AI 猜的标题没有用户的准。文件名好歹是条信息，覆盖它就丢了来源。
    expect(db.runLog.filter((r) => r.sql.includes('UPDATE assets SET title'))).toEqual([])
    expect(db.runLog.some((r) => r.sql.includes('UPDATE assets SET tags_json'))).toBe(true)
    expect(db.runLog.some((r) => r.sql.includes('UPDATE images SET caption'))).toBe(true)
  })

  it('标题为空时才填', async () => {
    const db = fakeDb({ asset: { kind: 'image', title: '   ' }, image: { caption: null } })
    getDb.mockReturnValue(db)

    await applyAnalysis(7, cap())

    const writes = db.runLog.filter((r) => r.sql.includes('UPDATE assets SET title'))
    expect(writes).toHaveLength(1)
    expect(writes[0].args).toEqual(['新标题', 7])
  })

  it('用户手写过的标题也不覆盖', async () => {
    const db = fakeDb({ asset: { kind: 'image', title: '我拍的猫' }, image: { caption: null } })
    getDb.mockReturnValue(db)

    await applyAnalysis(7, cap())

    expect(db.runLog.filter((r) => r.sql.includes('UPDATE assets SET title'))).toEqual([])
  })

  it('明确允许时才覆盖标题', async () => {
    const db = fakeDb({ asset: { kind: 'image', title: '我拍的猫' }, image: { caption: null } })
    getDb.mockReturnValue(db)

    await applyAnalysis(7, cap(), { overwriteTitle: true })

    expect(db.runLog.filter((r) => r.sql.includes('UPDATE assets SET title'))).toHaveLength(1)
  })

  it('编码语料是描述加标签，标签不能被漏掉', async () => {
    const db = fakeDb({ asset: { kind: 'image', title: '' }, image: { caption: null } })
    getDb.mockReturnValue(db)

    await applyAnalysis(7, cap())

    // 标签本来是填来被搜的。只编码描述的结果是标签词从语料里消失，
    // 而用户以为打了标签就能搜到。
    const text = lastEncodedText()
    expect(text).toContain('猫')
    expect(text).toContain('窗台')
    expect(text).toContain('一只猫在窗台上')
  })

  it('描述没变但标签变了，向量仍要重算', async () => {
    const db = fakeDb({
      asset: { kind: 'image', title: '' },
      image: { caption: '一只猫在窗台上' },
    })
    getDb.mockReturnValue(db)

    await applyAnalysis(7, cap())

    // 走的是「只更新向量」那一支：caption 列不变，caption_embedding 必须变。
    // 漏了这条的故障是「标签加了却搜不到」，没有任何提示。
    expect(db.runLog.filter((r) => r.sql.includes('caption_embedding')).length).toBeGreaterThan(0)
    expect(db.runLog.some((r) => r.sql.includes('UPDATE images SET caption ='))).toBe(false)
  })

  it('非图片直接拒', async () => {
    getDb.mockReturnValue(fakeDb({ asset: { kind: 'video', title: '' } }))
    await expect(applyAnalysis(7, cap())).rejects.toThrow('只有图片能标注画面')
  })

  it('素材不存在直接拒', async () => {
    getDb.mockReturnValue(fakeDb({ asset: undefined }))
    await expect(applyAnalysis(7, cap())).rejects.toThrow('素材不存在')
  })
})

describe('analyzeBatch', () => {
  it('一张失败不影响其它张，且失败带原因', async () => {
    // analyzeImage 只做一次 fetch，按请求体里的图片路径决定成败
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { image_path?: string }
        if (body.image_path === '/bad.png') return new Response('读图失败', { status: 500 })
        return new Response(JSON.stringify(cap()), { status: 200 })
      }),
    )

    const db = fakeDb({
      byPath: { 1: '/ok1.png', 2: '/bad.png', 3: '/ok3.png' },
      asset: { kind: 'image', title: '' },
      image: { caption: null },
    })
    getDb.mockReturnValue(db)

    const progress: Array<[number, number, string]> = []
    const r = await analyzeBatch([1, 2, 3], (d, t, c) => progress.push([d, t, c]))

    expect(r.ok.map((x) => x.assetId)).toEqual([1, 3])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]).toMatchObject({ assetId: 2 })
    expect(r.failed[0].error).toContain('标注服务 500')
    // 每张都报一次进度，失败的也报：用户要能看到第几张失败了
    expect(progress.map((p) => p[0])).toEqual([1, 2, 3])
    vi.unstubAllGlobals()
  })

  it('空列表什么都不做', async () => {
    const r = await analyzeBatch([])
    expect(r).toEqual({ ok: [], failed: [] })
  })
})

/**
 * 限流重试。**退避全部注入不等的 sleep**：五次重试合计约 30 秒，真等就是把测试
 * 跑成半小时，而这些用例要断言的是重试的次数与节奏，不是等待本身。
 */
describe('analyzeImage 的限流重试', () => {
  /** 记下每次退避等了多久，返回一个真的不耗时的 sleep。 */
  function recordingSleep() {
    const waits: number[] = []
    return {
      waits,
      sleep: async (ms: number) => {
        waits.push(ms)
      },
    }
  }

  it('429 之后退避重试，等通过为止', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        // 前两次撞上限流，第三次窗口过去了
        if (calls <= 2) return new Response('该模型当前访问量过大', { status: 429 })
        return new Response(JSON.stringify(cap()), { status: 200 })
      }),
    )
    const { waits, sleep } = recordingSleep()

    const r = await analyzeImage('/a.png', { sleep })

    expect(r.title).toBe('新标题')
    expect(calls).toBe(3)
    expect(waits).toHaveLength(2)
    vi.unstubAllGlobals()
  })

  it('最多试五次，不会无限重试', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        return new Response('该模型当前访问量过大', { status: 429 })
      }),
    )
    const { sleep } = recordingSleep()

    await expect(analyzeImage('/a.png', { sleep })).rejects.toBeInstanceOf(AnalyzeRateLimitError)
    expect(calls).toBe(5)
    vi.unstubAllGlobals()
  })

  it('重试耗尽给的是一句人话，不把上游 JSON 糊到界面上', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('该模型当前访问量过大', { status: 429 })),
    )
    const { sleep } = recordingSleep()

    await expect(analyzeImage('/a.png', { sleep })).rejects.toThrow('模型繁忙')
    vi.unstubAllGlobals()
  })

  it('500 不重试，一次就失败', async () => {
    // 图片损坏、模型没返回内容都属于这一类，重试一遍还是同样坏，白等一倍时间。
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        return new Response('读图失败', { status: 500 })
      }),
    )
    const { sleep } = recordingSleep()

    await expect(analyzeImage('/a.png', { sleep })).rejects.toThrow('标注服务 500')
    expect(calls).toBe(1)
    vi.unstubAllGlobals()
  })

  it('退避翻倍增长、有上限、带抖动', async () => {
    // 不带抖动的话，批量里前后脚撞同一个窗口的几张会在同一秒一起重试，
    // 把刚刚散开的压力又攒成一个尖峰。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('该模型当前访问量过大', { status: 429 })),
    )
    const { waits, sleep } = recordingSleep()

    await expect(analyzeImage('/a.png', { sleep })).rejects.toThrow()

    expect(waits).toHaveLength(4)
    waits.forEach((ms, i) => {
      const base = Math.min(2000 * 2 ** i, 20000)
      expect(ms).toBeGreaterThanOrEqual(Math.round(base * 0.75))
      expect(ms).toBeLessThanOrEqual(Math.round(base * 1.25))
    })
    vi.unstubAllGlobals()
  })

  it('退避的原因会报进进度，用户知道它在等而不是卡死', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++
        if (calls === 1) return new Response('该模型当前访问量过大', { status: 429 })
        return new Response(JSON.stringify(cap()), { status: 200 })
      }),
    )
    const db = fakeDb({
      byPath: { 1: '/a.png' },
      asset: { kind: 'image', title: '' },
      image: { caption: null },
    })
    getDb.mockReturnValue(db)

    const seen: Array<{ done: number; current: string; note?: string }> = []
    await analyzeBatch([1], (d, _t, c, n) => seen.push({ done: d, current: c, note: n }), {
      sleep: async () => {},
    })

    const waiting = seen.filter((s) => s.note)
    expect(waiting).toHaveLength(1)
    expect(waiting[0].note).toContain('模型繁忙')
    // 退避时这一张还没完成，done 不能提前加一
    expect(waiting[0].done).toBe(0)
    vi.unstubAllGlobals()
  })
})
