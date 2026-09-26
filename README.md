# nulabg-mcp

MCP сървър за счетоводната платформа [nula.bg](https://nula.bg). Дава на Claude и на други AI асистенти (Claude Desktop, Claude Code, Cursor, VS Code…) достъп до вашите фактури, покупки, OCR, клиенти, склад и банки чрез nula.bg API ключ.

> **Неофициален клиент.** Проектът не е свързан с nula.bg. Работи върху публичното им REST API.

*English: an MCP server for the Bulgarian accounting SaaS nula.bg. Install the `.mcpb` bundle in Claude Desktop or run `npx -y nulabg-mcp` with `NULA_API_KEY` set.*

## Какво може

| Модул (toolset) | Tools | Какво прави |
|---|---|---|
| `core` | `nula_lookup_company` | Справка за фирма по ЕИК или ДДС номер (Търговски регистър / VIES) |
| `invoices` | `nula_search_invoices`, `nula_create_invoice`, `nula_update_invoice`, `nula_update_invoice_metadata`, `nula_get_invoice_pdf`, `nula_email_invoice`, `nula_delete_last_invoice` | Търсене, издаване (с preview), редакция, платена/изпратена, категории, прикачени файлове, PDF, изпращане по имейл, изтриване на последната фактура |
| `bills` | `nula_search_bills`, `nula_create_bill`, `nula_update_bill_categories` | Покупки, вкл. протоколи по чл.117 ЗДДС |
| `ocr` | `nula_ocr_upload`, `nula_ocr_status` | Качване на до 10 документа от диска, изчакване на разпознаването, квота |
| `customers` | `nula_search_customers` | Клиенти и контрагенти |
| `inventory` | `nula_search_items`, `nula_list_item_categories` | Артикули, цени, сметки, наличности |
| `banking` | `nula_list_bank_accounts`, `nula_list_bank_transactions` | Банкови сметки и движения |
| `insights` | `nula_receivables_report`, `nula_period_summary`, `nula_match_bank_transactions` | Вземания с aging, обобщение за месец, предложения за равнение банка ↔ фактура |
| `nra` (изкл.) | `nula_nra_declarations`, `nula_nra_refresh_result` | Статус на декларациите към НАП (без подаване) |
| `noi` (изкл.) | `nula_noi_documents`, `nula_noi_get_document` | Документи към НОИ (Прил. 9/10/11) |

**21 tools** при разрешени промени, **13** в режим само за четене (по подразбиране), **25** с включени `nra` и `noi`.
При няколко фирми се появява и `nula_list_companies`.

Освен това има:
- **Prompts:** `issue-invoice`, `process-receipts`, `month-end-review`, `collect-overdue`.
- **Resources:** основанията за 0% ДДС, основанията за протоколи, всички стойности на enum-ите и PDF на фактура.

Примерни заявки:
- „Издай фактура на ЕИК 123456789 за 10 часа консултации по 60 € без ДДС, платима по банка до 15 дни.“
- „Качи всички PDF-и от ~/Documents/Фактури/Септември като покупки и ми покажи какво е разпознато.“
- „Кои клиенти ми дължат пари от над 30 дни?“
- „Сравни входящите плащания по банковата сметка за септември с неплатените фактури.“

## Инсталация

Нужен е **API ключ от nula.bg**, генериран от вашия акаунт в nula.bg. Ключът дава достъп до данните на фирмата, затова го пазете като парола.

> 🔒 **По подразбиране сървърът е само за четене.** Claude може да търси и чете, но не може да създава, редактира, изпраща или трие нищо в nula.bg. Така тестването и оценката са безопасни. За да разрешите промени, задайте `NULA_READ_ONLY=false` (в Claude Desktop: махнете отметката „Само четене“ в настройките на разширението).

### Claude Desktop (препоръчително)

1. Вземете `nulabg-mcp-<версия>.mcpb`: от [Releases](https://github.com/encorp-io/nulabg-mcp/releases), ако имате достъп до хранилището, или директно от нас (хранилището е частно).
2. Отворете файла с двоен клик (или **Settings → Extensions → Install Extension**).
3. Въведете API ключа. Той се пази в keychain-а на системата. „Само четене“ е включено по подразбиране.

Node.js не е нужен, защото Claude Desktop го съдържа.

### Claude Code

```bash
claude mcp add nulabg --scope user --env NULA_API_KEY=<вашият-ключ> -- npx -y nulabg-mcp
```

С право на промени (след като сте тествали):

```bash
claude mcp add nulabg --scope user --env NULA_API_KEY=<вашият-ключ> --env NULA_READ_ONLY=false -- npx -y nulabg-mcp
```

### Cursor / Windsurf / Claude Desktop (ръчно)

`~/.cursor/mcp.json` или `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nulabg": {
      "command": "npx",
      "args": ["-y", "nulabg-mcp"],
      "env": { "NULA_API_KEY": "<вашият-ключ>" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`. Ключът се иска при стартиране и не се записва във файла:

```json
{
  "inputs": [{ "type": "promptString", "id": "nula-key", "description": "nula.bg API key", "password": true }],
  "servers": {
    "nulabg": {
      "command": "npx",
      "args": ["-y", "nulabg-mcp"],
      "env": { "NULA_API_KEY": "${input:nula-key}" }
    }
  }
}
```

Проверка на ключа от терминала:

```bash
NULA_API_KEY=<вашият-ключ> npx -y nulabg-mcp --check
```

## Настройки

| Променлива | По подразбиране | Описание |
|---|---|---|
| `NULA_API_KEY` | — | API ключ (задължителен, освен ако не ползвате `NULA_PROFILES`) |
| `NULA_READ_ONLY` | **`true`** | Само четене. Промени в nula.bg се разрешават само с изрично `false` (`0`, `no`, `off`). Всяка друга стойност, вкл. грешно изписана, оставя режима само за четене |
| `NULA_TOOLSETS` | `core,invoices,bills,ocr,customers,inventory,banking,insights` | Кои модули да са активни; `all` включва и `nra`, `noi` |
| `NULA_CONFIRM_WRITES` | `elicit` | Потвърждение в клиента преди създаване, изпращане и изтриване (ако клиентът поддържа elicitation); `never` го изключва |
| `NULA_DEFAULT_CURRENCY` | `EUR` | Валута за нови документи |
| `NULA_DEFAULT_LANGUAGE` | `bg` | Език на PDF и имейл (`bg` / `en`) |
| `NULA_DEFAULT_INVOICE_CATEGORY` | — | Категория за нови фактури (nula.bg изисква поне една) |
| `NULA_DOWNLOAD_DIR` | `~/Downloads/nula` | Къде се записват PDF и XML |
| `NULA_FILE_ROOTS` | `~` | Папки, от които може да се качват файлове (разделени с `:`, на Windows с `;`) |
| `NULA_PROFILES` | — | Няколко фирми: `{"firma-a":"ключ1","firma-b":"ключ2"}` или път до JSON файл |
| `NULA_DEFAULT_PROFILE` | `default` или първият | Фирма по подразбиране при `NULA_PROFILES` |
| `NULA_BILL_CALLBACK_URL` | `https://nula.bg/` | Адрес, който nula.bg уведомява след създаване на покупка (вижте „Ограничения“) |
| `NULA_BASE_URL` | `https://nula.bg` | |
| `NULA_TIMEOUT_MS` / `NULA_MAX_CONCURRENCY` / `NULA_LOG_LEVEL` | `30000` / `4` / `info` | |

### Няколко фирми (за счетоводители)

```bash
NULA_PROFILES='{"alfa":"ключ-1","beta":"ключ-2"}' NULA_DEFAULT_PROFILE=alfa npx -y nulabg-mcp
```

Всеки tool получава параметър `company`, а `nula_list_companies` показва наличните фирми без ключовете.

## Безопасност

- **Преглед преди създаване.** `nula_create_invoice` и `nula_create_bill` имат `preview_only`. Асистентът е инструктиран първо да покаже номер, редове и суми и да изчака потвърждение.
- **Потвърждение в клиента.** Създаването, редакцията, изпращането по имейл и изтриването искат изрично „да“ чрез MCP elicitation, когато клиентът го поддържа. Tools, които изпращат или трият, са маркирани като `destructive`, така че клиентите искат одобрение.
- **Изтриване.** nula.bg трие само последната фактура. Tool-ът изисква номера ѝ (`expected_number`), отказва, ако последната е друга, и отказва предварително, ако фактурата е осчетоводена (виж „Ограничения“).
- **Без повторни опити при запис.** Заявки, които създават, променят, изпращат или трият, никога не се повтарят автоматично. При timeout отговорът казва „статусът е неизвестен, проверете преди нов опит“.
- **Файлове.** Четат се само PDF, JPG и PNG (по съдържание, не по разширение), само от `NULA_FILE_ROOTS`, без скрити папки, до 10 MB. URL-и се приемат само `https`, без локални и вътрешни адреси.
- **Ключът.** Не се логва и не се връща в отговори. Логовете отиват в stderr.
- **Само четене по подразбиране.** Докато не зададете изрично `NULA_READ_ONLY=false`, tools, които създават, променят, изпращат или трият, изобщо не се регистрират, така че Claude не може да ги извика. При грешно изписана стойност сървърът остава само за четене.
- **Без подаване към НАП и НОИ.** Подаването на декларации изисква КЕП и не е достъпно през този сървър.

## Ограничения (v0.1)

- **Проверено срещу реален акаунт на 26.09.2026.** Всички 13 read tools и операциите със запис (издаване, редакция, платена/изпратена, PDF, имейл) работят с истински данни. Форматите на отговорите са документирани в [docs/research/nula-api-analysis.md §8–§9](docs/research/nula-api-analysis.md). Единственото, което не минава, е изтриването — виж по-долу. OCR, НАП и НОИ не са тествани, защото ключът няма достъп до тях.
- **OCR, НАП и НОИ изискват ключ с достъп до фирмата.** С ключ, създаден в профила, тези endpoint-и връщат 403 „This token is not scoped to a team you can access“. Останалите модули работят.
- **Артикули:** търсенето по SKU минава през обхождане на каталога, защото `/open-cart/products/{sku}` и `getItemDetails` връщат 404 дори за съществуващи артикули, а филтърът `search` не търси по SKU.
- **Покупка по id:** `/ocr/bill/{id}` работи само за документи, минали през OCR; за останалите сървърът намира покупката в списъка.
- **„Изпратена“ фактура:** nula.bg не връща такъв статус, затова `nula_update_invoice_metadata` иска и двата флага (`is_paid` и `is_sent`) или номера на фактурата.
- **Изтриването на фактура често е невъзможно през API-то.** `DELETE /api/v1/deleteInvoice` се вика без параметри и трие последната издадена фактура, но връща HTTP 403 (с празно съобщение) за осчетоводен документ. Във фирма със счетоводен модул всички фактури излизат с `has_accounting: true`, тоест изтриването не минава и документът се маха ръчно от уеб приложението или с кредитно известие. Tool-ът проверява това предварително, вместо да праща обречена заявка.
- **Callback URL при покупки.** `createBill` изисква `callback_url`. По подразбиране се подава адресът на самия nula.bg, така че данни не излизат към трети страни. Ако имате собствен webhook, задайте `NULA_BILL_CALLBACK_URL`.
- **Липсващи API операции.** nula.bg API няма създаване или редакция на контрагент (клиентът се създава автоматично с първата фактура), GET на фактура по id, справки по ДДС и плащания.

## Разработка

```bash
npm install
npm run build        # TypeScript → dist/
npm test             # unit + протоколни тестове (Vitest, фалшив nula.bg API)
npm run lint         # Biome
npm run inspect      # MCP Inspector срещу dist/cli.js
npm run pack:mcpb    # Claude Desktop bundle → nulabg-mcp-<версия>.mcpb
node dist/cli.js --list-tools
```

Стек:
- TypeScript;
- `@modelcontextprotocol/server` 2.x (MCP spec 2026-07-28, съвместим и с клиенти от 2025 г.);
- zod 4;
- Node.js ≥ 20.

Архитектура и решения: [docs/SPEC.md](docs/SPEC.md). Проучване: [docs/research/](docs/research/).

**Release:** стъпките и предварителните проверки са в [docs/RELEASING.md](docs/RELEASING.md). Накратко: вдигате версията в `package.json`, обновявате [CHANGELOG.md](CHANGELOG.md) и пускате tag `vX.Y.Z`; GitHub Actions публикува в npm с provenance, прикачва `.mcpb` към GitHub Release и обновява MCP Registry.

## Лиценз

MIT
