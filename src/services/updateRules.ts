// REGRAS PURAS DA ATUALIZAÇÃO (sem imports de runtime/Tauri/rede/disco).
// Separado de `updater.ts` para ser importável (e testável) pelo unit em Node;
// o Rust só busca/baixa — a decisão de versão mora aqui.

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
  /** Asset cita versão diferente da tag (binário velho reaproveitado) — o cartão avisa. */
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
 * Lê uma versão no formato do projeto (`1.1.10-pre-alpha`, `v1.1.9`, `2.0`).
 * Cada componente numérico é comparado como NÚMERO — como string, "10" < "9".
 */
export function parseVersion(raw: string): ParsedVersion {
  const s = String(raw ?? '').trim().replace(/^v/i, '')
  /** Separa o núcleo numérico do sufixo: `1.1.10-pre-alpha` -> `1.1.10` + `pre-alpha`. */
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
 * Compara duas versões (`> 0` = `a` mais nova).
 *
 * IGNORA o sufixo de pré-release — igual ao `compare_version_strings` do Rust.
 * As duas pontas PRECISAM concordar: o Rust escolhe QUAL release é a mais nova e
 * este código decide se ela é mais nova que a atual.
 *
 * BUG REAL (achado em 01/11/2026): aqui o sufixo era considerado e no Rust não.
 * A tag é limpa (`v1.1.23`) e o app reporta `1.1.23-pre-alpha`, então quem
 * atualizava via `isNewer('1.1.23-pre-alpha', '1.1.23') === true` TODA vez:
 * o app baixava o instalador de novo e caía em `stalled` depois de reiniciar.
 *
 * Regra: `1.1.23-pre-alpha` e `1.1.23` são a MESMA versão.
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
  return 0
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
 * Como o update é aplicado: `auto` (Windows, executa o instalador), `manual`
 * (Linux/Android exigem confirmação do usuário) ou `link` (sem instalador).
 */
export type UpdateMode = 'auto' | 'manual' | 'link'

/**
 * Como o update é aplicado: `auto` (a versão nova entra e o app reabre sozinho),
 * `manual` (o instalador do sistema abre e o usuário confirma) ou `link`.
 *
 * O que dá para automatizar de verdade:
 * - Windows: Inno ` /SILENT` + reinício — automático de fato.
 * - Linux: depende do formato. AppImage é um arquivo só, então o Rust copia por
 *   cima e reexecuta (`auto`). `.deb` exige root (`dpkg -i`) ou um prompt de
 *   senha (pkexec), que não é automático — segue `manual`.
 * - Android: o sistema exige o toque de confirmação para instalar APK fora da
 *   loja. Não há como contornar sem root; prometer `auto` seria mentira.
 */
export function updateModeFor(platform: string, assetName = ''): UpdateMode {
  if (platform === 'windows') return 'auto'
  // Linux: só o AppImage se substitui sozinho; o .deb abre no instalador.
  if (platform === 'linux') {
    return /\.appimage$/i.test(assetName) ? 'auto' : 'manual'
  }
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
 * Versão que este app JÁ instalou e continuou rodando a antiga — freio do loop
 * "atualiza → fecha → abre → atualiza de novo" com instalador rotulado errado.
 */
export const FLAG_APPLIED = 'update.applied'
/**
 * Sinal do Rust de que o AppImage já foi substituído e reaberto: não é erro,
 * é o gatilho para encerrar esta cópia antiga.
 */
export const REINICIAR_SINAL = 'ATUALIZADO_E_REINICIADO'

/**
 * Fluxo completo, sem UI: verifica, decide, baixa, confere e aplica.
 * Garante: falha de rede não bloqueia; versão pulada não volta; versão que
 * falhou vira `later` (não loop); instalada sem efeito vira `stalled`; hash
 * sempre conferido antes de aplicar.
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

  const mode = updateModeFor(info.platform, info.asset_name)
  // `link` só quando a plataforma não sabe instalar sozinha (macOS).
  if (mode === 'link') return { kind: 'later', info }

  // FREIO DO LOOP: versão já instalada sem efeito — instalar de novo repete o resultado.
  const alreadyApplied = (await deps.getFlag(FLAG_APPLIED)) === info.latest
  if (alreadyApplied) return { kind: 'stalled', info }

  const failedBefore = (await deps.getFlag(FLAG_FAILED)) === info.latest
  if (!opts.autoApply || failedBefore) return { kind: 'later', info }

  // ANDROID: baixa e abre o instalador do sistema como no Linux. Antes o return
  // antecipado impedia o Android de atualizar sozinho; o toque de confirmação
  // continua obrigatório (é do sistema), e `autoApply` segue a preferência.

  let path: string
  try {
    path = await deps.download(info)
  } catch (e) {
    // Download quebrado não marca falha permanente: pode ser rede; tenta de novo.
    return { kind: 'error', message: String((e as Error)?.message ?? e) }
  }

  // Marca ANTES de executar: o instalador fecha este processo (sem garantia
  // de que o código abaixo rode — marca depois faria o loop voltar).
  await deps.setFlag(FLAG_APPLIED, info.latest).catch(() => {})

  try {
    await deps.apply(path)
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    // AppImage no Linux: o Rust já trocou o arquivo e REABRIU a versão nova.
    // Aqui só encerramos esta cópia antiga pelo caminho normal do app.
    if (msg.includes(REINICIAR_SINAL)) {
      await deps.quit().catch(() => {})
      return { kind: 'applied', info, path }
    }
    // Falha do INSTALADOR: desfaz a marca e registra a falha para não reiniciar em loop.
    await deps.setFlag(FLAG_APPLIED, '').catch(() => {})
    await deps.setFlag(FLAG_FAILED, info.latest).catch(() => {})
    return { kind: 'error', message: msg }
  }

  // Windows: o Inno fecha este processo e reabre o app. NÃO existe timer de
  // saída de propósito: um `setTimeout(quit)` da cópia antiga derrubava a
  // cópia nova (loop de janela). Quem encerra e reinicia é o instalador.
  return { kind: 'applied', info, path }
}
