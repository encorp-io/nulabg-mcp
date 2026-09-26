<!-- На български или на английски — както ви е удобно. -->

## Какво променя това

## Как е проверено

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] проверено през MCP клиент (Inspector, Claude Code, Claude Desktop) — опишете как

## Чеклист

- [ ] Тестовете не викат истинското nula.bg API; fixture-ите са с измислени стойности (без реални ЕИК, IBAN, имена, суми)
- [ ] Нов или променен tool е отразен в [README](../README.md) и [docs/SPEC.md](../docs/SPEC.md)
- [ ] Добавен ред в `## [Unreleased]` на [CHANGELOG.md](../CHANGELOG.md), ако промяната се вижда от потребителя
- [ ] Tool, който създава, променя, изпраща или трие, се регистрира само когато `NULA_READ_ONLY=false`, и е анотиран правилно (`destructiveHint` / `readOnlyHint`)
