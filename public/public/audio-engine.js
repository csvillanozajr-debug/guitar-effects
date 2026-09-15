// Web Audio engine for guitar effects

export function createAudioEngine() {
  let context;
  let inputGainNode;
  let outputGainNode;
  let sourceNode; // simulated guitar (oscillator + noise)
  let masterInput;
  let masterOutput;

  // Pedal nodes map
  const pedals = new Map();

  async function init() {
    context = new (window.AudioContext || window.webkitAudioContext)();

    inputGainNode = context.createGain();
    outputGainNode = context.createGain();

    inputGainNode.gain.value = 1;
    outputGainNode.gain.value = 0.4;

    // Simulated "guitar" source: mix of saw + noise
    const osc = context.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 110; // A2

    const noiseBuffer = createNoiseBuffer(context, 2);
    const noise = context.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;

    const noiseGain = context.createGain();
    noiseGain.gain.value = 0.05;

    osc.connect(inputGainNode);
    noise.connect(noiseGain).connect(inputGainNode);

    sourceNode = { osc, noise, noiseGain };

    masterInput = inputGainNode;
    masterOutput = outputGainNode;

    outputGainNode.connect(context.destination);

    osc.start();
  }

  function createNoiseBuffer(ctx, seconds) {
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * seconds;
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  function ensurePedalNodes(id, type) {
    if (pedals.has(id)) return pedals.get(id);

    const nodes = {
      type,
      active: false,
      params: {},
      input: context.createGain(),
      output: context.createGain(),
      dry: context.createGain(),
      wet: context.createGain(),
      processors: [],
    };

    nodes.input.connect(nodes.dry);
    nodes.input.connect(nodes.wet);

    // Build effect chain per type
    if (type === "overdrive" || type === "distortion") {
      const drive = context.createWaveShaper();
      drive.curve = makeDistortionCurve(0);
      drive.oversample = "4x";

      const tone = context.createBiquadFilter();
      tone.type = "lowshelf";
      tone.frequency.value = 1000;
      tone.gain.value = 0;

      const level = context.createGain();
      level.gain.value = 0.5;

      nodes.processors = [drive, tone, level];
      nodes.wet.connect(drive);
      drive.connect(tone);
      tone.connect(level);
      level.connect(nodes.output);

      nodes.params = {
        type === "overdrive" ? "Gain" : "Drive": drive,
        Tone: tone,
        type === "overdrive" ? "Level" : "Volume": level,
      };
    } else if (type === "delay") {
      const delay = context.createDelay(1.0);
      delay.delayTime.value = 0.3;

      const feedback = context.createGain();
      feedback.gain.value = 0.4;

      const mix = context.createGain();
      mix.gain.value = 0.5;

      // Delay feedback loop
      nodes.wet.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(mix);
      mix.connect(nodes.output);

      // Also allow dry through output
      nodes.dry.connect(nodes.output);

      nodes.processors = [delay, feedback, mix];
      nodes.params = {
        Time: delay,
        Feedback: feedback,
        Mix: mix,
      };
    }

    pedals.set(id, nodes);
    return nodes;
  }

  function makeDistortionCurve(amount) {
    const k = typeof amount === "number" && amount > 0 ? amount : 50;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  function setPedalActive(id, active) {
    const p = ensurePedalNodes(id, getPedalTypeById(id));
    p.active = active;

    // Re-wire: if inactive, bypass processors (dry only)
    // Simple approach: always sum dry+wet into output; control wet gain via mix param
    // For on/off, we can set wet gain to 0 when off.
    if (!p.processors.length) return;

    const first = p.processors[0];
    if (active) {
      // ensure wet path connected
      if (!p.wet.connected) {
        // already connected in construction
      }
    } else {
      // set wet gain to 0 by adjusting mix or level
      if (p.type === "delay") {
        p.params.Mix.gain.value = 0;
      } else {
        // overdrive/distortion: set level to 0
        const levelParamName = p.type === "overdrive" ? "Level" : "Volume";
        p.params[levelParamName].gain.value = 0;
      }
    }
  }

  function setPedalParam(id, paramName, value01) {
    const type = getPedalTypeById(id);
    const p = ensurePedalNodes(id, type);

    if (type === "overdrive" || type === "distortion") {
      if (paramName === "Gain" || paramName === "Drive") {
        const drive = p.params[paramName];
        const amount = value01 * 100; // 0–100
        drive.curve = makeDistortionCurve(amount);
      } else if (paramName === "Tone") {
        const tone = p.params.Tone;
        tone.gain.value = (value01 * 2 - 1) * 10; // -10 to 10 dB
      } else if (paramName === "Level" || paramName === "Volume") {
        const level = p.params[paramName];
        level.gain.value = 0.1 + value01 * 0.9; // 0.1–1.0
        if (p.active === false) {
          // keep off state effectively muted
          level.gain.value = 0;
        }
      }
    } else if (type === "delay") {
      if (paramName === "Time") {
        const delay = p.params.Time;
        delay.delayTime.value = 0.05 + value01 * 0.7; // 50–750 ms
      } else if (paramName === "Feedback") {
        const fb = p.params.Feedback;
        fb.gain.value = value01 * 0.8; // 0–0.8
      } else if (paramName === "Mix") {
        const mix = p.params.Mix;
        mix.gain.value = value01;
        if (p.active === false) {
          mix.gain.value = 0;
        }
      }
    }
  }

  function setInputGain(value) {
    if (!inputGainNode) return;
    inputGainNode.gain.value = value;
  }

  function setOutputGain(value) {
    if (!outputGainNode) return;
    outputGainNode.gain.value = value;
  }

  function getPedalTypeById(id) {
    // Match with DOM dataset; simple heuristic
    if (id.includes("pedal-0")) return "overdrive";
    if (id.includes("pedal-1")) return "distortion";
    if (id.includes("pedal-2")) return "delay";
    return "overdrive";
  }

  return {
    get context() {
      return context;
    },
    init,
    setPedalActive,
    setPedalParam,
    setInputGain,
    setOutputGain,
  };
}
