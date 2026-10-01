# Cancelamento de eco (AEC) e supressão de ruído — voz nativa

Implementado em `forge-core/src/net/media_dsp.rs`, ligado ao pipeline em
`forge-core/src/net/media_voice.rs`. Linux only (mesmo gate de `media_voice`).

## O que foi escolhido, e por quê

A especificação pedia o crate `speexdsp`. **Esse crate não serve:**
`speexdsp` da crates.io expõe **só o resampler** (`src/lib.rs` tem um único
`pub mod resampler`), e o `speexdsp-sys` original exige `libspeexdsp-dev` +
`pkg-config` + `bindgen`. Nesta máquina existe `libspeexdsp.so.1` mas **não** há
headers nem `.pc` — e instalar exigiria root.

Foi usado **`aec-rs` → `aec-rs-sys`**, que **embute o código C do speexdsp** e
compila com `cmake`. Zero dependências de sistema, zero sudo. Traz
`speex_echo.h` **e** `speex_preprocess.h`.

## A API real (lida na fonte — nada adivinhado)

A especificação citava `echo_ctl(..., SetSize, 200)`, `filter_length_ms` e
`tail_length_ms`. **Nenhum desses existe.** O real é:

```c
SpeexEchoState *speex_echo_state_init(int frame_size, int filter_length);
void speex_echo_cancellation(SpeexEchoState*, const spx_int16_t *rec,
                             const spx_int16_t *play, spx_int16_t *out);
```

- `filter_length` é em **amostras**, não ms.
- **Não existe `tail_length_ms`** — o tamanho do eco é único (`filter_length`).
  Se a cauda não for coberta, o ajuste é reduzir esse valor, não mexer num
  parâmetro inexistente.
- `rec` = microfone, `play` = referência do alto-falante.

Configuração: 48 kHz, 960 amostras/quadro (20 ms), filtro de **200 ms = 9600
amostras** (o manual pede 100–500 ms).

## Sinal de referência

Alimentado no callback de playout (`open_speaker`) com **exatamente** os
samples escritos no device — capturados **depois** do downmix e **depois** do
resample para a taxa do hardware, porque é esse o sinal que a sala ouve.
Um `RefRing` com capacidade de ~1,3 s e descarte-do-mais-antivo absorve o jitter
entre os dois streams sem deixar a latência crescer.

## Segurança: por que isto não apaga a voz real

Um AEC com referência errada é **pior** que nenhum: o filtro adaptativo aprende
a prever a voz local e a apaga. Três garantias:

1. **Só liga com alto-falante.** Sem `has_speaker()`, `EchoCanceller` é
   pass-through (fone de ouvido não tem eco acústico).
2. **Sem referência ⇒ microfone intacto.** `process()` devolve `mic` sem tocar
   nele, e não silêncio.
3. **Referência morta descarta o filtro.** Após `STALE_LIMIT` (10 quadros ≈
   200 ms) sem referência, o estado adaptativo é jogado fora, para um estado
   divergido não overdeletar a voz quando o playout volta.

## Medições

`forge-core/tests` não serve (o harness é binário porque o DSP é independente):
há `aec-probe/`, um crate que faz `#[path]` do arquivo **de produção**. Não é
cópia — o número medido é o do módulo que entra no binário.

### Cancelamento de eco (janela 3 s–10 s, filtro já convergido)

| cenário | ANTES | DEPOIS | ERLE | corr. c/ eco |
|---|---|---|---|---|
| caixa de som (12 ms, 0.35) | −39,52 dBFS | −49,61 dBFS | **10,09 dB** | 0,967 → **0,003** |
| caixa + sala (25 ms, 0,50) | −36,59 dBFS | −48,91 dBFS | **12,32 dB** | 0,979 → **0,011** |
| fone/mesa (6 ms, 0,20) | −44,09 dBFS | −56,42 dBFS | **12,34 dB** | 0,952 → ~0,000 |

Teste no lib (`cargo test -p forge-core --lib -- --nocapture aec_reduz_eco`):

```
=== AEC: ANTES -39.41 dBFS | DEPOIS -49.12 dBFS | reducao 9.72 dB ===
```

### Custo de CPU

| | ms/quadro | % do deadline de 20 ms |
|---|---|---|
| pass-through | 0,001 | 0,0 % |
| AEC (filtro 200 ms) | 0,538 | **2,7 %** |

### Latência

O AEC **não adiciona latência**: `process()` é uma transformação síncrona do
quadro atual, entre a recepção do frame e o `enc.encode`. Não há fila nova, e o
ritmo do loop continua ancorado no relógio de captura (`at + FRAME`). A
medição de ponta (84–93 ms) exige microfone e alto-falante reais — não há
device de áudio neste ambiente, então não foi remedida aqui.

## Supressão de ruído: DESLIGADA por padrão, e por quê

`DEFAULT_NS = false`. A medição mostrou que o preprocessor do speexdpx, ligado,
**não preserva a forma de onda** da voz local (correlação 0,98 → 0,005 no
cenário sem eco nenhum). A energia cai só 3,65 dB, o que é ambíguo: o
preprocessor é um filterbank e muda fase, então correlação de forma de onda não
é medida confiável de inteligibilidade. **Com uma métrica que eu mesmo
demonstrei ser inconsistente, não dá para ligar isso com honestidade.** Fica o
gancho pronto (`EchoCanceller::new_opts(..., ns)`).

## Ressalva honesta sobre a medição

O ERLE ficou em 10–12 dB, e com fala local presente (duplex) cai para ~0 dB —
limitação conhecida do MDF sob *double-talk*. Números mais generosos (43 dB)
apareceram com um sinal **harmônico**, e 972 divergências com um sinal
desnormalizado; os dois eram artefatos do **sinal de teste**, não do AEC. O
número acima é o do gerador realista (formantes + pausas, RMS normalizado).
Merece validação com microfone e caixa de som reais.
