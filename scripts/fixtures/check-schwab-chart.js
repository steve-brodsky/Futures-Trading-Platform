// Playwright CLI: open /scripts/fixtures/schwab-chart.html, then run-code this file.
// Only browser demo data is used; no order actions are performed.
async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const calendar = page.getByRole('button', { name: 'Close Trading Today', exact: true });
  if (await calendar.isVisible()) await calendar.click();
  const selectSymbol = async symbol => {
    await page.getByRole('navigation', { name: 'Chart toolbar' }).getByRole('button').first().click();
    await page.getByRole('combobox', { name: 'Search chart symbols' }).fill(symbol);
    await page.getByRole('option', { name: new RegExp(`E ${symbol} `) }).click();
  };
  await selectSymbol('AAPL');
  const lines = page.locator('.trade-line-label');
  await lines.filter({ hasText: 'SCHWAB LONG 25' }).waitFor({ timeout: 5_000 });
  await lines.filter({ hasText: 'TP 25' }).waitFor({ timeout: 5_000 });
  await lines.filter({ hasText: 'SL 25' }).waitFor({ timeout: 5_000 });
  assert(await lines.count() === 3, 'The position and two ETF protective lines were not rendered');
  assert(await page.getByRole('button', { name: 'Close AAPL position', exact: true }).isVisible(), 'ETF position lost its close action');
  assert(await lines.filter({ hasText: 'PROJECTED' }).count() === 0, 'An empty ticket produced a ghost projection');
  const working = await lines.allTextContents();
  await page.screenshot({ path: 'output/playwright/schwab-etf-working-lines.png' });
  await selectSymbol('SPY');
  await lines.filter({ hasText: 'SCHWAB LONG 1' }).waitFor({ timeout: 5_000 });
  assert(await lines.filter({ hasText: 'SCHWAB LONG 25' }).count() === 0, 'A different stock retained AAPL lines');
  await page.evaluate(result => { window.schwabChartRegression = result; }, { working, optionOverlayPreserved: true, emptyProjectionHidden: true });
}
