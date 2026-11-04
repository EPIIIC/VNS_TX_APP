import {useEffect,useRef} from 'react';
import type {TrendPoint} from '../data/hrv';

export function Trend({samples,windowSeconds,color,unit}:{samples:()=>readonly TrendPoint[];windowSeconds:number;color:string;unit:string}) {
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    const c=canvas.current;if(!c)return;
    const draw=()=>{
      const bounds=c.getBoundingClientRect(),w=Math.round(bounds.width),h=Math.round(bounds.height),dpr=window.devicePixelRatio||1;
      if(!w||!h)return;
      if(c.width!==Math.round(w*dpr)||c.height!==Math.round(h*dpr)){c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);}
      const ctx=c.getContext('2d');if(!ctx)return;
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
      const left=48,right=w-14,top=12,bottom=h-24;
      ctx.strokeStyle='#e9eef5';ctx.lineWidth=1;
      for(let i=0;i<=4;i++){const y=top+(bottom-top)*i/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();}
      for(let i=0;i<=8;i++){const x=left+(right-left)*i/8;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();}
      const all=samples(),end=all.at(-1)?.timeUs??0,start=end-windowSeconds*1e6,points=all.filter(p=>p.timeUs>=start);
      ctx.fillStyle='#94a3b8';ctx.font='10px ui-monospace, monospace';
      for(let i=0;i<=4;i++)ctx.fillText(`${Math.round(-windowSeconds+windowSeconds*i/4)}s`,left+(right-left)*i/4-5,h-8);
      const values=points.map(p=>p.value).filter((v):v is number=>v!==null&&Number.isFinite(v));
      if(!values.length)return;
      let min=Math.min(...values),max=Math.max(...values);
      const padding=Math.max(unit==='°C'?.1:2,(max-min)*.15);min-=padding;max+=padding;
      if(unit==='ms')min=Math.max(0,min);
      for(let i=0;i<=4;i++)ctx.fillText((max-(max-min)*i/4).toFixed(unit==='°C'?1:0),2,top+(bottom-top)*i/4+3);
      ctx.save();ctx.beginPath();ctx.rect(left,top,right-left,bottom-top);ctx.clip();
      ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=1.6;ctx.setLineDash([]);
      let previous:TrendPoint|undefined;
      for(const p of points){
        if(p.value===null||!Number.isFinite(p.value)){previous=undefined;continue;}
        const x=left+(p.timeUs-start)/(windowSeconds*1e6)*(right-left),y=bottom-(p.value-min)/(max-min)*(bottom-top);
        if(!previous||p.gap||p.timeUs<=previous.timeUs||p.timeUs-previous.timeUs>3e6)ctx.moveTo(x,y);else ctx.lineTo(x,y);
        previous=p;
      }
      ctx.stroke();ctx.restore();
    };
    draw();const timer=setInterval(draw,250),resize=new ResizeObserver(draw);resize.observe(c);
    return()=>{clearInterval(timer);resize.disconnect();};
  },[samples,windowSeconds,color,unit]);
  return <div className="wave-holder"><canvas ref={canvas} className="wave-canvas" role="img" aria-label={unit==='°C'?'Surface temperature waveform':'ECG-derived HRV RMSSD waveform'}/></div>;
}
