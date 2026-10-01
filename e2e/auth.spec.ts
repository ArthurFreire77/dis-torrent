import { test, expect } from '@playwright/test';
test('criar conta e navegar para app', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Criar conta' })).toBeVisible({ timeout: 10000 });
  await page.getByPlaceholder('Seu nome').fill('Alice');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page).toHaveURL(/\/d\/forge/, { timeout: 10000 });
});
