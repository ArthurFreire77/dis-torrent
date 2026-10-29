# Auditoria de conectividade P2P

**Atualizado em 2026-10-28.** Este documento registra o que os diagnósticos
medem e o que ainda precisa de teste com dois dispositivos em redes distintas.

## O que os sinais comprovam

- **STUN `ok`** comprova que o cliente recebeu um endereço reflexivo UDP. Não
  comprova que a porta TCP local aceita conexões de entrada nem que um peer
  remoto consiga alcançá-la.
- **Broker MQTT alcançável** comprova que o teste de conectividade chegou ao
  endpoint MQTT. Não comprova que outro peer está online nem que mensagens foram
  encaminhadas numa sessão.
- **Peer `CONNECTED` com `via_relay=true`** é evidência de handshake autenticado
  concluído pelo caminho relay. Contadores `relay_attempts` e `last_relay_error`
  ajudam a distinguir uma tentativa de uma sessão estabelecida.
- O estado DHT `null` significa que o motor ainda não informou um resultado; a
  UI não o apresenta mais como “DHT desligada”.

O painel explica a diferença entre broker alcançável e encaminhamento real.
Relatórios copiados ocultam por padrão fingerprints, apelidos, portas,
endereços de rede e texto de erro. O usuário pode desmarcar a opção localmente
para incluir os detalhes; nenhum relatório é enviado automaticamente.

## Mudanças nesta rodada

- `join_community` enfileira o pedido e inicia `ConnectRelay` e a busca de
  anúncio para o fingerprint do host. A busca direta continua sujeita aos
  gates de privacidade existentes; o caminho proxy/Tor não é contornado.
- Ao conectar, `flush_joins` envia o token apenas ao host declarado no token e
  só depois de validar assinatura, expiração e vínculo do membro contra a chave
  pública recebida no handshake autenticado. O receptor também valida a mesma
  assinatura antes de aceitar o primeiro `CommunityState` da comunidade.
- O teste de relay MQTT usa um client id por fingerprint. Brokers que expulsam
  uma segunda conexão com o mesmo client id não podem mais fazer os dois nós do
  próprio teste se desconectarem mutuamente.

## Limites e validação restante

- A leitura de endpoint MQTT não é um teste de transporte entre dois peers.
  `relay_mqtt_e2e.rs` é o teste que prova handshake e mensagem via relay, mas
  depende de brokers públicos e pode falhar por indisponibilidade externa.
- Esta alteração não adiciona transporte MQTT sobre TLS ou WSS/443, nem promete
  que os brokers públicos aceitem esses protocolos.
- Não houve validação em 4G/5G, CGNAT, NAT simétrico, firewall de entrada ou em
  duas redes externas independentes. STUN e as sondas de broker, isoladamente,
  não resolvem esses casos.
- A conectividade ainda depende de anúncios/endereços que possam ser
  alcançados, do relay habilitado e do modo de privacidade. Se nenhum caminho
  direto ou relay for viável, o estado correto permanece falha/reconexão, não
  “online”.

## Testes direcionados

```powershell
cd distorrent-core
cargo test --lib reaction_limit::tests
cargo test --test relay_mqtt_e2e --no-run
cargo test --test relay_mqtt_e2e relay_mqtt_real_internet -- --nocapture
```

O último comando usa a internet e pode aguardar até dois minutos por etapa do
broker público. Um sucesso nele confirma um fluxo real para aquela execução;
não garante disponibilidade contínua desses endpoints.
