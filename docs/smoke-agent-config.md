# Смок: готовый конфиг агента (ADR-0015, фаза 4 PRD «пул агента»)

Дата: 2026-09-23. Ветка рабочего дерева `feat/agent-pool-core` (фаза 3 в том же дереве не закоммичена).
Сборка `npm run build`. Короткий протокол фазы 4; полный смок пула живым клиентом — фаза 5.

## Стенд

- Установка в скретч-`HOME` (`env -i PATH HOME=<scratch>/home`), ничего от машины разработчика:
  `mcpcut setup --yes --no-admin --ui-port 8097 --serve-port 8098 --serve-public-url https://plane.example:8090`,
  затем `mcpcut admin add owner --role owner` (первый админ без токена).
- Веб: `mcpcut ui --port 8097`, Chromium headless-shell 1234 через `playwright` из npx-кеша
  (рецепт памяти проекта «браузерный смок без гейта MCP»), два прогона — `javaScriptEnabled: true`
  и `false`.

## CLI

| # | Проверка | Ожидание | Итог |
|---|---|---|---|
| 1 | `setup --serve-public-url https://plane.example:8090` | `config.json` содержит `serve.publicUrl: "https://plane.example:8090"` рядом с `allowedHosts: ["plane.example:8090"]` | ✅ |
| 2 | `MCP_ADMIN_TOKEN=… agent create demo` | `agent:`/`token:`/notice, пустая строка, заголовок, блок с `--url https://plane.example:8090` и токеном в `env`, строка `HTTP client instead? mcpcut agent config demo --http`; `[audit]` — на stderr | ✅ |
| 3 | `agent config demo --http` без админ-токена | exit 0, `url: https://plane.example:8090/mcp`, `Authorization: Bearer <token>`, строка «Replace <token> …» | ✅ |
| 4 | `agent config ghost` | exit 1, `agent "ghost" does not exist` | ✅ |

## Браузер (16/16 проверок)

| # | Проверка | JS on | JS off |
|---|---|---|---|
| 1 | страница `create`: `<pre data-client-config="stdio">` несёт **тот же** токен, что `<pre data-token>` | ✅ | ✅ |
| 2 | `--url` в блоке — `serve.publicUrl` | ✅ | ✅ |
| 3 | «HTTP client form» скрыта до клика и раскрывается кликом (`<details>`, без JS) | ✅ | ✅ |
| 4 | блок: `white-space: pre`, `user-select: all` (вычисленный стиль) | ✅ | ✅ |
| 5 | один клик выделяет весь блок (`getSelection()` содержит `"mcpServers"` и токен) | ✅ | — ¹ |
| 6 | `/agents` после создания **не** содержит токена | ✅ | ✅ |
| 7 | drawer «client config» в карточке: `<token>` в `env` | ✅ | ✅ |
| 8 | подвал карточки не переполняется (`scrollWidth ≤ width`) | ✅ | ✅ |

¹ Проверка чтением выделения требует JS на странице; вычисленный `user-select: all` (п. 4) стоит в
обоих прогонах.

Скриншоты осмотрены глазами: страница токена (блок под токеном, HTTP-форма в раскрытом drawer'е),
карточка на 1280 px и на 390 px.

## Находки

- **Раскрытый drawer в карточке снимался пустым** — кадр попадал внутрь анимации `row-in` (180 мс)
  у `.drawer-bd`. Не дефект: снимок после паузы показывает блок; вычисленные `opacity: 1`,
  `visibility: visible`.
- **На 390 px drawer зажимался рядом с кнопкой Revoke** (≈ 180 px на блок). Исправлено в той же
  сессии: `.ag-foot:has(.ag-config-drawer) { flex-wrap: wrap }` и `flex: 1 1 320px` у drawer'а —
  на телефоне Revoke уходит строкой ниже, блок занимает ширину карточки.
- **Скрипт смока**: `page.press('Enter')` на поле токена формы `/login` не уводил со страницы
  входа за отведённое ожидание; нажатие кнопки submit с `waitForURL` — уводит. Дефектом продукта
  не является (curl-вход даёт 303 + cookie), записано для следующего смока.

## Не прогонялось здесь

- pty-смок консоли (`Agents ▸ create` → `token-hold` с блоком на 80×24 и 60×16) — покрыт сквозным
  тестом `tests/tui/console-live-e2e.test.ts` на фейковом терминале и рендер-тестом 40×24; живой pty —
  в смок фазы 5.
- Удалённая консоль — сквозной тест `tests/console-api/remote-console-e2e.test.ts` (адрес в блоке —
  серверный); живьём — фаза 5.
- Docker (`MCPCUT_SERVE_PUBLIC_URL=http://203.0.113.7:8090` → `--allow-http` в блоке) — фаза 5.
