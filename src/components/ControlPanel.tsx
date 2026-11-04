import {Download,Play,Settings2,Square,Zap} from 'lucide-react';
import {Button,Card,CardContent,CardHeader,CardTitle,Label} from './ui';

type Props={connected:boolean;busy:boolean;running:boolean;rows:number;windowSeconds:number;setWindow:(n:number)=>void;
  led:number;setLed:(n:number)=>void;appliedRed?:number;appliedIr?:number;
  start:()=>void;stop:()=>void;clear:()=>void;save:()=>void;apply:()=>void;
  powerState:number|null;powerAllowed:boolean;powerOn:()=>void;powerOff:()=>void};
export function ControlPanel(p:Props) {
  const outline='h-10 px-1 rounded-xl text-[11px] border-slate-200 text-slate-700';
  const applied=p.appliedRed===p.led&&p.appliedIr===p.led;
  return <>
    <Card className="rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
      <CardHeader className="bg-slate-50/50 border-b border-slate-100 px-3 py-2.5"><CardTitle className="flex items-center gap-2 text-sm text-slate-800"><Settings2 className="w-4 h-4 text-blue-500"/>Acquisition</CardTitle></CardHeader>
      <CardContent className="px-3 pt-3 pb-3 space-y-3">
        <div className="grid grid-cols-4 gap-2">
          <Button disabled={!p.connected||p.busy||p.running} onClick={p.start} className="h-10 px-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-xs"><Play className="w-3 h-3 mr-1"/>Start</Button>
          <Button disabled={!p.connected} onClick={p.stop} variant="outline" className={outline}><Square className="w-3 h-3 mr-1"/>Stop</Button>
          <Button disabled={!p.rows} onClick={p.clear} variant="outline" className={outline}>Clear Data</Button>
          <Button disabled={!p.rows} onClick={p.save} variant="outline" className={outline}><Download className="w-3 h-3 mr-1"/>Save CSV</Button>
        </div>
        <div className="flex items-center justify-between gap-2"><Label htmlFor="window" className="text-xs font-medium text-slate-600">Waveform Window</Label><select id="window" value={p.windowSeconds} onChange={e=>p.setWindow(Number(e.target.value))} className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-xs"><option value="4">4 s</option><option value="8">8 s</option><option value="12">12 s</option></select></div>
        <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
          <div className="flex justify-between items-center gap-2"><Label htmlFor="ppg-led" className="text-xs text-slate-600">Red + IR LED</Label><output htmlFor="ppg-led" className="text-xs font-semibold text-slate-700 tabular-nums">{(p.led*.2).toFixed(1)} mA typ.</output></div>
          <input id="ppg-led" type="range" min="0" max="127" step="1" value={p.led} onChange={e=>p.setLed(Number(e.target.value))} className="block w-full h-7 accent-blue-600 cursor-pointer"/>
          <div className="flex justify-between text-[10px] text-slate-400"><span>0 mA</span><span>{p.running?'Stop to apply':p.connected?(applied?'Applied to Red + IR':'Pending · Red + IR'):'Red + IR linked'}</span><span>25.4 mA</span></div>
        </div>
        <Button disabled={!p.connected||p.busy||p.running||!Number.isInteger(p.led)||p.led<0||p.led>127} onClick={p.apply} className="w-full h-9 rounded-xl bg-slate-800 hover:bg-slate-900 text-xs">Apply LED Current</Button>
      </CardContent>
    </Card>
    <Card className="rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
      <CardHeader className="bg-slate-50/50 border-b border-slate-100 px-3 py-2.5"><CardTitle className="flex items-center gap-2 text-sm text-slate-800"><Zap className="w-4 h-4 text-blue-500"/>Wireless Power</CardTitle></CardHeader>
      <CardContent className="px-3 py-3 flex items-center gap-3">
        <div className={`relative flex-none w-16 h-16 rounded-full border-[5px] flex items-center justify-center ${p.powerState?'border-blue-500':'border-slate-100'}`}><span className="text-sm font-semibold text-slate-700">{p.powerState===null?'--':p.powerState===1?'Starting':p.powerState?'ON':'OFF'}</span></div>
        <div className="flex-1 min-w-0 space-y-2"><div className="text-[10px] text-slate-400">XKT-511 enable · Boost always on</div><div className="grid grid-cols-2 gap-2">
          <Button disabled={!p.powerAllowed} onClick={p.powerOn} className="h-9 px-2 text-xs rounded-xl bg-blue-600 hover:bg-blue-700"><Play className="w-3 h-3 mr-1"/>Power ON</Button>
          <Button disabled={!p.connected} onClick={p.powerOff} variant="destructive" className="h-9 px-2 text-xs rounded-xl"><Square className="w-3 h-3 mr-1"/>OFF</Button>
        </div></div>
      </CardContent>
    </Card>
  </>;
}
