# Ручной смок M5 — доказательный журнал: цепочка, подпись, отчёт, retention, эскалация поверхности

**Пройден 2026-08-18.** Закрывает пункт приёмки милестоуна M5 («ручной смок: генерация отчёта по
живой сессии + verify + подделка строки → verify ловит», план
`.claude/PRPs/plans/m5-tamper-evident-journal.plan.md`, задача 6.5) и заодно проверяет два новых
поведения волны 6 — retention-prune с маркером и отзыв явного `allow` при расширении поверхности
тулза (решения владельца O6 и O4).

Стенд: только скретч-каталоги, реальный `~/.mcp-journal` **не использовался** — каждый вызов CLI
шёл с подменённым `HOME` (`JOURNAL_DIR = join(homedir(), '.mcp-journal')`, `src/config.ts`).
Прогон на продовом `dist/` (`npm run build` перед смоком — первая попытка шла на устаревшем
`dist/`, см. наблюдение 1). Апстрим — скретч-фикстура `smoke-server.mjs`: один тулз `write_note`,
чья `inputSchema` расширяется при `SMOKE_WIDE=1` (без переменной — одно свойство `text`, с ней —
`text` + `force`). Клиент — построчный JSON-RPC в stdin `wrap`.

Два стенда: `home/` (эскалация поверхности, подпись главы) и `home2/` (retention: журнал, у
которого старые записи стоят В НАЧАЛЕ).

## Часть 1 — эскалация при расширении поверхности (задача 6.3, решение O4)

Политика стенда: `defaultDecision: deny`, карантин включён (`onQuarantined: require-approval`),
и **явное правило** `servers.smoke.tools.write_note: "allow"` — то самое, которое до M5 продолжало
действовать после того, как сервер менял тулзу.

```
HOME=<scratch>/home node dist/cli.js wrap --server smoke --policy policy.json -- node smoke-server.mjs
HOME=<scratch>/home node dist/cli.js quarantine approve smoke write_note
SMOKE_WIDE=1 HOME=<scratch>/home node dist/cli.js wrap ...   # сервер отдаёт расширенную схему
HOME=<scratch>/home node dist/cli.js approvals list
HOME=<scratch>/home node dist/cli.js show <session> --kind decision --json
```

| # | Действие | Факт |
|---|---|---|
| 1 | Первая сессия, узкая схема | ☑ `write_note` в карантине как `new`; вызовов не делали |
| 2 | `quarantine approve smoke write_note` | ☑ «Approved "write_note" for server "smoke".» |
| 3 | Вторая сессия, та же схема, `tools/call` | ☑ **вызов разрешён** — явное правило действует, тулз `known`, эскалации нет (контроль, что правило не сломано вообще) |
| 4 | Третья сессия, `SMOKE_WIDE=1`, `tools/list` + `tools/call` одним потоком | ☑ вызов **разрешён**, и это правильно: карантинное состояние на момент решения ещё `known` — инвентарь наблюдает расширение из ОТВЕТА сервера, который приходит после того, как запрос уже прогейтен. Наблюдение 2 |
| 5 | Четвёртая сессия, расширение уже известно инвентарю | ☑ **allow отозван**: заявка встала в очередь (`approvals list` → `server=smoke tool=write_note class=write args={"text":"hi","force":true}`), клиент через таймаут получил `-32002 approval_timeout` |
| 6 | Записи решения этой сессии | ☑ обе несут новое правило и провенанс: `require-approval-pending \| surface-changed \| state=changed \| policyHash=3aca122c3734` и `timeout \| surface-changed \| state=changed \| policyHash=3aca122c3734` |

То есть аудитор, читающий «в политике написано `allow`, а исход — require-approval», видит причину
в самой записи (`rule: surface-changed`), а не делает вывод, что правила поменялись сами.

## Часть 2 — подпись главы цепочки (волна 4) и внешний якорь

```
HOME=<scratch>/home node dist/cli.js keygen
HOME=<scratch>/home node dist/cli.js verify
HOME=<scratch>/home node dist/cli.js verify --sign
```

| # | Действие | Факт |
|---|---|---|
| 7 | `keygen` | ☑ ключ 0600, публичный ключ и отпечаток `96924847…` напечатаны один раз |
| 8 | `verify` | ☑ exit 0, «Chain intact through seq 54 (54 record(s) checked).» |
| 9 | `verify --sign` | ☑ якорь `formatVersion 2, seq 54, recordHash 03950f46…, signedAt …, keyFingerprint 96924847…` + подпись base64; следом — абзац про то, что процесс под тем же пользователем перепишет цепочку и переподпишет её этим же ключом, и без внешнего якоря подпись не доказывает ничего |

## Часть 3 — retention (задача 6.1, решение O6)

Сначала — краевой случай, который вышел сам собой на стенде `home/`: три «состаренные» записи
(`ts` = январь) были дописаны в конец журнала, то есть по `seq` они новее живых.

| # | Действие | Факт |
|---|---|---|
| 10 | `prune --older-than 30d` на `home/` | ☑ «Nothing to prune: no record is older than 2026-07-19T…» — правило префикса сработало ровно как задумано: старые по `ts` записи, стоящие ЗА новыми, не удаляются, потому что дыра в середине цепочки неремонтируема |

Дальше — стенд `home2/`, где состаренные записи стоят в начале (seq 1..3), а за ними живая сессия.

```
HOME=<scratch>/home2 node dist/cli.js prune --older-than 30d          # без --yes
HOME=<scratch>/home2 node dist/cli.js prune --older-than 30d --yes
HOME=<scratch>/home2 node dist/cli.js verify
HOME=<scratch>/home2 node dist/cli.js export --report --out rep-pruned
HOME=<scratch>/home2 node dist/cli.js verify --report rep-pruned
```

| # | Действие | Факт |
|---|---|---|
| 11 | `prune` без `--yes` | ☑ ничего не удалено: «would delete: 3 record(s), seq 1..3», глава префикса `cd05271e…`, «marker would be: signed with this installation's key», и прямым текстом «Re-run with --yes … This cannot be undone» |
| 12 | `prune --yes` | ☑ «Deleted 3 record(s) (through seq 3)», маркер подписан (`ed25519 by key 1c25468c…`), «remaining journal: starts at seq 4», плюс абзац о том, что маркер — заявление самого хоста |
| 13 | `verify` после prune | ☑ exit **0**; первым делом печатает «Retention: 3 record(s) were deleted through seq 3 …», говорит, что дальше цепочка проверяется от главы маркера, а не от genesis, и что маркер подписан; затем «Chain intact through seq 9 (6 record(s) checked)» |
| 14 | `export --report` после prune | ☑ манифест несёт `seqRange {firstSeq: 4, lastSeq: 9}`, `chain.startPrevHash cd05271e…`, **`chain.prunedThroughSeq: 3`**; `summary.md` — строка «Retention: records through seq 3 were DELETED by a retention prune before this export…» |
| 15 | `verify --report` на этом экспорте | ☑ exit 0, RESULT: PASSED; свёртка цепочки прошла ОТ ГЛАВЫ МАРКЕРА: «folding 6 link(s) from startPrevHash cd05271e… reproduces chain.head.recordHash d8ad575d… at seq 9» |

Главное здесь: prune не превращает журнал в «чистый» — он делает удаление **раскрытым**, а остаток
— по-прежнему проверяемым.

## Часть 4 — подделки ловятся и на подрезанном журнале

| # | Действие | Факт |
|---|---|---|
| 16 | `UPDATE journal_records SET doc=… WHERE seq=6` (правка без пересчёта хеша) | ☑ exit **2**, «Chain intact through seq 5», «BROKEN at seq 6: this record's content does not match its recorded hash» — и раскрытие retention остаётся на месте, то есть маркер не маскирует подделку |
| 17 | `DELETE FROM journal_records WHERE seq=6` (тихое удаление без маркера) | ☑ exit **2**, «BROKEN at seq 7: … a record was deleted, inserted, or reordered near this point, OR the record immediately before it (seq 6) was edited…» — формулировка честно называет обе неразличимые причины |

## Часть 5 — отчёт и его оффлайн-проверка (волна 5)

Прогонялось на отдельном стенде до волны 6 (тот же `dist/`, чистый `HOME`), фиксируется здесь,
потому что это и есть процедура аудитора:

| # | Действие | Факт |
|---|---|---|
| 18 | `keygen` → `export --report` → `verify --report` | ☑ exit 0, все семь проверок PASS, RESULT: PASSED |
| 19 | Правка байта в `records.jsonl` | ☑ exit **2**: провалились и дайджест, и свёртка цепочки |
| 20 | Удаление `summary.md` | ☑ exit **2** — манифест удостоверяет его дайджестом, значит отсутствие есть улика, а не неудобство |
| 21 | Удаление `signature.json` при `keyFingerprint` в манифесте | ☑ exit **2** с текстом «This is NOT an ordinary unsigned report» |
| 22 | Удаление `records.jsonl` | ☑ exit **2** (обе байтовые проверки) |
| 23 | Несуществующий каталог | ☑ exit **1** — «не смогли посмотреть», не находка |
| 24 | Сессионный экспорт | ☑ exit 0, свёртка цепочки `[SKIPPED]` с причиной, остальные шесть проверок отработали |
| 25 | Неподписанный экспорт | ☑ exit 0 с баннером UNSIGNED; он же с `--require-signature` → exit **2** |

## Перф-гейты (после волны 6)

```
node tools/bench/bench-journal.mjs --mode sink     # 82 233 rec/s  (гейт O5: ≥ 80k)
node tools/bench/bench-journal.mjs --mode search   # p95 0.88 мс / 2.83 мс (гейт: < 50 мс)
```

Ветка prune в горячий путь записи не попадает: дополнительный `SELECT` по таблице маркера
выполняется только когда в журнале не осталось ни одной аттестованной строки.

## Наблюдения

1. **Первый прогон шёл на устаревшем `dist/`** и «доказал» отсутствие эскалации — на деле
   `surfaceDeltaOf` в собранном коде просто не было. Урок тот же, что в смоке M4 про браузер:
   смок проверяет ТО, ЧТО СОБРАНО. Перед смоком — `npm run build`, и лучше сразу проверять
   наличие нового поведения самым дешёвым зондом (здесь хватило одной строчки в скретч-скрипте).
2. **Эскалация зависит от порядка**: расширение поверхности видно инвентарю только из ответа
   сервера на `tools/list`, а `tools/call`, отправленный в том же потоке строк, гейтится раньше,
   чем этот ответ обработан. Это не дыра эскалации, а обычное свойство наблюдения: первый вызов
   после расширения может пройти по старому состоянию. Тот же класс, что «первый вызов до
   `tools/list` не карантинится» (задокументировано в `decide.ts`). Кандидат в бэклог, если
   партнёр принесёт сценарий, где один такой вызов недопустим.
3. **`prune` на префиксе, а не по предикату** — на стенде это увидели «в лоб»: журнал со старыми записями
   в конце ответил «nothing to prune». Формулировка вывода это объясняет («no record is older
   than …»), но не говорит, что старые записи ЕСТЬ и они не в префиксе. Кандидат на улучшение
   текста, если у пилота такой журнал реально появится (импортированные legacy-сессии).
