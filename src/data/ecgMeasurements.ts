import { countsToMv, type EcgInfo, type Sample } from '../ble/protocol';
import type { DisplayOptions, WavePoint } from './ecgDisplay';
export const sourceName=(source?:number)=>source===0?'Electrodes':source===1?'INTERNAL CAL 0.5 mVpp':source===2?'INTERNAL CAL 1 mVpp':'Unknown source';
export function ecgMetrics(samples:readonly Sample[]) {
  const a=samples.filter(s=>s.type==='ecg'&&Number.isFinite(s.a));
  const min=a.length?Math.min(...a.map(s=>s.a)):null,max=a.length?Math.max(...a.map(s=>s.a)):null;
  const volts=a.map(s=>countsToMv(s.a,s.gain));
  const known=!!a.length&&volts.every(v=>v!==null);
  const mv=volts as number[];
  const source=a.at(-1)?.source;
  const cal=a.filter(s=>s.source===source&&source!==undefined&&source>0&&!(s.flags&8)&&(s.tag===0||s.tag===2));
  const calMv=cal.map(s=>countsToMv(s.a,s.gain));
  const calPp=cal.length>=256&&calMv.every(v=>v!==null)?Math.max(...calMv as number[])-Math.min(...calMv as number[]):null;
  return {min,max,vppMv:known?Math.max(...mv)-Math.min(...mv):null,
    calibrationPpMv:calPp,
    gain:a.at(-1)?.gain,rate:a.at(-1)?.rate,source:a.at(-1)?.source,
    tags:Array.from({length:8},(_,i)=>a.filter(s=>s.tag===i).length),
    invalid:a.filter(s=>!s.valid).length,clipped:a.filter(s=>Math.abs(s.a)>=129024).length};
}
export class EcgAxis {
  private half=0;private unit='';private since:number|undefined;
  range(points:readonly WavePoint[],options:DisplayOptions) {
    const known=points.length>0&&points.every(p=>countsToMv(0,p.sample.gain)!==null);
    const useMv=options.unit==='mv'&&known,unit=useMv?'mV':'Counts';
    const values=points.map(p=>p.a===null?null:useMv?countsToMv(p.a,p.sample.gain):p.a);
    if(options.range!==null && (options.unit==='counts'||known))return {values,half:options.range,unit};
    const peak=Math.max(0,...values.filter((v):v is number=>v!==null).map(Math.abs));
    const minimum=useMv?.025:64;
    const needed=Math.max(minimum,peak*1.2);
    const base=10**Math.floor(Math.log10(needed));
    const target=[1,2,5,10].map(n=>n*base).find(n=>n>=needed)!;
    const now=points.at(-1)?.sample.timeUs??0;
    if(unit!==this.unit||!this.half||target>this.half){this.half=target;this.unit=unit;this.since=undefined;}
    else if(target<this.half*.6){
      if(this.since===undefined||now<this.since)this.since=now;
      if(now-this.since>=3e6){this.half=target;this.since=undefined;}
    } else this.since=undefined;
    return {values,half:this.half,unit};
  }
}
export function registerLog(info:EcgInfo):string {
  const names=['CNFG_GEN(0x10)','CNFG_CAL(0x12)','CNFG_EMUX(0x14)','CNFG_ECG(0x15)'];
  const [gen,cal,mux,ecg]=info.registers,details:string[]=[];
  if(info.validMask&1)details.push(`EN_ECG=${(gen>>>19)&1}; FMSTR=${(gen>>>20)&3}; EN_RBIAS=${(gen>>>4)&3}; RBIAS=${[50,100,200,'reserved'][(gen>>>2)&3]} MOhm; RBIASP/N=${(gen>>>1)&1}/${gen&1}`);
  if(info.validMask&2)details.push(`EN_VCAL=${(cal>>>22)&1}; VMODE=${(cal>>>21)&1}; VMAG=${(cal>>>20)&1}; FCAL=${(cal>>>12)&7}; FIFTY=${(cal>>>11)&1}`);
  if(info.validMask&4)details.push(`OPENP/N=${(mux>>>21)&1}/${(mux>>>20)&1}; CALP/N_SEL=${(mux>>>18)&3}/${(mux>>>16)&3}`);
  if(info.validMask&8)details.push(`RATE_CODE=${(ecg>>>22)&3}; GAIN_CODE=${(ecg>>>16)&3}; DHPF=${(ecg>>>14)&1}; DLPF=${(ecg>>>12)&3}`);
  return [`Actual SPI readback; boot=${info.bootId}; read_device_us=${info.readTimeUs}; publish_device_us=${info.timeUs}`,
    ...names.map((n,i)=>`${n} = ${(info.validMask&(1<<i))?'0x'+info.registers[i].toString(16).padStart(6,'0'):'READ FAILED'}`),
    ...details,
    `gain=${info.gain||'unknown'}; rate=${info.rate||'unknown'}; source=${sourceName(info.source)}; errno=${info.error}`,
    `raw_min=${info.min}; raw_max=${info.max}; samples=${info.samples}; clipped=${info.clipped}`,
    `ETAG[0..7]=${info.tags.join(',')}`].join('\n');
}
export function saveRegisterLog(info:EcgInfo) {
  const url=URL.createObjectURL(new Blob([registerLog(info)+'\n'],{type:'text/plain'}));
  const a=document.createElement('a');a.href=url;a.download=`VNS-TX-registers-${info.bootId}-${info.readTimeUs}.txt`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
