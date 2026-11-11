import test from 'node:test';
import assert from 'node:assert/strict';
import type {Sample} from '../ble/protocol';
import {denoiseEcgBlock,ECG_WAVELET_DELAY,ECG_WAVELET_WINDOW,WaveletEcgDenoiser} from './ecgAdvancedProcessing';

const sample=(index:number):Sample=>({type:'ecg',index,timeUs:index*1e6/256,a:0,b:0,flags:2,tag:0,valid:true,gain:160,source:0});
const rms=(values:readonly number[])=>Math.sqrt(values.reduce((sum,value)=>sum+value*value,0)/values.length);

test('wavelet denoiser has a fixed device-sample delay and does not invent timestamps',()=>{
  const denoiser=new WaveletEcgDenoiser();let first=null;
  for(let i=0;i<ECG_WAVELET_WINDOW;i++)first=denoiser.push(sample(i),1000);
  assert.ok(first);assert.equal(first.sample.index,ECG_WAVELET_WINDOW/2);
  assert.equal(ECG_WAVELET_WINDOW-1-first.sample.index,ECG_WAVELET_DELAY);
  assert.equal(first.sample.timeUs,(ECG_WAVELET_WINDOW/2)*1e6/256);
  assert.ok(Math.abs(first.value-1000)<1e-9);
});

test('balanced wavelet shrinkage rejects alternating noise while preserving ECG-band shape',()=>{
  const noisy=Array.from({length:ECG_WAVELET_WINDOW},(_,i)=>1000+200*(i%2?1:-1));
  const clean=denoiseEcgBlock(noisy);
  assert.ok(rms(clean.map(value=>value-1000))<1);
  const signal=Array.from({length:ECG_WAVELET_WINDOW},(_,i)=>1000*Math.sin(2*Math.PI*5*i/256));
  const filtered=denoiseEcgBlock(signal);
  assert.ok(rms(filtered)/rms(signal)>.98);
  assert.ok(rms(filtered.map((value,i)=>value-signal[i]))<60);
});
