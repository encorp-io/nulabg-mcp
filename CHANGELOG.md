# Changelog

Форматът следва [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), версиите — [SemVer](https://semver.org/lang/bg/).

## [Unreleased]

## [0.1.0] — 2026-09-26

Първа версия: MCP сървър за [nula.bg](https://nula.bg) през stdio, с API ключ.

### Добавено
- **21 tools** (25 с `nra` и `noi`) в 10 toolset-а: справка за фирма, фактури (търсене, издаване с preview, редакция, платена/изпратена, категории, прикачени файлове, PDF, имейл, изтриване на последната), покупки (търсене, въвеждане, категории), OCR (качване с изчакване и квота), клиенти, артикули и наличности, банкови сметки и движения, изчислени справки (вземания с aging, обобщение за период, предложения за равнение банка ↔ фактура), НАП и НОИ (само наблюдение).
- **4 prompts**: `issue-invoice`, `process-receipts`, `month-end-review`, `collect-overdue`.
- **Resources**: 57-те основания за 0% ДДС, 32-те основания за протокол по чл.117, стойностите на enum-ите и PDF на фактура.
- **Само четене по подразбиране** (`NULA_READ_ONLY`, fail-closed): tools за запис изобщо не се регистрират, докато не се зададе изрично `false`.
- **Guardrails**: `preview_only` преди издаване, потвърждение през MCP elicitation, проверка за дублиран номер, guard при изтриване (последна фактура + `has_accounting`), без автоматичен retry при запис, sandbox и проверка по magic bytes за файловете, SSRF защита при URL, маскиране на ключа в логовете.
- **Няколко фирми** за счетоводители: `NULA_PROFILES` и параметър `company` на всеки tool.
- **Разпространение**: npm пакет с `bin`, `.mcpb` bundle за Claude Desktop (ключът отива в keychain), запис за MCP Registry, GitHub Actions за тестове и релийз.
- **Документация**: [README](README.md), [спецификация](docs/SPEC.md) и проучване на API-то, платформата и MCP екосистемата в [docs/research](docs/research); [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md), [CODE_OF_CONDUCT](CODE_OF_CONDUCT.md) и шаблони за issues и pull requests.

### Проверено на живо (26.09.2026, реален акаунт)
- Всички 13 read tools; форматите на отговорите са документирани в [API анализ §8](docs/research/nula-api-analysis.md).
- Операции със запис: издаване, редакция, платена/изпратена, PDF и имейл.
- Не минава: изтриване на осчетоводена фактура (nula.bg връща 403); OCR, НАП и НОИ изискват ключ с достъп до фирмата.

[Unreleased]: https://github.com/encorp-io/nulabg-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/encorp-io/nulabg-mcp/releases/tag/v0.1.0
