import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LARGE_DOWNLOAD_BYTES } from '../src/services/downloadDirPrompt.ts'

const swarm = readFileSync('src/services/fileSwarm.ts', 'utf8')
const manager = readFileSync('src/services/downloadManager.ts', 'utf8')
const card = readFileSync('src/components/FileCard.tsx', 'utf8')
const cardRules = readFileSync('src/components/fileCardRules.ts', 'utf8')
const queue = readFileSync('src/services/downloadQueue.ts', 'utf8')
const spool = readFileSync('src-tauri/src/download_spool.rs', 'utf8')
const target = readFileSync('src-tauri/src/download_target.rs', 'utf8')
const seed = readFileSync('src-tauri/src/seed_files.rs', 'utf8')
const engine = readFileSync('distorrent-core/src/net/engine.rs', 'utf8')
const fFiles = readFileSync('distorrent-core/src/net/engine/f_files.rs', 'utf8')
const cache = readFileSync('distorrent-core/src/cache.rs', 'utf8')
const rules = readFileSync('src/services/fileRules.ts', 'utf8')

test('cartão: azul não iniciado → amarelo baixando → verde baixado', () => {
  assert.match(cardRules, /tone: 'idle'/, 'azul para o estado inicial')
  assert.match(cardRules, /tone: 'busy'/, 'amarelo enquanto baixa')
  assert.match(cardRules, /tone: 'done'/, 'verde depois de baixar')
  assert.match(cardRules, /label: 'Baixado'/, 'o rótulo diz Baixado, não Baixar')
  assert.match(cardRules, /label: pct > 0 \? `Baixando \$\{pct\}%` : 'Baixando…'/, 'o botão vira Baixando')
  assert.match(card, /st\.tone === 'done' \? pal\.green/, 'verde aplicado de verdade')
  assert.match(card, /pal\.yellow/, 'amarelo aplicado de verdade')
  assert.match(card, /pal\.accent/, 'azul aplicado de verdade')
})

test('depois de verde, baixar de novo é um botão VERMELHO separado', () => {
  assert.match(card, /showRedownload/, 'o card usa a regra')
  assert.match(card, /Baixar novamente/, 'rótulo explícito')
  assert.match(card, /background: pal\.red/, 'vermelho, não o azul de sempre')
  assert.match(cardRules, /showRedownload: true/, 'a regra liga o botão só no concluído')
  assert.match(cardRules, /clickable: false, showRedownload: true/, 'o verde não reinicia sozinho')
})

test('animação de baixando: spinner e brilho na barra', () => {
  assert.match(cardRules, /spinning: true/, 'spinner no botão')
  assert.match(card, /className=\{st\.spinning \? 'spin' : undefined\}/, 'classe de rotação real')
  assert.match(card, /className=\{st\.tone === 'busy' \? 'dl-bar' : undefined\}/, 'barra animada')
  const css = readFileSync('src/styles/global.css', 'utf8')
  assert.match(css, /\.dl-bar::after/, 'brilho correndo definido no CSS')
  assert.match(css, /@keyframes dl-pop/, 'pop do botão ao concluir')
})

test('cache de prévia: imagem 7 MB, vídeo 250 MB, TTL de 7 dias', () => {
  assert.match(rules, /MEDIA_CACHE_IMAGE_MAX = 7 \* 1024 \* 1024/, 'imagem 7 MB')
  assert.match(rules, /MEDIA_CACHE_VIDEO_MAX = 250 \* 1024 \* 1024/, 'vídeo 250 MB')
  assert.match(rules, /MEDIA_CACHE_TTL_DAYS = 7/, 'uma semana')
  assert.match(swarm, /shouldCacheMedia\(sf\.name, sf\.size\)/, 'o download respeita o limite')
  assert.match(cache, /DEFAULT_TTL_SECS: u64 = 7 \* 24 \* 60 \* 60/, 'o disco expira em 7 dias')
  assert.match(cache, /duration_since\(\*mtime\)/, 'TTL por data de acesso')
})

test('arquivo grande pergunta onde salvar antes de começar', () => {
  assert.equal(LARGE_DOWNLOAD_BYTES, 512 * 1024 * 1024)
  const action = readFileSync('src/services/downloadAction.ts', 'utf8')
  assert.match(action, /confirmLargeDestination/, 'o fluxo chama a confirmação')
  assert.match(action, /if \(escolhida === null\) return false/, 'cancelar não baixa')
  assert.match(action, /downloadDirSet\(escolhida\)/, 'a escolha é gravada')
  assert.match(target, /pub\(crate\) fn download_dir_set/, 'o Rust grava a pasta')
  assert.match(target, /\.distorrent-write-/, 'testa escrita antes de aceitar a pasta')
  assert.match(target, /GetDiskFreeSpaceExW/, 'mostra espaço livre de verdade')
})

test('download grande não vai para a memória: spool em disco por bloco', () => {
  assert.match(swarm, /MEMORY_MAX_BYTES = 64 \* 1024 \* 1024/, 'limite de memória')
  assert.match(swarm, /services\.spoolPut\(/, 'bloco vai para o disco')
  assert.match(swarm, /ChunkSet/, 'bitmap no lugar de Set gigante')
  assert.match(spool, /\.blk/, 'um arquivo por bloco (escrita fora de ordem segura)')
  assert.match(spool, /read_bits|bitmap_b64/, 'bitmap permite retomar')
  assert.match(manager, /if \(sf\.onDisk\)/, 'finalização do grande não monta blob')
  assert.match(manager, /spoolFinish|fileSwarm\.download\(sf\)/, 'quem monta é o Rust')
})

test('marca de recebido só depois do disco confirmar', () => {
  const trecho = swarm.slice(swarm.indexOf('this.enqueueSpoolWrite(file_id, index, b64data, sf.size)'))
  assert.match(trecho.slice(0, 600), /\.then\(\(\) => \{\s*sf\.have\.add\(index\)/, 'have só no then')
  assert.match(trecho.slice(0, 1000), /\.catch\(\(e\) => \{\s*this\.failChunk/, 'falha de disco vira bloco pendente')
  assert.match(swarm, /sf\.writing\?\.has\(i\)/, 'não pede de novo o bloco em escrita')
  assert.match(manager, /\(sf\.pendingWrites \?\? 0\) === 0/, 'não finaliza com escrita em voo')
})

test('escrita em lote: vários blocos por chamada de IPC (velocidade)', () => {
  assert.match(swarm, /services\.spoolPutBatch/, 'usa o lote do Rust')
  assert.match(swarm, /entries\.length >= 16/, 'envia quando junta 16 blocos')
  assert.match(spool, /pub\(crate\) fn spool_put_batch/, 'o comando existe')
  assert.match(spool, /#\[derive\(Debug, Clone, Serialize, Deserialize\)\]\s*struct SpoolMeta/, 'meta serializável')
})

test('velocidade tem teto configurável e limites de motor coerentes', () => {
  const speed = readFileSync('src/services/downloadSpeed.ts', 'utf8')
  assert.match(speed, /SPEED_PRESETS = \[0, 5, 10, 20, 50, 100\]/, 'presets de teto')
  assert.match(speed, /inFlightForLimit/, 'teto diminui a janela de blocos')
  assert.match(swarm, /inFlightForLimit\(tetoMbps\)/, 'o agendador respeita o teto')
  assert.match(engine, /MAX_ANNOUNCED_FILE_BYTES/, 'continua tendo teto de tamanho')
  const netlimit = readFileSync('distorrent-core/src/net/netlimit.rs', 'utf8')
  assert.match(netlimit, /bytes_per_peer_10s:\s*512 \* 1024 \* 1024/, 'teto de bytes por peer (50 MB/s)')
  assert.match(netlimit, /chunk_req_per_peer_10s:\s*2000/, 'teto de pedidos por peer')
  assert.match(netlimit, /frames_kill_per_peer_10s/, 'flood continua sendo morto')
})

test('reserva do .part acontece ANTES da primeira escrita', () => {
  // Sem isto o `spool_put` respondia "download não iniciado" e o bloco sumia.
  const trecho = swarm.slice(swarm.indexOf('let pronto = this.spoolReady.get(file_id)'))
  assert.match(trecho.slice(0, 400), /services\.spoolBegin/, 'reserva o arquivo primeiro')
  assert.match(trecho.slice(0, 1400), /pronto\s*\.then\(\(\) => this\.enqueueSpoolWrite/, 'só escreve depois da reserva')
})

test('re-download limpa a reserva para não reusar .part apagado', () => {
  assert.match(swarm, /this\.spoolReady\.delete\(file_id\)/, 'descarte/release limpa a promessa')
  assert.match(swarm, /private spoolReady = new Map<string, Promise<void>>/, 'guarda a promessa, não só um booleano')
})

test('fechar e reabrir: fila retoma e semeadura por caminho volta', () => {
  assert.match(manager, /rehydrateStatus/, 'estado no meio do caminho vira fila')
  assert.match(manager, /restoreSeeds\(\)/, 'o boot restaura semeadura')
  assert.match(swarm, /seedReadChunk/, 'bloco vem do caminho salvo')
  assert.match(seed, /seed\.meta\./, 'caminho fica no SQLite')
  assert.match(seed, /is_file\(\)/, 'arquivo que sumiu não é anunciado')
  assert.match(spool, /spool_gc|SPOOL_TTL_MS/, 'spool parado é limpo')
})

test('anúncio de 500 GB não estoura o frame de 1 MB', () => {
  assert.match(engine, /MAX_ANNOUNCED_FILE_BYTES: u64 = 500 \* 1024 \* 1024 \* 1024/, 'teto de 500 GiB')
  assert.match(fFiles, /chunks > 2_200_000/, 'teto de blocos coerente com 500 GiB')
  assert.match(rules, /MAX_ANNOUNCED_CHUNK_HASHES = 4096/, 'sem 2 milhões de hashes no frame')
  assert.match(rules, /512000/, 'frontend também aceita 500 GiB')
})

test('arquivo com falha não mente "Baixado"', () => {
  assert.match(cardRules, /prog\?\.status === 'failed'/, 'falha tem estado próprio')
  assert.match(cardRules, /label: 'Tentar de novo'/, 'rótulo honesto')
  assert.match(queue, /if \(ev === 'fail'\) return 'failed'/, 'máquina de estados mantém falha')
})
