# Смок: карточка сервера по `Servers.dc.html` (тулзы в модалке, состояние словом, релиз из карантина)

**Статус: ПРОЙДЕН** (прогон 2026-08-27, ветка `feat/ui-mcpcut-redesign`; 4021 тест зелёный, `npm run lint` чист).
Источник — экран `Servers.dc.html` дизайн-проекта `claude.ai/design/p/862ebc55-…`. Скриншоты — `docs/design/mcpcut/servers-tiles-state.png`, `servers-card-tools-row.png`, `servers-tools-modal.png`, `servers-tools-release.png`, `servers-tools-modal-nojs.png`.

**Чем прогоняли:** живой стенд на подменённом `HOME` (реальный `~/.mcp-journal` не тронут), UI на порту 8097; управляемая stdio-фикстура `tests/fixtures/probe-server.mjs` (тулзы `read_note`/`write_note`) плюс заведомо недоступный http-сервер; браузер — headless Chromium скриптом (playwright из npx-кеша + `executablePath`, см. память `browser-smoke-without-mcp-gate`), в двух контекстах: с JavaScript и **с полностью выключенным JavaScript**.

## Стенд

```
SMOKE=<scratch>/smoke
HOME="$SMOKE" node dist/cli.js admin add alice --role owner        # owner-токен печатается один раз
echo '{"tools":[{"name":"read_note","description":"Reads a note"},
       {"name":"write_note","description":"Writes a note"}]}' > "$SMOKE/probe-control.json"
HOME="$SMOKE" node dist/cli.js server add probe --transport stdio --command "$(which node)" \
  --args "<repo>/tests/fixtures/probe-server.mjs,$SMOKE/probe-control.json"
HOME="$SMOKE" node dist/cli.js server add remote --transport http --url https://mcp.example.com/sse
HOME="$SMOKE" node dist/cli.js ui --port 8097
```

Авто-проба при регистрации (M5.5 п.1) сама наполнила инвентарь: `probe` — `alive`, обе тулзы в карантине как `new`; `remote` — `unreachable`.

## Что проверялось и факт

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| 1 | Плитка | точка · имя, пилюля транспорта + **слово состояния**, пилюля карантина, target, мета | ✅ `STDIO alive` / `HTTP unreachable`, `1 quarantined`; у http-плитки target без схемы — `mcp.example.com/sse` |
| 2 | Развёрнутая карточка | command, args строками с номерами от `00` и счётчиком против потолка, env с потолком | ✅ `ARGS 2 / 100`, строки `00`/`01`, `ENV 0 / 100`, пусто = «no env entries» |
| 3 | Строка тулзов | одна кнопка `tools · N exposed · M quarantined · view →` вместо списка внутри карточки | ✅ `TOOLS 2 exposed · 2 quarantined … view →` |
| 4 | **Модалка тулзов с JS** | открывается на месте, без перезагрузки страницы | ✅ `window.__marker` пережил клик, `framenavigated` = 0; в модалке — имя сервера, тулзы, пилюли карантина, правила `ALLOW · APPROVAL · DENY` |
| 5 | **Модалка тулзов без JS** | `GET /servers?tools=probe` рисует ту же модалку открытой | ✅ модалка видима и полностью функциональна при `javaScriptEnabled: false`; карточка при этом раскрыта (иначе строка `view →` была бы недоступна) |
| 6 | Подтверждение релиза | вложенный диалог с текстом под случай + ссылкой на структурный дифф | ✅ для `new` — «was discovered on the last probe and has never run»; всегда «This view shows the description only — review the structural diff» |
| 7 | **Релиз из карантина** | нативный POST `/quarantine/approve` возвращает на `/servers`, а не в JSON | ✅ 303 → `/servers`, счётчик стал `2 exposed · 1 quarantined`; после второго релиза `quarantine list` = пусто |
| 8 | Ошибки в консоли | нет | ✅ пусто в обоих контекстах |

## Найдено и закрыто в ходе смока

**Закрытая `<details>`-модалка оставляла на странице полосу.** `details.drawer` в `components.ts` специфичнее голого класса `.srv-drawer`, поэтому `border: none` не применялся: у закрытого дровера (его `summary` визуально скрыт) оставалась рамка 2px нулевой высоты — тонкая белая полоса под сеткой. Проявилось на трёх узлах сразу (регистрационный дровер + две модалки тулзов). Закрыто повышением специфичности до `details.srv-drawer, details.srv-tools-modal` и `display: none` у закрытой модалки.

## Что НЕ проверялось

- Firefox/WebKit — только Chromium (headless shell).
- Закрытие модалки кликом по фону: в дизайне оно есть, здесь закрывают `×` и `Cancel` (клик по фону потребовал бы JS-обработчика без no-JS-эквивалента).
- Тумблер `exposed`/`hidden` на тулз из дизайна **не переносился**: у нас эту роль исполняют правила политики `allow`/`require-approval`/`deny` (ADR-0009), и второй, параллельный механизм запрета размыл бы fail-closed модель.
