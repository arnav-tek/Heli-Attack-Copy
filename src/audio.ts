/**
 * AudioManager handles synthesized and managed sound effects using the Web Audio API.
 * This avoids dependency on external assets while providing low-latency feedback.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  
  // Looping engine sound
  private engineOsc: OscillatorNode | null = null;
  private engineNoise: ScriptProcessorNode | null = null;
  private engineLfo: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;

  constructor() {
    // Context is created lazily on first interaction
  }

  private init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.5;
    this.masterGain.connect(this.ctx.destination);
    
    this.setupEngine();
  }

  public resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  private setupEngine() {
    if (!this.ctx || !this.masterGain) return;

    // Sub-bass carrier for weight
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 40;
    
    const oscGain = this.ctx.createGain();
    oscGain.gain.value = 0.1;

    // Noise for rotor air movement
    const bufferSize = 4096;
    const noiseNode = this.ctx.createScriptProcessor(bufferSize, 1, 1);
    noiseNode.onaudioprocess = (e) => {
      const output = e.outputBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }
    };
    this.engineNoise = noiseNode;

    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = 400;

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.05;

    // LFO for rotor RPM effect (pulsing)
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 15; // 15 pulses per second
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.4;
    
    lfo.connect(lfoGain);
    
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0; // Start silent

    lfoGain.connect(this.engineGain.gain);

    this.engineOsc.connect(oscGain);
    oscGain.connect(this.engineGain);
    
    noiseNode.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.engineGain);

    this.engineGain.connect(this.masterGain);

    this.engineOsc.start();
    this.engineLfo = lfo;
    lfo.start();
  }

  public updateEngine(speedFactor: number, altitude: number) {
    if (!this.engineOsc || !this.engineGain || !this.ctx) return;
    
    // Pitch shift based on "load" (speed)
    const pitch = 40 + (speedFactor * 30);
    this.engineOsc.frequency.setTargetAtTime(pitch, this.ctx.currentTime, 0.1);
    
    // Volume based on health/proximity (simple for now)
    const targetVol = 0.15 + (speedFactor * 0.1);
    this.engineGain.gain.setTargetAtTime(targetVol, this.ctx.currentTime, 0.2);
  }

  public playLaser(x: number) {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    
    osc.type = 'square';
    osc.frequency.setValueAtTime(400 + (Math.random() * 100), now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.1);
    
    g.gain.setValueAtTime(0.2, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
    
    // Panning based on screen position (crude)
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, x / (window.innerWidth / 2)));

    osc.connect(g);
    g.connect(panner);
    panner.connect(this.masterGain);
    
    osc.start();
    osc.stop(now + 0.1);
  }

  public playMachineGun(x: number) {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    const panner = this.ctx.createStereoPanner();

    osc.type = 'square';
    osc.frequency.setValueAtTime(720 + Math.random() * 90, now);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.045);
    filter.type = 'bandpass';
    filter.frequency.value = 950;
    filter.Q.value = 3.8;
    g.gain.setValueAtTime(0.16, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.055);
    panner.pan.value = Math.max(-1, Math.min(1, x / 170));

    osc.connect(filter);
    filter.connect(g);
    g.connect(panner);
    panner.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  public playShotgun(x: number) {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const length = Math.floor(this.ctx.sampleRate * 0.13);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.3);
    }

    const burst = this.ctx.createBufferSource();
    burst.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2400, now);
    filter.frequency.exponentialRampToValueAtTime(420, now + 0.12);
    g.gain.setValueAtTime(0.38, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.14);
    panner.pan.value = Math.max(-1, Math.min(1, x / 170));

    burst.connect(filter);
    filter.connect(g);
    g.connect(panner);
    panner.connect(this.masterGain);
    burst.start(now);
  }

  public playMissileLaunch() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(92, now);
    osc.frequency.exponentialRampToValueAtTime(340, now + 0.22);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(520, now);
    filter.frequency.exponentialRampToValueAtTime(2200, now + 0.2);
    g.gain.setValueAtTime(0.24, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.26);

    osc.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.28);
  }

  public playRocketLaunch() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(145, now);
    osc.frequency.exponentialRampToValueAtTime(62, now + 0.18);
    g.gain.setValueAtTime(0.28, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.2);

    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.22);
  }

  public playReload() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      const start = now + i * 0.08;
      osc.type = 'square';
      osc.frequency.setValueAtTime(260 + i * 90, start);
      g.gain.setValueAtTime(0.12, start);
      g.gain.exponentialRampToValueAtTime(0.01, start + 0.055);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(start);
      osc.stop(start + 0.06);
    }
  }

  public playPickup() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(1040, now + 0.11);
    g.gain.setValueAtTime(0.16, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.16);

    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.17);
  }

  public playEnemySpawn() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(68, now + 0.22);
    g.gain.setValueAtTime(0.12, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.24);

    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  public playEnemyFire() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(20, now + 0.2);
    
    g.gain.setValueAtTime(0.15, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start();
    osc.stop(now + 0.2);
  }

  public playExplosion(intensity: number = 1.0) {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    
    // Noise burst
    const bufferSize = this.ctx.sampleRate * 0.5;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800 * intensity, now);
    filter.frequency.exponentialRampToValueAtTime(40, now + 0.4);
    
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.4 * intensity, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
    
    noise.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    
    noise.start();
    
    // Low thump
    const osc = this.ctx.createOscillator();
    const g2 = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(60 * intensity, now);
    osc.frequency.exponentialRampToValueAtTime(10, now + 0.3);
    g2.gain.setValueAtTime(0.5 * intensity, now);
    g2.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    
    osc.connect(g2);
    g2.connect(this.masterGain);
    osc.start();
    osc.stop(now + 0.3);
  }

  public playHit() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(100, now);
    osc.frequency.linearRampToValueAtTime(200, now + 0.05);
    
    g.gain.setValueAtTime(0.1, now);
    g.gain.linearRampToValueAtTime(0, now + 0.05);
    
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start();
    osc.stop(now + 0.05);
  }

  public dispose() {
    if (this.engineOsc) {
      this.engineOsc.stop();
      this.engineOsc.disconnect();
      this.engineOsc = null;
    }

    if (this.engineLfo) {
      this.engineLfo.stop();
      this.engineLfo.disconnect();
      this.engineLfo = null;
    }

    if (this.engineNoise) {
      this.engineNoise.disconnect();
      this.engineNoise.onaudioprocess = null;
      this.engineNoise = null;
    }

    this.engineGain?.disconnect();
    this.engineGain = null;
    this.masterGain?.disconnect();
    this.masterGain = null;

    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
  }
}
