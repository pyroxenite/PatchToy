/**
 * Clock - the single time base for every renderer, plus the beat clock.
 *
 * Every ShaderPreview, the background preview and the FeedbackRenderer read
 * `clock.u` (via applyClockUniforms) instead of keeping their own start time,
 * so multi-pass graphs (Feedback render targets feeding a Preview) and the
 * audio uniforms are evaluated at exactly the same moment within a frame.
 *
 * The clock advances once per animation frame. Its rAF callback is registered
 * when this module is first imported (before any renderer exists), so it runs
 * first in every frame and all renderers of that frame see the same values.
 *
 * Time:  `time` (u_time, seconds) stops while paused; `withOverride()` pins
 *        time / beat for automation renders (render_preview).
 *
 * Beat clock: a continuous beat position B (beats). beatCount = floor(B),
 *        beatPhase = fract(B). Each frame B advances by dt / period and is
 *        slewed towards a target position from one of:
 *          - the audio beat tracker (AudioEngine), while its confidence is good
 *            (on >= 0.35, off < 0.2); otherwise it freewheels at the last tempo;
 *          - the metronome (fixed BPM, optionally phase-anchored by tap tempo);
 *          - tap tempo with no audio source.
 *        Slewing never runs the clock backwards (at worst 25% speed) or faster
 *        than 2x, so beat-driven animation stays smooth when the phase is corrected.
 *        The target includes a display lookahead (~1.5 frames) and the user's
 *        audio/visual offset, so the visual beat lands on the audible beat.
 *
 * Tempo: the beat position advances with the tracker's beat period (it follows tempo
 *        changes beat by beat), while u_bpm is the tracker's smoothed tempo, so it glides.
 *        `bpmShown` is the 0.1-BPM display value with hysteresis (UI readout).
 *
 * Published (stable) beat clock. Everything above is the *raw* clock (rawPos / rawPeriodMs):
 *        the tracker's live estimate, which goes chaotic for a few seconds when the music
 *        changes (a new track: the tracker coasts at the old tempo, then relocks with a tempo
 *        step and a fast phase slew). Shaders and nodes see a separate *published* clock
 *        (pubPos, pubTempo) that only takes over an estimate once it is trusted:
 *          lock   trusted and converged: the published tempo follows the tracker's smoothed
 *                 tempo (tau 0.4 s), the phase follows the raw clock by bending the rate
 *                 (at most +-25%, never backwards, never a jump).
 *          coast  the estimate is untrusted (confidence < TRUST_OFF, the tempo stepped by
 *                 > 3% or the phase moved > 0.12 beat from the published one, for BAD_MS;
 *                 at once when clearly gone: confidence < 0.1, a step > 8% or a move > 0.25
 *                 beat, i.e. a new track; short dips of weak room-mic onsets are ridden out,
 *                 holding tempo and rate meanwhile): the published clock keeps the last
 *                 trusted tempo and its continuous phase.
 *          glide  the estimate has held still (confidence >= TRUST_ON, tempo within 1.5%, raw
 *                 clock no longer slewing) for SETTLE_MS and 2 of its beats: the tempo glides
 *                 to it over GLIDE_BEATS (a bar, smoothstep, monotonic) while the phase is
 *                 pulled in by the same rate bend; then lock.
 *        So u_beatPhase stays continuous and u_beatTime monotonic through track changes, and
 *        u_bpm moves smoothly from the old tempo to the new one.
 *        u_beatTrust (0..1) says how far the published clock can be relied on: 0 while it
 *        coasts, rising with the convergence of a glide, x the tracker confidence when locked,
 *        x a fast drop when the confidence falls far below its own recent distribution while
 *        locked (1.5-3.5 deviations below its mean: a new track the tracker hasn't noticed
 *        yet), so steady but moderate confidence keeps it; half while an estimate is on hold;
 *        1 whenever no live audio drives the clock (audio off, metronome, taps, manual
 *        stepping, render_preview), so silent / metronome renders are unchanged.
 *        u_beat (the pulse) fades with it: exp(-6 phase) * beatGate(u_beatTrust).
 *        u_beatConfidence keeps its meaning (the tracker's own confidence).
 *        u_beatRaw = (phase, bar phase, count, bpm) of the raw clock, for diagnostics.
 *        Without live audio the published clock *is* the raw clock (bit for bit).
 *        User gestures (tap, typed BPM, mode change) act on the published clock directly
 *        (the raw clock is re-based on it first, then the published one snaps to the result).
 */

const PULSE_DECAY = 6;          // u_beat = exp(-beatPhase * 6)
const FOLLOW_ON = 0.35;         // tracker confidence needed to start following it
const FOLLOW_OFF = 0.2;         // ... and below which the clock freewheels again
const TAP_RESET_MS = 2000;      // a pause this long starts a new tap sequence
const SHOW_HYST = 0.08;         // BPM readout changes only when the tempo moves this far from it

// Published clock (see header)
const TRUST_ON = 0.35;          // tracker confidence needed before an estimate can be trusted...
const TRUST_OFF = 0.2;          // ... and below which the published clock coasts (= FOLLOW_ON / OFF:
                                // low but steady confidence still drives it; u_beatTrust fades effects)
const SETTLE_MS = 1000;         // a new estimate must hold still this long (and >= 2 of its beats)
const SETTLE_TEMPO = 0.015;     // "holding still": tempo within 1.5% of the candidate...
const SETTLE_SLEW = 0.06;       // ... and the raw clock not slewing by more than this (beats)
const TEMPO_JUMP = 0.03;        // a locked estimate whose tempo steps this far is a new estimate...
const PHASE_JUMP = 0.12;        // ... or whose phase moved this far from the published one (beats)
const LOCK_PHASE = 0.03;        // a glide ends (lock) once the phase error is below this
const GLIDE_BEATS = 4;          // tempo glide to a newly trusted tempo: about one bar
const BEND_MAX = 0.25;          // phase correction bends the published rate by at most +-25%
const BEND_TAU = 150;           // ms: the bend itself is smoothed (the rate never steps)
const TEMPO_TAU = 400;          // ms: locked published tempo follows the tracker's smoothed tempo
const TRUST_UP_MS = 500;        // u_beatTrust rises with this time constant...
const TRUST_DOWN_MS = 120;      // ... and falls with this one
const BAD_MS = 400;             // a trusted estimate must be untrustworthy this long before coasting
                                // (weak mic onsets dip briefly), unless it is clearly gone:
const SEVERE_CONF = 0.1;        //   confidence below this,
const SEVERE_TEMPO = 0.08;      //   a tempo step this large,
const SEVERE_PHASE = 0.25;      //   or a phase move this large (beats)
const CONF_TAU = 8000;          // ms: recent mean of the tracker confidence while locked (trust drop)...
const CONF_VAR_TAU = 10000;     // ... and its spread, both learned from values within the normal band
const CONF_ESCAPE_TAU = 12000;  // ms: the mean follows values below the band only this slowly
const CONF_SD0 = 0.1;           // spread assumed at the first lock

/**
 * Certainty gate 0..1 for beat effects: smoothstep around `threshold` (default 0.5: 0 at
 * u_beatTrust 0.25, 1 at 0.75). threshold <= 0: always 1. Same formula as beatGateGLSL.
 */
export function beatGate(trust, threshold = 0.5) {
    const thr = Math.min(Number.isFinite(threshold) ? threshold : 0.5, 1);
    if (thr <= 0) return 1;
    const lo = Math.max(thr - 0.25, 0), hi = Math.min(thr + 0.25, 1);
    const t = clamp((trust - lo) / (hi - lo), 0, 1);
    return t * t * (3 - 2 * t);
}

/** GLSL of beatGate (trust and threshold are GLSL expressions). */
export function beatGateGLSL(trust, threshold = '0.5') {
    const thr = `min(${threshold}, 1.0)`;
    return `(${thr} <= 0.0 ? 1.0 : smoothstep(max(${thr} - 0.25, 0.0), min(${thr} + 0.25, 1.0), ${trust}))`;
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const easeOutCubic = (p) => { const q = 1 - p; return 1 - q * q * q; };

export class Clock {
    constructor() {
        this.time = 0;
        this.paused = false;
        this.manualOwners = new Set(); // external frame drivers (setManual): offline export, output window
        this.frame = 0;
        this.lastNow = -1;
        this.frameMs = 1000 / 60;
        // Frame time (ms) summed over every frame, paused or not, manual steps included:
        // per-frame smoothing (MIDI CC) measures the time between two of its frames with it
        this.elapsedMs = 0;

        // Beat clock: raw (tracker-following) and published (what shaders see; see header).
        // beatPos / periodMs (accessors below) read the published clock and set both.
        this.rawPos = 0;
        this.rawPeriodMs = 500;
        this.rawSlew = 0;            // raw clock's phase error to its target this frame (beats)
        this.pubPos = 0;
        this.pubPeriodMs = 500;      // published period (nominal, without the phase bend)
        this.pubTempo = 120;         // published tempo while live audio drives it
        this.pubState = 'lock';      // 'lock' | 'glide' | 'coast' (only meaningful while live)
        this.trusted = true;         // published clock trusts the estimate (false = coasting)
        this.trust = 1;              // u_beatTrust
        this.untrustedSince = null;  // perf time the published clock started coasting (live)
        this._live = false;          // live audio drove the clock last frame
        this._cand = null;           // { bpm, since }: estimate settling before it is trusted
        this._glide = null;          // { from, to, t0, dur }: tempo glide
        this._bend = 0;              // current rate bend (fraction)
        this._confMean = -1;         // recent mean of the tracker confidence while locked (-1 = none yet)...
        this._confVar = 0;           // ... and its variance (trust drop)
        this._badSince = null;       // perf time the estimate became untrustworthy (BAD_MS)
        this._goodAt = null;         // perf time the estimate was last good enough
        this._rateTempo = 120;       // tempo the published clock advances at (before the bend)
        this.mode = 'free';          // 'free' | 'metronome'  (audio following is decided per frame)
        this.metroBpm = 120;
        this.anchorMs = null;        // perf time of a beat (metronome / taps), null = freewheel
        this.following = false;      // currently following the audio tracker
        this.offsetMs = 0;           // user A/V offset: positive = visuals later
        this.audio = null;           // AudioEngine, attached by the engine itself
        this.taps = [];
        this.tapAnchored = false;    // the beat phase comes from the user's taps (audio off: confidence 1)
        this.audioBpm = 0;           // smoothed tracker tempo while following (u_bpm)
        this.bpmShown = 120;         // UI readout (0.1 BPM, hysteresis)

        /** Uniform block read by the renderers (plain numbers, updated in place). */
        this.u = {
            time: 0,
            level: 0, bass: 0, lowMid: 0, mid: 0, high: 0, kick: 0,
            beat: 1, beatPhase: 0, barPhase: 0, beatCount: 0, bpm: 120, beatTime: 0,
            confidence: 0,
            trust: 1,                // u_beatTrust
            raw: [0, 0, 0, 120]      // u_beatRaw: raw clock (phase, bar phase, count, bpm)
        };

        this.listeners = new Set();
        this._override = 0;
        this._tick = this._tick.bind(this);
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(this._tick);
    }

    /** Beat position (beats) of the published clock; setting it moves both clocks. */
    get beatPos() { return this.pubPos; }
    set beatPos(v) { this.rawPos = this.pubPos = v; }

    /** Beat period (ms) of the published clock; setting it sets both clocks' tempo. */
    get periodMs() { return this.pubPeriodMs; }
    set periodMs(v) {
        this.rawPeriodMs = this.pubPeriodMs = v;
        if (v > 0) this.pubTempo = 60000 / v;
    }

    /** ms the published clock has been coasting on an untrusted estimate (0 = trusted / not live). */
    untrustedMs(now = performance.now()) {
        return this.trusted || this.untrustedSince === null ? 0 : Math.max(0, now - this.untrustedSince);
    }

    _tick(now) {
        requestAnimationFrame(this._tick);
        if (!this.manual) this.update(now);
    }

    /** Subscribe to state changes (pause, mode, tempo set by the user). Returns an unsubscribe fn. */
    onChange(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    emit(reason) {
        for (const fn of this.listeners) {
            try { fn(reason, this); } catch (e) { console.warn('[clock] listener failed', e); }
        }
    }

    // ------------------------------------------------------------------
    // Time / transport
    // ------------------------------------------------------------------

    pause() { this.setPaused(true); }
    resume() { this.setPaused(false); }
    togglePause() { this.setPaused(!this.paused); }

    setPaused(paused) {
        paused = !!paused;
        if (paused === this.paused) return;
        this.paused = paused;
        this.emit('pause');
    }

    /** Jump u_time (seconds). */
    setTime(seconds) {
        this.time = Number(seconds) || 0;
        this.u.time = this.time;
    }

    // ------------------------------------------------------------------
    // Frame update
    // ------------------------------------------------------------------

    update(now) {
        if (this.lastNow < 0) this.lastNow = now;
        let dt = now - this.lastNow;
        this.lastNow = now;
        if (!(dt > 0)) dt = 0;
        if (dt > 250) dt = 250; // hidden tab / breakpoint: don't jump
        if (dt > 0 && dt < 100) this.frameMs += (dt - this.frameMs) * 0.05;
        this.frame++;
        this.elapsedMs += dt;
        if (this._override || this.paused) return;

        this.time += dt / 1000;
        this.u.time = this.time;

        const audio = this.audio;
        const live = !!(audio && audio.isLive && audio.isLive());
        if (live) audio.update(now, this);

        // Visual beat lands on the audible beat: frames reach the screen ~1.5 frames later
        const lookahead = 1.5 * this.frameMs - this.offsetMs;
        let target = NaN;

        // ---- raw clock: follows the tracker / metronome / taps ----
        if (this.mode === 'metronome' || !live) {
            if (this.following) this.following = false;
            if (this.mode === 'metronome') this.rawPeriodMs = 60000 / this.metroBpm;
            if (this.anchorMs !== null) target = (now + lookahead - this.anchorMs) / this.rawPeriodMs;
        } else {
            const conf = audio.beatValid ? audio.beatConfidence : 0;
            if (!this.following && conf >= FOLLOW_ON) this.following = true;
            else if (this.following && conf < FOLLOW_OFF) {
                this.following = false;
                // freewheel at the smoothed tempo (not the last beat's period)
                if (this.audioBpm > 0) this.rawPeriodMs = 60000 / this.audioBpm;
            }
            if (this.following) {
                this.rawPeriodMs = audio.beatPeriodMs;
                this.audioBpm = audio.bpm > 0 ? audio.bpm : 60000 / audio.beatPeriodMs;
                // audio.beatRefMs is the audible time of a beat (latency + user offset applied)
                target = (now + 1.5 * this.frameMs - audio.beatRefMs) / this.rawPeriodMs;
                this.anchorMs = null;
            } else if (this.anchorMs !== null) {
                target = (now + lookahead - this.anchorMs) / this.rawPeriodMs;
            }
        }

        const rate = dt / this.rawPeriodMs;
        this.rawPos += rate;
        this.rawSlew = 0;
        if (Number.isFinite(target) && dt > 0) {
            let err = target - this.rawPos;
            err -= Math.round(err);
            this.rawSlew = err;
            const tau = Math.abs(err) > 0.2 ? 120 : 300; // ms
            const corr = clamp(err * Math.min(1, dt / tau), -0.75 * rate, rate);
            this.rawPos += corr;
        }
        const following = this.following && this.mode !== 'metronome' && live;

        const u = this.u;
        if (this.mode === 'metronome') {
            u.confidence = 1;
        } else if (live) {
            u.level = audio.level;
            u.bass = audio.bass;
            u.lowMid = audio.lowMid;
            u.mid = audio.mid;
            u.high = audio.high;
            u.kick = audio.kick;
            // u_beatConfidence: the tracker's value (0 no beat / coasting, ~0.5 tentative,
            // ~1 locked and phase-confirmed); a file whose tempo the user locked counts as known
            const lockedFile = audio.source === 'file' && audio.settings && audio.settings.locked && audio.beatValid;
            u.confidence = lockedFile ? 1 : audio.beatValid ? audio.beatConfidence : 0;
        } else {
            // audio off: 0, unless the user tapped the beat (then it is known)
            u.level = u.bass = u.lowMid = u.mid = u.high = u.kick = 0;
            u.confidence = this.tapAnchored && this.anchorMs !== null ? 1 : 0;
        }

        // ---- published clock ----
        const rawBpm = following ? this.audioBpm : 60000 / this.rawPeriodMs;
        if (this.mode !== 'metronome' && live) this._publishLive(now, dt, following, u.confidence, rawBpm);
        else this._publishRaw(now);
        this._derivePublished();
        this.showBpm(u.bpm);
        if (this.mode === 'metronome') Clock.groove(this.pubPos, this.pubPeriodMs, u);
    }

    /** No live audio: the published clock is the raw clock. */
    _publishRaw(now) {
        if (this._live) {
            // Live audio just stopped: the raw clock continues from the published one (no jump)
            this._live = false;
            this.rawPos = this.pubPos;
            this.rawPeriodMs = this.pubPeriodMs;
            if (this.anchorMs !== null) this.anchorMs = this.currentAnchor(now);
        }
        this.pubPos = this.rawPos;
        this.pubPeriodMs = this.rawPeriodMs;
        this.pubTempo = 60000 / this.rawPeriodMs;
        this.pubState = 'lock';
        this.trusted = true;
        this.trust = 1;
        this.untrustedSince = null;
        this._cand = null;
        this._glide = null;
        this._bend = 0;
    }

    /** Live audio: coast / glide / lock on the tracker's estimate (see header). */
    _publishLive(now, dt, following, conf, rawBpm) {
        if (!this._live) {
            // Audio just went live: continue at the current tempo until the tracker earns trust
            this._live = true;
            this.pubTempo = this._rateTempo = 60000 / this.pubPeriodMs;
            this._enterCoast(now);
        }
        const good = following && rawBpm > 0 && conf >= (this.trusted ? TRUST_OFF : TRUST_ON);
        if (good) this._goodAt = now;

        // Is the estimate holding still? (tempo near the candidate, raw clock not slewing; a
        // dip shorter than BAD_MS doesn't restart it)
        const c = this._cand;
        if (!good) { if (this._goodAt === null || now - this._goodAt > BAD_MS) this._cand = null; }
        else if (!c || Math.abs(rawBpm / c.bpm - 1) > SETTLE_TEMPO || Math.abs(this.rawSlew) > SETTLE_SLEW) this._cand = { bpm: rawBpm, since: now };
        else c.bpm += (rawBpm - c.bpm) * 0.05;
        const cand = this._cand;
        const settled = good && !!cand && now - cand.since >= Math.max(SETTLE_MS, 2 * 60000 / cand.bpm);

        // Phase error to the estimate (beats, wrapped), against where the published clock is
        // about to be (the raw clock has already advanced this frame)
        let err = this.rawPos - (this.pubPos + dt * this._rateTempo / 60000);
        err -= Math.round(err);

        // State transitions. A trusted estimate is dropped once it has been untrustworthy for
        // BAD_MS (confidence too low, glide target lost, tempo stepped or phase moved), at once
        // when it is clearly gone (a new track); short dips of weak onsets are ridden out.
        if (this.pubState === 'coast') {
            this._badSince = null;
            if (settled) {
                this.pubState = 'glide';
                this.trusted = true;
                this.untrustedSince = null;
                const from = this.pubTempo, to = cand.bpm;
                this._glide = { from, to, t0: now, dur: GLIDE_BEATS * 120000 / (from + to) };
            }
        } else {
            const tempoOff = rawBpm > 0 ? Math.abs(rawBpm / this.pubTempo - 1) : 1;
            const bad = !good || (this.pubState === 'glide' && !cand) ||
                (this.pubState === 'lock' && (tempoOff > TEMPO_JUMP || Math.abs(err) > PHASE_JUMP));
            const severe = conf < SEVERE_CONF || (this.pubState === 'lock' && (tempoOff > SEVERE_TEMPO || Math.abs(err) > SEVERE_PHASE));
            if (!bad) this._badSince = null;
            else if (this._badSince === null) this._badSince = now;
            if (bad && (severe || now - this._badSince >= BAD_MS)) this._enterCoast(now);
        }
        // Holding: untrustworthy for less than BAD_MS. The published clock carries on as if
        // coasting (tempo and rate held, no phase bend: a tempo step isn't chased before it is
        // confirmed), at half trust; if the estimate recovers it simply stays locked.
        const hold = this.pubState === 'lock' && this._badSince !== null;

        // Tempo
        if (this.pubState === 'glide') {
            const g = this._glide;
            if (cand) g.to = cand.bpm;
            const p = clamp((now - g.t0) / g.dur, 0, 1);
            let t = g.from + (g.to - g.from) * p * p * (3 - 2 * p);
            if ((t - this.pubTempo) * (g.to - g.from) < 0) t = this.pubTempo; // monotonic
            this.pubTempo = t;
            if (p >= 1 && Math.abs(err) < LOCK_PHASE) {
                this.pubState = 'lock';
                this._glide = null;
            }
        } else if (this.pubState === 'lock' && !hold) {
            this.pubTempo += (rawBpm - this.pubTempo) * (1 - Math.exp(-dt / TEMPO_TAU));
        }
        this.pubPeriodMs = 60000 / this.pubTempo;
        // Rate: the published tempo while coasting / gliding; when locked, the tracker's beat
        // period (it follows tempo changes beat by beat, u_bpm stays the smoothed tempo)
        const rateTarget = this.pubState === 'lock' && following && !hold ? 60000 / this.rawPeriodMs : this.pubTempo;
        this._rateTempo += (rateTarget - this._rateTempo) * (1 - Math.exp(-dt / BEND_TAU));

        // Phase: bend the rate towards the estimate (trusted only), smoothly, never backwards
        // (time constant: half a beat when locked, a beat while gliding)
        const bendTarget = this.trusted && !hold ? clamp(err * (this.pubState === 'lock' ? 2 : 1), -BEND_MAX, BEND_MAX) : 0;
        this._bend += (bendTarget - this._bend) * (1 - Math.exp(-dt / BEND_TAU));
        this.pubPos += (dt * this._rateTempo / 60000) * (1 + this._bend);

        // Confidence drop relative to its own recent distribution (mean and spread over ~10 s):
        // a fall far below what is normal for this signal (a new track the tracker still coasts
        // through or locks onto at the wrong phase, a breakdown) lowers trust quickly, while
        // confidence that always fluctuates (weak or smeared onsets through a room mic,
        // syncopation) keeps it. The distribution is learned from values within the normal band
        // (down to 2.5 deviations below the mean), so a lasting fall doesn't become the new
        // normal within seconds: the mean only creeps after it (CONF_ESCAPE_TAU). Learned while
        // locked only (the climb of a fresh lock isn't the signal's spread), anew after every
        // coast (another track, another source).
        if (this.pubState === 'lock' && !hold) {
            if (this._confMean < 0) { this._confMean = conf; this._confVar = CONF_SD0 * CONF_SD0; }
            const dm = conf - this._confMean;
            const inBand = dm > -2.5 * Math.max(Math.sqrt(this._confVar), 0.04);
            this._confMean += dm * (1 - Math.exp(-dt / (inBand ? CONF_TAU : CONF_ESCAPE_TAU)));
            if (inBand) this._confVar += (dm * dm - this._confVar) * (1 - Math.exp(-dt / CONF_VAR_TAU));
        }
        const z = this._confMean < 0 ? 0 : (this._confMean - conf) / Math.max(Math.sqrt(this._confVar), 0.04);
        const dr = clamp((3.5 - z) / 2, 0, 1);
        const drop = dr * dr * (3 - 2 * dr); // 1 within 1.5 deviations below the mean, 0 beyond 3.5

        // u_beatTrust: 0 while coasting, rises as a glide converges, x the tracker confidence
        let q = 0;
        if (this.trusted) {
            q = clamp(1 - Math.abs(err) / 0.25, 0, 1) * clamp(1 - Math.abs(this.pubTempo / rawBpm - 1) / 0.05, 0, 1) *
                clamp(conf, 0, 1) * drop * (hold ? 0.5 : 1);
        }
        this.trust += (q - this.trust) * (1 - Math.exp(-dt / (q < this.trust ? TRUST_DOWN_MS : TRUST_UP_MS)));
    }

    _enterCoast(now) {
        this.pubState = 'coast';
        this._badSince = null;
        this._confMean = -1;
        this.trusted = false;
        if (this.untrustedSince === null) this.untrustedSince = now;
        this._cand = null;
        this._glide = null;
    }

    /** Beat fields of `u` from the published clock, u_beatTrust, u_beatRaw. */
    _derivePublished() {
        const u = this.u;
        this.deriveBeat(this.pubPos, this.pubPeriodMs, u, this._live ? this.pubTempo : 0);
        if (this.trust < 1) u.beat *= beatGate(this.trust);
        u.trust = this.trust;
        this._fillRaw(u.raw);
    }

    /** u_beatRaw (in place): phase, bar phase, count, bpm of the raw clock. */
    _fillRaw(r) {
        const B = this.rawPos;
        const count = Math.floor(B);
        const phase = B - count;
        r[0] = phase;
        r[1] = ((((count % 4) + 4) % 4) + phase) / 4;
        r[2] = count;
        r[3] = this.following && this._live ? this.audioBpm : 60000 / this.rawPeriodMs;
    }

    /** User gesture on the clock: the raw clock continues from the published one first. */
    _rebase() {
        this.rawPos = this.pubPos;
        this.rawPeriodMs = this.pubPeriodMs;
    }

    /** ... and afterwards the published clock takes the gesture's result as is. */
    _snapPublished() {
        this.pubPos = this.rawPos;
        this.pubPeriodMs = this.rawPeriodMs;
        this.pubTempo = this._rateTempo = 60000 / this.rawPeriodMs;
        this._bend = 0;
        this._glide = null;
        this._cand = null;
        if (this._live) { this.pubState = 'lock'; this.trusted = true; this.untrustedSince = null; }
        this._derivePublished();
    }

    /** Readout value: 0.1 BPM steps, only moving when the tempo leaves a small band around it. */
    showBpm(bpm, force = false) {
        if (!(bpm > 0)) return;
        if (force || Math.abs(bpm - this.bpmShown) > SHOW_HYST) this.bpmShown = Math.round(bpm * 10) / 10;
    }

    /** Fill the beat fields of `u` for beat position B (tempo `bpm`, default from the period). */
    deriveBeat(B, periodMs, u, bpm = 0) {
        const count = Math.floor(B);
        const phase = B - count;
        u.beatCount = count;
        u.beatPhase = phase;
        u.barPhase = ((((count % 4) + 4) % 4) + phase) / 4;
        u.beat = Math.exp(-phase * PULSE_DECAY);
        u.beatTime = count + easeOutCubic(phase);
        u.bpm = bpm > 0 ? bpm : 60000 / periodMs;
    }

    /**
     * Metronome "virtual groove": deterministic audio values for beat position B, so
     * audio-reactive shaders also move with no music (and render reproducibly headless):
     * kick + bass on every beat, snare (mid) on beats 2 and 4, hats (high) on 8ths.
     */
    static groove(B, periodMs, u) {
        const count = Math.floor(B);
        const phase = B - count;
        const sec = phase * periodMs / 1000;
        const kick = Math.exp(-sec / 0.11);
        const snare = (((count % 2) + 2) % 2) === 1 ? Math.exp(-sec / 0.16) : 0;
        const half = (phase * 2) % 1;
        const hat = Math.exp(-(half * periodMs / 2000) / 0.05) * (phase >= 0.5 ? 1 : 0.6);
        u.kick = kick;
        u.bass = 0.15 + 0.8 * Math.exp(-sec / 0.25);
        u.level = 0.25 + 0.45 * kick + 0.2 * snare + 0.05 * hat;
        u.lowMid = 0.2 + 0.3 * kick + 0.4 * snare;
        u.mid = 0.2 + 0.6 * snare + 0.1 * hat;
        u.high = 0.12 + 0.65 * hat;
    }

    // ------------------------------------------------------------------
    // Beat clock control
    // ------------------------------------------------------------------

    /** Current beat phase anchor in perf time (keeps the phase continuous when switching). */
    currentAnchor(now = performance.now()) {
        const lookahead = 1.5 * this.frameMs - this.offsetMs;
        const phase = this.rawPos - Math.floor(this.rawPos);
        return now + lookahead - phase * this.rawPeriodMs;
    }

    /** 'metronome' (fixed BPM, no audio needed) or 'free' (follow audio / freewheel). */
    setMode(mode, { bpm } = {}) {
        const m = mode === 'metronome' ? 'metronome' : 'free';
        if (bpm > 0) this.metroBpm = clamp(Number(bpm), 20, 400);
        this._rebase();
        if (m === 'metronome') {
            this.anchorMs = this.currentAnchor();
            this.rawPeriodMs = 60000 / this.metroBpm;
        }
        const changed = m !== this.mode;
        this.mode = m;
        this.tapAnchored = false;
        this._snapPublished();
        this.showBpm(this.u.bpm, true);
        this.emit(changed ? 'mode' : 'tempo');
    }

    /** Set the tempo (metronome BPM / freewheel tempo), keeping the current phase. */
    setBpm(bpm) {
        bpm = Number(bpm);
        if (!(bpm > 0)) return;
        bpm = clamp(bpm, 20, 400);
        this._rebase();
        const anchor = this.currentAnchor();
        this.metroBpm = bpm;
        this.rawPeriodMs = 60000 / bpm;
        this.anchorMs = anchor;
        this._snapPublished(); // typed tempo: published at once (live: trusted)
        this.showBpm(bpm, true);
        this.emit('tempo');
    }

    /**
     * Tap tempo. The first tap of a sequence is the downbeat (bar position resets);
     * the tempo is the median tap interval. Returns { bpm, taps, first }.
     */
    tap(now = performance.now()) {
        const last = this.taps[this.taps.length - 1];
        const first = !(last !== undefined && now - last < TAP_RESET_MS);
        if (first) this.taps = [];
        this.taps.push(now);
        this._rebase();
        if (this.taps.length > 9) this.taps.shift();

        let bpm = null;
        if (this.taps.length >= 2) {
            const iv = [];
            for (let i = 1; i < this.taps.length; i++) iv.push(this.taps[i] - this.taps[i - 1]);
            iv.sort((a, b) => a - b);
            const med = iv[iv.length >> 1];
            bpm = clamp(60000 / med, 30, 300);
            this.metroBpm = bpm;
            this.rawPeriodMs = 60000 / bpm;
        }
        // Phase: the tap is an audible beat
        this.anchorMs = now;
        this.tapAnchored = true;
        const lookahead = 1.5 * this.frameMs - this.offsetMs;
        const target = (now + lookahead - this.anchorMs) / this.rawPeriodMs;
        let err = target - this.rawPos;
        err -= Math.round(err);
        this.rawPos += err; // a tap is an explicit gesture: snap
        if (first) {
            // Downbeat: the beat at this tap becomes beat 1 of a bar (count multiple of 4)
            const n = Math.round(this.rawPos);
            this.rawPos += (4 * Math.ceil(n / 4) - n);
        }
        this._snapPublished(); // the published clock snaps too (live: the tap is trusted)
        if (bpm) this.showBpm(bpm, true);
        this.emit('tap');
        return { bpm, taps: this.taps.length, first };
    }

    // ------------------------------------------------------------------
    // Automation
    // ------------------------------------------------------------------

    /**
     * Run fn with pinned values (synchronous renders, e.g. render_preview):
     *   time  -> u_time
     *   beat  -> beat position (beats); without it, time * bpm / 60
     *   bpm   -> defaults to the metronome / current tempo
     * Beat and audio values are deterministic (metronome groove) whenever time or beat is given.
     */
    withOverride({ time, beat, bpm } = {}, fn) {
        const saved = { ...this.u };
        this._override++;
        try {
            const u = this.u;
            const tempo = bpm > 0 ? Number(bpm) : (this.mode === 'metronome' ? this.metroBpm : u.bpm || 120);
            const periodMs = 60000 / tempo;
            let B = Number.isFinite(beat) ? Number(beat) : undefined;
            let t = Number.isFinite(time) ? Number(time) : undefined;
            if (t === undefined && B !== undefined) t = B * periodMs / 1000;
            if (B === undefined && t !== undefined) B = t * tempo / 60;
            if (t !== undefined) u.time = t;
            if (B !== undefined) {
                this.deriveBeat(B, periodMs, u);
                Clock.groove(B, periodMs, u);
                u.confidence = 1;
                u.trust = 1;
                // (a new array: the saved copy keeps the live one)
                u.raw = [u.beatPhase, u.barPhase, u.beatCount, tempo];
            }
            return fn();
        } finally {
            Object.assign(this.u, saved);
            this._override--;
        }
    }

    // ------------------------------------------------------------------
    // Manual stepping (offline export, src/output/OfflineExporter.js)
    // ------------------------------------------------------------------

    /**
     * Manual mode: this page's animation frames stop advancing the clock (and
     * main.js skips its per-frame work); an external driver does it instead:
     *   - offline export: step(dt) at a fixed timestep (slower than real time).
     *     Audio analysis is not stepped: the metronome groove stays deterministic,
     *     a live audio source freewheels at its tempo with the band values at 0;
     *   - the output window: update(performance.now()) once per output frame.
     * Several drivers may hold it (owner); manual while any does.
     */
    get manual() { return this.manualOwners.size > 0; }

    setManual(on, { time, owner = 'default' } = {}) {
        if (Number.isFinite(time)) this.setTime(time);
        const was = this.manual;
        if (on) this.manualOwners.add(owner); else this.manualOwners.delete(owner);
        if (this.manual === was) return;
        if (!this.manual) {
            // Back to real time: phase-anchored modes continue from the stepped beat position
            this.lastNow = -1;
            if (this.anchorMs !== null) this.anchorMs = this.currentAnchor();
        }
        this.emit('manual');
    }

    /** Advance time and the beat clock by dt seconds (manual mode). */
    step(dt) {
        dt = Math.max(0, Number(dt) || 0);
        this.frame++;
        this.elapsedMs += dt * 1000;
        this.time += dt;
        const u = this.u;
        u.time = this.time;
        // Stepped clocks are not live: a live source freewheels at the published tempo
        if (this._live) this._publishRaw(performance.now());
        if (this.mode === 'metronome') this.rawPeriodMs = 60000 / this.metroBpm;
        this.rawPos += (dt * 1000) / this.rawPeriodMs;
        this.pubPos = this.rawPos;
        this.pubPeriodMs = this.rawPeriodMs;
        this.pubTempo = 60000 / this.rawPeriodMs;
        this.trust = 1;
        this._derivePublished();
        if (this.mode === 'metronome') {
            Clock.groove(this.rawPos, this.rawPeriodMs, u);
            u.confidence = 1;
        } else {
            u.level = u.bass = u.lowMid = u.mid = u.high = u.kick = 0;
            u.confidence = this.tapAnchored && this.anchorMs !== null ? 1 : 0;
        }
    }

    status() {
        return {
            time: +this.time.toFixed(3),
            paused: this.paused,
            mode: this.mode,
            following_audio: this.following,
            beat_trusted: this.trusted,
            beat_trust: +this.trust.toFixed(3),
            beat_state: this._live ? this.pubState : 'direct',
            raw_bpm: +this.u.raw[3].toFixed(2),
            bpm: +this.u.bpm.toFixed(2),
            metronome_bpm: +this.metroBpm.toFixed(2),
            beat_count: this.u.beatCount,
            beat_phase: Math.floor(this.u.beatPhase * 1000) / 1000,
            bar_phase: Math.floor(this.u.barPhase * 1000) / 1000,
            offset_ms: this.offsetMs
        };
    }
}

export const clock = new Clock();

/**
 * Upload the clock / audio uniforms that a program declares. `locs` maps uniform
 * names to WebGLUniformLocation (missing = not used). Allocation-free.
 */
export function applyClockUniforms(gl, locs) {
    const u = clock.u;
    let l;
    if ((l = locs.u_time)) gl.uniform1f(l, u.time);
    if ((l = locs.u_level)) gl.uniform1f(l, u.level);
    if ((l = locs.u_bass)) gl.uniform1f(l, u.bass);
    if ((l = locs.u_lowMid)) gl.uniform1f(l, u.lowMid);
    if ((l = locs.u_mid)) gl.uniform1f(l, u.mid);
    if ((l = locs.u_high)) gl.uniform1f(l, u.high);
    if ((l = locs.u_kick)) gl.uniform1f(l, u.kick);
    if ((l = locs.u_beat)) gl.uniform1f(l, u.beat);
    if ((l = locs.u_beatPhase)) gl.uniform1f(l, u.beatPhase);
    if ((l = locs.u_barPhase)) gl.uniform1f(l, u.barPhase);
    if ((l = locs.u_beatCount)) gl.uniform1f(l, u.beatCount);
    if ((l = locs.u_bpm)) gl.uniform1f(l, u.bpm);
    if ((l = locs.u_beatTime)) gl.uniform1f(l, u.beatTime);
    if ((l = locs.u_beatConfidence)) gl.uniform1f(l, u.confidence);
    if ((l = locs.u_beatTrust)) gl.uniform1f(l, u.trust);
    if ((l = locs.u_beatRaw)) { const r = u.raw; gl.uniform4f(l, r[0], r[1], r[2], r[3]); }
}

if (typeof window !== 'undefined') window.__patchtoyClock = clock;
