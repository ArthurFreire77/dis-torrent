import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import './styles/mobile.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('[DisTorrent] #root não encontrado em index.html — render abortado')

/**
 * Tela de falha em vez de página branca.
 *
 * POR QUE: um erro em qualquer componente derrubava a árvore inteira e o
 * usuário via uma tela branca sem texto, sem botão e sem pista — o mesmo
 * sintoma de "o app abriu e ficou branco". Aqui a mensagem real aparece e há
 * como recarregar sem fechar o processo pelo gerenciador de tarefas.
 */
function mensagem(e: unknown): string {
  if (e instanceof Error) return e.stack || `${e.name}: ${e.message}`
  try { return String(e) } catch { return 'erro desconhecido' }
}

/**
 * Avisa o backend que a interface desenhou.
 *
 * A janela nasce com `visible: false` para não "piscar" no boot do autostart.
 * Este aviso é quem a mostra. Repete com backoff porque perder o único aviso
 * deixaria o app aberto e invisível — o pior desfecho possível.
 */
function avisarUiPronta() {
  let tentativas = 0
  const tentar = () => {
    tentativas++
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('app_ui_ready'))
      .catch(() => {
        if (tentativas < 5) window.setTimeout(tentar, 300 * tentativas)
      })
  }
  tentar()
}

class BootBoundary extends React.Component<
  { children: React.ReactNode },
  { erro: unknown | null }
> {
  state = { erro: null as unknown | null }

  static getDerivedStateFromError(erro: unknown) {
    return { erro }
  }

  componentDidCatch(erro: unknown, info: React.ErrorInfo) {
    console.error('[DisTorrent] render falhou', erro, info?.componentStack)
  }

  render() {
    if (!this.state.erro) return this.props.children
    return (
      <div
        role="alert"
        data-testid="boot-error"
        style={{
          minHeight: '100vh', background: '#1e1f22', color: '#dbdee1',
          fontFamily: 'Inter, system-ui, sans-serif', padding: '28px 22px',
          display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center',
          justifyContent: 'center', textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 22, fontWeight: 900, color: '#f2f3f5' }}>DisTorrent tropeçou ao abrir</div>
        <div style={{ fontSize: 13, color: '#949ba4', maxWidth: 620, lineHeight: 1.6 }}>
          A interface não conseguiu montar. Isso é um defeito nosso, não do seu PC —
          o texto abaixo é o erro exato, útil para corrigir.
        </div>
        <pre
          style={{
            maxWidth: 760, width: '100%', maxHeight: 260, overflow: 'auto',
            textAlign: 'left', background: '#111214', border: '1px solid #26272b',
            borderRadius: 10, padding: 12, fontSize: 11, lineHeight: 1.5,
            color: '#f0b232', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          }}
        >
          {mensagem(this.state.erro)}
        </pre>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: '#5865f2', color: '#fff', border: 'none', borderRadius: 8,
              padding: '10px 18px', fontWeight: 700, cursor: 'pointer', fontSize: 13,
            }}
          >
            Recarregar
          </button>
          <button
            onClick={() => {
              const txt = mensagem(this.state.erro)
              try { void navigator.clipboard?.writeText(txt) } catch {  }
            }}
            style={{
              background: '#2b2d31', color: '#dbdee1', border: '1px solid #26272b',
              borderRadius: 8, padding: '10px 18px', fontWeight: 700,
              cursor: 'pointer', fontSize: 13,
            }}
          >
            Copiar erro
          </button>
        </div>
      </div>
    )
  }
}

// Erro fora do React (promise rejeitada, listener, extensão): sem isto o
// console fica com a única cópia e a janela continua branca.
function mostrarFatal(texto: string) {
  try {
    let alvo = document.getElementById('boot-fatal')
    if (!alvo) {
      alvo = document.createElement('div')
      alvo.id = 'boot-fatal'
      alvo.setAttribute('role', 'alert')
      alvo.style.cssText =
        'position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;gap:12px;' +
        'align-items:center;justify-content:center;padding:28px;text-align:center;' +
        'background:#1e1f22;color:#dbdee1;font-family:Inter,system-ui,sans-serif'
      alvo.innerHTML =
        '<div style="font-size:20px;font-weight:900;color:#f2f3f5">DisTorrent não conseguiu abrir</div>' +
        '<div style="font-size:13px;color:#949ba4;max-width:620px;line-height:1.6">' +
        'O erro exato está abaixo. Ele serve para corrigir o defeito — copie e envie.</div>' +
        '<pre id="boot-fatal-msg" style="max-width:760px;width:100%;max-height:240px;overflow:auto;' +
        'text-align:left;background:#111214;border:1px solid #26272b;border-radius:10px;padding:12px;' +
        'font-size:11px;line-height:1.5;color:#f0b232;white-space:pre-wrap;word-break:break-word;' +
        'font-family:JetBrains Mono,ui-monospace,monospace;margin:0"></pre>' +
        '<button id="boot-fatal-reload" style="background:#5865f2;color:#fff;border:none;border-radius:8px;' +
        'padding:10px 18px;font-weight:700;cursor:pointer;font-size:13px">Recarregar</button>'
      document.body.appendChild(alvo)
      const btn = document.getElementById('boot-fatal-reload')
      btn?.addEventListener('click', () => window.location.reload())
    }
    const pre = document.getElementById('boot-fatal-msg')
    if (pre) pre.textContent = texto
  } catch {  }
}

window.addEventListener('error', (ev) => {
  mostrarFatal(mensagem(ev.error ?? ev.message))
})
window.addEventListener('unhandledrejection', (ev) => {
  mostrarFatal(mensagem(ev.reason))
})

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <BootBoundary>
      <App />
    </BootBoundary>
  </React.StrictMode>
)

// Só depois do primeiro frame: mostrar a janela antes de haver pixel pinta o
// fundo vazio e parece a tal tela branca.
requestAnimationFrame(() => {
  requestAnimationFrame(avisarUiPronta)
})
