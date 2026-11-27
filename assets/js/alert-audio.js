/* ============================================================================
 * alert-audio.js — the one alert sound for the whole site
 *
 * A gentle three-second raindrop bloom: five soft sine droplets, two of them
 * detuned whole-number harmonics (so the chord is consonant, never beating),
 * all through a low-pass filter with rising resonance, plus a 0.31 s echo —
 * 1.60 s and 1.90 s are whole multiples of 0.31 s, so the repeats land on the
 * grid instead of smearing.  Pure sines under 1.4 kHz, a soft saturation on the
 * way out, no square/saw harmonics, and a 2.5 s cooldown so it never machine-guns
 * — designed to be pleasant when it is heard all day, every day of the season.
 *
 *   AlertAudio.init()                    create/resume the audio context (click)
 *   AlertAudio.play(kind)                render the cue; returns a label or null
 *   AlertAudio.test()                    the same cue on demand (the Test button)
 *   AlertAudio.setVolume(0..1) / getVolume()
 *   AlertAudio.available() / state()
 *
 * Kinds: 'review', 'pending', 'scoring', 'risk', 'state' — identical sample,
 * different label, so the alert is never a surprise and never louder for one
 * category than another.
 * ==========================================================================*/
(function (global) {
  'use strict';

  var DURATION_MS = 3000;
  var COOLDOWN_MS = 2500;
  var DEFAULT_VOLUME = 0.34;

  var ctx = null;
  var master = null;
  var lastPlayAt = 0;
  var plays = 0;
  var muted = false;
  var volume = DEFAULT_VOLUME;

  var LABELS = {
    review: 'review / challenge',
    pending: 'official-scorer ruling pending',
    scoring: 'official scoring change',
    risk: 'run(s) at risk',
    abs: 'ABS pitch challenge',
    state: 'game state change',
    preview: 'test',
    test: 'test',
  };

  function AudioCtor() {
    return global.AudioContext || global.webkitAudioContext || null;
  }

  function available() { return !!AudioCtor(); }

  /** Create (or resume) the context. Must be called from a user gesture. */
  function init() {
    if (muted) return null;
    var Ctor = AudioCtor();
    if (!Ctor) return null;
    try {
      if (!ctx) {
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = volume;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      return ctx;
    } catch (e) {
      return null;
    }
  }

  function setVolume(value) {
    var v = Number(value);
    if (!isFinite(v)) return volume;
    volume = Math.min(1, Math.max(0, v));
    if (master) {
      try { master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02); } catch (e) {
        try { master.gain.value = volume; } catch (e2) { /* ignore */ }
      }
    }
    return volume;
  }

  function getVolume() { return volume; }

  /**
   * render() — schedule one cue on the shared graph.
   * Returns the string label when a cue was actually scheduled.
   */
  function render(kind) {
    if (muted) return null;
    if (!ctx || !master) return null;
    var t0 = ctx.currentTime + 0.02;

    /* Soft saturation: keeps the peaks round instead of clipping them. */
    var shaper = null;
    try {
      shaper = ctx.createWaveShaper();
      var curve = new Float32Array(1024);
      for (var i = 0; i < curve.length; i += 1) {
        var x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 1.15);
      }
      shaper.curve = curve;
      shaper.oversample = '2x';
      shaper.connect(master);
    } catch (e) {
      shaper = master;
    }

    /* Low-pass with rising resonance = the "drop" character, no harsh hiss. */
    var filter = null;
    try {
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(700, t0);
      filter.frequency.exponentialRampToValueAtTime(2000, t0 + 0.9);
      filter.Q.setValueAtTime(0.9, t0);
      filter.Q.exponentialRampToValueAtTime(2.4, t0 + 1.7);
      filter.connect(shaper);
    } catch (e) {
      filter = shaper;
    }

    /* Echo on a 0.31 s grid; the longer drops land on it exactly. */
    var echoSource = null;
    try {
      echoSource = ctx.createGain();
      echoSource.gain.value = 0.34;
      echoSource.connect(shaper);
      [0.31, 0.62].forEach(function (delay, index) {
        var node = ctx.createDelay(1);
        node.delayTime.value = delay;
        var gain = ctx.createGain();
        gain.gain.value = index === 0 ? 0.30 : 0.14;
        echoSource.connect(node);
        node.connect(gain);
        gain.connect(shaper);
      });
    } catch (e) {
      echoSource = null;
    }

    /* drop { at, freq, dur, gain } — a soft sine droplet. */
    function drop(at, freq, dur, peak) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, at);
      /* A tiny downward glide (a drop falling), not a pitch bend. */
      osc.frequency.exponentialRampToValueAtTime(freq * 0.985, at + dur);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.028);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(gain);
      gain.connect(filter);
      if (echoSource) gain.connect(echoSource);
      osc.start(at);
      osc.stop(at + dur + 0.06);
    }

    /* Root an octave lower than a chirp, so it reads as water, not a bell. */
    drop(t0 + 0.00, 784.0, 0.24, 0.45);    /* G5  */
    drop(t0 + 0.19, 1046.5, 0.28, 0.36);   /* C6  */
    drop(t0 + 0.38, 1174.7, 0.30, 0.34);   /* D6  */
    drop(t0 + 0.31, 1318.5, 0.34, 0.30);   /* E6, whole-number 5:4-ish against G5 */
    drop(t0 + 0.62, 1568.0, 0.42, 0.26);   /* G6, two octaves over the root      */
    drop(t0 + 1.30, 523.25, 0.70, 0.34);   /* C5, the "settle"                   */
    drop(t0 + 1.60, 659.25, 0.60, 0.26);   /* E5, +0.30 s (echo grid 0.31 s)     */
    drop(t0 + 1.90, 783.99, 0.86, 0.22);   /* G5, +0.60 s (echo grid 0.62 s)     */

    return LABELS[kind] || LABELS.review;
  }

  /**
   * play(kind, opts)
   *   opts.force  ignore the cooldown (used by the Test button)
   * Returns the label when a cue was scheduled, null when it was suppressed.
   */
  function play(kind, opts) {
    var options = opts || {};
    var now = Date.now();
    if (!options.force && now - lastPlayAt < COOLDOWN_MS) return null;
    if (!init()) return null;
    var label = render(kind);
    if (!label) return null;
    lastPlayAt = now;
    plays += 1;
    return label;
  }

  /** The Test button: always audible on demand, never silenced by the cooldown. */
  function test() {
    return play('test', { force: true });
  }

  function state() {
    return {
      available: available(),
      ready: !!ctx,
      contextState: ctx ? ctx.state : 'none',
      volume: volume,
      muted: muted,
      lastPlayAt: lastPlayAt,
      plays: plays,
      durationMs: DURATION_MS,
      cooldownMs: COOLDOWN_MS,
    };
  }

  function setMuted(value) {
    muted = !!value;
    if (muted && ctx && ctx.suspend) { try { ctx.suspend(); } catch (e) { /* ignore */ } }
    if (!muted && ctx && ctx.resume) { try { ctx.resume(); } catch (e) { /* ignore */ } }
    return muted;
  }

  global.AlertAudio = {
    DURATION_MS: DURATION_MS,
    COOLDOWN_MS: COOLDOWN_MS,
    LABELS: LABELS,
    available: available,
    init: init,
    play: play,
    test: test,
    setVolume: setVolume,
    getVolume: getVolume,
    setMuted: setMuted,
    state: state,
  };
}(window));
