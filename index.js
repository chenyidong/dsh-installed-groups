/**
 * 已安装插件分类视图 —— 宿主半边。
 *
 * 干三件事：把分组布局 / 中文译文存成 DSH_HOME 下的真实文件，并通过一条同源
 * HTTP 路由提供给页面半边（浏览器 localStorage 会被清，文件不会）；顺手把插件
 * 版本与简介表（页面读不到的 profile node_modules 信息）一起回给页面。
 *
 *   GET  /installed-groups/layout  -> 布局 + 版本表 + 简介表 + 中文译文表
 *   PUT  /installed-groups/layout  -> 整体替换布局
 *   POST /installed-groups/layout  -> 翻译英文简介，落盘后回译文表
 *
 * 译文按「插件名 + 原文」缓存：翻过的直接读 translations.json，不再调模型；
 * 原文变了（插件升级/换简介）才重翻。翻译走宿主 llm 服务的默认模型。
 *
 * 数据存 $DSH_HOME/dsh-installed-groups/，不放包目录：pnpm 升级插件时整目录
 * 替换，数据放里面会被清掉。路由只在 webServer 到位时挂载，headless 组合不受影响。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-installed-groups'
export const inject = []

const ROUTE = '/installed-groups/layout'
const BATCH = 5

const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const statePath = (file) => join(home(), 'dsh-installed-groups', file)

/** 插件装在这个 profile 的 node_modules 里，版本与简介也只在这里。 */
const profileDir = () => process.env.DSH_PROFILE_DIR || join(home(), 'profiles', process.env.DSH_PROFILE || 'desktop')

/** 把不可信输入收敛成布局形状；认不出的字段一律丢掉。 */
function normalize(value) {
  const source = value && typeof value === 'object' ? value : {}
  const assign = (field) => {
    const raw = source[field]
    const out = {}
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, cat] of Object.entries(raw)) {
        if (typeof key === 'string' && typeof cat === 'string' && cat) out[key] = cat.slice(0, 60)
      }
    }
    return out
  }
  const order = Array.isArray(source.order)
    ? [...new Set(source.order.filter((id) => typeof id === 'string' && id))].slice(0, 100)
    : []
  const cats = Array.isArray(source.cats)
    ? [...new Set(source.cats.filter((id) => typeof id === 'string' && id))].slice(0, 100)
    : []
  return { version: 1, assign: assign('assign'), order, cats }
}

/** 译文表：{ 插件名: { source: 原文, text: 中文 } }。文件不可信，逐条收敛。 */
function normalizeTranslations(value) {
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [name, row] of Object.entries(value).slice(0, 300)) {
    if (typeof name !== 'string' || !name || name.length > 120) continue
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    if (typeof row.source !== 'string' || typeof row.text !== 'string' || !row.text.trim()) continue
    out[name] = { source: row.source.slice(0, 2000), text: row.text.trim().slice(0, 2000) }
  }
  return out
}

function isLocal(req) {
  const addr = req.socket && req.socket.remoteAddress
  return typeof addr === 'string' && /^(::1|127\.|::ffff:127\.)/.test(addr)
}

function sendJson(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

const readJson = async (file, shape) => {
  try { return shape(JSON.parse(await readFile(file, 'utf8'))) } catch { return shape({}) }
}

/** 先写临时文件再改名：进程中途被杀也不会留下半个 JSON。 */
async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

const readLayout = () => readJson(statePath('layout.json'), normalize)
const writeLayout = (value) => writeJson(statePath('layout.json'), normalize(value))

/** 状态目录是唯一真相源（用户后来翻的、原文变了重翻的都在这里）；随包预置的
 *  中文译文作种子：首次运行整体初始化，之后只补齐种子里新增的条目 —— 插件升级
 *  带来的新译文能平滑落进已有状态目录，不覆盖用户已存的结果。原文变了由客户端
 *  检测 source 不一致后重翻，这里不掺和。 */
const SEED = new URL('./translations.json', import.meta.url)
async function readTranslations() {
  const file = statePath('translations.json')
  const saved = await readJson(file, normalizeTranslations)
  try {
    const seed = normalizeTranslations(JSON.parse(await readFile(SEED, 'utf8')))
    let added = 0
    for (const [name, row] of Object.entries(seed)) {
      if (!saved[name]) { saved[name] = row; added++ }
    }
    if (added) await writeJson(file, saved)
  } catch { /* 没有种子：用状态目录里已有的 */ }
  return saved
}
const writeTranslations = (value) => writeJson(statePath('translations.json'), normalizeTranslations(value))

/** 版本 + 简介：官方卡片 DOM 里没有版本，简介也可能缺；profile 的 package.json
 *  是当前装着的那个版本，dsh.description 优先（官方卡片多半就显示它）。 */
async function readPluginInfo() {
  const dir = profileDir()
  const versions = {}
  const descriptions = {}
  try {
    const deps = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies ?? {}
    await Promise.all(Object.keys(deps).map(async (name) => {
      try {
        const pkg = JSON.parse(await readFile(join(dir, 'node_modules', name, 'package.json'), 'utf8'))
        if (typeof pkg.version === 'string' && pkg.version) versions[name] = pkg.version
        const desc = (typeof pkg.dsh?.description === 'string' && pkg.dsh.description)
          || (typeof pkg.description === 'string' && pkg.description) || ''
        if (desc) descriptions[name] = desc.slice(0, 2000)
      } catch { /* 这一行读不到，不影响别的行 */ }
    }))
  } catch { /* profile 没就绪就回空表 */ }
  return { versions, descriptions }
}

/* ------------------------------------------------------------------ 翻译 */

const SYSTEM = [
  '你是 DeepSeek Harness 插件简介的翻译器。',
  '输入是一个 JSON 对象：{ "插件包名": "英文简介" }。',
  '把每条简介翻译成自然、简洁的简体中文；产品名、命令、API、版本号等保留原文写法（如 DSH、MCP、GitHub、Ctrl+R）。',
  '只输出一个 JSON 对象，键与输入的插件包名完全一致，值是对应的中文译文。',
  '不要输出 markdown 代码块、解释或任何额外文字，不要增删条目。',
].join('\n')

const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 翻译是一句话的活：模型若默认高推理，会把输出预算全花在思考上，吐空字符串。 */
function lowestEffort(info) {
  const list = info?.reasoning?.efforts
  if (!Array.isArray(list)) return undefined
  const ids = list.map((e) => e && typeof e === 'object' ? e.id : undefined)
    .filter((id) => typeof id === 'string' && id)
  let best
  let rank = Infinity
  for (const id of ids) {
    const r = EFFORT_ORDER.indexOf(id)
    if (r >= 0 && r < rank) { best = id; rank = r }
  }
  return best ?? ids[0]
}

/** 新会话的默认模型；没设就退到第一个能列出模型的 provider。 */
async function pickRoute(ctx, llm) {
  let selection
  try { selection = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel')?.currentSelection?.() : undefined } catch { /* ignore */ }
  if (typeof selection?.provider === 'string' && selection.provider
    && typeof selection?.model === 'string' && selection.model) {
    return { provider: selection.provider, model: selection.model }
  }
  if (typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return null
  const providers = await Promise.resolve(llm.listProviders()).catch(() => [])
  if (!Array.isArray(providers)) return null
  for (const entry of providers.slice(0, 20)) {
    const provider = typeof entry?.id === 'string' && entry.id ? entry.id
      : typeof entry?.provider === 'string' ? entry.provider : ''
    if (!provider) continue
    const models = await Promise.resolve(llm.listModels(provider)).catch(() => [])
    const model = Array.isArray(models) && typeof models[0]?.id === 'string' ? models[0].id : ''
    if (model) return { provider, model }
  }
  return null
}

/**
 * 模型偶尔会裹 ```json 或前后带话：只截最外层花括号里的对象；
 * 输出被 maxTokens 截断时，退而逐条捞完整的 "键":"值" 对，别整批丢掉。
 */
function parseTranslationMap(text, names) {
  const clean = String(text).trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  let parsed = {}
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(clean.slice(start, end + 1)) } catch { /* 下面兜底 */ }
  }
  if (!Object.keys(parsed).length && start >= 0) {
    const body = clean.slice(start + 1)
    const re = /"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/g
    let m
    while ((m = re.exec(body)) !== null) {
      try { parsed[m[1]] = JSON.parse('"' + m[2] + '"') } catch { /* 截断的那条跳过 */ }
    }
  }
  const out = {}
  for (const name of names) {
    const value = parsed?.[name]
    if (typeof value === 'string' && value.trim()) out[name] = value.trim().slice(0, 2000)
  }
  // 只有一条时模型可能直接吐译文而不是 JSON。
  if (!Object.keys(out).length && names.length === 1 && clean && start < 0) out[names[0]] = clean.slice(0, 2000)
  return out
}

async function askModel(llm, route, input) {
  const effort = typeof llm.resolveModelInfo === 'function'
    ? lowestEffort(await Promise.resolve(llm.resolveModelInfo(route.provider, route.model)).catch(() => undefined))
    : undefined
  let written = ''
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }],
    maxTokens: 3000,
    signal: AbortSignal.timeout(30000),
    ...(effort ? { reasoningEffort: effort } : {}),
  })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') written += chunk.text
    if (chunk?.type === 'finish') {
      if (chunk.reason?.kind === 'error') throw new Error('模型返回错误')
      break
    }
  }
  return written
}

/** 只翻没翻过（或原文已变）的条目；分批调用，单批失败不影响别批。 */
async function translateDescriptions(ctx, items) {
  const clean = []
  for (const item of items.slice(0, 120)) {
    const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 120) : ''
    const text = typeof item?.text === 'string' ? item.text.trim().slice(0, 2000) : ''
    if (name && text) clean.push({ name, text })
  }
  const saved = await readTranslations()
  const result = {}
  const pending = []
  for (const { name, text } of clean) {
    const hit = saved[name]
    if (hit && hit.source === text) result[name] = hit   // 翻过且原文没变：直接加载保存结果
    else pending.push({ name, text })
  }
  if (!pending.length) return { translations: result, translated: 0, error: '' }

  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (!llm || typeof llm.stream !== 'function') {
    return { translations: result, translated: 0, error: '模型服务不可用，暂用原文' }
  }
  const route = await pickRoute(ctx, llm)
  if (!route) return { translations: result, translated: 0, error: '没有可用模型，暂用原文' }

  let translated = 0
  let error = ''
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH)
    const input = Object.fromEntries(batch.map((it) => [it.name, it.text]))
    try {
      const answer = await askModel(llm, route, input)
      const map = parseTranslationMap(answer, batch.map((it) => it.name))
      for (const [name, zh] of Object.entries(map)) {
        saved[name] = { source: input[name], text: zh }
        result[name] = saved[name]
        translated++
      }
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 200)
    }
  }
  if (translated) await writeTranslations(saved)
  return { translations: result, translated, error }
}

export function apply(ctx) {
  const mount = (hostCtx) => {
    const webServer = hostCtx
      && (hostCtx.webServer || (typeof hostCtx.get === 'function' ? hostCtx.get('webServer') : undefined))
    if (!webServer || typeof webServer.register !== 'function') return
    ctx.effect(() => {
      const off = webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (req, res) => {
          if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: '只接受本机请求' })
          try {
            if (req.method === 'GET') {
              const info = await readPluginInfo()
              return sendJson(res, 200, {
                ok: true,
                layout: await readLayout(),
                versions: info.versions,
                descriptions: info.descriptions,
                translations: await readTranslations(),
              })
            }
            if (req.method !== 'PUT' && req.method !== 'POST') {
              return sendJson(res, 405, { ok: false, error: '只支持 GET / PUT / POST' })
            }
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            let body = {}
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* 空体/坏 JSON 当空对象 */ }
            if (req.method === 'PUT') {
              await writeLayout(body)
              return sendJson(res, 200, { ok: true })
            }
            const out = await translateDescriptions(ctx, Array.isArray(body?.items) ? body.items : [])
            return sendJson(res, 200, { ok: true, ...out })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })
      return off
    }, 'dsh-installed-groups: layout route')
  }
  // apply 期 webServer 往往还没就绪，走 inject 回调等它到位。
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mount)
  else mount(ctx)
}
