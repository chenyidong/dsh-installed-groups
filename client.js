/**
 * 已安装插件分类视图 —— 原位增强官方 Installed 列表，不开新标签。
 *
 * 教训驱动的设计：不重排官方卡片（flex 重排会破坏官方网格、React 重建后样式
 * 残留、往卡片插节点会触发跨插件回环）。官方卡片整片隐藏，我们自己渲染一份
 * 分类列表插进同一个滚动容器；数据从官方卡片 DOM 读，开关代理点击官方开关。
 * 官方 React 怎么重建都不影响我们——它从不知道自己的卡片被 CSS 藏起来了。
 *
 * 功能：自动分类（RULES 关键词）+ 手动调整（拖到 chip / 行内下拉）+ 搜索 +
 * 单类折叠（chip）+ 全部折叠 + 密度切换 + 自定义分类。开关/详情/卸载走官方。
 * 布局存宿主半边 /installed-groups/layout（$DSH_HOME 文件），没挂上退回 localStorage。
 */
window.__ModuleLoader__.load({
  id: 'dsh-installed-groups',
  factory() {
    const BODY = '[data-plugin-body]'
    const DETAIL = '[data-plugin-detail],[data-plugin-item-detail],[data-plugin-row-detail],[data-market-detail]'
    const CARD = 'li[data-plugin-package],li[data-plugin-item]'
    const LAYOUT_ROUTE = '/installed-groups/layout'
    const LAYOUT_STORE = 'dsh-installed-groups.layout.v1'
    const DENSITY_STORE = 'dsh-installed-groups.density.v1'
    const UNGROUPED = '__other__'

    /** 自动分类规则：按序匹配，第一条命中定类。匹配包名或简介（中英皆宜）。 */
    const RULES = [
      { id: 'ui', name: '界面', color: '#4f86d6', kw: ['sidebar', 'theme', 'font', 'width', 'footer', 'nav', 'layout', 'scroll', 'ui-', 'badge', 'brand', '界面', '主题', '侧边', '外观', '缩放', '折叠'] },
      { id: 'chat', name: '对话', color: '#3fa88a', kw: ['chat', 'composer', 'message', 'conversation', 'quote', 'continue', '语音', '输入', '消息', '对话', '提示词'] },
      { id: 'agent', name: 'Agent 能力', color: '#9a6bd1', kw: ['agent', 'subagent', 'goal', 'workflow', 'todo', 'schedule', 'team', 'skill', 'preset', '编排', '任务', '技能', '定时'] },
      { id: 'memory', name: '记忆/知识', color: '#c98a3f', kw: ['memory', 'recall', 'knowledge', 'context', 'mnemon', 'reme', '记忆', '知识', '上下文'] },
      { id: 'browser', name: '浏览器/自动化', color: '#4aa3c7', kw: ['browser', 'computer-use', 'ego', 'playwright', 'cdp', 'screenshot', '浏览器', '自动化', '截图'] },
      { id: 'model', name: '模型/账号', color: '#c2607a', kw: ['model', 'provider', 'account', 'balance', 'token', 'llm', 'vendor', 'qoder', 'workbuddy', 'deepseek', '模型', '账号', '额度'] },
      { id: 'data', name: '数据/文档', color: '#7d9a3f', kw: ['database', 'sql', 'office', 'document', 'file', 'export', 'csv', 'excel', '数据', '文档', '文件', '表格'] },
      { id: 'dev', name: '开发工具', color: '#b06a4a', kw: ['git', 'ide', 'terminal', 'code', 'dev', 'debug', 'editor', 'lsp', 'market', '开发', '编译', '终端', '市场'] },
      { id: 'notify', name: '通知', color: '#3fa3b8', kw: ['notify', 'notification', 'sound', 'alert', 'webhook', '通知', '提醒', '声音'] },
      { id: 'sys', name: '系统工具', color: '#8a8a8a', kw: ['restart', 'reload', 'update', 'config', 'backup', 'mask', 'prune', 'purge', 'sandbox', 'safety', 'armory', 'pocket', '重启', '刷新', '更新', '配置', '安全'] },
    ]
    const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]))
    const titleOf = (id) => (id === UNGROUPED ? '未分类' : RULE_BY_ID.get(id)?.name ?? id)
    const colorOf = (id) => RULE_BY_ID.get(id)?.color ?? '#8a8a8a'

    function autoCategoryOf(name, description) {
      const text = `${name} ${description}`.toLowerCase()
      for (const rule of RULES) {
        if (rule.kw.some((word) => text.includes(word.toLowerCase()))) return rule.id
      }
      return UNGROUPED
    }

    /* ------------------------------------------------------------------ layout */

    function normalizeLayout(value) {
      const source = value && typeof value === 'object' ? value : {}
      const assign = {}
      if (source.assign && typeof source.assign === 'object' && !Array.isArray(source.assign)) {
        for (const [name, cat] of Object.entries(source.assign)) {
          if (typeof name === 'string' && typeof cat === 'string' && cat) assign[name] = cat.slice(0, 60)
        }
      }
      const list = (field, cap) => Array.isArray(source[field])
        ? [...new Set(source[field].filter((id) => typeof id === 'string' && id))].slice(0, cap)
        : []
      return { version: 1, assign, cats: list('cats', 100).filter((id) => !RULE_BY_ID.has(id)), order: list('order', 200) }
    }

    let storageMode = ''
    let layout = normalizeLayout(null)

    function readLocal() {
      try {
        const raw = window.localStorage.getItem(LAYOUT_STORE)
        return raw ? normalizeLayout(JSON.parse(raw)) : null
      } catch { return null }
    }

    const isEmptyLayout = (value) =>
      !Object.keys(value.assign).length && !value.cats.length && !value.order.length

    async function loadLayout() {
      try {
        const res = await fetch(LAYOUT_ROUTE, { cache: 'no-store' })
        if (res.ok) {
          const body = await res.json()
          if (body?.ok && body.layout) {
            storageMode = 'file'
            const file = normalizeLayout(body.layout)
            // 迁移：宿主文件是空的而浏览器里有旧数据（路由挂载前手动归的类）
            // → 把 localStorage 那份接过来并落盘，别让重启抹掉手动分类。
            const local = readLocal()
            if (isEmptyLayout(file) && local && !isEmptyLayout(local)) {
              layout = local
              persist()
              return local
            }
            return file
          }
        }
      } catch { /* 路由未挂载 */ }
      storageMode = 'local'
      return readLocal() ?? normalizeLayout(null)
    }

    let saveTimer = 0
    function persist() {
      try { window.localStorage.setItem(LAYOUT_STORE, JSON.stringify(layout)) } catch { /* 不持久也要能用 */ }
      if (storageMode !== 'file') return
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        fetch(LAYOUT_ROUTE, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(layout),
        }).catch(() => { /* localStorage 仍有副本 */ })
      }, 120)
    }

    function mutateLayout(mutate) {
      layout = normalizeLayout({ ...layout, ...mutate(layout) })
      persist()
      scheduleReconcile()
    }

    function setCategory(name, category) {
      mutateLayout((current) => {
        const assign = { ...current.assign }
        if (category) assign[name] = category
        else delete assign[name]
        return { assign }
      })
    }

    function addCategory(rawName) {
      const id = rawName.trim().slice(0, 30)
      if (!id || RULE_BY_ID.has(id) || id === UNGROUPED) return
      mutateLayout((current) => current.cats.includes(id) ? {} : { cats: [...current.cats, id] })
    }

    function renameCategory(oldId, rawName) {
      const next = rawName.trim().slice(0, 30)
      if (!next || next === oldId || RULE_BY_ID.has(next) || next === UNGROUPED) return
      mutateLayout((current) => {
        const assign = {}
        for (const [name, cat] of Object.entries(current.assign)) assign[name] = cat === oldId ? next : cat
        return {
          assign,
          cats: [...new Set(current.cats.map((cat) => (cat === oldId ? next : cat)))],
          order: [...new Set(current.order.map((id) => (id === oldId ? next : id)))],
        }
      })
    }

    function removeCategory(id) {
      mutateLayout((current) => ({
        cats: current.cats.filter((cat) => cat !== id),
        order: current.order.filter((cat) => cat !== id),
      }))
    }

    function reorderCategories(dragId, targetId) {
      if (!dragId || !targetId || dragId === targetId) return
      mutateLayout((current) => {
        const list = [...current.order]
        const from = list.indexOf(dragId)
        if (from >= 0) list.splice(from, 1)
        const to = list.indexOf(targetId)
        if (to >= 0) list.splice(to, 0, dragId)
        else list.push(dragId)
        return { order: [...new Set(list)] }
      })
    }

    /* -------------------------------------------------------------------- style */

    const STYLE = `
/* 官方卡片整片隐藏：只藏含卡片的分组容器（JS 打标），页头/tab/添加按钮留给官方自己渲染。 */
[data-plugin-body] > div[data-ig-group] { display:none !important; }
[data-plugin-body] > div[data-ig-header] { position:sticky; top:0; z-index:21; background:var(--dsw-alias-bg-base); }
.ig-view { display:flex; flex-direction:column; gap:0; }
.ig-bar { position:sticky; top:var(--ig-head-h,0); z-index:20; display:flex; flex-wrap:wrap; align-items:center; gap:6px;
  padding:8px 2px; background:var(--dsw-alias-bg-base); border-bottom:1px solid var(--dsw-alias-border-l1);
  font-size:12px; color:var(--dsw-alias-label-primary); }
.ig-bar input { padding:4px 10px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); color:inherit; outline:none; }
.ig-bar input:focus { border-color:var(--dsw-alias-brand-primary); }
.ig-chip { display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:12px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); cursor:pointer;
  user-select:none; font-size:12px; color:var(--dsw-alias-label-primary); }
.ig-chip em { font-style:normal; opacity:.65; }
.ig-chip.is-collapsed { opacity:.5; }
.ig-chip.is-drop { border-color:var(--dsw-alias-brand-primary); box-shadow:0 0 0 1px var(--dsw-alias-brand-primary); }
.ig-caret { width:10px; text-align:center; opacity:.8; }
.ig-chip-dot { width:8px; height:8px; border-radius:50%; }
.ig-btn { padding:3px 9px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); color:inherit; cursor:pointer; font-size:12px; }
.ig-btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); }
.ig-btn:disabled { opacity:.5; cursor:default; }
.ig-note { color:var(--dsw-alias-label-secondary); }
/* 分组面板：每类一块，底色按分类色浅染（color-mix 5%），组间一眼分开。
   color-mix 不支持时（老内核）退回中性层色，不会变黑块。 */
.ig-group { margin:12px 0; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; overflow:hidden;
  background:var(--dsw-alias-bg-layer-1); }
@supports (background: color-mix(in srgb, red 5%, white)) {
  .ig-group { background:color-mix(in srgb, var(--ig-acc, #888) 5%, var(--dsw-alias-bg-layer-1)); }
}
.ig-group.is-collapsed { background:var(--dsw-alias-bg-layer-1); }
.ig-head { display:flex; align-items:center; gap:8px; padding:10px 14px; cursor:pointer; user-select:none;
  font-size:14px; font-weight:600; color:var(--dsw-alias-label-primary); }
.ig-head:hover { background:var(--dsw-alias-bg-layer-2); }
.ig-head .ig-caret { font-size:12px; opacity:.8; }
.ig-head-dot { width:10px; height:10px; border-radius:50%; background:var(--ig-acc, #888); }
.ig-head em { font-style:normal; font-weight:500; font-size:12px; color:var(--dsw-alias-label-secondary); }
.ig-row { display:flex; align-items:center; gap:12px; padding:10px 14px;
  border-top:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-primary); }
.ig-row:hover { background:var(--dsw-alias-bg-layer-2); }
.ig-main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:3px; }
.ig-compact .ig-row { padding:5px 14px; }
.ig-compact .ig-desc { display:none; }
.ig-name { font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ig-name:hover { color:var(--dsw-alias-brand-primary); text-decoration:underline; }
.ig-desc { font-size:12px; color:var(--dsw-alias-label-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ig-tag { font-size:11px; padding:1px 7px; border-radius:9px; border:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary); flex:none; cursor:pointer; }
.ig-tag.is-manual { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.ig-cat-btn { font-size:12px; padding:3px 10px; border-radius:12px; flex:none; cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary); }
.ig-cat-btn:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-label-primary); }
.ig-cat-btn.is-manual { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); font-weight:600; }
.ig-menu { position:fixed; z-index:100; min-width:170px; max-height:300px; overflow:auto; padding:4px;
  border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-overlay);
  box-shadow:0 8px 24px rgba(0,0,0,.18); font-size:12px; color:var(--dsw-alias-label-primary); }
.ig-menu-item { display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:7px; cursor:pointer; }
.ig-menu-item:hover { background:var(--dsw-alias-bg-layer-2); }
.ig-menu-item::before { content:''; width:8px; height:8px; border-radius:50%; background:var(--ig-acc, transparent); flex:none; }
.ig-menu-item.is-active { color:var(--dsw-alias-brand-primary); font-weight:600; }
.ig-switch { position:relative; width:34px; height:18px; border-radius:9px; border:none; cursor:pointer;
  flex:none; padding:0; transition:background .15s; }
.ig-switch i { position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%;
  background:#fff; transition:left .15s; }
.ig-switch[data-on="true"] { background:var(--dsw-alias-state-success-primary); }
.ig-switch[data-on="true"] i { left:18px; }
.ig-switch[data-on="false"] { background:var(--dsw-alias-state-idle-primary); }
.ig-switch:disabled { opacity:.45; cursor:default; }
`

    /* ---------------------------------------------------------------- reconcile */

    /**
     * 全局令牌：HMR/重复注入会让多个实例的轮询同时往页面插工具栏（叠出多行）。
     * 每个实例 apply 时把 window 上的令牌换成自己的；reconcile 开头发现令牌
     * 不是自己的就彻底停摆——旧实例自动让位，页面永远只有一套视图。
     */
    const MY_TOKEN = `${Date.now()}.${Math.random()}`
    const TOKEN_KEY = '__dshInstalledGroupsToken'
    let pollTimer = 0

    const collapsed = new Set() // 会话内折叠的分类，不落盘
    let reconcileTimer = 0
    let density = (() => {
      try { return window.localStorage.getItem(DENSITY_STORE) === 'compact' ? 'compact' : 'comfortable' } catch { return 'comfortable' }
    })()

    /** 每个插件页实例一份视图（侧栏 + 中心区同开不串台）。 */
    const views = new WeakMap()

    function scheduleReconcile() {
      if (reconcileTimer) return
      reconcileTimer = setTimeout(() => { reconcileTimer = 0; reconcileAll() }, 80)
    }

    function orderedCategories(present) {
      const known = RULES.map((rule) => rule.id).filter((id) => present.has(id))
      known.sort((a, b) => {
        const ia = layout.order.indexOf(a)
        const ib = layout.order.indexOf(b)
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
      })
      const custom = [...new Set([...layout.cats, ...present])]
        .filter((id) => id !== UNGROUPED && !RULE_BY_ID.has(id))
      const ids = [...known, ...custom]
      if (present.has(UNGROUPED)) ids.push(UNGROUPED)
      return ids
    }

    function reconcileAll() {
      if (window[TOKEN_KEY] !== MY_TOKEN) {
        // 已被更新的实例接管：本实例连轮询一起停掉，不留后台噪音。
        if (pollTimer) clearInterval(pollTimer)
        return
      }
      for (const body of document.querySelectorAll(BODY)) {
        if (body.querySelector(DETAIL) || !body.querySelector(CARD)) {
          views.get(body)?.remove()
          views.delete(body)
          continue
        }
        ensureView(body)
      }
    }

    /** 读官方卡片的真实状态：名称、简介、开关（aria-checked）、可开关性。
     *  简介是 CardHead 的 span.cardDesc（CSS module 类名带 hash，用前缀匹配）。 */
    function readItems(body) {
      const items = []
      for (const li of body.querySelectorAll(CARD)) {
        const name = li.dataset.pluginPackage || li.dataset.pluginItem || ''
        if (!name) continue
        const description = li.querySelector('[class*="cardDesc"]')?.textContent?.trim() ?? ''
        const sw = li.querySelector('button[role="switch"],[role="switch"]')
        const enabled = sw ? sw.getAttribute('aria-checked') !== 'false' : null
        const switchable = Boolean(sw) && !sw.disabled
        items.push({ name, description, enabled, switchable, source: li })
      }
      return items
    }

    function ensureView(body) {
      // 官方子块分类打标（写前比对，页面没变时零写入）：
      // 含卡片的分组容器 → data-ig-group（CSS 隐藏）；第一个不含卡片的 div → data-ig-header（粘顶）。
      let header = null
      for (const el of body.children) {
        if (el.classList.contains('ig-view')) continue
        if (el.querySelector(CARD)) setAttr(el, 'data-ig-group', '1')
        else if (!header && el.tagName === 'DIV') { header = el; setAttr(el, 'data-ig-header', '1') }
        else { clearAttr(el, 'data-ig-group'); clearAttr(el, 'data-ig-header') }
      }
      if (header) setStyle(body, '--ig-head-h', `${header.offsetHeight}px`)

      let view = views.get(body)
      if (!view || !view.isConnected) {
        // 清掉前任实例留下的视图（本实例不认识它们；旧实例已停摆不会复活）。
        for (const stale of body.querySelectorAll(':scope > .ig-view')) stale.remove()
        view = document.createElement('div')
        view.className = 'ig-view'
        view.setAttribute('data-installed-groups', '')
        buildView(view, body)
        body.append(view)
        views.set(body, view)
      }
      refreshView(view, body)
    }

    function clearAttr(node, name) {
      if (node.hasAttribute(name)) node.removeAttribute(name)
    }

    /** 写前必比对：同值写入也算 DOM 变更，会喂给其它插件的观察器形成回环。 */
    function setAttr(node, name, value) {
      if (node.getAttribute(name) !== value) node.setAttribute(name, value)
    }

    function setStyle(el, prop, value) {
      if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value)
    }

    /* ------------------------------------------------------------------ 视图构建 */

    function buildView(view, body) {
      // 工具栏
      const bar = document.createElement('div')
      bar.className = 'ig-bar'
      const search = document.createElement('input')
      search.className = 'ig-q'
      search.placeholder = '搜索插件、简介、分类…'
      search.addEventListener('input', () => refreshView(view, body, true))
      const collapseAll = document.createElement('button')
      collapseAll.className = 'ig-btn ig-collapse-all'
      collapseAll.textContent = '△ 全部折叠'
      collapseAll.addEventListener('click', () => {
        const all = [...bar.querySelectorAll('.ig-chip')].map((chip) => chip.dataset.cat)
        const isAll = all.length > 0 && all.every((id) => collapsed.has(id))
        collapsed.clear()
        if (!isAll) all.forEach((id) => collapsed.add(id))
        refreshView(view, body)
      })
      const densityBtn = document.createElement('button')
      densityBtn.className = 'ig-btn'
      densityBtn.title = '一键切换行高密度'
      densityBtn.textContent = density === 'compact' ? '密度:紧凑' : '密度:舒适'
      densityBtn.addEventListener('click', () => {
        density = density === 'compact' ? 'comfortable' : 'compact'
        try { window.localStorage.setItem(DENSITY_STORE, density) } catch { /* ignore */ }
        densityBtn.textContent = density === 'compact' ? '密度:紧凑' : '密度:舒适'
        view.classList.toggle('ig-compact', density === 'compact')
      })
      const newCat = document.createElement('input')
      newCat.className = 'ig-newcat'
      newCat.placeholder = '＋ 新分类 回车'
      newCat.style.width = '110px'
      newCat.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        addCategory(event.target.value)
        event.target.value = ''
      })
      const note = document.createElement('span')
      note.className = 'ig-note'
      const chips = document.createElement('span')
      chips.className = 'ig-chips'
      chips.style.cssText = 'display:contents'
      bar.append(search, collapseAll, densityBtn, newCat, note, chips)

      const list = document.createElement('div')
      list.className = 'ig-list'
      view.append(bar, list)
      view.classList.toggle('ig-compact', density === 'compact')
      view._bar = bar
      view._list = list
      // 聚焦跟踪：输入框/分类菜单打开期间冻结重建（见 refreshView 的守卫）。
      view.addEventListener('focusin', (event) => {
        if (event.target.tagName === 'INPUT') view._busy = true
      })
      view.addEventListener('focusout', () => {
        view._busy = false
        scheduleReconcile()
      })
    }

    /* ------------------------------------------------------------------ 视图刷新 */

    function refreshView(view, body, force) {
      // 用户正在视图里操作（下拉/输入框聚焦）时不重建列表：重建会换掉节点、
      // 把展开的原生下拉立刻关掉。blur 事件里会补一次刷新，不会漏更新。
      // force=用户主动动作（搜索输入），照常刷新。
      if (view._busy && !force) return
      // 分类菜单展开时也不重建：锚点按钮被换掉菜单就悬空了。
      if (openMenu) return
      const items = readItems(body)
      const query = (view._bar.querySelector('.ig-q')?.value ?? '').trim().toLowerCase()

      const enriched = items.map((item) => {
        const category = layout.assign[item.name] ?? autoCategoryOf(item.name, item.description)
        const matches = !query
          || `${item.name} ${item.description}`.toLowerCase().includes(query)
          || titleOf(category).toLowerCase().includes(query)
        return { ...item, category, manual: Boolean(layout.assign[item.name]), matches }
      })
      const counts = new Map()
      for (const item of enriched) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
      const ids = orderedCategories(new Set(enriched.map((item) => item.category)))

      updateChips(view, ids, counts)

      // 列表：整段重建（都是我们自己的节点，重建成本极低且无 React 纠纷）。
      const nodes = []
      for (const id of ids) {
        const rows = enriched.filter((item) => item.category === id && item.matches)
        if (rows.length === 0 && !layout.cats.includes(id)) continue
        const head = document.createElement('div')
        head.className = 'ig-head'
        head.dataset.cat = id
        const caret = document.createElement('span')
        caret.className = 'ig-caret'
        caret.textContent = collapsed.has(id) ? '▸' : '▾'
        const dot = document.createElement('i')
        dot.className = 'ig-head-dot'
        const label = document.createElement('span')
        label.textContent = titleOf(id)
        const count = document.createElement('em')
        count.textContent = ` ${counts.get(id) ?? 0}`
        head.append(caret, dot, label, count)
        const group = document.createElement('div')
        group.className = `ig-group${collapsed.has(id) ? ' is-collapsed' : ''}`
        group.style.setProperty('--ig-acc', colorOf(id))
        group.append(head)
        if (collapsed.has(id)) {
          head.title = '点击展开本类'
          head.addEventListener('click', () => { collapsed.delete(id); refreshView(view, body) })
          nodes.push(group)
          continue
        }
        head.title = '点击折叠本类'
        head.addEventListener('click', () => { collapsed.add(id); refreshView(view, body) })
        if (rows.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'ig-note'
          empty.style.padding = '6px 14px 12px'
          empty.textContent = '空分类：把插件行拖到顶部分类 chip，或用行内下拉选它。'
          group.append(empty)
        }
        for (const item of rows) group.append(rowNode(view, body, item, ids))
        nodes.push(group)
      }
      view._list.replaceChildren(...nodes)

      const note = view._bar.querySelector('.ig-note')
      note.textContent = `${items.length} 个插件${storageMode === 'local' ? ' · 暂存:浏览器' : ''}`
    }

    /** 一行插件：名称（点击=打开官方详情）、简介、手动徽标、换类下拉、开关（代理官方）。 */
    function rowNode(view, body, item, ids) {
      const row = document.createElement('div')
      row.className = 'ig-row'
      row.draggable = true
      row.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', `item:${item.name}`)
      })

      const name = document.createElement('span')
      name.className = 'ig-name'
      name.textContent = item.name
      name.title = '打开官方详情页'
      name.addEventListener('click', () => {
        // 打开官方详情：卡片虽被 CSS 隐藏，.click() 仍会派发到 React 处理器。
        // 标题是 CardHead 里的可点元素：优先非开关的按钮，兜底点卡片本身。
        const card = item.source.isConnected ? item.source : null
        if (!card) return
        const target = [...card.querySelectorAll('button')].find((btn) => btn.getAttribute('role') !== 'switch')
        if (target) target.click()
        else card.click()
      })

      const desc = document.createElement('span')
      desc.className = 'ig-desc'
      desc.textContent = item.description
      desc.title = item.description

      const tag = document.createElement('span')
      tag.className = `ig-tag${item.manual ? ' is-manual' : ''}`
      tag.textContent = item.manual ? '手动' : '自动'
      tag.title = item.manual ? '手动指定，点击恢复自动' : '按名称/简介自动归类'
      if (item.manual) tag.addEventListener('click', () => setCategory(item.name, ''))

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `ig-cat-btn${item.manual ? ' is-manual' : ''}`
      btn.textContent = (item.manual ? '' : '↺ ') + titleOf(item.category)
      btn.title = item.manual
        ? `手动归类：${titleOf(item.category)}，点选可改；选「↺ 自动归类」恢复规则`
        : `自动归类：${titleOf(item.category)}，点选即手动`
      btn.addEventListener('click', () => openCatMenu(btn, item, ids))

      const sw = document.createElement('button')
      sw.className = 'ig-switch'
      sw.type = 'button'
      sw.append(document.createElement('i'))
      if (item.switchable && item.enabled !== null) {
        sw.dataset.on = String(item.enabled)
        sw.title = item.enabled ? '点击停用' : '点击启用'
        sw.addEventListener('click', () => {
          const official = item.source.isConnected
            ? item.source.querySelector('button[role="switch"],[role="switch"]')
            : null
          if (official && !official.disabled) official.click()
          // 官方状态变化由下一轮轮询/操作反馈刷新
          scheduleReconcile()
        })
      } else {
        sw.disabled = true
        sw.dataset.on = String(item.enabled ?? false)
        sw.title = item.enabled === null ? '这一行没有开关（内核管理或尚未加载）' : '当前不可切换'
      }

      // 名称+简介竖排两行：左列 .ig-main，右侧徽标/分类按钮/开关。
      const main = document.createElement('div')
      main.className = 'ig-main'
      main.append(name, desc)
      row.append(main, tag, btn, sw)
      return row
    }

    /** 分类选择菜单：自绘浮层（原生 select 展开是系统样式，与页面不搭）。 */
    let openMenu = null
    function closeCatMenu() {
      openMenu?.remove()
      openMenu = null
    }
    document.addEventListener('click', (event) => {
      if (openMenu && !openMenu.contains(event.target) && !event.target.closest('.ig-cat-btn')) closeCatMenu()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeCatMenu()
    })

    function openCatMenu(btn, item, ids) {
      if (openMenu?.anchor === btn) { closeCatMenu(); return }
      closeCatMenu()
      const menu = document.createElement('div')
      menu.className = 'ig-menu'
      menu.anchor = btn
      const entries = [{ value: '', label: '↺ 自动归类', color: '' },
        ...ids.map((id) => ({ value: id, label: titleOf(id), color: colorOf(id) }))]
      for (const entry of entries) {
        const row = document.createElement('div')
        row.className = `ig-menu-item${(item.manual ? item.category : '') === entry.value ? ' is-active' : ''}`
        row.style.setProperty('--ig-acc', entry.color || 'transparent')
        row.textContent = entry.label
        row.addEventListener('click', () => {
          closeCatMenu()
          if (entry.value !== (item.manual ? item.category : '')) setCategory(item.name, entry.value)
        })
        menu.append(row)
      }
      document.body.append(menu)
      const rect = btn.getBoundingClientRect()
      const space = window.innerHeight - rect.bottom
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`
      if (space < menu.offsetHeight + 12) menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 6)}px`
      else menu.style.top = `${rect.bottom + 6}px`
      openMenu = menu
    }

    /* -------------------------------------------------------------------- chips */

    function updateChips(view, ids, counts) {
      const chips = view._bar.querySelector('.ig-chips')
      const signature = ids.map((id) => `${id}:${collapsed.has(id) ? 'c' : 'o'}:${layout.cats.includes(id) ? 'x' : ''}`).join('|')
      if (chips.dataset.sig === signature) return
      chips.dataset.sig = signature
      // 重建前必须清空：否则每次签名变化都往同一容器追加一排，筛选栏越叠越长。
      chips.replaceChildren()
      const allCollapsed = ids.length > 0 && ids.every((id) => collapsed.has(id))
      view._bar.querySelector('.ig-collapse-all').textContent = allCollapsed ? '▽ 全部展开' : '△ 全部折叠'
      for (const id of ids) {
        const chip = document.createElement('span')
        chip.className = `ig-chip${collapsed.has(id) ? ' is-collapsed' : ''}`
        chip.dataset.cat = id
        chip.draggable = true
        chip.title = '卡片/行拖到这里=移入本类；拖动 chip 排类序'
        const dot = document.createElement('i')
        dot.className = 'ig-chip-dot'
        dot.style.background = colorOf(id)
        const label = document.createElement('span')
        label.textContent = titleOf(id)
        const count = document.createElement('em')
        count.textContent = String(counts.get(id) ?? 0)
        chip.append(dot, label, count)
        if (layout.cats.includes(id)) {
          const rename = document.createElement('button')
          rename.className = 'ig-btn'
          rename.type = 'button'
          rename.textContent = '✎'
          rename.title = '重命名（Enter 确认 / Esc 取消）'
          rename.addEventListener('click', () => {
            label.replaceWith(inlineEditor(id, titleOf(id), view))
            chips.dataset.sig = ''
          })
          const del = document.createElement('button')
          del.className = 'ig-btn'
          del.type = 'button'
          del.textContent = '×'
          del.title = (counts.get(id) ?? 0) === 0 ? '删除这个空分类' : '还有成员，先移空再删'
          del.disabled = (counts.get(id) ?? 0) > 0
          del.addEventListener('click', () => removeCategory(id))
          chip.append(rename, del)
        }
        chips.append(chip)
      }
    }

    /** Electron 里没有 window.prompt：行内输入框，Enter 确认、Esc/失焦收尾。 */
    function inlineEditor(id, current, view) {
      const input = document.createElement('input')
      input.value = current
      input.style.width = '90px'
      let done = false
      const finish = (commit) => {
        if (done) return
        done = true
        if (commit) renameCategory(id, input.value)
        else scheduleReconcile()
      }
      input.addEventListener('keydown', (event) => {
        event.stopPropagation()
        if (event.key === 'Enter') finish(true)
        if (event.key === 'Escape') finish(false)
      })
      input.addEventListener('blur', () => finish(true))
      input.addEventListener('click', (event) => event.stopPropagation())
      queueMicrotask(() => input.select())
      return input
    }

    /* 拖放：行/卡片 → chip 换类；chip → chip 排类序。委托在 document。 */
    document.addEventListener('dragstart', (event) => {
      const li = event.target instanceof Element ? event.target.closest(CARD) : null
      if (!li) return
      const name = li.dataset.pluginPackage || li.dataset.pluginItem || ''
      if (name) event.dataTransfer.setData('text/plain', `item:${name}`)
    })
    document.addEventListener('dragover', (event) => {
      const chip = event.target instanceof Element ? event.target.closest('.ig-chip') : null
      if (!chip) return
      event.preventDefault()
      chip.classList.add('is-drop')
    })
    document.addEventListener('dragleave', (event) => {
      const chip = event.target instanceof Element ? event.target.closest('.ig-chip') : null
      if (chip?.contains(event.relatedTarget ?? null)) return
      chip?.classList.remove('is-drop')
    })
    document.addEventListener('drop', (event) => {
      const chip = event.target instanceof Element ? event.target.closest('.ig-chip') : null
      if (!chip) return
      event.preventDefault()
      chip.classList.remove('is-drop')
      const payload = event.dataTransfer?.getData('text/plain') ?? ''
      if (payload.startsWith('item:')) setCategory(payload.slice(5), chip.dataset.cat)
      else if (payload.startsWith('head:')) reorderCategories(payload.slice(5), chip.dataset.cat)
    })

    /* ------------------------------------------------------------------ 生命周期 */

    /**
     * 不用 MutationObserver，700ms 轮询 + 全量 diff 写：页面没变时每轮只读不写。
     * 视图节点被官方重建顶掉时（append 后 React 重渲染 body 子级），下一轮补挂。
     */
    let started = false

    return {
      inject: [],
      apply() {
        if (started) return
        started = true
        window[TOKEN_KEY] = MY_TOKEN // 接管：旧实例的下一轮 reconcile 自动停摆
        document.querySelectorAll('style[data-installed-groups]').forEach((node) => node.remove())
        const styleTag = document.createElement('style')
        styleTag.setAttribute('data-installed-groups', 'base')
        styleTag.textContent = STYLE
        document.head.append(styleTag)
        loadLayout().then((loaded) => { layout = loaded })
        reconcileAll()
        pollTimer = setInterval(reconcileAll, 700)
      },
    }
  },
})
