# Смок: правила тулзов из карточки сервера + горячая перезагрузка политики

**Статус: ПРОЙДЕН** (прогон 2026-08-26, ветка `feat/ui-mcpcut-redesign`, сборка рабочего дерева до `d53b49b`; 3971 тест зелёный).
План — `.claude/plans/policy-tool-rules-ui.plan.md`, модель угроз и решения владельца — ADR-0009. Скриншот карточки — `docs/design/mcpcut/servers-tool-rules.png`.

**Чем прогоняли:** живой стенд на подменённом `HOME` (реальный `~/.mcp-journal` не тронут), UI на порту 8098; управляемая stdio-фикстура `tests/fixtures/probe-server.mjs` (тулзы `read_note`/`write_note`); **живой агент** — настоящий `connect probe --agent bot`, говорящий JSON-RPC в stdin/stdout прокси; браузер — headless Chromium скриптом (playwright из npx-кеша + `executablePath`, см. память `browser-smoke-without-mcp-gate`), чтобы не гейтить каждый шаг dogfood-контуром.

## Стенд

```
SMOKE=<scratch>/smoke-rules
printf '{"mode":"alive","variant":"v1"}\n' > "$SMOKE/probe-control.json"
printf '{"version":1,"defaultDecision":"allow","approval":{"timeoutMs":3000}}\n' > "$SMOKE/.mcp-journal/policy.json"
HOME="$SMOKE" node dist/cli.js ui --port 8098          # owner-токен печатается один раз
HOME="$SMOKE" node dist/cli.js server add probe --transport stdio --command "$(which node)" \
  --args "<repo>/tests/fixtures/probe-server.mjs,$SMOKE/probe-control.json"
HOME="$SMOKE" node dist/cli.js quarantine approve --all --server probe
HOME="$SMOKE" node dist/cli.js agent create bot && agent grant bot probe --tools read_note,write_note
MCP_AGENT_TOKEN=<token> HOME="$SMOKE" node dist/cli.js connect probe --agent bot   # живёт весь прогон
```

## Что проверялось и факт

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| 1 | Исходное состояние | тулзы видны агенту, вызов проходит | ✅ `tools/list` = `[read_note, write_note]`, `read_note` → ok |
| 2 | Карточка сервера | у каждого тулза пилюля исхода + источник и кнопки | ✅ `allow · default`, кнопки `ALLOW · APPROVAL · DENY` (reset появляется при явном правиле) |
| 3 | **Deny из UI → живой агент** | следующий же вызов запрещён, тулз пропал из каталога | ✅ `A1 tools/list = [write_note]`; вызов → «blocked by policy rule `servers.probe.tools.read_note`» |
| 4 | **Require-approval из UI** | следующий вызов встаёт в очередь одобрений | ✅ на дашборде `data-pending-count = 1`; вызов ждал и упал по таймауту 3с («requires human approval and timed out») |
| 5 | **Reset (clear) из UI** | исход снова по дефолту, тулз вернулся | ✅ пилюля `allow`, `tools/list` снова с двумя тулзами, вызов → ok |
| 6 | Без перезагрузки страницы | `<details>` не схлопывается, страница не мигает | ✅ 0 навигаций на действия, `window.__marker` жив, панель тулзов осталась раскрытой |
| 7 | Устаревший CAS-токен | 409 с внятным текстом | ✅ `409 {"status":"conflict","message":"policy changed on disk — reload the page and retry"}`; тост показывает этот текст |
| 8 | CLI без токена | отказ с подсказкой, exit 1 | ✅ «Refusing to edit the policy: no admin token…» |
| 9 | CLI `policy set` (owner) | правка + строка аудита + эффективный исход | ✅ `policy 97da15bf -> a89957af: probe/write_note = require-approval; effective now: require-approval (explicit)` |
| 10 | CLI `--json` | стабильная форма | ✅ `{server, tool, rule, hashBefore, hashAfter, effective{outcome,source,rulePath}, sourcePath}` |
| 11 | Отказ при shadow-файле (находка 5a) | не писать «в никуда» | ✅ «connect loads `<journalDir>/.mcp-journal/policy.json` first… Edit that file by hand or remove it» |
| 12 | `policy show` | что перечитывается, что требует рестарта | ✅ «hot reload: rules yes (…) · wiring config no (approval.timeoutMs, approval.grantTtlMs, journal.failClosed, quarantine.enabled — restart running proxies)» |
| 13 | Журнал правок | `kind: 'policy-edit'`, атрибуция, связка хешей | ✅ 8 записей `plane_policy`, `via: ui/cli`, `adminName: owner`, `hashBefore -> hashAfter` встык (`97da15bf → 5415fe21 → f9db54fd → 97da15bf`) |
| 14 | Цепочка журнала | не сломана новым kind | ✅ `verify`: «Chain intact through seq 74 (74 record(s) checked)» |
| 15 | Минимальность файла | правка не раздувает ручной файл | ✅ после всех правок `policy.json` = ровно исходные `version`/`defaultDecision`/`approval` |

> **Поправка 2026-08-26 (после прогона).** Строки 10 и 11 описывают поведение на момент смока.
> Решением владельца цель записи стала **тем файлом, который загрузил сам вход** (ADR-0009,
> «Поправка 2026-08-26»): отказ строки 11 снят — расхождение читателей теперь **печатается**
> («connect reads `<путь>` first — rules here reach ui/wrap/serve only»), а не блокирует правку;
> в форме `--json` строки 10 добавилось поле `readers {connect, connectPath, operator}`
> (остальные поля не менялись). Прогон не переигрывался: строки оставлены как исторический
> протокол.

## Находки прогона (закрыты в этом заходе)

1. **Правило вступало в силу через один вызов.** Первая версия `maybeRefresh()` лишь планировала асинхронную проверку, а `decide()` работал синхронно со старой политикой: deny → следующий вызов ещё разрешён, require-approval → следующий вызов упирался в предыдущий deny. Закрыто синхронной проверкой на горячем пути (`statSync` не чаще 250 мс, `readFileSync`+parse+подмена до возврата) — коммит `d53b49b`. **Урок: гейт «следующий вызов» проверять живым агентом, а не только тестом с прогревом.**
2. **Хеш политики в строке источников оставался старым** после действия — строка вне live-региона. Закрыто `data-live-text="policy-hash"` (`5ac3cb0`). Важно не косметически: этот хеш оператор сверяет с журналом.
3. **Тост отказа читался как голый код** (`Action failed (409)`). Теперь несёт `message` из JSON-ответа (`d792c64`).

## Не покрыто

- Firefox/WebKit-плечо (открытый пункт бэклога всех прошлых смоков).
- Гонка двух живых писателей политики (UI и CLI одновременно): межпроцессный O_EXCL-лок закреплён юнит-тестами на реальном temp-каталоге (два независимых писателя → ровно один `written`), в живом стенде вручную не воспроизводилась.
- Ветка «битый файл на диске» в живом UI (баннер + отключённые кнопки): закреплена тестами рендера и юнитами провайдера, глазами в браузере не смотрели.
- no-JS деградация (обычный POST → 303): контракт под тестами, в браузере с выключенным JS не прогонялась.
- `serve`/`wrap` как потребители горячей перезагрузки: в живом стенде прогнан только `connect`; для остальных — e2e и юниты.
