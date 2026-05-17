"use strict";

const CONFIG = window.BINJGB_LAUNCHER_CONFIG || {};
const SETTINGS = {
    title: CONFIG.title || "binjgb",
    subtitle: CONFIG.subtitle || "",
    rom: CONFIG.rom || "gameboy.gb",
    storagePrefix: CONFIG.storagePrefix || "binjgb",
    showTouchControls: CONFIG.showTouchControls !== false,
    showAdvancedControls: CONFIG.showAdvancedControls !== false,
    enableFastForward: CONFIG.enableFastForward !== false,
    enableRewind: CONFIG.enableRewind !== false,
    enablePause: CONFIG.enablePause !== false,
    enablePaletteSwitching: CONFIG.enablePaletteSwitching !== false,
    enableSaveState: CONFIG.enableSaveState !== false,
    enableLoadState: CONFIG.enableLoadState !== false,
    enableFullscreen: CONFIG.enableFullscreen !== false,
    enableReset: CONFIG.enableReset !== false,
    enableCurveChange: CONFIG.enableCurveChange === true,
    autoLoadState: CONFIG.autoLoadState !== false,
    cgbColorCurve: Number.isFinite(CONFIG.cgbColorCurve) ? CONFIG.cgbColorCurve : 2,
    defaultPaletteIdx: Number.isFinite(CONFIG.defaultPaletteIdx) ? CONFIG.defaultPaletteIdx : 79,
    palettes: Array.isArray(CONFIG.palettes) ? CONFIG.palettes.slice() : Array.from({ length: 84 }, (_, index) => index),
    rewindFramesPerBaseState: Number.isFinite(CONFIG.rewindFramesPerBaseState) ? CONFIG.rewindFramesPerBaseState : 45,
    rewindBufferCapacity: Number.isFinite(CONFIG.rewindBufferCapacity) ? CONFIG.rewindBufferCapacity : 4 * 1024 * 1024,
    rewindFactor: Number.isFinite(CONFIG.rewindFactor) ? CONFIG.rewindFactor : 1.5,
    rewindUpdateMs: Number.isFinite(CONFIG.rewindUpdateMs) ? CONFIG.rewindUpdateMs : 16,
    audioFrames: Number.isFinite(CONFIG.audioFrames) ? CONFIG.audioFrames : 4096,
    audioLatencySec: Number.isFinite(CONFIG.audioLatencySec) ? CONFIG.audioLatencySec : 0.1,
    maxUpdateSec: Number.isFinite(CONFIG.maxUpdateSec) ? CONFIG.maxUpdateSec : 5 / 60,
};

const RESULT_OK = 0;
const SCREEN_WIDTH = 160;
const SCREEN_HEIGHT = 144;
const CPU_TICKS_PER_SECOND = 4194304;
const EVENT_NEW_FRAME = 1;
const EVENT_AUDIO_BUFFER_FULL = 2;
const EVENT_UNTIL_TICKS = 4;

const $ = (selector) => document.querySelector(selector);
const canvas = $("#screen");
const bootMessageEl = $("#bootMessage");
const paletteSelect = $("#paletteSelect");
const curveSelect = $("#curveSelect");
const volumeSlider = $("#volumeSlider");
const rewindSlider = $("#rewindSlider");
const fpsLabel = $("#fpsLabel");
const ticksLabel = $("#ticksLabel");
const modeLabel = $("#modeLabel");
const paletteLabel = $("#paletteLabel");
const stateLabel = $("#stateLabel");
const subtitleLabel = $("#subtitleLabel");
const resetHint = $("#resetHint");

let app = null;

function storageKey(name) {
    return `${SETTINGS.storagePrefix}:${name}`;
}

function readStoredArray(name) {
    try {
        const value = localStorage.getItem(storageKey(name));
        if (!value) return null;
        const parsed = JSON.parse(value);
        return new Uint8Array(parsed);
    } catch (error) {
        return null;
    }
}

function writeStoredArray(name, buffer) {
    try {
        localStorage.setItem(storageKey(name), JSON.stringify(Array.from(buffer)));
    } catch (error) {
    }
}

function readStoredNumber(name, fallback) {
    try {
        const value = localStorage.getItem(storageKey(name));
        if (value === null) return fallback;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    } catch (error) {
        return fallback;
    }
}

function writeStoredNumber(name, value) {
    try {
        localStorage.setItem(storageKey(name), String(value));
    } catch (error) {
    }
}

function makeWasmBuffer(module, ptr, size) {
    return new Uint8Array(module.HEAP8.buffer, ptr, size);
}

class EmuAudio {
    constructor(module, e, state) {
        this.started = false;
        this.module = module;
        this.state = state;
        this.buffer = makeWasmBuffer(
            this.module, this.module._get_audio_buffer_ptr(e),
            this.module._get_audio_buffer_capacity(e));
        this.startSec = 0;
        this.resume();

        this.boundStartPlayback = this.startPlayback.bind(this);
        window.addEventListener("keydown", this.boundStartPlayback, true);
        window.addEventListener("click", this.boundStartPlayback, true);
        window.addEventListener("touchend", this.boundStartPlayback, true);
    }

    get sampleRate() {
        return EmuAudio.ctx.sampleRate;
    }

    startPlayback() {
        window.removeEventListener("touchend", this.boundStartPlayback, true);
        window.removeEventListener("keydown", this.boundStartPlayback, true);
        window.removeEventListener("click", this.boundStartPlayback, true);
        this.started = true;
        this.resume();
    }

    pushBuffer() {
        if (!this.started) return;
        const nowSec = EmuAudio.ctx.currentTime;
        const nowPlusLatency = nowSec + SETTINGS.audioLatencySec;
        const volume = this.state.volume;
        this.startSec = this.startSec || nowPlusLatency;

        if (this.startSec >= nowSec) {
            const buffer = EmuAudio.ctx.createBuffer(2, SETTINGS.audioFrames, this.sampleRate);
            const channel0 = buffer.getChannelData(0);
            const channel1 = buffer.getChannelData(1);
            for (let index = 0; index < SETTINGS.audioFrames; index++) {
                channel0[index] = this.buffer[2 * index] * volume / 255;
                channel1[index] = this.buffer[2 * index + 1] * volume / 255;
            }
            const bufferSource = EmuAudio.ctx.createBufferSource();
            bufferSource.buffer = buffer;
            bufferSource.connect(EmuAudio.ctx.destination);
            bufferSource.start(this.startSec);
            this.startSec += SETTINGS.audioFrames / this.sampleRate;
        } else {
            this.startSec = nowPlusLatency;
        }
    }

    pause() {
        if (!this.started) return;
        EmuAudio.ctx.suspend();
    }

    resume() {
        if (!this.started) return;
        EmuAudio.ctx.resume();
    }

    destroy() {
        if (this.boundStartPlayback) {
            window.removeEventListener("keydown", this.boundStartPlayback, true);
            window.removeEventListener("click", this.boundStartPlayback, true);
            window.removeEventListener("touchend", this.boundStartPlayback, true);
            this.boundStartPlayback = null;
        }
        this.buffer = null;
        this.started = false;
    }
}

EmuAudio.ctx = new (window.AudioContext || window.webkitAudioContext)();

class Canvas2DRenderer {
    constructor(el) {
        this.ctx = el.getContext("2d");
        this.imageData = this.ctx.createImageData(el.width, el.height);
    }

    uploadTexture(buffer) {
        this.imageData.data.set(buffer);
    }

    renderTexture() {
        this.ctx.putImageData(this.imageData, 0, 0);
    }
}

class WebGLRenderer {
    constructor(el) {
        const gl = el.getContext("webgl", { preserveDrawingBuffer: true });
        if (gl === null) {
            throw new Error("unable to create webgl context");
        }
        this.gl = gl;
        const w = SCREEN_WIDTH / 256;
        const h = SCREEN_HEIGHT / 256;
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 0, h,
            +1, -1, w, h,
            -1, +1, 0, 0,
            +1, +1, w, 0,
        ]), gl.STATIC_DRAW);

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

        const compileShader = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error(`compileShader failed: ${gl.getShaderInfoLog(shader)}`);
            }
            return shader;
        };

        const vertexShader = compileShader(gl.VERTEX_SHADER,
            `attribute vec2 aPos;
       attribute vec2 aTexCoord;
       varying highp vec2 vTexCoord;
       void main(void) {
         gl_Position = vec4(aPos, 0.0, 1.0);
         vTexCoord = aTexCoord;
       }`);
        const fragmentShader = compileShader(gl.FRAGMENT_SHADER,
            `varying highp vec2 vTexCoord;
       uniform sampler2D uSampler;
       void main(void) {
         gl_FragColor = texture2D(uSampler, vTexCoord);
       }`);

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
        }
        gl.useProgram(program);

        const aPos = gl.getAttribLocation(program, "aPos");
        const aTexCoord = gl.getAttribLocation(program, "aTexCoord");
        const uSampler = gl.getUniformLocation(program, "uSampler");
        gl.enableVertexAttribArray(aPos);
        gl.enableVertexAttribArray(aTexCoord);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, gl.FALSE, 16, 0);
        gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, gl.FALSE, 16, 8);
        gl.uniform1i(uSampler, 0);
    }

    uploadTexture(buffer) {
        this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT,
            this.gl.RGBA, this.gl.UNSIGNED_BYTE, buffer);
    }

    renderTexture() {
        this.gl.clearColor(0.5, 0.5, 0.5, 1.0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
    }
}

class Video {
    constructor(module, e, el) {
        this.module = module;
        if (window.navigator.userAgent.match(/iPhone|iPad/)) {
            this.renderer = new Canvas2DRenderer(el);
        } else {
            try {
                this.renderer = new WebGLRenderer(el);
            } catch (error) {
                this.renderer = new Canvas2DRenderer(el);
            }
        }
        this.buffer = makeWasmBuffer(
            this.module, this.module._get_frame_buffer_ptr(e),
            this.module._get_frame_buffer_size(e));
    }

    uploadTexture() {
        this.renderer.uploadTexture(this.buffer);
    }

    renderTexture() {
        this.renderer.renderTexture();
    }
}

class Rewind {
    constructor(module, e, settings) {
        this.module = module;
        this.e = e;
        this.settings = settings;
        this.joypadBufferPtr = this.module._joypad_new();
        this.statePtr = 0;
        this.bufferPtr = this.module._rewind_new_simple(
            e, settings.rewindFramesPerBaseState, settings.rewindBufferCapacity);
        this.module._emulator_set_default_joypad_callback(e, this.joypadBufferPtr);
    }

    destroy() {
        this.module._rewind_delete(this.bufferPtr);
        this.module._joypad_delete(this.joypadBufferPtr);
    }

    get oldestTicks() {
        return this.module._rewind_get_oldest_ticks_f64(this.bufferPtr);
    }

    get newestTicks() {
        return this.module._rewind_get_newest_ticks_f64(this.bufferPtr);
    }

    pushBuffer() {
        if (!this.isRewinding) {
            this.module._rewind_append(this.bufferPtr, this.e);
        }
    }

    get isRewinding() {
        return this.statePtr !== 0;
    }

    beginRewind() {
        if (this.isRewinding) return;
        this.statePtr = this.module._rewind_begin(this.e, this.bufferPtr, this.joypadBufferPtr);
    }

    rewindToTicks(ticks) {
        if (!this.isRewinding) return false;
        return this.module._rewind_to_ticks_wrapper(this.statePtr, ticks) === RESULT_OK;
    }

    endRewind() {
        if (!this.isRewinding) return;
        this.module._emulator_set_default_joypad_callback(this.e, this.joypadBufferPtr);
        this.module._rewind_end(this.statePtr);
        this.statePtr = 0;
    }
}

class Emulator {
    static start(module, romBuffer, extRamBuffer, settings, state) {
        Emulator.stop();
        app.emulator = new Emulator(module, romBuffer, extRamBuffer, settings, state);
        app.emulator.run();
    }

    static stop() {
        if (app.emulator) {
            app.emulator.destroy();
            app.emulator = null;
        }
    }

    constructor(module, romBuffer, extRamBuffer, settings, state) {
        this.module = module;
        this.settings = settings;
        this.state = state;
        this.romBuffer = romBuffer.slice(0);
        const size = (romBuffer.byteLength + 0x7fff) & ~0x7fff;
        this.romDataPtr = this.module._malloc(size);
        makeWasmBuffer(this.module, this.romDataPtr, size).fill(0).set(new Uint8Array(romBuffer));
        this.e = this.module._emulator_new_simple(
            this.romDataPtr, size, EmuAudio.ctx.sampleRate, settings.audioFrames,
            settings.cgbColorCurve);
        if (this.e === 0) {
            throw new Error("Invalid ROM.");
        }

        this.audio = new EmuAudio(module, this.e, state);
        this.video = new Video(module, this.e, canvas);
        this.rewind = new Rewind(module, this.e, settings);
        this.rewindIntervalId = 0;

        this.lastRafSec = 0;
        this.leftoverTicks = 0;
        this.fps = 60;
        this.fastForward = false;

        if (extRamBuffer && extRamBuffer.byteLength > 0) {
            this.loadExtRam(extRamBuffer);
        }

        this.bindKeys();
        this.bindTouch();
        this.touchEnabled = settings.showTouchControls && "ontouchstart" in document.documentElement;
        this.updateOnscreenGamepad();
    }

    destroy() {
        this.unbindTouch();
        this.unbindKeys();
        this.cancelAnimationFrame();
        clearInterval(this.rewindIntervalId);
        this.rewind.destroy();
        this.audio.destroy();
        this.module._emulator_delete(this.e);
        this.module._free(this.romDataPtr);
    }

    withNewFileData(fileDataPtr, cb) {
        const buffer = makeWasmBuffer(
            this.module, this.module._get_file_data_ptr(fileDataPtr),
            this.module._get_file_data_size(fileDataPtr));
        const result = cb(fileDataPtr, buffer);
        this.module._file_data_delete(fileDataPtr);
        return result;
    }

    withNewExtRamFileData(cb) {
        return this.withNewFileData(this.module._ext_ram_file_data_new(this.e), cb);
    }

    withNewStateFileData(cb) {
        return this.withNewFileData(this.module._state_file_data_new(this.e), cb);
    }

    loadExtRam(extRamBuffer) {
        this.withNewExtRamFileData((fileDataPtr, buffer) => {
            if (buffer.byteLength === extRamBuffer.byteLength) {
                buffer.set(new Uint8Array(extRamBuffer));
                this.module._emulator_read_ext_ram(this.e, fileDataPtr);
            }
        });
    }

    getExtRam() {
        return this.withNewExtRamFileData((fileDataPtr, buffer) => {
            this.module._emulator_write_ext_ram(this.e, fileDataPtr);
            return new Uint8Array(buffer);
        });
    }

    loadState(stateBuffer) {
        if (!stateBuffer) return;
        this.withNewStateFileData((fileDataPtr, buffer) => {
            if (buffer.byteLength === stateBuffer.byteLength) {
                buffer.set(new Uint8Array(stateBuffer));
                this.module._emulator_read_state(this.e, fileDataPtr);
            }
        });
    }

    getSaveState() {
        return this.withNewStateFileData((fileDataPtr, buffer) => {
            this.module._emulator_write_state(this.e, fileDataPtr);
            return new Uint8Array(buffer);
        });
    }

    get isPaused() {
        return this.rafCancelToken === null;
    }

    pause() {
        if (!this.isPaused) {
            this.cancelAnimationFrame();
            this.audio.pause();
            this.beginRewind();
        }
    }

    resume() {
        if (this.isPaused) {
            this.endRewind();
            this.requestAnimationFrame();
            this.audio.resume();
        }
    }

    setBuiltinPalette(palIdx) {
        this.module._emulator_set_builtin_palette(this.e, this.settings.palettes[palIdx]);
    }

    get isRewinding() {
        return this.settings.enableRewind && this.rewind.isRewinding;
    }

    beginRewind() {
        if (!this.settings.enableRewind) return;
        this.rewind.beginRewind();
    }

    rewindToTicks(ticks) {
        if (!this.settings.enableRewind) return;
        if (this.rewind.rewindToTicks(ticks)) {
            this.runUntil(ticks);
            this.video.renderTexture();
        }
    }

    endRewind() {
        if (!this.settings.enableRewind) return;
        this.rewind.endRewind();
        this.lastRafSec = 0;
        this.leftoverTicks = 0;
        this.audio.startSec = 0;
    }

    set autoRewind(enabled) {
        if (!this.settings.enableRewind) return;
        if (enabled) {
            this.rewindIntervalId = setInterval(() => {
                const oldest = this.rewind.oldestTicks;
                const start = this.ticks;
                const delta = this.settings.rewindFactor * this.settings.rewindUpdateMs / 1000 * CPU_TICKS_PER_SECOND;
                const rewindTo = Math.max(oldest, start - delta);
                this.rewindToTicks(rewindTo);
                app.state.ticks = this.ticks;
            }, this.settings.rewindUpdateMs);
        } else {
            clearInterval(this.rewindIntervalId);
            this.rewindIntervalId = 0;
        }
    }

    requestAnimationFrame() {
        this.rafCancelToken = requestAnimationFrame(this.rafCallback.bind(this));
    }

    cancelAnimationFrame() {
        cancelAnimationFrame(this.rafCancelToken);
        this.rafCancelToken = null;
    }

    run() {
        this.requestAnimationFrame();
    }

    get ticks() {
        return this.module._emulator_get_ticks_f64(this.e);
    }

    runUntil(untilTicks) {
        while (true) {
            const event = this.module._emulator_run_until_f64(this.e, untilTicks);
            if (event & EVENT_NEW_FRAME) {
                this.rewind.pushBuffer();
                this.video.uploadTexture();
            }
            if ((event & EVENT_AUDIO_BUFFER_FULL) && !this.isRewinding) {
                this.audio.pushBuffer();
            }
            if (event & EVENT_UNTIL_TICKS) {
                break;
            }
        }
        if (this.module._emulator_was_ext_ram_updated(this.e)) {
            app.state.extRamUpdated = true;
        }
    }

    rafCallback(startMs) {
        this.requestAnimationFrame();
        let deltaSec = 0;
        if (!this.isRewinding) {
            const startSec = startMs / 1000;
            deltaSec = Math.max(startSec - (this.lastRafSec || startSec), 0);

            const startTimeMs = performance.now();
            const deltaTicks = Math.min(deltaSec, this.settings.maxUpdateSec) * CPU_TICKS_PER_SECOND;
            let runUntilTicks = this.ticks + deltaTicks - this.leftoverTicks;
            this.runUntil(runUntilTicks);
            const deltaTimeMs = performance.now() - startTimeMs;
            const deltaTimeSec = deltaTimeMs / 1000;

            if (this.fastForward) {
                const speedUp = (deltaTicks / CPU_TICKS_PER_SECOND) / Math.max(deltaTimeSec, 0.0001);
                const extraFrames = Math.floor(speedUp - deltaTimeSec);
                const extraTicks = extraFrames * deltaTicks;
                runUntilTicks = this.ticks + extraTicks - this.leftoverTicks;
                this.runUntil(runUntilTicks);
            }

            this.leftoverTicks = (this.ticks - runUntilTicks) | 0;
            this.lastRafSec = startSec;
        }

        const lerp = (from, to, alpha) => (alpha * from) + ((1 - alpha) * to);
        this.fps = lerp(this.fps, Math.min(1 / Math.max(deltaSec, 0.0001), 10000), 0.3);
        this.video.renderTexture();
    }

    updateOnscreenGamepad() {
        const controller = $("#controller");
        if (controller) {
            controller.style.display = this.touchEnabled ? "block" : "none";
        }
    }

    bindTouch() {
        if (!this.settings.showTouchControls) return;
        const controller = $("#controller");
        if (!controller) return;
        const dpadEl = $("#controller_dpad");
        const selectEl = $("#controller_select");
        const startEl = $("#controller_start");
        const bEl = $("#controller_b");
        const aEl = $("#controller_a");

        this.touchFuncs = {
            controller_b: this.setJoypB.bind(this),
            controller_a: this.setJoypA.bind(this),
            controller_start: this.setJoypStart.bind(this),
            controller_select: this.setJoypSelect.bind(this),
        };

        this.boundButtonTouchStart = this.buttonTouchStart.bind(this);
        this.boundButtonTouchEnd = this.buttonTouchEnd.bind(this);
        [selectEl, startEl, bEl, aEl].forEach((el) => {
            if (!el) return;
            el.addEventListener("touchstart", this.boundButtonTouchStart);
            el.addEventListener("touchend", this.boundButtonTouchEnd);
        });

        this.boundDpadTouchStartMove = this.dpadTouchStartMove.bind(this);
        this.boundDpadTouchEnd = this.dpadTouchEnd.bind(this);
        if (dpadEl) {
            dpadEl.addEventListener("touchstart", this.boundDpadTouchStartMove);
            dpadEl.addEventListener("touchmove", this.boundDpadTouchStartMove);
            dpadEl.addEventListener("touchend", this.boundDpadTouchEnd);
        }

        this.boundTouchRestore = this.touchRestore.bind(this);
        window.addEventListener("touchstart", this.boundTouchRestore);
    }

    unbindTouch() {
        const dpadEl = $("#controller_dpad");
        const selectEl = $("#controller_select");
        const startEl = $("#controller_start");
        const bEl = $("#controller_b");
        const aEl = $("#controller_a");

        [selectEl, startEl, bEl, aEl].forEach((el) => {
            if (!el || !this.boundButtonTouchStart) return;
            el.removeEventListener("touchstart", this.boundButtonTouchStart);
            el.removeEventListener("touchend", this.boundButtonTouchEnd);
        });

        if (dpadEl && this.boundDpadTouchStartMove) {
            dpadEl.removeEventListener("touchstart", this.boundDpadTouchStartMove);
            dpadEl.removeEventListener("touchmove", this.boundDpadTouchStartMove);
            dpadEl.removeEventListener("touchend", this.boundDpadTouchEnd);
        }

        if (this.boundTouchRestore) {
            window.removeEventListener("touchstart", this.boundTouchRestore);
        }
    }

    buttonTouchStart(event) {
        if (event.currentTarget.id in this.touchFuncs) {
            this.touchFuncs[event.currentTarget.id](true);
            event.currentTarget.classList.add("btnPressed");
            event.preventDefault();
        }
    }

    buttonTouchEnd(event) {
        if (event.currentTarget.id in this.touchFuncs) {
            this.touchFuncs[event.currentTarget.id](false);
            event.currentTarget.classList.remove("btnPressed");
            event.preventDefault();
        }
    }

    dpadTouchStartMove(event) {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = (2 * (event.targetTouches[0].clientX - rect.left)) / rect.width - 1;
        const y = (2 * (event.targetTouches[0].clientY - rect.top)) / rect.height - 1;
        const deadzone = 0.1;

        if (Math.abs(x) > deadzone) {
            if (y > x && y < -x) {
                this.setJoypLeft(true);
                this.setJoypRight(false);
            } else if (y < x && y > -x) {
                this.setJoypLeft(false);
                this.setJoypRight(true);
            }
        } else {
            this.setJoypLeft(false);
            this.setJoypRight(false);
        }

        if (Math.abs(y) > deadzone) {
            if (x > y && x < -y) {
                this.setJoypUp(true);
                this.setJoypDown(false);
            } else if (x < y && x > -y) {
                this.setJoypUp(false);
                this.setJoypDown(true);
            }
        } else {
            this.setJoypUp(false);
            this.setJoypDown(false);
        }

        event.preventDefault();
    }

    dpadTouchEnd(event) {
        this.setJoypLeft(false);
        this.setJoypRight(false);
        this.setJoypUp(false);
        this.setJoypDown(false);
        event.preventDefault();
    }

    touchRestore() {
        if (!this.settings.showTouchControls) return;
        this.touchEnabled = true;
        this.updateOnscreenGamepad();
    }

    bindKeys() {
        this.keyFuncs = {
            ArrowDown: this.setJoypDown.bind(this),
            ArrowLeft: this.setJoypLeft.bind(this),
            ArrowRight: this.setJoypRight.bind(this),
            ArrowUp: this.setJoypUp.bind(this),
            KeyZ: this.setJoypB.bind(this),
            KeyX: this.setJoypA.bind(this),
            Enter: this.setJoypStart.bind(this),
            Tab: this.setJoypSelect.bind(this),
        };

        if (this.settings.enableRewind) {
            this.keyFuncs.Backspace = this.keyRewind.bind(this);
        }
        if (this.settings.enablePause) {
            this.keyFuncs.Space = this.keyPause.bind(this);
        }
        if (this.settings.enablePaletteSwitching) {
            this.keyFuncs.BracketLeft = this.keyPrevPalette.bind(this);
            this.keyFuncs.BracketRight = this.keyNextPalette.bind(this);
        }
        if (this.settings.enableFastForward) {
            this.keyFuncs.ShiftLeft = this.setFastForward.bind(this);
        }
        if (this.settings.enableSaveState) {
            this.keyFuncs.F6 = this.keySaveState.bind(this);
        }
        if (this.settings.enableLoadState) {
            this.keyFuncs.F9 = this.keyLoadState.bind(this);
        }

        this.boundKeyDown = this.keyDown.bind(this);
        this.boundKeyUp = this.keyUp.bind(this);
        window.addEventListener("keydown", this.boundKeyDown);
        window.addEventListener("keyup", this.boundKeyUp);
    }

    unbindKeys() {
        window.removeEventListener("keydown", this.boundKeyDown);
        window.removeEventListener("keyup", this.boundKeyUp);
    }

    keyDown(event) {
        if (event.code in this.keyFuncs) {
            if (this.touchEnabled) {
                this.touchEnabled = false;
                this.updateOnscreenGamepad();
            }
            this.keyFuncs[event.code](true);
            event.preventDefault();
        }
    }

    keyUp(event) {
        if (event.code in this.keyFuncs) {
            this.keyFuncs[event.code](false);
            event.preventDefault();
        }
    }

    keyRewind(isKeyDown) {
        if (!this.settings.enableRewind) return;
        if (this.isRewinding !== isKeyDown) {
            if (isKeyDown) {
                app.setPaused(true);
                this.autoRewind = true;
            } else {
                this.autoRewind = false;
                app.setPaused(false);
            }
        }
    }

    keyPause(isKeyDown) {
        if (!this.settings.enablePause) return;
        if (isKeyDown) app.togglePause();
    }

    keyPrevPalette(isKeyDown) {
        if (!this.settings.enablePaletteSwitching) return;
        if (isKeyDown) {
            app.setPalette((app.state.palIdx + this.settings.palettes.length - 1) % this.settings.palettes.length);
        }
    }

    keyNextPalette(isKeyDown) {
        if (!this.settings.enablePaletteSwitching) return;
        if (isKeyDown) {
            app.setPalette((app.state.palIdx + 1) % this.settings.palettes.length);
        }
    }

    setFastForward(isKeyDown) {
        if (!this.settings.enableFastForward) return;
        this.fastForward = isKeyDown;
    }

    keySaveState(isKeyDown) {
        if (!this.settings.enableSaveState) return;
        if (isKeyDown) app.saveState();
    }

    keyLoadState(isKeyDown) {
        if (!this.settings.enableLoadState) return;
        if (isKeyDown) app.loadState();
    }

    setJoypDown(set) { this.module._set_joyp_down(this.e, set); }
    setJoypUp(set) { this.module._set_joyp_up(this.e, set); }
    setJoypLeft(set) { this.module._set_joyp_left(this.e, set); }
    setJoypRight(set) { this.module._set_joyp_right(this.e, set); }
    setJoypSelect(set) { this.module._set_joyp_select(this.e, set); }
    setJoypStart(set) { this.module._set_joyp_start(this.e, set); }
    setJoypB(set) { this.module._set_joyp_B(this.e, set); }
    setJoypA(set) { this.module._set_joyp_A(this.e, set); }
}

class LauncherApp {
    constructor(settings) {
        this.settings = settings;
        this.state = {
            fps: 60,
            ticks: 0,
            paused: false,
            palIdx: readStoredNumber("paletteIdx", settings.defaultPaletteIdx),
            volume: readStoredNumber("volume", 0.5),
            extRamUpdated: false,
            stateLoaded: false,
            message: "",
            rewindMin: 0,
            rewindMax: 0,
        };
        this.emulator = null;
        this.romBuffer = null;
        this.bindUi();
    }

    async start() {
        try {
            this.setMessage(`Loading ${this.settings.rom}...`);
            this.romBuffer = await (await fetch(this.settings.rom)).arrayBuffer();
            await this.startEmulator();
            this.setMessage("");
        } catch (error) {
            this.setMessage(`Failed to load ${this.settings.rom}: ${error.message}`);
            throw error;
        }
    }

    setMessage(message) {
        this.state.message = message;
        if (bootMessageEl) {
            bootMessageEl.textContent = message || "";
            bootMessageEl.classList.toggle("is-visible", Boolean(message));
        }
    }

    bindUi() {
        if (subtitleLabel) subtitleLabel.textContent = this.settings.subtitle || "";
        if (resetHint) resetHint.textContent = this.settings.rom;

        this.applyFeatureVisibility();

        document.querySelectorAll("[data-action]").forEach((button) => {
            const action = button.dataset.action;
            if (!this.isActionEnabled(action)) {
                button.disabled = true;
                button.hidden = true;
                return;
            }
            if (this.isHoldAction(action)) {
                button.addEventListener("pointerdown", (event) => this.handleHoldAction(action, true, event));
                button.addEventListener("pointerup", (event) => this.handleHoldAction(action, false, event));
                button.addEventListener("pointerleave", (event) => this.handleHoldAction(action, false, event));
                button.addEventListener("pointercancel", (event) => this.handleHoldAction(action, false, event));
            } else {
                button.addEventListener("click", () => this.handleAction(action));
            }
        });

        if (paletteSelect) {
            paletteSelect.innerHTML = this.settings.palettes.map((value, index) =>
                `<option value="${index}">${String(value).padStart(2, "0")}</option>`).join("");
            paletteSelect.value = String(this.state.palIdx);
            paletteSelect.addEventListener("change", () => this.setPalette(Number(paletteSelect.value)));
        }

        if (curveSelect) {
            curveSelect.value = String(this.settings.cgbColorCurve);
            curveSelect.addEventListener("change", () => this.changeCurve(Number(curveSelect.value)));
            curveSelect.disabled = !this.settings.enableCurveChange;
        }

        if (volumeSlider) {
            volumeSlider.value = String(this.state.volume);
            volumeSlider.addEventListener("input", () => {
                this.state.volume = Number(volumeSlider.value);
                writeStoredNumber("volume", this.state.volume);
            });
        }

        if (rewindSlider) {
            rewindSlider.addEventListener("input", () => {
                if (this.emulator && this.settings.enableRewind) {
                    this.emulator.rewindToTicks(Number(rewindSlider.value));
                    this.state.ticks = this.emulator.ticks;
                    this.refreshUi();
                }
            });
        }

        setInterval(() => {
            if (this.emulator) {
                this.state.fps = this.emulator.fps;
                this.state.ticks = this.emulator.ticks;
                if (this.state.extRamUpdated) {
                    this.saveExtRam();
                    this.state.extRamUpdated = false;
                }
                this.refreshUi();
            }
        }, 250);
    }

    applyFeatureVisibility() {
        document.querySelectorAll("[data-feature]").forEach((el) => {
            const feature = el.dataset.feature;
            const enabled = this.isFeatureEnabled(feature);
            el.hidden = !enabled;
        });
        document.body.classList.toggle("allow-touch", this.settings.showTouchControls);
        document.body.classList.toggle("show-advanced", this.settings.showAdvancedControls);
    }

    isFeatureEnabled(feature) {
        switch (feature) {
            case "touch": return this.settings.showTouchControls;
            case "advanced": return this.settings.showAdvancedControls;
            case "rewind": return this.settings.enableRewind;
            case "pause": return this.settings.enablePause;
            case "ff": return this.settings.enableFastForward;
            case "palette": return this.settings.enablePaletteSwitching;
            case "state": return this.settings.enableSaveState || this.settings.enableLoadState;
            case "curve": return this.settings.enableCurveChange;
            case "reset": return this.settings.enableReset;
            case "fullscreen": return this.settings.enableFullscreen;
            default: return true;
        }
    }

    isActionEnabled(action) {
        switch (action) {
            case "pause": return this.settings.enablePause;
            case "ff": return this.settings.enableFastForward;
            case "rewind": return this.settings.enableRewind;
            case "palette-prev":
            case "palette-next": return this.settings.enablePaletteSwitching;
            case "save-state": return this.settings.enableSaveState;
            case "load-state": return this.settings.enableLoadState;
            case "fullscreen": return this.settings.enableFullscreen;
            case "reset": return this.settings.enableReset;
            case "curve-change": return this.settings.enableCurveChange;
            default: return true;
        }
    }

    isHoldAction(action) {
        return action === "rewind" || action === "ff";
    }

    handleHoldAction(action, isDown, event) {
        event.preventDefault();
        if (action === "rewind") this.emulator?.keyRewind(isDown);
        if (action === "ff") this.emulator?.setFastForward(isDown);
    }

    handleAction(action) {
        switch (action) {
            case "pause": this.togglePause(); break;
            case "palette-prev": this.setPalette(this.state.palIdx - 1); break;
            case "palette-next": this.setPalette(this.state.palIdx + 1); break;
            case "save-state": this.saveState(); break;
            case "load-state": this.loadState(); break;
            case "fullscreen": this.toggleFullscreen(); break;
            case "reset": this.restart(); break;
            case "curve-change": this.changeCurve(Number(curveSelect?.value || this.settings.cgbColorCurve)); break;
            default: break;
        }
    }

    async startEmulator() {
        const extRamBuffer = readStoredArray("extram")?.buffer || null;
        Emulator.start(await Binjgb(), this.romBuffer, extRamBuffer, this.settings, this.state);
        this.emulator = app.emulator;
        this.state.paused = false;
        this.emulator.setBuiltinPalette(this.state.palIdx);
        if (this.settings.autoLoadState) {
            this.loadState();
        }
        this.refreshUi();
    }

    async restart() {
        if (!this.romBuffer) return;
        const keepCurve = this.settings.cgbColorCurve;
        Emulator.stop();
        this.settings.cgbColorCurve = keepCurve;
        await this.startEmulator();
    }

    changeCurve(curve) {
        if (this.settings.cgbColorCurve === curve) return;
        this.settings.cgbColorCurve = curve;
        writeStoredNumber("cgbColorCurve", curve);
        this.restart();
    }

    togglePause() {
        if (!this.emulator) return;
        this.state.paused = !this.state.paused;
        if (this.state.paused) {
            this.emulator.pause();
        } else {
            this.emulator.resume();
        }
        this.refreshUi();
    }

    setPaused(paused) {
        if (!this.emulator) return;
        this.state.paused = paused;
        if (paused) {
            this.emulator.pause();
        } else {
            this.emulator.resume();
        }
        this.refreshUi();
    }

    setPalette(index) {
        if (!this.emulator || !this.settings.enablePaletteSwitching) return;
        const count = this.settings.palettes.length;
        const next = ((index % count) + count) % count;
        this.state.palIdx = next;
        writeStoredNumber("paletteIdx", next);
        this.emulator.setBuiltinPalette(next);
        this.refreshUi();
    }

    saveExtRam() {
        if (!this.emulator) return;
        writeStoredArray("extram", this.emulator.getExtRam());
    }

    saveState() {
        if (!this.emulator || !this.settings.enableSaveState) return;
        writeStoredArray("saveState", this.emulator.getSaveState());
        this.state.stateLoaded = true;
        this.refreshUi();
    }

    loadState() {
        if (!this.emulator || !this.settings.enableLoadState) return;
        const buffer = readStoredArray("saveState");
        if (!buffer) return;
        this.emulator.loadState(buffer.buffer);
        this.state.stateLoaded = true;
        this.refreshUi();
    }

    toggleFullscreen() {
        if (!this.settings.enableFullscreen) return;
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            canvas?.requestFullscreen();
        }
    }

    refreshUi() {
        if (fpsLabel) fpsLabel.textContent = this.state.fps.toFixed(1);
        if (ticksLabel) ticksLabel.textContent = Math.floor(this.state.ticks).toLocaleString();
        if (modeLabel) modeLabel.textContent = this.state.paused ? "paused" : (this.emulator?.fastForward ? "fast-forward" : "running");
        if (paletteLabel) paletteLabel.textContent = `${this.state.palIdx}`;
        if (stateLabel) stateLabel.textContent = this.state.stateLoaded ? "state ready" : "live";
        if (paletteSelect) paletteSelect.value = String(this.state.palIdx);
        if (rewindSlider && this.emulator) {
            rewindSlider.min = String(this.emulator.rewind.oldestTicks | 0);
            rewindSlider.max = String(this.emulator.rewind.newestTicks | 0);
            rewindSlider.value = String(this.emulator.ticks | 0);
        }
        if (curveSelect) curveSelect.value = String(this.settings.cgbColorCurve);
    }
}

app = new LauncherApp(SETTINGS);
window.addEventListener("DOMContentLoaded", () => app.start());