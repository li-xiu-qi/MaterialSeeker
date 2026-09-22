import Database from 'better-sqlite3'
import { PATHS } from './paths'

/**
 * SQLite 单例。向量维度固定 1024（编码器 2048 维经 MRL 截断），
 * 截断损失实测约 0.1 个 R@10 点，存储减半。
 */
export const VECTOR_DIM = 1024

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  db = new Database(PATHS.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  initSchema(db)
  migrateCollections(db)
  return db
}

/**
 * 给存量库加 collection 列。
 *
 * CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，所以这一步必须单独做，
 * 否则升级后旧库里 assets 没有 collection_id，所有按库过滤的 SQL 直接报错。
 * 做法：缺列就加（默认 1，指向默认库），确保默认库存在，再把游离行收编。
 * 幂等，每次启动都跑，重复跑没有副作用。
 */
function migrateCollections(d: Database.Database) {
  const cols = d.prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'collection_id')) {
    d.exec('ALTER TABLE assets ADD COLUMN collection_id INTEGER NOT NULL DEFAULT 1')
  }
  d.prepare('INSERT OR IGNORE INTO collections (id, name) VALUES (1, ?)').run('默认库')
  d.prepare('UPDATE assets SET collection_id = 1 WHERE collection_id IS NULL OR collection_id = 0').run()
}

function initSchema(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('video','image','text')),
      title TEXT NOT NULL,
      source_path TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      meta_json TEXT
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
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `)
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
