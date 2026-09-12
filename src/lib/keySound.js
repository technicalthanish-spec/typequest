let audioContext = null;

export function playKeySound() {
  try {
    const AudioContext =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContext) return;

    if (!audioContext) {
      audioContext = new AudioContext();
    }

    const ctx = audioContext;
    const now = ctx.currentTime;

    // Short low "thock"
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(
      135 + Math.random() * 25,
      now
    );

    osc.frequency.exponentialRampToValueAtTime(
      75,
      now + 0.045
    );

    gain.gain.setValueAtTime(0.39, now);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      now + 0.055
    );

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.06);

    // Tiny high-frequency key switch click
    const buffer = ctx.createBuffer(
      1,
      Math.floor(ctx.sampleRate * 0.012),
      ctx.sampleRate
    );

    const data = buffer.getChannelData(0);

    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) *
        (1 - i / data.length);
    }

    const noise = ctx.createBufferSource();
    const noiseGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    noise.buffer = buffer;

    filter.type = "highpass";
    filter.frequency.value = 1800;

    noiseGain.gain.setValueAtTime(0.25, now);
    noiseGain.gain.exponentialRampToValueAtTime(
      0.001,
      now + 0.012
    );

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);

    noise.start(now);
  } catch {}
}
