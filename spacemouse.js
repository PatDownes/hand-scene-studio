// spacemouse.js — 3Dconnexion SpaceMouse via WebHID API

// 3Dconnexion vendor IDs
const VENDOR_3DX = 0x256f;
const VENDOR_LOGITECH = 0x046d;

// Raw axis range (SpaceNavigator reports ~-350..+350)
const RAW_MAX = 350;

export class SpaceMouse {
  constructor() {
    this.device = null;
    this.sensitivity = 1.0;
    this.deadZone = 0.05;
    this.onStatus = null; // callback(connected, deviceName)

    // Latest axis state (updated by HID input reports)
    this._tx = 0; this._ty = 0; this._tz = 0;
    this._rx = 0; this._ry = 0; this._rz = 0;

    this._onInputReport = this._onInputReport.bind(this);

    // Try to reconnect a previously-granted device
    this._tryReconnect();
  }

  /** Auto-reconnect if the user already granted permission in a previous session. */
  async _tryReconnect() {
    if (!navigator.hid) return;
    try {
      const devices = await navigator.hid.getDevices();
      const dev = devices.find(d => this._is3Dconnexion(d));
      if (dev) await this._open(dev);
    } catch (e) {
      // Silent — user hasn't granted permission yet
    }
  }

  _is3Dconnexion(dev) {
    return dev.vendorId === VENDOR_3DX || dev.vendorId === VENDOR_LOGITECH;
  }

  /** Must be called from a user gesture (button click). Opens the HID permission prompt. */
  async connect() {
    if (!navigator.hid) {
      throw new Error('WebHID not supported in this browser');
    }
    const [dev] = await navigator.hid.requestDevice({
      filters: [
        { vendorId: VENDOR_3DX },
        { vendorId: VENDOR_LOGITECH, usagePage: 0x01, usage: 0x08 }, // Multi-axis Controller
      ],
    });
    if (!dev) return; // User cancelled
    await this._open(dev);
  }

  async _open(dev) {
    if (!dev.opened) await dev.open();
    this.device = dev;
    dev.addEventListener('inputreport', this._onInputReport);
    dev.addEventListener('disconnect', () => this._handleDisconnect());
    if (this.onStatus) this.onStatus(true, dev.productName || 'SpaceMouse');
  }

  _handleDisconnect() {
    if (this.device) {
      this.device.removeEventListener('inputreport', this._onInputReport);
      this.device = null;
    }
    this._tx = this._ty = this._tz = 0;
    this._rx = this._ry = this._rz = 0;
    if (this.onStatus) this.onStatus(false, '');
  }

  _onInputReport(e) {
    const data = e.data; // DataView

    if (e.reportId === 1 && data.byteLength >= 6) {
      // Translation: 3x int16 LE
      this._tx = data.getInt16(0, true);
      this._ty = data.getInt16(2, true);
      this._tz = data.getInt16(4, true);
    } else if (e.reportId === 2 && data.byteLength >= 6) {
      // Rotation: 3x int16 LE
      this._rx = data.getInt16(0, true);
      this._ry = data.getInt16(2, true);
      this._rz = data.getInt16(4, true);
    }
    // reportId 3 = buttons — ignored for now
  }

  get connected() {
    return this.device !== null;
  }

  /** Call each frame. Returns { tx, ty, tz, rx, ry, rz } normalized to ~-1..+1, or null. */
  poll() {
    if (!this.device) return null;

    const dz = this.deadZone;
    const s = this.sensitivity;

    const apply = (raw) => {
      const v = Math.max(-1, Math.min(1, raw / RAW_MAX));
      const abs = Math.abs(v);
      return abs < dz ? 0 : Math.sign(v) * ((abs - dz) / (1 - dz)) * s;
    };

    const tx = apply(this._tx);
    const ty = apply(this._ty);
    const tz = apply(this._tz);
    const rx = apply(this._rx);
    const ry = apply(this._ry);
    const rz = apply(this._rz);

    if (tx === 0 && ty === 0 && tz === 0 && rx === 0 && ry === 0 && rz === 0) return null;

    return { tx, ty, tz, rx, ry, rz };
  }

  async destroy() {
    if (this.device) {
      this.device.removeEventListener('inputreport', this._onInputReport);
      if (this.device.opened) await this.device.close();
      this.device = null;
    }
  }
}
