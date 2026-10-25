import Database from 'better-sqlite3'
import { PATHS } from './paths'
import { ensureSegFunction } from './segment'

/**
 * SQLite 单例。向量维度固定 768（EmbeddingGemma 2 原生维度）。
 * 改维度必须三处同步：推理仓 .env 的 MATERIALSEEKER_DIM、本文件、embed.ts 的
 * 校验；换模型则库里所有已存向量作废，必须全量重算。
 */
export const VECTOR_DIM = 768

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  db = new Database(PATHS.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  ensureSegFunction(db) // FTS 触发器调用它，必须先于任何 INSERT 就位
  initSchema(db)
  migrateCollections(db)
  migrateKinds(db)
  initAudioFiles(db)
  migrateFtsSegmentation(db)
  return db
}

/**
 * 幂等迁移。目前两笔：
 *
 * 1. collection_id：旧库没有库的概念。CREATE TABLE IF NOT EXISTS 不会给已存在
 *    的表加列，所以必须单独做，否则升级后旧库 assets 没有 collection_id，
 *    所有按库过滤的 SQL 直接报错。做法：缺列就加（默认 1，指向默认库），
 *    确保默认库存在，再把游离行收编。
 * 2. tags_json：标签。同理，IF NOT EXISTS 不会补列，而标签入库与检索都读它。
 *
 * 幂等，每次启动都跑，重复跑没有副作用。
 */
/**
 * 两张表的 kind 都放开为不限枚举（assets 与 ingest_jobs），并建 audio_files 表。
 *
 * **为什么重建表而不是 ALTER**：SQLite 的 ALTER TABLE 只能加列、不能改 CHECK，
 * 而 kind 上原本挂着 `CHECK (kind IN ('video','image','text'))`，不加 audio
 * 这一列就插不进音频素材。改 CHECK 只有重建一条路。
 *
 * **为什么不保留 CHECK 只把 audio 补进枚举**：加第五种模态时还要再重建一次。
 * 重建父表的代价不是写这几行 DDL，是下面那一串 foreign_keys 开关与拷贝——四张
 * 子表（transcripts/frames/images/text_notes）都 REFERENCES assets(id) ON DELETE
 * CASCADE，而 **foreign_keys=ON 时 DROP 父表会级联清空子表**，这不是假设，是
 * SQLite 文档写明的隐式 DELETE FROM 行为。所以重建必须关外键、包事务、再开回来，
 * 少一步就是一次数据事故。为了少一次这种事故，枚举改由这里注释与 AssetKind
 * 类型集中声明，CHECK 不再承担这件事。
 *
 * 幂等判据是 sqlite_master 里的建表 SQL 还含不含 CHECK：含就重建，不含就跳过。
 * 每次启动都跑，正常启动第二次起都是空跑。
 */
function migrateKinds(d: Database.Database) {
  const sqlOf = (name: string) =>
    (
      d.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
        | { sql: string | null }
        | undefined
    )?.sql ?? ''

  const needsAssets = sqlOf('assets').includes('CHECK')
  const needsJobs = sqlOf('ingest_jobs').includes('CHECK')
  // 两个判据分开，不能合成一个 if：只迁了 assets 而漏了 jobs 的状态是可能的
  // （本次发布前的某个版本只处理了前者），那时 queue 会报 constraint failed，
  // 而错因藏在一条已经跑过的迁移里，很难往回追。
  if (!needsAssets && !needsJobs) return

  // PRAGMA foreign_keys 在事务内是 no-op，必须在事务外设，且必须真的关掉——
  // 见上面：ON 着 DROP 父表会清空四张子表。
  d.pragma('foreign_keys = OFF')
  try {
    d.exec('BEGIN')
    if (needsAssets) {
      d.exec(`
      CREATE TABLE assets_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        source_path TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        meta_json TEXT,
        collection_id INTEGER NOT NULL DEFAULT 1,
        tags_json TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO assets_migrated
        (id, kind, title, source_path, duration_ms, created_at, meta_json,
         collection_id, tags_json)
      SELECT id, kind, title, source_path, duration_ms, created_at, meta_json,
             collection_id, COALESCE(tags_json, '[]')
      FROM assets;
      DROP TABLE assets;
      ALTER TABLE assets_migrated RENAME TO assets;
    `)
    }
    if (needsJobs) {
      // ingest_jobs 没有子表引用它，DROP 不会连带清数据；仍放进同一个事务，
      // 与 assets 一起成功或一起回滚，不留迁了一半的状态。
      d.exec(`
      CREATE TABLE ingest_jobs_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        file_path TEXT,
        collection_id INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'queued',
        stage TEXT NOT NULL DEFAULT 'queued',
        percent INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        error TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        started_at TEXT,
        finished_at TEXT
      );
      INSERT INTO ingest_jobs_migrated
        (id, batch_id, kind, title, file_path, collection_id, status, stage, percent,
         message, error, result_json, created_at, updated_at, started_at, finished_at)
      SELECT id, batch_id, kind, title, file_path, collection_id, status, stage, percent,
             message, error, result_json, created_at, updated_at, started_at, finished_at
      FROM ingest_jobs;
      DROP TABLE ingest_jobs;
      ALTER TABLE ingest_jobs_migrated RENAME TO ingest_jobs;
    `)
    }
    d.exec('COMMIT')
  } catch (e) {
    // 回滚失败的极端情况下不能把连接留在半迁移状态：外键必须开回来，否则
    // 之后所有删除都不再级联，而那个故障要等到有人发现子表有孤儿行才暴露。
    d.exec('ROLLBACK')
    throw e
  } finally {
    d.pragma('foreign_keys = ON')
  }
}

/**
 * 音频文件的落库表。**只有文件路径与时长**，其余全部复用视频那一套：
 * transcripts（全文）、transcript_sentences（全片句流）、chunks + sentences
 * （检索与句级定位）。音频没有「帧」这个中间层，也不需要——它的画面内容是零。
 *
 * 新表用 CREATE TABLE IF NOT EXISTS，这一笔不用重建父表，没有数据风险。
 */
function initAudioFiles(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS audio_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audio_asset ON audio_files(asset_id);
  `)
}

function migrateCollections(d: Database.Database) {
  const cols = d.prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'collection_id')) {
    d.exec('ALTER TABLE assets ADD COLUMN collection_id INTEGER NOT NULL DEFAULT 1')
  }
  d.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (1, ?)').run('默认库')
  d.prepare('UPDATE assets SET collection_id = 1 WHERE collection_id IS NULL OR collection_id = 0').run()

  if (!cols.some((c) => c.name === 'tags_json')) {
    // 默认 '[]' 而不是 NULL：读取侧 loadTags 对两种空都给 []，但 SQL 里做条件
    // 判断时 NULL 要多写一层 IS NOT NULL，默认值让查询保持单形态。
    d.exec("ALTER TABLE assets ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'")
  }
}

function initSchema(d: Database.Database) {
  d.exec(`
    /*
      kind 不限枚举，合法取值见文件末尾的 AssetKind 与 migrateAssetKinds 的说明。
      这里不写 CHECK 是刻意的：写了之后每加一种模态就要重建一次父表，而重建
      要关外键、拷数据，是整库级别的风险操作。
    */
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      source_path TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      meta_json TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      full_text TEXT NOT NULL,
      language TEXT,
      asr_engine TEXT
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      text TEXT NOT NULL,
      chunk_strategy TEXT NOT NULL,
      embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_transcript ON chunks(transcript_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_time ON chunks(start_ms, end_ms);

    -- 句级索引。两张表分工：transcript_sentences 是全片的句子流（时间轴展示），
    -- sentences 是某个 chunk 命中后要展开的句子（检索用）。冗余是故意的，
    -- 检索路径不该为拿句级时间戳再 join 一次全文表。
    CREATE TABLE IF NOT EXISTS transcript_sentences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transcript_id INTEGER NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tx_sentences_tx ON transcript_sentences(transcript_id);

    CREATE TABLE IF NOT EXISTS sentences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sentences_chunk ON sentences(chunk_id);

    CREATE TABLE IF NOT EXISTS frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      timestamp_ms INTEGER NOT NULL,
      thumb_path TEXT,
      caption TEXT,
      embedding BLOB,
      caption_embedding BLOB,
      scene_index INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_frames_asset ON frames(asset_id);

    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      caption TEXT,
      embedding BLOB,
      caption_embedding BLOB
    );

    CREATE TABLE IF NOT EXISTS text_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      embedding BLOB
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, content='chunks', content_rowid='id'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS captions_fts USING fts5(
      caption, content=''
    );

    -- 素材库（collection）。一个素材归属且只归属一个库，库是检索的作用域。
    -- 没有库的概念时每次检索都是全表，素材一多就只剩变慢一条路。
    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- 入库任务。视频入库是分钟级，不能再堵在 HTTP 请求里：提交后立刻返回
    -- jobId，由一个后台队列逐个执行，前端轮询这里拿阶段与百分比。
    -- status: queued / running / done / error / canceled
    CREATE TABLE IF NOT EXISTS ingest_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('video','image')),
      title TEXT NOT NULL,
      file_path TEXT,
      collection_id INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'queued',
      stage TEXT NOT NULL DEFAULT 'queued',
      percent INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      error TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_batch ON ingest_jobs(batch_id, id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON ingest_jobs(status, id);
  `)

  // FTS5 与主表同步（external content 模式需手动维护）
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, seg_zh(new.text));
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, seg_zh(new.text));
    END;
  `)
}

/**
 * 把 chunks 三个触发器换成 seg_zh 版本，并重建已有 FTS 索引。
 *
 * **CREATE TRIGGER IF NOT EXISTS 对已存在的旧触发器无效**：名字相同就跳过，
 * 所以旧库（触发器里还是裸 new.text）不会因为改了上面的 DDL 而更新。判据取
 * sqlite_master 里 chunks_ai 的定义含不含 seg_zh，不含才是旧版。
 *
 * **重建不走 FTS5 的 'rebuild' 命令**：external content 的 rebuild 从 content
 * 表重新取原列写进索引，取的是原文不是 seg_zh(text)，重建完索引里仍旧是未分词
 * 文本，中文依旧查不到。必须手工 DELETE 再按 seg_zh(text) 重插。
 *
 * 幂等：第二次启动时判据已满足，整个函数空跑。
 */
export function migrateFtsSegmentation(d: Database.Database) {
  const row = d
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'chunks_ai'")
    .get() as { sql: string | null } | undefined
  if (!row?.sql || row.sql.includes('seg_zh')) return

  const before = d.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get() as { n: number }
  d.exec(`
    DROP TRIGGER IF EXISTS chunks_ai;
    DROP TRIGGER IF EXISTS chunks_ad;
    DROP TRIGGER IF EXISTS chunks_au;
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, seg_zh(new.text));
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, seg_zh(new.text));
    END;
  `)
  // 手工重建索引。包一个事务：中途失败的话至少不会留下半份索引
  // （半份索引比空索引更难查，空索引只是全查不到，半份是有的查得到有的查不到）。
  d.transaction(() => {
    d.exec('DELETE FROM chunks_fts')
    d.exec('INSERT INTO chunks_fts(rowid, text) SELECT id, seg_zh(text) FROM chunks')
  })()
  const after = d.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get() as { n: number }
  if (before.n !== after.n) {
    // 行数不变是预期（每条 chunk 一行，变的只是内容）；不一致说明 external
    // content 的 rowid 映射出过问题，此时不静默，打到日志里。
    console.warn(
      `[fts] 重建后行数变化: ${before.n} -> ${after.n}，检查 chunks 与 chunks_fts 的 rowid 映射`,
    )
  }
}

/**
 * Float32Array ↔ SQLite BLOB。向量以 little-endian float32 存储。
 */
export function embeddingToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

export function blobToEmbedding(b: Buffer): Float32Array {
  const out = new Float32Array(b.byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4)
  return out
}

export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
/**
 * 素材模态。**定义在 mediaKind.ts**（那里不依赖 better-sqlite3，客户端组件
 * 也需要它）。这里 re-export 只是为了让 `from '@/lib/db'` 的旧 import 不断，
 * 新代码请直接 import mediaKind。
 */
export type { AssetKind } from './mediaKind'
