/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  createWorketFromSrc,
  registeredWorklets,
} from './audioworklet-registry';

export class AudioStreamer {
  private sampleRate: number = 24000;
  private bufferSize: number = 7680;
  // A queue of audio buffers to be played. Each buffer is a Float32Array.
  private audioQueue: Float32Array[] = [];
  private isPlaying: boolean = false;
  // Indicates if the stream has finished playing, e.g., interrupted.
  private isStreamComplete: boolean = false;
  private checkInterval: number | null = null;
  private scheduledTime: number = 0;
  private initialBufferTime: number = 0.1; //0.1 // 100ms initial buffer
  
  // Web Audio API nodes. source => gain => destination
  public gainNode: GainNode;
  public source: AudioBufferSourceNode;
  
  // Track active sources to stop them individually without destroying the graph
  private activeSources: Set<AudioBufferSourceNode> = new Set();
  
  private endOfQueueAudioSource: AudioBufferSourceNode | null = null;
  private keepAliveOscillator: OscillatorNode | null = null;

  // Ambient Pad Components
  private padGain: GainNode | null = null;
  private padOscillators: OscillatorNode[] = [];
  private padFilter: BiquadFilterNode | null = null;

  public onComplete = () => {};

  constructor(public context: AudioContext) {
    this.gainNode = this.context.createGain();
    this.source = this.context.createBufferSource();
    this.gainNode.connect(this.context.destination);
    this.addPCM16 = this.addPCM16.bind(this);
    
    // Start Keep-Alive to prevent background suspension
    this.startKeepAlive();
  }

  private startKeepAlive() {
    // Plays a silent/inaudible sound to keep the audio context active in background
    try {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      
      oscillator.type = 'sine';
      oscillator.frequency.value = 1; // 1 Hz (inaudible)
      
      // Extremely low gain, just enough to be "active" but effectively silent
      gain.gain.value = 0.001; 
      
      oscillator.connect(gain);
      gain.connect(this.context.destination);
      
      oscillator.start();
      this.keepAliveOscillator = oscillator;
    } catch (e) {
      console.warn('Failed to start keep-alive oscillator', e);
    }
  }

  // --- Ambient Pad Logic ---
  setPadVolume(volume: number) {
    if (this.padGain) {
      // Ramp to new volume for smooth transition
      this.padGain.gain.linearRampToValueAtTime(volume, this.context.currentTime + 0.5);
    }
  }

  startPad(volume: number) {
    if (this.padGain) return; // Already running

    const now = this.context.currentTime;
    
    // Master gain for the pad
    this.padGain = this.context.createGain();
    this.padGain.gain.value = 0; // Start silent for fade-in
    
    // Lowpass filter to make it "warm" and non-intrusive
    this.padFilter = this.context.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 400; // Muffled, warm sound
    this.padFilter.Q.value = 1;

    // Chain: Oscs -> Filter -> PadGain -> MainGain (so muting works)
    this.padFilter.connect(this.padGain);
    this.padGain.connect(this.gainNode);

    // D Major / D drone (D3, A3, D4) - Neutral, hopeful, authoritative
    const freqs = [146.83, 220.00, 293.66]; 
    
    freqs.forEach(f => {
      const osc = this.context.createOscillator();
      osc.type = 'triangle'; // Triangle is softer than saw, richer than sine
      osc.frequency.value = f;
      // Detune slightly for "chorus" effect
      osc.detune.value = (Math.random() * 10) - 5; 
      osc.connect(this.padFilter!);
      osc.start();
      this.padOscillators.push(osc);
    });

    // Fade in over 2 seconds
    this.padGain.gain.linearRampToValueAtTime(volume, now + 2);
  }

  stopPad() {
    if (!this.padGain) return;
    const now = this.context.currentTime;
    
    // Fade out
    this.padGain.gain.linearRampToValueAtTime(0, now + 2);
    
    setTimeout(() => {
      this.padOscillators.forEach(o => o.stop());
      this.padOscillators = [];
      this.padGain?.disconnect();
      this.padFilter?.disconnect();
      this.padGain = null;
      this.padFilter = null;
    }, 2000);
  }
  // -------------------------

  async addWorklet<T extends (d: any) => void>(
    workletName: string,
    workletSrc: string,
    handler: T
  ): Promise<this> {
    let workletsRecord = registeredWorklets.get(this.context);
    if (workletsRecord && workletsRecord[workletName]) {
      // the worklet already exists on this context
      // add the new handler to it
      workletsRecord[workletName].handlers.push(handler);
      return Promise.resolve(this);
    }

    if (!workletsRecord) {
      registeredWorklets.set(this.context, {});
      workletsRecord = registeredWorklets.get(this.context)!;
    }

    // create new record to fill in as becomes available
    workletsRecord[workletName] = { handlers: [handler] };

    const src = createWorketFromSrc(workletName, workletSrc);
    await this.context.audioWorklet.addModule(src);
    const worklet = new AudioWorkletNode(this.context, workletName);

    //add the node into the map
    workletsRecord[workletName].node = worklet;

    return this;
  }

  private _processPCM16Chunk(chunk: Uint8Array): Float32Array {
    const float32Array = new Float32Array(chunk.length / 2);
    const dataView = new DataView(chunk.buffer);

    for (let i = 0; i < chunk.length / 2; i++) {
      try {
        const int16 = dataView.getInt16(i * 2, true);
        float32Array[i] = int16 / 32768;
      } catch (e) {
        console.error(e);
      }
    }
    return float32Array;
  }

  addPCM16(chunk: Uint8Array) {
    this.isStreamComplete = false;
    let processingBuffer = this._processPCM16Chunk(chunk);
    while (processingBuffer.length >= this.bufferSize) {
      const buffer = processingBuffer.slice(0, this.bufferSize);
      this.audioQueue.push(buffer);
      processingBuffer = processingBuffer.slice(this.bufferSize);
    }
    if (processingBuffer.length > 0) {
      this.audioQueue.push(processingBuffer);
    }
    if (!this.isPlaying) {
      this.isPlaying = true;
      this.scheduledTime = this.context.currentTime + this.initialBufferTime;
      this.scheduleNextBuffer();
    }
  }

  private createAudioBuffer(audioData: Float32Array): AudioBuffer {
    const audioBuffer = this.context.createBuffer(
      1,
      audioData.length,
      this.sampleRate
    );
    audioBuffer.getChannelData(0).set(audioData);
    return audioBuffer;
  }

  private scheduleNextBuffer() {
    const SCHEDULE_AHEAD_TIME = 0.2;

    while (
      this.audioQueue.length > 0 &&
      this.scheduledTime < this.context.currentTime + SCHEDULE_AHEAD_TIME
    ) {
      const audioData = this.audioQueue.shift()!;
      const audioBuffer = this.createAudioBuffer(audioData);
      const source = this.context.createBufferSource();

      // Track this source
      this.activeSources.add(source);

      if (this.audioQueue.length === 0) {
        if (this.endOfQueueAudioSource) {
          this.endOfQueueAudioSource.onended = null;
        }
        this.endOfQueueAudioSource = source;
        source.onended = () => {
          this.activeSources.delete(source);
          if (
            !this.audioQueue.length &&
            this.endOfQueueAudioSource === source
          ) {
            this.endOfQueueAudioSource = null;
            this.onComplete();
          }
        };
      } else {
        // Standard cleanup for non-end chunks
        source.onended = () => {
          this.activeSources.delete(source);
        };
      }

      source.buffer = audioBuffer;
      source.connect(this.gainNode);

      const worklets = registeredWorklets.get(this.context);

      if (worklets) {
        Object.entries(worklets).forEach(([workletName, graph]) => {
          const { node, handlers } = graph;
          if (node) {
            source.connect(node);
            node.port.onmessage = function (ev: MessageEvent) {
              handlers.forEach(handler => {
                handler.call(node.port, ev);
              });
            };
            node.connect(this.context.destination);
          }
        });
      }
      
      const startTime = Math.max(this.scheduledTime, this.context.currentTime);
      source.start(startTime);
      this.scheduledTime = startTime + audioBuffer.duration;
    }

    if (this.audioQueue.length === 0) {
      if (this.isStreamComplete) {
        this.isPlaying = false;
        if (this.checkInterval) {
          clearInterval(this.checkInterval);
          this.checkInterval = null;
        }
      } else {
        if (!this.checkInterval) {
          this.checkInterval = window.setInterval(() => {
            if (this.audioQueue.length > 0) {
              this.scheduleNextBuffer();
            }
          }, 100) as unknown as number;
        }
      }
    } else {
      const nextCheckTime =
        (this.scheduledTime - this.context.currentTime) * 1000;
      setTimeout(
        () => this.scheduleNextBuffer(),
        Math.max(0, nextCheckTime - 50)
      );
    }
  }

  stop() {
    this.isPlaying = false;
    this.isStreamComplete = true;
    this.audioQueue = [];
    
    // Stop all currently playing sources smoothly
    this.activeSources.forEach(source => {
      try {
        source.stop();
      } catch (e) {
        // Ignore errors if source is already stopped
      }
    });
    this.activeSources.clear();

    // Reset scheduling time
    this.scheduledTime = this.context.currentTime;
    
    // NOTE: We do NOT call stopPad() here anymore. 
    // The background ambience should persist during speech interruptions.

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    // We do NOT disconnect the gainNode anymore to prevent breaking the graph
  }

  async resume() {
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
    this.isStreamComplete = false;
    this.scheduledTime = this.context.currentTime + this.initialBufferTime;
    this.gainNode.gain.setValueAtTime(1, this.context.currentTime);
  }

  complete() {
    this.isStreamComplete = true;
    this.onComplete();
  }
}