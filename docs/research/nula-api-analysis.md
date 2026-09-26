# NULA.BG API: технически анализ

> **Обновено на 2026-09-26 с резултатите от проверка срещу живото API — виж §8.**
>
> Източник: OpenAPI 3.0 spec от `https://nula.bg/docs?api-docs.json` (L5-Swagger / Laravel),
> изтеглен на 2026-09-22. Snapshot: [`nula-openapi.snapshot-2026-09-22.json`](nula-openapi.snapshot-2026-09-22.json).
> UI на документацията: https://nula.bg/api/documentation

> **Отделно от REST API-то** nula.bg има и официален MCP сървър („Таня“) на `https://nula.bg/mcp` с OAuth 2.1 (DCR, scope `mcp:use`, header `Mcp-Team-Id` за избор на фирма). Виж [nula-platform.md](nula-platform.md).

## 1. Обща картина

| Параметър | Стойност |
|---|---|
| Base URL | `https://nula.bg` (в spec-а няма `servers`, пътищата са абсолютни `/api/...`) |
| Формат | JSON (`application/json`); upload-ите са `multipart/form-data`; PDF-ите са `application/pdf` |
| Автентикация | `Authorization: Bearer <token>`. Securityscheme е `bearerAuth` с `bearerFormat: JWT`, което подсказва Laravel Passport или Sanctum personal access token |
| Версии | Две фамилии: `/api/v1/*` (класическото публично API) и `/api/native/v1/*` (API-то на native/desktop приложението на НУЛА) |
| Брой операции | 37 операции в 36 пътя, разделени в 9 тага |
| Схеми (`components.schemas`) | **Няма.** Всички модели са inline, а отговорите на повечето list/get endpoint-и **не са документирани** (`data: "[Success]"`) |
| Tenancy | „Team“, т.е. фирма/организация (вероятно Laravel Jetstream teams). Endpoint-ите работят в контекста на „authenticated team“ |

### Проверено на живо (без ключ, 2026-09-22)

```
GET /api/v1/customers (без токен или с невалиден токен)
→ HTTP 401, Content-Type: application/json
→ {"message":"Unauthenticated.","statusCode":403,"errors":"Unauthenticated."}
```

- **HTTP статусът и `statusCode` в тялото се разминават** (401 срещу 403). Клиентът трябва да гледа HTTP статуса.
- Липсват `X-RateLimit-*` headers поне при неавтентикирани заявки. Лимитите остават **неизвестни**.
- API-то връща JSON и без `Accept: application/json`, тоест няма redirect към login.

## 2. Каталог на endpoint-ите

Легенда: 🟢 read-only · 🟡 запис (добавя) · 🟠 промяна · 🔴 необратимо/деструктивно/външен ефект

### 2.1 Invoice: продажби (фактури)

| # | Метод и път | Какво прави | Бележки за MCP |
|---|---|---|---|
| 1 | 🟢 `GET /api/v1/getInvoices` | Списък фактури с филтри | Query: `daterange` (`YYYY-MM-DD_YYYY-MM-DD`), `page`, `type` (0 проформа, 1 фактура, 2 ДИ, 3 КИ; празно = всички без проформи), `name`, `identifier` (ЕИК), `vat_number`, `number`. **Формата на отговора не е документиран** |
| 2 | 🟢 `GET /api/v1/getInvoicesByNumber?number=` | Фактури по номер | `number` е задължителен. Единственият начин да се вземе „една фактура“, защото **няма GET по id** |
| 3 | 🟢 `GET /api/v1/getNextInvoiceNumber?type=` | Следващ свободен номер | `type`: 0 проформа, 1 фактура. Взема предвид серията, настроена в профила |
| 4 | 🟢 `GET /api/v1/invoices/{id}/getInvoicePDF?in_english=0\|1` | PDF на фактура | Връща `application/pdf` (binary) |
| 5 | 🟡 `POST /api/v1/createInvoice` | Създава фактура | Виж §3.1. **Създава контрагент** по ЕИК/ДДС номер, ако липсва, и **създава артикули**, освен ако `only_search=1`. Опционален `callback_url` превключва към async (background job) |
| 6 | 🟠 `PATCH /api/v1/editInvoice/{id}` | Редакция | Въпреки PATCH изисква **пълния обект** (същите required полета като create, вкл. `items` и `tags`), т.е. на практика е PUT |
| 7 | 🟠 `PATCH /api/v1/setInvoiceStatus/{id}` | Платена/изпратена | Body: `set_as_paid` и `set_as_sent`, **и двете задължителни** (0/1) |
| 8 | 🟠 `POST /api/v1/invoice/{id}/category` | Сменя само таговете (категории) | Body: `tags: string[]`. При грешка връща 422 |
| 9 | 🟡 `POST /api/v1/invoice/{id}/attachFile` | Прикача файл | Body: `media` като base64 низ |
| 10 | 🔴 `GET /api/v1/invoice/{id}/email` | **Изпраща фактурата по имейл** | **GET със страничен ефект.** Query: `email`*, `send_attached_files`* (0/1), `send_in_english`* (0/1), `note`, `attach_type` (`link`\|`file`) |
| 11 | 🔴 `DELETE /api/v1/deleteInvoice` | **Изтрива ПОСЛЕДНАТА фактура** | Няма параметри и няма id. Трие последната фактура на екипа (заради последователната номерация по ЗДДС) |
| 12 | 🟢 `GET /api/v1/getCompanyDetails` | Справка за фирма (ЕИК или VIES) | Query: `bulgarian_recipient`* (1 = BG, 0 = друга държава от ЕС), `identifier`, `company_name`, `recipient_vat` (задължителен извън BG). Тагнат е като Invoice, но по смисъл е lookup |

### 2.2 Bill: покупки (входящи фактури)

| # | Метод и път | Какво прави | Бележки за MCP |
|---|---|---|---|
| 13 | 🟢 `GET /api/v1/bills` | Списък покупки | Същите филтри като при фактурите (`daterange`, `page`, `name`, `identifier`, `vat_number`, `number`), но за **доставчика**. Отговорът не е документиран |
| 14 | 🟡 `POST /api/v1/createBill` | Създава покупка | Виж §3.2. **`callback_url` е задължителен**, което подсказва асинхронна обработка (отворен въпрос). Поддържа протоколи по чл.117 ЗДДС (`protocol_number`, `protocol_date`, `protocol_reason` 1–32) |
| 15 | 🟠 `POST /api/v1/bill/{id}/category` | Сменя таговете на покупка | `tags: string[]` |
| 16 | 🟡 `POST /api/v1/ocr/uploadFile` | OCR на файл (legacy) | multipart: `file` (PDF/PNG/JPG), `callback_url`, `scan_items` (0/1). Връща `upload_id` |
| 17 | 🟢 `GET /api/v1/ocr/bill/{id}` | Покупка + редове след OCR | **Единственият документиран response с пълна схема** (виж §4) |

### 2.3 Customer: контрагенти

| # | Метод и път | Какво прави | Бележки |
|---|---|---|---|
| 18 | 🟢 `GET /api/v1/customers?search=&page=` | Списък с пагинация | `search` търси по име, ЕИК или ДДС номер |
| 19 | 🟢 `GET /api/v1/customers/{id}` | Един контрагент | 404 → `errors: "Клиентът не беше намерен"` |

> ⚠️ **Няма endpoint за създаване или редакция на контрагент.** Контрагенти се създават само косвено през `createInvoice` (полетата `recipient_*`).

### 2.4 Bank: банки

| # | Метод и път | Какво прави | Бележки |
|---|---|---|---|
| 20 | 🟢 `GET /api/v1/getBanks?allBanks=0\|1` | Банкови сметки | `allBanks=1` връща сметките на **всички екипи на потребителя**, `0` само на текущия екип. Това е индикация, че токенът е на ниво потребител с „текущ“ екип |
| 21 | 🟢 `GET /api/v1/transactions/{id}/getTransactions` | Транзакции по сметка | Query: `from`, `to` (`Y-m-d`), `page` |

### 2.5 Items и OpenCart: артикули и склад

| # | Метод и път | Какво прави | Бележки |
|---|---|---|---|
| 22 | 🟢 `GET /api/v1/getItemDetails?name=&sku=` | Детайли за артикул | Примерен отговор: `name, sku, english_name, purchase_account ("304 - …"), purchase_price, sale_account ("702 - …"), sale_price, is_tracked, available_quantity` |
| 23 | 🟢 `GET /api/v1/open-cart/products` | Каталог продаваеми артикули | `per_page` (≤100, по подразбиране 50), `page`, `search` (SKU/баркод/име), `name`. **Добре документиран**, с `meta` за пагинация |
| 24 | 🟢 `GET /api/v1/open-cart/products/{sku}` | Един продукт по SKU/баркод | 404 → `errors.sku[]` |
| 25 | 🟢 `GET /api/v1/open-cart/categories` | Категории (тагове с поне 1 артикул) | `per_page`, `page`; двуезични имена (`bg`, `en-gb`) |

> OpenCart endpoint-ите всъщност са **най-добре документираното read API за номенклатурата** (наличности, цени, категории). В MCP ги представяме като общ „inventory“, не като OpenCart-специфични.

### 2.6 OCR (native)

| # | Метод и път | Какво прави | Бележки |
|---|---|---|---|
| 26 | 🟢 `GET /api/native/v1/ocr/uploads?since=` | OCR качвания, най-новите първи | `since` (ISO 8601) връща само промените. **Параметърът не е деклариран в spec-а** |
| 27 | 🟡 `POST /api/native/v1/ocr/uploads` | Изпраща документи за OCR | `file` или `files[]` (≤10) и `document_type` (`bill`\|`invoice`). Отговаря с **201**; **402** при изчерпани сканирания; **403** ако екипът няма OCR. Body-то не е формално описано |
| 28 | 🟢 `GET /api/native/v1/ocr/uploads/{type}/{id}` | Пълният извлечен документ с редовете | `type` ∈ `bill`, `invoice`. Path параметрите не са декларирани |
| 29 | 🟢 `GET /api/native/v1/ocr/quota` | Оставащи сканирания | Безплатен лимит, използвани в цикъла, купени кредити. `known=false`, ако не могат да се определят |

### 2.7 NRA (НАП): декларации

| # | Метод и път | Какво прави | Бележки |
|---|---|---|---|
| 30 | 🟢 `GET /api/native/v1/nra/declarations` | Всички подавания (най-новите първи) | ⚠️ Отговорът **съдържа base64 съдържанието на файловете**, т.е. може да е огромен |
| 31 | 🟢 `GET /api/native/v1/nra/declarations/{submission}/sign-payload` | BORICA BISS payload за подпис с КЕП | 422, ако не е чернова |
| 32 | 🔴 `POST /api/native/v1/nra/declarations/{submission}/submit` | **Подава подписана декларация в НАП** | Приема raw BISS подписи и сертификат, сглобява PKCS#7 и подава. Body-то не е документирано |
| 33 | 🟠 `POST /api/native/v1/nra/declarations/{submission}/submitted` | Записва резултат от подаване, направено извън web | Body-то не е документирано |
| 34 | 🟠 `POST /api/native/v1/nra/declarations/{submission}/refresh-result` | Проверява отново резултата в НАП | 503, ако НАП не отговаря. Идемпотентно |

### 2.8 NOI (НОИ): болнични и майчинство, Приложения 9/10/11

| # | Метод и път | Какво прави | Бележки |
|---|---|---|---|
| 35 | 🟢 `GET /api/native/v1/noi/documents` | Списък документи по отпуски | Тип, период, служител, статус, входящ номер |
| 36 | 🟢 `GET /api/native/v1/noi/documents/{leave}/xml` | XML (BPril9/10/11), base64 | |
| 37 | 🟢 `GET /api/native/v1/noi/documents/{leave}/result-pdf` | PDF с резултата от НОИ | |

## 3. Модели на заявките за запис

### 3.1 `createInvoice` (и `editInvoice`)

Задължителни: `bulgarian_recipient`, `recipient_company_name`, `payment_method`, `invoiced_at`, `created_at`, `currency_code`, `vat_amount`, `price_type`, `items`, `tags`.

| Поле | Тип (spec) | Значение | Проблем |
|---|---|---|---|
| `identifier` | integer | ЕИК; задължителен при `bulgarian_recipient=1` | ЕИК може да започва с 0, затова трябва да се праща като **string** |
| `bulgarian_recipient` | int 0/1 | BG или чуждестранен контрагент | boolean като int |
| `recipient_vat` | string | ДДС номер; задължителен при чуждестранен. `999999999999999`, ако няма | магическа стойност |
| `recipient_company_name` | string | Име | |
| `recipient_address/post_code/city/country` | string | Използват се **само при създаване** на нов контрагент | |
| `number` | integer | Номер; ако липсва, се генерира | пример `"0000000001"`: водещи нули → **string** (10 цифри) |
| `payment_method` | int | 1 банка, 2 брой, 3 карта, 4 наложен платеж, 5 пощенски паричен превод | |
| `type` | int | 0 проформа, 1 фактура, 2 ДИ, 3 КИ, 9 протокол, 10 протокол лични нужди, 11 протокол начисляване ДДС | протокол за брак не се поддържа |
| `invoiced_at` | `dd.mm.yyyy` | Дата на данъчно събитие | нестандартен формат |
| `created_at` | `dd.mm.yyyy` | Дата на издаване | |
| `due_at` | `dd.mm.yyyy` | Падеж | |
| `vat_amount` | int | **ДДС ставка** (0/9/20), а не сума! | подвеждащо име |
| `currency_code` | string | Валута | примерите са `BGN`, но от 01.01.2026 България е в еврозоната → **да се провери** |
| `IBAN` | string | Сметка; по подразбиране първата | |
| `price_type` | int | 1 = цените са с ДДС, 0 = без ДДС | |
| `paid_amount` | double | Предплатена сума | |
| `exchange_rate` | decimal | Курс при чужда валута | |
| `no_vat_reason` | int 1–57 | Основание за 0% (чл.113 ал.9, чл.28, …, чл.131б ЗДДС) | задължително при ставка 0 |
| `different_vats` | int 0/1 | Различни ставки по редове | |
| `tags` | string[] | Категория | **задължително** |
| `oss_country` | string | ISO-2 държава за OSS режим | |
| `file` | base64 data-URI | Прикачен файл | |
| `callback_url` | string | Ако е подаден → async обработка и резултат на URL-а | MCP (stdio) не може да приема callback-и |
| `items[].name`* | string | | |
| `items[].sku` | string | | |
| `items[].only_search` | 0/1 | 1 = не създава артикул, само търси; грешка, ако не го намери | |
| `items[].item_type`* | int | 1 = 701 продукция, 2 = 702 стоки, 3 = 703 услуги, 4 = 412 аванси | |
| `items[].quantity`* | **integer** | | вероятно грешка в spec-а (дробни количества?) → да се провери |
| `items[].price`* | double | Единична цена | |
| `items[].description`* | string | | задължително |
| `items[].vat_amount` | int | Ставка на реда (при `different_vats=1`) | |

Отговор (пример): `data: ['id' => 1, 'number' => '0000000001']`, т.е. връща `id` и `number`.

### 3.2 `createBill`

Задължителни: `callback_url`, `bulgarian_recipient`, `recipient_company_name`, `payment_method` (само 1–3), `billed_at`, `created_at`, `currency_code`, `vat_amount`, `price_type`, `items`, `number`.

Разлики спрямо `createInvoice`:
- `number` е **задължителен** (номерът на входящата фактура на доставчика).
- `vat_period` (`yyyy-mm`) определя ДДС периода на отчитане.
- `type`: 0, 1, 2, 3, 9.
- `items[]`: `purchase_account_code`* (разходна сметка, напр. 304, 602…), `sale_account_code`, `tracked`* (0/1), `unit_name`* (мярка), `vat_type` (1 ПДК, 2 ЧДК, 3 БДК, 4 ТРО), `vat_amount` (тук е **СУМА**, не ставка!), `search_only_by_sku`.
- Протокол по чл.117: `protocol_number`, `protocol_date`, `protocol_reason` (1–32: ВОП, внос, чл.82 и т.н.).
- Отговор: `['id', 'number', 'protocol_number']`.

## 4. Модели на отговорите: какво знаем

| Endpoint | Документирано? |
|---|---|
| `GET /api/v1/ocr/bill/{id}` | ✅ `data{document_type, invoice_number, date (dd.mm.yyyy), vendor_identifier, vendor_vat_id, vat_amount, vat_value, total_amount, currency, iban, code}`, `items[]{code, description, unit, quantity, unit_price, amount}` |
| `GET /api/v1/open-cart/*` | ✅ пълна схема + `meta{current_page, per_page, total, last_page}` |
| `GET /api/v1/getItemDetails` | ~ само пример в PHP синтаксис |
| create* | ~ `id`, `number` (в PHP синтаксис) |
| Всички останали (`getInvoices`, `bills`, `customers`, `getBanks`, `getTransactions`, `getCompanyDetails`, native/*) | ❌ `data: "[Success]"` или изобщо без content |

> **Извод:** преди имплементацията е нужна **Phase 0: discovery с реален API ключ** (тестова фирма). Записваме реалните отговори като анонимизирани fixtures и от тях генерираме zod схемите.

## 5. Особености, които MCP слоят трябва да скрие

| # | Особеност | Решение в MCP |
|---|---|---|
| Q1 | 4 различни формата за дати (`dd.mm.yyyy`, `YYYY-MM-DD_YYYY-MM-DD`, `Y-m-d`, `yyyy-mm`, ISO 8601) | MCP приема **само ISO `YYYY-MM-DD`** (и `YYYY-MM` за период) и конвертира |
| Q2 | Boolean флагове като 0/1 | MCP използва `boolean` |
| Q3 | Числови enum-и (payment_method, type, item_type, vat_type, no_vat_reason…) | MCP използва **четими string enum-и** (`"bank_transfer"`, `"credit_note"`, `"services"`…) и ги мапва |
| Q4 | Номера и ЕИК-та с водещи нули са типизирани като integer | string + regex валидация + zero-pad на номерата до 10 цифри |
| Q5 | `vat_amount` значи ставка в едни места и сума в други | MCP разделя на `vat_rate` и `vat_sum` |
| Q6 | RPC стил (`getInvoices`, `editInvoice`), смесен с REST | скрито зад tool имена |
| Q7 | GET със страничен ефект (имейл) | tool с `destructiveHint`/`openWorldHint` + потвърждение |
| Q8 | DELETE на „последната“ фактура без id | guard: tool-ът изисква `expected_number` и първо проверява коя е последната |
| Q9 | „PATCH“ изисква пълния обект | tool-ът прави read-modify-write (ако отговорът на get съдържа всичко) или изисква пълния обект |
| Q10 | Няма GET invoice/bill по id | get по номер; bill през `/ocr/bill/{id}` (да се провери дали работи и за не-OCR покупки) |
| Q11 | Няма idempotency key на create | **без автоматичен retry на POST**; pre-check за дубликат по номер |
| Q12 | `createBill` изисква `callback_url` | Отворен въпрос към nula.bg. Варианти: (а) синхронният отговор вече съдържа `id`, (б) remote MCP хоства callback endpoint, (в) polling по `bills` |
| Q13 | HTTP статус ≠ `statusCode` в тялото | вярваме на HTTP статуса |
| Q14 | `errors` е string или обект `{field: [msg]}` | нормализираме; при 422 мапваме API полетата обратно към имената на MCP параметрите |
| Q15 | NRA list връща base64 файлове | режем ги от списъка; отделен tool ги сваля при нужда |
| Q16 | Недокументирани body-та на native endpoint-ите | Phase 0 (reverse с реален ключ) или въпрос към nula.bg |
| Q17 | Валута BGN в примерите, а `exchange_rate` е „спрямо лева“, след приемането на еврото (фактурите след 31.12.2025 са в EUR) | `EUR` по подразбиране, изпраща се винаги (`currency_code` е задължителен); дали API-то отхвърля BGN за дати от 2026 г. се проверява във фаза 0 |
| Q18 | Токенът най-вероятно дава **пълен достъп** до акаунта (без scopes) | read-only режим в MCP, toolsets, потвърждения |

## 6. Какво API-то НЕ позволява (gap-ове)

- Създаване или редакция на **контрагент** (само косвено през фактура)
- **GET фактура по id**; редакция или изтриване на **покупка**
- Списък на **всички артикули** с отчетни данни (частично покрит от OpenCart products)
- **Справки**: дневници по ДДС, оборотна ведомост, ОПР/баланс, вземания/задължения
- **Плащания и равнение** (свързване на банкова транзакция с фактура)
- **Каса**, **ТРЗ** (освен НОИ документите), **ДМА**
- Endpoint тип „кой съм аз / коя фирма“ (whoami) за валидиране на ключа
- Webhooks (освен per-request `callback_url`)

Тези gap-ове са полезни като списък с feature requests към nula.bg. Част от тях MCP-то компенсира с изчисления от наша страна (напр. „неплатени и просрочени фактури“ от `getInvoices`).

## 8. Проверено срещу живото API (2026-09-26)

Извикахме всички read endpoint-и с реален API ключ на действаща фирма (само четене, нищо не е създавано).
Скриптове: `scripts/capture-shapes.mjs` (структура на отговорите) и `scripts/live-read-check.mjs` (всички
read tools през MCP протокола). Резултатите по-долу заменят предположенията от §4 и §5.

### 8.1 Формат на списъците (най-важната разлика)

`data` **не е Laravel paginator**, а обект с числови ключове:

```jsonc
{ "statusCode": 200, "message": "OK",
  "data": { "0": {…}, "1": {…}, /* … до 99 */ "current_page": 1, "next_page": 2, "last_page": 4 } }
```

- Страницата е **фиксирана на 100 записа**; `per_page` и `total` липсват.
- `next_page` е `null` на последната страница.
- `GET /api/v1/getBanks` връща **масив в масив**: `data: [[ {сметка}, … ]]`.
- `GET /api/v1/getInvoicesByNumber` връща `data` като **масив**, но със **съкратен запис**
  (`id`, `number`, `type`, `created_at`, `has_accounting`) — без редове и суми. За пълния документ
  се ползва `GET /api/v1/getInvoices?number=…`, който връща целия запис с `items`.

### 8.2 Полета на фактура (`getInvoices`)

| Поле | Значение |
|---|---|
| `amount` | **сума без ДДС**, във валутата на документа |
| `vat_value` | сумата на ДДС (string), във валутата на документа |
| `amount_in_default_currency`, `total_amount_in_default_currency` | същите суми, **преобразувани във валутата на фирмата** (проверено с фактура в USD: коефициент 0,8627) |
| `vat_amount` | **ставката** (20, 9, 0) |
| `status` / `status_id` | `Paid` (4), `Unpaid` (1), `Partially paid` (5), `Invalid` (9) — на английски |
| `price_type` | `with_vat` / `without_vat` |
| `payment_method` / `payment_method_id` | текстов етикет (`Bank transfer`, `By card`) и код |
| `invoiced_at` | `YYYY-MM-DD` (данъчно събитие) |
| `created_at` | ISO timestamp (дата на издаване) |
| `due_at` | `YYYY-MM-DD` |
| `customer` | обект: `id`, `name`, `identifier`, `vat_number`, `city`, `post_code`, `country`, `address`, `company`, `contacts` |
| `recipient` | име на клиента като текст |
| `items[]` | `id`, `item_id`, `name`, `sku`, `description`, `quantity`, `price`, `unit_weight`, `discount_amount`, `discount_type`, `vat_amount` |
| други | `number` (10 цифри), `type`, `vat_period`, `has_different_vats`, `no_vat_reason(_text)`, `IBAN`, `note`, `exchange_rate`, `created_by_user` |

⚠️ **Няма поле за „изпратена“.** Статусът покрива само плащането, така че `is_sent` не може да се прочете.
⚠️ **Няма категории/тагове** в отговора на списъка.

### 8.3 Покупки (`bills`)
Като фактурите, но с `vendor` вместо `customer`, `billed_at` вместо `invoiced_at`, плюс `has_eu_vat` и
`requires_additional_doc`. Редовете имат и `vat_type`. Статусите са същите три (+ `Partially paid`).

`GET /api/v1/ocr/bill/{id}` връща **404 за покупки, които не са създадени през OCR**. MCP-то затова
търси id-то в списъка (до 5 страници), който също съдържа редовете.

### 8.4 Банки и транзакции
- Сметка: `id`, `IBAN`, `name`, `BIC`, `balance`, `currency_code`, `enabled`, `is_default`, `iris_pay_iban_id`, `consent_status`, `consent_valid_until`.
- Транзакция: `id`, `amount` (винаги положителна), `currency_code`, **`operation`: `Кредит` / `Дебит`** (посоката), `counterparty_name`, `counterparty_bank_name`, `counterparty_bank_account`, `description`, `value_date` (ISO timestamp).

### 8.5 Артикули
- `GET /api/v1/open-cart/products` работи и съвпада с документацията (`meta` с `current_page`, `per_page`, `total`, `last_page`).
- **`GET /api/v1/open-cart/products/{sku}` връща 404 дори за съществуващ артикул** (пробвано и със `sku`, и с `model`).
- **`GET /api/v1/getItemDetails` връща 404** и по `sku`, и по `name` — вероятно се отнася за друга номенклатура.
- Филтърът `search=` **не търси по SKU или model** (0 резултата); `name=` работи.
- Затова MCP-то търси по SKU локално, обхождайки страниците на каталога.

### 8.6 `getCompanyDetails`
Връща `identifier`, `name`, `legal_form_short`, `vat`, `vat_id`, `managers`, **`аddress` (с кирилско „а“)**, `last_update`.

### 8.7 Автентикация и достъп
- Ключът е с формат `<id>|<таен низ>` (Laravel Sanctum), а не JWT.
- **Native endpoint-ите (`/api/native/v1/*`: OCR, НАП, НОИ) връщат 403 „This token is not scoped to a team you can access.“** Ключ, създаден в профила, работи за `/api/v1/*`, но не и за тях. Отворен въпрос към nula.bg: как се създава ключ с достъп до фирмата за native endpoint-ите.
- Няма `X-RateLimit-*` headers; при около 40 заявки в рамките на минута не се появи 429.

### 8.8 Скорост (реален акаунт, ~400 фактури и ~300 покупки за година)
`getInvoices` 1,7–2,1 s · `bills` 1,2–1,6 s · `customers` 0,8–1,1 s · PDF 1,4 s · останалите 0,3–0,7 s.
Изчислените справки обхождат страници: вземания ≈ 3,6 s, равнение с банката ≈ 8 s.

## 9. Проверено със запис (2026-09-26, с изрично разрешение на собственика)

Издадена, редактирана, изпратена по имейл и (опит за) изтрита една тестова фактура на реална фирма.
Скрипт: `scripts/live-write-check.mjs` (изисква `--yes` и `--email`).

| Стъпка | Endpoint | Резултат |
|---|---|---|
| Създаване | `POST /api/v1/createInvoice` | ✅ Връща `{id, number}`. Контрагентът е разпознат по ЕИК; артикулът е създаден автоматично (`item_id`) |
| Прочитане | `GET /api/v1/getInvoices?number=` | ✅ Пълният документ с редовете |
| Редакция | `PATCH /api/v1/editInvoice/{id}` | ✅ Заменя целия документ (количеството от 1 на 2 → сумата от 12,00 на 24,00 €) |
| Платена | `PATCH /api/v1/setInvoiceStatus/{id}` | ✅ `status` става `Paid` (`status_id` 4) |
| PDF | `GET /api/v1/invoices/{id}/getInvoicePDF` | ✅ 146 KB PDF |
| Имейл | `GET /api/v1/invoice/{id}/email` | ✅ Изпратен успешно |
| Изтриване | `DELETE /api/v1/deleteInvoice` | ❌ **HTTP 403 с празно тяло** |

### Изтриването е по-ограничено, отколкото пише в документацията
- Фактурата **беше последната** в серията (следващият номер стана 524), тоест guard-ът работи правилно.
- 403 се получава и след като фактурата се маркира като неплатена.
- `GET /api/v1/getInvoicesByNumber` показва **`has_accounting: true`** за нея, тоест документът е **осчетоводен**. Това е най-вероятната причина за отказа.
- MCP-то вече проверява `has_accounting` **преди** заявката и връща обяснение, вместо да предизвиква безсмислен 403. Мапингът на грешките също обяснява 403 от този endpoint.
- **Проверка на още 6 последователни фактури: всички са с `has_accounting: true`.** Във фирма със счетоводен модул документите се осчетоводяват автоматично, тоест `deleteInvoice` на практика **никога не минава** там. Повторен опит след размаркиране като платена също дава 403.
- Отворен въпрос към nula.bg: как се изтрива последната фактура през API-то, ако е осчетоводена (има ли „отосчетоводяване“ или параметър)? Ако отговорът е „не може“, тогава документацията на endpoint-а трябва да го каже, а практическата алтернатива е кредитно известие.

### Други наблюдения
- `created_at` в отговора е `2026-09-25T21:00:00Z` за дата на издаване 26.09.2026, тоест полунощ софийско време, записана в UTC. Преобразуването по Europe/Sofia дава правилната дата.
- `items[].vat_amount` се връща `null`, когато фактурата е с една ставка.
- `recipient` първо съдържаше името на управителя, а след редакцията стана празно. Затова името на клиента се чете от обекта `customer`, не от `recipient`.
- Отговорът съдържа и обекта `bank` с IBAN и **салдо** на сметката по подразбиране: още една причина `detailed`/`raw` да не влиза в списъците.
