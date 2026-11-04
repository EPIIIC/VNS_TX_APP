import type {Sample} from '../ble/protocol';
import {DisplayFilterChain} from './displayFilters';

export type Spo2Reading={timeUs:number;estimatePct:number|null};
const RATE=100,WINDOW=1000,SETTLE=200;
const mean=(a:readonly number[])=>a.reduce((sum,x)=>sum+x,0)/a.length;
const median=(values:number[])=>{const a=[...values].sort((a,b)=>a-b);return a[Math.floor(a.length/2)];};
function correlation(a:readonly number[],b:readonly number[]) {
  const ma=mean(a),mb=mean(b);let ab=0,aa=0,bb=0;
  for(let i=0;i<a.length;i++){const x=a[i]-ma,y=b[i]-mb;ab+=x*y;aa+=x*x;bb+=y*y;}
  return aa>0&&bb>0?ab/Math.sqrt(aa*bb):0;
}
function smooth(a:readonly number[]) {
  return a.map((_,i)=>mean(a.slice(Math.max(0,i-2),Math.min(a.length,i+3))));
}
/** ADI UG6409 illustrative approximation, NOT a calibrated MAX30102 R curve.
 * It intentionally returns blank outside the prototype's 70–100% range,
 * rather than clamping a poor measurement to a plausible saturation. */
export function ratioToSpo2(ratio:number):number|null {
  const value=104-17*ratio;
  return Number.isFinite(ratio)&&ratio>0&&value>=70&&value<=100?value:null;
}
function estimate(window:readonly Readonly<Sample>[]):number|null {
  const red=window.map(s=>s.a),ir=window.map(s=>s.b);
  const redDc=mean(red),irDc=mean(ir);
  if(Math.min(redDc,irDc)<5000||Math.max(redDc,irDc)>250000)return null;
  // Reject large DC motion/contact changes, not just ADC rail clipping.
  for(const values of [red,ir]) {
    const dc=mean(values);
    if(Math.abs(mean(values.slice(0,200))-mean(values.slice(-200)))/dc>.05)return null;
    if((Math.max(...values)-Math.min(...values))/dc>.3)return null;
  }
  // Fixed analysis preprocessing; independent of the user's display filters.
  const rf=new DisplayFilterChain(RATE,{highPass:.5,lowPass:5}),inf=new DisplayFilterChain(RATE,{highPass:.5,lowPass:5});
  const r=red.map(x=>rf.push(x)).slice(SETTLE),y=ir.map(x=>inf.push(x)).slice(SETTLE);
  if(correlation(r,y)<.9)return null;
  // Require a common, reproducible pulse period in both wavelengths (40–180 bpm).
  const periodic:number[]=[];
  for(let lag=32;lag<=151;lag++)periodic[lag]=correlation(y.slice(lag),y.slice(0,-lag));
  const candidates=Array.from({length:117},(_,i)=>i+33).filter(lag=>periodic[lag]>=periodic[lag-1]&&periodic[lag]>periodic[lag+1]);
  if(!candidates.length)return null;
  const best=Math.max(...candidates.map(lag=>periodic[lag]));
  const period=candidates.find(lag=>periodic[lag]>=Math.max(.7,best-.03));
  if(period===undefined||correlation(r.slice(period),r.slice(0,-period))<.7)return null;
  const distance=Math.round(period*.6),valleys:number[]=[];
  for(let i=1;i<y.length-1;i++)if(y[i]<y[i-1]&&y[i]<=y[i+1]) {
    const last=valleys.at(-1);
    if(last===undefined||i-last>=distance)valleys.push(i);
    else if(y[i]<y[last])valleys[valleys.length-1]=i;
  }
  const sr=smooth(red),si=smooth(ir),ratios:number[]=[];
  const pulse=(values:number[],from:number,to:number)=>{
    let ac=0,dc=0,peak=from;
    for(let i=from+1;i<to;i++){
      const baseline=values[from]+(values[to]-values[from])*(i-from)/(to-from),height=values[i]-baseline;
      if(height>ac){ac=height;dc=baseline;peak=i;}
    }
    return {normalized:dc>0?ac/dc:0,peak};
  };
  for(let i=1;i<valleys.length;i++) {
    const from=valleys[i-1]+SETTLE,to=valleys[i]+SETTLE;
    if(Math.abs(to-from-period)>period*.2)continue;
    const a=pulse(sr,from,to),b=pulse(si,from,to);
    if(a.normalized<.001||b.normalized<.001||a.normalized>.2||b.normalized>.2||Math.abs(a.peak-b.peak)>10)continue;
    ratios.push(a.normalized/b.normalized);
  }
  if(ratios.length<3)return null;
  const ratio=median(ratios),deviation=median(ratios.map(r=>Math.abs(r-ratio)));
  if(deviation/ratio>.1||ratios.filter(r=>Math.abs(r-ratio)<=ratio*.2).length/ratios.length<.8)return null;
  return ratioToSpo2(ratio);
}

/** Red/IR are paired in one FIFO sample. Never align independent arrival times.
 * LED codes are confirmed acquisition metadata; missing/off/changed LEDs cannot
 * contribute to a window. Quality gates are engineering heuristics, not motion
 * compensation or a claim of clinical accuracy. */
export class Spo2Analyzer {
  private samples:Readonly<Sample>[]=[];
  private previous:Readonly<Sample>|undefined;
  private untilUpdate=0;
  private latest:Spo2Reading={timeUs:0,estimatePct:null};
  reset(){this.samples=[];this.previous=undefined;this.untilUpdate=0;this.latest={timeUs:0,estimatePct:null};}
  reading(nowUs:number):Spo2Reading {
    return nowUs<this.latest.timeUs||nowUs-this.latest.timeUs>3e6?{timeUs:nowUs,estimatePct:null}:this.latest;
  }
  push(s:Readonly<Sample>):Spo2Reading|null {
    if(s.type!=='ppg')return null;
    const old=this.previous,leds=[s.ledRed,s.ledIr];
    const usable=s.valid&&leds.every(n=>n!==undefined&&Number.isInteger(n)&&n>0&&n<=127)
      &&[s.a,s.b].every(n=>Number.isFinite(n)&&n>0&&n<260000);
    const continuous=!!old&&!(s.flags&1)&&s.index===((old.index+1)>>>0)
      &&Math.abs(s.timeUs-old.timeUs-10000)<2&&s.ledRed===old.ledRed&&s.ledIr===old.ledIr;
    if(!usable){this.reset();return null;}
    if(!continuous)this.reset();
    this.previous=s;this.samples.push(s);
    if(this.samples.length<WINDOW)return null;
    if(this.samples.length>WINDOW)this.samples.splice(0,this.samples.length-WINDOW);
    if(this.untilUpdate>0){this.untilUpdate--;return null;}
    this.untilUpdate=RATE-1;
    this.latest={timeUs:s.timeUs,estimatePct:estimate(this.samples)};
    return this.latest;
  }
}
