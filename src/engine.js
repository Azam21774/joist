'use strict';
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');

const LOGIN_URL = 'https://pro.joistapp.com/login';
const ESTIMATES_URL = 'https://pro.joistapp.com/dashboard/documents/estimates';

const ROW_SELECTOR = '[data-component-name="document-list-row"]';
const EMAIL_BUTTON_SELECTOR = '[data-tour="email-button"] button';
const TO_INPUT_SELECTOR = 'input[data-testid="toEmail"]';
const CHIP_DELETE_ICON_SELECTOR = '[data-testid="recipientEmailChip"] svg[data-testid="CancelIcon"]';
const SUBJECT_INPUT_SELECTOR = '[data-testid="emailSubject"] input';
const MESSAGE_TEXTAREA_SELECTOR = '[data-testid="emailMessage"] textarea:not([aria-hidden="true"])';
const SEND_BUTTON_SELECTOR = 'button[class*="sendEmailModalComponents_sendButton"]';
const LOGIN_BUTTON_SELECTOR = 'button.Login_submitButton__fMHAq';

class Aborted extends Error {
  constructor() { super('Aborted'); this.aborted = true; }
}

const rawSleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const toNum = v =>
  v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0
    ? undefined
    : Number(v);

// ---------------------------------------------------------------- Chrome / CDP
function getChromePath(custom) {
  if (custom && fs.existsSync(custom)) return custom;
  const c = [];
  if (process.platform === 'darwin') c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  if (process.platform === 'win32') {
    c.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    );
  }
  if (process.platform === 'linux') c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  const found = c.find(p => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found. Set the Chrome path in Settings.');
  return found;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

function httpJson(url) {
  return new Promise((res, rej) => {
    http
      .get(url, r => {
        let b = '';
        r.on('data', c => (b += c));
        r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
      })
      .on('error', rej);
  });
}

async function waitForCdp(port, proc, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (proc.exitCode !== null) throw new Error('Chrome exited right after launch.');
    try { await httpJson(`http://127.0.0.1:${port}/json/version`); return; } catch { await rawSleep(300); }
  }
  throw new Error("Chrome's CDP port is not responding.");
}

// ---------------------------------------------------------------- Human-like helpers
async function humanClick(page, target) {
  const el = typeof target === 'string' ? await page.$(target) : target;
  if (!el) throw new Error('Element to click not found.');
  await el.evaluate(n => n.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await rawSleep(rand(400, 800));
  const box = await el.boundingBox();
  if (!box) throw new Error('Element has no visible box.');
  const x = box.x + box.width * (0.25 + Math.random() * 0.5);
  const y = box.y + box.height * (0.25 + Math.random() * 0.5);
  await page.mouse.move(x, y, { steps: rand(15, 30) });
  await rawSleep(rand(80, 250));
  await page.mouse.click(x, y, { delay: rand(40, 120) });
}

async function typeChars(page, text, delay, chk) {
  const fixed = typeof delay === 'number';
  for (const ch of text) {
    chk();
    if (ch === '\n') {
      await page.keyboard.press('Enter');
      if (!fixed) await rawSleep(rand(120, 300));
      continue;
    }
    await page.keyboard.type(ch, { delay: fixed ? delay : rand(40, 140) });
    if (!fixed && Math.random() < 0.04) await rawSleep(rand(200, 400));
  }
}

async function humanType(page, selector, text) {
  await humanClick(page, selector);
  await rawSleep(rand(200, 500));
  await typeChars(page, text, undefined, () => {});
}

async function humanClearAndType(page, selector, text, delay, chk) {
  const el = await page.$(selector);
  if (!el) throw new Error(`Field not found: ${selector}`);
  await humanClick(page, el);
  await rawSleep(rand(150, 300));
  await el.evaluate(node => {
    const proto = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, '');
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await rawSleep(rand(200, 400));
  await typeChars(page, text, delay, chk);
}

// ---------------------------------------------------------------- Engine
class Engine extends EventEmitter {
  constructor(store, userDataDir) {
    super();
    this.store = store;
    this.dir = userDataDir;
    this.rt = new Map(); // accountId -> { browser, proc, page, intentional, lastUsed }
    this.runState = 'idle';
    this.abort = false;
    this.pauseReq = false;
    this.resumeFn = null;
    this.loopPromise = null;
    this.seq = 0;
    this.logs = [];
    this._st = null;

    this.d.accounts.forEach(a => { a.status = 'idle'; a.note = ''; });
    this.d.recipients.forEach(r => { if (r.status === 'sending') r.status = 'pending'; });
  }

  get d() { return this.store.data; }
  find(id) { return this.d.accounts.find(a => a.id === id); }

  // ---- state / log plumbing
  snapshot() {
    return {
      accounts: this.d.accounts.map(({ id, email, status, note }) => ({ id, email, status, note })),
      recipients: this.d.recipients,
      settings: this.d.settings,
      run: { state: this.runState }
    };
  }
  emitState() {
    if (this._st) return;
    this._st = setTimeout(() => { this._st = null; this.emit('state'); }, 80);
  }
  log(msg, level = 'info') {
    const entry = { t: Date.now(), level, msg };
    this.logs.push(entry);
    if (this.logs.length > 400) this.logs.shift();
    this.emit('log', entry);
  }
  setRun(s) { this.runState = s; this.emitState(); }
  setStatus(a, status, note = '') { if (!a) return; a.status = status; a.note = note; this.emitState(); }

  // ---- settings
  saveSettings(s) {
    this.d.settings = { ...this.d.settings, ...s };
    this.store.save();
  }

  // ---- recipients
  addRecipients(text) {
    const have = new Set(this.d.recipients.map(r => r.email.toLowerCase()));
    let added = 0, dup = 0, bad = 0;
    for (const raw of String(text).split(/[\s,;]+/)) {
      const email = raw.trim();
      if (!email) continue;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { bad++; continue; }
      if (have.has(email.toLowerCase())) { dup++; continue; }
      have.add(email.toLowerCase());
      this.d.recipients.push({ email, status: 'pending' });
      added++;
    }
    this.store.save(); this.emitState();
    this.log(`Recipients: ${added} added${dup ? `, ${dup} duplicate skipped` : ''}${bad ? `, ${bad} invalid skipped` : ''}.`);
    return { added, dup, bad };
  }
  removeRecipients(emails) {
    const set = new Set(emails);
    this.d.recipients = this.d.recipients.filter(r => !(set.has(r.email) && r.status !== 'sending'));
    this.store.save(); this.emitState();
  }
  clearRecipients(scope = 'all') {
    this.d.recipients = this.d.recipients.filter(r => {
      if (r.status === 'sending') return true;
      if (scope === 'sent') return r.status !== 'sent';
      return false;
    });
    this.store.save(); this.emitState();
    this.log(scope === 'sent' ? 'Sent recipients cleared.' : 'All recipients cleared.');
  }

  // ---- accounts
  addAccounts(text) {
    let added = 0, bad = 0, dup = 0;
    for (const line of String(text).split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      const i = l.indexOf(':');
      const email = i > 0 ? l.slice(0, i).trim() : '';
      const password = i > 0 ? l.slice(i + 1).trim() : '';
      if (!email || !password) { bad++; continue; }
      if (this.d.accounts.some(a => a.email.toLowerCase() === email.toLowerCase())) { dup++; continue; }
      this.d.accounts.push({ id: crypto.randomUUID(), email, password, status: 'idle', note: '' });
      added++;
    }
    this.store.save(); this.emitState();
    this.log(`Accounts: ${added} added${dup ? `, ${dup} duplicate` : ''}${bad ? `, ${bad} invalid (expected email:password)` : ''}.`);
    return { added, dup, bad };
  }
  async removeAccount(id) {
    const a = this.find(id);
    if (!a) return;
    await this.closeRuntime(id);
    this.d.accounts = this.d.accounts.filter(x => x.id !== id);
    fs.rm(path.join(this.dir, 'profiles', id), { recursive: true, force: true }, () => {});
    this.store.save(); this.emitState();
    this.log(`Account removed: ${a.email}`, 'warn');
  }

  async closeRuntime(id) {
    const r = this.rt.get(id);
    if (!r) return;
    r.intentional = true;
    this.rt.delete(id);
    try { await r.browser.close(); } catch {}
    try { if (r.proc && r.proc.exitCode === null) r.proc.kill(); } catch {}
  }
  async closeAccount(id) {
    const a = this.find(id);
    await this.closeRuntime(id);
    if (a) { this.setStatus(a, 'idle', 'Chrome closed'); this.log(`Chrome closed: ${a.email}`); }
  }
  async markInactive(id, note) {
    const a = this.find(id);
    await this.closeRuntime(id);
    if (a) {
      this.setStatus(a, 'inactive', note || 'Inactive');
      this.log(`INACTIVE: ${a.email} — ${note || ''}`, 'error');
    }
  }

  // ---- open / login (CDP)
  async openAccount(id) {
    const a = this.find(id);
    if (!a || a.status === 'connecting' || a.status === 'busy') return;
    if (a.status === 'active' && this.rt.has(id)) {
      try { await this.rt.get(id).page.bringToFront(); } catch {}
      return;
    }
    await this.closeRuntime(id);
    this.setStatus(a, 'connecting', 'Launching Chrome…');
    this.log(`Open/Login: ${a.email}`);
    try {
      const port = await freePort();
      const profile = path.join(this.dir, 'profiles', a.id);
      fs.mkdirSync(profile, { recursive: true });
      const proc = spawn(
        getChromePath(this.d.settings.chromePath),
        [
          `--remote-debugging-port=${port}`,
          '--remote-debugging-address=127.0.0.1',
          `--user-data-dir=${profile}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-infobars',
          '--start-maximized',
          'about:blank'
        ],
        { stdio: 'ignore' }
      );
      proc.on('error', () => {});
      const entry = { browser: null, proc, page: null, intentional: false, lastUsed: 0 };
      this.rt.set(id, entry);

      await waitForCdp(port, proc);
      const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
      entry.browser = browser;
      browser.on('disconnected', () => {
        if (this.rt.get(id) === entry && !entry.intentional) {
          this.rt.delete(id);
          try { if (proc.exitCode === null) proc.kill(); } catch {}
          const acc = this.find(id);
          if (acc) { this.setStatus(acc, 'inactive', 'Chrome was closed'); this.log(`INACTIVE: ${acc.email} — Chrome was closed`, 'error'); }
        }
      });

      const page = (await browser.pages())[0] || (await browser.newPage());
      page.setDefaultTimeout(30000);
      entry.page = page;

      await this._login(page, a);
      await this._openEstimate(page, a);
      await page.waitForSelector(EMAIL_BUTTON_SELECTOR, { visible: true, timeout: 30000 });

      this.setStatus(a, 'active', 'Ready');
      this.log(`Ready: ${a.email} (login + estimate open)`, 'success');
    } catch (e) {
      await this.markInactive(id, e.message);
    }
  }

  // Per-account Open/Login: joins the run once logged in; starts a run with this account if none is active
  async startAccount(id) {
    const a = this.find(id);
    if (!a) return;
    await this.openAccount(id);
    if (a.status !== 'active' || this.loopPromise) return; // if a run is active the account joins the pool automatically
    if (['idle', 'stopped', 'done'].includes(this.runState)) {
      const r = this.start({ prepare: false });
      if (!r.ok) this.log(r.error, 'warn');
    }
  }

  async _login(page, a) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const where = await Promise.race([
      page.waitForSelector('input[name="email"]', { visible: true, timeout: 15000 }).then(() => 'login'),
      page.waitForFunction(() => location.pathname.includes('/dashboard'), { timeout: 15000 }).then(() => 'dash')
    ]).catch(() => null);
    if (!where) throw new Error('Joist login page failed to load.');
    if (where === 'dash') return; // session already saved in this profile

    await rawSleep(rand(800, 1600));
    await humanType(page, 'input[name="email"]', a.email);
    await rawSleep(rand(400, 900));
    await humanType(page, 'input[name="password"]', a.password);
    await rawSleep(rand(700, 1500));
    await page.waitForSelector(LOGIN_BUTTON_SELECTOR, { visible: true });
    if (await page.$eval(LOGIN_BUTTON_SELECTOR, b => b.disabled)) throw new Error('Sign In button disabled.');
    await humanClick(page, LOGIN_BUTTON_SELECTOR);
    try {
      await page.waitForFunction(() => location.pathname.includes('/dashboard'), { timeout: 25000 });
    } catch {
      throw new Error('Login failed — check the email/password.');
    }
  }

  async _openEstimate(page, a) {
    if (!page.url().includes('/estimates')) {
      await page.goto(ESTIMATES_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await page.waitForSelector(ROW_SELECTOR, { visible: true, timeout: 30000 });
    await rawSleep(rand(1200, 2200));

    const rows = await page.$$eval(ROW_SELECTOR, rs =>
      rs.map(r => ({
        name: (r.querySelector('[data-component-name="document-list-row-name"] a span[role="button"]')?.textContent || '').replace(/\s+/g, ' ').trim(),
        status: (r.querySelector('[data-component-name="document-list-row-status"]')?.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase()
      }))
    );

    const wanted = (this.d.settings.estimateName || '').replace(/\s+/g, ' ').trim().toLowerCase();
    let idx;
    if (wanted) {
      idx = rows.findIndex(r => r.name.toLowerCase() === wanted);
      if (idx === -1) idx = rows.findIndex(r => r.name.toLowerCase().includes(wanted));
    } else {
      idx = rows.findIndex(r => r.status === 'ISSUED');
      if (idx === -1 && rows.length === 1) idx = 0;
    }
    if (idx === -1) {
      throw new Error(wanted ? `Estimate "${this.d.settings.estimateName}" not found.` : 'No ISSUED estimate found.');
    }
    this.log(`${a.email}: opening "${rows[idx].name}" [${rows[idx].status}]`);
    const handles = await page.$$(ROW_SELECTOR);
    const btn = await handles[idx].$('button[data-testid="openButton"]');
    if (!btn) throw new Error("The estimate's Open button was not found.");
    await humanClick(page, btn);
  }

  // ---- sending one batch
  async _sendBatch(acct, batch) {
    const entry = this.rt.get(acct.id);
    if (!entry || !entry.page) throw new Error('Browser is not connected.');
    const page = entry.page;
    const s = this.d.settings;
    const chk = () => { if (this.abort) throw new Aborted(); };

    // reload if a previously stopped run left the email modal half-open
    if (await page.$(TO_INPUT_SELECTOR)) {
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
    chk();
    await page.waitForSelector(EMAIL_BUTTON_SELECTOR, { visible: true, timeout: 30000 });
    await rawSleep(rand(1000, 2000));
    await humanClick(page, EMAIL_BUTTON_SELECTOR);
    await page.waitForSelector(TO_INPUT_SELECTOR, { visible: true, timeout: 20000 });
    await rawSleep(rand(800, 1500));
    chk();

    // clear old chips, then add this batch's recipients
    while (true) {
      const icon = await page.$(CHIP_DELETE_ICON_SELECTOR);
      if (!icon) break;
      await humanClick(page, icon);
      await rawSleep(rand(300, 700));
    }
    const rDelay = toNum(s.recipientTypingDelayMs);
    for (const r of batch) {
      chk();
      await page.click(TO_INPUT_SELECTOR);
      if (rDelay === undefined) await rawSleep(rand(200, 400));
      await typeChars(page, r.email, rDelay, chk);
      if (rDelay === undefined) await rawSleep(rand(200, 400));
      await page.keyboard.press('Enter');
      await rawSleep(rDelay === undefined ? rand(300, 600) : 150);
    }

    const tDelay = toNum(s.typingDelayMs);
    chk();
    await humanClearAndType(page, SUBJECT_INPUT_SELECTOR, s.subject || '', tDelay, chk);
    chk();
    await humanClearAndType(page, MESSAGE_TEXTAREA_SELECTOR, s.message || '', tDelay, chk);
    chk();

    await rawSleep(rand(800, 1500));
    await page.waitForSelector(SEND_BUTTON_SELECTOR, { visible: true, timeout: 15000 });
    chk(); // last abort point — after the click the batch counts as sent
    await humanClick(page, SEND_BUTTON_SELECTOR);
    batch.forEach(r => (r.status = 'sent'));
    this.store.save(); this.emitState();

    await rawSleep(2000);
    try { await page.waitForSelector(TO_INPUT_SELECTOR, { hidden: true, timeout: 15000 }); } catch {}
    await rawSleep(rand(1200, 2200));
  }

  // ---- run control
  sleep(ms, breakOnPause = false) {
    return new Promise((res, rej) => {
      const end = Date.now() + ms;
      const t = setInterval(() => {
        if (this.abort) { clearInterval(t); rej(new Aborted()); }
        else if ((breakOnPause && this.pauseReq) || Date.now() >= end) { clearInterval(t); res(); }
      }, 100);
    });
  }

  async _gate() {
    if (this.abort) throw new Aborted();
    if (this.pauseReq) {
      this.setRun('paused');
      this.log('Paused.', 'warn');
      await new Promise(r => (this.resumeFn = r));
      this.resumeFn = null;
      if (this.abort) throw new Aborted();
      this.setRun('running');
    }
  }

  async _pickAccount() {
    while (true) {
      await this._gate();
      const ready = this.d.accounts.filter(a => a.status === 'active' && this.rt.has(a.id));
      if (ready.length) {
        if (this.runState === 'waiting') { this.setRun('running'); this.log('Active account available, resuming.', 'success'); }
        ready.sort((x, y) => this.rt.get(x.id).lastUsed - this.rt.get(y.id).lastUsed);
        return ready[0];
      }
      if (this.runState !== 'waiting') {
        this.setRun('waiting');
        this.log('No active account. Add a new account and click Open / Login — the remaining recipients will continue from where they left off.', 'warn');
      }
      await this.sleep(1000);
    }
  }

  async _batchDelay() {
    const ms = toNum(this.d.settings.batchDelayMs);
    const wait = ms === undefined ? rand(2000, 4000) : ms;
    if (wait > 0) {
      this.log(`Waiting ${wait}ms before the next batch…`);
      await this.sleep(wait, true);
    }
  }

  // Start All: open + log in every closed (idle) account in parallel and wait for all to settle
  async _prepare() {
    const idle = this.d.accounts.filter(a => a.status === 'idle');
    if (idle.length) this.log(`${idle.length} account(s) opening and logging in together…`);
    const all = Promise.allSettled(idle.map(a => this.openAccount(a.id)));
    const watcher = new Promise((_, rej) => {
      const t = setInterval(() => { if (this.abort) { clearInterval(t); rej(new Aborted()); } }, 100);
      all.then(() => clearInterval(t));
    });
    await Promise.race([all, watcher]);
    while (this.d.accounts.some(a => a.status === 'connecting')) await this.sleep(300);
    const n = this.d.accounts.filter(a => a.status === 'active').length;
    this.log(`${n}/${this.d.accounts.length} account(s) ready.`, n ? 'success' : 'warn');
  }

  async _loop(prepare) {
    const d = this.d;
    try {
      if (prepare) await this._prepare();
      while (true) {
        await this._gate();
        const pending = d.recipients.filter(r => r.status === 'pending');
        if (!pending.length) {
          this.setRun('done');
          this.log('All recipients processed ✔', 'success');
          return;
        }
        const acct = await this._pickAccount();
        const size = Math.max(1, toNum(d.settings.batchSize) || 10);
        const batch = d.recipients.filter(r => r.status === 'pending').slice(0, size);
        if (!batch.length) continue;
        batch.forEach(r => (r.status = 'sending'));
        this.setStatus(acct, 'busy', `Sending ${batch.length} recipients…`);
        this.log(`Batch (${batch.length}) → ${acct.email}`);
        try {
          await this._sendBatch(acct, batch);
          const e = this.rt.get(acct.id);
          if (e) e.lastUsed = ++this.seq;
          if (acct.status === 'busy') this.setStatus(acct, 'active', 'Ready');
          this.log(`Sent ${batch.length} recipients ✔ (${acct.email})`, 'success');
          if (d.recipients.some(r => r.status === 'pending')) await this._batchDelay();
        } catch (e) {
          batch.forEach(r => { if (r.status === 'sending') r.status = 'pending'; });
          if (e.aborted) {
            if (acct.status === 'busy' && this.rt.has(acct.id)) this.setStatus(acct, 'active', 'Ready');
            this.setRun('stopped');
            return;
          }
          this.log(`${acct.email}: batch failed — ${e.message}. The same batch will go to another account.`, 'error');
          await this.markInactive(acct.id, e.message);
        }
        this.store.save();
      }
    } catch (e) {
      if (!e.aborted) this.log(`Engine error: ${e.message}`, 'error');
      this.d.recipients.forEach(r => { if (r.status === 'sending') r.status = 'pending'; });
      this.setRun('stopped');
    } finally {
      this.loopPromise = null;
      this.store.save();
      this.emitState();
    }
  }

  start({ prepare = true } = {}) {
    if (this.loopPromise) return { ok: true };
    const s = this.d.settings;
    if (!this.d.accounts.length) return { ok: false, error: 'Add at least one account first.' };
    if (!this.d.recipients.some(r => r.status === 'pending')) return { ok: false, error: 'No pending recipients.' };
    if (!(s.subject || '').trim()) return { ok: false, error: 'Subject is empty.' };
    if (!(s.message || '').trim()) return { ok: false, error: 'Message is empty.' };
    this.abort = false;
    this.pauseReq = false;
    this.setRun('running');
    this.log('Started.', 'success');
    this.loopPromise = this._loop(prepare);
    return { ok: true };
  }

  pause() {
    if (!['running', 'waiting'].includes(this.runState)) return { ok: false };
    this.pauseReq = true;
    this.setRun('pausing');
    this.log('Pause requested — will pause after the current batch finishes.', 'warn');
    return { ok: true };
  }

  resume() {
    if (this.runState === 'paused' || this.runState === 'pausing') {
      this.pauseReq = false;
      if (this.resumeFn) this.resumeFn();
      else this.setRun('running');
      this.log('Resumed.', 'success');
      return { ok: true };
    }
    return this.start(); // stopped -> continue from where it left off (pending recipients)
  }

  async stop() {
    if (!this.loopPromise) {
      if (this.runState !== 'idle' && this.runState !== 'done') this.setRun('stopped');
      return { ok: true };
    }
    this.log('Stopping…', 'warn');
    this.abort = true;
    this.pauseReq = false;
    this.setRun('stopping');
    if (this.resumeFn) this.resumeFn();
    try { await this.loopPromise; } catch {}
    this.abort = false;
    this.setRun('stopped');
    this.log('Stopped. Click Resume to continue from where it stopped.', 'warn');
    return { ok: true };
  }

  async restart() {
    await this.stop();
    this.d.recipients.forEach(r => (r.status = 'pending'));
    this.store.save();
    this.setRun('idle');
    this.log('Restart: all recipients reset to pending, starting from the beginning.', 'warn');
    return this.start();
  }

  async shutdown() {
    try { await this.stop(); } catch {}
    for (const id of [...this.rt.keys()]) await this.closeRuntime(id);
    this.store.flush();
  }
}

module.exports = { Engine };
