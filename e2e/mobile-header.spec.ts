import { test, expect, type Page } from '@playwright/test';

// A barra superior do mobile tinha busca e download como botões próprios.
// Com a chamada de voz/vídeo e membros, o cabeçalho ficou com cinco alvos de
// 44px numa faixa estreita — e o pior não era o aperto: o badge de downloads
// ficava a ~12px do notch em telas de 360px, e busca aparecia duas vezes
// (ícone da barra + item do menu ⋯), que é o tipo de duplicata que faz o
// usuário achar que clicou na coisa errada.
//
// Este teste trava o comportamento: as duas ações continuam alcançáveis, mas
// só pelo menu ⋯.

async function boot(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/m');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill('Movel');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/m/, { timeout: 15000 });
}

test.describe('cabeçalho do mobile sem poluição', () => {
  test('barra superior não tem mais busca nem download', async ({ page }) => {
    await boot(page);
    await page.locator('.m-conversation, [data-testid="conv"]').first().click().catch(() => {});

    // o ícone de busca saiu da barra…
    await expect(page.getByLabel('Buscar nesta conversa')).toHaveCount(0);
    // …e o de downloads também (o badge vive no rótulo do menu agora)
    await expect(page.getByLabel('Downloads')).toHaveCount(0);
  });

  test('menu ⋯ expõe buscar e downloads', async ({ page }) => {
    await boot(page);
    await page.locator('.m-conversation, [data-testid="conv"]').first().click().catch(() => {});

    await page.getByLabel('Mais opções').click();

    await expect(page.getByText('Buscar mensagens')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Downloads/)).toBeVisible();

    // buscar abre a sheet, pelo mesmo caminho de antes
    await page.getByText('Buscar mensagens').click();
    await expect(page.getByPlaceholder(/uscar|Buscar/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('barra superior não transborda em tela estreita (360px)', async ({ page }) => {
    await boot(page);
    await page.locator('.m-conversation, [data-testid="conv"]').first().click().catch(() => {});
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(300);

    // nenhum filho da barra pode apontar para fora da viewport
    const overflow = await page.evaluate(() => {
      const bar = document.querySelector('.m-topbar, header');
      if (!bar) return null;
      const r = bar.getBoundingClientRect();
      return [...bar.querySelectorAll('button')].some(
        (b) => b.getBoundingClientRect().right > window.innerWidth + 1 || b.getBoundingClientRect().left < -1,
      ) ? { scrollW: r.width, inner: window.innerWidth } : null;
    });
    expect(overflow).toBeNull();
  });
});