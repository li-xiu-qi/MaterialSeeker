/**
 * 标签（tags）。
 *
 * **为什么单独一个模块**：标签既写库（assets.tags_json）又要进向量
 * （并入 caption 一起编码），两边任何一边漏了都会静默出错，漏写库只是界面
 * 上看不到，漏编码表现为「明明打了标签却搜不到」，而后者不会报错，只是
 * 搜不到，最容易被当成模型不行。
 *
 * **标签与描述（caption）的分工**，这是本模块存在的真正理由：
 * - 描述是一句自然语言，给人读、也给模型当 passage 编码，是语义检索的主语料。
 * - 标签是几个名词，是硬性的归类词，通常比描述里的措辞更接近用户搜索时会
 *   打的词（「猫」「夜景」「访谈」）。用户搜「夜景」时不会写「灯光昏黄的
 *   室外场景」，但会打「夜景」这个标签。
 * 所以标签必须并入编码语料。只存不编的结果是标签成为纯展示字段，而它本来
 * 是为了被搜到的。
 */

/** 单个素材的标签上限。再多就不再是标签而是散文，列表上也会把卡片撑坏。 */
export const MAX_TAGS = 12

/** 单条标签长度上限。超过的多半是把描述粘进标签了，直接截断不如让人改。 */
export const MAX_TAG_LEN = 20

/**
 * 把任意来路的值收敛成标签数组。
 *
 * 接受四种输入，因为三个调用方各自顺手：前端表单传逗号字符串，JSON API 传
 * 数组，AI 标注传「猫, 夜景」这种带空格的串，库里读回来的是 JSON 字符串。
 * 一律在这里收敛，调用方不做清洗。
 */
export function parseTags(raw: unknown): string[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) {
    list = raw
  } else if (typeof raw === 'string') {
    const t = raw.trim()
    if (!t) return []
    let parsedOk = false
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t)
        if (Array.isArray(parsed)) {
          list = parsed
          parsedOk = true
        }
      } catch {
        // 解析失败按纯字符串走，不走 throw：坏数据该被清掉而不是让入库失败
      }
    }
    // **「解析成功」与「解析出来的数组非空」必须分开记。**
    //
    // 早先是 `if (Array.isArray(parsed)) list = parsed`，再用 `list.length === 0`
    // 判断要不要回退切分。而空 JSON 串（库里绝大多数行的默认值就是 '[]'）解析
    // 成功、得到空数组，会被判成「不是 JSON」，于是回退切 '[]' 这两个字符，产出
    // 字面量标签 `[]`。后果有两个：详情页的标签框里躺着一个 "[]" 给人看；以及
    // 保存时这个假标签被写回库，第一次编辑之后这条素材就真的多出一个标签。
    //
    // 用独立标记而不是 list 是否为空：解析出的数组本来就可能是空的。
    if (!parsedOk) list = t.split(/[,，;；]/)
  } else {
    return []
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'string' && typeof item !== 'number') continue
    const tag = String(item)
      .trim()
      // 压掉内部连续空白，但保留首尾已被 trim 掉的边界
      .replace(/\s+/g, ' ')
      .slice(0, MAX_TAG_LEN)
    if (!tag) continue
    // 去重按大小写不敏感：用户连打「MV」与「mv」时这是同一个意思，不去重
    // 会占掉两个名额，而列表上两个标签只差一个字母看着像 bug。
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/** 入库用。空数组存 '[]' 而不是 NULL，读取侧就不用判两种空。 */
export function serializeTags(tags: string[]): string {
  return JSON.stringify(tags)
}

/** 读库用。坏 JSON 当空数组，不让一行的坏数据带崩整页。 */
export function loadTags(raw: string | null | undefined): string[] {
  if (!raw) return []
  return parseTags(raw)
}

/**
 * 标签的入库编码语料。
 *
 * **标签不单独编码，拼在描述后面一起编码**。单独给标签建一路向量的代价是
 * 检索多一条路径、多一次排序合并，而拼接之后同一句语料里的名词权重自然
 * 会被分配到标签词上，效果上够用。拼接分隔符用空格而不是顿号：顿号在分词
 * 里是标点，空格至少能让「访谈 2026」保持为两个可分的词。
 *
 * **每段都 trim**：这段文本要喂给编码器，调用方可能传来没洗过的标签（AI 标注
 * 直接给一串带空格的字符串是常事）。多出来的空格对向量影响很小，但会让
 * caption_embedding 与界面上看到的描述不一致，排查时对不上。在这里收口，
 * 调用方就不必各自记得先 parseTags。
 */
export function composeCaptionText(caption: string | null | undefined, tags: string[]): string {
  return [caption?.trim() ?? '', ...tags.map((t) => t.trim())].filter(Boolean).join(' ')
}
