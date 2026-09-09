# ADR-0007: Доказательный журнал — хеш-цепочка и подпись (M5)

- **Статус**: принято (2026-08-18; статус актуализирован 2026-08-24 — M5 закрыт целиком, все 6 волн
  реализованы, смок `docs/smoke-m5.md`)
- **Область**: `src/journal/chain.ts`, `src/journal/chain-verify.ts`, `src/journal/db.ts` (волна 3),
  `src/journal/signing.ts` (волна 4), `src/cli/verify-cmd.ts`, `src/cli/keygen-cmd.ts` (волны 3–5),
  `docs/adr/0006-storage-sqlite.md` (уточнения), `docs/adr/0004-admin-ui-architecture.md` (поправка)
- **Основание**: `.claude/PRPs/plans/m5-tamper-evident-journal.plan.md` (ключевые дизайн-решения,
  волны 3–4), требования из ROADMAP.md:90–97 (вход от ECZ-ID, тред `python-sdk#1705`),
  измеренный профиль цепочки волны 3

## Контекст

Журнал из M1–M4 даёт обслуживаемому персоналу запись, что произошло и когда. Для компании,
которая обязана доказать контролируемость AI-агентов перед аудитором (EU AI Act Art. 12, SOC 2),
этого недостаточно: запись должна быть неизменяемой после создания, должна называть, по какой
редакции правил было разрешено каждое действие, и должна быть независимо проверяемой без доступа к
базе.

Три отдельные проблемы:

1. **Целостность журнала не доказуема.** Сегодня в `journal.db` лежат строки без связей. Если
   процесс под тем же uid открывает БД и правит строку (или удаляет строки из середины), нечто
   это не обнаружит — будущий аудитор, получив экспорт, не сможет сказать, цела ли была история.
   ADR-0006 обещает (строка 130): звено цепочки коммитится одной транзакцией с записью —
   это решение остаётся в силе, нужно выполнить.
2. **Решение без провенанса.** Запись `decision` отвечает на вопрос «что произошло», но не
   «по какой редакции политики и матрицы грантов это решение было принято». Аудитор видит
   запись, которая говорит `rule: 'grant'`, но не может независимо её воспроизвести — версия
   политики могла меняться. ROADMAP.md:95 требует добавить `policyHash` и `grantsHash` до подписи.
3. **Одобрение без субъекта.** М2–М4 shell-одобрение (из `approvals approve` без параметров) даёт
   резолюцию без `actor`. ROADMAP.md:96 требует субъекта в подписанной цепочке; волна 2 этого
   milestones это закрывает (решение владельца O3).

Решение собирает три слоя в стек: хеш-цепочка доказывает целостность (волна 3, уже реализована),
подпись главы доказывает источник (волна 4), экспорт упаковывает всё в проверяемый отчёт (волна 5,
вне этого ADR).

## Решение

### 1. Хеш-цепочка в `journal.db` (волна 3 — реализована)

Две новых колонки на строку:

```sql
ALTER TABLE journal_records ADD COLUMN prev_hash TEXT;
ALTER TABLE journal_records ADD COLUMN record_hash TEXT;
```

Существующие записи остаются с `NULL` в обоих: это честный способ сказать «записана ДО включения
цепочки, не аттестована». Ретроактивная подпись мертвых строк была бы ложью о том, что они когда-то
защищались.

**Формула одного звена** (функция `linkHashOf` в `src/journal/chain.ts`):

```
record_hash = sha256Hex(prev_hash + '\n' + sha256Hex(doc))
```

Хешируется **STORED** `doc` STRING байт-в-байт, не canonical JSON (контраст с `policyHash`/`grantsHash`,
которые используют `canonicalJson` ибо там хешируется СЕМАНТИЧЕСКИЙ документ, а не его байты).
Причина: `doc` экспортируется и отправляется аудитору как есть, и верификатор должен пере-хешировать
ровно те же самые байты без переимплементации правил канонизации. Цепочка доказывает целостность
ПО ПРОВОДУ, не переинтерпретированный смысл.

Разделяющий `\n` между хешем предыдущего звена и хешем документа предотвращает коллизии даже если
`doc` случайно содержит буквальный 64-символьный hex-хеш или он сформован так, чтобы результат выглядел
иначе.

**Вычисление и коммит** (волна 3, функция `insertRecordRows` в `src/journal/db.ts`):

- Звено вычисляется в `insertRecordRows`, который БЫ ЕДИНСТВЕННЫЙ путь записи строк (вызывают его
  `batch-writer.ts` и `import.ts`), так что chained-path нет.
- `SELECT record_hash ORDER BY seq DESC LIMIT 1` выполняется ОДИН раз на батч строк (не один раз на
  строку), забирает текущую главу цепочки.
- Главу читают ВНУТРИ транзакции (`handle.transaction(...)` обёртывает весь батч), после
  `BEGIN IMMEDIATE`, так что она не может поехать между попыткой и блокировкой. Если busy-retry
  переиграет весь батч, глава перечитывается — нужно, потому что другой процесс мог добавить строки
  между попытками.
- Цепочка вычисляется в памяти в одном цикле: `prev = chainHeadOf(db)`, затем в цикле по `rows`:
  `recordHash = linkHashOf(prev, row.doc)`, `prev = recordHash`.

Это **выполняет обещание ADR-0006:130** — звено и запись коммитятся одной транзакцией, и оборотень
«запись упала, глава цепочки не обновилась» невозможен.

### 2. Честная модель угроз: tamper-evidence, не tamper-proof

Цепочка и подпись (волна 4) дают обнаружимость подделки, а не невозможность подделки. Что именно
они не дают — надо сказать прямо, потому что обратное прочтение опаснее отсутствия механизма вовсе.

**Процесс под тем же uid — включая дочерний процесс агента — может переписать цепочку целиком.**

Почему: граница доверия у этого продукта — учётная запись ОС (ADR-0003), а не процесс. База
журнала лежит в том же каталоге, что и ключ подписи (0600 в домашней директории оператора).
Всё, что исполняется под этой учётной записью, может открыть базу, переписать любую запись,
согласованно пересчитать все хеши после неё и переподписать новую главу. Результат будет
внутренне непротиворечив, и `verify` назовёт его целым — потому что он и будет целым, просто
это будет цепочка другой истории.

Обнаружимость даёт **только внешний якорь**: глава цепочки, которую оператор выгрузил и сохранил
вне этого хоста. Сверка с ней — единственная операция, которая отличает исходную историю от
переписанной. Якорь, оставленный на том же диске, не даёт ничего.

Отсюда следует, что гарантия здесь **организационная, а не техническая**: оператор не отдаёт
подписывающий ключ агентскому процессу, регулярно снимает якорь и хранит его отдельно. Это
неудобное следствие честной модели: если агенту доверены права файловой системы, то ему доверены
и файлы журнала. Технической преграды внутри того же uid не существует, и притворяться, что она
есть, значит продать аудитору гарантию, которой нет.

ROADMAP.md:34, 96 называют технических кандидатов на будущее (отдельный uid для писателя журнала,
внеполосное подтверждение одобрений) — они в бэклоге после пилотов. ADR-0004 уже описывает
same-uid-угрозу для UI; здесь она закрепляется для журнала.

### 3. Выбор алгоритма подписи: Ed25519 (решение владельца O2)

Две альтернативы:

| Вариант | Плюсы | Минусы |
|---|---|---|
| **HMAC-SHA256** | Быстрый, встроенный в `node:crypto` | Симметричный — верификатор должен узнать ключ и может тогда подделать любой отчёт. Независимость проверки теряется |
| **Ed25519** | Асимметричный — публичный ключ даёт аудитору проверку без доступа к секрету | Медленнее, но для подписи одной главы на ротацию базы это не проблема |

Выбрано: **Ed25519** (асимметричная подпись). Приватный ключ 0600 в `~/.mcp-journal/signing.key`;
публичный ключ отдается оператору для передачи аудитору. Функционал (`src/journal/signing.ts`,
волна 4) использует `node:crypto.generateKeyPairSync` — встроенный, без npm-зависимостей.

### 4. Формат и место подписи

**Подписывается ГЛАВА цепочки, не каждая запись.**

Почему: цепочка уже связывает все записи (если отредактировать одну, разломаются все хеши после).
Подпись каждой записи не добавила бы ни одного свойства, но срезала бы пропускную способность —
а она после волны 3 и так на пределе гейта. Подпись главы заверяет весь префикс сразу.

Манифест экспорта (волна 5) будет подписан: он содержит диапазон `seq`, последний `record_hash`,
временную метку и счётчики. Это якорь, который оператор может сохранить out-of-band и потом сверить.

### 5. `migrate` (wipe-and-reload) становится отказом (волна 3)

Раньше повторный импорт делал `DELETE FROM journal_records WHERE session_id = ?` и потом пересыпал
строки. После включения цепочки это активно разрушительно: удаление строк из середины цепи разломает
каждый хеш после них, и `verify` больше не сможет это разобрать (разрыв — не ошибка ввода, а крах
самой истории).

После волны 3: `imported_sessions` маркер — это ЗАПРЕТ на повторный импорт, а не триггер перезагрузки.

- **маркер есть**: сессия уже полностью импортирована, ничего не делаем.
- **маркер отсутствует, но строки сессии уже есть**: консервативный отказ. Нельзя надёжно разобрать,
  это результат `migrate`, прерванного на середине, или что-то ещё (например, текущий прокси пишет
  в `journal.db` параллельно). Команда `migrate` выводит предупреждение, exit 1, и скипает сессию,
  но продолжает импортировать остальные файлы.

Модель `imported_sessions` отличается от `migrated_documents` в state.db: там таблица без строк
сигнализирует об ошибке (документ исчез), здесь это норма (retention удалил старые строки сессии,
и маркер остался, но пусто).

### 6. Retention и пруне-маркер (волна 6, зафиксировать место для расширения)

Пруне-операция (`journal prune --older-than <duration>`) будет удалять старый префикс записей и
оставлять маркер со СКЕЛЕТОМ удалённого префикса: границей seq, последним `record_hash` удалённого
дребезга и (если ключ есть) его подписью. Это позволит `verify` стартовать от маркера, не от генезиса
(волна 6, задача 6.1), и оставить целостность оставшегося суффикса доказуемой.

`resolveChainStartPrevHash` (функция в `src/journal/chain-verify.ts`, волна 3, задача 3.3) уже существует как seam для этого. Сегодня возвращает `GENESIS_PREV_HASH`; волна 6 это переделает.

### 7. Экспорт разделяет целостность и авторитетность (волна 5)

Волна 5 выдаст `export --report`: манифест + JSONL + summary. Контракт (явно, в текстах и
интерфейсе):

> Отчёт удостоверяет историю решений и целостность записей НА МОМЕНТ ВЫГРУЗКИ. Он не является
> утверждением о ТЕКУЩИХ правах субъектов, политики или операторов. Экспорт композируется с
> внешним резолвером (вне périметра этого продукта), который отвечает на вопрос, кто авторитетен сейчас.

Это ROADMAP.md:94 — разделение слоев: enforcement (что разрешено-и-запрещено) → receipt (что
произошло и цела ли запись) → resolver (что считать авторитетным сейчас).

Приватные входы решений не экспортируются — редакция уже применена на сохранённую запись.

### 8. At-rest шифрование вне M5 (решение владельца O1)

Рассматривался SQLCipher (шифрует BД целиком) и column-level encryption. Результат:

- **SQLCipher** превысит лимит на две prod-зависимости (ADR-0001).
- **Column-level** ломает journal search и UI journalLog.
- **Ни то, ни другое не защищает от same-uid-агента**, который может открыть базу прямо.

Ответ на запрос: требование к оператору — использовать FileVault (macOS) или LUKS (Linux) для
шифрования диска. Это документируется в README и ROADMAP.md, и вопрос пересматривается после
пилотов (вверху PRD как открытый, не в M5).

### 9. Гейт пропускной способности цепочки (волна 3, решение владельца O5)

Волна 3 замерила пропускную способность на каноническом профиле M4.5 (один синк, один писатель):

| Профиль | Результат |
|---|---|
| База M4.5 (без цепочки) | 119–124k записей/с |
| С хеш-цепочкой | 83–86k записей/с; ~75k на восьми синках |

Разложение замерено, а не предположено: `SELECT` главы цепочки стоит ~0.6 мс на все 391 батч —
пренебрежимо, вопреки тому, что риск-таблица плана называла его главным подозреваемым. Вся цена —
**хеширование**: ~216 мс на 100k записей. То есть потеря 30–40% упирается в криптографию записи,
а не в I/O и не в лишний запрос.

Первоначальный гейт был ≥100k записей/с. После замера владелец PRD его пересмотрел:

- Реальная нагрузка пилота — единицы вызовов в час, а не поток записи.
- Гейт был стражем от регресса, а не продуктовым требованием; это то же рассуждение, которое
  владелец уже применил в M4.5 к гейту 10k обновлений/с.
- Формат звена при этом НЕ меняется. Вариант «один хеш вместо двух» даёт ~94–95k — гейт всё равно
  не берётся, а формат заморозился бы в худшем виде. Платить необратимым решением за 10% нельзя:
  сменить формат звена после того, как цепочка начала заверять записи, значит обесценить всё уже
  заверенное.

**Гейт пересмотрен: ≥80k записей/с.** Поиск по журналу цепочка не задевает вовсе: p95 0.86–3.19 мс
при гейте 50 мс.

Триггеры пересмотра: жалоба пилота на задержку записи либо ожидание writer-лока свыше 5%.

### 10. Терминология: когда разрешается говорить о доказательности

CLAUDE.md:3 запрещает слова «tamper-evident» и «audit-ready» в публичных текстах _на данный момент_,
потому что M5 их не доставляет. **Условие разрешения терминологии:** когда волна 5 доставляет
экспортируемый, независимо проверяемый отчёт.

Сегодня (волна 3 реализована, волна 4 в разработке): журнал называется в публичных текстах
«persistent, append-oriented, secret-redacted», и это правда на 100%. ADR-0007 (этот текст) может
ОПИСЫВАТЬ ДИЗАЙН как target architecture (чем мы идём и почему), но не может УТВЕРЖДАТЬ, что
продукт уже это даёт.

**Правка CLAUDE.md** случится в волне 6, задача 6.4, когда вся пятёрка волн доставлена и смок
прошёл.

### 11. Report format v1 (wave 5, task 5.5): a versioned, minimally-sufficient field set

*(Written in English per the wave-5 documentation task's instruction; the rest of this ADR
predates that instruction and stays in Russian.)*

`REPORT_FORMAT_VERSION` (`src/journal/report.ts`) versions the report format as a whole —
`report.json`'s field set, the `records.jsonl` line convention, and the definition of
`chain.recomputable` — not any one field in isolation. Every consumer (`report-parse.ts`) checks
it BEFORE running the zod schema, and rejects an unrecognized version outright rather than
attempting a best-effort read: a v2 manifest handed to a v1-only build fails loudly ("this build
understands version 1 only… a newer report needs a newer mcp-journal"), instead of silently
degrading into a check that examines fields whose meaning this build no longer knows.

v1's field set (the frozen contract, reproduced in `report.ts`'s `ReportManifest`) is deliberately
the MINIMUM an offline auditor needs to re-derive every claim the report makes: the exact bytes
exported (`records.sha256`/`lineCount`), the decision counts and outcomes, the chain state at
export time, and whether that state can be independently re-folded from the export alone
(`isChainRecomputable`). It does not try to anticipate every question a real auditor engagement
will raise. The PRD's open question — an actual interview with a design partner's auditor — is
expected to surface fields v1 does not have (a machine-readable diff against a prior report, a
retention marker once wave 6 ships pruning, and others neither foreseeable nor useful to guess at
now). That interview has not happened; guessing its answer today would either under-specify a v2
that has to break v1 anyway, or over-specify a v1 carrying fields nobody asked for. `formatVersion`
exists precisely so that gap can be closed later without invalidating every v1 report already
handed to an auditor: an old report stays readable by an old-enough verifier, and a new report says
plainly that it needs a newer one.

### 12. Three known v2 candidates, deliberately not fixed in v1

Three points came up during wave 5 implementation where v1 could say more than it does. All three
are DIAGNOSABILITY gaps, not soundness holes — v1's checks still catch the underlying discrepancy,
just less directly than a v2 field could — and all three are deferred to a v2 informed by the
auditor interview above, rather than fixed now on a guess:

- **(a) `records.lineCount` and `counts.records` can never legitimately disagree.** Both fields
  count the same set of exported rows, produced by the same streaming pass
  (`report.ts`'s `streamRecords`); no honest export can make them differ. `report-verify.ts`'s
  manifest-self-consistency check turns that redundancy into a cross-check instead of leaving it
  as dead weight: a manifest hand-edited after export to change one copy and not the other is
  caught, where a maximally minimal manifest carrying only one of the two fields could not have
  caught it. A v2 that dropped the redundant field would need a different way to catch the same
  tamper.
- **(b) `chain.verifiedAtExport` is derivable from `chain.break === null`.** Same shape as (a),
  same treatment: `report-verify.ts` checks the two agree rather than dropping one of them, so a
  post-export edit that changes only one is caught rather than silently accepted.
- **(c) `signature.json` carries no binding to the specific report it signs** (no `manifestSha256`
  or equivalent). `signature.json`'s `keyFingerprint` says which KEY signed; nothing in v1 says
  which `report.json` the signature was produced OVER, beyond the signature verifying or not
  verifying against whatever manifest happens to be present. A `signature.json` from a DIFFERENT
  export of the same installation — same key, wrong manifest — is caught only indirectly:
  `verifyReportManifestSignature` (`report-signing.ts`) recomputes the canonical bytes from the
  manifest actually on disk, and the signature simply fails to verify against them. The auditor
  reads "the signature does not verify," not "this signature belongs to a different report" — a
  true but less specific diagnosis. No mix-and-match of a foreign `signature.json` onto a real
  manifest can pass the check, ever; a v2 field could turn that generic failure into a directly
  nameable "wrong report" error.

### 13. Manifest signing is a second, explicitly enumerated signing adapter

Manifest signing (`signReportManifest`/`verifyReportManifestSignature`) lives in
`src/journal/report-signing.ts`, not in `src/journal/signing.ts` alongside
`signChainHeadAnchor`. The reason is purely the project's 400-line file cap: `signing.ts` is
already at that limit, and `report-signing.ts`'s own "why" comments would push it over.

This widens the architecture rule `tests/architecture/imports.test.ts` enforces — from
"asymmetric crypto lives in exactly one file" to "asymmetric crypto lives in an ENUMERATED set of
files," now two, both named explicitly in that test rather than matched by a pattern. Nothing else
may import a signing primitive; adding a third file to the set means touching that test
deliberately, which keeps the boundary a decision each time, not a drift.

Key-fingerprint DERIVATION is not duplicated by this split: `report-signing.ts` imports
`privateKeyFingerprint`/`publicKeyFingerprint` from `signing.ts` rather than recomputing them, so
both signers — the chain-head anchor and the report manifest — answer "which key signed this"
through the same one code path. Splitting WHERE signing happens did not split WHERE a key's
identity is computed.

### 14. Retention: an explicitly-run prune, anchored by a marker (wave 6, task 6.1, decision O6)

*(English, like sections 11-13.)*

Pruning is a command an operator runs (`mcp-journal prune --older-than <dur> --yes`), never a
default, a timer or a configured period. The owner decision (O6) is that the first auditor who
names a retention period is the earliest moment a default could be anything but this project
guessing how long someone else's evidence is worth keeping. What ships is the mechanism plus the
disclosure; the policy stays with the operator.

Three design points are load-bearing:

- **A prefix, not a predicate.** Rows are deleted as a contiguous `seq` prefix whose every row is
  older than the cutoff, never as "every row whose `ts` is old". `ts` does not have to rise with
  `seq` (imported legacy sessions, a clock step), and a timestamp predicate would delete a row from
  the MIDDLE of the chain. A hole is unrepairable: no surviving row after it can be re-anchored to
  anything, and `verify` would report a permanent break that no operator action can clear. So an
  old row sitting behind a newer one survives its cutoff, and the CLI says so.
- **The delete and the marker are one transaction.** A committed delete without its marker leaves a
  journal whose surviving rows verify against nothing — and, worse, one that is indistinguishable
  afterwards from tampering, because the head hash the marker would have carried died with the
  deleted rows. One transaction makes "pruned" a state the journal can BE IN rather than a state it
  can be caught halfway into.
- **The marker feeds three readers, not one.** `verifyChain` starts its walk from it (otherwise
  every prune would look exactly like a `gap`, teaching operators to ignore the one signal the
  chain exists to give); `insertRecordRows` falls back to it when no attested row is left (otherwise
  a journal pruned empty would restart at genesis and read as one that never held anything); and
  the report manifest carries `chain.prunedThroughSeq` (otherwise an auditor gets a report starting
  at seq 4001 with a non-genesis `startPrevHash` and nothing explaining either).

The marker reuses the wave-4 chain-head anchor as its signed statement rather than inventing a
second signed format: "at instant T the chain head at seq N was H" is exactly what a marker
attests about the prefix it removed, and one format means one verification path for an auditor. A
prefix that held no attested row at all (pre-chain rows only) is recorded UNSIGNED on purpose --
signing would require either a placeholder hash, which is a statement about a chain position that
never existed, or a second format for "nothing was attested".

**What a marker is worth, stated plainly wherever it surfaces:** it is the host's own claim about
what it deleted, written by the same uid that could have deleted rows and recorded nothing. The
signature attributes the claim to this installation's key; it does not make the claim complete.
Only an anchor taken out of band BEFORE the prune corroborates it. This is the same honest limit as
everywhere else in M5, applied to the one operation that removes evidence rather than adding it.

> **Amendment 2026-09-08 (owner decision Q17, ADR-0010).** The marker's own SHAPE is unchanged --
> deliberately. `prune --yes` now requires an admin token of role `owner` and attributes the delete,
> but WHO ran it is recorded as a separate `access-edit` record (`action: 'prune'`, with
> `olderThan`, `deletedCount`, `prunedThroughSeq`) written right after the marker, not as a field on
> the marker itself. A field there would sit inside the payload the marker signature covers and that
> both `verify` and the offline `verify --report` read, so adding one would change the signed
> statement on every existing installation -- for a fact the journal's attributed-change category
> already has a place for. The limit above is untouched: the record, like the marker, is this host's
> own claim.

### 15. Surface-change escalation lives in the decision precedence, not in the classifier (wave 6, task 6.3, decision O4)

The plan's candidate rule was "a `widened` surface raises an approved tool's CLASS". Two things
killed it. The dogfood data: across ~2 weeks, 4 servers and 35 approved tools, exactly two
`changed` events occurred, one of them synthetic, and the real one
(`playwright/browser_take_screenshot`) carried no `inputSchema` at all, so no direction was
computed -- the proposed rule would have fired zero times. And the precedence: a `changed` tool is
already quarantined, quarantine already resolves ABOVE the class defaults, so raising the class
changes an outcome only when `quarantine.enabled` is false, i.e. exactly where the operator opted
out of drift gating.

The path that was actually open is the opposite one. A per-tool rule outranks BOTH quarantine and
the class defaults -- deliberately, since it is an operator's most specific instruction -- so an
explicit `allow` written against one tool surface kept allowing calls after the server advertised a
wider one. That is now withdrawn (`decide.ts`'s `withdrawnBySurfaceChange`): the call falls to
`quarantine.onQuarantined` under the rule `surface-changed`, and the reason names the superseded
config path so an auditor reading "policy says allow, outcome was require-approval" sees why.

An UNCOMPUTABLE delta escalates, exactly like `widened` does. The absence of the signal is not
evidence of safety, and all three ways it goes missing are real: an approval predating stored
descriptors (the live dogfood installation holds one), a schema too large to store whole
(persisted as a summary, so a diff over it can report `neutral` for a change it never saw), and a
descriptor with no `inputSchema` on either side. `narrowed` and `neutral` leave the `allow`
standing -- a smaller surface, or a wording-only edit, is still covered by what the operator
approved.

Escalation is gated on `quarantine.enabled` on purpose: that flag IS the operator's switch for
gating known schema drift, and honouring an explicit `allow` while ignoring an explicit "do not
gate drift" would be two answers to one question. State `new` is untouched for the mirror-image
reason -- a rule written for a tool that was never approved was never written against an approved
surface.

## Что отвергнуто и почему

| Вариант | Почему нет |
|---|---|
| **Сеть хеш-цепочек на основе сессии, не глобальная** (независимые цепи per-session) | Цепь per-session не доказывает глобальный порядок событий между сессиями; верификатор не может сказать, произошло ли событие А раньше события В, если они в разных сессиях. Глобальная цепь (через `seq AUTOINCREMENT` в `journal.db`) держит полный порядок |
| **Merkle-tree вместо linear chain** | Merkle-tree даёт о(log n) верификацию, но для 1M записей = ~20 операций, что не измеряет разницу в сценарии offline-verify. Сложность и плоскость кода выбирают linear chain |
| **HMAC-SHA256 вместо Ed25519** | Симметричный алгоритм: верификатор = вероятный подделыватель. Независимость проверки теряется. Отвергнуто владельцем (O2) в пользу асимметрии |
| **Подпись каждой записи, не главы** | Криптооперация на запись срезает пропускную способность и не добавляет свойств: цепочка уже связывает записи, а подпись главы заверяет весь префикс |
| **Переподписывание старых NULL-hash строк** | Ложь о том, что они когда-то защищались. Честно оставляют `NULL` навсегда |
| **Retroactive CAS/version-pin в approvals** | Записаны `policyHash`/`grantsHash` на момент заявки (`queue-file.ts:PendingApprovalFile`), выполняя требование ROADMAP.md:95 о провенансе до подписи. Попытка добавить версион-плин к старым записям не помогает |

## Последствия

- (+) **Целостность доказуема**: `verify` ходит по цепочке, находит первый разрыв и называет его.
  Оператор, который регулярно сохраняет цепочку и проверяет её, имеет якорь против same-uid
  переписывания.
- (+) **Провенанс в каждой записи**: `policyHash` и `grantsHash` позволяют аудитору воспроизвести,
  по каким правилам решение было принято, и проверить согласованность. Это ROADMAP.md:95.
- (+) **Атрибуция**: волна 2 (решение O3) заполняет `actor` везде (UI, CLI, позднее одобрение).
  Цепочка фиксирует, кто одобрил — хотя гарантия против same-uid всё ещё организационная.
- (+) **Модель угроз говорится честно**: никакого `tamper-proof`, только tamper-EVIDENCE с
  внешним якорем. Это означает, что продукт не претендует на невозможное, и операторы знают,
  на что рассчитывать.
- (+) **Гейт пропускной способности пересмотрен**: 80k rec/s — достаточно, и замер это доказал.
  Нет скрытого долга.
- (−) **Производительность упала на ~30%** (от базовой 119–124k до 83–86k); причина —
  криптография, а не I/O. Это известно, измерено и принято.
- (−) **Граница доверия не улучшена**: same-uid угроза остаётся. Это не вина хранилища и не
  может быть решено здесь (ADR-0003). Кандидаты — в бэклоге.
- (−) **Ключ подписи — новый критический артефакт**: must be 0600, must be backed up, rotation
  требует пересбора экспортов. README документирует процедуру; это решение владельца.

## Связанные решения

- **ADR-0001** — граница зависимостей (две prod-зависимости); это решение их не добавляет.
  `node:crypto` встроен в рантайм (Node 24 LTS).
- **ADR-0003** — граница доверия (учётная запись ОС); это решение наследует её и честно называет
  same-uid-угрозу.
- **ADR-0006** — обещание (строка 130): звено и запись коммитятся одной транзакцией. Волна 3
  это выполняет.
- **ADR-0004** — поправка вверху документа, уточнение модели угроз для same-uid-агента.
- **PRD** `.claude/prds/mcp-control-plane.prd.md` — требования M5, success metrics.
- **ROADMAP.md:90–97** — внешние требования из ECZ-ID.

---

## Поправка 2026-08-18 (терминология и CLAUDE.md)

**Обстоятельства:** Волна 3 (хеш-цепочка) реализована и верифицирована. Волна 4 (подпись) в
разработке и зафиксирована этим ADR. Волна 5 (экспорт отчёта) и волна 6 (retention, finalization)
не начинались. CLAUDE.md:3 запрещает термины «tamper-evident» и «audit-ready» в публичных текстах,
ожидая финальной доставки М5 полностью.

**Решение:** План предполагал правку CLAUDE.md в этом ADR (задача 4.1). Однако дальнейший анализ
показал, что терминология разрешается только в волне 6, задача 6.4, когда **весь стек** (цепочка +
подпись + экспорт + retention) доставлен. ADR-0007 может описывать архитектуру как целевую, но не
может утверждать, что она работает _сейчас_, если не все волны завершены.

Согласно плану, CLAUDE.md будет отредактирован в финале (волна 6); это ADR не трогает его. Вместо
того, текст здесь ясно описывает условие: когда волна 5 доставляет exportable, offline-verifiable
report, терминология становится уместной в публичных текстах, потому что продукт тогда действительно
её даёт. Это дефер, а не забывчивость.

**Сегодня в публичных текстах журнал остаётся:** «persistent, append-oriented, secret-redacted» —
абсолютно правдивое описание, охватывающее факт без переоценки гарантий.

---

## Когда пересматриваем

- **Гейт пропускной способности**: жалоба пилота на задержку записи либо ожидание writer-лока свыше 5%.
  Кандидаты: асимметричное хеширование, batch-амортизация подписей, изоляция подписующего процесса.
- **Требование at-rest шифрования**: если партнёр отвергнет требование FileVault/LUKS, то решение
  владельца переоценивается, и SQLCipher входит в граничное расширение на три зависимости.
- **Прорыв ключа подписи**: ротация — явно (oпровать старый ключ, сформировать новый, подписать
  переходный манифест). Процедура — в README и ROADMAP.
- **Retention и композирование с резолвером**: если пилот потребует сложные запросы через цепочку
  и retention, может потребоваться merkle-tree или дополнительный индекс в `verify`.
- **Многоузловое развёртывание**: если партнёр потребует, чтобы несколько плоскостей писали в
  общий журнал, нужно решение (например, центральный логос-сервер), и это отдельный ADR.
