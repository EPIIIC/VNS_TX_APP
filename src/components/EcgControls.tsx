import {useEffect,useState} from 'react';
import type {EcgInfo,Status} from '../ble/protocol';
import {Button,Card,CardContent,CardHeader,CardTitle,Label} from './ui';
import type {DisplayOptions} from '../data/ecgDisplay';
import {registerLog,saveRegisterLog} from '../data/ecgMeasurements';
type Props={info:EcgInfo|null;status:Status|null;busy:boolean;display:DisplayOptions;
  setDisplay:(value:DisplayOptions)=>void;configure:(gain:number,source:number)=>void;read:()=>void};
export function EcgControls({info,status,busy,display,setDisplay,configure,read}:Props) {
  const [gain,setGain]=useState(160),[source,setSource]=useState(0);
  useEffect(()=>{if(info){setGain(info.selectedGain);setSource(info.selectedSource);}},[info?.selectedGain,info?.selectedSource]);
  const supported=!!status&&(status.capabilities&256)!==0;
  const select='bg-white border border-slate-200 rounded-lg px-2 py-2 text-sm w-full';
  return <Card className="rounded-2xl shadow-sm border-slate-200/60 overflow-hidden">
    <CardHeader className="bg-slate-50/50 border-b border-slate-100 pb-4"><CardTitle>ECG Input & Display</CardTitle></CardHeader>
    <CardContent className="space-y-4 pt-4">
      <div className="grid grid-cols-2 gap-3">
        <div><Label htmlFor="ecg-mode">ECG display</Label><select id="ecg-mode" className={select} value={display.mode} onChange={e=>setDisplay({...display,mode:e.target.value as DisplayOptions['mode']})}><option value="raw">Raw (no GUI filters)</option><option value="monitor">Filtered (custom)</option></select></div>
        <div><Label htmlFor="ecg-unit">Unit</Label><select id="ecg-unit" className={select} value={display.unit} onChange={e=>setDisplay({...display,unit:e.target.value as DisplayOptions['unit'],range:null})}><option value="mv">Input mV</option><option value="counts">Counts</option></select></div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><Label htmlFor="ecg-highpass">ECG extra high-pass</Label><select id="ecg-highpass" className={select} value={display.highPass??'off'} disabled={display.mode==='raw'} onChange={e=>setDisplay({...display,highPass:e.target.value==='off'?null:Number(e.target.value)})}><option value="off">Off</option>{[.5,1].map(v=><option key={v} value={v}>{v} Hz</option>)}</select></div>
        <div><Label htmlFor="ecg-lowpass">ECG extra low-pass</Label><select id="ecg-lowpass" className={select} value={display.lowPass===undefined?40:display.lowPass??'off'} disabled={display.mode==='raw'} onChange={e=>setDisplay({...display,lowPass:e.target.value==='off'?null:Number(e.target.value)})}><option value="off">Off</option>{[20,30,40].map(v=><option key={v} value={v}>{v} Hz</option>)}</select></div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={display.notch} disabled={display.mode==='raw'} onChange={e=>setDisplay({...display,notch:e.target.checked})}/>ECG 50 Hz notch</label>
      <div className="border-t border-slate-100 pt-4">
        <Label htmlFor="ecg-denoise">ECG Signal Processing</Label>
        <select id="ecg-denoise" className={select} value={display.denoise??'off'} disabled={display.mode==='raw'} onChange={e=>setDisplay({...display,denoise:e.target.value as NonNullable<DisplayOptions['denoise']>})}>
          <option value="off">Off (current processing only)</option>
          <option value="wavelet">Wavelet denoise · balanced</option>
        </select>
      </div>
      <div><Label htmlFor="ecg-range">Y-axis range</Label><select id="ecg-range" className={select} value={display.range??'auto'} onChange={e=>setDisplay({...display,range:e.target.value==='auto'?null:Number(e.target.value)})}><option value="auto">Auto Scale</option>{(display.unit==='mv'?[.05,.1,.25,.5,1,2,5,12.5]:[256,1024,4096,16384,32768,131072]).map(v=><option key={v} value={v}>±{v} {display.unit==='mv'?'mV':'Counts'}</option>)}</select></div>
      <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-4">
        <div><Label htmlFor="ecg-gain">Hardware gain</Label><select id="ecg-gain" className={select} value={gain} disabled={!supported||busy||status?.monitoring} onChange={e=>setGain(Number(e.target.value))}>{[20,40,80,160].map(v=><option key={v} value={v}>{v} V/V</option>)}</select></div>
        <div><Label htmlFor="ecg-source">Input source</Label><select id="ecg-source" className={select} value={source} disabled={!supported||busy||status?.monitoring} onChange={e=>setSource(Number(e.target.value))}><option value="0">Electrodes</option><option value="1">Internal cal 0.5 mVpp</option><option value="2">Internal cal 1 mVpp</option></select></div>
      </div>
      {source>0&&<p role="alert" className="text-xs text-red-600">Internal test, not human ECG. Disconnect electrodes first.</p>}
      <Button disabled={!supported||busy||!!status?.monitoring} onClick={()=>configure(gain,source)} className="w-full h-12 rounded-xl bg-slate-800 text-white">Apply ECG Input</Button>
      <details className="text-xs text-slate-500"><summary className="cursor-pointer font-semibold">ECG Register Log</summary><div className="grid grid-cols-2 gap-2 pt-3"><Button variant="outline" disabled={!supported||busy} onClick={read}>Read ECG Registers</Button><Button variant="outline" disabled={!info} onClick={()=>info&&saveRegisterLog(info)}>Save Register Log</Button></div>
      <pre className="text-[10px] text-slate-500 whitespace-pre-wrap break-all">{info?registerLog(info):'No actual register readback received.'}</pre></details>
    </CardContent>
  </Card>;
}
