/**
 * 已安装插件分类视图 —— 宿主半边。
 *
 * 只干一件事：把分组布局存成 DSH_HOME 下的真实文件，并通过一条同源 HTTP
 * 路由提供给页面半边（浏览器 localStorage 会被清，文件不会）：
 *
 *   GET  /installed-groups/layout  -> 已保存的布局（没有则空布局）
 *   PUT  /installed-groups/layout  -> 整体替换
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

function statePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-installed-groups', 'layout.json')
}

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

function isLocal(req) {
  const addr = req.socket && req.socket.remoteAddress
  return typeof addr === 'string' && /^(::1|127\.|::ffff:127\.)/.test(addr)
}

function sendJson(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readLayout() {
  try {
    return normalize(JSON.parse(await readFile(statePath(), 'utf8')))
  } catch {
    return normalize({})
  }
}

/** 先写临时文件再改名：进程中途被杀也不会留下半个 JSON。 */
async function writeLayout(value) {
  const target = statePath()
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(normalize(value), null, 2), 'utf8')
  await rename(tmp, target)
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
            if (req.method === 'GET') return sendJson(res, 200, { ok: true, layout: await readLayout() })
            if (req.method === 'PUT') {
              const chunks = []
              for await (const chunk of req) chunks.push(chunk)
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              await writeLayout(body)
              return sendJson(res, 200, { ok: true })
            }
            return sendJson(res, 405, { ok: false, error: '只支持 GET / PUT' })
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
