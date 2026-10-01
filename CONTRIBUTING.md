# CONTRIBUTING

## Regra de ouro: critério "REAL"

Uma funcionalidade só está pronta quando **funciona de verdade** e tem teste. "A UI existe" não é pronto. "Está mockado" é dívida explícita no código, nunca padrão aceitável.

## Regras do projeto

1. **Design FORGE congelado** — não mude cores/layout/ícones em `src/designs/ThemeShell.tsx`. A UI consome dados; não produz.
2. **Nada de dados fictícios** — proibido reintroduzir mocks. Estados vazios são estados vazios.
3. **Autorização no core** — a UI nunca decide permissões; o motor valida.
4. **Crypto só de biblioteca** — ed25519-dalek/x25519-dalek/chacha20poly1305/blake3/@noble. Nenhuma primitiva própria.
5. **Sem servidor central obrigatório** — qualquer infraestrutura auxiliar deve ser explícita, opcional e documentada em `AUX_SERVICES.md`.
6. **Privacidade em logs** — nunca logar chaves privadas, corpos de mensagem ou segredos de sessão.

## Fluxo

1. Fork + branch `feat/...` ou `fix/...`
2. Rode **antes** do PR:
   ```bash
   cd forge-core && cargo test && cargo clippy -- -D warnings
   npm run typecheck && npm run lint && npm run build
   ```
3. PR descrevendo: o que é REAL no que você fez, e o que ainda não é (se houver).
4. Commits no estilo `area: resumo curto` (ex.: `core: heartbeat timeout de 25s`).

## Estrutura

- `forge-core/` — motor Rust (identidade, storage, rede). Sem dependência de UI.
- `src-tauri/` — casca Tauri (commands + eventos).
- `src/` — UI React FORGE (services → hooks → ThemeShell).
- `host/` — Community Host headless (próxima fase).

Novas features de rede/protocolo entram em `PROTOCOL.md` antes do código.
