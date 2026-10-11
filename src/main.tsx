import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
// Estilos do shell mobile + tela de boot. Em stylesheet de verdade (não
// injetado pelo React) para valer desde o primeiro paint — antes partes da
// tela apareciam SEM CSS.
import './styles/mobile.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('[DisTorrent] #root não encontrado em index.html — render abortado')
ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
