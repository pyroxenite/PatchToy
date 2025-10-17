const startBtn = document.getElementById('start');
const stopBtn  = document.getElementById('stop');
const bpmEl    = document.getElementById('bpm');
const meterEl  = document.getElementById('meter');
const lvlText  = document.getElementById('lvlText');
const lvlMaxEl = document.getElementById('lvlMax');
const confidenceEl = document.getElementById('confidence');
const beatEl   = document.getElementById('beat');
const logEl    = document.getElementById('log');

let ctx, bpmNode, meterNode, normalizer, mic, stream, silent;
let aliveTimer;
let beatFlashTimer;
let beatScheduleTimer;
let currentBpm = null;
let beatIntervalSec = null;
let nextBeatTime = null;
let lastBeatTime = null;
let lastOnsetTime = null;
let currentConfidence = 0;
let hasConfidence = false;
const minMeterDb = -60;
let meterMaxDb = -36;
const BEAT_CONF_THRESHOLD = 0.55;

function log(...args){
  console.log('[BPM]', ...args);
  const line = document.createElement('div');
  line.textContent = args.map(a => (typeof a==='object'? JSON.stringify(a): String(a))).join(' ');
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

async function start() {
  try {
    if (ctx) return;
    ctx = new AudioContext({ latencyHint: 'interactive' });
    log('AudioContext created @', ctx.sampleRate, 'Hz');
    resetBeatState();
    meterMaxDb = -36;
    lvlMaxEl.textContent = '— dBFS';

    // Load worklets
    await ctx.audioWorklet.addModule('./bpm-processor.js');
    await ctx.audioWorklet.addModule('./meter-processor.js');
    await ctx.audioWorklet.addModule('./normalizer-processor.js');
    
    log('Worklets loaded');
    
    // Create nodes
    bpmNode   = new AudioWorkletNode(ctx, 'bpm-processor');
    meterNode = new AudioWorkletNode(ctx, 'meter-processor');
    normalizer = new AudioWorkletNode(ctx, 'normalizer-processor');

    bpmNode.port.onmessage = ({ data }) => {
      if (typeof data?.confidence === 'number' && Number.isFinite(data.confidence)) {
        updateConfidence(data.confidence);
      }
      if (typeof data?.bpm === 'number') {
        bpmEl.textContent = data.bpm + ' BPM';
        updateBeatBpm(data.bpm);
      }
      if (data?.onset != null) {
        applyOnsetPhaseCorrection(typeof data.onset === 'number' ? data.onset : ctx?.currentTime);
      }
      if (data?.debug) {
        log('bpm dbg:', data.debug);
      }
    };

    meterNode.port.onmessage = ({ data }) => {
      if (data?.rms) {
        // rms is linear 0..1; convert to dBFS and update meter
        const rms = data.rms;
        const db = 20 * Math.log10(Math.max(rms, 1e-12));
        lvlText.textContent = db.toFixed(1) + ' dBFS';
        // adapt max target toward recent peaks so the meter uses full range
        if (db > meterMaxDb - 1) {
          meterMaxDb = db;
        } else {
          meterMaxDb = Math.max(db, -50, meterMaxDb - 0.5);
        }
        const span = Math.max(6, meterMaxDb - minMeterDb);
        const pct = Math.max(0, Math.min(1, (db - minMeterDb) / span));
        meterEl.style.width = (pct * 100).toFixed(1) + '%';
        lvlMaxEl.textContent = meterMaxDb.toFixed(1) + ' dBFS';
      }
    };

    // Get mic
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    });
    log('getUserMedia OK, tracks:', stream.getAudioTracks().length);

    mic = ctx.createMediaStreamSource(stream);

    // Optional highpass
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 40;

    // Split to meter + bpm
    const splitter = new GainNode(ctx, { gain: 1 });

    mic.connect(hp).connect(normalizer).connect(splitter);
    splitter.connect(bpmNode);
    splitter.connect(meterNode);

    // Keep graph alive
    silent = new GainNode(ctx, { gain: 0 });
    bpmNode.connect(silent).connect(ctx.destination);
    meterNode.connect(silent);

    // Heartbeat: show context state
    aliveTimer = setInterval(() => {
      log('state:', ctx.state, 'time:', ctx.currentTime.toFixed(2));
    }, 3000);

    startBtn.disabled = true;
    stopBtn.disabled = false;
    log('Started. Speak/clap to see level and BPM.');
  } catch (err) {
    log('ERROR:', err.message || err);
    alert('Mic start failed: ' + (err.message || err));
  }
}

async function stop() {
  if (!ctx) return;
  try {
    bpmNode?.disconnect();
    meterNode?.disconnect();
    mic?.disconnect();
    silent?.disconnect();

    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }

    clearInterval(aliveTimer);
    await ctx.close();
    log('AudioContext closed');

    ctx = bpmNode = meterNode = mic = silent = null;
    resetBeatState();
    bpmEl.textContent = '—';
    lvlText.textContent = '— dBFS';
    lvlMaxEl.textContent = '— dBFS';
    meterEl.style.width = '0%';
    meterMaxDb = -36;

    startBtn.disabled = false;
    stopBtn.disabled = true;
  } catch (err) {
    log('ERROR on stop:', err.message || err);
  }
}

startBtn.onclick = async () => {
  // iOS/Safari sometimes starts suspended; resume explicitly
  try { await ctx?.resume(); } catch {}
  start();
};
stopBtn.onclick = stop;

// Debug: expose globals
window.__bpm = () => bpmEl.textContent;
window.__ctx = () => ctx;

function flashBeat() {
  if (!beatEl) return;
  beatEl.classList.add('flash');
  clearTimeout(beatFlashTimer);
  beatFlashTimer = setTimeout(() => beatEl.classList.remove('flash'), 150);
}

function resetBeatState() {
  pauseBeatOscillator(true);
  currentBpm = null;
  beatIntervalSec = null;
  nextBeatTime = null;
  lastBeatTime = null;
  lastOnsetTime = null;
  currentConfidence = 0;
  hasConfidence = false;
  setConfidenceDisplay('—');
}

function updateBeatBpm(bpm) {
  if (!ctx || !bpm || bpm <= 0) return;
  const prevInterval = beatIntervalSec;
  currentBpm = bpm;
  beatIntervalSec = 60 / currentBpm;
  if (!isFinite(beatIntervalSec) || beatIntervalSec <= 0) return;

  const now = ctx.currentTime;
  if (prevInterval == null) {
    lastBeatTime = now;
    nextBeatTime = now + beatIntervalSec;
  } else {
    if (nextBeatTime != null) {
      const origin = lastBeatTime != null ? lastBeatTime : (nextBeatTime - prevInterval);
      lastBeatTime = origin;
      nextBeatTime = origin + beatIntervalSec;
    } else {
      lastBeatTime = now;
      nextBeatTime = now + beatIntervalSec;
    }
  }
  if (isConfidenceHigh()) {
    ensureBeatAnchor();
    scheduleBeatTimeout();
  } else {
    pauseBeatOscillator(false);
  }
}

function scheduleBeatTimeout() {
  if (!ctx || !isConfidenceHigh() || beatIntervalSec == null || beatIntervalSec <= 0 || nextBeatTime == null) return;
  const now = ctx.currentTime;
  if (!isFinite(nextBeatTime)) return;

  while (nextBeatTime <= now + 0.002) {
    lastBeatTime = nextBeatTime;
    nextBeatTime += beatIntervalSec;
  }

  const delayMs = Math.max(0, (nextBeatTime - now) * 1000);
  clearTimeout(beatScheduleTimer);
  beatScheduleTimer = setTimeout(handleScheduledBeat, delayMs);
}

function handleScheduledBeat() {
  beatScheduleTimer = null;
  if (!isConfidenceHigh() || beatIntervalSec == null || beatIntervalSec <= 0) return;
  flashBeat();
  const now = ctx ? ctx.currentTime : 0;
  const scheduledTime = nextBeatTime != null && isFinite(nextBeatTime) ? nextBeatTime : now;
  lastBeatTime = scheduledTime;
  nextBeatTime = scheduledTime + beatIntervalSec;
  scheduleBeatTimeout();
}

function applyOnsetPhaseCorrection(onsetTime) {
  if (!ctx) return;
  const onset = Number.isFinite(onsetTime) ? onsetTime : ctx.currentTime;
  lastOnsetTime = onset;
  if (!currentBpm || beatIntervalSec == null || beatIntervalSec <= 0) return;

  if (nextBeatTime == null) {
    lastBeatTime = onset;
    nextBeatTime = onset + beatIntervalSec;
    if (isConfidenceHigh()) {
      ensureBeatAnchor();
      scheduleBeatTimeout();
    }
    return;
  }

  const prevBeat = (lastBeatTime != null) ? lastBeatTime : (nextBeatTime - beatIntervalSec);
  let errorToNext = onset - nextBeatTime;
  let errorToPrev = onset - prevBeat;

  const absNext = Math.abs(errorToNext);
  const absPrev = Math.abs(errorToPrev);
  const tolerance = Math.min(0.25, beatIntervalSec * 0.45);
  if (!Number.isFinite(errorToNext)) errorToNext = 0;
  if (!Number.isFinite(errorToPrev)) errorToPrev = 0;

  if (absNext <= absPrev) {
    if (Math.abs(errorToNext) > tolerance) {
      lastBeatTime = onset;
      nextBeatTime = onset + beatIntervalSec;
    } else {
      const correction = errorToNext * 0.4;
      nextBeatTime += correction;
      if (lastBeatTime != null && nextBeatTime <= lastBeatTime) {
        nextBeatTime = lastBeatTime + beatIntervalSec;
      }
    }
  } else {
    if (Math.abs(errorToPrev) > tolerance) {
      lastBeatTime = onset;
      nextBeatTime = onset + beatIntervalSec;
    } else {
      const correction = errorToPrev * 0.4;
      const prev = (lastBeatTime != null) ? lastBeatTime : (nextBeatTime - beatIntervalSec);
      lastBeatTime = prev + correction;
      nextBeatTime = lastBeatTime + beatIntervalSec;
    }
  }

  if (nextBeatTime != null && ctx) {
    const now = ctx.currentTime;
    while (nextBeatTime <= now + 0.002) {
      lastBeatTime = nextBeatTime;
      nextBeatTime += beatIntervalSec;
    }
  }
  if (isConfidenceHigh()) {
    ensureBeatAnchor();
    scheduleBeatTimeout();
  } else {
    pauseBeatOscillator(false);
  }
}

function updateConfidence(value) {
  const clamped = clamp01(value);
  const prevHigh = isConfidenceHigh();
  currentConfidence = clamped;
  hasConfidence = true;
  setConfidenceDisplay(Math.round(clamped * 100) + '%');
  const nowHigh = isConfidenceHigh();
  if (nowHigh && !prevHigh) {
    ensureBeatAnchor();
    scheduleBeatTimeout();
  } else if (!nowHigh && prevHigh) {
    pauseBeatOscillator(false);
  }
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function isConfidenceHigh() {
  return hasConfidence && currentConfidence >= BEAT_CONF_THRESHOLD;
}

function ensureBeatAnchor() {
  if (!ctx || beatIntervalSec == null || beatIntervalSec <= 0) return;
  const now = ctx.currentTime;
  if (nextBeatTime == null || !isFinite(nextBeatTime)) {
    const base = (lastBeatTime != null && isFinite(lastBeatTime)) ? lastBeatTime : now;
    lastBeatTime = base;
    nextBeatTime = base + beatIntervalSec;
  }
  while (nextBeatTime <= now + 0.01) {
    lastBeatTime = nextBeatTime;
    nextBeatTime += beatIntervalSec;
  }
}

function pauseBeatOscillator(resetPhase) {
  clearTimeout(beatScheduleTimer);
  beatScheduleTimer = null;
  clearTimeout(beatFlashTimer);
  beatFlashTimer = null;
  if (beatEl) beatEl.classList.remove('flash');
  if (resetPhase) {
    nextBeatTime = null;
    lastBeatTime = null;
  }
}

function setConfidenceDisplay(text) {
  if (confidenceEl) confidenceEl.textContent = text;
}
