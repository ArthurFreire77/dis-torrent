/*
 * Ponte CDP para o app REAL do DisTorrent (WebView2).
 * Uso: node app.mjs <launch|kill|status|eval|shot|layout|watch|log> [...]
 *
 * Por que Playwright: ele já é dependência do projeto e fala CDP nativamente,
 * então nenhuma ferramenta nova precisa ser instalada na máquina do usuário.
 */
import { chromium } from 'playwright-core'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../../..')
const EXE = path.join(REPO, 'src-tauri/target/release/distorrent.exe')
const PORT = 9222
const DEVTOOLS = `http://127.0.0.1:${PORT}`
const RIG_DIR = path.join(process.env.TEMP || '.', 'opencode/dt-rig')
const WATCH_DIR = path.join(RIG_DIR, 'watch')

function cdpAlive() {
  return fetch(`${DEVTOOLS}/json/version`, { signal: AbortSignal.timeout(2500) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
}

function appPids() {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      "Get-Process -Name distorrent -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }",
    ], { encoding: 'utf8' })
    return out.split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
}

async function kill() {
  for (const pid of appPids()) {
    try { process.kill(pid, 'SIGTERM') } catch { /* já morreu */ }
  }
  await new Promise((r) => setTimeout(r, 1200))
  for (const pid of appPids()) {
    try { process.kill(pid, 'SIGKILL') } catch { /* já morreu */ }
  }
  await new Promise((r) => setTimeout(r, 500))
  console.log(appPids().length === 0 ? 'APP FECHADO' : 'AINDA VIVO: ' + appPids().join(','))
}

async function launch() {
  if (await cdpAlive()) {
    console.log('CDP JÁ ATIVO ' + (await cdpAlive()).Browser)
    return
  }
  if (appPids().length > 0) {
    console.log('app aberto sem CDP — fechando (single-instance impediria a nova janela)')
    await kill()
  }
  if (!fs.existsSync(EXE)) throw new Error('binário não encontrado: ' + EXE)
  const child = spawn(EXE, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  })
  child.unref()
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const v = await cdpAlive()
    if (v) {
      console.log('CDP OK ' + v.Browser + '  pid=' + appPids().join(','))
      return
    }
  }
  throw new Error('o app subiu mas o CDP não respondeu em 30s')
}

async function connect() {
  const browser = await chromium.connectOverCDP(DEVTOOLS, { timeout: 15000 })
  const ctx = browser.contexts()[0]
  if (!ctx) throw new Error('sem contexto CDP')
  let page = ctx.pages().find((p) => !p.url().startsWith('devtools://'))
  if (!page) page = await ctx.newPage()
  // O app demora a montar (boot/update gate); espera o #root ter conteúdo.
  const ready = await page
    .waitForFunction(() => !!document.getElementById('root')?.children.length, null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  return { browser, page, ready }
}

async function evaluate(js) {
  const { browser, page } = await connect()
  try {
    const value = await page.evaluate(`(async () => { ${js} })()`)
    console.log(JSON.stringify(value, null, 2))
  } finally {
    await browser.close()
  }
}

async function shot(file) {
  const target = path.resolve(file || path.join(RIG_DIR, `shot-${Date.now()}.png`))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const { browser, page } = await connect()
  try {
    await page.bringToFront().catch(() => {})
    await page.screenshot({ path: target })
    console.log(target)
  } finally {
    await browser.close()
  }
}

/* Coleta de layout: percorre o DOM pintado e acha caixas que não cabem. */
const LAYOUT_SCRIPT = `(() => {
  const out = []
  const vw = window.innerWidth, vh = window.innerHeight
  const all = document.querySelectorAll('body *')
  for (const el of all) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    if (el.children.length > 12) { /* ainda mede: é um container */ }
    const cw = el.clientWidth, ch = el.clientHeight
    const sw = el.scrollWidth, sh = el.scrollHeight
    const tag = el.tagName.toLowerCase()
    const id = el.getAttribute('data-testid') || el.getAttribute('data-call-tile') ||
               el.getAttribute('data-call-participant') || el.id || ''
    const cls = (el.className && typeof el.className === 'string') ? el.className.trim().slice(0, 60) : ''
    out.push({
      tag, id, cls,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      cw, ch, sw, sh,
      ox: cs.overflowX, oy: cs.overflowY,
      flex: cs.flex, minW: cs.minWidth, minH: cs.minHeight,
      text: (el.childElementCount === 0 ? (el.textContent || '').trim().slice(0, 40) : ''),
      squeezed: cw > 0 && sw > cw + 2,
      flattened: ch > 0 && sh > ch + 2 && (cs.overflowY === 'hidden' || cs.overflowY === 'clip'),
    })
  }
  const problems = []
  for (const n of out) {
    if (n.squeezed) problems.push({ kind: 'squeezed', path: n.tag + (n.id ? '#' + n.id : ''), w: n.w, sw: n.sw, text: n.text })
    if (n.flattened) problems.push({ kind: 'flattened', path: n.tag + (n.id ? '#' + n.id : ''), h: n.h, sh: n.sh, text: n.text })
    if ((n.w < 90 && n.h > 200) || (n.h < 40 && n.w > 150)) {
      problems.push({ kind: 'sliver', path: n.tag + (n.id ? '#' + n.id : ''), w: n.w, h: n.h, text: n.text })
    }
  }
  return { viewport: { w: vw, h: vh }, nodeCount: out.length, problems, nodes: out }
})()`

async function layout({ print = false } = {}) {
  const { browser, page, ready } = await connect()
  try {
    const data = await page.evaluate(LAYOUT_SCRIPT)
    if (print) return data
    console.log(JSON.stringify({ viewport: data.viewport, nodeCount: data.nodeCount, problems: data.problems }, null, 2))
    const offenders = data.nodes
      .filter((n) => n.id || n.tag === 'textarea' || n.cls)
      .sort((a, b) => a.w * a.h - b.w * b.h)
      .slice(0, 15)
    console.error('\nmenores caixas com identidade:')
    for (const n of offenders) {
      console.error(`  ${String(n.w).padStart(5)}x${String(n.h).padStart(5)}  ${n.tag}${n.id ? '#' + n.id : ''}${n.cls ? '.' + n.cls.split(' ')[0] : ''}  ${n.text}`)
    }
    if (!ready) console.error('aviso: #root ainda vazio quando medi')
    return data
  } finally {
    await browser.close()
  }
}

async function watch(seconds) {
  fs.mkdirSync(WATCH_DIR, { recursive: true })
  const total = (Number(seconds) || 90) * 1000
  const { browser, page } = await connect()
  let lastSig = ''
  let samples = 0
  const started = Date.now()
  try {
    while (Date.now() - started < total) {
      const data = await page.evaluate(LAYOUT_SCRIPT).catch(() => null)
      if (!data) break
      samples++
      const sig = JSON.stringify(data.problems)
      if (sig !== lastSig) {
        const file = path.join(WATCH_DIR, `change-${String(samples).padStart(4, '0')}.json`)
        fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...data }, null, 2))
        console.log(`${new Date().toISOString()}  ${data.problems.length} problema(s)  -> ${file}`)
        for (const p of data.problems.slice(0, 6)) console.log(`   ${p.kind} ${p.path} w=${p.w} h=${p.h}`)
        lastSig = sig
      }
      await new Promise((r) => setTimeout(r, 700))
    }
    console.log(`fim: ${samples} amostras, arquivos em ${WATCH_DIR}`)
  } finally {
    await browser.close()
  }
}

async function log(which = 'win', lines = '60') {
  const n = Number(lines) || 60
  if (which === 'core') {
    const f = path.join(process.env.APPDATA || '.', 'com.distorrent.app', 'distorrent.log')
    if (!fs.existsSync(f)) throw new Error('log do core não encontrado: ' + f)
    const text = fs.readFileSync(f, 'utf8').split(/\r?\n/)
    console.log(text.slice(-n).join('\n'))
    return
  }
  const { browser, page } = await connect()
  const bucket = []
  page.on('console', (m) => bucket.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => bucket.push(`[pageerror] ${e.message}`))
  await new Promise((r) => setTimeout(r, 1500))
  await browser.close()
  console.log(bucket.slice(-n).join('\n') || '(sem mensagens novas)')
}

const [cmd, ...rest] = process.argv.slice(2)
try {
  if (cmd === 'launch') await launch()
  else if (cmd === 'kill') await kill()
  else if (cmd === 'status') {
    const v = await cdpAlive()
    console.log(v ? 'CDP OK ' + v.Browser + '  pid=' + appPids().join(',') : 'CDP OFF  pid=' + appPids().join(','))
  } else if (cmd === 'eval') await evaluate(rest[0] || 'return null')
  else if (cmd === 'shot') await shot(rest[0])
  else if (cmd === 'layout') await layout()
  else if (cmd === 'prova') {
    // Prova antes/depois: script separado, roda da raiz do repo para achar
    // `playwright-core` (dependência já existente do projeto).
    const prova = path.join(import.meta.dirname, 'prova-layout.mjs')
    execFileSync(process.execPath, [prova], { cwd: REPO, stdio: 'inherit' })
  }
  else if (cmd === 'watch') await watch(rest[0])
  else if (cmd === 'log') await log(rest[0], rest[1])
  else {
    console.error('uso: app.mjs <launch|kill|status|eval|shot|layout|watch|log> [...]')
    process.exit(64)
  }
} catch (e) {
  console.error('FALHOU: ' + (e?.message || e))
  process.exit(1)
}
