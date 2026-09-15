# Смок: терминальная консоль mcpcut (фазы 1–6) — первый запуск, службы, узкий терминал, NO_COLOR, очередь клавиш, bootstrap-файл, Docker

**Статус: ПРОЙДЕН С ОГОВОРКАМИ** (прогон 2026-09-15, ветка `feat/mcpcut-phase1-config-services`, HEAD `cc35d10` + незакоммиченная фаза 6; `npm run build` перед прогоном; после прогона `npx vitest run` — **6564 зелёных**, `npm run lint` чист; первый прогон сьюта, стартовавший впритык к `docker compose down -v` и `mcpcut stop` стенда, дал один падший тест, имя которого хвост лога не сохранил — чистый повтор зелёный). Оговорки — на суд владельца, ни одна не блокирует фазу:

1. **`status` не повторяет предупреждение о публичной привязке** (G4). PRD (таблица рисков, строка «Публичная привязка на VPS без TLS») обещает, что предупреждение «пишет … в конфиг-экран и `status`»; в коде `checkBindExposure` вызывают только `setup --yes` и мастер, `status`/`status --json` молчат. Не однострочник (нужно решить, куда писать — stderr, `detail`, JSON-поле), поэтому не правил.
2. **Внутри compose `status` видит только свой контейнер** (H4, H6). У `ui` и `serve` разные сетевые пространства имён, проба `0.0.0.0` идёт на `127.0.0.1` того контейнера, где запущена команда, поэтому в контейнере `ui` `serve` всегда `stopped` («not answering … check compose or systemd»), а в контейнере `serve` — наоборот. Шапка консоли показывает `ui ◉ … serve ○`, интро Home советует `Services ▸ start`, которого под `external` нет. README §Docker («the header draws them `◉`») и `docker-compose.yml` описывают картину, которой нет. Нужна либо проба по имени сервиса compose (`serve:8090`), либо честная фраза в README.
3. **Ожидание смока про короткий баннер на 40 колонках не совпало с правилом F4** (C9). На 40×12 длинный баннер переносится ровно в 2 строки и по F4 остаётся; короткий появляется уже, где перенос дал бы 3 строки (проверено на 30×12). Расхождение — в чек-листе, не в коде.

**Чем прогоняли:** `dist/cli.js` под Node 25.6 (пол — 24) на macOS 14; pty-драйвер `python3` (`pty.fork` + `os.read`/`os.write`, `TIOCSWINSZ` + `SIGWINCH` для размера, кадр = последний полный `ESC[H … ESC[J` без ANSI) — скрипт `drive.py` в скретче, шаги — JSON-списки `wait/send/snap/resize/close`; три изолированных `HOME` (`home`, `home-slow`, `home-noadmin`) с `MCPCUT_CONFIG` внутри них, реальные `~/.mcp-journal` и `~/.mcpcut` не тронуты; свободные порты выбирались `net.createServer().listen(0)`; Docker Desktop (arm64) с `node:24`, `debian:bookworm-slim` + `systemd` (`jrei/systemd-ubuntu` не имеет arm64-манифеста) и `docker compose -p mcpcut-smoke`; `curl`, `plutil`.

**Наблюдение о протоколе (поправка к памяти фазы 5):** после входа консоль **не** запускает `status` в панели — эффект `refresh-services` только обновляет шапку (`services: —` → `ui ● …`), панель Home показывает интро. Ждать `exit N` после входа нечего; ждать надо строку `Run an agent through` (интро Home). Очередь клавиш (E) поэтому проверялась на `Enter` по `status` Home, а не на «авто-status».

## Стенд

```
SMOKE=<scratch>/smoke-mcpcut; mkdir -p $SMOKE/home $SMOKE/home-slow $SMOKE/home-noadmin
npm run build
# каждая команда — так, и только так:
HOME=$SMOKE/<home> MCPCUT_CONFIG=$SMOKE/<home>/.mcpcut/config.json node dist/cli.js …
# pty:
HOME=… MCPCUT_CONFIG=… python3 $SMOKE/drive.py [--cols 40 --rows 12] [--env NO_COLOR=1] \
    --out $SMOKE/<раздел> --steps $SMOKE/steps<раздел>.json -- node dist/cli.js
# порты: home 57445/57446 · home-slow 57447/57448 · home-noadmin 58674/58675 · compose 8091/8090 (свободны на хосте)
```

Замедление старта `ui` для секундомера (A3–A4): `NODE_OPTIONS=--require=$SMOKE/slow.cjs`, где `slow.cjs` = `if (process.argv.includes('ui')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)` — демон наследует `NODE_OPTIONS` (`daemonEnv` вырезает только токены), консоль не тронута.

## A. Чистый `HOME`: голый `mcpcut` → мастер → лестница → токен → консоль

80×24, `home` (без замедления) и `home-slow` (с ним). Клавиши формы — как в `tests/tui/support/wizard-harness.ts`: `Tab Tab`, `⌫×64`, порт, `Tab×3`, `⌫×64`, порт, `Tab Tab`, `Enter`.

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| A1 | `mcpcut` на TTY без конфига | мастер: восемь полей с предзаполнением, футер `Enter deploy · …` | ✔ `Data dir [$HOME/.mcp-journal]`, `UI host [127.0.0.1]`, `UI port [8091]`, `TLS in front [ ]`, `Agent host`, `Agent port [8090]`, `First admin [owner]`, `Services by ‹ mcpcut ›`; второй строкой шапки — путь конфига и `MCPCUT_CONFIG=…` |
| A2 | `Enter` после замены портов | лестница: `✓ Checks and config`, `… Starting ui`, ниже — транскрипт `setup --yes` с `check …` | ✔ `check ui bind ok 127.0.0.1:57445 free`, `check ui exposure ok 127.0.0.1 loopback only`, `setup: config written …`, `vault: initialized …`, ключи, `exit 0`, футер `working… · Ctrl-C quit` |
| A3 | Строка `Starting ui` при медленном `ui` (рига 3 с) | `waiting for the service to answer (N s of up to 15 s)` | ✔ `… Starting ui  waiting for the service to answer (1 s of up to 15 s)` |
| A4 | тот же кадр через 1 с | `N+1` | ✔ `(2 s of up to 15 s)` |
| A5 | без замедления | `ui` отвечает раньше первого тика | ✔ кадр `waiting for the service to answer (up to 15 s)` без `N` — счётчик появляется с первого тика (F8), на этом хосте `ui` встал за <1 с |
| A6 | Финал | `✓` ×3, `Setup complete. ui and serve run in the background …`, `Owner token for "owner" (shown once):`, `mcpa_…`, `Saved it? [y/N]`, футер `y sign in · q quit` | ✔ |
| A7 | `y` | экран входа консоли со строкой служб | ✔ `Sign in` / `Token:` / `services: ui ● 127.0.0.1:57447 · serve ● 127.0.0.1:57448` (первые ~300 мс — `services: —`) |
| A8 | Токен + `Enter` | шапка `McpCut console · owner (owner) · ui ● … · serve ● …`, вкладки `1 Home … 7 Policy ›`, интро Home | ✔ |
| A9 | Время пути «пустой HOME → экран входа» | ≤ 5 мин без документации | ✔ **2,0 с** (драйвер, без замедления); **6,7 с** с ригой 3 с; руками — время набора двух портов |

Кадр A3 (`home-slow`, 80×24, сокращено):

```
✓ Checks and config     config written · vault · signing key · owner minted
… Starting ui           waiting for the service to answer (1 s of up to 15 s)
  Starting serve
```

## B. Службы переживают терминал

`home-slow`: вход через pty, затем драйвер **закрывает master pty** (терминал исчез, консоль получает `SIGHUP`/EOF).

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| B1 | Консоль после закрытия pty | процесс консоли завершён | ✔ `pgrep -fl "dist/cli.js tui|dist/cli.js$"` — пусто |
| B2 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:57447/login` | `200` | ✔ `200` |
| B3 | `mcpcut status` | обе `running`, exit 0 | ✔ `ui running pid 50254 127.0.0.1:57447 since …`, `serve running pid 50388 …` |
| B4 | То же для `home` (консоль убита `SIGKILL` драйвером) | обе живы | ✔ `200`, `running` ×2 |

## C. Узкий терминал 40×12 (и 30×12), затем `resize` до 80×24

`home-slow`, вход, `2` (Admins).

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| C1 | Home на 40×12 | раскладка `stacked`: полоса действий сверху, панель во всю ширину с колонки 0 | ✔ `▸ status` строкой, пустая строка, интро с колонки 0; строки шире 40 обрезаны `…` |
| C2 | `2` | `▸ list` / `add`, интро Admins | ✔ полоса — 2 строки (треть тела: `min(5, floor(9/3)) = 3`, но видимых действий показано 2 — окно списка) |
| C3 | `Enter` на `list` | вывод `$ mcpcut admin list` во всю ширину, `exit 0` | ✔ `owner  owner  cre›` — `›` = есть что прокрутить `]` |
| C4 | `?` | оверлей на всё тело; строки шире 40 → «клавиши / описание с отступом 2» | ✔ `Tab / S-Tab / 1-9 / h l` ↵ `  move between sections`; `Enter` ↵ `  open the selected action, or run the` ↵ `  form on screen` |
| C5 | Последняя строка оверлея | `any key closes this help` | ✖ на 12 строках не видна: тело 9 строк, помощь длиннее, оверлей режется по `rows` **по замыслу** (`render-help.ts`: «no scrolling … a 20×5 terminal honestly shows the first lines») — наблюдение, не дефект |
| C6 | Любая клавиша (пробел) | оверлей закрыт, панель прежняя | ✔ вернулся вывод `admin list` |
| C7 | `j`, `Enter` на `add` | форма `Name [▏]`, `Role ‹ owner ›`, хинт `prints the admin's token once — copy it…` | ✔ |
| C8 | `bob2`, `Enter` → `token-hold` на 40 колонках | **ожидание чек-листа:** короткий баннер | ✖/✔ длинный баннер в 2 строки (`One-time token on screen: it cannot be` ↵ `shown again and leaves with this screen.`) — по F4 короткий берётся только при >2 строк; **оговорка 3** |
| C9 | То же на 30×12 (`bob3`) | короткий баннер | ✔ `One-time token on screen: copy` ↵ `it, then press y.` |
| C10 | `Tab` на `token-hold` | игнорируется | ✔ кадр не изменился |
| C11 | `y` | футер обычный, `▸ add` в полосе, вывод остаётся | ✔ |
| C12 | `TIOCSWINSZ` 80×24 + `SIGWINCH` | две колонки: действия слева (`list add rotate role remove`), вывод справа, окно вкладок `‹ 2 Admins … 8 Quarantine ›` | ✔ |

Кадр C8 (40×12, токен затёрт):

```
McpCut console · owner (owner) · ui ● 1…
1 Home  2 Admins  3 Servers  4 Vault ›
────────────────────────────────────────
One-time token on screen: it cannot be
shown again and leaves with this screen.

$ mcpcut admin add bob2 --role owner
admin: bob2
role: owner
token: mcpa_<redacted>›
exit 0
copy the token · y saved it · PgUp/PgDn…
```

Наблюдение: на 40 колонках строка `token: mcpa_…` обрезана (`›`) — токен из 48 символов виден не целиком, оператору нужен `]`, чтобы скопировать хвост. Не дефект F4, но стоит фразы в README §Console («на узком терминале токен прокручивается `]`»).

## D. `NO_COLOR=1` и `TERM=dumb`

`home-slow`, 80×24, вход и выход `q`; считались байты в сыром потоке pty.

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| D1 | `NO_COLOR=1 mcpcut` | ни одного `ESC[1m`/`ESC[7m`/`ESC[2m`; альт-экран и `ESC[H` остаются | ✔ SGR (`ESC[…m`) = **0**; `ESC[?1049h` = 1, `ESC[H` = 55 |
| D2 | `TERM=dumb mcpcut` | то же | ✔ SGR = **0**; альт-экран 1, `ESC[H` 55 |
| D3 | По умолчанию (`TERM=xterm-256color`) | атрибуты есть | ✔ `ESC[1m` = 55, `ESC[7m` = 3, всего SGR 116 |
| D4 | Кадр без цвета читается | активная вкладка различима позицией/`▸`, шапка — текстом | ✔ `1 Home  2 Admins …`, `▸ status` |

## E. Очередь клавиш во время команды

`home-slow`, 80×24. После входа панель Home — интро (см. «Наблюдение о протоколе»); `Enter` запускает `status`, `9` и `Tab` отправлены в том же пакете байтов, что и `Enter`.

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| E1 | `Enter 9 Tab` одним записыванием | футер `running… · keys are queued until it finishes · Ctrl-C aborts` | ✔ строка найдена в сыром потоке (кадр живёт < 100 мс — `status` при живых службах отвечает быстро) |
| E2 | После `exit 0` | активна вкладка **`10 Journal`** (`9` → Approvals, `Tab` → Journal) | ✔ окно вкладок `‹ 7 Policy … 12 Services`, действия `▸ sessions / show / export`, в панели — вывод `status` с `exit 0` |
| E3 | `Ctrl-C`-ветка | не гонялась в pty (покрыта `tests/tui/update-keys.test.ts`) | — |

## F. `--no-admin`: файл `bootstrap-token`

`home-noadmin`, порты 58674/58675.

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| F1 | `setup --yes --no-admin --data-dir … --ui-port … --serve-port …` | предупреждение называет `…/bootstrap-token` и правило удаления | ✔ `setup: --no-admin: this install has no admin yet. The first "ui" start will create "owner" and write its one-time token to $DD/bootstrap-token (0600); the file is deleted after the first sign-in — or run "mcpcut admin add <name> --role owner" before starting anything.` |
| F2 | `mcpcut start` → `ls -l $DD/bootstrap-token` | `-rw-------`, каталог `drwx------` | ✔ `-rw-------@ … 49 … bootstrap-token` (48 символов + `\n`), `drwx------@` |
| F3 | `mcpcut logs ui` | путь и правило есть, `mcpa_` нет | ✔ `[ui] no admins found: created "owner" with role owner`, `[ui] its one-time token is in $DD/bootstrap-token (m…`, `[ui] the file is deleted after the first sign-in. Rotate …`; `grep -c mcpa_` = **0** и в `logs ui`, и в сыром `run/ui.log` |
| F4 | `mcpcut` (pty) | экран входа с `first owner token: <path>` под строкой служб | ✔ `services: ui ● … · serve ● …` ↵ `first owner token: /private/tmp/…/home-noadmin/.mcp-journal/bootstrap-p…` |
| F5 | Вход токеном из файла | консоль, шапка `owner (owner)` | ✔ |
| F6 | Файл после входа | удалён | ✔ `ls: …/bootstrap-token: No such file or directory`; `ui.log` без новых строк (удаляла консоль, не демон) |
| F7 | Повторный `mcpcut` | экран входа без строки `first owner token` | ✔ только `services: …` |
| F8 | `mcpcut stop` → `status` | `stopped` ×2 | ✔ |
| F9 | Веб-вход другим админом ничего не пишет | не гонялось (нужен CSRF-танец; покрыто `tests/ui/login-flow*`/`tests/admin/bootstrap-file.test.ts`) | — |

Наблюдение: в `logs ui` длинная строка с путём обрезана `…` («readable-field»-фильтр журнала), в сыром файле она целая — на 80 колонках путь скретча в неё не помещается; на реальном `~/.mcp-journal` поместится.

## G. VPS-подобное окружение: `node:24`, публичные привязки

`docker run --rm -v "$PWD":/app:ro -w /app -e HOME=/tmp/h node:24 sh -c 'node dist/cli.js setup --yes --ui-host 0.0.0.0 --serve-host 0.0.0.0 --data-dir /tmp/d …; node dist/cli.js status; node dist/cli.js status --json'`, затем то же в `docker run -d … sleep infinity` + `docker exec`.

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| G1 | `setup --yes` с `0.0.0.0` | `check ui exposure warn …` с флагами `--behind-tls`/`--allowed-host`, ADR-0004 | ✔ `check  ui exposure    warn ui binds 0.0.0.0: reachable from the network. Terminate TLS in front (ui: --behind-tls + --allowed-host; serve: agents' bearer tokens travel in clear otherwise) — ADR-0004` (и для `serve`) |
| G2 | Токен владельца | в stdout один раз, с предупреждением о редиректе | ✔ `token: mcpa_…`, `Do not redirect this command's stdout…` |
| G3 | `status` при лежащих службах | `stopped` ×2, exit 1 | ✔ `ui stopped — 0.0.0.0:8091 —`, exit **1** (как в фазе 5) |
| G4 | `status` повторяет предупреждение о публичной привязке | по PRD — да | ✖ ни `status`, ни `status --json` (`{"host":"0.0.0.0",…,"state":"stopped"}`) не упоминают экспозицию — **оговорка 1** |
| G5 | `mcpcut start` в контейнере | демоны на `0.0.0.0` | ✔ `ui: started pid 44 on http://0.0.0.0:8091`, `status` — `running` ×2 |
| G6 | `docker exec -it … mcpcut` (pty) | вход, шапка `ui ● 0.0.0.0:8091 · serve ● 0.0.0.0:8090`, Services с `start`/`stop` (супервизор `mcpcut`) | ✔ `▸ status / start / stop / logs / setup` |
| G7 | `mcpcut stop` в контейнере **без init** (`sleep infinity` как PID 1) | `stopped pid` | ⚠ `stopped pid 56 (forced: SIGKILL after SIGTERM)` ×2 — PID 1 не жнёт зомби, `kill -0` видит «живой» pid после SIGTERM; с `docker run --init` — чистое `stopped pid` ×2. Артефакт стенда, compose ставит `init: true` — но фраза в README §Docker/§Services про `init` в «голом» контейнере не помешает |

## H. Docker compose

`docker compose -p mcpcut-smoke build && up -d` (порты 8091/8090 на хосте свободны).

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| H1 | `up -d` | `ui` healthy, `serve` стартует после | ✔ `Container mcpcut-smoke-ui-1 Healthy` → `serve Started`; через 40 с обе `(healthy)` |
| H2 | `docker compose logs ui` | транскрипт `setup`, `warn` про `0.0.0.0`, одноразовый токен, `ui: listening on http://0.0.0.0:8091` | ✔ плюс `[ui] wildcard bind: Host screening admits only localhost names…` |
| H3 | `curl http://localhost:8091/login` с хоста | `200` | ✔ |
| H4 | `exec -T ui mcpcut status` | `external` ×2 | ✖ `ui external — 0.0.0.0:8091 — answering …; managed by an external supervisor (supervisor: external), mcpcut only reports`; **`serve stopped — not answering on 0.0.0.0:8090; … check compose or systemd`** (и при healthy `serve`); в контейнере `serve` — зеркально. **Оговорка 2** |
| H5 | `status --json` | `supervisor: external` виден | ✔ `"state":"external","detail":"… managed by an external supervisor (supervisor: external) …"` |
| H6 | `exec -it ui mcpcut` (pty) | экран входа `services: ui ◉ … · serve ◉ …`, подсказка про внешний супервизор | ✔/✖ `services: ui ◉ 0.0.0.0:8091 · serve ○ 0.0.0.0:8090` ↵ `services are managed by compose or systemd (supervisor: external)` — `serve ○` по той же причине |
| H7 | Services в контейнере | `status · logs · setup`, без `start`/`stop`; шапка `◉` | ✔ `▸ status / logs / setup`; интро «Under supervisor: external (compose/systemd) start and stop are hidden.»; шапка `ui ◉` |
| H8 | `exec -T ui mcpcut start` | отказ с объяснением | ✔ `ui: external — something answers on 0.0.0.0:8091; mcpcut did not start it`, `serve: external — this install hands its services to another supervisor`; exit **0** (по тесту «nothing to do») |
| H9 | `down -v` | тома и сеть удалены | ✔ `mcpcut-smoke_mcp-data`, `mcpcut-smoke_mcp-config` removed |

## I. Unit-файлы

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| I1 | `plutil -lint docs/deploy/*.plist` (хост) | `OK` ×2 | ✔ `com.mcpcut.serve.plist: OK`, `com.mcpcut.ui.plist: OK` |
| I2 | `systemd-analyze --user verify /d/mcpcut-ui.service` в `debian:bookworm-slim` + `apt-get install systemd` (systemd 252) | без ошибок | ✔ exit 0, вывода нет — **при `XDG_RUNTIME_DIR=/run/user/0`**; без него `--user` падает ещё до чтения файла (`Failed to lookup RuntimeDirectory path`) — стоит фразы в `docs/deploy/README.md` рядом с командой |
| I3 | то же для `mcpcut-serve.service` | без ошибок | ✔ exit 0 |
| I4 | `systemd-analyze verify` (system-scope) обоих | без ошибок | ✔ exit 0 |
| I5 | `jrei/systemd-ubuntu` | — | не прогонялось: образ без `linux/arm64` манифеста; замена — Debian + пакет `systemd` |

## Наблюдения

1. **После входа консоль не запускает `status` в панели** — Home показывает интро, шапку обновляет тихий `refresh-services`. Память фазы 5 («ждать `exit N` после входа») устарела; для pty-смока ждать `Run an agent through`.
2. **`status` без предупреждения об экспозиции** (G4) — расхождение с PRD; решение владельца: stderr-строка в `status` + поле в `--json`, или вычеркнуть из PRD.
3. **Compose: `status`/шапка видят только свой контейнер** (H4/H6) — README §Docker обещает `◉` для обоих. Варианты: проба по DNS-имени сервиса compose (конфиг-поле `probeHost` у каждого сервиса, entrypoint пишет `serve`/`ui`) или честная фраза в README и `docker-compose.yml`.
4. **Короткий баннер `token-hold` появляется ниже 40 колонок**, не на 40 (F4 по факту переноса); на 40 токен в панели обрезан — копировать через `]`. Чек-лист смока стоит поправить под F4; README §Console — одна фраза про `]`.
5. **`?` на 12 строках не показывает `any key closes this help`** — по замыслу (без прокрутки); при желании — держать строку закрытия последней ценой обрезки середины.
6. **`stop` в контейнере без init отчитывается `forced`** — зомби не пожат PID 1; compose ставит `init: true`, «голому» `docker run` нужен `--init` (фраза в README §Docker).
7. **`systemd-analyze --user verify` требует `XDG_RUNTIME_DIR`** в контейнере/чистой сессии — уточнение для `docs/deploy/README.md`.
8. **`logs ui` режет длинные строки `…`** (readable-фильтр) — путь `bootstrap-token` на 80 колонках со скретч-путём не влез; при штатном `~/.mcp-journal` влезает.
9. Первые ~300 мс после входа шапка/экран входа показывают `services: —` — честно (проба в пути), в глаза не бросается.
10. `MCPCUT_CONFIG` в окружении мастер печатает второй строкой шапки — удобно для смока, оператору с одним конфигом не мешает.
