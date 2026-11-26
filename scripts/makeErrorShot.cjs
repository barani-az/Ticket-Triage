// Renders a made-up error page off-screen and saves it as a JPEG, so the vision path can be tested
// without screenshotting anyone's real screen. Run with: electron scripts/makeErrorShot.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const html = `<!doctype html><html><body style="margin:0;font-family:Segoe UI,sans-serif;background:#f3f4f6">
<div style="background:#1f2937;color:#d1d5db;padding:10px 18px;font-size:14px">shop.example.com/checkout/payment</div>
<div style="max-width:720px;margin:48px auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:32px">
  <div style="font-size:13px;color:#6b7280">Acme Shop &gt; Checkout &gt; Payment</div>
  <h1 style="font-size:34px;margin:14px 0 6px;color:#b91c1c">500 Internal Server Error</h1>
  <p style="font-size:17px;margin:0 0 18px">Something went wrong while processing your payment.</p>
  <div style="background:#fef2f2;border:1px solid #fecaca;color:#7f1d1d;padding:12px 14px;border-radius:6px;font-size:15px">
    Reference: ERR-7731 &middot; Please try again later or contact support.
  </div>
  <button style="margin-top:22px;padding:10px 18px;font-size:15px">Pay now</button>
</div></body></html>`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1100, height: 520, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 600));
  const img = await w.webContents.capturePage();
  const out = path.join(process.cwd(), 'data', 'test-error-shot.jpg');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toJPEG(80));
  console.log('saved', out, img.getSize());
  app.quit();
});
