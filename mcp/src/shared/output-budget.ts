/** Shared encoded response budget. Releasing twice cannot manufacture capacity. */
export class OutputBudget {
  private used=0;
  constructor(readonly limit=64*1024*1024) {}
  get bytes():number{return this.used;}
  reserve(bytes:number):()=>void {
    if(!Number.isSafeInteger(bytes)||bytes<0||this.used+bytes>this.limit)throw new Error('global_output_budget');
    this.used+=bytes;let released=false;return()=>{if(!released){released=true;this.used-=bytes;}};
  }
}
