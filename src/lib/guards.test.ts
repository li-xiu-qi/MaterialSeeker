import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * 源码级守卫。**测的不是产品行为，是「同一类错误不许再犯」。**
 *
 * 这个项目的缺陷有个鲜明特点：大部分不是逻辑写错，是把某个已知会炸的模式又抄
 * 了一遍——假 base 拼跳转被复制 22 处、多栏类名拼字符串导致双栏四栏静默失效、
 * 客户端组件 import 到碰数据库的模块让整页 500。三者都只在运行时现形，且前两
 * 种在控制台里一声不响。
 *
 * 这类缺陷的共同点是「写了但看不出来」，所以最好的拦截点是源码文本本身。
 * 每条守则都对应一个真实发生过的事故，不是出于猜忌。
 */

const SRC = join(process.cwd(), 'src')

interface Found {
  file: string
  line: number
  text: string
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

/** 扫源码，返回命中 file:line:原文。测试文件自己不扫，免得守卫测自己。 */
function scan(pattern: RegExp, opts: { skipTests?: boolean } = {}): Found[] {
  const hits: Found[] = []
  for (const file of walk(SRC)) {
    if (opts.skipTests !== false && file.includes('.test.')) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, i) => {
      if (pattern.test(text)) {
        hits.push({ file: relative(SRC, file), line: i + 1, text: text.trim() })
      }
    })
  }
  return hits
}

/**
 * 先说扫描器本身是有效的。**没有这一条，下面的守则可能一条都没跑过。**
 *
 * 失效形态很具体：SRC 路径拼错、正则写法不匹配、目录名变了下划线，任何一种
 * 都会让命中数恒为 0，于是所有守则「通过」。这类假绿比没有测试更危险，因为
 * 它让人以为这块已经有人守了。
 */
describe('扫描器自身有效性', () => {
  it('真的扫到了文件，数量有下限', () => {
    const files = walk(SRC)
    // 项目有 50+ 个源文件。低于这个数说明路径或遍历坏了，不是项目变小了。
    expect(files.length).toBeGreaterThan(40)
  })

  it('每条守则的正则都能在源码里找到非零上下文，不是匹不到任何东西的空模式', () => {
    // 拿一个必然存在的字面量试同一条检索路径，确认 scan 会返回它
    const anyHits = scan(/className|export function|interface /)
    expect(anyHits.length).toBeGreaterThan(0)
  })
})

describe('禁则：不许拿变量拼栅格类名', () => {
  // 事故：双栏四栏整块不生效，控制台一声不响。根因是 Tailwind 按源码里出现过
  // 的字面类名生成 CSS，模板字符串拼出来的类名构建时不存在，扫不到就不生成。
  const DYNAMIC_GRID = /(?:grid-cols|gap|h-|w-)-\$\{/

  it('源码里没有模板拼接的栅格类', () => {
    const hits = scan(DYNAMIC_GRID)
    expect(
      hits.map((h) => `${h.file}:${h.line} ${h.text}`),
      'Tailwind 只认字面类名，拼接出来的不会生成 CSS。改用字面量映射表，见 lib/layout.ts',
    ).toEqual([])
  })

  it('三个档位的类名确实以字面量形式存在于源码中', () => {
    // 反偏向验证：守卫不能靠「禁止一切 grid」来通过，那会连带禁掉正常用法。
    const src = readFileSync(join(SRC, 'lib/layout.ts'), 'utf8')
    expect(src).toContain('grid-cols-2')
    expect(src).toContain('grid-cols-4')
  })
})

describe('禁则：不许拿假域名当 base 拼跳转', () => {
  // 事故：Location 头发出去一个不存在的 host，浏览器报连接失败，而操作其实
  // 成功了，界面表现是「点了没反应」。8 个路由复制了 22 处。
  const FAKE_BASE = /new URL\([^)]*,\s*['"]https?:\/\/(?!placeholder\.invalid)/

  it('没有用假 base 拼 URL 再交给 redirect', () => {
    const hits = scan(FAKE_BASE)
    expect(
      hits.map((h) => `${h.file}:${h.line} ${h.text}`),
      '改用 lib/redirect 的 redirectBack，它发的是相对 Location',
    ).toEqual([])
  })

  it('redirectBack 是唯一自己设 Location 头的地方', () => {
    // 新路由绕开 redirectBack 自己拼 Location，就是复现那 22 处
    // 只比文件名不比行号：行号会随任何改动漂移，按它断言会天天假红
    const hits = scan(/Location:\s*[`'"]/)
    expect(hits.length, '只应有一处设 Location 头').toBe(1)
    expect(hits[0].file, '回跳一律走 redirectBack，别在路由里手写 Location 头').toBe(
      'lib/redirect.ts',
    )
  })
})

describe('禁则：客户端组件不许 import 碰数据库的模块', () => {
  // 事故：这条链让页面直接 500， Turbopack 报 Can't resolve 'fs'。
  // 判例：lib/collections → lib/db → better-sqlite3 → node:fs。
  // 同一个坑在 AppShell 与 CollectionScope 各踩过一次，所以立成守则。
  const SERVER_ONLY = /^import\s.*from\s+'@\/lib\/(db|collections|library|libraryFilter|search|embed|ingest|paths)'/m

  it('标了 use client 的文件没有这类 import', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (file.includes('.test.')) continue
      const src = readFileSync(file, 'utf8')
      const isClient = src.includes("'use client'") || src.includes('"use client"')
      if (!isClient) continue
      const lines = src.split('\n')
      lines.forEach((text, i) => {
        if (SERVER_ONLY.test(text.trim())) {
          offenders.push(`${relative(SRC, file)}:${i + 1} ${text.trim()}`)
        }
      })
    }
    expect(
      offenders,
      '客户端 bundle 装不进 node:fs。要这些数据就让服务端组件算好当 prop 传进来',
    ).toEqual([])
  })

  it('守卫不是靠「全项目一个 use client 都没有」通过的', () => {
    // 反向验证：真得有人在用客户端组件，否则上一条是空跑
    let clients = 0
    for (const file of walk(SRC)) {
      if (file.includes('.test.')) continue
      const src = readFileSync(file, 'utf8')
      if (src.includes("'use client'") || src.includes('"use client"')) clients++
    }
    expect(clients).toBeGreaterThan(0)
  })
})

describe('禁则：正文里的下拉框必须滚轮友好', () => {
  // 浏览器既定行为：鼠标悬停在原生 select 上拨滚轮，滚轮被用来改选中项，页面
  // 纹丝不动。素材库页顶部就摆着「当前库」下拉框，用户从侧边栏点进来时鼠标
  // 往往正停在附近，往下拨滚轮时库在悄悄切换、页面一步不动，看着就像滚轮坏了。
  // 用户报过「拨滚轮页面完全不动」，这是代码侧唯一能确认的成因。
  // 修法是 ScrollSafeSelect：底下仍是原生 select，只把吞滚轮的默认动作拦掉。

  it('正文里没有裸的 select 开标签，全部走 ScrollSafeSelect', () => {
    const hits: string[] = []
    for (const file of walk(SRC)) {
      if (file.includes('.test.')) continue
      // ScrollSafeSelect 自己就得包含 <select>（它是那个原生控件的包装），
      // 不排除它守卫会先打死自己。这与之前踩过的自伤同源：反面样例写在注释里，
      // 扫源码的守卫就会被它绊倒，永远红着。
      if (file.endsWith('components/ScrollSafeSelect.tsx')) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((text, i) => {
        // 跳过块注释内部：说明修复原因的文档里就写着裸 select 长什么样
        if (/^\s*\*(\s|$)/.test(text)) return
        if (/<select[\s>]/.test(text)) {
          hits.push(`${relative(SRC, file)}:${i + 1} ${text.trim().slice(0, 60)}`)
        }
      })
    }
    expect(
      hits,
      '原生 select 会吞滚轮，改用 ScrollSafeSelect（见 src/components/ScrollSafeSelect.tsx）',
    ).toEqual([])
  })

  it('ScrollSafeSelect 确实被用着，守卫不是靠「全项目零 select」通过的', () => {
    // 反向验证：真得有下拉框被包起来，否则上一条是空跑
    const users: string[] = []
    for (const file of walk(SRC)) {
      if (file.includes('.test.')) continue
      if (readFileSync(file, 'utf8').includes('<ScrollSafeSelect')) users.push(relative(SRC, file))
    }
    expect(users.sort()).toEqual(['app/(app)/library/page.tsx', 'components/CollectionScope.tsx'])
  })

  it('ScrollSafeSelect 拦的是默认动作，没把原生 select 换掉', () => {
    // **必须跳过注释行。** 这条断言原来写 expect(src).toContain('<select')，探针
    // 证明它是装饰品：把 <select> 换成 <div role="listbox"> 后它照样通过，因为说明
    // 原因的文档注释里就写着「底下还是一个真正的 <select>」。裸字符串匹配分不清
    // 代码与注释，扫源码的守则一律要先剥掉注释。
    const codeLines = readFileSync(join(SRC, 'components/ScrollSafeSelect.tsx'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*\*(\s|$)/.test(l) && !/^\s*\/\//.test(l))
      .join('\n')
    expect(codeLines).toContain('<select')
    expect(codeLines).toContain('preventDefault()')
  })
})

/**
 * 后台任务队列的落位。**它属于入库页，不属于导航侧边栏。**
 *
 * 真实事故：QueuePanel 先在全局导航侧边栏挂过一段时间，理由是「任务进度只存在在
 * 发起它的那个页面，用户切走就看不见，而长任务等待期间去干点别的是正当需求」。
 * 用户直接指出层级错了。这个理由站不住的地方在于：真正的等待发生在入库页，人在
 * 那里等，左栏上传面板就有实时进度；切走页面是少数情况，而为少数情况把一块与导航
 * 无关的内容常驻在全局导航里，代价是每次打开应用都看见它，而它对检索页与素材库页
 * 毫无意义。
 *
 * 守卫同时防两种复犯：一是它被搬回 AppShell，二是它被复制出第二份。
 */
describe('后台任务队列的落位', () => {
  it('只在一个地方被 import，且那个地方是入库页', () => {
    // **查 import 而不是查 <QueuePanel /> 渲染。** 两边各有漏法：只查渲染，
    // 「加了 import 但还没接上」的半成品发现不了；只查 import，重复定义可能被漏。
    // import 侧更能说明意图——文件里有它，就是打算在这一页用它。
    //
    // 注释行不经剥离线：解释这段历史时必然会提到它曾在哪，逐字匹配必然恒红。
    const importers: string[] = []
    for (const file of walk(SRC)) {
      if (file.includes('.test.')) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      const used = lines.some(
        (l) => !/^\s*\*(\s|$)/.test(l) && /^\s*import[^\n]*QueuePanel/.test(l),
      )
      if (used) importers.push(relative(SRC, file))
    }
    expect(importers).toEqual(['app/(app)/ingest/page.tsx'])
  })

  it('导航外壳不碰它', () => {
    const shell = readFileSync(join(SRC, 'components/AppShell.tsx'), 'utf8')
    const code = shell
      .split('\n')
      .filter((l) => !/^\s*\*(\s|$)/.test(l) && !/^\s*\/\//.test(l))
      .join('\n')
    expect(code).not.toContain('QueuePanel')
  })
})

/**
 * 队列的时间窗必须真的被用上，且只用在终态那一段。
 *
 * queueWindow.test.ts 守的是那几个 SQL 片段写得对；这一组守的是 jobs.ts 确实把
 * 它们拼进了 listQueue，而且拼在正确的那一段。两者都不能省：只测片段，「最近 N 条」
 * 的旧写法随时可能回来，而它不报错，只是任务永远不消失（用户报过「后台任务完成之后
 * 应该给他清掉」）；只测调用，修饰符写错时片段自己发现不了。
 */
describe('队列时间窗被用上了', () => {
  it('listQueue 里终态查询带时间窗条件与绑定值', () => {
    const code = readFileSync(join(SRC, 'lib/jobs.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*\*(\s|$)/.test(l) && !/^\s*\/\//.test(l))
      .join('\n')
    // 断言的是「调用了 helper」而不是抄一遍 SQL：抄一份就成了两份实现，
    // 改一处忘一处。
    expect(code).toContain('finishedWindowSql()')
    expect(code).toContain('finishedWindowArg()')
  })

  it('窗口条件只拼在终态查询上，没拼到进行中那一段', () => {
    // 拼错地方会让进行中的任务也被时间窗滤掉：上传传到一半的任务 finished_at 是
    // NULL，结果队列空着而文件还在传，用户以为任务没挂上。
    //
    // **不靠下标比大小定位。** 这一条改过四版，前三版都在跟「const windowSql
    // 定义行夹在两段查询之间」搏斗：那行是普通赋值，不含 ${}，却混在同一个
    // windowSql 名字里，拿名字当下标锚点就会被它绊倒。改用计数与次序：
    // ${windowSql} 这种模板插值只该出现在拼进查询的那一处，恰好一次。
    const src = readFileSync(join(SRC, 'lib/jobs.ts'), 'utf8')
    const inListQueue = src.slice(src.indexOf('export function listQueue'))
    const marks = inListQueue.split('${windowSql}').length - 1
    expect(marks, '窗口只许拼进一个查询').toBe(1)

    const ascIdx = inListQueue.indexOf('ORDER BY id ASC')
    const descIdx = inListQueue.indexOf('ORDER BY id DESC')
    const lastIdx = inListQueue.lastIndexOf('${windowSql}')
    // 末次出现（拼进查询那一次）夹在两个 ORDER BY 之间：在升序之后说明没落到
    // 进行中查询里，在降序之前说明它就是终态查询的 WHERE 片段。
    expect(lastIdx).toBeGreaterThan(ascIdx)
    expect(lastIdx).toBeLessThan(descIdx)
  })
})

/**
 * 素材库的类型筛选必须真的生效。**它丢过一次，而且丢得无声无息。**
 *
 * 把筛选从内存搬到 SQL 那次，`libraryWhere` 的注释写着「类型不进这个片段，由各查询
 * 自己写 a.kind = ?」。话是对的，但三条 SQL 里的 a.kind 全是写死的字面量，没有任何
 * 一层读 `query.kind`——类型筛选就此不存在。用户报的是「我选中文本，为什么视频和
 * 图片还在显示」。缺陷不抛错、不打日志，只是三类全出来。
 *
 * 这类缺陷的共同点是「一个参数传进来了但没人用」，最好的拦截点就是源码层面查它
 * 有没有被读。
 */
describe('素材库类型筛选生效', () => {
  it('getLibraryList 读 query.kind', () => {
    const code = readFileSync(join(SRC, 'lib/library.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*\*(\s|$)/.test(l) && !/^\s*\/\//.test(l))
      .join('\n')
    expect(code).toContain('query.kind')
  })

  it('三条查询都受类型筛选控制，不是只有第一条', () => {
    // 只给第一条加 wanted() 的话，选「文本」时图片照旧显示，而那两类用户根本
    // 没点，错得同样显眼但更难定位（三条查询结构相同，看不出哪条漏了）。
    const src = readFileSync(join(SRC, 'lib/library.ts'), 'utf8')
    const inGet = src.slice(src.indexOf('export function getLibraryList'))
    for (const k of ['video', 'image', 'text'] as const) {
      expect(inGet, `${k} 那组要被 wanted() 包住`).toContain(`wanted('${k}')`)
    }
  })

  it('页面把类型筛选传下去了，不是拿到参数就扔', () => {
    const page = readFileSync(join(SRC, 'app/(app)/library/page.tsx'), 'utf8')
    expect(page).toContain('getLibraryList(collectionId')
    expect(page).toMatch(/getLibraryList\(collectionId,\s*\{[^}]*kind/)
  })
})
