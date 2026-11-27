const fs = require('fs');
const path = require('path');
class CredentialStore {
  constructor({ filePath, storage } = {}) {
    const electron = storage ? null : require('electron');
    this.filePath = filePath || path.join(electron.app.getPath('userData'), 'provider-credentials.json');
    this.storage = storage || electron.safeStorage;
  }

  _read() {
    try {
      const contents = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return Object.fromEntries(Object.entries(contents).map(([name, value]) => [
        name,
        this.storage.decryptString(Buffer.from(value, 'base64'))
      ]));
    } catch (_) {
      return {};
    }
  }

  get(name) {
    return this._read()[name] || '';
  }

  isConfigured(name) {
    return !!this.get(name);
  }

  save(entries) {
    if (!this.storage.isEncryptionAvailable()) {
      throw new Error('Secure key storage is unavailable. Configure an OS keychain or secret store, then try again.');
    }
    if (process.platform === 'linux' && this.storage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Linux secure storage is unavailable because no system secret store is configured.');
    }

    const credentials = this._read();
    for (const [name, value] of Object.entries(entries || {})) {
      if (value === null) delete credentials[name];
      else if (typeof value === 'string' && value.trim()) credentials[name] = value.trim();
    }

    const encrypted = Object.fromEntries(Object.entries(credentials).map(([name, value]) => [
      name,
      this.storage.encryptString(value).toString('base64')
    ]));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(encrypted), { mode: 0o600 });
    fs.renameSync(tempPath, this.filePath);
    return Object.fromEntries(Object.keys(entries || {}).map(name => [name, !!credentials[name]]));
  }
}

module.exports = CredentialStore;
