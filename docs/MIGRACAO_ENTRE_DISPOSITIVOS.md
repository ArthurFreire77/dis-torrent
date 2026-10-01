# Migrar sua conta para outro dispositivo (.stormvault)

Guia passo a passo para levar sua conta do DisTorrent de um aparelho para
outro — sem servidor, sem nuvem obrigatória. O arquivo `.stormvault` é um
cofre cifrado com tudo da sua conta.

## 1. No dispositivo antigo: exportar

1. Abra **Configurações** (no celular: aba **Você**) → seção **COFRE & BACKUP**.
2. Em **EXPORTAR COFRE**, digite uma **senha de export** (mínimo 8 caracteres).
   Guarde bem essa senha — sem ela o arquivo não abre em lugar nenhum.
3. Deixe marcado **"incluir chave privada"** (é o que permite migrar de
   dispositivo; sem isso o arquivo só serve como backup de leitura).
4. Toque **Exportar**. O arquivo `.stormvault` é salvo na pasta **Downloads**.

## 2. Transferir o arquivo

Copie o `.stormvault` para o dispositivo novo por **pen drive, cabo USB,
cartão SD ou sua nuvem pessoal**. O arquivo é cifrado (Argon2id + ChaCha20):
o provedor, o dono do pen drive ou quem interceptar **não consegue ler nada**
sem a senha. Mesmo assim, prefira meios que você controla e apague a cópia
intermediária depois.

## 3. No dispositivo novo: importar

1. Instale o DisTorrent no dispositivo novo.
2. Na primeira abertura o app mostra **Criar conta** — crie uma conta
   temporária qualquer (só para entrar; ela será substituída/mesclada).
3. Vá em **Configurações → COFRE & BACKUP → IMPORTAR COFRE**.
3. Toque **Escolher arquivo…**, selecione o `.stormvault`, digite a
   **senha do arquivo** e toque **Importar**.
4. Entre com a **mesma senha do cofre**. Pronto: identidade, conversas,
   mensagens, amigos e comunidades aparecem no novo aparelho.

## 4. O que migra e o que NÃO migra

**Migra:** identidade e chave privada, histórico de mensagens, conversas,
amigos, comunidades (canais, cargos, bots, membros), grupos e configurações.

**NÃO migra:** mídia e arquivos baixados (fotos, vídeos, anexos salvos no
aparelho antigo). Só o histórico e a conta viajam no cofre — os arquivos
precisam ser baixados de novo nas conversas (peça reenvio aos contatos ou
baixe dos peers quando estiverem online).

## 5. Troubleshooting

- **"senha incorreta"**: a senha do arquivo é a que você digitou na hora de
  exportar, não a senha de desbloqueio do app antigo (a menos que sejam iguais).
  Confira acentos, maiúsculas e espaços.
- **"cofre de outra conta"**: o arquivo pertence a uma identidade diferente da
  que já existe neste dispositivo. Para trocar de conta, use o modo pânico
  (**digite APAGAR**) para limpar o aparelho antes — ou mantenha cada conta no
  seu dispositivo. Não há multi-conta no mesmo perfil.
- **Arquivo truncado / corrompido**: o app detecta truncamento e colagem antes
  mesmo de pedir a senha (tamanho e hash do corpo estão no header assinado).
  Exporte de novo no aparelho antigo e transfira por outro meio.
- **Esqueci a senha do arquivo**: não há recuperação — por design, ninguém
  (nem nós) tem cópia. Exporte um cofre novo no aparelho antigo com outra senha.
