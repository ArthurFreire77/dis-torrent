import { test, expect, type Page } from '@playwright/test';

// v6 — fases da chamada (CallPhaseBadge): a máquina de estados do callManager
// (callPhases.ts) aparece no overlay. Com fake device o WebRTC conecta de
// verdade entre duas abas (padrão calls2.spec.ts), então as fases transitam
// outgoing → connecting → connected de forma observável.

test.use({
  browserName: 'chromium',
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  },
});

async function createAccount(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Seu nome').fill(name);
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/distorrent/, { timeout: 15000 });
}

async function fpOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem('distorrent:identity') ?? '';
    return (JSON.parse(raw) as { fingerprint: string }).fingerprint;
  });
}

async function befriend(a: Page, b: Page) {
  const fpB = await fpOf(b);
  const fpA = await fpOf(a);
  await a.getByRole('button', { name: 'Adicionar amigo' }).click();
  await a.getByPlaceholder('Digite o fingerprint do seu amigo').fill(fpB);
  await a.getByRole('button', { name: 'Enviar solicitação' }).click();
  await b.getByRole('button', { name: 'Pendentes' }).click();
  await expect(b.getByText('Solicitação de amizade recebida')).toBeVisible({ timeout: 15000 });
  await b.getByRole('button', { name: 'Aceitar' }).first().click();
  await a.getByRole('button', { name: 'Todos' }).click();
  await expect(a.locator('.nav-row', { hasText: 'Bob' }).first()).toBeVisible({ timeout: 15000 });
  return { fpA, fpB };
}

function collectCrashSignals(page: Page, bucket: string[]) {
  page.on('pageerror', (e) => bucket.push(String((e as Error)?.message ?? e)));
  page.on('console', (m) => {
    if (m.type() === 'error') bucket.push(m.text());
  });
}

async function useLocalHostIce(pages: Page[]) {
  await Promise.all(pages.map((page) => page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Native, {
      construct(target, args) {
        // Duas abas locais não devem depender do hairpin NAT/STUN da máquina.
        const config = args[0] && typeof args[0] === 'object'
          ? { ...args[0], iceServers: [] }
          : { iceServers: [] };
        return Reflect.construct(target, [config, ...args.slice(1)]);
      },
    });
  })));
}

test('badge de fase: Chamando… no A antes do aceitar; Conectado após conectar', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await useLocalHostIce([a, b]);
  const errsA: string[] = [];
  collectCrashSignals(a, errsA);
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriend(a, b);

  // A liga para B
  await a.locator('.friend-row', { hasText: 'Bob' }).first().getByTitle('Conversar').click();
  await expect(a.getByPlaceholder(/Conversar com/)).toBeVisible({ timeout: 10000 });
  await a.getByTitle(/Iniciar chamada de voz/).click();

  // fase outgoing: badge "Chamando…" no overlay do A
  await expect(a.getByText('Chamando…')).toBeVisible({ timeout: 15000 });

  // B aceita → overlay conecta → badge vira "Conectado • mm:ss"
  await expect(b.getByRole('button', { name: 'Aceitar' })).toBeVisible({ timeout: 20000 });
  await b.getByRole('button', { name: 'Aceitar' }).click();
  await Promise.all([
    expect(a.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 }),
    expect(b.getByText(/^Conectado • /)).toBeVisible({ timeout: 30000 }),
  ]);

  // hangup limpa overlay (fase terminal 'ended' é interna; UI some)
  await a.getByRole('button', { name: 'Sair' }).first().click();
  await expect(a.getByText(/^Conectado • /)).toBeHidden({ timeout: 10000 });

  // nenhum crash de página durante o ciclo inteiro
  const joined = errsA.join('\n');
  expect(joined).not.toContain('ReferenceError');
  expect(joined).not.toContain("Can't find variable");
});

test('recusada mostra aviso honesto (máquina: remote-reject)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  await useLocalHostIce([a, b]);
  await createAccount(a, 'Alice');
  await createAccount(b, 'Bob');
  await befriend(a, b);

  await a.locator('.friend-row', { hasText: 'Bob' }).first().getByTitle('Conversar').click();
  await a.getByTitle(/Iniciar chamada de voz/).click();
  await expect(b.getByRole('button', { name: 'Recusar' })).toBeVisible({ timeout: 20000 });

  // B recusa → A recebe o toast "chamada recusada" (onCallNotice) e overlay fecha
  await b.getByRole('button', { name: 'Recusar' }).click();
  await expect(a.getByText('chamada recusada')).toBeVisible({ timeout: 15000 });
  await expect(a.getByText('Chamando…')).toBeHidden({ timeout: 10000 });
});

// Nota: reconectar após derrubar a rota real não é coberto por este E2E de duas
// abas; a transição reconnecting é coberta pelos testes unitários da máquina e
// pelo watchdog do callManager. Não marcar o arquivo todo como skipped por isso.
