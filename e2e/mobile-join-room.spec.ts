import { test, expect, type Page } from '@playwright/test'

// O botão "Entrar" da chamada precisa existir no CELULAR quando há sala viva
// anunciada. Antes ele saía como um número solto ao lado de um telefone e
// passava batido (relato: "não tem botão para entrar na chamada no Android").
//
// A sala é simulada publicando-se um evento `call_room` pelo mesmo canal que o
// motor usa (`distorrent://event` no nativo). No modо navegador o app escuta o
// barramento local, então injetamos pelo `window` via BroadcastChannel — é o
// mesmo caminho do modo web, sem depender de motor.

async function criarConta(page: Page, nome: string) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 })
  await page.getByPlaceholder('Seu nome').fill(nome)
  await page.getByRole('button', { name: 'Criar conta' }).click()
  // Com viewport de celular o app entra no shell móvel (`/m`), não em `/d`.
  // Exigir só `/d/distorrent` reprovava o teste antes de chegar no botão.
  await expect(page).toHaveURL(/\/(d\/distorrent|m)$/, { timeout: 15000 })
}

test('mobile mostra o botão Entrar quando há sala de chamada anunciada', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await criarConta(page, 'Movel')
  await page.goto('/m')
  await expect(page.getByRole('button', { name: 'Chats' })).toBeVisible({ timeout: 15000 })

  // Publica uma sala para a primeira conversa que existir e confere o botão.
  const publicou = await page.evaluate(async () => {
    const convs = JSON.parse(localStorage.getItem('distorrent:conversations') ?? '[]')
    const convId = convs?.[0]?.id
    if (!convId) return false
    // O app escuta o bus local; a sala é anunciada como o motor faria.
    const bc = new BroadcastChannel('distorrent-bus-v2')
    bc.postMessage({
      type: 'call_room',
      call_id: 'call-teste-sala',
      conv_id: convId,
      kind: 'voice',
      state: 'open',
      participants: ['host-teste'],
      host_fp: 'host-teste',
    })
    bc.close()
    return true
  })

  test.skip(!publicou, 'sem conversa criada para anunciar sala (cenário de conta nova)')

  const entrada = page.getByTestId('mobile-join-room').first()
  await expect(entrada).toBeVisible({ timeout: 10000 })
  await expect(entrada).toContainText('Entrar')
})
