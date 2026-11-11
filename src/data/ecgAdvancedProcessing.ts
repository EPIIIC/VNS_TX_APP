import type {Sample} from '../ble/protocol';

/**
 * Optional display-only CDF 5/3 wavelet shrinkage.
 *
 * A centred sliding window avoids using the unstable edge of a wavelet block.
 * The returned sample therefore keeps its original device timestamp and has a
 * fixed 63-sample (246 ms at 256 SPS) display delay. Raw samples are untouched.
 */
export const ECG_WAVELET_WINDOW=128;
export const ECG_WAVELET_DELAY=ECG_WAVELET_WINDOW/2-1;
const LEVELS=3;

const median=(values:number[])=>{
  const ordered=[...values].sort((a,b)=>a-b),middle=Math.floor(ordered.length/2);
  return ordered.length%2?ordered[middle]:(ordered[middle-1]+ordered[middle])/2;
};
const soft=(value:number,threshold:number)=>Math.sign(value)*Math.max(0,Math.abs(value)-threshold);

/** In-place forward CDF 5/3 lifting transform with symmetric boundaries. */
function forward(values:number[]) {
  let length=values.length;
  for(let level=0;level<LEVELS;level++) {
    const half=length/2,detail=Array<number>(half),approx=Array<number>(half);
    for(let i=0;i<half;i++) {
      const left=values[2*i],right=values[Math.min(2*i+2,length-2)];
      detail[i]=values[2*i+1]-(left+right)/2;
    }
    for(let i=0;i<half;i++) {
      const left=detail[Math.max(0,i-1)],right=detail[i];
      approx[i]=values[2*i]+(left+right)/4;
    }
    for(let i=0;i<half;i++){values[i]=approx[i];values[half+i]=detail[i];}
    length=half;
  }
}

/** Exact inverse of forward(). */
function inverse(values:number[]) {
  for(let level=LEVELS-1;level>=0;level--) {
    const length=values.length/(2**level),half=length/2;
    const approx=values.slice(0,half),detail=values.slice(half,length),even=Array<number>(half);
    for(let i=0;i<half;i++)even[i]=approx[i]-(detail[Math.max(0,i-1)]+detail[i])/4;
    for(let i=0;i<half;i++) {
      values[2*i]=even[i];
      values[2*i+1]=detail[i]+(even[i]+even[Math.min(i+1,half-1)])/2;
    }
  }
}

/**
 * Balanced level-dependent soft thresholding. Only the three highest detail
 * bands are changed; the low-frequency approximation (P/T and baseline shape)
 * is retained. This is a viewing aid, not a diagnostic reconstruction.
 */
export function denoiseEcgBlock(input:readonly number[]):number[] {
  if(input.length!==ECG_WAVELET_WINDOW)throw Error(`Wavelet block must contain ${ECG_WAVELET_WINDOW} samples`);
  const values=[...input];forward(values);
  // Conservative at 16-32 Hz so QRS slopes are not flattened. The existing
  // selectable low-pass/notch handle deterministic out-of-band interference.
  const factors=[.9,.55,.15];
  for(let level=0;level<LEVELS;level++) {
    const length=values.length/(2**level),half=length/2,start=half,end=length;
    const detail=values.slice(start,end),sigma=median(detail.map(v=>Math.abs(v)))/.67448975;
    const threshold=Number.isFinite(sigma)?factors[level]*sigma*Math.sqrt(2*Math.log(detail.length)):0;
    for(let i=start;i<end;i++)values[i]=soft(values[i],threshold);
  }
  inverse(values);return values;
}

export type ProcessedEcg={sample:Readonly<Sample>;value:number};

export class WaveletEcgDenoiser {
  private values:number[]=[];
  private samples:Readonly<Sample>[]=[];
  reset(){this.values=[];this.samples=[];}
  push(sample:Readonly<Sample>,value:number):ProcessedEcg|null {
    this.values.push(value);this.samples.push(sample);
    if(this.values.length>ECG_WAVELET_WINDOW){this.values.shift();this.samples.shift();}
    if(this.values.length<ECG_WAVELET_WINDOW)return null;
    const index=ECG_WAVELET_WINDOW/2;
    return {sample:this.samples[index],value:denoiseEcgBlock(this.values)[index]};
  }
}
