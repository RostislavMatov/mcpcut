// The browser half of docs/demo/claude-code.tape: while VHS records Claude Code in
// the terminal, this records the admin UI that answers it. Run by
// docs/demo/claude-code-render.sh, which joins both recordings by the times this
// script writes to $DEMO/times.json (milliseconds since the epoch):
//   t0       the tape's first visible frame ($DEMO/t0 is touched just before it)
//   rec1     the approvals scene starts: the dashboard with the held write
//   approve  Approve is pressed
//   rec2     the journal scene starts, a few seconds after Claude Code has written the file
//
// Needs playwright-core (PLAYWRIGHT_CORE: the path of its index.mjs) and a Chromium
// (CHROME: the executable). Signs in with the owner token the tape left in $DEMO/token,
// off camera, then records two fresh pages with that session.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'

const { chromium } = await import(process.env.PLAYWRIGHT_CORE)
const DEMO = process.env.DEMO
const UI = 'http://127.0.0.1:8091'
const SIZE = { width: 1220, height: 666 }
const POLL_MS = 300
const SHOW_WAIT_MS = 4_000
const times = {}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const GIVE_UP_MS = 180_000

async function until(check) {
  const deadline = Date.now() + GIVE_UP_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error(`gave up waiting: ${check.toString()}`)
    try {
      if (await check()) return
    } catch {
      // not there yet: the service is starting, the file is not written yet
    }
    await sleep(POLL_MS)
  }
}

function pendingWrite(token) {
  const out = execFileSync('mcpcut', ['approvals', 'list'], {
    env: { ...process.env, MCP_ADMIN_TOKEN: token },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return out.includes('write_file')
}

// The token file exists (empty) from the moment the shell opens it for the redirect, so wait for its content.
await until(() => existsSync(`${DEMO}/t0`) && readFileSync(`${DEMO}/token`, 'utf8').trim().length > 0)
times.t0 = statSync(`${DEMO}/t0`).mtimeMs
const token = readFileSync(`${DEMO}/token`, 'utf8').trim()
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true })

await until(async () => (await fetch(`${UI}/login`)).ok)
// The login page plays a short sign-in animation, then posts the form.
const signIn = await browser.newContext({ viewport: SIZE, colorScheme: 'dark' })
const login = await signIn.newPage()
await login.goto(`${UI}/login`)
await login.fill('#token', token)
await login.click('button[type=submit]')
await until(() => !new URL(login.url()).pathname.startsWith('/login'))
const storageState = await signIn.storageState()
await signIn.close()

async function scene(name, play) {
  const context = await browser.newContext({ viewport: SIZE, colorScheme: 'dark', storageState, recordVideo: { dir: `${DEMO}/${name}`, size: SIZE } })
  const page = await context.newPage()
  await play(page)
  await context.close()
}

await until(() => pendingWrite(token))
await sleep(SHOW_WAIT_MS)
times.rec1 = Date.now()
await scene('video1', async (page) => {
  await page.goto(`${UI}/`)
  await page.getByRole('button', { name: /^Approve$/ }).first().scrollIntoViewIfNeeded()
  await sleep(4_000)
  times.approve = Date.now()
  await page.getByRole('button', { name: /^Approve$/ }).first().click()
  await sleep(2_500)
})

await until(() => existsSync(`${DEMO}/home/project/todo.md`))
await sleep(6_000)
times.rec2 = Date.now()
await scene('video2', async (page) => {
  await page.goto(`${UI}/journal`)
  await sleep(2_500)
  await page.locator('a[href^="/journal?session="]').first().click()
  await sleep(7_000)
})

await browser.close()
writeFileSync(`${DEMO}/times.json`, JSON.stringify(times))
