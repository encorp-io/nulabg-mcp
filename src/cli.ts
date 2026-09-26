#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { assertServable, ConfigError, loadConfig, TOOLSETS } from './config.ts';
import { createLogger } from './logger.ts';
import { NulaClient } from './nula/client.ts';
import { describeError } from './nula/errors.ts';
import { extractList } from './nula/normalize.ts';
import { createNulaServer, VERSION } from './server.ts';
import { annotationsFor, selectTools } from './tools/index.ts';

const HELP = `nulabg-mcp ${VERSION}: MCP server for the nula.bg accounting platform

Usage:
  nulabg-mcp                 Start the MCP server on stdio (what MCP clients run)
  nulabg-mcp --check         Verify the API key(s) against nula.bg and exit
  nulabg-mcp --list-tools    Print the tools enabled by the current configuration
  nulabg-mcp --version

Environment:
  NULA_API_KEY               nula.bg API key (required, or NULA_PROFILES)
  NULA_PROFILES              JSON {"alias":"key",...} or path to such a file, for several companies
  NULA_DEFAULT_PROFILE       Default alias when NULA_PROFILES is used
  NULA_READ_ONLY             true (default) = read-only; set false to allow creating, editing,
                             e-mailing and deleting documents in nula.bg
  NULA_TOOLSETS              Comma list: ${TOOLSETS.join(', ')}, all
  NULA_CONFIRM_WRITES        elicit (default) | never
  NULA_DEFAULT_CURRENCY      Default EUR
  NULA_DEFAULT_LANGUAGE      bg (default) | en
  NULA_DEFAULT_INVOICE_CATEGORY  Category used when none is given
  NULA_DOWNLOAD_DIR          Where PDFs/XMLs are saved (default ~/Downloads/nula)
  NULA_FILE_ROOTS            Folders files may be uploaded from (default ~), separated by ":" (";" on Windows)
  NULA_BILL_CALLBACK_URL     https URL nula.bg notifies after creating a bill (optional)
  NULA_BASE_URL              Default https://nula.bg
  NULA_TIMEOUT_MS, NULA_MAX_CONCURRENCY, NULA_LOG_LEVEL (debug|info|warn|error)
`;

async function check(): Promise<number> {
  const config = loadConfig();
  assertServable(config);
  let failures = 0;
  for (const [alias, apiKey] of Object.entries(config.profiles)) {
    const client = new NulaClient({ apiKey, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs });
    try {
      const banks = extractList(await client.get('/api/v1/getBanks', { query: { allBanks: 0 } })).items;
      process.stdout.write(`✓ ${alias}: API key accepted by ${config.baseUrl} (${banks.length} bank accounts)\n`);
      process.stdout.write(`  mode: ${config.readOnly ? 'read-only (default)' : 'write access enabled'}\n`);
    } catch (err) {
      failures++;
      process.stdout.write(`✗ ${alias}: ${describeError(err)}\n`);
    }
  }
  return failures ? 1 : 0;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (args.has('--version') || args.has('-v')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.has('--list-tools')) {
    const config = loadConfig();
    for (const t of selectTools(config)) {
      const a = annotationsFor(t);
      const flags = a.readOnlyHint ? 'read' : a.destructiveHint ? 'write, destructive' : 'write';
      process.stdout.write(`${t.name.padEnd(32)} [${t.toolset}] (${flags}) ${t.title}\n`);
    }
    return;
  }
  if (args.has('--check')) {
    process.exitCode = await check();
    return;
  }

  const config = loadConfig();
  assertServable(config);
  const logger = createLogger(config.logLevel);
  const handle = serveStdio(() => createNulaServer({ config, logger }), {
    onerror: (err) => logger.error('transport error', { error: err.message }),
  });
  logger.info(
    `nulabg-mcp ${VERSION} ready on stdio (${Object.keys(config.profiles).length} company profile(s), ` +
      (config.readOnly
        ? 'READ-ONLY: set NULA_READ_ONLY=false to allow changes in nula.bg)'
        : 'WRITE ACCESS ENABLED: tools can create, send and delete documents)'),
  );
  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`nulabg-mcp: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`nulabg-mcp: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
