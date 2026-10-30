// REGRAS PURAS DA ATUALIZAÇÃO (sem imports de runtime).
//
// POR QUE ESTE ARQUIVO É SEPARADO DE `updater.ts`: `updater.ts` importa
// `./index`, que carrega `@tauri-apps/api` — e aí a suíte de unit (Node) não
// consegue nem importar o módulo. Aqui não entra nada de Tauri, rede ou disco:
// só comparação de versão e o fluxo, para poder ser testado de verdade.
//
// O Rust (`src-tauri/src/updater.rs`) só BUSCA e BAIXA. A decisão de "esta
// versão é mais nova?" e "devo instalar sozinho?" mora aqui.

// Formatação de bytes: uma implementação só (`shared/bytes.ts`).
export { formatBytes } from '../shared/bytes.ts'

/** Metadados devolvidos por `update_check` (Rust). */
export interface UpdateInfo {
  current: string
  latest: string
  asset_name: string
  asset_size: number
  download_url: string
  /** `sha256:<hex>` quando o GitHub informar; vazio quando não informar. */
  digest: string
  notes: string
  html_url: string
  platform: string
  /**
   * O nome do asset cita uma versão diferente da tag da release.
   *
   * Acontece quando a release é publicada reaproveitando um binário velho
   * (`build-installer.ps1 -SkipBuild` com `distorrent.exe` antigo): instalar
   * "a versão nova" não muda nada e o app pediria atualização para sempre. O
   * cartão precisa dizer isso em vez de prometer uma atualização que não existe.
   */
  label_mismatch?: boolean
  /** Versão citada no nome do asset, quando ele cita alguma. */
  asset_version?: string
}

export interface ParsedVersion {
  nums: number[]
  /** Sufixo de pré-release (`pre-alpha`, `beta.2`); vazio em versão final. */
  pre: string
}

/**
 * Lê uma versão no formato do projeto: `1.1.10-pre-alpha`, `v1.1.9`, `2.0`.
 *
 * POR QUE NÃO USAR `Number()` DIRETO: `1.1.10` comparado como string é MENOR
 * que `1.1.9` ("10" < "9" na primeira posição), e o app ficaria em loop
 * oferecendo uma atualização que ele já tem. Cada componente numérico é
 * comparado como número.
 */
export function parseVersion(raw: string): ParsedVersion {
  const s = String(raw ?? '').trim().replace(/^v/i, '')
  // Separa o núcleo numérico do sufixo: `1.1.10-pre-alpha` -> `1.1.10` + `pre-alpha`
  const [core, ...rest] = s.split('-')
  const nums = (core ?? '')
    .split('.')
    .map((p) => {
      // `10a` -> 10: build do Tauri às vezes anexa letra no patch.
      const m = /^\d+/.exec(p.trim())
      return m ? Number(m[0]) : 0
    })
  if (nums.length === 0) nums.push(0)
  return { nums, pre: rest.join('-').toLowerCase() }
}

/**
 * Compara duas versões. `> 0` quando `a` é mais nova que `b`.
 *
 * Regra de pré-release (SemVer simplificado): `1.1.11-pre-alpha` é MAIS NOVA
 * que `1.1.10` — o projeto publica sempre como pré-alpha, então tratar
 * pré-release como "menor" faria o app nunca atualizar. Já na MESMA base,
 * `1.1.11` (final) é mais nova que `1.1.11-pre-alpha`, que é o comportamento
 * esperado no dia em que existir uma release estável.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] ?? 0
    const nb = pb.nums[i] ?? 0
    if (na !== nb) return na > nb ? 1 : -1
  }
  if (pa.pre === pb.pre) return 0
  // mesma base numérica: final (sem sufixo) > pré-release
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre > pb.pre ? 1 : -1
}

/** Existe versão mais nova publicada? */
export function isNewer(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0
}

/** Só as N primeiras linhas das notas: o overlay não vira parede de texto. */
export function shortNotes(notes: string, maxLines = 6): string {
  const lines = String(notes ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
  return lines.slice(0, maxLines).join('\n')
}

/**
 * Como o update é aplicado nesta plataforma.
 *
 * - `auto`: baixa, confere o hash e **executa** o instalador; o app reabre
 *   sozinho. É o Windows (Inno com `/RESTARTAPPLICATIONS`).
 * - `manual`: baixa e **abre o instalador do sistema**; o usuário conclui e o
 *   app reabre. Linux (`.deb`/`.AppImage` exigem root para instalar) e Android
 *   (o sistema exige um toque de confirmação — nenhum app fora da loja pode
 *   instalar silenciosamente).
 * - `link`: não há instalador para baixar (macOS sem bundle assinado).
 */
export type UpdateMode = 'auto' | 'manual' | 'link'

export function updateModeFor(platform: string): UpdateMode {
  if (platform === 'windows') return 'auto'
  if (platform === 'linux') return 'manual'
  // Android: o Rust baixa o APK e o plugin nativo abre o instalador.
  if (platform === 'android') return 'manual'
  return 'link'
}

/** Resultado do fluxo, para a UI decidir o que fazer depois. */
export type UpdateOutcome =
  | { kind: 'none' }
  | { kind: 'later'; info: UpdateInfo }
  | { kind: 'stalled'; info: UpdateInfo }
  | { kind: 'applied'; info: UpdateInfo; path: string }
  | { kind: 'error'; message: string }

export interface UpdateDeps {
  /** `null` = build de navegador (não há instalador para baixar). */
  check: () => Promise<UpdateInfo>
  download: (info: UpdateInfo) => Promise<string>
  apply: (path: string) => Promise<void>
  quit: () => Promise<void>
  /** Guarda "pulei esta versão" / "essa falhou" / "essa eu já instalei". */
  getFlag: (key: string) => Promise<string | null>
  setFlag: (key: string, value: string) => Promise<void>
}

export const FLAG_SKIP = 'update.skip'
export const FLAG_FAILED = 'update.failed'
/**
 * Versão que este app JÁ instalou e continuou rodando a antiga.
 *
 * É o freio do loop "atualiza → fecha → abre → atualiza de novo". Sem ele, um
 * instalador rotulado errado (o caso clássico: release `v1.1.12` empacotando um
 * `distorrent.exe` 1.1.11) faz o app baixar, instalar, reabrir e encontrar a
 * MESMA atualização pendente para sempre — o usuário vê a janela piscando.
 */
export const FLAG_APPLIED = 'update.applied'

/**
 * Fluxo completo, sem UI: verifica, decide, baixa, confere e aplica.
 *
 * Regras de segurança/robustez que o chamador NÃO pode afrouxar:
 *   1. Falha de rede não bloqueia o app — devolve `none`/`error` e a UI segue.
 *   2. Versão marcada como "pular" não é oferecida de novo.
 *   3. Versão que JÁ falhou ao instalar não é tentada em loop automático: vira
 *      `later`, com botão manual. Sem isso, um instalador quebrado reiniciaria
 *      o app para sempre.
 *   4. Versão que já foi INSTALADA e não mudou a versão em execução vira
 *      `stalled` — nunca tenta sozinha outra vez (ver `FLAG_APPLIED`).
 *   5. Nada é aplicado sem o hash conferido (o Rust recusa; aqui só repassamos).
 */
export async function runUpdateFlow(
  deps: UpdateDeps,
  opts: { autoApply: boolean },
): Promise<UpdateOutcome> {
  let info: UpdateInfo
  try {
    info = await deps.check()
  } catch (e) {
    return { kind: 'error', message: String((e as Error)?.message ?? e) }
  }

  if (!isNewer(info.current, info.latest)) return { kind: 'none' }
  if ((await deps.getFlag(FLAG_SKIP)) === info.latest) return { kind: 'none' }

  const mode = updateModeFor(info.platform)
  // `link` só quando a plataforma não sabe instalar sozinha (macOS).
  if (mode === 'link') return { kind: 'later', info }

  // FREIO DO LOOP: já instalamos ESTA versão e o app continua rodando uma
  // anterior. Instalar de novo produz exatamente o mesmo resultado — a janela
  // fecharia e abriria para sempre. Dizemos a verdade e paramos.
  const alreadyApplied = (await deps.getFlag(FLAG_APPLIED)) === info.latest
  if (alreadyApplied) return { kind: 'stalled', info }

  const failedBefore = (await deps.getFlag(FLAG_FAILED)) === info.latest
  if (!opts.autoApply || failedBefore) return { kind: 'later', info }

  // ANDROID: baixa e abre o instalador do sistema IGUAL ao Linux.
  //
  // Antes este `return` acontecia antes de tudo e o Android NUNCA atualizava
  // sozinho: o app checava, mostrava o cartão e ficava por isso mesmo — quem
  // não tocasse no botão passava semanas numa build antiga (protocolo P2P
  // diferente degrada a rede toda).
  //
  // O download de ~40 MB é o mesmo que o Windows faz. O toque de confirmação
  // do instalador continua OBRIGATÓRIO e é do sistema: nenhum app fora da
  // loja instala APK sem ele. O `autoApply` respeita a preferência "atualizar
  // sozinho" — desligada, vira cartão manual, como nas outras plataformas.

  let path: string
  try {
    path = await deps.download(info)
  } catch (e) {
    // Download quebrado NÃO marca falha permanente: pode ser rede. A próxima
    // abertura tenta de novo (é barato e é o que o usuário espera).
    return { kind: 'error', message: String((e as Error)?.message ?? e) }
  }

  // Marca ANTES de executar: o instalador fecha este processo, então não há
  // garantia de que o código abaixo rode. Se a marcação ficasse depois e o
  // Inno matasse o app no meio, o loop voltaria na próxima abertura.
  await deps.setFlag(FLAG_APPLIED, info.latest).catch(() => {})

  try {
    await deps.apply(path)
  } catch (e) {
    // Aqui a falha é do INSTALADOR. Desfaz a marca e registra a falha para não
    // reiniciar em loop (a marca de "aplicado" seria mentira: não aplicou).
    await deps.setFlag(FLAG_APPLIED, '').catch(() => {})
    await deps.setFlag(FLAG_FAILED, info.latest).catch(() => {})
    return { kind: 'error', message: String((e as Error)?.message ?? e) }
  }

  // Windows: o Inno fecha este processo (`/CLOSEAPPLICATIONS`) e reabre o app
  // (`/RESTARTAPPLICATIONS` → hoje é o `[Code]` do installer/distorent.iss, que
  // espera o mutex cair antes de abrir).
  //
  // NÃO existe timer de saída aqui de propósito. Existia um `setTimeout(quit,
  // 4000)` como "reserva"; quando o Inno reabria o app antes dos 4 s, o timer
  // da cópia ANTIGA derrubava a cópia NOVA (o processo novo herda o handle do
  // mutex mas não o timer) — a janela abria, fechava e reabria em loop.
  // Quem encerra este processo é o instalador, que também é quem reinicia.
  return { kind: 'applied', info, path }
}
