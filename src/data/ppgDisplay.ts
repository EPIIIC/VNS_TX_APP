import type {Sample} from '../ble/protocol';
import {ppgPoint,type WavePoint} from './ecgDisplay';
import {DisplayFilterChain} from './displayFilters';
export type PpgDisplayOptions={mode:'raw'|'filtered';highPass:number|null;lowPass:number|null};
export const DEFAULT_PPG_DISPLAY:PpgDisplayOptions={mode:'filtered',highPass:.5,lowPass:3};
export function ppgFilterLabel(options:PpgDisplayOptions) {
  if(options.mode==='raw'||(options.highPass===null&&options.lowPass===null))return 'Raw counts · GUI filters off';
  return `GUI HP ${options.highPass??'off'}${options.highPass?' Hz':''} · LP ${options.lowPass??'off'}${options.lowPass?' Hz':''} · Counts`;
}
export class PpgDisplay {
  private red:DisplayFilterChain;private ir:DisplayFilterChain;
  private previous:Readonly<Sample>|undefined;private count=0;
  constructor(private options:PpgDisplayOptions=DEFAULT_PPG_DISPLAY) {
    this.red=new DisplayFilterChain(100,options);this.ir=new DisplayFilterChain(100,options);
  }
  reset(){this.previous=undefined;this.count=0;this.red.reset();this.ir.reset();}
  push(sample:Readonly<Sample>):WavePoint {
    const old=this.previous,continuous=!!old&&!(sample.flags&1)&&sample.index===((old.index+1)>>>0)
      &&Math.abs(sample.timeUs-old.timeUs-10000)<2;
    if(!continuous||!sample.valid||!Number.isFinite(sample.a)||!Number.isFinite(sample.b))this.reset();
    this.previous=sample;
    const raw={...ppgPoint(sample),gap:!continuous,
      a:sample.valid&&Number.isFinite(sample.a)?sample.a:null,b:sample.valid&&Number.isFinite(sample.b)?sample.b:null};
    if(this.options.mode==='raw'||!this.red.active)return raw;
    if(!sample.valid||!Number.isFinite(sample.a)||!Number.isFinite(sample.b))return {...raw,a:null,b:null};
    const a=this.red.push(sample.a),b=this.ir.push(sample.b);this.count++;
    return this.count<=200?{...raw,mode:'settling'}:{sample,a,b,mode:'filtered',gap:!continuous||this.count===201};
  }
}
/** Never combine warmup/raw DC values and filtered AC values on one scale. */
export function ppgView(points:readonly WavePoint[]) {
  return points.at(-1)?.mode==='filtered'?points.map(p=>p.mode==='filtered'?p:{...p,a:null,b:null}):
    points.map(p=>({...p,a:p.sample.valid&&Number.isFinite(p.sample.a)?p.sample.a:null,b:p.sample.valid&&Number.isFinite(p.sample.b)?p.sample.b:null}));
}
