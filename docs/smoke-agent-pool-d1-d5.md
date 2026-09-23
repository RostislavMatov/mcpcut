# Смок: хвосты фазы 5 пула (D1–D5) — резиденты, обе ревизии, пул в выгрузке ребёнка, `ungranted`

Дата: 2026-09-23. Ветка `feat/agent-pool-d1-d5` (незакоммиченное рабочее дерево — волны 0–5 плана и
исправления ревью). План — `.claude/PRPs/plans/completed/agent-pool-d1-d5.plan.md`, Task 27.

**Версии.** mcpcut 0.1.0 (tarball из рабочего дерева, на Mac — `npm i -g --prefix <scratch>`). Node на
Mac 25.6.0, в контейнерах `node:24-bookworm-slim`. `@modelcontextprotocol/sdk` 1.30.0 (клиент),
`@modelcontextprotocol/server` + `@modelcontextprotocol/node` 2.0.0 (сервер только на новой ревизии),
Claude Code 2.1.280 (`claude-haiku-4-5-20251001`), `caddy:2`.

## Стенд

- **Сервис — на VPS S2**, отдельный compose-проект `mcpcut-d15` в `/root/mcpcut-d15` (права 0700):
  образ продукта собран на S2 из рабочего дерева (без `.claude`, `docs`, `tests`, `.git`); поверх —
  образ смока со **сторонними** серверами, поставленными бинарями: `@upstash/context7-mcp@4.1.1`,
  `@sveltejs/mcp@0.1.26`, `terraform-mcp-server` 1.3.0 (zip с `releases.hashicorp.com`, sha256 сверен
  с официальным `SHA256SUMS`) и сервер **только на `2026-07-28`** на официальном TS SDK v2
  (`serveStdio(f, { legacy: 'reject' })` и `createMcpHandler(f, { legacy: 'reject' })` +
  `toNodeHandler`; HTTP-вариант — сервис `modern-http` только в сети проекта).
- TLS — Caddy + Let's Encrypt на `<S2-dashed>.sslip.io:8443` (443 на S2 занят); наружу — только 80 и
  8443, ~25 минут. UI не публиковался.
- Токены админа и агента — в файлах `0600` на S2 (в команды — через окружение, `-e MCP_ADMIN_TOKEN`
  без значения), на Mac — в файле `0600` и конфиге клиента `0600`; удалены при разборе.
- Реестр: stdio `context7`, `svelte`, `terraform` (`terraform-mcp-server stdio`), `modern`
  (SDK v2 stdio), `ctx7npx` и `ctx7npx2` (**одинаковая** командная строка `npx -y
  @upstash/context7-mcp@4.1.1`); HTTP `deepwiki`, `context7-http`, `mslearn`, `aws`, `cfdocs`,
  `modern-http` (`auto`), `modern-http-sl` (`--protocol stateless`). Политика — `allow`, карантин
  выключен. GitHub не брали: PAT не выдавался.

## Результаты

### A. Развёртывание

| # | Проверка | Итог |
|---|---|---|
| A1 | сборка продукта и образа смока на 2 CPU; `ui`/`serve` healthy | ✅ |
| A2 | сертификат Let's Encrypt | ✅ `certificate obtained successfully` |
| A3 | `POST https://…:8443/mcp` без токена с Mac | ✅ 401, `ssl_verify_result 0` |
| A4 | первый владелец через `exec`; токен не в логах контейнеров | ✅ |

### B. Реестр, агент, гранты

| # | Проверка | Итог |
|---|---|---|
| B1 | `server add` ×13 с регистрационной пробой | ✅ все `alive`; **`modern` и оба `modern-http*` — `alive via tools/list`** (RV6), остальные — `via initialize` |
| B2 | `agent create bot`: блок `connect --url https://…:8443`, без `--allow-http`; токен ровно в `token:` и `env` | ✅ (2 вхождения) |

### C. Резиденты (D1+, D5, ADR-0016)

| # | Проверка | Итог |
|---|---|---|
| C1 | грант шести stdio-серверов → старт **до** любого подключения | ✅ все шесть `ready` за ~20 с после грантов (14:15:59 → 14:16:19), ни одного клиента |
| C2 | ≤ 2 старта одновременно, одинаковые командные строки — по очереди (BU4) | ✅ `ctx7npx` ready 14.45, `ctx7npx2` ready 19.74 (+5.3 с ≈ длительность одного `npx`); после рестарта `serve` — 04.70 → 08.44 |
| C3 | тот же процесс при переподключении | ✅ 10 процессов с теми же pid до и после трёх отдельных подключений SDK-клиента |
| C4 | убийство резидента (`kill -9`) → перезапуск с паузой | ✅ `ended (server-ended); restarting in 1 s`, новый pid, `ready` через 1.65 с |
| C5 | ungrant без подключения → остановка | ✅ `stopped (revoked)` через **2.8 с** |
| C6 | рестарт `serve` → резиденты вернулись сами | ✅ все шесть `ready` за 7.3 с, число процессов то же (10) |
| C7 | тёплый сервер сверх потолка вживую | — не прогонялось (потолок 32 не достижим без 33 пар; покрыто `tests/cli/serve-pool-warm.test.ts`) |

### D. Бюджет старта (D1)

| # | Проверка | Итог |
|---|---|---|
| D1 | первый `tools/list` при живых резидентах | ✅ **1.79 с** на 13 серверов (37 тулзов): 6 резидентов + 7 HTTP, открытых по требованию |
| D2 | сломанная команда (`node -e process.exit(3)`) | ✅ пул отказал сразу — `attach-refused ended-during-start`, весь список 1.6 с; резидент — паузы 1 → 2 → 4 → 8 с |

### E. Обе ревизии (D4)

| # | Проверка | Итог |
|---|---|---|
| E1 | stdio-член только на `2026-07-28` (SDK v2) в пуле | ✅ `modern__shout` → `MODERN: STDIO MODERN`; резидент `ready (2026-07-28)` |
| E2 | HTTP-член только на `2026-07-28`, `auto` и `stateless` | ✅ `modern-http__shout`, `modern-http-sl__shout` отвечают |
| E3 | STATUS сервера новой ревизии | ✅ `alive via tools/list` (B1) |
| E4 | сторонние члены рядом | ✅ DeepWiki, Context7 (stdio и HTTP), MS Learn (`2025-06-18`), AWS Knowledge (имена `aws___…` → `aws__aws___…`, кодек `__` держит), Cloudflare Docs, Svelte (`2025-06-18`), Terraform (ответ самого сервера «provider not found» — вызов дошёл) |

### F. Пул в выгрузке дочерней сессии (D2)

| # | Проверка | Итог |
|---|---|---|
| F1 | `export --report --session <резидент context7>` | ✅ `Note: … was attached by 4 pool session(s) …`; в `summary.md` — блок «Pool membership … (from records outside this export)» с четырьмя сессиями пула, агентом, сервером, временем, `seq` и `(resident)`; заголовок — «attached by 4 pool sessions …; from records outside this export» |
| F2 | `verify --report` на Mac | ✅ `RESULT: PASSED` (подпись Ed25519) |

### G. Причина ухода (D3)

| # | Проверка | Итог |
|---|---|---|
| G1 | 5 циклов ungrant/regrant `svelte` при подключённом клиенте | ✅ **5/5** `detach ungranted` |

### H. Claude Code headless через пул

| # | Проверка | Итог |
|---|---|---|
| H1 | `deepwiki__read_wiki_structure` + `context7__resolve-library-id` | ✅ «Overview», `/colinhacks/zod` (24 с, 4 хода) |
| H2 | `modern__shout` (член новой ревизии) | ✅ `MODERN: HELLO FROM CLAUDE` |

### I. Разбор

| # | Проверка | Итог |
|---|---|---|
| I1 | токены админа и агента — в логах четырёх контейнеров и в 2030 записях журнала | ✅ 0 вхождений |
| I2 | `down -v`, образы, builder-кеш, `/root/mcpcut-d15` удалены; снимок `docker ps/images/volume/network` + `ss -ltn` после ≡ до | ✅ `SNAPSHOT MATCHES` |

## Находки

- **Ф1 (закрыто в волне):** между вотчем ребёнка и вотчем пула следующий `tools/list` пула просил
  только что отозванный сервер: надзор честно отказывал (`no-grant`, процесс не поднимался), но
  журнал получал `attach-refused no-grant`, а stderr — пару `starting`/`did not start`. Опенер теперь
  отказывает сам, по свежей записи агента, до надзора (`tests/cli/serve-pool-child.test.ts`).
- **Ф2 (закрыто в волне):** строка `[serve] resident …: starting` печаталась при постановке в очередь,
  а не при запуске — при шести грантах сразу «стартовали» шесть. Теперь `start queued`.
- **Ф3 (сеть, не продукт):** один вызов Claude Code к DeepWiki получил от моста `mcpcut bridge could not
  reach the service (… ETIMEDOUT)` — тот же обрыв Mac ↔ S2, что оборвал одно SSH-подключение в эти
  минуты. Мост остался жив, следующий вызов прошёл; повтор H1 — чисто.
- **Наблюдение:** повторный грант после отзыва перезапускает резидента (≈ 5 с на `svelte`), потому что
  отозванная сессия не хранится (RS6: `revoked` — не перезапускать). Первый `tools/list` после
  повторного гранта ждёт этот старт.
- **Наблюдение:** записи рукопожатия с `serverInfo` — не больше 4.9 КБ; больших `data:`-иконок у
  взятых серверов нет.

## Что не прогонялось

- Тёплый сервер сверх потолка 32 и вытеснение при нехватке слотов — нужны 33+ пары; покрыто тестами.
- GitHub (stdio и `api.githubcopilot.com`) — нет PAT.
- Интерактивный Claude Code и другие клиенты (Cursor, Claude Desktop).
- Ротация секрета вольта вживую — покрыто `tests/cli/serve-pool-residents-lifecycle.test.ts`.
