# Ручной смок M4.5 волна 5 — установка, миграция, бэкап и отказ на повреждённой БД

**Пройден 2026-08-16.** Закрыт последний открытый пункт acceptance волны 5 (план
`.claude/PRPs/plans/storage-cutover-and-docs.plan.md`, задача 12): процедуры из README
(«Backup & restore», апгрейд с M4, отказ при повреждении) прогнаны руками на продовом `dist/`.

Стенд: только скретч-каталоги, реальный `~/.mcp-journal` **не использовался** — каждый вызов CLI
шёл с подменённым `HOME` (`JOURNAL_DIR = join(homedir(), '.mcp-journal')`, `src/config.ts`).
Проверено после прогона: `find ~/.mcp-journal -newermt '-40 minutes'` — пусто, mtime каталога
`02:28` (прогон шёл `03:41–03:47`). Живой upstream — `@modelcontextprotocol/server-memory` 0.6.3,
клиент — свой драйвер JSON-RPC поверх stdin/stdout `wrap` (скретчпад сессии, `smoke-w5/driver.mjs`).

Каталоги стенда: `fresh/` (чистая установка), `legacy/` (имитация M4-установки), `bak/` (бэкап),
`restored/` (восстановление), `corrupt/` + `corrupt2/` (две формы повреждения),
`journalonly/`, `empty/` (краевые случаи `backup`).

## Часть 1 — чистая установка (`wrap`, живой MCP-клиент)

```
HOME=<scratch>/fresh node dist/cli.js wrap --server memory -- npx -y @modelcontextprotocol/server-memory
  # в stdin: initialize → notifications/initialized → tools/list → tools/call create_entities
HOME=<scratch>/fresh node dist/cli.js sessions
HOME=<scratch>/fresh node dist/cli.js show 01M04092VX2PD7AN0CGRA282M0
HOME=<scratch>/fresh node dist/cli.js export
HOME=<scratch>/fresh node dist/cli.js export --session 01M04092VX2PD7AN0CGRA282M0
```

| # | Действие | Факт |
|---|---|---|
| 1 | `wrap` на пустом `HOME`, прогон настоящего MCP-хендшейка | ☑ ответы прошли сквозняком: `initialize` → `"serverInfo":{"name":"memory-server","version":"0.6.3"}`, `tools/list` → 9 тулзов; каталог `.mcp-journal` создан `0700`, в нём `journal.db` и `state.db` (оба `0600`) |
| 2 | `sessions` | ☑ ровно одна сессия: `01M04092VX2PD7AN0CGRA282M0 … 11 messages`; **подсказки про legacy на stderr нет** (файлов `*.jsonl` в каталоге не появилось) |
| 3 | `show <id>` | ☑ 11 записей, все виды носителя видны: `request`/`response`/`notification`/`stderr`/`decision`, включая пару `toolsList.original` / `toolsList.filtered` |
| 4 | `export` | ☑ 11 строк, **все 11 распарсились как JSON**; форма записи: `{"id","ts","sessionId","direction","kind","payload","method","rpcId"}` |
| 5 | `export --session <id>` | ☑ те же 11 строк (фильтр работает); на несуществующий id — пустой stdout, exit 0 — тот же контракт, что у `show <неизвестный id>` (проверено), см. наблюдение 3 |

Побочно: `tools/call create_entities` на первом контакте с новым сервером ушёл в карантин M2
(`outcome=require-approval-pending rule=quarantine` → через 6.5 с `outcome=timeout`), клиент
получил `-32002` с `approvalId` и инструкцией `mcp-journal approvals approve <id>`. Политика
подхватилась из проектного `./.mcp-journal/policy.json` самого репозитория (`write:
require-approval`) — ожидаемое поведение `wrap`, зафиксированное ещё в смоке M3. Для смока волны 5
это плюс: `state.db` на «wrap-only» установке оказался не пустым, и часть 3 проверила бэкап обеих БД.

**Вердикт: pass.**

## Часть 2 — апгрейд с M4 (legacy `*.jsonl` → `migrate`)

В пустой `HOME` руками положен правдоподобный legacy-журнал
`01KZLEGACYW5SMOKE0000000AA.jsonl` (3 записи в форме `JournalRecord`, срисованной с `export`
части 1: `request` / `response` / `decision`).

```
HOME=<scratch>/legacy node dist/cli.js sessions      # до миграции
HOME=<scratch>/legacy node dist/cli.js show 01KZLEGACYW5SMOKE0000000AA
HOME=<scratch>/legacy node dist/cli.js migrate
HOME=<scratch>/legacy node dist/cli.js sessions|show|export
HOME=<scratch>/legacy node dist/cli.js migrate       # повторно
```

| # | Действие | Факт |
|---|---|---|
| 6 | `sessions` до миграции | ☑ stdout: `No sessions found.`; stderr: `1 legacy *.jsonl session file(s) are not imported; run \`mcp-journal migrate\` to see them.` — сессии в списке нет, оператор не остаётся в неведении |
| 7 | `show <id>` до миграции | ☑ адресная подсказка: `01KZLEGACYW5SMOKE0000000AA has an un-imported legacy *.jsonl file; run \`mcp-journal migrate\` to see it.`, stdout пуст |
| 8 | `migrate` | ☑ построчный отчёт: `agents.json/admins.json/registry.json/tool-inventory.json/approvals/ -> no file`, `journal: *.jsonl -> imported (3 records from 1 sessions)`, итог «Migrated 1 store(s) into state.db.» (см. находку 1) |
| 9 | `sessions` после миграции | ☑ сессия видна (`3 messages`), **подсказка со stderr исчезла** |
| 10 | `show` / `export` после миграции | ☑ все 3 записи на месте, `id` совпадают побайтно с посеянными (`…A1/…A2/…A3`), `decision` отрисован как `outcome=allow tool=search_nodes rule=classDefaults.read`; export парсится |
| 11 | Повторный `migrate` | ☑ `journal: *.jsonl -> already migrated`, «Migrated 0 store(s)» — идемпотентно |
| 12 | Файлы после миграции | ☑ исходный `*.jsonl` на месте и не тронут (холодный бэкап, как обещает README), рядом появились `journal.db` и `state.db` |

**Вердикт: pass.**

## Часть 3 — бэкап и восстановление

```
HOME=<scratch>/fresh node dist/cli.js backup <scratch>/bak
cp <scratch>/bak/{state.db,journal.db} <scratch>/restored/.mcp-journal/
HOME=<scratch>/restored node dist/cli.js sessions
HOME=<scratch>/fresh node dist/cli.js backup <scratch>/bak      # повторно, в тот же каталог
```

| # | Действие | Факт |
|---|---|---|
| 13 | `backup <destDir>` | ☑ **две строки отчёта**: `backup: state.db -> …/bak/state.db`, `backup: journal.db -> …/bak/journal.db`, exit 0 |
| 14 | Права результата | ☑ оба файла `-rw-------` (0600), каталог `drwx------` (0700) |
| 15 | Восстановление в НОВЫЙ пустой `HOME` (просто `cp` файлов бэкапа) | ☑ `sessions` — **побайтно тот же листинг**, что в источнике (`diff` пуст); `export` — тоже `diff`-идентичен, 11 строк. WAL-хвост источника вошёл в снимок: онлайн-бэкап SQLite отработал как заявлено |
| 16 | Повторный `backup` в тот же каталог | ☑ отказ, exit 1: `Could not back up database "…/fresh/.mcp-journal/state.db" to "…/bak/state.db": EEXIST: file already exists…`; предыдущий снимок не перезаписан |
| 17 | Краевой: установка только с `journal.db` | ☑ одна строка отчёта, exit 0 — команда бэкапит то, что есть, и не создаёт недостающую БД |
| 18 | Краевой: пустая установка | ☑ `No databases to back up.`, exit 1 |

Оговорка по сценарию: пункт задания «`state.db` может отсутствовать на wrap-only установке»
на этом стенде не воспроизвёлся — `state.db` создался очередью одобрений (карантинный
gated-вызов части 1), поэтому строк отчёта честные две. Случай «только `journal.db`» проверен
отдельно (пункт 17).

**Вердикт: pass.**

## Часть 4 — отказ старта на повреждённой БД

Проверены **обе** ветки `DatabaseIntegrityError` (`src/store/preflight.ts`): «не открывается»
и «открылась, но `integrity_check` ругается».

```
cp -R <scratch>/fresh/.mcp-journal <scratch>/corrupt/.mcp-journal
# первые 4 байта state.db → 0xdeadbeef
HOME=<scratch>/corrupt node dist/cli.js serve --port 0
HOME=<scratch>/corrupt node dist/cli.js ui --port 0
HOME=<scratch>/corrupt node dist/cli.js wrap --server memory -- npx -y @modelcontextprotocol/server-memory
# отдельная копия: страница 7 journal.db забита 0x5a (заголовок цел, файл открывается)
HOME=<scratch>/corrupt2 node dist/cli.js serve --port 0
```

| # | Действие | Факт |
|---|---|---|
| 19 | `serve` на `state.db` с побитым заголовком | ☑ exit **1**, stderr: `state.db cannot be opened: Could not open database "…/state.db": file is not a database` + `Refusing to start. Restore the database from a backup (see README "Backup & restore").`; порт не занят |
| 20 | `serve` на `journal.db` с повреждённой страницей | ☑ exit **1**, stderr: `journal.db failed PRAGMA integrity_check: *** in database main *** Tree 7 page 7: btreeInitPage() returns error code 11` + та же строка `Refusing to start…` |
| 21 | `ui` на том же повреждённом каталоге | ☑ exit 1, дословно тот же отказ — фронт браузера тоже fail-closed |
| 22 | `wrap` на том же каталоге | ☑ exit 1, тот же отказ; upstream-процесс не запускался |
| 23 | Короткоживущая команда (`sessions`) на том же каталоге | ☑ отработала штатно (exit 0, сессия видна) — `state.db` повреждён, а читает она `journal.db`. Это заявленный дизайн (`preflight.ts`: короткоживущие команды не платят O(размер БД) за проверку), не находка |
| 24 | Ссылка из текста отказа | ☑ раздел README «Backup & restore» существует и описывает ровно ту процедуру, которую прошли в части 3 (остановить процессы → положить файлы → старт, `integrity_check` подтверждает) |

Техническая заметка для повторяемости: попытка повредить «случайные» 200 байт внутри страницы 2
дала `integrity_check: ok` (байты попали в неиспользованную область), и `serve` корректно
стартовал — сам по себе не дефект. Перебором найдено, что на этой БД (12 страниц) забивка
страниц 2–6 и 10–12 роняет уже открытие (ветка «cannot be opened»), а страниц 7–9 — оставляет
файл открываемым и валит `integrity_check` (ветка «failed PRAGMA integrity_check»). Для будущих
прогонов: **страница 7** — надёжный способ получить вторую ветку.

**Вердикт: pass.**

## Замеры

Взяты с этой же машины (прогоны волн 4–5), приводятся как есть:

| Замер | Значение |
|---|---|
| `searchSession`, 1M строк | p50 **0.76 ms**, p95 **1.00 ms** |
| `searchAllSessions`, 1M строк | p50 **2.32 ms**, p95 **4.64 ms** (волна 4: 6.65 ms — регрессии нет) |
| `PRAGMA integrity_check`, 583 MB / 1M строк | **1.77 s** холодный, **~0.73 s** тёплый |

Порог эскалации стартовой проверки (~2 s) не превышен даже на холодном кэше — переход на
`quick_check` не требуется.

## Находки

1. **LOW — врущая итоговая строка `migrate`.** При миграции только журнала печатается
   «Migrated 1 store(s) into **state.db**.» (`src/cli/migrate-cmd.ts:183`), хотя записи ушли в
   `journal.db` — строка захардкожена и не различает целевую БД. Пострадавших нет (построчный
   отчёт выше называет стор верно: `journal: *.jsonl -> imported`), но оператора, который
   после апгрейда пойдёт бэкапить «тот самый state.db», это дезориентирует. Кандидат в бэклог:
   либо «into the database», либо имя БД по стору. Исходники по условиям прогона не правились.
2. **Наблюдение (не дефект) — короткоживущие команды не видят повреждения.** `sessions` на
   каталоге с мёртвым `state.db` отвечает как ни в чём не бывало (пункт 23). Поведение
   задокументировано в `preflight.ts` и осознанно, но в README раздела «что делать при
   повреждении» стоит явно сказать: диагностика повреждения — это попытка старта
   `serve`/`ui`/`wrap`/`connect`, а не `sessions`; успешный `sessions` **не** означает, что
   установка цела.
3. **Наблюдение (не дефект) — тихий `export`/`show` на неизвестном id.** Оба печатают пустоту
   и выходят с 0. Между собой согласованы, скриптам это удобно (пустой вывод вместо ошибки),
   но человек за терминалом не отличает «сессии нет» от «сессия пуста». Кандидат в косметический
   бэклог, отдельного пункта не завожу.

Ни одного CRITICAL/HIGH. Все четыре обязательных сценария (чистая установка, апгрейд с M4,
бэкап/восстановление, отказ на повреждении) прошли по README дословно.

## Гигиена после прогона

- Реальный `~/.mcp-journal` не читался на запись и не изменялся: проверка `find ~/.mcp-journal
  -newermt '-40 minutes'` после прогона — пусто.
- Весь стенд остался в скретчпаде сессии (`smoke-w5/`) для справки; учётки, токены, админы и
  агенты не создавались, живых процессов после прогона не осталось (`serve`/`ui` ни разу не
  дошли до bind — либо отказ, либо явное завершение).
- Единственная запись во внешнюю систему за прогон — сущность `smoke-w5` в графе
  server-memory — не состоялась: вызов был остановлен карантином и истёк по таймауту.
