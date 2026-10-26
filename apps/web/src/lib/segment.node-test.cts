/**
 * 中文关键词检索（FTS5 索引侧分词）的自包含功能测试。
 *
 * 用 Node 内置 node:test 而不是项目的 vitest，原因：本机 node_modules 处在
 * 半装状态（npmmirror 的 rolldown binding packument 畸形触发 npm semver bug，
 * 完整 npm install 装不上，vitest 跑不起来），而这个链路必须当场验证。
 * 待 npm install 修复后可以同价改写成 vitest 用例，断言不变。
 *
 * 覆盖四件事：
 *   1. 中文连续查询命中（本次改造的核心行为，改造前恒零命中）
 *   2. 英文与数字不回归（改造前就正常的形态不能被改坏）
 *   3. 触发器同步：INSERT chunk 后 FTS 行是分词文本且能查到
 *   4. 迁移幂等：旧触发器换新版 + 索引重建，跑第二次空跑
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { ensureSegFunction, segForIndex, segForQuery, toFtsMatch } from './segment'
import { migrateFtsSegmentation } from './db'

/** 建一个带旧版触发器（裸 new.text）的库，模拟升级前的真实状态。 */
function makeOldDb(): Database.Database {
  const d = new Database(':memory:')
  ensureSegFunction(d) // 旧库启动时也注册（getDb 的逻辑），迁移判据只看 DDL
  d.exec(`
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id');
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
  `)
  d.prepare('INSERT INTO chunks(text) VALUES (?)').run('滑板少年在草地上表演，背景有城市建筑')
  d.prepare('INSERT INTO chunks(text) VALUES (?)').run('Paraformer 是中文语音识别模型，RTF 0.16')
  return d
}

function ftsHits(d: Database.Database, query: string): number {
  const tokens = segForQuery(query)
  if (!tokens.length) return 0
  return (
    d
      .prepare('SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?')
      .get(toFtsMatch(tokens)) as { n: number }
  ).n
}

test('中文连续查询命中（无空格整句）', () => {
  const d = makeOldDb()
  migrateFtsSegmentation(d)
  assert.ok(ftsHits(d, '滑板草地') >= 1, '2 字词组合应命中')
  assert.ok(ftsHits(d, '城市建筑') >= 1, '另一个 2 字词应命中')
  assert.ok(ftsHits(d, '语音识别模型') >= 1, '4 字连续查询应命中')
})

test('英文与数字不回归', () => {
  const d = makeOldDb()
  migrateFtsSegmentation(d)
  assert.equal(ftsHits(d, 'Paraformer'), 1)
  assert.equal(ftsHits(d, 'RTF'), 1)
  assert.equal(ftsHits(d, '0.16'), 1)
})

test('近似负样本：完全无关的词不误报', () => {
  const d = makeOldDb()
  migrateFtsSegmentation(d)
  assert.equal(ftsHits(d, ' completely different words'), 0)
  assert.equal(ftsHits(d, '量子纠缠拓扑'), 0, '语料里没有的词不命中')
})

test('OR 语义边界：查询与文档共享任一子词即命中（记录在案的行为）', () => {
  const d = makeOldDb()
  migrateFtsSegmentation(d)
  // 「滑雪少年」与语料「滑板少年…」共享子词「少年」，OR 语义下会命中。
  // 这是 keyword 路的既定形态（不是缺陷）：精度靠 bm25 排序与向量路兜底，
  // FTS5 OR 的定位是宽召回。写下来防止后来者当 bug 修。
  assert.equal(ftsHits(d, '滑雪少年'), 1)
})

test('触发器同步：新插入的 chunk 自动进索引', () => {
  const d = makeOldDb()
  migrateFtsSegmentation(d)
  d.prepare('INSERT INTO chunks(text) VALUES (?)').run('一只小猫坐在窗台上晒太阳')
  assert.equal(ftsHits(d, '小猫窗台'), 1, '插入后应立即可查（索引侧已分词）')
  // external content 语义：fts 的 text 列经 content 表取回的是原文，不是索引里
  // 存的分词文本。所以「索引里是什么」只能用查询行为验证，不能读 text 列。
  const joined = d
    .prepare(
      'SELECT c.text AS t FROM chunks_fts f JOIN chunks c ON c.id = f.rowid WHERE f.chunks_fts MATCH ?',
    )
    .get(toFtsMatch(segForQuery('小猫窗台'))) as { t: string }
  assert.equal(joined.t, '一只小猫坐在窗台上晒太阳', 'JOIN 主表取回的是原文')
})

test('触发器同步：更新后旧词失效，新词立即可查', () => {
  const d = makeOldDb()
  migrateFtsSegmentation(d)
  const row = d.prepare('SELECT id FROM chunks ORDER BY id LIMIT 1').get() as { id: number }
  d.prepare('UPDATE chunks SET text = ? WHERE id = ?').run('一只小狗在阳台上睡觉', row.id)
  assert.equal(ftsHits(d, '滑板草地'), 0, '更新前的中文词不能残留在索引里')
  assert.equal(ftsHits(d, '小狗阳台'), 1, '更新后的中文词应立即命中')
})

test('触发器同步：删除后中文词不再命中，其他行不受影响', () => {
  const d = makeOldDb()
  migrateFtsSegmentation(d)
  const row = d.prepare('SELECT id FROM chunks ORDER BY id LIMIT 1').get() as { id: number }
  d.prepare('DELETE FROM chunks WHERE id = ?').run(row.id)
  assert.equal(ftsHits(d, '滑板草地'), 0, '删除行的中文词不能残留')
  assert.equal(ftsHits(d, 'Paraformer'), 1, '其他行仍在索引里')
})

test('迁移幂等：第二次空跑不重复重建', () => {
  const d = makeOldDb()
  migrateFtsSegmentation(d)
  const before = (d.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get() as { n: number }).n
  const sql1 = (
    d.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_ai'").get() as { sql: string }
  ).sql
  migrateFtsSegmentation(d)
  const after = (d.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get() as { n: number }).n
  const sql2 = (
    d.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_ai'").get() as { sql: string }
  ).sql
  assert.equal(before, after, '行数不变')
  assert.equal(sql1, sql2, '触发器定义没被二次重建改动')
})

test('segForQuery 对纯停用词返回空（调用方据此跳过 FTS）', () => {
  assert.deepEqual(segForQuery('的了在是一'), [])
  assert.ok(segForQuery('滑板').length >= 1)
  assert.ok(segForIndex('滑板少年在草地上').split(/\s+/).length >= 2, '索引侧应切成多个 token')
})
