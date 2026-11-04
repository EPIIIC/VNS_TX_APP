import {countsToMv,type Sample} from '../ble/protocol';
import {DEFAULT_DISPLAY,EcgDisplay,ecgFilterLabel,type DisplayOptions} from './ecgDisplay';
import {DEFAULT_PPG_DISPLAY,PpgDisplay,ppgFilterLabel,type PpgDisplayOptions} from './ppgDisplay';
import {HrvAnalyzer,type HrvReading} from './hrv';
import {Spo2Analyzer} from './spo2';
export type Row = Sample & { bootId: number; connection: number };
export type ExportOptions={ecg:DisplayOptions;ppg:PpgDisplayOptions};
const columns=['session','ecg_time_us','ecg_sample_index','ecg_raw_counts','ecg_raw_mv','ecg_filtered_counts','ecg_filtered_mv','ecg_input','ecg_filter','ecg_heart_rate_bpm','ecg_hrv_rmssd_ms',
  'ppg_time_us','ppg_sample_index','ppg_red_raw_counts','ppg_ir_raw_counts','ppg_red_filtered_counts','ppg_ir_filtered_counts','ppg_filter','ppg_spo2_estimate_pct',
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
    if(entry.session!==session){session=entry.session;ecg.reset();ppg.reset();spo2.reset();}
    const values:unknown[]=Array(columns.length).fill('');values[0]=session;
    if(r.type==='ecg') {
      const p=ecg.push(r),filtered=p.mode==='filtered'?p.a:null;
      const internal=!!(r.flags&16)||(r.source!==undefined&&r.source>0);
      values.splice(1,8,r.timeUs,r.index,r.a,countsToMv(r.a,r.gain),filtered,
        filtered===null?null:countsToMv(filtered,r.gain),
        internal?(r.source===1?'internal_cal_0.5mVpp':r.source===2?'internal_cal_1mVpp':'internal_cal_unknown'):
          r.source===0?'electrodes':'unknown',internal?'Raw internal calibration':ecgFilterLabel(options.ecg));
      const beat=beats.get(`${session}:${r.timeUs}`);
      values[9]=beat?.heartRate;values[10]=beat?.rmssdMs;
    } else if(r.type==='ppg') {
      const p=ppg.push(r);values.splice(11,7,r.timeUs,r.index,r.a,r.b,
        p.mode==='filtered'?p.a:null,p.mode==='filtered'?p.b:null,ppgFilterLabel(options.ppg));
      values[18]=spo2.push(r)?.estimatePct;
    } else if(r.type==='temperature')values.splice(19,3,r.timeUs,r.a,r.b);
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
