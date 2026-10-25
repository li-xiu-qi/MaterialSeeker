import { describe, expect, it } from 'vitest'
import { asrEngineLabel } from './asrEngine'

describe('asrEngineLabel', () => {
  it('区分云端、现成字幕与本地 ASR', () => {
    expect(asrEngineLabel('siliconflow')).toBe('xingchen-asr-v3.2')
    expect(asrEngineLabel('subtitle')).toBe('srt-subtitle')
    expect(asrEngineLabel('local')).toBe('funasr-paraformer-zh')
    expect(asrEngineLabel(undefined)).toBe('funasr-paraformer-zh')
  })
})
