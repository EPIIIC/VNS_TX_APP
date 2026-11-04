import type { Sample } from '../ble/protocol';
import {DisplayFilterChain} from './displayFilters';

/** Display-only points keep their original sample for quality and time checks.
 * Neither this module nor the renderer writes back into the recording. */
export type WavePoint = {
  sample: Readonly<Sample>;
  a: number|null;
  b: number|null;
  gap: boolean;
  mode: 'filtered'|'raw'|'settling';
};

export const ECG_FILTER_LABEL='User-selected display filters';
export const ECG_FILTER_CONFIG=Object.freeze({sampleRate:256,highPassHz:0,sensorHighPassHz:.5,lowPassHz:40,lowPassOrder:2,notchHz:50,notchQ:10});
export type DisplayOptions={mode:'raw'|'monitor';notch:boolean;unit:'mv'|'counts';range:number|null;highPass?:number|null;lowPass?:number|null};
export const DEFAULT_DISPLAY:DisplayOptions={mode:'monitor',notch:true,unit:'mv',range:1,highPass:null,lowPass:40};
export function ecgFilterLabel(options:DisplayOptions) {
  if(options.mode==='raw')return 'Raw sensor · GUI filters off';
  return `GUI HP ${options.highPass??'off'}${options.highPass?' Hz':''} · LP ${options.lowPass===undefined?40:options.lowPass??'off'}${options.lowPass===null?'':' Hz'} · ${options.notch?'50 Hz notch':'Notch off'}`;
}
const RATE=ECG_FILTER_CONFIG.sampleRate, WARMUP=RATE;

export class EcgDisplay {
  private previous:Readonly<Sample>|undefined;
  private count=0;
  private chain:DisplayFilterChain;
  constructor(private options:Pick<DisplayOptions,'mode'|'notch'|'highPass'|'lowPass'>={mode:'monitor',notch:true}) {
    this.chain=new DisplayFilterChain(RATE,{highPass:options.highPass,
      lowPass:options.lowPass===undefined?40:options.lowPass,notch:options.notch?50:null});
  }

  reset() { this.previous=undefined;this.count=0;this.clearFilter(); }
  private clearFilter() {this.count=0;this.chain.reset();}

  push(sample:Readonly<Sample>):WavePoint {
    const old=this.previous;
    const continuous=!!old && !(sample.flags&1) && sample.index===((old.index+1)>>>0)
      && Math.abs(sample.timeUs-old.timeUs-1e6/RATE)<2;
    // A quality warning (e.g. DC lead-off) does not remove the real AC input.
    // Keep filtering it for a clearly labelled, unverified diagnostic trace.
    // Hard artifacts still reset state; never turn the source valid flag on.
    const good=(sample.tag===0||sample.tag===2) && Number.isFinite(sample.a)
      && Math.abs(sample.a)<129024;
    this.previous=sample;
    // Raw is exactly the sensor output; internal calibration always bypasses
    // additional GUI filters. No gain or waveform values are invented.
    if(this.options.mode==='raw'||!this.chain.active||(sample.flags&16)||(sample.source!==undefined&&sample.source>0)) {
      return {sample,a:sample.a,b:null,gap:!continuous,mode:'raw'};
    }
    if(!good) {
      this.clearFilter();
      // Preserve the real invalid input as a diagnostic trace. Never
      // pass it through the filters or use it to choose the ECG vertical scale.
      return {sample,a:Number.isFinite(sample.a)?sample.a:null,b:null,gap:!continuous,mode:'raw'};
    }
    if(!continuous)this.clearFilter();
    const y=this.chain.push(sample.a);
    this.count++;
    const ready=this.count>WARMUP;
    return {sample,a:ready?y:sample.a,b:null,gap:!continuous||this.count===WARMUP+1,
      mode:ready?'filtered':'settling'};
  }
}

export function ppgPoint(sample:Readonly<Sample>):WavePoint {
  return {sample,a:sample.valid?sample.a:null,b:sample.valid?sample.b:null,
    gap:!!(sample.flags&1),mode:'raw'};
}

/** Fixed zero center and power-of-two steps. After five seconds of quiet input,
 * at most one inward step every two device seconds restores visibility after
 * motion artifacts. Repeated redraws cannot advance these timers. */
export class StableEcgScale {
  private half=4096;
  private unverified:StableEcgScale|undefined;
  private quietSince:number|undefined;
  private lastShrink:number|undefined;
  constructor(private readonly includeUnverified=false) {}
  pause() {this.quietSince=undefined;this.lastShrink=undefined;}
  forQuality(verified:boolean):StableEcgScale {
    if(verified){this.unverified?.pause();return this;}
    this.pause();return this.unverified??=new StableEcgScale(true);
  }
  update(points:readonly WavePoint[]):number {
    const magnitudes=points.filter(p=>p.mode==='filtered'&&p.a!==null&&(this.includeUnverified||p.sample.valid))
      .map(p=>Math.abs(p.a!)).sort((a,b)=>a-b);
    if(magnitudes.length>=64) {
      const robust=magnitudes[Math.floor((magnitudes.length-1)*.98)];
      if(robust>this.half*.85) {
        while(robust>this.half*.85 && this.half<262144)this.half*=2;
        this.pause();
      } else if(robust<this.half*.2 && magnitudes.length>=512) {
        const now=points.at(-1)!.sample.timeUs;
        if(this.quietSince===undefined||now<this.quietSince)this.quietSince=now;
        if(now-this.quietSince>=5e6 && (this.lastShrink===undefined||now-this.lastShrink>=2e6)) {
          this.half=Math.max(256,this.half/2);this.lastShrink=now;
        }
      } else this.pause();
    }
    return this.half;
  }
}

/** Warmup/hard artifacts use a full-range raw view. Soft quality warnings keep
 * a filtered unverified view with its own scale. Never mix raw/filtered axes. */
export function ecgView(points:readonly WavePoint[],scale:StableEcgScale) {
  const filtered=points.at(-1)?.mode==='filtered';
  if(filtered) return {mode:'filtered' as const,half:scale.forQuality(points.at(-1)!.sample.valid).update(points),
    points:points.map(p=>p.mode==='filtered'?p:{...p,a:null})};
  scale.pause();
  return {mode:'raw' as const,half:131072,points:points.map(p=>({...p,
    a:Number.isFinite(p.sample.a)?p.sample.a:null,mode:'raw' as const}))};
}
