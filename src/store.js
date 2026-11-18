'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  accounts: [],
  recipients: [],
  settings: {
    estimateName: '',
    batchSize: 10,
    typingDelayMs: null,
    recipientTypingDelayMs: null,
    batchDelayMs: null,
    chromePath: '',
    subject: '',
    message: ''
  }
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = this.load();
    this._t = null;
  }
  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { ...DEFAULTS, ...d, settings: { ...DEFAULTS.settings, ...(d.settings || {}) } };
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 200);
  }
  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.error('Store save failed:', e.message);
    }
  }
}

module.exports = { Store };
