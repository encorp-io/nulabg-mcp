# Релийз

Версията се публикува от един tag на три места: **npm** (с provenance), **GitHub Release** (с `.mcpb` файла) и **MCP Registry**.

## Еднократна подготовка

| Какво | Къде | Бележка |
|---|---|---|
| GitHub хранилище | `github.com/<org>/nulabg-mcp` | Името му трябва да съвпада с `repository`, `mcpName` в `package.json`, `server.json` и `manifest.json` |
| npm пакет | `nulabg-mcp` (без scope) | Проверено като свободно на 26.09.2026: `npm view nulabg-mcp` връща 404 |
| npm Trusted Publisher | npmjs.com → пакетът → **Settings / Access** → Trusted Publisher | Вместо токън, виж по-долу |
| MCP Registry namespace | `io.github.encorp-io/nulabg-mcp` | Публикува се с GitHub OIDC от workflow-а; не иска ключ |
| Права на workflow-а | Settings → Actions → General | „Read and write permissions“, за да може да създаде Release ✅ вече е зададено |

При смяна на организация или име се обновяват: `package.json` (`name`, `mcpName`, `repository`, `homepage`, `bugs`), `server.json` (`name`, `repository`, `packages[].identifier`), `manifest.json` (`repository`, `homepage`, `documentation`, `support`), README и CHANGELOG.

### npm достъп: Trusted Publishing, без `NPM_TOKEN`

Като `@encorp.ai/llm-open-proxy`, пакетът се публикува през [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers): GitHub Actions разменя своя OIDC токън за еднократен npm токън. **Никъде не се пази секрет** и provenance се прикача автоматично (затова `--provenance` не се подава).

Настройката е в npm, на страницата на пакета → **Settings / Access** → **Trusted Publisher** → GitHub Actions:

| Поле | Стойност |
|---|---|
| Organization or user | `encorp-io` |
| Repository | `nulabg-mcp` |
| Workflow filename | `release.yml` |
| Environment name | *(празно)* |

Изисква npm ≥ 11.5.1, затова workflow-ът върви на Node 24 и проверява версията, преди да публикува.

**Първата версия.** npm пре-регистрира trusted publisher само за съществуващ пакет, затова при `@encorp.ai/llm-open-proxy` версия 0.1.0 е публикувана ръчно, а всичко след нея — от Actions. Тук има два пътя:

1. Ако npm позволи да добавите trusted publisher за още непубликувано име (org page → **Add package** → GitHub Actions), направете го и целият релийз минава през tag-а.
2. Иначе публикувайте веднъж от машината си (`npm login`, после `npm publish --access public`), добавете trusted publisher и чак тогава пуснете tag-а — стъпката за npm вижда, че версията вече е в регистъра, прескача я и довършва останалото (`.mcpb`, GitHub Release, MCP Registry). Провенанс за тази първа версия няма; следващите го получават.

## Преди всеки релийз

```bash
npm ci
npm run lint && npm run typecheck && npm test   # 62 теста
npm run build
npm pack --dry-run                              # какво влиза в npm пакета
npm run pack:mcpb                               # nulabg-mcp-<версия>.mcpb
```

Ръчни проверки:

```bash
NULA_API_KEY=<ключ> node dist/cli.js --check        # ключът работи, режимът е read-only
NULA_API_KEY=<ключ> node dist/cli.js --list-tools   # 13 tools по подразбиране
npx @modelcontextprotocol/inspector --cli node dist/cli.js -e NULA_API_KEY=<ключ> --method tools/list --strict
```

По желание, с реален ключ и **само четене**:

```bash
set -a && . ./.env.local && set +a
node scripts/live-read-check.mjs     # всички read tools през MCP протокола
```

`scripts/live-write-check.mjs` издава, редактира, изпраща и трие истинска фактура. Пуска се **само** с изрично съгласие на собственика на сметката и никога в CI.

Накрая инсталирайте `.mcpb` файла в Claude Desktop и задайте един въпрос („кои фактури не са платени?“), за да проверите целия път от край до край.

## Пускане

1. Обновете `## [Unreleased]` в [CHANGELOG.md](../CHANGELOG.md) към новата версия и добавете дата.
2. Вдигнете версията: `npm version minor` (или `patch` / `major`) — прави commit и tag.
   `manifest.json` и `server.json` се синхронизират автоматично: манифестът при `npm run pack:mcpb`, а `server.json` от release workflow-а.
3. `git push origin main --follow-tags`

Оттам нататък [`.github/workflows/release.yml`](../.github/workflows/release.yml) прави:

- проверка, че tag-ът съвпада с `package.json`, и че npm е ≥ 11.5.1;
- lint, typecheck, тестове, build;
- `npm publish --access public` през Trusted Publishing (прескача се, ако версията вече е в npm);
- `npm run pack:mcpb` и GitHub Release с прикачен `.mcpb`;
- обновяване на `server.json` (версия, URL и SHA-256 на bundle-а) и `mcp-publisher publish`.

## След релийза

```bash
npx -y nulabg-mcp@latest --version
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=nulabg" | head
```

Свалете `.mcpb` от Release-а и го инсталирайте наново, за да сте сигурни, че публикуваният файл работи.

## Ако нещо се счупи

- **npm:** `npm deprecate nulabg-mcp@<версия> "…"` и пуснете patch. Версии се отпубликуват само до 72 часа (`npm unpublish`), затова по-добре е patch.
- **MCP Registry:** публикувайте нова версия; записите не се трият.
- **GitHub Release:** може да се изтрие или маркира като pre-release.
