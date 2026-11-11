import {countsToMv,type Sample} from '../ble/protocol';
import {DEFAULT_DISPLAY,EcgDisplay,type DisplayOptions} from './ecgDisplay';
import {DEFAULT_PPG_DISPLAY,PpgDisplay,type PpgDisplayOptions} from './ppgDisplay';
import {HrvAnalyzer,type HrvReading} from './hrv';
import {Spo2Analyzer} from './spo2';
export type Row = Sample & { bootId: number; connection: number };
export type ExportOptions={ecg:DisplayOptions;ppg:PpgDisplayOptions};
const columns=['session','ecg_time_us','ecg_sample_index','ecg_filtered_mv','ecg_heart_rate_bpm','ecg_hrv_rmssd_ms',
  'ppg_time_us','ppg_sample_index','ppg_ir_filtered_counts','ppg_spo2_estimate_pct',
  'temperature_time_us','temperature_surface_c','temperature_ambient_c'];
const cell=(v:unknown)=>{
  if(v===undefined||v===null||(typeof v==='number'&&!Number.isFinite(v)))return '';
  const s=String(v);return /[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
};
/** Recompute both display filters from the complete raw record using the
 * selection at export time. Never mutate stored measurements or retime them. */
export function csv(rows:readonly Row[],options:ExportOptions={ecg:DEFAULT_DISPLAY,ppg:DEFAULT_PPG_DISPLAY}):string {
  const sessions=new Map<string,number>();
  const ordered=rows.filter(r=>r.type!=='rr').map(r=>{
    const key=`${r.bootId}:${r.connection}`;
    if(!sessions.has(key))sessions.set(key,sessions.size+1);
    return {r,session:sessions.get(key)!};
  }).sort((a,b)=>a.session-b.session||a.r.timeUs-b.r.timeUs);
  let session=0,ecg=new EcgDisplay(options.ecg),ppg=new PpgDisplay(options.ppg);
  const hrv=new HrvAnalyzer(),spo2=new Spo2Analyzer(),beats=new Map<string,HrvReading>();
  const filteredEcg=new Map<string,number>();
  // A centred wavelet window returns an earlier sample. Index the result by
  // that sample's device time/index so filtered CSV values remain aligned.
  for(const entry of ordered) {
    if(entry.session!==session){session=entry.session;ecg.reset();}
    if(entry.r.type==='ecg') {
      const point=ecg.push(entry.r);
      if(point.mode==='filtered'&&point.a!==null)
        filteredEcg.set(`${session}:${point.sample.index}:${point.sample.timeUs}`,point.a);
    }
  }
  session=0;
  // QRS decisions arrive ~0.3 s after the peak. First analyze the record, then
  // attach each result to its ORIGINAL peak sample, never its detection time.
  for(const entry of ordered) {
    if(entry.session!==session){session=entry.session;hrv.reset();}
    if(entry.r.type==='ecg') {
      const reading=hrv.push(entry.r);
      if(reading)beats.set(`${session}:${reading.timeUs}`,reading);
    }
  }
  session=0;
  const lines=[columns.join(',')];
  for(const entry of ordered) {
    const {r}=entry;
    if(entry.session!==session){session=entry.session;ppg.reset();spo2.reset();}
    const values:unknown[]=Array(columns.length).fill('');values[0]=session;
    if(r.type==='ecg') {
      const filtered=filteredEcg.get(`${session}:${r.index}:${r.timeUs}`)??null;
      values.splice(1,3,r.timeUs,r.index,filtered===null?null:countsToMv(filtered,r.gain));
      const beat=beats.get(`${session}:${r.timeUs}`);
      values[4]=beat?.heartRate;values[5]=beat?.rmssdMs;
    } else if(r.type==='ppg') {
      const p=ppg.push(r);values.splice(6,3,r.timeUs,r.index,p.mode==='filtered'?p.b:null);
      values[9]=spo2.push(r)?.estimatePct;
    } else if(r.type==='temperature')values.splice(10,3,r.timeUs,r.a,r.b);
    lines.push(values.map(cell).join(','));
  }
  return '\uFEFF'+lines.join('\r\n')+'\r\n';
}
export class Recording {
  rows:Row[]=[];
  full=false;
  constructor(readonly limit=200_000) {}
  add(samples: Sample[],bootId:number,connection:number) {
    for (const s of samples) {
      if(this.rows.length>=this.limit) {this.full=true;break;}
      this.rows.push({...s,bootId,connection});
    }
  }
  clear() {this.rows=[];this.full=false;}
}
export function saveCsv(rows:readonly Row[],options?:ExportOptions) {
  const blob=new Blob([csv(rows,options)],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`VNS-TX-${new Date().toISOString().replace(/[:.]/g,'-')}.csv`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
