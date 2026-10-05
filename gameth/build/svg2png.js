// BUILD ARTEFACT — renders the report charts to PNG for a visual sanity check.
const fs = require('fs'), { execSync } = require('child_process');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const dir = __dirname.replace(/\\/g, '/');
for (const f of ['fig-diff', 'fig-centre']) {
  const svg = fs.readFileSync(`${dir}/${f}.svg`, 'utf8');
  fs.writeFileSync(`${dir}/${f}.html`, `<html><body style="margin:0">${svg}</body></html>`);
  execSync(`"${CHROME}" --headless --disable-gpu --screenshot="${dir}/${f}.png" --window-size=760,380 --hide-scrollbars "file:///${dir}/${f}.html"`, { stdio: 'ignore' });
  console.log(f + '.png', fs.statSync(`${dir}/${f}.png`).size);
}
