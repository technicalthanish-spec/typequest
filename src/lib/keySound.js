let audioContext = null;

export function playKeySound() {
  try {
    const AudioContext =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContext) return;

    if (!audioContext) {
      audioContext = new AudioContext();
    }

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = "square";
    oscillator.frequency.value = 220 + Math.random() * 60;

    gain.gain.setValueAtTime(0.9, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      audioContext.currentTime + 0.035
    );

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.035);
  } catch {}
}
