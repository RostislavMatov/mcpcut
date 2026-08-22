# Смок фронта «McpCut» (перенос админки на дизайн от 2026-08-22)

**Статус: ПРОЙДЕН** (прогон 2026-08-22, ветка `feat/ui-mcpcut-redesign`, сборка из рабочего дерева после волн 0–3).
План и решения — `.claude/plans/ui-mcpcut-redesign.plan.md`. Скриншоты — `docs/design/mcpcut/`.

**Чем прогоняли:** Chromium (Playwright 1.62, бинарник `chromium-1228`, headless), два прохода — с JS и **с выключенным JS**; живой стенд на подменённом `HOME` (реальный `~/.mcp-journal` не тронут), посев данных только через публичный CLI и фейкового stdio-клиента поверх `connect` (как в смоке M4): 4 сервера (2 stdio / 2 http, env/headers с `vault:`-ссылками), 3 агента (один отозван), 3 админа, каталог `m4-server.mjs` в карантине → выпуск → вызов `read_note` (allow) → вызов `write_note` (висящая заявка, таймаут 900 с) → перерегистрация сервера со схемой v2 → рекарантин `write_note` (`changed`, `surfaceDelta: widened`) + решение `quarantined`.

## Стенд

```
export SMOKE=/tmp/smoke-mcpcut && mkdir -p "$SMOKE"
npm run build
HOME=$SMOKE node dist/cli.js ui --port 8093          # owner-токен печатается на stderr один раз
# посев — см. seed-скрипт в отчёте сессии (CLI: vault init/set, server add ×4, agent create/grant/revoke,
# admin add ×2, connect-сессии с tools/list, tools/call, quarantine approve, server remove/add v2)
```

## Что проверялось и факт

| # | Проверка | Ожидание | Факт |
|---|---|---|---|
| 1 | `GET /` без сессии | 303 → `/login` | ✅ |
| 2 | `/login`: шрифт | `document.fonts.check('16px Silkscreen') === true`, `.brand` рендерится Silkscreen; в Network только same-origin `/assets/silkscreen-400.woff2` | ✅ загружен с same-origin, внешних запросов нет |
| 3 | `/login`: нет `data-events-url`, нет табов/sign-out; консоль пуста | — | ✅ |
| 4 | Вход form-POST из Chromium (класс регрессии M4 `Origin: null`) | 303 → `/`, дашборд | ✅ |
| 5 | Дашборд: 4 тайла (held/quarantined/servers/agents), очередь одобрений с живой заявкой (`m4/write_note`, аргументы с `[REDACTED]`), последние решения, полоса серверов с пометкой `quarantined` | — | ✅ `[REDACTED]` на месте, в журнале решений `REQUIRE-APPROVAL-PENDING`, `QUARANTINED`, `ALLOW` |
| 6 | Табы по роли owner | Dashboard · Journal · Quarantine · Servers · Agents · Vault · Admins | ✅ |
| 7 | `/journal`: список сессий, открытие сессии, раскрытие записи (`<details>`) — payload виден | — | ✅ (первый скриншот «пустого» тела оказался снимком посреди 320-мс анимации `row-in`; с паузой 450 мс — содержимое на месте) |
| 8 | `/quarantine`: карточка `m4/write_note` · `changed` · `surfaceDelta: widened` · дифф `properties.force — property-added`, approve/reject | — | ✅ |
| 9 | `/servers`: карточки, поиск в шапке (клиентский фильтр), `+` у активного таба открывает drawer регистрации; раскрытые карточки: command/args (по одному на строку), env/headers (`vault:`-бейдж vs literal), список тулзов из инвентаря с пометкой карантина и ссылкой «review in quarantine» | — | ✅ |
| 10 | Отклонённая регистрация (секрет-литерал в env) | 400, drawer остаётся открыт, `[role=alert]` с подсказкой про вольт, секрет не возвращается в HTML | ✅ «env.TOKEN: value … looks like a secret literal; secrets must not live …» |
| 11 | `/agents`: матрица прав, `revoked`, drawers create/grant, `+` | — | ✅ |
| 12 | `/admins`: ростер, роли-пилюли, inline-формы role/rotate/remove в ряд, drawer add | — | ✅ |
| 13 | `/vault` (owner): имена и даты, без значений | — | ✅ |
| 14 | Sign out | 303 → `/login` | ✅ |
| 15 | **Без JS**: вход формой, `/servers`, открытие drawer кликом по `<summary>` | страница работоспособна | ✅ |
| 16 | CSP: `securitypolicyviolation` на всех страницах | 0 | ✅ 0 (inline-стилей нет; `font-src 'self'` добавлен) |
| 17 | Консоль/сеть | только ожидаемый 400 из п.10 | ✅ |

## Находки (закрыты в ходе смока)

1. Поиск в шапке рендерился столбиком (`form { flex-direction: column }` перекрывал `.search`) — `flex-direction: row` на `.search`.
2. Inline-формы `/admins` (`form.inline`) по той же причине ставили кнопку под селект — `flex-direction: row` на `form.inline`.
3. `code` с `word-break: break-all` рвал `mcp-journal admin add` посреди слова на `/login` — `overflow-wrap: anywhere`.
4. Пилюли-радио `.choice` наследовали `flex-direction: column` от `label` — поправлено в `forms.ts` (находка агента волны 3).

## Не покрыто

- Firefox/WebKit-плечо (как и в предыдущих смоках); режим `--behind-tls`.
- Живое SSE-обновление очереди в браузере глазами (контракт `data-live-region` не менялся и покрыт `tests/ui/page-contracts.test.ts`); заметка: счётчики «N held» в шапках панелей Dashboard/Quarantine лежат вне live-региона и обновляются только перезагрузкой.
- Экран `Groups` дизайна — не переносился: сущности «группа» нет в бэкенде (M5.5, пункт 2, открытые вопросы владельца PRD).
