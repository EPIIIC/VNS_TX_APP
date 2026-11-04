import test from 'node:test';
import assert from 'node:assert/strict';
import type {Sample} from '../ble/protocol';
import {DisplayFilterChain} from './displayFilters';
import {DEFAULT_DISPLAY,EcgDisplay} from './ecgDisplay';
import {DEFAULT_PPG_DISPLAY,PpgDisplay,ppgView} from './ppgDisplay';
const ecg=(i:number,a:number):Sample=>({type:'ecg',index:i,timeUs:i*3906.25,a,b:0,flags:2,tag:0,valid:true,gain:160,source:0});
const ppg=(i:number,a=50000,b=80000):Sample=>({type:'ppg',index:i,timeUs:i*10000,a,b,flags:2,valid:true});
const rms=(v:number[])=>Math.sqrt(v.reduce((sum,x)=>sum+x*x,0)/v.length);
function ecgTone(hz:number,options:Partial<typeof DEFAULT_DISPLAY>) {
  const dsp=new EcgDisplay({...DEFAULT_DISPLAY,...options}),out:number[]=[];
  for(let i=0;i<8192;i++){const p=dsp.push(ecg(i,1000*Math.sin(2*Math.PI*hz*i/256)));if(i>=4096)out.push(p.a!);}
  return rms(out)/(1000/Math.SQRT2);
}
test('ECG notch, high-pass and low-pass are independently selectable',()=>{
  assert.ok(ecgTone(50,{lowPass:null,notch:false})>.99);
  assert.ok(ecgTone(50,{lowPass:null,notch:true})<.001);
  assert.ok(ecgTone(30,{lowPass:20,notch:false})<.45);
  assert.ok(ecgTone(30,{lowPass:40,notch:false})>.85);
  assert.ok(ecgTone(.1,{highPass:.5,lowPass:null,notch:false})<.1);
  assert.ok(ecgTone(.1,{highPass:null,lowPass:null,notch:false})>.99);
});
test('PPG Raw preserves both channels exactly; disabled filter chain is also a bypass',()=>{
  for(const options of [{...DEFAULT_PPG_DISPLAY,mode:'raw' as const},{mode:'filtered' as const,highPass:null,lowPass:null}]) {
    const dsp=new PpgDisplay(options);
    for(let i=0;i<400;i++){const s=Object.freeze(ppg(i,12345+i,65432-i)),p=dsp.push(s);assert.equal(p.a,s.a);assert.equal(p.b,s.b);assert.equal(p.sample,s);}
  }
});
test('PPG removes DC and rejects high frequencies without cross-channel coupling',()=>{
  const dsp=new PpgDisplay({mode:'filtered',highPass:.3,lowPass:5}),red:number[]=[],ir:number[]=[];
  for(let i=0;i<6000;i++) {
    const p=dsp.push(ppg(i,50000+1000*Math.sin(2*Math.PI*2*i/100),80000));
    if(i>=3000){red.push(p.a!);ir.push(p.b!);}
  }
  assert.ok(rms(red)>650&&rms(red)<720);assert.ok(rms(ir)<1e-5);
  const fast=new PpgDisplay({mode:'filtered',highPass:null,lowPass:5}),noise:number[]=[];
  for(let i=0;i<4000;i++){const p=fast.push(ppg(i,1000*Math.sin(2*Math.PI*20*i/100),0));if(i>=2000)noise.push(p.a!);}
  assert.ok(rms(noise)<40);
});
test('PPG warmup, invalid data and time/index gaps never mix raw DC with filtered AC',()=>{
  const dsp=new PpgDisplay({mode:'filtered',highPass:.3,lowPass:5});
  const points=Array.from({length:301},(_,i)=>dsp.push(ppg(i)));
  assert.equal(points[199].mode,'settling');assert.equal(points[200].mode,'filtered');assert.equal(points[200].gap,true);
  assert.equal(ppgView(points)[0].a,null);assert.ok(Math.abs(ppgView(points).at(-1)!.a!)<1e-6);
  const gap=dsp.push(ppg(400));assert.equal(gap.mode,'settling');assert.equal(gap.gap,true);
  const rawView=ppgView([...points,gap]);assert.equal(rawView[0].a,50000);assert.equal(rawView[0].b,80000);
  const bad=dsp.push({...ppg(401),valid:false});assert.equal(bad.a,null);assert.equal(bad.b,null);
  assert.equal(dsp.push(ppg(402)).mode,'settling');dsp.reset();assert.equal(dsp.push(ppg(0)).gap,true);
});
test('PPG output is independent of BLE batches and reprocessing never mutates raw samples',()=>{
  const options={mode:'filtered' as const,highPass:.5,lowPass:8};
  const raw=Array.from({length:700},(_,i)=>Object.freeze(ppg(i,40000+Math.sin(i)*200,60000+Math.cos(i)*300)));
  const before=JSON.stringify(raw),a=new PpgDisplay(options),b=new PpgDisplay(options);
  const expected=raw.map(s=>a.push(s)),actual=[];
  for(let i=0;i<raw.length;i+=12)for(const s of raw.slice(i,i+12))actual.push(b.push(s));
  assert.deepEqual(actual,expected);assert.equal(JSON.stringify(raw),before);
});
test('display filters reject invalid or Nyquist cutoffs and prime constant DC without a fake pulse',()=>{
  for(const hz of [-1,0,50,NaN])assert.throws(()=>new DisplayFilterChain(100,{lowPass:hz}));
  assert.throws(()=>new DisplayFilterChain(100,{highPass:5,lowPass:2}));
  const chain=new DisplayFilterChain(100,{highPass:.1,lowPass:5});
  for(let i=0;i<500;i++)assert.ok(Math.abs(chain.push(200000))<1e-5);
});
