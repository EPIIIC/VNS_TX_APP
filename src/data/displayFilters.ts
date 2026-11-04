/** Causal display-only RBJ biquads. Coefficients: W3C Audio EQ Cookbook. */
type Coefficients={b0:number;b1:number;b2:number;a1:number;a2:number};
type ChainOptions={highPass?:number|null;lowPass?:number|null;notch?:number|null};
function coefficients(kind:'highpass'|'lowpass'|'notch',hz:number,rate:number):Coefficients {
  if(!Number.isFinite(hz)||hz<=0||hz>=rate/2)throw Error('Filter frequency must be between 0 and Nyquist');
  const w=2*Math.PI*hz/rate,c=Math.cos(w),alpha=Math.sin(w)/(2*(kind==='notch'?10:Math.SQRT1_2)),a0=1+alpha;
  const b0=kind==='notch'?1:kind==='lowpass'?(1-c)/2:(1+c)/2;
  const b1=kind==='notch'?-2*c:kind==='lowpass'?1-c:-(1+c);
  return {b0:b0/a0,b1:b1/a0,b2:b0/a0,a1:-2*c/a0,a2:(1-alpha)/a0};
}
class Biquad {
  private x1=0;private x2=0;private y1=0;private y2=0;
  constructor(private c:Coefficients) {}
  prime(x:number) {
    const c=this.c,y=x*(c.b0+c.b1+c.b2)/(1+c.a1+c.a2);
    this.x1=this.x2=x;this.y1=this.y2=y;return y;
  }
  push(x:number) {
    const c=this.c,y=c.b0*x+c.b1*this.x1+c.b2*this.x2-c.a1*this.y1-c.a2*this.y2;
    this.x2=this.x1;this.x1=x;this.y2=this.y1;this.y1=y;return y;
  }
}
export class DisplayFilterChain {
  private sections:Biquad[]=[];private started=false;
  get active(){return this.sections.length>0;}
  constructor(rate:number,options:ChainOptions) {
    if(!Number.isFinite(rate)||rate<=0)throw Error('Invalid sample rate');
    if(options.highPass!=null&&options.lowPass!=null&&options.highPass>=options.lowPass)throw Error('High-pass must be below low-pass');
    for(const [kind,hz] of [['highpass',options.highPass],['notch',options.notch],['lowpass',options.lowPass]] as const)
      if(hz!=null)this.sections.push(new Biquad(coefficients(kind,hz,rate)));
  }
  reset(){this.started=false;}
  push(input:number) {
    if(!this.started){let dc=input;for(const section of this.sections)dc=section.prime(dc);this.started=true;}
    let y=input;for(const section of this.sections)y=section.push(y);return y;
  }
}
