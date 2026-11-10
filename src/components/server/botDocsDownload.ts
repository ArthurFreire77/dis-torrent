/**
 * Baixa o texto como arquivo no WebView. Blob + object URL porque o app não tem
 * permissão de escrita em pasta arbitrária e o download é de texto, não de mídia.
 * Retorna `false` quando o WebView bloqueia o download (o chamador avisa o usuário).
 */
export function baixarTexto(nomeArquivo: string, texto: string, tipo = 'text/markdown;charset=utf-8'): boolean {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false
  let url = ''
  try {
    url = URL.createObjectURL(new Blob([texto], { type: tipo }))
  } catch {
    return false
  }
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = nomeArquivo
    a.rel = 'noopener'
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    // Revoga depois do clique: revogar na hora cancela o download em WebKitGTK.
    setTimeout(() => {
      try {
        document.body.removeChild(a)
      } catch {}
      try {
        URL.revokeObjectURL(url)
      } catch {}
    }, 1200)
    return true
  } catch {
    try {
      URL.revokeObjectURL(url)
    } catch {}
    return false
  }
}
