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
  return db
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
