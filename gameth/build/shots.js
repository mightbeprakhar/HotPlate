// BUILD ARTEFACT — screenshots the board for the gorge + archipelago layouts.
const { chromium } = require('playwright');
const fs = require('fs');

const SEEDS = { gorge: 'shot4', archipelago: 'shot5' };

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  for (const [layout, seed] of Object.entries(SEEDS)) {
    await p.goto('http://localhost:8777/index.html?cb=' + Date.now(), { waitUntil: 'load' });
    await p.evaluate(s => {
      localStorage && localStorage.clear && localStorage.clear();
      window.__seed = s;
    }, seed);
    await p.fill('#seedInput', seed);
    await p.click('button[data-mode="campaign"]');
    await p.click('#playBtn');
    await p.waitForTimeout(1400);
    const got = await p.evaluate(() => ({ name: HP && window.UI ? null : null, t: document.getElementById('seedChip').textContent }));
    console.log(layout, '->', got.t);
    await p.screenshot({ path: `build/check-${layout}.png` });
  }
  await b.close();
})();
