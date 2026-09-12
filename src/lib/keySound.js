let audioContext = null;

export function playKeySound(key = "") {
  try {
    const AudioContext =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContext) return;

    if (!audioContext) {
      audioContext = new AudioContext();
    }

    const ctx = audioContext;
    const now = ctx.currentTime;

    // Same key = same sound variation
    let code = 0;

    for (let i = 0; i < key.length; i++) {
      code += key.charCodeAt(i);
    }

    const variation = code % 60;

    let frequency = 150 + variation;

    // Special keys
    if (key === " ") {
      frequency = 95;
    }

    if (key === "Enter") {
      frequency = 120;
    }

    // Main soft tone
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";

    osc.frequency.setValueAtTime(
      frequency,
      now
    );

    osc.frequency.exponentialRampToValueAtTime(
      frequency * 0.68,
      now + 0.06
    );

    // LOUD main layer
    gain.gain.setValueAtTime(
      1.15,
      now
    );

    gain.gain.exponentialRampToValueAtTime(
      0.001,
      now + 0.085
    );

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.09);

    // Mechanical click layer
    const bufferLength =
      Math.floor(ctx.sampleRate * 0.012);

    const buffer = ctx.createBuffer(
      1,
      bufferLength,
      ctx.sampleRate
    );

    const data =
      buffer.getChannelData(0);

    for (let i = 0; i < data.length; i++) {
      const fade =
        1 - i / data.length;

      data[i] =
        (Math.random() * 2 - 1) *
        fade *
        0.85;
    }

    const noise =
      ctx.createBufferSource();

    const noiseGain =
      ctx.createGain();

    const filter =
      ctx.createBiquadFilter();

    noise.buffer = buffer;

    filter.type = "bandpass";

    filter.frequency.value =
      1250 + variation * 14;

    filter.Q.value = 0.9;

    // LOUD click layer
    noiseGain.gain.setValueAtTime(
      0.72,
      now
    );

    noiseGain.gain.exponentialRampToValueAtTime(
      0.001,
      now + 0.018
    );

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);

    noise.start(now);

    // Extra soft upper click
    const clickOsc = ctx.createOscillator();
    const clickGain = ctx.createGain();

    clickOsc.type = "triangle";

    clickOsc.frequency.setValueAtTime(
      650 + variation * 4,
      now
    );

    clickOsc.frequency.exponentialRampToValueAtTime(
      320,
      now + 0.025
    );

    clickGain.gain.setValueAtTime(
      0.38,
      now
    );

    clickGain.gain.exponentialRampToValueAtTime(
      0.001,
      now + 0.03
    );

    clickOsc.connect(clickGain);
    clickGain.connect(ctx.destination);

    clickOsc.start(now);
    clickOsc.stop(now + 0.035);

  } catch {}
}
