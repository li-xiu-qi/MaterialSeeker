import path from 'node:path'
import fs from 'node:fs'

/**
 * 存储布局。全库唯一数据根，默认 <repo>/app_datas，
 * 可用 VIDEOSEEKER_DATA_DIR 覆盖（dgx-spark 上指向 ~/videoseeker-data）。
 */
const repoRoot = process.env.VIDEOSEEKER_REPO_ROOT || path.resolve(process.cwd(), '..')
const dataDir = process.env.VIDEOSEEKER_DATA_DIR || path.join(repoRoot, 'app_datas')

export const PATHS = {
  repoRoot,
  dataDir,
  /** 入库的视频文件 */
  videosDir: path.join(dataDir, 'videos'),
  /** 入库的图片文件 */
  imagesDir: path.join(dataDir, 'images'),
  /** 抽出的关键帧（含缩略图） */
  framesDir: path.join(dataDir, 'frames'),
  /** 列表用缩略图缓存（按 源文件+宽度 生成，命中即复用） */
  thumbsDir: path.join(dataDir, 'thumbs'),
  /** 中间产物（ffmpeg 拆出的音频、临时文件） */
  tmpDir: path.join(dataDir, 'tmp'),
  /** SQLite 主库 */
  dbPath: path.join(dataDir, 'videoseeker.db'),
} as const

for (const dir of [
  PATHS.dataDir,
  PATHS.videosDir,
  PATHS.imagesDir,
  PATHS.framesDir,
  PATHS.thumbsDir,
  PATHS.tmpDir,
]) {
  fs.mkdirSync(dir, { recursive: true })
}
