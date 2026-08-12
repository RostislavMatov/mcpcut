# Ручной смок M4 — acceptance-прогон admin UI из реального клиента

**Пройден 2026-08-12.** Последний открытый пункт acceptance M4 (план
`.claude/plans/admin-ui-approvals.plan.md`) закрыт: gate-метрика показана вживую — человек
одобрил и отклонил write-вызовы из браузера, агент получил ответ в окне ожидания. Живой агент —
сессия Claude Code с Playwright/MCP, обёрнутым собственным dogfood-контуром (`wrap`);
HTTP-вход — curl против `serve`. Автоматизированный аналог зелёный
(`tests/e2e/m4-integration.test.ts`, 10 сценариев).

Стенд: политика `write: require-approval` (для `wrap` — проектный `./.mcp-journal/policy.json`
самого dogfood), агент `smoke-m4` (грант `github: search_*` + фикстура), админы `alice` (owner),
`bob` (operator), `carol` (viewer); `ui --port 8091`, `serve --port 8765`.

## Часть 1 — gate-критерий (живой клиент, браузер человека)

| # | Действие | Факт |
|---|---|---|
| 1 | Вход `alice` | ☑ 303 → консоль, `alice · owner` в шапке — **после фикса `a094e47`** (см. находку 1: до фикса вход из Chromium был невозможен) |
| 2 | Gated-вызов → карточка в UI без перезагрузки | ☑ карточка `playwright / browser_navigate` с классом, аргументами и таймером ожидания; одобрена на 25-й секунде 60-секундного окна |
| 3 | Approve из UI до истечения ожидания | ☑ вызов прошёл сразу; resolved-файл: `actor: "ui:alice"`; поля M4 `waitExpiresAt`/`decisionRule` на месте |
| 4 | Deny из UI | ☑ агент получил ошибку «denied by a human operator» в окне ожидания; журнал: `require-approval-pending` → `denied-by-operator`, один approvalId, latency 6.9 с |
| 5 | Повторный резолв того же id | ☑ CLI: «No pending approval with that id (already resolved or unknown id)», exit 1, не 500 (гонка UI×CLI дополнительно закреплена e2e-сценарием 5) |
| 6 | UI без запущенного `serve` | ☑ вся часть 1 шла при незапущенном `serve` |

## Часть 2 — gate через `serve` (curl)

| # | Действие | Факт |
|---|---|---|
| 7 | `tools/call search_repositories` под Bearer-токеном агента | ☑ POST провисел 3.2 с, `bob` одобрил из UI посреди ожидания (`actor: "ui:bob"`), вернулся реальный ответ GitHub — ключ дошёл из вольта |

## Часть 3 — роли и админ-поверхность

| # | Действие | Факт |
|---|---|---|
| 8 | `carol` (viewer): POST approve; `/admins` | ☑ 403 на оба; в её HTML **ноль** POST-форм — viewer не видит кнопок действий |
| 9 | `bob` (operator): `/admins` | ☑ 403 (страница owner-only) |
| 10 | Атрибуция оператора | ☑ approve от `bob` через UI-API несёт `actor: "ui:bob"`. Выпуск агента из UI вручную не прогонялся (создан через CLI); сценарий закрыт e2e №10 |
| 11 | `admin rotate bob` при живой сессии | ☑ его cookie → 403 немедленно; сессия `carol` не тронута (200) |
| 12 | Удаление последнего owner | ☑ «cannot remove or demote the last owner…», exit 1 |

## Часть 4 — карантин и журнал

| # | Действие | Факт |
|---|---|---|
| 13 | Схема v1→v2 (optional `force`) → рекарантин + дифф в UI | ☑ фикстура `m4-server.mjs`; страница `/quarantine` рендерит `property-added properties.force`, `surfaceDelta: widened` |
| 14 | `quarantine show smoke-fixture write_note` | ☑ тот же дифф в CLI: `state: changed`, `surfaceDelta: widened`, `property-added properties.force` |
| 15 | Журнал: список сессий, страница сессии, фильтры | ☑ 200; ссылки `?session=<id>`; неизвестный путь `/journal/<id>` честно 403 (deny-by-default) |
| 16 | Секреты в разметке | ☑ грep по всем страницам: ни `mcpa_`, ни `mcpj_`; вольт в UI — только имя `vault:github-pat` |

## Находки смока

1. **HIGH (исправлено в ходе смока, `a094e47`)**: `Referrer-Policy: no-referrer` заставлял Chromium сериализовать `Origin` form-POST как `null`, который наш же Origin-скрининг отвергает → вход в UI из любого Chromium был невозможен. node:http/curl-тесты связку referrer-policy→Origin не эмулируют. Фикс: `same-origin`; закреплено комментарием в hardening-тесте. **Урок: браузерный смок обязателен для каждой браузерной поверхности.**
2. **LOW-B из финального ревью подтверждён вживую**: кап 8 сессий/админа без idle-timeout запер `alice` (429) после серии curl-логинов без logout; понадобился перезапуск UI. Приоритет пары «rate-limit за прокси + owner-резерв» в бэклоге M5 поднят.
3. Косметика (бэклог): страница логина открывает SSE `/events` без сессии (403 в консоли); `favicon.ico` без маршрута (403); неаутентифицированный `GET /` — голый 403 без редиректа на `/login`.
4. Косметика: `policy show` печатает удвоенный сегмент в списке путей поиска (`…/.mcp-journal/.mcp-journal/policy.json`).
5. Операционное: dogfood-вотчер M2 (`approvals-watch.mjs`) конкурирует с UI за резолюции (`actor: cli` побеждает за секунды). Для операторов с обоими каналами — задокументировать, что первый резолв побеждает штатно.

## Гигиена после прогона

- `smoke-m4` отозван; `smoke-fixture` удалён из реестра; `bob`/`carol` удалены; политика `~/.mcp-journal/policy.json` удалена (восстановлен пре-смок journaling-only); вотчер перезапущен.
- `alice` оставлена как owner; её токен светился в транскрипте сессии — **ротировать** (`admin rotate alice`).
- Latency approve: одобрение в окне ожидания срабатывает за ~1–7 с от клика до прохождения вызова (шаги 3, 7).
