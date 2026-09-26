# Принос към nulabg-mcp

Благодарим за интереса. Issues и pull requests са добре дошли — на български или на английски.

*In English: contributions are welcome. The codebase, comments and tool descriptions are in English; the README and docs are in Bulgarian. Run `npm ci && npm run lint && npm run typecheck && npm test` before opening a pull request.*

## Какво помага най-много

- **Несъответствия с истинското API.** nula.bg документира почти никакви отговори, затова форматите са реверс-инженерни от реален акаунт ([docs/research/nula-api-analysis.md §8–§9](docs/research/nula-api-analysis.md)). Ако при вас поле идва с друго име, тип или стойност, отворете issue с **имената на полетата и типовете, без истински данни**.
- **Ограниченията в README → „Ограничения“.** Ако някое от тях вече не важи (например изтриване на осчетоводена фактура или SKU справка), кажете.
- **Липсващи endpoint-и** от [публичната документация](https://nula.bg/api/documentation), които биха били полезни като tool.

## Локална настройка

```bash
npm ci
npm run build          # TypeScript → dist/
npm test               # Vitest срещу фалшив nula.bg API — не иска ключ и мрежа
npm run lint           # Biome (форматиране + линт)
npm run typecheck
```

Преди pull request: `npm run lint && npm run typecheck && npm test`. Форматирането се оправя с `npm run format`.

Ръчна проверка през MCP протокола:

```bash
NULA_API_KEY=<ключ> node dist/cli.js --check
NULA_API_KEY=<ключ> node dist/cli.js --list-tools
npm run inspect        # MCP Inspector
```

## Правила за код

- **TypeScript**, ESM, Node ≥ 20. Кодът, коментарите и описанията на tools са на **английски**; README и `docs/` — на български.
- **Един tool = един файл-раздел в `src/tools/`.** Регистрацията минава през `define.ts` (`ok`, `fail`, `applyLimit`, `fitItems`), за да са отговорите с еднаква форма и в рамките на лимита от 20 000 символа.
- **Всеки отговор има и `structuredContent`, и кратко човешко резюме.** Файловете се връщат като `resource_link`, не като вграден blob.
- **Нормализацията е на едно място** — `src/nula/normalize.ts`. Нов endpoint не бива да носи формата си нагоре към tool-а.
- **Анотации.** Read tools са `readOnlyHint: true`; изпращане и триене — `destructiveHint: true`. Tool, който пише, се регистрира само когато `NULA_READ_ONLY=false`.
- **Грешките минават през `src/nula/errors.ts`**, за да излиза съобщение, което човек може да разчете, с име на полето от нашата схема.

## Тестове

- Автоматичните тестове **никога не викат истинското API**. Фалшивият сървър е в `test/helpers.ts` (`fakeNula`, `keyedEnvelope`, `invoiceRecord`).
- Fixture-ите носят **истинските имена на полетата, но измислени стойности** — без ЕИК, IBAN, имена на фирми и суми от реални акаунти.
- Нов tool идва с протоколен тест в `test/protocol/`, който го вика през MCP клиент.
- `scripts/live-*.mjs` работят срещу реален акаунт и не се пускат в CI. `live-write-check.mjs` издава и трие истински документи — само с изрично съгласие на собственика на сметката.

## Commit и pull request

- Кратко заглавие в стил Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).
- В PR-а опишете какво се променя за потребителя и дали има нужда от ред в [CHANGELOG.md](CHANGELOG.md) (в `## [Unreleased]`).
- Промяна в поведението на tool (име, параметри, форма на отговора) се отразява и в [docs/SPEC.md](docs/SPEC.md).

## Сигурност

Уязвимост не се докладва през issue — вижте [SECURITY.md](SECURITY.md).
