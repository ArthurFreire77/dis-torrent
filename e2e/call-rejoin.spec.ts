import { test, expect, type Page } from '@playwright/test';

// CICLO COMPLETO DE CHAMADAS — o bug relatado pelo usuário:
// "faz uma chamada de vídeo, sai, entra em outra e não funciona — não
// consegue chamar de novo, áudio também". Este spec exercita chamar →
// conectar → sair → CHAMAR DE NOVO (mesma direção e direção invertida),
// que era exatamente o caminho que quebrava.

test.use({
  browserName: 'chromium',
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

async function createAccount(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/forge/, { timeout: 15000 });
}

async function fpOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem('forge:identity') ?? '';
    return (JSON.parse(raw) as { fingerprint: string }).fingerprint;
  });
}

async function befriend(a: Page, b: Page) {
  const fpB = await fpOf(b);
  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  await a.getByPlaceholder('Digite o fingerprint do seu amigo').fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });
  await b.getByRole('button', { name: 'Aceitar' }).first().click();
  await a.getByRole('button', { name: 'Todos' }).click();
  await expect(a.locator('.nav-row', { hasText: 'Bob' }).first()).toBeVisible({ timeout: 15000 });
}

function collectCrashSignals(page: Page, bucket: string[]) {
  page.on('pageerror', (e) => bucket.push(String((e as Error)?.message ?? e)));
  page.on('console', (m) => {
    if (m.type() === 'error') bucket.push(m.text());
  });
}

/** Abre a DM (se ainda não estiver aberta) e liga (voz).
 *  Após a 1ª chamada a view já é a DM — as .friend-row só existem na lista
 *  de amigos, e clicar nelas de novo travava em retry eterno. */
async function dial(a: Page, name: string) {
  const inDm = await a.getByPlaceholder(/Conversar com/).isVisible().catch(() => false)
  if (!inDm) {
    // Garante a LISTA de amigos: quem atendeu amizade fica na view "Pendentes"
    // (sem .friend-row nenhuma). Esperas EXPLÍCITAS: retry eterno de clique não
    // diz em qual passo morreu — falha rápida e legível.
    await a.getByRole('button', { name: 'Amigos' }).first().click();
    const todos = a.getByRole('button', { name: 'Todos' });
    await expect(todos).toBeVisible({ timeout: 8000 });
    await todos.click();
    const row = a.locator('.friend-row', { hasText: name }).first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.getByTitle('Conversar').click();
    await expect(a.getByPlaceholder(/Conversar com/)).toBeVisible({ timeout: 10000 });
  }
  await a.getByTitle(/Iniciar chamada de voz/).click();
}

async function assertNoCrash(errs: string[]) {
  const joined = errs.join('\n');
  expect(joined).not.toContain('ReferenceError');
  expect(joined).not.toContain("Can't find variable");
  expect(joined).not.toContain('RTCPeerConnection is not defined');
}

test('chamar → conectar → sair → chamar DE NOVO conecta (mesma direção)', async ({ browser }) => {
  test.setTimeout(120_000); // dois ciclos completos de chamada passam dos 30s padrão
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  const errs: string[] = [];
  collectCrashSignals(a, errs);
  collectCrashSignals(b, errs);
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriend(a, b);

  // ── 1ª chamada: A liga, B atende, conecta ─────────────────────────────
  await dial(a, 'Bob');
  await expect(a.getByText('Chamando…')).toBeVisible({ timeout: 15000 });
  await expect(b.getByRole('button', { name: 'Aceitar' })).toBeVisible({ timeout: 20000 });
  await b.getByRole('button', { name: 'Aceitar' }).click();
  await expect(a.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 });
  await expect(b.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 });

  // ── A sai (hangup): overlay some nos dois lados ────────────────────────
  // `getByRole('Sair').first()` pegaria o botão de LOGOUT da sidebar, que fica
  // ATRÁS do overlay fixo da chamada (pointer events interceptados — 53
  // retries de clique). O botão de desligar tem data-testid="call-leave".
  await a.getByTestId('call-leave').click();
  await expect(a.getByText(/^Conectado • /)).toBeHidden({ timeout: 10000 });
  await expect(b.getByText(/^Conectado • /)).toBeHidden({ timeout: 15000 });

  // ── 2ª chamada: A liga DE NOVO para o mesmo B ───────────────────────────
  // Este era o ponto que quebrava: o overlay não abria de novo, ou o ring
  // não chegava em B, ou a chamada ficava presa em "Conectando…".
  await dial(a, 'Bob');
  await expect(a.getByText('Chamando…')).toBeVisible({ timeout: 15000 });
  await expect(b.getByRole('button', { name: 'Aceitar' })).toBeVisible({ timeout: 20000 });
  await b.getByRole('button', { name: 'Aceitar' }).click();
  await expect(a.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 });
  await expect(b.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 });

  assertNoCrash(errs);
  await ctx.close();
});

test('quem ATENDEu consegue ligar de volta depois de sair (direção invertida)', async ({ browser }) => {
  test.setTimeout(120_000); // dois ciclos completos de chamada passam dos 30s padrão
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  const errs: string[] = [];
  collectCrashSignals(a, errs);
  collectCrashSignals(b, errs);
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriend(a, b);

  // 1ª chamada: A liga, B atende, conecta.
  await dial(a, 'Bob');
  await expect(b.getByRole('button', { name: 'Aceitar' })).toBeVisible({ timeout: 20000 });
  await b.getByRole('button', { name: 'Aceitar' }).click();
  await expect(b.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 });

  // B sai (desliga a chamada, não o logout da sidebar: ver nota do teste 1).
  await b.getByTestId('call-leave').click();
  await expect(b.getByText(/^Conectado • /)).toBeHidden({ timeout: 10000 });
  await expect(a.getByText(/^Conectado • /)).toBeHidden({ timeout: 15000 });

  // Agora é B quem LIGA para A (direção invertida) — precisa tocar em A.
  // (dial() navega até a lista de amigos: B ficou na view "Pendentes" após
  // aceitar a amizade, e as .friend-row só existem na lista.)
  await dial(b, 'Alice');
  await expect(b.getByText('Chamando…')).toBeVisible({ timeout: 15000 });
  await expect(a.getByRole('button', { name: 'Aceitar' })).toBeVisible({ timeout: 20000 });
  await a.getByRole('button', { name: 'Aceitar' }).click();
  await expect(a.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 });
  await expect(b.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 });

  assertNoCrash(errs);
  await ctx.close();
});
