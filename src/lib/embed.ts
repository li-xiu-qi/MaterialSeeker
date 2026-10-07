import { VECTOR_DIM } from '../lib/db'

/**
 * 推理服务客户端。编码全部走本地 GPU 上的 Python 推理服务，
 * Node 侧不加载模型。
 *
 * instruction 是强制项：编码器是 instruction aware 的，索引端与查询端
 * 必须带不同 instruction，混用会掉点。两个常量集中在这里，改口径只改一处。
 */

const BASE_URL = process.env.VIDEOSEEKER_INFERENCE_URL || 'http://127.0.0.1:8280'

/** 索引侧（passage）：被检索的内容。EG2 的 Document task prefix。 */
export const PASSAGE_INSTRUCTION = 'title: none | text: '
/** 查询侧（query）：用户的查询。EG2 的 SearchQuery task prefix。 */
export const QUERY_INSTRUCTION = 'task: search result | query: '

export type Modality = 'text' | 'image'

export interface EncodeRequest {
  inputs: Array<
    | { modality: 'text'; text: string; instruction?: string }
    | { modality: 'image'; path: string; instruction?: string }
  >
}

export interface Embedding {
  /** 1024 维（编码器原始 2048 维已截断） */
  vector: number[]
  dim: number
}

/**
 * 编码一批输入。服务不可用时抛错，由调用方决定降级还是失败。
 * 静默降级会让检索结果缺一路而不被察觉，这里显式抛。
 */
export async function encodeBatch(req: EncodeRequest): Promise<Float32Array[]> {
  const res = await fetch(`${BASE_URL}/encode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`inference service ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { embeddings: Embedding[] }
  if (data.embeddings.length !== req.inputs.length) {
    throw new Error(
      `inference service returned ${data.embeddings.length} embeddings for ${req.inputs.length} inputs`,
    )
  }
  return data.embeddings.map((e) => {
    if (e.dim !== VECTOR_DIM) {
      throw new Error(`unexpected embedding dim ${e.dim}, expected ${VECTOR_DIM}`)
    }
    return Float32Array.from(e.vector)
  })
}

export function encodeText(text: string, side: 'passage' | 'query'): Promise<Float32Array[]> {
  return encodeBatch({
    inputs: [
      {
        modality: 'text',
        text,
        instruction: side === 'query' ? QUERY_INSTRUCTION : PASSAGE_INSTRUCTION,
      },
    ],
  })
}

export function encodeImage(path: string): Promise<Float32Array[]> {
  return encodeBatch({ inputs: [{ modality: 'image', path }] })
}
