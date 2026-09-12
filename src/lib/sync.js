// Serializes complete-state writes and retains the latest pending state on failure.
// The injected persistence layer makes network interruption cases testable.
export function createSaveQueue({persist,send,onSaved=()=>{},onError=()=>{}}) {
  let latest=null, running=null, revision=0, paused=false;
  let persistence=Promise.resolve();
  const write = value => {
    persistence=persistence.catch(()=>{}).then(()=>persist(value));
    return persistence;
  };
  async function drain() {
    try {
      while(latest && !paused) {
        const snapshot=latest;
        await write({state:latest,revision});
        revision=await send(snapshot,revision);
        if(latest===snapshot) latest=null;
        await write(latest ? {state:latest,revision} : null);
        onSaved(snapshot,revision,!latest);
      }
    } catch(error) {
      if(latest) await write({state:latest,revision}).catch(()=>{});
      onError(error);
    } finally {running=null;}
  }
  return {
    configure(value,{offline=false}={}) {revision=value;paused=offline;},
    enqueue(state) {
      latest=state;
      const saved=write({state,revision});
      if(!paused && !running) running=saved.then(drain).catch(error=>{running=null;onError(error);});
      return running || saved;
    },
    async idle() {await running;await persistence;},
  };
}
