import test from 'node:test';
import assert from 'node:assert/strict';
import { Recording,csv,type Row } from './recording';
import {DEFAULT_DISPLAY,EcgDisplay} from './ecgDisplay';
import {DEFAULT_PPG_DISPLAY,PpgDisplay} from './ppgDisplay';
import type { Sample } from '../ble/protocol';
import {HrvAnalyzer} from './hrv';
import {Spo2Analyzer} from './spo2';
const s:Sample={type:'ecg',timeUs:1234567,index:42,a:-131072,b:0x800000,flags:3,tag:0,valid:true};
const parse=(text:string)=>{const lines=text.slice(1).trim().split('\r\n'),header=lines.shift()!.split(',');return lines.map(line=>Object.fromEntries(line.split(',').map((v,i)=>[header[i],v])));};
test('CSV preserves signed raw measurement and device time without debug/error fields',()=>{
  const r=new Recording();r.add([s],123,2);const text=csv(r.rows);
  const row=parse(text)[0];assert.equal(row.ecg_time_us,'1234567');assert.equal(row.ecg_sample_index,'42');assert.equal(row.ecg_raw_counts,'-131072');
  assert.equal(row.ecg_raw_mv,'');assert.equal(row.ecg_filtered_counts,'');
  assert.ok(text.startsWith('\uFEFFsession'));assert.doesNotMatch(text,/boot_id|fifo_tag|flags|valid|error|fault|register/i);
});
test('CSV aligns independent ECG, PPG and temperature timestamps on the same device clock',()=>{
  const r=new Recording();r.add([{...s,timeUs:1003906,index:1,gain:160,source:0},
    {type:'temperature',timeUs:1002000,index:0,a:23.75,b:24.5,valid:true,flags:2},
    {type:'ppg',timeUs:1000000,index:7,a:12345,b:67890,valid:true,flags:2}],42,1);
  const out=parse(csv(r.rows));assert.equal(out.length,3);
  assert.equal(out[0].ppg_time_us,'1000000');assert.equal(out[0].ppg_red_raw_counts,'12345');assert.equal(out[0].ecg_time_us,'');
  assert.equal(out[1].temperature_time_us,'1002000');assert.equal(out[1].temperature_surface_c,'23.75');
  assert.equal(out[2].ecg_time_us,'1003906');assert.equal(out[2].ecg_raw_counts,'-131072');assert.equal(out[2].ecg_raw_mv,'-6.25');
});
test('CSV exports selected ECG/PPG filtered values at their original timestamps and resets per session',()=>{
  const options={ecg:{...DEFAULT_DISPLAY,highPass:.5,lowPass:30,notch:false},ppg:{mode:'filtered' as const,highPass:.3,lowPass:5}};
  const rows:Row[]=[];
  for(let i=0;i<600;i++) {
    rows.push({type:'ecg',timeUs:i*3906.25,index:i,a:1000*Math.sin(i/10),b:0,flags:2,tag:0,valid:true,gain:160,source:0,bootId:1,connection:1});
    rows.push({type:'ppg',timeUs:i*10000,index:i,a:50000+1000*Math.sin(i/10),b:80000+500*Math.cos(i/10),flags:2,valid:true,bootId:1,connection:1});
  }
  const rawBefore=JSON.stringify(rows),out=parse(csv(rows,options)),ecg=new EcgDisplay(options.ecg),ppg=new PpgDisplay(options.ppg);
  const eg=rows.filter(r=>r.type==='ecg').map(r=>ecg.push(r)),pg=rows.filter(r=>r.type==='ppg').map(r=>ppg.push(r));
  const lastE=out.filter(r=>r.ecg_time_us!=='').at(-1)!,lastP=out.filter(r=>r.ppg_time_us!=='').at(-1)!;
  assert.equal(Number(lastE.ecg_filtered_counts),eg.at(-1)!.a);assert.equal(Number(lastP.ppg_red_filtered_counts),pg.at(-1)!.a);
  assert.equal(Number(lastP.ppg_ir_filtered_counts),pg.at(-1)!.b);assert.equal(lastE.ecg_time_us,String(599*3906.25));
  assert.equal(out[0].ecg_filtered_counts,'');assert.equal(JSON.stringify(rows),rawBefore);
  const fresh=parse(csv([...rows,{...rows[0],bootId:2,connection:2}],options)).at(-1)!;
  assert.equal(fresh.session,'2');assert.equal(fresh.ecg_filtered_counts,'');
  const rawOut=parse(csv(rows,{ecg:{...options.ecg,mode:'raw'},ppg:{...options.ppg,mode:'raw'}}));
  assert.ok(rawOut.every(r=>r.ecg_filtered_counts===''&&r.ppg_red_filtered_counts===''));
});
test('CSV labels calibration as internal input and excludes unverified RR diagnostic records',()=>{
  const text=csv([{...s,source:1,flags:16,bootId:1,connection:1},{...s,type:'rr',bootId:1,connection:1}]);
  const rows=parse(text);assert.equal(rows.length,1);assert.equal(rows[0].ecg_input,'internal_cal_0.5mVpp');
  assert.equal(rows[0].ecg_filtered_counts,'');assert.equal(rows[0].ecg_filter,'Raw internal calibration');
});
test('recording capacity has explicit full flag without overwriting older data',()=>{
  const r=new Recording(2);r.add([s,s,{...s,index:43}],1,1);
  assert.equal(r.rows.length,2);assert.equal(r.full,true);assert.equal(r.rows[1].index,42);
  r.clear();assert.equal(r.rows.length,0);assert.equal(r.full,false);
});
test('CSV attaches HR/RMSSD to the original ECG R-peak sample, not detection/notification time',()=>{
  const rows:Row[]=[],analyzer=new HrvAnalyzer(),expected=new Map<number,{hr:number|null;hrv:number|null}>();
  for(let i=0;i<65*256;i++) {
    const t=i/256,phase=(t+.5)%1-.5,mv=.8*Math.exp(-.5*(phase/.012)**2);
    const r:Row={type:'ecg',timeUs:Math.floor(i*1e6/256),index:i,a:Math.round(mv*131072*160/1000),b:0,flags:2,tag:0,valid:true,gain:160,rate:256,source:0,bootId:1,connection:1};
    rows.push(r);const reading=analyzer.push(r);
    if(reading)expected.set(reading.timeUs,{hr:reading.heartRate,hrv:reading.rmssdMs});
  }
  const before=JSON.stringify(rows),out=parse(csv(rows)),results=out.filter(r=>r.ecg_heart_rate_bpm!=='');
  assert.ok(results.length>50);assert.ok(out.some(r=>r.ecg_hrv_rmssd_ms!==''));
  for(const r of out){
    const beat=expected.get(Number(r.ecg_time_us));
    assert.equal(r.ecg_heart_rate_bpm,beat?.hr==null?'':String(beat.hr));
    assert.equal(r.ecg_hrv_rmssd_ms,beat?.hrv==null?'':String(beat.hrv));
  }
  assert.equal(JSON.stringify(rows),before);
  const raw=parse(csv(rows,{ecg:{...DEFAULT_DISPLAY,mode:'raw',notch:false},ppg:DEFAULT_PPG_DISPLAY}));
  assert.deepEqual(raw.map(r=>[r.ecg_heart_rate_bpm,r.ecg_hrv_rmssd_ms]),out.map(r=>[r.ecg_heart_rate_bpm,r.ecg_hrv_rmssd_ms]));
  const restarted=parse(csv([...rows,{...rows[0],bootId:2,connection:2}]));
  assert.equal(restarted.at(-1)!.ecg_heart_rate_bpm,'');assert.equal(restarted.at(-1)!.ecg_hrv_rmssd_ms,'');
  assert.doesNotMatch(csv(rows),/debug|error|fault|flags|register|quality|fifo/i);
});
test('CSV exports optical estimates on the original PPG window-end sample; no debug fields',()=>{
  const rows:Row[]=[],analyzer=new Spo2Analyzer(),expected=new Map<number,number|null>();
  for(let i=0;i<1300;i++) {
    const pulse=Math.sin(2*Math.PI*1.2*i/100);
    const r:Row={type:'ppg',index:i,timeUs:i*10000,a:40000+430*pulse,b:80000+2000*pulse,flags:2,valid:true,ledRed:31,ledIr:31,bootId:1,connection:1};
    rows.push(r);const reading=analyzer.push(r);if(reading)expected.set(reading.timeUs,reading.estimatePct);
  }
  const out=parse(csv(rows));assert.ok(out.some(r=>r.ppg_spo2_estimate_pct!==''));
  for(const r of out){const value=expected.get(Number(r.ppg_time_us));assert.equal(r.ppg_spo2_estimate_pct,value==null?'':String(value));assert.equal(r.ecg_heart_rate_bpm,'');}
  const bypass=parse(csv(rows,{ecg:DEFAULT_DISPLAY,ppg:{mode:'raw',highPass:null,lowPass:null}}));
  assert.deepEqual(bypass.map(r=>r.ppg_spo2_estimate_pct),out.map(r=>r.ppg_spo2_estimate_pct));
  const missing=rows.map(r=>({...r,ledRed:undefined,ledIr:undefined}));
  assert.ok(parse(csv(missing)).every(r=>r.ppg_spo2_estimate_pct===''));
});
