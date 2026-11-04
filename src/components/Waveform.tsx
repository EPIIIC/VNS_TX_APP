import { useEffect,useRef } from 'react';
import {ecgView, StableEcgScale, type WavePoint, type DisplayOptions } from '../data/ecgDisplay';
import {EcgAxis} from '../data/ecgMeasurements';
import {ppgView} from '../data/ppgDisplay';
type Props={samples:()=>readonly WavePoint[];kind:'ecg'|'ppg';windowSeconds:number;epoch?:number;ecgScale?:StableEcgScale;display?:DisplayOptions};
export function Waveform({samples,kind,windowSeconds,epoch=0,ecgScale,display}:Props) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const scale=useRef(new StableEcgScale());
  const voltageAxis=useRef(new EcgAxis());
  useEffect(()=>{scale.current=new StableEcgScale();voltageAxis.current=new EcgAxis();},[epoch]);
  useEffect(()=>{
    const c=canvas.current;if(!c)return;
    const draw=()=>{
      const bounds=c.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
      const w=Math.round(bounds.width),h=Math.round(bounds.height);if(!w||!h)return;
      if(c.width!==Math.round(w*dpr)||c.height!==Math.round(h*dpr)){c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);}
      const ctx=c.getContext('2d');if(!ctx)return;
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      const left=48,right=w-14,top=12,bottom=h-24;
      ctx.strokeStyle='#e9eef5';ctx.lineWidth=1;
      for(let i=0;i<=4;i++){const y=top+(bottom-top)*i/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();}
      for(let i=0;i<=8;i++){const x=left+(right-left)*i/8;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();}
      const all=samples(),end=all.at(-1)?.sample.timeUs??0,start=end-windowSeconds*1e6;
      const windowPoints=all.filter(p=>p.sample.timeUs>=start);
      const voltage=kind==='ecg'&&display?voltageAxis.current.range(windowPoints,display):null;
      const view=kind==='ecg'&&!voltage?ecgView(windowPoints,ecgScale??scale.current):null;
      const visible=voltage?windowPoints.map((p,i)=>({...p,a:voltage.values[i]})):view?.points??(kind==='ppg'?ppgView(windowPoints):windowPoints);
      const drawable=visible.filter(p=>(kind==='ppg'?p.b:p.a)!==null);
      ctx.font='10px ui-monospace, monospace';ctx.fillStyle='#94a3b8';
      for(let i=0;i<=4;i++){const t=-windowSeconds+windowSeconds*i/4;ctx.fillText(`${t.toFixed(0)}s`,left+(right-left)*i/4-5,h-8);}
      if(!drawable.length)return;
      let min=Infinity,max=-Infinity;
      if(kind==='ecg'){max=voltage?.half??view!.half;min=-max;}
      else {
        for(const p of drawable){min=Math.min(min,p.b!);max=Math.max(max,p.b!);}
        const pad=Math.max(1,(max-min)*.12);min-=pad;max+=pad;
      }
      for(let i=0;i<=4;i++){const value=max-(max-min)*i/4;ctx.fillText(voltage?.unit==='mV'?value.toFixed(3):Math.round(value).toString(),2,top+(bottom-top)*i/4+3);}
      const trace=(field:'a'|'b',color:string)=>{
        ctx.save();ctx.beginPath();ctx.rect(left,top,right-left,bottom-top);ctx.clip();
        ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1.6;ctx.setLineDash([]);let previous:WavePoint|undefined;
        for(const p of visible){
          if(p[field]===null){previous=undefined;continue;}
          const s=p.sample,x=left+(s.timeUs-start)/(windowSeconds*1e6)*(right-left),y=bottom-(p[field]!-min)/(max-min)*(bottom-top);
          const changed=!!previous&&previous.mode!==p.mode;
          if(!previous||changed||p.gap||s.index!==((previous.sample.index+1)>>>0)||s.timeUs<=previous.sample.timeUs)ctx.moveTo(x,y);else ctx.lineTo(x,y);
          previous=p;
        }
        ctx.stroke();ctx.restore();
      };
      trace(kind==='ecg'?'a':'b',kind==='ecg'?'#ef4444':'#7863d7');
    };
    draw();const timer=setInterval(draw,100);const resize=new ResizeObserver(draw);resize.observe(c);
    return()=>{clearInterval(timer);resize.disconnect();};
  },[samples,kind,windowSeconds,epoch,ecgScale,display]);
  return <div className="wave-holder"><canvas ref={canvas} className="wave-canvas" role="img" aria-label={kind==='ecg'?'ECG waveform':'PPG IR waveform'}/></div>;
}
