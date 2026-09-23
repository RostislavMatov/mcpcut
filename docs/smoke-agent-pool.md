# Смок: пул агента живыми клиентами против сервиса на VPS (ADR-0015, фаза 5 PRD «пул агента»)

Дата: 2026-09-23. Ветка `feat/agent-pool-core`, HEAD `9d60e2d` + **незакоммиченная фаза 5** (рабочее
дерево целиком: связка пула в отчёте, скоуп уведомлений N1–N4, пометки длинных имён). План —
`.claude/PRPs/plans/completed/agent-pool-report-docs-smoke.plan.md`, волна 6.

**Версии.** mcpcut 0.1.0 (tarball из промежуточного каталога: `dist` + `package.json` + README/LICENSE/NOTICE,
1432 файла; ставился `npm i -g --prefix <scratch>` — на Mac в `PATH` клиентов стоял именно он). Node на
Mac 25.6.0, в контейнерах `node:24-bookworm-slim`. `@modelcontextprotocol/inspector` 2.7.0,
`@modelcontextprotocol/sdk` 1.30.0, `@modelcontextprotocol/client` 2.0.0, Claude Code 2.1.280 (модель
`claude-haiku-4-5-20251001`), `@modelcontextprotocol/server-everything` / `-memory` /
`-sequential-thinking` 2026.8.31, `caddy:2`.

## Стенд

- **Сервис — на VPS S2** (Ubuntu 22.04, x86_64, 2 CPU, ~3.9 ГБ RAM; общий хост — чужие службы на 443,
  2053, 2096, 1080 не трогались). Отдельный compose-проект `mcpcut-smoke` в `/root/mcpcut-smoke`:
  образ собран на S2 из рабочего дерева (`package*.json`, `tsconfig.json`, `src`, `docker`,
  `Dockerfile`, `docker-compose.yml`, `.dockerignore` — без `.claude`, `docs`, `tests`, `.git`);
  override добавил `caddy` (80, 8443 — единственное, что опубликовано наружу, на ~25 минут),
  `everything-http` (`server-everything streamableHttp`, только в сети проекта) и
  `MCPCUT_SERVE_PUBLIC_URL=https://<S2-dashed>.sslip.io:8443` обоим сервисам. Пример этого стенда без
  адреса смока — `docs/deploy/caddy/`.
- **TLS**: Caddy + Let's Encrypt по HTTP-01 на :80 для `<S2-dashed>.sslip.io` (443 занят →
  `https_port 8443`, `disable_tlsalpn_challenge`). Сертификат выдан с первого раза за ~5 с.
- **UI S2 наружу не публиковался**: только SSH-туннель. Локальный порт 8091 на Mac был занят
  собственным UI владельца, поэтому туннель встал на IPv6 `[::1]:8091`, и все проверки UI шли по
  `http://[::1]:8091` явно — иначе запрос мог уйти в локальный UI (Host-экран пропускает `[::1]:8091`).
- **Агент и клиенты — на этом Mac**, через `mcpcut connect --url` из tarball. Токены — в файлах `0600`,
  на S2 — в `.admin-token`/`.agent-token` `0600`, в команды попадали только через окружение
  (`-e MCP_ADMIN_TOKEN` без значения); все удалены при разборе.
- Реестр: `everything`, `memory` (`MEMORY_FILE_PATH=/tmp/memory.json`), `think`,
  `everything-registered-under-a-long-name-for-pe2-limits` (54 символа — PE2), `everything-http`
  (`--transport http --protocol sessionful`). Политика: `defaultDecision: allow`, карантин выключен,
  `memory.create_entities` → `require-approval`. Агент `smoke-bot`: гранты `*` на четыре сервера;
  группа `ops` с грантом `*` на `think` (агент в неё не входит до изменения 1).

## Результаты

### A. Развёртывание

| # | Проверка | Ожидание | Итог |
|---|---|---|---|
| A1 | `up -d --build` на 2 CPU | `ui`/`serve` healthy | ✅ (сборка ~3 мин) |
| A2 | сертификат Let's Encrypt для sslip-имени | `certificate obtained successfully` | ✅ |
| A3 | `curl https://<S2-dashed>.sslip.io:8443/mcp` с Mac | `401`, цепочка доверена системой (`ssl_verify_result 0`) | ✅ |
| A4 | первый владелец `docker compose exec -T ui mcpcut admin add owner --role owner` | токен только в stdout exec, не в логе контейнера | ✅ (sweep G4) |

### B. Реестр и блок

| # | Проверка | Ожидание | Итог |
|---|---|---|---|
| B1 | `server add` ×5, проба | все `alive` | ✅ после повтора — см. **Ф1**: первые пробы `npx` сразу после рестарта не уложились в 10 с; `server refresh` — `alive` за 2.0–2.5 с; HTTP-сервер — 164 мс |
| B2 | `agent create smoke-bot` | блок `mcpcut connect --url https://<S2-dashed>.sslip.io:8443`, **без** `--allow-http`, токен ровно в `token:` и `env` (2 вхождения) | ✅ |
| B3 | блок → `mcp.json` — «вставка»; дальше файл не правится | sha256 до и после всех изменений совпадает | ✅ (`configUnchanged: true`) |

### C. Живые клиенты через пул

| # | Проверка | Ожидание | Итог |
|---|---|---|---|
| C1 | Inspector CLI `tools/list` | имена с префиксами, серверы по алфавиту | ✅ 38 тулзов: `everything` 13, `everything-http` 13, длинный сервер 3, `memory` 9; порядок `everything`, `everything-http`, `everything-registered-…`, `memory` — **после Ф2**; до неё — 13 (только HTTP) |
| C2 | длинный сервер (PE2) | ≤ 64 — в списке (`…__echo` 60, `…__get-env` 63, `…__get-sum` 63 — warn), > 64 — скрыты | ✅ 3 в списке, 10 скрыты; запись `dropped`/`name-too-long` с `hiddenNames` на каждую сессию |
| C3 | Inspector `tools/call everything__echo message=pool-smoke-1` | `Echo: pool-smoke-1` | ✅ |
| C4 | SDK v1.30: `connect` → `serverInfo` | `mcpcut 0.1.0` | ✅ connect 549 мс, первый `tools/list` 6.6 с (дети поднимаются по PE7) |
| C5 | SDK: `trigger-long-running-operation` с `onprogress` (N2, позитивный путь вживую) | прогресс доходит до клиента | ✅ **3 события** прогресса, вызов 2.1 с |
| C6 | SDK: изменение 1 — `group join ops smoke-bot` | `list_changed`, в списке `think__*` | ✅ 1.90 с после записи (6.3 с с учётом ssh + `docker exec`) |
| C7 | SDK: изменение 2 — `agent ungrant smoke-bot memory` | `list_changed`, `memory__*` нет | ✅ 1.87 с после записи |
| C8 | SDK: изменение 3 — `agent grant smoke-bot memory --tools '*'` | `list_changed`, `memory__*` снова | ✅ 1.82 с после записи |
| C9 | логи членов пула до клиента (N1) | 0 | ✅ SDK: 0 `notifications/message`; отдельный прогон с `toggle-simulated-logging` — см. C15 |
| C10 | SDK v2 (`@modelcontextprotocol/client` 2.0.0), `versionNegotiation: legacy` и `auto` | доказательство для владельца (не гейт) | ✅ оба режима подключились; `auto`: `era: legacy`, согласована `2025-11-25`, 39 тулзов; stateless-проба получила `pool-sessionful-only` (строка в логе `serve`) и клиент откатился к `initialize` |
| C11 | Claude Code headless, P1 «перечисли тулзы» | все имена `mcp__mcpcut__<server>__<tool>` | ✅ 39 тулзов, `mcp_servers: connected`; самое длинное полное имя — 76 символов (`…long-name…__get-env`), Claude Code его принял |
| C12 | Claude Code P2 «вызови `everything__echo`» | `Echo: pool-smoke-cc` | ✅ после Ф2 (до неё — у сессии было 13 тулзов, модель нашла `everything-http__echo` и вызвала его) |
| C13 | Claude Code P3 `memory__create_entities` под `require-approval` | вызов держится; одобрение с S2 → успех | ✅ заявка видна через 28 с (`agent_waits=56s`), `approvals approve` на +43 с, ответ Claude «Success», весь прогон 45 с; решение `approved`, `actor: cli:owner` |
| C14 | `ps` на Mac при живом мосте | токена нет ни в одном argv | ✅ 0 процессов (проверка по значению токена, не по префиксу — префикс ловил собственные оболочки сессии) |
| C15 | N1/N3 вживую: `everything__toggle-simulated-logging`, 12 с | до клиента 0 логов; одна запись пула; строки в трафике ребёнка | ✅ сервер выдал 3 `notifications/message`, клиенту — 0; одна запись `dropped` (`unsupported-method`, `everything`, `notifications/message`); все 3 строки в трафике дочерней сессии |

### D. Поверхности через туннель

| # | Проверка | Ожидание | Итог |
|---|---|---|---|
| D1 | `/servers`, JS on/off: строка карточки длинного сервера | `· 10 not in pool` | ✅ `13 exposed · 13 quarantined · 10 not in pool` в обоих режимах («quarantined» — инвентарь пробы; принуждение карантина выключено политикой) |
| D2 | модалка `?tools=<длинный>` без JS | пилюли `not in pool · N` (alert) и `long pool name · N`, `title` без имени тулза | ✅ 13 пилюль: 10 hidden, 3 warn, ни один `title` не повторяет имя; модалка открыта сервером |
| D3 | `/agents` | блок карточки `smoke-bot` с `--url https://<S2-dashed>.sslip.io:8443`, токена в странице нет | ✅ |
| D4 | удалённая консоль в pty (`mcpcut --remote http://[::1]:8091`) → `Agents ▸ create smoke-bot-2` | пана `token-hold` с блоком на **адрес сервера**, не туннеля; 80×24 и 60×16 | ✅ блок `https://<S2-dashed>.sslip.io:8443`; на 60×16 — короткий баннер «copy it, then press y»; `y` снимает удержание |
| D5 | удалённый `Vault ▸ set` (RC4) по http, пир в контейнере — не loopback | отказ | ✅ «Writing to the vault over plain HTTP from a non-loopback …», код 1; в «эквивалентной команде» только имя секрета |

### E. Отчёт с S2, проверенный на Mac

| # | Проверка | Ожидание | Итог |
|---|---|---|---|
| E1 | `export --report` на S2 | `Pool sessions: N` | ✅ 782 записи, 173 решения, `Pool sessions: 15`, подписан |
| E2 | `verify --report` **на Mac** (другая машина), `--pub` из S2 | 7× PASS, `RESULT: PASSED`, exit 0 | ✅ re-fold 782 звеньев от genesis совпал с головой |
| E3 | раздел «Pool sessions» | сессия SDK: `memory` дважды, `Left the pool: memory (ungranted)`; отказы и дропы | ✅ сессии холодного старта — `Did not attach: … (handshake-failed)` (Ф2 видна в отчёте); на каждую сессию `name-too-long ×N` |
| E4 | заголовки дочерних сессий и колонка `server` | пометка пула у каждого ребёнка | ✅ 58 из 58 заголовков с `server …, pool session … (agent smoke-bot)`; колонка `server` есть |
| E5 | `export --report --session <сессия пула SDK>` (R3) | `Note:` в stdout, «Not in this export» в `summary.md` | ✅ `its decisions are in 6 child session(s)` и все шесть id в summary |
| E6 | паритет вживую: тот же `echo` через пул и через `/agents/smoke-bot/servers/everything` | записи решения равны по всем полям, кроме `id`/`ts`/`sessionId`/длительностей | ✅ 13 полей, различий нет (вкл. `policyHash`, `grantsHash`, `argsHash`, `rule`, `toolClass`, `quarantineState`) |
| E7 | ревизия handshake реальных серверов (вопрос владельцу о `2026-07-28`) | таблица «сервер → ревизия» | ✅ все пять отвечают плоскости `2025-11-25` на запрос `2025-11-25` (`mcp-servers/everything` stdio и HTTP, `memory-server`, `sequential-thinking-server`) |
| E8 | 16 решений `deny` в отчёте | объяснены | ✅ это `prompts/list`: клиенты спрашивали пул о промптах, каждый ребёнок отказал — у агента грант `--tools '*'` без промптов (fail-closed по умолчанию) |

### F. Мост из контейнера и Docker-вариант адреса

| # | Проверка | Ожидание | Итог |
|---|---|---|---|
| F1 | `node:24-bookworm-slim` на S2, `npm i -g` tarball, `mcpcut connect --url https://…:8443` | каталог с префиксами, код 0 | ✅ 39 тулзов пяти серверов, код 0; перед ответом — два `tools/list_changed`, переизданных пулом от членов (N1) |
| F2 | контейнер с `MCPCUT_SERVE_PUBLIC_URL=http://203.0.113.7:8090` → entrypoint → `setup` → `agent config` | в блоке `--allow-http` | ✅ |

### G. Негативные и sweep

| # | Проверка | Ожидание | Итог |
|---|---|---|---|
| G1 | `connect --url http://<S2>:8090` c токеном (PE8) | отказ до сети, код 1 | ✅ |
| G2 | `agent revoke smoke-bot`, Inspector по тому же блоку | код ≠ 0, «did not accept the agent token» | ✅ код 1 |
| G3 | sweep токена агента: логи всех служб S2 (включая `caddy`), `report-s2/*`, вывод Claude Code (`cc-*.jsonl`), SDK, Inspector, логи MCP Claude Code (`~/Library/Caches/claude-cli-nodejs/*pool-smoke*`) | 0 вхождений | ✅ 26 файлов, 0 |
| G4 | тот же sweep для токена владельца | 0 | ✅ |

### H. Разбор

| # | Проверка | Ожидание | Итог |
|---|---|---|---|
| H1 | все агенты смока отозваны | — | ✅ `smoke-bot`, `smoke-bot-2`, `smoke-bot-3` |
| H2 | `down -v --rmi local`; `docker rmi mcp-control-plane:local caddy:2 node:24-bookworm-slim` (их не было в снимке «до»); `rm -rf /root/mcpcut-smoke` | — | ✅ |
| H3 | снимок «после» ≡ «до» по ресурсам смока | контейнеры, образы, тома, сети, порты смока исчезли | ✅ **по ресурсам смока**. Отличия «после» от «до» есть, и они не наши: в 09:52:54 UTC другая сессия владельца (другой проект) намеренно вывела из эксплуатации чужой контейнерный стек на этом же хосте (контейнеры, тома, образы, сеть, порт 5434, затем `docker builder prune -af`) — это видно по `docker events` и её собственной расшифровке; наш разбор шёл в 09:58:49 и ограничен проектом `mcpcut-smoke` |
| H4 | на Mac: удалены файлы с токенами (`owner.txt`, `create*.txt`, `mcp*.json`, сырой вывод pty), оставлены копии без токенов; туннель и SSH-мастер закрыты | — | ✅ |

## Находки

| # | Находка | Серьёзность | Что сделано |
|---|---|---|---|
| **Ф1** | Холодный `npx -y <пакет>` в контейнере S2 ставится 12–18 с | среда | Прогрев кеша последовательно. Для пула это важно из-за Ф2 |
| **Ф2** | **Пул поднимает детей параллельно, и бюджет fan-out (10 с, `POOL_FANOUT_TIMEOUT_MS`) начинается при запуске процесса.** Четыре тёплых `npx -y` одновременно на 2 CPU — ~14 с каждый, поэтому серверы, зарегистрированные как `npx -y …`, **детерминированно** выпадают из первого `tools/list` сессии (`Did not attach: … (handshake-failed)`); к тому же параллельные `npx -y` одного пакета в холодном кеше **ломают** `~/.npm/_npx` (`ERR_MODULE_NOT_FOUND …/zod/v4/index.js`). Посерверный режим этого не видит (клиент ждёт сам, процесс один) | HIGH для пользователя на малом хосте; не дефект кода в узком смысле — **решение владельца** | В смоке серверы перерегистрированы по установленным бинарям (`npm i -g` в слое контейнеров; четыре параллельных старта — 1.6–2.1 с) — **отклонение от «вставить как есть» на стороне реестра, записано**. README (раздел пула) и `docs/deploy/caddy/` советуют бинарь вместо `npx -y` для пула. Варианты для владельца — ROADMAP: отдельный, более длинный бюджет старта ребёнка; или отдавать частичный список и слать `list_changed`, когда опоздавший сервер подключится |
| Ф3 | Claude Code при 13 тулзах (Ф2) не нашёл `everything__echo` и вызвал одноимённый тулз **другого сервера** (`everything-http__echo`) | наблюдение | Следствие Ф2; модель выбирает по имени. В пуле префикс сервера — единственное, что их различает, и он виден |
| Ф4 | Гонка причины ухода при `agent ungrant`: вотч дочерней сессии завершает её раньше вотча пула примерно в трети случаев — `child-ended` вместо `ungranted` | LOW | Найдено сквозным тестом фазы 5, тест допускает обе причины; ROADMAP |
| Ф5 | Члены пула шлют собственный `tools/list_changed` при старте — агент получает `list_changed` на каждый подключившийся сервер (F1: два перед первым ответом) | LOW | Остаточный риск «rate-limit `list_changed` членов» уже в ADR-0015 фазы 5; ROADMAP |
| Ф6 | Подсказка на Home консоли всё ещё говорит `mcpcut connect <server> --agent <name>` и не упоминает пул / `agent config` | LOW | ROADMAP |
| Ф7 | Туннель на занятый локальный 8091 молча встаёт только на IPv6, и `http://localhost:8091` ведёт в **другой** UI | среда | Проверка шла по `http://[::1]:8091` явно; README-рецепт туннеля — ROADMAP (совет выбрать свободный порт и `--ui-public-url`) |

## Метрики PRD (факты смока)

- **Онбординг ≤ 5 мин без README** — сценарием, не человеком (O3): от `agent create` до первого
  `Echo: pool-smoke-1` прошло 285 с, **включая** диагностику Ф1/Ф2; чистого замера после исправления
  стенда нет. Человеческий хронометраж не проводился.
- **«Одна запись, которая не меняется»** — B3 + C6–C8: три изменения доступа дошли до живого клиента
  через один и тот же неизменённый блок; `list_changed` через 1.8–1.9 с после записи (поллинг вотча в
  проде — 5 с).
- **Паритет решений пул ↔ посерверно** — E6 вживую.
- **Отчёт показывает вызов через пул целиком** — E1–E5, проверен на другой машине (E2).
- **Живые клиенты**: официальный SDK v1 и v2, Inspector CLI, Claude Code headless — все подключились
  sessionful; stateless-first клиента среди них нет (C10: v2 `auto` откатывается сам).

## Что НЕ прогонялось

- Интерактивный Claude Code владельца и человеческий хронометраж онбординга (O3).
- Клиенты, отличные от четырёх выше (Cursor, Claude Desktop и т. п.).
- `everything`-тулз, просящий sampling, — в `server-everything` 2026.8.31 такого нет; поведение пула на
  server→client-запрос проверено тестами фазы 3, не вживую.
- Долгий вызов дольше таймаута одобрения (60 с) и одобрение после таймаута.
- RC4 за TLS (удалённая консоль через https) — UI S2 наружу не публиковался намеренно.
- Firefox/WebKit — только Chromium headless.
