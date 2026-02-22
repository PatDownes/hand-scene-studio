// timeline.js — Lane-based animation engine for Hand Scene Studio

let _nextLaneId = 1;

class TimelineEngine {
  constructor(onFrame) {
    this.onFrame = onFrame || (() => {});
    this.duration = 5;
    this.fps = 30;
    this.loop = true;
    this.lanes = [];
    this.currentTime = 0;
    this.playing = false;
    this._rafId = null;
    this._lastTimestamp = null;
  }

  // ── Lane management ──

  addLane(label) {
    const lane = {
      id: `lane-${_nextLaneId++}`,
      label: label || `Lane ${this.lanes.length + 1}`,
      enabled: true,
      keyframes: [],
      captureFilter: null, // { objectId, groupIds[] }
    };
    this.lanes.push(lane);
    return lane;
  }

  removeLane(id) {
    const idx = this.lanes.findIndex(l => l.id === id);
    if (idx !== -1) this.lanes.splice(idx, 1);
  }

  reorderLanes(ids) {
    const map = new Map(this.lanes.map(l => [l.id, l]));
    this.lanes = ids.map(id => map.get(id)).filter(Boolean);
  }

  setLaneEnabled(id, enabled) {
    const lane = this.lanes.find(l => l.id === id);
    if (lane) lane.enabled = enabled;
  }

  setLaneLabel(id, label) {
    const lane = this.lanes.find(l => l.id === id);
    if (lane) lane.label = label;
  }

  getLane(id) {
    return this.lanes.find(l => l.id === id) || null;
  }

  // ── Keyframe CRUD ──

  addKeyframe(laneId, time, properties) {
    const lane = this.getLane(laneId);
    if (!lane) return;

    const existIdx = lane.keyframes.findIndex(k => Math.abs(k.time - time) < 0.001);
    if (existIdx !== -1) {
      Object.assign(lane.keyframes[existIdx].properties, properties);
    } else {
      lane.keyframes.push({ time, properties: { ...properties } });
    }
    lane.keyframes.sort((a, b) => a.time - b.time);
  }

  removeKeyframe(laneId, index) {
    const lane = this.getLane(laneId);
    if (!lane || index < 0 || index >= lane.keyframes.length) return;
    lane.keyframes.splice(index, 1);
  }

  updateKeyframe(laneId, index, properties) {
    const lane = this.getLane(laneId);
    if (!lane || index < 0 || index >= lane.keyframes.length) return;
    Object.assign(lane.keyframes[index].properties, properties);
  }

  // ── Interpolation ──

  _findBracket(keyframes, time) {
    if (keyframes.length === 0) return null;
    if (keyframes.length === 1) return { a: keyframes[0], b: keyframes[0], t: 0 };

    if (time <= keyframes[0].time) return { a: keyframes[0], b: keyframes[0], t: 0 };
    if (time >= keyframes[keyframes.length - 1].time) {
      const last = keyframes[keyframes.length - 1];
      return { a: last, b: last, t: 0 };
    }

    for (let i = 0; i < keyframes.length - 1; i++) {
      if (time >= keyframes[i].time && time <= keyframes[i + 1].time) {
        const span = keyframes[i + 1].time - keyframes[i].time;
        const t = span > 0 ? (time - keyframes[i].time) / span : 0;
        return { a: keyframes[i], b: keyframes[i + 1], t };
      }
    }

    return { a: keyframes[keyframes.length - 1], b: keyframes[keyframes.length - 1], t: 0 };
  }

  _lerpValue(a, b, t) {
    if (a === b) return a;

    // Color interpolation (hex strings)
    if (typeof a === 'string' && a.startsWith('#') && typeof b === 'string' && b.startsWith('#')) {
      return this._lerpColor(a, b, t);
    }

    // Numeric
    if (typeof a === 'number' && typeof b === 'number') {
      return a + (b - a) * t;
    }

    // Fallback: hold
    return a;
  }

  _lerpColor(hexA, hexB, t) {
    const rA = parseInt(hexA.slice(1, 3), 16);
    const gA = parseInt(hexA.slice(3, 5), 16);
    const bA = parseInt(hexA.slice(5, 7), 16);
    const rB = parseInt(hexB.slice(1, 3), 16);
    const gB = parseInt(hexB.slice(3, 5), 16);
    const bB = parseInt(hexB.slice(5, 7), 16);
    const r = Math.round(rA + (rB - rA) * t);
    const g = Math.round(gA + (gB - gA) * t);
    const b = Math.round(bA + (bB - bA) * t);
    return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
  }

  _interpolateProps(bracket) {
    const { a, b, t } = bracket;
    if (t === 0) return { ...a.properties };

    const result = {};
    const allKeys = new Set([...Object.keys(a.properties), ...Object.keys(b.properties)]);
    for (const key of allKeys) {
      if (key in a.properties && key in b.properties) {
        result[key] = this._lerpValue(a.properties[key], b.properties[key], t);
      } else if (key in a.properties) {
        result[key] = a.properties[key];
      } else {
        result[key] = b.properties[key];
      }
    }
    return result;
  }

  // ── Resolution ──

  resolveAtTime(time) {
    const merged = {};
    for (const lane of this.lanes) {
      if (!lane.enabled || lane.keyframes.length === 0) continue;
      const bracket = this._findBracket(lane.keyframes, time);
      if (!bracket) continue;
      const props = this._interpolateProps(bracket);
      Object.assign(merged, props);
    }
    return merged;
  }

  // ── Playback ──

  play() {
    if (this.playing) return;
    if (this.currentTime >= this.duration) {
      this.currentTime = 0;
    }
    this.playing = true;
    this._lastTimestamp = null;
    this._rafId = requestAnimationFrame(ts => this._tick(ts));
  }

  pause() {
    this.playing = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(time) {
    this.currentTime = Math.max(0, Math.min(this.duration, time));
    this.onFrame(this.currentTime);
  }

  _tick(timestamp) {
    if (!this.playing) return;

    if (this._lastTimestamp === null) {
      this._lastTimestamp = timestamp;
    }

    const delta = (timestamp - this._lastTimestamp) / 1000;
    this._lastTimestamp = timestamp;

    this.currentTime += delta;

    if (this.currentTime >= this.duration) {
      if (this.loop) {
        this.currentTime = this.currentTime % this.duration;
      } else {
        this.currentTime = this.duration;
        this.playing = false;
        this._rafId = null;
        this.onFrame(this.currentTime);
        return;
      }
    }

    this.onFrame(this.currentTime);

    if (!this.playing) return;
    this._rafId = requestAnimationFrame(ts => this._tick(ts));
  }

  // ── Lane reorder ──

  moveLaneUp(id) {
    const idx = this.lanes.findIndex(l => l.id === id);
    if (idx > 0) {
      [this.lanes[idx - 1], this.lanes[idx]] = [this.lanes[idx], this.lanes[idx - 1]];
    }
  }

  moveLaneDown(id) {
    const idx = this.lanes.findIndex(l => l.id === id);
    if (idx >= 0 && idx < this.lanes.length - 1) {
      [this.lanes[idx], this.lanes[idx + 1]] = [this.lanes[idx + 1], this.lanes[idx]];
    }
  }

  // ── Serialization ──

  toJSON() {
    return {
      duration: this.duration,
      fps: this.fps,
      loop: this.loop,
      lanes: this.lanes.map(lane => ({
        id: lane.id,
        label: lane.label,
        enabled: lane.enabled,
        captureFilter: lane.captureFilter || null,
        keyframes: lane.keyframes.map(kf => ({
          time: kf.time,
          properties: { ...kf.properties },
        })),
      })),
    };
  }

  static fromJSON(data, onFrame) {
    const engine = new TimelineEngine(onFrame);
    engine.duration = data.duration ?? 5;
    engine.fps = data.fps ?? 30;
    engine.loop = data.loop ?? true;
    engine.lanes = (data.lanes || []).map(l => ({
      id: l.id,
      label: l.label,
      enabled: l.enabled ?? true,
      captureFilter: l.captureFilter || null,
      keyframes: (l.keyframes || []).map(kf => ({
        time: kf.time,
        properties: { ...kf.properties },
      })),
    }));
    // Ensure new lanes don't collide with loaded IDs
    for (const lane of engine.lanes) {
      const match = lane.id.match(/^lane-(\d+)$/);
      if (match) {
        _nextLaneId = Math.max(_nextLaneId, parseInt(match[1]) + 1);
      }
    }
    return engine;
  }
}

export { TimelineEngine };
