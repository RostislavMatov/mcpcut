# Ручной смок M3 — acceptance-прогон из реального клиента

**Пройден 2026-08-10.** Последний открытый пункт acceptance M3 (план
`.claude/plans/registry-agents-vault-http.plan.md`) закрыт: `connect` — из живой сессии Claude Code,
`serve` — реальным HTTP-клиентом (curl). Автоматизированный аналог зелёный
(`tests/e2e/m3-integration.test.ts`).

Стенд: реестр (`github` → npx server-github, ключ `vault:github-pat`), агент `smoke-agent`
с грантом `search_*,get_*,list_*`, сниппет `github-cp` в локальном `.mcp.json` (гитом не трекается).

## Часть 1 — `connect` (stdio, живой клиент)

| # | Действие | Ожидание | Факт |
|---|---|---|---|
| 1 | Список MCP-серверов сессии | `github-cp` подключён (плюс `playwright`, `memory` из dogfood M2) | ☑ |
| 2 | Перечислить тулзы `github-cp` | Ровно 14 read-тулзов (`search_*`, `get_*`, `list_*`); НЕТ `create_issue`, `push_files`, `fork_repository`, `create_*` | ☑ 14 из 26 |
| 3 | Вызвать `search_repositories` (любой запрос) | Реальный ответ GitHub — ключ дошёл из вольта; в конфиге агента ключа нет | ☑ |
| 4 | Попросить агента вызвать невыданный тулз (например `create_issue`) | Клиент его даже не видит (нет в списке); принудительный вызов → deny с правилом `agent: no grant …` | ☑ deny `-32001`, правило `agent: no grant for github/create_issue` |
| 5 | `node dist/cli.js sessions` + `show <id> --kind decision` | Сессия в журнале; decision-записи с `serverName=github` (не `auto:`); обе версии `tools/list` (`toolsList.original` / `toolsList.filtered`) | ☑ 26 → 14 тулзов |
| 6 | В отдельном терминале: `node dist/cli.js agent revoke smoke-agent` при живой сессии | Сессия рвётся ≤ ~5 с; в журнале финальная запись `agent-revoked`; тулзы `github-cp` перестают отвечать | ☑ `agent-revoked` через 1.8 с; клиент разом потерял все 14 тулзов |
| 7 | Перезапуск сессии после revoke | `github-cp` не поднимается (authentication failed в stderr прокси) | ☑ `connect` тем же токеном → `authentication failed`, exit 1 |

## Часть 2 — `serve` (HTTP-вход, curl)

Отдельный агент `serve-smoke` с грантом `search_*`, `serve --port 8765`,
роут `/agents/:agent/servers/:server`.

| # | Действие | Факт |
|---|---|---|
| 8 | `initialize` с `Authorization: Bearer` | ☑ 200, выдан `mcp-session-id` (sessionful-модель) |
| 9 | `tools/list` | ☑ ровно 4 тулза (`search_repositories`, `search_code`, `search_issues`, `search_users`) — грант уже `search_*` |
| 10 | `tools/call search_repositories` | ☑ реальный ответ GitHub |
| 11 | `tools/call list_commits` (не выдан) | ☑ deny, правило `agent: no grant for github/list_commits` |
| 12 | Запрос без токена | ☑ 401 |
| 13 | Чужой путь `/agents/smoke-agent/...` под токеном `serve-smoke` | ☑ 404 (имена не раскрываются) |
| 14 | Stateless-ревизия (`MCP-Protocol-Version: 2026-07-28`, без session-id) | ☑ `{"error":"protocol-mismatch"}` — ожидаемо: `github` в реестре stdio, а stdio-upstream sessionful; ADR-0002 translate-none. Заголовки `Mcp-Method`/`Mcp-Name` проверяются до отказа |

**Не покрыто вручную:** полный stateless-путь downstream↔upstream — для него нужен stateless HTTP
upstream в реестре; остаётся под e2e-тестами.

## Побочные наблюдения (не блокеры)

1. **`toolClass: write` у `search_*`.** Классификатор ставит `read` только при
   `annotations.readOnlyHint === true`; github-mcp-server 0.6.2 аннотаций не отдаёт → безопасный
   дефолт `write` (`src/policy/classify-tool.ts`). Работе гранта не мешает, но под политикой с
   `classDefaults.read: allow` такой сервер требует `classOverrides` — стоит написать в README.
2. **Разные источники политики у входов.** `connect` читает политику только из
   `~/.mcp-journal/policy.json` (и печатает предупреждение, что игнорирует проектный файл), а
   `serve` подхватил `./.mcp-journal/policy.json`. Поведение задокументировано в предупреждении, но
   несимметрично — кандидат в бэклог M4.
3. **Живой human-in-the-loop.** На шаге 10 сработал карантин M2 (`require-approval-pending` →
   `approved`, latency 6.3 с): вотчер `tools/approvals-watch.mjs` показал macOS-диалог, человек
   нажал «Одобрить». M2-петля одобрений проверена через HTTP-вход M3 незапланированно.

## Гигиена после прогона

- Оба агента отозваны (`smoke-agent`, `serve-smoke`) — токены из этого прогона мертвы.
- Блок `github-cp` удалён из `.mcp.json`. Для постоянного dogfood M3 нужен новый агент
  (`agent create` → `grant` → сниппет с токеном; `.mcp.json` гитом не трекается).
