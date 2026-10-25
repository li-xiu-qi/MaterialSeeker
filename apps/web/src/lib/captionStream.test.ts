import { describe, expect, it } from 'vitest'
import {
  feedCaptionStream,
  shouldClearSelectionAfterRun,
  summarizeCaptionRun,
} from './captionStream'

/**
 * NDJSON 流式解析。**这里是纯函数，所以能把「一行被切成两半」这种真实会发生
 * 的输入直接写进用例**——用真实流测它得连视觉模型，而且分块点不可控。
 */
describe('feedCaptionStream', () => {
  it('一次一整行时当场解析出来', () => {
    const r = feedCaptionStream('', '{"type":"progress","done":1,"total":3,"current":"猫"}\n')
    expect(r.events).toEqual([{ kind: 'progress', value: { done: 1, total: 3, current: '猫' } }])
    expect(r.rest).toBe('')
  })

  it('一行被切成两半时，前半段留着不解析，拼上后才出', () => {
    // 直接 JSON.parse 前半段会抛 SyntaxError，而调用方会把它当成「标注失败」
    // 报给用户。真实原因是分块与行号无关，不是标注出了问题。
    const first = feedCaptionStream('', '{"type":"prog')
    expect(first.events).toEqual([])
    expect(first.rest).toBe('{"type":"prog')

    const second = feedCaptionStream(first.rest, 'ress","done":2,"total":3,"current":"狗"}\n')
    expect(second.events).toEqual([
      { kind: 'progress', value: { done: 2, total: 3, current: '狗' } },
    ])
    expect(second.rest).toBe('')
  })

  it('一个分块里有多行时全部解析，顺序不变', () => {
    const chunk =
      '{"type":"progress","done":1,"total":2,"current":"a"}\n' +
      '{"type":"progress","done":2,"total":2,"current":"b"}\n'
    const r = feedCaptionStream('', chunk)
    expect(r.events).toHaveLength(2)
    expect(r.events.map((e) => (e.kind === 'progress' ? e.value.done : -1))).toEqual([1, 2])
  })

  it('多行加一个半行，半行留在 rest', () => {
    const r = feedCaptionStream('', '{"type":"progress","done":1,"total":2,"current":"a"}\n{"type":"do')
    expect(r.events).toHaveLength(1)
    expect(r.rest).toBe('{"type":"do')
  })

  it('退避等待的 note 会被解析出来', () => {
    const line =
      '{"type":"progress","done":0,"total":3,"current":"#7","note":"模型繁忙，4 秒后重试"}\n'
    const r = feedCaptionStream('', line)
    expect(r.events).toEqual([
      {
        kind: 'progress',
        value: { done: 0, total: 3, current: '#7', note: '模型繁忙，4 秒后重试' },
      },
    ])
  })

  it('没有 note 的进度事件不带这个字段，不是空串', () => {
    // 必须整个省掉而不是给空串：前端靠「有没有值」决定显不显示，空串会让上一张的
    // 等待提示在下一张成功之后还挂在那里。
    const r = feedCaptionStream('', '{"type":"progress","done":1,"total":3,"current":"猫"}\n')
    const ev = r.events[0]
    expect(ev.kind === 'progress' && 'note' in ev.value).toBe(false)
  })

  it('done 事件带出成功数与失败明细', () => {
    const line =
      '{"type":"done","ok":2,"failed":[{"assetId":5,"error":"标注服务 500"},{"assetId":6,"error":"读图失败"}]}\n'
    const r = feedCaptionStream('', line)
    expect(r.events).toEqual([
      { kind: 'done', ok: 2, failed: [{ assetId: 5, error: '标注服务 500' }, { assetId: 6, error: '读图失败' }] },
    ])
  })

  it('fatal 事件带出原因', () => {
    const r = feedCaptionStream('', '{"type":"fatal","error":"推理服务没配 key"}\n')
    expect(r.events).toEqual([{ kind: 'fatal', error: '推理服务没配 key' }])
  })

  it('非 JSON 行不当异常抛，记为 garbage', () => {
    // 代理偶尔会在流里插一行自己的东西。抛异常的结果是整批标注被报成失败，
    // 而前几张其实已经写进库了。
    const r = feedCaptionStream('', 'Internal Server Error\n')
    expect(r.events).toEqual([{ kind: 'garbage', raw: 'Internal Server Error' }])
  })

  it('空行跳过，不当 garbage', () => {
    const r = feedCaptionStream('', '\n\n{"type":"progress","done":1,"total":1,"current":"x"}\n\n')
    expect(r.events).toHaveLength(1)
  })

  it('缺字段时给默认值，不出 NaN', () => {
    const r = feedCaptionStream('', '{"type":"progress"}\n')
    expect(r.events).toEqual([{ kind: 'progress', value: { done: 0, total: 0, current: '' } }])
  })

  it('未知 type 记 garbage 而不是静默丢弃', () => {
    const r = feedCaptionStream('', '{"type":"heartbeat"}\n')
    expect(r.events).toEqual([{ kind: 'garbage', raw: '{"type":"heartbeat"}' }])
  })

  it('中文按字符边界切分也能正确拼回', () => {
    // 流的分块不看字符边界，一个三字节汉字被切在两个分块之间是常态。
    // 这里模拟「字节被切开」：前半段是一个不完整的 JSON 串，拼上后中文要完整。
    const whole = '{"type":"progress","done":1,"total":1,"current":"日式店铺"}\n'
    const cut = 20
    const first = feedCaptionStream('', whole.slice(0, cut))
    expect(first.rest).toBe(whole.slice(0, cut))
    const second = feedCaptionStream(first.rest, whole.slice(cut))
    expect(second.events).toEqual([
      { kind: 'progress', value: { done: 1, total: 1, current: '日式店铺' } },
    ])
  })
})

describe('summarizeCaptionRun', () => {
  it('全成功只报数量', () => {
    expect(summarizeCaptionRun(3, [])).toBe('已标 3 张')
  })

  it('有失败时两个数都给', () => {
    expect(summarizeCaptionRun(2, [{ assetId: 5, error: 'x' }])).toBe('已标 2 张，失败 1 张')
  })

  it('一张都没成也要说清，不能显示空', () => {
    expect(summarizeCaptionRun(0, [{ assetId: 5, error: 'x' }])).toBe('已标 0 张，失败 1 张')
  })
})

describe('shouldClearSelectionAfterRun', () => {
  it('有成功就清勾选', () => {
    // 残留勾选的后果不是难看：工具条上「删除所选」对它依然有效，
    // 再点一次「AI 标注」会把同一批重跑一遍，白烧配额。
    expect(shouldClearSelectionAfterRun(1, [{ assetId: 5, error: 'x' }])).toBe(true)
  })

  it('全失败时留着，方便一键重试', () => {
    expect(shouldClearSelectionAfterRun(0, [{ assetId: 5, error: 'x' }])).toBe(false)
  })

  it('一张没勾（全被过滤掉）时无所谓，按清处理', () => {
    expect(shouldClearSelectionAfterRun(0, [])).toBe(false)
  })
})
