import { getDb } from './db'

/**
 * 素材库（collection）的增删查与作用域。
 *
 * 库存在的理由是检索作用域：没有它每次检索都是全表，素材一多就只有变慢
 * 一条路。一个素材归属且只归属一个库，这是刻意的简化，多归属看着灵活，
 * 实际会把「这个素材到底算哪边的」变成每次都要重新判断的问题。
 *
 * 默认库 id 固定为 1（见 db.ts 的 migrateCollections），不允许删：删了它
 * 存量素材的 collection_id 就悬空，而默认库恰恰是兜底的那个。
 */

export const DEFAULT_COLLECTION_ID = 1

/**
 * 「全部库」的哨兵值。用 0 而不是 null 或字符串，是因为它要能和普通 id 一样
 * 流经 SQL 参数与 URL 查询串，0 不可能与自增主键撞上。
 */
export const ALL_COLLECTIONS = 0

export interface Collection {
  id: number
  name: string
  createdAt: string
  video: number
  image: number
  text: number
}

export function listCollections(): Collection[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.created_at,
              (SELECT count(*) FROM assets a WHERE a.collection_id = c.id AND a.kind='video') AS video,
              (SELECT count(*) FROM assets a WHERE a.collection_id = c.id AND a.kind='image') AS image,
              (SELECT count(*) FROM assets a WHERE a.collection_id = c.id AND a.kind='text') AS text
       FROM collections c ORDER BY c.id`,
    )
    .all() as Array<{
    id: number
    name: string
    created_at: string
    video: number
    image: number
    text: number
  }>

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    video: r.video,
    image: r.image,
    text: r.text,
  }))
}

export function getCollection(id: number): Collection | null {
  return listCollections().find((c) => c.id === id) ?? null
}

/** 素材总数，用于判断一个库是不是空的 */
export function collectionSize(id: number): number {
  const db = getDb()
  const row = db
    .prepare('SELECT count(*) AS n FROM assets WHERE collection_id = ?')
    .get(id) as { n: number }
  return row.n
}

export function createCollection(name: string): number {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('素材库名称不能为空')
  if (trimmed.length > 40) throw new Error('素材库名称太长（上限 40 字）')

  const db = getDb()
  const exist = db.prepare('SELECT id FROM collections WHERE name = ?').get(trimmed) as
    | { id: number }
    | undefined
  if (exist) throw new Error(`已存在同名素材库「${trimmed}」`)

  const r = db.prepare('INSERT INTO collections (name) VALUES (?)').run(trimmed)
  return Number(r.lastInsertRowid)
}

export function renameCollection(id: number, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('素材库名称不能为空')
  const db = getDb()
  const exist = db.prepare('SELECT id FROM collections WHERE name = ? AND id != ?').get(trimmed, id)
  if (exist) throw new Error(`已存在同名素材库「${trimmed}」`)
  db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(trimmed, id)
}

/**
 * 删素材库。只允许删空库：非空时先让用户把素材移走或删掉，否则一堆素材的
 * collection_id 会指向不存在的库，按库过滤时它们凭空消失且查不到原因。
 */
export function deleteCollection(id: number): void {
  if (id === DEFAULT_COLLECTION_ID) throw new Error('默认库不能删除')
  const n = collectionSize(id)
  if (n > 0) {
    throw new Error(`这个库还有 ${n} 条素材，先把它们移走或删除`)
  }
  getDb().prepare('DELETE FROM collections WHERE id = ?').run(id)
}

/**
 * 校验作用域参数。前端传来的 lib 可能是任意字符串，这里归一成合法值。
 * 'all' 归一成 ALL_COLLECTIONS，其余非法值一律回落到默认库——不让它变成
 * SQL 注入面，也不让它悄悄搜出空结果还查不出原因。
 */
export function normalizeCollectionId(raw: string | number | undefined | null): number {
  if (raw === 'all') return ALL_COLLECTIONS
  if (raw === undefined || raw === null || raw === '') return DEFAULT_COLLECTION_ID
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_COLLECTION_ID
  return getCollection(n) ? n : DEFAULT_COLLECTION_ID
}

/**
 * 作用域的 SQL 条件与参数。**所有按库过滤的查询都用这两个函数**，不要各自
 * 拼字符串：拼漏一次就是「选了全部却还在按库过滤」，而这种错不会有任何报错，
 * 只是结果莫名变少，属于最难查的那类。
 */
export function scopeClause(collectionId: number): string {
  return collectionId === ALL_COLLECTIONS ? '' : 'AND a.collection_id = ?'
}

export function scopeArgs(collectionId: number): number[] {
  return collectionId === ALL_COLLECTIONS ? [] : [collectionId]
}

/** 作用域的展示名，界面与文案共用 */
export function scopeLabel(collectionId: number): string {
  if (collectionId === ALL_COLLECTIONS) return '全部库'
  return getCollection(collectionId)?.name ?? '默认库'
}
