# THREAT MODEL — DisTorrent

> **Escopo e propósito.** Este documento existe porque o DisTorrent é um
> **projeto educacional** de rede P2P: o objetivo é mostrar, na prática, as
> garantias e os limites de um sistema sem servidor. Ele **não deve ser usado
> para fins ilegais** — o autor não se responsabiliza pelo uso indevido.
> Nada aqui promete anonimato; leia as garantias abaixo como limites reais.

## Garantias EXATAS (nem mais, nem menos)

- **PSEUDONIMIDADE** — sua identidade é um par de chaves. Nenhum e-mail, nenhum
  telefone, nenhum cadastro. Mas seu IP é visível a quem você conecta.
- **Torneamento opcional de rede** — o modo **Tor** (`privacy.mode = full`) roda
  o tráfego Direct **e** o relay pelo SOCKS5 do daemon Tor local
  (`DISTORRENT_TOR_ADDR`, padrão `127.0.0.1:9050`). O **número de saltos do circuito
  é do daemon Tor** (padrão 3: guard/middle/exit) — o app não controla nem
  verifica. Announce, descoberta LAN (UDP/mDNS), DHT, PEX e STUN ficam
  DESLIGADOS; handshakes inbound diretos são RECUSADOS (port-scanner não ganha
  seu Hello em claro); e ao trocar para o modo, sessões diretas vivas são
  derrubadas na hora (ver `privacy_fail_closed.rs`). Se o SOCKS5 cai, o dial
  **falha fechado — NUNCA cai para conexão direta**. Isto protege o transporte,
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
| **Spam de reações** | Buckets no receptor por fingerprint autenticada, conversa, mensagem e global; dedupe; ID precisa apontar para mensagem existente na conversa; rejeição não persiste nem retransmite | Buckets em memória reiniciam com o app; reação que chega antes da mensagem por caminhos diferentes do mesh é descartada (sem fila de replay automático) |
| **Spoof de nome** (homoglifo, cargo, parecido) | Gate NFC+skeleton+blocklist no core + unicidade por escopo; apelidos da rede sanitizados (Storm §3) | Confusável fora do skeleton (ex.: fonte exótica) → denúncia + moderação |
| **Link malicioso de peer autenticado** | `check_links` + palavras/dominios por servidor; encurtador avisa (medium) ou cai (high) | Domínio novo ainda não listado → denúncia + `blocked_domains` do servidor |
| **Peer malicioso** | Vê apenas suas DMs com ele; não consegue ler mensagens de terceiros | DoS no app (crash por parsing — frames limitados a 1 MiB, JSON tipado) |
| **Roubo de chave** | Keyring do SO; nunca sai do processo; não vai para logs | Malware com acesso ao keyring (fora do escopo de app) |
| **Vazamento de metadados** | Broadcast UDP anuncia fp+nickname na LAN (necessário p/ discovery) | Modo stealth / intervalo variável futuro |
| **Ataque de sincronização** (peer envia lixo ao reconectar) | Toda mensagem do outbox é assinada pelo autor e revalidada ao chegar | — |
| **Abuso de permissões** | N/A nesta fase (sem comunidades). Fase comunidades: validação no CORE, nunca na UI | — |
| **Release falsa** (instalador adulterado servido pelo GitHub, CDN ou espelho) | Manifesto canônico assinado 2-de-3 com chaves Ed25519 **offline**; hash SHA-256 e tamanho do instalador vêm do manifesto, não da API do GitHub; tag do GitHub não é fonte de versão. Ver [`docs/RELEASE_TRUST.md`](docs/RELEASE_TRUST.md) | Quem controlar 2 das 3 chaves assina qualquer coisa. Não há transparência pública de log de releases |
| **Download adulterado em trânsito** | HTTPS + allowlist de hosts + revalidação de **cada** redirect + SHA-256 e tamanho conferidos contra o manifesto assinado; divergência apaga o `.part`; `update_apply` reconfere o hash imediatamente antes de executar | Comprometimento do build que assina (2 chaves) ou do processo em memória não é detectado |
| **Rollback / downgrade para versão vulnerável** | `security_epoch` monotônico e piso local `release.epoch_floor`, combinado com `min_security_epoch` declarado pela autoridade (`piso = max(local, declarado)`); epoch abaixo do piso = `OBSOLETO`, recusado mesmo com 2 assinaturas válidas | O piso local só cresce para valores já aceitos; não há piso por arquitetura/canal |
| **Replay de atestação de build** | Nonce de 32 bytes novo por consulta + binding ao `blake3(transcript)` do handshake + fingerprint do peer; nonce consumido após o veredito; `attest_nonce` e `attest_transcript` por peer | Sem chaves locais, `verification_available = false` e o estado fica `NAO_VERIFICADO` (informação, não bloqueio) |
| **Peer empurrando manifesto falso** | `BuildManifestPush` é re-verificado com as chaves **locais** (`ReleaseTrust::accept`) e só entra no cache se `RELEASE_VERIFICADA`; rate limit 4/10 s por peer; nunca é ordem de atualização | Um manifesto válido de versão mais nova é aceito como informação; o piso só barra versão mais antiga |
| **DoS pela camada de atestação** (assinaturas inválidas em massa, manifestos gigantes) | Buckets por peer (atestação 10/10 s, push 4/10 s), orçamento de falhas consultado **antes** da verificação (`attest_failure_budget`) e consumido por `note_attest_failure`, teto global de 16 verificações simultâneas (`attest_global_conc`), limite de 256 KiB de hex na resposta e de 64 KiB de corpo no manifesto | O orçamento de falhas reseta com a janela de 10 s; um atacante com muitas identidades multiplica o custo (mitigado por peer, não globalmente) |
| **Comprometimento de uma chave de release** | Limiar de 2 assinaturas: uma chave sozinha não assina release, não roda rotação e não muda o conjunto. Rotação exige 2 assinaturas do conjunto **atual**, epoch nova e continuidade (≥ 1 chave em comum) | Duas chaves comprometidas = autoridade tomada. Se duas forem perdidas ao mesmo tempo, não há recuperação criptográfica dentro do modelo |

## Bootstrap HTTP (DISTORRENT_BOOTSTRAP_URL) — o que sai do seu dispositivo

**Desligado por padrão.** Não existe endpoint embutido: sem `DISTORRENT_BOOTSTRAP_URL`
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
   da chamada — o ICE do browser usa sockets UDP próprios, fora do SOCKS5/Tor do
   app. **O que o app faz nesses modos** (`proxy`/`full`): os SERVIDORES PÚBLICOS
   de reserva (Google STUN, openrelay TURN) ficam FORA da lista de ICE —
   terceiros não recebem seu IP — e a UI carimba a chamada como **"não
   anônima"** enquanto durar. A chamada segue possível na LAN (candidatos host)
   e com o TURN que VOCÊ configurou. Anonimato real de mídia exige TURN via Tor
   ou VPN transparente.
2. **Discovery LAN expõe presença** na rede local — exceto em `proxy`/`full`,
   onde broadcaster UDP, mDNS e UPnP/NAT-PMP ficam desligados (gate na fonte).
3. **Fallback de keyring** (sem secret service) guarda a chave em SQLite plano — visível na UI/documentação; mitigue exportando um .stormvault (cifrado) e guardando fora do device.
4. Cripto é feita **apenas** com primitivas maduras (ed25519-dalek, x25519-dalek, chacha20poly1305, hkdf, blake3). Nenhuma primitiva própria. A **composição** (handshake) é nossa e está documentada aqui e em `protocol.rs`.
5. **O Tor não é "7 saltos".** O app conecta ao SOCKS5 do daemon Tor local; o
   comprimento do circuito é configuração do SEU Tor (padrão 3). Qualquer
   contagem diferente seria marketing, não engenharia.

## Autenticidade de release — limites explícitos

Esta seção existe para que ninguém leia "assinado" como "seguro contra tudo".
Spec completa em [`docs/RELEASE_TRUST.md`](docs/RELEASE_TRUST.md).

1. **Integridade do processo em execução NÃO é garantida.** O manifesto assinado
   prova a procedência do **artefato** (versão, hash, URL, arquitetura). A
   assinatura de identidade de um peer prova **posse da chave**, não que o
   executável dele está intacto. `SelfIntegrityState` compara o SHA-256 do
   arquivo do executável com um valor local — o arquivo pode ser trocado depois
   do boot e a memória pode ser alterada em runtime.
   Não existe atestação de runtime sem hardware medido.
2. **Atestação de hardware está ausente.** Nenhuma plataforma deste build
   produz prova verificável: TPM quote exigiria cadeia EK/endosso + política de
   PCR + admin; IMA/TPM no Linux exigiria root; Key Attestation do Android
   exigiria a cadeia raiz da Google embutida (não implementado). O campo
   `hardware.proof_available` é **sempre `false`** com o motivo, e o receptor
   recalcula localmente — um peer não se auto-promove a
   `ATESTACAO_DE_HARDWARE`. O estado `ATESTACAO_DE_HARDWARE` é inalcançável.
3. **Um usuário com acesso de escrita local derrota a verificação.** Quem pode
   gravar no `distorrent.db` pode mudar `release.epoch_floor`,
   `release.trust`, `release.self_integrity` ou `release.update_pending`, e quem
   pode gravar na pasta do app pode trocar o executável. A camada é contra
   *origem remota comprometida*, não contra *máquina local comprometida*. O
   cache de manifestos é re-verificado no boot, o que impede que um cache
   adulterado vire confiança — mas não impede adulterar as próprias chaves de
   confiança gravadas.
4. **Comprometimento da conta do GitHub, sozinho, não assina release.** O
   atacante pode publicar assets, trocar `distorrent-manifest.bin`, apagar
   releases e mudar notas — mas o manifesto forjado não verifica sem **2 das 3**
   chaves privadas offline. Efeitos possíveis: negar atualização (apagar a
   release), oferecer uma release antiga (recusada pelo piso de epoch) e enganar
   quem baixa o instalador manualmente **sem** passar pelo app (aí a proteção é
   o hash/assinatura que o usuário confere à mão).
5. **Duas chaves comprometidas = autoridade tomada.** O limiar é 2 de 3 (ou
   2 de até 5); com duas chaves o atacante assina release e rotação. É o custo
   de qualquer esquema de limiar. Mitigação é operacional (3 locais separados,
   cerimônia offline), não criptográfica.
6. **Perda de duas chaves = sem recuperação.** Rotação exige 2 assinaturas do
   conjunto **atual**. Se duas chaves forem perdidas ao mesmo tempo, não há
   caminho criptográfico para publicar um conjunto novo; só um build novo com
   outro `TRUST_SET_BOOTSTRAP` (e a confiança dos usuários nele) resolve.
7. **Não há transparência pública de log.** Nada append-only e verificável
   externamente registra quais manifestos existiram. Quem controla o GitHub pode
   **esconder** uma release (não pode forjar uma).
8. **Não há sandbox de execução.** Depois que `update_apply` inicia o
   instalador, o app não controla mais o que ele faz; um `.deb` é entregue ao
   gerenciador do sistema sem validação de pacote.
9. **A raiz de confiança está embutida, mas é uma única cerimônia.** Este build
   carrega epoch 1 com limiar 2-de-3. Não existe override em runtime (nem env,
   nem arquivo, nem comando) — a constante é compilada. Se ela for esvaziada, a
   verificação fica indisponível e o atualizador não oferece update (fail-closed,
   nunca "confia em todos").
10. **`SelfIntegrityState` fica `UNAVAILABLE` hoje.** Não há caminho que grave o
    SHA-256 esperado do executável: o `update_apply` deixou de gravar o hash do
    instalador (seria `DIVERGE` garantido) e o manifesto não publica o hash do
    executável como asset próprio. A medição existe, a referência não.
11. **Não há build reprodutível verificado.** O `commit` é assinado no
    manifesto, mas nada no cliente reconstrói o binário para comparar.
12. **Não há sandbox de execução.** Depois que o instalador é iniciado, o app não
    controla o que ele faz.

## Rate limits e tetos de recurso (net/`netlimit.rs`)

Todo caminho de entrada tem limite, em dois andares — **throttle** (excedente
descartado, sessão preservada; o protocolo reenvia) e **kill** (flooding
deliberado/bug, sessão encerrada). Taxa e tamanho são independentes: um teto
de frames/s não substitui teto de bytes por mensagem. Defaults (env
`DISTORRENT_LIMIT_*` para reconfigurar sem build; snapshot via comando
`net_limits`/diagnóstico):

| Camada | Throttle (por peer) | Kill (por peer) | Global |
|---|---|---|---|
| TCP inbound (accept) | 30/10s, burst 20 (por IP) | — | 120/10s |
| Handshakes concorrentes | 64 vagas | — | 64 vagas |
| Sessões online | — | — | 256 |
| Frames de sessão | 1200/10s, burst 800 | 6000/10s | 6000/10s |
| Bytes de sessão | 128 MiB/10s, burst 64 MiB | 640 MiB/10s | — |
| Discovery UDP (datagrama) | 15/10s, burst 10 (por IP) | — | 300/10s |
| Hello NOVO via relay | 12/10s, burst 8 | — | — |
| Pedidos de chunk | 200/10s, burst 120 | — | — |
| Sinalização de chamada (ICE) | 240/10s, burst 160 | — | — |
| FriendRequest | 20/10s, burst 12 | — | — |
| Atestação de build (desafio/resposta) | 10/10s, burst 6 | — (descarta) | 16 verificações simultâneas |
| Push de manifesto de peer | 4/10s, burst 2 | — (descarta) | — |
| Falhas de atestação | 3/10s, burst 2 | — | — |
| Loops de dial outbound | — | — | 64 concorrentes |

Isto É a fronteira anti-DoS do transporte: um par autenticado não consegue
consumir CPU/RAM/IO indefinidamente (cada accept era uma task de handshake
criptográfico sem freio; cada Hello novo no relay nascia um respondente).
Testado em `netlimit.rs` (unit, determinístico) e `privacy_fail_closed.rs`
(integração).

## Cofre portátil (.stormvault v1) — modelo de ameaça

Spec completo em `docs/STORMVAULT.md`. Resumo:

- Quem tem o arquivo **+ a senha** tem a conta (by design — não há servidor para recuperar).
- Sem a senha: Argon2id (19 MiB, t=2) torna força-bruta cara por tentativa.
- Chave privada NUNCA em claro no disco; só dentro do payload cifrado.
- Header inteiro como AAD do AEAD + `payload_len`/`payload_hash`: truncamento, colagem ou adulteração são detectados antes/depois da KDF.
- Backups automáticos usam chave derivada em RAM (sem senha) — valem enquanto o app está desbloqueado; não substituem um .stormvault com senha guardado fora.
- Modo pânico (vaultWipe) apaga cofre+backups locais; um .stormvault externo continua válido para restaurar.
