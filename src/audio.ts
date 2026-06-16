/**
 * AudioManager handles synthesized and managed sound effects using the Web Audio API.
 * This avoids dependency on external assets while providing low-latency feedback.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  
  // Looping engine sound
  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineNoise: ScriptProcessorNode | null = null;
  private engineLfo: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;

  // Background Music Sequencer
  private musicInterval: any = null;
  private musicStep = 0;
  
  private lastExplosionTime = 0;

  // Persisted mix state (applied whenever the context exists)
  private masterVolume = 0.5;
  private muted = false;

  constructor() {
    // Context is created lazily on first interaction
  }

  private init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : this.masterVolume;
    this.masterGain.connect(this.ctx.destination);
    
    this.setupEngine();
  }

  /** Sets the master volume (0..1). Takes effect immediately and persists across context creation. */
  public setMasterVolume(volume: number) {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    this.applyMix();
  }

  /** Mutes or unmutes all audio without losing the configured volume level. */
  public setMuted(muted: boolean) {
    this.muted = muted;
    this.applyMix();
  }

  private applyMix() {
    if (!this.ctx || !this.masterGain) return;
    const target = this.muted ? 0 : this.masterVolume;
    this.masterGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.03);
  }

  public resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  private setupEngine() {
    if (!this.ctx || !this.masterGain) return;

    // Sub-bass carrier for weight (chopping sound)
    this.engineOsc = this.ctx.createOscillator();
    this.engineOsc.type = 'triangle';
    this.engineOsc.frequency.value = 38;
    
    const oscGain = this.ctx.createGain();
    oscGain.gain.value = 0.14;

    // Secondary mid-bass hum carrier (turbine hum)
    this.engineOsc2 = this.ctx.createOscillator();
    this.engineOsc2.type = 'triangle';
    this.engineOsc2.frequency.value = 76;
    
    const oscGain2 = this.ctx.createGain();
    oscGain2.gain.value = 0.08;

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
    noiseFilter.frequency.value = 350;

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.07;

    // LFO for rotor RPM effect (pulsing)
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 6.0; // 6 pulses per second base
    
    // Pitch modulation for engineOsc (gives cyclic Doppler blade pitch sweep!)
    const lfoPitchGain = this.ctx.createGain();
    lfoPitchGain.gain.value = 5.0;
    lfo.connect(lfoPitchGain);
    lfoPitchGain.connect(this.engineOsc.frequency);

    // Pitch modulation for engineOsc2
    const lfoPitchGain2 = this.ctx.createGain();
    lfoPitchGain2.gain.value = 3.0;
    lfo.connect(lfoPitchGain2);
    lfoPitchGain2.connect(this.engineOsc2.frequency);

    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.06;
    lfo.connect(lfoGain);
    
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0; // Start silent

    lfoGain.connect(this.engineGain.gain);

    this.engineOsc.connect(oscGain);
    oscGain.connect(this.engineGain);

    this.engineOsc2.connect(oscGain2);
    oscGain2.connect(this.engineGain);
    
    noiseNode.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(this.engineGain);

    this.engineGain.connect(this.masterGain);

    this.engineOsc.start();
    this.engineOsc2.start();
    this.engineLfo = lfo;
    lfo.start();
  }

  public updateEngine(speedFactor: number, altitude: number) {
    if (!this.engineOsc || !this.engineOsc2 || !this.engineGain || !this.engineLfo || !this.ctx) return;
    
    // Pitch scales with speed (load)
    const pitch1 = 38 + (speedFactor * 16);
    const pitch2 = 76 + (speedFactor * 32);
    this.engineOsc.frequency.setTargetAtTime(pitch1, this.ctx.currentTime, 0.1);
    this.engineOsc2.frequency.setTargetAtTime(pitch2, this.ctx.currentTime, 0.1);

    // LFO frequency (rotor spin rate) increases dynamically under load
    const lfoSpeed = 6.0 + (speedFactor * 3.0);
    this.engineLfo.frequency.setTargetAtTime(lfoSpeed, this.ctx.currentTime, 0.12);
    
    // Volume scales up as speed increases
    const targetVol = 0.14 + (speedFactor * 0.12);
    this.engineGain.gain.setTargetAtTime(targetVol, this.ctx.currentTime, 0.15);
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
    
    g.gain.setValueAtTime(0.08, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start();
    osc.stop(now + 0.2);
  }

  public playExplosion(intensity: number = 1.0) {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    if (now - this.lastExplosionTime < 0.1) return;
    this.lastExplosionTime = now;
    
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

  public playLockBeep() {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1400, now);
    
    g.gain.setValueAtTime(0.12, now);
    g.gain.exponentialRampToValueAtTime(0.01, now + 0.075);
    
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  public startMusic() {
    if (this.musicInterval) return;
    this.resume();
    this.musicStep = 0;
    this.musicInterval = window.setInterval(this.musicTick, 115);
  }

  public stopMusic() {
    if (this.musicInterval) {
      window.clearInterval(this.musicInterval);
      this.musicInterval = null;
    }
  }

  private musicTick = () => {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    
    // Bass note conversion (MIDI)
    const bassMidi = [40, 40, 40, 40, 43, 43, 45, 45, 40, 40, 40, 40, 38, 38, 35, 37][this.musicStep % 16];
    if (bassMidi > 0) {
      const freq = 440 * Math.pow(2, (bassMidi - 69) / 12);
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, now);
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(180, now);
      
      g.gain.setValueAtTime(0.05, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      
      osc.connect(filter);
      filter.connect(g);
      g.connect(this.masterGain);
      
      osc.start(now);
      osc.stop(now + 0.2);
    }
    
    // Lead melody note conversion
    const melodyMidi = [
      64, 0, 67, 0, 69, 0, 71, 72, 71, 0, 69, 0, 67, 0, 64, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      64, 67, 69, 71, 72, 74, 76, 0, 76, 74, 72, 71, 69, 67, 64, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ][this.musicStep % 64];
    
    if (melodyMidi > 0) {
      const freq = 440 * Math.pow(2, (melodyMidi - 69) / 12);
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      
      g.gain.setValueAtTime(0.035, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      
      osc.connect(g);
      g.connect(this.masterGain);
      
      osc.start(now);
      osc.stop(now + 0.3);
    }
    
    this.musicStep++;
  };

  public dispose() {
    this.stopMusic();

    if (this.engineOsc) {
      this.engineOsc.stop();
      this.engineOsc.disconnect();
      this.engineOsc = null;
    }

    if (this.engineOsc2) {
      this.engineOsc2.stop();
      this.engineOsc2.disconnect();
      this.engineOsc2 = null;
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
