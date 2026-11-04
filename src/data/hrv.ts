import {countsToMv,type Sample} from '../ble/protocol';
import {DisplayFilterChain} from './displayFilters';

export type TrendPoint={timeUs:number;value:number|null;gap?:boolean};
export type HrvReading={timeUs:number;heartRate:number|null;rrMs:number|null;rmssdMs:number|null};
type FilterPoint={timeUs:number;raw:number;band:number;slope:number};
type Candidate={timeUs:number;energy:number;amplitude:number;slope:number};
type Interval={timeUs:number;ms:number;accepted:boolean};
const RATE=256,PERIOD=1e6/RATE;
const median=(values:number[])=>{const a=[...values].sort((a,b)=>a-b);return a.length?a[Math.floor(a.length/2)]:0;};

/** Only adjacent accepted intervals contribute: never bridge excluded beats. */
export function rmssd(intervals:readonly {ms:number;accepted:boolean}[]):number|null {
  let sum=0,count=0;
  for(let i=1;i<intervals.length;i++)if(intervals[i].accepted&&intervals[i-1].accepted){sum+=(intervals[i].ms-intervals[i-1].ms)**2;count++;}
  return count?Math.sqrt(sum/count):null;
}

/** Streaming Pan–Tompkins-inspired QRS detector, adapted to 256 SPS.
 * Research/prototype estimate, NOT a validated medical device algorithm.
 * Uses raw device-timed ECG independently of display settings. RR screening
 * cannot certify sinus/NN beats; no ectopic classification is claimed. */
export class HrvAnalyzer {
  private filter=new DisplayFilterChain(RATE,{highPass:5,lowPass:18,notch:50});
  private previous:Readonly<Sample>|undefined;
  private points:FilterPoint[]=[];
  private energies:number[]=[];private energySum=0;
  private envelope:number[]=[];
  private count=0;private learning:Candidate[]=[];private pending:Candidate|undefined;
  private signal=0;private noise=0;private signalAmplitude=0;private noiseAmplitude=0;
  private beat:Candidate|undefined;private intervals:Interval[]=[];private streak=0;
  private lastGood:number|undefined;
  private latest:HrvReading={timeUs:0,heartRate:null,rrMs:null,rmssdMs:null};

  reset() {
    this.filter.reset();this.previous=undefined;this.points=[];this.energies=[];this.energySum=0;
    this.envelope=[];this.count=0;this.learning=[];this.pending=undefined;
    this.signal=this.noise=this.signalAmplitude=this.noiseAmplitude=0;
    this.beat=undefined;this.intervals=[];this.streak=0;this.lastGood=undefined;
    this.latest={timeUs:0,heartRate:null,rrMs:null,rmssdMs:null};
  }
  reading(nowUs:number):HrvReading {
    return this.lastGood===undefined||nowUs-this.lastGood>3e6||nowUs<this.lastGood?
      {timeUs:nowUs,heartRate:null,rrMs:null,rmssdMs:null}:this.latest;
  }
  push(sample:Readonly<Sample>):HrvReading|null {
    if(sample.type!=='ecg')return null;
    const mv=countsToMv(sample.a,sample.gain),old=this.previous;
    const usable=sample.valid&&sample.source===0&&sample.rate===RATE&&mv!==null&&Number.isFinite(mv)
      &&(sample.tag===0||sample.tag===2)&&Math.abs(sample.a)<129024&&!(sample.flags&16);
    const continuous=!!old&&!(sample.flags&1)&&sample.gain===old.gain
      &&sample.index===((old.index+1)>>>0)&&Math.abs(sample.timeUs-old.timeUs-PERIOD)<2;
    if(!usable){this.reset();return null;}
    if(!continuous)this.reset();
    this.previous=sample;this.count++;
    const band=this.filter.push(mv!);
    const history=this.points;
    const slope=history.length>=4?(2*band+history.at(-1)!.band-history.at(-3)!.band-2*history.at(-4)!.band)/8:0;
    history.push({timeUs:sample.timeUs,raw:mv!,band,slope:Math.abs(slope)});
    while(history.length>RATE)history.shift();
    this.energies.push(slope*slope);this.energySum+=slope*slope;
    if(this.energies.length>38)this.energySum-=this.energies.shift()!;
    const energy=this.energySum/38;
    this.envelope.push(energy);if(this.envelope.length>3)this.envelope.shift();
    if(this.envelope.length===3&&this.envelope[1]>this.envelope[0]&&this.envelope[1]>=this.envelope[2]) {
      const local=history.filter(p=>p.timeUs>=sample.timeUs-200000);
      const strongest=local.reduce((a,b)=>Math.abs(a.band)>Math.abs(b.band)?a:b);
      const baseline=local.reduce((sum,p)=>sum+p.raw,0)/local.length;
      const near=local.filter(p=>Math.abs(p.timeUs-strongest.timeUs)<=40000);
      const peak=near.reduce((a,b)=>Math.abs(a.raw-baseline)>Math.abs(b.raw-baseline)?a:b);
      const candidate={timeUs:peak.timeUs,energy:this.envelope[1],amplitude:Math.abs(strongest.band),slope:Math.max(...local.map(p=>p.slope))};
      // Consolidate multiple integration maxima from the same QRS complex.
      if(!this.pending||candidate.energy>this.pending.energy)this.pending=candidate;
    }
    if(this.pending&&sample.timeUs-this.pending.timeUs>300000) {
      const candidate=this.pending;this.pending=undefined;
      if(this.count<=RATE*2){this.learning.push(candidate);return null;}
      if(!this.signal) {
        const peaks=this.learning.length?this.learning:[candidate];
        this.signal=Math.max(...peaks.map(p=>p.energy))*.5;
        this.noise=median(peaks.map(p=>p.energy))*.25;
        this.signalAmplitude=Math.max(...peaks.map(p=>p.amplitude))*.5;
        this.noiseAmplitude=median(peaks.map(p=>p.amplitude))*.25;this.learning=[];
      }
      return this.classify(candidate);
    }
    // A missing beat invalidates the live value instead of holding it forever.
    if(this.lastGood!==undefined&&sample.timeUs-this.lastGood>3e6)this.latest={timeUs:sample.timeUs,heartRate:null,rrMs:null,rmssdMs:null};
    return null;
  }
  private classify(p:Candidate):HrvReading|null {
    const threshold=this.noise+.25*(this.signal-this.noise);
    const amplitudeThreshold=this.noiseAmplitude+.25*(this.signalAmplitude-this.noiseAmplitude);
    const dt=this.beat?(p.timeUs-this.beat.timeUs)/1000:Infinity;
    const qrs=p.energy>Math.max(1e-9,threshold)&&p.amplitude>Math.max(.02,amplitudeThreshold)
      &&dt>=250&&!(dt<360&&p.slope<.5*this.beat!.slope);
    if(!qrs) {
      // Refractory maxima belong to the same beat, not to the noise population.
      if(dt>=250){this.noise=.125*p.energy+.875*this.noise;this.noiseAmplitude=.125*p.amplitude+.875*this.noiseAmplitude;}
      return null;
    }
    this.signal=.125*p.energy+.875*this.signal;this.signalAmplitude=.125*p.amplitude+.875*this.signalAmplitude;
    const previous=this.beat;this.beat=p;
    if(!previous)return null;
    const recent=this.intervals.filter(x=>x.accepted).slice(-8).map(x=>x.ms),typical=median(recent);
    const accepted=dt>=300&&dt<=2000&&(!typical||Math.abs(dt-typical)<=typical*.2)
      &&p.energy>this.noise*3&&p.amplitude>this.noiseAmplitude*2;
    this.intervals.push({timeUs:p.timeUs,ms:dt,accepted});
    this.intervals=this.intervals.filter(x=>x.timeUs>=p.timeUs-60e6);
    this.streak=accepted?this.streak+1:0;
    const valid=this.intervals.filter(x=>x.accepted);
    const covered=this.intervals.length>1?p.timeUs-this.intervals[0].timeUs:0;
    const ready=this.streak>=3&&valid.length>=20&&covered>=30e6&&valid.length/this.intervals.length>=.9;
    const heartReady=this.streak>=3;
    if(heartReady)this.lastGood=p.timeUs;
    else this.lastGood=undefined;
    this.latest={timeUs:p.timeUs,heartRate:heartReady?60000/median(valid.slice(-5).map(x=>x.ms)):null,
      rrMs:heartReady?dt:null,rmssdMs:ready?rmssd(this.intervals):null};
    return this.latest;
  }
}
