import {Card,CardContent,CardHeader,CardTitle,Label} from './ui';
import type {PpgDisplayOptions} from '../data/ppgDisplay';
export function PpgControls({display,setDisplay}:{display:PpgDisplayOptions;setDisplay:(v:PpgDisplayOptions)=>void}) {
  const select='bg-white border border-slate-200 rounded-lg px-2 py-2 text-sm w-full';
  return <Card className="rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
    <CardHeader className="bg-slate-50/50 border-b border-slate-100 pb-4"><CardTitle>PPG Display Filters</CardTitle></CardHeader>
    <CardContent className="space-y-4 pt-4">
      <div><Label htmlFor="ppg-mode">PPG display</Label><select id="ppg-mode" className={select} value={display.mode} onChange={e=>setDisplay({...display,mode:e.target.value as PpgDisplayOptions['mode']})}><option value="raw">Raw (no GUI filters)</option><option value="filtered">Filtered (custom)</option></select></div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label htmlFor="ppg-highpass">PPG high-pass</Label><select id="ppg-highpass" className={select} value={display.highPass??'off'} disabled={display.mode==='raw'} onChange={e=>setDisplay({...display,highPass:e.target.value==='off'?null:Number(e.target.value)})}><option value="off">Off</option>{[.1,.3,.5,1].map(v=><option key={v} value={v}>{v} Hz</option>)}</select></div>
        <div><Label htmlFor="ppg-lowpass">PPG low-pass</Label><select id="ppg-lowpass" className={select} value={display.lowPass??'off'} disabled={display.mode==='raw'} onChange={e=>setDisplay({...display,lowPass:e.target.value==='off'?null:Number(e.target.value)})}><option value="off">Off</option>{[2,3,4,5,8,10,20].map(v=><option key={v} value={v}>{v} Hz</option>)}</select></div>
      </div>
    </CardContent>
  </Card>;
}
