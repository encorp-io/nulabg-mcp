# NULA.BG: проучване на платформата (2026-09-22)

> Източници: публични страници, блог, spec-ове и `.well-known` endpoint-и. Без регистрация и без вход в системата.
> Непотвърденото е маркирано с **[непроверено]**.

## ⚠️ Основна находка: nula.bg вече има официален MCP сървър („Таня“)

| | |
|---|---|
| Обявен | 20.07.2026 (блог); демо пред 70+ счетоводители през 09.2026 |
| Позициониране | „Първият счетоводен MCP сървър в България“ |
| Endpoint | `https://nula.bg/mcp` (Streamable HTTP, само POST) |
| Auth | OAuth 2.1: issuer `https://nula.bg`, `/oauth/authorize`, `/oauth/token`, **DCR** на `/oauth/register`, PKCE S256, scope `mcp:use`, `authorization_code` + `refresh_token` (**проверено лично** с curl: 401 + `WWW-Authenticate … resource_metadata=…/oauth-protected-resource/mcp`) |
| Много фирми | consent екранът показва фирмите (teams) като checkbox-ове и избор **Read / Read+Write**. При повече от една фирма всяка заявка иска header **`Mcp-Team-Id`**; при една фирма тя се избира автоматично. Токените изтичат след 90 дни (по [installer-а](https://github.com/moynzzz/nula-mcp-installer); **[непроверено]** дали е официален, но е с © Nula EOOD) |
| Собствен клиент | `tanya.nula.bg` (Next.js чат). В bundle-а се споменава OpenAI модел **[непроверено]** |
| Фокус (по блога) | **Анализи за счетоводители:** „Готови ли сме за месечно приключване?“, „Кои фактури не са осчетоводени?“, „Банкови движения без съпоставка?“, „ДДС позицията за месеца?“, „Просрочени задължения?“, „Разходи за маркетинг за тримесечието“ |
| Tools | **Не са публикувани.** Нужен е OAuth вход, за да се види `tools/list` |

**Изводи:**
1. Таня вероятно ползва **вътрешни данни**, които публичното REST API няма: осчетоводяване, ДДС позиция, съпоставки. Там нашето MCP не може да се състезава.
2. Таня е **само remote и само OAuth**, тоест не работи с локални файлове и не е удобна за headless автоматизации.
3. Claude.ai, ChatGPT и Claude Desktop вече могат да се свържат директно с Таня. Затова нашият remote OAuth слой (фаза 3 в SPEC) **губи смисъл**.
4. `Mcp-Team-Id` показва, че бекендът поддържа избор на фирма чрез header. Трябва да се попита дали REST API-то приема същото.

## 1. Какво е NULA

- **Оператор:** Клауд Тек ООД (Cloud Tech Ltd), ЕИК 204733952, Варна. ⚠️ Това е **същият ЕИК, който е пример в API spec-а**, така че не бива да се ползва за тестови фактури.
- **Клиенти:** МСП, стартъпи, фрийлансъри, НПО, **счетоводни кантори**. Над 10 000 фирми, над 2 млн. документа, над 10 000 свързани банкови сметки.

**Модули:**

| Модул | Какво включва | Покрито от публичното API |
|---|---|---|
| Фактуриране | повтарящи се фактури, напомняния, BG/EN, валути | ✅ (create, list, pdf, email, status, edit, delete last) |
| Покупки и разходи с OCR | снимка, имейл, web upload; от 09.2026 и ТРЗ документи (болнични, молби за отпуск) с оценка на разпознаването | ✅ list, create, OCR |
| Банки | open banking синхронизация, bulk плащания (ДСК); **NULA Wallet** (05.2026): EUR сметки с BG IBAN, SEPA Instant | ✅ сметки и транзакции (без плащания) |
| Счетоводство | сметкоплан, ДМА, дневници и декларации по ДДС, ГФО, SAF-T, INTRASTAT, съпоставка с НАП, заключване на година | ❌ (само NRA статуси) |
| ТРЗ | договори, фишове, Д1/Д6, НОИ Прил. 9/10/11 | ~ само НОИ документи |
| Склад и производство | артикули, рецепти, партиди, локации | ~ артикули и наличности (read) |
| Друго | CRM, Smart Drive, ChatCFO, Speedy/Econt наложени платежи, bulk подаване към НАП с B-Trust КЕП | ❌ |

- **Приложения:** web SaaS. Native/desktop приложение (от API spec-а: BISS/КЕП подписване) **[непроверено]**, няма публична страница за сваляне. Мобилно приложение **[непроверено]**.

## 2. Цени (без ДДС, на месец)

| План | Цена | Какво добавя |
|---|---|---|
| Invoice Pro | 9 € (90 €/год.) | неограничено потребители и фактури, повтарящи се фактури, 1 банка, валути |
| Бизнес Старт | 19 € | 2-ра банка, **OCR**, склад, ДДС изчисления |
| Бизнес Премиум | 49 € | неограничено банки, bulk плащания, счетоводство, ТРЗ, AI анализи |
| Счетоводна фирма | 99 € | до 50 клиентски фирми, CRM, е-подаване, 500 OCR/месец |

- Добавки: OCR план 9 €/мес. (200 сканирания за всички фирми на собственика), допълнителни по 0,005 €/документ, Viewer 1,99 €/потребител.
- **Кои планове включват API достъп не е публикувано [непроверено].** Единственото известно ограничение: OCR endpoint-ът връща 403 без OCR право и 402 при изчерпана квота.
- Всяка фирма има собствен абонамент (освен при плана за счетоводни фирми).

## 3. API ключ: как се взема

- **Не е намерено публично описание** на мястото в UI-а. Проверени са сайтът, sitemap, 190 блог поста и YouTube. Помощният център в Intercom връща 404. → **Фаза 0: да се провери в акаунт или да се попита nula.bg.**
- Индиции (изводи):
  - Laravel Passport personal access token (JWT).
  - **Един ключ за един потребител и една фирма (team).** REST spec-ът няма параметър за фирма, но `getBanks?allBanks=1` връща сметките на всички фирми на потребителя.
- Роли в екипа: Администратор, Счетоводител, Служител, Фактуриращ, с права Достъп/Редакция по модули. **[непроверено]** Дали ключът наследява правата на ролята.
- 2FA е задължителен от 04.2026 (засяга OAuth вход, не API ключа).

## 4. Лимити, среди, webhooks, версии

- **Rate limits:** не са документирани, няма `X-RateLimit-*`. Инфраструктурата е зад AWS API Gateway (`apigw-requestid`), така че е възможно throttling **[непроверено]**.
- **Sandbox:** няма публичен.
  - `dev.nula.bg` е достъпен и има собствен spec, но изостава от production (няма `/customers` и native OCR) и не е рекламиран.
  - `ue-varna.nula.bg` е учебна среда (ИУ-Варна).
- **Webhooks:** само per-request `callback_url` (createInvoice опционален, ocr/uploadFile опционален, **createBill задължителен**). Payload, подпис и retry не са документирани.
- **Версии и changelog:** няма. И prod, и dev връщат `version: 1.0.0`, а endpoint-ите се различават. API-то се променя без bump на версията. Единственият changelog са блог постовете „Какво ново“.

## 5. Съществуващи интеграции върху API-то

- Shopify app (2023), nopCommerce plugin (noptech, 49,99 €), **OpenCart** (пилот от 11.2025; оттук `/api/v1/open-cart/*`).
- WooCommerce: само маркетингови споменавания. Zapier, Make, n8n: няма.
- GitHub: няма REST клиенти, само MCP installer-ът.

## 6. Конкурентни MCP сървъри

| Продукт | MCP | Бележка |
|---|---|---|
| **NULA** | ✅ официален (Таня) | remote, OAuth |
| inv.bg | общностен „Inv.bg-MCP“ (Cloudflare Workers, API ключ, 30+ tools) | неофициален |
| Microinvest, Ajur, Плюс-Минус, Fakturi.bg | няма | |
| Официален MCP Registry | нищо за NULA и inv.bg | |

## 7. Домейн правила за AI агента

- **Номерация:** 10 цифри, последователна (чл.114 ЗДДС). При `createInvoice` номерът е незадължителен, при `createBill` е задължителен (номерът на доставчика). Протоколът по чл.117 има собствен номер.
- **Типове:** фактури 0/1/2/3/9/10/11. Протокол за брак не се поддържа от API-то. Покупки: 0/1/2/3/9.
- **ДДС:** ставки 0, 9, 20. При 0% е задължително основание (57 варианта). Покупки: ПДК, ЧДК, БДК, ТРО. Обхватът на 9% се е променял, така че се проверява за всеки артикул. Праг за регистрация по ЗДДС от 2026: **51 130 €**.
- **ЕИК срещу ДДС номер:** `identifier` е ЕИК (при BG). `recipient_vat` е за чуждестранни; без ДДС номер се подава `999999999999999`.
- **Евро (от 01.01.2026):**
  - Фиксиран курс 1,95583.
  - NULA приключи миграцията на 08.01.2026 (салда, ТРЗ, активи).
  - **Фактурите след 31.12.2025 са в EUR.** Двойно показване на фактури не е задължително (то е само за цени към потребители).
  - КИ/ДИ към фактури в BGN от 2025 г. се издават в EUR.
  - **API-то още е „BGN-ориентирано“:** примерите са `BGN`, а `exchange_rate` е „спрямо лева“. `currency_code` е задължителен, затова MCP винаги праща `EUR` по подразбиране. Дали API-то отхвърля BGN за дати от 2026 г. **[непроверено]**.

## Източници
1. https://blog.nula.bg/mcp-accounting-server-bulgaria/ · https://blog.nula.bg/mcp-ai-asistent-za-schetovoditeli/
2. https://nula.bg/.well-known/oauth-authorization-server · https://nula.bg/.well-known/oauth-protected-resource/mcp · https://nula.bg/mcp
3. https://github.com/moynzzz/nula-mcp-installer
4. https://tanya.nula.bg
5. https://nula.bg/terms · https://nula.bg/privacy
6. https://nula.bg/ · https://nula.bg/pricing · https://nula.bg/accounting · https://nula.bg/payroll · https://nula.bg/nula-wallet · https://nula.bg/solutions/accounting-firms
7. https://blog.nula.bg/nula-metrics/ · https://blog.nula.bg/ocr-trz-spidi-ekont-i-plashtaniya/ · https://blog.nula.bg/new-accounting-features-2026/ · https://blog.nula.bg/sklad-i-proizvodstvo/ · https://blog.nula.bg/nap-avtomatizaciya-za-schetovodini-kantori/
8. https://blog.nula.bg/predstavqme-nov-ocr-plan/ · https://blog.nula.bg/viewer-plan/ · https://blog.nula.bg/abonamentni-planove-cenorazpis-sravnenie/
9. https://blog.nula.bg/required-2-factor-authentication/
10. https://dev.nula.bg/docs?api-docs.json · https://blog.nula.bg/nula-university-of-economics-varna-partnership/
11. https://blog.nula.bg/fakturirane-shopify/ · https://nop-tech.com/nulabg-invoice-integration · https://opencartbulgaria.com/nula/
12. https://glama.ai/mcp/servers/unbelievable-digital/Inv.bg-MCP · https://registry.modelcontextprotocol.io/v0/servers
13. https://nra.bg/wps/wcm/connect/agency/site/taxes/dds-v-balgariya/fakturirane · https://blog.nula.bg/bgn-to-eur-migration/ · https://blog.nula.bg/euro-bulgaria-implications/ · https://nra.bg/wps/portal/nra/za-nap/bulgaria_v_eurozonzta/vuprosi-i-otgovori-za-evroto-za-biznesa
