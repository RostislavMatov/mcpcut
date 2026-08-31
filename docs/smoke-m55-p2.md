# Смок: группы серверов (M5.5 п. 2) — CLI, трафик, `/groups`, колонка Source, каскад `server remove`

**Статус: ПРОЙДЕН** (прогон 2026-08-31, ветка `feat/m55-server-groups`, HEAD `b76a7f1`; 4317 тестов зелёные, `npm run lint` чист — оба **после** правки, найденной в смоке).
Поверхности — по ADR-0010 §6 и плану `.claude/PRPs/plans/completed/m55-server-groups.plan.md` §«Ручная проверка». Скриншоты — `docs/design/mcpcut/groups-page.png`, `groups-drawer.png`, `agents-source-column.png`, `servers-remove-cascade.png`, `journal-access-edit.png`.

**Чем прогоняли:** живой стенд на подменённом `HOME` (реальный `~/.mcp-journal` не тронут), UI на порту 8098; управляемая stdio-фикстура `tests/fixtures/probe-server.mjs` (тулзы `read_note`/`write_note`) под двумя именами — `notes` и `other`; настоящий трафик через `connect` со сценарным JSON-RPC по stdin; браузер — headless Chromium скриптом (playwright из npx-кеша + `executablePath`, см. память `browser-smoke-without-mcp-gate`), в двух контекстах: **с JavaScript** и **с полностью выключенным JavaScript**; роли — тремя именными админами через `curl` (CSRF + `Origin`).

## Стенд

```
SMOKE=<scratch>/smoke-groups
HOME="$SMOKE" node dist/cli.js admin add alice      --role owner       # токен печатается один раз
HOME="$SMOKE" node dist/cli.js admin add viewer-vic --role viewer
HOME="$SMOKE" node dist/cli.js admin add op-olga    --role operator
echo '{"tools":[{"name":"read_note","description":"Reads a note"},
       {"name":"write_note","description":"Writes a note"}]}' > "$SMOKE/probe-control.json"
HOME="$SMOKE" node dist/cli.js server add notes --transport stdio --command "$(which node)" \
  --args "<repo>/tests/fixtures/probe-server.mjs,$SMOKE/probe-control.json"
HOME="$SMOKE" node dist/cli.js server add other --transport stdio --command "$(which node)" \
  --args "<repo>/tests/fixtures/probe-server.mjs,$SMOKE/probe-control.json"
HOME="$SMOKE" node dist/cli.js agent create bot-a
HOME="$SMOKE" node dist/cli.js agent create bot-b
HOME="$SMOKE" node dist/cli.js ui --port 8098
```

Авто-проба при регистрации (M5.5 п. 1) сама наполнила инвентарь: оба сервера — `alive`, по две тулзы в карантине как `new`.

## A. CLI `group *`

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| A1 | `group create analytics` **без** `MCP_ADMIN_TOKEN` | exit 1, ничего не записано | ✔ exit 1; «Refusing to change groups: no admin token… role "owner"» с подсказкой `admin add`/`admin rotate`; `group list` после этого пуст |
| A2 | то же с токеном alice | ok + `[audit]` на stderr | ✔ `created group analytics` (stdout) + `[audit] group create by alice (owner): analytics` (stderr) |
| A3 | `group grant analytics notes --tools read_note` | запись + аудит | ✔ `granted notes to group analytics: read_note`, `[audit] group grant by alice (owner): analytics/notes` |
| A4 | `group join analytics bot-a` | запись + аудит | ✔ `added bot-a to group analytics`, `[audit] group join …: analytics/bot-a` |
| A5 | `group show analytics` | имя, дата, гранты по-серверно, члены | ✔ `grants: notes: read_note`, `members: bot-a` |
| A6 | `group list` | таблица со счётчиками | ✔ `analytics 1 1` (NAME/SERVERS/MEMBERS) |
| A7 | `group remove analytics` при члене | **отказ** со списком членов, exit 1 | ✔ exit 1, `group "analytics" still has members: bot-a — remove them first` |
| A8 | `group create` токеном viewer / operator | отказ (G4 — только owner) | ✔ обоим: отказ с подсказкой `mcp-journal admin role <name> owner`; ни `x1`, ни `x2` не созданы |

## B. Трафик: группа даёт и отнимает доступ по-настоящему

`MCP_AGENT_TOKEN=<bot-a> node dist/cli.js connect notes --agent bot-a`, сценарий по stdin.

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| B1 | `initialize` | сервер отвечает | ✔ `protocolVersion 2026-07-28`, `probe-server 0.0.1` |
| B2 | `tools/list` | ровно `read_note` (грант группы) | ✔ в ответе одна тулза `read_note`; в журнале **две** записи `decision` — `toolsList.original` (`read_note, write_note`) и `toolsList.filtered` (`read_note`) |
| B3 | `tools/call write_note` | отказ — не выдана | ✔ `-32001`, `rule: "agent: no grant for notes/write_note"`, `reason: policy_denied` |
| B4 | `tools/call read_note` | проходит | ✔ результат фикстуры `{"served":"v1"}` |
| B5 | `grantsHash` в записи решения | непустой | ✔ `44378289e298…3766` во всех четырёх записях `decision` сессии; агент — из группы, персональных грантов нет |
| B6 | `group ungrant analytics notes` → новый `connect` | правка группы дошла до входа | ✔ `connect` отказывает **на старте**: `agent "bot-a" has no grant for server "notes"` — сервер даже не поднимается |
| B7 | `sessions` / `show plane_access --json` | правки группы отдельной сессией | ✔ три записи `kind: access-edit`, `sessionId: plane_access`, у каждой `actor: {adminName:"alice", role:"owner", via:"cli"}` и `action: group.create|group.grant|group.join`; полей `decision`/`agentName` нет |

## C. Браузер, JavaScript ВКЛЮЧЁН (owner alice)

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| C1 | `/groups` | карточка группы, вкладка в nav между Servers и Agents, счётчик | ✔ `SERVER GROUPS`, карточка `analytics · 1 server · 1 member`, матрица грантов, `MEMBERS bot-a`, `REMOVE GROUP`; nav-мета `1 group · 1 member` (`groups-page.png`) |
| C2 | **Закрытые дровера** — ловушка специфичности `details.drawer` (0,1,1) | ни полосы, ни рамки | ✔ у всех трёх (`create-group`, `grant-group`, `join-group`) `display: none`, высота 0, border 0 — `details.gr-drawer` в `page-groups.ts` перебивает общий правильно |
| C3 | Создание группы через drawer | `+` в nav открывает модалку, POST создаёт | ✔ модалка по центру с затемнением, поле `name` и подсказка «lowercase, digits and hyphens · up to 64 chars»; создана `ops` (`groups-drawer.png`) |
| C4 | `Grant a server` → `other` для `ops` | грант виден в карточке | ✔ строка `other · ALL · — · —` с кнопкой `UNGRANT` |
| C5 | `Add an agent` → `bot-b` в `ops` | член виден | ✔ `ops · 1 server · 1 member`, `MEMBERS bot-b · LEAVE` |
| C6 | `/agents`, колонка **Source** | `group:<имя>`, строка read-only и ведёт в `/groups` | ✔ `bot-a → notes … group:analytics`, `bot-b → other … group:ops`; вместо `Ungrant` — ссылка `manage in groups` на `/groups#group-<name>` |
| C7 | Персональный грант `bot-a` на `notes` поверх группы | `agent` + пометка «overrides group:analytics» | ✔ строка стала `read_note write_note … agent  overrides group:analytics`, вернулась кнопка `UNGRANT` (`agents-source-column.png`) |
| C8 | `/servers` → remove `other` | интерстишел перечисляет держателей до подтверждения | ✔ «Removing this server also removes it from 1 agent grants and 1 groups:», секции `Agents: bot-a` и `Groups: ops`, `REMOVE ANYWAY` / `Cancel` (`servers-remove-cascade.png`) |
| C9 | Подтверждение каскада | сервер и грант исчезают у обеих половин | ✔ 303 → `/servers` (остался только `notes`); в `/groups` у `ops` — `0 servers · 1 member`, `no servers granted`; у агента-держателя грант тоже снят |
| C10 | `/journal`, записи `access-edit` | под сессией `plane_access`, с актором и действием | ✔ `session plane_access`, пилюля `ACCESS-EDIT`, раскрытая запись показывает `actor/action/group/server/grant` целиком (`journal-access-edit.png`) |
| C11 | `group remove` при члене (UI) | панель отказа со списком | ✔ «GROUP “OPS” STILL HAS MEMBERS — Remove 1 member from the group first… Members: bot-b» |
| C12 | `Leave` → `Remove group` | подтверждение, затем удаление | ✔ интерстишел «REMOVE GROUP “OPS”? This group grants N servers…» → `REMOVE IT` → в списке снова только `analytics` |
| C13 | Консоль | 0 ошибок | ✔ 0 `console.error`, 0 `pageerror` за весь проход |

## D. Браузер, JavaScript ВЫКЛЮЧЕН (`javaScriptEnabled: false`)

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| D1 | `/groups?add=1` | серверный рендер открывает нужный drawer | ✔ `#create-group` открыт и виден; `#grant-group` и `#join-group` при этом невидимы |
| D2 | Создание нативной формой | POST → 303 на `/groups` | ✔ группа `nojs` появилась в списке |
| D3 | `/groups?grant=1` + нативные `<select>` | грант записан | ✔ `nojs · 1 server · 0 members` |
| D4 | `/groups?join=1` | член записан | ✔ nav-мета стала `2 groups · 2 members` |
| D5 | Отказ и удаление группы | обе панели работают без JS | ✔ отказ со списком членов → `Leave` → интерстишел «REMOVE GROUP “NOJS”? … Servers granted: other» → `REMOVE IT` → группы нет |
| D6 | Интерстишел `server remove` без JS | перечисляет обе половины, каскад проходит | ✔ «1 agent grants and 1 groups», `Agents: bot-b`, `Groups: nojs2`; после подтверждения у группы `0 servers`, у `bot-b` — `no grants` |
| D7 | `server remove` при **нуле** держателей | без интерстишела | ✔ удаление сразу, страница `/servers` без `other` |

## E. Роли (G4: группы — только owner)

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| E1 | `viewer-vic` на `/groups` | страница видна, органов управления нет | ✔ ни `+` в nav, ни ссылок `Grant a server` / `Add an agent`, ни одной формы `action="/groups/*"`, ни одного дровера |
| E2 | `op-olga` на `/groups` | то же самое — operator не расширен | ✔ ровно те же нули |
| E3 | POST на все шесть маршрутов от обоих (с валидным CSRF и `Origin`) | 403 | ✔ `create`, `grant`, `join`, `leave`, `ungrant`, `remove` — по 403 обоим; группа `sneaky` не создана |
| E4 | `/agents`, drawer «Grant by group» | отсутствует у не-owner | ✔ нет ни у vic, ни у olga; колонка `Source` при этом видна обоим (чтение не сужалось) |

## F. Укрепление новых POST

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| F1 | Пустое тело на каждый `POST /groups/*` (owner) | 400, не 500 | ✔ все шесть — 400 с панелью «Could not complete the action» |
| F2 | Имя группы с `<script>` | экранировано, группа не создана | ✔ 400, в теле `&lt;script&gt;alert(1)&lt;/script&gt;` и текст ошибки со схемой `^[a-z0-9][a-z0-9-]{0,63}$`; сырых `<script>alert` в ответе 0 |
| F3 | POST без заголовка `Origin` | 403 | ✔ |
| F4 | POST с чужим `csrf_token` | 403 | ✔ |

## Находки

**1. ЗАКРЫТО в ходе смока — шапка карточки группы липла к рамке.** `.gr-card` обнуляет собственный `padding` (карточка = `<details>`, чтобы тело управляло отступами само), а у `.gr-sum` отступа не было вовсе: имя группы начиналось на x=44 при внутренней кромке рамки ровно 44, счётчик `1 server · 1 member` упирался в правую кромку — и вся строка не совпадала с телом карточки, вложенным на 14px (`.gr-bd`). Соседняя карточка сервера этой болезни не имеет: `.srv-sum` несёт `padding: 11px 12px`. Закрыто одной строкой — `.gr-sum { … padding: 11px 14px; }` (горизонталь совпадает с `.gr-bd`) плюс комментарий о причине; замер после правки: имя на 58 = 44 + 14, счётчик кончается на 1222 = 1236 − 14. Тестом не покрыто сознательно: в проекте нет ни одного теста на значения CSS (прошлая правка того же класса — `details.srv-drawer` в `page-servers.ts` — тоже закрыта комментарием), а тест на строку в CSS-бандле был бы хрупким и ничего не доказывал.

**2. ОТКРЫТО (MEDIUM) — README документирует команду, которая не работает: `--tools "*"`.** `README.md:555` в новом разделе «Server groups» показывает `mcp-journal group grant analytics postgres --tools "*"`, но одинокая звёздочка отбивается: `invalid tool pattern "*": must be an exact name or end with a single "*"` (`TOOL_RULE_NAME_PATTERN = /^[A-Za-z0-9_.:-]+\*?$/`, `src/policy/constants.ts:176`). Причина — асимметрия в `src/cli/grant-flags.ts`: `parseMethodFlag` явно ловит `value.trim() === '*'` и возвращает `'*'`, а `parseToolsFlag` возвращает `'*'` **только для отсутствующего флага** и иначе уходит в `splitPatterns`. UI звёздочку принимает (грант рисуется как `ALL`), `--resources "*"` тоже. Сам код-пробел **не новый**: на `main` `agent grant --tools "*"` падает ровно так же — новым на этой ветке является пример в README. Два выхода: паритет одной строкой в `parseToolsFlag` (тогда CLI, UI и README сходятся) либо правка примера в README. Оставлено владельцу: `grant-flags.ts` — общий путь M3 за пределами мандата этого смока, а выбор между «расширить CLI» и «сузить документацию» — решение, а не опечатка.

**3. ОТКРЫТО (LOW, косметика) — нет формы единственного числа в каскаде.** Интерстишел говорит «Removing this server also removes it from **1 agent grants** and **1 groups**». Формулировка совпадает со строкой аудита CLI, процитированной в README (`cascaded: 2 agent grants, 1 groups`), то есть согласована — но не по-английски. Правка стоит одного хелпера на обе стороны; трогать не стал, чтобы не ветвить строки во время ревью.

**4. Наблюдение (не дефект) — `POST /agents/grant` отвечает 200-панелью, все `POST /groups/*` отвечают 303.** Новые групповые маршруты ведут себя как `servers/*` (PRG, возврат на страницу), унаследованный `agents/grant` показывает страницу «Done» с ссылкой «Back to agents». Поведение `agents/grant` — из M4 и этой веткой не менялось; расхождение заметно теперь, когда обе формы стоят на одной странице.

**5. Наблюдение (не дефект) — текстовый поиск журнала не покрывает `kind`.** `?view=records&q=access-edit` не находит ничего: `searchableText` (`src/journal/search-filters.ts:99-106`) склеивает `method`, короткие поля решения и payload, но не `kind`. Записи находятся по содержимому — `q=group.create` даёт их все. Поведение прежнее, к группам отношения не имеет; отмечено, чтобы следующий смокер не принял это за потерю записей.

**6. Заметка про стенд (не дефект) — `SESSIONS_PER_ADMIN_MAX = 8`.** После восьми логинов подряд одним и тем же токеном `/login` начинает отвечать 429 (`src/ui/constants.ts`), и это ровно то, что задумано: живая сессия не выселяется ради новой. В смоке лечится перезапуском `ui` (таблица сессий в памяти); стоит помнить при скриптовых прогонах, которые логинятся на каждый шаг.

## Что НЕ проверялось

- Firefox/WebKit — только Chromium (headless shell).
- Вход `serve` (HTTP-фронт): трафик гнали только через `connect`; развёртка групп живёт в ридере, общем для обоих входов, и покрыта юнит-тестами (`tests/agents/effective-reader.test.ts`, serve-тесты), но живого HTTP-прогона в этом смоке не было.
- Подхват правки группы **живой** сессией на опросе отзыва (≤ 5 с): проверено тестом `tests/session/agent-watch-groups.test.ts`, вручную — нет; B6 проверяет соседнее, отказ на новом подключении.
- Слияние **двух и более** групп на одном агенте (объединение с дедупом, поглощение `'*'`) — только юнит-тесты; в браузере агент состоял максимум в одной группе.
- SSE-живость `/groups`: страница отдаёт `data-events-url`, но обновления карточек по событию не проверялись — все переходы шли через POST + 303.
- Гонка «одновременная правка группы из UI и CLI» и незавершённый (прерванный на полпути) каскад `server remove` — не-атомарность описана в ADR-0010 §5 и лечится повтором команды; специально не воспроизводилась.
