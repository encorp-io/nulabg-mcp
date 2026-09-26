# MCP стек и разпространение: проучване (2026-09-22)

> Версиите на пакетите са проверени с `npm view` на 2026-09-22. Всичко непроверено е маркирано с **[непроверено]**.

## 1. MCP спецификация: текущо състояние

**Текуща ревизия: `2026-07-28`.** Промените са големи:

| Ревизия | Ключови промени |
|---|---|
| 2025-06-18 | structured output (`outputSchema` / `structuredContent`), elicitation, `resource_link`, `title`, MCP сървърът става OAuth Resource Server (RFC 9728, RFC 8707) |
| 2025-11-25 | icons, правила за имена на tools (1–128 символа, `A-Za-z0-9_-.`), URL-mode elicitation, CIMD, експериментални tasks; грешките при валидация на входа се връщат като `isError` резултат |
| **2026-07-28** | **Stateless протокол:** без `initialize` handshake и `Mcp-Session-Id`, версия и capabilities се пращат в `_meta` на всяка заявка, добавен е `server/discover`. **MRTR (Multi Round-Trip Requests):** сървърът връща `resultType: "input_required"` с `inputRequests` (напр. elicitation форма), а клиентът повтаря заявката с отговорите. Tasks стават extension. Streamable HTTP изисква headers `Mcp-Method` и `Mcp-Name`. Deprecated: **Roots**, **Sampling**, **Logging**, HTTP+SSE, DCR (в полза на CIMD) |

- **Transports:** stdio и Streamable HTTP. HTTP+SSE е deprecated.
- **Tool annotations** (hints, клиентите не им вярват безусловно): `readOnlyHint` (default false), `destructiveHint` (default true, има смисъл само когато tool-ът не е read-only), `idempotentHint` (false), `openWorldHint` (true).
- **Резултати от tool:** text, image, audio, `resource_link`, embedded `resource`. При `outputSchema` → `structuredContent` плюс текстово копие за съвместимост.
- **Extensions:** MCP Apps (`@modelcontextprotocol/ext-apps` 2.0.0; поддържа се в Claude web/Desktop, ChatGPT, VS Code, Cursor…), Tasks, OAuth client credentials, enterprise-managed auth.
- **Auth за remote:** OAuth 2.1, PKCE S256, CIMD за предпочитане. **Token passthrough е забранен:** сървърът не бива да приема токени, издадени за друг ресурс. Authorization като цяло е незадължителна.

## 2. TypeScript SDK

| Пакет | Версия | Бележка |
|---|---|---|
| `@modelcontextprotocol/server` | **2.0.0** | v2, излязъл 2026-07-27; Node ≥ 20; зависи от `zod ^4.2.0` |
| `@modelcontextprotocol/core` | 2.0.0 | |
| `@modelcontextprotocol/node` / `hono` / `express` | 2.0.0 | HTTP адаптери |
| `@modelcontextprotocol/sdk` | 1.30.0 | v1 линия; поправки до ~януари 2027 |
| `zod` | **4.6.5** | |
| `@modelcontextprotocol/inspector` | 2.7.0 | изисква Node ≥ 22.19 |
| `@anthropic-ai/mcpb` | 2.1.2 | CLI за `.mcpb` |
| `mcp-handler` (Vercel) | 2.2.0 | върху SDK v2 |

API на v2:
- `new McpServer({name, version})` и `server.registerTool(name, {title, description, inputSchema: z.object(…), outputSchema, annotations}, handler)`.
- Невалидните аргументи автоматично стават `isError` резултат. Хвърлена грешка в handler също става `isError`. За protocol грешки има `ProtocolError`.
- stdio: `serveStdio(() => server)`.
- HTTP: `createMcpHandler(factory)` → `{fetch}` (Workers, Deno, Bun, Vercel). На Node се ползва `toNodeHandler` или `createMcpHonoApp` (Host и Origin проверки по подразбиране). Auth се подава изрично: `handler.fetch(req, {authInfo})` → `ctx.http.authInfo`.
- **Обратна съвместимост:** клиентите от 2025 г., които още пращат `initialize`, се обслужват по подразбиране (`legacy: 'stateless'` за HTTP, `'serve'` за stdio). Claude Desktop, Cursor и т.н. работят независимо от ревизията на протокола.

## 3. Алтернативи на TypeScript

| Вариант | Версия | Оценка за wrapper с един API ключ |
|---|---|---|
| **TypeScript SDK v2** | 2.0.0 | ✅ Tier 1, първи върху 2026-07-28; Node е вграден в Claude Desktop; npx; един codebase за stdio и remote |
| Go (`go-sdk`) | v1.8.0 | 🥈 Един статичен binary без runtime. Минуси: build за всяка OS/arch, без npx, по-малко helpers за MCPB и Apps |
| C# / .NET | 2.2.0 | за .NET екипи; по-тежко разпространение |
| Rust (`rmcp`) | 3.4.0 | прекалено за REST wrapper |
| FastMCP (TS) | 4.20.16 | още е на SDK v1, т.е. не е на spec-а от 2026. Не |
| xmcp | 1.1.3 | излишен слой |
| Cloudflare `agents` (McpAgent) | 0.24.0 | добър за remote с OAuth (`workers-oauth-provider` 0.10.3) |
| `workers-mcp` | 2025 | изоставен |

## 4. Канали за разпространение

### 4.1 npm + npx (разработчици)
- Пакет с `bin` и `"mcpName"` в `package.json` (нужно за registry). Потребителят трябва да има Node.
- Claude Code: `claude mcp add --transport stdio --scope user --env NULA_API_KEY=… nula -- npx -y @scope/nula-mcp`
- Claude Desktop (ръчно): `claude_desktop_config.json` → `mcpServers.nula = {command:"npx", args:["-y","@scope/nula-mcp"], env:{NULA_API_KEY:"…"}}`
- Cursor: `~/.cursor/mcp.json`, същата форма; `"${env:NULA_API_KEY}"`.
- VS Code: `.vscode/mcp.json` с `servers` и `inputs` (`promptString`, `password: true`), така че ключът не се пише във файла.

### 4.2 MCP Bundle (`.mcpb`) за Claude Desktop (нетехнически потребители)
- Zip с `manifest.json`, сървъра и `node_modules`. CLI: `mcpb init`, `mcpb validate`, `mcpb pack`, `mcpb sign`.
- `manifest_version: "0.3"`, `server.type: "node"`.
- API ключът: `user_config.api_key = {type:"string", sensitive:true, required:true}` → `env.NULA_API_KEY = "${user_config.api_key}"`. Стойността се маскира и се пази сигурно (OS keychain според материалите на Anthropic).
- Node е вграден в Claude Desktop (macOS, Windows). **[непроверено]** Коя версия на Node е вградена, защото v2 изисква ≥ 20. Декларира се `compatibility.runtimes.node: ">=20"` и се тества.
- Инсталация: двоен клик, drag & drop, или Settings → Extensions → Install Extension. Enterprise админите могат да allowlist-ват.
- За листване в директорията на Claude: annotations на всеки tool и privacy policy (`privacy_policies`).

### 4.3 Официален MCP Registry (`registry.modelcontextprotocol.io`)
- Preview (възможни breaking changes). Съхранява само метаданни.
- `server.json` (schema `2025-12-11`), CLI `mcp-publisher` (`init`, `login github|github-oidc|dns|http`, `publish`).
- Namespace: `io.github.<org>/…` (GitHub) или `io.encorp/…` (DNS TXT на домейна).
- Пакети: `npm` (с `environmentVariables`, `isSecret: true`), `mcpb` (URL от GitHub Releases, `fileSha256`), `remotes` (streamable-http + headers).

### 4.4 Remote (Streamable HTTP): Claude.ai и ChatGPT
- **Claude.ai custom connectors:** OAuth (DCR, CIMD или pre-registered client) или **static headers** (beta, само за някои организации). Ключът се въвежда веднъж от админа и е **общ за организацията**. Отворен бъг: anthropics/claude-ai-mcp#644 (headers се игнорират).
- **ChatGPT:** само OAuth 2.1 или без auth; не поддържа custom API ключове.
- **Извод:** за да въвежда **всеки потребител собствения си nula ключ** в claude.ai или ChatGPT, е нужен тънък **OAuth слой**. Страницата `/authorize` иска nula ключа, пази го криптиран и издава собствени access токени. Това е в синхрон и с правилото срещу token passthrough.
- **Claude Code, Cursor, VS Code:** директен header `Authorization: Bearer <nula-key>` (или `X-API-Key`) към remote сървъра работи.
- **Никога ключ в URL.**

### 4.5 Други директории
Docker MCP Catalog (PR към `docker/mcp-registry`), Smithery, mcp.so, Glama, awesome-mcp-servers.

## 5. Дизайн на tools: best practices

- **Брой:** точността при избора пада с растежа на списъка. Целта е **~15–20 tools**. Claude Code и Cursor вече зареждат tools при нужда, но други клиенти не го правят.
- **Workflow tools, не 1:1 endpoint-и** (Anthropic, „Writing effective tools for agents“): слети list и get, `response_format: concise|detailed`, четими имена до id-тата.
- **Имена:** `snake_case` с префикс (`nula_…`), само `[a-z0-9_]`.
- **Размер:** Claude Code предупреждава при 10k токена и реже при 25k (`MAX_MCP_OUTPUT_TOKENS`). Tool може да вдигне лимита си с `_meta["anthropic/maxResultSizeChars"]` (≤ 500k символа). Добрите default-и са малки страници и филтри.
- **PDF и файлове:** **да се избягват embedded blob ресурси.** Hosted connector-ът ги отхвърля (anthropics/claude-code#94746), а Claude Desktop не ги рендерира (anthropics/claude-ai-mcp#287). Вместо това: текст + `resource_link`, кратко живеещ подписан URL за сваляне, или (в stdio) запис на диска.
- **Грешки:** API и бизнес грешките са `isError: true` с конкретна подсказка. Protocol грешките са само за невалидни заявки.
- **Безопасност:** annotations на всеки tool; read-only switch, който изобщо не регистрира write tools; потвърждение чрез MRTR elicitation с fallback към двустъпков preview → commit.

## 6. Тестване
- **MCP Inspector 2.7.0:** web UI (`npx @modelcontextprotocol/inspector -e NULA_API_KEY=… -- node dist/stdio.js`), `--tui`, `--cli` (за CI; `--method tools/list --strict` проверява портативността на схемите).
- **Evals:** MCPJam (точност при избора на tool в различни модели), Braintrust / mcp-eval, методиката от skill-а `mcp-builder` (~10 реалистични въпроса и отговора).

## Източници
- Spec changelogs: https://modelcontextprotocol.io/specification/2026-07-28/changelog · …/2025-11-25/changelog · …/2025-06-18/changelog
- Tools: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Security: https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices
- Extensions: https://modelcontextprotocol.io/docs/extensions/overview · client matrix: https://modelcontextprotocol.io/extensions/client-matrix
- SDK tiers: https://modelcontextprotocol.io/docs/sdk
- TS SDK: https://github.com/modelcontextprotocol/typescript-sdk · https://ts.sdk.modelcontextprotocol.io/v2/servers/tools · …/v2/serving/http · …/v2/serving/stdio · …/v2/migration/
- Go SDK: https://github.com/modelcontextprotocol/go-sdk
- MCPB: https://github.com/modelcontextprotocol/mcpb (MANIFEST.md, CLI.md) · https://claude.com/docs/connectors/building/mcpb · https://www.anthropic.com/engineering/desktop-extensions
- Registry: https://github.com/modelcontextprotocol/registry/tree/main/docs
- Claude connectors: https://claude.com/docs/connectors/custom/remote-mcp · https://claude.com/docs/connectors/building/authentication · https://github.com/anthropics/claude-ai-mcp/issues/644
- ChatGPT auth: https://developers.openai.com/plugins/build/auth
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- VS Code: https://code.visualstudio.com/docs/copilot/customization/mcp-servers
- Cursor: https://cursor.com/docs/context/mcp
- Anthropic, Writing tools for agents: https://www.anthropic.com/engineering/writing-tools-for-agents
- PDF бъгове: https://github.com/anthropics/claude-code/issues/94746 · https://github.com/anthropics/claude-ai-mcp/issues/287
- Inspector: https://github.com/modelcontextprotocol/inspector
