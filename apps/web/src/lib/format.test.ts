import { describe, expect, it } from 'vitest'
import { fmtMs, fmtScore, typeLabel, sourceLabel } from './format'

/**
 * 展示格式化的回归。这个文件另有守卫作用：format.ts 的注释明写**不能 import
 * 任何 node 内置模块**，因为它被客户端组件引用，node:fs 进 bundle 会让
 * Turbopack panic。这些测试本身就是那条约束的探针——一旦有人加了一个
 * node 依赖进来，import 阶段就会炸，而不是等到用户在浏览器里看到 500。
 */

describe('fmtMs', () => {
  it('毫秒转 m:ss，秒数补零', () => {
    expect(fmtMs(0)).toBe('0:00')
    expect(fmtMs(9000)).toBe('0:09')
    expect(fmtMs(59500)).toBe('0:59')
    expect(fmtMs(60000)).toBe('1:00')
    expect(fmtMs(212000)).toBe('3:32')
  })

  it('不足一秒按 0 秒，不出现负数', () => {
    // 句子边界calibration 可能给出毫秒差值，向下取整比四舍五入安全
    expect(fmtMs(999)).toBe('0:00')
    expect(fmtMs(-1)).toBe('0:00')
  })

  it('超过一小时继续按分钟累加，不截断', () => {
    expect(fmtMs(3_600_000)).toBe('60:00')
  })
})

describe('fmtScore', () => {
  it('余弦值转百分数并取整', () => {
    expect(fmtScore(0.863)).toBe('86%')
    expect(fmtScore(0)).toBe('0%')
    expect(fmtScore(1)).toBe('100%')
  })

  it('取整而不是截断，0.879 该是 88% 不是 87%', () => {
    expect(fmtScore(0.879)).toBe('88%')
  })
})

describe('typeLabel', () => {
  it('内部字段名不裸露到界面', () => {
    // 这三个英文名是数据库与路由里的字面量，界面上出现即回归
    expect(typeLabel('chunk')).toBe('台词')
    expect(typeLabel('frame')).toBe('关键帧')
    expect(typeLabel('image')).toBe('图片')
  })

  it('未知类型原样返回，不显示 undefined', () => {
    expect(typeLabel('something_new')).toBe('something_new')
  })
})

describe('sourceLabel', () => {
  it('四条向量路各有各的中文名，不能混', () => {
    // 用户靠这几行字区分「这句话是语义命中的还是关键词命中的」
    expect(sourceLabel('vector')).toBe('语义匹配')
    expect(sourceLabel('keyword')).toBe('关键词')
    expect(sourceLabel('frame_vector')).toBe('画面')
    expect(sourceLabel('caption_vector')).toBe('画面描述')
    expect(sourceLabel('image_vector')).toBe('图片')
  })

  it('四个名字互不相同', () => {
    const names = ['vector', 'keyword', 'frame_vector', 'caption_vector', 'image_vector'].map(
      sourceLabel,
    )
    expect(new Set(names).size).toBe(names.length)
  })

  it('未知来源原样返回', () => {
    expect(sourceLabel('whatever')).toBe('whatever')
  })
})
