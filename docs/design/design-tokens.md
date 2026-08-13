# MCP Control Plane — дизайн-токены (Ivory Audit)

Источник визуального языка: тёплый ivory-минимализм CRM-референса Ronas IT
(`crm-full.png`) + структурная грамматика карточек/шапки-сущности/табов
`cyclops-full.png`. Адаптировано под домен: consle для аудита действий
AI-агентов — очередь одобрений, журнал с редакцией секретов, карантин
тулзов, реестр MCP-серверов, матрица прав.

Текущий `src/ui/assets/app-css.ts` — тёмная тема с CSP `default-src 'none';
style-src 'self'` (никаких внешних шрифтов/CDN). Эта система задаёт
светлую (ivory) тему по умолчанию, но именует токены семантически
(`--surface`, `--text-*`, `--status-*-bg/fg`), чтобы тёмная тема второй
итерацией переопределяла те же имена, не переименовывая классы.

---

## 1. Цвет

### 1.1 Нейтральная база (ivory / ink)

| Токен | Значение | Назначение |
|---|---|---|
| `--color-ivory-50` | `#FAFAF7` | Фон страницы (`body`) |
| `--color-ivory-100` | `#F3F3EC` | Sunken-поверхность: полоса сводных метрик, фон таблицы-зебры, sidebar-hover |
| `--color-ivory-200` | `#EDEDE3` | Более тёмный sunken (трек gauge, пустая ячейка sparkline) |
| `--color-white` | `#FFFFFF` | Поверхность карточек/попапов поверх ivory-фона |
| `--color-ink-950` | `#101010` | Тёмный акцентный фон (инвертированная карточка) |
| `--color-ink-900` | `#1B1B18` | Первичный текст |
| `--color-ink-700` | `#4A4A44` | Вторичный текст (подписи, мета) |
| `--color-ink-600` | `#6E6E66` | Приглушённый текст (плейсхолдеры, disabled-подписи) — 4.92:1 на ivory-50, порог соблюдён |
| `--color-ink-300` | `#B8B8AE` | Декоративное: иконки-заглушки, disabled-иконки (не для текста) |
| `--color-ivory-on-dark` | `#F5F5F0` | Текст на тёмной акцентной карточке — 17.4:1 |

Причина держать `ink-600`, а не референсный серый `#7A7A72`: он даёт всего
4.14:1 на `--color-ivory-50` — ниже требуемого порога 4.5:1. `#6E6E66`
проверен (4.92:1) и визуально почти неотличим.

### 1.2 Границы

| Токен | Значение | Назначение |
|---|---|---|
| `--color-border` | `#E4E4D9` | Стандартная граница карточек/инпутов/таблиц (декоративная, не текстовая — AA не требуется) |
| `--color-border-strong` | `#D2D2C4` | Граница на hover/focus/активных чипах, разделитель табов |
| `--color-border-on-dark` | `rgba(245,245,240,0.16)` | Граница внутри тёмной карточки |

### 1.3 Акцент (интерактив)

| Токен | Значение | Назначение | Контраст |
|---|---|---|---|
| `--color-accent` | `#2A5FD8` | Ссылки, активная вкладка, primary-иконки, фокус-ring | 5.39:1 на ivory-50 |
| `--color-accent-fg` | `#FFFFFF` | Текст на `--accent`-фоне (primary-кнопка) | 5.63:1 на `--accent` |
| `--color-accent-bg-soft` | `#E7EEFC` | Слабый фон для active nav-item / выбранного чипа | — |

Синий сохранён из текущего `--accent: #4f8cff` тёмной темы (переприглушён
под светлый фон), чтобы бренд-акцент не менялся при переходе тем.

### 1.4 Статусные пары (домен: allowed / pending / denied / quarantine / redacted)

Все пары посчитаны по WCAG (относительная люминация), fg проверен и на
своём pill-фоне, и на `--color-ivory-50` (для случаев текста без пилюли —
например, статус-слово в ячейке таблицы).

| Статус | fg-токен | Значение | bg-токен | Значение | fg/bg | fg/ivory |
|---|---|---|---|---|---|---|
| **Allowed / Approved** | `--status-success-fg` | `#166534` | `--status-success-bg` | `#DCFCE7` | 6.49:1 | 6.82:1 |
| **Pending approval** | `--status-pending-fg` | `#92400E` | `--status-pending-bg` | `#FEF3C7` | 6.37:1 | 6.78:1 |
| **Denied / Error** | `--status-danger-fg` | `#991B1B` | `--status-danger-bg` | `#FEE2E2` | 6.80:1 | 7.95:1 |
| **Quarantine** | `--status-quarantine-fg` | `#6B21A8` | `--status-quarantine-bg` | `#F3E8FF` | 7.39:1 | 8.34:1 |
| **Redacted (секрет)** | `--status-redacted-fg` | `#57534E` | `--status-redacted-bg` | `#E7E5DF` | 6.06:1 | 7.30:1 |

Решение по quarantine — **фиолетовый, не янтарный**: pending и quarantine
семантически разные состояния (pending = «ждёт решения человека по
конкретному вызову», quarantine = «новый/незнакомый тулз, ещё не прошёл
классификацию» — они видны одновременно на одном экране очереди/реестра,
им нужен разный hue, иначе оператор путает срочность одобрения с
неклассифицированностью тулза).

Redacted использует нейтральный тон (не статусный hue) сознательно:
редакция секрета — не «плохое» и не «хорошее» событие, это факт
маскирования; тёплый stone-серый читается как «замок», а не как
предупреждение.

### 1.5 Иконка статуса (опционально, если нужен доп. слой кроме цвета)

Не полагаться только на цвет (WCAG SC 1.4.1): у каждого статуса — своя
форма иконки в бейдже: `✓` allowed, `●` (пульсирующая точка) pending,
`✕` denied, `▲` quarantine, `🔒` redacted.

---

## 2. Типографика

### 2.1 Шрифтовая пара

- **UI (гуманистический гротеск)**: **Inter** (Google Fonts) — нейтральный,
  отличная читаемость на мелких кеглях, широкий набор начертаний.
  Fallback/system-стек (используется по умолчанию, см. ниже про CSP):
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif`.
- **Моно (ID/токены/JSON/диффы)**: **JetBrains Mono** (Google Fonts) —
  чёткое различение `0/O`, `1/l/I`, важно в панели аудита, где путаница
  символов в токене/хеше — инцидент. Fallback: `ui-monospace,
  "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace`.

**Важно про CSP**: текущий `app-css.ts` держит `default-src 'none';
style-src 'self'` и явно не тянет внешние шрифты. Пока `font-src` не
добавлен в CSP (и шрифты не самохостятся как `data:`-URI внутри того же
`'self'`-стилшита), **действующая тема должна использовать только
system-стек** — Google-пара зафиксирована здесь как целевая эстетика на
случай самохостинга (`woff2` инлайнится как base64 в CSS, `font-src`
остаётся `'self'`/`data:`, внешний CDN по-прежнему не используется).

```css
--font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", sans-serif;
--font-mono: ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace;
```

### 2.2 Тип-шкала

| Токен | px | Использование |
|---|---|---|
| `--text-xs` | 12 | Мета, таймстемпы, подпись под числом, текст бейджа |
| `--text-sm` | 13 | Плотный текст таблиц, вторичные UI-подписи |
| `--text-base` | 14 | Базовый текст UI, тело |
| `--text-md` | 16 | Заголовок карточки, значение в форме |
| `--text-lg` | 20 | Заголовок секции, имя сущности (entity header) |
| `--text-xl` | 24 | Заголовок страницы |
| `--text-2xl` | 32 | Крупное число метрики (stat-card) |
| `--text-3xl` | 40 | Hero-число (единственная ключевая метрика экрана, напр. «Pending: 7» в шапке очереди) |

### 2.3 Начертания и межстрочный интервал

| Токен | Значение | Использование |
|---|---|---|
| `--font-weight-regular` | 400 | Тело, таблицы |
| `--font-weight-medium` | 500 | UI-лейблы, пункты навигации, бейджи |
| `--font-weight-semibold` | 600 | Заголовки карточек/секций, entity name |
| `--font-weight-bold` | 700 | Крупные числа метрик (`--text-2xl`/`--text-3xl`) — как в референсе, числа тяжелее заголовков |
| `--line-height-tight` | 1.2 | Крупные числа, entity name |
| `--line-height-heading` | 1.3 | Заголовки |
| `--line-height-body` | 1.5 | UI-текст, тело |
| `--line-height-relaxed` | 1.6 | Длинный текст (описания, пустые состояния) |

Моно-текст (ID, токены, JSON) всегда `--text-sm`/`--text-xs` + `--line-height-body` —
крупный моно на весь экран не нужен, это вспомогательные данные, а не контент.

---

## 3. Форма, пространство, тень

### 3.1 Радиусы

| Токен | px | Использование |
|---|---|---|
| `--radius-sm` | 6 | Чипы дат, мелкие инпуты, код-инлайн |
| `--radius-md` | 10 | Кнопки, поля ввода, popover |
| `--radius-lg` | 16 | Карточки (stat-card, kanban-card, entity header, sunken-полоса метрик) — ключевой референсный радиус |
| `--radius-pill` | 999 | Статус-бейджи, счётчики, фильтр-чипы |

### 3.2 Отступы (шкала 4/8)

| Токен | px |
|---|---|
| `--space-1` | 4 |
| `--space-2` | 8 |
| `--space-3` | 12 |
| `--space-4` | 16 |
| `--space-5` | 20 |
| `--space-6` | 24 |
| `--space-8` | 32 |
| `--space-10` | 40 |
| `--space-12` | 48 |
| `--space-16` | 64 |

### 3.3 Тени

Ivory-стиль почти без теней — глубину даёт разница заливки (white-карточка
на ivory-фоне) и бордер, не тень. Тень зарезервирована для по-настоящему
«плавающих» слоёв (popover, toast, модал).

| Токен | Значение | Использование |
|---|---|---|
| `--shadow-none` | `none` | Карточки по умолчанию (stat-card, kanban-card, таблица) |
| `--shadow-xs` | `0 1px 2px rgba(27,27,24,0.04)` | Лёгкий hover-подъём карточки/строки |
| `--shadow-sm` | `0 4px 16px rgba(27,27,24,0.08)` | Popover, dropdown, toast |
| `--shadow-md` | `0 12px 32px rgba(27,27,24,0.12)` | Модальное окно (approve/deny confirm) |

### 3.4 Фокус-ринг

Обязателен на всех интерактивных элементах (клавиатурная навигация в
консоли аудита — не косметика, а требование).

```css
--focus-ring: 0 0 0 3px rgba(42, 95, 216, 0.35);
--focus-ring-offset: 2px;
```

Применение: `outline: none; box-shadow: var(--focus-ring); outline-offset:
var(--focus-ring-offset);` — не полагаться на цвет каймы отдельно, ring
достаточно широкий (3px) для видимости на ivory и на белой карточке.

---

## 4. Готовый CSS-блок

```css
:root {
  color-scheme: light dark;

  /* ---- Нейтральная база ---- */
  --color-ivory-50: #FAFAF7;
  --color-ivory-100: #F3F3EC;
  --color-ivory-200: #EDEDE3;
  --color-white: #FFFFFF;
  --color-ink-950: #101010;
  --color-ink-900: #1B1B18;
  --color-ink-700: #4A4A44;
  --color-ink-600: #6E6E66;
  --color-ink-300: #B8B8AE;
  --color-ivory-on-dark: #F5F5F0;

  /* ---- Семантические поверхности/текст (переопределить для dark-темы) ---- */
  --bg-page: var(--color-ivory-50);
  --bg-sunken: var(--color-ivory-100);
  --bg-sunken-strong: var(--color-ivory-200);
  --bg-surface: var(--color-white);
  --bg-dark-accent: var(--color-ink-950);

  --text-primary: var(--color-ink-900);
  --text-secondary: var(--color-ink-700);
  --text-muted: var(--color-ink-600);
  --text-on-dark: var(--color-ivory-on-dark);
  --text-on-dark-muted: rgba(245, 245, 240, 0.64);

  --border-default: #E4E4D9;
  --border-strong: #D2D2C4;
  --border-on-dark: rgba(245, 245, 240, 0.16);

  /* ---- Акцент ---- */
  --color-accent: #2A5FD8;
  --color-accent-fg: #FFFFFF;
  --color-accent-bg-soft: #E7EEFC;

  /* ---- Статусы (fg/bg пары, все ≥4.5:1) ---- */
  --status-success-fg: #166534;
  --status-success-bg: #DCFCE7;
  --status-pending-fg: #92400E;
  --status-pending-bg: #FEF3C7;
  --status-danger-fg: #991B1B;
  --status-danger-bg: #FEE2E2;
  --status-quarantine-fg: #6B21A8;
  --status-quarantine-bg: #F3E8FF;
  --status-redacted-fg: #57534E;
  --status-redacted-bg: #E7E5DF;

  /* ---- Диаграммы ---- */
  --chart-bar-solid: var(--color-ink-900);
  --chart-bar-hatch-line: var(--color-ink-900);
  --chart-bar-hatch-gap: transparent;
  --chart-grid-line: rgba(27, 27, 24, 0.08);
  --chart-axis-text: var(--text-muted);
  --chart-gauge-track: var(--bg-sunken-strong);
  --chart-gauge-value: var(--color-ink-900);
  --chart-sparkline-line: var(--color-accent);
  --chart-sparkline-fill: rgba(42, 95, 216, 0.10);

  /* ---- Типографика ---- */
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace;

  --text-xs: 0.75rem;   /* 12px */
  --text-sm: 0.8125rem; /* 13px */
  --text-base: 0.875rem;/* 14px */
  --text-md: 1rem;      /* 16px */
  --text-lg: 1.25rem;   /* 20px */
  --text-xl: 1.5rem;    /* 24px */
  --text-2xl: 2rem;     /* 32px */
  --text-3xl: 2.5rem;   /* 40px */

  --font-weight-regular: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;

  --line-height-tight: 1.2;
  --line-height-heading: 1.3;
  --line-height-body: 1.5;
  --line-height-relaxed: 1.6;

  /* ---- Форма ---- */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-pill: 999px;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;

  --shadow-none: none;
  --shadow-xs: 0 1px 2px rgba(27, 27, 24, 0.04);
  --shadow-sm: 0 4px 16px rgba(27, 27, 24, 0.08);
  --shadow-md: 0 12px 32px rgba(27, 27, 24, 0.12);

  --focus-ring: 0 0 0 3px rgba(42, 95, 216, 0.35);
  --focus-ring-offset: 2px;

  font-family: var(--font-ui);
}

/*
 * Тёмная тема (не реализуется в этой итерации) переопределила бы только
 * блок «Семантические поверхности/текст» + статусы, оставив имена токенов
 * теми же:
 *
 * @media (prefers-color-scheme: dark) {
 *   :root {
 *     --bg-page: #101010;
 *     --bg-surface: #171a21;
 *     --text-primary: #F5F5F0;
 *     ...
 *   }
 * }
 */
```

---

## 5. Спеки компонентов

**Stat-card** — белая карточка `--radius-lg`, паддинг `--space-5`, без
тени (`--shadow-none`), граница `--border-default`. Сверху circular-чип
`40×40px` с line-иконкой (`--bg-sunken`, иконка `--text-secondary`).
Число — `--text-2xl`/`--font-weight-bold`/`--line-height-tight`/`--text-primary`.
Подпись под числом — `--text-sm`/`--text-muted`. Опционально тренд-чип
справа от подписи: стрелка + `%`, цвет из `--status-success-fg` (рост) или
`--status-danger-fg` (падение), без заливки (только текст+иконка).

**Entity header** (шапка сущности: MCP-сервер, агент, тулз-запись в
реестре) — контейнер без карточной рамки, на `--bg-page`. Слева
circular-аватар/иконка-инициал 40px. Имя — `--text-lg`/`--font-weight-semibold`;
под ним подзаголовок/описание — `--text-sm`/`--text-secondary`. Статус —
`status-badge` сразу справа от имени, инлайн. Мета (Created on / entry-point
class / owner) — `--text-xs`/`--text-muted`, выровнена по правому краю
строки заголовка. Под блоком — табы (см. ниже), разделены от контента
`--border-default` снизу.

**Таблица (журнал, реестр, матрица прав)** — без внешней рамки-карточки,
строки разделены `--border-default` (не зебра — зебра на ivory спорит с
sunken-полосой метрик, оставляем контраст только через границы). Плотность:
`--space-2` `--space-3` паддинг ячейки, `--text-sm` для тела. Колонки с
ID/токеном/хешем — `--font-mono`, `--text-xs`, `--text-secondary`, с
`text-overflow: ellipsis` + `title=` полным значением. Заголовок таблицы —
`--text-xs`/`--font-weight-medium`/`--text-muted`/uppercase не делаем (ivory-стиль
избегает капса), просто приглушённый цвет отличает от тела.

**Status badge** — `--radius-pill`, паддинг `4px 10px`, `--text-xs`/`--font-weight-medium`,
fg/bg из статусной пары (§1.4), плюс иконка-глиф статуса слева от текста
(§1.5) — цвет не единственный носитель смысла. Высота 22px, без границы
(заливка уже даёт контраст с карточкой).

**Карточка очереди одобрений** — белая карточка `--radius-lg`, левая
кромка 3px в цвете `--status-pending-fg` (быстрый сигнал в списке без
чтения текста). Тело: агент + вызываемый тулз (`--text-md`/`--font-weight-semibold`),
далее ключевые аргументы вызова в `--font-mono`/`--text-sm` (max 2-3 строки,
дальше — «показать полностью»), таймстемп `--text-xs`/`--text-muted`. Низ
карточки — две кнопки: **Approve** (primary: `--color-accent` фон исключён
специально — approve здесь про безопасность, используем `--status-success-fg`
как фон, `#FFFFFF` текст) и **Deny** (destructive outline: прозрачный фон,
`--status-danger-fg` текст и граница, заливка только на hover/`:active`).
Кнопки равной ширины, `--radius-md`, разделены `--space-2`.

**Kanban-колонка со счётчиком** (карантин по классам риска, либо очередь
по entry-point) — заголовок колонки: имя + счётчик в pill-чипе
(`--bg-sunken`, `--text-secondary`, `--text-xs`, как «12 ↑↓» в референсе,
без стрелок сортировки если не нужна ручная пересортировка). Колонка —
вертикальный список card, gap `--space-3`, фон колонки прозрачный
(карточки сами несут заливку).

**Дифф-блок** (карантин: diff `inputSchema` нового vs текущего тулза) —
`--font-mono`/`--text-sm`, построчно. Добавленная строка: фон
`--status-success-bg`, текст `--status-success-fg`, префикс `+ ` жирным.
Удалённая строка: фон `--status-danger-bg`, текст `--status-danger-fg`,
префикс `- `. Неизменная строка: `--text-secondary` без фона. Контейнер —
`--bg-sunken`, `--radius-md`, паддинг `--space-3`, горизонтальный скролл
при длинных строках (`overflow-x: auto`, не перенос — диффы JSON-путей
не должны ломать выравнивание).

**Фильтр-чипы** (журнал: по статусу/агенту/серверу/периоду) — `--radius-pill`,
паддинг `6px 12px`, `--text-sm`, граница `--border-default`, фон
`--bg-surface`. Активный чип: фон `--color-accent-bg-soft`, граница
`--color-accent`, текст `--color-accent` (не инвертируем в сплошной синий —
чипы часто в ряд, инверсия делает ряд визуально шумным). Внутри активного
чипа — крестик-«снять фильтр» `12px`.

**Sidebar item** — паддинг `8px 12px`, `--radius-md`, `--text-sm`/`--font-weight-medium`,
иконка 18px thin-line слева, `gap: --space-2`. Default: `--text-secondary`,
фон прозрачный. Hover: фон `--bg-sunken`. Active: фон `--bg-sunken-strong`,
текст `--text-primary`, иконка `--text-primary` (референс: `Customers`
активный пункт — светло-серая плашка, не акцентный цвет — в консоли
аудита активный раздел не должен визуально путаться со статусным
акцентом). Бейдж-счётчик справа (непрочитанные approvals и т.п.):
`--radius-pill`, `--bg-sunken-strong`, `--text-xs`, паддинг `2px 7px`; если
count > 0 и раздел — «Approvals», можно заливкой `--status-pending-bg`/`--status-pending-fg`
вместо нейтральной, чтобы очередь одобрений визуально сигналила даже
свёрнутым сайдбаром.

**Тёмный акцентный кард** — использовать **только на одной** карточке
экрана единовременно, как в референсе: (а) в очереди одобрений — карточка
операции с наивысшим риском/самой долгой на ожидании («требует
внимания прямо сейчас»); либо (б) на дашборде — главная метрика (напр.
«Pending: 7»), `--text-3xl` число. Фон `--bg-dark-accent`, текст
`--text-on-dark`/`--text-on-dark-muted` для вторичного, граница
`--border-on-dark`, `--radius-lg`, без тени. Кнопки/бейджи внутри —
статусные fg/bg пары сохраняются (не инвертируются под тёмный фон), кроме
случая, когда сама карточка обозначает pending-статус — тогда достаточно
рамки-акцента, дублировать амбер-бейдж внутри тёмной карточки избыточно.

**Пустые состояния** (журнал без записей, карантин пуст, реестр без
серверов) — центрировано, `--space-10` паддинг сверху/снизу. Иконка 32px
`--text-muted`, заголовок `--text-md`/`--font-weight-semibold`/`--text-primary`
(«Нет ожидающих одобрений»), подпись `--text-sm`/`--text-muted`
(объясняет причину/следующий шаг, не просто «пусто»). Если применим
фильтр — вторичная кнопка «Сбросить фильтры».

---

## 6. Графики

**Штрихованные бары** (доп. серия / «не сегодня» / низкий приоритет —
solid используется для главной точки данных, hatch — для второстепенных,
как в референсе Mon/Wed/Thu):

```css
.chart-bar {
  background: var(--chart-bar-solid);
  border-radius: 2px 2px 0 0;
}

.chart-bar--hatched {
  background: repeating-linear-gradient(
    -45deg,
    var(--chart-bar-hatch-line) 0,
    var(--chart-bar-hatch-line) 1.5px,
    var(--chart-bar-hatch-gap) 1.5px,
    var(--chart-bar-hatch-gap) 5px
  );
  border: 1px solid var(--chart-bar-hatch-line);
  border-bottom: none;
}
```

**Gauge** (полукруг, напр. «% операций, одобренных без эскалации») — трек
`--chart-gauge-track` (широкий stroke, `stroke-linecap: butt`, сегментами
через `stroke-dasharray`, как штрихи на референсе, не сплошная дуга),
значение — `--chart-gauge-value`, тонкая дуга поверх треков через
`stroke-dasharray`/`stroke-dashoffset`. Число в центре — `--text-2xl`/`--font-weight-bold`,
подпись под числом `--text-sm`/`--text-muted`.

**Sparkline** (тренд метрики в stat-card) — линия `--chart-sparkline-line`
1.5px, область под линией `--chart-sparkline-fill` (мягкая заливка, не
градиент до нуля — референс держит графику плоской). Без точек-маркеров
на промежуточных значениях, точка только на последнем (текущем) значении,
2.5px радиус, заливка `--chart-sparkline-line`.

**Оси и сетка** — едва заметные, не соревнуются с данными: `--chart-grid-line`
(8% непрозрачности чёрного) только горизонтальные линии (без вертикальных),
подписи осей `--chart-axis-text`/`--text-xs`, никаких засечек (tick marks),
сама ось не рисуется отдельной линией — только подписи снизу/сбоку.

---

## 7. Открытые решения / на что обратить внимание при реализации

1. **Google Fonts vs CSP**: до появления `font-src` в CSP или самохостинга
   `woff2` как `data:`-URI, использовать `--font-ui`/`--font-mono` как
   заданы (system-стек, Inter/JetBrains Mono только как fallback-имена —
   они не подключены, поэтому browser молча пропустит их и возьмёт
   системный шрифт; это безопасно, а не breaking).
2. **Quarantine = фиолетовый** — решение зафиксировано в §1.4 с
   обоснованием (не путать с pending). Если возникнет доп. статус
   («requires re-review after policy change»), не занимать фиолетовый и
   амбер повторно — следующий свободный различимый hue на этом фоне:
   тёмно-бирюзовый (`teal-800`/`teal-100`), но не проверен на контраст —
   посчитать перед использованием.
3. **`--color-ink-600` заменяет референсный `#7A7A72`** — единственное
   отклонение от прямого «снятия» цвета с скриншота, обосновано в §1.1.
