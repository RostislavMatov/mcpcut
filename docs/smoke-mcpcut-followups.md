# Смок: хвосты смока mcpcut — Q31 (экспозиция в `status`), Q32 (`probeHost` для compose), Q33 (маркер вкладки)

**Статус: ПРОЙДЕН** (прогон 2026-09-17, ветка `feat/mcpcut-smoke-followups`, HEAD `a7efb1b` + незакоммиченный набор плана `.claude/PRPs/plans/completed/mcpcut-smoke-followups-q31-q33.plan.md`; `npm run build` и `npm run lint` чисты перед прогоном; затронутые области `npx vitest run tests/services tests/cli/service-cmd.test.ts tests/cli/setup-args.test.ts tests/cli/setup-cmd.test.ts tests/setup/schema.test.ts tests/docker/entrypoint.test.ts tests/tui tests/architecture` — **71 файл, 1976 зелёных**; после прогона и `down -v` полный `npx vitest run` — **301 файл, 6623 зелёных**). Все семь пунктов «Manual Validation» плана прогнаны, дефектов в изменённом коде не найдено. Наблюдения — в конце, ни одно не вносится этим набором.

## Окружение

| | |
|---|---|
| Дата | 2026-09-17 |
| Хост | macOS 14 (Darwin 23.5.0), arm64 |
| Node | v25.6.0 (пол проекта — 24) |
| Docker | Engine 28.5.1, Compose v2.40.2-desktop.1 |
| Образ | `mcp-control-plane:local`, собран из рабочего дерева (`up -d --build`) |
| pty | `drive.py` из смока фаз 1–6 (`pty.fork`, кадр = последний `ESC[H … ESC[J` без ANSI) |

## Стенд

```
SMOKE=<scratch>/smoke
npm run build
# голый хост — только так (реальные ~/.mcpcut и ~/.mcp-journal не тронуты):
HOME=$SMOKE/<home> MCPCUT_CONFIG=$SMOKE/<home>/.mcpcut/config.json NODE_NO_WARNINGS=1 node dist/cli.js …
#   home-exp — ui на 0.0.0.0, порты 65473/65474
#   home-lo  — loopback,     порты 65483/65484
# main для байтового сравнения: git worktree add --detach $SMOKE/main-wt main; npm run build там (node_modules — симлинк)
# compose — отдельный проект, тома пользователя не тронуты:
docker compose -p mcpcut-smoke-followups …
# установка «без поля»: -f docker-compose.yml -f $SMOKE/override-noprobe.yml (обе переменные = "")
```

## A. Q31 — предупреждение об экспозиции в `status` (голый хост)

| # | Шаг | Ожидание | Факт | Итог |
|---|---|---|---|---|
| A1 | `setup --yes --ui-host 0.0.0.0 --data-dir … --ui-port 65473 --serve-port 65474` | exit 0, `check ui exposure warn`, `serve exposure ok` | exit 0; `check  ui exposure    warn ui binds 0.0.0.0: reachable from the network. … — ADR-0004`; `check  serve exposure ok   127.0.0.1 loopback only` | ✔ |
| A2 | `status` (службы остановлены) | stdout — таблица без предупреждения; stderr — строка `ui: warning: …ADR-0004`; про `serve` ничего | stdout: `ui     stopped  —  0.0.0.0:65473    —` / `serve  stopped  —  127.0.0.1:65474  —`; stderr: `ui:    warning: ui binds 0.0.0.0: reachable from the network. Terminate TLS in front (ui: --behind-tls + --allowed-host; serve: agents' bearer tokens travel in clear otherwise) — ADR-0004` — одна строка | ✔ |
| A3 | `status --json` | `"exposure"` только у `ui`; stderr пуст | `[{"exposure":{"detail":"ui binds 0.0.0.0: …","level":"warn"},"host":"0.0.0.0",…,"service":"ui","state":"stopped"},{"host":"127.0.0.1",…,"service":"serve","state":"stopped"}]`; stderr **0 байт** | ✔ |
| A4 | Exit-код, службы остановлены | как у `main` (1) | ветка: table 1, json 1; `main` на том же конфиге: 1 | ✔ |
| A5 | `start`, затем `status` / `status --json` | exit 0, предупреждение в stderr остаётся | `ui running pid 19623 0.0.0.0:65473 …`, `serve running …`, exit **0**; stderr — та же строка `ui: warning: …`; `--json` exit 0; `main` на том же живом стенде: exit 0, stderr 0 байт | ✔ |

## B. Q31 — loopback-установка байт-в-байт как `main`

Конфиг `home-lo` записан `setup --yes` ветки (без `--*-probe-host`), `main` собран в `git worktree` в скретче и после прогона удалён.

| # | Шаг | Ожидание | Факт | Итог |
|---|---|---|---|---|
| B1 | `status --json` ветки и `main`, службы остановлены | `cmp` без различий, stderr пуст у обоих | `IDENTICAL` (sha1 `cc73f122a739…`), exit 1 / 1, stderr 0 / 0 байт | ✔ |
| B2 | То же после `start` | байт-в-байт | `IDENTICAL` (sha1 `e67d4ad1a06b…`), exit 0 / 0, stderr 0 / 0 байт | ✔ |
| B3 | `status` (таблица) ветки на loopback | stderr пуст | exit 0, stderr 0 байт | ✔ |

## C. Q33 — маркер активной вкладки (pty, `home-lo`, службы запущены)

Вход токеном из `setup`, затем `2`, затем `9`. «Ширина» — число символов строки вкладок в кадре.

| # | Шаг | Ожидание | Факт | Итог |
|---|---|---|---|---|
| C1 | `NO_COLOR=1 mcpcut`, 80×24, после входа | `▸1 Home  2 Admins …`, SGR = 0 | `▸1 Home  2 Admins  3 Servers  4 Vault  5 Agents  6 Groups  7 Policy ›`; ширина 80; `▸` ровно один; SGR в сыром потоке **0** | ✔ |
| C2 | `2` | `‹ ▸2 Admins` или `▸2 Admins` | `‹ ▸2 Admins  3 Servers  4 Vault  5 Agents  6 Groups  7 Policy  8 Quarantine ›`; ширина 80 | ✔ |
| C3 | `9` | маркер у `9 Approvals` | `‹  7 Policy  8 Quarantine ▸9 Approvals  10 Journal  11 Audit  12 Services`; ширина 80 | ✔ |
| C4 | Без `NO_COLOR` (ANSI), те же шаги | `▸` рядом с инверсией, те же кадры | кадры C1–C3 совпадают; в сыром потоке `‹ ▸ESC[7m2 Admins ESC[27m` — маркер вне инверсии; SGR 124 | ✔ |
| C5 | `NO_COLOR=1`, 40×12 | ширина строки = 40, один `▸` | Home `▸1 Home  2 Admins  3 Servers  4 Vault ›`; Admins ` 1 Home ▸2 Admins  3 Servers  4 Vault ›`; Approvals `‹ ▸9 Approvals  10 Journal  11 Audit ›`; все ширины 40 | ✔ |
| C6 | Home на голом хосте (`supervisor: mcpcut`) | совет `Services ▸ start` на месте | `A service marked ○ in the header: Services ▸ start.` | ✔ |

## D. Q32 + Q31 — compose с нуля

`docker compose -p mcpcut-smoke-followups up -d --build` (на пустых томах этого проекта).

| # | Шаг | Ожидание | Факт | Итог |
|---|---|---|---|---|
| D1 | `up -d --build` | `ui` healthy → `serve` стартует | `Container …-ui-1 Healthy` → `…-serve-1 Started`; `ps`: оба `(healthy)` | ✔ |
| D2 | `logs ui` | транскрипт `setup`, `warn` про оба `0.0.0.0`, `config written`, `listening` | `check  ui exposure    warn ui binds 0.0.0.0 …`, `check  serve exposure warn serve binds 0.0.0.0 …`, `setup: config written to /home/node/.mcpcut/config.json`, `ui: listening on http://0.0.0.0:8091` | ✔ |
| D3 | `exec -T ui mcpcut status` | обе `external` | `ui     external  —  0.0.0.0:8091  —` ↵ `  answering on ui:8091; managed by an external supervisor (supervisor: external), mcpcut only reports`; `serve  external  —  0.0.0.0:8090  —` ↵ `  answering on serve:8090; …` | ✔ |
| D4 | `exec -T serve mcpcut status` | обе `external` | идентично D3 | ✔ |
| D5 | Конфиг | `probeHost` `ui` / `serve` | `"ui": {"host": "0.0.0.0", "port": 8091, "probeHost": "ui"}`, `"serve": {"host": "0.0.0.0", "port": 8090, "probeHost": "serve"}`, `"supervisor": "external"` | ✔ |
| D6 | Предупреждение об экспозиции в `status` | stderr: две строки (оба сервиса на `0.0.0.0`) | `ui:    warning: ui binds 0.0.0.0: …— ADR-0004` / `serve: warning: serve binds 0.0.0.0: …— ADR-0004` (в обоих контейнерах) | ✔ |
| D7 | `status --json` в обоих контейнерах | `exposure` у обоих, `state: external`, stderr 0 байт | `"detail":"answering on ui:8091; …","exposure":{…,"level":"warn"},…,"state":"external"` и то же для `serve`; stderr **0 байт** | ✔ |
| D8 | Exit-код `status` в compose | не меняется этим набором | **1** (см. наблюдение 1: `every(state === 'running')` — строка до изменения) | ✔ (без изменений) |
| D9 | `exec -it ui mcpcut` (pty) — экран входа | `services: ui ◉ … · serve ◉ …` | `Sign in` / `Token: ▏` / `services: ui ◉ 0.0.0.0:8091 · serve ◉ 0.0.0.0:8090`; строки-подсказки нет (она выводится только при `○`, `render-signin.ts`) | ✔ |
| D10 | Вход токеном из `logs ui` → Home | шапка `◉ ×2`, интро без `Services ▸ start` | `McpCut console · owner (owner) · ui ◉ 0.0.0.0:8091 · serve ◉ 0.0.0.0:8090`; интро: `Services are run by compose or systemd` ↵ `(supervisor: external): mcpcut only reports.`; `Services ▸ start` нет; `q` → exit 0 | ✔ |

## E. Q32 — установка без поля и миграция по README

`down -v`, затем `up -d` с `override-noprobe.yml` (`MCPCUT_UI_PROBE_HOST: ""`, `MCPCUT_SERVE_PROBE_HOST: ""` у обоих сервисов).

| # | Шаг | Ожидание | Факт | Итог |
|---|---|---|---|---|
| E1 | Пустые переменные → entrypoint | флаги не передаются, `probeHost` в конфиге нет | `env`: `MCPCUT_UI_PROBE_HOST=` / `MCPCUT_SERVE_PROBE_HOST=`; конфиг `"ui": {"host": "0.0.0.0", "port": 8091}`, `"serve": {"host": "0.0.0.0", "port": 8090}` | ✔ |
| E2 | `exec -T ui mcpcut status` до миграции | прежняя картина: сосед `stopped` | `ui external … answering on 0.0.0.0:8091`; `serve stopped — 0.0.0.0:8090 — not answering on 0.0.0.0:8090; … check compose or systemd` | ✔ |
| E3 | `docker compose -p … run --rm ui setup --yes --ui-probe-host ui --serve-probe-host serve` (команда README) | exit 0, токен не печатается | exit 0; `vault: already initialized`, `signing key: already present`, `admin: 1 admin(s) exist, none created`; `grep -c mcpa_` = **0** | ✔ |
| E4 | Конфиг после | поле дописано, остальное прежнее | `"probeHost": "ui"`, `"probeHost": "serve"`, `supervisor: external`, хосты/порты прежние | ✔ |
| E5 | `docker compose -p … restart`, `status` в `ui` и в `serve` | обе `external` из обоих контейнеров | `answering on ui:8091 …` / `answering on serve:8090 …` в обоих | ✔ |

## F. Голый `docker run` образа (без env)

`docker run -d --init --name mcpcut-smoke-followups-bare mcp-control-plane:local ui`.

| # | Шаг | Ожидание | Факт | Итог |
|---|---|---|---|---|
| F1 | Конфиг | нет `probeHost` | `env | grep -c PROBE` = 0; `"ui": {"host": "0.0.0.0", "port": 8091}`, `"serve": {…8090}`, `supervisor: external` | ✔ |
| F2 | `status` внутри | свой UI найден по loopback | `ui external … answering on 0.0.0.0:8091 …`; `serve stopped … not answering` (контейнер `serve` не запускался — ожидаемо); exit 1; оба предупреждения об экспозиции в stderr | ✔ |
| F3 | `status --json` | `ui.state = external` | `"detail":"answering on 0.0.0.0:8091; …","state":"external"` | ✔ |

## G. Края `probeHost` (голый хост, `home-lo`)

| # | Шаг | Ожидание | Факт | Итог |
|---|---|---|---|---|
| G1 | `setup --yes --ui-probe-host nosuch.invalid --serve-probe-host 127.0.0.1` на существующей установке | exit 0, токена нет, поля в конфиге | exit 0, `mcpa_` = 0, `"probeHost": "nosuch.invalid"`, `"probeHost": "127.0.0.1"` | ✔ |
| G2 | `status --json` без pid-файла, DNS не резолвится | `stopped` без исключения | `ui … "state":"stopped"`, exit 1, без трейса | ✔ |
| G3 | `start` → `status` (pid-файл есть) | `probeHost` игнорируется, проба по хосту записи | `ui running pid 22453 127.0.0.1:65483 …`, `serve running …`, exit 0 | ✔ |
| G4 | `setup --yes --ui-probe-host ''` | отказ схемы | `ui.probeHost: Too small: expected string to have >=1 characters`, exit 1 | ✔ |

## Не прогонялось

| Что | Почему |
|---|---|
| IPv6 wildcard `::` / `[::]` в `status` | не в чек-листе Manual Validation; покрыто юнит-тестами `checkBindExposure` |
| `exec -it serve mcpcut` (консоль из контейнера `serve`) | не в чек-листе; `status` из `serve` (D4, E5) показывает ту же картину |
| `probeHost` под systemd | стенда systemd в этом прогоне нет; путь кода тот же, что G2/G3 (нет pid-файла) |

## Наблюдения (не дефекты этого набора)

1. **`status` в здоровом compose выходит с кодом 1.** Правило `statuses.every(state === 'running') ? 0 : 1` не менялось (в диффе строка контекста), а `external` ≠ `running`, поэтому `mcpcut status` в стеке, где обе службы отвечают, всегда даёт exit 1 — и до изменений, и после. Скрипт, который использует `docker compose exec ui mcpcut status` как health-check, будет считать стек больным. Кандидат в ROADMAP/на решение владельца (например, считать `external` успехом под `supervisor: external`).
2. **Compose-сборка перетегивает общий образ `mcp-control-plane:local`.** `image:` в `docker-compose.yml` не зависит от имени проекта, поэтому `-p mcpcut-smoke-followups up --build` пересобрал тег, которым пользуется и основной проект `mcp-control-plane`. Тома и контейнеры пользователя не тронуты; образ теперь соответствует рабочему дереву ветки. Для будущих смоков — собирать под отдельным тегом (override `image:`).
3. На узком терминале неактивная первая вкладка рисуется с ведущим пробелом (` 1 Home ▸2 Admins`) — место под маркер зарезервировано у каждой метки, ширина строки при этом точная (40). Выглядит намеренно.
4. Кадр экрана входа на голом хосте снимался до ответа пробы — строка `services:` в нём ещё не появилась (поведение фазы 6: молчание, пока ответ в пути); в compose (D9) снято после ожидания строки.

## Уборка

`docker compose -p mcpcut-smoke-followups down -v` (контейнеры, сеть, тома `mcpcut-smoke-followups_mcp-data`/`_mcp-config` удалены); контейнер `mcpcut-smoke-followups-bare` удалён `rm -f` (анонимных томов у образа нет — `Config.Volumes = null`); службы `home-exp`/`home-lo` остановлены `mcpcut stop`; `git worktree remove --force $SMOKE/main-wt` — в `git worktree list` только основное дерево.
