// Primitives de interface das telas de configuração.
//
// Estas telas eram o ponto mais fraco da UI: cada painel escrevia seu próprio
// `inputStyle()`, seu próprio botão e seu próprio card, e o resultado eram
// larguras diferentes (460px, 560px, "85vh"), cores divergentes e zero
// consistência. Tudo aqui é compartilhado para que um campo em Configurações
// e o mesmo campo em Editor de Bot sejam literalmente o mesmo componente.

import type { ReactNode } from 'react'
import { Ic, type IconName } from './icons'

export const ui = {
  // painel de fundo
  bg: '#313338',
  surface: '#2b2d31',
  surfaceHover: '#35373c',
  elevated: '#383a40',
  input: '#1e1f22',
  border: '#26272b',
  borderStrong: '#3f4147',
  accent: '#5865f2',
  accentHover: '#4752c4',
  success: '#23a559',
  successHover: '#1a6339',
  warning: '#f0b232',
  danger: '#f23f42',
  dangerHover: '#c93b3e',
  text: '#dbdee1',
  heading: '#f2f3f5',
  muted: '#949ba4',
  link: '#00a8fc',

  // escala de espaço — múltiplos de 4, como o resto do app
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,

  radius: 8,
  radiusSm: 6,
  radiusLg: 12,
} as const

/** Larguras de modal. Antes cada tela escolhia a sua (460/560) e nada batia. */
export const WIDTHS = {
  /** Formulário curto: editar canal, criar categoria. */
  sm: 520,
  /** Painel padrão: criar bot, editar cargo. */
  md: 720,
  /** Tela de cadastro complexa: painel de bot completo. */
  lg: 880,
  /** Wizard de servidor, com resumo lateral. */
  wizard: 940,
} as const

/** Altura máxima de modal. `dvh` evita o bug do 100vh no mobile. */
export const MODAL_MAX_H = 'min(88vh, 88dvh)'

// ---------- tipografia ----------

export const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.6,
  color: ui.muted,
  marginBottom: 6,
  textTransform: 'uppercase',
}

export const helpStyle: React.CSSProperties = {
  fontSize: 12,
  color: ui.muted,
  lineHeight: 1.5,
  marginTop: 6,
}

export const errorStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#ffb3b3',
  background: '#3a1f22',
  border: '1px solid #f23f42',
  borderRadius: ui.radiusSm,
  padding: '10px 12px',
  lineHeight: 1.5,
}

// ---------- campos ----------

export function TextField({
  value,
  onChange,
  label,
  hint,
  error,
  placeholder,
  type = 'text',
  mono,
  maxLength,
  autoFocus,
  disabled,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  label?: string
  hint?: string
  error?: string | null
  placeholder?: string
  type?: string
  mono?: boolean
  maxLength?: number
  autoFocus?: boolean
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <div style={{ marginBottom: ui.lg }}>
      {label && <label style={labelStyle}>{label}</label>}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        aria-invalid={error ? true : undefined}
        style={{
          width: '100%',
          background: ui.input,
          border: `1px solid ${error ? ui.danger : ui.border}`,
          borderRadius: ui.radius,
          padding: '11px 12px',
          color: ui.text,
          fontSize: 14,
          fontFamily: mono ? 'JetBrains Mono, monospace' : undefined,
          outline: 'none',
          boxSizing: 'border-box',
          opacity: disabled ? 0.55 : 1,
          cursor: disabled ? 'not-allowed' : undefined,
        }}
      />
      {error ? (
        <div style={{ ...helpStyle, color: '#ff9c9c' }}>{error}</div>
      ) : hint ? (
        <div style={helpStyle}>{hint}</div>
      ) : null}
    </div>
  )
}

export function TextArea({
  value,
  onChange,
  label,
  hint,
  error,
  placeholder,
  rows = 3,
  maxLength,
  ariaLabel,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  label?: string
  hint?: string
  error?: string | null
  placeholder?: string
  rows?: number
  maxLength?: number
  ariaLabel?: string
  disabled?: boolean
}) {
  return (
    <div style={{ marginBottom: ui.lg }}>
      {label && <label style={labelStyle}>{label}</label>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        aria-invalid={error ? true : undefined}
        style={{
          width: '100%',
          background: ui.input,
          border: `1px solid ${error ? ui.danger : ui.border}`,
          borderRadius: ui.radius,
          padding: '11px 12px',
          color: ui.text,
          fontSize: 14,
          outline: 'none',
          resize: 'vertical',
          boxSizing: 'border-box',
          fontFamily: 'inherit',
          lineHeight: 1.5,
          opacity: disabled ? 0.55 : 1,
          cursor: disabled ? 'not-allowed' : undefined,
        }}
      />
      {error ? (
        <div style={{ ...helpStyle, color: '#ff9c9c' }}>{error}</div>
      ) : hint ? (
        <div style={helpStyle}>{hint}</div>
      ) : null}
    </div>
  )
}

export function Select({
  value,
  onChange,
  options,
  label,
  hint,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  label?: string
  hint?: string
  ariaLabel?: string
}) {
  return (
    <div style={{ marginBottom: ui.lg }}>
      {label && <label style={labelStyle}>{label}</label>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel ?? label}
        style={{
          width: '100%',
          background: ui.input,
          border: `1px solid ${ui.border}`,
          borderRadius: ui.radius,
          padding: '11px 12px',
          color: ui.text,
          fontSize: 14,
          outline: 'none',
          boxSizing: 'border-box',
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <div style={helpStyle}>{hint}</div>}
    </div>
  )
}

// ---------- botões ----------

export type ButtonVariant = 'primary' | 'success' | 'secondary' | 'ghost' | 'danger'

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  busy,
  icon,
  full,
  ariaLabel,
  title,
  type = 'button',
  style,
}: {
  children?: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  disabled?: boolean
  busy?: boolean
  icon?: IconName
  full?: boolean
  ariaLabel?: string
  title?: string
  type?: 'button' | 'submit'
  /** Ajuste pontual de layout. Não substitui os tokens — use para margem/ordem. */
  style?: React.CSSProperties
}) {
  const bg: Record<ButtonVariant, string> = {
    primary: ui.accent,
    success: ui.success,
    secondary: ui.input,
    ghost: 'transparent',
    danger: ui.danger,
  }
  const fg: Record<ButtonVariant, string> = {
    primary: '#fff',
    success: '#fff',
    secondary: ui.text,
    ghost: ui.muted,
    danger: '#fff',
  }
  const off = disabled || busy
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={off}
      title={title}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        width: full ? '100%' : undefined,
        background: off ? ui.surfaceHover : bg[variant],
        color: off ? ui.muted : fg[variant],
        border: variant === 'secondary' || variant === 'ghost' ? `1px solid ${ui.border}` : 'none',
        borderRadius: ui.radius,
        padding: '10px 16px',
        fontWeight: 700,
        fontSize: 13,
        cursor: off ? 'not-allowed' : 'pointer',
        opacity: off ? 0.6 : 1,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {icon && <Ic name={icon} size={15} />}
      {children}
    </button>
  )
}

/** Botão só de ícone. SEMPRE com `label` — é o que o leitor de_screen lê. */
export function IconButton({
  icon,
  onClick,
  label,
  variant = 'ghost',
  disabled,
  active,
  size = 32,
}: {
  icon: IconName
  onClick?: () => void
  /** Nome da ação. Obrigatório: ícone sozinho não é acessível. */
  label: string
  variant?: ButtonVariant
  disabled?: boolean
  active?: boolean
  size?: number
}) {
  const bg = active ? ui.accent : variant === 'ghost' ? 'transparent' : ui.input
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: bg,
        color: active ? '#fff' : ui.muted,
        border: variant === 'ghost' && !active ? 'none' : `1px solid ${ui.border}`,
        borderRadius: ui.radiusSm,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        padding: 0,
        flexShrink: 0,
      }}
    >
      <Ic name={icon} size={Math.round(size * 0.5)} />
    </button>
  )
}

// ---------- containers ----------

/** Card de conteúdo. `pad: false` quando o próprio conteúdo já tem padding. */
export function Card({
  children,
  title,
  subtitle,
  icon,
  action,
  pad = true,
}: {
  children: ReactNode
  title?: string
  subtitle?: string
  icon?: IconName
  action?: ReactNode
  pad?: boolean
}) {
  return (
    <section
      style={{
        background: ui.surface,
        border: `1px solid ${ui.border}`,
        borderRadius: ui.radiusLg,
        padding: pad ? ui.xl : 0,
        marginBottom: ui.xl,
      }}
    >
      {(title || action) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: ui.md,
            marginBottom: ui.lg,
          }}
        >
          {icon && (
            <span style={{ color: ui.muted, marginTop: 2 }}>
              <Ic name={icon} size={18} />
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            {title && (
              <h3 style={{ fontSize: 15, fontWeight: 800, color: ui.heading, margin: 0 }}>
                {title}
              </h3>
            )}
            {subtitle && (
              <div style={{ ...helpStyle, marginTop: 4 }}>{subtitle}</div>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

/** Aviso inline (informação, não erro). */
export function Notice({
  children,
  tone = 'info',
  icon,
}: {
  children: ReactNode
  tone?: 'info' | 'warning' | 'danger' | 'success'
  icon?: IconName
}) {
  const tones = {
    info: { bg: '#232428', border: ui.borderStrong, fg: ui.text, ic: 'info' as IconName },
    warning: { bg: '#3a3320', border: '#f0b232', fg: '#ffe0a3', ic: 'warn' as IconName },
    danger: { bg: '#3a1f22', border: ui.danger, fg: '#ffb3b3', ic: 'warn' as IconName },
    success: { bg: '#1f3327', border: ui.success, fg: '#a5e5bd', ic: 'check' as IconName },
  }
  const t = tones[tone]
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        gap: ui.sm,
        alignItems: 'flex-start',
        background: t.bg,
        border: `1px solid ${t.border}`,
        borderRadius: ui.radius,
        padding: '11px 13px',
        color: t.fg,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <span style={{ flexShrink: 0, marginTop: 1 }}>
        <Ic name={icon ?? t.ic} size={15} />
      </span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  )
}

/** Linha rótulo/valor, para blocos de informação (dono do servidor, id...). */
export function DataRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: ui.md, padding: '7px 0', alignItems: 'baseline' }}>
      <span style={{ ...labelStyle, marginBottom: 0, flexShrink: 0, minWidth: 120 }}>{label}</span>
      <span style={{ fontSize: 13, color: ui.text, minWidth: 0, wordBreak: 'break-word' }}>
        {children}
      </span>
    </div>
  )
}

/** Estado vazio: ícone + texto + ação opcional. Melhor que div cinza vazia. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: IconName
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: ui.md,
        padding: `${ui.xxl}px ${ui.lg}px`,
        textAlign: 'center',
        background: ui.surface,
        border: `1px dashed ${ui.borderStrong}`,
        borderRadius: ui.radiusLg,
      }}
    >
      <span style={{ color: ui.muted }}>
        <Ic name={icon} size={28} />
      </span>
      <div style={{ fontSize: 14, fontWeight: 700, color: ui.heading }}>{title}</div>
      {hint && <div style={{ ...helpStyle, maxWidth: 420 }}>{hint}</div>}
      {action}
    </div>
  )
}

// ---------- diálogo ----------

/**
 * Modal com fundo, clique-fora e ESC. Centraliza as três coisas que toda tela
 * precisa e que antes cada uma reimplementava (e uma delas esquecia do ESC).
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = WIDTHS.md,
  zIndex = 90,
  labelId,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  width?: number
  zIndex?: number
  labelId?: string
}) {
  if (!open) return null
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex,
        padding: ui.lg,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={labelId ? undefined : title}
        aria-labelledby={labelId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
        style={{
          background: ui.bg,
          border: `1px solid ${ui.border}`,
          borderRadius: ui.radiusLg,
          padding: ui.xl,
          width: '100%',
          maxWidth: width,
          maxHeight: MODAL_MAX_H,
          overflowY: 'auto',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: ui.md,
            marginBottom: ui.xl,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              id={labelId}
              style={{ fontSize: 19, fontWeight: 800, color: ui.heading, margin: 0 }}
            >
              {title}
            </h2>
            {subtitle && (
              <div style={{ ...helpStyle, marginTop: 5 }}>{subtitle}</div>
            )}
          </div>
          <IconButton icon="x" label="Fechar" onClick={onClose} size={30} />
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>{children}</div>

        {footer && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: ui.sm,
              marginTop: ui.xl,
              paddingTop: ui.lg,
              borderTop: `1px solid ${ui.border}`,
              flexShrink: 0,
              flexWrap: 'wrap',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}