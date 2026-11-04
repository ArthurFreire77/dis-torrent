/**
 * Baixa o texto como arquivo no WebView. Blob + object URL porque o app não tem
 * permissão de escrita em pasta arbitrária e o download é de texto, não de mídia.
 */
export function baixarTexto(nomeArquivo: string, texto: string, tipo = 'text/markdown;charset=utf-8'): boolean {
  let url = ''
  try {
    url = URL.createObjectURL(new Blob([texto], { type: tipo }))
  } catch {
    return false
  }
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
}
