# Смок: первый владелец заводится в браузере (`/setup`)

**Статус: ПРОЙДЕН 2026-09-19** — 16/16 в Chromium (JS on + no-JS), ветка `feat/web-first-owner-setup`,
`npm run build` перед прогоном. Одна находка смока (LOW, закрыта в волне) — ниже.

**Чем прогоняли.** Стенд: `MCPCUT_DATA_DIR=<scratch>/data MCPCUT_CONFIG=<нет файла> node dist/cli.js ui --port 8097`
над пустым каталогом — путь «`ui` руками над пустым стором», тот же, что даёт `setup --yes --no-admin`.
Браузер — headless-скрипт по рецепту без Playwright MCP (playwright из npx-кеша + `chromium_headless_shell-1234`),
не гейтится dogfood-контуром. Реальный `~/.mcpcut` не тронут.

## Что увидел stderr службы

```
[ui] no admins found: open http://127.0.0.1:8097/setup to create the owner
[ui] the page asks for the one-time setup code in <scratch>/data/setup-code (mode 0600); the file is deleted once the owner exists
[ui] no browser? "mcpcut admin add <name> --role owner" in a shell does the same
ui: listening on http://127.0.0.1:8097
[ui] first-run setup admin.add alice
```

Ни кода (`mcps_…`), ни токена (`mcpa_…`) в stderr нет; stdout пуст (0 байт). `setup-code` создан `-rw-------`.

## Прогон

| # | Проверка | Итог |
|---|---|---|
| 1 | открыть `/` → оказаться на `/setup` | PASS |
| 2 | открыть `/login` → тоже `/setup` | PASS |
| 3 | форма: код (password), имя, роль `owner` (disabled) | PASS |
| 4 | неверный код: alert, имя сохранено в поле, код **не** возвращён в документ | PASS |
| 5 | браузер сам отклоняет `Bad Name` по `pattern` | PASS (после фикса, см. находку) |
| 6 | браузер принимает `ok-name` | PASS |
| 7 | верный код + `Bad Name` в обход `pattern`: сервер отвечает 400 с причиной | PASS |
| 8 | верный код + `alice`: владелец создан, токен показан один раз | PASS |
| 9 | страница токена не переполняется на 390 px | PASS |
| 10 | «I saved it — enter console» входит одним нажатием, дашборд называет `alice` | PASS |
| 11 | Back после входа токен не показывает (`ERR_CACHE_MISS`: `no-store` + POST) | PASS |
| 12 | `/setup` после первого запуска → `/login` | PASS |
| 13 | `/journal?view=records` показывает запись `admin.add` | PASS |
| 14 | ошибок в консоли браузера нет | PASS |
| 15 | без JS, без сессии: `/` → `/login` | PASS |
| 16 | без JS: ошибок нет | PASS |

После шага 8 в каталоге данных нет `setup-code`; остались только `state.db*` и `journal.db*`.

Скриншоты: `docs/design/mcpcut/setup-form.png`, `docs/design/mcpcut/setup-done.png`.

## Находка смока

**LOW — атрибут `pattern` у поля имени не компилировался.** `[a-z0-9][a-z0-9-]{0,63}` — валидный
регэксп для Node, но браузер компилирует `pattern` с флагом `v`, где голый `-` в классе —
`SyntaxError`; невалидный `pattern` молча отбрасывается, поле остаётся без проверки (в консоли —
`Pattern attribute value … is not a valid regular expression`). Сервер имя всё равно валидирует,
так что это UX, не дыра. Закрыто: дефис экранирован (`ADMIN_NAME_HTML_PATTERN`), тест
`tests/ui/setup-page.test.ts` компилирует атрибут с флагом `v` и сверяет его с `ADMIN_NAME_PATTERN`
стора на наборе имён. Урок тот же, что у M4: браузерную поверхность ловит только браузер.

Косметика, поправленная по скриншотам: отступы в блоке токена (`.login-form.token-reveal`),
ширина подвала и `nowrap` у команд, пунктирная рамка у disabled-поля роли.

## Консоль: экран первого владельца (pty, настоящий бинарь)

Стенд: `MCPCUT_CONFIG=<scratch>/config.json mcpcut setup --yes --no-admin --data-dir <scratch>/data`,
затем голый `node dist/cli.js` под pty 120×30. 6/6, повторён после правок ревью.

| # | Проверка | Итог |
|---|---|---|
| 1 | установка без админов открывается экраном `No admin yet — create the owner`, не входом | PASS |
| 2 | `Bad Name` + Enter: отказ под полем (`must match …`), ничего не запущено | PASS |
| 3 | `alice` + Enter: токен `mcpa_…` на экране целиком | PASS |
| 4 | `q` при токене на экране спрашивает, `n` оставляет токен | PASS |
| 5 | `y` входит сам: главный экран называет `alice · owner` | PASS |
| 6 | Ctrl-C — код выхода 0 | PASS |

После прогона: `admin list` показывает `alice owner`; в журнале одна запись
`{"actor":{"adminName":null,"role":null,"via":"cli"},"action":"admin.add","admin":"alice","targetRole":"owner"}`;
токена нет ни в одном файле каталога данных.

Урок стенда: зависший первый прогон успел создать админа, и второй закономерно открылся экраном
входа — чистить каталог данных перед каждым прогоном. И не называть скрипт `pty.py`.

## Что смок не покрывал

- Firefox/Safari — только Chromium.
- Docker: entrypoint по-прежнему передаёт `--admin`, страница `/setup` там не возникает (решение C7
  не пересматривалось).
- Привязку не к loopback и reverse-proxy (`--trusted-proxy-header`, `--behind-tls`): поведение
  `/setup` за ними покрыто только юнит-тестами ядра.
