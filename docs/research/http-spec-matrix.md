# Streamable HTTP: матрица требований спеки × версия × поддержка в M3

Сверка с первоисточником, выполнена 2026-08-05 (Task 1 Волны 0 плана M3).
Первоисточники: modelcontextprotocol.io/specification/{2025-06-18,2025-11-25,2026-07-28},
страницы transports / streamable-http / versioning / changelog / patterns/mrtr.
Сводка `docs/research/2026-08-04-findings.md` §3 — вторичный источник, расхождения с ней — в §5.

## 0. Статус ревизий [подтверждено первоисточником]

| Ревизия | Статус на 2026-08-05 | Модель |
|---|---|---|
| 2025-03-26 | Final | sessionful (первая Streamable HTTP) |
| 2025-06-18 | Final | sessionful + `MCP-Protocol-Version` header |
| 2025-11-25 | Final (последняя handshake-ревизия) | sessionful + SSE-polling/`retry` |
| **2026-07-28** | **Current** — финализирована 28.07.2026, НЕ RC | stateless (без initialize, без сессий, без GET) |

**Критично**: страница versioning прямо говорит «The current protocol version is 2026-07-28».
Предпосылка плана «RC не финален, финал + 10 недель валидации» устарела — финал уже состоялся.
Практическая картина не меняется: реальные серверы и клиенты сегодня говорят на 2025-03-26…2025-11-25,
поэтому «старая» модель остаётся обязательной. Наша sessionful-цель — механика 2025-06-18
с дельтами 2025-11-25 (совместимое надмножество).

Легенда «Кто»: **П-срв** — плоскость как HTTP-сервер (downstream, `serve`);
**П-кли** — плоскость как HTTP-клиент (upstream, `client.ts`);
**сквозн** — семантика агента/сервера, плоскость форвардит байт-в-байт.

## 1. Sessionful (2025-06-18; Δ = добавлено в 2025-11-25) [подтверждено первоисточником]

### 1.1 Security

| Требование | Уровень | M3 | Кто |
|---|---|---|---|
| Валидировать `Origin` на всех входящих соединениях (защита от DNS rebinding) | MUST | **да** (см. §4.2) | П-срв |
| Δ `Origin` присутствует и невалиден → 403 Forbidden | MUST | да | П-срв |
| Локально биндиться только на 127.0.0.1 | SHOULD | да (дефолт; `--host` + предупреждение) | П-срв |
| Аутентификация всех соединений | SHOULD | да (Bearer-токен агента) | П-срв |

### 1.2 POST (клиент → сервер)

| Требование | Уровень | M3 | Кто |
|---|---|---|---|
| Каждое JSON-RPC сообщение — отдельный POST на единый MCP endpoint | MUST | да | П-кли |
| `Accept: application/json, text/event-stream` в POST | MUST | да | П-кли |
| Тело POST — ровно одно JSON-RPC request/notification/response | MUST | да | П-кли |
| response/notification принят → 202 без тела; не принят → HTTP-ошибка (тело MAY JSON-RPC error без id) | MUST | да | П-срв |
| request → ответ `application/json` (один объект) ИЛИ `text/event-stream`; клиент обязан уметь оба | MUST | да (оба режима с обеих сторон) | П-срв, П-кли |
| SSE-стрим: в итоге содержит response на request из POST | SHOULD | да | П-срв |
| SSE-стрим: серверные requests/notifications до response, связанные с исходным request | MAY | да (форвард от upstream) | П-срв |
| Не закрывать SSE до отправки response (кроме истечения сессии); после response — закрыть | SHOULD NOT / SHOULD | да | П-срв |
| Обрыв соединения ≠ отмена запроса; отмена — явная `CancelledNotification` | SHOULD NOT / SHOULD | да (обрыв не интерпретируем) | П-срв, сквозн |
| Δ Праймящее SSE-событие (id + пустой data) сразу после открытия стрима | SHOULD | нет — сцеплено с resumability (§4.1), бэклог | П-срв |
| Δ Сервер закрывает *соединение* не закрывая *стрим* (`retry` + polling) | MAY | нет (не закрываем преждевременно — допустимо) | П-срв |
| Δ Клиент обязан уважать `retry`-поле перед переподключением | MUST | да | П-кли |

### 1.3 GET (SSE-канал server-initiated)

| Требование | Уровень | M3 | Кто |
|---|---|---|---|
| Клиент может открыть GET-SSE для сообщений сервера вне POST | MAY | да (нужен для sampling/elicitation от upstream) | П-кли |
| `Accept: text/event-stream` в GET | MUST | да | П-кли |
| Сервер: SSE или 405 | MUST | да (SSE в sessionful-режиме; 405 в stateless) | П-срв |
| На GET-стриме серверные requests/notifications, не связанные с текущими запросами | MAY / SHOULD | да | П-срв |
| Не слать response на GET-стриме (кроме resume) | MUST NOT | да | П-срв |
| Не дублировать сообщение в несколько стримов | MUST NOT | да | П-срв |

### 1.4 Resumability / Redelivery — решение: НЕ в M3 (§4.1)

| Требование | Уровень | M3 | Кто |
|---|---|---|---|
| SSE event `id`; если есть — глобально уникален в сессии, Δ кодирует стрим | MAY (id) / MUST (уникальность) | нет: id не аттачим (MAY ⇒ соответствуем) | П-срв |
| Клиент резюмирует через GET + `Last-Event-ID`; Δ независимо от того, чем открыт исходный стрим | SHOULD | нет: переоткрываем GET без `Last-Event-ID`, обрыв фиксируем в журнале | П-кли |
| Не реплеить сообщения чужого стрима | MUST NOT | n/a (реплея нет) | — |

### 1.5 Session management (`Mcp-Session-Id`; в тексте 2025-11-25 пишется `MCP-Session-Id` — HTTP-заголовки регистронезависимы)

| Требование | Уровень | M3 | Кто |
|---|---|---|---|
| Сервер выдаёт session id при initialize — заголовком на ответе с `InitializeResult` | MAY | да (мы выдаём всегда в sessionful-режиме) | П-срв |
| Session id глобально уникален и криптостоек | SHOULD | да — `crypto.randomUUID()`, **не** голый ULID (уточнение плана: ULID не гарантирует crypto-RNG) | П-срв |
| Session id — только видимый ASCII 0x21–0x7E | MUST | да | П-срв |
| Клиент включает выданный session id во все последующие запросы | MUST | да (захват из initialize-ответа) | П-кли |
| Запрос без session id (кроме initialize) → 400 | SHOULD | да | П-срв |
| Сервер может завершить сессию в любой момент; после — 404 на её id | MAY / MUST | да (TTL бездействия, лимит сессий, revoke) | П-срв |
| Клиент на 404 обязан начать новую сессию новым `InitializeRequest` | MUST | да: типизированная ошибка «session expired» + авто-reinit с лимитом попыток | П-кли |
| Клиент шлёт DELETE с session id при завершении | SHOULD | да | П-кли |
| Сервер может отвечать 405 на DELETE | MAY | нет — DELETE поддерживаем (завершение сессии) | П-срв |

### 1.6 `MCP-Protocol-Version` header

| Требование | Уровень | M3 | Кто |
|---|---|---|---|
| Клиент включает заголовок во все запросы после initialize; значение — согласованное на initialize | MUST / SHOULD | да | П-кли |
| Заголовка нет и версию не определить иначе → считать 2025-03-26 | SHOULD | да | П-срв |
| Невалидная/неподдерживаемая версия → 400 | MUST | да (поддерживаемые версии — константа в `protocol/mcp.ts`) | П-срв |

### 1.7 Вне scope M3

Обратная совместимость с HTTP+SSE (2024-11-05, `endpoint`-событие) — транспорт deprecated
с 2025-03-26, реализовывать не будем; сервер такого типа в реестре — ошибка подключения с внятным текстом.

## 2. Stateless (2026-07-28, current) [подтверждено первоисточником]

Убрано относительно 1.x: initialize/initialized, `Mcp-Session-Id`, GET-endpoint, DELETE,
SSE event id / `Last-Event-ID` / resumability, `ping`, `logging/setLevel`,
`notifications/roots/list_changed`. Deprecated: roots, sampling, logging, HTTP+SSE.

### 2.1 Endpoint и security

| Требование | Уровень | M3 | Кто |
|---|---|---|---|
| Единый MCP endpoint, только POST | MUST | да | П-срв |
| GET/DELETE от старых клиентов → 405 | SHOULD | да | П-срв |
| `Mcp-Session-Id` от старого клиента → игнорировать, не минтить и не эхоить | SHOULD | да | П-срв |
| `Last-Event-ID` → игнорировать | SHOULD | да | П-срв |
| `Origin`: MUST валидировать; присутствует и невалиден → 403 (тело MAY JSON-RPC error без id) | MUST | да (§4.2) | П-срв |
| localhost-bind / аутентификация | SHOULD | да (как в 1.1) | П-срв |

### 2.2 Сообщения

| Требование | Уровень | M3 | Кто |
|---|---|---|---|
| Каждый request/notification — отдельный POST; `Accept` оба типа | MUST | да | П-кли |
| Клиент НЕ шлёт JSON-RPC responses | MUST NOT | да (в stateless-режиме response-тело от агента → 400) | П-кли, П-срв |
| notification → 202 / HTTP-ошибка | MUST | да | П-срв |
| request → JSON-объект или SSE-стрим, скоуп — этот запрос | MUST | да | П-срв, П-кли |
| На response-стриме только notifications, связанные с запросом; независимые серверные requests запрещены | MUST / MUST NOT | да | П-срв |
| Финальный response завершает стрим | SHOULD | да | П-срв |
| `X-Accel-Buffering: no` на SSE-ответах | SHOULD | да (дёшево, критично за reverse-proxy) | П-срв |
| SSE keep-alive комментарии (`:`) на долгих стримах | рекомендация | да | П-срв |
| Закрытие клиентом SSE-стрима = отмена запроса; сервер прекращает работу, больше ничего не шлёт | MUST / SHOULD / MUST NOT | да (разрыв downstream → закрытие соответствующего запроса к upstream) | П-срв |
| Обрыв стрима: запрос потерян, клиент переиздаёт с НОВЫМ id (redelivery нет) | MUST | сквозн (ретраит агент); плоскость обрыв не маскирует | сквозн |

### 2.3 Обязательные заголовки и header↔body валидация (SEP-2243) — НЕ БЫЛО в сводке research

| Требование | Уровень | M3 | Кто |
|---|---|---|---|
| `MCP-Protocol-Version` на каждом POST; значение = `_meta["io.modelcontextprotocol/protocolVersion"]` тела | MUST | да (плоскость-клиент зеркалит из тела ⇒ совпадение по построению) | П-кли |
| `Mcp-Method` (= `method`) на всех запросах; `Mcp-Name` (= `params.name`/`params.uri`) на tools/call, resources/read, prompts/get | REQUIRED | да (зеркало из тела; Base64-сентинел `=?base64?…?=` для не-ASCII) | П-кли |
| Сервер, обрабатывающий тело, валидирует header↔body; мисматч/отсутствие → 400 + `-32020 HeaderMismatch` | MUST | да — плоскость читает тела (журнал/политика), значит обязана | П-срв |
| Неподдерживаемая версия → 400 + `UnsupportedProtocolVersionError` (`-32022`) | MUST | частично: транспортируемые версии — константа; семантическую совместимость решает upstream (negotiation сквозная, план §4) | П-срв, сквозн |
| Неизвестный метод → 404 + `-32601` | MUST | да (session-слой мапит код ошибки upstream-ответа на HTTP-статус) | П-срв |
| `x-mcp-header` → `Mcp-Param-{name}`: клиент обязан зеркалить и отвергать невалидные tool-определения из `tools/list` | MUST (клиент) | **нет — бэклог**. Требует кэша inputSchema всех тулзов на клиенте плоскости. Ограничение честно документируем: тулз с `x-mcp-header` через плоскость к stateless-серверу получит `HeaderMismatch` от сервера | П-кли |
| Незнакомый `Mcp-Param-*` у intermediary → форвардить не трогая | MUST | да | П-срв |

### 2.4 Stateless-семантика — сквозная (плоскость форвардит, не синтезирует)

| Требование | Уровень | M3 | Кто |
|---|---|---|---|
| `_meta`: `protocolVersion` (обязателен), `clientInfo`/`clientCapabilities` (SHOULD) в каждом запросе | MUST / SHOULD | сквозн — формирует агент | сквозн |
| `server/discover`: сервер обязан реализовать | MUST | сквозн — отвечает upstream; плоскость НЕ синтезирует (мост stateless-агент ↔ sessionful/старый сервер = отказ по ADR-0002) | сквозн |
| MRTR (SEP-2322): серверные requests только через `InputRequiredResult`; см. §3 | MUST | сквозн (транспортно — обычные POST/ответы) | сквозн |
| `resultType` обязателен во всех результатах; отсутствие = `"complete"` | MUST | сквозн | сквозн |
| `subscriptions/listen` — долгоживущий response-стрим для change-notifications (замена GET) | — | да транспортно (обычный POST с долгим SSE-ответом), семантика сквозная | П-срв/сквозн |
| `ttlMs`/`cacheScope` на list-результатах; детерминированный порядок tools/list | MUST / SHOULD | сквозн (плоскость pass-through; наш tools/list-фильтр порядок сохраняет) | сквозн |

## 3. SEP-2322 / MRTR — фактическая форма [подтверждено первоисточником: страница basic/patterns/mrtr]

- `InputRequiredResult` = `Result` c `resultType: "input_required"`; поля `inputRequests?` и `requestState?`;
  **минимум одно из двух обязано присутствовать** (MUST).
- `inputRequests`: map «серверный строковый ключ → request-объект» (`elicitation/create`,
  `sampling/createMessage`, `roots/list`); ключи уникальны в рамках запроса (MUST); сервер не шлёт
  requests, не заявленные в capabilities клиента (MUST NOT).
- `requestState`: непрозрачная строка сервера; клиент MUST NOT инспектировать/менять; при ретрае MUST
  эхоить точное значение (и MUST NOT добавлять, если его не было). Сервер MUST трактовать как
  attacker-controlled: целостность (HMAC/AEAD) MUST, если влияет на авторизацию/логику; SHOULD —
  principal + TTL + привязка к исходному запросу внутри защищённого блоба.
- Ретрай — независимый запрос с **новым** JSON-RPC id (MUST) и `inputResponses` (map с теми же ключами).
- `InputRequiredResult` допустим только на `tools/call`, `resources/read`, `prompts/get` (MUST NOT на прочих).
- Недостающие ответы → сервер SHOULD повторить `InputRequiredResult`, а не ошибку.
- Для плоскости: политика видит ретрай как новый `tools/call` того же тулза (решение M2-цепочки
  применяется заново — это корректно); `requestState`/`inputResponses` могут содержать чувствительные
  данные ⇒ кейсы для редакции и leak-regression (Волна 3).

## 4. Решения M3

### 4.1 SSE-resumability (`Last-Event-ID`) — НЕТ, бэклог
Основание: в sessionful-ревизиях это MAY (event id, сервер) / SHOULD (resume, клиент) — не MUST;
в 2026-07-28 удалена целиком («Resumable SSE streams via Last-Event-ID are not supported»).
Сценарий M3 — localhost/LAN, короткие стримы. Поведение при обрыве: П-кли переоткрывает GET-стрим
без `Last-Event-ID` (sessionful) или отдаёт типизированную ошибку запроса (stateless-путь — ретраит агент);
факт обрыва — в журнал. Недоставленные server-initiated сообщения признаются потерянными.
Отступление от SHOULD зафиксировано здесь и в ADR-0002.

### 4.2 Origin-валидация — ВСЕГДА при наличии заголовка (строже рекомендации плана)
Спека: MUST в обеих моделях, а DNS rebinding целит именно localhost — проверка «только при
не-localhost bind» не закрывает атаку. Политика M3: заголовка нет → пропустить (не-браузерные клиенты,
типичные агенты, Origin не шлют); есть и матчит allowlist → ок; иначе → 403 (+ JSON-RPC error без id).
Дефолтный allowlist: `http(s)://localhost[:port]`, `127.0.0.1`, `[::1]`. Флаг `--allowed-origin <origin>`
(повторяемый) для остального. Реализация — в `transport/http/server.ts` до маршрутизации.

### 4.3 Прочее
- Session id downstream: `crypto.randomUUID()` (SHOULD cryptographically secure; правка плана, где ULID).
- `X-Accel-Buffering: no` + keep-alive комментарии на SSE — делаем (SHOULD/рекомендация, дёшево).
- `Mcp-Param-*` (x-mcp-header) — бэклог с документированным ограничением (§2.3).
- HTTP-статус ответа при бридже (404/-32601, 400/-32020, 400/-32022) выбирается по коду ошибки
  JSON-RPC-ответа в тонком session-слое; тело остаётся байт-идентичным.
- HTTP+SSE 2024-11-05 — не поддерживаем (deprecated).

## 5. Расхождения первоисточника со сводкой research 2026-08-04 (§3) и планом

1. **Статус ревизии**: сводка — «RC … финал 28.07.2026 + 10 недель валидации»; факт — 2026-07-28
   финализирована 28.07.2026 и объявлена **current**. Формулировка ADR-0002 скорректирована:
   контрольная точка ~октябрь 2026 остаётся, но как «оценка реальной адопции stateless», а не «финал RC».
2. Сводка «убирает initialize и Mcp-Session-Id» верна, но неполна: убраны также GET-endpoint, DELETE,
   SSE-resumability, `ping`, `logging/setLevel`, `notifications/roots/list_changed`; deprecated roots /
   sampling / logging. `subscriptions/listen` — замена GET-стрима (в сводке отсутствует).
3. В сводке нет обязательных заголовков `Mcp-Method`/`Mcp-Name` и MUST-валидации header↔body
   (`-32020 HeaderMismatch`) — напрямую касается плоскости (мы обрабатываем тела) и intermediary-роли.
4. В сводке нет `server/discover` (MUST для серверов) и обязательного `resultType`.
5. Механика корреляции «HTTP — заголовок MCP-Session-Id» из сводки применима только к ревизиям
   ≤ 2025-11-25; в current-ревизии корреляция — HTTP request/response + `Mcp-Method`/`Mcp-Name`.
6. План: session id — ULID; спека SHOULD «cryptographically secure» → randomUUID (§4.3).
7. Написание заголовка: 2025-06-18 — `Mcp-Session-Id`, 2025-11-25 — `MCP-Session-Id`;
   регистронезависимо, сравнение в коде — только case-insensitive.
8. 2025-11-25 добавила SSE-polling (праймящее событие, `retry`-поле — клиент MUST уважать) —
   в сводке отсутствует; у нас: уважаем `retry` (П-кли), не используем как сервер.

## 6. Что не удалось подтвердить / не проверялось

- Текст SEP-2322 как отдельного документа (`/seps/2322-MRTR`, PR #2322) отдельно не открывался —
  содержимое MRTR подтверждено самой спекой (страница patterns/mrtr и changelog); статус пометки:
  спека [подтверждено первоисточником], полный текст SEP [вторичный источник].
- Заявление сводки «финал + 10 недель валидации» в первоисточнике не найдено ни в каком виде —
  вероятно, из RC-блога; на итог не влияет (ревизия уже current) — [не найдено].
- JSON-схема (`schema.ts` 2026-07-28) с полями `InputRequiredResult` напрямую не читалась;
  поля подтверждены нормативной страницей MRTR — достаточно для Task 1, сверка схемы — при
  реализации хелперов в `protocol/mcp.ts` (Волна 3).
