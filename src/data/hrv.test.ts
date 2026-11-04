import test from 'node:test';
import assert from 'node:assert/strict';
import type {Sample} from '../ble/protocol';
import {HrvAnalyzer,rmssd,type HrvReading} from './hrv';
import {DEFAULT_PPG_DISPLAY} from './ppgDisplay';

// Numerical fixtures only; never passed to the live UI.
const sample=(i:number,mv:number):Sample=>({type:'ecg',index:i,timeUs:Math.floor(i*1e6/256),a:Math.round(mv*131072*160/1000),b:0,
  flags:2,tag:0,valid:true,gain:160,rate:256,source:0});
function input(i:number,beats:number[],inverted=false) {
  const t=i/256;let x=.05*Math.sin(2*Math.PI*.25*t)+.015*Math.sin(2*Math.PI*50*t);
  for(const beat of beats)if(Math.abs(t-beat)<.7){
    const d=t-beat;
    x+=(inverted?-1:1)*(.8*Math.exp(-.5*(d/.012)**2)-.15*Math.exp(-.5*((d+.025)/.01)**2)
      -.22*Math.exp(-.5*((d-.03)/.012)**2)+.18*Math.exp(-.5*((d-.25)/.05)**2));
  }
  return sample(i,x);
}
function run(beats:number[],inverted=false) {
  const detector=new HrvAnalyzer(),readings:HrvReading[]=[];
  for(let i=0;i<80*256;i++){const r=detector.push(input(i,beats,inverted));if(r)readings.push(r);}
  return {detector,readings};
}
test('RMSSD uses adjacent accepted RR only, preserving excluded-beat gaps',()=>{
  assert.equal(rmssd([{ms:1000,accepted:true},{ms:1100,accepted:true},{ms:1000,accepted:true}]),100);
  assert.equal(rmssd([{ms:1000,accepted:true},{ms:500,accepted:false},{ms:1100,accepted:true}]),null);
  assert.equal(rmssd([]),null);
});
test('streaming QRS detector handles positive and inverted beats without T-wave double counts',()=>{
  for(const inverted of [false,true]) {
    const {readings}=run(Array.from({length:80},(_,i)=>i+.5),inverted);
    assert.ok(readings.length>=72&&readings.length<=78,`${readings.length} beats`);
    const good=readings.filter(r=>r.rmssdMs!==null);
    assert.ok(good.length>30);assert.ok(good.every(r=>Math.abs(r.heartRate!-60)<.6&&r.rmssdMs!<6));
    assert.ok(readings.filter(r=>r.timeUs<30e6).every(r=>r.rmssdMs===null));
  }
});
test('variable ECG beat times produce RR variability in milliseconds',()=>{
  const beats:number[]=[];let t=.5;
  for(let i=0;t<80;i++){beats.push(t);t+=i%2?.95:1.05;}
  const good=run(beats).readings.filter(r=>r.rmssdMs!==null);
  assert.ok(good.length>30);
  const average=good.reduce((sum,r)=>sum+r.rmssdMs!,0)/good.length;
  assert.ok(average>90&&average<110,`RMSSD=${average}`);
});
test('invalid/clipped/calibration/unknown-source/gain/rate inputs cannot create HRV; gaps reset learning',()=>{
  for(const change of [{valid:false},{a:131071},{source:1},{source:undefined},{gain:undefined},{rate:128},{tag:1}]) {
    const detector=new HrvAnalyzer();
    for(let i=0;i<40*256;i++)detector.push({...input(i,Array.from({length:40},(_,j)=>j+.5)),...change});
    assert.equal(detector.reading(40e6).rmssdMs,null);assert.equal(detector.reading(40e6).heartRate,null);
  }
  const {detector}=run(Array.from({length:80},(_,i)=>i+.5));
  assert.notEqual(detector.reading(80e6).rmssdMs,null);
  detector.push(sample(83*256,0));assert.equal(detector.reading(83e6).rmssdMs,null);
});
test('missing/extra beats are screened and flatline does not generate measurements',()=>{
  const beats=Array.from({length:80},(_,i)=>i+.5).filter(t=>t!==50.5);beats.push(60.85);beats.sort((a,b)=>a-b);
  const {readings,detector}=run(beats);
  assert.ok(readings.filter(r=>r.timeUs>50e6&&r.timeUs<55e6).some(r=>r.rmssdMs===null));
  assert.ok(readings.filter(r=>r.rmssdMs!==null).every(r=>r.rmssdMs!<8));
  assert.equal(detector.reading(90e6).heartRate,null);
  const flat=new HrvAnalyzer();for(let i=0;i<65*256;i++)flat.push(sample(i,0));
  assert.equal(flat.reading(65e6).rmssdMs,null);
});
test('PPG defaults to the requested 0.5–3 Hz display band',()=>{
  assert.deepEqual(DEFAULT_PPG_DISPLAY,{mode:'filtered',highPass:.5,lowPass:3});
});
