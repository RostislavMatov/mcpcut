# Ручной смок M3 — acceptance-прогон из реального клиента

Последний открытый пункт acceptance M3 (план `.claude/plans/registry-agents-vault-http.plan.md`).
Подготовка выполнена 2026-08-10: реестр (`github` → npx server-github, ключ `vault:github-pat`),
агент `smoke-agent` с грантом `search_*,get_*,list_*`, сниппет `github-cp` в локальном
`.mcp.json` (файл гитом не трекается — токен внутри). Автоматизированный аналог уже зелёный
(`tests/e2e/m3-integration.test.ts` + прогон через `connect` с живым GitHub 2026-08-06).

## Шаги (сессия Claude Code, запущенная в этом проекте)

| # | Действие | Ожидание | Факт |
|---|---|---|---|
| 1 | Список MCP-серверов сессии | `github-cp` подключён (плюс `playwright`, `memory` из dogfood M2) | ☐ |
| 2 | Перечислить тулзы `github-cp` | Ровно 14 read-тулзов (`search_*`, `get_*`, `list_*`); НЕТ `create_issue`, `push_files`, `fork_repository`, `create_*` | ☐ |
| 3 | Вызвать `search_repositories` (любой запрос) | Реальный ответ GitHub — ключ дошёл из вольта; в конфиге агента ключа нет | ☐ |
| 4 | Попросить агента вызвать невыданный тулз (например `create_issue`) | Клиент его даже не видит (нет в списке); принудительный вызов → deny с правилом `agent: no grant …` | ☐ |
| 5 | `node dist/cli.js sessions` + `show <id> --kind decision` | Сессия в журнале; decision-записи с `serverName=github` (не `auto:`); обе версии `tools/list` (`toolsList.original` / `toolsList.filtered`) | ☐ |
| 6 | В отдельном терминале: `node dist/cli.js agent revoke smoke-agent` при живой сессии | Сессия рвётся ≤ ~5 с; в журнале финальная запись `agent-revoked`; тулзы `github-cp` перестают отвечать | ☐ |
| 7 | Перезапуск сессии после revoke | `github-cp` не поднимается (authentication failed в stderr прокси) | ☐ |

## После прохождения

1. Отметить чекбоксы здесь и строку acceptance «ручной смок» в плане M3.
2. PRD: M3 `implemented` → `complete`; ROADMAP: 🟡 → ✅; CLAUDE.md — статус.
3. Гигиена: токен уже отозван шагом 6 (это и есть страховка от засветки токена);
   удалить блок `github-cp` из `.mcp.json` или создать нового агента для постоянного dogfood M3.
4. Обновить память проекта (m3-status-and-remaining).

## Если что-то падает

- `github-cp` не поднялся вовсе → `node dist/cli.js connect github --agent smoke-agent` руками с
  `MCP_AGENT_TOKEN` из `.mcp.json`, смотреть stderr; журнал сессии покажет, дошёл ли initialize.
- Пустые сессии по 1 записи уже встречались 2026-08-06 — это был перезапуск клиента во время
  пересборки `dist/`; сначала `npm run build`.
