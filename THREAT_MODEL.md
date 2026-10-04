# THREAT MODEL — DisTorrent

## Garantias EXATAS (nem mais, nem menos)

- **PSEUDONIMIDADE** — sua identidade é um par de chaves. Nenhum e-mail, nenhum
  telefone, nenhum cadastro. Mas seu IP é visível a quem você conecta.
- **Torneamento opcional de rede** — existe um modo **Tor de 7 saltos**
  (`privacy.mode = full`): todo tráfego Direct **e** o relay saem pelo SOCKS5 do
  Tor, e announce + descoberta LAN ficam desligados. Isso protege o transporte,
  **não** cobre WebRTC/STUN — ver "Limitações assumidas" abaixo.
- **Privacidade de conteúdo** — mensagens DM são cifradas fim-a-fim (X25519 efêmero + HKDF + ChaCha20Poly1305). Observador de rede vê metadados (quem fala com quem, quando, tamanho) — mitigações futuras: padding, transporte variado.
- **Privacidade local** — chave privada no keyring do SO (Secret Service/Keychain/DPAPI). Fallback SQLite sem cifrar é **documentado e visível** (Linux sem secret service). Backup/export seguro: cofre portátil `.stormvault` v1 (Argon2id + ChaCha20Poly1305) — ver
[`docs/STORMVAULT.md`](docs/STORMVAULT.md).

## Ameaças e mitigações (estado atual)

| Ameaça | Mitigação implementada | Residual |
|---|---|---|
| **Impersonation** | Handshake assina transcript com ed25519; fingerprint é derivado da pubkey (`blake3(pub)`) — impossível apresentar pubkey diferente do fp anunciado | Phishing de fingerprint (usuário aceita peer errado) → verificação visual/QR futura |
| **Replay** | Nonces frescos de 16 bytes por conexão entram no transcript; sessão usa contadores por direção | — |
| **MITM na conexão** | Ambos assinam (fps + nonces + chaves efêmeras X25519) | — |
| **Mensagem forjada/tamper** | Envelope assinado sobre bytes canônicos; receptor re-verifica SEMPRE (não confia na UI); testado | — |
| **Spoof de autoria via conexão aberta** | `author_fp` deve ser igual ao peer autenticado da conexão | — |
| **Convite/addr falso (testado)** | Conectar com `expected_fp` errado derruba a conexão pós-handshake | — |
| **Sybil** (identidades baratas em massa) | Convite amarrado a fingerprint + PoW p/ novatos + reputação persistente (Storm §2/§5) | Sem custo de identidade: mitigado, não resolvido |
| **Spam/flood** | Gate no receptor pós-assinatura: 10 msgs/10s por peer, dup 60s, link malicioso derrubado; sessão preservada (Storm §2) | Flood distribuído de N peers distintos (cada um abaixo do teto) → moderação + ban |
| **Spoof de nome** (homoglifo, cargo, parecido) | Gate NFC+skeleton+blocklist no core + unicidade por escopo; apelidos da rede sanitizados (Storm §3) | Confusável fora do skeleton (ex.: fonte exótica) → denúncia + moderação |
| **Link malicioso de peer autenticado** | `check_links` + palavras/dominios por servidor; encurtador avisa (medium) ou cai (high) | Domínio novo ainda não listado → denúncia + `blocked_domains` do servidor |
| **Peer malicioso** | Vê apenas suas DMs com ele; não consegue ler mensagens de terceiros | DoS no app (crash por parsing — frames limitados a 1 MiB, JSON tipado) |
| **Roubo de chave** | Keyring do SO; nunca sai do processo; não vai para logs | Malware com acesso ao keyring (fora do escopo de app) |
| **Vazamento de metadados** | Broadcast UDP anuncia fp+nickname na LAN (necessário p/ discovery) | Modo stealth / intervalo variável futuro |
| **Ataque de sincronização** (peer envia lixo ao reconectar) | Toda mensagem do outbox é assinada pelo autor e revalidada ao chegar | — |
| **Abuso de permissões** | N/A nesta fase (sem comunidades). Fase comunidades: validação no CORE, nunca na UI | — |

## Bootstrap HTTP (FORGE_BOOTSTRAP_URL) — o que sai do seu dispositivo

**Desligado por padrão.** Não existe endpoint embutido: sem `FORGE_BOOTSTRAP_URL`
apontando para um tracker que você mesmo hospeda (`host --bootstrap PORTA`), o
announce e o lookup de amigos por tracker não rodam — o motor funciona só com
LAN (UDP/mDNS), MQTT, STUN/UPnP/NAT-PMP e hole punching. Para ativar, aponte a
variável para a sua instância (ver `.env.example`).

Quando ativado:

- **Announce** (a cada 30s, modos `normal`/`encrypted` APENAS): envia ao serviço de
  terceiros seu **fingerprint, IP público (via UPnP ou api.ipify), nickname e porta TCP**.
  É o equivalente ao tracker de um torrent: permite que amigos te encontrem sem IP manual.
- **Lookup de amigos `pending_out`**: consulta o bootstrap pelo fp do amigo — revela a
  ele que você quer falar com aquele fp.
- **NUNCA anuncia em `privacy.mode = proxy` ou `full` (Tor)**: nesses modos o loop de
  announce é pulado inteiro — reqwest não passa pelo SOCKS5, então qualquer chamada
  direta vazaria o IP real. Corrigido no engine (`run_engine`, gate `privacy.mode`).
- Residual: o operador do bootstrap pode mapear fp↔IP↔nickname nos modos normais
  (é o custo do "encontre-me sem IP manual", igual tracker público).

## Logs — o que NÃO aparece

Nunca logamos: chave privada, corpos de mensagem, segredos de sessão. Logs cobrem: conexões, handshakes (fps), estados, erros de protocolo.

## Limitações assumidas (honestidade > marketing)

1. **Não é anonimato.** É pseudônimo + E2E de conteúdo. O modo Tor protege o
   transporte e esconde o IP de quem observa a rede, mas não cobre o WebRTC/STUN
   da chamada — que faz STUN direto para o servidor de STUN, potencialmente
   associado ao seu IP real. Para chamada com Tor, é preciso TURN via Tor.
2. **Discovery LAN expõe presença** na rede local.
3. **Fallback de keyring** (sem secret service) guarda a chave em SQLite plano — visível na UI/documentação; mitigue exportando um .stormvault (cifrado) e guardando fora do device.
4. Cripto é feita **apenas** com primitivas maduras (ed25519-dalek, x25519-dalek, chacha20poly1305, hkdf, blake3). Nenhuma primitiva própria. A **composição** (handshake) é nossa e está documentada aqui e em `protocol.rs`.

## Cofre portátil (.stormvault v1) — modelo de ameaça

Spec completo em `docs/STORMVAULT.md`. Resumo:

- Quem tem o arquivo **+ a senha** tem a conta (by design — não há servidor para recuperar).
- Sem a senha: Argon2id (19 MiB, t=2) torna força-bruta cara por tentativa.
- Chave privada NUNCA em claro no disco; só dentro do payload cifrado.
- Header inteiro como AAD do AEAD + `payload_len`/`payload_hash`: truncamento, colagem ou adulteração são detectados antes/depois da KDF.
- Backups automáticos usam chave derivada em RAM (sem senha) — valem enquanto o app está desbloqueado; não substituem um .stormvault com senha guardado fora.
- Modo pânico (vaultWipe) apaga cofre+backups locais; um .stormvault externo continua válido para restaurar.
