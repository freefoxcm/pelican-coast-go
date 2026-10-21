// ============================================================================
//  src/audio.js — 鹈鹕海岸 · 追鱼 / 实时合成音频引擎        (owner: audio-engine)
// ----------------------------------------------------------------------------
//  * 零音频文件 / 零外部资源：音乐、环境声、音效全部由 Web Audio 实时合成。
//  * 音乐：Am–F–C–G，16 小节循环；kick(四四) / snare(2、4 拍) / hihat(8 分)
//    / bass(16 分琶音, lowpass+包络) / pad(慢 attack/release) / lead(五声音阶)。
//  * 节奏跟随踩踏：bpm ≈ 72 + speedRatio*70，再按 cadence ±6，范围 70~152；
//    变速平滑、相位连续（不重置 nextNoteTime）。
//  * lookahead 前瞻调度：25ms 定时器 + 0.1s 提前量，音频时钟记账 → 无漂移。
//  * 昼夜：state.night↑ → 整体低通变暗、混响/延迟拉长、Pad 增强、鼓更闷。
//  * 输出链：masterGain → DynamicsCompressor → Analyser → destination。
//  * 调试字段：handle.level(RMS) / handle.peak / handle.bpm / handle.voiceCount
//    / handle.contextState，供 QA 无头验证「确实有信号输出」。
// ============================================================================

// ---------------------------------------------------------------- 常量
const LOOKAHEAD = 0.1;        // 调度提前量（秒）
const SCHED_INTERVAL_MS = 25; // 调度周期（毫秒）
const BPM_BASE = 72;
const BPM_SPAN = 70;
const BPM_MIN = 70;
const BPM_MAX = 152;
const MAX_OSCILLATORS = 24;   // 同时存在的振荡器硬上限（含常驻 LFO）
const MAX_MUSIC_VOICES = 16;  // 音乐层软上限，给音效留余量
const MAX_SFX_CONCURRENT = 8; // 同时进行的音效事件上限
const SILENT = 0.0001;        // 指数包络不能到 0
const AMB_LFO_COUNT = 3;      // 常驻环境 LFO 振荡器数量（计入上限）

// ---------------------------------------------------------------- 小工具
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** 确定性伪随机（固定种子 → 每次刷新旋律一致） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 和声 / 节奏数据
// Am — F — C — G（每小节一个和弦，16 小节 = 该进行重复 4 遍）
// pad: 平滑声部连接的四音和弦（MIDI）；bass: 低音根音；third: 三度音程
const CHORDS = [
  { name: 'Am', pad: [57, 60, 64, 69], bass: 45, third: 3 },
  { name: 'F',  pad: [53, 57, 60, 65], bass: 41, third: 4 },
  { name: 'C',  pad: [48, 55, 60, 64], bass: 48, third: 4 },
  { name: 'G',  pad: [55, 59, 62, 67], bass: 43, third: 4 },
];

// 16 分贝斯琶音级数：0=根音 1=五度 2=八度 3=八度+三度
const BASS_PATTERN = [0, 0, 1, 2, 0, 1, 2, 3, 0, 0, 1, 2, 0, 2, 3, 2];
const BASS_OFFSETS = [0, 7, 12, 0]; // 第 4 个偏移在运行时按和弦三度补

// 五声音阶（A 小调：A C D E G A C），主旋律只用这些音
const LEAD_SCALE = [69, 72, 74, 76, 79, 81, 84];

/**
 * 16 小节主旋律表（确定性：固定种子 + 固定动机）。
 * 旋律只在第 4~7 小节与第 12~15 小节出现（每 4/8 小节一次），
 * 由 4 小节动机组成 → 有记忆点但不喧宾夺主。len 单位为 16 分音符。
 */
const MELODY = (() => {
  const rnd = mulberry32(0x5eaf00d);
  const bars = Array.from({ length: 16 }, () => []);
  const MOTIFS = [
    { steps: [0, 3, 6, 10], lens: [2, 2, 3, 4] },
    { steps: [0, 2, 6, 8, 12], lens: [2, 2, 2, 2, 3] },
    { steps: [0, 4, 8, 12, 14], lens: [3, 2, 2, 2, 2] },
    { steps: [2, 6, 10, 14], lens: [2, 3, 2, 4] },
    { steps: [0, 3, 6, 9, 12], lens: [2, 2, 2, 2, 3] },
  ];
  function phrase(startBar, variant) {
    let idx = 2 + variant;
    for (let b = 0; b < 4; b++) {
      const motif = MOTIFS[(b + variant) % MOTIFS.length];
      const bar = bars[startBar + b];
      for (let i = 0; i < motif.steps.length; i++) {
        if (rnd() < 0.1) continue; // 偶尔留白
        idx += Math.floor(rnd() * 5) - 2; // 级进为主的小幅随机游走
        idx = clamp(idx, 0, LEAD_SCALE.length - 1);
        bar.push({ step: motif.steps[i], midi: LEAD_SCALE[idx], len: motif.lens[i] });
      }
    }
  }
  phrase(4, 0);
  phrase(12, 1);
  const last = bars[15];
  if (last.length) { // 乐句收尾：长音 + 回到主音
    last[last.length - 1].len = 6;
    last[last.length - 1].midi = 81;
  }
  return bars;
})();

// ---------------------------------------------------------------- createAudio
export function createAudio() {
  // ---- 运行时状态 --------------------------------------------------------
  let ctx = null;
  let built = false;   // 音频图是否已成功构建（ctx 可能因自动播放策略处于 suspended）
  let failed = false;  // 创建失败 → 整个句柄退化为 no-op，但绝不抛错
  let muted = false;
  let masterVolume = 0.85;

  let timerId = 0;
  let resumeRetryAt = 0;
  let gestureBound = false;
  let visBound = false;
  let pageHidden = false;
  let paused = false;

  // 音乐时钟（lookahead 调度）
  let schedStep = 0;        // 0..15（当前小节内的 16 分音符）
  let schedBar = 0;         // 绝对小节计数
  let nextNoteTime = 0;     // 下一个 16 分音符的 AudioContext 时间
  let currentBpm = 96;      // 平滑后的实际 BPM（HUD 用）
  let targetBpm = 96;
  let schedGapEma = 0.02;   // 调度定时器实际间隔的滑动平均（秒）
  let lastTimerWall = 0;
  let activeLookahead = LOOKAHEAD;

  // 由 update(state) 更新的氛围参数
  let night = 0;
  let speedRatio = 0;
  let cadence = 1;
  let lastCombo = 1;
  let atmoAccum = 0; // 氛围参数限频更新（约 10Hz，避免每帧堆 AudioParam 自动化事件）

  // 总线 / 节点
  let masterGain = null;
  let compressor = null;
  let analyser = null;
  let toneFilter = null;
  let musicBus = null;
  let dryGain = null;
  let padBus = null;
  let bassBus = null;
  let drumBus = null;
  let drumTone = null;
  let leadBus = null;
  let sfxBus = null;
  let sfxReverbSend = null;
  let reverbFilter = null;
  let reverbSend = null;
  let convolver = null;
  let reverbWet = null;
  let delayNode = null;
  let delayFilter = null;
  let delayFeedback = null;
  let delaySend = null;
  let delayWet = null;
  let noiseBuffer = null;

  // 环境声节点（常驻）
  let ambienceBus = null;
  let wavesGain = null;
  let wavesLfoGain = null;
  let surfGain = null;
  let surfLfoGain = null;
  let windGain = null;
  let windLfoGain = null;
  let cricketGain = null;
  let cricketLfoGain = null;

  // 计数 / 调试
  let voiceCount = 0;       // 当前活动振荡器（含 3 个常驻 LFO）
  let activeSfx = 0;
  let errorCount = 0;
  let levelRms = 0;
  let levelPeak = 0;
  const meterBuf = new Float32Array(1024);
  const sfxCooldown = Object.create(null);

  const SFX_CD = {
    jump: 0.12, land: 0.1, catch: 0.045, achievement: 0.4,
    flap: 0.07, shift: 0.05, splash: 0.08, crash: 0.25,
  };
  const SFX_DUR = {
    jump: 0.45, land: 0.4, catch: 0.7, achievement: 1.3,
    flap: 0.35, shift: 0.2, splash: 0.6, crash: 0.7,
  };

  const now = () => (ctx ? ctx.currentTime : 0);

  // ======================================================================
  //  图构建
  // ======================================================================
  function makeNoiseBuffer(seconds) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    const rnd = mulberry32(0x1234567);
    for (let i = 0; i < len; i++) data[i] = rnd() * 2 - 1;
    return buf;
  }

  /** 程序生成混响脉冲响应：噪声 + 指数衰减 + 简单低通（暗尾） */
  function makeImpulse(seconds, decay, bright) {
    const rate = ctx.sampleRate;
    const len = Math.max(64, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    const rnd = mulberry32(0xc0ffee);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, decay);
        const white = rnd() * 2 - 1;
        lp += (white - lp) * bright; // one-pole lowpass：越大越亮
        let s = lp * env * 0.7;
        // 少量早期反射尖峰，增加空间感
        if (i % Math.floor(rate * 0.037) === 0 && t < 0.5) s += white * env * 0.25;
        data[i] = s;
      }
    }
    return buf;
  }

  function buildGraph() {
    // --- 输出链：master → compressor → analyser → destination ---
    masterGain = ctx.createGain();
    masterGain.gain.value = SILENT;

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.knee.value = 24;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;

    masterGain.connect(compressor);
    compressor.connect(analyser);
    analyser.connect(ctx.destination);

    // --- 音乐总线（昼夜低通变暗）---
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.6;
    toneFilter = ctx.createBiquadFilter();
    toneFilter.type = 'lowpass';
    toneFilter.frequency.value = 9200;
    toneFilter.Q.value = 0.5;
    musicBus.connect(toneFilter);

    dryGain = ctx.createGain();
    dryGain.gain.value = 0.95;
    toneFilter.connect(dryGain);
    dryGain.connect(masterGain);

    // --- 混响（卷积 + 程序 IR）---
    reverbFilter = ctx.createBiquadFilter();
    reverbFilter.type = 'lowpass';
    reverbFilter.frequency.value = 7000;
    reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.5;
    convolver = ctx.createConvolver();
    convolver.normalize = true;
    try { convolver.buffer = makeImpulse(2.6, 2.6, 0.72); } catch (e) { /* 忽略 */ }
    reverbWet = ctx.createGain();
    reverbWet.gain.value = 0.16;
    toneFilter.connect(reverbFilter);
    reverbFilter.connect(reverbSend);
    reverbSend.connect(convolver);
    convolver.connect(reverbWet);
    reverbWet.connect(masterGain);

    // --- 反馈延迟（夜间拉长）---
    delayNode = ctx.createDelay(1.5);
    delayNode.delayTime.value = 0.375;
    delayFilter = ctx.createBiquadFilter();
    delayFilter.type = 'lowpass';
    delayFilter.frequency.value = 4500;
    delayFeedback = ctx.createGain();
    delayFeedback.gain.value = 0.2;
    delaySend = ctx.createGain();
    delaySend.gain.value = 0.5;
    delayWet = ctx.createGain();
    delayWet.gain.value = 0.07;
    toneFilter.connect(delaySend);
    delaySend.connect(delayNode);
    delayNode.connect(delayFilter);
    delayFilter.connect(delayFeedback);
    delayFeedback.connect(delayNode); // 反馈环（内含 DelayNode，合法）
    delayFilter.connect(delayWet);
    delayWet.connect(masterGain);

    // --- 分层总线 ---
    padBus = ctx.createGain();
    padBus.gain.value = 0.9;
    padBus.connect(musicBus);

    bassBus = ctx.createGain();
    bassBus.gain.value = 0.9;
    bassBus.connect(musicBus);

    leadBus = ctx.createGain();
    leadBus.gain.value = 0.85;
    leadBus.connect(musicBus);

    drumBus = ctx.createGain();
    drumBus.gain.value = 0.9;
    drumTone = ctx.createBiquadFilter();
    drumTone.type = 'lowpass';
    drumTone.frequency.value = 14000;
    drumTone.Q.value = 0.6;
    drumBus.connect(drumTone);
    drumTone.connect(musicBus);

    // --- 音效总线（不随昼夜变暗，保持明亮；少量送混响）---
    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.8;
    sfxBus.connect(masterGain);

    sfxReverbSend = ctx.createGain();
    sfxReverbSend.gain.value = 0.3;
    sfxReverbSend.connect(convolver);

    // --- 环境声总线 ---
    ambienceBus = ctx.createGain();
    ambienceBus.gain.value = 0.55;
    ambienceBus.connect(masterGain);

    noiseBuffer = makeNoiseBuffer(4);
  }

  // ======================================================================
  //  环境声：海浪 / 风 / 夜间虫鸣（全部为滤波噪声 + 慢 LFO）
  // ======================================================================
  function startAmbience() {
    // 海浪：低通噪声 + 0.055Hz 慢 LFO
    const waveSrc = ctx.createBufferSource();
    waveSrc.buffer = noiseBuffer;
    waveSrc.loop = true;
    const waveLp = ctx.createBiquadFilter();
    waveLp.type = 'lowpass';
    waveLp.frequency.value = 460;
    waveLp.Q.value = 0.6;
    wavesGain = ctx.createGain();
    wavesGain.gain.value = 0.05;
    waveSrc.connect(waveLp);
    waveLp.connect(wavesGain);
    wavesGain.connect(ambienceBus);

    // 碎浪层：略高的低通，同一 LFO 不同深度（更像一波波拍岸）
    const surfSrc = ctx.createBufferSource();
    surfSrc.buffer = noiseBuffer;
    surfSrc.loop = true;
    const surfBp = ctx.createBiquadFilter();
    surfBp.type = 'bandpass';
    surfBp.frequency.value = 720;
    surfBp.Q.value = 0.9;
    surfGain = ctx.createGain();
    surfGain.gain.value = 0.03;
    surfSrc.connect(surfBp);
    surfBp.connect(surfGain);
    surfGain.connect(ambienceBus);

    const waveLfo = ctx.createOscillator();
    waveLfo.type = 'sine';
    waveLfo.frequency.value = 0.055;
    wavesLfoGain = ctx.createGain();
    wavesLfoGain.gain.value = 0.022;
    waveLfo.connect(wavesLfoGain);
    wavesLfoGain.connect(wavesGain.gain);
    surfLfoGain = ctx.createGain();
    surfLfoGain.gain.value = 0.014;
    waveLfo.connect(surfLfoGain);
    surfLfoGain.connect(surfGain.gain);

    // 风：高通噪声，增益由速度驱动
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = noiseBuffer;
    windSrc.loop = true;
    const windHp = ctx.createBiquadFilter();
    windHp.type = 'highpass';
    windHp.frequency.value = 720;
    windHp.Q.value = 0.4;
    const windLp = ctx.createBiquadFilter();
    windLp.type = 'lowpass';
    windLp.frequency.value = 4200;
    windGain = ctx.createGain();
    windGain.gain.value = 0.008;
    windSrc.connect(windHp);
    windHp.connect(windLp);
    windLp.connect(windGain);
    windGain.connect(ambienceBus);

    const windLfo = ctx.createOscillator();
    windLfo.type = 'sine';
    windLfo.frequency.value = 0.13;
    windLfoGain = ctx.createGain();
    windLfoGain.gain.value = 0.004;
    windLfo.connect(windLfoGain);
    windLfoGain.connect(windGain.gain);

    // 夜间虫鸣：窄带噪声 + 9Hz 振幅调制（轻微）
    const cricketSrc = ctx.createBufferSource();
    cricketSrc.buffer = noiseBuffer;
    cricketSrc.loop = true;
    const cricketBp = ctx.createBiquadFilter();
    cricketBp.type = 'bandpass';
    cricketBp.frequency.value = 4300;
    cricketBp.Q.value = 16;
    cricketGain = ctx.createGain();
    cricketGain.gain.value = SILENT;
    cricketSrc.connect(cricketBp);
    cricketBp.connect(cricketGain);
    cricketGain.connect(ambienceBus);

    const cricketLfo = ctx.createOscillator();
    cricketLfo.type = 'sine';
    cricketLfo.frequency.value = 9;
    cricketLfoGain = ctx.createGain();
    cricketLfoGain.gain.value = 0.004;
    cricketLfo.connect(cricketLfoGain);
    cricketLfoGain.connect(cricketGain.gain);

    const t = now() + 0.05;
    waveSrc.start(t);
    surfSrc.start(t + 0.2);
    windSrc.start(t + 0.1);
    cricketSrc.start(t + 0.3);
    waveLfo.start(t);
    windLfo.start(t);
    cricketLfo.start(t);

    // 3 个常驻 LFO 计入振荡器预算
    voiceCount += AMB_LFO_COUNT;
  }

  // ======================================================================
  //  振荡器生命周期：统一限流 + 回收
  // ======================================================================
  function beginOsc(limit) {
    if (voiceCount >= (limit || MAX_OSCILLATORS)) return false;
    voiceCount++;
    return true;
  }

  function finishOsc(osc, startT, stopT, nodes) {
    try {
      osc.start(Math.max(startT, now() - 0.001));
      osc.stop(Math.max(stopT, now() + 0.002));
    } catch (e) {
      voiceCount = Math.max(0, voiceCount - 1);
      for (const n of nodes) { try { n.disconnect(); } catch (err) { /* noop */ } }
      return;
    }
    osc.addEventListener('ended', () => {
      voiceCount = Math.max(0, voiceCount - 1);
      for (const n of nodes) { try { n.disconnect(); } catch (err) { /* noop */ } }
    }, { once: true });
  }

  /** 短噪声爆发（鼓 / 音效通用）。返回 BufferSource。 */
  function noiseBurst(t, opts) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    const nodes = [src];
    let out = src;
    if (opts.filterType) {
      const f = ctx.createBiquadFilter();
      f.type = opts.filterType;
      f.frequency.setValueAtTime(Math.max(20, opts.filterF0 || 1000), t);
      if (opts.filterF1) {
        const sweep = Math.max(0.01, opts.filterSweep || opts.decay || 0.2);
        f.frequency.exponentialRampToValueAtTime(Math.max(20, opts.filterF1), t + sweep);
      }
      f.Q.value = opts.q == null ? 1 : opts.q;
      src.connect(f);
      out = f;
      nodes.push(f);
    }
    const g = ctx.createGain();
    const attack = opts.attack == null ? 0.003 : opts.attack;
    const decay = opts.decay == null ? 0.2 : opts.decay;
    g.gain.setValueAtTime(SILENT, t);
    g.gain.linearRampToValueAtTime(Math.max(SILENT * 2, opts.peak == null ? 0.1 : opts.peak), t + attack);
    g.gain.exponentialRampToValueAtTime(SILENT, t + attack + decay);
    out.connect(g);
    g.connect(opts.dest || sfxBus);
    nodes.push(g);

    if (opts.send > 0 && sfxReverbSend) {
      const s = ctx.createGain();
      s.gain.value = opts.send;
      g.connect(s);
      s.connect(sfxReverbSend);
      nodes.push(s);
    }

    const stopT = t + attack + decay + 0.06;
    try {
      src.start(t, Math.random() * Math.min(1.5, noiseBuffer.duration * 0.4));
      src.stop(stopT);
    } catch (e) { /* noop */ }
    src.addEventListener('ended', () => {
      for (const n of nodes) { try { n.disconnect(); } catch (err) { /* noop */ } }
    }, { once: true });
    return src;
  }

  /** 合成单音（oscillator + 可选滤波 + AD 包络），用于音效层。 */
  function synthTone(t, opts) {
    if (!beginOsc(MAX_OSCILLATORS)) return false;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const nodes = [osc, g];
    osc.type = opts.type || 'sine';
    const f0 = Math.max(1, opts.f0 || 440);
    osc.frequency.setValueAtTime(f0, t);
    if (opts.f1 && opts.f1 !== f0) {
      const sweep = Math.max(0.01, opts.sweep || opts.decay || 0.2);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f1), t + sweep);
    }
    const attack = opts.attack == null ? 0.005 : opts.attack;
    const decay = opts.decay == null ? 0.2 : opts.decay;
    const peak = opts.peak == null ? 0.1 : opts.peak;
    g.gain.setValueAtTime(SILENT, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(SILENT, t + attack + decay);
    if (opts.detune) osc.detune.setValueAtTime(opts.detune, t);
    osc.connect(g);
    const dest = opts.dest || sfxBus;
    g.connect(dest);
    if (opts.send > 0 && sfxReverbSend) {
      const s = ctx.createGain();
      s.gain.value = opts.send;
      g.connect(s);
      s.connect(sfxReverbSend);
      nodes.push(s);
    }
    finishOsc(osc, t, t + attack + decay + 0.05, nodes);
    return true;
  }

  // ======================================================================
  //  音乐层：鼓组
  // ======================================================================
  function kick(t, vel) {
    if (!beginOsc(MAX_OSCILLATORS)) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const nodes = [osc, g];
    osc.type = 'sine';
    osc.frequency.setValueAtTime(152, t);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    g.gain.setValueAtTime(SILENT, t);
    g.gain.linearRampToValueAtTime(0.5 * vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(SILENT, t + 0.34);
    osc.connect(g);
    g.connect(drumBus);
    finishOsc(osc, t, t + 0.37, nodes);
    // beater click
    noiseBurst(t, { filterType: 'highpass', filterF0: 2600, peak: 0.05 * vel, attack: 0.001, decay: 0.025, dest: drumBus });
  }

  function snare(t, vel) {
    noiseBurst(t, { filterType: 'bandpass', filterF0: 1900, q: 0.8, peak: 0.15 * vel, attack: 0.002, decay: 0.16, dest: drumBus });
    if (!beginOsc(MAX_OSCILLATORS)) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const nodes = [osc, g];
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(190, t);
    osc.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    g.gain.setValueAtTime(SILENT, t);
    g.gain.linearRampToValueAtTime(0.1 * vel, t + 0.003);
    g.gain.exponentialRampToValueAtTime(SILENT, t + 0.1);
    osc.connect(g);
    g.connect(drumBus);
    finishOsc(osc, t, t + 0.12, nodes);
  }

  function hat(t, accent, open) {
    noiseBurst(t, {
      filterType: 'highpass',
      filterF0: open ? 7200 : 6800,
      q: 0.7,
      peak: (open ? 0.05 : 0.045) * accent,
      attack: 0.001,
      decay: open ? 0.22 : 0.045,
      dest: drumBus,
    });
  }

  // ======================================================================
  //  音乐层：贝斯 / Pad / 主旋律
  // ======================================================================
  function bassNote(t, chord, degree, stepDur) {
    if (!beginOsc(MAX_OSCILLATORS)) return;
    const offsets = [0, 7, 12, 12 + chord.third];
    const semis = offsets[degree] || 0;
    const freq = midiToFreq(chord.bass + semis);
    const dur = Math.max(0.05, stepDur * 0.86);
    const osc = ctx.createOscillator();
    const filt = ctx.createBiquadFilter();
    const g = ctx.createGain();
    const nodes = [osc, filt, g];
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, t);
    filt.type = 'lowpass';
    filt.Q.value = 5.5;
    filt.frequency.setValueAtTime(1500, t);
    filt.frequency.exponentialRampToValueAtTime(260, t + Math.min(0.13, dur));
    g.gain.setValueAtTime(SILENT, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.005);
    g.gain.exponentialRampToValueAtTime(SILENT, t + dur);
    osc.connect(filt);
    filt.connect(g);
    g.connect(bassBus);
    finishOsc(osc, t, t + dur + 0.03, nodes);
  }

  function padChord(t, chord, barDur) {
    const dur = Math.max(0.3, barDur * 0.92);
    const attack = Math.min(0.55, Math.max(0.16, barDur * 0.2));
    const release = Math.min(1.5, Math.max(0.4, barDur * 0.45));
    for (let i = 0; i < chord.pad.length; i++) {
      if (!beginOsc(MAX_MUSIC_VOICES)) break;
      const midi = chord.pad[i];
      const osc = ctx.createOscillator();
      const filt = ctx.createBiquadFilter();
      const g = ctx.createGain();
      const nodes = [osc, filt, g];
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(midiToFreq(midi), t);
      osc.detune.setValueAtTime(i % 2 ? 6 : -6, t); // 轻微失谐，像模拟合成器叠音
      filt.type = 'lowpass';
      filt.frequency.value = 1150;
      filt.Q.value = 0.7;
      const peak = 0.042;
      const gEnd = t + dur;
      g.gain.setValueAtTime(SILENT, t);
      g.gain.linearRampToValueAtTime(peak, t + attack);
      g.gain.setValueAtTime(peak, gEnd);
      g.gain.exponentialRampToValueAtTime(SILENT, gEnd + release);
      osc.connect(filt);
      filt.connect(g);
      g.connect(padBus);
      finishOsc(osc, t, gEnd + release + 0.04, nodes);
    }
  }

  function leadNote(t, midi, lenSec) {
    if (!beginOsc(MAX_MUSIC_VOICES)) return;
    const f = midiToFreq(midi);
    const osc = ctx.createOscillator();
    const filt = ctx.createBiquadFilter();
    const g = ctx.createGain();
    const nodes = [osc, filt, g];
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f, t);
    osc.detune.setValueAtTime(-4, t);
    osc.detune.linearRampToValueAtTime(4, t + Math.max(0.1, lenSec));
    filt.type = 'lowpass';
    filt.frequency.value = 3200;
    filt.Q.value = 0.6;
    const attack = 0.014;
    const decayT = t + 0.09;
    const holdT = Math.max(decayT + 0.01, t + Math.max(0.1, lenSec * 0.72));
    const endT = holdT + 0.28;
    g.gain.setValueAtTime(SILENT, t);
    g.gain.linearRampToValueAtTime(0.075, t + attack);
    g.gain.exponentialRampToValueAtTime(0.038, decayT);
    g.gain.setValueAtTime(0.038, holdT);
    g.gain.exponentialRampToValueAtTime(SILENT, endT);
    osc.connect(filt);
    filt.connect(g);
    g.connect(leadBus);
    finishOsc(osc, t, endT + 0.03, nodes);

    // 八度上方一点点正弦「亮片」
    if (beginOsc(MAX_MUSIC_VOICES)) {
      const osc2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      const nodes2 = [osc2, g2];
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(f * 2, t);
      g2.gain.setValueAtTime(SILENT, t);
      g2.gain.linearRampToValueAtTime(0.014, t + attack);
      g2.gain.exponentialRampToValueAtTime(SILENT, decayT + 0.1);
      osc2.connect(g2);
      g2.connect(leadBus);
      finishOsc(osc2, t, decayT + 0.13, nodes2);
    }
  }

  // ======================================================================
  //  16 分音符步进调度
  // ======================================================================
  function scheduleOneStep(s, bar, t) {
    const inBar = bar % 16;
    const chord = CHORDS[bar % 4];
    const stepDur = 60 / currentBpm / 4;
    const beatDur = stepDur * 4;
    const barDur = beatDur * 4;
    const beat = s >> 2;
    const sub = s & 3;
    const section = inBar >> 2; // 0..3：16 小节内每 4 小节一个段落，做鼓组/配器变化

    // --- 鼓：四四 kick、2/4 拍 snare、8 分 hihat ---
    if (sub === 0) kick(t, beat === 0 ? 0.95 : 0.8);
    if (inBar >= 2 && (s === 4 || s === 12)) snare(t, 0.75);
    if (inBar >= 2 && s === 15 && (inBar & 1)) snare(t, 0.2); // ghost note
    if (inBar === 15 && s >= 13) snare(t, 0.22 + (s - 13) * 0.12); // 循环前的鼓 fill
    if ((inBar === 7 || inBar === 11) && s === 15) snare(t, 0.26); // 段落衔接轻 fill
    if ((s & 1) === 0) {
      const accent = (s & 3) === 0 ? 1 : 0.62;
      hat(t, accent, s === 14 && (inBar % 4 === 3));
    }
    // 后半段（第 9~16 小节）加入 16 分 hat 沙沙声，律动更密；第 4 段加过门 kick
    if (section >= 2 && (s & 1) === 1) hat(t, 0.3, false);
    if (section === 3 && s === 14) kick(t, 0.42);

    // --- 贝斯：16 分琶音（循环最后一小节留 3 个 16 分空拍，让 fill 更明显）---
    if (inBar >= 1 && !(inBar === 15 && s >= 13)) {
      bassNote(t, chord, BASS_PATTERN[s], stepDur);
    }

    // --- Pad：每小节一个和弦（慢 attack / release）---
    if (s === 0) {
      padChord(t, chord, barDur);
    }

    // --- 主旋律：第 4~7 / 12~15 小节 ---
    const mel = MELODY[inBar];
    if (mel && mel.length) {
      for (let i = 0; i < mel.length; i++) {
        const note = mel[i];
        if (note.step === s) {
          leadNote(t, note.midi, note.len * stepDur);
        }
      }
    }

    // --- 每个 16 小节循环开头：轻微空气感冲击（不刺耳）---
    if (inBar === 0 && s === 0) {
      noiseBurst(t, { filterType: 'bandpass', filterF0: 1200, q: 0.8, peak: 0.035, attack: 0.05, decay: 0.9, dest: drumBus, send: 0.5 });
    }
  }

  function advanceStep() {
    // 变速：每 16 分音符向目标 BPM 逼近一小步（平滑、不重置相位）
    // 上限 ±4 BPM/16 分：约 1.5~2.5 秒跟上踏频变化，听得出快慢但不会突兀
    const diff = targetBpm - currentBpm;
    currentBpm = clamp(currentBpm + clamp(diff * 0.2, -4, 4), BPM_MIN, BPM_MAX);
    nextNoteTime += 60 / currentBpm / 4;
    schedStep++;
    if (schedStep >= 16) {
      schedStep = 0;
      schedBar++;
    }
  }

  function scheduleAhead(fromTimer) {
    if (!built || !ctx || failed) return;
    if (ctx.state !== 'running') return;
    if (pageHidden || paused) return;
    try {
      // 主线程被长任务阻塞时（低帧率/无头 swiftshader），25ms 定时器会被节流。
      // 用定时器实际间隔的 EMA 自适应放大提前量，减少断音（桌面 60fps 时仍为 0.1s）。
      if (fromTimer) {
        const wall = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
        if (lastTimerWall > 0) {
          const gap = wall - lastTimerWall;
          if (gap >= 0 && gap < 3) schedGapEma += (gap - schedGapEma) * 0.12;
        }
        lastTimerWall = wall;
      }
      activeLookahead = clamp(0.1 + Math.max(0, schedGapEma - 0.04) * 2.5, LOOKAHEAD, 0.5);

      const t0 = ctx.currentTime;
      // 落后于音乐时钟：按拍补算跳过的步进（只推进相位/BPM，不补发声音），
      // 避免长任务后「一次性爆发旧音符」或节拍永久滞后。
      if (nextNoteTime < t0 - 0.02) {
        if (t0 - nextNoteTime > 3) {
          nextNoteTime = t0 + 0.08; // 长时间暂停/隐藏恢复：直接对齐当下
        } else {
          let catchUp = 0;
          while (nextNoteTime < t0 && catchUp++ < 512) advanceStep();
        }
      }
      let guard = 0;
      while (nextNoteTime < t0 + activeLookahead && guard++ < 96) {
        scheduleOneStep(schedStep, schedBar, nextNoteTime);
        advanceStep();
      }
    } catch (e) {
      errorCount++;
    }
  }

  // ======================================================================
  //  昼夜氛围 / BPM 目标 / 电平表
  // ======================================================================
  function applyAtmosphere() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const dark = night;

    // 整体低通：黄昏明亮 → 深夜变暗
    toneFilter.frequency.setTargetAtTime(lerp(9200, 2100, dark), t, 0.45);
    drumTone.frequency.setTargetAtTime(lerp(14000, 2600, dark), t, 0.45);

    // 各层比例：夜间 Pad 增强、鼓更闷更轻
    padBus.gain.setTargetAtTime(lerp(0.9, 1.5, dark), t, 0.5);
    bassBus.gain.setTargetAtTime(lerp(0.9, 0.95, dark), t, 0.5);
    drumBus.gain.setTargetAtTime(lerp(0.95, 0.66, dark), t, 0.5);
    leadBus.gain.setTargetAtTime(lerp(0.85, 0.9, dark), t, 0.5);

    // 混响 / 延迟：夜间拉长
    reverbWet.gain.setTargetAtTime(lerp(0.16, 0.42, dark), t, 0.6);
    reverbFilter.frequency.setTargetAtTime(lerp(7000, 2400, dark), t, 0.6);
    delayWet.gain.setTargetAtTime(lerp(0.07, 0.2, dark), t, 0.6);
    delayFeedback.gain.setTargetAtTime(lerp(0.2, 0.44, dark), t, 0.6);
    delayFilter.frequency.setTargetAtTime(lerp(4500, 1600, dark), t, 0.6);
    // 延迟时间跟随速度（附点八分），保持连续
    const delayTarget = clamp(0.75 * 60 / Math.max(60, currentBpm), 0.16, 0.65);
    delayNode.delayTime.setTargetAtTime(delayTarget, t, 0.9);

    // 环境声：海浪夜间更明显；风随速度；虫鸣只在夜里
    const waveBase = 0.045 + 0.02 * dark;
    wavesGain.gain.setTargetAtTime(waveBase, t, 0.8);
    wavesLfoGain.gain.setTargetAtTime(waveBase * 0.55, t, 0.8);
    const surfBase = 0.028 + 0.016 * dark;
    surfGain.gain.setTargetAtTime(surfBase, t, 0.8);
    surfLfoGain.gain.setTargetAtTime(surfBase * 0.55, t, 0.8);
    const windBase = 0.006 + speedRatio * speedRatio * 0.05;
    windGain.gain.setTargetAtTime(windBase, t, 0.6);
    windLfoGain.gain.setTargetAtTime(windBase * 0.5, t, 0.6);
    const cricketBase = dark * dark * 0.014;
    cricketGain.gain.setTargetAtTime(Math.max(SILENT * 2, cricketBase), t, 0.9);
    cricketLfoGain.gain.setTargetAtTime(cricketBase * 0.8, t, 0.9);
  }

  function updateMeter(dt) {
    if (!analyser) return;
    try {
      analyser.getFloatTimeDomainData(meterBuf);
      let sum = 0;
      let pk = 0;
      for (let i = 0; i < meterBuf.length; i++) {
        const v = meterBuf[i];
        sum += v * v;
        const a = v < 0 ? -v : v;
        if (a > pk) pk = a;
      }
      const rms = Math.sqrt(sum / meterBuf.length);
      const k = clamp((dt || 0.016) * 14, 0, 1);
      levelRms += (rms - levelRms) * k;
      levelPeak = Math.max(pk, levelPeak * 0.94);
    } catch (e) { /* noop */ }
  }

  // ======================================================================
  //  音效
  // ======================================================================
  function sfxCatch(t, combo) {
    const c = clamp(Math.round(combo || 1), 1, 6);
    const base = 81 + (c - 1) * 2; // A5 起，连击越高越亮
    const steps = [0, 4, 7];
    for (let i = 0; i < steps.length; i++) {
      const tt = t + i * 0.055;
      synthTone(tt, { type: 'triangle', f0: midiToFreq(base + steps[i]), peak: 0.085, attack: 0.004, decay: 0.5, send: 0.35 });
      synthTone(tt, { type: 'sine', f0: midiToFreq(base + steps[i] + 12), peak: 0.022, attack: 0.003, decay: 0.35, send: 0.4 });
    }
    noiseBurst(t, { filterType: 'highpass', filterF0: 6500, peak: 0.035, attack: 0.002, decay: 0.12, send: 0.3 });
  }

  function sfxAchievement(t) {
    const notes = [81, 85, 88]; // A5 – C#6 – E6
    for (let i = 0; i < notes.length; i++) {
      const tt = t + i * 0.13;
      synthTone(tt, { type: 'triangle', f0: midiToFreq(notes[i]), peak: 0.1, attack: 0.01, decay: 0.95, send: 0.6 });
      synthTone(tt, { type: 'sine', f0: midiToFreq(notes[i] + 12), peak: 0.026, attack: 0.008, decay: 0.8, send: 0.6 });
    }
  }

  function playSfx(name, opts) {
    if (!built || !ctx || failed) return;
    try {
      if (ctx.state !== 'running') return;
      if (sfxCooldown[name] != null) {
        const cd = SFX_CD[name] || 0.05;
        if (ctx.currentTime - sfxCooldown[name] < cd) return;
      }
      if (activeSfx >= MAX_SFX_CONCURRENT) return;
      sfxCooldown[name] = ctx.currentTime;
      activeSfx++;
      setTimeout(() => { activeSfx = Math.max(0, activeSfx - 1); }, (SFX_DUR[name] || 0.6) * 1000 + 80);

      const t = ctx.currentTime + 0.006;
      switch (name) {
        case 'jump':
          noiseBurst(t, { filterType: 'bandpass', filterF0: 380, filterF1: 2900, filterSweep: 0.3, q: 1.4, peak: 0.16, attack: 0.02, decay: 0.3, send: 0.25 });
          synthTone(t, { type: 'sine', f0: 170, f1: 640, sweep: 0.22, peak: 0.05, attack: 0.01, decay: 0.2 });
          break;
        case 'land':
          synthTone(t, { type: 'sine', f0: 150, f1: 42, sweep: 0.2, peak: 0.34, attack: 0.004, decay: 0.3 });
          noiseBurst(t, { filterType: 'lowpass', filterF0: 820, q: 0.7, peak: 0.12, attack: 0.004, decay: 0.2, send: 0.2 });
          break;
        case 'catch':
          sfxCatch(t, (opts && opts.combo) || lastCombo);
          break;
        case 'achievement':
          sfxAchievement(t);
          break;
        case 'flap':
          noiseBurst(t, { filterType: 'bandpass', filterF0: 2600, filterF1: 500, filterSweep: 0.16, q: 1.1, peak: 0.14, attack: 0.004, decay: 0.22, send: 0.2 });
          synthTone(t, { type: 'sine', f0: 120, f1: 70, sweep: 0.1, peak: 0.07, attack: 0.004, decay: 0.12 });
          break;
        case 'shift':
          noiseBurst(t, { filterType: 'highpass', filterF0: 3200, filterF1: 1400, filterSweep: 0.07, q: 0.8, peak: 0.09, attack: 0.003, decay: 0.09 });
          synthTone(t, { type: 'sine', f0: 520, f1: 340, sweep: 0.06, peak: 0.022, attack: 0.004, decay: 0.07 });
          break;
        case 'splash':
          noiseBurst(t, { filterType: 'lowpass', filterF0: 3200, q: 0.6, peak: 0.16, attack: 0.005, decay: 0.42, send: 0.35 });
          synthTone(t + 0.02, { type: 'sine', f0: 1150, peak: 0.04, attack: 0.003, decay: 0.14, send: 0.3 });
          synthTone(t + 0.075, { type: 'sine', f0: 1620, peak: 0.028, attack: 0.003, decay: 0.12, send: 0.3 });
          synthTone(t, { type: 'sine', f0: 180, f1: 90, sweep: 0.14, peak: 0.07, attack: 0.004, decay: 0.16 });
          break;
        case 'crash':
          noiseBurst(t, { filterType: 'lowpass', filterF0: 2600, q: 0.8, peak: 0.28, attack: 0.004, decay: 0.5, send: 0.3 });
          synthTone(t, { type: 'sine', f0: 110, f1: 38, sweep: 0.22, peak: 0.26, attack: 0.004, decay: 0.32 });
          noiseBurst(t + 0.01, { filterType: 'bandpass', filterF0: 4800, q: 4, peak: 0.06, attack: 0.002, decay: 0.4 });
          break;
        default:
          break;
      }
    } catch (e) {
      errorCount++;
    }
  }

  // ======================================================================
  //  解锁 / 生命周期
  // ======================================================================
  function onVisibilityChange() {
    pageHidden = !!(typeof document !== 'undefined' && document.hidden);
    if (!ctx) return;
    if (!pageHidden) {
      if (ctx.state === 'suspended') {
        try { ctx.resume().catch(() => {}); } catch (e) { /* noop */ }
      }
      // 恢复时重新对齐调度时钟，避免一次性补播
      nextNoteTime = Math.max(nextNoteTime, ctx.currentTime + 0.08);
    }
  }

  // 常驻 LFO 与首次手势恢复：某些浏览器（或 ?autostart=1 非手势路径）会让
  // ctx 初始为 suspended，这里在首个真实手势时静默 resume，并在成功后解绑。
  const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchstart'];
  function onFirstGesture() {
    if (!ctx) { unbindGestureResume(); return; }
    try {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      if (ctx.state === 'running') unbindGestureResume();
    } catch (e) { /* noop */ }
  }
  function bindGestureResume() {
    if (gestureBound || typeof window === 'undefined' || !window.addEventListener) return;
    gestureBound = true;
    for (const ev of GESTURE_EVENTS) {
      try { window.addEventListener(ev, onFirstGesture, { capture: true, passive: true }); } catch (e) { /* noop */ }
    }
  }
  function unbindGestureResume() {
    if (!gestureBound || typeof window === 'undefined') return;
    gestureBound = false;
    for (const ev of GESTURE_EVENTS) {
      try { window.removeEventListener(ev, onFirstGesture, { capture: true }); } catch (e) { /* noop */ }
    }
  }

  function unlock() {
    if (ctx) {
      if (ctx.state === 'suspended') {
        try { ctx.resume().catch(() => {}); } catch (e) { /* noop */ }
      }
      return;
    }
    if (failed) return;
    try {
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) { failed = true; return; }
      ctx = new AC({ latencyHint: 'interactive' });
      buildGraph();
      startAmbience();

      // 主输出淡入（避免爆音）
      const t = now();
      masterGain.gain.cancelScheduledValues(t);
      masterGain.gain.setValueAtTime(SILENT, t);
      masterGain.gain.setTargetAtTime(muted ? SILENT : masterVolume, t + 0.02, 0.12);

      // 音乐从下一个小节网格开始
      schedStep = 0;
      schedBar = 0;
      currentBpm = 96;
      nextNoteTime = ctx.currentTime + 0.12;

      built = true;
      bindGestureResume();

      if (ctx.state === 'suspended') {
        try { ctx.resume().catch(() => {}); } catch (e) { /* noop */ }
      }

      timerId = setInterval(() => scheduleAhead(true), SCHED_INTERVAL_MS);
      if (typeof document !== 'undefined' && !visBound) {
        document.addEventListener('visibilitychange', onVisibilityChange);
        visBound = true;
        pageHidden = !!document.hidden;
      }
      applyAtmosphere();
    } catch (e) {
      // 失败必须静默：不抛错、不刷 console，句柄保持 no-op 可用
      failed = true;
      built = false;
      errorCount++;
      try { if (ctx) ctx.close(); } catch (err) { /* noop */ }
      ctx = null;
      if (timerId) { clearInterval(timerId); timerId = 0; }
    }
  }

  // ======================================================================
  //  对外句柄
  // ======================================================================
  return {
    /** 首次用户手势时调用；可重复调用（suspended 时 resume） */
    unlock() {
      try { unlock(); } catch (e) { /* 静默 */ }
    },

    /** AudioContext 已创建且处于 running（可正常出声） */
    get ready() { return !!built && !!ctx && !failed && ctx.state === 'running'; },

    /** 当前平滑后的 BPM（HUD 显示） */
    get bpm() { return currentBpm; },

    get muted() { return muted; },

    /** 最近一帧输出 RMS（调试/QA 用，>0.005 即证明有信号） */
    get level() { return levelRms; },

    /** 最近峰值（缓慢衰减） */
    get peak() { return levelPeak; },

    /** 当前活动振荡器数量（调试/QA 用，应 ≤ 24） */
    get voiceCount() { return voiceCount; },

    /** 'running' | 'suspended' | 'closed' | 'none' */
    get contextState() { return ctx ? ctx.state : 'none'; },

    /**
     * 每帧调用：更新 BPM 目标、昼夜氛围、环境声、电平表、补一次前瞻调度。
     * dt 为秒；state 为 CONTRACT §2 的 state。
     */
    update(dt, state) {
      if (!ctx || failed) return;
      try {
        const d = clamp(Number(dt) || 0.016, 0, 0.1);
        const st = state || null;

        paused = !!(st && st.paused);
        pageHidden = !!(typeof document !== 'undefined' && document.hidden);

        // 自动开始（非用户手势）等场景下 ctx 可能被浏览器挂起：低频静默重试恢复
        if (ctx.state === 'suspended') {
          const wall = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
          if (wall >= resumeRetryAt) {
            resumeRetryAt = wall + 2;
            try { ctx.resume().catch(() => {}); } catch (e) { /* noop */ }
          }
        }

        // --- BPM 目标：72 + speedRatio*70，再加 cadence 微调（±6），范围 70~152
        let sr = 0;
        if (st) {
          if (typeof st.speedRatio === 'number') sr = st.speedRatio;
          else if (typeof st.speed === 'number') sr = st.speed / (st.speedMax || 34);
        }
        sr = clamp(Number(sr) || 0, 0, 1);
        speedRatio = sr;
        cadence = clamp(Number(st && st.cadence) || 1, 0, 2);
        const cadJitter = clamp((cadence - 1) * 10, -6, 6);
        targetBpm = clamp(BPM_BASE + sr * BPM_SPAN + cadJitter, BPM_MIN, BPM_MAX);

        // --- 昼夜
        night = clamp(Number(st && st.night) || 0, 0, 1);
        if (st && typeof st.combo === 'number' && st.combo > 0) lastCombo = st.combo;

        // --- 氛围平滑（约 10Hz 更新即可；夜/昼参数本身是 setTargetAtTime 缓变）---
        atmoAccum += d;
        if (atmoAccum >= 0.1) {
          atmoAccum = 0;
          applyAtmosphere();
        }

        // --- 电平表（证明真实有输出）
        updateMeter(d);

        // --- 帧内也补一次调度（主循环 rAF 驱动时更稳；与 25ms 定时器幂等）
        scheduleAhead(false);
      } catch (e) { errorCount++; }
    },

    /** 立即刷新并返回当前输出 RMS（QA 用，不依赖主循环调用频率） */
    measure() {
      try { updateMeter(0.1); } catch (e) { errorCount++; }
      return levelRms;
    },

    /** 播放音效：'jump'|'land'|'catch'|'achievement'|'flap'|'shift'|'splash'|'crash' */
    sfx(name, opts) {
      try { playSfx(name, opts); } catch (e) { errorCount++; }
    },

    /** 平滑静音/取消静音（约 0.15s） */
    setMuted(b) {
      muted = !!b;
      if (!ctx || !masterGain) return;
      try {
        const t = now();
        masterGain.gain.cancelScheduledValues(t);
        masterGain.gain.setTargetAtTime(muted ? SILENT : masterVolume, t, 0.05);
      } catch (e) { errorCount++; }
    },

    /** 主音量 0..1（受静音开关约束） */
    setMasterVolume(v) {
      masterVolume = clamp(Number(v) || 0, 0, 1);
      if (!ctx || !masterGain) return;
      try {
        const t = now();
        masterGain.gain.setTargetAtTime(muted ? SILENT : masterVolume, t, 0.05);
      } catch (e) { errorCount++; }
    },

    /** 释放（非契约必需，供 QA/热重载使用） */
    dispose() {
      try {
        if (timerId) clearInterval(timerId);
        timerId = 0;
        if (typeof document !== 'undefined' && visBound) {
          document.removeEventListener('visibilitychange', onVisibilityChange);
          visBound = false;
        }
        if (ctx) ctx.close();
      } catch (e) { /* noop */ } finally {
        unbindGestureResume();
        ctx = null;
        built = false;
      }
    },

    /** 调试信息（QA probe 用） */
    get debug() {
      return {
        ready: !!built && !!ctx && !failed && ctx.state === 'running',
        built, bpm: currentBpm, targetBpm, night, speedRatio,
        level: levelRms, peak: levelPeak, voiceCount, activeSfx,
        contextState: ctx ? ctx.state : 'none', errors: errorCount,
        bar: schedBar, step: schedStep, lookahead: activeLookahead, schedGap: schedGapEma,
      };
    },
  };
}
