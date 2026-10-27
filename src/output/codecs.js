/**
 * Codec / container selection for the real-time recorder (MediaRecorder) and the
 * offline exporter (WebCodecs VideoEncoder).
 */

export const RESOLUTIONS = [
    { id: 'preview', label: 'Preview size' },
    { id: '720p', label: '720p', w: 1280, h: 720 },
    { id: '1080p', label: '1080p', w: 1920, h: 1080 },
    { id: '1440p', label: '1440p', w: 2560, h: 1440 },
    { id: '4k', label: '4K UHD', w: 3840, h: 2160 },
    { id: 'square', label: 'Square 1080', w: 1080, h: 1080 },
    { id: 'vertical', label: 'Vertical 1080×1920', w: 1080, h: 1920 },
    { id: 'custom', label: 'Custom…' }
];

export const FPS_OPTIONS = [24, 25, 30, 50, 60];

/** Encoders want even sizes (H.264 4:2:0); keep it sane for GPU targets too. */
export function evenSize(w, h) {
    const e = (v) => Math.max(16, Math.min(8192, 2 * Math.round((Number(v) || 0) / 2)));
    return [e(w), e(h)];
}

/** Default bitrate: ~0.15 bits per pixel per frame (real-time), 0.25 offline. */
export function autoBitrate(w, h, fps, offline = false) {
    const bpp = offline ? 0.25 : 0.15;
    return Math.round(Math.min(200e6, Math.max(1e6, w * h * fps * bpp)));
}

const MR_TYPES = {
    webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
    mp4: ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4']
};
const MR_AUDIO = {
    'video/webm;codecs=vp9': 'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8': 'video/webm;codecs=vp8,opus',
    'video/mp4;codecs=avc1.640028': 'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1': 'video/mp4;codecs=avc1,mp4a.40.2'
};

/** MediaRecorder MIME type for 'webm' | 'mp4' | 'auto' (null = unsupported). */
export function pickRecorderType(format = 'auto', withAudio = false) {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
    const order = format === 'mp4' ? ['mp4'] : format === 'webm' ? ['webm'] : ['webm', 'mp4'];
    for (const f of order) {
        for (const t of MR_TYPES[f]) {
            if (!MediaRecorder.isTypeSupported(t)) continue;
            const ta = withAudio && MR_AUDIO[t];
            if (ta && MediaRecorder.isTypeSupported(ta)) return { mime: ta, ext: f, format: f };
            return { mime: t, ext: f, format: f };
        }
    }
    return null;
}

export function recorderFormats() {
    return { webm: !!pickRecorderType('webm'), mp4: !!pickRecorderType('mp4') };
}

function avcLevel(w, h, fps) {
    const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
    const rate = mbs * fps;
    const levels = [[0x1F, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2A, 8704, 522240],
        [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600], [0x3C, 139264, 4177920]];
    for (const [lvl, maxFs, maxRate] of levels) if (mbs <= maxFs && rate <= maxRate) return lvl;
    return 0x3C;
}

/**
 * WebCodecs config for 'mp4' (H.264) or 'webm' (VP9, then VP8). Resolves
 * { config, container } or null when the browser can't encode it.
 */
export async function pickEncoderConfig(format, { width, height, fps, bitrate }) {
    if (typeof VideoEncoder === 'undefined') return null;
    const base = { width, height, bitrate, framerate: fps, latencyMode: 'quality', bitrateMode: 'variable' };
    const candidates = [];
    if (format === 'mp4') {
        const lvl = avcLevel(width, height, fps).toString(16).padStart(2, '0').toUpperCase();
        for (const profile of ['6400', '4D00', '4200']) {
            candidates.push({ ...base, codec: `avc1.${profile}${lvl}`, avc: { format: 'avc' } });
        }
    } else {
        const lvl = width * height > 2228224 ? '51' : width * height > 983040 ? '41' : '31';
        candidates.push({ ...base, codec: `vp09.00.${lvl}.08` }, { ...base, codec: 'vp8' });
    }
    for (const config of candidates) {
        for (const accel of ['prefer-hardware', 'no-preference']) {
            const cfg = { ...config, hardwareAcceleration: accel };
            try {
                const res = await VideoEncoder.isConfigSupported(cfg);
                if (res && res.supported) return { config: cfg, container: format };
            } catch (e) { /* try the next one */ }
        }
    }
    return null;
}

export async function offlineFormats() {
    const probe = { width: 1280, height: 720, fps: 30, bitrate: 8e6 };
    const [mp4, webm] = await Promise.all([pickEncoderConfig('mp4', probe), pickEncoderConfig('webm', probe)]);
    return {
        mp4: !!mp4,
        webm: !!webm,
        png: true,
        folder: typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
    };
}
