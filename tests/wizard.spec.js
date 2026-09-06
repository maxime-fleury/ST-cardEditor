import { test, expect } from '@playwright/test';

test('wizard creates a blank card from name only', async ({ page }) => {
  await page.goto('/');
  await page.locator('#btnWizardNav').click();
  await page.locator('#wizName').fill('Elara');
  for (let i = 0; i < 4; i++) {
    await page.locator('#wizBtnNext').click();
    await page.waitForTimeout(250);
  }
  await expect(page.locator('#wizBtnBlank')).toBeVisible();
  await page.locator('#wizBtnBlank').click();
  await expect(page.locator('.card-list-item')).toHaveCount(1);
  await expect(page.locator('.card-list-name')).toHaveText(/Elara/);
});