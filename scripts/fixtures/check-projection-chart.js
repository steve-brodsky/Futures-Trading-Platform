// With `npm run dev` running, open the browser-only demo using Playwright CLI:
// playwright-cli -s=projections open http://127.0.0.1:1420/
// playwright-cli -s=projections run-code --filename scripts/fixtures/check-projection-chart.js
// No order submission controls are used; the browser demo has no broker connection.
async (page) => {
  const calendar = page.getByRole('button', { name: 'Close Trading Today', exact: true });
  if (await calendar.isVisible()) await calendar.click();
  await page.getByRole('navigation', { name: 'Chart toolbar' }).getByRole('button').first().click();
  await page.getByRole('combobox', { name: 'Search chart symbols' }).fill('SPY');
  await page.getByRole('option', { name: /E SPY SPDR S&P 500 ETF Trust/ }).click();
  const openPanel = page.getByRole('button', { name: 'Open order panel', exact: true });
  if (await openPanel.isVisible()) await openPanel.click();
  await page.getByRole('button', { name: 'Risk $', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Risk amount in dollars' }).fill('100');
  await page.getByRole('spinbutton', { name: 'Stop loss price' }).fill('630.15');
  await page.getByRole('button', { name: 'Set take profit by risk multiple', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '1.5R', exact: true }).click();

  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => ({
    stop: Number(document.querySelector('input[aria-label="Stop loss price"]').value),
    target: Number(document.querySelector('input[aria-label="Take profit price"]').value),
  }));
  const label = field => page.locator('.trade-line-label').filter({ hasText: `PROJECTED ${field}` });
  const center = async field => {
    const bounds = await label(field).boundingBox();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await frame();
  const initial = await snapshot();
  const sl = await center('SL');
  const tp = await center('TP');
  const pixelsPerDollar = (sl.y - tp.y) / (initial.target - initial.stop);
  await page.mouse.move(sl.x, sl.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    const pointerY = sl.y - 35 * i / 12;
    await page.mouse.move(sl.x, pointerY);
    await frame();
    const position = await center('SL');
    assert(Math.abs(position.y - pointerY) < 2, 'Autoscale moved the projected stop away from the pointer');
  }
  await page.mouse.up();
  await frame();
  const dragged = await snapshot();
  const expectedStop = initial.stop + 35 / pixelsPerDollar;
  assert(Math.abs(dragged.stop - expectedStop) < .02, `Stop drifted during drag: ${dragged.stop}, expected ${expectedStop}`);
  assert(Math.abs(dragged.target - (632.15 + 1.5 * (632.15 - dragged.stop))) < .011, 'R target did not follow the dragged stop');
  for (let i = 0; i < 60; i++) {
    await frame();
    assert(JSON.stringify(await snapshot()) === JSON.stringify(dragged), 'Stop/target changed after release');
  }

  // Escape restores both prices and R selection, including autoscale state.
  const next = await center('SL');
  await page.mouse.move(next.x, next.y);
  await page.mouse.down();
  await page.mouse.move(next.x, next.y + 20);
  await frame();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await frame();
  assert(JSON.stringify(await snapshot()) === JSON.stringify(dragged), 'Escape failed to restore the projection');

  // Dragging TP clears R and survives subsequent stop edits.
  const target = await center('TP');
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y - 12);
  await page.mouse.up();
  await frame();
  const manual = await snapshot();
  assert(manual.target !== dragged.target, 'Target drag did not edit the target');
  await page.getByRole('spinbutton', { name: 'Stop loss price' }).fill('630.15');
  await frame();
  assert((await snapshot()).target === manual.target, 'Stop edit changed a manual target');
  await page.evaluate(result => { window.projectionChartRegression = result; }, { stableFrames: 60, dragged, manual });
}
